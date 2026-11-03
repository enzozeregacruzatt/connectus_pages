#!/usr/bin/env node
'use strict';

// Levanta tres servidores para probar la app embebida, sin AWS y con el handler real:
//   http://localhost:8787   la app
//   http://127.0.0.1:8788   otro origen, autorizado por FRAME_ANCESTORS, con un iframe a la app
//   http://127.0.0.1:8789   otro origen, no autorizado, que intenta lo mismo: el navegador debe bloquearlo
// Las variables salen de test/.env.local, que deja scripts/mysql_prueba.sh up.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseEnv } = require('node:util');

const ENV_FILE = path.join(__dirname, '..', 'test', '.env.local');
const LISTEN_HOST = '127.0.0.1';
const APP_PORT = 8787;
const ALLOWED_PORT = 8788;
const BLOCKED_PORT = 8789;
const APP_URL = `http://localhost:${APP_PORT}/`;
const FRAME_ANCESTORS = `http://127.0.0.1:${ALLOWED_PORT}`;
const LOCAL_DB_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY_BYTES = 1024 * 1024;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readTestEnv() {
  let raw;
  try {
    raw = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
  } catch {
    fail("No existe test/.env.local: corre primero 'scripts/mysql_prueba.sh up'.");
  }
  const variables = {
    DB_HOST: raw.DB_HOST,
    DB_PORT: raw.DB_PORT,
    DB_USER: raw.DB_USER,
    DB_PASSWORD: raw.DB_PASSWORD,
    DB_SSL_CA_FILE: raw.DB_SSL_CA_FILE,
    TOKEN_SECRET: raw.TOKEN_SECRET,
  };
  if (Object.values(variables).some((value) => !value)) {
    fail("Faltan variables en test/.env.local: corre 'scripts/mysql_prueba.sh up'.");
  }
  return variables;
}

function toRestEvent(req, body) {
  const queryStart = req.url.indexOf('?');
  const rawPath = queryStart === -1 ? req.url : req.url.slice(0, queryStart);
  const rawQuery = queryStart === -1 ? '' : req.url.slice(queryStart + 1);

  const multiValueHeaders = {};
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    (multiValueHeaders[name] ||= []).push(req.rawHeaders[index + 1]);
  }

  const multiValueQuery = {};
  for (const [name, value] of new URLSearchParams(rawQuery)) {
    (multiValueQuery[name] ||= []).push(value);
  }
  const hasQuery = Object.keys(multiValueQuery).length > 0;

  return {
    httpMethod: req.method,
    path: rawPath,
    headers: Object.fromEntries(Object.entries(multiValueHeaders).map(([name, values]) => [name, values.at(-1)])),
    multiValueHeaders,
    queryStringParameters: hasQuery
      ? Object.fromEntries(Object.entries(multiValueQuery).map(([name, values]) => [name, values.at(-1)]))
      : null,
    multiValueQueryStringParameters: hasQuery ? multiValueQuery : null,
    body: body.length > 0 ? body.toString('base64') : null,
    isBase64Encoded: body.length > 0,
    requestContext: { identity: { sourceIp: req.socket.remoteAddress } },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function embeddingPage(title, note) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; background: #f4f6f8; color: #344767; }
  iframe { width: 100%; max-width: 960px; height: 720px; border: 1px solid #dce4ec; background: #fff; }
  .angosto { width: 360px; }
</style>
</head>
<body>
<h1>${title}</h1>
<p>${note}</p>
<iframe src="${APP_URL}" title="Consulta de SMS"></iframe>
<h2>Iframe angosto (360 px)</h2>
<iframe class="angosto" src="${APP_URL}" title="Consulta de SMS, angosta"></iframe>
</body>
</html>
`;
}

function startEmbeddingServer(port, title, note) {
  const page = embeddingPage(title, note);
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
  }).listen(port, LISTEN_HOST);
}

function startAppServer(handler) {
  http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const response = await handler(toRestEvent(req, body));
      res.writeHead(response.statusCode, response.headers);
      res.end(response.body);
    } catch (error) {
      console.error(JSON.stringify({ event: 'dev_server_error', code: error.code || error.name }));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }).listen(APP_PORT, LISTEN_HOST);
}

function main() {
  const variables = readTestEnv();
  if (!LOCAL_DB_HOSTS.has(variables.DB_HOST)) {
    fail('Este servidor solo se conecta a una base local: revisa test/.env.local.');
  }
  Object.assign(process.env, variables, { STAGE: 'local', FRAME_ANCESTORS });

  // Se carga después de fijar STAGE: el handler no debe poder arrancar en otro modo.
  const { app } = require('../src/handler');

  startAppServer(app);
  startEmbeddingServer(
    ALLOWED_PORT,
    'Sitio autorizado',
    'Este origen está en FRAME_ANCESTORS: la app debe verse dentro del iframe.'
  );
  startEmbeddingServer(
    BLOCKED_PORT,
    'Sitio no autorizado',
    'Este origen no está en FRAME_ANCESTORS: el navegador debe bloquear los dos iframes.'
  );

  console.log(`App:               ${APP_URL}`);
  console.log(`Sitio autorizado:  http://127.0.0.1:${ALLOWED_PORT}/`);
  console.log(`Sitio bloqueado:   http://127.0.0.1:${BLOCKED_PORT}/`);
}

main();
