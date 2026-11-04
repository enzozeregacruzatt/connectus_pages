'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { mock, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');

const { DUMMY_HASH, LOGIN_FAILURE_FLOOR_MS, verifyToken } = require('../../src/auth');
const {
  buildApp,
  linkFor,
  loginRow,
  postLogin,
  DAY_SECONDS,
  LINK_SECRET_A,
  LINK_SECRET_B,
  NOW_SECONDS,
  PASSWORD,
  TOKEN_SECRET,
} = require('./support/app_fixture');
const { mysqlError } = require('./support/fake_db');

const FAILED_MESSAGE = 'Usuario o contraseña incorrectos, o acceso bloqueado temporalmente.';
const INVALID_LINK_BODY = {
  error: 'invalid_link',
  message: 'Este enlace no es válido o venció. Pide uno nuevo a tu contacto de Connectus.',
};
const DUMMY_SALT = DUMMY_HASH.split('$')[4];

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
  for (const [loginId, username, password] of [
    [1, 'demo', 'clave-incorrecta'],
    [1, 'no-existe', PASSWORD],
    [2, 'inactivo', PASSWORD],
    [3, 'bloqueado', PASSWORD],
  ]) {
    const response = await postLogin(app, { link: linkFor({ loginId }), username, password });
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

test('un usuario que no calza con el enlace también calcula un scrypt, contra el hash ficticio', async () => {
  const { app } = buildApp();
  const salts = await scryptSaltsDuring(() => postLogin(app, { username: 'no-existe', password: PASSWORD }));
  assert.deepEqual(salts, [DUMMY_SALT]);
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

  db.failOn(/username_ok/, mysqlError(1226, 'ER_USER_LIMIT_REACHED'));
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
    const base = JSON.stringify({ link: linkFor(), username: 'demo', password: PASSWORD, relleno: '' });
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
  const response = await postLogin(app, JSON.stringify({ link: linkFor(), username: 'demo', password: 'ñ'.repeat(2000) }));
  assert.equal(response.statusCode, 413);
});

test('audit_log registra login_ok y login_fail, con el id_login del enlace', async () => {
  const { app, db } = buildApp();
  const exp = NOW_SECONDS + 180 * DAY_SECONDS;
  await postLogin(app, { link: linkFor({ exp }), username: 'demo', password: PASSWORD });
  await postLogin(app, { username: 'demo', password: 'mala' });
  const spy = mock.method(console, 'error', () => {});
  await postLogin(app, { username: 'no-existe', password: 'mala' });
  spy.mock.restore();
  assert.deepEqual(db.state.audit, [
    {
      idLogin: 1,
      action: 'login_ok',
      idAccount: null,
      detail: `enlace a v0 vence ${new Date(exp * 1000).toISOString().slice(0, 10)}`,
      ip: '203.0.113.10',
    },
    { idLogin: 1, action: 'login_fail', idAccount: null, detail: null, ip: '203.0.113.10' },
    { idLogin: 1, action: 'login_fail', idAccount: null, detail: 'usuario_no_coincide', ip: '203.0.113.10' },
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
    db.failOn(/username_ok/, mysqlError(errno, code));
    const spy = mock.method(console, 'error', () => {});
    const response = await postLogin(app, { username: 'demo', password: PASSWORD });
    spy.mock.restore();
    assert.equal(response.statusCode, statusCode);
    assert.equal(JSON.parse(response.body).error, error);
  });
}

const LOGIN_FIELDS = { username: 'demo', password: PASSWORD };

function captureLog() {
  const spies = ['log', 'info', 'warn', 'error', 'debug', 'trace'].map((method) => mock.method(console, method, () => {}));
  return {
    stop() {
      const lines = spies
        .flatMap((spy) => spy.mock.calls)
        .map((call) => call.arguments.join(' '));
      spies.forEach((spy) => spy.mock.restore());
      return lines;
    },
  };
}

const flip = (link) => `${link.slice(0, -1)}${link.at(-1) === 'A' ? 'B' : 'A'}`;

const REJECTED_LINKS = [
  ['sin enlace', undefined, 'malformed'],
  ['nulo', null, 'malformed'],
  ['número', 123, 'malformed'],
  ['objeto', { $ne: '' }, 'malformed'],
  ['arreglo', [linkFor()], 'malformed'],
  ['vacío', '', 'malformed'],
  ['con forma inválida', 'l1.a.1.0.1.x', 'malformed'],
  ['con salto de línea final', `${linkFor()}\n`, 'malformed'],
  ['con firma alterada', flip(linkFor()), 'bad_signature'],
  ['firmado con otro secreto', linkFor({ secret: 'otro-secreto-de-pruebas-que-supera-los-32-bytes' }), 'bad_signature'],
  ['firmado con la otra ranura', linkFor({ slot: 'b', secret: LINK_SECRET_A }), 'bad_signature'],
  ['vencido en el segundo exacto', linkFor({ exp: NOW_SECONDS }), 'expired'],
  ['vencido hace rato', linkFor({ exp: NOW_SECONDS - 86400 }), 'expired'],
  ['sobre el tope de 365 días', linkFor({ exp: NOW_SECONDS + 365 * DAY_SECONDS + 1 }), 'too_long'],
  ['con login fuera de INT', linkFor({ loginId: 2147483648 }), 'out_of_range'],
];

for (const [label, link, reason] of REJECTED_LINKS) {
  test(`un enlace ${label} responde invalid_link sin base, scrypt, piso, auditoría ni el enlace en consola`, async () => {
    const floorMs = 20000;
    const { app, db } = buildApp({ loginFailureFloorMs: floorMs });
    const output = captureLog();
    const startedAt = performance.now();
    let response;
    const salts = await scryptSaltsDuring(async () => {
      response = await postLogin(app, { link, ...LOGIN_FIELDS });
    });
    const elapsed = performance.now() - startedAt;
    const logged = output.stop();

    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), INVALID_LINK_BODY);
    assert.deepEqual(db.calls, [], 'no toca la base');
    assert.deepEqual(salts, [], 'no calcula un scrypt');
    assert.ok(elapsed < floorMs / 2, `tardó ${elapsed} ms`);
    assert.deepEqual(db.state.audit, []);
    assert.deepEqual(logged, [JSON.stringify({ event: 'link_rejected', reason })]);
  });
}

test('todas las fallas de enlace responden exactamente igual, también la revocada', async () => {
  const { app, db } = buildApp();
  const output = captureLog();
  const bodies = new Set();
  for (const [, link] of REJECTED_LINKS) {
    bodies.add((await postLogin(app, { link, ...LOGIN_FIELDS })).body);
  }
  db.state.logins[0].linkVersion = 1;
  bodies.add((await postLogin(app, { link: linkFor({ linkVersion: 0 }), ...LOGIN_FIELDS })).body);
  output.stop();
  assert.equal(bodies.size, 1);
});

test('una ranura retirada responde invalid_link', async () => {
  const { app, db } = buildApp({ config: { linkSecrets: { b: LINK_SECRET_B } } });
  const output = captureLog();
  const response = await postLogin(app, { link: linkFor(), ...LOGIN_FIELDS });
  const logged = output.stop();
  assert.deepEqual(JSON.parse(response.body), INVALID_LINK_BODY);
  assert.deepEqual(db.calls, []);
  assert.deepEqual(logged, [JSON.stringify({ event: 'link_rejected', reason: 'unknown_slot' })]);
});

test('el tipo de contenido, el tamaño y el cuerpo se revisan antes que el enlace', async () => {
  const { app, db } = buildApp();
  const output = captureLog();
  const tooLarge = 'x'.repeat(4097);
  assert.equal((await postLogin(app, tooLarge, {})).statusCode, 415);
  assert.equal((await postLogin(app, tooLarge)).statusCode, 413);
  assert.equal((await postLogin(app, '[]')).statusCode, 400);
  assert.deepEqual(output.stop(), [], 'no llegó a mirar el enlace');
  assert.deepEqual(db.calls, []);
});

test('el enlace se revisa antes que la forma de usuario y clave', async () => {
  const { app, db } = buildApp();
  const output = captureLog();
  const response = await postLogin(app, { link: 'malo', username: { $ne: '' }, password: null });
  output.stop();
  assert.deepEqual(JSON.parse(response.body), INVALID_LINK_BODY);
  assert.deepEqual(db.calls, []);
});

test('el enlace en la query de POST /api/login no cuenta', async () => {
  const { app } = buildApp();
  const output = captureLog();
  const response = await app.handle({
    method: 'POST',
    path: '/api/login',
    headers: { 'content-type': 'application/json' },
    query: { e: [linkFor()], link: [linkFor()] },
    body: JSON.stringify(LOGIN_FIELDS),
    ip: '203.0.113.10',
  });
  output.stop();
  assert.deepEqual(JSON.parse(response.body), INVALID_LINK_BODY);
});

test('las dos ranuras valen a la vez', async () => {
  const { app } = buildApp();
  for (const link of [linkFor(), linkFor({ slot: 'b', secret: LINK_SECRET_B })]) {
    assert.equal((await postLogin(app, { link, ...LOGIN_FIELDS })).statusCode, 200);
  }
});

test('el enlace vale hasta un segundo antes de vencer y justo en el tope de 365 días', async () => {
  const { app } = buildApp();
  for (const exp of [NOW_SECONDS + 1, NOW_SECONDS + 365 * DAY_SECONDS]) {
    assert.equal((await postLogin(app, { link: linkFor({ exp }), ...LOGIN_FIELDS })).statusCode, 200);
  }
});

test('el usuario se compara sin distinguir mayúsculas, como la columna', async () => {
  const { app } = buildApp();
  assert.equal((await postLogin(app, { username: 'DEMO', password: PASSWORD })).statusCode, 200);
});

test('una clave mala con enlace válido: mensaje uniforme, piso y fallo sumado', async () => {
  const floorMs = 300;
  const { app, db } = buildApp({ loginFailureFloorMs: floorMs });
  const startedAt = performance.now();
  const response = await postLogin(app, { username: 'demo', password: 'mala' });
  assertLoginRejected(response);
  assert.ok(performance.now() - startedAt >= floorMs - 1);
  assert.equal(db.state.logins[0].failedAttempts, 1);
});

test('el enlace de A con el usuario B: mensaje uniforme, piso, hash ficticio, sin fallos y auditado', async () => {
  const floorMs = 300;
  const { app, db } = buildApp({
    seed: { logins: [loginRow(), loginRow({ id: 2, username: 'otra' })] },
    loginFailureFloorMs: floorMs,
  });
  const output = captureLog();
  const startedAt = performance.now();
  let response;
  const salts = await scryptSaltsDuring(async () => {
    response = await postLogin(app, { link: linkFor({ loginId: 1 }), username: 'otra', password: PASSWORD });
  });
  const elapsed = performance.now() - startedAt;
  const logged = output.stop();

  assertLoginRejected(response);
  assert.ok(elapsed >= floorMs - 1, `tardó ${elapsed} ms`);
  assert.deepEqual(salts, [DUMMY_SALT]);
  assert.deepEqual(db.state.logins.map((row) => row.failedAttempts), [0, 0]);
  assert.equal(db.calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
  assert.deepEqual(db.state.audit, [
    { idLogin: 1, action: 'login_fail', idAccount: null, detail: 'usuario_no_coincide', ip: '203.0.113.10' },
  ]);
  assert.deepEqual(logged, [JSON.stringify({ event: 'link_suspect', detail: 'usuario_no_coincide' })]);
});

test('5 intentos de otros usuarios con un enlace válido no bloquean al login del enlace', async () => {
  const { app, db } = buildApp();
  const output = captureLog();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assertLoginRejected(await postLogin(app, { username: 'otra', password: 'mala' }));
  }
  output.stop();
  assert.equal(db.state.logins[0].lockedUntil, 0);
  assert.equal(db.state.logins[0].failedAttempts, 0);
  assert.equal((await postLogin(app, LOGIN_FIELDS)).statusCode, 200);
});

for (const [label, seedVersion, linkVersion] of [
  ['vieja', 1, 0],
  ['más nueva que la del login', 0, 1],
]) {
  test(`un enlace bien firmado con versión ${label} lee la base y audita, sin scrypt, piso ni fallo sumado`, async () => {
    const floorMs = 20000;
    const { app, db } = buildApp({ loginFailureFloorMs: floorMs });
    db.state.logins[0].linkVersion = seedVersion;
    const output = captureLog();
    const startedAt = performance.now();
    let response;
    const salts = await scryptSaltsDuring(async () => {
      response = await postLogin(app, { link: linkFor({ linkVersion }), ...LOGIN_FIELDS });
    });
    const elapsed = performance.now() - startedAt;
    const logged = output.stop();

    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), INVALID_LINK_BODY);
    assert.deepEqual(salts, []);
    assert.ok(elapsed < floorMs / 2, `tardó ${elapsed} ms`);
    assert.equal(db.state.logins[0].failedAttempts, 0);
    assert.equal(db.calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
    assert.equal(db.calls.filter(({ sql }) => sql.includes('username_ok')).length, 1);
    assert.deepEqual(db.state.audit, [
      { idLogin: 1, action: 'login_fail', idAccount: null, detail: 'enlace_revocado', ip: '203.0.113.10' },
    ]);
    assert.deepEqual(logged, [JSON.stringify({ event: 'link_suspect', detail: 'enlace_revocado' })]);
  });
}

test('un enlace bien firmado de un login que ya no existe se trata como revocado', async () => {
  const { app, db } = buildApp();
  const output = captureLog();
  let response;
  const salts = await scryptSaltsDuring(async () => {
    response = await postLogin(app, { link: linkFor({ loginId: 99 }), ...LOGIN_FIELDS });
  });
  const logged = output.stop();
  assert.deepEqual(JSON.parse(response.body), INVALID_LINK_BODY);
  assert.deepEqual(salts, []);
  assert.deepEqual(db.state.audit, [
    { idLogin: 99, action: 'login_fail', idAccount: null, detail: 'enlace_revocado', ip: '203.0.113.10' },
  ]);
  assert.deepEqual(logged, [JSON.stringify({ event: 'link_suspect', detail: 'enlace_revocado' })]);
});

test('el SELECT del login va por el id del enlace, con la versión y la comparación de usuario', async () => {
  const { app, db } = buildApp();
  await postLogin(app, { link: linkFor({ loginId: 1 }), username: 'demo', password: PASSWORD });
  const { sql, params } = db.calls.find((call) => call.sql.includes('username_ok'));
  assert.match(sql, /link_version/);
  assert.match(sql, /\(username = \?\) AS username_ok/);
  assert.match(sql, /FROM connectus_pages\.login WHERE id = \? LIMIT 1$/);
  assert.deepEqual(params, ['demo', 1]);
});

test('login_ok deja la ranura, la versión y la fecha, nunca la firma', async () => {
  const { app, db } = buildApp();
  db.state.logins[0].linkVersion = 3;
  const link = linkFor({ slot: 'b', secret: LINK_SECRET_B, linkVersion: 3 });
  await postLogin(app, { link, ...LOGIN_FIELDS });
  const [{ detail }] = db.state.audit;
  assert.match(detail, /^enlace b v3 vence \d{4}-\d{2}-\d{2}$/);
  assert.equal(JSON.stringify(db.state.audit).includes(link.split('.')[5]), false);
});

test('la consola nunca contiene el enlace ni su firma, en ningún camino', async () => {
  const { app, db } = buildApp({ loginFailureFloorMs: 1 });
  const links = [linkFor(), linkFor({ linkVersion: 1 }), flip(linkFor()), linkFor({ exp: NOW_SECONDS - 1 })];
  const output = captureLog();
  for (const link of links) {
    await postLogin(app, { link, username: 'demo', password: 'mala' });
    await postLogin(app, { link, username: 'otra', password: PASSWORD });
    await postLogin(app, { link, ...LOGIN_FIELDS });
  }
  db.failOn(/username_ok/, mysqlError(1064, 'ER_PARSE_ERROR'));
  await postLogin(app, { link: links[0], ...LOGIN_FIELDS });
  const logged = output.stop().join('\n');
  assert.match(logged, /link_rejected/);
  assert.match(logged, /link_suspect/);
  for (const link of links) {
    assert.equal(logged.includes(link), false);
    assert.equal(logged.includes(link.split('.')[5]), false);
  }
});
