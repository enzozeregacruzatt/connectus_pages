'use strict';

const { LOGIN_FAILURE_FLOOR_MS, authenticate, login, loginHasAccount, parseCredentials } = require('./auth');
const { errorCode, writeAudit } = require('./db');
const { buildSecurityHeaders } = require('./headers');
const { parseSearch, searchSms } = require('./sms');
const { readStatic } = require('./static');

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_REQUEST_PATTERN = /^application\/json\s*(;.*)?$/i;
const MAX_LOGIN_BODY_BYTES = 4096;
// audit_log.id_account es INT, y parseSearch acepta enteros mayores.
const MAX_AUDIT_ACCOUNT_ID = 2147483647;

const ER_FILSORT_ABORT = 1028;
const ER_TOO_MANY_CONNECTIONS = 1040;
const ER_SERVER_SHUTDOWN = 1053;
const ER_TOO_MANY_USER_CONNECTIONS = 1203;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_USER_LIMIT_REACHED = 1226;
const ER_QUERY_INTERRUPTED = 1317;
const ER_QUERY_TIMEOUT = 3024;
const ER_CLIENT_INTERACTION_TIMEOUT = 4031;
// El corte de MAX_EXECUTION_TIME llega como 3024, o como 1028 si cae durante un filesort (visto en 5.7, no en 9.3).
// KILL QUERY llega como 1317, y es la misma situación para el usuario.
const QUERY_CUT_ERRNOS = new Set([ER_FILSORT_ABORT, ER_QUERY_INTERRUPTED, ER_QUERY_TIMEOUT]);
const UNAVAILABLE_ERRNOS = new Set([
  ER_TOO_MANY_CONNECTIONS,
  ER_SERVER_SHUTDOWN,
  ER_TOO_MANY_USER_CONNECTIONS,
  ER_LOCK_WAIT_TIMEOUT,
  ER_USER_LIMIT_REACHED,
  ER_CLIENT_INTERACTION_TIMEOUT,
]);
// mysql2 reescribe a HANDSHAKE_SSL_ERROR todo corte durante el saludo TLS. Un certificado inválido llega igual, y también da
// 503, pero el registro conserva el código.
const UNAVAILABLE_CODES = new Set([
  'HANDSHAKE_SSL_ERROR',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'PROTOCOL_CONNECTION_LOST',
]);

const LOGIN_FAILED_MESSAGE = 'Usuario o contraseña incorrectos, o acceso bloqueado temporalmente.';
const INTERNAL_MESSAGE = 'Ocurrió un error interno. Inténtalo de nuevo.';
const BUSY_MESSAGE = 'El servicio está ocupado. Inténtalo de nuevo en unos minutos.';
const TIMEOUT_MESSAGE = 'La consulta tardó demasiado. Acota las fechas o indica un número.';

function isApiPath(path) {
  return path === '/api' || path.startsWith('/api/');
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(typeof body === 'string' ? body : '', 'utf8');
}

function classifyError(error) {
  if (error && QUERY_CUT_ERRNOS.has(error.errno)) {
    return { statusCode: 504, code: 'timeout', message: TIMEOUT_MESSAGE };
  }
  // mysql2 marca fatal, sin código, el error de usar una conexión que ya se cerró.
  const unavailable = error && (
    UNAVAILABLE_ERRNOS.has(error.errno)
    || UNAVAILABLE_CODES.has(error.code)
    || (error.fatal && !error.code)
  );
  if (unavailable) return { statusCode: 503, code: 'busy', message: BUSY_MESSAGE };
  return { statusCode: 500, code: 'internal', message: INTERNAL_MESSAGE };
}

function forbiddenAudit(loginId, account, ip) {
  const inRange = account <= MAX_AUDIT_ACCOUNT_ID;
  return {
    idLogin: loginId,
    action: 'forbidden',
    idAccount: inRange ? account : null,
    detail: inRange ? null : 'cuenta_fuera_de_rango',
    ip,
  };
}

function createApp({ db, config, clock = Date.now, publicDir, loginFailureFloorMs = LOGIN_FAILURE_FLOOR_MS }) {
  const securityHeaders = buildSecurityHeaders(config);

  function respond(path, statusCode, contentType, body, extraHeaders) {
    const headers = { ...securityHeaders, 'Content-Type': contentType, ...extraHeaders };
    if (isApiPath(path)) headers['Cache-Control'] = 'no-store';
    return { statusCode, headers, body, isBase64Encoded: false };
  }

  function respondJson(path, statusCode, payload, extraHeaders) {
    return respond(path, statusCode, JSON_CONTENT_TYPE, JSON.stringify(payload), extraHeaders);
  }

  function respondError(path, statusCode, code, message, extraHeaders) {
    return respondJson(path, statusCode, { error: code, message }, extraHeaders);
  }

  async function serveStatic(req) {
    const file = await readStatic(req.path, publicDir);
    return respond(req.path, 200, file.contentType, file.body, { 'Cache-Control': 'no-cache' });
  }

  async function handleLogin(req) {
    if (!JSON_REQUEST_PATTERN.test(req.headers['content-type'] || '')) {
      return respondError(req.path, 415, 'unsupported_media_type', 'El contenido debe ser application/json.');
    }
    const rawBody = toBuffer(req.body);
    if (rawBody.length > MAX_LOGIN_BODY_BYTES) {
      return respondError(req.path, 413, 'payload_too_large', 'La petición es demasiado grande.');
    }
    const credentials = parseCredentials(rawBody);
    if (!credentials) {
      return respondError(req.path, 400, 'invalid_request', 'Debes indicar un usuario y una contraseña válidos.');
    }
    const session = await login({ db, config, clock, ...credentials, ip: req.ip, failureFloorMs: loginFailureFloorMs });
    if (!session) return respondError(req.path, 401, 'invalid_credentials', LOGIN_FAILED_MESSAGE);
    return respondJson(req.path, 200, session);
  }

  async function handleSms(req) {
    const loginId = await authenticate({ db, config, clock, authorization: req.headers.authorization });
    if (loginId === null) {
      return respondError(req.path, 401, 'unauthorized', 'Tu sesión venció. Vuelve a entrar.', {
        'WWW-Authenticate': 'Bearer',
      });
    }

    const search = parseSearch(req.query || {}, { cursorSecret: config.tokenSecret });
    if (!search.ok) return respondError(req.path, 400, search.code, search.message);

    if (!(await loginHasAccount(db, loginId, search.account))) {
      await writeAudit(db, forbiddenAudit(loginId, search.account, req.ip));
      return respondError(req.path, 403, 'forbidden', 'No tienes acceso a esa cuenta.');
    }

    await writeAudit(db, {
      idLogin: loginId,
      action: 'search',
      idAccount: search.account,
      detail: `${search.start}..${search.end} ${search.dst === null ? 'sin_numero' : 'con_numero'}`,
      ip: req.ip,
    });

    return respondJson(req.path, 200, await searchSms(db, search, { nowMs: clock(), cursorSecret: config.tokenSecret }));
  }

  const routes = new Map([
    ['/', { method: 'GET', handler: serveStatic }],
    ['/app.js', { method: 'GET', handler: serveStatic }],
    ['/app.css', { method: 'GET', handler: serveStatic }],
    ['/api/login', { method: 'POST', handler: handleLogin }],
    ['/api/sms', { method: 'GET', handler: handleSms }],
  ]);

  async function handle(rawRequest) {
    const req = { ...rawRequest, path: String(rawRequest.path), headers: rawRequest.headers || {} };
    const route = routes.get(req.path);
    if (!route) return respondError(req.path, 404, 'not_found', 'La ruta no existe.');
    if (req.method !== route.method) {
      return respondError(req.path, 405, 'method_not_allowed', 'Método no permitido.', { Allow: route.method });
    }
    try {
      return await route.handler(req);
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_failed', code: errorCode(error) }));
      const { statusCode, code, message } = classifyError(error);
      return respondError(req.path, statusCode, code, message);
    }
  }

  return { handle };
}

module.exports = { BUSY_MESSAGE, createApp };
