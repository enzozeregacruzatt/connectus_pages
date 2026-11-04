'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOGGED_CHARS = 256;
const ECHO_TEXT = 'eco de la sonda';
const DOWNLOAD_TEXT = 'Archivo de prueba de la sonda.\n';
const DOWNLOAD_NAME = 'sonda.txt';
const DOWNLOAD_ERROR = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Error de prueba de la sonda.</Message></Error>\n';

// La misma política de la app, sin frame-ancestors: lo que se quiere saber es quién embebe, y lo que falle aquí fallaría también allá.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
    + "connect-src 'self'; form-action 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  // Si la página se volvió a pedir o salió de una caché también es parte de lo que se mide.
  'Cache-Control': 'no-store',
};
const OPAQUE_CORS = { 'Access-Control-Allow-Origin': 'null' };
const TEXT = 'text/plain; charset=utf-8';

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const probeScript = fs.readFileSync(path.join(__dirname, 'sonda.js'), 'utf8');

const respond = (statusCode, contentType, body, headers = {}) => ({
  statusCode,
  headers: { ...SECURITY_HEADERS, 'Content-Type': contentType, ...headers },
  body,
});

const routes = new Map([
  ['/', () => respond(200, 'text/html; charset=utf-8', indexHtml)],
  ['/sonda.js', () => respond(200, 'text/javascript; charset=utf-8', probeScript)],
  ['/eco', () => respond(200, TEXT, ECHO_TEXT, OPAQUE_CORS)],
  ['/eco-sin-cors', () => respond(200, TEXT, ECHO_TEXT)],
  ['/descarga', () => respond(200, TEXT, DOWNLOAD_TEXT, { 'Content-Disposition': `attachment; filename="${DOWNLOAD_NAME}"` })],
  // Como un error de S3: sin attachment, así que el enlace navega en lugar de bajar. ¿Reemplaza la página?
  ['/descarga-falla', () => respond(403, 'application/xml', DOWNLOAD_ERROR)],
]);

// La app manda Authorization, y eso siempre pasa por un preflight: hay que saber si este también llega.
function echoPreflight() {
  return {
    statusCode: 204,
    headers: {
      ...SECURITY_HEADERS,
      ...OPAQUE_CORS,
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
    body: '',
  };
}

// Un archivo local no tiene origen, y su esquema dice lo mismo sin la ruta, que puede traer datos de quien lo abre.
function refererOrigin(referer) {
  try {
    const { origin, protocol } = new URL(referer);
    return origin === 'null' ? protocol : origin;
  } catch {
    return null;
  }
}

const cut = (value) => (typeof value === 'string' ? value.slice(0, MAX_LOGGED_CHARS) : null);

// Así se sabe qué embebe sin preguntarle al cliente. Dentro de JSON.stringify, una cabecera con saltos de línea no inventa otra entrada.
function logRequest(route, headers) {
  console.log(JSON.stringify({
    event: 'sonda',
    route,
    secFetchDest: cut(headers['sec-fetch-dest']),
    secFetchSite: cut(headers['sec-fetch-site']),
    userAgent: cut(headers['user-agent']),
    refererOrigin: cut(refererOrigin(headers.referer)),
  }));
}

exports.sonda = async (event) => {
  const route = event.rawPath;
  const method = event.requestContext.http.method;
  if (!routes.has(route)) return respond(404, TEXT, 'No existe.');
  logRequest(route, event.headers || {});
  if (method === 'OPTIONS' && route === '/eco') return echoPreflight();
  if (method !== 'GET') return respond(405, TEXT, 'Método no permitido.');
  return routes.get(route)();
};
