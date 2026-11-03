'use strict';

const assert = require('node:assert/strict');
const { mock, test } = require('node:test');

const { buildContentSecurityPolicy, buildSecurityHeaders, parseFrameAncestors } = require('../../src/headers');
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
