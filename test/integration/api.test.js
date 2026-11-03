'use strict';

// Recorre el handler real contra el mysqld desechable, con el usuario pages_app y sus permisos de verdad.
// Requiere scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const mysql = require('mysql2/promise');

const { createApp } = require('../../src/app');
const { LOGIN_FAILURE_FLOOR_MS, hashPassword } = require('../../src/auth');
const { loadConfig } = require('../../src/config');
const { createDb } = require('../../src/db');
const { createHandler } = require('../../src/handler');
const { adminConnectionOptions, loadTestEnv, localConfigEnv } = require('./support/test_env');

const CREAR_LOGIN = path.join(__dirname, '..', '..', 'scripts', 'crear_login.js');
const CREAR_LOGIN_TERMINAL = path.join(__dirname, 'support', 'crear_login_terminal.py');
const TERMINAL_MYSQL_P = path.join(__dirname, 'support', 'terminal_mysql_p.py');
const LOGIN_FAILED_MESSAGE = 'Usuario o contraseña incorrectos, o acceso bloqueado temporalmente.';
const THROWAWAY_PASSWORD = 'clave-desechable-de-la-prueba';
const THROWAWAY_USERS = ['api_bloqueo', 'api_revocar', 'api_cuentas', 'api_expulsar', 'api_cambio_clave'];
const CREATED_BY_SCRIPT_USERS = ['api_script_generada', 'api_script_canalizada', 'api_script_terminal', 'api_script_no_permitida'];

// Fuera del mes del fixture, con ids mayores y en orden, para que no cambien los datos de otras pruebas.
const BOUNDARY_NUMBER = 56900000555;
// Una fecha fija, con el mes del fixture ya bien atrás: si no, estas pruebas cambiarían de rama según el día en que corran.
const FIXED_NOW = '2026-11-20T15:00:00Z';
const BOUNDARY_ROWS = [
  { id: 40001, createdAt: '2026-11-09 23:59:59', inside: false },
  { id: 40002, createdAt: '2026-11-10 00:00:00', inside: true },
  { id: 40003, createdAt: '2026-11-10 12:00:00', inside: true },
  { id: 40004, createdAt: '2026-11-11 23:59:59', inside: true },
  { id: 40005, createdAt: '2026-11-12 00:00:00', inside: false },
];

function restEvent(overrides) {
  return {
    httpMethod: 'GET',
    path: '/',
    headers: {},
    multiValueHeaders: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    requestContext: { identity: { sourceIp: '203.0.113.30' } },
    ...overrides,
  };
}

describe('API contra el mysqld desechable', () => {
  let env;
  let db;
  let admin;
  let config;
  let handler;
  const loginIds = new Map();

  function handlerAt(isoTime, loginFailureFloorMs = 0) {
    const app = createApp({ db, config, clock: () => Date.parse(isoTime), loginFailureFloorMs });
    return createHandler(async () => app);
  }

  async function postLogin(username, password, using = handler) {
    return using(restEvent({
      httpMethod: 'POST',
      path: '/api/login',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }));
  }

  async function tokenFor(username, password, using = handler) {
    const response = await postLogin(username, password, using);
    assert.equal(response.statusCode, 200);
    return JSON.parse(response.body).token;
  }

  function getSms(token, params, using = handler) {
    return using(restEvent({
      path: '/api/sms',
      headers: { Authorization: `Bearer ${token}` },
      queryStringParameters: params,
    }));
  }

  // El contenido del fixture es único por fila: identifica a cada una sin que la API exponga el id.
  async function walkAllPages(token, params, using = handler) {
    const contents = [];
    const items = [];
    let cursor = null;
    for (let page = 0; page < 500; page += 1) {
      const response = await getSms(token, cursor === null ? params : { ...params, cursor }, using);
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.ok(body.items.length <= 50);
      items.push(...body.items);
      contents.push(...body.items.map((item) => item.content));
      if (body.nextCursor === null) return { contents, items };
      assert.equal(typeof body.nextCursor, 'string');
      assert.equal(body.items.length, 50, 'una página con siguiente debe venir completa');
      cursor = body.nextCursor;
    }
    throw new Error('La paginación no terminó.');
  }

  async function adminContents(where, params) {
    const [rows] = await admin.query(`SELECT sms_content FROM dbconnectus.sms_outgoing WHERE ${where} ORDER BY id DESC`, params);
    return rows.map((row) => row.sms_content);
  }

  async function loginState(username) {
    const [[row]] = await admin.query(
      'SELECT failed_attempts, locked_until, last_login_at, '
      + 'TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), locked_until) AS seconds_locked '
      + 'FROM connectus_pages.login WHERE username = ?',
      [username]
    );
    return row;
  }

  before(async () => {
    env = loadTestEnv();
    config = await loadConfig({
      env: localConfigEnv(env, { TOKEN_SECRET: crypto.randomBytes(32).toString('hex') }),
    });
    db = createDb(config);
    handler = handlerAt(FIXED_NOW);

    admin = await mysql.createConnection(adminConnectionOptions(env));

    await cleanUp();
    const passwordHash = await hashPassword(THROWAWAY_PASSWORD);
    for (const username of THROWAWAY_USERS) {
      const [created] = await admin.query(
        'INSERT INTO connectus_pages.login (username, password_hash) VALUES (?, ?)',
        [username, passwordHash]
      );
      loginIds.set(username, created.insertId);
      await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 101)', [created.insertId]);
    }
    for (const { id, createdAt } of BOUNDARY_ROWS) {
      await admin.query(
        'INSERT INTO dbconnectus.sms_outgoing (id, id_account, status, dst_number, sms_content, created_at) '
        + "VALUES (?, 101, 'DELIVRD', ?, ?, ?)",
        [id, BOUNDARY_NUMBER, `Borde ${id}`, createdAt]
      );
    }
  });

  async function cleanUp() {
    await admin.query('DELETE FROM dbconnectus.sms_outgoing WHERE id BETWEEN 40001 AND 40005');
    await admin.query('DELETE FROM dbconnectus.sms_outgoing WHERE id BETWEEN 60001 AND 60101');
    const [rows] = await admin.query('SELECT id FROM connectus_pages.login WHERE username IN (?)', [
      [...THROWAWAY_USERS, ...CREATED_BY_SCRIPT_USERS],
    ]);
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return;
    await admin.query('DELETE FROM connectus_pages.audit_log WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login WHERE id IN (?)', [ids]);
  }

  after(async () => {
    if (admin) {
      await cleanUp();
      await admin.end();
    }
    if (db) await db.end();
  });

  it('sirve el front real con la CSP de local', async () => {
    const response = await handler(restEvent({ path: '/' }));
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.ok(response.headers['Content-Security-Policy'].endsWith('frame-ancestors http://127.0.0.1:8788'));
    assert.match(response.body, /<script[^>]+src="[^"]*app\.js"/);
  });

  it('login correcto: devuelve token y solo las cuentas del login', async () => {
    const response = await postLogin('demo', env.demoPassword);
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.expiresIn, 3600);
    assert.deepEqual(body.accounts, [
      { id: 101, name: 'Cuenta de prueba 101' },
      { id: 102, name: 'Cuenta de prueba 102' },
    ]);
    assert.ok(body.token);

    const solo = JSON.parse((await postLogin('solo102', env.solo102Password)).body);
    assert.deepEqual(solo.accounts, [{ id: 102, name: 'Cuenta de prueba 102' }]);
  });

  it('clave mala: 401 con el mensaje único, suma un intento y entrar lo limpia', async () => {
    const response = await postLogin('api_cuentas', 'clave-incorrecta');
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), { error: 'invalid_credentials', message: LOGIN_FAILED_MESSAGE });
    assert.equal((await loginState('api_cuentas')).failed_attempts, 1);

    await tokenFor('api_cuentas', THROWAWAY_PASSWORD);
    const state = await loginState('api_cuentas');
    assert.equal(state.failed_attempts, 0);
    assert.equal(state.locked_until, null);
    assert.ok(state.last_login_at);
  });

  it('usuario inexistente: el mismo 401, y login_fail sin id_login', async () => {
    const countAnonymousFailures = async () => {
      const [[{ n }]] = await admin.query(
        "SELECT COUNT(*) AS n FROM connectus_pages.audit_log WHERE action = 'login_fail' AND id_login IS NULL"
      );
      return Number(n);
    };
    const countBefore = await countAnonymousFailures();
    const response = await postLogin('no_existe_en_la_base', 'cualquier-clave');
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), { error: 'invalid_credentials', message: LOGIN_FAILED_MESSAGE });
    assert.equal(await countAnonymousFailures(), countBefore + 1);
  });

  it('inactivo: 401 aunque la clave sea correcta, sin sumar intentos', async () => {
    const response = await postLogin('inactivo', env.inactivePassword);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), { error: 'invalid_credentials', message: LOGIN_FAILED_MESSAGE });
    assert.equal((await loginState('inactivo')).failed_attempts, 0);
  });

  it('bloqueo a los 5 fallos, intentos que no suman y vencimiento', async () => {
    const username = 'api_bloqueo';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.equal((await postLogin(username, 'clave-incorrecta')).statusCode, 401);
      const state = await loginState(username);
      assert.equal(state.failed_attempts, attempt);
      assert.equal(state.locked_until, null);
    }
    assert.equal((await postLogin(username, 'clave-incorrecta')).statusCode, 401);
    let state = await loginState(username);
    assert.equal(state.failed_attempts, 0, 'el quinto fallo reinicia el contador');
    assert.ok(state.locked_until, 'el quinto fallo bloquea');
    assert.ok(Number(state.seconds_locked) > 14 * 60 && Number(state.seconds_locked) <= 15 * 60);

    const lockedUntil = state.locked_until;
    const blocked = await postLogin(username, THROWAWAY_PASSWORD);
    assert.equal(blocked.statusCode, 401, 'la clave correcta no entra mientras está bloqueado');
    assert.deepEqual(JSON.parse(blocked.body), { error: 'invalid_credentials', message: LOGIN_FAILED_MESSAGE });
    state = await loginState(username);
    assert.equal(state.failed_attempts, 0, 'los intentos no suman mientras está bloqueado');
    assert.equal(state.locked_until, lockedUntil, 'el bloqueo no se alarga');

    await admin.query(
      'UPDATE connectus_pages.login SET locked_until = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE username = ?',
      [username]
    );
    await tokenFor(username, THROWAWAY_PASSWORD);
    state = await loginState(username);
    assert.equal(state.locked_until, null);
    assert.equal(state.failed_attempts, 0);
  });

  it('5 claves malas de un anónimo bloquean el login, pero no expulsan la sesión abierta', async () => {
    const username = 'api_expulsar';
    const token = await tokenFor(username, THROWAWAY_PASSWORD);
    const params = { account: '101', start: '2026-10-10', end: '2026-10-10' };
    assert.equal((await getSms(token, params)).statusCode, 200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await postLogin(username, 'clave-incorrecta')).statusCode, 401);
    }
    assert.ok((await loginState(username)).locked_until, 'el quinto fallo bloquea');
    assert.equal((await getSms(token, params)).statusCode, 200, 'la sesión abierta sigue');
    assert.equal((await postLogin(username, THROWAWAY_PASSWORD)).statusCode, 401, 'el login sigue frenado');
  });

  it('cambiar la clave con UPDATE invalida el token ya emitido, y solo la clave nueva entra', async () => {
    const username = 'api_cambio_clave';
    const params = { account: '101', start: '2026-10-10', end: '2026-10-10' };
    const oldToken = await tokenFor(username, THROWAWAY_PASSWORD);
    assert.equal((await getSms(oldToken, params)).statusCode, 200);

    const newPassword = `${THROWAWAY_PASSWORD}-nueva`;
    await admin.query('UPDATE connectus_pages.login SET password_hash = ? WHERE username = ?', [
      await hashPassword(newPassword),
      username,
    ]);
    const rejected = await getSms(oldToken, params);
    assert.equal(rejected.statusCode, 401);
    assert.equal(JSON.parse(rejected.body).error, 'unauthorized');
    assert.equal((await postLogin(username, THROWAWAY_PASSWORD)).statusCode, 401);

    const newToken = await tokenFor(username, newPassword);
    assert.equal((await getSms(newToken, params)).statusCode, 200);

    await admin.query('UPDATE connectus_pages.login SET token_version = token_version + 1 WHERE username = ?', [username]);
    assert.equal((await getSms(newToken, params)).statusCode, 401, 'también se pueden cerrar las sesiones sin cambiar la clave');
  });

  it('una falla de login tarda lo mismo si el usuario existe que si no, con el piso real', async () => {
    const timed = async (username) => {
      const startedAt = performance.now();
      const response = await postLogin(username, 'clave-incorrecta', handlerAt(FIXED_NOW, LOGIN_FAILURE_FLOOR_MS));
      assert.equal(response.statusCode, 401);
      return performance.now() - startedAt;
    };
    const existing = await timed('api_cambio_clave');
    const missing = await timed('no_existe_en_la_base');
    assert.ok(existing >= LOGIN_FAILURE_FLOOR_MS - 1, `el existente tardó ${existing} ms`);
    assert.ok(missing >= LOGIN_FAILURE_FLOOR_MS - 1, `el inexistente tardó ${missing} ms`);
    assert.ok(Math.abs(existing - missing) < 100, `diferencia de ${Math.abs(existing - missing)} ms`);
  });

  it('el rango de fechas es inclusivo, hasta el último segundo de los dos extremos', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const { items } = await walkAllPages(token, {
      account: '101',
      start: '2026-11-10',
      end: '2026-11-11',
      dst: String(BOUNDARY_NUMBER),
    });
    const expected = BOUNDARY_ROWS.filter((row) => row.inside).map((row) => `Borde ${row.id}`).reverse();
    assert.deepEqual(items.map((item) => item.content), expected);
    assert.deepEqual(items.map((item) => item.createdAt), ['11/11/2026 23:59', '10/11/2026 12:00', '10/11/2026 00:00']);
  });

  it('la paginación recorre todo el rango sin duplicados ni huecos', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const start = '2026-10-10';
    const end = '2026-10-11';
    const { contents } = await walkAllPages(token, { account: '101', start, end });
    const expected = await adminContents('id_account = 101 AND created_at BETWEEN ? AND ?', [
      `${start} 00:00:00`,
      `${end} 23:59:59`,
    ]);
    assert.ok(expected.length > 100, 'el rango debe dar para varias páginas');
    assert.equal(new Set(expected).size, expected.length, 'el contenido debe identificar a cada fila');
    assert.equal(new Set(contents).size, contents.length, 'sin duplicados');
    assert.deepEqual(contents, expected);
  });

  it('una búsqueda hasta hoy trae también las filas con id mayor que la más nueva por created_at', async () => {
    const start = '2026-10-25';
    const end = '2026-11-08';
    const today = handlerAt('2026-11-03T15:00:00Z');
    const token = await tokenFor('demo', env.demoPassword, today);
    const { contents } = await walkAllPages(token, { account: '101', start, end }, today);
    const expected = await adminContents('id_account = 101 AND created_at BETWEEN ? AND ?', [
      `${start} 00:00:00`,
      `${end} 23:59:59`,
    ]);
    assert.equal(expected.length, 3415);
    assert.deepEqual(contents, expected);
    for (const id of [29991, 29992, 29993, 29994, 30000]) {
      assert.ok(contents.includes(`Mensaje de prueba ${id}`), `falta la fila ${id}`);
    }
  });

  it('una fila adelantada de otra cuenta no oculta las de la búsqueda de hoy', async () => {
    const day = '2026-12-10';
    const today = handlerAt(`${day}T16:00:00Z`);
    const values = [[60001, 102, `${day} 15:00:00`, 'Adelantada de la 102']];
    for (let index = 0; index < 100; index += 1) {
      const id = 60002 + index;
      values.push([id, 101, `${day} 12:${String(index % 60).padStart(2, '0')}:00`, `Atrasada ${id}`]);
    }
    await admin.query(
      'INSERT INTO dbconnectus.sms_outgoing (id, id_account, created_at, sms_content, dst_number) VALUES ?',
      [values.map((row) => [...row, BOUNDARY_NUMBER])]
    );
    try {
      const token = await tokenFor('demo', env.demoPassword, today);
      const { contents } = await walkAllPages(token, { account: '101', start: day, end: day }, today);
      assert.equal(contents.length, 100);
      assert.equal(contents[0], 'Atrasada 60101');
    } finally {
      await admin.query('DELETE FROM dbconnectus.sms_outgoing WHERE id BETWEEN 60001 AND 60101');
    }
  });

  it('un rango lejano usa la cota superior y trae lo mismo que la base', async () => {
    const start = '2026-10-20';
    const end = '2026-10-22';
    const token = await tokenFor('demo', env.demoPassword);
    const { contents } = await walkAllPages(token, { account: '101', start, end });
    assert.deepEqual(contents, await adminContents('id_account = 101 AND created_at BETWEEN ? AND ?', [
      `${start} 00:00:00`,
      `${end} 23:59:59`,
    ]));
  });

  it('la respuesta no expone el id de la tabla, y el cursor sirve solo para su cuenta', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const params = { account: '101', start: '2026-10-10', end: '2026-10-11' };
    const first = JSON.parse((await getSms(token, params)).body);
    assert.equal(first.items.length, 50);
    assert.ok(first.items.every((item) => !('id' in item)));
    assert.match(first.nextCursor, /^[A-Za-z0-9_-]{48}$/);

    for (const [account, cursor] of [['102', first.nextCursor], ['101', '12000'], ['101', `${first.nextCursor}x`]]) {
      const response = await getSms(token, { ...params, account, cursor });
      assert.equal(response.statusCode, 400, `cursor ${cursor}`);
      assert.equal(JSON.parse(response.body).error, 'invalid_request');
    }
  });

  it('el borde de un rango cae bien aunque id y created_at no estén en orden', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const day = '2026-10-20';
    const { contents } = await walkAllPages(token, { account: '102', start: day, end: day });
    const expected = await adminContents('id_account = 102 AND created_at BETWEEN ? AND ?', [`${day} 00:00:00`, `${day} 23:59:59`]);
    const [[disordered]] = await admin.query(
      'SELECT COUNT(*) AS n FROM dbconnectus.sms_outgoing a JOIN dbconnectus.sms_outgoing b ON b.id = a.id + 1 '
      + 'WHERE b.created_at < a.created_at'
    );
    assert.ok(Number(disordered.n) > 0, 'el fixture debe traer filas con id y created_at desordenados');
    assert.deepEqual(contents, expected);
  });

  it('filtra por número, normalizándolo, y recorre sus páginas', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const number = '56900000777';
    const [[range]] = await admin.query(
      'SELECT DATE(MIN(created_at)) AS start, DATE(MAX(created_at)) AS end FROM dbconnectus.sms_outgoing '
      + 'WHERE id_account = 102 AND dst_number = ?',
      [number]
    );
    const params = { account: '102', start: range.start, end: range.end };
    const { contents, items } = await walkAllPages(token, { ...params, dst: '+56 9 0000 0777' });
    const expected = await adminContents('id_account = 102 AND dst_number = ? AND created_at BETWEEN ? AND ?', [
      number,
      `${range.start} 00:00:00`,
      `${range.end} 23:59:59`,
    ]);
    assert.ok(expected.length > 50, 'el número debe dar para más de una página');
    assert.deepEqual(contents, expected);
    assert.ok(items.every((item) => item.dst === number));
  });

  it('un número que solo existe en la cuenta 999 no aparece en una cuenta permitida', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    for (const account of ['101', '102']) {
      const response = await getSms(token, { account, start: '2026-10-01', end: '2026-10-15', dst: '56900000999' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), { items: [], nextCursor: null });
    }
  });

  it('la cuenta 999 y una cuenta ajena responden 403', async () => {
    const params = { start: '2026-10-10', end: '2026-10-11' };
    const demo = await tokenFor('demo', env.demoPassword);
    const forbidden = await getSms(demo, { ...params, account: '999' });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(JSON.parse(forbidden.body).error, 'forbidden');

    const solo102 = await tokenFor('solo102', env.solo102Password);
    assert.equal((await getSms(solo102, { ...params, account: '101' })).statusCode, 403);
    assert.equal((await getSms(solo102, { ...params, account: '999' })).statusCode, 403);
    assert.equal((await getSms(solo102, { ...params, account: '102' })).statusCode, 200);
  });

  it('pedir una cuenta ajena deja rastro en audit_log, también si no cabe en INT', async () => {
    const [[{ id: loginId }]] = await admin.query("SELECT id FROM connectus_pages.login WHERE username = 'solo102'");
    const [[{ last }]] = await admin.query('SELECT COALESCE(MAX(id), 0) AS last FROM connectus_pages.audit_log');
    const token = await tokenFor('solo102', env.solo102Password);
    const params = { start: '2026-10-10', end: '2026-10-11' };
    for (const account of ['101', '999', '99999999999']) {
      assert.equal((await getSms(token, { ...params, account })).statusCode, 403);
    }
    const [rows] = await admin.query(
      "SELECT id_login, id_account, detail, ip FROM connectus_pages.audit_log WHERE id > ? AND action = 'forbidden' AND id_login = ? ORDER BY id",
      [last, loginId]
    );
    assert.deepEqual(rows.map((row) => [row.id_login, row.id_account, row.detail, row.ip]), [
      [loginId, 101, null, '203.0.113.30'],
      [loginId, 999, null, '203.0.113.30'],
      [loginId, null, 'cuenta_fuera_de_rango', '203.0.113.30'],
    ]);
  });

  it('el contenido llega intacto y cada campo tiene el tipo y la etiqueta del contrato', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const [[row]] = await admin.query('SELECT DATE(created_at) AS day FROM dbconnectus.sms_outgoing WHERE id = 9000');
    const { items } = await walkAllPages(token, { account: '101', start: row.day, end: row.day, dst: '56900000002' });
    const accents = items.find((item) => item.content === 'Campaña con acentos: ¿qué tal, canción?');
    assert.ok(accents, 'falta la fila con acentos');
    assert.equal(accents.delivery, 'Campaña de prueba 101-A');
    assert.equal(accents.status, 'Entregado');
    assert.equal(accents.dst, '56900000002');
    assert.match(accents.createdAt, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    assert.ok(items.some((item) => item.content === '<script>alert(1)</script> & "comillas"'), 'falta la fila con HTML');
  });

  it('el envío de otra cuenta no entrega su nombre', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const [[row]] = await admin.query('SELECT DATE(created_at) AS day FROM dbconnectus.sms_outgoing WHERE id = 9002');
    const { items } = await walkAllPages(token, { account: '101', start: row.day, end: row.day, dst: '56900000003' });
    assert.equal(items.find((item) => item.content === 'Mensaje de prueba 9002').delivery, null);
  });

  it('las fechas y etiquetas coinciden con la base, también con estado NULL', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const start = '2026-10-15';
    const { items } = await walkAllPages(token, { account: '101', start, end: start });
    const [rows] = await admin.query(
      "SELECT sms_content, status, DATE_FORMAT(created_at, '%d/%m/%Y %H:%i') AS shown FROM dbconnectus.sms_outgoing "
      + 'WHERE id_account = 101 AND created_at BETWEEN ? AND ?',
      [`${start} 00:00:00`, `${start} 23:59:59`]
    );
    const byContent = new Map(rows.map((row) => [row.sms_content, row]));
    const labels = new Map([
      ['NEW', 'Programado'],
      ['DELIVRD', 'Entregado'],
      ['UNDELIV', 'No entregable'],
      ['SENT_TO_ESME', 'Enviado a proveedor'],
      ['ESME_ROK', 'Esperando respuesta'],
      ['QUEUED', 'Encolado'],
      ['OUTBALANCE', 'Sin saldo'],
      ['ESME_RTHROTTLED', 'No entregable'],
      ['ESTADO_DESCONOCIDO', 'Sin información'],
      [null, 'Sin información'],
    ]);
    const seen = new Set();
    for (const item of items) {
      const row = byContent.get(item.content);
      assert.equal(item.createdAt, row.shown);
      assert.equal(item.status, labels.get(row.status));
      seen.add(row.status);
    }
    assert.ok(seen.has(null), 'el rango debe incluir un estado NULL');
    assert.ok(seen.has('ESTADO_DESCONOCIDO'));
  });

  it('un rango vacío responde sin filas', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const response = await getSms(token, { account: '101', start: '2020-01-01', end: '2020-01-02' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { items: [], nextCursor: null });
  });

  it('audit_log guarda la búsqueda y nunca el número', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const number = '56900000778';
    const [[{ last }]] = await admin.query('SELECT COALESCE(MAX(id), 0) AS last FROM connectus_pages.audit_log');
    await getSms(token, { account: '102', start: '2026-10-01', end: '2026-10-15', dst: number });
    await getSms(token, { account: '101', start: '2026-10-02', end: '2026-10-03' });

    const [rows] = await admin.query(
      "SELECT id_login, action, id_account, detail, ip, TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP()) AS age "
      + "FROM connectus_pages.audit_log WHERE id > ? AND action = 'search' AND ip = '203.0.113.30' ORDER BY id",
      [last]
    );
    const mine = rows.filter((row) => /^2026-10-(01\.\.2026-10-15 con_numero|02\.\.2026-10-03 sin_numero)$/.test(row.detail));
    assert.deepEqual(mine.map((row) => [row.action, row.id_account, row.detail, row.ip]), [
      ['search', 102, '2026-10-01..2026-10-15 con_numero', '203.0.113.30'],
      ['search', 101, '2026-10-02..2026-10-03 sin_numero', '203.0.113.30'],
    ]);
    assert.ok(Math.abs(Number(mine[0].age)) < 60, 'created_at va en UTC');

    const [[leaks]] = await admin.query(
      "SELECT COUNT(*) AS n FROM connectus_pages.audit_log "
      + "WHERE detail LIKE '%569000%' OR detail LIKE '%Mensaje%' OR action LIKE '%569000%'"
    );
    assert.equal(Number(leaks.n), 0);
  });

  it('login_ok y login_fail quedan en audit_log con su id_login', async () => {
    const id = loginIds.get('api_revocar');
    await postLogin('api_revocar', 'clave-incorrecta');
    await postLogin('api_revocar', THROWAWAY_PASSWORD);
    const [rows] = await admin.query(
      'SELECT action, id_login, ip FROM connectus_pages.audit_log WHERE id_login = ? ORDER BY id',
      [id]
    );
    assert.deepEqual(rows.map((row) => [row.action, row.id_login, row.ip]), [
      ['login_fail', id, '203.0.113.30'],
      ['login_ok', id, '203.0.113.30'],
    ]);
  });

  it('active=0 revoca de inmediato el token que ya estaba emitido', async () => {
    const username = 'api_revocar';
    const params = { account: '101', start: '2026-10-10', end: '2026-10-10' };
    const token = await tokenFor(username, THROWAWAY_PASSWORD);
    assert.equal((await getSms(token, params)).statusCode, 200);

    await admin.query('UPDATE connectus_pages.login SET active = 0 WHERE username = ?', [username]);
    const revoked = await getSms(token, params);
    assert.equal(revoked.statusCode, 401);
    assert.equal(JSON.parse(revoked.body).error, 'unauthorized');
    assert.equal((await postLogin(username, THROWAWAY_PASSWORD)).statusCode, 401);

    await admin.query('UPDATE connectus_pages.login SET active = 1 WHERE username = ?', [username]);
    assert.equal((await getSms(token, params)).statusCode, 200);
  });

  it('quitar la cuenta del login surte efecto de inmediato', async () => {
    const id = loginIds.get('api_revocar');
    const params = { account: '101', start: '2026-10-10', end: '2026-10-10' };
    const token = await tokenFor('api_revocar', THROWAWAY_PASSWORD);
    assert.equal((await getSms(token, params)).statusCode, 200);
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ? AND id_account = 101', [id]);
    assert.equal((await getSms(token, params)).statusCode, 403);
    await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 101)', [id]);
  });

  // El SQL de crear_login.js va por el cliente mysql, como en producción, y el login entra por el handler real.
  function runSql(sql) {
    return spawnSync(
      'mysql',
      [
        '--no-defaults',
        '--protocol=TCP',
        '-h', env.host,
        '-P', env.port,
        '--ssl-mode=VERIFY_CA',
        `--ssl-ca=${env.caFile}`,
        '-u', env.adminUser,
      ],
      { input: sql, encoding: 'utf8' }
    );
  }

  function runSqlAsAdmin(sql) {
    const result = runSql(sql);
    assert.equal(result.status, 0, result.stderr);
  }

  async function allowedAccounts() {
    const [rows] = await admin.query('SELECT id_account FROM connectus_pages.allowed_account ORDER BY id_account');
    return rows.map((row) => row.id_account);
  }

  async function assertScriptLoginWorks(username, password) {
    const response = await postLogin(username, password);
    assert.equal(response.statusCode, 200);
    const { token, accounts } = JSON.parse(response.body);
    assert.deepEqual(accounts, [{ id: 101, name: 'Cuenta de prueba 101' }]);

    const dates = { start: '2026-10-10', end: '2026-10-10' };
    const search = await getSms(token, { ...dates, account: '101' });
    assert.equal(search.statusCode, 200);
    assert.ok(JSON.parse(search.body).items.length > 0);
    assert.equal((await getSms(token, { ...dates, account: '102' })).statusCode, 403);

    assert.equal((await postLogin(username, `${password}x`)).statusCode, 401);
  }

  it('crear_login.js no abre una cuenta que no está en allowed_account', async () => {
    const username = 'api_script_no_permitida';
    const allowedBefore = await allowedAccounts();
    const created = spawnSync(process.execPath, [CREAR_LOGIN, '--usuario', username, '--cuentas', '999', '--generar'], {
      encoding: 'utf8',
    });
    assert.equal(created.status, 0);
    assert.doesNotMatch(created.stdout, /allowed_account/);

    const applied = runSql(created.stdout);
    assert.notEqual(applied.status, 0);
    assert.match(applied.stderr, /ERROR 1452/);
    assert.deepEqual(await allowedAccounts(), allowedBefore);
    const [rows] = await admin.query('SELECT id FROM connectus_pages.login WHERE username = ?', [username]);
    assert.deepEqual(rows, [], 'la transacción no debe dejar el login a medias');
  });

  it('un login de crear_login.js con clave generada entra por el backend real', async () => {
    const username = 'api_script_generada';
    const created = spawnSync(process.execPath, [CREAR_LOGIN, '--usuario', username, '--cuentas', '101', '--generar'], {
      encoding: 'utf8',
    });
    assert.equal(created.status, 0);
    const password = created.stderr.trim().split('\n').pop();
    runSqlAsAdmin(created.stdout);
    await assertScriptLoginWorks(username, password);
  });

  it('un login de crear_login.js canalizado a mysql -p en una terminal entra por el backend real', async () => {
    const username = 'api_script_canalizada';
    const create = `"${process.execPath}" "${CREAR_LOGIN}" --usuario ${username} --cuentas 101 --generar`;
    const client = `mysql --no-defaults --protocol=TCP -h ${env.host} -P ${env.port} --ssl-mode=VERIFY_CA --ssl-ca=${env.caFile} -u ${env.adminUser} -p`;
    // La cuenta de administración local no tiene clave: basta con Enter.
    const terminal = spawnSync('python3', ['-I', TERMINAL_MYSQL_P, `${create} | ${client}`, 'una sola vez:', '0.3', ''], {
      encoding: 'utf8',
    });
    assert.equal(terminal.status, 0, terminal.stderr);
    const password = /una sola vez:\r?\n(\S+)\r?\n/.exec(terminal.stdout)?.[1];
    assert.ok(password, 'la clave generada debe verse en la terminal');
    await assertScriptLoginWorks(username, password);
  });

  it('un login de crear_login.js con clave escrita en la terminal entra por el backend real', async () => {
    const username = 'api_script_terminal';
    // Con acentos, comillas y barra: tiene que dar el mismo hash desde la terminal que desde el JSON del login.
    const password = 'clave-ñandú-\'"\\-de-prueba';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-login-sql-'));
    const sqlFile = path.join(directory, 'login.sql');
    try {
      const created = spawnSync(
        'python3',
        ['-I', CREAR_LOGIN_TERMINAL, process.execPath, CREAR_LOGIN, username, '101', sqlFile],
        { input: `${password}\n`, encoding: 'utf8' }
      );
      assert.equal(created.status, 0, created.stderr);
      assert.ok(created.stderr.includes('Repite la clave: '));
      assert.equal(created.stderr.includes(password), false, 'la clave no debe verse en la terminal');
      const sql = fs.readFileSync(sqlFile, 'utf8');
      assert.equal(sql.includes(password), false, 'la clave no debe ir en el SQL');
      runSqlAsAdmin(sql);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    await assertScriptLoginWorks(username, password);
  });

  it('la conexión va cifrada y con el wait_timeout del contrato', async () => {
    const [cipher] = await db.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    assert.ok(cipher.Value, 'la conexión debe ir por TLS');
    const [session] = await db.query('SELECT @@SESSION.wait_timeout AS waitTimeout');
    assert.equal(Number(session.waitTimeout), 120);
  });

  it('una conexión que el servidor cerró no le llega como error al usuario', async () => {
    const token = await tokenFor('demo', env.demoPassword);
    const params = { account: '101', start: '2026-10-10', end: '2026-10-10' };

    // Justo tras cerrarla: el cliente aún no se entera y la consulta muere a mitad de camino.
    let [{ id }] = await db.query('SELECT CONNECTION_ID() AS id');
    await admin.query('KILL ?', [Number(id)]);
    assert.equal((await getSms(token, params)).statusCode, 200);
    let [{ id: replacement }] = await db.query('SELECT CONNECTION_ID() AS id');
    assert.notEqual(String(replacement), String(id));

    // Con tiempo de por medio: como un contenedor que despierta después del wait_timeout.
    id = replacement;
    await admin.query('KILL ?', [Number(id)]);
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    assert.equal((await getSms(token, params)).statusCode, 200);
    [{ id: replacement }] = await db.query('SELECT CONNECTION_ID() AS id');
    assert.notEqual(String(replacement), String(id));
    const [session] = await db.query('SELECT @@SESSION.wait_timeout AS waitTimeout');
    assert.equal(Number(session.waitTimeout), 120, 'la conexión nueva también fija wait_timeout');
  });

  // Desde 8.0.24 el servidor avisa con el error 4031 antes de cerrar, y mysql2 lo toma como respuesta de la consulta, sin fatal.
  // Con el hilo bloqueado, como en un contenedor congelado, la consulta sale antes de que Node lea ese aviso. En 5.7 no hay
  // aviso: esta prueba solo detecta el defecto con 8.x o superior en el PATH.
  for (const route of ['la búsqueda', 'el login']) {
    it(`una conexión cerrada por wait_timeout durante un congelamiento no hace fallar ${route}`, async () => {
      const token = await tokenFor('demo', env.demoPassword);
      const params = { account: '101', start: '2026-10-10', end: '2026-10-10' };
      const [{ id }] = await db.query('SELECT CONNECTION_ID() AS id');
      await db.query('SET SESSION wait_timeout = 1');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);

      const response = route === 'el login'
        ? await postLogin('demo', env.demoPassword)
        : await getSms(token, params);
      assert.equal(response.statusCode, 200);

      const [{ id: replacement }] = await db.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(String(replacement), String(id));
      const [session] = await db.query('SELECT @@SESSION.wait_timeout AS waitTimeout');
      assert.equal(Number(session.waitTimeout), 120, 'la conexión nueva vuelve al wait_timeout del contrato');
    });
  }
});
