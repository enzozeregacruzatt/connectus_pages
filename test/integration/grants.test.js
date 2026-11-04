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
  'WORKER_DB_USER',
  'WORKER_DB_PASSWORD',
  'LOGIN_DEMO_PASSWORD',
];

const SOURCE_TABLES = [
  'account',
  'contact_list',
  'delivery',
  'short_link',
  'short_link_delivery',
  'short_link_sms_outgoings',
  'sms_incoming',
  'sms_outgoing',
];

// Lista cerrada: una vista o columna nueva tiene que pasar por aquí.
const VIEW_COLUMNS = {
  account: ['id', 'name'],
  delivery: ['id', 'id_unique', 'id_account', 'id_product', 'delivery_type', 'name', 'deliver_at', 'created_at'],
  delivery_datos: [
    'id', 'id_unique', 'id_account', 'id_product', 'delivery_type', 'name', 'deliver_at', 'created_at', 'status', 'error_status',
    'has_base', 'contact_list_name', 'number_of_contacts',
  ],
  incoming_ids_de_envio: ['id', 'id_delivery'],
  link_de_envio: ['id_delivery', 'id_account', 'id_unique', 'clicks'],
  link_de_sms: ['id_delivery', 'id_sms', 'id_short_link', 'clicks'],
  sms: [
    'id', 'id_unique', 'id_account', 'id_delivery', 'status', 'src_number', 'dst_number', 'sms_content', 'multiplier', 'created_at',
    'updated_at', 'dst_provider', 'dst_country',
  ],
  sms_de_cuenta: [
    'id', 'id_unique', 'id_account', 'id_delivery', 'src_number', 'dst_number', 'sms_content', 'status', 'dst_provider', 'created_at',
  ],
  sms_de_envio: [
    'id', 'id_unique', 'id_account', 'id_delivery', 'src_number', 'dst_number', 'sms_content', 'multiplier', 'status', 'dst_provider',
    'dst_country', 'created_at', 'updated_at',
  ],
  sms_de_numero: [
    'id', 'id_unique', 'id_account', 'id_delivery', 'src_number', 'dst_number', 'sms_content', 'status', 'dst_provider', 'dst_country',
    'created_at', 'updated_at',
  ],
  sms_ids_de_envio: ['id', 'id_delivery'],
  sms_incoming_de_envio: ['id', 'id_unique', 'id_account', 'id_delivery', 'src_number', 'dst_number', 'sms_content', 'created_at'],
};

const FORCED_INDEX = {
  link_de_envio: 'id_delivery__idx',
  sms_de_cuenta: 'id_account__idx',
  sms_de_envio: 'id_delivery__idx',
  sms_de_numero: 'dst_number_idx',
  sms_incoming_de_envio: 'index_sms_incoming_on_id_delivery',
};

const ER_ACCESS_DENIED = 1045;
const ER_DB_ACCESS_DENIED = 1044;
const ER_TABLE_DENIED = 1142;
const ER_COLUMN_DENIED = 1143;
const ER_PROC_DENIED = 1370;
const ER_BAD_FIELD = 1054;
const ER_KEY_DOES_NOT_EXITS = 1176;
const ER_CANT_AGGREGATE_2COLLATIONS = 1267;
const ER_CANNOT_CONVERT_STRING = 3854;
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

function connectWorker(env) {
  return connect(env, { user: env.WORKER_DB_USER, password: env.WORKER_DB_PASSWORD, ssl: tlsOptions(env) });
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

// SHOW GRANTS cambia el orden de líneas, privilegios y columnas, y las comillas, según la versión del servidor.
function normalizeGrants(rows) {
  const sortColumns = (text) => text.replace(/\(([^)]*)\)/, (_, cols) => `(${cols.split(',').map((c) => c.trim()).sort().join(', ')})`);
  return rows
    .map((row) => Object.values(row)[0].replace(/[`']/g, ''))
    .map((line) => {
      const [, privileges, target] = /^GRANT (.*?) ON (.*)$/.exec(line);
      const sorted = privileges.split(/,\s*(?![^(]*\))/).map(sortColumns).sort().join(', ');
      return `GRANT ${sorted} ON ${target}`;
    })
    .sort();
}

function contractQuery({ dst, cursor, upperBound = true } = {}) {
  let where = `id_account = ? AND id > ?${upperBound ? ' AND id <= ?' : ''} AND created_at BETWEEN ? AND ?`;
  if (dst !== undefined) where += ' AND dst_number = ?';
  if (cursor !== undefined) where += ' AND id < ?';
  const view = dst === undefined ? 'sms_de_cuenta' : 'sms_de_numero';
  return `SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_delivery, dst_number, sms_content, status, created_at
    FROM connectus_pages.${view} WHERE ${where} ORDER BY id DESC LIMIT 51`;
}

describe('base de datos', () => {
  let env;
  let app;
  let worker;
  let admin;

  before(async () => {
    env = loadEnv();
    app = await connectApp(env);
    worker = await connectWorker(env);
    admin = await connectAdmin(env);
  });

  after(async () => {
    if (app) await app.end();
    if (worker) await worker.end();
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
    for (const table of SOURCE_TABLES) {
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

    for (const table of ['allowed_account', 'audit_log', 'sms_incoming_de_envio']) {
      it(`no puede leer ${table}`, async () => {
        await assertFails(() => app.query(`SELECT * FROM connectus_pages.${table} LIMIT 1`), [ER_TABLE_DENIED]);
      });
    }

    for (const column of ['password_hash', 'active', 'username', 'token_version', 'link_version']) {
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
      'DELETE en delivery_stats': 'DELETE FROM connectus_pages.delivery_stats WHERE id_delivery = 0',
      'UPDATE en export_job': "UPDATE connectus_pages.export_job SET state = 'failed' WHERE id = 0",
      'DELETE en export_job': 'DELETE FROM connectus_pages.export_job WHERE id = 0',
      'INSERT en export_job de una columna de estado': `INSERT INTO connectus_pages.export_job
        (public_id, id_login, id_account, kind, created_at, state)
        VALUES (REPEAT('0', 32), 1, 101, 'sms_csv', UTC_TIMESTAMP(), 'finished')`,
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

    it('no puede llamar a purge_audit_log', async () => {
      await assertFails(() => app.query('CALL connectus_pages.purge_audit_log()'), [ER_PROC_DENIED]);
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
          'GRANT INSERT (created_at, delivery_name, dst_number, end_date, id_account, id_delivery, id_login, kind, public_id, start_date), SELECT ON connectus_pages.export_job TO pages_app@%',
          'GRANT INSERT ON connectus_pages.audit_log TO pages_app@%',
          'GRANT INSERT, SELECT, UPDATE ON connectus_pages.delivery_stats TO pages_app@%',
          'GRANT SELECT ON connectus_pages.account TO pages_app@%',
          'GRANT SELECT ON connectus_pages.delivery TO pages_app@%',
          'GRANT SELECT ON connectus_pages.delivery_datos TO pages_app@%',
          'GRANT SELECT ON connectus_pages.incoming_ids_de_envio TO pages_app@%',
          'GRANT SELECT ON connectus_pages.link_de_envio TO pages_app@%',
          'GRANT SELECT ON connectus_pages.link_de_sms TO pages_app@%',
          'GRANT SELECT ON connectus_pages.login_account TO pages_app@%',
          'GRANT SELECT ON connectus_pages.sms TO pages_app@%',
          'GRANT SELECT ON connectus_pages.sms_de_cuenta TO pages_app@%',
          'GRANT SELECT ON connectus_pages.sms_de_envio TO pages_app@%',
          'GRANT SELECT ON connectus_pages.sms_de_numero TO pages_app@%',
          'GRANT SELECT ON connectus_pages.sms_ids_de_envio TO pages_app@%',
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

  describe('pages_worker no sale de lo permitido', () => {
    for (const table of SOURCE_TABLES) {
      it(`no puede leer dbconnectus.${table}`, async () => {
        await assertFails(() => worker.query(`SELECT * FROM dbconnectus.${table} LIMIT 1`), [ER_TABLE_DENIED]);
      });
    }

    for (const table of [
      'login',
      'login_account',
      'allowed_account',
      'audit_log',
      'sms_ids_de_envio',
      'sms',
      'delivery_datos',
      'incoming_ids_de_envio',
      'link_de_envio',
      'link_de_sms',
    ]) {
      it(`no puede leer ${table}`, async () => {
        await assertFails(() => worker.query(`SELECT * FROM connectus_pages.${table} LIMIT 1`), [ER_TABLE_DENIED]);
      });
    }

    it('de delivery_stats solo lee las columnas para borrar', async () => {
      await worker.query('SELECT id_delivery, updated_at FROM connectus_pages.delivery_stats LIMIT 1');
      for (const column of ['counts', 'id_account', 'clicks_sum']) {
        await assertFails(() => worker.query(`SELECT ${column} FROM connectus_pages.delivery_stats LIMIT 1`), [ER_COLUMN_DENIED]);
      }
    });

    const denied = {
      'INSERT en delivery_stats': `INSERT INTO connectus_pages.delivery_stats (id_delivery, id_account, next_step_at, updated_at)
        VALUES (0, 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP())`,
      'UPDATE en delivery_stats': 'UPDATE connectus_pages.delivery_stats SET updated_at = UTC_TIMESTAMP() WHERE id_delivery = 0',
      'INSERT en export_job': `INSERT INTO connectus_pages.export_job (public_id, id_login, id_account, kind, created_at)
        VALUES (REPEAT('0', 32), 1, 101, 'sms_csv', UTC_TIMESTAMP())`,
      'DELETE en audit_log': 'DELETE FROM connectus_pages.audit_log WHERE id = 0',
      'UPDATE en audit_log': "UPDATE connectus_pages.audit_log SET detail = 'x' WHERE id = 0",
      'UPDATE en login': 'UPDATE connectus_pages.login SET failed_attempts = 0 WHERE id = 0',
      'CREATE TABLE': 'CREATE TABLE connectus_pages.grants_prueba (id INT)',
      'DROP de una vista': 'DROP VIEW connectus_pages.sms_de_cuenta',
    };
    for (const [name, sql] of Object.entries(denied)) {
      it(`rechaza ${name}`, async () => {
        await assertFails(() => worker.query(sql), [ER_TABLE_DENIED, ER_COLUMN_DENIED]);
      });
    }

    it('rechaza una conexión sin TLS', async () => {
      await assertFails(
        () => connect(env, { user: env.WORKER_DB_USER, password: env.WORKER_DB_PASSWORD, ssl: undefined }),
        [ER_ACCESS_DENIED],
      );
    });

    it('tiene exactamente los permisos del contrato', async () => {
      const [rows] = await admin.query("SHOW GRANTS FOR 'pages_worker'@'%'");
      assert.deepEqual(
        normalizeGrants(rows),
        [
          'GRANT DELETE, SELECT (id_delivery, updated_at) ON connectus_pages.delivery_stats TO pages_worker@%',
          'GRANT DELETE, SELECT, UPDATE ON connectus_pages.export_job TO pages_worker@%',
          'GRANT EXECUTE ON FUNCTION connectus_pages.sms_cutoff_id TO pages_worker@%',
          'GRANT EXECUTE ON PROCEDURE connectus_pages.purge_audit_log TO pages_worker@%',
          'GRANT INSERT ON connectus_pages.audit_log TO pages_worker@%',
          'GRANT SELECT ON connectus_pages.account TO pages_worker@%',
          'GRANT SELECT ON connectus_pages.delivery TO pages_worker@%',
          'GRANT SELECT ON connectus_pages.sms_de_cuenta TO pages_worker@%',
          'GRANT SELECT ON connectus_pages.sms_de_envio TO pages_worker@%',
          'GRANT SELECT ON connectus_pages.sms_de_numero TO pages_worker@%',
          'GRANT SELECT ON connectus_pages.sms_incoming_de_envio TO pages_worker@%',
          'GRANT USAGE ON *.* TO pages_worker@%',
        ].sort(),
      );
    });

    it('tiene TLS obligatorio y el tope de conexiones del contrato', async () => {
      const [[row]] = await admin.query(
        `SELECT ssl_type, max_questions, max_connections, max_user_connections, account_locked
         FROM mysql.user WHERE user = 'pages_worker' AND host = '%'`,
      );
      assert.deepEqual(
        { ...row },
        { ssl_type: 'ANY', max_questions: 0, max_connections: 0, max_user_connections: 2, account_locked: 'N' },
      );
    });
  });

  describe('lo que pages_worker sí puede hacer', () => {
    it('lee las vistas de exportación, y la función de corte', async () => {
      for (const view of ['account', 'delivery', 'sms_de_cuenta', 'sms_de_numero', 'sms_de_envio', 'sms_incoming_de_envio']) {
        const [rows] = await worker.query(`SELECT id FROM connectus_pages.${view} LIMIT 1`);
        assert.equal(rows.length, 1, view);
      }
      const [[{ cutoff }]] = await worker.query('SELECT connectus_pages.sms_cutoff_id(?) AS cutoff', [RANGE_START]);
      assert.match(cutoff, /^[1-9][0-9]*$/);
    });

    it('lee, cambia y borra un job, y no puede crearlo', async () => {
      const publicId = crypto.randomBytes(16).toString('hex');
      await app.query(
        `INSERT INTO connectus_pages.export_job (public_id, id_login, id_account, kind, created_at)
         VALUES (?, 1, 101, 'sms_csv', UTC_TIMESTAMP())`,
        [publicId],
      );
      try {
        const [[job]] = await worker.query('SELECT id, state FROM connectus_pages.export_job WHERE public_id = ?', [publicId]);
        assert.equal(job.state, 'new');
        await worker.query("UPDATE connectus_pages.export_job SET state = 'processing', stalls = stalls + 1 WHERE id = ?", [job.id]);
        const [[updated]] = await worker.query('SELECT state, stalls FROM connectus_pages.export_job WHERE id = ?', [job.id]);
        assert.deepEqual({ ...updated }, { state: 'processing', stalls: 1 });
        const [deleted] = await worker.query('DELETE FROM connectus_pages.export_job WHERE id = ?', [job.id]);
        assert.equal(deleted.affectedRows, 1);
      } finally {
        await admin.query('DELETE FROM connectus_pages.export_job WHERE public_id = ?', [publicId]);
      }
    });

    it('borra fotos viejas de delivery_stats con solo sus dos columnas', async () => {
      const id = 900001;
      await admin.query(
        `INSERT INTO connectus_pages.delivery_stats (id_delivery, id_account, next_step_at, updated_at)
         VALUES (?, 101, UTC_TIMESTAMP(3), UTC_TIMESTAMP() - INTERVAL 40 DAY), (?, 101, UTC_TIMESTAMP(3), UTC_TIMESTAMP())`,
        [id, id + 1],
      );
      try {
        const [deleted] = await worker.query(
          'DELETE FROM connectus_pages.delivery_stats WHERE id_delivery IN (?) AND updated_at < UTC_TIMESTAMP() - INTERVAL 30 DAY LIMIT 200',
          [[id, id + 1]],
        );
        assert.equal(deleted.affectedRows, 1);
        const [left] = await admin.query('SELECT id_delivery FROM connectus_pages.delivery_stats WHERE id_delivery IN (?)', [[id, id + 1]]);
        assert.deepEqual(left.map((row) => row.id_delivery), [id + 1]);
      } finally {
        await admin.query('DELETE FROM connectus_pages.delivery_stats WHERE id_delivery IN (?)', [[id, id + 1]]);
      }
    });

    it('inserta en audit_log aunque no pueda leerlo', async () => {
      const [result] = await worker.query("INSERT INTO connectus_pages.audit_log (action, detail) VALUES ('grants_worker', 'sin_numero')");
      await admin.query('DELETE FROM connectus_pages.audit_log WHERE id = ?', [result.insertId]);
    });

    it('purge_audit_log borra hasta 1000 filas de más de 1 año, primero las más viejas', async () => {
      const action = `purga_${crypto.randomBytes(4).toString('hex')}`;
      const rows = Array.from({ length: 1003 }, (_, index) => [action, String(index)]);
      await admin.query('INSERT INTO connectus_pages.audit_log (action, detail) VALUES ?', [rows]);
      await admin.query(
        'UPDATE connectus_pages.audit_log SET created_at = UTC_TIMESTAMP() - INTERVAL 400 DAY + INTERVAL detail MINUTE WHERE action = ?',
        [action],
      );
      await admin.query(
        "INSERT INTO connectus_pages.audit_log (action, detail, created_at) VALUES (?, 'reciente', UTC_TIMESTAMP() - INTERVAL 360 DAY)",
        [action],
      );
      try {
        await worker.query('CALL connectus_pages.purge_audit_log()');
        const [left] = await admin.query('SELECT detail FROM connectus_pages.audit_log WHERE action = ? ORDER BY created_at', [action]);
        assert.deepEqual(left.map((row) => row.detail), ['1000', '1001', '1002', 'reciente']);
        await worker.query('CALL connectus_pages.purge_audit_log()');
        const [again] = await admin.query('SELECT detail FROM connectus_pages.audit_log WHERE action = ?', [action]);
        assert.deepEqual(again.map((row) => row.detail), ['reciente'], 'lo que tiene menos de 1 año se queda');
      } finally {
        await admin.query('DELETE FROM connectus_pages.audit_log WHERE action = ?', [action]);
      }
    });

    it('purge_audit_log es SECURITY DEFINER y de pages_owner', async () => {
      const [[row]] = await admin.query(
        `SELECT routine_type AS type, sql_data_access AS access, security_type AS security, definer AS definer
         FROM information_schema.routines WHERE routine_schema = 'connectus_pages' AND routine_name = 'purge_audit_log'`,
      );
      assert.deepEqual({ ...row }, { type: 'PROCEDURE', access: 'MODIFIES SQL DATA', security: 'DEFINER', definer: 'pages_owner@%' });
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
        const [[{ link_version: linkVersion }]] = await app.query('SELECT link_version FROM connectus_pages.login WHERE id = ?', [id]);
        assert.equal(linkVersion, 0, 'el trigger no toca la versión del enlace');
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

    it('crea y lee un job con las columnas del contrato, que parte en new', async () => {
      const publicId = crypto.randomBytes(16).toString('hex');
      await app.query(
        `INSERT INTO connectus_pages.export_job
           (public_id, id_login, id_account, kind, id_delivery, delivery_name, start_date, end_date, dst_number, created_at)
         VALUES (?, 1, 101, 'delivery_xlsx', 1, 'Nombre', '2026-10-01', '2026-10-15', 56900000001, UTC_TIMESTAMP())`,
        [publicId],
      );
      try {
        const [[job]] = await app.query('SELECT state, last_id, dst_number, next_part FROM connectus_pages.export_job WHERE public_id = ?', [publicId]);
        assert.deepEqual({ ...job }, { state: 'new', last_id: '0', dst_number: '56900000001', next_part: 1 });
      } finally {
        await admin.query('DELETE FROM connectus_pages.export_job WHERE public_id = ?', [publicId]);
      }
    });

    it('crea, lee y avanza una foto en delivery_stats', async () => {
      const id = 900011;
      await app.query(
        `INSERT IGNORE INTO connectus_pages.delivery_stats (id_delivery, id_account, next_step_at, updated_at)
         VALUES (?, 101, UTC_TIMESTAMP(3), UTC_TIMESTAMP())`,
        [id],
      );
      try {
        await app.query(
          "UPDATE connectus_pages.delivery_stats SET work_phase = 'counts', work_rows = work_rows + 5, updated_at = UTC_TIMESTAMP() WHERE id_delivery = ?",
          [id],
        );
        const [[row]] = await app.query('SELECT work_phase, work_rows, counts FROM connectus_pages.delivery_stats WHERE id_delivery = ?', [id]);
        assert.deepEqual({ ...row }, { work_phase: 'counts', work_rows: 5, counts: null });
      } finally {
        await admin.query('DELETE FROM connectus_pages.delivery_stats WHERE id_delivery = ?', [id]);
      }
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
    it('el fixture público solo trae las columnas que usan las vistas', async () => {
      const [rows] = await admin.query(
        "SELECT CONCAT(table_name, '.', column_name) AS col FROM information_schema.columns WHERE table_schema = 'dbconnectus'",
      );
      const columns = {
        account: ['id', 'name'],
        contact_list: ['id', 'id_account', 'name', 'number_of_contacts'],
        delivery: [
          'id', 'id_unique', 'id_account', 'delivery_type', 'name', 'deliver_at', 'created_at', 'id_product', 'id_contact_list', 'status',
          'error_status',
        ],
        short_link: ['id', 'id_unique', 'clicks'],
        short_link_delivery: ['id', 'id_account', 'id_short_link', 'id_delivery'],
        short_link_sms_outgoings: ['id', 'id_sms_outgoing', 'id_short_link'],
        sms_incoming: ['id', 'id_unique', 'id_account', 'id_delivery', 'src_number', 'dst_number', 'sms_content', 'created_at'],
        sms_outgoing: [
          'id', 'id_unique', 'id_account', 'id_delivery', 'status', 'src_number', 'dst_number', 'sms_content', 'multiplier', 'created_at',
          'updated_at', 'dst_provider', 'dst_country',
        ],
      };
      assert.deepEqual(
        rows.map((row) => row.col).sort(),
        Object.entries(columns)
          .flatMap(([table, names]) => [...names, 'columna_fuera_del_contrato'].map((column) => `${table}.${column}`))
          .sort(),
      );
    });

    it('el fixture público solo trae los índices que usan las vistas, más sum_multiplier_idx', async () => {
      const [rows] = await admin.query(
        `SELECT table_name AS t, index_name AS i, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS c
         FROM information_schema.statistics WHERE table_schema = 'dbconnectus' GROUP BY table_name, index_name`,
      );
      assert.deepEqual(
        rows.filter((row) => row.i !== 'PRIMARY').map((row) => `${row.t}.${row.i}(${row.c})`).sort(),
        [
          'delivery.delivery_account_created_idx(id_account,created_at)',
          'delivery.id_account__idx(id_account)',
          'delivery.id_unique(id_unique)',
          'short_link_delivery.id_delivery__idx(id_delivery)',
          'short_link_sms_outgoings.index_short_link_sms_outgoings_on_id_sms_outgoing(id_sms_outgoing)',
          'sms_incoming.index_sms_incoming_on_id_delivery(id_delivery)',
          'sms_outgoing.created_at_idx(created_at)',
          'sms_outgoing.dst_number_idx(dst_number)',
          'sms_outgoing.id_account__idx(id_account)',
          'sms_outgoing.id_delivery__idx(id_delivery)',
          'sms_outgoing.id_unique(id_unique)',
          'sms_outgoing.sum_multiplier_idx(created_at,multiplier)',
        ],
      );
    });

    it('el esquema solo trae los objetos del contrato', async () => {
      const [tables] = await admin.query(
        "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = 'connectus_pages'",
      );
      assert.deepEqual(
        tables.filter((row) => row.type === 'BASE TABLE').map((row) => row.name).sort(),
        ['allowed_account', 'audit_log', 'delivery_stats', 'export_job', 'login', 'login_account'],
      );
      assert.deepEqual(tables.filter((row) => row.type === 'VIEW').map((row) => row.name).sort(), Object.keys(VIEW_COLUMNS).sort());
      const [routines] = await admin.query(
        "SELECT routine_name AS name, routine_type AS type FROM information_schema.routines WHERE routine_schema = 'connectus_pages'",
      );
      assert.deepEqual(routines.map((row) => `${row.type} ${row.name}`).sort(), ['FUNCTION sms_cutoff_id', 'PROCEDURE purge_audit_log']);
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
        'SELECT id FROM connectus_pages.sms_de_cuenta WHERE id_account = 999',
        'SELECT id FROM connectus_pages.sms_de_numero WHERE dst_number = 56900000999',
        'SELECT id FROM connectus_pages.sms_de_envio WHERE id_delivery = 6',
        'SELECT id FROM connectus_pages.sms_ids_de_envio WHERE id_delivery = 6',
        'SELECT id FROM connectus_pages.delivery_datos WHERE id = 6',
        'SELECT id FROM connectus_pages.incoming_ids_de_envio WHERE id_delivery = 6',
        'SELECT clicks FROM connectus_pages.link_de_envio WHERE id_delivery = 6',
        'SELECT id_sms FROM connectus_pages.link_de_sms WHERE id_delivery = 6',
      ];
      for (const sql of queries) {
        const [rows] = await app.query(sql);
        assert.equal(rows.length, 0, sql);
      }
      const [incoming] = await worker.query('SELECT id FROM connectus_pages.sms_incoming_de_envio WHERE id_account = 999');
      assert.equal(incoming.length, 0);
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
      for (const view of Object.keys(VIEW_COLUMNS)) {
        await assertFails(
          () => admin.query(`SELECT columna_fuera_del_contrato FROM connectus_pages.${view} LIMIT 1`),
          [ER_BAD_FIELD],
        );
      }
      const [columns] = await admin.query(
        `SELECT table_name AS t, column_name AS c FROM information_schema.columns
         WHERE table_schema = 'connectus_pages' AND table_name IN (?)
         ORDER BY table_name, ordinal_position`,
        [Object.keys(VIEW_COLUMNS)],
      );
      const byTable = {};
      for (const { t, c } of columns) (byTable[t] ||= []).push(c);
      assert.deepEqual(byTable, VIEW_COLUMNS);
    });

    for (const view of Object.keys(VIEW_COLUMNS)) {
      it(`${view} es MERGE, SECURITY DEFINER y de pages_owner`, async () => {
        const [[row]] = await admin.query(`SHOW CREATE VIEW connectus_pages.${view}`);
        const definition = row['Create View'];
        assert.match(definition, /ALGORITHM=MERGE/);
        assert.match(definition, /DEFINER=`pages_owner`@`%`/);
        assert.match(definition, /SQL SECURITY DEFINER/);
        const forced = FORCED_INDEX[view];
        const shown = definition.replaceAll('`', '').match(/FORCE INDEX \(([^)]*)\)/)?.[1];
        assert.equal(shown, forced, 'el índice fijado en la vista');
      });
    }

    it('los nombres de envío se traen por cuenta', async () => {
      const [rows] = await app.query('SELECT id, id_unique, name, id_product FROM connectus_pages.delivery WHERE id IN (?) AND id_account = ?', [
        [1, 7],
        101,
      ]);
      assert.deepEqual(rows.map((row) => row.id), [1]);
      assert.match(rows[0].id_unique, /^[0-9a-f]{32}$/);
      assert.strictEqual(rows[0].id_product, 1);
    });

    it('un carácter de 4 bytes contra una columna utf8mb3 falla con un código que la app clasifica', async () => {
      await assertFails(
        () => app.query("SELECT id FROM connectus_pages.delivery WHERE id_account = 101 AND name LIKE ? ESCAPE '!' LIMIT 1", ['%😀%']),
        [ER_CANT_AGGREGATE_2COLLATIONS, ER_CANNOT_CONVERT_STRING],
      );
    });

    it('un índice que ya no existe falla con un código que la app clasifica', async () => {
      await assertFails(() => admin.query('SELECT id FROM dbconnectus.sms_outgoing FORCE INDEX (no_existe) LIMIT 1'), [ER_KEY_DOES_NOT_EXITS]);
    });

    // La cuenta sale de la fila donde se devuelven datos, y del envío donde solo se cuenta. Ver sql/01_esquema.sql.
    describe('una fila con el envío de una cuenta y el id_account de otra', () => {
      it('no aparece entre los datos del envío con la cuenta del envío', async () => {
        const [rows] = await app.query('SELECT id FROM connectus_pages.sms_de_envio WHERE id_delivery = 1 AND id_account = 101 AND id IN (9011, 9012)');
        assert.equal(rows.length, 0);
      });

      it('nunca se muestra con la cuenta prohibida, y sí con su cuenta si está permitida', async () => {
        const [rows] = await app.query('SELECT id, id_account FROM connectus_pages.sms_de_envio WHERE id_delivery = 1 AND id IN (9011, 9012)');
        assert.deepEqual(rows.map((row) => [row.id, row.id_account]), [[9011, 102]]);
      });

      it('entra en el conteo, que es por envío', async () => {
        const [rows] = await app.query('SELECT id FROM connectus_pages.sms_ids_de_envio WHERE id_delivery = 1 AND id IN (9011, 9012) ORDER BY id');
        assert.deepEqual(rows.map((row) => row.id), [9011, 9012]);
      });

      it('la respuesta de la 999 cuenta para el envío, pero el trabajador no la lee', async () => {
        const [counted] = await app.query('SELECT id FROM connectus_pages.incoming_ids_de_envio WHERE id_delivery = 1 AND id = 5007');
        assert.equal(counted.length, 1);
        const [read] = await worker.query('SELECT id FROM connectus_pages.sms_incoming_de_envio WHERE id_delivery = 1 AND id = 5007');
        assert.equal(read.length, 0);
      });
    });

    describe('delivery_datos', () => {
      async function datos(id) {
        const [[row]] = await app.query(
          'SELECT status, error_status, has_base, contact_list_name, number_of_contacts FROM connectus_pages.delivery_datos WHERE id = ?',
          [id],
        );
        return { ...row, has_base: Number(row.has_base) };
      }

      it('muestra el motivo de negocio de un fallo y oculta el texto de una excepción', async () => {
        assert.equal((await datos(10)).error_status, 'No hay saldo suficiente para el envío');
        const exception = await datos(11);
        assert.equal(exception.status, 'failed');
        assert.equal(exception.error_status, null);
      });

      it('has_base distingue una base sin nombre de un envío sin base, y de una base de otra cuenta', async () => {
        assert.deepEqual(await datos(9), {
          status: 'processing',
          error_status: null,
          has_base: 1,
          contact_list_name: 'Base del envío en curso',
          number_of_contacts: 100,
        });
        const withoutName = await datos(18);
        assert.deepEqual([withoutName.has_base, withoutName.contact_list_name, withoutName.number_of_contacts], [1, null, null]);
        assert.equal((await datos(17)).has_base, 0);
        const otherAccount = await datos(19);
        assert.deepEqual([otherAccount.has_base, otherAccount.contact_list_name], [0, null]);
      });

      it('tolera nulos y fechas en cero', async () => {
        const [rows] = await app.query('SELECT id, deliver_at, created_at, status FROM connectus_pages.delivery_datos WHERE id IN (13, 14, 15, 16) ORDER BY id');
        assert.equal(rows[0].deliver_at, null);
        assert.equal(rows[1].created_at, null);
        assert.equal(rows[2].created_at, '0000-00-00 00:00:00');
        assert.equal(rows[3].status, null);
      });
    });

    describe('links', () => {
      it('link_de_envio devuelve el link del envío', async () => {
        const [rows] = await app.query('SELECT id_unique, clicks FROM connectus_pages.link_de_envio WHERE id_delivery = 8 AND id_account = 101 LIMIT 1');
        assert.deepEqual(rows.map((row) => ({ ...row })), [{ id_unique: 'lnkuno1', clicks: 42 }]);
      });

      it('link_de_sms suma los links de cada SMS del envío, sin las filas ajenas', async () => {
        const [[row]] = await app.query(
          'SELECT COUNT(DISTINCT id_short_link) AS links, COALESCE(SUM(clicks), 0) AS clics FROM connectus_pages.link_de_sms WHERE id_delivery = 3',
        );
        const [[expected]] = await admin.query(
          'SELECT COUNT(*) AS links, SUM(id % 5) AS clics FROM dbconnectus.sms_outgoing WHERE id_delivery = 3',
        );
        assert.deepEqual({ ...row }, { ...expected });
      });

      it('un envío de link único no tiene links por SMS', async () => {
        const [rows] = await app.query('SELECT id_sms FROM connectus_pages.link_de_sms WHERE id_delivery = 8');
        assert.equal(rows.length, 0);
      });
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
  });

  describe('pages_owner', () => {
    it('tiene exactamente los permisos del contrato', async () => {
      const [rows] = await admin.query("SHOW GRANTS FOR 'pages_owner'@'%'");
      assert.deepEqual(
        normalizeGrants(rows),
        [
          'GRANT ALL PRIVILEGES ON connectus_pages.* TO pages_owner@% WITH GRANT OPTION',
          'GRANT SELECT (clicks, id, id_unique) ON dbconnectus.short_link TO pages_owner@%',
          'GRANT SELECT (created_at, deliver_at, delivery_type, error_status, id, id_account, id_contact_list, id_product, id_unique, name, status) ON dbconnectus.delivery TO pages_owner@%',
          'GRANT SELECT (created_at, dst_country, dst_number, dst_provider, id, id_account, id_delivery, id_unique, multiplier, sms_content, src_number, status, updated_at) ON dbconnectus.sms_outgoing TO pages_owner@%',
          'GRANT SELECT (created_at, dst_number, id, id_account, id_delivery, id_unique, sms_content, src_number) ON dbconnectus.sms_incoming TO pages_owner@%',
          'GRANT SELECT (id, id_account, name, number_of_contacts) ON dbconnectus.contact_list TO pages_owner@%',
          'GRANT SELECT (id, name) ON dbconnectus.account TO pages_owner@%',
          'GRANT SELECT (id_account, id_delivery, id_short_link) ON dbconnectus.short_link_delivery TO pages_owner@%',
          'GRANT SELECT (id_short_link, id_sms_outgoing) ON dbconnectus.short_link_sms_outgoings TO pages_owner@%',
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
      const [byAccount] = await app.query('SELECT id FROM connectus_pages.sms_de_cuenta WHERE id_account = 101 LIMIT 1');
      assert.equal(byAccount.length, 1);
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

    it('corre cada archivo con su cuenta y en orden, y deja las claves solo en OUT_ENV', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-pasos-'));
      const client = path.join(directory, 'mysql');
      const steps = path.join(directory, 'pasos');
      const outEnv = path.join(directory, 'cuentas.env');
      const separator = '--paso--';
      fs.writeFileSync(
        client,
        `#!/bin/sh\ncase "$1" in\n  --defaults-file=*) who=owner ;;\n  *) who=master ;;\nesac\n`
          + `{ echo "${separator} $who"; cat; } >> '${steps}'\n`,
        { mode: 0o755 },
      );
      try {
        const result = run({ MYSQL: client, MYSQL_ADMIN_ARGS: '-u master', MYSQL_HOST_ARGS: SECURE_HOST, OUT_ENV: outEnv });
        assert.equal(result.status, 0, result.stderr);

        const executed = fs.readFileSync(steps, 'utf8').split(`${separator} `).slice(1);
        assert.deepEqual(executed.map((step) => step.split('\n', 1)[0]), ['master', 'owner', 'owner', 'owner', 'master']);
        const sqlFile = (name) => fs.readFileSync(path.join(ROOT, 'sql', name), 'utf8');
        const body = (step) => step.slice(step.indexOf('\n') + 1);
        assert.equal(body(executed[1]), sqlFile('01_esquema.sql'));
        assert.equal(body(executed[2]), sqlFile('02_permisos_app.sql'));
        assert.equal(body(executed[3]), sqlFile('02_permisos_worker.sql'));
        assert.equal(body(executed[4]), sqlFile('03_bloquear_owner.sql'));

        assert.equal(fs.statSync(outEnv).mode & 0o777, 0o600);
        const saved = /^DB_USER=pages_app\nDB_PASSWORD=([0-9a-f]{48})\nWORKER_DB_USER=pages_worker\nWORKER_DB_PASSWORD=([0-9a-f]{48})\n$/
          .exec(fs.readFileSync(outEnv, 'utf8'));
        assert.ok(saved, 'OUT_ENV no tiene la forma esperada');
        const [, appPassword, workerPassword] = saved;
        assert.notEqual(appPassword, workerPassword);

        const accounts = body(executed[0]);
        assert.ok(accounts.includes(`'pages_app'@'%' IDENTIFIED BY '${appPassword}'`));
        assert.ok(accounts.includes(`'pages_worker'@'%' IDENTIFIED BY '${workerPassword}'`));
        assert.doesNotMatch(accounts, /__PW_/);
        assert.equal(result.stderr.includes(appPassword) || result.stderr.includes(workerPassword), false);
        assert.equal(result.stdout.includes(appPassword) || result.stdout.includes(workerPassword), false);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

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

    it('los comandos documentados para subir las claves dejan el archivo sin permisos para otros, con cualquier umask', () => {
      const header = fs.readFileSync(APROVISIONAR, 'utf8');
      const documented = [...header.matchAll(/^# +(\(umask 077; sed .*)$/gm)].map((match) => match[1]);
      assert.equal(documented.length, 2, 'falta un comando en la cabecera');
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-umask-'));
      try {
        const outEnv = path.join(directory, 'out.env');
        const target = path.join(directory, 'clave');
        fs.writeFileSync(outEnv, 'DB_USER=pages_app\nDB_PASSWORD=clave-app\nWORKER_DB_USER=pages_worker\nWORKER_DB_PASSWORD=clave-worker\n');
        for (const [index, expected] of ['clave-app', 'clave-worker'].entries()) {
          const command = documented[index].replaceAll('<OUT_ENV>', `'${outEnv}'`).replaceAll('<archivo>', `'${target}'`);
          const result = spawnSync('bash', ['-c', `umask 022; ${command}`], { encoding: 'utf8' });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(fs.readFileSync(target, 'utf8'), expected);
          assert.equal(fs.statSync(target).mode & 0o777, 0o600);
          fs.rmSync(target);
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it('si las cuentas ya existen, falla con un mensaje claro y no cambia nada', async () => {
      const result = run({ MYSQL_ADMIN_ARGS: `-u ${env.DB_ADMIN_USER}`, MYSQL_HOST_ARGS: hostArgs() });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /pages_owner, pages_app o pages_worker ya existen/);
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
