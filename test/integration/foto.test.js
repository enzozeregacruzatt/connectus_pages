'use strict';

// La foto de conteos contra el mysqld desechable, con pages_app y sus permisos de verdad. Requiere scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it, mock } = require('node:test');

const { createDb } = require('../../src/db');
const { restEvent, startEnvironment, uniqueOf } = require('./support/envios_env');

const ACCOUNT = '101';
// Ver la cabecera del fixture.
const BIG = 1;
const LINKS_BY_SMS = 3;
const UNIQUE_LINK = 8;
const SMALL = 13;
const DELIVERIES = [BIG, LINKS_BY_SMS, UNIQUE_LINK, SMALL];
const DAY_MS = 86400000;
const CHILE_OFFSET_MS = 3 * 3600000;
const MAX_STEPS = 200;
const COUNT_STEP = /GROUP BY status, dst_provider, dst_country/;
const SUM_LINKS = /FROM connectus_pages\.link_de_sms/;
const LAST_ROW = /FROM connectus_pages\.sms_de_envio .*ORDER BY id DESC LIMIT 1/;

const cutError = (errno) => Object.assign(new Error(`corte con datos ${errno}`), { errno, code: `ER_${errno}` });

// A este reloj el envío grande tiene menos de 4 días: una foto recién tomada no se recalcula.
const NEAR = '2026-11-02T12:00:00Z';

describe('foto de conteos', () => {
  let environment;
  let admin;
  let token;
  let baseMs;

  const clockFromBase = (days) => new Date(baseMs + days * DAY_MS + CHILE_OFFSET_MS).toISOString();
  const textOf = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

  // El token dura 1 hora: uno para cada reloj de estas pruebas.
  async function statsAt(isoTime, deliveryId) {
    return stats(environment.handlerAt(isoTime), deliveryId, await environment.tokenAt(isoTime));
  }

  function get(handler, deliveryId, usingToken = token) {
    return handler(restEvent('/api/delivery/stats', usingToken, { account: ACCOUNT, id: uniqueOf(deliveryId) }));
  }

  async function stats(handler, deliveryId, usingToken) {
    const response = await get(handler, deliveryId, usingToken);
    assert.equal(response.statusCode, 200, response.body);
    return JSON.parse(response.body);
  }

  async function row(deliveryId) {
    const [[found]] = await admin.query('SELECT * FROM connectus_pages.delivery_stats WHERE id_delivery = ?', [deliveryId]);
    return found;
  }

  const update = (deliveryId, set) => admin.query(`UPDATE connectus_pages.delivery_stats SET ${set} WHERE id_delivery = ?`, [deliveryId]);
  const freeNextStep = (deliveryId) => update(deliveryId, 'next_step_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND');

  // Cada petición avanza un tramo. Se salta la pausa entre tramos, que aquí solo alargaría la prueba.
  async function runUntilReady(handler, deliveryId) {
    const seen = [];
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const body = await stats(handler, deliveryId);
      seen.push(body);
      if (body.state === 'ready') return { body, seen };
      await freeNextStep(deliveryId);
    }
    throw new Error('la foto no terminó');
  }

  async function expectedCounts(deliveryId) {
    const [rows] = await admin.query(
      'SELECT status, dst_provider, dst_country, COUNT(*) AS n FROM dbconnectus.sms_outgoing '
      + 'WHERE id_delivery = ? AND id_account = ? GROUP BY status, dst_provider, dst_country',
      [deliveryId, ACCOUNT]
    );
    return rows.map((item) => ({ ...item, n: Number(item.n) }));
  }

  function assertPublishedTotal(body, total) {
    assert.equal(body.national.totals.total + body.international.totals.total, total);
    assert.equal(body.chart.reduce((sum, slice) => sum + slice.value, 0), total);
    for (const table of [body.national, body.international]) {
      assert.equal(table.rows.reduce((sum, item) => sum + item.total, 0), table.totals.total);
      assert.equal(table.totals.cells.reduce((sum, value) => sum + value, 0), table.totals.total);
      for (const item of table.rows) {
        assert.equal(item.cells.reduce((sum, value) => sum + value, 0), item.total);
        for (const value of item.cells) assert.equal(typeof value, 'number');
      }
    }
  }

  async function assertExactPhoto(deliveryId, body) {
    const expected = await expectedCounts(deliveryId);
    assertPublishedTotal(body, expected.reduce((sum, item) => sum + item.n, 0));
    const published = (await row(deliveryId)).counts;
    const key = (item) => JSON.stringify([item.status, item.provider ?? item.dst_provider, item.country ?? item.dst_country]);
    assert.deepEqual(
      new Map(published.map((item) => [key(item), item.n])),
      new Map(expected.map((item) => [key(item), item.n]))
    );
    for (const item of published) assert.equal(typeof item.n, 'number', 'n numérico, no texto');
  }

  before(async () => {
    environment = await startEnvironment('api_foto', [101]);
    admin = environment.admin;
    token = await environment.tokenAt(NEAR);
    const [[{ created_at: last }]] = await admin.query(
      'SELECT created_at FROM dbconnectus.sms_outgoing WHERE id_delivery = ? AND id_account = ? ORDER BY id DESC LIMIT 1',
      [BIG, ACCOUNT]
    );
    baseMs = Date.parse(`${last.replace(' ', 'T')}Z`);
  });

  beforeEach(() => admin.query('DELETE FROM connectus_pages.delivery_stats WHERE id_delivery IN (?)', [DELIVERIES]));

  after(async () => {
    await admin.query('DELETE FROM connectus_pages.delivery_stats WHERE id_delivery IN (?)', [DELIVERIES]);
    await environment.stop();
  });

  describe('publicación', () => {
    it('un envío de más de un tramo publica el total exacto, con sumas numéricas', async () => {
      const handler = environment.handlerAt(NEAR);
      const { body, seen } = await runUntilReady(handler, BIG);
      assert.ok(seen.length > 1, 'más de un tramo');
      assert.ok(seen.slice(0, -1).every((item) => item.state === 'computing'));
      assert.ok(seen.slice(0, -1).every((item) => item.national === null && item.updatedAt === null), 'sin foto anterior');
      const progress = seen.slice(0, -1).map((item) => item.progressRows);
      assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
      assert.ok(new Set(progress).size === progress.length, 'el avance sube en cada tramo');
      assert.ok(progress.every((rows) => Number.isInteger(rows)));
      await assertExactPhoto(BIG, body);
    });

    it('cada tramo deja la pausa en next_step_at, y responde cuánto falta', async () => {
      const body = await stats(environment.handlerAt(NEAR), BIG);
      assert.equal(body.state, 'computing');
      assert.ok(body.retryAfterMs > 0 && body.retryAfterMs <= 60000, String(body.retryAfterMs));
      const next = await stats(environment.handlerAt(NEAR), BIG);
      assert.equal(next.progressRows, body.progressRows, 'dentro de la pausa nadie trabaja');
    });

    it('publica con counted_at = work_started_at y deja el trabajo reiniciado', async () => {
      const handler = environment.handlerAt(NEAR);
      await stats(handler, BIG);
      const started = (await row(BIG)).work_started_at;
      assert.ok(started);
      await update(BIG, "work_started_at = '2026-11-01 10:00:00'");
      await freeNextStep(BIG);
      await runUntilReady(handler, BIG);
      const published = await row(BIG);
      assert.equal(published.counted_at, '2026-11-01 10:00:00');
      assert.deepEqual(
        [published.work_phase, published.work_step, published.work_last_id, published.work_rows],
        ['idle', 5000, 0, 0]
      );
      assert.deepEqual(
        [published.work_counts, published.work_links_distinct, published.work_clicks_sum, published.work_started_at, published.failed_at],
        [null, null, null, null, null]
      );
    });

    it('la fila mezclada, con id_delivery de la cuenta y otra id_account, no entra', async () => {
      const handler = environment.handlerAt(NEAR);
      const { body } = await runUntilReady(handler, BIG);
      const [[{ all, own }]] = await admin.query(
        'SELECT COUNT(*) AS `all`, SUM(id_account = 101) AS own FROM dbconnectus.sms_outgoing WHERE id_delivery = ?',
        [BIG]
      );
      assert.ok(Number(all) > Number(own), 'el fixture trae filas mezcladas');
      assert.equal(body.national.totals.total + body.international.totals.total, Number(own));
    });

    it('la foto recién publicada se entrega sin leer sms_outgoing', async () => {
      const handler = environment.handlerAt(NEAR);
      await runUntilReady(handler, SMALL);
      const before = await row(SMALL);
      const body = await stats(handler, SMALL);
      assert.equal(body.state, 'ready');
      assert.match(body.updatedAt, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
      assert.equal((await row(SMALL)).next_step_at, before.next_step_at, 'no se reclamó');
    });
  });

  describe('pantallas concurrentes', () => {
    let pools;

    beforeEach(() => {
      pools = [createDb(environment.config), createDb(environment.config), createDb(environment.config)];
    });

    afterEach(async () => {
      await Promise.all(pools.map((pool) => pool.end()));
    });

    it('varias a la vez no duplican filas', async () => {
      const handlers = pools.map((pool) => environment.handlerAt(NEAR, pool));
      let last;
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const bodies = await Promise.all(handlers.map((handler) => stats(handler, BIG)));
        last = bodies.find((body) => body.state === 'ready');
        if (last) break;
        await freeNextStep(BIG);
      }
      assert.ok(last, 'la foto no terminó');
      await assertExactPhoto(BIG, await stats(handlers[0], BIG));
    });

    it('la primera vez, dos a la vez crean una sola fila', async () => {
      const handlers = pools.map((pool) => environment.handlerAt(NEAR, pool));
      // El choque en el INSERT no sale siempre.
      for (let round = 0; round < 25; round += 1) {
        await admin.query('DELETE FROM connectus_pages.delivery_stats WHERE id_delivery = ?', [SMALL]);
        const responses = await Promise.allSettled(handlers.map((handler) => get(handler, SMALL)));
        for (const { value } of responses) assert.equal(value.statusCode, 200, value.body);
        assert.ok(responses.some(({ value }) => JSON.parse(value.body).state === 'ready'));
        const [[{ n }]] = await admin.query('SELECT COUNT(*) AS n FROM connectus_pages.delivery_stats WHERE id_delivery = ?', [SMALL]);
        assert.equal(Number(n), 1);
      }
      await assertExactPhoto(SMALL, await stats(handlers[0], SMALL));
    });
  });

  // Un escritor que sigue vivo cuando otro ya retomó su trabajo.
  function slowDb(pattern, whileSlow) {
    const { db } = environment;
    let pending = true;
    return {
      ...db,
      async query(sql, params) {
        const rows = await db.query(sql, params);
        if (pending && pattern.test(sql)) {
          pending = false;
          await whileSlow();
        }
        return rows;
      },
    };
  }

  describe('escritor tardío', () => {
    it('se descarta si el trabajo es otro', async () => {
      const newer = '2026-11-01 11:00:00';
      const handler = environment.handlerAt(NEAR, slowDb(COUNT_STEP, () => update(BIG, `work_started_at = '${newer}'`)));
      await stats(handler, BIG);
      const found = await row(BIG);
      assert.equal(found.work_started_at, newer);
      assert.deepEqual([found.work_last_id, found.work_rows, found.work_counts], [0, 0, null]);
    });

    it('se descarta al publicar', async () => {
      const newer = '2026-11-01 11:00:00';
      const body = await stats(environment.handlerAt(NEAR, slowDb(COUNT_STEP, () => update(SMALL, `work_started_at = '${newer}'`))), SMALL);
      assert.equal(body.state, 'computing');
      const found = await row(SMALL);
      assert.equal(found.counted_at, null);
      assert.equal(found.work_started_at, newer);
    });

    it('el del primer tramo no pisa a quien ya pasó a la fase de links, con work_last_id otra vez en 0', async () => {
      // El envío tiene un solo tramo de conteo: el otro lo termina completo mientras este sigue leyendo.
      const other = environment.handlerAt(NEAR);
      const slow = environment.handlerAt(NEAR, slowDb(COUNT_STEP, async () => {
        await freeNextStep(UNIQUE_LINK);
        await stats(other, UNIQUE_LINK);
        const found = await row(UNIQUE_LINK);
        assert.deepEqual([found.work_phase, found.work_last_id], ['links', 0]);
      }));
      await stats(slow, UNIQUE_LINK);
      const found = await row(UNIQUE_LINK);
      assert.equal(found.work_phase, 'links', 'el escritor tardío no la devolvió a counts');
      await freeNextStep(UNIQUE_LINK);
      await assertExactPhoto(UNIQUE_LINK, (await runUntilReady(other, UNIQUE_LINK)).body);
    });
  });

  describe('trabajo a medias', () => {
    it('retomar uno abandonado lo reinicia', async () => {
      const handler = environment.handlerAt(NEAR);
      await stats(handler, BIG);
      await update(BIG, 'work_step = 1000');
      await freeNextStep(BIG);
      await stats(handler, BIG);
      await freeNextStep(BIG);
      const halfway = await row(BIG);
      assert.ok(halfway.work_rows > 0);
      await update(BIG, "updated_at = UTC_TIMESTAMP() - INTERVAL 11 MINUTE, work_started_at = '2026-11-01 09:00:00'");

      const body = await stats(handler, BIG);
      const retaken = await row(BIG);
      assert.notEqual(retaken.work_started_at, '2026-11-01 09:00:00');
      assert.ok(retaken.work_last_id < halfway.work_last_id, 'volvió a empezar');
      assert.equal(body.progressRows, retaken.work_rows);
      await freeNextStep(BIG);
      await assertExactPhoto(BIG, (await runUntilReady(handler, BIG)).body);
    });

    it('uno que se movió hace poco sigue donde iba', async () => {
      const handler = environment.handlerAt(NEAR);
      await stats(handler, BIG);
      await freeNextStep(BIG);
      await update(BIG, 'work_step = 1000, updated_at = UTC_TIMESTAMP() - INTERVAL 9 MINUTE');
      const first = await row(BIG);
      await stats(handler, BIG);
      const next = await row(BIG);
      assert.equal(next.work_started_at, first.work_started_at);
      assert.ok(next.work_rows > first.work_rows);
    });

    it('la guarda de 8 s no reclama, ni escribe un tramo', async () => {
      const app = environment.appAt(NEAR);
      const request = {
        method: 'GET',
        path: '/api/delivery/stats',
        headers: { authorization: `Bearer ${token}` },
        query: { account: [ACCOUNT], id: [uniqueOf(BIG)] },
      };
      const late = await app.handle({ ...request, startedAtMs: performance.now() - 8001 });
      assert.equal(JSON.parse(late.body).state, 'computing');
      assert.equal((await row(BIG)).work_phase, 'idle');

      const inTime = await app.handle({ ...request, startedAtMs: performance.now() - 7000 });
      assert.equal(JSON.parse(inTime.body).state, 'computing');
      assert.equal((await row(BIG)).work_phase, 'counts');
    });
  });

  describe('cortes', () => {
    function cuttingDb(pattern, errno) {
      const { db } = environment;
      return {
        ...db,
        query(sql, params) {
          return pattern.test(sql) ? Promise.reject(cutError(errno)) : db.query(sql, params);
        },
      };
    }

    for (const errno of [3024, 1028, 1317]) {
      it(`un ${errno} baja work_step a la mitad, sin avanzar, y publicar lo restablece`, async () => {
        const handler = environment.handlerAt(NEAR, cuttingDb(COUNT_STEP, errno));
        const body = await stats(handler, BIG);
        assert.equal(body.state, 'computing');
        const found = await row(BIG);
        assert.deepEqual([found.work_step, found.work_last_id, found.work_rows], [2500, 0, 0]);
        await freeNextStep(BIG);

        const healthy = environment.handlerAt(NEAR);
        await stats(healthy, BIG);
        assert.ok((await row(BIG)).work_rows <= 2500, 'el tramo siguiente usa el tamaño nuevo');
        await freeNextStep(BIG);
        await assertExactPhoto(BIG, (await runUntilReady(healthy, BIG)).body);
        assert.equal((await row(BIG)).work_step, 5000);
      });
    }

    it('un corte de verdad del servidor, con el hint al mínimo, llega como corte', async () => {
      const { db } = environment;
      const shortened = {
        ...db,
        query(sql, params) {
          if (!COUNT_STEP.test(sql)) return db.query(sql, params);
          const slow = sql.replace('MAX_EXECUTION_TIME(8000)', 'MAX_EXECUTION_TIME(1)')
            .replace(' GROUP BY', ' AND SLEEP(0.02) = 0 GROUP BY');
          return db.query(slow, params);
        },
      };
      await stats(environment.handlerAt(NEAR, shortened), BIG);
      assert.equal((await row(BIG)).work_step, 2500);
    });

    it('baja hasta 500, y bajo eso falla sin borrar la foto anterior', async () => {
      const healthy = environment.handlerAt(NEAR);
      const { body: photo } = await runUntilReady(healthy, BIG);
      await update(BIG, 'counted_at = UTC_TIMESTAMP() - INTERVAL 11 MINUTE');

      const cutting = environment.handlerAt(NEAR, cuttingDb(COUNT_STEP, 3024));
      const steps = [];
      for (let step = 0; step < 4; step += 1) {
        const body = await stats(cutting, BIG);
        assert.equal(body.state, 'computing');
        assert.deepEqual(body.national, photo.national, 'entrega la foto anterior');
        steps.push((await row(BIG)).work_step);
        await freeNextStep(BIG);
      }
      assert.deepEqual(steps, [2500, 1250, 625, 500]);

      const failed = await stats(cutting, BIG);
      assert.equal(failed.state, 'failed');
      assert.deepEqual(failed.national, photo.national);
      const found = await row(BIG);
      assert.ok(found.failed_at);
      assert.deepEqual(
        [found.work_phase, found.work_step, found.work_last_id, found.work_rows, found.work_counts, found.work_started_at],
        ['idle', 5000, 0, 0, null, null]
      );
      assert.ok(found.counts.length > 0);

      // Por 10 minutos no se recalcula.
      const paused = await stats(healthy, BIG);
      assert.equal(paused.state, 'failed');
      assert.equal((await row(BIG)).work_phase, 'idle');

      await update(BIG, 'failed_at = UTC_TIMESTAMP() - INTERVAL 11 MINUTE');
      assert.equal((await stats(healthy, BIG)).state, 'computing');
      await freeNextStep(BIG);
      assert.equal((await runUntilReady(healthy, BIG)).body.state, 'ready');
      assert.equal((await row(BIG)).failed_at, null);
    });

    it('sin foto anterior, el fallo responde sin tablas', async () => {
      const cutting = environment.handlerAt(NEAR, cuttingDb(COUNT_STEP, 3024));
      await stats(cutting, SMALL);
      await update(SMALL, 'work_step = 500');
      await freeNextStep(SMALL);
      const body = await stats(cutting, SMALL);
      assert.equal(body.state, 'failed');
      assert.deepEqual([body.national, body.international, body.chart, body.updatedAt], [null, null, null, null]);
    });

    it('en la fase de links, un corte también achica el tramo, que parte en 2.000', async () => {
      const cutting = environment.handlerAt(NEAR, cuttingDb(SUM_LINKS, 3024));
      const healthy = environment.handlerAt(NEAR);
      while ((await row(LINKS_BY_SMS))?.work_phase !== 'links') {
        await stats(healthy, LINKS_BY_SMS);
        await freeNextStep(LINKS_BY_SMS);
      }
      await stats(cutting, LINKS_BY_SMS);
      assert.equal((await row(LINKS_BY_SMS)).work_step, 1000);
    });

    it('otro error no se toma como corte, y responde sin datos en la consola', async () => {
      const failure = Object.assign(new Error('datos 56900000001'), { errno: 1146, code: 'ER_NO_SUCH_TABLE' });
      const { db } = environment;
      const broken = { ...db, query: (sql, params) => (COUNT_STEP.test(sql) ? Promise.reject(failure) : db.query(sql, params)) };
      const spy = mock.method(console, 'error', () => {});
      const response = await get(environment.handlerAt(NEAR, broken), BIG);
      const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
      spy.mock.restore();
      assert.equal(response.statusCode, 500);
      assert.equal(logged, JSON.stringify({ event: 'schema_error', code: 'ER_NO_SUCH_TABLE' }));
      assert.equal((await row(BIG)).work_step, 5000);
    });
  });

  describe('vigencia', () => {
    async function withPhoto(deliveryId, countedAtSql) {
      await runUntilReady(environment.handlerAt(NEAR), deliveryId);
      await update(deliveryId, `counted_at = ${countedAtSql}`);
    }

    const ago = (amount) => `UTC_TIMESTAMP() - INTERVAL ${amount}`;

    for (const [title, days, age, stale] of [
      ['menos de 4 días, foto de 9 minutos', 1, '9 MINUTE', false],
      ['menos de 4 días, foto de 11 minutos', 1, '11 MINUTE', true],
      ['base en el futuro, foto de 11 minutos', -2, '11 MINUTE', true],
      ['de 4 a 15 días, foto de 5 horas', 5, '5 HOUR', false],
      ['de 4 a 15 días, foto de 7 horas', 5, '7 HOUR', true],
    ]) {
      it(`${title}: ${stale ? 'recalcula' : 'la usa'}`, async () => {
        await withPhoto(BIG, ago(age));
        const body = await statsAt(clockFromBase(days), BIG);
        assert.equal(body.state, stale ? 'computing' : 'ready');
        assert.equal((await row(BIG)).work_phase, stale ? 'counts' : 'idle');
        assert.notEqual(body.national, null);
      });
    }

    // deliver_at es de hace más de 15 días, y la última fila, de hace 2: con la fecha programada, esta foto ya contaría como fija.
    it('la base es la última fila y no deliver_at', async () => {
      await withPhoto(BIG, ago('11 MINUTE'));
      assert.equal((await statsAt(clockFromBase(2), BIG)).state, 'computing');
    });

    it('más de 15 días, con una foto tomada antes del plazo: la foto vieja se recalcula', async () => {
      await withPhoto(BIG, `'${textOf(baseMs + 10 * DAY_MS)}'`);
      const body = await statsAt(clockFromBase(20), BIG);
      assert.equal(body.state, 'computing');
      assert.equal((await row(BIG)).work_phase, 'counts');
    });

    it('más de 15 días, con una foto tomada después del plazo: queda fija, aunque pasen meses', async () => {
      await withPhoto(BIG, `'${textOf(baseMs + 17 * DAY_MS)}'`);
      const before = await row(BIG);
      const body = await statsAt(clockFromBase(200), BIG);
      assert.equal(body.state, 'ready');
      const after = await row(BIG);
      assert.equal(after.work_phase, 'idle');
      assert.equal(after.next_step_at, before.next_step_at);
    });

    it('un recálculo que publica responde ready, aunque la foto siga dentro del plazo', async () => {
      await withPhoto(SMALL, `'${textOf(baseMs)}'`);
      const [[{ created_at: last }]] = await admin.query(
        'SELECT created_at FROM dbconnectus.sms_outgoing WHERE id_delivery = ? ORDER BY id DESC LIMIT 1', [SMALL]
      );
      const base = Date.parse(`${last.replace(' ', 'T')}Z`);
      await update(SMALL, `counted_at = '${textOf(base + DAY_MS)}'`);
      const body = await statsAt(new Date(base + 15.5 * DAY_MS + CHILE_OFFSET_MS).toISOString(), SMALL);
      assert.equal(body.state, 'ready');
    });

    for (const errno of [3024, 1028, 1317]) {
      it(`un corte ${errno} al leer la última fila entrega la foto, sin reclamar un tramo ni repetir la lectura`, async () => {
        await withPhoto(SMALL, ago('2 HOUR'));
        const before = await row(SMALL);
        const { db } = environment;
        let lastRowReads = 0;
        const cutting = {
          ...db,
          query(sql, params) {
            if (!LAST_ROW.test(sql)) return db.query(sql, params);
            lastRowReads += 1;
            return Promise.reject(cutError(errno));
          },
        };
        const body = await stats(environment.handlerAt(NEAR, cutting), SMALL);
        assert.equal(body.state, 'ready');
        assert.ok(body.updatedAt);
        assert.ok(body.national);
        assert.equal(lastRowReads, 1);
        const after = await row(SMALL);
        assert.equal(after.work_phase, 'idle');
        assert.equal(after.next_step_at, before.next_step_at);
      });
    }

    it('otro error al leer la última fila no se toma como corte', async () => {
      await withPhoto(SMALL, ago('2 HOUR'));
      const failure = Object.assign(new Error('datos'), { errno: 1146, code: 'ER_NO_SUCH_TABLE' });
      const { db } = environment;
      const broken = { ...db, query: (sql, params) => (LAST_ROW.test(sql) ? Promise.reject(failure) : db.query(sql, params)) };
      const spy = mock.method(console, 'error', () => {});
      const response = await get(environment.handlerAt(NEAR, broken), SMALL);
      spy.mock.restore();
      assert.equal(response.statusCode, 500);
    });

    it('updatedAt va en hora de Chile, con fecha', async () => {
      await withPhoto(SMALL, "'2026-11-20 02:30:00'");
      await update(SMALL, 'next_step_at = UTC_TIMESTAMP(3) + INTERVAL 1 HOUR');
      const body = await stats(environment.handlerAt(NEAR), SMALL);
      assert.equal(body.updatedAt, '19/11/2026 23:30');
    });
  });

  describe('clics', () => {
    it('link único: los primeros 2.000 sin links publican de una, y los clics salen del link', async () => {
      const handler = environment.handlerAt(NEAR);
      const { body } = await runUntilReady(handler, UNIQUE_LINK);
      assert.deepEqual(body.links, { distinct: 0, clicks: 42 });
      await assertExactPhoto(UNIQUE_LINK, body);
    });

    it('por SMS, en más de un tramo: suman lo mismo que la base', async () => {
      const handler = environment.handlerAt(NEAR);
      const { body, seen } = await runUntilReady(handler, LINKS_BY_SMS);
      const [[expected]] = await admin.query(
        'SELECT COUNT(DISTINCT x.id_short_link) AS links, SUM(l.clicks) AS clics FROM dbconnectus.sms_outgoing s '
        + 'JOIN dbconnectus.short_link_sms_outgoings x ON x.id_sms_outgoing = s.id '
        + 'JOIN dbconnectus.short_link l ON l.id = x.id_short_link WHERE s.id_delivery = ?',
        [LINKS_BY_SMS]
      );
      assert.deepEqual(body.links, { distinct: Number(expected.links), clicks: Number(expected.clics) });
      assert.equal(typeof (await row(LINKS_BY_SMS)).clicks_sum, 'string', 'BIGINT llega como texto y se convierte');
      assert.ok(Number(expected.links) > 2000, 'más de un tramo de links');
      await assertExactPhoto(LINKS_BY_SMS, body);
      const links = seen.filter((item) => item.state === 'computing').map((item) => item.progressRows);
      assert.ok(links.at(-1) > links.at(-2), 'el avance sigue subiendo en la fase de links');
    });

    it('con suma en 0, usa los clics del link del envío', async () => {
      const handler = environment.handlerAt(NEAR);
      await runUntilReady(handler, LINKS_BY_SMS);
      await update(LINKS_BY_SMS, 'clicks_sum = 0, links_distinct = 5');
      assert.deepEqual((await stats(handler, LINKS_BY_SMS)).links, { distinct: 5, clicks: 7 });
    });

    it('sin link del envío, links es null', async () => {
      assert.equal((await stats(environment.handlerAt(NEAR), SMALL)).links, null);
    });
  });

  describe('categorías', () => {
    it('los estados fuera de categoría van a Otros estados, y el gráfico los suma solo si hay', async () => {
      const { body } = await runUntilReady(environment.handlerAt(NEAR), BIG);
      const others = body.national.rows.find((item) => item.label === 'Otros estados').total
        + body.international.rows.find((item) => item.label === 'Otros estados').total;
      assert.ok(others > 0);
      assert.equal(body.chart.at(-1).label, 'Otros estados');
      assert.equal(body.chart.at(-1).value, others);
      assert.equal(body.chart.length, 9);
      const invalid = body.chart.find((slice) => slice.label === 'Número Inválido');
      const [[{ n }]] = await admin.query(
        "SELECT COUNT(*) AS n FROM dbconnectus.sms_outgoing WHERE id_delivery = ? AND id_account = ? AND status LIKE '%ESME\\_RI%'",
        [BIG, ACCOUNT]
      );
      assert.equal(invalid.value, Number(n));
    });

    it('Estados Unidos y un país nulo: uno en Otros de internacional, el otro en nacional', async () => {
      const { body } = await runUntilReady(environment.handlerAt(NEAR), BIG);
      const [[totals]] = await admin.query(
        "SELECT SUM(dst_country = 'Estados Unidos') AS usa, SUM(dst_country <> 'Chile') AS international, "
        + "SUM(dst_country IS NULL OR dst_country = 'Chile') AS national "
        + 'FROM dbconnectus.sms_outgoing WHERE id_delivery = ? AND id_account = ?',
        [BIG, ACCOUNT]
      );
      assert.equal(body.international.totals.total, Number(totals.international));
      assert.equal(body.national.totals.total, Number(totals.national));
      assert.deepEqual(body.international.columns, ['Perú', 'Colombia', 'México', 'Brasil', 'Argentina', 'Otros']);
      assert.deepEqual(body.national.columns, ['Movistar', 'Entel', 'Claro', 'Wom', 'VTR', 'Virgin', 'Otros']);
      assert.ok(body.international.totals.cells[5] >= Number(totals.usa));
      assert.ok(Number(totals.usa) > 0);
    });
  });
});
