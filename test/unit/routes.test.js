'use strict';

const assert = require('node:assert/strict');
const { mock, test } = require('node:test');

const { buildApp, postLogin, PASSWORD } = require('./support/app_fixture');

const errorOf = (response) => JSON.parse(response.body).error;

for (const [path, contentType] of [
  ['/', 'text/html; charset=utf-8'],
  ['/app.js', 'text/javascript; charset=utf-8'],
  ['/app.css', 'text/css; charset=utf-8'],
]) {
  test(`GET ${path} sirve el estático`, async () => {
    const { app } = buildApp();
    const response = await app.handle({ method: 'GET', path, headers: {} });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], contentType);
    assert.ok(response.body.length > 0);
  });
}

for (const path of ['/nada', '/index.html', '/api', '/api/', '/api/nada', '/api/login/', '/api/sms/', '/app.js/', '/APP.JS', '//', '']) {
  test(`${JSON.stringify(path)} responde 404`, async () => {
    const { app } = buildApp();
    const response = await app.handle({ method: 'GET', path, headers: {} });
    assert.equal(response.statusCode, 404);
    assert.equal(errorOf(response), 'not_found');
    assert.ok(JSON.parse(response.body).message);
  });
}

for (const [method, path, allow] of [
  ['POST', '/', 'GET'],
  ['HEAD', '/', 'GET'],
  ['PUT', '/app.js', 'GET'],
  ['DELETE', '/app.css', 'GET'],
  ['GET', '/api/login', 'POST'],
  ['PUT', '/api/login', 'POST'],
  ['OPTIONS', '/api/login', 'POST'],
  ['POST', '/api/sms', 'GET'],
  ['constructor', '/api/sms', 'GET'],
]) {
  test(`${method} ${path} responde 405`, async () => {
    const { app } = buildApp();
    const response = await app.handle({ method, path, headers: {} });
    assert.equal(response.statusCode, 405);
    assert.equal(errorOf(response), 'method_not_allowed');
    assert.equal(response.headers.Allow, allow);
  });
}

for (const headers of [
  {},
  { 'content-type': 'text/plain' },
  { 'content-type': 'application/x-www-form-urlencoded' },
  { 'content-type': 'multipart/form-data; boundary=x' },
  { 'content-type': 'application/jsonp' },
  { 'content-type': 'application/json, text/plain' },
  { 'content-type': 'text/plain; application/json' },
]) {
  test(`POST /api/login con ${JSON.stringify(headers)} responde 415`, async () => {
    const { app, db } = buildApp();
    const response = await postLogin(app, { username: 'demo', password: PASSWORD }, headers);
    assert.equal(response.statusCode, 415);
    assert.equal(errorOf(response), 'unsupported_media_type');
    assert.equal(db.calls.length, 0);
  });
}

for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/json;charset=UTF-8']) {
  test(`POST /api/login acepta Content-Type ${contentType}`, async () => {
    const { app } = buildApp();
    const response = await postLogin(app, { username: 'demo', password: PASSWORD }, { 'content-type': contentType });
    assert.equal(response.statusCode, 200);
  });
}

for (const path of [
  '/../package.json',
  '/..%2f..%2fpackage.json',
  '/%2e%2e/%2e%2e/etc/passwd',
  '/../../../../etc/passwd',
  '/app.js/../../package.json',
  '/public/app.js',
  '/./app.js',
  '/src/app.js',
  '/.env',
  '/test/.env.local',
  '/app.js%00.css',
  '/constructor',
  '/__proto__',
  '/toString',
  '/hasOwnProperty',
]) {
  test(`un estático fuera del mapa no se sirve: ${path}`, async () => {
    const { app } = buildApp();
    const response = await app.handle({ method: 'GET', path, headers: {} });
    assert.equal(response.statusCode, 404);
    assert.equal(errorOf(response), 'not_found');
  });
}

test('sin publicDir sirve la carpeta public del repo', async () => {
  const { createApp } = require('../../src/app');
  const app = createApp({ db: {}, config: { tokenSecret: 'x'.repeat(40) } });
  for (const path of ['/', '/app.js', '/app.css']) {
    const response = await app.handle({ method: 'GET', path, headers: {} });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.length > 0);
  }
});

test('si falta el archivo del estático responde 500 sin decir la ruta', async () => {
  const { createApp } = require('../../src/app');
  const spy = mock.method(console, 'error', () => {});
  const app = createApp({
    db: {},
    config: { tokenSecret: 'x'.repeat(40) },
    publicDir: '/ruta/que/no/existe/secreta',
  });
  const response = await app.handle({ method: 'GET', path: '/', headers: {} });
  const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  spy.mock.restore();
  assert.equal(response.statusCode, 500);
  assert.equal(errorOf(response), 'internal');
  assert.doesNotMatch(response.body, /secreta/);
  assert.doesNotMatch(logged, /secreta/);
  assert.match(logged, /ENOENT/);
});
