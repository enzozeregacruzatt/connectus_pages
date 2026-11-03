'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock, test } = require('node:test');

const { buildPoolOptions, createDb, errorCode, writeAudit } = require('../../src/db');

const PROD_CONFIG = { stage: 'prod', db: { host: 'db.invalid', port: 3306, user: 'pages_app', password: 'clave' } };

class FakePool extends EventEmitter {
  constructor(outcomes) {
    super();
    this.outcomes = outcomes;
    this.calls = [];
    this.destroyed = 0;
  }

  async getConnection() {
    this.calls.push('getConnection');
    return { destroy: () => { this.destroyed += 1; } };
  }

  async query(sql, params) {
    this.calls.push({ sql, params });
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return [outcome, []];
  }
}

function fatal(code) {
  const error = new Error('conexión perdida');
  error.fatal = true;
  if (code) error.code = code;
  return error;
}

test('las opciones del pool son las del contrato', () => {
  const options = buildPoolOptions(PROD_CONFIG);
  assert.equal(options.connectionLimit, 1);
  assert.equal(options.connectTimeout, 5000);
  assert.equal(options.dateStrings, true);
  assert.equal(options.supportBigNumbers, true);
  assert.equal(options.bigNumberStrings, true);
  assert.equal(options.charset, 'utf8mb4');
  assert.equal(options.stringifyObjects, true);
  assert.equal(options.host, 'db.invalid');
  assert.equal(options.port, 3306);
});

test('fuera de local exige TLS verificado con el paquete de RDS', () => {
  const { ssl } = buildPoolOptions(PROD_CONFIG);
  assert.deepEqual(ssl.ca, require('aws-ssl-profiles').ca);
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.verifyIdentity, true);
});

test('en local usa el CA del archivo, verifica la cadena y no el nombre', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-ca-'));
  const caFile = path.join(directory, 'ca.pem');
  fs.writeFileSync(caFile, 'certificado de prueba');
  try {
    const { ssl } = buildPoolOptions({ stage: 'local', db: { sslCaFile: caFile } });
    assert.equal(ssl.ca.toString(), 'certificado de prueba');
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(ssl.verifyIdentity, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('en local, sin el archivo de CA no se conecta sin TLS: lanza un error', () => {
  assert.throws(() => buildPoolOptions({ stage: 'local', db: { sslCaFile: '/no/existe.pem' } }), { code: 'ENOENT' });
});

test('al abrir cada conexión fija wait_timeout y los topes de lo que no lleva hint', () => {
  const pool = new FakePool([]);
  createDb(PROD_CONFIG, () => pool);
  const statements = [];
  pool.emit('connection', { query: (sql) => statements.push(sql) });
  assert.deepEqual(statements, [
    'SET SESSION wait_timeout = 120, max_execution_time = 3000, lock_wait_timeout = 5, innodb_lock_wait_timeout = 5',
  ]);
});

test('una falla al fijar los topes de sesión solo registra el código', () => {
  const pool = new FakePool([]);
  createDb(PROD_CONFIG, () => pool);
  const spy = mock.method(console, 'error', () => {});
  const failure = new Error('detalle privado');
  failure.code = 'ER_X';
  pool.emit('connection', { query: (sql, callback) => callback(failure) });
  const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  spy.mock.restore();
  assert.match(logged, /ER_X/);
  assert.doesNotMatch(logged, /detalle privado/);
});

test('query devuelve solo las filas', async () => {
  const db = createDb(PROD_CONFIG, () => new FakePool([[{ id: 1 }]]));
  assert.deepEqual(await db.query('SELECT 1', []), [{ id: 1 }]);
});

for (const [label, error] of [
  ['conexión perdida', fatal('PROTOCOL_CONNECTION_LOST')],
  ['conexión reiniciada', fatal('ECONNRESET')],
  ['tubería rota', fatal('EPIPE')],
  ['conexión ya cerrada', fatal()],
]) {
  test(`reintenta una vez ante ${label}`, async () => {
    const pool = new FakePool([error, [{ id: 1 }]]);
    const db = createDb(PROD_CONFIG, () => pool);
    assert.deepEqual(await db.query('SELECT 1', [7]), [{ id: 1 }]);
    assert.deepEqual(pool.calls, [{ sql: 'SELECT 1', params: [7] }, { sql: 'SELECT 1', params: [7] }]);
  });
}

function interactionTimeout() {
  // Como lo entrega mysql2: un Err del servidor en respuesta a la consulta, sin fatal.
  const error = new Error('The client was disconnected by the server because of inactivity.');
  error.errno = 4031;
  error.code = 'ER_CLIENT_INTERACTION_TIMEOUT';
  return error;
}

test('reintenta una vez ante 4031 sin fatal, y antes saca del pool la conexión muerta', async () => {
  const pool = new FakePool([interactionTimeout(), [{ id: 1 }]]);
  const db = createDb(PROD_CONFIG, () => pool);
  assert.deepEqual(await db.query('SELECT 1', [7]), [{ id: 1 }]);
  assert.deepEqual(pool.calls, [
    { sql: 'SELECT 1', params: [7] },
    'getConnection',
    { sql: 'SELECT 1', params: [7] },
  ]);
  assert.equal(pool.destroyed, 1);
});

test('un segundo 4031 no se reintenta más', async () => {
  const pool = new FakePool([interactionTimeout(), interactionTimeout(), [{ id: 1 }]]);
  const db = createDb(PROD_CONFIG, () => pool);
  await assert.rejects(db.query('SELECT 1'), { errno: 4031 });
  assert.equal(pool.calls.filter((call) => call !== 'getConnection').length, 2);
});

test('un error fatal no descarta otra conexión: mysql2 ya sacó esa del pool', async () => {
  const pool = new FakePool([fatal('PROTOCOL_CONNECTION_LOST'), [{ id: 1 }]]);
  const db = createDb(PROD_CONFIG, () => pool);
  await db.query('SELECT 1');
  assert.equal(pool.destroyed, 0);
});

test('no reintenta más de una vez', async () => {
  const pool = new FakePool([fatal('PROTOCOL_CONNECTION_LOST'), fatal('PROTOCOL_CONNECTION_LOST'), [{ id: 1 }]]);
  const db = createDb(PROD_CONFIG, () => pool);
  await assert.rejects(db.query('SELECT 1'), { code: 'PROTOCOL_CONNECTION_LOST' });
  assert.equal(pool.calls.length, 2);
});

test('no reintenta errores de SQL ni fallas al conectar', async () => {
  const sqlError = new Error('tiempo agotado');
  sqlError.errno = 3024;
  sqlError.code = 'ER_QUERY_TIMEOUT';
  for (const error of [sqlError, fatal('ECONNREFUSED'), fatal('ETIMEDOUT')]) {
    const pool = new FakePool([error, [{ id: 1 }]]);
    const db = createDb(PROD_CONFIG, () => pool);
    await assert.rejects(db.query('SELECT 1'));
    assert.equal(pool.calls.length, 1);
  }
});

test('write devuelve el resultado', async () => {
  const db = createDb(PROD_CONFIG, () => new FakePool([{ affectedRows: 1 }]));
  assert.deepEqual(await db.write('UPDATE x', []), { affectedRows: 1 });
});

for (const [label, error] of [
  ['conexión perdida', fatal('PROTOCOL_CONNECTION_LOST')],
  ['conexión reiniciada', fatal('ECONNRESET')],
  ['tubería rota', fatal('EPIPE')],
]) {
  test(`write no reenvía ante ${label}: el servidor pudo aplicarla`, async () => {
    const pool = new FakePool([error, { affectedRows: 1 }]);
    const db = createDb(PROD_CONFIG, () => pool);
    await assert.rejects(db.write('UPDATE x', [7]), { code: error.code });
    assert.equal(pool.calls.length, 1);
  });
}

test('write reenvía una vez si la conexión ya estaba cerrada: mysql2 no llegó a enviarla', async () => {
  const pool = new FakePool([fatal(), { affectedRows: 1 }]);
  const db = createDb(PROD_CONFIG, () => pool);
  assert.deepEqual(await db.write('UPDATE x', [7]), { affectedRows: 1 });
  assert.equal(pool.calls.length, 2);
  assert.equal(pool.destroyed, 0);
});

test('write reenvía una vez ante 4031, y antes saca del pool la conexión muerta', async () => {
  const pool = new FakePool([interactionTimeout(), { affectedRows: 1 }]);
  const db = createDb(PROD_CONFIG, () => pool);
  assert.deepEqual(await db.write('UPDATE x', [7]), { affectedRows: 1 });
  assert.deepEqual(pool.calls, [
    { sql: 'UPDATE x', params: [7] },
    'getConnection',
    { sql: 'UPDATE x', params: [7] },
  ]);
  assert.equal(pool.destroyed, 1);
});

test('write no reenvía más de una vez', async () => {
  const pool = new FakePool([fatal(), fatal(), { affectedRows: 1 }]);
  const db = createDb(PROD_CONFIG, () => pool);
  await assert.rejects(db.write('UPDATE x'));
  assert.equal(pool.calls.length, 2);
});

test('write no reenvía errores de SQL', async () => {
  const lockWait = new Error('bloqueo');
  lockWait.errno = 1205;
  lockWait.code = 'ER_LOCK_WAIT_TIMEOUT';
  const pool = new FakePool([lockWait, { affectedRows: 1 }]);
  const db = createDb(PROD_CONFIG, () => pool);
  await assert.rejects(db.write('UPDATE x'), { errno: 1205 });
  assert.equal(pool.calls.length, 1);
});

test('errorCode nunca devuelve el mensaje', () => {
  const coded = new Error('privado');
  coded.code = 'ER_X';
  assert.equal(errorCode(coded), 'ER_X');
  assert.equal(errorCode(new TypeError('privado')), 'TypeError');
  assert.equal(errorCode(null), 'unknown');
});

test('audit_log se escribe con UTC_TIMESTAMP y por db.write', async () => {
  const calls = [];
  await writeAudit({ write: async (sql, params) => calls.push({ sql, params }) }, {
    idLogin: 1,
    action: 'search',
    idAccount: 101,
    detail: 'x',
    ip: '203.0.113.1',
  });
  assert.match(calls[0].sql, /^INSERT INTO connectus_pages\.audit_log .* UTC_TIMESTAMP\(\)\)$/);
  assert.deepEqual(calls[0].params, [1, 'search', 101, 'x', '203.0.113.1']);
});

test('si se pierde la conexión al auditar, registra el código y la petición sigue', async () => {
  const pool = new FakePool([fatal('PROTOCOL_CONNECTION_LOST'), { affectedRows: 1 }]);
  const db = createDb(PROD_CONFIG, () => pool);
  const spy = mock.method(console, 'error', () => {});
  await writeAudit(db, { action: 'search' });
  const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  spy.mock.restore();
  assert.match(logged, /audit_insert_failed/);
  assert.match(logged, /PROTOCOL_CONNECTION_LOST/);
  assert.equal(pool.calls.length, 1, 'no debe duplicar la fila de auditoría');
});
