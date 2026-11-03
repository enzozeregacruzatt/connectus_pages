'use strict';

// Corre public/app.js tal cual, sobre un DOM mínimo, contra el handler real y el mysqld desechable: comprueba que el front y la
// API hablan el mismo contrato (rutas, parámetros, campos, cursores y errores). Requiere scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const vm = require('node:vm');
const mysql = require('mysql2/promise');

const { createApp } = require('../../src/app');
const { hashPassword } = require('../../src/auth');
const { loadConfig } = require('../../src/config');
const { createDb } = require('../../src/db');
const { createHandler } = require('../../src/handler');
const { statusLabel } = require('../../src/sms');
const { createFakeDocument } = require('./support/fake_dom');
const { adminConnectionOptions, loadTestEnv, localConfigEnv } = require('./support/test_env');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const USERNAME = 'front_api';
const PASSWORD = 'clave-desechable-del-front';
const LOGIN_FAILED_MESSAGE = 'Usuario o contraseña incorrectos, o acceso bloqueado temporalmente.';
const RANGE_MESSAGE = 'El rango debe ser válido y no superar 15 días.';
const SESSION_EXPIRED = 'Tu sesión venció. Vuelve a ingresar.';
const PAGE_SIZE = 50;

describe('front contra la API real', () => {
  let db;
  let admin;
  let handler;
  let loginId;

  async function cleanUp() {
    const [rows] = await admin.query('SELECT id FROM connectus_pages.login WHERE username = ?', [USERNAME]);
    if (rows.length === 0) return;
    const ids = rows.map((row) => row.id);
    await admin.query('DELETE FROM connectus_pages.audit_log WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login WHERE id IN (?)', [ids]);
  }

  before(async () => {
    const env = loadTestEnv();
    const config = await loadConfig({
      env: localConfigEnv(env, { TOKEN_SECRET: crypto.randomBytes(32).toString('hex') }),
    });
    db = createDb(config);
    const app = createApp({ db, config, loginFailureFloorMs: 0 });
    handler = createHandler(async () => app);
    admin = await mysql.createConnection(adminConnectionOptions(env));

    await cleanUp();
    const [created] = await admin.query(
      'INSERT INTO connectus_pages.login (username, password_hash) VALUES (?, ?)',
      [USERNAME, await hashPassword(PASSWORD)]
    );
    loginId = created.insertId;
    await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 101), (?, 102)', [loginId, loginId]);
  });

  after(async () => {
    if (admin) {
      await cleanUp();
      await admin.end();
    }
    if (db) await db.end();
  });

  // Un navegador por prueba: el token vive encerrado en el IIFE de app.js.
  function openApp({ embedded = false } = {}) {
    const document = createFakeDocument(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
    const calls = [];
    let inFlight = 0;

    // Resuelve las rutas relativas de app.js contra la raíz, donde queda servido el front, y arma el evento de API Gateway.
    async function fetchFromHandler(relativeUrl, options = {}) {
      const url = new URL(relativeUrl, 'http://localhost/');
      const multiValueQuery = {};
      for (const [name, value] of url.searchParams) (multiValueQuery[name] ||= []).push(value);
      calls.push({ method: options.method || 'GET', path: url.pathname, query: multiValueQuery });
      inFlight += 1;
      try {
        const response = await handler({
          httpMethod: options.method || 'GET',
          path: url.pathname,
          headers: options.headers || {},
          multiValueHeaders: null,
          queryStringParameters: null,
          multiValueQueryStringParameters: Object.keys(multiValueQuery).length > 0 ? multiValueQuery : null,
          body: options.body ?? null,
          isBase64Encoded: false,
          requestContext: { identity: { sourceIp: '203.0.113.31' } },
        });
        return { status: response.statusCode, json: async () => JSON.parse(response.body) };
      } finally {
        inFlight -= 1;
      }
    }

    const topWindow = {};
    const sandbox = {
      document,
      fetch: fetchFromHandler,
      URLSearchParams,
      AbortController,
      self: embedded ? {} : topWindow,
      top: topWindow,
    };
    vm.runInNewContext(fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8'), sandbox, { filename: 'public/app.js' });

    const element = (id) => document.getElementById(id);

    async function settled() {
      do {
        await new Promise((resolve) => { setImmediate(resolve); });
      } while (inFlight > 0);
      await new Promise((resolve) => { setImmediate(resolve); });
    }

    return {
      document,
      calls,
      element,
      settled,
      text: (id) => element(id).textContent,
      async logIn(username, password) {
        element('login-username').value = username;
        element('login-password').value = password;
        element('login-form').fire('submit');
        await settled();
      },
      setFilter(id, value) {
        element(id).value = value;
        element('search-form').fire('input');
      },
      async search(filters) {
        for (const [id, value] of Object.entries(filters)) this.setFilter(id, value);
        element('search-form').fire('submit');
        await settled();
      },
      async click(id) {
        assert.equal(element(id).disabled, false, `${id} no debe estar deshabilitado`);
        element(id).fire('click');
        await settled();
      },
      rows() {
        return element('results-body').children.map((row) => row.children.map((cell) => cell.textContent));
      },
    };
  }

  async function expectedRows(where, params) {
    const [rows] = await admin.query(
      "SELECT DATE_FORMAT(s.created_at, '%d/%m/%Y %H:%i') AS shown, s.dst_number, s.sms_content, s.status, d.name AS delivery "
      + 'FROM dbconnectus.sms_outgoing s '
      + 'LEFT JOIN dbconnectus.delivery d ON d.id = s.id_delivery AND d.id_account = s.id_account '
      + `WHERE ${where} ORDER BY s.id DESC`,
      params
    );
    return rows.map((row) => [
      row.shown,
      String(row.dst_number),
      row.sms_content,
      statusLabel(row.status),
      row.delivery ?? 'Sin envío',
    ]);
  }

  it('si app.js no llega a correr, se ve el aviso y el login no', () => {
    const document = createFakeDocument(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
    assert.equal(document.getElementById('load-notice').hidden, false);
    assert.equal(document.getElementById('login-view').hidden, true);
    assert.equal(document.getElementById('query-view').hidden, true);
    document.getElementById('login-username').focus();
    assert.equal(document.activeElement, null, 'lo que está dentro de algo oculto no recibe el foco');
  });

  it('al arrancar, app.js cambia el aviso por el login y le da el foco', () => {
    const page = openApp();
    assert.equal(page.element('load-notice').hidden, true);
    assert.equal(page.element('login-view').hidden, false);
    assert.equal(page.element('query-view').hidden, true);
    assert.equal(page.document.activeElement, page.element('login-username'));
  });

  it('el login falla con el mensaje del servidor y borra la contraseña', async () => {
    const page = openApp();
    assert.equal(page.document.activeElement, page.element('login-username'));
    await page.logIn(USERNAME, 'clave-incorrecta');
    assert.equal(page.text('login-error'), LOGIN_FAILED_MESSAGE);
    assert.equal(page.element('login-password').value, '');
    assert.equal(page.element('login-view').hidden, false);
    assert.equal(page.element('query-view').hidden, true);
    assert.deepEqual(page.calls.map(({ method, path: route }) => [method, route]), [['POST', '/api/login']]);
  });

  it('embebida no toma el foco al cargar: se lo quitaría a la página del cliente', async () => {
    const page = openApp({ embedded: true });
    assert.equal(page.document.activeElement, null);
    await page.logIn(USERNAME, 'clave-incorrecta');
    assert.equal(page.document.activeElement, page.element('login-password'), 'tras una acción del usuario sí mueve el foco');
  });

  it('al entrar muestra las cuentas y los últimos 15 días en hora de Chile', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    assert.equal(page.element('login-view').hidden, true);
    assert.equal(page.element('query-view').hidden, false);
    assert.equal(page.element('login-password').value, '');

    assert.equal(page.element('account-choice').hidden, false);
    assert.deepEqual(
      page.element('account-select').children.map((option) => [option.value, option.textContent]),
      [['101', 'Cuenta de prueba 101'], ['102', 'Cuenta de prueba 102']]
    );

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    const fourteenDaysAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86400000).toISOString().slice(0, 10);
    assert.equal(page.element('filter-end').value, today);
    assert.equal(page.element('filter-start').value, fourteenDaysAgo);
    assert.equal(page.calls.length, 1, 'entrar no debe lanzar una búsqueda');
  });

  it('una sola cuenta se muestra como texto y se usa en la búsqueda', async () => {
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ? AND id_account = 102', [loginId]);
    try {
      const page = openApp();
      await page.logIn(USERNAME, PASSWORD);
      assert.equal(page.element('account-choice').hidden, true);
      assert.equal(page.element('account-single').hidden, false);
      assert.equal(page.text('account-name'), 'Cuenta de prueba 101');
      await page.search({ 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
      assert.equal(page.text('search-error'), '');
      assert.deepEqual(page.calls.at(-1).query.account, ['101']);
    } finally {
      await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 102)', [loginId]);
    }
  });

  it('pinta los datos de la base y pagina hacia adelante y hacia atrás', async () => {
    const start = '2026-10-10';
    const end = '2026-10-11';
    const expected = await expectedRows('s.id_account = 101 AND s.created_at BETWEEN ? AND ?', [
      `${start} 00:00:00`,
      `${end} 23:59:59`,
    ]);
    assert.ok(expected.length > PAGE_SIZE * 2, 'el rango debe dar para al menos tres páginas');
    assert.ok(expected.some((row) => row[4] === 'Sin envío'), 'debe haber filas sin envío');
    assert.ok(expected.some((row) => row[4] !== 'Sin envío'), 'debe haber filas con envío');

    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    await page.search({ 'account-select': '101', 'filter-start': start, 'filter-end': end });

    assert.equal(page.text('search-error'), '');
    assert.equal(page.element('results').hidden, false);
    assert.equal(page.element('pager').hidden, false);
    assert.equal(page.text('page-label'), 'Página 1');
    assert.equal(page.element('page-prev').disabled, true);
    assert.deepEqual(page.rows(), expected.slice(0, PAGE_SIZE));
    assert.deepEqual(page.calls.at(-1).query, { account: ['101'], start: [start], end: [end] });

    await page.click('page-next');
    assert.equal(page.text('page-label'), 'Página 2');
    assert.deepEqual(page.rows(), expected.slice(PAGE_SIZE, PAGE_SIZE * 2));
    const firstCursor = page.calls.at(-1).query.cursor;
    assert.equal(firstCursor.length, 1);

    await page.click('page-next');
    assert.equal(page.text('page-label'), 'Página 3');
    assert.deepEqual(page.rows(), expected.slice(PAGE_SIZE * 2, PAGE_SIZE * 3));

    await page.click('page-prev');
    assert.equal(page.text('page-label'), 'Página 2');
    assert.deepEqual(page.calls.at(-1).query.cursor, firstCursor);
    assert.deepEqual(page.rows(), expected.slice(PAGE_SIZE, PAGE_SIZE * 2));

    await page.click('page-prev');
    assert.equal(page.text('page-label'), 'Página 1');
    assert.equal(page.calls.at(-1).query.cursor, undefined);
    assert.deepEqual(page.rows(), expected.slice(0, PAGE_SIZE));
  });

  it('recorre todas las páginas de un número escrito con formato', async () => {
    const start = '2026-10-16';
    const end = '2026-10-17';
    const number = '56900000777';
    const expected = await expectedRows('s.id_account = 102 AND s.dst_number = ? AND s.created_at BETWEEN ? AND ?', [
      number,
      `${start} 00:00:00`,
      `${end} 23:59:59`,
    ]);
    assert.ok(expected.length > PAGE_SIZE);

    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    await page.search({
      'account-select': '102',
      'filter-number': '+56 9 0000 0777',
      'filter-start': start,
      'filter-end': end,
    });
    assert.deepEqual(page.calls.at(-1).query.dst, [number]);

    // Con tope: si el cursor no avanzara, esto daría vueltas para siempre.
    const shown = [...page.rows()];
    for (let pages = 1; !page.element('page-next').disabled; pages += 1) {
      assert.ok(pages < 20, 'la paginación no termina');
      await page.click('page-next');
      shown.push(...page.rows());
    }
    assert.deepEqual(shown, expected);
  });

  it('un rango sin datos deja el aviso de vacío y sin tabla', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    await page.search({ 'filter-start': '2020-01-01', 'filter-end': '2020-01-02' });
    assert.equal(page.text('search-error'), '');
    assert.match(page.text('search-status'), /No se encontraron/);
    assert.equal(page.element('results').hidden, true);
  });

  it('un rango inválido no llega al servidor y usa su mismo texto', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    const callsBefore = page.calls.length;
    await page.search({ 'filter-start': '2026-10-01', 'filter-end': '2026-10-16' });
    assert.equal(page.text('search-error'), RANGE_MESSAGE);
    assert.equal(page.calls.length, callsBefore);
  });

  it('una búsqueda más nueva gana a la respuesta de la anterior', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    page.setFilter('account-select', '101');
    page.setFilter('filter-start', '2026-10-10');
    page.setFilter('filter-end', '2026-10-10');
    page.element('search-form').fire('submit');
    page.setFilter('account-select', '102');
    page.element('search-form').fire('submit');
    await page.settled();

    const expected = await expectedRows('s.id_account = 102 AND s.created_at BETWEEN ? AND ?', [
      '2026-10-10 00:00:00',
      '2026-10-10 23:59:59',
    ]);
    assert.deepEqual(page.rows(), expected.slice(0, PAGE_SIZE));
  });

  it('cambiar un filtro borra los resultados y obliga a buscar de nuevo', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    await page.search({ 'account-select': '101', 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
    assert.ok(page.rows().length > 0);
    page.setFilter('filter-number', '56900000002');
    assert.deepEqual(page.rows(), []);
    assert.equal(page.element('results').hidden, true);
  });

  it('muestra el mensaje del servidor si le quitan la cuenta', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ? AND id_account = 102', [loginId]);
    try {
      await page.search({ 'account-select': '102', 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
      assert.equal(page.text('search-error'), 'No tienes acceso a esa cuenta.');
      assert.equal(page.element('query-view').hidden, false);
      assert.equal(page.element('results').hidden, true);
    } finally {
      await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 102)', [loginId]);
    }
  });

  it('si le quitan la cuenta con resultados en pantalla, los borra y la saca del selector', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    await page.search({ 'account-select': '102', 'filter-start': '2026-10-10', 'filter-end': '2026-10-11' });
    assert.equal(page.rows().length, PAGE_SIZE);
    assert.equal(page.element('page-next').disabled, false);

    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ? AND id_account = 102', [loginId]);
    try {
      await page.click('page-next');
      assert.equal(page.text('search-error'), 'No tienes acceso a esa cuenta.');
      assert.equal(page.text('search-status'), '');
      assert.deepEqual(page.rows(), []);
      assert.equal(page.element('results').hidden, true);
      assert.equal(page.element('pager').hidden, true);
      assert.equal(page.element('query-view').hidden, false);
      assert.deepEqual(page.element('account-select').children.map((option) => option.value), ['101']);
      assert.equal(page.element('account-choice').hidden, true);
      assert.equal(page.text('account-name'), 'Cuenta de prueba 101');
      assert.equal(page.document.activeElement, page.element('filter-number'));

      // La cuenta que le queda sigue funcionando en la misma sesión.
      await page.search({ 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
      assert.equal(page.text('search-error'), '');
      assert.deepEqual(page.calls.at(-1).query.account, ['101']);
      assert.ok(page.rows().length > 0);
    } finally {
      await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 102)', [loginId]);
    }
  });

  it('si le quitan su única cuenta, no queda nada que buscar', async () => {
    const page = openApp();
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ? AND id_account = 102', [loginId]);
    try {
      await page.logIn(USERNAME, PASSWORD);
      await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ? AND id_account = 101', [loginId]);
      await page.search({ 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
      assert.equal(page.text('search-error'), 'No tienes acceso a esa cuenta.');
      assert.equal(page.text('account-name'), 'Sin cuentas asignadas');
      assert.equal(page.element('search-button').disabled, true);
    } finally {
      await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 101), (?, 102)', [loginId, loginId]);
    }
  });

  it('un 401 vuelve al login con aviso y borra los datos de la pantalla', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    await page.search({ 'account-select': '101', 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
    assert.ok(page.rows().length > 0);

    await admin.query('UPDATE connectus_pages.login SET active = 0 WHERE id = ?', [loginId]);
    try {
      await page.search({ 'filter-end': '2026-10-11' });
      assert.equal(page.element('login-view').hidden, false);
      assert.equal(page.element('query-view').hidden, true);
      assert.equal(page.text('login-error'), SESSION_EXPIRED);
      assert.deepEqual(page.rows(), []);
      assert.deepEqual(page.element('account-select').children, []);
    } finally {
      await admin.query('UPDATE connectus_pages.login SET active = 1 WHERE id = ?', [loginId]);
    }
  });

  it('"Salir" borra el token y los datos', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    await page.search({ 'account-select': '101', 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
    assert.ok(page.rows().length > 0);

    await page.click('logout-button');
    assert.equal(page.element('login-view').hidden, false);
    assert.equal(page.element('query-view').hidden, true);
    assert.equal(page.text('login-error'), '');
    assert.deepEqual(page.rows(), []);
    assert.deepEqual(page.element('account-select').children, []);
  });
});
