'use strict';

const assert = require('node:assert/strict');
const { mock, test } = require('node:test');

const handlerModule = require('../../src/handler');
const { buildApp, signIn, PASSWORD, VALID_SEARCH } = require('./support/app_fixture');

const { DEADLINE_MARGIN_MS, DEFAULT_DEADLINE_MS, createAppHolder, createHandler, toRequest } = handlerModule;

function restEvent(overrides = {}) {
  return {
    httpMethod: 'GET',
    path: '/',
    headers: null,
    multiValueHeaders: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    requestContext: { identity: { sourceIp: '203.0.113.20' } },
    ...overrides,
  };
}

function handlerFor(app) {
  return createHandler(async () => app);
}

const loginBody = JSON.stringify({ username: 'demo', password: PASSWORD });

test('el handler exporta app', () => {
  assert.equal(typeof handlerModule.app, 'function');
});

test('adapta método, ruta, ip y cabeceras en minúsculas', () => {
  const request = toRequest(restEvent({
    httpMethod: 'POST',
    path: '/api/login',
    headers: { 'Content-Type': 'application/json', AUTHORIZATION: 'Bearer x' },
  }));
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/login');
  assert.equal(request.ip, '203.0.113.20');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.authorization, 'Bearer x');
});

test('la ip sale de requestContext.identity.sourceIp, no de las cabeceras', () => {
  const request = toRequest(restEvent({ headers: { 'X-Forwarded-For': '198.51.100.1' } }));
  assert.equal(request.ip, '203.0.113.20');
  assert.equal(toRequest(restEvent({ requestContext: undefined })).ip, null);
});

test('un cuerpo sin base64 se entrega tal cual', async () => {
  const { app } = buildApp();
  const response = await handlerFor(app)(restEvent({
    httpMethod: 'POST',
    path: '/api/login',
    headers: { 'Content-Type': 'application/json' },
    body: loginBody,
  }));
  assert.equal(response.statusCode, 200);
});

test('un cuerpo en base64 se decodifica', async () => {
  const { app } = buildApp();
  const response = await handlerFor(app)(restEvent({
    httpMethod: 'POST',
    path: '/api/login',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(loginBody).toString('base64'),
    isBase64Encoded: true,
  }));
  assert.equal(response.statusCode, 200);
  assert.ok(JSON.parse(response.body).token);
});

test('un cuerpo en base64 con tildes conserva sus caracteres', () => {
  const body = toRequest(restEvent({
    body: Buffer.from('{"a":"contraseña"}').toString('base64'),
    isBase64Encoded: true,
  })).body;
  assert.equal(body.toString('utf8'), '{"a":"contraseña"}');
});

test('el tope de 4 KB se mide sobre el cuerpo ya decodificado', async () => {
  const { app } = buildApp();
  const base = { httpMethod: 'POST', path: '/api/login', headers: { 'Content-Type': 'application/json' } };
  const inBase64 = (bytes) => Buffer.alloc(bytes, 0x20).toString('base64');
  const atLimit = await handlerFor(app)(restEvent({ ...base, body: inBase64(4096), isBase64Encoded: true }));
  assert.equal(atLimit.statusCode, 400);
  const over = await handlerFor(app)(restEvent({ ...base, body: inBase64(4097), isBase64Encoded: true }));
  assert.equal(over.statusCode, 413);
});

test('sin cuerpo el login responde 400', async () => {
  const { app } = buildApp();
  const response = await handlerFor(app)(restEvent({
    httpMethod: 'POST',
    path: '/api/login',
    headers: { 'Content-Type': 'application/json' },
  }));
  assert.equal(response.statusCode, 400);
});

test('un parámetro repetido en multiValueQueryStringParameters responde 400', async () => {
  const { app } = buildApp();
  const token = await signIn(app);
  const response = await handlerFor(app)(restEvent({
    path: '/api/sms',
    headers: { Authorization: `Bearer ${token}` },
    // API Gateway deja en queryStringParameters solo el último valor; esa vista no debe ganar.
    queryStringParameters: { ...VALID_SEARCH, account: '102' },
    multiValueQueryStringParameters: {
      account: ['999', '102'],
      start: [VALID_SEARCH.start],
      end: [VALID_SEARCH.end],
    },
  }));
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, 'invalid_request');
});

test('funciona solo con queryStringParameters', async () => {
  const { app } = buildApp();
  const token = await signIn(app);
  const response = await handlerFor(app)(restEvent({
    path: '/api/sms',
    headers: { Authorization: `Bearer ${token}` },
    queryStringParameters: VALID_SEARCH,
  }));
  assert.equal(response.statusCode, 200);
});

test('dos cabeceras Authorization no dejan pasar ninguna', async () => {
  const { app } = buildApp();
  const token = await signIn(app);
  const response = await handlerFor(app)(restEvent({
    path: '/api/sms',
    headers: { Authorization: `Bearer ${token}` },
    multiValueHeaders: { Authorization: [`Bearer ${token}`, 'Bearer otro'] },
    queryStringParameters: VALID_SEARCH,
  }));
  assert.equal(response.statusCode, 401);
});

test('dos Content-Type no dejan pasar el login', async () => {
  const { app } = buildApp();
  const response = await handlerFor(app)(restEvent({
    httpMethod: 'POST',
    path: '/api/login',
    multiValueHeaders: { 'Content-Type': ['application/json', 'text/plain'] },
    body: loginBody,
  }));
  assert.equal(response.statusCode, 415);
});

test('una cabecera o parámetro llamado __proto__ no contamina nada', () => {
  const request = toRequest(restEvent({
    headers: JSON.parse('{"__proto__":"x","Authorization":"y"}'),
    queryStringParameters: JSON.parse('{"__proto__":"x","account":"1"}'),
  }));
  assert.equal(Object.getPrototypeOf(request.headers), null);
  assert.equal(request.headers.authorization, 'y');
  assert.deepEqual(request.query.account, ['1']);
  assert.equal({}.x, undefined);
});

test('la respuesta tiene la forma que espera API Gateway', async () => {
  const { app } = buildApp();
  const response = await handlerFor(app)(restEvent());
  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.body, 'string');
  assert.equal(response.isBase64Encoded, false);
  assert.ok(response.headers['Content-Security-Policy']);
});

test('un evento malformado responde 500 con las cabeceras, sin lanzar', async () => {
  const { app } = buildApp();
  const spy = mock.method(console, 'error', () => {});
  const response = await handlerFor(app)(restEvent({ body: 42 }));
  spy.mock.restore();
  assert.equal(response.statusCode, 500);
  assert.ok(response.headers['Content-Security-Policy'].endsWith("frame-ancestors 'none'"));
});

test('si la app no arranca responde 500 con frame-ancestors none y sin detalles', async () => {
  const spy = mock.method(console, 'error', () => {});
  const failure = new Error('token_secret demasiado corto: secreto-filtrado');
  failure.code = 'config_token_secret_too_short';
  const response = await createHandler(async () => {
    throw failure;
  })(restEvent());
  const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  spy.mock.restore();
  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).error, 'internal');
  assert.ok(response.headers['Content-Security-Policy'].endsWith("frame-ancestors 'none'"));
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(response.body, /secreto-filtrado/);
  assert.doesNotMatch(logged, /secreto-filtrado/);
  assert.match(logged, /config_token_secret_too_short/);
});

const BUSY_MESSAGE = 'El servicio está ocupado. Inténtalo de nuevo en unos minutos.';
const never = () => new Promise(() => {});
const remaining = (ms) => ({ getRemainingTimeInMillis: () => ms });
const pendingMark = Symbol('pendiente');
const stateOf = (promise) => Promise.race([promise, Promise.resolve(pendingMark)]);

function assertBusyResponse(response) {
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { error: 'busy', message: BUSY_MESSAGE });
  assert.ok(response.headers['Content-Security-Policy'].endsWith("frame-ancestors 'none'"));
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.isBase64Encoded, false);
}

test('el plazo por omisión deja el margen dentro del timeout', () => {
  assert.equal(DEADLINE_MARGIN_MS, 2000);
  assert.equal(DEFAULT_DEADLINE_MS, 23000);
});

test('si la configuración no termina de cargar, responde 503 antes del plazo y descarta la app', async () => {
  const spy = mock.method(console, 'error', () => {});
  let discarded = 0;
  const startedAt = performance.now();
  const response = await createHandler(never, () => { discarded += 1; })(restEvent(), remaining(DEADLINE_MARGIN_MS + 30));
  const logged = spy.mock.calls.map((call) => call.arguments.join(' '));
  spy.mock.restore();
  assertBusyResponse(response);
  assert.ok(performance.now() - startedAt < DEADLINE_MARGIN_MS);
  assert.equal(discarded, 1);
  assert.deepEqual(logged, ['{"event":"request_deadline_exceeded"}']);
});

test('si la petición no termina, responde 503 sin datos de la petición en el registro', async () => {
  const spy = mock.method(console, 'error', () => {});
  let discarded = 0;
  const event = restEvent({ path: '/api/sms', headers: { Authorization: 'Bearer token-privado' } });
  const response = await createHandler(async () => ({ handle: never }), () => { discarded += 1; })(event, remaining(DEADLINE_MARGIN_MS + 30));
  const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  spy.mock.restore();
  assertBusyResponse(response);
  assert.equal(discarded, 1);
  assert.doesNotMatch(logged, /token-privado|api\/sms/);
});

test('sin tiempo restante, responde 503 de inmediato en vez de dejar morir la Lambda', async () => {
  const spy = mock.method(console, 'error', () => {});
  const response = await createHandler(never)(restEvent(), remaining(500));
  spy.mock.restore();
  assertBusyResponse(response);
});

test('sin context, el plazo es de 23 s', async () => {
  const spy = mock.method(console, 'error', () => {});
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = createHandler(never)(restEvent());
    mock.timers.tick(DEFAULT_DEADLINE_MS - 1);
    assert.equal(await stateOf(pending), pendingMark);
    mock.timers.tick(1);
    assertBusyResponse(await pending);
  } finally {
    mock.timers.reset();
    spy.mock.restore();
  }
});

test('una respuesta a tiempo no descarta la app ni deja el temporizador corriendo', async () => {
  const { app } = buildApp();
  const timersBefore = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  let discarded = 0;
  const response = await createHandler(async () => app, () => { discarded += 1; })(restEvent(), remaining(60000));
  assert.equal(response.statusCode, 200);
  assert.equal(discarded, 0);
  const timersAfter = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  assert.ok(timersAfter <= timersBefore);
});

test('un rechazo que llega después del plazo no tumba el proceso', async () => {
  const spy = mock.method(console, 'error', () => {});
  let rejectLater;
  const late = new Promise((_, reject) => { rejectLater = reject; });
  const response = await createHandler(() => late)(restEvent(), remaining(DEADLINE_MARGIN_MS + 10));
  rejectLater(new Error('tarde'));
  await new Promise((resolve) => { setImmediate(resolve); });
  spy.mock.restore();
  assertBusyResponse(response);
});

test('la app se construye una vez por contenedor', async () => {
  let builds = 0;
  const holder = createAppHolder(async () => { builds += 1; return { handle() {} }; });
  assert.equal(await holder.get(), await holder.get());
  assert.equal(builds, 1);
});

test('si construir falla, la siguiente petición lo reintenta', async () => {
  let builds = 0;
  const holder = createAppHolder(async () => {
    builds += 1;
    if (builds === 1) throw new Error('Parameter Store no contestó');
    return { handle() {} };
  });
  await assert.rejects(holder.get());
  assert.ok(await holder.get());
  assert.equal(builds, 2);
});

test('descartar cierra la app sin esperarla, y la siguiente petición construye otra', async () => {
  const apps = [];
  const holder = createAppHolder(async () => {
    const app = { closed: 0, close() { this.closed += 1; return never(); } };
    apps.push(app);
    return app;
  });
  const first = await holder.get();
  holder.discard();
  const second = await holder.get();
  assert.notEqual(second, first);
  assert.equal(first.closed, 1);
  assert.equal(second.closed, 0);
});

test('un cierre que falla no tumba el proceso y registra solo el código', async () => {
  const failure = Object.assign(new Error('detalle privado'), { code: 'ER_X' });
  for (const close of [async () => { throw failure; }, () => { throw failure; }]) {
    const spy = mock.method(console, 'error', () => {});
    const holder = createAppHolder(async () => ({ close }));
    await holder.get();
    holder.discard();
    await new Promise((resolve) => { setImmediate(resolve); });
    const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
    spy.mock.restore();
    assert.match(logged, /app_close_failed/);
    assert.match(logged, /ER_X/);
    assert.doesNotMatch(logged, /detalle privado/);
  }
});

test('una carga descartada se cierra si termina tarde, y si falla tarde no borra la que la reemplazó', async () => {
  const pending = [];
  let builds = 0;
  const holder = createAppHolder(() => {
    builds += 1;
    return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
  });
  holder.get();
  holder.discard();
  const replacement = holder.get();
  const closedLate = { closed: 0, close() { this.closed += 1; } };
  pending[0].resolve(closedLate);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(closedLate.closed, 1);

  holder.discard();
  const third = holder.get();
  const spy = mock.method(console, 'error', () => {});
  pending[1].reject(new Error('tarde'));
  await replacement.catch(() => {});
  await new Promise((resolve) => { setImmediate(resolve); });
  spy.mock.restore();
  assert.equal(holder.get(), third);
  assert.equal(builds, 3);
  pending[2].resolve({ close() {} });
});
