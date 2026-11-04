'use strict';

const { BUSY_MESSAGE, createApp } = require('./app');
const { loadConfig } = require('./config');
const { createDb, errorCode } = require('./db');
const { buildSecurityHeaders } = require('./headers');
const { createStorage } = require('./storage');

const DEADLINE_MARGIN_MS = 2000;
// El timeout de serverless.yml menos el margen, para cuando no hay context.
const DEFAULT_DEADLINE_MS = 23000;
const DEADLINE_EXPIRED = Symbol('plazo vencido');

// Cabeceras en minúsculas y multivalor unido con coma: dos Authorization o dos Content-Type dejan de
// calzar con lo que se exige, en vez de que gane uno de los dos sin que nadie lo note.
function normalizeHeaders(event) {
  const headers = Object.create(null);
  for (const [name, values] of Object.entries(event.multiValueHeaders || {})) {
    if (Array.isArray(values)) headers[name.toLowerCase()] = values.join(', ');
  }
  for (const [name, value] of Object.entries(event.headers || {})) {
    const key = name.toLowerCase();
    if (!(key in headers)) headers[key] = value;
  }
  return headers;
}

function normalizeQuery(event) {
  const query = Object.create(null);
  for (const [name, values] of Object.entries(event.multiValueQueryStringParameters || {})) {
    if (Array.isArray(values)) query[name] = values;
  }
  for (const [name, value] of Object.entries(event.queryStringParameters || {})) {
    if (!(name in query)) query[name] = [value];
  }
  return query;
}

function decodeBody(event) {
  if (event.body === null || event.body === undefined) return Buffer.alloc(0);
  return Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
}

function toRequest(event) {
  return {
    method: event.httpMethod,
    path: event.path,
    headers: normalizeHeaders(event),
    query: normalizeQuery(event),
    body: decodeBody(event),
    ip: event.requestContext?.identity?.sourceIp ?? null,
  };
}

// Sin configuración no se sabe quién puede embeber la página, así que frame-ancestors queda en 'none'.
function failClosedResponse(statusCode, code, message) {
  return {
    statusCode,
    headers: {
      ...buildSecurityHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({ error: code, message }),
    isBase64Encoded: false,
  };
}

function deadlineMs(context) {
  const remaining = context?.getRemainingTimeInMillis?.();
  return remaining === undefined ? DEFAULT_DEADLINE_MS : remaining - DEADLINE_MARGIN_MS;
}

// Si la base no contesta, ninguna sentencia vuelve: sin este plazo la Lambda moriría y API Gateway daría un 502 sin las
// cabeceras de seguridad. Cubre también cargar la configuración y conectar.
function createHandler(getApp, discardApp = () => {}) {
  return async (event, context) => {
    const startedAtMs = performance.now();
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(resolve, deadlineMs(context), DEADLINE_EXPIRED);
    });
    const work = (async () => {
      const app = await getApp();
      return app.handle({ ...toRequest(event), startedAtMs });
    })();
    try {
      const response = await Promise.race([work, expired]);
      if (response !== DEADLINE_EXPIRED) return response;
      console.error(JSON.stringify({ event: 'request_deadline_exceeded' }));
      discardApp();
      return failClosedResponse(503, 'busy', BUSY_MESSAGE);
    } catch (error) {
      console.error(JSON.stringify({ event: 'handler_failed', code: errorCode(error) }));
      return failClosedResponse(500, 'internal', 'Ocurrió un error interno. Inténtalo de nuevo.');
    } finally {
      clearTimeout(timer);
    }
  };
}

// Una vez por contenedor. Si falla, se olvida para que la siguiente petición lo reintente y un
// contenedor no quede inservible por un error transitorio de Parameter Store.
function createAppHolder(build) {
  let current;
  return {
    get() {
      if (!current) {
        const building = build();
        current = building;
        // Una carga descartada que falla tarde no debe borrar la que la reemplazó.
        building.catch(() => {
          if (current === building) current = undefined;
        });
      }
      return current;
    },
    // Una conexión colgada, con connectionLimit 1, dejaría en cola todo lo que venga después. No se espera el cierre porque
    // tampoco termina hasta que la sentencia colgada vuelva.
    discard() {
      const discarded = current;
      current = undefined;
      discarded?.then((app) => app.close()).catch((error) => {
        console.error(JSON.stringify({ event: 'app_close_failed', code: errorCode(error) }));
      });
    },
  };
}

const holder = createAppHolder(async () => {
  const config = await loadConfig();
  const db = createDb(config);
  return { ...createApp({ db, config, storage: createStorage() }), close: () => db.end() };
});

exports.app = createHandler(holder.get, holder.discard);
exports.DEADLINE_MARGIN_MS = DEADLINE_MARGIN_MS;
exports.DEFAULT_DEADLINE_MS = DEFAULT_DEADLINE_MS;
exports.createAppHolder = createAppHolder;
exports.createHandler = createHandler;
exports.toRequest = toRequest;
