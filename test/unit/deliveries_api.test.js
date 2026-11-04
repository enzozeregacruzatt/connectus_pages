'use strict';

const assert = require('node:assert/strict');
const { mock, test } = require('node:test');

const { deliveryVariant, parseDeliveryList, parseDeliveryMessages, parseDeliveryRef } = require('../../src/deliveries');
const { encodeCursor, encodeDatedCursor } = require('../../src/cursor');
const { parseSmsDetail } = require('../../src/sms');
const { TOKEN_SECRET, buildApp, signIn } = require('./support/app_fixture');
const { mysqlError } = require('./support/fake_db');

const NOW = Date.parse('2026-11-20T15:00:00Z');
const ROUTES = ['/api/sms/detail', '/api/deliveries', '/api/delivery', '/api/delivery/progress', '/api/delivery/stats', '/api/delivery/messages'];
const WITH_ID = ROUTES.filter((path) => path !== '/api/deliveries');
const ID = 'a'.repeat(32);
const options = { cursorSecret: TOKEN_SECRET };

function request(token, path, query) {
  return { method: 'GET', path, headers: { authorization: `Bearer ${token}` }, query, ip: '203.0.113.10' };
}

for (const path of WITH_ID) {
  for (const [title, id] of [
    ['un número', 12345],
    ['un objeto', { id: 1 }],
    ['con emoji', 'a😀'],
    ['con % y _', 'a%_'],
    ['con espacios', 'a b'],
    ['con comilla', "a'b"],
    ['de más de 32', 'a'.repeat(33)],
    ['vacío', ''],
  ]) {
    test(`${path}: el id ${title} responde 400 sin consultar`, async () => {
      const { app, db } = buildApp();
      const token = await signIn(app);
      const before = db.calls.length;
      const response = await app.handle(request(token, path, { account: ['101'], id: [id] }));
      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).error, 'invalid_request');
      assert.ok(db.calls.slice(before).every(({ sql }) => /connectus_pages\.login WHERE id = /.test(sql)), 'solo se relee el login');
    });
  }

  test(`${path}: sin id responde 400`, async () => {
    const { app } = buildApp();
    const response = await app.handle(request(await signIn(app), path, { account: ['101'] }));
    assert.equal(response.statusCode, 400);
  });
}

for (const path of ROUTES) {
  test(`${path}: sin token responde 401, antes de leer los parámetros`, async () => {
    const { app } = buildApp();
    const response = await app.handle({ method: 'GET', path, headers: {}, query: {} });
    assert.equal(response.statusCode, 401);
  });

  test(`${path}: solo GET`, async () => {
    const { app } = buildApp();
    const response = await app.handle({ method: 'POST', path, headers: {} });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.Allow, 'GET');
  });

  test(`${path}/ no existe: el mapa de rutas es exacto`, async () => {
    const { app } = buildApp();
    assert.equal((await app.handle({ method: 'GET', path: `${path}/`, headers: {} })).statusCode, 404);
  });

  test(`${path}: una cuenta inválida responde 400`, async () => {
    const { app } = buildApp();
    const token = await signIn(app);
    for (const account of ['0', '-1', '1.5', 'abc', '101 OR 1=1', '']) {
      const response = await app.handle(request(token, path, { account: [account], id: [ID] }));
      assert.equal(response.statusCode, 400, account);
    }
  });

  test(`${path}: sin membresía responde 403 y audita`, async () => {
    const { app, db } = buildApp();
    const response = await app.handle(request(await signIn(app), path, { account: ['999'], id: [ID] }));
    assert.equal(response.statusCode, 403);
    assert.equal(db.state.audit.at(-1).action, 'forbidden');
    assert.equal(db.state.audit.at(-1).idAccount, 999);
  });

  for (const [errno, code] of [
    [1054, 'ER_BAD_FIELD_ERROR'],
    [1142, 'ER_TABLEACCESS_DENIED_ERROR'],
    [1143, 'ER_COLUMNACCESS_DENIED_ERROR'],
    [1146, 'ER_NO_SUCH_TABLE'],
    [1176, 'ER_KEY_DOES_NOT_EXITS'],
    [1305, 'ER_SP_DOES_NOT_EXIST'],
    [1356, 'ER_VIEW_INVALID'],
    [1370, 'ER_PROCACCESS_DENIED_ERROR'],
  ]) {
    test(`${path}: un error ${errno} es schema_error, sin datos en la consola ni en la respuesta`, async () => {
      const { app, db } = buildApp();
      const token = await signIn(app);
      db.failOn(/connectus_pages\.(?:sms|delivery|delivery_datos) /, mysqlError(errno, code));
      const spy = mock.method(console, 'error', () => {});
      const response = await app.handle(request(token, path, { account: ['101'], id: [ID] }));
      const logged = spy.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
      spy.mock.restore();
      assert.equal(response.statusCode, 500);
      assert.equal(JSON.parse(response.body).error, 'internal');
      assert.doesNotMatch(response.body, /56900000001|ER_/);
      assert.equal(logged, JSON.stringify({ event: 'schema_error', code }));
    });
  }

  for (const errno of [1267, 3854]) {
    test(`${path}: un error ${errno} es un 400 genérico`, async () => {
      const { app, db } = buildApp();
      const token = await signIn(app);
      db.failOn(/connectus_pages\.(?:sms|delivery|delivery_datos) /, mysqlError(errno, `ER_${errno}`));
      const spy = mock.method(console, 'error', () => {});
      const response = await app.handle(request(token, path, { account: ['101'], id: [ID] }));
      spy.mock.restore();
      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).error, 'invalid_request');
    });
  }

  for (const errno of [3024, 1028, 1317]) {
    test(`${path}: un corte ${errno} responde 504, sin hablar de fechas`, async () => {
      const { app, db } = buildApp();
      const token = await signIn(app);
      db.failOn(/connectus_pages\.(?:sms|delivery|delivery_datos) /, mysqlError(errno, `ER_${errno}`));
      const spy = mock.method(console, 'error', () => {});
      const response = await app.handle(request(token, path, { account: ['101'], id: [ID] }));
      spy.mock.restore();
      assert.equal(response.statusCode, 504);
      assert.doesNotMatch(JSON.parse(response.body).message, /fechas/);
    });
  }
}

test('un 1213 responde 503: se puede reintentar', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  db.failOn(/connectus_pages\.delivery /, mysqlError(1213, 'ER_LOCK_DEADLOCK'));
  const spy = mock.method(console, 'error', () => {});
  const response = await app.handle(request(token, '/api/delivery/stats', { account: ['101'], id: [ID] }));
  spy.mock.restore();
  assert.equal(response.statusCode, 503);
});

test('q con un carácter sobre U+FFFF responde vacío sin consultar envíos', async () => {
  const { app, db } = buildApp();
  const token = await signIn(app);
  const response = await app.handle(request(token, '/api/deliveries', { account: ['101'], q: ['campaña 😀'] }));
  assert.deepEqual(JSON.parse(response.body), { items: [], nextCursor: null });
  assert.ok(!db.calls.some(({ sql }) => /FROM connectus_pages\.delivery /.test(sql)));
});

test('parseDeliveryList: q se recorta, y su largo se cuenta en caracteres', () => {
  assert.equal(parseDeliveryList({ account: ['101'], q: ['  hola  '] }, options).q, 'hola');
  assert.equal(parseDeliveryList({ account: ['101'], q: ['   '] }, options).q, null);
  assert.equal(parseDeliveryList({ account: ['101'] }, options).q, null);
  assert.equal(parseDeliveryList({ account: ['101'], q: ['😀'.repeat(100)] }, options).ok, true);
  assert.equal(parseDeliveryList({ account: ['101'], q: ['😀'.repeat(101)] }, options).ok, false);
});

test('parseDeliveryList: el cursor es de esa ruta y de esa cuenta', () => {
  const dated = { id: 5, createdAt: '2026-10-24 08:55:00' };
  const valid = encodeDatedCursor(dated, 'deliveries:101', TOKEN_SECRET);
  assert.deepEqual(parseDeliveryList({ account: ['101'], cursor: [valid] }, options).cursor, dated);
  for (const cursor of [
    encodeDatedCursor(dated, 'deliveries:102', TOKEN_SECRET),
    encodeDatedCursor(dated, 'exports:101', TOKEN_SECRET),
    encodeCursor(5, 'deliveries:101', TOKEN_SECRET),
    'x',
  ]) {
    assert.equal(parseDeliveryList({ account: ['101'], cursor: [cursor] }, options).ok, false);
  }
});

test('parseDeliveryMessages: el cursor es de ese envío, y dst se valida como en la búsqueda', () => {
  const valid = encodeCursor(5, `messages:101:${ID}`, TOKEN_SECRET);
  const base = { account: ['101'], id: [ID] };
  assert.equal(parseDeliveryMessages({ ...base, cursor: [valid] }, options).cursor, 5);
  assert.equal(parseDeliveryMessages({ ...base, id: ['b'], cursor: [valid] }, options).ok, false);
  assert.equal(parseDeliveryMessages({ ...base, account: ['102'], cursor: [valid] }, options).ok, false);
  assert.equal(parseDeliveryMessages({ ...base, cursor: [encodeCursor(5, 'sms:101', TOKEN_SECRET)] }, options).ok, false);
  assert.equal(parseDeliveryMessages({ ...base, dst: ['+56 9 0000 0001'] }, options).dst, '56900000001');
  assert.equal(parseDeliveryMessages({ ...base, dst: ['   '] }, options).dst, null);
  assert.equal(parseDeliveryMessages({ ...base, dst: ['abc'] }, options).code, 'invalid_number');
});

test('un parámetro repetido se rechaza en cada ruta', () => {
  const twice = { account: ['101', '102'], id: [ID] };
  for (const result of [parseDeliveryRef(twice), parseSmsDetail(twice), parseDeliveryMessages(twice, options), parseDeliveryList(twice, options)]) {
    assert.equal(result.ok, false);
  }
  assert.equal(parseDeliveryRef({ account: ['101'], id: [ID, ID] }).ok, false);
});

// Chile en UTC-3 a esta hora: son las 12:00 del 20.
for (const [title, row, expected] of [
  ['en curso y con base', { deliver_at: '2026-11-20 10:00:00', status: 'processing', has_base: 1 }, 'generating'],
  ['new y con base', { deliver_at: '2026-11-20 10:00:00', status: 'new', has_base: '1' }, 'generating'],
  ['sin deliver_at, en curso', { deliver_at: null, status: 'new', has_base: 1 }, 'generating'],
  ['programado al futuro', { deliver_at: '2026-12-01 10:00:00', status: 'new', has_base: 1 }, 'generating'],
  ['deliver_at en cero, en curso', { deliver_at: '0000-00-00 00:00:00', status: 'new', has_base: 1 }, 'generating'],
  ['en curso sin base', { deliver_at: '2026-11-20 10:00:00', status: 'processing', has_base: 0 }, 'complete'],
  ['fallido reciente', { deliver_at: '2026-11-20 10:00:00', status: 'failed', has_base: 0 }, 'failed'],
  ['fallido sin deliver_at', { deliver_at: null, status: 'failed', has_base: 1 }, 'failed'],
  ['fallido hace más de 1 día', { deliver_at: '2026-11-19 11:59:59', status: 'failed', has_base: 1 }, 'complete'],
  ['en curso hace más de 1 día', { deliver_at: '2026-11-19 11:59:59', status: 'processing', has_base: 1 }, 'complete'],
  ['en curso hace menos de 1 día', { deliver_at: '2026-11-19 12:00:01', status: 'processing', has_base: 1 }, 'generating'],
  ['estado nulo', { deliver_at: '2026-11-20 10:00:00', status: null, has_base: 1 }, 'complete'],
  ['terminado', { deliver_at: '2026-11-20 10:00:00', status: 'completed', has_base: 1 }, 'complete'],
]) {
  test(`variante: ${title} es ${expected}`, () => {
    assert.equal(deliveryVariant(row, NOW), expected);
  });
}
