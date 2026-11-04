'use strict';

const {
  LOGIN_FAILURE_FLOOR_MS,
  acceptLink,
  authenticate,
  login,
  loginHasAccount,
  parseCredentials,
  parseLoginBody,
} = require('./auth');
const { errorCode, insertAudit, isQueryCut, isSchemaError, writeAudit } = require('./db');
const {
  findDelivery,
  listDeliveries,
  parseDeliveryList,
  parseDeliveryMessages,
  parseDeliveryRef,
  readDelivery,
  readMessages,
  readProgress,
} = require('./deliveries');
const {
  createExport,
  exportAuditDetail,
  findJob,
  jobFilename,
  listExports,
  parseExportBody,
  parseExportList,
  parseJobRef,
  readExportStatus,
} = require('./exports');
const {
  FRAME_ANCESTORS_OPEN,
  OPAQUE_CORS_HEADERS,
  OPAQUE_ORIGIN,
  OPAQUE_PREFLIGHT_HEADERS,
  buildSecurityHeaders,
} = require('./headers');
const { DOWNLOAD_EXPIRES_SECONDS } = require('./presign');
const { parseSearch, parseSmsDetail, readSmsDetail, searchSms } = require('./sms');
const { readStatic } = require('./static');
const { readDeliveryStats } = require('./stats');

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_REQUEST_PATTERN = /^application\/json\s*(;.*)?$/i;
const MAX_BODY_BYTES = 4096;
// audit_log.id_account es INT, y parseSearch acepta enteros mayores.
const MAX_AUDIT_ACCOUNT_ID = 2147483647;

const ER_TOO_MANY_CONNECTIONS = 1040;
const ER_SERVER_SHUTDOWN = 1053;
const ER_TOO_MANY_USER_CONNECTIONS = 1203;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_LOCK_DEADLOCK = 1213;
const ER_USER_LIMIT_REACHED = 1226;
const ER_CANT_AGGREGATE_2COLLATIONS = 1267;
const ER_CANNOT_CONVERT_STRING = 3854;
const ER_CLIENT_INTERACTION_TIMEOUT = 4031;
const UNAVAILABLE_ERRNOS = new Set([
  ER_TOO_MANY_CONNECTIONS,
  ER_SERVER_SHUTDOWN,
  ER_TOO_MANY_USER_CONNECTIONS,
  ER_LOCK_WAIT_TIMEOUT,
  ER_LOCK_DEADLOCK,
  ER_USER_LIMIT_REACHED,
  ER_CLIENT_INTERACTION_TIMEOUT,
]);
// Un carácter que la columna no puede guardar, comparado contra ella. El código cambia según la versión.
const INCOMPARABLE_TEXT_ERRNOS = new Set([ER_CANT_AGGREGATE_2COLLATIONS, ER_CANNOT_CONVERT_STRING]);
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
const INVALID_LINK_MESSAGE = 'Este enlace no es válido o venció. Pide uno nuevo a tu contacto de Connectus.';
const INVALID_CREDENTIALS_MESSAGE = 'Debes indicar un usuario y una contraseña válidos.';
const INTERNAL_MESSAGE = 'Ocurrió un error interno. Inténtalo de nuevo.';
const BUSY_MESSAGE = 'El servicio está ocupado. Inténtalo de nuevo en unos minutos.';
const TIMEOUT_MESSAGE = 'La consulta tardó demasiado. Acota las fechas o indica un número.';
const RETRY_TIMEOUT_MESSAGE = 'La consulta tardó demasiado. Inténtalo de nuevo.';
const INVALID_REQUEST_MESSAGE = 'La solicitud no es válida.';
const DELIVERY_NOT_FOUND_MESSAGE = 'Envío no encontrado.';
const SMS_NOT_FOUND_MESSAGE = 'Mensaje no encontrado.';
const EXPORT_NOT_FOUND_MESSAGE = 'Exportación no encontrada.';
const EXPORT_GONE_MESSAGE = 'El archivo ya no está disponible. Genera uno nuevo.';

function isApiPath(path) {
  return path === '/api' || path.startsWith('/api/');
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(typeof body === 'string' ? body : '', 'utf8');
}

function classifyError(error, timeoutMessage = TIMEOUT_MESSAGE) {
  if (isQueryCut(error)) return { statusCode: 504, code: 'timeout', message: timeoutMessage };
  if (error && INCOMPARABLE_TEXT_ERRNOS.has(error.errno)) {
    return { statusCode: 400, code: 'invalid_request', message: INVALID_REQUEST_MESSAGE };
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

// Un corte o un carácter que la columna no guarda son respuestas previstas: quedan registrados, sin alarma.
const EXPECTED_FAILURE_EVENTS = new Map([[504, 'request_cut'], [400, 'bad_text']]);

function failureEvent(error, statusCode) {
  if (isSchemaError(error)) return 'schema_error';
  return EXPECTED_FAILURE_EVENTS.get(statusCode) ?? 'request_failed';
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

// Lo que el login y la exportación exigen antes de leer un cuerpo.
function bodyProblem(req) {
  if (!JSON_REQUEST_PATTERN.test(req.headers['content-type'] || '')) {
    return { ok: false, statusCode: 415, code: 'unsupported_media_type', message: 'El contenido debe ser application/json.' };
  }
  if (toBuffer(req.body).length > MAX_BODY_BYTES) {
    return { ok: false, statusCode: 413, code: 'payload_too_large', message: 'La petición es demasiado grande.' };
  }
  return null;
}

function createApp({ db, config, storage, clock = Date.now, publicDir, loginFailureFloorMs = LOGIN_FAILURE_FLOOR_MS }) {
  const securityHeaders = buildSecurityHeaders(config);
  if (config.frameAncestors === FRAME_ANCESTORS_OPEN) console.error(JSON.stringify({ event: 'frame_ancestors_open' }));

  function isOpaqueApiRequest(req) {
    return config.corsOpaque === true && isApiPath(req.path) && req.headers.origin === OPAQUE_ORIGIN;
  }

  // Las cabeceras CORS van también en los errores: sin ellas, el front de un documento opaco no puede leer el mensaje.
  function apiHeaders(req) {
    if (!isApiPath(req.path)) return {};
    return { 'Cache-Control': 'no-store', ...(isOpaqueApiRequest(req) ? OPAQUE_CORS_HEADERS : {}) };
  }

  function respond(req, statusCode, contentType, body, extraHeaders) {
    const headers = { ...securityHeaders, 'Content-Type': contentType, ...extraHeaders, ...apiHeaders(req) };
    return { statusCode, headers, body, isBase64Encoded: false };
  }

  function respondJson(req, statusCode, payload, extraHeaders) {
    return respond(req, statusCode, JSON_CONTENT_TYPE, JSON.stringify(payload), extraHeaders);
  }

  function respondError(req, statusCode, code, message, extraHeaders) {
    return respondJson(req, statusCode, { error: code, message }, extraHeaders);
  }

  function respondPreflight(req) {
    return {
      statusCode: 204,
      headers: { ...securityHeaders, ...apiHeaders(req), ...OPAQUE_PREFLIGHT_HEADERS },
      body: '',
      isBase64Encoded: false,
    };
  }

  async function serveStatic(req) {
    const file = await readStatic(req.path, publicDir);
    return respond(req, 200, file.contentType, file.body, { 'Cache-Control': 'no-cache' });
  }

  async function handleLogin(req) {
    const problem = bodyProblem(req);
    if (problem) return respondError(req, problem.statusCode, problem.code, problem.message);
    const body = parseLoginBody(toBuffer(req.body));
    if (!body) return respondError(req, 400, 'invalid_request', INVALID_CREDENTIALS_MESSAGE);

    const link = acceptLink(body.link, config, clock);
    if (!link) return respondError(req, 401, 'invalid_link', INVALID_LINK_MESSAGE);

    const credentials = parseCredentials(body);
    if (!credentials) return respondError(req, 400, 'invalid_request', INVALID_CREDENTIALS_MESSAGE);

    const { session, failure } = await login({
      db,
      config,
      clock,
      link,
      ...credentials,
      ip: req.ip,
      failureFloorMs: loginFailureFloorMs,
    });
    if (failure === 'invalid_link') return respondError(req, 401, 'invalid_link', INVALID_LINK_MESSAGE);
    if (failure) return respondError(req, 401, 'invalid_credentials', LOGIN_FAILED_MESSAGE);
    return respondJson(req, 200, session);
  }

  async function withLogin(req, work) {
    const loginId = await authenticate({ db, config, clock, authorization: req.headers.authorization });
    if (loginId === null) {
      return respondError(req, 401, 'unauthorized', 'Tu sesión venció. Vuelve a entrar.', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    return work(loginId);
  }

  function respondForbidden(req) {
    return respondError(req, 403, 'forbidden', 'No tienes acceso a esa cuenta.');
  }

  // Lo que toda ruta de datos hace antes de consultar: token, parámetros y membresía de la cuenta, en cada petición.
  function withAccount(req, parse, work) {
    return withLogin(req, async (loginId) => {
      const params = parse(req.query || {}, { cursorSecret: config.tokenSecret });
      if (!params.ok) return respondError(req, params.statusCode ?? 400, params.code, params.message);

      if (!(await loginHasAccount(db, loginId, params.account))) {
        await writeAudit(db, forbiddenAudit(loginId, params.account, req.ip));
        return respondForbidden(req);
      }

      return work(loginId, params);
    });
  }

  function respondFound(req, payload, notFoundMessage) {
    if (payload === null) return respondError(req, 404, 'not_found', notFoundMessage);
    return respondJson(req, 200, payload);
  }

  function handleSms(req) {
    return withAccount(req, parseSearch, async (loginId, search) => {
      await writeAudit(db, {
        idLogin: loginId,
        action: 'search',
        idAccount: search.account,
        detail: `${search.start}..${search.end} ${search.dst === null ? 'sin_numero' : 'con_numero'}`,
        ip: req.ip,
      });
      return respondJson(req, 200, await searchSms(db, search, { nowMs: clock(), cursorSecret: config.tokenSecret }));
    });
  }

  function handleSmsDetail(req) {
    return withAccount(req, parseSmsDetail, async (loginId, params) => {
      const detail = await readSmsDetail(db, params);
      if (detail !== null) {
        await writeAudit(db, { idLogin: loginId, action: 'sms_view', idAccount: params.account, detail: params.id, ip: req.ip });
      }
      return respondFound(req, detail, SMS_NOT_FOUND_MESSAGE);
    });
  }

  function handleDeliveries(req) {
    return withAccount(req, parseDeliveryList, async (_loginId, params) => (
      respondJson(req, 200, await listDeliveries(db, params, { cursorSecret: config.tokenSecret }))
    ));
  }

  function handleDelivery(req) {
    return withAccount(req, parseDeliveryRef, async (loginId, params) => {
      const detail = await readDelivery(db, params, { loginId, nowMs: clock() });
      if (detail !== null) {
        await writeAudit(db, { idLogin: loginId, action: 'delivery_view', idAccount: params.account, detail: params.id, ip: req.ip });
      }
      return respondFound(req, detail, DELIVERY_NOT_FOUND_MESSAGE);
    });
  }

  function handleDeliveryProgress(req) {
    return withAccount(req, parseDeliveryRef, async (_loginId, params) => (
      respondFound(req, await readProgress(db, params, { nowMs: clock() }), DELIVERY_NOT_FOUND_MESSAGE)
    ));
  }

  function handleDeliveryStats(req) {
    return withAccount(req, parseDeliveryRef, async (_loginId, params) => {
      const delivery = await findDelivery(db, params.account, params.id);
      if (delivery === null) return respondFound(req, null, DELIVERY_NOT_FOUND_MESSAGE);
      return respondJson(req, 200, await readDeliveryStats(db, delivery, { nowMs: clock(), startedAtMs: req.startedAtMs }));
    });
  }

  function handleDeliveryMessages(req) {
    return withAccount(req, parseDeliveryMessages, async (loginId, params) => {
      const page = await readMessages(db, params, { cursorSecret: config.tokenSecret });
      if (page !== null && params.dst !== null) {
        await writeAudit(db, {
          idLogin: loginId,
          action: 'delivery_search',
          idAccount: params.account,
          detail: `${params.id} con_numero`,
          ip: req.ip,
        });
      }
      return respondFound(req, page, DELIVERY_NOT_FOUND_MESSAGE);
    });
  }

  function handleExportCreate(req) {
    const parse = () => bodyProblem(req) ?? parseExportBody(toBuffer(req.body));
    return withAccount(req, parse, async (loginId, params) => {
      const { outcome, job, item, message } = await createExport(db, params, { loginId, nowMs: clock() });
      if (outcome === 'busy') return respondError(req, 503, 'busy', BUSY_MESSAGE);
      if (outcome === 'not_found') return respondFound(req, null, DELIVERY_NOT_FOUND_MESSAGE);
      if (outcome === 'limit') return respondError(req, 429, 'export_limit', message);
      if (outcome === 'duplicate') return respondJson(req, 200, item);

      console.error(JSON.stringify({ event: 'export_create' }));
      await writeAudit(db, { idLogin: loginId, action: 'export_create', idAccount: job.account, detail: exportAuditDetail(job), ip: req.ip });
      return respondJson(req, 201, item);
    });
  }

  function handleExportList(req) {
    return withLogin(req, async (loginId) => {
      const params = parseExportList(req.query || {}, { cursorSecret: config.tokenSecret, loginId });
      if (!params.ok) return respondError(req, 400, params.code, params.message);
      return respondJson(req, 200, await listExports(db, params, { loginId, nowMs: clock(), cursorSecret: config.tokenSecret }));
    });
  }

  function withJobRef(req, work) {
    return withLogin(req, async (loginId) => {
      const params = parseJobRef(req.query || {});
      if (!params.ok) return respondError(req, 400, params.code, params.message);
      return work(loginId, params.id);
    });
  }

  function handleExportStatus(req) {
    return withJobRef(req, async (loginId, publicId) => (
      respondFound(req, await readExportStatus(db, publicId, { loginId, nowMs: clock() }), EXPORT_NOT_FOUND_MESSAGE)
    ));
  }

  // Sin auditoría no hay URL: la descarga es lo único que se lleva datos fuera, y este registro es la señal de una filtración.
  function handleExportDownload(req) {
    return withJobRef(req, async (loginId, publicId) => {
      const job = await findJob(db, publicId, loginId);
      if (!job) return respondFound(req, null, EXPORT_NOT_FOUND_MESSAGE);
      if (!(await loginHasAccount(db, loginId, job.account))) {
        await writeAudit(db, forbiddenAudit(loginId, job.account, req.ip));
        return respondForbidden(req);
      }
      if (job.state !== 'finished') return respondError(req, 409, 'not_ready', 'El archivo todavía no está listo.');

      // El error de S3 llega sin attachment y reemplaza el documento: con él se pierde la sesión.
      let object;
      try {
        object = await storage.headObject(job.storageKey);
      } catch (error) {
        console.error(JSON.stringify({ event: 'request_failed', code: errorCode(error) }));
        return respondError(req, 503, 'busy', BUSY_MESSAGE);
      }
      if (!object) return respondError(req, 404, 'not_found', EXPORT_GONE_MESSAGE);

      try {
        await insertAudit(db, {
          idLogin: loginId,
          action: 'export_download',
          idAccount: job.account,
          detail: `${job.kind} ${job.publicId}`,
          ip: req.ip,
        });
      } catch (error) {
        console.error(JSON.stringify({ event: 'audit_insert_failed', code: errorCode(error) }));
        return respondError(req, 503, 'busy', BUSY_MESSAGE);
      }
      const filename = jobFilename(job);
      return respondJson(req, 200, {
        url: storage.downloadUrl({ key: job.storageKey, filename }),
        expiresIn: DOWNLOAD_EXPIRES_SECONDS,
        filename,
      });
    });
  }

  const routes = new Map([
    ['/', { methods: { GET: serveStatic } }],
    ['/app.js', { methods: { GET: serveStatic } }],
    ['/app.css', { methods: { GET: serveStatic } }],
    ['/api/login', { methods: { POST: handleLogin } }],
    ['/api/sms', { methods: { GET: handleSms } }],
    ['/api/sms/detail', { methods: { GET: handleSmsDetail }, timeoutMessage: RETRY_TIMEOUT_MESSAGE }],
    ['/api/deliveries', { methods: { GET: handleDeliveries }, timeoutMessage: RETRY_TIMEOUT_MESSAGE }],
    ['/api/delivery', { methods: { GET: handleDelivery }, timeoutMessage: RETRY_TIMEOUT_MESSAGE }],
    ['/api/delivery/progress', { methods: { GET: handleDeliveryProgress }, timeoutMessage: RETRY_TIMEOUT_MESSAGE }],
    ['/api/delivery/stats', { methods: { GET: handleDeliveryStats }, timeoutMessage: RETRY_TIMEOUT_MESSAGE }],
    ['/api/delivery/messages', { methods: { GET: handleDeliveryMessages }, timeoutMessage: RETRY_TIMEOUT_MESSAGE }],
    ['/api/exports', { methods: { GET: handleExportList, POST: handleExportCreate }, timeoutMessage: RETRY_TIMEOUT_MESSAGE }],
    ['/api/exports/status', { methods: { GET: handleExportStatus }, timeoutMessage: RETRY_TIMEOUT_MESSAGE }],
    ['/api/exports/download', { methods: { GET: handleExportDownload }, timeoutMessage: RETRY_TIMEOUT_MESSAGE }],
  ]);

  async function handle(rawRequest) {
    const req = {
      ...rawRequest,
      path: String(rawRequest.path),
      headers: rawRequest.headers || {},
      startedAtMs: rawRequest.startedAtMs ?? performance.now(),
    };
    if (req.method === 'OPTIONS' && isOpaqueApiRequest(req)) return respondPreflight(req);
    const route = routes.get(req.path);
    if (!route) return respondError(req, 404, 'not_found', 'La ruta no existe.');
    if (!Object.hasOwn(route.methods, req.method)) {
      return respondError(req, 405, 'method_not_allowed', 'Método no permitido.', { Allow: Object.keys(route.methods).join(', ') });
    }
    try {
      return await route.methods[req.method](req);
    } catch (error) {
      const { statusCode, code, message } = classifyError(error, route.timeoutMessage);
      console.error(JSON.stringify({ event: failureEvent(error, statusCode), code: errorCode(error) }));
      return respondError(req, statusCode, code, message);
    }
  }

  return { handle };
}

module.exports = { BUSY_MESSAGE, createApp };
