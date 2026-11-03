'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { mock, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');

const { LOGIN_FAILURE_FLOOR_MS, verifyToken } = require('../../src/auth');
const { buildApp, loginRow, postLogin, NOW_MS, PASSWORD, TOKEN_SECRET } = require('./support/app_fixture');
const { mysqlError } = require('./support/fake_db');

const FAILED_MESSAGE = 'Usuario o contraseña incorrectos, o acceso bloqueado temporalmente.';
const NOW_SECONDS = NOW_MS / 1000;

test('un login correcto devuelve token, vigencia y cuentas', async () => {
  const { app } = buildApp();
  const response = await postLogin(app, { username: 'demo', password: PASSWORD });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(Object.keys(body).sort(), ['accounts', 'expiresIn', 'token']);
  assert.equal(body.expiresIn, 3600);
  assert.deepEqual(body.accounts, [{ id: 101, name: 'Cuenta Demo 101' }, { id: 102, name: 'Cuenta Demo 102' }]);
  assert.deepEqual(verifyToken(body.token, TOKEN_SECRET, NOW_SECONDS), { loginId: 1, tokenVersion: 0 });
});

test('el token no incluye las cuentas', async () => {
  const { app } = buildApp();
  const { token } = JSON.parse((await postLogin(app, { username: 'demo', password: PASSWORD })).body);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'iss', 'sub', 'ver']);
});

test('el token lleva la versión de token del login', async () => {
  const { app, db } = buildApp();
  db.state.logins[0].tokenVersion = 4;
  const { token } = JSON.parse((await postLogin(app, { username: 'demo', password: PASSWORD })).body);
  assert.deepEqual(verifyToken(token, TOKEN_SECRET, NOW_SECONDS), { loginId: 1, tokenVersion: 4 });
});

test('un login sin cuentas entra con la lista vacía', async () => {
  const { app } = buildApp({ seed: { loginAccounts: [] } });
  const response = await postLogin(app, { username: 'demo', password: PASSWORD });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).accounts, []);
});

test('entrar limpia el contador y deja la hora del último acceso', async () => {
  const { app, db } = buildApp();
  db.state.logins[0].failedAttempts = 3;
  await postLogin(app, { username: 'demo', password: PASSWORD });
  assert.equal(db.state.logins[0].failedAttempts, 0);
  assert.equal(db.state.logins[0].lockedUntil, 0);
  assert.ok(db.state.logins[0].lastLoginAt);
});

function assertLoginRejected(response) {
  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'invalid_credentials', message: FAILED_MESSAGE });
}

test('todas las fallas responden exactamente igual', async () => {
  const { app, db } = buildApp({
    seed: {
      logins: [
        loginRow(),
        loginRow({ id: 2, username: 'inactivo', active: 0 }),
        loginRow({ id: 3, username: 'bloqueado', lockedUntil: NOW_SECONDS + 60 }),
      ],
    },
  });
  const bodies = new Set();
  for (const [username, password] of [
    ['demo', 'clave-incorrecta'],
    ['no-existe', PASSWORD],
    ['inactivo', PASSWORD],
    ['bloqueado', PASSWORD],
  ]) {
    const response = await postLogin(app, { username, password });
    assertLoginRejected(response);
    bodies.add(response.body);
  }
  assert.equal(bodies.size, 1);
  assert.equal(db.state.audit.every((row) => row.action === 'login_fail'), true);
});

// Se cuentan los scrypt reales y se mira contra qué sal se calcularon.
async function scryptSaltsDuring(fn) {
  const spy = mock.method(crypto, 'scrypt');
  try {
    await fn();
    return spy.mock.calls.map((call) => Buffer.from(call.arguments[1]).toString('base64'));
  } finally {
    spy.mock.restore();
  }
}

const saltOf = (row) => row.passwordHash.split('$')[4];

test('el usuario inexistente también calcula un scrypt', async () => {
  const { app } = buildApp();
  const salts = await scryptSaltsDuring(() => postLogin(app, { username: 'no-existe', password: PASSWORD }));
  assert.equal(salts.length, 1);
});

test('una clave incorrecta se compara contra el hash real', async () => {
  const { app, db } = buildApp();
  const salts = await scryptSaltsDuring(() => postLogin(app, { username: 'demo', password: 'mala' }));
  assert.deepEqual(salts, [saltOf(db.state.logins[0])]);
});

test('mientras está bloqueado calcula un scrypt, pero no contra el hash real', async () => {
  const { app, db } = buildApp();
  db.state.logins[0].lockedUntil = NOW_SECONDS + 60;
  const salts = await scryptSaltsDuring(() => postLogin(app, { username: 'demo', password: PASSWORD }));
  assert.equal(salts.length, 1);
  assert.notEqual(salts[0], saltOf(db.state.logins[0]));
});

test('un usuario inactivo calcula un scrypt, pero no contra el hash real', async () => {
  const { app, db } = buildApp();
  db.state.logins[0].active = 0;
  const salts = await scryptSaltsDuring(() => postLogin(app, { username: 'demo', password: PASSWORD }));
  assert.equal(salts.length, 1);
  assert.notEqual(salts[0], saltOf(db.state.logins[0]));
});

test('un hash guardado malformado se responde como una clave incorrecta', async () => {
  const { app, db } = buildApp();
  db.state.logins[0].passwordHash = 'texto-plano';
  assertLoginRejected(await postLogin(app, { username: 'demo', password: 'texto-plano' }));
  assert.equal(db.state.logins[0].failedAttempts, 1);
});

test('5 fallos seguidos bloquean 15 minutos', async () => {
  const { app, db } = buildApp();
  const row = db.state.logins[0];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assertLoginRejected(await postLogin(app, { username: 'demo', password: 'mala' }));
    assert.equal(row.failedAttempts, attempt);
    assert.equal(row.lockedUntil, 0);
  }
  assertLoginRejected(await postLogin(app, { username: 'demo', password: 'mala' }));
  assert.equal(row.failedAttempts, 0);
  assert.equal(row.lockedUntil, NOW_SECONDS + 900);
  assertLoginRejected(await postLogin(app, { username: 'demo', password: PASSWORD }));
});

test('la sentencia del fallo es una sola y calcula locked_until antes de reiniciar el contador', async () => {
  const { app, db } = buildApp();
  await postLogin(app, { username: 'demo', password: 'mala' });
  const updates = db.calls.filter(({ sql }) => sql.startsWith('UPDATE'));
  assert.equal(updates.length, 1);
  const { sql } = updates[0];
  assert.ok(sql.indexOf('locked_until = IF(') < sql.indexOf('failed_attempts = IF('));
  assert.match(sql, /UTC_TIMESTAMP\(\) \+ INTERVAL 15 MINUTE/);
  assert.match(sql, /WHERE id = \?$/);
});

test('mientras está bloqueado los intentos no suman', async () => {
  const { app, db } = buildApp();
  const row = db.state.logins[0];
  row.lockedUntil = NOW_SECONDS + 60;
  await postLogin(app, { username: 'demo', password: 'mala' });
  assert.equal(row.failedAttempts, 0);
  assert.equal(row.lockedUntil, NOW_SECONDS + 60);
  assert.equal(db.calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
});

test('al vencer el bloqueo se puede entrar', async () => {
  const { app, db } = buildApp();
  db.state.logins[0].lockedUntil = NOW_SECONDS - 1;
  assert.equal((await postLogin(app, { username: 'demo', password: PASSWORD })).statusCode, 200);
});

test('un usuario inactivo no suma intentos', async () => {
  const { app, db } = buildApp();
  db.state.logins[0].active = 0;
  await postLogin(app, { username: 'demo', password: 'mala' });
  assert.equal(db.state.logins[0].failedAttempts, 0);
  assert.equal(db.calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
});

async function timedLogin(app, credentials) {
  const startedAt = performance.now();
  const response = await postLogin(app, credentials);
  return { response, elapsed: performance.now() - startedAt };
}

test('el piso de tiempo por omisión es el del contrato', () => {
  assert.equal(LOGIN_FAILURE_FLOOR_MS, 1500);
});

test('el piso de tiempo tapa la escritura extra de un usuario existente', async () => {
  const floorMs = 500;
  const extraWriteMs = 100;
  const { app, db } = buildApp({ loginFailureFloorMs: floorMs });
  const originalWrite = db.write;
  db.write = async (sql, params) => {
    if (sql.startsWith('UPDATE')) await sleep(extraWriteMs);
    return originalWrite(sql, params);
  };
  const existing = await timedLogin(app, { username: 'demo', password: 'clave-incorrecta' });
  const missing = await timedLogin(app, { username: 'no-existe', password: 'clave-incorrecta' });
  assertLoginRejected(existing.response);
  assertLoginRejected(missing.response);
  assert.equal(db.state.logins[0].failedAttempts, 1, 'el usuario existente sí escribió');
  assert.ok(existing.elapsed >= floorMs - 1, `el existente tardó ${existing.elapsed} ms`);
  assert.ok(missing.elapsed >= floorMs - 1, `el inexistente tardó ${missing.elapsed} ms`);
  assert.ok(Math.abs(existing.elapsed - missing.elapsed) < extraWriteMs, 'no debe notarse la escritura extra');
});

test('un login correcto y una falla de la base no esperan el piso de tiempo', async () => {
  const floorMs = 20000;
  const { app, db } = buildApp({ loginFailureFloorMs: floorMs });
  const correct = await timedLogin(app, { username: 'demo', password: PASSWORD });
  assert.equal(correct.response.statusCode, 200);
  assert.ok(correct.elapsed < floorMs);

  db.failOn(/FROM connectus_pages\.login WHERE username/, mysqlError(1226, 'ER_USER_LIMIT_REACHED'));
  const spy = mock.method(console, 'error', () => {});
  const failure = await timedLogin(app, { username: 'demo', password: PASSWORD });
  spy.mock.restore();
  assert.equal(failure.response.statusCode, 503);
  assert.ok(failure.elapsed < floorMs);
});

test('si una falla se pasa del piso de tiempo lo registra, para poder calibrarlo, sin datos del usuario', async () => {
  const { app } = buildApp({ loginFailureFloorMs: 1 });
  const spy = mock.method(console, 'error', () => {});
  await postLogin(app, { username: 'demo', password: 'clave-incorrecta-privada' });
  const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  spy.mock.restore();
  assert.match(logged, /"event":"login_floor_exceeded","elapsedMs":\d+/);
  assert.doesNotMatch(logged, /demo|clave-incorrecta-privada/);
});

for (const [label, body] of [
  ['username como objeto', { username: { $ne: '' }, password: PASSWORD }],
  ['password como objeto', { username: 'demo', password: { $gt: '' } }],
  ['username como arreglo', { username: ['demo'], password: PASSWORD }],
  ['password como arreglo', { username: 'demo', password: [PASSWORD] }],
  ['username como número', { username: 1, password: PASSWORD }],
  ['password como número', { username: 'demo', password: 1 }],
  ['password como booleano', { username: 'demo', password: true }],
  ['password nula', { username: 'demo', password: null }],
  ['sin username', { password: PASSWORD }],
  ['sin password', { username: 'demo' }],
  ['username vacío', { username: '', password: PASSWORD }],
  ['username con espacio', { username: 'de mo', password: PASSWORD }],
  ['username con comilla', { username: "demo'--", password: PASSWORD }],
  ['username con salto de línea', { username: 'demo\n', password: PASSWORD }],
  ['username de 65 caracteres', { username: 'a'.repeat(65), password: PASSWORD }],
  ['password vacía', { username: 'demo', password: '' }],
  ['password de 257 caracteres', { username: 'demo', password: 'a'.repeat(257) }],
  ['cuerpo arreglo', [{ username: 'demo', password: PASSWORD }]],
  ['cuerpo nulo', 'null'],
  ['cuerpo número', '1'],
  ['cuerpo texto', '"demo"'],
  ['cuerpo vacío', ''],
  ['JSON inválido', '{"username":'],
]) {
  test(`POST /api/login con ${label} responde 400 sin tocar la base`, async () => {
    const { app, db } = buildApp();
    const response = await postLogin(app, body);
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error, 'invalid_request');
    assert.equal(db.calls.length, 0);
  });
}

test('acepta un username de 64 caracteres con los símbolos permitidos y una clave de 256', async () => {
  const username = `${'a'.repeat(58)}._@-Z9`;
  assert.equal(username.length, 64);
  const { app } = buildApp();
  assertLoginRejected(await postLogin(app, { username, password: 'a'.repeat(256) }));
});

test('el cuerpo admite 4 KB exactos y rechaza un byte más', async () => {
  const { app } = buildApp();
  const pad = (bytes) => {
    const base = JSON.stringify({ username: 'demo', password: PASSWORD, relleno: '' });
    return base.replace('"relleno":""', `"relleno":"${'x'.repeat(bytes - Buffer.byteLength(base))}"`);
  };
  assert.equal(Buffer.byteLength(pad(4096)), 4096);
  assert.equal((await postLogin(app, pad(4096))).statusCode, 200);
  const tooLarge = await postLogin(app, pad(4097));
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(JSON.parse(tooLarge.body).error, 'payload_too_large');
});

test('el tope de 4 KB se mide en bytes, no en caracteres', async () => {
  const { app } = buildApp();
  const response = await postLogin(app, JSON.stringify({ username: 'demo', password: 'ñ'.repeat(2100) }));
  assert.equal(response.statusCode, 413);
});

test('audit_log registra login_ok y login_fail, con id_login solo si el usuario existe', async () => {
  const { app, db } = buildApp();
  await postLogin(app, { username: 'demo', password: PASSWORD });
  await postLogin(app, { username: 'demo', password: 'mala' });
  await postLogin(app, { username: 'no-existe', password: 'mala' });
  assert.deepEqual(db.state.audit, [
    { idLogin: 1, action: 'login_ok', idAccount: null, detail: null, ip: '203.0.113.10' },
    { idLogin: 1, action: 'login_fail', idAccount: null, detail: null, ip: '203.0.113.10' },
    { idLogin: null, action: 'login_fail', idAccount: null, detail: null, ip: '203.0.113.10' },
  ]);
});

test('si falla la auditoría, el login sigue y se registra solo el código', async () => {
  const { app, db } = buildApp();
  db.failOn(/audit_log/, mysqlError(1142, 'ER_TABLEACCESS_DENIED_ERROR'));
  const spy = mock.method(console, 'error', () => {});
  const response = await postLogin(app, { username: 'demo', password: PASSWORD });
  const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  spy.mock.restore();
  assert.equal(response.statusCode, 200);
  assert.match(logged, /ER_TABLEACCESS_DENIED_ERROR/);
  assert.doesNotMatch(logged, /56900000001|clave-secreta/);
});

for (const [label, pattern, password] of [
  ['una clave mala', /^UPDATE connectus_pages\.login SET locked_until/, 'clave-incorrecta'],
  ['una clave buena', /^UPDATE connectus_pages\.login SET failed_attempts = 0/, PASSWORD],
]) {
  test(`si se pierde la conexión al registrar ${label}, responde 503 en vez de contestar sin saber si quedó`, async () => {
    const { app, db } = buildApp();
    db.failOn(pattern, mysqlError(undefined, 'PROTOCOL_CONNECTION_LOST', { fatal: true }));
    const spy = mock.method(console, 'error', () => {});
    const response = await postLogin(app, { username: 'demo', password });
    spy.mock.restore();
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).error, 'busy');
    assert.equal(db.state.audit.length, 0);
  });
}

for (const [errno, code, statusCode, error] of [
  [1226, 'ER_USER_LIMIT_REACHED', 503, 'busy'],
  [undefined, 'ECONNREFUSED', 503, 'busy'],
  [undefined, 'HANDSHAKE_SSL_ERROR', 503, 'busy'],
  [1053, 'ER_SERVER_SHUTDOWN', 503, 'busy'],
  [1064, 'ER_PARSE_ERROR', 500, 'internal'],
]) {
  test(`una falla de base ${code} en el login responde ${statusCode}, no 401`, async () => {
    const { app, db } = buildApp();
    db.failOn(/FROM connectus_pages\.login WHERE username/, mysqlError(errno, code));
    const spy = mock.method(console, 'error', () => {});
    const response = await postLogin(app, { username: 'demo', password: PASSWORD });
    spy.mock.restore();
    assert.equal(response.statusCode, statusCode);
    assert.equal(JSON.parse(response.body).error, error);
  });
}
