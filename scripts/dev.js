#!/usr/bin/env node
'use strict';

// Levanta estos servidores para probar la app embebida, sin AWS y con el handler real:
//   http://localhost:8787   la app, sin enlace: muestra el aviso y no el formulario
//   http://127.0.0.1:8788   otro origen, autorizado por FRAME_ANCESTORS, con iframes a la app con el enlace
//   http://127.0.0.1:8789   otro origen, no autorizado, que intenta lo mismo: el navegador debe bloquearlo
//   http://127.0.0.1:8791   otro origen, con iframes a una segunda app (localhost:8790) con frame_ancestors sin-restriccion y
//                           CORS para documento opaco: uno común y otro en sandbox sin allow-same-origin ni allow-forms
// Las variables y el enlace del login demo salen de test/.env.local, que deja scripts/mysql_prueba.sh up.
// El trabajador de exportaciones corre en este mismo proceso, y sus archivos quedan en un directorio temporal, que se borra al salir.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { parseEnv } = require('node:util');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createDb } = require('../src/db');
const { FRAME_ANCESTORS_OPEN } = require('../src/headers');
const { createStorage } = require('../src/storage');
const { createWorkerHandler } = require('../src/worker/handler');

const ENV_FILE = path.join(__dirname, '..', 'test', '.env.local');
const LISTEN_HOST = '127.0.0.1';
const APP_PORT = 8787;
const ALLOWED_PORT = 8788;
const BLOCKED_PORT = 8789;
const OPEN_APP_PORT = 8790;
const OPEN_EMBEDDER_PORT = 8791;
const APP_URL = `http://localhost:${APP_PORT}/`;
const OPEN_APP_URL = `http://localhost:${OPEN_APP_PORT}/`;
const FRAME_ANCESTORS = `http://127.0.0.1:${ALLOWED_PORT}`;
const LOCAL_DB_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY_BYTES = 1024 * 1024;
const DOWNLOAD_PREFIX = '/descarga-local/';
const WORKER_EVERY_MS = 5000;
const WORKER_RUN_MS = 120000;

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
    LINK_SECRET_A: raw.LINK_SECRET_A,
    WORKER_DB_USER: raw.WORKER_DB_USER,
    WORKER_DB_PASSWORD: raw.WORKER_DB_PASSWORD,
  };
  if (Object.values(variables).some((value) => !value) || !raw.LINK_DEMO) {
    fail("Faltan variables en test/.env.local: corre 'scripts/mysql_prueba.sh up'.");
  }
  return { variables, link: raw.LINK_DEMO };
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

function embeddingPage(title, note, frames) {
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
${frames.join('\n')}
</body>
</html>
`;
}

function startEmbeddingServer(port, title, note, frames) {
  const page = embeddingPage(title, note, frames);
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
  }).listen(port, LISTEN_HOST);
}

// Hace las veces de S3: entrega el archivo con el nombre pedido, como la URL prefirmada.
function serveDownload(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const key = pathname.slice(DOWNLOAD_PREFIX.length);
  let file;
  try {
    file = fs.createReadStream(createStorage().objectPath(key));
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  file.on('error', () => {
    res.writeHead(404);
    res.end();
  });
  file.on('open', () => {
    res.writeHead(200, {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(searchParams.get('filename') ?? 'archivo')}`,
      'Cache-Control': 'private, no-store',
    });
    file.pipe(res);
  });
}

function startAppServer(handler, port) {
  http.createServer(async (req, res) => {
    if (req.url.startsWith(DOWNLOAD_PREFIX)) {
      serveDownload(req, res);
      return;
    }
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
  }).listen(port, LISTEN_HOST);
}

function normalFrames(link) {
  const src = `${APP_URL}#e=${link}`;
  return [
    `<iframe src="${src}" title="Consulta de SMS"></iframe>`,
    '<h2>Iframe angosto (360 px)</h2>',
    `<iframe class="angosto" src="${src}" title="Consulta de SMS, angosta"></iframe>`,
  ];
}

function openFrames(link) {
  const src = `${OPEN_APP_URL}#e=${link}`;
  return [
    `<iframe src="${src}" title="Consulta de SMS"></iframe>`,
    '<h2>Sandbox con allow-scripts, nada más: origen opaco, sin submit</h2>',
    `<iframe sandbox="allow-scripts" src="${src}" title="Consulta de SMS, en sandbox"></iframe>`,
  ];
}

async function buildOpenApp() {
  const config = await loadConfig({ env: { ...process.env, FRAME_ANCESTORS: FRAME_ANCESTORS_OPEN, CORS_OPAQUE: 'on' } });
  return createApp({ db: createDb(config), config, storage: createStorage() });
}

// Una corrida a la vez y con plazo corto, igual que con reservedConcurrency: 1. Un error ya quedó registrado por el handler.
function startWorker() {
  const worker = createWorkerHandler();
  const runOnce = async () => {
    const deadline = Date.now() + WORKER_RUN_MS;
    await worker({}, { getRemainingTimeInMillis: () => deadline - Date.now() + 60000 }).catch(() => {});
    setTimeout(runOnce, WORKER_EVERY_MS);
  };
  runOnce();
}

function removeOnExit(dir) {
  const leave = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', leave);
  process.on('SIGTERM', leave);
}

async function main() {
  const { variables, link } = readTestEnv();
  if (!LOCAL_DB_HOSTS.has(variables.DB_HOST)) {
    fail('Este servidor solo se conecta a una base local: revisa test/.env.local.');
  }
  const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-exports-'));
  removeOnExit(exportsDir);
  Object.assign(process.env, variables, {
    STAGE: 'local',
    FRAME_ANCESTORS,
    EXPORTS_DIR: exportsDir,
    EXPORTS_BASE_URL: `http://localhost:${APP_PORT}${DOWNLOAD_PREFIX}`,
    WORKER_QUIET_WINDOWS: 'none',
  });

  // Se carga después de fijar STAGE: el handler no debe poder arrancar en otro modo.
  const { app, createHandler } = require('../src/handler');
  const openApp = await buildOpenApp();

  startWorker();
  startAppServer(app, APP_PORT);
  startEmbeddingServer(
    ALLOWED_PORT,
    'Sitio autorizado',
    'Este origen está en FRAME_ANCESTORS: la app debe verse dentro del iframe, con el formulario.',
    normalFrames(link)
  );
  startEmbeddingServer(
    BLOCKED_PORT,
    'Sitio no autorizado',
    'Este origen no está en FRAME_ANCESTORS: el navegador debe bloquear los dos iframes.',
    normalFrames(link)
  );
  startAppServer(createHandler(async () => openApp), OPEN_APP_PORT);
  startEmbeddingServer(
    OPEN_EMBEDDER_PORT,
    'Sin restricción',
    'Esta app omite frame-ancestors: cualquier origen puede embeberla. El sandbox entra solo con CORS para documento opaco.',
    openFrames(link)
  );

  console.log(`App, sin enlace:   ${APP_URL}`);
  console.log(`Sitio autorizado:  http://127.0.0.1:${ALLOWED_PORT}/`);
  console.log(`Sitio bloqueado:   http://127.0.0.1:${BLOCKED_PORT}/`);
  console.log(`Sin restricción:   http://127.0.0.1:${OPEN_EMBEDDER_PORT}/`);
}

main().catch((error) => fail(`No se pudo arrancar: ${error.code || error.name}`));
