'use strict';

const assert = require('node:assert/strict');
const { mock, test } = require('node:test');

const { buildContentSecurityPolicy, buildSecurityHeaders, parseFrameAncestors } = require('../../src/headers');
const { createHandler } = require('../../src/handler');
const { buildApp, signIn, getSms, postLogin, VALID_SEARCH } = require('./support/app_fixture');

const BASE_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; ";

function silently(fn) {
  const spy = mock.method(console, 'error', () => {});
  try {
    return { result: fn(), logged: spy.mock.calls.map((call) => call.arguments.join(' ')) };
  } finally {
    spy.mock.restore();
  }
}

const ancestorsOf = (raw, stage) => silently(() => buildContentSecurityPolicy(raw, stage)).result
  .replace(BASE_POLICY, '');

test('la CSP es exactamente la del contrato', () => {
  assert.equal(
    buildContentSecurityPolicy('https://a.example.com'),
    `${BASE_POLICY}frame-ancestors https://a.example.com`
  );
});

test('sin configuración nadie puede embeber', () => {
  for (const raw of [undefined, null, '', '   ', 42, {}, ['https://a.example.com']]) {
    assert.equal(ancestorsOf(raw), "frame-ancestors 'none'", `valor ${JSON.stringify(raw)}`);
  }
});

test('acepta varios dominios separados por espacio, con puerto', () => {
  assert.equal(
    ancestorsOf('https://a.example.com  https://b.example.com:8443'),
    'frame-ancestors https://a.example.com https://b.example.com:8443'
  );
});

test('descarta el elemento que no calza y conserva los válidos', () => {
  assert.equal(
    ancestorsOf('https://a.example.com http://b.example.com'),
    'frame-ancestors https://a.example.com'
  );
});

test('si ningún elemento calza queda en none', () => {
  for (const raw of [
    '*',
    'https://*.example.com',
    'http://a.example.com',
    'example.com',
    'HTTPS://A.EXAMPLE.COM',
    'https://a.example.com/ruta',
    'https://a.example.com:123456',
    'https://usuario@a.example.com',
    "'self'",
    "'unsafe-inline'",
    'data:',
    'javascript:alert(1)',
  ]) {
    assert.equal(ancestorsOf(raw), "frame-ancestors 'none'", `valor ${raw}`);
  }
});

test('un punto y coma no puede inyectar otra directiva', () => {
  for (const raw of [
    'https://a.example.com;script-src *',
    'https://a.example.com; script-src *',
    "https://a.example.com;frame-ancestors *",
  ]) {
    const value = ancestorsOf(raw);
    assert.equal(value, "frame-ancestors 'none'", `valor ${raw}`);
  }
});

test('un elemento válido no se salva si otro trae punto y coma', () => {
  assert.equal(
    ancestorsOf('https://a.example.com https://b.example.com;script-src'),
    'frame-ancestors https://a.example.com'
  );
});

test('un salto de línea no puede inyectar una cabecera', () => {
  for (const raw of [
    'https://a.example.com\r\nX-Inyectada: 1',
    'https://a.example.com\nX-Inyectada:1',
    'https://a.example.com\r\n',
    '\nhttps://a.example.com',
    'https://a.example.com\tX-Inyectada:1',
  ]) {
    const policy = silently(() => buildContentSecurityPolicy(raw)).result;
    assert.doesNotMatch(policy, /[\r\n\t]/);
    assert.doesNotMatch(policy, /X-Inyectada/);
    assert.ok(policy.endsWith("frame-ancestors 'none'"), `valor ${JSON.stringify(raw)}`);
  }
});

test('un valor con un salto de línea final no salta la validación del fin de línea', () => {
  assert.deepEqual(silently(() => parseFrameAncestors('https://a.example.com\n')).result, []);
});

test('registra la cantidad descartada, nunca el valor', () => {
  const { logged } = silently(() => parseFrameAncestors('https://a.example.com http://secreto.example.com'));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /frame_ancestors_invalid/);
  assert.doesNotMatch(logged[0], /secreto/);
});

test('http solo se acepta en local, y solo hacia localhost o 127.0.0.1', () => {
  assert.equal(
    ancestorsOf('http://127.0.0.1:8788 http://localhost:3000 http://localhost', 'local'),
    'frame-ancestors http://127.0.0.1:8788 http://localhost:3000 http://localhost'
  );
  assert.equal(ancestorsOf('http://127.0.0.1:8788'), "frame-ancestors 'none'");
  assert.equal(ancestorsOf('http://127.0.0.1:8788', 'prod'), "frame-ancestors 'none'");
  assert.equal(ancestorsOf('http://otro.example.com', 'local'), "frame-ancestors 'none'");
  assert.equal(ancestorsOf('http://127.0.0.1.example.com', 'local'), "frame-ancestors 'none'");
  assert.equal(ancestorsOf('http://localhost.example.com', 'local'), "frame-ancestors 'none'");
});

test('las demás cabeceras son las del contrato y nunca hay X-Frame-Options', () => {
  const headers = buildSecurityHeaders({ frameAncestors: 'https://a.example.com' });
  assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(headers['X-Robots-Tag'], 'noindex');
  assert.equal(Object.keys(headers).some((name) => name.toLowerCase() === 'x-frame-options'), false);
});

function assertSecure(response) {
  assert.equal(response.headers['Content-Security-Policy'], `${BASE_POLICY}frame-ancestors https://embed.example.com`);
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(response.headers['X-Robots-Tag'], 'noindex');
  assert.ok(response.headers['Strict-Transport-Security']);
  assert.equal(Object.keys(response.headers).some((name) => name.toLowerCase() === 'x-frame-options'), false);
}

test('todas las respuestas llevan las cabeceras, también los errores', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  const responses = {
    200: await app.handle({ method: 'GET', path: '/', headers: {} }),
    400: await getSms(app, token, { account: 'x' }),
    401: await getSms(app, null, VALID_SEARCH),
    403: await getSms(app, token, { ...VALID_SEARCH, account: '999' }),
    404: await app.handle({ method: 'GET', path: '/nada', headers: {} }),
    405: await app.handle({ method: 'DELETE', path: '/api/sms', headers: {} }),
    415: await postLogin(app, {}, {}),
  };
  for (const [status, response] of Object.entries(responses)) {
    assert.equal(response.statusCode, Number(status));
    assertSecure(response);
  }
  const spy = mock.method(console, 'error', () => {});
  db.failOn(/./, new Error('falla'));
  const failed = await getSms(app, token, VALID_SEARCH);
  spy.mock.restore();
  assert.equal(failed.statusCode, 500);
  assertSecure(failed);
});

test('Cache-Control: no-store en /api y no-cache en los estáticos', async () => {
  const { app } = buildApp();
  const token = await signIn(app);
  for (const response of [
    await postLogin(app, { username: 'demo', password: 'x' }),
    await getSms(app, token, VALID_SEARCH),
    await app.handle({ method: 'GET', path: '/api/nada', headers: {} }),
    await app.handle({ method: 'GET', path: '/api/login', headers: {} }),
    await postLogin(app, {}, {}),
  ]) {
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  for (const path of ['/app.js', '/app.css', '/']) {
    const response = await app.handle({ method: 'GET', path, headers: {} });
    assert.equal(response.headers['Cache-Control'], 'no-cache');
  }
});

test('una configuración de frame_ancestors inválida deja la app en none, sin caerse', async () => {
  const spy = mock.method(console, 'error', () => {});
  const { app } = buildApp({ config: { frameAncestors: 'http://otro.example.com; script-src *' } });
  spy.mock.restore();
  const response = await app.handle({ method: 'GET', path: '/', headers: {} });
  assert.ok(response.headers['Content-Security-Policy'].endsWith("frame-ancestors 'none'"));
});

const POLICY_WITHOUT_ANCESTORS = BASE_POLICY.trimEnd().replace(/;$/, '');
const ACCESS_CONTROL = /^access-control-/i;

test('solo sin-restriccion exacto omite frame-ancestors y deja el resto intacto', () => {
  assert.equal(buildContentSecurityPolicy('sin-restriccion'), POLICY_WITHOUT_ANCESTORS);
  assert.equal(buildContentSecurityPolicy('sin-restriccion', 'prod'), POLICY_WITHOUT_ANCESTORS);
  assert.equal(buildSecurityHeaders({ frameAncestors: 'sin-restriccion', stage: 'prod' })['Content-Security-Policy'], POLICY_WITHOUT_ANCESTORS);
});

test('cualquier variante de sin-restriccion queda cerrada, sin omitir nada', () => {
  for (const raw of [
    '*',
    "'none'",
    ' sin-restriccion',
    'sin-restriccion ',
    'SIN-RESTRICCION',
    'Sin-Restriccion',
    'sin-restriccion\n',
    'sin_restriccion',
    'sin-restricción',
  ]) {
    assert.equal(ancestorsOf(raw), "frame-ancestors 'none'", `valor ${JSON.stringify(raw)}`);
  }
  assert.equal(ancestorsOf('sin-restriccion https://x.example.com'), 'frame-ancestors https://x.example.com');
});

test('nunca sale frame-ancestors * ni X-Frame-Options', () => {
  for (const raw of ['*', 'sin-restriccion', 'https://a.example.com *', '', undefined]) {
    const headers = silently(() => buildSecurityHeaders({ frameAncestors: raw })).result;
    assert.doesNotMatch(headers['Content-Security-Policy'], /frame-ancestors \*/);
    assert.equal(Object.keys(headers).some((name) => name.toLowerCase() === 'x-frame-options'), false);
  }
});

test('sin configuración, también en el error de la app abierta, queda en none', async () => {
  assert.ok(buildSecurityHeaders()['Content-Security-Policy'].endsWith("frame-ancestors 'none'"));
  const spy = mock.method(console, 'error', () => {});
  const failing = createHandler(async () => { throw new Error('no arrancó'); });
  const response = await failing({ httpMethod: 'GET', path: '/', headers: { Origin: 'null' } });
  spy.mock.restore();
  assert.equal(response.statusCode, 500);
  assert.ok(response.headers['Content-Security-Policy'].endsWith("frame-ancestors 'none'"));
  assert.equal(Object.keys(response.headers).some((name) => ACCESS_CONTROL.test(name)), false);
});

function buildLogged(config) {
  const spy = mock.method(console, 'error', () => {});
  const built = buildApp({ config });
  const logged = spy.mock.calls.map((call) => call.arguments.join(' '));
  spy.mock.restore();
  return { ...built, logged };
}

test('la app registra frame_ancestors_open al crearse, y solo con el valor exacto', async () => {
  const open = buildLogged({ frameAncestors: 'sin-restriccion' });
  assert.deepEqual(open.logged, ['{"event":"frame_ancestors_open"}']);
  const response = await open.app.handle({ method: 'GET', path: '/', headers: {} });
  assert.equal(response.headers['Content-Security-Policy'], POLICY_WITHOUT_ANCESTORS);

  assert.deepEqual(buildLogged({ frameAncestors: 'https://a.example.com' }).logged, []);
  assert.deepEqual(buildLogged({ frameAncestors: '' }).logged, []);
  assert.equal(buildLogged({ frameAncestors: 'SIN-RESTRICCION' }).logged.some((line) => line.includes('frame_ancestors_open')), false);
});

const accessControlOf = (response) => Object.keys(response.headers).filter((name) => ACCESS_CONTROL.test(name));
const OPAQUE = { origin: 'null' };

async function opaqueResponses(app, headers) {
  const token = await signIn(app);
  const json = { 'content-type': 'application/json' };
  return {
    200: await getSms(app, token, VALID_SEARCH, { headers: { ...headers, authorization: `Bearer ${token}` } }),
    400: await app.handle({ method: 'POST', path: '/api/login', headers: { ...headers, ...json }, body: '[]' }),
    401: await getSms(app, null, VALID_SEARCH, { headers }),
    403: await getSms(app, token, { ...VALID_SEARCH, account: '999' }, { headers: { ...headers, authorization: `Bearer ${token}` } }),
    404: await app.handle({ method: 'GET', path: '/api/nada', headers }),
    405: await app.handle({ method: 'DELETE', path: '/api/sms', headers }),
    413: await app.handle({ method: 'POST', path: '/api/login', headers: { ...headers, ...json }, body: 'x'.repeat(4097) }),
    415: await app.handle({ method: 'POST', path: '/api/login', headers, body: '{}' }),
  };
}

test('CORS encendido con Origin: null: todas las respuestas de /api llevan sus cabeceras, también los errores', async () => {
  const { app, db } = buildApp({ config: { corsOpaque: true } });
  const responses = await opaqueResponses(app, OPAQUE);
  const token = await signIn(app);
  const spy = mock.method(console, 'error', () => {});
  db.failOn(/FROM connectus_pages\.login WHERE id = \? LIMIT 1$/, new Error('falla'));
  responses[500] = await getSms(app, token, VALID_SEARCH, { headers: { ...OPAQUE, authorization: `Bearer ${token}` } });
  spy.mock.restore();
  for (const [status, response] of Object.entries(responses)) {
    assert.equal(response.statusCode, Number(status));
    assert.equal(response.headers['Access-Control-Allow-Origin'], 'null', `respuesta ${status}`);
    assert.equal(response.headers.Vary, 'Origin', `respuesta ${status}`);
    assert.deepEqual(accessControlOf(response), ['Access-Control-Allow-Origin'], `respuesta ${status}`);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
});

for (const [path, status] of [['/api/login', 204], ['/api/sms', 204], ['/api/nada', 204]]) {
  test(`CORS encendido: OPTIONS ${path} con Origin: null responde ${status} sin cuerpo y sin tocar la base`, async () => {
    const { app, db } = buildApp({ config: { corsOpaque: true } });
    const response = await app.handle({
      method: 'OPTIONS',
      path,
      headers: { ...OPAQUE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    assert.equal(response.statusCode, status);
    assert.equal(response.body, '');
    assert.equal(response.headers['Access-Control-Allow-Origin'], 'null');
    assert.equal(response.headers['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
    assert.equal(response.headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
    assert.equal(response.headers['Access-Control-Max-Age'], '600');
    assert.equal(response.headers.Vary, 'Origin');
    assert.equal(response.headers['Access-Control-Allow-Credentials'], undefined);
    assert.equal(response.headers['Content-Type'], undefined);
    assert.ok(response.headers['Content-Security-Policy']);
    assert.deepEqual(db.calls, []);
  });
}

test('CORS encendido con otro Origin o sin Origin: nada, y OPTIONS sigue en 404 o 405', async () => {
  const { app } = buildApp({ config: { corsOpaque: true } });
  for (const headers of [{}, { origin: 'https://a.example.com' }, { origin: 'NULL' }, { origin: 'null, null' }, { origin: ' null' }]) {
    for (const response of Object.values(await opaqueResponses(app, headers))) {
      assert.deepEqual(accessControlOf(response), []);
      assert.equal(response.headers.Vary, undefined);
    }
    const allowed = await app.handle({ method: 'OPTIONS', path: '/api/login', headers });
    assert.equal(allowed.statusCode, 405);
    assert.deepEqual(accessControlOf(allowed), []);
    const missing = await app.handle({ method: 'OPTIONS', path: '/api/nada', headers });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(accessControlOf(missing), []);
  }
});

test('CORS encendido: fuera de /api no se abre nada, ni siquiera con Origin: null', async () => {
  const { app } = buildApp({ config: { corsOpaque: true } });
  for (const path of ['/', '/app.js', '/app.css']) {
    const response = await app.handle({ method: 'GET', path, headers: OPAQUE });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(accessControlOf(response), []);
    assert.equal((await app.handle({ method: 'OPTIONS', path, headers: OPAQUE })).statusCode, 405);
  }
  assert.equal((await app.handle({ method: 'OPTIONS', path: '/nada', headers: OPAQUE })).statusCode, 404);
});

test('CORS apagado por omisión: con Origin: null no sale ninguna cabecera, y OPTIONS sigue en 404 o 405', async () => {
  const { app } = buildApp();
  for (const response of Object.values(await opaqueResponses(app, OPAQUE))) {
    assert.deepEqual(accessControlOf(response), []);
    assert.equal(response.headers.Vary, undefined);
  }
  assert.equal((await app.handle({ method: 'OPTIONS', path: '/api/login', headers: OPAQUE })).statusCode, 405);
  assert.equal((await app.handle({ method: 'OPTIONS', path: '/api/nada', headers: OPAQUE })).statusCode, 404);
});
