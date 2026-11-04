'use strict';

const assert = require('node:assert/strict');
const { mock, test } = require('node:test');

const { PARAMETER_PREFIX } = require('../../src/config');
const { WORKER_PARAMETERS, loadWorkerConfig } = require('../../src/worker/config');
const { createWorkerHandler } = require('../../src/worker/handler');
const { isQuiet, parseQuietWindows } = require('../../src/worker/quiet');

const VALUES = {
  db_host: 'db.invalid',
  worker_db_user: 'pages_worker',
  worker_db_password: 'clave-falsa',
  worker_quiet_windows: '10:15-11:20',
};

function store(values) {
  const requested = [];
  const fetchParameters = async (names) => {
    requested.push(...names);
    return names
      .filter((name) => values[name.slice(PARAMETER_PREFIX.length)] !== undefined)
      .map((name) => ({ Name: name, Value: values[name.slice(PARAMETER_PREFIX.length)] }));
  };
  return { requested, fetchParameters };
}

test('pide solo sus cuatro parámetros: nunca los secretos de la app', async () => {
  const { requested, fetchParameters } = store(VALUES);
  const config = await loadWorkerConfig({ env: { STAGE: 'prod' }, fetchParameters });
  assert.deepEqual(requested.sort(), WORKER_PARAMETERS.map((name) => PARAMETER_PREFIX + name).sort());
  assert.ok(!requested.some((name) => /token_secret|link_secret/.test(name)));
  assert.deepEqual(config.db, { host: 'db.invalid', port: 3306, user: 'pages_worker', password: 'clave-falsa' });
  assert.deepEqual(config.quietWindows, [{ day: null, start: 615, end: 680 }]);
});

for (const name of WORKER_PARAMETERS) {
  test(`sin ${name} no arranca`, async () => {
    const { fetchParameters } = store({ ...VALUES, [name]: undefined });
    await assert.rejects(loadWorkerConfig({ env: { STAGE: 'prod' }, fetchParameters }), { code: 'config_missing_parameter' });
  });
}

test('una ventana malformada no arranca', async () => {
  const { fetchParameters } = store({ ...VALUES, worker_quiet_windows: 'siempre' });
  await assert.rejects(loadWorkerConfig({ env: { STAGE: 'prod' }, fetchParameters }), { code: 'config_quiet_windows_invalid' });
});

test('en local, sin WORKER_QUIET_WINDOWS no arranca', async () => {
  const env = { STAGE: 'local', DB_HOST: 'h', DB_PORT: '1', WORKER_DB_USER: 'u', WORKER_DB_PASSWORD: 'p', DB_SSL_CA_FILE: 'c' };
  await assert.rejects(loadWorkerConfig({ env }), { code: 'config_missing_variable' });
  const config = await loadWorkerConfig({ env: { ...env, WORKER_QUIET_WINDOWS: 'none' } });
  assert.deepEqual(config.quietWindows, []);
});

for (const text of ['10:15-11:20', '10:15-11:20,12:00-12:30', 'd5:04:20-05:10', 'd31:23:00-01:00,10:00-10:01', '23:30-00:30']) {
  test(`la ventana ${text} es válida`, () => {
    assert.ok(parseQuietWindows(text).length > 0);
  });
}

for (const text of [undefined, null, 5, '', ' ', 'None', 'none,10:00-11:00', '10:00', '10:00-', '24:00-25:00', '10:60-11:00', '1:00-2:00',
  '10:00-10:00', 'd0:10:00-11:00', 'd32:10:00-11:00', 'd5:', '10:00-11:00,', ' 10:00-11:00', '10:00-11:00 ']) {
  test(`la ventana ${JSON.stringify(text)} se rechaza`, () => {
    assert.equal(parseQuietWindows(text), null);
  });
}

const at = (iso) => Date.parse(iso);

test('none nunca está en ventana', () => {
  assert.equal(isQuiet(parseQuietWindows('none'), at('2026-10-15T12:00:00Z')), false);
});

test('la ventana va en hora de Chile, también al cambiar la hora', () => {
  const windows = parseQuietWindows('10:15-11:20');
  // Octubre: UTC-3. Junio: UTC-4.
  assert.equal(isQuiet(windows, at('2026-10-15T13:14:59Z')), false);
  assert.equal(isQuiet(windows, at('2026-10-15T13:15:00Z')), true);
  assert.equal(isQuiet(windows, at('2026-10-15T14:19:59Z')), true);
  assert.equal(isQuiet(windows, at('2026-10-15T14:20:00Z')), false);
  assert.equal(isQuiet(windows, at('2026-06-15T14:15:00Z')), true);
  assert.equal(isQuiet(windows, at('2026-06-15T13:15:00Z')), false);
});

test('una ventana cruza la medianoche', () => {
  const windows = parseQuietWindows('23:30-00:30');
  assert.equal(isQuiet(windows, at('2026-10-16T02:29:00Z')), false);
  assert.equal(isQuiet(windows, at('2026-10-16T02:30:00Z')), true);
  assert.equal(isQuiet(windows, at('2026-10-16T03:29:00Z')), true);
  assert.equal(isQuiet(windows, at('2026-10-16T03:30:00Z')), false);
});

test('el prefijo de día vale solo ese día del mes, también al cruzar la medianoche', () => {
  const windows = parseQuietWindows('d15:10:00-11:00');
  assert.equal(isQuiet(windows, at('2026-10-15T13:30:00Z')), true);
  assert.equal(isQuiet(windows, at('2026-10-16T13:30:00Z')), false);
  const crossing = parseQuietWindows('d15:23:00-01:00');
  assert.equal(isQuiet(crossing, at('2026-10-16T02:30:00Z')), true);
  assert.equal(isQuiet(crossing, at('2026-10-16T03:30:00Z')), true);
  assert.equal(isQuiet(crossing, at('2026-10-15T03:30:00Z')), false);
});

test('el handler captura todo: la consola y el error lanzado traen solo el código', async () => {
  const number = '56911100099';
  const leaky = Object.assign(new Error(`Fallo con ${number}`), { code: 'ER_X', sql: `SELECT ${number}` });
  const consoleError = mock.method(console, 'error', () => {});
  const worker = createWorkerHandler({
    load: async () => ({ quietWindows: [] }),
    openDb: () => ({ end: async () => {} }),
    openStorage: () => ({}),
    run: async () => {
      throw leaky;
    },
  });
  try {
    const error = await worker({}, { getRemainingTimeInMillis: () => 1000 }).catch((thrown) => thrown);
    assert.equal(error.message, 'ER_X');
    assert.deepEqual(Object.keys(error), []);
    assert.equal(error.cause, undefined);
    const printed = JSON.stringify(consoleError.mock.calls.map((call) => call.arguments));
    assert.ok(!printed.includes(number));
    assert.deepEqual(JSON.parse(consoleError.mock.calls[0].arguments[0]), { event: 'worker_failed', code: 'ER_X' });
  } finally {
    consoleError.mock.restore();
  }
});

test('el handler cierra el pool también si la corrida falla', async () => {
  const end = mock.fn(async () => {});
  const consoleError = mock.method(console, 'error', () => {});
  const worker = createWorkerHandler({
    load: async () => ({ quietWindows: [] }),
    openDb: () => ({ end }),
    openStorage: () => ({}),
    run: async () => ({ failure: 'SlowDown' }),
  });
  try {
    await assert.rejects(worker({}, { getRemainingTimeInMillis: () => 1000 }), /^Error: SlowDown$/);
    assert.equal(end.mock.callCount(), 1);
  } finally {
    consoleError.mock.restore();
  }
});

test('una corrida normal no lanza nada, y relee la configuración cada vez', async () => {
  const load = mock.fn(async () => ({ quietWindows: [] }));
  const worker = createWorkerHandler({
    load,
    openDb: () => ({ end: async () => {} }),
    openStorage: () => ({}),
    run: async () => ({}),
  });
  await worker({}, { getRemainingTimeInMillis: () => 1000 });
  await worker({}, { getRemainingTimeInMillis: () => 1000 });
  assert.equal(load.mock.callCount(), 2);
});
