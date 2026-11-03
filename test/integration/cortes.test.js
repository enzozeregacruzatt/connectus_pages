'use strict';

// Lo que pasa cuando la base no contesta, se corta o tarda: con un proxy TCP que se calla o corta en el momento justo, y el
// mysqld desechable detrás. Requiere scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, describe, it, mock } = require('node:test');
const mysql = require('mysql2/promise');

const { BUSY_MESSAGE, createApp } = require('../../src/app');
const { hashPassword } = require('../../src/auth');
const { loadConfig } = require('../../src/config');
const { createDb } = require('../../src/db');
const { createHandler } = require('../../src/handler');
const { createTcpProxy } = require('./support/proxy_tcp');
const { adminConnectionOptions, loadTestEnv, localConfigEnv } = require('./support/test_env');

const USERNAME = 'api_corte';
const PASSWORD = 'clave-desechable-de-los-cortes';
const SEARCH = { account: '101', start: '2026-10-10', end: '2026-10-10' };
const REGISTER_FAILURE = /^UPDATE connectus_pages\.login SET locked_until/;
const REGISTER_SUCCESS = /^UPDATE connectus_pages\.login SET failed_attempts = 0/;
const INSERT_AUDIT = /^INSERT INTO connectus_pages\.audit_log/;
const CONTRACT_SEARCH = /FROM connectus_pages\.sms WHERE/;
const SELECT_COLUMNS = 'id, id_delivery, dst_number, sms_content, status, created_at';

function restEvent(overrides) {
  return {
    httpMethod: 'GET',
    path: '/',
    headers: {},
    multiValueHeaders: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    requestContext: { identity: { sourceIp: '203.0.113.40' } },
    ...overrides,
  };
}

const loginEvent = (username, password) => restEvent({
  httpMethod: 'POST',
  path: '/api/login',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});

const searchEvent = (token) => restEvent({
  path: '/api/sms',
  headers: { Authorization: `Bearer ${token}` },
  queryStringParameters: SEARCH,
});

// Plazo = tiempo restante menos el margen de 2 s del handler.
const withDeadline = (ms) => ({ getRemainingTimeInMillis: () => ms + 2000 });

function captureConsoleError() {
  const spy = mock.method(console, 'error', () => {});
  return {
    stop() {
      const lines = spy.mock.calls.map((call) => call.arguments.join(' '));
      spy.mock.restore();
      return lines.join('\n');
    },
  };
}

describe('cortes de la base', () => {
  let env;
  let config;
  let admin;
  let loginId;

  async function loginState() {
    const [[row]] = await admin.query(
      'SELECT failed_attempts, locked_until FROM connectus_pages.login WHERE id = ?',
      [loginId]
    );
    return { failedAttempts: Number(row.failed_attempts), lockedUntil: row.locked_until };
  }

  async function resetLogin() {
    await admin.query('UPDATE connectus_pages.login SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [loginId]);
  }

  async function auditCount(action) {
    const [[row]] = await admin.query(
      'SELECT COUNT(*) AS total FROM connectus_pages.audit_log WHERE id_login = ? AND action = ?',
      [loginId, action]
    );
    return Number(row.total);
  }

  async function removeLogin() {
    const [rows] = await admin.query('SELECT id FROM connectus_pages.login WHERE username = ?', [USERNAME]);
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return;
    await admin.query('DELETE FROM connectus_pages.audit_log WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login WHERE id IN (?)', [ids]);
  }

  before(async () => {
    env = loadTestEnv();
    config = await loadConfig({ env: localConfigEnv(env, { TOKEN_SECRET: crypto.randomBytes(32).toString('hex') }) });
    admin = await mysql.createConnection(adminConnectionOptions(env));
    await removeLogin();
    const [created] = await admin.query(
      'INSERT INTO connectus_pages.login (username, password_hash) VALUES (?, ?)',
      [USERNAME, await hashPassword(PASSWORD)]
    );
    loginId = created.insertId;
    await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 101)', [loginId]);
  });

  after(async () => {
    await removeLogin();
    await admin.end();
  });

  describe('plazo por petición, con el handler real', () => {
    let proxy;
    let handler;

    before(async () => {
      proxy = await createTcpProxy(Number(env.port)).listen();
      Object.assign(process.env, localConfigEnv(env, {
        DB_PORT: String(proxy.port),
        TOKEN_SECRET: crypto.randomBytes(32).toString('hex'),
      }));
      // Se carga después de fijar el entorno: es el mismo export que corre en Lambda, con su pool y su descarte.
      handler = require('../../src/handler').app;
    });

    after(() => proxy.close());

    function assertBusy(response) {
      assert.equal(response.statusCode, 503);
      assert.deepEqual(JSON.parse(response.body), { error: 'busy', message: BUSY_MESSAGE });
      assert.ok(response.headers['Content-Security-Policy'].endsWith("frame-ancestors 'none'"));
      assert.ok(response.headers['Strict-Transport-Security']);
      assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(response.headers['Cache-Control'], 'no-store');
    }

    it('una conexión que se queda callada responde 503 con cabeceras antes del plazo, y la siguiente petición sale por un pool nuevo', async () => {
      const signedIn = await handler(loginEvent(USERNAME, PASSWORD));
      assert.equal(signedIn.statusCode, 200);
      const { token } = JSON.parse(signedIn.body);
      assert.equal((await handler(searchEvent(token))).statusCode, 200);
      const connections = proxy.connections;

      proxy.silenceOpenConnections();
      const output = captureConsoleError();
      const startedAt = performance.now();
      const response = await handler(searchEvent(token), withDeadline(400));
      const elapsed = performance.now() - startedAt;
      const logged = output.stop();

      assertBusy(response);
      assert.ok(elapsed >= 380 && elapsed < 2400, `tardó ${elapsed} ms`);
      assert.match(logged, /request_deadline_exceeded/);
      assert.equal(logged.includes(token), false, 'el registro no lleva datos de la petición');

      assert.equal((await handler(searchEvent(token))).statusCode, 200);
      assert.equal(proxy.connections, connections + 1, 'la petición siguiente abre otra conexión');
    });

    it('un login que queda colgado tampoco bloquea al siguiente', async () => {
      assert.equal((await handler(loginEvent(USERNAME, PASSWORD))).statusCode, 200);
      proxy.silenceOpenConnections();
      const output = captureConsoleError();
      const response = await handler(loginEvent(USERNAME, PASSWORD), withDeadline(300));
      output.stop();
      assertBusy(response);
      assert.equal((await handler(loginEvent(USERNAME, PASSWORD))).statusCode, 200);
    });

    it('una conexión que no termina de abrir también responde dentro del plazo, antes del connectTimeout de 5 s', async () => {
      const signedIn = await handler(loginEvent(USERNAME, PASSWORD));
      const { token } = JSON.parse(signedIn.body);
      proxy.silenceOpenConnections();
      proxy.setSilentForNewConnections(true);
      const output = captureConsoleError();
      try {
        // La primera descarta el pool de la conexión callada, y la segunda ya se queda en el saludo del pool nuevo.
        assertBusy(await handler(searchEvent(token), withDeadline(200)));
        const startedAt = performance.now();
        assertBusy(await handler(searchEvent(token), withDeadline(300)));
        assert.ok(performance.now() - startedAt < 2300);
      } finally {
        proxy.setSilentForNewConnections(false);
        output.stop();
      }
      assert.equal((await handler(searchEvent(token))).statusCode, 200);
    });
  });

  describe('escrituras con la conexión cortada', () => {
    let proxy;
    let db;
    let handler;
    let cutOn = null;

    before(async () => {
      proxy = await createTcpProxy(Number(env.port)).listen();
      db = createDb({ ...config, db: { ...config.db, port: proxy.port } });
      // Avisa al proxy justo antes de la escritura elegida, sin cambiar lo que hace db.js.
      const armed = {
        ...db,
        write(sql, params) {
          if (cutOn && cutOn.statement.test(sql)) {
            proxy.cutAfterNextStatement(cutOn.kind);
            cutOn = null;
          }
          return db.write(sql, params);
        },
      };
      const app = createApp({ db: armed, config, loginFailureFloorMs: 0 });
      handler = createHandler(async () => app);
    });

    after(async () => {
      await db.end();
      await proxy.close();
    });

    it('control: sin corte, una clave mala responde 401 y deja failed_attempts en 1', async () => {
      await resetLogin();
      const fails = await auditCount('login_fail');
      assert.equal((await handler(loginEvent(USERNAME, 'clave-incorrecta'))).statusCode, 401);
      assert.equal((await loginState()).failedAttempts, 1);
      assert.equal(await auditCount('login_fail'), fails + 1);
    });

    for (const kind of ['fin', 'rst']) {
      it(`una clave mala con la conexión cortada tras el commit, con ${kind}, deja failed_attempts en 1 y responde 503`, async () => {
        await resetLogin();
        // Con la conexión ya abierta: el corte tiene que caer en el UPDATE y no en el saludo.
        assert.equal((await handler(loginEvent(USERNAME, PASSWORD))).statusCode, 200);
        const connections = proxy.connections;
        cutOn = { statement: REGISTER_FAILURE, kind };
        const output = captureConsoleError();
        const response = await handler(loginEvent(USERNAME, 'clave-incorrecta'));
        const logged = output.stop();

        assert.equal(response.statusCode, 503);
        assert.equal(JSON.parse(response.body).error, 'busy');
        const state = await loginState();
        assert.equal(state.failedAttempts, 1, 'el intento cuenta una sola vez');
        assert.equal(state.lockedUntil, null);
        assert.equal(proxy.connections, connections, 'no abre otra conexión para reenviar');
        assert.match(logged, /request_failed/);
      });
    }

    it('una clave buena con la conexión cortada tras el commit responde 503, y el siguiente intento entra', async () => {
      assert.equal((await handler(loginEvent(USERNAME, PASSWORD))).statusCode, 200);
      cutOn = { statement: REGISTER_SUCCESS, kind: 'fin' };
      const output = captureConsoleError();
      const response = await handler(loginEvent(USERNAME, PASSWORD));
      output.stop();
      assert.equal(response.statusCode, 503);
      assert.equal((await handler(loginEvent(USERNAME, PASSWORD))).statusCode, 200);
    });

    it('la auditoría con la conexión cortada tras el commit deja una sola fila, registra el código y la búsqueda sigue', async () => {
      const signedIn = await handler(loginEvent(USERNAME, PASSWORD));
      const { token } = JSON.parse(signedIn.body);
      const searches = await auditCount('search');
      cutOn = { statement: INSERT_AUDIT, kind: 'fin' };
      const output = captureConsoleError();
      const response = await handler(searchEvent(token));
      const logged = output.stop();
      assert.equal(response.statusCode, 200);
      assert.equal(await auditCount('search'), searches + 1);
      assert.match(logged, /audit_insert_failed/);
      assert.match(logged, /PROTOCOL_CONNECTION_LOST|ECONNRESET/);
    });
  });

  describe('topes de servidor', () => {
    let db;
    let handler;

    before(() => {
      db = createDb(config);
      const app = createApp({ db, config, loginFailureFloorMs: 0 });
      handler = createHandler(async () => app);
    });

    after(() => db.end());

    it('la conexión fija los topes de sesión del contrato', async () => {
      const [session] = await db.query(
        'SELECT @@SESSION.wait_timeout AS waitTimeout, @@SESSION.max_execution_time AS maxExecutionTime, '
        + '@@SESSION.lock_wait_timeout AS lockWait, @@SESSION.innodb_lock_wait_timeout AS innodbLockWait'
      );
      assert.deepEqual(Object.values(session).map(Number), [120, 3000, 5, 5]);
    });

    it('un hint de 8000 ms gana sobre el tope de 3 s de la sesión, y sin hint rige el tope', async () => {
      const [withHint] = await db.query('SELECT /*+ MAX_EXECUTION_TIME(8000) */ SLEEP(3.2) AS interrupted');
      assert.equal(Number(withHint.interrupted), 0);
      const [withoutHint] = await db.query('SELECT SLEEP(3.2) AS interrupted');
      assert.equal(Number(withoutHint.interrupted), 1);
    });

    it('un UPDATE que espera un bloqueo de fila responde 503 busy a los 5 s, no a los 50 del servidor', async () => {
      await resetLogin();
      const locker = await mysql.createConnection(adminConnectionOptions(env));
      await locker.query('START TRANSACTION');
      await locker.query('SELECT id FROM connectus_pages.login WHERE id = ? FOR UPDATE', [loginId]);
      const output = captureConsoleError();
      const startedAt = performance.now();
      try {
        const response = await handler(loginEvent(USERNAME, 'clave-incorrecta'));
        const elapsed = performance.now() - startedAt;
        assert.equal(response.statusCode, 503);
        assert.equal(JSON.parse(response.body).error, 'busy');
        assert.ok(elapsed >= 4500 && elapsed < 8000, `tardó ${elapsed} ms`);
      } finally {
        await locker.query('ROLLBACK');
        await locker.end();
      }
      assert.match(output.stop(), /ER_LOCK_WAIT_TIMEOUT/);
    });

    function handlerWithSearch(replacementSql) {
      const replaced = {
        ...db,
        query: (sql, params) => (CONTRACT_SEARCH.test(sql) ? db.query(replacementSql()) : db.query(sql, params)),
      };
      const app = createApp({ db: replaced, config, loginFailureFloorMs: 0 });
      return createHandler(async () => app);
    }

    // La búsqueda del contrato ordena por id y no llega al filesort: aquí se la obliga, con un tope muy bajo.
    it('un corte de MAX_EXECUTION_TIME durante un filesort responde 504 timeout, llegue con el código que llegue', async (t) => {
      const signedIn = await handler(loginEvent(USERNAME, PASSWORD));
      const { token } = JSON.parse(signedIn.body);
      const limits = [1, 2, 3, 5, 8, 12, 20, 30, 50];
      let index = 0;
      const sorting = handlerWithSearch(() => {
        const limit = limits[index % limits.length];
        index += 1;
        return `SELECT /*+ MAX_EXECUTION_TIME(${limit}) */ ${SELECT_COLUMNS} FROM connectus_pages.sms `
          + 'WHERE id_account = 101 ORDER BY sms_content DESC, id LIMIT 51';
      });

      const statuses = new Set();
      const output = captureConsoleError();
      for (let round = 0; round < limits.length * 4; round += 1) {
        const response = await sorting(searchEvent(token));
        statuses.add(response.statusCode);
        if (response.statusCode === 504) assert.equal(JSON.parse(response.body).error, 'timeout');
      }
      const logged = output.stop();
      const codes = new Set(logged.match(/ER_[A-Z_]+/g) || []);
      t.diagnostic(`códigos del corte: ${[...codes].join(', ') || 'ninguno'}`);
      assert.ok(statuses.has(504), 'el tope tiene que alcanzar a cortar alguna');
      assert.deepEqual([...statuses].filter((status) => status !== 200 && status !== 504), []);
      assert.deepEqual([...codes].filter((code) => code !== 'ER_QUERY_TIMEOUT' && code !== 'ER_FILSORT_ABORT'), []);
    });

    it('KILL QUERY responde 504 timeout, no 500', async (t) => {
      const signedIn = await handler(loginEvent(USERNAME, PASSWORD));
      const { token } = JSON.parse(signedIn.body);
      const [{ id }] = await db.query('SELECT CONNECTION_ID() AS id');
      const heavy = handlerWithSearch(() => 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ a.id, a.id_delivery, a.dst_number, '
        + 'a.sms_content, a.status, a.created_at FROM connectus_pages.sms a '
        + 'JOIN connectus_pages.sms b ON a.id % 50 = b.id % 50 AND b.id < 4000 ORDER BY a.sms_content DESC, b.id LIMIT 51');

      const output = captureConsoleError();
      const pending = heavy(searchEvent(token));
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [[running]] = await admin.query(
          "SELECT COUNT(*) AS total FROM information_schema.PROCESSLIST WHERE ID = ? AND INFO LIKE '%a.sms_content%'",
          [Number(id)]
        );
        if (Number(running.total) > 0) break;
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }
      await admin.query('KILL QUERY ?', [Number(id)]);
      const response = await pending;
      const logged = output.stop();
      t.diagnostic(`código de KILL QUERY: ${(logged.match(/ER_[A-Z_]+/g) || []).join(', ')}`);
      assert.equal(response.statusCode, 504);
      assert.equal(JSON.parse(response.body).error, 'timeout');
      assert.match(logged, /ER_QUERY_INTERRUPTED|ER_FILSORT_ABORT/);
    });
  });
});
