'use strict';

// Comprueba con qué índice corre cada consulta y cuántas lecturas hace, contra el mysqld desechable y su fixture.
// Requiere scripts/mysql_prueba.sh up. Corre como master: pages_app no puede hacer EXPLAIN sobre las vistas.
//
// Se mira key y lecturas, no Extra, que cambia entre versiones. Las lecturas son la suma de los Handler_read_*: a diferencia de los
// tiempos, no dependen de la máquina. Los topes están ajustados al fixture para que un plan que recorra otro índice no quepa.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const mysql = require('mysql2/promise');

const { adminConnectionOptions, loadTestEnv } = require('./support/test_env');

const ACCOUNT = 101;
// Ver la cabecera del fixture.
const BIG_DELIVERY = 1;
const LINKS_BY_SMS_DELIVERY = 3;
const UNIQUE_LINK_DELIVERY = 8;
const SEARCHED_NUMBER = 56900000777;
const SEARCHED_NUMBER_ACCOUNT = 102;
const RANGE_START = '2026-10-10 00:00:00';
const RANGE_END = '2026-10-20 23:59:59';
const CUTOFF_LO = '2026-10-09 00:00:00';
const CUTOFF_HI = '2026-10-21 23:59:59';
const MONTH_START = '2026-10-01 00:00:00';
const MONTH_END = '2026-10-31 23:59:59';
const OLD_LIST_CURSOR = '2026-10-03 12:00:00';

const SEARCH_COLUMNS = 'id, id_delivery, dst_number, sms_content, status, created_at';
const EXPORT_COLUMNS = 'id, id_unique, id_delivery, src_number, dst_number, sms_content, status, dst_provider, created_at';
const MESSAGE_COLUMNS = 'id, id_unique, status, dst_number, dst_provider, dst_country, updated_at';
const LIST_COLUMNS = 'id, id_unique, name, delivery_type, created_at, deliver_at';
const LIST_FILTER = 'id_account = ? AND id_product = 1 AND created_at IS NOT NULL';
const READ_COUNTERS = new Set(['first', 'key', 'last', 'next', 'prev', 'rnd', 'rnd_next'].map((name) => `Handler_read_${name}`));

describe('planes de consulta', () => {
  let admin;
  let version;
  let cutoffs;
  let bigDeliveryIds;
  let accountIds;
  let unique;

  before(async () => {
    admin = await mysql.createConnection(adminConnectionOptions(loadTestEnv()));
    [[{ version }]] = await admin.query('SELECT VERSION() AS version');
    [[cutoffs]] = await admin.query(
      'SELECT connectus_pages.sms_cutoff_id(?) AS lo, connectus_pages.sms_cutoff_id(?) AS hi',
      [CUTOFF_LO, CUTOFF_HI]
    );
    const [bigRows] = await admin.query('SELECT id FROM dbconnectus.sms_outgoing WHERE id_delivery = ? ORDER BY id', [BIG_DELIVERY]);
    bigDeliveryIds = bigRows.map((row) => row.id);
    const [accountRows] = await admin.query('SELECT id FROM dbconnectus.sms_outgoing WHERE id_account = ? ORDER BY id', [ACCOUNT]);
    accountIds = accountRows.map((row) => row.id);
    const [[{ sms }]] = await admin.query('SELECT id_unique AS sms FROM dbconnectus.sms_outgoing WHERE id = 9000');
    const [[{ delivery }]] = await admin.query('SELECT id_unique AS delivery FROM dbconnectus.delivery WHERE id = ?', [BIG_DELIVERY]);
    unique = { sms, delivery };
  });

  after(async () => {
    if (admin) await admin.end();
  });

  // Si el fixture dejara de traer esto, los planes de abajo pasarían sin probar lo que dicen.
  it('el fixture trae lo que estos planes necesitan', async () => {
    const count = async (sql, params) => {
      const [[{ n }]] = await admin.query(sql, params);
      return Number(n);
    };
    assert.ok(bigDeliveryIds.length > 5000, 'un envío de más de un tramo');
    assert.ok(await count('SELECT COUNT(*) AS n FROM dbconnectus.delivery WHERE id_account = ?', [ACCOUNT]) >= 30, 'envíos de una cuenta');
    assert.ok(await count('SELECT COUNT(*) AS n FROM dbconnectus.sms_outgoing WHERE id_delivery = ?', [LINKS_BY_SMS_DELIVERY]) > 2000);
    assert.ok(await count('SELECT COUNT(*) AS n FROM dbconnectus.short_link_sms_outgoings WHERE id_sms_outgoing >= 1000000') > 20000);
    assert.ok(await count('SELECT COUNT(*) AS n FROM dbconnectus.sms_incoming WHERE id_delivery = ?', [BIG_DELIVERY]) > 2000);
  });

  async function readsOf(sql, params) {
    await admin.query('FLUSH STATUS');
    await admin.query(sql, params);
    const [counters] = await admin.query("SHOW SESSION STATUS LIKE 'Handler_read%'");
    return counters
      .filter((row) => READ_COUNTERS.has(row.Variable_name))
      .reduce((total, row) => total + Number(row.Value), 0);
  }

  function assertMerged(plan) {
    assert.ok(plan.every((row) => row.select_type === 'SIMPLE'), 'la vista no se fusionó');
    assert.ok(!plan.some((row) => String(row.table).startsWith('<derived')), 'la vista se materializó');
    const allowed = plan.find((row) => row.table === 'a');
    if (allowed) assert.equal(allowed.key, 'PRIMARY');
  }

  async function check({ sql, params, table, key, types, maxReads, onlyOn }) {
    const [plan] = await admin.query(`EXPLAIN ${sql}`, params);
    assertMerged(plan);
    if (table) {
      const row = plan.find((item) => item.table === table);
      assert.ok(row, `falta ${table} en el plan: ${JSON.stringify(plan)}`);
      assert.equal(row.key, key, JSON.stringify(plan));
      assert.notEqual(row.type, 'ALL', JSON.stringify(plan));
      if (types) assert.ok(types.includes(row.type), JSON.stringify(plan));
    }
    if (maxReads !== undefined && (!onlyOn || version.startsWith(onlyOn))) {
      const reads = await readsOf(sql, params);
      assert.ok(reads <= maxReads, `${reads} lecturas, tope ${maxReads}`);
    }
  }

  describe('corte por fecha', () => {
    it('la sentencia de sms_cutoff_id usa created_at_idx, aunque compita con sum_multiplier_idx', async () => {
      await check({
        sql: 'SELECT id FROM dbconnectus.sms_outgoing WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT 1',
        params: [RANGE_START],
        table: 'sms_outgoing',
        key: 'created_at_idx',
        maxReads: 2,
      });
    });

    it('la función lee una fila', async () => {
      assert.ok(await readsOf('SELECT connectus_pages.sms_cutoff_id(?) AS lo', [RANGE_START]) <= 2);
    });
  });

  describe('búsqueda de SMS', () => {
    const search = (view, extra = '') => `SELECT /*+ MAX_EXECUTION_TIME(8000) */ ${SEARCH_COLUMNS} FROM connectus_pages.${view} `
      + `WHERE id_account = ? AND id > ?${extra} AND created_at BETWEEN ? AND ? ORDER BY id DESC LIMIT 51`;

    it('sin número, con cota superior: id_account__idx', async () => {
      await check({
        sql: search('sms_de_cuenta', ' AND id <= ?'),
        params: [ACCOUNT, cutoffs.lo, cutoffs.hi, RANGE_START, RANGE_END],
        table: 's',
        key: 'id_account__idx',
        maxReads: 600,
      });
    });

    it('sin número, sin cota superior: id_account__idx', async () => {
      await check({
        sql: search('sms_de_cuenta'),
        params: [ACCOUNT, cutoffs.lo, RANGE_START, RANGE_END],
        table: 's',
        key: 'id_account__idx',
        maxReads: accountIds.length + 2,
      });
    });

    it('sin número, con cursor: id_account__idx, y lee casi solo la página', async () => {
      await check({
        sql: search('sms_de_cuenta', ' AND id < ?'),
        params: [ACCOUNT, 0, accountIds[Math.floor(accountIds.length / 2)], MONTH_START, MONTH_END],
        table: 's',
        key: 'id_account__idx',
        maxReads: 55,
      });
    });

    it('con número: dst_number_idx, y lee solo las filas de ese número', async () => {
      const [[{ n }]] = await admin.query('SELECT COUNT(*) AS n FROM dbconnectus.sms_outgoing WHERE dst_number = ?', [SEARCHED_NUMBER]);
      await check({
        sql: search('sms_de_numero', ' AND dst_number = ?'),
        params: [SEARCHED_NUMBER_ACCOUNT, 0, SEARCHED_NUMBER, MONTH_START, MONTH_END],
        table: 's',
        key: 'dst_number_idx',
        maxReads: Number(n) + 2,
      });
    });

    it('los nombres por IN leen pocas filas, sin afirmar el índice', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, id_unique, name, id_product FROM connectus_pages.delivery '
          + 'WHERE id IN (?) AND id_account = ?',
        params: [[1, 2, 3, 7], ACCOUNT],
        maxReads: 12,
      });
    });

    it('un SMS por id_unique: índice único', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id_unique, id_delivery, src_number, dst_number, dst_country, updated_at, '
          + 'dst_provider, status, sms_content FROM connectus_pages.sms WHERE id_unique = ? AND id_account = ?',
        params: [unique.sms, ACCOUNT],
        table: 's',
        key: 'id_unique',
        types: ['const'],
        maxReads: 4,
      });
    });
  });

  describe('lista de envíos', () => {
    const list = (extra = '') => `SELECT /*+ MAX_EXECUTION_TIME(3000) */ ${LIST_COLUMNS} FROM connectus_pages.delivery `
      + `WHERE ${LIST_FILTER}${extra} ORDER BY created_at DESC, id DESC LIMIT 11`;
    const ANY_RANGE = ['ref', 'range'];

    it('primera página: delivery_account_created_idx, sin recorrer los envíos de la cuenta', async () => {
      await check({
        sql: list(),
        params: [ACCOUNT],
        table: 'd',
        key: 'delivery_account_created_idx',
        types: ANY_RANGE,
        maxReads: 14,
      });
    });

    // 5.7 puede resolverla con ref, leyendo desde el principio y filtrando: el costo del cursor solo se compara en la otra versión.
    it('con cursor: delivery_account_created_idx', async () => {
      await check({
        sql: list(' AND (created_at < ? OR (created_at = ? AND id < ?))'),
        params: [ACCOUNT, OLD_LIST_CURSOR, OLD_LIST_CURSOR, 120],
        table: 'd',
        key: 'delivery_account_created_idx',
        types: ANY_RANGE,
        maxReads: 14,
        onlyOn: '9.',
      });
    });

    it('con cursor en la fecha en cero: delivery_account_created_idx, sin nombrar esa fecha', async () => {
      await check({
        sql: list(' AND created_at < ? AND id < ?'),
        params: [ACCOUNT, '1000-01-01 00:00:00', 200],
        table: 'd',
        key: 'delivery_account_created_idx',
        types: ANY_RANGE,
        maxReads: 14,
      });
    });

    it('buscando por nombre: delivery_account_created_idx, y a lo sumo los envíos de la cuenta', async () => {
      const [[{ n }]] = await admin.query('SELECT COUNT(*) AS n FROM dbconnectus.delivery WHERE id_account = ?', [ACCOUNT]);
      await check({
        sql: list(" AND name LIKE ? ESCAPE '!'"),
        params: [ACCOUNT, '%no hay un envío así%'],
        table: 'd',
        key: 'delivery_account_created_idx',
        types: ANY_RANGE,
        maxReads: Number(n) + 3,
      });
    });
  });

  describe('detalle de envío', () => {
    it('datos del envío: índice único, sin leer de más', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, id_unique, name, delivery_type, deliver_at, created_at, status, error_status, '
          + 'has_base, contact_list_name, number_of_contacts FROM connectus_pages.delivery_datos '
          + 'WHERE id_unique = ? AND id_account = ? AND id_product = 1',
        params: [unique.delivery, ACCOUNT],
        table: 'd',
        key: 'id_unique',
        types: ['const'],
        maxReads: 5,
      });
    });

    it('último reporte del login: export_job_login_idx', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ public_id, kind, state, error_code, created_at FROM connectus_pages.export_job '
          + "WHERE id_login = ? AND id_delivery = ? AND kind = ? ORDER BY id DESC LIMIT 1",
        params: [1, BIG_DELIVERY, 'delivery_xlsx'],
      });
      const [plan] = await admin.query(
        'EXPLAIN SELECT public_id FROM connectus_pages.export_job FORCE INDEX (export_job_login_idx) WHERE id_login = ? ORDER BY id DESC LIMIT 1',
        [1]
      );
      assert.equal(plan[0].key, 'export_job_login_idx');
    });

    it('conteo del envío en curso: id_delivery__idx', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(1500) */ COUNT(*) AS n FROM connectus_pages.sms_ids_de_envio WHERE id_delivery = ?',
        params: [BIG_DELIVERY],
        table: 's',
        key: 'id_delivery__idx',
        maxReads: bigDeliveryIds.length + 3,
      });
    });

    const messages = (view, extra = '') => `SELECT /*+ MAX_EXECUTION_TIME(3000) */ ${MESSAGE_COLUMNS} FROM connectus_pages.${view} `
      + `WHERE id_delivery = ? AND id_account = ?${extra} ORDER BY id LIMIT 11`;

    it('mensajes, primera página: id_delivery__idx, y lee solo la página', async () => {
      await check({
        sql: messages('sms_de_envio'),
        params: [BIG_DELIVERY, ACCOUNT],
        table: 's',
        key: 'id_delivery__idx',
        maxReads: 14,
      });
    });

    it('mensajes, con cursor: id_delivery__idx, y lee solo la página', async () => {
      await check({
        sql: messages('sms_de_envio', ' AND id > ?'),
        params: [BIG_DELIVERY, ACCOUNT, bigDeliveryIds[4000]],
        table: 's',
        key: 'id_delivery__idx',
        maxReads: 14,
      });
    });

    it('mensajes por número: dst_number_idx, y no recorre el envío', async () => {
      const [[{ dst_number: number }]] = await admin.query('SELECT dst_number FROM dbconnectus.sms_outgoing WHERE id = ?', [bigDeliveryIds[0]]);
      const [[{ n }]] = await admin.query('SELECT COUNT(*) AS n FROM dbconnectus.sms_outgoing WHERE dst_number = ?', [number]);
      await check({
        sql: messages('sms_de_numero', ' AND dst_number = ?'),
        params: [BIG_DELIVERY, ACCOUNT, number],
        table: 's',
        key: 'dst_number_idx',
        maxReads: Number(n) + 2,
      });
    });

    it('conteo de respuestas: index_sms_incoming_on_id_delivery', async () => {
      const [[{ n }]] = await admin.query('SELECT COUNT(*) AS n FROM dbconnectus.sms_incoming WHERE id_delivery = ?', [BIG_DELIVERY]);
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(1500) */ COUNT(*) AS n FROM connectus_pages.incoming_ids_de_envio WHERE id_delivery = ?',
        params: [BIG_DELIVERY],
        table: 'i',
        key: 'index_sms_incoming_on_id_delivery',
        maxReads: Number(n) + 3,
      });
    });

    it('link del envío: id_delivery__idx', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id_unique, clicks FROM connectus_pages.link_de_envio '
          + 'WHERE id_delivery = ? AND id_account = ? LIMIT 1',
        params: [UNIQUE_LINK_DELIVERY, ACCOUNT],
        table: 'sd',
        key: 'id_delivery__idx',
        maxReads: 5,
      });
    });
  });

  describe('foto de conteos', () => {
    const STEP = 1000;

    it('última fila del envío: id_delivery__idx, y lee una', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ created_at FROM connectus_pages.sms_de_envio '
          + 'WHERE id_delivery = ? AND id_account = ? ORDER BY id DESC LIMIT 1',
        params: [BIG_DELIVERY, ACCOUNT],
        table: 's',
        key: 'id_delivery__idx',
        maxReads: 4,
      });
    });

    it('límite del tramo: id_delivery__idx, y lee lo que salta', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ id FROM connectus_pages.sms_ids_de_envio '
          + `WHERE id_delivery = ? AND id > ? ORDER BY id LIMIT 1 OFFSET ${STEP - 1}`,
        params: [BIG_DELIVERY, bigDeliveryIds[1000]],
        table: 's',
        key: 'id_delivery__idx',
        maxReads: STEP + 3,
      });
    });

    it('conteo del tramo: id_delivery__idx, y no lee el envío entero', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ status, dst_provider, dst_country, COUNT(*) AS n FROM connectus_pages.sms_de_envio '
          + 'WHERE id_delivery = ? AND id_account = ? AND id > ? AND id <= ? GROUP BY status, dst_provider, dst_country',
        params: [BIG_DELIVERY, ACCOUNT, bigDeliveryIds[1000], bigDeliveryIds[1000 + STEP]],
        table: 's',
        key: 'id_delivery__idx',
        maxReads: 3 * STEP,
      });
    });

    it('links por SMS: entra por id_delivery__idx y va por SMS a la tabla de unión', async () => {
      const [rows] = await admin.query('SELECT id FROM dbconnectus.sms_outgoing WHERE id_delivery = ? ORDER BY id', [LINKS_BY_SMS_DELIVERY]);
      const sql = 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ COUNT(DISTINCT id_short_link) AS links, COALESCE(SUM(clicks), 0) AS clics '
        + 'FROM connectus_pages.link_de_sms WHERE id_delivery = ? AND id_sms > ? AND id_sms <= ?';
      const params = [LINKS_BY_SMS_DELIVERY, rows[100].id, rows[300].id];
      await check({ sql, params, table: 's', key: 'id_delivery__idx', maxReads: 5 * 200 });
      await check({ sql, params, table: 'x', key: 'index_short_link_sms_outgoings_on_id_sms_outgoing' });
    });
  });

  describe('exportación', () => {
    const BATCH = 2000;

    it('tope congelado: id_account__idx, y lee una fila', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id FROM connectus_pages.sms_de_cuenta WHERE id_account = ? ORDER BY id DESC LIMIT 1',
        params: [ACCOUNT],
        table: 's',
        key: 'id_account__idx',
        maxReads: 3,
      });
    });

    it('límite del lote: id_account__idx, y lee lo que salta', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ id FROM connectus_pages.sms_de_cuenta '
          + `WHERE id_account = ? AND id > ? AND id <= ? ORDER BY id LIMIT 1 OFFSET ${BATCH - 1}`,
        params: [ACCOUNT, accountIds[1000], accountIds[9000]],
        table: 's',
        key: 'id_account__idx',
        maxReads: BATCH + 3,
      });
    });

    it('datos del lote: id_account__idx, y lee solo el rango', async () => {
      await check({
        sql: `SELECT /*+ MAX_EXECUTION_TIME(8000) */ ${EXPORT_COLUMNS} FROM connectus_pages.sms_de_cuenta `
          + 'WHERE id_account = ? AND id > ? AND id <= ? AND created_at BETWEEN ? AND ? ORDER BY id',
        params: [ACCOUNT, accountIds[1000], accountIds[1000 + BATCH], MONTH_START, MONTH_END],
        table: 's',
        key: 'id_account__idx',
        maxReads: BATCH + 3,
      });
    });

    it('con número, en un solo paso: dst_number_idx, y lee solo las filas de ese número', async () => {
      const [[{ n }]] = await admin.query('SELECT COUNT(*) AS n FROM dbconnectus.sms_outgoing WHERE dst_number = ?', [SEARCHED_NUMBER]);
      await check({
        sql: `SELECT /*+ MAX_EXECUTION_TIME(8000) */ ${EXPORT_COLUMNS} FROM connectus_pages.sms_de_numero `
          + 'WHERE id_account = ? AND id > ? AND id <= ? AND dst_number = ? AND created_at BETWEEN ? AND ? ORDER BY id LIMIT 2000',
        params: [SEARCHED_NUMBER_ACCOUNT, 0, 2147483647, SEARCHED_NUMBER, MONTH_START, MONTH_END],
        table: 's',
        key: 'dst_number_idx',
        maxReads: Number(n) + 2,
      });
    });

    it('reporte del envío: id_delivery__idx, y lee solo el lote', async () => {
      await check({
        sql: `SELECT /*+ MAX_EXECUTION_TIME(8000) */ ${MESSAGE_COLUMNS}, src_number, sms_content, multiplier, created_at `
          + `FROM connectus_pages.sms_de_envio WHERE id_delivery = ? AND id_account = ? AND id > ? AND id <= ? ORDER BY id LIMIT ${BATCH}`,
        params: [BIG_DELIVERY, ACCOUNT, bigDeliveryIds[1000], 2147483647],
        table: 's',
        key: 'id_delivery__idx',
        maxReads: BATCH + 3,
      });
    });

    it('respuestas del envío: index_sms_incoming_on_id_delivery, y lee solo el lote', async () => {
      await check({
        sql: 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_unique, src_number, dst_number, sms_content, created_at '
          + `FROM connectus_pages.sms_incoming_de_envio WHERE id_delivery = ? AND id_account = ? AND id > ? AND id <= ? ORDER BY id LIMIT ${BATCH}`,
        params: [BIG_DELIVERY, ACCOUNT, 100, 2147483647],
        table: 'i',
        key: 'index_sms_incoming_on_id_delivery',
        maxReads: BATCH + 3,
      });
    });
  });
});
