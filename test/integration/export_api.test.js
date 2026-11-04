'use strict';

// /api/exports contra el mysqld desechable, con pages_app y sus permisos de verdad. Requiere scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, afterEach, before, beforeEach, describe, it, mock } = require('node:test');
const mysql = require('mysql2/promise');

const { createDb } = require('../../src/db');
const { findJob } = require('../../src/exports');
const { parseQuietWindows } = require('../../src/worker/quiet');
const { adminConnectionOptions, loadTestEnv } = require('./support/test_env');
const { JOB_NUMBER, startExportEnvironment } = require('./support/exports_env');
const { uniqueOf } = require('./support/envios_env');

const NOW = '2026-11-20T15:00:00Z';
const NOW_TEXT = '2026-11-20 15:00:00';
const ACCOUNT = '101';
const SEARCH = { kind: 'sms_csv', account: ACCOUNT, start: '2026-10-05', end: '2026-10-19' };
const hoursBefore = (hours) => new Date(Date.parse(NOW) - hours * 3600000).toISOString().slice(0, 19).replace('T', ' ');

describe('exportaciones por la API', () => {
  let environment;
  let other;
  let admin;
  let token;
  let otherToken;
  let consoleError;

  function request(appInstance, method, path, { auth = token, query, body, headers } = {}) {
    return appInstance.handle({
      method,
      path,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      query: Object.fromEntries(Object.entries(query ?? {}).map(([name, value]) => [name, [value]])),
      body: body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      ip: '203.0.113.60',
    });
  }

  const app = (options) => environment.appAt(NOW, options);
  const post = (body, options, appInstance = app()) => request(appInstance, 'POST', '/api/exports', { body, ...options });
  const get = (path, query, options, appInstance = app()) => request(appInstance, 'GET', path, { query, ...options });
  const parsed = (response) => JSON.parse(response.body);
  const audits = async (action, loginId = environment.loginId) => {
    const [rows] = await admin.query('SELECT detail, id_account, ip FROM connectus_pages.audit_log WHERE id_login = ? AND action = ? ORDER BY id', [loginId, action]);
    return rows;
  };

  before(async () => {
    environment = await startExportEnvironment('exportador_api', [101, 102]);
    other = await startExportEnvironment('exportador_api_otro', [101]);
    ({ admin } = environment);
    token = await environment.tokenAt(NOW);
    otherToken = await other.tokenAt(NOW);
  });

  after(async () => {
    await other.stop();
    await environment.stop();
  });

  beforeEach(() => {
    consoleError = mock.method(console, 'error', () => {});
  });

  afterEach(async () => {
    consoleError.mock.restore();
    await admin.query('DELETE FROM connectus_pages.export_job WHERE id_login IN (?)', [[environment.loginId, other.loginId]]);
    await admin.query('DELETE FROM connectus_pages.audit_log WHERE id_login IN (?)', [[environment.loginId, other.loginId]]);
  });

  describe('POST /api/exports', () => {
    it('crea el job como pages_app, responde 201 con el item y sin el id de la tabla', async () => {
      const response = await post(SEARCH);
      assert.equal(response.statusCode, 201);
      const item = parsed(response);
      assert.match(item.id, /^[0-9a-f]{32}$/);
      assert.deepEqual({ ...item, id: null }, {
        id: null,
        kind: 'sms_csv',
        account: '101',
        accountName: 'Cuenta de prueba 101',
        filter: 'Todos los números',
        start: '2026-10-05',
        end: '2026-10-19',
        state: 'generating',
        errorMessage: null,
        createdAt: '20/11/2026 12:00',
        filename: null,
      });
      const job = await environment.jobOf(item.id);
      assert.equal(job.created_at, NOW_TEXT);
      assert.equal(job.state, 'new');
    });

    it('con número: el filtro lo muestra, y la auditoría y la consola no', async () => {
      const response = await post({ ...SEARCH, dst: JOB_NUMBER });
      const item = parsed(response);
      assert.equal(item.filter, JOB_NUMBER);
      const [audit] = await audits('export_create');
      assert.equal(audit.detail, `sms_csv 2026-10-05..2026-10-19 con_numero ${item.id}`);
      assert.equal(audit.id_account, 101);
      assert.equal(audit.ip, '203.0.113.60');
      const printed = JSON.stringify(consoleError.mock.calls.map((call) => call.arguments));
      assert.ok(printed.includes('export_create'));
      assert.ok(!printed.includes(JOB_NUMBER));
    });

    it('sin número: la auditoría dice sin_numero', async () => {
      const item = parsed(await post(SEARCH));
      assert.equal((await audits('export_create'))[0].detail, `sms_csv 2026-10-05..2026-10-19 sin_numero ${item.id}`);
    });

    for (const kind of ['delivery_xlsx', 'incoming_xlsx']) {
      it(`${kind}: del envío, con su nombre como filtro`, async () => {
        const response = await post({ kind, account: ACCOUNT, delivery: uniqueOf(8) });
        assert.equal(response.statusCode, 201);
        const item = parsed(response);
        assert.equal(item.filter, 'Envío chico con link único');
        assert.equal(item.start, null);
        const job = await environment.jobOf(item.id);
        assert.equal(job.id_delivery, 8);
        assert.equal((await audits('export_create'))[0].detail, `${kind} ${item.id}`);
      });
    }

    it('un envío ajeno, inexistente o de otro producto da 404', async () => {
      for (const delivery of [uniqueOf(4), uniqueOf(6), uniqueOf(12), 'x'.repeat(32)]) {
        const response = await post({ kind: 'delivery_xlsx', account: ACCOUNT, delivery });
        assert.equal(response.statusCode, 404);
        assert.equal(parsed(response).message, 'Envío no encontrado.');
      }
    });

    it('cuenta sin membresía: 403 y auditoría forbidden, sin crear nada', async () => {
      const response = await post({ ...SEARCH, account: '999' });
      assert.equal(response.statusCode, 403);
      assert.equal((await audits('forbidden'))[0].id_account, 999);
      const [rows] = await admin.query('SELECT id FROM connectus_pages.export_job WHERE id_login = ?', [environment.loginId]);
      assert.equal(rows.length, 0);
    });

    it('sin token: 401, antes de mirar nada', async () => {
      assert.equal((await post(SEARCH, { auth: null })).statusCode, 401);
      assert.equal((await post('no es json', { auth: null })).statusCode, 401);
    });

    it('mismos 415 y 413 que el login', async () => {
      const wrongType = await request(app(), 'POST', '/api/exports', { headers: { 'content-type': 'text/plain' }, body: SEARCH });
      assert.equal((await request(app(), 'POST', '/api/exports', { body: undefined })).statusCode, 415);
      assert.equal(wrongType.statusCode, 415);
      const big = await post({ ...SEARCH, relleno: 'x'.repeat(5000) });
      assert.equal(big.statusCode, 413);
    });

    it('el cuerpo acepta solo strings, y nada que no sea del contrato', async () => {
      for (const body of [
        '{',
        '[]',
        'null',
        {},
        { kind: 'otro', account: ACCOUNT },
        { ...SEARCH, account: 101 },
        { ...SEARCH, start: ['2026-10-05'] },
        { ...SEARCH, dst: 56900000001 },
        { ...SEARCH, dst: null },
        { ...SEARCH, cursor: 'x' },
        { ...SEARCH, delivery: uniqueOf(8) },
        '{"kind":"sms_csv","account":"101","start":"2026-10-05","end":"2026-10-19","__proto__":"x"}',
        { kind: 'delivery_xlsx', account: ACCOUNT, delivery: 8 },
        { kind: 'delivery_xlsx', account: ACCOUNT, delivery: [uniqueOf(8)] },
        { kind: 'delivery_xlsx', account: ACCOUNT, delivery: `${uniqueOf(8)}x` },
        { kind: 'delivery_xlsx', account: ACCOUNT, delivery: uniqueOf(8), start: '2026-10-05' },
        { ...SEARCH, end: '2026-10-20' },
        { ...SEARCH, end: '2026-10-01' },
        { ...SEARCH, dst: 'abc' },
      ]) {
        assert.equal((await post(body)).statusCode, 400, JSON.stringify(body));
      }
    });
  });

  describe('duplicados y topes', () => {
    it('mismo login, cuenta, tipo y filtros, sin terminar: 200 con el mismo job, y sin auditar otra vez', async () => {
      const first = parsed(await post(SEARCH));
      const again = await post(SEARCH);
      assert.equal(again.statusCode, 200);
      assert.equal(parsed(again).id, first.id);
      assert.equal((await audits('export_create')).length, 1);
    });

    it('otro filtro, otra cuenta u otro tipo no son duplicado', async () => {
      const ids = new Set();
      for (const body of [SEARCH, { ...SEARCH, end: '2026-10-18' }, { ...SEARCH, account: '102' }]) {
        const response = await post(body);
        assert.equal(response.statusCode, 201);
        ids.add(parsed(response).id);
      }
      assert.equal(ids.size, 3);
    });

    it('uno terminado o de más de 12 h 15 min no es duplicado', async () => {
      const period = { start_date: SEARCH.start, end_date: SEARCH.end };
      await environment.insertJob({ ...period, state: 'finished', created_at: NOW_TEXT });
      await environment.insertJob({ ...period, state: 'processing', created_at: hoursBefore(12.3) });
      assert.equal((await post(SEARCH)).statusCode, 201);
    });

    it('3 sin terminar: 429 export_limit con mensaje', async () => {
      for (const day of ['18', '17', '16']) assert.equal((await post({ ...SEARCH, end: `2026-10-${day}` })).statusCode, 201);
      const response = await post({ ...SEARCH, end: '2026-10-15' });
      assert.equal(response.statusCode, 429);
      assert.equal(parsed(response).error, 'export_limit');
      assert.ok(parsed(response).message);
      // Un duplicado no suma: se responde igual.
      assert.equal((await post({ ...SEARCH, end: '2026-10-18' })).statusCode, 200);
    });

    it('uno sin terminar de más de 12 h 15 min no ocupa cupo', async () => {
      for (let index = 0; index < 3; index += 1) await environment.insertJob({ state: 'processing', created_at: hoursBefore(13) });
      assert.equal((await post(SEARCH)).statusCode, 201);
    });

    it('un job de 12 h 14 min sí ocupa cupo', async () => {
      for (let index = 0; index < 3; index += 1) await environment.insertJob({ state: 'new', created_at: hoursBefore(12.2) });
      assert.equal((await post(SEARCH)).statusCode, 429);
    });

    it('10 en 24 h, terminados o no: 429. Los de hace más de 24 h no cuentan', async () => {
      for (let index = 0; index < 9; index += 1) await environment.insertJob({ state: 'finished', created_at: hoursBefore(23) });
      await environment.insertJob({ state: 'finished', created_at: hoursBefore(25) });
      assert.equal((await post(SEARCH)).statusCode, 201);
      assert.equal((await post({ ...SEARCH, end: '2026-10-18' })).statusCode, 429);
    });

    it('los topes son por login', async () => {
      for (let index = 0; index < 3; index += 1) await other.insertJob({ state: 'new', created_at: NOW_TEXT });
      assert.equal((await post(SEARCH)).statusCode, 201);
    });
  });

  describe('GET_LOCK', () => {
    it('POST concurrentes, cada uno con su conexión como en Lambdas distintas: un solo job, y nadie pasa el tope', async () => {
      const pools = Array.from({ length: 6 }, () => createDb(environment.config));
      try {
        const responses = await Promise.all(pools.map((db) => post(SEARCH, {}, environment.appAt(NOW, { db }))));
        const codes = responses.map(({ statusCode }) => statusCode).sort();
        assert.deepEqual(codes, [200, 200, 200, 200, 200, 201]);
        assert.equal(new Set(responses.map((response) => parsed(response).id)).size, 1);

        await admin.query('DELETE FROM connectus_pages.export_job WHERE id_login = ?', [environment.loginId]);
        const distinct = await Promise.all(pools.map((db, index) => post({ ...SEARCH, end: `2026-10-${10 + index}` }, {}, environment.appAt(NOW, { db }))));
        assert.deepEqual(distinct.map(({ statusCode }) => statusCode).sort(), [201, 201, 201, 429, 429, 429]);
      } finally {
        await Promise.all(pools.map((db) => db.end()));
      }
    });

    it('sin candado en 2 s: 503 busy, sin crear nada', async () => {
      const holder = await mysql.createConnection(adminConnectionOptions(loadTestEnv()));
      try {
        await holder.query('SELECT GET_LOCK(?, 1)', [`pages_export:${environment.loginId}`]);
        const response = await post(SEARCH);
        assert.equal(response.statusCode, 503);
        assert.equal(parsed(response).error, 'busy');
        const [rows] = await admin.query('SELECT id FROM connectus_pages.export_job WHERE id_login = ?', [environment.loginId]);
        assert.equal(rows.length, 0);
      } finally {
        await holder.end();
      }
    });

    it('suelta el candado también si la inserción falla, y por la misma conexión', async () => {
      const db = createDb(environment.config);
      const statements = [];
      const threads = new Set();
      const spied = {
        ...db,
        withConnection: (work) => db.withConnection(async (connection) => work({
          ...connection,
          async query(sql, params) {
            statements.push(sql);
            const [{ thread }] = await connection.query('SELECT CONNECTION_ID() AS thread');
            threads.add(String(thread));
            if (/^INSERT/.test(sql)) throw Object.assign(new Error('datos'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });
            return connection.query(sql, params);
          },
        })),
      };
      try {
        assert.equal((await post(SEARCH, {}, environment.appAt(NOW, { db: spied }))).statusCode, 503);
        assert.equal(threads.size, 1);
        assert.match(statements.at(-1), /RELEASE_LOCK/);
        assert.match(statements[0], /GET_LOCK/);
        const [[{ used }]] = await admin.query('SELECT IS_USED_LOCK(?) AS used', [`pages_export:${environment.loginId}`]);
        assert.equal(used, null);
      } finally {
        await db.end();
      }
    });
  });

  describe('lectura de jobs', () => {
    it('la lista va del login, más nuevos primero, 10 por página, con cursor y filtro por tipo', async () => {
      const ids = [];
      for (let index = 0; index < 12; index += 1) {
        ids.push(await environment.insertJob({
          kind: index % 2 === 0 ? 'delivery_xlsx' : 'sms_csv',
          state: 'finished',
          created_at: hoursBefore(index + 1),
          id_delivery: index % 2 === 0 ? 8 : null,
          delivery_name: index % 2 === 0 ? 'Envío' : null,
          start_date: index % 2 === 0 ? null : '2026-10-05',
          end_date: index % 2 === 0 ? null : '2026-10-19',
        }));
      }
      await other.insertJob({ state: 'finished', created_at: hoursBefore(1) });

      const first = parsed(await get('/api/exports'));
      assert.deepEqual(first.items.map(({ id }) => id), [...ids].reverse().slice(0, 10));
      assert.ok(first.nextCursor);
      assert.ok(!first.nextCursor.match(/^\d+$/));
      const second = parsed(await get('/api/exports', { cursor: first.nextCursor }));
      assert.deepEqual(second.items.map(({ id }) => id), [...ids].reverse().slice(10));
      assert.equal(second.nextCursor, null);

      const only = parsed(await get('/api/exports', { kind: 'delivery_xlsx' }));
      assert.equal(only.items.length, 6);
      assert.ok(only.items.every(({ kind }) => kind === 'delivery_xlsx'));
      assert.ok(only.items.every(({ filename }) => filename.startsWith('Reporte_de_envío_')));
    });

    it('un cursor de otro login o malformado da 400, y un tipo inválido también', async () => {
      for (let index = 0; index < 11; index += 1) await other.insertJob({ state: 'finished', created_at: hoursBefore(1) });
      const { nextCursor } = parsed(await get('/api/exports', undefined, { auth: otherToken }, other.appAt(NOW)));
      assert.ok(nextCursor);
      assert.equal((await get('/api/exports', { cursor: nextCursor })).statusCode, 400);
      assert.equal((await get('/api/exports', { cursor: 'x' })).statusCode, 400);
      assert.equal((await get('/api/exports', { kind: 'otro' })).statusCode, 400);
    });

    it('parseJob deja en número lo que mysqld entrega como texto', async () => {
      const publicId = await environment.insertJob({ lo: 2 ** 40, hi: 2 ** 41, last_id: 7, plain_bytes: 2 ** 33, file_bytes: 9, work_ms: 11, dst_number: JOB_NUMBER, created_at: NOW_TEXT });
      const [[raw]] = await admin.query('SELECT hi FROM connectus_pages.export_job WHERE public_id = ?', [publicId]);
      assert.equal(typeof raw.hi, 'string', 'bigNumberStrings, como en la app');
      const job = await findJob(environment.db, publicId, environment.loginId);
      assert.equal(job.lo, 2 ** 40);
      assert.equal(job.hi, 2 ** 41);
      assert.equal(job.lastId, 7);
      assert.equal(job.plainBytes, 2 ** 33);
      assert.equal(job.fileBytes, 9);
      assert.equal(job.workMs, 11);
      assert.equal(job.dst, JOB_NUMBER);
      assert.equal(job.lastId + job.workMs, 18);
    });

    it('el estado valida la forma del id antes de consultar', async () => {
      for (const id of ['x', 'A'.repeat(32), `${'a'.repeat(32)}0`, '']) {
        assert.equal((await get('/api/exports/status', { id })).statusCode, 400);
        assert.equal((await get('/api/exports/download', { id })).statusCode, 400);
      }
      assert.equal((await get('/api/exports/status', { id: 'a'.repeat(32) })).statusCode, 404);
    });

    it('sin terminar con más de 12 h 15 min: failed y too_old sin el código crudo, en lista y estado', async () => {
      const publicId = await environment.insertJob({ state: 'processing', created_at: hoursBefore(12.3), start_date: '2026-10-05', end_date: '2026-10-19' });
      const item = parsed(await get('/api/exports/status', { id: publicId }));
      assert.equal(item.state, 'failed');
      assert.equal(item.errorMessage, 'La generación tardó demasiado. Inténtalo de nuevo.');
      assert.equal(parsed(await get('/api/exports')).items[0].state, 'failed');
    });

    it('el mensaje de error sale de la tabla, nunca el código', async () => {
      for (const [code, pattern] of [['too_many_rows', /1\.000\.000/], ['too_large', /grande/], ['stalled', /interrumpió/], ['schema_error', /No se pudo/], ['otro_codigo', /No se pudo/]]) {
        const publicId = await environment.insertJob({ state: 'failed', error_code: code, created_at: NOW_TEXT });
        const item = parsed(await get('/api/exports/status', { id: publicId }));
        assert.match(item.errorMessage, pattern);
        assert.ok(!JSON.stringify(item).includes(code));
      }
    });

    it('el estado termina en ready, con el nombre del archivo', async () => {
      const csv = await environment.insertJob({ state: 'finished', start_date: '2026-10-05', end_date: '2026-10-19', created_at: NOW_TEXT });
      assert.equal(parsed(await get('/api/exports/status', { id: csv })).filename, 'sms_2026-10-05_2026-10-19.csv');
      const xlsx = await environment.insertJob({ state: 'finished', kind: 'incoming_xlsx', id_delivery: 8, created_at: '2026-11-20 02:30:00' });
      const item = parsed(await get('/api/exports/status', { id: xlsx }));
      assert.equal(item.state, 'ready');
      assert.equal(item.filename, `Respuestas_de_envío_19-11-2026_${xlsx.slice(0, 8)}.xlsx`);
    });
  });

  describe('dos logins en la misma cuenta', () => {
    it('uno no puede ver ni bajar lo del otro', async () => {
      const mine = parsed(await post(SEARCH));
      await admin.query("UPDATE connectus_pages.export_job SET state = 'finished', storage_key = CONCAT('exports/', public_id) WHERE public_id = ?", [mine.id]);

      const appOfOther = other.appAt(NOW);
      assert.deepEqual(parsed(await get('/api/exports', undefined, { auth: otherToken }, appOfOther)).items, []);
      assert.equal((await get('/api/exports/status', { id: mine.id }, { auth: otherToken }, appOfOther)).statusCode, 404);
      const download = await get('/api/exports/download', { id: mine.id }, { auth: otherToken }, appOfOther);
      assert.equal(download.statusCode, 404);
      assert.ok(!download.body.includes('url'));
      assert.equal((await audits('export_download', other.loginId)).length, 0);
    });

    it('el mismo pedido de otro login es otro job', async () => {
      const mine = parsed(await post(SEARCH));
      const theirs = await post(SEARCH, { auth: otherToken }, other.appAt(NOW));
      assert.equal(theirs.statusCode, 201);
      assert.notEqual(parsed(theirs).id, mine.id);
    });

    it('report e incoming de GET /api/delivery son del login que pregunta', async () => {
      const mine = parsed(await post({ kind: 'delivery_xlsx', account: ACCOUNT, delivery: uniqueOf(8) }));
      const detail = await get('/api/delivery', { account: ACCOUNT, id: uniqueOf(8) });
      assert.equal(parsed(detail).report.id, mine.id);
      assert.equal(parsed(detail).report.createdAt, mine.createdAt);
      const theirs = await get('/api/delivery', { account: ACCOUNT, id: uniqueOf(8) }, { auth: otherToken }, other.appAt(NOW));
      assert.equal(parsed(theirs).report, null);
    });
  });

  describe('membresía quitada', () => {
    it('lista y estado dejan de mostrarlo, y la descarga da 403 con auditoría', async () => {
      const publicId = await environment.insertJob({ id_account: 102, state: 'finished', storage_key: 'exports/x', start_date: '2026-10-05', end_date: '2026-10-19', created_at: NOW_TEXT });
      await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ? AND id_account = 102', [environment.loginId]);
      try {
        assert.deepEqual(parsed(await get('/api/exports')).items, []);
        assert.equal((await get('/api/exports/status', { id: publicId })).statusCode, 404);
        const response = await get('/api/exports/download', { id: publicId });
        assert.equal(response.statusCode, 403);
        assert.ok(!response.body.includes('url'));
        assert.equal((await audits('forbidden'))[0].id_account, 102);
        assert.equal((await audits('export_download')).length, 0);
      } finally {
        await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 102)', [environment.loginId]);
      }
    });

    it('sin ninguna cuenta, la lista viene vacía sin armar un IN vacío', async () => {
      const [memberships] = await admin.query('SELECT id_account FROM connectus_pages.login_account WHERE id_login = ?', [other.loginId]);
      await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ?', [other.loginId]);
      try {
        const response = await get('/api/exports', undefined, { auth: otherToken }, other.appAt(NOW));
        assert.equal(response.statusCode, 200);
        assert.deepEqual(parsed(response), { items: [], nextCursor: null });
      } finally {
        for (const { id_account: account } of memberships) {
          await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, ?)', [other.loginId, account]);
        }
      }
    });
  });

  describe('GET /api/exports/download', () => {
    const finishedJob = (fields) => environment.insertJob({
      state: 'finished',
      storage_key: `exports/${crypto.randomBytes(16).toString('hex')}`,
      start_date: '2026-10-05',
      end_date: '2026-10-19',
      created_at: NOW_TEXT,
      ...fields,
    });

    const withObject = () => environment.appAt(NOW, { storage: { ...environment.s3.storage, headObject: async () => ({ size: 1 }) } });

    it('terminado: URL, 300 s y nombre, y audita con tipo e id público', async () => {
      const publicId = await finishedJob();
      const response = await get('/api/exports/download', { id: publicId }, {}, withObject());
      assert.equal(response.statusCode, 200);
      const body = parsed(response);
      assert.equal(body.expiresIn, 300);
      assert.equal(body.filename, 'sms_2026-10-05_2026-10-19.csv');
      assert.match(body.url, /^http:\/\/descarga\.invalid\/exports\//);
      assert.deepEqual(Object.keys(body).sort(), ['expiresIn', 'filename', 'url']);
      assert.equal((await audits('export_download'))[0].detail, `sms_csv ${publicId}`);
    });

    it('el objeto ya no está: 404 con su mensaje, sin URL ni auditoría', async () => {
      const publicId = await finishedJob();
      const response = await get('/api/exports/download', { id: publicId });
      assert.equal(response.statusCode, 404);
      assert.equal(parsed(response).error, 'not_found');
      assert.equal(parsed(response).message, 'El archivo ya no está disponible. Genera uno nuevo.');
      assert.ok(!response.body.includes('url'));
      assert.equal((await audits('export_download')).length, 0);
    });

    it('S3 falla al revisar el objeto: 503, sin firmar ni auditar', async () => {
      const publicId = await finishedJob();
      const downloadUrl = mock.fn(() => 'http://no-debe-salir.invalid/');
      const headObject = async () => { throw Object.assign(new Error('datos'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } }); };
      const response = await get('/api/exports/download', { id: publicId }, {}, environment.appAt(NOW, { storage: { downloadUrl, headObject } }));
      assert.equal(response.statusCode, 503);
      assert.equal(parsed(response).error, 'busy');
      assert.ok(!response.body.includes('invalid'));
      assert.equal(downloadUrl.mock.callCount(), 0);
      assert.equal((await audits('export_download')).length, 0);
      assert.ok(JSON.stringify(consoleError.mock.calls.map((call) => call.arguments)).includes('request_failed'));
    });

    it('revisa el objeto antes de auditar', async () => {
      const publicId = await finishedJob();
      const seen = [];
      const headObject = async (key) => {
        seen.push(key, (await audits('export_download')).length);
        return { size: 1 };
      };
      const response = await get('/api/exports/download', { id: publicId }, {}, environment.appAt(NOW, { storage: { ...environment.s3.storage, headObject } }));
      assert.equal(response.statusCode, 200);
      assert.deepEqual(seen, [(await environment.jobOf(publicId)).storage_key, 0]);
    });

    it('sin terminar o fallido: 409, sin URL', async () => {
      for (const state of ['new', 'processing', 'failed']) {
        const publicId = await environment.insertJob({ state, created_at: NOW_TEXT });
        const response = await get('/api/exports/download', { id: publicId });
        assert.equal(response.statusCode, 409);
        assert.ok(!response.body.includes('url'));
      }
    });

    it('si falla el INSERT de auditoría: 503 sin URL, y la consola solo trae el código', async () => {
      const publicId = await finishedJob();
      const downloadUrl = mock.fn(() => 'http://no-debe-salir.invalid/');
      const db = {
        query: (sql, params) => environment.db.query(sql, params),
        write(sql, params) {
          if (/audit_log/.test(sql)) {
            return Promise.reject(Object.assign(new Error(`datos ${JOB_NUMBER}`), { code: 'ER_LOCK_DEADLOCK', errno: 1213, sql: `x ${JOB_NUMBER}` }));
          }
          return environment.db.write(sql, params);
        },
      };
      const response = await get('/api/exports/download', { id: publicId }, {}, environment.appAt(NOW, { db, storage: { downloadUrl, headObject: async () => ({ size: 1 }) } }));
      assert.equal(response.statusCode, 503);
      assert.equal(parsed(response).error, 'busy');
      assert.ok(!response.body.includes('url'));
      assert.ok(!response.body.includes('invalid'));
      assert.equal(downloadUrl.mock.callCount(), 0);
      const printed = JSON.stringify(consoleError.mock.calls.map((call) => call.arguments));
      assert.ok(printed.includes('audit_insert_failed'));
      assert.ok(!printed.includes(JOB_NUMBER));
    });

    it('los permisos reales: pages_app no puede cambiar el estado de un job', async () => {
      const publicId = await environment.insertJob({ created_at: NOW_TEXT });
      await assert.rejects(environment.db.write("UPDATE connectus_pages.export_job SET state = 'finished' WHERE public_id = ?", [publicId]), { errno: 1142 });
    });
  });

  describe('de punta a punta', () => {
    it('POST, trabajador, estado y descarga, con la fila en el archivo y el total exacto', async () => {
      const body = { kind: 'sms_csv', account: '102', start: '2026-10-16', end: '2026-10-17', dst: '56900000777' };
      const created = parsed(await post(body));
      await environment.work({
        clock: () => Date.parse(NOW),
        quietWindows: parseQuietWindows('none'),
      });
      const status = parsed(await get('/api/exports/status', { id: created.id }));
      assert.equal(status.state, 'ready');
      assert.equal(status.filename, 'sms_2026-10-16_2026-10-17.csv');
      const download = parsed(await get('/api/exports/download', { id: created.id }));
      assert.ok(download.url.includes(created.id));

      const [[{ n }]] = await admin.query(`SELECT COUNT(*) AS n FROM dbconnectus.sms_outgoing WHERE dst_number = 56900000777 AND id_account = 102
        AND created_at BETWEEN '2026-10-16 00:00:00' AND '2026-10-17 23:59:59'`);
      assert.ok(Number(n) > 0);
      const lines = environment.s3.read(created.id).toString('utf8').trimEnd().split('\n');
      assert.equal(lines.length - 1, Number(n));
      assert.ok(lines.slice(1).every((line) => line.split(';')[4] === '56900000777'));
      environment.s3.reset();
    });
  });
});
