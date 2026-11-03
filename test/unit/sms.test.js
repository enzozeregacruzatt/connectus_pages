'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { mock, test } = require('node:test');

const { decodeCursor } = require('../../src/cursor');
const { formatCreatedAt, searchSms, statusLabel } = require('../../src/sms');
const { createFakeDb } = require('./support/fake_db');

for (const [status, label] of [
  ['NEW', 'Programado'],
  ['DELIVRD', 'Entregado'],
  ['UNDELIV', 'No entregable'],
  ['SENT_TO_ESME', 'Enviado a proveedor'],
  ['ESME_ROK', 'Esperando respuesta'],
  ['QUEUED', 'Encolado'],
  ['OUTBALANCE', 'Sin saldo'],
  ['ESME_RINVDSTADR', 'No entregable'],
  ['ESME_RTHROTTLED', 'No entregable'],
  ['ESTADO_DESCONOCIDO', 'Sin información'],
  ['EXPIRED', 'Sin información'],
  ['new', 'Sin información'],
  ['', 'Sin información'],
  ['constructor', 'Sin información'],
  ['__proto__', 'Sin información'],
  [null, 'Sin información'],
  [undefined, 'Sin información'],
]) {
  test(`etiqueta de estado ${JSON.stringify(status)}: ${label}`, () => {
    assert.equal(statusLabel(status), label);
  });
}

test('formatea la fecha como texto, sin segundos', () => {
  assert.equal(formatCreatedAt('2026-10-31 14:05:33'), '31/10/2026 14:05');
  assert.equal(formatCreatedAt('2026-01-02 00:00:00'), '02/01/2026 00:00');
});

test('el formato de fecha no usa Date', () => {
  const dateMock = mock.method(globalThis, 'Date', function DateNotAllowed() {
    throw new Error('Date no debe usarse al formatear created_at');
  });
  try {
    assert.equal(formatCreatedAt('2026-10-31 14:05:33'), '31/10/2026 14:05');
  } finally {
    dateMock.mock.restore();
  }
});

test('una hora que no existe en Chile por el cambio de horario se muestra tal cual', () => {
  // 2026-09-06 00:30 no existe en America/Santiago: a medianoche el reloj salta a la 01:00.
  const script = `
    const { formatCreatedAt } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'sms.js'))});
    process.stdout.write(formatCreatedAt('2026-09-06 00:30:00'));
  `;
  for (const TZ of ['America/Santiago', 'UTC', 'Asia/Tokyo']) {
    const output = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ } });
    assert.equal(output.toString(), '06/09/2026 00:30');
  }
});

test('lo que no es una fecha de la base no se formatea', () => {
  assert.equal(formatCreatedAt(null), null);
  assert.equal(formatCreatedAt(undefined), null);
  assert.equal(formatCreatedAt('ayer'), null);
  assert.equal(formatCreatedAt(new Date(0)), null);
});

function smsRow(id, overrides = {}) {
  return {
    id,
    id_account: 101,
    id_delivery: null,
    dst_number: '56900000001',
    sms_content: `Mensaje ${id}`,
    status: 'DELIVRD',
    created_at: '2026-10-10 12:00:00',
    ...overrides,
  };
}

const SEARCH = { account: 101, start: '2026-10-05', end: '2026-10-10', dst: null, cursor: null };
const CURSOR_SECRET = 'secreto-de-pruebas-que-supera-los-32-bytes';
// Mucho después de SEARCH: los días de margen ya pasaron y la cota superior aplica.
const OPTIONS = { nowMs: Date.parse('2026-11-20T15:00:00Z'), cursorSecret: CURSOR_SECRET };
const search = (db, overrides = {}, options = {}) => searchSms(db, { ...SEARCH, ...overrides }, { ...OPTIONS, ...options });

test('las cotas de id se piden con un día de margen a cada lado', async () => {
  const db = createFakeDb({ sms: [smsRow(1)] });
  await search(db);
  assert.deepEqual(db.calls[0].params, ['2026-10-04 00:00:00', '2026-10-11 23:59:59']);
  assert.match(db.calls[0].sql, /^SELECT \/\*\+ MAX_EXECUTION_TIME\(2000\) \*\//);
});

test('el margen de las cotas cruza meses y años', async () => {
  const db = createFakeDb();
  await search(db, { start: '2027-01-01', end: '2027-01-01' }, { nowMs: Date.parse('2027-01-20T15:00:00Z') });
  assert.deepEqual(db.calls[0].params, ['2026-12-31 00:00:00', '2027-01-02 23:59:59']);
});

test('la consulta acota por id por los dos lados y pide 51 filas', async () => {
  const db = createFakeDb({ sms: [smsRow(1)] });
  await search(db);
  const { sql, params } = db.calls[1];
  assert.match(sql, /^SELECT \/\*\+ MAX_EXECUTION_TIME\(8000\) \*\/ id, id_delivery, dst_number, sms_content, status, created_at FROM connectus_pages\.sms WHERE id_account = \? AND id > \? AND id <= \? AND created_at BETWEEN \? AND \? ORDER BY id DESC LIMIT 51$/);
  assert.deepEqual(params, [101, 0, 1, '2026-10-05 00:00:00', '2026-10-10 23:59:59']);
  assert.ok(params.every((param) => ['number', 'string'].includes(typeof param)));
  assert.equal(typeof params[1], 'number');
  assert.doesNotMatch(sql, /COUNT\(/i);
});

test('el número viaja como parámetro numérico y el cursor al final', async () => {
  const db = createFakeDb({ sms: [smsRow(5)] });
  await search(db, { dst: '56900000001', cursor: 10 });
  const { sql, params } = db.calls[1];
  assert.match(sql, /AND dst_number = \? AND id < \? ORDER BY id DESC LIMIT 51$/);
  assert.deepEqual(params.slice(-2), [56900000001, 10]);
});

test('con 50 filas o menos no hay página siguiente', async () => {
  const db = createFakeDb({ sms: Array.from({ length: 50 }, (_, index) => smsRow(index + 1)) });
  const result = await search(db);
  assert.equal(result.items.length, 50);
  assert.equal(result.nextCursor, null);
});

test('con 51 filas se muestran 50 y el cursor lleva cifrado el id de la última', async () => {
  const db = createFakeDb({ sms: Array.from({ length: 51 }, (_, index) => smsRow(index + 1)) });
  const result = await search(db);
  assert.equal(result.items.length, 50);
  assert.equal(result.items[0].content, 'Mensaje 51');
  assert.equal(result.items[49].content, 'Mensaje 2');
  assert.notEqual(result.nextCursor, '2');
  assert.equal(decodeCursor(result.nextCursor, SEARCH.account, CURSOR_SECRET), 2);
  assert.equal(decodeCursor(result.nextCursor, 102, CURSOR_SECRET), null, 'el cursor está atado a la cuenta');
  assert.equal(decodeCursor(result.nextCursor, SEARCH.account, `${CURSOR_SECRET}x`), null);
});

test('la forma de cada fila es la del contrato', async () => {
  const db = createFakeDb({
    sms: [smsRow(1, { id_delivery: 7, created_at: '2026-10-10 14:05:33', status: null })],
    deliveries: [{ id: 7, id_account: 101, name: 'Envío de prueba' }],
  });
  assert.deepEqual(await search(db), {
    items: [{
      createdAt: '10/10/2026 14:05',
      dst: '56900000001',
      content: 'Mensaje 1',
      status: 'Sin información',
      delivery: 'Envío de prueba',
    }],
    nextCursor: null,
  });
});

test('los nombres de envío se piden sin repetir y acotados a la cuenta', async () => {
  const db = createFakeDb({
    sms: [smsRow(1, { id_delivery: 7 }), smsRow(2, { id_delivery: 7 }), smsRow(3, { id_delivery: 8 })],
    deliveries: [
      { id: 7, id_account: 101, name: 'Siete' },
      { id: 8, id_account: 102, name: 'De otra cuenta' },
    ],
  });
  const result = await search(db);
  assert.deepEqual(db.calls[2].params, [[8, 7], 101]);
  assert.deepEqual(result.items.map((item) => item.delivery), [null, 'Siete', 'Siete']);
});

test('sin envíos no se consulta la vista delivery', async () => {
  const db = createFakeDb({ sms: [smsRow(1)] });
  const result = await search(db);
  assert.equal(db.calls.length, 2);
  assert.equal(result.items[0].delivery, null);
});

test('una cota de id inesperada no llega a la consulta', async () => {
  const db = createFakeDb();
  const original = db.query;
  db.query = async (sql, params) => {
    if (/sms_cutoff_id/.test(sql)) return [{ lo: '0 OR 1=1', hi: '10' }];
    return original(sql, params);
  };
  await assert.rejects(search(db), { code: 'unexpected_id' });
});

// 02:00 UTC del 3 de noviembre todavía es 2 de noviembre en Chile, que en esa fecha está en UTC-3.
const NEAR_MIDNIGHT = { nowMs: Date.parse('2026-11-03T02:00:00Z') };

function usesUpperBound(db) {
  const smsCall = db.calls.find(({ sql }) => /FROM connectus_pages\.sms WHERE/.test(sql));
  const uses = /AND id <= \?/.test(smsCall.sql);
  assert.equal(/sms_cutoff_id\(\?\) AS hi/.test(db.calls[0].sql), uses, 'hi solo se calcula si se usa');
  assert.equal(db.calls[0].params.length, uses ? 2 : 1);
  return uses;
}

test('la cota superior se usa solo si el fin del rango quedó más de 2 días atrás, contados en hora de Chile', async () => {
  for (const [end, expected] of [
    ['2026-10-30', true],
    ['2026-10-31', false],
    ['2026-11-01', false],
    ['2026-11-02', false],
    ['2026-11-08', false],
  ]) {
    const db = createFakeDb({ sms: [smsRow(1)] });
    await search(db, { start: end, end }, NEAR_MIDNIGHT);
    assert.equal(usesUpperBound(db), expected, `fin ${end}`);
  }
});

test('sin cota superior, la consulta no lleva id <= ? y calcula solo lo', async () => {
  const db = createFakeDb({ sms: [smsRow(1)] });
  await search(db, { start: '2026-11-01', end: '2026-11-02' }, NEAR_MIDNIGHT);
  assert.deepEqual(db.calls[0].params, ['2026-10-31 00:00:00']);
  const { sql, params } = db.calls[1];
  assert.match(sql, /WHERE id_account = \? AND id > \? AND created_at BETWEEN \? AND \? ORDER BY id DESC LIMIT 51$/);
  assert.deepEqual(params, [101, 1, '2026-11-01 00:00:00', '2026-11-02 23:59:59']);
});

test('una búsqueda hasta hoy no pierde filas con id mayor y created_at menor que la más nueva', async () => {
  const db = createFakeDb({
    sms: [
      smsRow(10, { created_at: '2026-11-02 15:00:00', id_account: 102 }),
      smsRow(11, { created_at: '2026-11-02 12:00:00' }),
      smsRow(12, { created_at: '2026-11-02 12:01:00' }),
    ],
  });
  const result = await search(db, { start: '2026-11-02', end: '2026-11-02' }, NEAR_MIDNIGHT);
  assert.deepEqual(result.items.map((item) => item.content), ['Mensaje 12', 'Mensaje 11']);
});
