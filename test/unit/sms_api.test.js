'use strict';

const assert = require('node:assert/strict');
const { mock, test } = require('node:test');

const { issueToken } = require('../../src/auth');
const { decodeCursor } = require('../../src/cursor');
const {
  buildApp,
  getSms,
  loginRow,
  postLogin,
  signIn,
  smsRow,
  NOW_MS,
  PASSWORD,
  TOKEN_SECRET,
  VALID_SEARCH,
} = require('./support/app_fixture');
const { mysqlError } = require('./support/fake_db');

const NOW_SECONDS = NOW_MS / 1000;
const errorOf = (response) => JSON.parse(response.body).error;

function assertUnauthorized(response) {
  assert.equal(response.statusCode, 401);
  assert.equal(errorOf(response), 'unauthorized');
  assert.equal(response.headers['Cache-Control'], 'no-store');
}

test('una búsqueda válida devuelve filas y nextCursor', async () => {
  const { app } = buildApp({ seed: { sms: [smsRow(1)] } });
  const token = await signIn(app);
  const response = await getSms(app, token, VALID_SEARCH);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.items.length, 1);
  assert.equal(body.nextCursor, null);
});

for (const authorization of [
  undefined,
  '',
  'Bearer',
  'Bearer ',
  'Basic dXNlcjpwYXNz',
  'bearer abc',
  'Bearer a b',
  'Bearer a.b.c',
  'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOjF9.',
]) {
  test(`Authorization ${JSON.stringify(authorization)} responde 401 sin tocar la base`, async () => {
    const { app, db } = buildApp();
    const response = await app.handle({
      method: 'GET',
      path: '/api/sms',
      headers: authorization === undefined ? {} : { authorization },
      query: {},
    });
    assertUnauthorized(response);
    assert.equal(db.calls.length, 0);
  });
}

test('un token vencido responde 401', async () => {
  const { app, clockState } = buildApp();
  const token = await signIn(app);
  assert.equal((await getSms(app, token, VALID_SEARCH)).statusCode, 200);
  clockState.now += 3600 * 1000;
  assertUnauthorized(await getSms(app, token, VALID_SEARCH));
});

test('un token con dos Authorization unidas por la pasarela responde 401', async () => {
  const { app } = buildApp();
  const token = await signIn(app);
  const response = await app.handle({
    method: 'GET',
    path: '/api/sms',
    headers: { authorization: `Bearer ${token}, Bearer ${token}` },
    query: {},
  });
  assertUnauthorized(response);
});

test('revocar con active=0 surte efecto en la petición siguiente', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  assert.equal((await getSms(app, token, VALID_SEARCH)).statusCode, 200);
  db.state.logins[0].active = 0;
  assertUnauthorized(await getSms(app, token, VALID_SEARCH));
});

test('borrar el login surte efecto en la petición siguiente', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  db.state.logins.length = 0;
  assertUnauthorized(await getSms(app, token, VALID_SEARCH));
});

test('5 claves malas de un anónimo bloquean el login, pero no expulsan una sesión abierta', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await postLogin(app, { username: 'demo', password: 'clave-incorrecta' })).statusCode, 401);
  }
  assert.equal(db.state.logins[0].lockedUntil, NOW_SECONDS + 900);
  assert.equal((await getSms(app, token, VALID_SEARCH)).statusCode, 200);
  assert.equal((await postLogin(app, { username: 'demo', password: PASSWORD })).statusCode, 401, 'el login sigue frenado');
});

test('subir token_version invalida el token ya emitido, y el nuevo login recibe uno que vale', async () => {
  const { app, db } = buildApp();
  const oldToken = await signIn(app);
  assert.equal((await getSms(app, oldToken, VALID_SEARCH)).statusCode, 200);
  db.state.logins[0].tokenVersion += 1;
  assertUnauthorized(await getSms(app, oldToken, VALID_SEARCH));
  const newToken = await signIn(app);
  assert.equal((await getSms(app, newToken, VALID_SEARCH)).statusCode, 200);
});

test('quitar una cuenta del login surte efecto en la petición siguiente', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  assert.equal((await getSms(app, token, VALID_SEARCH)).statusCode, 200);
  db.state.loginAccounts.length = 0;
  const response = await getSms(app, token, VALID_SEARCH);
  assert.equal(response.statusCode, 403);
  assert.equal(errorOf(response), 'forbidden');
});

test('una cuenta ajena responde 403 y no llega a consultar SMS', async () => {
  const { app, db } = buildApp({ seed: { sms: [smsRow(1, { id_account: 999 })] } });
  const token = await signIn(app);
  db.calls.length = 0;
  const response = await getSms(app, token, { ...VALID_SEARCH, account: '999' });
  assert.equal(response.statusCode, 403);
  assert.equal(errorOf(response), 'forbidden');
  assert.equal(db.calls.some(({ sql }) => /connectus_pages\.sms\b|sms_cutoff_id/.test(sql)), false);
  assert.doesNotMatch(response.body, /Mensaje/);
});

test('pedir una cuenta ajena deja rastro en audit_log', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  db.state.audit.length = 0;
  await getSms(app, token, { ...VALID_SEARCH, account: '999' });
  assert.deepEqual(db.state.audit, [
    { idLogin: 1, action: 'forbidden', idAccount: 999, detail: null, ip: '203.0.113.10' },
  ]);
});

test('una cuenta pedida que no cabe en la columna INT deja rastro sin el id', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  db.state.audit.length = 0;
  assert.equal((await getSms(app, token, { ...VALID_SEARCH, account: '2147483647' })).statusCode, 403);
  assert.equal((await getSms(app, token, { ...VALID_SEARCH, account: '2147483648' })).statusCode, 403);
  assert.deepEqual(db.state.audit.map(({ idAccount, detail }) => [idAccount, detail]), [
    [2147483647, null],
    [null, 'cuenta_fuera_de_rango'],
  ]);
});

test('si falla la auditoría del rechazo, la respuesta sigue siendo 403', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  db.failOn(/audit_log/, mysqlError(1142, 'ER_TABLEACCESS_DENIED_ERROR'));
  const spy = mock.method(console, 'error', () => {});
  const response = await getSms(app, token, { ...VALID_SEARCH, account: '999' });
  spy.mock.restore();
  assert.equal(response.statusCode, 403);
});

test('los items no llevan el id de la tabla y el cursor no lo deja ver', async () => {
  const sms = Array.from({ length: 51 }, (_, index) => smsRow(1000 + index));
  const { app } = buildApp({ seed: { sms } });
  const token = await signIn(app);
  const { items, nextCursor } = JSON.parse((await getSms(app, token, VALID_SEARCH)).body);
  assert.deepEqual(Object.keys(items[0]).sort(), ['content', 'createdAt', 'delivery', 'dst', 'status']);
  assert.match(nextCursor, /^[A-Za-z0-9_-]{48}$/);
  assert.doesNotMatch(nextCursor, /1001/);
  assert.equal(decodeCursor(nextCursor, 101, TOKEN_SECRET), 1001);
});

test('el cursor pagina hasta el final sin repetir filas', async () => {
  const sms = Array.from({ length: 120 }, (_, index) => smsRow(index + 1));
  const { app } = buildApp({ seed: { sms } });
  const token = await signIn(app);
  const seen = [];
  let cursor;
  do {
    const params = cursor ? { ...VALID_SEARCH, cursor } : VALID_SEARCH;
    const body = JSON.parse((await getSms(app, token, params)).body);
    seen.push(...body.items.map((item) => item.content));
    cursor = body.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, sms.map((row) => row.sms_content).reverse());
});

test('un cursor de otra cuenta, alterado o numérico responde 400 sin consultar SMS', async () => {
  const sms = Array.from({ length: 51 }, (_, index) => smsRow(index + 1));
  const { app, db } = buildApp({ seed: { sms } });
  const token = await signIn(app);
  const { nextCursor } = JSON.parse((await getSms(app, token, VALID_SEARCH)).body);
  const flipped = (nextCursor[0] === 'A' ? 'B' : 'A') + nextCursor.slice(1);
  for (const [account, cursor] of [['102', nextCursor], ['101', flipped], ['101', '12345'], ['101', '']]) {
    db.calls.length = 0;
    const response = await getSms(app, token, { ...VALID_SEARCH, account, cursor });
    assert.equal(response.statusCode, 400, `cursor ${cursor} en ${account}`);
    assert.equal(errorOf(response), 'invalid_request');
    assert.equal(db.calls.some(({ sql }) => /connectus_pages\.sms\b/.test(sql)), false);
  }
});

test('un token de otro login no da acceso a las cuentas del primero', async () => {
  const { app } = buildApp({
    seed: {
      logins: [loginRow(), loginRow({ id: 2, username: 'solo102' })],
      loginAccounts: [{ idLogin: 1, idAccount: 101 }, { idLogin: 2, idAccount: 102 }],
    },
  });
  const token = issueToken(2, 0, TOKEN_SECRET, NOW_SECONDS);
  assert.equal((await getSms(app, token, VALID_SEARCH)).statusCode, 403);
  assert.equal((await getSms(app, token, { ...VALID_SEARCH, account: '102' })).statusCode, 200);
});

test('los parámetros se validan después de autenticar', async () => {
  const { app } = buildApp();
  assertUnauthorized(await getSms(app, null, { account: 'no-valida' }));
});

test('los errores de validación responden 400 con el mensaje del contrato', async () => {
  const { app } = buildApp();
  const token = await signIn(app);
  const range = await getSms(app, token, { ...VALID_SEARCH, end: '2026-10-16' });
  assert.equal(range.statusCode, 400);
  assert.equal(JSON.parse(range.body).message, 'El rango debe ser válido y no superar 15 días.');
  const number = await getSms(app, token, { ...VALID_SEARCH, dst: 'abc' });
  assert.equal(number.statusCode, 400);
  assert.equal(JSON.parse(number.body).message, 'Debes indicar un número destino válido.');
  const repeated = await getSms(app, token, { ...VALID_SEARCH, account: ['101', '102'] });
  assert.equal(repeated.statusCode, 400);
});

test('un rango de 14 días pasa y uno de 15 no, ya con la API completa', async () => {
  const { app } = buildApp();
  const token = await signIn(app);
  assert.equal((await getSms(app, token, { ...VALID_SEARCH, end: '2026-10-15' })).statusCode, 200);
  assert.equal((await getSms(app, token, { ...VALID_SEARCH, end: '2026-10-16' })).statusCode, 400);
});

test('dst con inyección llega a la consulta como número y no toca el SQL', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  db.calls.length = 0;
  await getSms(app, token, { ...VALID_SEARCH, dst: "56900000001' OR 1=1 -- " });
  const call = db.calls.find(({ sql }) => /connectus_pages\.sms\b/.test(sql));
  assert.doesNotMatch(call.sql, /OR 1=1|56900000001/);
  assert.equal(call.params.at(-1), 5690000000111);
  assert.equal(typeof call.params.at(-1), 'number');
});

test('audit_log registra la búsqueda sin el número ni el contenido', async () => {
  const { app, db } = buildApp({ seed: { sms: [smsRow(1, { sms_content: 'contenido-privado' })] } });
  const token = await signIn(app);
  db.state.audit.length = 0;
  await getSms(app, token, { ...VALID_SEARCH, dst: '56900000001' });
  await getSms(app, token, VALID_SEARCH);
  assert.deepEqual(db.state.audit, [
    { idLogin: 1, action: 'search', idAccount: 101, detail: '2026-10-01..2026-10-15 con_numero', ip: '203.0.113.10' },
    { idLogin: 1, action: 'search', idAccount: 101, detail: '2026-10-01..2026-10-15 sin_numero', ip: '203.0.113.10' },
  ]);
  assert.doesNotMatch(JSON.stringify(db.state.audit), /56900000001|contenido-privado/);
});

test('una ip con forma inesperada no llega a audit_log', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  db.state.audit.length = 0;
  await getSms(app, token, VALID_SEARCH, { ip: 'x'.repeat(46) });
  await getSms(app, token, VALID_SEARCH, { ip: null });
  assert.deepEqual(db.state.audit.map((row) => row.ip), [null, null]);
});

test('si falla la auditoría, la búsqueda sigue', async () => {
  const { app, db } = buildApp({ seed: { sms: [smsRow(1)] } });
  const token = await signIn(app);
  db.failOn(/audit_log/, mysqlError(1142, 'ER_TABLEACCESS_DENIED_ERROR'));
  const spy = mock.method(console, 'error', () => {});
  const response = await getSms(app, token, VALID_SEARCH);
  const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  spy.mock.restore();
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).items.length, 1);
  assert.match(logged, /audit_insert_failed/);
});

for (const [label, error, statusCode, code, message] of [
  ['1226', mysqlError(1226, 'ER_USER_LIMIT_REACHED'), 503, 'busy'],
  ['1203', mysqlError(1203, 'ER_TOO_MANY_USER_CONNECTIONS'), 503, 'busy'],
  ['1040', mysqlError(1040, 'ER_CON_COUNT_ERROR'), 503, 'busy'],
  ['1053, de un apagado ordenado', mysqlError(1053, 'ER_SERVER_SHUTDOWN'), 503, 'busy'],
  ['1205', mysqlError(1205, 'ER_LOCK_WAIT_TIMEOUT'), 503, 'busy'],
  ['ECONNREFUSED', mysqlError(undefined, 'ECONNREFUSED'), 503, 'busy'],
  ['ETIMEDOUT', mysqlError(undefined, 'ETIMEDOUT'), 503, 'busy'],
  ['HANDSHAKE_SSL_ERROR, de un corte en el saludo TLS', mysqlError(undefined, 'HANDSHAKE_SSL_ERROR', { fatal: true }), 503, 'busy'],
  ['conexión perdida', mysqlError(undefined, 'PROTOCOL_CONNECTION_LOST', { fatal: true }), 503, 'busy'],
  ['conexión cerrada', mysqlError(undefined, undefined, { fatal: true }), 503, 'busy'],
  ['4031 sin fatal', mysqlError(4031, 'ER_CLIENT_INTERACTION_TIMEOUT'), 503, 'busy'],
  ['3024', mysqlError(3024, 'ER_QUERY_TIMEOUT'), 504, 'timeout',
    'La consulta tardó demasiado. Acota las fechas o indica un número.'],
  ['1028, el corte durante un filesort', mysqlError(1028, 'ER_FILSORT_ABORT'), 504, 'timeout',
    'La consulta tardó demasiado. Acota las fechas o indica un número.'],
  ['1317, de KILL QUERY', mysqlError(1317, 'ER_QUERY_INTERRUPTED'), 504, 'timeout',
    'La consulta tardó demasiado. Acota las fechas o indica un número.'],
  ['otro error de SQL', mysqlError(1064, 'ER_PARSE_ERROR'), 500, 'internal'],
  ['un error cualquiera', new TypeError('leyó 56900000001'), 500, 'internal'],
]) {
  test(`un error ${label} responde ${statusCode} ${code}`, async () => {
    const { app, db } = buildApp();
    const token = await signIn(app);
    db.failOn(/FROM connectus_pages\.sms WHERE/, error);
    const spy = mock.method(console, 'error', () => {});
    const response = await getSms(app, token, VALID_SEARCH);
    spy.mock.restore();
    assert.equal(response.statusCode, statusCode);
    const body = JSON.parse(response.body);
    assert.equal(body.error, code);
    if (message) assert.equal(body.message, message);
    assert.doesNotMatch(response.body, /56900000001|clave-secreta|dst_number/);
  });
}

test('un corte en el saludo TLS responde 503, y el registro conserva el código', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  db.failOn(/FROM connectus_pages\.sms WHERE/, mysqlError(undefined, 'HANDSHAKE_SSL_ERROR', { fatal: true }));
  const spy = mock.method(console, 'error', () => {});
  const response = await getSms(app, token, VALID_SEARCH);
  const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  spy.mock.restore();
  assert.equal(response.statusCode, 503);
  assert.match(logged, /"event":"request_failed","code":"HANDSHAKE_SSL_ERROR"/);
});

test('la consola nunca recibe clave, token, número, contenido ni parámetros de SQL', async () => {
  const PRIVATE_NUMBER = '56900000099';
  const PRIVATE_CONTENT = 'contenido-privado-del-sms';
  const WRONG_PASSWORD = 'clave-incorrecta-privada';
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const spies = methods.map((method) => mock.method(console, method, () => {}));
  const { app, db } = buildApp({
    seed: { sms: [smsRow(1, { dst_number: PRIVATE_NUMBER, sms_content: PRIVATE_CONTENT })] },
  });
  await postLogin(app, { username: 'demo', password: WRONG_PASSWORD });
  await postLogin(app, { username: 'no-existe', password: WRONG_PASSWORD });
  const { token } = JSON.parse((await postLogin(app, { username: 'demo', password: PASSWORD })).body);
  await getSms(app, token, { ...VALID_SEARCH, dst: PRIVATE_NUMBER });
  await getSms(app, `${token}x`, { ...VALID_SEARCH, dst: PRIVATE_NUMBER });
  await getSms(app, token, { ...VALID_SEARCH, dst: 'x'.repeat(20) });

  const leak = mysqlError(1064, 'ER_PARSE_ERROR');
  leak.message = `falla con ${PRIVATE_NUMBER} y ${PRIVATE_CONTENT} y ${WRONG_PASSWORD} y ${token}`;
  leak.sql = leak.message;
  leak.sqlMessage = leak.message;
  db.failOn(/FROM connectus_pages\.sms WHERE/, leak);
  db.failOn(/audit_log/, leak);
  await getSms(app, token, { ...VALID_SEARCH, dst: PRIVATE_NUMBER });
  db.clearFailures();
  db.failOn(/FROM connectus_pages\.login WHERE username/, leak);
  await postLogin(app, { username: 'demo', password: WRONG_PASSWORD });

  const output = spies
    .flatMap((spy) => spy.mock.calls)
    .flatMap((call) => call.arguments)
    .map((argument) => (typeof argument === 'string' ? argument : JSON.stringify(argument)))
    .join('\n');
  spies.forEach((spy) => spy.mock.restore());
  assert.match(output, /ER_PARSE_ERROR/, 'la prueba debe haber pasado por el registro de errores');
  for (const secret of [PRIVATE_NUMBER, PRIVATE_CONTENT, WRONG_PASSWORD, PASSWORD, TOKEN_SECRET, token]) {
    assert.equal(output.includes(secret), false);
  }
  assert.doesNotMatch(output, /SELECT|UPDATE|INSERT/);
});
