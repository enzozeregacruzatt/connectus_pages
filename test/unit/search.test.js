'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { encodeCursor } = require('../../src/cursor');
const { parseSearch } = require('../../src/sms');

const CURSOR_SECRET = 'secreto-de-pruebas-que-supera-los-32-bytes';

const RANGE_MESSAGE = 'El rango debe ser válido y no superar 15 días.';
const NUMBER_MESSAGE = 'Debes indicar un número destino válido.';

function query(overrides = {}) {
  const base = { account: ['101'], start: ['2026-10-01'], end: ['2026-10-10'], ...overrides };
  for (const name of Object.keys(base)) {
    if (base[name] === undefined) delete base[name];
  }
  return base;
}

function assertRangeRejected(start, end) {
  const result = parseSearch(query({ start: [start], end: [end] }));
  assert.equal(result.ok, false, `${start}..${end} debía rechazarse`);
  assert.equal(result.message, RANGE_MESSAGE);
}

test('acepta una búsqueda mínima', () => {
  assert.deepEqual(parseSearch(query()), {
    ok: true,
    account: 101,
    start: '2026-10-01',
    end: '2026-10-10',
    dst: null,
    cursor: null,
  });
});

test('una diferencia de 14 días se acepta y una de exactamente 15 se rechaza', () => {
  const accepted = parseSearch(query({ start: ['2026-10-01'], end: ['2026-10-15'] }));
  assert.equal(accepted.ok, true);
  assertRangeRejected('2026-10-01', '2026-10-16');
});

test('acepta un rango de un solo día y cruzando meses y años', () => {
  assert.equal(parseSearch(query({ start: ['2026-10-01'], end: ['2026-10-01'] })).ok, true);
  assert.equal(parseSearch(query({ start: ['2026-12-25'], end: ['2027-01-05'] })).ok, true);
  assert.equal(parseSearch(query({ start: ['2024-02-20'], end: ['2024-03-05'] })).ok, true);
});

test('el conteo de días no se confunde con el mes bisiesto', () => {
  assert.equal(parseSearch(query({ start: ['2024-02-15'], end: ['2024-02-29'] })).ok, true);
  assertRangeRejected('2024-02-15', '2024-03-01');
  assert.equal(parseSearch(query({ start: ['2026-02-15'], end: ['2026-03-01'] })).ok, true);
  assertRangeRejected('2026-02-15', '2026-03-02');
});

test('rechaza un fin anterior al inicio', () => {
  assertRangeRejected('2026-10-10', '2026-10-09');
});

for (const date of [
  '2026-02-30',
  '2026-02-29',
  '2026-13-01',
  '2026-00-10',
  '2026-04-31',
  '2026-10-00',
  '2026-10-32',
  '0000-01-01',
  '0999-12-31',
  '9999-12-31',
  '2026-1-1',
  '26-10-01',
  '20261001',
  '2026/10/01',
  '2026-10-01 00:00:00',
  '2026-10-01T00:00:00Z',
  ' 2026-10-01',
  '2026-10-01\n',
  "2026-10-01' OR '1'='1",
  '٢٠٢٦-١٠-٠١',
  '',
]) {
  test(`rechaza la fecha imposible o mal escrita ${JSON.stringify(date)}`, () => {
    assertRangeRejected(date, '2026-10-10');
    assertRangeRejected('2026-10-01', date);
  });
}

test('acepta el 29 de febrero de un año bisiesto', () => {
  assert.equal(parseSearch(query({ start: ['2024-02-29'], end: ['2024-02-29'] })).ok, true);
});

test('las fechas son obligatorias', () => {
  assert.equal(parseSearch(query({ start: undefined })).message, RANGE_MESSAGE);
  assert.equal(parseSearch(query({ end: undefined })).message, RANGE_MESSAGE);
});

for (const name of ['account', 'start', 'end', 'dst', 'cursor']) {
  test(`rechaza el parámetro ${name} repetido`, () => {
    const base = query({ dst: ['56900000001'], cursor: ['10'] });
    const result = parseSearch({ ...base, [name]: [base[name][0], base[name][0]] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_request');
  });
}

test('la cuenta es obligatoria y debe ser un entero positivo', () => {
  assert.equal(parseSearch(query({ account: undefined })).ok, false);
  for (const account of ['0', '-1', '1.5', '1e3', '0x10', '007', 'abc', '', ' 101', '101 OR 1=1', '99999999999999999999']) {
    assert.equal(parseSearch(query({ account: [account] })).ok, false, `cuenta ${account}`);
  }
});

test('el cursor debe ser uno emitido por la app para esa cuenta', () => {
  const options = { cursorSecret: CURSOR_SECRET };
  const valid = encodeCursor(123, 'sms:101', CURSOR_SECRET);
  assert.equal(parseSearch(query({ cursor: [valid] }), options).cursor, 123);

  const rejected = [
    '123',
    '0',
    '-5',
    '1.5',
    'abc',
    '',
    '1 OR 1=1',
    '99999999999999999999',
    'A'.repeat(48),
    `${valid}A`,
    valid.slice(0, -1),
    (valid[0] === 'A' ? 'B' : 'A') + valid.slice(1),
    `${valid.slice(0, -1)}+`,
    encodeCursor(123, 'sms:102', CURSOR_SECRET),
    encodeCursor(123, 'sms:101', `${CURSOR_SECRET}x`),
    encodeCursor(0, 'sms:101', CURSOR_SECRET),
    encodeCursor(2n ** 60n, 'sms:101', CURSOR_SECRET),
  ];
  for (const cursor of rejected) {
    const result = parseSearch(query({ cursor: [cursor] }), options);
    assert.equal(result.ok, false, `cursor ${cursor}`);
    assert.equal(result.code, 'invalid_request');
  }
});

test('dos cursores del mismo id no se parecen: no permiten comparar posiciones', () => {
  assert.notEqual(encodeCursor(123, 'sms:101', CURSOR_SECRET), encodeCursor(123, 'sms:101', CURSOR_SECRET));
});

test('sin el secreto, un cursor no pasa', () => {
  assert.equal(parseSearch(query({ cursor: [encodeCursor(123, 'sms:101', CURSOR_SECRET)] })).ok, false);
});

test('dst deja solo los dígitos, como en la plataforma', () => {
  assert.equal(parseSearch(query({ dst: ['+56 9 0000-0001'] })).dst, '56900000001');
});

test('dst con inyección de SQL queda reducido a dígitos', () => {
  const result = parseSearch(query({ dst: ["56900000001' OR 1=1 -- "] }));
  assert.equal(result.ok, true);
  assert.equal(result.dst, '5690000000111');
  assert.equal(parseSearch(query({ dst: ["' OR ''='"] })).message, NUMBER_MESSAGE);
  assert.equal(parseSearch(query({ dst: ['1; DROP TABLE sms_outgoing'] })).dst, '1');
});

test('dst sin dígitos o con más de 15 se rechaza', () => {
  assert.equal(parseSearch(query({ dst: ['abc'] })).message, NUMBER_MESSAGE);
  assert.equal(parseSearch(query({ dst: ['1'.repeat(16)] })).message, NUMBER_MESSAGE);
  assert.equal(parseSearch(query({ dst: ['1'.repeat(15)] })).dst, '1'.repeat(15));
  assert.equal(parseSearch(query({ dst: ['٥٦٩'] })).message, NUMBER_MESSAGE);
});

test('dst vacío o solo con espacios cuenta como no indicado, igual que en la plataforma', () => {
  assert.equal(parseSearch(query({ dst: [''] })).dst, null);
  assert.equal(parseSearch(query({ dst: ['   '] })).dst, null);
});

test('ignora parámetros desconocidos', () => {
  assert.equal(parseSearch({ ...query(), otro: ['1', '2'] }).ok, true);
});
