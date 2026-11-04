'use strict';

// El trabajador contra el mysqld desechable, con pages_worker y sus permisos de verdad, y un S3 falso que valida como S3. Requiere
// scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it, mock } = require('node:test');

const { createDb } = require('../../src/db');
const { MIN_PART_BYTES } = require('../../src/storage');
const { createWorkerHandler } = require('../../src/worker/handler');
const { parseQuietWindows } = require('../../src/worker/quiet');
const { createMortal, csvRows, startExportEnvironment, workerDbConfig, xlsxRows } = require('./support/exports_env');
const {
  BIG_DELIVERY,
  RANGE,
  SEARCHED_NUMBER,
  expectedIncomingIds,
  expectedSmsIds,
  insertExportData,
  removeExportData,
} = require('./support/exports_data');
const { createTcpProxy } = require('./support/proxy_tcp');

const DATA_STEP = /FROM connectus_pages\.sms_de_cuenta WHERE id_account = \? AND id > \? AND id <= \? AND created_at BETWEEN/;
const DELIVERY_STEP = /FROM connectus_pages\.sms_de_envio WHERE id_delivery = \? AND id_account = \? AND id > \? AND id <= \?/;
// La sentencia que trae o delimita un lote: los topes y la elección del job llevan LIMIT 1, y la limpieza no es un SELECT.
const BATCH_STEP = /^SELECT.*(OFFSET|LIMIT) \d{3,}$/s;
const DELIVERY_NAMES = /id, name FROM connectus_pages\.delivery /;
const CUTOFF = /sms_cutoff_id/;
const cutError = (errno) => Object.assign(new Error(`corte con datos ${errno}`), { errno, code: `ER_${errno}` });
const CSV_JOB = { kind: 'sms_csv', start_date: RANGE.start, end_date: RANGE.end };
const XLSX_JOB = { kind: 'delivery_xlsx', id_delivery: BIG_DELIVERY, delivery_name: 'Envío de exportación' };
const INCOMING_JOB = { kind: 'incoming_xlsx', id_delivery: BIG_DELIVERY, delivery_name: 'Envío de exportación' };
const JOBS = { sms_csv: CSV_JOB, delivery_xlsx: XLSX_JOB, incoming_xlsx: INCOMING_JOB };

function dataIdsOf(kind, file) {
  const rows = kind === 'sms_csv' ? csvRows(file) : xlsxRows(file);
  return { header: rows[0], ids: rows.slice(1).map((row) => row[0]), rows };
}

describe('trabajador de exportaciones', () => {
  let environment;
  let admin;
  let s3;
  let consoleError;

  before(async () => {
    environment = await startExportEnvironment('exportador_trabajador', [101, 102]);
    ({ admin, s3 } = environment);
    await admin.query('DELETE FROM connectus_pages.export_job');
    await insertExportData(admin);
  });

  after(async () => {
    await removeExportData(admin);
    await environment.stop();
  });

  beforeEach(() => {
    s3.reset();
    consoleError = mock.method(console, 'error', () => {});
  });

  afterEach(async () => {
    consoleError.mock.restore();
    await admin.query('DELETE FROM connectus_pages.export_job');
  });

  const logged = () => consoleError.mock.calls.map((call) => JSON.parse(call.arguments[0]));

  async function expectExact(publicId, kind) {
    const job = await environment.jobOf(publicId);
    assert.equal(job.state, 'finished', job.error_code);
    const expected = kind === 'incoming_xlsx' ? await expectedIncomingIds(admin) : await expectedSmsIds(admin);
    const { ids } = dataIdsOf(kind, s3.read(publicId));
    assert.equal(ids.length, expected.length, 'el total exacto');
    assert.deepEqual(ids, expected, 'sin filas repetidas ni faltantes, y en orden');
    assert.equal(Number(job.rows_written), expected.length);
    assert.equal(Number(job.file_bytes), s3.read(publicId).length);
    return job;
  }

  describe('corrida sin interrupciones', () => {
    for (const kind of Object.keys(JOBS)) {
      it(`${kind}: más de una parte, cada una de al menos 5 MiB salvo la última, y el total exacto`, async () => {
        const publicId = await environment.insertJob(JOBS[kind]);
        assert.deepEqual(await environment.work(), {});
        const job = await expectExact(publicId, kind);
        assert.ok(Number(job.next_part) > 2, `partes: ${Number(job.next_part) - 1}`);
        const parts = s3.calls.filter(({ operation }) => operation === 'uploadPart');
        for (const { input } of parts.slice(0, -1)) assert.ok(input.body.length >= MIN_PART_BYTES);
        assert.equal(Number(job.stalls), 0);
        assert.ok(job.finished_at);
      });
    }

    it('el CSV lleva el BOM y la cabecera una sola vez, aunque tenga varias partes', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      await environment.work();
      const file = s3.read(publicId);
      assert.equal(file.toString('utf8', 0, 3), '﻿');
      assert.equal(file.indexOf(Buffer.from([0xef, 0xbb, 0xbf]), 3), -1);
      assert.equal(file.toString('utf8').split('Identificador único').length, 2);
      assert.deepEqual(csvRows(file)[0].slice(1), ['Cuenta', 'Envío', 'Número origen', 'Número destino', 'Mensaje', 'Estado', 'Proveedor', 'Fecha']);
    });

    it('registra export_finished en la auditoría, con el id público y las filas, sin datos', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      await environment.work();
      const [rows] = await admin.query("SELECT detail, id_account FROM connectus_pages.audit_log WHERE action = 'export_finished' AND detail LIKE ?", [`${publicId}%`]);
      assert.equal(rows.length, 1);
      const expected = await expectedSmsIds(admin);
      assert.equal(rows[0].detail, `${publicId} ${expected.length}`);
      assert.equal(rows[0].id_account, 101);
    });

    it('con número: solo las filas de ese número, y el número no sale en consola', async () => {
      const publicId = await environment.insertJob({ ...CSV_JOB, dst_number: SEARCHED_NUMBER });
      await environment.work();
      const { ids, rows } = dataIdsOf('sms_csv', s3.read(publicId));
      assert.deepEqual(ids, await expectedSmsIds(admin, `AND dst_number = ${SEARCHED_NUMBER}`));
      assert.ok(ids.length > 0);
      assert.ok(rows.slice(1).every((row) => row[4] === String(SEARCHED_NUMBER)));
      assert.ok(!JSON.stringify(logged()).includes(String(SEARCHED_NUMBER)));
    });

    it('sin filas: el archivo sale igual, con su cabecera', async () => {
      const csv = await environment.insertJob({ ...CSV_JOB, start_date: '2025-01-01', end_date: '2025-01-02' });
      const xlsx = await environment.insertJob({ ...XLSX_JOB, id_delivery: 139 });
      await environment.work();
      assert.equal(csvRows(s3.read(csv)).length, 1);
      assert.equal(xlsxRows(s3.read(xlsx)).length, 1);
      assert.equal(Number((await environment.jobOf(xlsx)).rows_written), 0);
    });

    it('toma primero el job más viejo', async () => {
      const first = await environment.insertJob({ ...CSV_JOB, start_date: '2025-01-01', end_date: '2025-01-02' });
      const second = await environment.insertJob({ ...CSV_JOB, start_date: '2025-02-01', end_date: '2025-02-02' });
      await environment.work();
      const keys = s3.calls.filter(({ operation }) => operation === 'createUpload').map(({ input }) => input.key);
      assert.deepEqual(keys, [`exports/${first}`, `exports/${second}`]);
    });
  });

  describe('dos jobs en una misma corrida', () => {
    it('cuentas distintas, con la fila mezclada: el nombre no se arrastra del job anterior', async () => {
      const period = { kind: 'sms_csv', start_date: '2026-10-08', end_date: '2026-10-12' };
      // Esta fila es de la 102 y cita el envío 1, de la 101. El job de la 101 corre antes y deja el nombre de ese envío a la vista.
      const [[mixed]] = await admin.query('SELECT id_unique FROM dbconnectus.sms_outgoing WHERE id = 9011');
      const of101 = await environment.insertJob({ ...period, id_account: 101 });
      const of102 = await environment.insertJob({ ...period, id_account: 102 });
      await environment.work();

      const rows101 = csvRows(s3.read(of101));
      assert.ok(rows101.some((row) => row[2] === 'Campaña de prueba 101-A'));
      assert.ok(rows101.slice(1).every((row) => row[1] === 'Cuenta de prueba 101'));
      const rows102 = csvRows(s3.read(of102));
      const row = rows102.find((candidate) => candidate[0] === mixed.id_unique);
      assert.ok(row, 'la fila mezclada está en el archivo de su cuenta');
      assert.equal(row[1], 'Cuenta de prueba 102');
      assert.equal(row[2], '');
      assert.ok(rows102.slice(1).every((candidate) => candidate[1] === 'Cuenta de prueba 102'));
    });
  });

  describe('muertes', () => {
    for (const kind of Object.keys(JOBS)) {
      it(`${kind}: muere a mitad de una parte, después de cerrar la primera, y sigue sin repetir ni perder`, async () => {
        const publicId = await environment.insertJob(JOBS[kind]);
        const mortal = createMortal();
        let parts = 0;
        s3.after('uploadPart', () => { parts += 1; });
        const db = mortal.db(environment.workerDb, (sql) => {
          if (parts === 1 && BATCH_STEP.test(sql)) mortal.kill();
        });
        await environment.work({ db, storage: mortal.storage(s3.storage) });
        const halfway = await environment.jobOf(publicId);
        assert.equal(halfway.state, 'processing');
        assert.equal(Number(halfway.next_part), 2);
        assert.ok(Number(halfway.last_id) > 0);
        assert.equal(Number(halfway.stalls), 0);

        s3.clearHooks();
        await environment.work();
        await expectExact(publicId, kind);
      });

      it(`${kind}: muere entre UploadPart y el UPDATE, y la parte se sobrescribe`, async () => {
        const publicId = await environment.insertJob(JOBS[kind]);
        const mortal = createMortal();
        s3.after('uploadPart', ({ partNumber }) => {
          if (partNumber === 2) mortal.kill();
        });
        await environment.work({ db: mortal.db(environment.workerDb), storage: mortal.storage(s3.storage) });
        const halfway = await environment.jobOf(publicId);
        assert.equal(Number(halfway.next_part), 2, 'el cierre de la parte 2 no alcanzó a guardarse');

        s3.clearHooks();
        await environment.work();
        await expectExact(publicId, kind);
        const second = s3.calls.filter(({ operation, input }) => operation === 'uploadPart' && input.partNumber === 2);
        assert.equal(second.length, 2);
      });
    }

    it('muere antes de cerrar la primera parte: stalls suma 1, y el archivo parte de cero con una sola cabecera', async () => {
      const publicId = await environment.insertJob({ ...CSV_JOB, batch_size: 500 });
      const mortal = createMortal();
      let batches = 0;
      const db = mortal.db(environment.workerDb, (sql) => {
        if (DATA_STEP.test(sql)) {
          batches += 1;
          if (batches === 2) mortal.kill();
        }
      });
      await environment.work({ db, storage: mortal.storage(s3.storage) });
      const halfway = await environment.jobOf(publicId);
      assert.equal(Number(halfway.stalls), 1);
      assert.equal(Number(halfway.last_id), 0);
      assert.ok(halfway.upload_id);

      const uploadId = halfway.upload_id;
      await environment.work();
      await expectExact(publicId, 'sms_csv');
      assert.equal((await environment.jobOf(publicId)).upload_id, uploadId, 'sigue con la misma carga');
      assert.equal(s3.read(publicId).toString('utf8').split('Identificador único').length, 2);
    });

    it('muere al guardar la carga recién creada: la próxima corrida crea otra y termina', async () => {
      const publicId = await environment.insertJob(XLSX_JOB);
      const mortal = createMortal();
      s3.after('createUpload', () => mortal.kill());
      await environment.work({ db: mortal.db(environment.workerDb), storage: mortal.storage(s3.storage) });
      assert.equal((await environment.jobOf(publicId)).upload_id, null);
      s3.clearHooks();
      await environment.work();
      await expectExact(publicId, 'delivery_xlsx');
    });
  });

  describe('completar', () => {
    it('muere entre completar y marcarlo: con NoSuchUpload, HeadObject confirma el tamaño y queda finished', async () => {
      const publicId = await environment.insertJob(XLSX_JOB);
      const mortal = createMortal();
      s3.after('completeUpload', () => mortal.kill());
      await environment.work({ db: mortal.db(environment.workerDb), storage: mortal.storage(s3.storage) });
      assert.equal((await environment.jobOf(publicId)).state, 'processing');

      s3.clearHooks();
      const uploadsBefore = s3.count('uploadPart');
      await environment.work();
      await expectExact(publicId, 'delivery_xlsx');
      assert.equal(s3.count('uploadPart'), uploadsBefore, 'no vuelve a escribir nada');
      assert.equal(s3.count('headObject'), 1);
    });

    it('la carga se perdió y no hay objeto: failed con inconsistent', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const mortal = createMortal();
      s3.after('uploadPart', () => mortal.kill());
      await environment.work({ db: mortal.db(environment.workerDb), storage: mortal.storage(s3.storage) });
      s3.clearHooks();
      const { upload_id: uploadId, storage_key: key } = await environment.jobOf(publicId);
      await s3.disk.abortUpload({ key, uploadId });
      await environment.work();
      const job = await environment.jobOf(publicId);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'inconsistent');
    });

    it('hay un objeto de otro tamaño: failed con inconsistent', async () => {
      const publicId = await environment.insertJob(XLSX_JOB);
      const mortal = createMortal();
      s3.after('completeUpload', () => mortal.kill());
      await environment.work({ db: mortal.db(environment.workerDb), storage: mortal.storage(s3.storage) });
      s3.clearHooks();
      await admin.query('UPDATE connectus_pages.export_job SET file_bytes = file_bytes + 1 WHERE public_id = ?', [publicId]);
      await environment.work();
      assert.equal((await environment.jobOf(publicId)).error_code, 'inconsistent');
    });

    it('una parte N+1 sobrante se descarta: el archivo solo trae hasta la N', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      s3.before('listParts', async ({ key, uploadId }) => {
        await s3.disk.uploadPart({ key, uploadId, partNumber: 50, body: Buffer.from('sobra') });
      });
      await environment.work();
      await expectExact(publicId, 'sms_csv');
      const { input } = s3.calls.find(({ operation }) => operation === 'completeUpload');
      assert.ok(input.parts.every(({ partNumber }) => partNumber < 50));
      assert.equal(input.objectSize, s3.read(publicId).length);
    });

    it('falta una parte del medio: failed con inconsistent, y aborta la carga', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const realList = s3.storage.listParts;
      await environment.work({
        storage: { ...s3.storage, listParts: async (input) => (await realList(input)).filter(({ partNumber }) => partNumber !== 1) },
      });
      const job = await environment.jobOf(publicId);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'inconsistent');
      assert.equal(s3.count('abortUpload'), 1);
      assert.ok(logged().some(({ event, code }) => event === 'export_failed' && code === 'inconsistent'));
    });

    it('la suma de las partes no calza con file_bytes: failed con inconsistent', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const realList = s3.storage.listParts;
      await environment.work({
        storage: { ...s3.storage, listParts: async (input) => (await realList(input)).map((part) => ({ ...part, size: part.size + 1 })) },
      });
      assert.equal((await environment.jobOf(publicId)).error_code, 'inconsistent');
    });
  });

  describe('cortes de la base', () => {
    function cutOn(pattern, times, errno = 3024) {
      let left = times;
      const mortal = createMortal();
      return mortal.db(environment.workerDb, (sql) => {
        if (left > 0 && pattern.test(sql)) {
          left -= 1;
          throw cutError(errno);
        }
      });
    }

    for (const errno of [3024, 1028, 1317]) {
      it(`corte ${errno} con lote a la mitad, guardado, y sigue sin perder filas`, async () => {
        const publicId = await environment.insertJob(CSV_JOB);
        const sizes = [];
        const mortal = createMortal();
        let left = 1;
        const db = mortal.db(environment.workerDb, async (sql, params) => {
          if (left > 0 && DATA_STEP.test(sql)) {
            left -= 1;
            throw cutError(errno);
          }
          if (/SET batch_size = \?/.test(sql)) sizes.push(params[0]);
        });
        await environment.work({ db });
        assert.deepEqual(sizes, [1000]);
        await expectExact(publicId, 'sms_csv');
      });
    }

    it('al cerrar una parte, el lote se duplica hasta 2000', async () => {
      const publicId = await environment.insertJob({ ...CSV_JOB, batch_size: 500 });
      const closes = [];
      const mortal = createMortal();
      const db = mortal.db(environment.workerDb, (sql, params) => {
        if (/SET last_id = \?/.test(sql)) closes.push(params[6]);
      });
      await environment.work({ db });
      assert.deepEqual(closes.slice(0, 3), [1000, 2000, 2000]);
      await expectExact(publicId, 'sms_csv');
    });

    it('un corte en lote 500 termina la corrida sin abortar y cuenta en stalls; la siguiente sigue', async () => {
      const publicId = await environment.insertJob({ ...CSV_JOB, batch_size: 500 });
      const outcome = await environment.work({ db: cutOn(DATA_STEP, 1) });
      assert.deepEqual(outcome, {});
      const job = await environment.jobOf(publicId);
      assert.equal(job.state, 'processing');
      assert.equal(Number(job.stalls), 1);
      assert.equal(s3.count('abortUpload'), 0);

      await environment.work();
      await expectExact(publicId, 'sms_csv');
    });

    it('un corte en lote 500 también cuenta después de haber cerrado una parte', async () => {
      const publicId = await environment.insertJob({ ...XLSX_JOB, batch_size: 500 });
      let parts = 0;
      s3.after('uploadPart', () => { parts += 1; });
      const mortal = createMortal();
      let cuts = 0;
      const db = mortal.db(environment.workerDb, (sql) => {
        if (parts === 1 && DELIVERY_STEP.test(sql)) {
          cuts += 1;
          throw cutError(3024);
        }
      });
      await environment.work({ db });
      // Parte de 1000 tras el cierre: 1000 -> 500 -> corte en el mínimo.
      assert.equal(cuts, 2);
      assert.equal(Number((await environment.jobOf(publicId)).stalls), 1);
    });

    it('un corte en la consulta de nombres se reintenta: ninguna fila pierde el nombre de su envío', async () => {
      const healthy = await environment.insertJob(CSV_JOB);
      await environment.work();
      const expected = csvRows(s3.read(healthy));
      assert.ok(expected.slice(1).some((row) => row[2] !== ''));

      const publicId = await environment.insertJob(CSV_JOB);
      await environment.work({ db: cutOn(DELIVERY_NAMES, 1) });
      assert.equal((await environment.jobOf(publicId)).state, 'finished');
      assert.deepEqual(csvRows(s3.read(publicId)), expected);
    });

    for (const [title, failure] of [
      ['un TypeError', new TypeError('datos')],
      ['un 4xx de S3', Object.assign(new Error('datos'), { name: 'InvalidPart', $metadata: { httpStatusCode: 400 } })],
      ['un id inesperado', new Error('unexpected_id')],
    ]) {
      it(`${title} no se conoce como pasajero: cuenta en stalls, sin abortar`, async () => {
        const publicId = await environment.insertJob(CSV_JOB);
        const db = createMortal().db(environment.workerDb, (sql) => {
          if (DATA_STEP.test(sql)) throw failure;
        });
        const outcome = await environment.work({ db });
        assert.ok(outcome.failure);
        const job = await environment.jobOf(publicId);
        assert.equal(job.state, 'processing');
        assert.equal(Number(job.stalls), 1);
        assert.equal(s3.count('abortUpload'), 0);
      });
    }

    it('un error que se repite termina en stalled al sexto reclamo, y el job siguiente avanza en esa misma corrida', async () => {
      const stuck = await environment.insertJob(CSV_JOB);
      const next = await environment.insertJob({ ...CSV_JOB, id_account: 102 });
      const db = createMortal().db(environment.workerDb, (sql, params) => {
        if (DATA_STEP.test(sql) && Number(params[0]) === 101) throw new TypeError('datos');
      });
      for (let claim = 1; claim <= 5; claim += 1) {
        assert.deepEqual(await environment.work({ db }), { failure: 'TypeError' });
        const job = await environment.jobOf(stuck);
        assert.equal(job.state, 'processing');
        assert.equal(Number(job.stalls), claim);
        assert.equal((await environment.jobOf(next)).state, 'new');
      }
      assert.deepEqual(await environment.work({ db }), {});
      const job = await environment.jobOf(stuck);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'stalled');
      assert.equal((await environment.jobOf(next)).state, 'finished');
    });

    it('lo que no se conoce como pasajero también cuenta después de haber cerrado una parte', async () => {
      const publicId = await environment.insertJob(XLSX_JOB);
      let parts = 0;
      s3.after('uploadPart', () => { parts += 1; });
      const db = createMortal().db(environment.workerDb, (sql) => {
        if (parts === 1 && DELIVERY_STEP.test(sql)) throw new TypeError('datos');
      });
      assert.deepEqual(await environment.work({ db }), { failure: 'TypeError' });
      assert.equal(Number((await environment.jobOf(publicId)).stalls), 1);
    });

    it('un corte al fijar el rango queda contado, y si se repite termina en stalled', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const db = cutOn(CUTOFF, Infinity);
      for (let claim = 1; claim <= 5; claim += 1) {
        await environment.work({ db });
        assert.equal(Number((await environment.jobOf(publicId)).stalls), claim);
      }
      await environment.work({ db });
      assert.equal((await environment.jobOf(publicId)).error_code, 'stalled');
      assert.equal(s3.count('createUpload'), 0);
    });

    for (const failure of [
      ...['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'PROTOCOL_CONNECTION_LOST'].map((code) => ({ code })),
      ...[1040, 1053, 1205, 1213, 4031].map((errno) => ({ errno, code: `ER_${errno}` })),
      ...['SlowDown', 'TimeoutError', 'RequestTimeout', 'ServiceUnavailable', 'InternalError'].map((name) => ({ name })),
      { name: 'OtroDeS3', $metadata: { httpStatusCode: 503 } },
    ]) {
      it(`pasajero conocido: ${JSON.stringify(failure)} no cuenta en stalls`, async () => {
        const publicId = await environment.insertJob(CSV_JOB);
        const db = createMortal().db(environment.workerDb, (sql) => {
          if (DATA_STEP.test(sql)) throw Object.assign(new Error('datos'), failure);
        });
        await environment.work({ db });
        const job = await environment.jobOf(publicId);
        assert.equal(job.state, 'processing');
        assert.equal(Number(job.stalls), 0);
      });
    }

    it('un fallo pasajero termina la corrida sin abortar, sin contar en stalls, y la siguiente sigue', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      for (const failure of [
        Object.assign(new Error('datos'), { code: 'ECONNRESET', errno: -54 }),
        Object.assign(new Error('datos'), { code: 'ER_SERVER_SHUTDOWN', errno: 1053 }),
        Object.assign(new Error('datos'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 }),
      ]) {
        let left = 1;
        const db = createMortal().db(environment.workerDb, (sql) => {
          if (left > 0 && DATA_STEP.test(sql)) {
            left -= 1;
            throw failure;
          }
        });
        assert.deepEqual(await environment.work({ db }), { failure: failure.code });
        const job = await environment.jobOf(publicId);
        assert.equal(job.state, 'processing');
        assert.equal(Number(job.stalls), 0);
      }
      assert.equal(s3.count('abortUpload'), 0);
      await environment.work();
      await expectExact(publicId, 'sms_csv');
    });

    it('SlowDown de S3 termina la corrida sin abortar', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      s3.before('uploadPart', () => {
        throw Object.assign(new Error('SlowDown'), { name: 'SlowDown' });
      });
      assert.deepEqual(await environment.work(), { failure: 'SlowDown' });
      assert.equal((await environment.jobOf(publicId)).state, 'processing');
      assert.equal(s3.count('abortUpload'), 0);
      s3.clearHooks();
      await environment.work();
      await expectExact(publicId, 'sms_csv');
    });

    it('un error de esquema: failed de inmediato, aborta, y registra schema_error', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const db = createMortal().db(environment.workerDb, (sql) => {
        if (DATA_STEP.test(sql)) throw Object.assign(new Error('datos'), { code: 'ER_VIEW_INVALID', errno: 1356 });
      });
      await environment.work({ db });
      const job = await environment.jobOf(publicId);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'schema_error');
      assert.equal(s3.count('abortUpload'), 1);
      assert.ok(logged().some(({ event }) => event === 'schema_error'));
    });

    it('la base se queda callada: al vencer el plazo destruye el pool y termina la corrida', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const proxy = await createTcpProxy(Number(environment.env.port)).listen();
      const db = createDb(workerDbConfig(environment.env, proxy.port));
      try {
        await db.query('SELECT 1');
        let silenced = false;
        const hushed = createMortal().db(db, (sql) => {
          if (!silenced && DATA_STEP.test(sql)) {
            silenced = true;
            proxy.silenceOpenConnections();
          }
        });
        const startedAt = Date.now();
        const outcome = await environment.work({ db: hushed, statementTimeoutMs: 400 });
        assert.deepEqual(outcome, { failure: 'statement_deadline' });
        assert.ok(Date.now() - startedAt < 10000);
        // El pool quedó destruido: no se puede seguir usando por error.
        await db.end();
        const job = await environment.jobOf(publicId);
        assert.equal(job.state, 'processing');
        assert.equal(Number(job.stalls), 1);
      } finally {
        db.destroy();
        await proxy.close();
      }
    });
  });

  describe('fallos inmediatos', () => {
    it('too_many_rows: al pasar de 1.000.000 de filas', async () => {
      const publicId = await environment.insertJob({ ...CSV_JOB, rows_written: 999999 });
      await environment.work();
      const job = await environment.jobOf(publicId);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'too_many_rows');
      assert.equal(s3.count('abortUpload'), 1);
      assert.ok(logged().some(({ event, code }) => event === 'export_failed' && code === 'too_many_rows'));
    });

    it('justo 1.000.000 de filas no falla', async () => {
      const total = (await expectedSmsIds(admin)).length;
      const publicId = await environment.insertJob({ ...CSV_JOB, rows_written: 1000000 - total });
      await environment.work();
      assert.equal((await environment.jobOf(publicId)).state, 'finished');
    });

    it('too_large: el contenido de un XLSX llega a 4 GiB', async () => {
      const publicId = await environment.insertJob({ ...XLSX_JOB, plain_bytes: 2 ** 32 - 1, file_bytes: 100 });
      await environment.work();
      assert.equal((await environment.jobOf(publicId)).error_code, 'too_large');
    });

    it('too_old: más de 12 h desde que se pidió', async () => {
      const publicId = await environment.insertJob({ ...CSV_JOB, created_at: '2026-09-24 23:59:59' });
      await environment.work();
      const job = await environment.jobOf(publicId);
      assert.equal(job.error_code, 'too_old');
      assert.equal(s3.count('createUpload'), 0);
    });

    it('justo en 12 h todavía corre', async () => {
      const publicId = await environment.insertJob({ ...CSV_JOB, created_at: '2026-09-25 00:00:00' });
      await environment.work();
      assert.equal((await environment.jobOf(publicId)).state, 'finished');
    });

    it('too_long: más de 2 h de trabajo, y aborta la carga que había', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const mortal = createMortal();
      let batches = 0;
      const db = mortal.db(environment.workerDb, (sql) => {
        if (DATA_STEP.test(sql) && ++batches === 2) mortal.kill();
      });
      await environment.work({ db, storage: mortal.storage(s3.storage) });
      await admin.query('UPDATE connectus_pages.export_job SET work_ms = ? WHERE public_id = ?', [2 * 3600000 + 1, publicId]);
      await environment.work();
      const job = await environment.jobOf(publicId);
      assert.equal(job.error_code, 'too_long');
      assert.equal(s3.count('abortUpload'), 1);
    });

    it('stalled: 5 muertes seguidas sin cerrar una parte, pero con 4 todavía corre', async () => {
      const dead = await environment.insertJob({ ...CSV_JOB, stalls: 5 });
      await environment.work();
      assert.equal((await environment.jobOf(dead)).error_code, 'stalled');

      const alive = await environment.insertJob({ ...CSV_JOB, stalls: 4 });
      await environment.work();
      assert.equal((await environment.jobOf(alive)).state, 'finished');
    });

    it('muriendo una y otra vez sin avanzar, termina en stalled', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const mortal = createMortal();
        const db = mortal.db(environment.workerDb, (sql) => {
          if (DATA_STEP.test(sql)) mortal.kill();
        });
        await environment.work({ db, storage: mortal.storage(s3.storage) });
      }
      assert.equal(Number((await environment.jobOf(publicId)).stalls), 5);
      await environment.work();
      assert.equal((await environment.jobOf(publicId)).error_code, 'stalled');
    });

    it('sin permiso en S3: failed, sin insistir', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      s3.before('uploadPart', () => {
        throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      });
      await environment.work();
      assert.equal((await environment.jobOf(publicId)).error_code, 'storage_denied');
    });

    it('un abort que devuelve 404 no impide marcar el fallo', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const mortal = createMortal();
      s3.after('uploadPart', () => mortal.kill());
      await environment.work({ db: mortal.db(environment.workerDb), storage: mortal.storage(s3.storage) });
      s3.clearHooks();
      s3.before('abortUpload', () => {
        throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' });
      });
      await admin.query('UPDATE connectus_pages.export_job SET stalls = 5 WHERE public_id = ?', [publicId]);
      await environment.work();
      assert.equal((await environment.jobOf(publicId)).error_code, 'stalled');
    });
  });

  describe('ventana de silencio', () => {
    const QUIET = parseQuietWindows('08:00-09:00');
    // 08:30 de Chile, en septiembre (UTC-3) y a mediodía del job.
    const INSIDE = Date.parse('2026-09-25T11:30:00Z');
    const OUTSIDE = Date.parse('2026-09-25T12:30:00Z');

    it('ausente o malformada: el handler no lee nada y lanza', async () => {
      for (const windows of [undefined, '', 'siempre', '25:00-26:00', '08:00-08:00', '8:00-9:00', '08:00-09:00,', ' none']) {
        const openDb = mock.fn();
        const worker = createWorkerHandler({
          openDb,
          openStorage: () => s3.storage,
          load: () => require('../../src/worker/config').loadWorkerConfig({
            env: {
              STAGE: 'local',
              DB_HOST: environment.env.host,
              DB_PORT: environment.env.port,
              WORKER_DB_USER: environment.env.workerUser,
              WORKER_DB_PASSWORD: environment.env.workerPassword,
              DB_SSL_CA_FILE: environment.env.caFile,
              WORKER_QUIET_WINDOWS: windows,
            },
          }),
        });
        await assert.rejects(worker({}, { getRemainingTimeInMillis: () => 800000 }), /^Error: config_/);
        assert.equal(openDb.mock.callCount(), 0);
      }
    });

    it('none: corre', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      await environment.work({ quietWindows: parseQuietWindows('none'), clock: () => INSIDE });
      assert.equal((await environment.jobOf(publicId)).state, 'finished');
    });

    it('dentro de la ventana: no toca el job ni limpia nada', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const statements = [];
      const db = createMortal().db(environment.workerDb, (sql) => { statements.push(sql); });
      await environment.work({ db, quietWindows: QUIET, clock: () => INSIDE });
      assert.equal(statements.length, 0);
      const job = await environment.jobOf(publicId);
      assert.equal(job.state, 'new');
      assert.equal(Number(job.stalls), 0);
    });

    for (const kind of Object.keys(JOBS)) {
      it(`${kind}: entra a mitad de corrida, sale sin contar stalls, y al volver no repite ni pierde`, async () => {
        const publicId = await environment.insertJob({ ...JOBS[kind], batch_size: 500 });
        let nowMs = OUTSIDE;
        let batches = 0;
        const db = createMortal().db(environment.workerDb, (sql) => {
          if (BATCH_STEP.test(sql) && ++batches === 2) nowMs = INSIDE;
        });
        await environment.work({ db, quietWindows: QUIET, clock: () => nowMs });
        const paused = await environment.jobOf(publicId);
        assert.equal(paused.state, 'processing');
        assert.equal(Number(paused.stalls), 0);
        assert.equal(batches, 2, 'no lee otro lote');
        if (kind === 'sms_csv') {
          // El CSV no puede cerrar lo que lleva: se vuelve a leer.
          assert.equal(Number(paused.last_id), 0);
          assert.equal(s3.count('uploadPart'), 0);
        } else {
          // El XLSX cierra rellenando hasta el mínimo, para no perder lo leído.
          assert.ok(Number(paused.last_id) > 0);
          assert.equal(s3.count('uploadPart'), 1);
          assert.ok(s3.calls.find(({ operation }) => operation === 'uploadPart').input.body.length >= MIN_PART_BYTES);
        }

        await environment.work({ quietWindows: QUIET, clock: () => OUTSIDE });
        await expectExact(publicId, kind);
      });
    }

    it('se revisa antes de cada lote, también con prefijo de día', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      await environment.work({ quietWindows: parseQuietWindows('d25:08:00-09:00'), clock: () => INSIDE });
      assert.equal((await environment.jobOf(publicId)).state, 'new');
      await environment.work({ quietWindows: parseQuietWindows('d24:08:00-09:00'), clock: () => INSIDE });
      assert.equal((await environment.jobOf(publicId)).state, 'finished');
    });
  });

  describe('guarda de la corrida', () => {
    function remainingAfter(batchesAllowed) {
      let batches = 0;
      return {
        db: createMortal().db(environment.workerDb, (sql) => {
          if (BATCH_STEP.test(sql)) batches += 1;
        }),
        remainingMs: () => (batches >= batchesAllowed ? 59000 : 800000),
      };
    }

    it('CSV: descarta lo no cerrado, sin contar stalls, y la siguiente corrida relee', async () => {
      const publicId = await environment.insertJob({ ...CSV_JOB, batch_size: 500 });
      await environment.work(remainingAfter(1));
      const job = await environment.jobOf(publicId);
      assert.equal(Number(job.last_id), 0);
      assert.equal(Number(job.stalls), 0);
      assert.ok(Number(job.work_ms) >= 0);
      await environment.work();
      await expectExact(publicId, 'sms_csv');
    });

    it('XLSX: rellena con bloques vacíos hasta 5 MiB; el archivo sigue siendo válido y exacto', async () => {
      const publicId = await environment.insertJob({ ...XLSX_JOB, batch_size: 500 });
      await environment.work(remainingAfter(1));
      const job = await environment.jobOf(publicId);
      assert.equal(Number(job.next_part), 2);
      assert.equal(Number(job.stalls), 0);
      assert.ok(Number(job.file_bytes) >= MIN_PART_BYTES);
      assert.ok(Number(job.rows_written) === 500, 'lo leído quedó guardado');
      await environment.work();
      await expectExact(publicId, 'delivery_xlsx');
    });

    function timedRun(msPerData, onPause) {
      const clock = { ms: 0, pauses: [] };
      const db = createMortal().db(environment.workerDb, (sql) => {
        if (DATA_STEP.test(sql)) clock.ms += msPerData;
      });
      return {
        clock,
        options: {
          db,
          now: () => clock.ms,
          sleep: async (ms) => {
            clock.pauses.push(ms);
            onPause?.(clock);
          },
        },
      };
    }

    it('la pausa es 3 veces el lote, con un mínimo de 250 ms', async () => {
      await environment.insertJob({ ...CSV_JOB, batch_size: 500 });
      const quick = timedRun(0);
      await environment.work(quick.options);
      assert.ok(quick.clock.pauses.every((ms) => ms === 250));
      await admin.query('DELETE FROM connectus_pages.export_job');

      await environment.insertJob({ ...CSV_JOB, batch_size: 500 });
      const steady = timedRun(1000);
      await environment.work(steady.options);
      assert.ok(steady.clock.pauses.length > 0);
      assert.ok(steady.clock.pauses.every((ms) => ms === 3000));
    });

    it('un lote de más de 5 s pausa 60 s', async () => {
      await environment.insertJob({ ...CSV_JOB, batch_size: 500 });
      const slow = timedRun(5001);
      await environment.work(slow.options);
      assert.ok(slow.clock.pauses.length > 0);
      assert.ok(slow.clock.pauses.every((ms) => ms === 60000));
    });

    it('sin cerrar ninguna parte y con más de 6 min, la pausa es 1 vez el lote, hasta que cierre una', async () => {
      await environment.insertJob({ ...CSV_JOB, batch_size: 500 });
      const timed = timedRun(2000, (clock) => {
        if (clock.pauses.length === 1) clock.ms += 7 * 60000;
      });
      let parts = 0;
      s3.after('uploadPart', () => { parts += 1; });
      await environment.work(timed.options);
      assert.ok(parts > 1);
      assert.deepEqual(timed.clock.pauses.slice(0, 2), [6000, 2000]);
      assert.equal(timed.clock.pauses.at(-1), 6000);
    });

    it('la pausa nunca se come la guarda', async () => {
      await environment.insertJob({ ...CSV_JOB, batch_size: 500 });
      const pauses = [];
      await environment.work({
        remainingMs: () => 60100,
        sleep: async (ms) => { pauses.push(ms); },
      });
      assert.ok(pauses.length > 0);
      assert.ok(pauses.every((ms) => ms <= 100));
    });
  });

  describe('limpieza', () => {
    it('borra lo viejo a lo sumo una vez por hora, con los permisos de pages_worker', async () => {
      const old = await environment.insertJob({ state: 'finished', created_at: '2026-09-18 11:59:59' });
      const recent = await environment.insertJob({ state: 'finished', created_at: '2026-09-18 12:00:01' });
      await admin.query(`INSERT INTO connectus_pages.delivery_stats (id_delivery, id_account, next_step_at, updated_at)
        VALUES (800001, 101, '2026-08-01 00:00:00', '2026-08-26 11:59:59'), (800002, 101, '2026-08-01 00:00:00', '2026-08-26 12:00:01')`);
      await admin.query(`INSERT INTO connectus_pages.audit_log (action, created_at) VALUES ('limpieza_vieja', '2025-09-01 00:00:00')`);
      const schedule = { lastCleanupMs: -Infinity };
      try {
        await environment.work({ schedule });
        assert.equal(await environment.jobOf(old), undefined);
        assert.ok(await environment.jobOf(recent));
        const [stats] = await admin.query('SELECT id_delivery FROM connectus_pages.delivery_stats WHERE id_delivery >= 800001 ORDER BY id_delivery');
        assert.deepEqual(stats.map((row) => row.id_delivery), [800002]);
        const [audit] = await admin.query("SELECT id FROM connectus_pages.audit_log WHERE action = 'limpieza_vieja'");
        assert.equal(audit.length, 0);

        const late = await environment.insertJob({ state: 'finished', created_at: '2026-09-01 00:00:00' });
        await environment.work({ schedule });
        assert.ok(await environment.jobOf(late), 'dentro de la misma hora no vuelve a limpiar');
        await environment.work({ schedule, clock: () => Date.parse('2026-09-25T13:00:00Z') });
        assert.equal(await environment.jobOf(late), undefined);
      } finally {
        await admin.query('DELETE FROM connectus_pages.delivery_stats WHERE id_delivery >= 800001');
      }
    });

    it('un fallo al limpiar no impide trabajar', async () => {
      const publicId = await environment.insertJob(CSV_JOB);
      const db = createMortal().db(environment.workerDb, (sql) => {
        if (/purge_audit_log/.test(sql)) throw Object.assign(new Error('datos'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 });
      });
      await environment.work({ db });
      assert.equal((await environment.jobOf(publicId)).state, 'finished');
      assert.ok(logged().some(({ event }) => event === 'cleanup_failed'));
    });
  });

  describe('consola', () => {
    it('un job con número que falla no deja sus dígitos en consola, ni en el error que lanza el handler', async () => {
      const number = 56911100098;
      const stdout = mock.method(console, 'log', () => {});
      await environment.insertJob({ ...CSV_JOB, dst_number: number });
      // Igual que mysql2: el mensaje y el sql traen el número interpolado.
      const leaky = Object.assign(new Error(`Fallo con dst_number = ${number}`), {
        code: 'ER_LOCK_WAIT_TIMEOUT',
        errno: 1205,
        sql: `SELECT * FROM x WHERE dst_number = ${number}`,
      });
      const worker = createWorkerHandler({
        load: async () => ({ quietWindows: [] }),
        openDb: () => {
          const db = createMortal().db(environment.workerDb, (sql) => {
            if (/sms_de_numero/.test(sql)) throw leaky;
          });
          return { ...db, end: async () => {} };
        },
        openStorage: () => s3.storage,
        clock: () => Date.parse('2026-09-25T12:00:00Z'),
        sleep: async () => {},
      });
      try {
        const error = await worker({}, { getRemainingTimeInMillis: () => 800000 }).catch((thrown) => thrown);
        assert.equal(error.message, 'ER_LOCK_WAIT_TIMEOUT');
        assert.deepEqual(Object.keys(error), []);
        assert.equal(error.sql, undefined);
        const printed = JSON.stringify([consoleError.mock.calls, stdout.mock.calls].flat().map((call) => call.arguments));
        assert.ok(!printed.includes(String(number)), 'los dígitos del número');
        assert.ok(printed.includes('worker_failed'));
      } finally {
        stdout.mock.restore();
      }
    });

    it('un error real de mysql2 tampoco deja datos en consola', async () => {
      const number = 56911100097;
      const publicId = await environment.insertJob({ ...CSV_JOB, dst_number: number });
      const db = createMortal().db(environment.workerDb, async (sql, params) => {
        // Una sentencia que el servidor rechaza de verdad, con el número en su texto: pages_worker no ve esta tabla.
        if (/sms_de_numero/.test(sql)) await environment.workerDb.query(`SELECT * FROM connectus_pages.login WHERE id = ${params[3]}`);
      });
      await environment.work({ db });
      const job = await environment.jobOf(publicId);
      assert.equal(job.error_code, 'schema_error');
      assert.ok(!JSON.stringify(consoleError.mock.calls.map((call) => call.arguments)).includes(String(number)));
    });
  });
});
