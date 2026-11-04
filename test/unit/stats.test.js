'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { buildTables, categoryOf, isStale, mergeCounts } = require('../../src/stats');

const DAY_MS = 86400000;
const NOW = Date.UTC(2026, 10, 20, 12);

for (const [status, label] of [
  ['NEW', 'Programado'],
  ['QUEUED', 'En cola'],
  ['ESME_RINVDSTADR', 'Número inválido'],
  ['SENT_TO_ESME', 'Enviado al proveedor'],
  ['ESME_ROK', 'Esperando respuesta'],
  ['UNDELIV', 'No entregable'],
  ['UNDELIVRD', 'No entregable'],
  ['OUTBALANCE', 'Sin saldo'],
  ['DELIVRD', 'Entregado'],
  ['EXPIRED', 'Otros estados'],
  ['ESME_RTHROTTLED', 'Otros estados'],
  ['ESTADO_DESCONOCIDO', 'Otros estados'],
  ['', 'Otros estados'],
  [null, 'Otros estados'],
]) {
  test(`${status} va a ${label}`, () => {
    assert.equal(categoryOf(status).label, label);
  });
}

function row(status, provider, country, n) {
  return { status, provider, country, n };
}

test('nacional: cualquier otro proveedor, también nulo, va a Otros', () => {
  const { national, international } = buildTables([
    row('DELIVRD', 'Entel', 'Chile', 3),
    row('DELIVRD', 'Otros', 'Chile', 1),
    row('DELIVRD', 'Proveedor nuevo', 'Chile', 2),
    row('DELIVRD', null, 'Chile', 4),
    row('DELIVRD', 'Wom', null, 5),
  ]);
  assert.deepEqual(national.columns, ['Movistar', 'Entel', 'Claro', 'Wom', 'VTR', 'Virgin', 'Otros']);
  const delivered = national.rows.find((item) => item.label === 'Entregado');
  assert.deepEqual(delivered.cells, [0, 3, 0, 5, 0, 0, 7]);
  assert.equal(delivered.total, 15);
  assert.equal(national.totals.total, 15);
  assert.equal(international.totals.total, 0);
});

test('internacional: los países de la columna, y el resto, con Estados Unidos, en Otros', () => {
  const { national, international } = buildTables([
    row('NEW', 'Entel', 'Peru', 1),
    row('NEW', 'Entel', 'Mexico', 2),
    row('NEW', 'Entel', 'Estados Unidos', 4),
    row('NEW', 'Entel', 'Japón', 8),
    row('NEW', 'Entel', 'Chile', 16),
  ]);
  assert.deepEqual(international.columns, ['Perú', 'Colombia', 'México', 'Brasil', 'Argentina', 'Otros']);
  assert.deepEqual(international.rows[0].cells, [1, 0, 2, 0, 0, 12]);
  assert.equal(international.totals.total, 15);
  assert.equal(national.totals.total, 16);
});

test('filas y columnas suman el total, también con estados fuera de categoría', () => {
  const counts = [
    row('EXPIRED', 'Claro', 'Chile', 3),
    row(null, null, null, 5),
    row('DELIVRD', 'Claro', 'Chile', 7),
    row('UNDELIVRD', 'Entel', 'Brasil', 11),
  ];
  const { national, international } = buildTables(counts);
  assert.equal(national.rows.at(-1).label, 'Otros estados');
  assert.equal(national.rows.at(-1).total, 8);
  assert.equal(national.totals.total, 15);
  assert.deepEqual(national.totals.cells, [0, 0, 10, 0, 0, 0, 5]);
  assert.equal(international.rows.find((item) => item.label === 'No entregable').total, 11);
});

test('el gráfico lleva Otros estados solo si es mayor que 0', () => {
  assert.equal(buildTables([row('DELIVRD', 'Claro', 'Chile', 1)]).chart.length, 8);
  const { chart } = buildTables([row('DELIVRD', 'Claro', 'Peru', 1), row('EXPIRED', null, null, 2)]);
  assert.equal(chart.length, 9);
  assert.equal(chart.at(-1).value, 2);
  assert.equal(chart.find((slice) => slice.label === 'Entregados').value, 1);
  assert.ok(chart.every((slice) => /^#[0-9a-f]{6}$/.test(slice.color)));
});

test('una foto vacía da tablas en 0', () => {
  const { national, chart } = buildTables([]);
  assert.equal(national.totals.total, 0);
  assert.equal(chart.reduce((sum, slice) => sum + slice.value, 0), 0);
});

test('mergeCounts suma números, aunque COUNT llegue como texto', () => {
  const first = mergeCounts(null, [{ status: 'NEW', dst_provider: 'Entel', dst_country: 'Chile', n: '2' }]);
  const second = mergeCounts(first, [
    { status: 'NEW', dst_provider: 'Entel', dst_country: 'Chile', n: '10' },
    { status: null, dst_provider: null, dst_country: null, n: '1' },
  ]);
  assert.deepEqual(second, [row('NEW', 'Entel', 'Chile', 12), row(null, null, null, 1)]);
});

test('mergeCounts no confunde un nulo con un texto parecido', () => {
  const merged = mergeCounts(null, [
    { status: null, dst_provider: 'x', dst_country: null, n: '1' },
    { status: 'null', dst_provider: 'x', dst_country: null, n: '1' },
  ]);
  assert.equal(merged.length, 2);
});

const stale = (fields) => isStale({ countedAt: '2026-11-20 10:00:00', countedAgeSeconds: 0, baseMs: NOW, nowWallMs: NOW, ...fields });
const daysAgo = (days) => NOW - days * DAY_MS;

for (const [title, fields, expected] of [
  ['sin foto', { countedAt: null }, true],
  ['base nula, foto reciente', { baseMs: null, countedAgeSeconds: 600 }, false],
  ['base nula, foto de más de 10 min', { baseMs: null, countedAgeSeconds: 601 }, true],
  ['base futura, foto de más de 10 min', { baseMs: NOW + DAY_MS, countedAgeSeconds: 601 }, true],
  ['menos de 4 días, foto de 10 min', { baseMs: daysAgo(3.9), countedAgeSeconds: 600 }, false],
  ['4 días, foto de 11 min', { baseMs: daysAgo(4), countedAgeSeconds: 660 }, false],
  ['4 días, foto de más de 6 h', { baseMs: daysAgo(4), countedAgeSeconds: 21601 }, true],
  ['15 días, foto de 6 h', { baseMs: daysAgo(15), countedAgeSeconds: 21600 }, false],
  ['más de 15 días, foto antes del plazo', { baseMs: daysAgo(20), countedAt: '2026-11-15 11:59:59' }, true],
  ['más de 15 días, foto después del plazo', { baseMs: daysAgo(20), countedAt: '2026-11-16 12:00:00', countedAgeSeconds: 9e7 }, false],
]) {
  test(`vigencia: ${title}`, () => {
    assert.equal(stale(fields), expected);
  });
}
