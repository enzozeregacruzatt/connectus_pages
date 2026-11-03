'use strict';

// Requiere scripts/mysql_prueba.sh up: comprueba la tercera barrera del contrato contra un mysqld real.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, 'test', '.env.local');
const CREAR_LOGIN = path.join(ROOT, 'scripts', 'crear_login.js');
const APROVISIONAR = path.join(ROOT, 'scripts', 'aprovisionar_bd.sh');
const TERMINAL_MYSQL_P = path.join(__dirname, 'support', 'terminal_mysql_p.py');
const REQUIRED_VARS = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_SSL_CA_FILE',
  'DB_ADMIN_USER',
  'LOGIN_DEMO_PASSWORD',
];

const ER_ACCESS_DENIED = 1045;
const ER_DB_ACCESS_DENIED = 1044;
const ER_TABLE_DENIED = 1142;
const ER_COLUMN_DENIED = 1143;
const ER_PROC_DENIED = 1370;
const ER_BAD_FIELD = 1054;
const ER_ACCOUNT_LOCKED = 3118;

const RANGE_START = '2026-10-10 00:00:00';
const RANGE_END = '2026-10-20 23:59:59';
const CUTOFF_LO = '2026-10-09 00:00:00';
const CUTOFF_HI = '2026-10-21 23:59:59';

function loadEnv() {
  let text;
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    throw new Error("No existe test/.env.local: corre 'scripts/mysql_prueba.sh up' antes de las pruebas de integración.");
  }
  const env = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables en test/.env.local (${missing.join(', ')}): corre 'scripts/mysql_prueba.sh up'.`);
  }
  return env;
}

function tlsOptions(env) {
  return { ca: fs.readFileSync(env.DB_SSL_CA_FILE), rejectUnauthorized: true, verifyIdentity: false };
}

function connect(env, options) {
  return mysql.createConnection({
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    connectTimeout: 5000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
    stringifyObjects: true,
    ...options,
  });
}

function connectApp(env) {
  return connect(env, { user: env.DB_USER, password: env.DB_PASSWORD, ssl: tlsOptions(env) });
}

function connectAdmin(env) {
  return connect(env, { user: env.DB_ADMIN_USER, ssl: tlsOptions(env) });
}

async function assertFails(action, errnos) {
  await assert.rejects(action, (err) => {
    assert.ok(errnos.includes(err.errno), `se esperaba errno ${errnos.join(' o ')} y llegó ${err.errno}`);
    return true;
  });
}

// SHOW GRANTS cambia el orden de líneas y columnas, y las comillas, según la versión del servidor.
function normalizeGrants(rows) {
  return rows
    .map((row) => Object.values(row)[0].replace(/[`']/g, ''))
    .map((line) => line.replace(/\(([^)]*)\)/, (_, cols) => `(${cols.split(',').map((c) => c.trim()).sort().join(', ')})`))
    .sort();
}

function contractQuery({ dst, cursor, upperBound = true } = {}) {
  let where = `id_account = ? AND id > ?${upperBound ? ' AND id <= ?' : ''} AND created_at BETWEEN ? AND ?`;
  if (dst !== undefined) where += ' AND dst_number = ?';
  if (cursor !== undefined) where += ' AND id < ?';
  return `SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_delivery, dst_number, sms_content, status, created_at
    FROM connectus_pages.sms WHERE ${where} ORDER BY id DESC LIMIT 51`;
}

describe('base de datos', () => {
  let env;
  let app;
  let admin;

  before(async () => {
    env = loadEnv();
    app = await connectApp(env);
    admin = await connectAdmin(env);
  });

  after(async () => {
    if (app) await app.end();
    if (admin) await admin.end();
  });

  async function cutoffs() {
    const [[row]] = await app.query(
      'SELECT /*+ MAX_EXECUTION_TIME(2000) */ connectus_pages.sms_cutoff_id(?) AS lo, connectus_pages.sms_cutoff_id(?) AS hi',
      [CUTOFF_LO, CUTOFF_HI],
    );
    return row;
  }

  describe('pages_app no sale de lo permitido', () => {
    for (const table of ['sms_outgoing', 'delivery', 'account']) {
      it(`no puede leer dbconnectus.${table}`, async () => {
        await assertFails(() => app.query(`SELECT * FROM dbconnectus.${table} LIMIT 1`), [ER_TABLE_DENIED]);
      });
    }

    it('no puede entrar a dbconnectus ni verla', async () => {
      await assertFails(() => app.query('USE dbconnectus'), [ER_DB_ACCESS_DENIED]);
      // En 8.0, performance_schema se lista para todos: trae tablas públicas, como session_variables.
      const [rows] = await app.query('SHOW DATABASES');
      const visible = rows.map((row) => row.Database).filter((name) => name !== 'performance_schema');
      assert.deepEqual(visible.sort(), ['connectus_pages', 'information_schema']);
    });

    for (const table of ['allowed_account', 'audit_log']) {
      it(`no puede leer ${table}`, async () => {
        await assertFails(() => app.query(`SELECT * FROM connectus_pages.${table} LIMIT 1`), [ER_TABLE_DENIED]);
      });
    }

    for (const column of ['password_hash', 'active', 'username', 'token_version']) {
      it(`no puede cambiar login.${column}`, async () => {
        await assertFails(
          () => app.query(`UPDATE connectus_pages.login SET ${column} = ${column} WHERE id = 0`),
          [ER_COLUMN_DENIED, ER_TABLE_DENIED],
        );
      });
    }

    const denied = {
      'DELETE en login': 'DELETE FROM connectus_pages.login WHERE id = 0',
      'INSERT en login': "INSERT INTO connectus_pages.login (username, password_hash) VALUES ('x', 'x')",
      'INSERT en login_account': 'INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (1, 999)',
      'INSERT en allowed_account': 'INSERT INTO connectus_pages.allowed_account (id_account) VALUES (999)',
      'DELETE en audit_log': 'DELETE FROM connectus_pages.audit_log WHERE id = 0',
      'UPDATE en audit_log': "UPDATE connectus_pages.audit_log SET detail = 'x' WHERE id = 0",
      'CREATE TABLE': 'CREATE TABLE connectus_pages.grants_prueba (id INT)',
      'CREATE VIEW': 'CREATE VIEW connectus_pages.grants_prueba AS SELECT 1',
      'DROP de una tabla': 'DROP TABLE connectus_pages.login',
      'DROP de una vista': 'DROP VIEW connectus_pages.sms',
    };
    for (const [name, sql] of Object.entries(denied)) {
      it(`rechaza ${name}`, async () => {
        await assertFails(() => app.query(sql), [ER_TABLE_DENIED, ER_COLUMN_DENIED]);
      });
    }

    it('rechaza CREATE y DROP de bases y DROP de la función', async () => {
      await assertFails(() => app.query('CREATE DATABASE grants_prueba'), [ER_DB_ACCESS_DENIED]);
      await assertFails(() => app.query('DROP DATABASE connectus_pages'), [ER_DB_ACCESS_DENIED]);
      await assertFails(() => app.query('DROP FUNCTION connectus_pages.sms_cutoff_id'), [ER_PROC_DENIED]);
    });

    it('rechaza una conexión sin TLS', async () => {
      await assertFails(
        () => connect(env, { user: env.DB_USER, password: env.DB_PASSWORD, ssl: undefined }),
        [ER_ACCESS_DENIED],
      );
    });

    it('tiene exactamente los permisos del contrato', async () => {
      const [rows] = await admin.query("SHOW GRANTS FOR 'pages_app'@'%'");
      assert.deepEqual(
        normalizeGrants(rows),
        [
          'GRANT EXECUTE ON FUNCTION connectus_pages.sms_cutoff_id TO pages_app@%',
          'GRANT INSERT ON connectus_pages.audit_log TO pages_app@%',
          'GRANT SELECT ON connectus_pages.account TO pages_app@%',
          'GRANT SELECT ON connectus_pages.delivery TO pages_app@%',
          'GRANT SELECT ON connectus_pages.login_account TO pages_app@%',
          'GRANT SELECT ON connectus_pages.sms TO pages_app@%',
          'GRANT SELECT, UPDATE (failed_attempts, last_login_at, locked_until) ON connectus_pages.login TO pages_app@%',
          'GRANT USAGE ON *.* TO pages_app@%',
        ].sort(),
      );
    });

    it('tiene TLS obligatorio y los topes del contrato', async () => {
      const [[row]] = await admin.query(
        `SELECT ssl_type, max_questions, max_connections, max_user_connections, account_locked
         FROM mysql.user WHERE user = 'pages_app' AND host = '%'`,
      );
      assert.deepEqual(
        { ...row },
        { ssl_type: 'ANY', max_questions: 0, max_connections: 2000, max_user_connections: 8, account_locked: 'N' },
      );
    });
  });

  describe('lo que pages_app sí puede hacer', () => {
    it('lee login y login_account', async () => {
      const [rows] = await app.query(
        `SELECT l.username, la.id_account FROM connectus_pages.login l
         JOIN connectus_pages.login_account la ON la.id_login = l.id
         WHERE l.username IN ('demo', 'solo102') ORDER BY l.username, la.id_account`,
      );
      assert.deepEqual(rows.map((row) => [row.username, row.id_account]), [['demo', 101], ['demo', 102], ['solo102', 102]]);
    });

    it('el hash de demo es el de su clave', async () => {
      const [[row]] = await app.query("SELECT password_hash FROM connectus_pages.login WHERE username = 'demo'");
      const [scheme, n, r, p, salt, hash] = row.password_hash.split('$');
      assert.deepEqual([scheme, n, r, p], ['scrypt', '32768', '8', '1']);
      const derived = crypto.scryptSync(env.LOGIN_DEMO_PASSWORD, Buffer.from(salt, 'base64'), 32, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      });
      assert.ok(crypto.timingSafeEqual(derived, Buffer.from(hash, 'base64')));
    });

    it('inactivo existe con active = 0', async () => {
      const [[row]] = await app.query("SELECT active FROM connectus_pages.login WHERE username = 'inactivo'");
      assert.equal(row.active, 0);
    });

    it('corre el bloqueo y el ingreso del contrato', async () => {
      // Con un login propio: node --test corre los archivos en paralelo y otra prueba puede estar usando demo.
      const username = `grants_${crypto.randomBytes(4).toString('hex')}`;
      const [created] = await admin.query(
        "INSERT INTO connectus_pages.login (username, password_hash) VALUES (?, 'scrypt$no$sirve')",
        [username],
      );
      const id = created.insertId;
      const lockout = `UPDATE connectus_pages.login
        SET locked_until = IF(failed_attempts + 1 >= 5, UTC_TIMESTAMP() + INTERVAL 15 MINUTE, locked_until),
            failed_attempts = IF(failed_attempts + 1 >= 5, 0, failed_attempts + 1)
        WHERE id = ?`;
      const read = async () => {
        const [[row]] = await app.query(
          'SELECT failed_attempts, locked_until, last_login_at FROM connectus_pages.login WHERE id = ?',
          [id],
        );
        return row;
      };
      try {
        for (let attempt = 1; attempt <= 4; attempt += 1) await app.query(lockout, [id]);
        assert.equal((await read()).failed_attempts, 4);
        assert.equal((await read()).locked_until, null);

        await app.query(lockout, [id]);
        const locked = await read();
        assert.equal(locked.failed_attempts, 0);
        assert.notEqual(locked.locked_until, null);

        await app.query(
          'UPDATE connectus_pages.login SET failed_attempts = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?',
          [id],
        );
        const entered = await read();
        assert.equal(entered.locked_until, null);
        assert.notEqual(entered.last_login_at, null);
      } finally {
        await admin.query('DELETE FROM connectus_pages.login WHERE id = ?', [id]);
      }
    });

    it('sus escrituras en login no suben token_version: el trigger solo mira la clave', async () => {
      const username = `grants_${crypto.randomBytes(4).toString('hex')}`;
      const [created] = await admin.query(
        "INSERT INTO connectus_pages.login (username, password_hash) VALUES (?, 'scrypt$uno')",
        [username],
      );
      const id = created.insertId;
      const version = async () => {
        const [[row]] = await app.query('SELECT token_version FROM connectus_pages.login WHERE id = ?', [id]);
        return row.token_version;
      };
      try {
        assert.equal(await version(), 0);
        await app.query('UPDATE connectus_pages.login SET failed_attempts = failed_attempts + 1 WHERE id = ?', [id]);
        await app.query('UPDATE connectus_pages.login SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [id]);
        assert.equal(await version(), 0);

        await admin.query("UPDATE connectus_pages.login SET password_hash = 'scrypt$dos' WHERE id = ?", [id]);
        assert.equal(await version(), 1);
        await admin.query("UPDATE connectus_pages.login SET password_hash = 'scrypt$dos' WHERE id = ?", [id]);
        assert.equal(await version(), 1, 'sin cambio real de clave no sube');
        await admin.query('UPDATE connectus_pages.login SET token_version = token_version + 1 WHERE id = ?', [id]);
        assert.equal(await version(), 2);
      } finally {
        await admin.query('DELETE FROM connectus_pages.login WHERE id = ?', [id]);
      }
    });

    it('el trigger de login es de pages_owner', async () => {
      const [[row]] = await admin.query(
        `SELECT definer AS definer, action_timing AS timing, event_manipulation AS event, event_object_table AS tbl
         FROM information_schema.triggers WHERE trigger_schema = 'connectus_pages' AND trigger_name = 'login_password_changed'`,
      );
      assert.deepEqual({ ...row }, { definer: 'pages_owner@%', timing: 'BEFORE', event: 'UPDATE', tbl: 'login' });
    });

    it('inserta en audit_log aunque no pueda leerlo', async () => {
      const [result] = await app.query(
        "INSERT INTO connectus_pages.audit_log (action, detail, ip) VALUES ('grants_prueba', 'sin_numero', '127.0.0.1')",
      );
      try {
        const [[row]] = await admin.query('SELECT action FROM connectus_pages.audit_log WHERE id = ?', [result.insertId]);
        assert.equal(row.action, 'grants_prueba');
      } finally {
        await admin.query('DELETE FROM connectus_pages.audit_log WHERE id = ?', [result.insertId]);
      }
    });
  });

  describe('vistas', () => {
    // Lista permitida, no de nombres prohibidos: una lista de prohibidos publicaría justo los nombres que quiere evitar.
    it('el fixture público solo trae las columnas que usa la consulta', async () => {
      const [rows] = await admin.query(
        "SELECT CONCAT(table_name, '.', column_name) AS col FROM information_schema.columns WHERE table_schema = 'dbconnectus'",
      );
      const filler = 'columna_fuera_del_contrato';
      assert.deepEqual(
        rows.map((row) => row.col).sort(),
        [
          ...['id', 'name', filler].map((column) => `account.${column}`),
          ...['id', 'id_account', 'name', filler].map((column) => `delivery.${column}`),
          ...['id', 'id_account', 'id_delivery', 'status', 'dst_number', 'sms_content', 'created_at', filler].map(
            (column) => `sms_outgoing.${column}`,
          ),
        ].sort(),
      );
    });

    it('la cuenta 999 existe en el origen', async () => {
      const [[sms]] = await admin.query('SELECT COUNT(*) AS n FROM dbconnectus.sms_outgoing WHERE id_account = 999');
      assert.ok(Number(sms.n) > 0);
      const [[delivery]] = await admin.query('SELECT COUNT(*) AS n FROM dbconnectus.delivery WHERE id_account = 999');
      assert.ok(Number(delivery.n) > 0);
      const [[account]] = await admin.query('SELECT COUNT(*) AS n FROM dbconnectus.account WHERE id = 999');
      assert.equal(Number(account.n), 1);
    });

    it('nunca devuelven la cuenta 999, aunque se pida', async () => {
      const queries = [
        'SELECT id FROM connectus_pages.sms WHERE id_account = 999',
        'SELECT id FROM connectus_pages.sms WHERE dst_number = 56900000999',
        'SELECT id FROM connectus_pages.sms WHERE id BETWEEN 9005 AND 9010',
        'SELECT id FROM connectus_pages.sms WHERE id_account = 999 OR 1 = 0',
        'SELECT id FROM connectus_pages.delivery WHERE id_account = 999',
        'SELECT id FROM connectus_pages.delivery WHERE id = 6',
        'SELECT id FROM connectus_pages.account WHERE id = 999',
      ];
      for (const sql of queries) {
        const [rows] = await app.query(sql);
        assert.equal(rows.length, 0, sql);
      }
    });

    it('sin filtro, solo devuelven las cuentas permitidas', async () => {
      const [sms] = await app.query('SELECT DISTINCT id_account FROM connectus_pages.sms ORDER BY id_account');
      assert.deepEqual(sms.map((row) => row.id_account), [101, 102]);
      const [delivery] = await app.query('SELECT DISTINCT id_account FROM connectus_pages.delivery ORDER BY id_account');
      assert.deepEqual(delivery.map((row) => row.id_account), [101, 102]);
      const [account] = await app.query('SELECT id, name FROM connectus_pages.account ORDER BY id');
      assert.deepEqual(account.map((row) => row.id), [101, 102]);
    });

    it('no exponen columnas fuera del contrato', async () => {
      for (const view of ['sms', 'delivery', 'account']) {
        await assertFails(
          () => app.query(`SELECT columna_fuera_del_contrato FROM connectus_pages.${view} LIMIT 1`),
          [ER_BAD_FIELD],
        );
      }
      const [columns] = await app.query(
        `SELECT table_name AS t, column_name AS c FROM information_schema.columns
         WHERE table_schema = 'connectus_pages' AND table_name IN ('sms', 'delivery', 'account')
         ORDER BY table_name, ordinal_position`,
      );
      const byTable = {};
      for (const { t, c } of columns) (byTable[t] ||= []).push(c);
      assert.deepEqual(byTable, {
        account: ['id', 'name'],
        delivery: ['id', 'id_account', 'name'],
        sms: ['id', 'id_account', 'id_delivery', 'dst_number', 'sms_content', 'status', 'created_at'],
      });
    });

    for (const view of ['sms', 'delivery', 'account']) {
      it(`${view} es MERGE, SECURITY DEFINER y de pages_owner`, async () => {
        const [[row]] = await admin.query(`SHOW CREATE VIEW connectus_pages.${view}`);
        const definition = row['Create View'];
        assert.match(definition, /ALGORITHM=MERGE/);
        assert.match(definition, /DEFINER=`pages_owner`@`%`/);
        assert.match(definition, /SQL SECURITY DEFINER/);
      });
    }

    it('los nombres de envío se traen por cuenta', async () => {
      const [rows] = await app.query('SELECT id, name FROM connectus_pages.delivery WHERE id IN (?) AND id_account = ?', [
        [1, 7],
        101,
      ]);
      assert.deepEqual(rows.map((row) => row.id), [1]);
    });
  });

  describe('sms_cutoff_id', () => {
    it('es READS SQL DATA, DEFINER y de pages_owner', async () => {
      const [[row]] = await admin.query(
        `SELECT sql_data_access AS access, security_type AS security, definer AS definer FROM information_schema.routines
         WHERE routine_schema = 'connectus_pages' AND routine_name = 'sms_cutoff_id'`,
      );
      assert.deepEqual({ ...row }, { access: 'READS SQL DATA', security: 'DEFINER', definer: 'pages_owner@%' });
    });

    it('devuelve la última fila anterior a la fecha', async () => {
      const [[{ cutoff }]] = await app.query('SELECT connectus_pages.sms_cutoff_id(?) AS cutoff', [RANGE_START]);
      assert.match(cutoff, /^[1-9][0-9]*$/);
      const [[row]] = await admin.query(
        `SELECT id FROM dbconnectus.sms_outgoing WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        [RANGE_START],
      );
      assert.equal(cutoff, String(row.id));
    });

    it('devuelve 0 si no hay filas anteriores', async () => {
      const [[{ cutoff }]] = await app.query("SELECT connectus_pages.sms_cutoff_id('2000-01-01 00:00:00') AS cutoff");
      assert.equal(cutoff, '0');
    });

    it('acota por los dos lados', async () => {
      const { lo, hi } = await cutoffs();
      assert.ok(Number(lo) > 0);
      assert.ok(Number(hi) > Number(lo));
    });
  });

  describe('consulta del contrato', () => {
    it('devuelve filas de la cuenta y del rango, de id mayor a menor', async () => {
      const { lo, hi } = await cutoffs();
      const [rows] = await app.query(contractQuery(), [101, lo, hi, RANGE_START, RANGE_END]);
      assert.equal(rows.length, 51);
      for (let i = 0; i < rows.length; i += 1) {
        assert.ok(rows[i].created_at >= RANGE_START && rows[i].created_at <= RANGE_END);
        if (i > 0) assert.ok(Number(rows[i].id) < Number(rows[i - 1].id));
      }
    });

    it('con número y cursor', async () => {
      const { lo, hi } = await cutoffs();
      const first = await app.query(contractQuery({ dst: '56900000777' }), [102, lo, hi, RANGE_START, RANGE_END, '56900000777']);
      assert.equal(first[0].length, 51);
      assert.ok(first[0].every((row) => row.dst_number === '56900000777'));
      const cursor = String(first[0][49].id);
      const second = await app.query(contractQuery({ dst: '56900000777', cursor }), [
        102,
        lo,
        hi,
        RANGE_START,
        RANGE_END,
        '56900000777',
        cursor,
      ]);
      assert.equal(String(second[0][0].id), String(first[0][50].id));
    });

    it('con la cuenta 999 no devuelve nada', async () => {
      const { lo, hi } = await cutoffs();
      const [rows] = await app.query(contractQuery(), [999, lo, hi, RANGE_START, RANGE_END]);
      assert.equal(rows.length, 0);
    });

    // EXPLAIN sobre una vista exige SHOW VIEW, que pages_app no tiene ni debe tener: se mira el plan como admin.
    async function explain(options, params) {
      const { lo, hi } = await cutoffs();
      const [rows] = await admin.query(`EXPLAIN ${contractQuery(options)}`, [101, lo, hi, RANGE_START, RANGE_END, ...params]);
      return rows;
    }

    function assertMergedWithIndex(plan) {
      assert.ok(plan.every((row) => row.select_type === 'SIMPLE'), 'la vista no se fusionó');
      assert.ok(!plan.some((row) => String(row.table).startsWith('<derived')), 'la vista se materializó');
      const sms = plan.find((row) => row.table === 's');
      assert.ok(sms, 'falta sms_outgoing en el plan');
      assert.notEqual(sms.key, null);
      assert.notEqual(sms.type, 'ALL');
      const allowed = plan.find((row) => row.table === 'a');
      assert.ok(allowed, 'falta allowed_account en el plan');
      assert.equal(allowed.key, 'PRIMARY');
    }

    it('usa índice sin número, en la vista fusionada', async () => {
      assertMergedWithIndex(await explain({}, []));
    });

    it('usa índice con número, en la vista fusionada', async () => {
      assertMergedWithIndex(await explain({ dst: '56900000777' }, ['56900000777']));
    });

    it('usa índice con cursor, en la vista fusionada', async () => {
      assertMergedWithIndex(await explain({ cursor: '12000' }, ['12000']));
    });

    it('sin cota superior, para los rangos que llegan hasta hoy, también usa índice en la vista fusionada', async () => {
      const { lo } = await cutoffs();
      const [plan] = await admin.query(`EXPLAIN ${contractQuery({ upperBound: false })}`, [101, lo, RANGE_START, RANGE_END]);
      assertMergedWithIndex(plan);
    });
  });

  describe('pages_owner', () => {
    it('tiene exactamente los permisos del contrato', async () => {
      const [rows] = await admin.query("SHOW GRANTS FOR 'pages_owner'@'%'");
      assert.deepEqual(
        normalizeGrants(rows),
        [
          'GRANT ALL PRIVILEGES ON connectus_pages.* TO pages_owner@% WITH GRANT OPTION',
          'GRANT SELECT (id, name) ON dbconnectus.account TO pages_owner@%',
          'GRANT SELECT (id, id_account, name) ON dbconnectus.delivery TO pages_owner@%',
          'GRANT SELECT (created_at, dst_number, id, id_account, id_delivery, sms_content, status) ON dbconnectus.sms_outgoing TO pages_owner@%',
          'GRANT USAGE ON *.* TO pages_owner@%',
        ].sort(),
      );
    });

    it('está bloqueada y con TLS obligatorio', async () => {
      const [[row]] = await admin.query(
        "SELECT ssl_type, account_locked FROM mysql.user WHERE user = 'pages_owner' AND host = '%'",
      );
      assert.deepEqual({ ...row }, { ssl_type: 'ANY', account_locked: 'Y' });
    });

    it('no puede entrar con la clave correcta, y las vistas siguen andando', async () => {
      // La clave real no se guarda en ningún lado. Para que el rechazo venga del bloqueo y no de la clave, se le fija una
      // conocida: ALTER USER no toca el bloqueo.
      const password = crypto.randomBytes(24).toString('hex');
      await admin.query("ALTER USER 'pages_owner'@'%' IDENTIFIED BY ?", [password]);
      await assertFails(
        () => connect(env, { user: 'pages_owner', password, ssl: tlsOptions(env) }),
        [ER_ACCOUNT_LOCKED],
      );

      const [sms] = await app.query('SELECT id FROM connectus_pages.sms WHERE id_account = 101 LIMIT 1');
      assert.equal(sms.length, 1);
      const [delivery] = await app.query('SELECT id FROM connectus_pages.delivery WHERE id_account = 101 LIMIT 1');
      assert.equal(delivery.length, 1);
      const [account] = await app.query('SELECT id FROM connectus_pages.account WHERE id = 101');
      assert.equal(account.length, 1);
      const { lo } = await cutoffs();
      assert.ok(Number(lo) > 0);
    });
  });

  describe('aprovisionar_bd.sh', () => {
    function hostArgs() {
      return `--protocol=TCP -h ${env.DB_HOST} -P ${env.DB_PORT} --ssl-mode=VERIFY_CA --ssl-ca=${env.DB_SSL_CA_FILE}`;
    }

    function run(extraEnv) {
      return spawnSync('bash', [APROVISIONAR], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...extraEnv },
      });
    }

    // Las cuentas ya existen en esta base: si el archivo llegara a parsearse, el error sería 1396 y no 1064.
    it('00_cuentas.sql no corre sin el script que pone las claves', () => {
      const result = spawnSync('mysql', `--no-defaults -u ${env.DB_ADMIN_USER} ${hostArgs()}`.split(' '), {
        encoding: 'utf8',
        input: fs.readFileSync(path.join(ROOT, 'sql', '00_cuentas.sql'), 'utf8'),
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ERROR 1064/);
    });

    it('sin MYSQL_HOST_ARGS, sale con error y no hay host por defecto', () => {
      const result = run({ MYSQL_ADMIN_ARGS: `-u ${env.DB_ADMIN_USER}` });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /MYSQL_HOST_ARGS/);
    });

    it('rechaza una clave en MYSQL_ADMIN_ARGS', () => {
      const result = run({ MYSQL_ADMIN_ARGS: '-u root -pclave', MYSQL_HOST_ARGS: hostArgs() });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no puede llevar la clave/);
    });

    // Con un cliente falso que deja constancia de sus argumentos: estas pruebas no se conectan a nada.
    function runWithFakeClient(mysqlHostArgs, mysqlAdminArgs = '-u master') {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-mysql-falso-'));
      const client = path.join(directory, 'mysql');
      const calls = path.join(directory, 'llamadas');
      fs.writeFileSync(client, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' "$*" >> '${calls}'\n`, { mode: 0o755 });
      try {
        const result = run({ MYSQL: client, MYSQL_ADMIN_ARGS: mysqlAdminArgs, MYSQL_HOST_ARGS: mysqlHostArgs });
        return { ...result, called: fs.existsSync(calls) };
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }

    const insecure = {
      'sin --ssl-mode': '-h db.invalid -P 3306',
      'con PREFERRED': '-h db.invalid -P 3306 --ssl-mode=PREFERRED',
      'con REQUIRED, que no valida el certificado': '-h db.invalid -P 3306 --ssl-mode=REQUIRED --ssl-ca=/x.pem',
      'con DISABLED': '-h db.invalid -P 3306 --ssl-mode=DISABLED',
      'con VERIFY_CA hacia otro host': '-h db.invalid -P 3306 --ssl-mode=VERIFY_CA --ssl-ca=/x.pem',
      'con VERIFY_CA hacia localhost': '-h localhost -P 3306 --ssl-mode=VERIFY_CA --ssl-ca=/x.pem',
      'con un --ssl-mode que tapa al primero': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --ssl-mode=DISABLED',
      'con --skip-ssl': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --skip-ssl',
      'sin host': '-P 3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'con dos hosts': '-h 127.0.0.1 -h db.invalid --ssl-mode=VERIFY_CA --ssl-ca=/x.pem',
      'con un host vacío': '--host= -P 3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      // El cliente acepta todas estas escrituras, y la última gana.
      'con --ssl-mode DISABLED, separado': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --ssl-mode DISABLED',
      'con --ssl_mode DISABLED, separado': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --ssl_mode DISABLED',
      'con --ssl_mode=VERIFY_IDENTITY': '-h db.invalid --ssl_mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'con --loose-ssl-mode=DISABLED': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --loose-ssl-mode=DISABLED',
      'con --loose_ssl_mode=DISABLED': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --loose_ssl_mode=DISABLED',
      'con --skip_ssl': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --skip_ssl',
      'con --ssl=0': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --ssl=0',
      'con --loose-host= que cambia el host de VERIFY_CA': '-h 127.0.0.1 --ssl-mode=VERIFY_CA --ssl-ca=/x.pem --loose-host=db.invalid',
      'con --protocol distinto de TCP': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --protocol=SOCKET',
      'con --defaults-file': '--defaults-file=/x.cnf -h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'con un argumento suelto': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem otra_base',
      'con -h sin valor al final': '--ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem -h',
      'con -h que se come la opción siguiente': '-h --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'con -P sin valor al final': '-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem -P',
      'con -P que no es un número': '-h db.invalid -P x --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'con -Px': '-h db.invalid -Px --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'con --port= que no es un número': '-h db.invalid --port=x --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'con --port=-P33077': '-h db.invalid --port=-P33077 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'con -P--port=33077': '-h db.invalid -P--port=33077 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
    };
    for (const [name, mysqlHostArgs] of Object.entries(insecure)) {
      it(`rechaza una conexión sin TLS verificado, antes de tocar nada: ${name}`, () => {
        const result = runWithFakeClient(mysqlHostArgs);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /MYSQL_HOST_ARGS/);
        assert.equal(result.called, false, 'no debe llegar a llamar al cliente');
      });
    }

    const secure = {
      'VERIFY_IDENTITY con -h': '-h db.invalid -P 3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'VERIFY_IDENTITY con --host=': '--host=db.invalid -P 3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'VERIFY_IDENTITY con -hHOST': '-hdb.invalid -P 3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'VERIFY_CA hacia 127.0.0.1': '--protocol=TCP -h 127.0.0.1 -P 33077 --ssl-mode=VERIFY_CA --ssl-ca=/x.pem',
      'el puerto con -PN': '-h db.invalid -P3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
      'el puerto con --port=': '-h db.invalid --port=3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem',
    };
    for (const [name, mysqlHostArgs] of Object.entries(secure)) {
      it(`acepta ${name}`, () => {
        const result = runWithFakeClient(mysqlHostArgs);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.called, true);
      });
    }

    it('un argumento no permitido no se repite en el error: podría ser una clave', () => {
      const result = runWithFakeClient('-h db.invalid --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem --password=una-clave-que-no-va');
      assert.equal(result.status, 2);
      assert.equal(result.called, false);
      assert.equal(result.stderr.includes('una-clave-que-no-va'), false);
    });

    const SECURE_HOST = '-h db.invalid -P 3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/x.pem';
    const unsafeAdmin = {
      'con la clave pegada a -p': '-u master -puna-clave-que-no-va',
      'con --password=': '-u master --password=una-clave-que-no-va',
      'con --loose-password=': '-u master --loose-password=una-clave-que-no-va',
      'con --loose_password=': '-u master --loose_password=una-clave-que-no-va',
      'con la clave después de -p': '-u master -p una-clave-que-no-va',
      'con --tls-version=': '-u master --tls-version=TLSv1',
      'con --ssl-cipher=': '-u master --ssl-cipher=AES128-SHA',
      'con --defaults-file=': '--defaults-file=/x.cnf -u master',
      'con --host=': '-u master --host=otro.invalid',
      'con -u sin valor al final': '-p -u',
      'con -u que se come la opción siguiente': '-u -p',
      'con --user= vacío': '--user=',
      'con --user separado': '--user master',
    };
    for (const [name, mysqlAdminArgs] of Object.entries(unsafeAdmin)) {
      it(`rechaza MYSQL_ADMIN_ARGS antes de tocar nada, sin repetir el argumento: ${name}`, () => {
        const result = runWithFakeClient(SECURE_HOST, mysqlAdminArgs);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /MYSQL_ADMIN_ARGS solo admite/);
        assert.equal(result.called, false, 'no debe llegar a llamar al cliente');
        assert.equal(result.stderr.includes('una-clave-que-no-va'), false);
      });
    }

    for (const mysqlAdminArgs of ['-u master', '-u master -p', '-umaster -p', '--user=master --password', '-p -u master']) {
      it(`acepta MYSQL_ADMIN_ARGS: ${mysqlAdminArgs}`, () => {
        const result = runWithFakeClient(SECURE_HOST, mysqlAdminArgs);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.called, true);
      });
    }

    // Lo que deja mysql_config_editor: 4 bytes en cero, 20 de clave y una línea cifrada por registro, con su largo adelante.
    function writeLoginFile(file, lines) {
      const obfuscation = crypto.randomBytes(20);
      const key = Buffer.alloc(16);
      obfuscation.forEach((byte, index) => {
        key[index % 16] ^= byte;
      });
      const parts = [Buffer.alloc(4), obfuscation];
      for (const line of lines) {
        const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
        const encrypted = Buffer.concat([cipher.update(`${line}\n`), cipher.final()]);
        const size = Buffer.alloc(4);
        size.writeUInt32LE(encrypted.length);
        parts.push(size, encrypted);
      }
      fs.writeFileSync(file, Buffer.concat(parts), { mode: 0o600 });
    }

    it('un [client] con otra cuenta en ~/.mylogin.cnf no le gana a pages_owner', async () => {
      const master = 'prueba_login_file';
      const password = crypto.randomBytes(16).toString('hex');
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-mylogin-'));
      const loginFile = path.join(directory, 'mylogin.cnf');
      const seen = path.join(directory, 'visto');
      const client = path.join(directory, 'mysql');
      writeLoginFile(loginFile, ['[client]', `user = ${master}`, `password = ${password}`]);
      // Con la base compartida no se puede volver a aprovisionar. El paso del master no hace nada, y el de pages_owner le pregunta
      // al servidor quién es, con el entorno y los argumentos que le dio el script.
      fs.writeFileSync(
        client,
        `#!/bin/sh\ncat > /dev/null\ncase "$1" in\n  --defaults-file=*) mysql "$@" -N -e 'SELECT CURRENT_USER()' >> '${seen}' 2>&1 ;;\nesac\nexit 0\n`,
        { mode: 0o755 }
      );
      await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [master, '%', password]);
      try {
        // Sin esta comprobación, un archivo que el cliente ignorara dejaría pasar la prueba sin probar nada.
        const asFile = spawnSync(
          'mysql',
          [
            '--no-defaults',
            '--protocol=TCP',
            '-h', env.DB_HOST,
            '-P', env.DB_PORT,
            '--ssl-mode=VERIFY_CA',
            `--ssl-ca=${env.DB_SSL_CA_FILE}`,
            '-N',
            '-e', 'SELECT CURRENT_USER()',
          ],
          { encoding: 'utf8', env: { PATH: process.env.PATH, MYSQL_TEST_LOGIN_FILE: loginFile } }
        );
        assert.equal(asFile.stdout.trim(), `${master}@%`, asFile.stderr);

        const result = run({
          MYSQL: client,
          MYSQL_ADMIN_ARGS: `-u ${env.DB_ADMIN_USER}`,
          MYSQL_HOST_ARGS: hostArgs(),
          MYSQL_TEST_LOGIN_FILE: loginFile,
        });
        assert.equal(result.status, 0, result.stderr);
        const output = fs.readFileSync(seen, 'utf8');
        assert.equal(output.includes(master), false, output);
        assert.match(output, /pages_owner/);
      } finally {
        await admin.query('DROP USER ?@?', [master, '%']);
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it('el comando documentado para subir la clave deja el archivo sin permisos para otros, con cualquier umask', () => {
      const header = fs.readFileSync(APROVISIONAR, 'utf8');
      const documented = /^# +(\(umask 077; sed .*)$/m.exec(header)?.[1];
      assert.ok(documented, 'falta el comando en la cabecera');
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-umask-'));
      try {
        const outEnv = path.join(directory, 'out.env');
        const target = path.join(directory, 'clave');
        fs.writeFileSync(outEnv, 'DB_USER=pages_app\nDB_PASSWORD=clave-de-prueba\n');
        const command = documented.replaceAll('<OUT_ENV>', `'${outEnv}'`).replaceAll('<archivo>', `'${target}'`);
        const result = spawnSync('bash', ['-c', `umask 022; ${command}`], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(target, 'utf8'), 'clave-de-prueba');
        assert.equal(fs.statSync(target).mode & 0o777, 0o600);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it('si las cuentas ya existen, falla con un mensaje claro y no cambia nada', async () => {
      const result = run({ MYSQL_ADMIN_ARGS: `-u ${env.DB_ADMIN_USER}`, MYSQL_HOST_ARGS: hostArgs() });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /pages_owner o pages_app ya existen/);
      const again = await connectApp(env);
      await again.end();
    });
  });
});

describe('crear_login.js', () => {
  const HASH_RE = /'(scrypt\$32768\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=)'/;

  function run(...args) {
    return spawnSync(process.execPath, [CREAR_LOGIN, ...args], { encoding: 'utf8' });
  }

  it('con --generar, escribe el hash del contrato y muestra la clave una vez por stderr', () => {
    const result = run('--usuario', 'demo_formato', '--cuentas', '101,102', '--generar');
    assert.equal(result.status, 0);

    const password = result.stderr.trim().split('\n').pop();
    assert.ok(password.length >= 16);
    assert.equal(result.stdout.includes(password), false, 'la clave no puede ir en el SQL');
    assert.equal(result.stderr.split(password).length, 2, 'la clave se muestra una sola vez');

    const hash = HASH_RE.exec(result.stdout)?.[1];
    assert.ok(hash, 'el hash no tiene el formato del contrato');
    const [, , , , salt, digest] = hash.split('$');
    assert.equal(Buffer.from(salt, 'base64').length, 16);
    assert.equal(Buffer.from(digest, 'base64').length, 32);
    const derived = crypto.scryptSync(password, Buffer.from(salt, 'base64'), 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    assert.ok(crypto.timingSafeEqual(derived, Buffer.from(digest, 'base64')));
  });

  it('escribe los dos INSERT en una transacción, quita cuentas repetidas y no toca allowed_account', () => {
    const { stdout } = run('--usuario', 'demo.formato@x-y', '--cuentas', '101,102,101', '--generar');
    const statements = stdout.trim().split('\n');
    assert.equal(statements.length, 5);
    assert.equal(statements[0], 'START TRANSACTION;');
    assert.match(statements[1], /^INSERT INTO connectus_pages\.login \(username, password_hash\) VALUES \('demo\.formato@x-y', '/);
    assert.equal(statements[2], 'SET @id_login = LAST_INSERT_ID();');
    assert.equal(statements[3], 'INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (@id_login, 101), (@id_login, 102);');
    assert.equal(statements[4], 'COMMIT;');
    assert.doesNotMatch(stdout, /allowed_account/);
  });

  // Node conecta a sus hijos por socket, y un shell, por FIFO: tienen que dar lo mismo.
  const pipes = {
    'un socket, como los hijos de Node': () => run('--usuario', 'demo', '--cuentas', '101'),
    'un FIFO, como un pipe del shell': () => spawnSync(
      'bash',
      ['-c', '"$0" "$@" | cat', process.execPath, CREAR_LOGIN, '--usuario', 'demo', '--cuentas', '101'],
      { encoding: 'utf8' }
    ),
  };
  for (const [name, runPiped] of Object.entries(pipes)) {
    it(`sin --generar, no pide la clave con la salida en ${name}, e indica escribir a un archivo`, () => {
      const result = runPiped();
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /umask 077; node scripts\/crear_login\.js \.\.\. > login\.sql/);
      assert.match(result.stderr, /mysql \.\.\. < login\.sql/);
      assert.match(result.stderr, /rm login\.sql/);
      assert.doesNotMatch(result.stderr, /Clave:/);
    });
  }

  it('sin --generar con la salida en un pipe, termina con error', () => {
    assert.equal(run('--usuario', 'demo', '--cuentas', '101').status, 2);
  });

  it('con --generar, el pipe sigue permitido', () => {
    const result = spawnSync(
      'bash',
      ['-c', 'set -o pipefail; "$0" "$@" | cat', process.execPath, CREAR_LOGIN, '--usuario', 'demo', '--cuentas', '101', '--generar'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^START TRANSACTION;/);
  });

  describe('con mysql -p al otro lado del pipe, en una terminal', () => {
    // A un puerto cerrado: mysql pide la clave antes de conectar, y la conexión no llega a nada.
    const CLIENT = 'mysql --no-defaults --protocol=TCP -h 127.0.0.1 -P 1 --ssl-mode=DISABLED -u nadie -p';
    const CREATE = `"${process.execPath}" "${CREAR_LOGIN}" --usuario demo --cuentas 101`;
    const TYPED = 'CLAVE-MASTER-FALSA';

    function onTerminal(command, waitFor, delay, typed) {
      const script = `${command}; echo "rc=\${PIPESTATUS[0]}"; stty -a`;
      const result = spawnSync('python3', ['-I', TERMINAL_MYSQL_P, script, waitFor, delay, typed], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    }

    // La demora pone el apagado del eco de mysql después de que Node guardó el estado de la terminal, como un wrapper del cliente.
    it('con --generar, la clave del master no se ve aunque el cliente demore en arrancar', () => {
      const screen = onTerminal(`${CREATE} --generar | (sleep 0.03; exec ${CLIENT})`, 'una sola vez:', '0.3', TYPED);
      assert.match(screen, /Enter password: /);
      assert.match(screen, /rc=0\b/);
      assert.equal(screen.includes(TYPED), false, screen);
    });

    it('al rechazar el pipe sin --generar, la clave del master tampoco se ve', () => {
      const screen = onTerminal(`${CREATE} | (sleep 0.03; exec ${CLIENT})`, 'umask 077', '0.3', TYPED);
      assert.match(screen, /rc=2\b/);
      assert.equal(screen.includes(TYPED), false, screen);
    });

    // Al revés: Node guarda el estado con el eco ya apagado, y mysql termina antes que él.
    it('con --generar, la terminal no queda sin eco si mysql termina primero', () => {
      const screen = onTerminal(`(sleep 0.03; exec ${CREATE} --generar) | ${CLIENT}`, 'Enter password: ', '0.08', '');
      assert.match(screen, /\becho\b/);
      assert.doesNotMatch(screen, /(?:^|\s)-echo(?:\s|;|$)/m);
      assert.doesNotMatch(screen, /rc=134\b/, 'node no debe abortar');
    });
  });

  it('el comando documentado para escribir el SQL deja el archivo sin permisos para otros, con cualquier umask', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-login-sql-'));
    const target = path.join(directory, 'login.sql');
    try {
      const command = `umask 022; (umask 077; "$0" "$@" > '${target}')`;
      const result = spawnSync('bash', ['-c', command, process.execPath, CREAR_LOGIN, '--usuario', 'demo', '--cuentas', '101', '--generar'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(target, 'utf8'), /^START TRANSACTION;/);
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const invalid = {
    'usuario con comillas': ['--usuario', "a' OR '1'='1", '--cuentas', '101', '--generar'],
    'usuario vacío': ['--usuario', '', '--cuentas', '101', '--generar'],
    'usuario de más de 64': ['--usuario', 'a'.repeat(65), '--cuentas', '101', '--generar'],
    'sin usuario': ['--cuentas', '101', '--generar'],
    'sin cuentas': ['--usuario', 'demo', '--generar'],
    'cuenta con texto': ['--usuario', 'demo', '--cuentas', '101,x', '--generar'],
    'cuenta cero': ['--usuario', 'demo', '--cuentas', '0', '--generar'],
    'cuenta negativa': ['--usuario', 'demo', '--cuentas', '-1', '--generar'],
    'cuenta fuera de INT': ['--usuario', 'demo', '--cuentas', '2147483648', '--generar'],
    'cuenta con inyección': ['--usuario', 'demo', '--cuentas', '101);DROP TABLE login;--', '--generar'],
    'lista con hueco': ['--usuario', 'demo', '--cuentas', '101,,102', '--generar'],
    'clave por argumento': ['--usuario', 'demo', '--cuentas', '101', '--clave', 'una-clave-que-no-va'],
    'clave como posicional': ['--usuario', 'demo', '--cuentas', '101', '--generar', 'una-clave-que-no-va'],
  };
  for (const [name, args] of Object.entries(invalid)) {
    it(`rechaza: ${name}`, () => {
      const result = run(...args);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.includes('una-clave-que-no-va'), false);
    });
  }
});
