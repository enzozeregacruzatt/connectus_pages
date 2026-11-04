'use strict';

// Corre public/app.js tal cual, sobre un DOM mínimo, contra el handler real y el mysqld desechable: comprueba que el front y la
// API hablan el mismo contrato (rutas, parámetros, campos, cursores y errores). Requiere scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it, mock } = require('node:test');
const vm = require('node:vm');
const mysql = require('mysql2/promise');

const { createApp } = require('../../src/app');
const { hashPassword } = require('../../src/auth');
const { loadConfig } = require('../../src/config');
const { createDb } = require('../../src/db');
const { createHandler } = require('../../src/handler');
const { signLink } = require('../../src/link');
const { statusLabel } = require('../../src/sms');
const { createFakeDocument } = require('./support/fake_dom');
const { adminConnectionOptions, loadTestEnv, localConfigEnv } = require('./support/test_env');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const USERNAME = 'front_api';
const PASSWORD = 'clave-desechable-del-front';
const LOGIN_FAILED_MESSAGE = 'Usuario o contraseña incorrectos, o acceso bloqueado temporalmente.';
const RANGE_MESSAGE = 'El rango debe ser válido y no superar 15 días.';
const SESSION_EXPIRED = 'Tu sesión venció. Vuelve a ingresar.';
const GENERIC_ERROR = 'No se pudo completar la solicitud. Inténtalo de nuevo.';
const CREDENTIALS_ERROR = 'Debes indicar un usuario y una contraseña válidos.';
const NO_LINK_NOTICE = 'Esta consulta se abre desde el enlace que te entregó Connectus.';
const INVALID_LINK_NOTICE = 'Este enlace no es válido o venció. Pide uno nuevo a tu contacto de Connectus.';
const PAGE_SIZE = 50;
const DAY_SECONDS = 86400;
// La hora fija de los envíos del fixture: el 9, el 10 y el 11 quedan programados 2 horas antes.
const FIXTURE_NOW = '2026-11-20T15:00:00Z';
const FILE_URL_PREFIX = 'https://archivos.invalid/';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const uniqueOf = (deliveryId) => crypto.createHash('md5').update(`envio-${deliveryId}`).digest('hex');

describe('front contra la API real', () => {
  let db;
  let admin;
  let config;
  let handler;
  let opaqueHandler;
  let fixtureHandler;
  let opaqueFixtureHandler;
  let loginId;

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  function linkFor(overrides = {}) {
    return signLink(
      { slot: 'a', loginId, linkVersion: 0, exp: nowSeconds() + 180 * DAY_SECONDS, ...overrides },
      config.linkSecrets.a
    );
  }

  function chileDate(seconds) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santiago', dateStyle: 'short' }).format(seconds * 1000);
  }

  async function cleanUp() {
    const [rows] = await admin.query('SELECT id FROM connectus_pages.login WHERE username = ?', [USERNAME]);
    if (rows.length === 0) return;
    const ids = rows.map((row) => row.id);
    await admin.query('DELETE FROM connectus_pages.audit_log WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.export_job WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login WHERE id IN (?)', [ids]);
  }

  before(async () => {
    const env = loadTestEnv();
    config = await loadConfig({
      env: localConfigEnv(env, { TOKEN_SECRET: crypto.randomBytes(32).toString('hex') }),
    });
    db = createDb(config);
    const storage = {
      headObject: async () => ({ size: 1 }),
      downloadUrl: ({ key, filename }) => `${FILE_URL_PREFIX}${key}?filename=${encodeURIComponent(filename)}`,
    };
    const app = createApp({ db, config, storage, loginFailureFloorMs: 0 });
    handler = createHandler(async () => app);
    const opaqueApp = createApp({ db, config: { ...config, corsOpaque: true }, storage, loginFailureFloorMs: 0 });
    opaqueHandler = createHandler(async () => opaqueApp);
    const fixtureClock = () => Date.parse(FIXTURE_NOW);
    const fixtureApp = createApp({ db, config, storage, clock: fixtureClock, loginFailureFloorMs: 0 });
    fixtureHandler = createHandler(async () => fixtureApp);
    const opaqueFixtureApp = createApp({ db, config: { ...config, corsOpaque: true }, storage, clock: fixtureClock, loginFailureFloorMs: 0 });
    opaqueFixtureHandler = createHandler(async () => opaqueFixtureApp);
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

  // Un navegador por prueba: el token vive encerrado en el IIFE de app.js. Sin hash ni search, abre con un enlace vigente.
  // Con opaque, se comporta como un documento en sandbox sin allow-same-origin: todo fetch es cross-origin y lleva Origin: null,
  // con su preflight, y una respuesta sin las cabeceras CORS no se puede leer.
  function openApp({ embedded = false, hash, search = '', opaque = false, using = handler, fixedNowMs = null } = {}) {
    const document = createFakeDocument(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
    const calls = [];
    const clock = { offsetMs: 0, fixedNowMs };
    // overrides: ruta → función que da { status, body } en lugar del handler, para lo que el fixture no puede provocar a voluntad.
    const network = { failure: null, overrides: new Map() };
    const timers = new Map();
    let lastTimer = 0;
    let inFlight = 0;

    function restEvent(httpMethod, pathname, headers, multiValueQuery, body) {
      return {
        httpMethod,
        path: pathname,
        headers,
        multiValueHeaders: null,
        queryStringParameters: null,
        multiValueQueryStringParameters: Object.keys(multiValueQuery).length > 0 ? multiValueQuery : null,
        body,
        isBase64Encoded: false,
        requestContext: { identity: { sourceIp: '203.0.113.31' } },
      };
    }

    // Resuelve las rutas relativas de app.js contra la raíz, donde queda servido el front, y arma el evento de API Gateway.
    async function fetchFromHandler(relativeUrl, options = {}) {
      const url = new URL(relativeUrl, 'http://localhost/');
      const method = options.method || 'GET';
      const multiValueQuery = {};
      for (const [name, value] of url.searchParams) (multiValueQuery[name] ||= []).push(value);
      calls.push({ method, path: url.pathname, query: multiValueQuery, url: relativeUrl, body: options.body ?? null });
      inFlight += 1;
      try {
        if (network.failure) throw network.failure;
        const override = network.overrides.get(url.pathname);
        if (override) {
          const answer = await override(method);
          return { status: answer.status, json: async () => answer.body };
        }
        const headers = { ...options.headers, ...(opaque ? { Origin: 'null' } : {}) };
        if (opaque) {
          const preflight = await using(restEvent('OPTIONS', url.pathname, { Origin: 'null', 'Access-Control-Request-Method': method }, {}, null));
          if (preflight.statusCode !== 204 || preflight.headers['Access-Control-Allow-Origin'] !== 'null') {
            throw new TypeError('Failed to fetch');
          }
        }
        const response = await using(restEvent(method, url.pathname, headers, multiValueQuery, options.body ?? null));
        if (opaque && response.headers['Access-Control-Allow-Origin'] !== 'null') throw new TypeError('Failed to fetch');
        return { status: response.statusCode, json: async () => JSON.parse(response.body) };
      } finally {
        inFlight -= 1;
      }
    }

    class ShiftedDate extends Date {
      static now() {
        return clock.fixedNowMs ?? Date.now() + clock.offsetMs;
      }
    }

    const topWindow = {};
    const sandbox = {
      document,
      fetch: fetchFromHandler,
      URLSearchParams,
      AbortController,
      Date: ShiftedDate,
      Intl,
      setTimeout(callback, delayMs) {
        lastTimer += 1;
        timers.set(lastTimer, { callback, delayMs });
        return lastTimer;
      },
      clearTimeout: (id) => timers.delete(id),
      location: { hash: hash ?? `#e=${linkFor()}`, search, href: `http://localhost/${search}#la-url-de-la-app` },
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
      clock,
      network,
      element,
      settled,
      text: (id) => element(id).textContent,
      async logIn(username, password) {
        element('login-username').value = username;
        element('login-password').value = password;
        element('login-button').fire('click');
        await settled();
      },
      setFilter(id, value) {
        // La cuenta está fuera del formulario, y solo un cambio de verdad dispara change.
        if (id === 'account-select') {
          if (element(id).value === value) return;
          element(id).value = value;
          element(id).fire('change');
          return;
        }
        element(id).value = value;
        element('search-form').fire('input');
      },
      async search(filters) {
        for (const [id, value] of Object.entries(filters)) this.setFilter(id, value);
        element('search-button').fire('click');
        await settled();
      },
      async click(id) {
        assert.equal(element(id).disabled, false, `${id} no debe estar deshabilitado`);
        element(id).fire('click');
        await settled();
      },
      rows(bodyId = 'results-body') {
        return element(bodyId).children.map((row) => row.children.map((cell) => cell.textContent));
      },
      // Los temporizadores no corren solos: la prueba decide cuándo vence cada espera.
      waits: () => [...timers.values()].map((timer) => timer.delayMs),
      async elapse() {
        const due = [...timers.entries()];
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.callback();
        }
        await settled();
      },
      async setHidden(hidden) {
        document.hidden = hidden;
        document.fire('visibilitychange');
        await settled();
      },
      // El primer botón bajo un elemento cuyo texto sea este.
      buttonIn(rootId, label) {
        const search = (node) => {
          if (node.tag === 'button' && node.textContent === label) return node;
          for (const child of node.children) {
            const found = search(child);
            if (found) return found;
          }
          return null;
        };
        const found = search(element(rootId));
        assert.ok(found, `no hay un botón ${label} en ${rootId}`);
        return found;
      },
      async press(rootId, label) {
        this.buttonIn(rootId, label).fire('click');
        await settled();
      },
      facts(listId) {
        const nodes = element(listId).children;
        const pairs = [];
        for (let index = 0; index < nodes.length; index += 2) pairs.push([nodes[index].textContent, nodes[index + 1].textContent]);
        return pairs;
      },
      statsOf(tableId) {
        const table = element(tableId).children[0];
        const section = (tag) => table.children.find((child) => child.tag === tag);
        const texts = (row) => row.children.map((cell) => cell.textContent);
        return { head: texts(section('thead').children[0]), body: section('tbody').children.map(texts), foot: texts(section('tfoot').children[0]) };
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
    assert.deepEqual(page.calls.map(({ path: route }) => route), ['/api/login', '/api/exports'], 'entrar no debe lanzar una búsqueda');
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
    page.element('search-button').fire('click');
    page.element('search-button').fire('click');
    page.setFilter('account-select', '102');
    page.setFilter('filter-start', '2026-10-10');
    page.setFilter('filter-end', '2026-10-10');
    page.element('search-button').fire('click');
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

  function assertNoForm(page, notice) {
    assert.equal(page.element('load-notice').hidden, true);
    assert.equal(page.element('link-notice').hidden, false);
    assert.equal(page.text('link-notice'), notice);
    assert.equal(page.element('login-view').hidden, true);
    assert.equal(page.element('query-view').hidden, true);
    assert.deepEqual(page.calls, []);
  }

  it('sin enlace: el aviso, sin formulario y sin peticiones', () => {
    assertNoForm(openApp({ hash: '' }), NO_LINK_NOTICE);
    assertNoForm(openApp({ hash: '#otra=cosa', search: '?x=1' }), NO_LINK_NOTICE);
  });

  it('con un enlace de forma inválida: el mismo aviso, sin formulario y sin peticiones', () => {
    const link = linkFor();
    for (const bad of ['x', 'l1.a.1.0.1.x', `${link}=`, link.slice(0, -1), link.replace('l1.', 'l2.'), link.replace('.a.', '.c.')]) {
      assertNoForm(openApp({ hash: `#e=${bad}` }), NO_LINK_NOTICE);
      assertNoForm(openApp({ hash: '', search: `?e=${bad}` }), NO_LINK_NOTICE);
    }
  });

  it('vencido según su fecha: el aviso con la fecha, sin formulario y sin peticiones', () => {
    const exp = nowSeconds() - 86400;
    assertNoForm(
      openApp({ hash: `#e=${linkFor({ exp })}` }),
      `El enlace venció el ${chileDate(exp)}. Pide uno nuevo a tu contacto de Connectus.`
    );
  });

  it('a menos de 30 días: el aviso y el formulario, y el aviso sigue después de entrar', async () => {
    const exp = nowSeconds() + 29 * DAY_SECONDS;
    const notice = `El enlace vence el ${chileDate(exp)}. Pide uno nuevo a tu contacto de Connectus.`;
    const page = openApp({ hash: `#e=${linkFor({ exp })}` });
    assert.equal(page.text('link-notice'), notice);
    assert.equal(page.element('link-notice').hidden, false);
    assert.equal(page.element('login-view').hidden, false);

    await page.logIn(USERNAME, PASSWORD);
    assert.equal(page.element('query-view').hidden, false);
    assert.equal(page.text('link-notice'), notice);
    assert.equal(page.element('link-notice').hidden, false);
  });

  it('el aviso parte a los 30 días justos, y un milisegundo antes todavía no', () => {
    const exp = nowSeconds() + 180 * DAY_SECONDS;
    const warnsFrom = (exp - 30 * DAY_SECONDS) * 1000;
    const at = (fixedNowMs) => openApp({ hash: `#e=${linkFor({ exp })}`, fixedNowMs });
    assert.equal(at(warnsFrom).element('link-notice').hidden, false);
    assert.equal(at(warnsFrom - 1).element('link-notice').hidden, true);
  });

  it('con más de 30 días: el formulario, sin aviso', () => {
    const page = openApp({ hash: `#e=${linkFor({ exp: nowSeconds() + 31 * DAY_SECONDS })}` });
    assert.equal(page.element('login-view').hidden, false);
    assert.equal(page.element('link-notice').hidden, true);
    assert.equal(page.text('link-notice'), '');
  });

  it('el fragmento gana a la query, y la query es el respaldo', async () => {
    const fromFragment = linkFor({ exp: nowSeconds() + 100 * DAY_SECONDS });
    const fromQuery = linkFor({ exp: nowSeconds() + 90 * DAY_SECONDS });
    const both = openApp({ hash: `#e=${fromFragment}`, search: `?e=${fromQuery}` });
    await both.logIn(USERNAME, 'clave-incorrecta');
    assert.equal(JSON.parse(both.calls[0].body).link, fromFragment);

    const queryOnly = openApp({ hash: '', search: `?e=${fromQuery}` });
    await queryOnly.logIn(USERNAME, 'clave-incorrecta');
    assert.equal(JSON.parse(queryOnly.calls[0].body).link, fromQuery);

    assertNoForm(openApp({ hash: '#e=malo', search: `?e=${fromQuery}` }), NO_LINK_NOTICE);
  });

  it('el POST lleva el enlace en el cuerpo, y ninguna URL pedida lo contiene', async () => {
    const link = linkFor();
    const page = openApp({ hash: `#e=${link}` });
    await page.logIn(USERNAME, PASSWORD);
    await page.search({ 'account-select': '101', 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
    assert.deepEqual(JSON.parse(page.calls[0].body), { link, username: USERNAME, password: PASSWORD });
    assert.deepEqual(page.calls.map(({ path: route }) => route), ['/api/login', '/api/exports', '/api/sms']);
    for (const call of page.calls) assert.equal(call.url.includes(link), false, call.url);
    assert.equal(page.calls.at(-1).body, null);
  });

  it('un enlace que el servidor rechaza oculta el formulario, muestra su mensaje y borra lo escrito', async () => {
    const spy = mock.method(console, 'error', () => {});
    const page = openApp({ hash: `#e=${signLink({ slot: 'a', loginId, linkVersion: 0, exp: nowSeconds() + 86400 }, 'x'.repeat(40))}` });
    assert.equal(page.element('login-view').hidden, false);
    await page.logIn(USERNAME, PASSWORD);
    spy.mock.restore();
    assert.equal(page.element('login-view').hidden, true);
    assert.equal(page.element('query-view').hidden, true);
    assert.equal(page.element('link-notice').hidden, false);
    assert.equal(page.text('link-notice'), INVALID_LINK_NOTICE);
    assert.equal(page.element('login-password').value, '');
    assert.equal(page.element('login-username').value, '');
  });

  it('un enlace revocado también oculta el formulario', async () => {
    const spy = mock.method(console, 'error', () => {});
    const page = openApp();
    await admin.query('UPDATE connectus_pages.login SET link_version = 1 WHERE id = ?', [loginId]);
    try {
      await page.logIn(USERNAME, PASSWORD);
    } finally {
      await admin.query('UPDATE connectus_pages.login SET link_version = 0 WHERE id = ?', [loginId]);
      spy.mock.restore();
    }
    assert.equal(page.element('login-view').hidden, true);
    assert.equal(page.text('link-notice'), INVALID_LINK_NOTICE);
  });

  it('"Salir" vuelve al formulario con el mismo enlace, sin recargar', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    await page.click('logout-button');
    assert.equal(page.element('login-view').hidden, false);
    await page.logIn(USERNAME, PASSWORD);
    assert.equal(page.element('query-view').hidden, false);
  });

  it('si el enlace vence con la sesión abierta, al salir ya no hay formulario', async () => {
    const exp = nowSeconds() + 40 * DAY_SECONDS;
    const page = openApp({ hash: `#e=${linkFor({ exp })}` });
    await page.logIn(USERNAME, PASSWORD);
    page.clock.offsetMs = 41 * DAY_SECONDS * 1000;
    await page.click('logout-button');
    assert.equal(page.element('login-view').hidden, true);
    assert.equal(page.text('link-notice'), `El enlace venció el ${chileDate(exp)}. Pide uno nuevo a tu contacto de Connectus.`);
  });

  const posts = (page) => page.calls.filter((call) => call.method === 'POST');

  it('el botón no es de envío y Enter en un campo entra sin que el formulario dispare submit', async () => {
    for (const field of ['login-username', 'login-password']) {
      const page = openApp();
      page.element('login-username').value = USERNAME;
      page.element('login-password').value = PASSWORD;
      const event = page.element(field).fire('keydown', { key: 'Enter' });
      assert.equal(event.defaultPrevented, true, 'el Enter no debe seguir a un envío implícito');
      await page.settled();
      assert.equal(page.element('query-view').hidden, false, field);
      assert.equal(posts(page).length, 1);
    }
  });

  it('otra tecla, la tecla sostenida o el Enter de un texto compuesto no entran', async () => {
    const page = openApp();
    page.element('login-username').value = USERNAME;
    page.element('login-password').value = PASSWORD;
    for (const init of [{ key: 'a' }, { key: 'Enter', repeat: true }, { key: 'Enter', isComposing: true }]) {
      const event = page.element('login-password').fire('keydown', init);
      assert.equal(event.defaultPrevented, false);
    }
    await page.settled();
    assert.deepEqual(page.calls, []);
  });

  it('Enter y clic seguidos lanzan un solo login', async () => {
    const page = openApp();
    page.element('login-username').value = USERNAME;
    page.element('login-password').value = PASSWORD;
    page.element('login-password').fire('keydown', { key: 'Enter' });
    page.element('login-button').fire('click');
    page.element('login-password').fire('keydown', { key: 'Enter' });
    await page.settled();
    assert.equal(posts(page).length, 1);
    assert.equal(page.element('query-view').hidden, false);
  });

  it('un submit por su cuenta solo se cancela: no lanza nada', async () => {
    const page = openApp();
    page.element('login-username').value = USERNAME;
    page.element('login-password').value = PASSWORD;
    assert.equal(page.element('login-form').fire('submit').defaultPrevented, true);
    await page.settled();
    assert.deepEqual(page.calls, []);

    await page.logIn(USERNAME, PASSWORD);
    const callsBefore = page.calls.length;
    assert.equal(page.element('search-form').fire('submit').defaultPrevented, true);
    await page.settled();
    assert.equal(page.calls.length, callsBefore);
  });

  it('sin usuario o sin contraseña no pregunta al servidor: el botón ya no pasa por required', async () => {
    const page = openApp();
    page.element('login-button').fire('click');
    await page.settled();
    assert.equal(page.text('login-error'), CREDENTIALS_ERROR);
    assert.equal(page.document.activeElement, page.element('login-username'));

    page.element('login-username').value = USERNAME;
    page.element('login-username').fire('keydown', { key: 'Enter' });
    await page.settled();
    assert.equal(page.document.activeElement, page.element('login-password'));
    assert.deepEqual(page.calls, []);
  });

  it('Enter en un filtro busca, y un doble Enter lanza una sola consulta', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    for (const field of ['filter-number', 'filter-start', 'filter-end']) {
      page.setFilter('account-select', '101');
      page.setFilter('filter-start', '2026-10-10');
      page.setFilter('filter-end', '2026-10-10');
      const before = page.calls.length;
      page.element(field).fire('keydown', { key: 'Enter' });
      page.element(field).fire('keydown', { key: 'Enter' });
      await page.settled();
      assert.equal(page.calls.length, before + 1, field);
      assert.ok(page.rows().length > 0, field);
    }
  });

  it('el selector de cuenta no busca con Enter: en él, Enter confirma la lista desplegada', async () => {
    const page = openApp();
    await page.logIn(USERNAME, PASSWORD);
    const before = page.calls.length;
    assert.equal(page.element('account-select').fire('keydown', { key: 'Enter' }).defaultPrevented, false);
    await page.settled();
    assert.equal(page.calls.length, before);
  });

  it('sin cuentas, ni el botón ni Enter buscan', async () => {
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ?', [loginId]);
    try {
      const page = openApp();
      await page.logIn(USERNAME, PASSWORD);
      assert.equal(page.element('search-button').disabled, true);
      const before = page.calls.length;
      page.element('filter-number').fire('keydown', { key: 'Enter' });
      page.element('search-button').fire('click');
      await page.settled();
      assert.equal(page.calls.length, before);
    } finally {
      await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 101), (?, 102)', [loginId, loginId]);
    }
  });

  it('bajo sandbox sin allow-forms ni allow-same-origin: con CORS abierto, botón y Enter hacen todo el recorrido', async () => {
    const page = openApp({ embedded: true, opaque: true, using: opaqueHandler });
    assert.equal(page.element('login-view').hidden, false);

    page.element('login-username').value = USERNAME;
    page.element('login-password').value = PASSWORD;
    page.element('login-password').fire('keydown', { key: 'Enter' });
    await page.settled();
    assert.equal(page.element('query-view').hidden, false);

    await page.search({ 'account-select': '101', 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
    assert.equal(page.text('search-error'), '');
    assert.ok(page.rows().length > 0);

    page.setFilter('filter-number', '56900000002');
    page.element('filter-number').fire('keydown', { key: 'Enter' });
    await page.settled();
    assert.equal(page.text('search-error'), '');

    await page.click('logout-button');
    assert.equal(page.element('login-view').hidden, false);
    await page.logIn(USERNAME, 'clave-incorrecta');
    assert.equal(page.text('login-error'), LOGIN_FAILED_MESSAGE, 'bajo CORS también se puede leer un error');
  });

  it('bajo sandbox y con CORS apagado, el TypeError da el error genérico y el formulario sigue', async () => {
    const page = openApp({ embedded: true, opaque: true });
    await page.logIn(USERNAME, PASSWORD);
    assert.equal(page.text('login-error'), GENERIC_ERROR);
    assert.equal(page.element('login-view').hidden, false);
    assert.equal(page.element('login-button').disabled, false);
    assert.equal(page.element('login-password').value, '');
  });

  it('un TypeError de fetch da el error genérico, en el login y en la búsqueda', async () => {
    const page = openApp();
    page.network.failure = new TypeError('Failed to fetch');
    await page.logIn(USERNAME, PASSWORD);
    assert.equal(page.text('login-error'), GENERIC_ERROR);
    assert.equal(page.text('login-status'), '');

    page.network.failure = null;
    await page.logIn(USERNAME, PASSWORD);
    assert.equal(page.element('query-view').hidden, false);

    page.network.failure = new TypeError('Failed to fetch');
    await page.search({ 'account-select': '101', 'filter-start': '2026-10-10', 'filter-end': '2026-10-10' });
    assert.equal(page.text('search-error'), GENERIC_ERROR);
    assert.equal(page.text('search-status'), '');
    assert.equal(page.element('query-view').hidden, false);
  });

  // Pantallas sobre la API: la hora fija hace que los envíos del fixture caigan en la variante que les toca.
  async function openFixtureApp(options = {}) {
    await admin.query('DELETE FROM connectus_pages.export_job WHERE id_login = ?', [loginId]);
    const page = openApp({ using: fixtureHandler, ...options });
    await page.logIn(USERNAME, PASSWORD);
    assert.equal(page.element('query-view').hidden, false);
    return page;
  }

  async function openDeliveryFromList(page, name) {
    await page.click('menu-deliveries');
    page.element('deliveries-query').value = name;
    await page.click('deliveries-button');
    await page.press('deliveries-body', name);
  }

  async function finishJob(page, state = 'finished', extra = '') {
    await admin.query(
      `UPDATE connectus_pages.export_job SET state = ?, storage_key = CONCAT('exports/', public_id)${extra} WHERE id_login = ?`,
      [state, loginId]
    );
    await page.elapse();
  }

  const asCount = (value) => value.toLocaleString('es-CL');

  it('al entrar pide las exportaciones CSV del login, y la cabecera nombra la cuenta', async () => {
    const page = await openFixtureApp();
    assert.deepEqual(page.calls.at(-1).query, { kind: ['sms_csv'] });
    assert.equal(page.text('hero-title'), 'Consulta de SMS');
    assert.equal(page.text('hero-subtitle'), 'Revisa mensajes y genera reportes para Cuenta de prueba 101.');
    assert.equal(page.text('exports-status'), 'Todavía no hay exportaciones.');
    assert.equal(page.element('exports-table').hidden, true);
    assert.equal(page.element('back-button').hidden, true);
    assert.equal(page.element('menu-query').getAttribute('aria-current'), 'page');
  });

  it('el menú cambia de pantalla, y "Envíos SMS" lista 10 por página, más nuevos primero, con su paginación', async () => {
    const page = await openFixtureApp();
    await page.click('menu-deliveries');
    assert.equal(page.element('screen-query').hidden, true);
    assert.equal(page.element('screen-deliveries').hidden, false);
    assert.equal(page.element('menu-deliveries').getAttribute('aria-current'), 'page');
    assert.equal(page.element('menu-query').getAttribute('aria-current'), null);
    assert.equal(page.text('hero-title'), 'Historial de envíos SMS');
    assert.equal(page.element('hero-limit').hidden, true);

    const [expected] = await admin.query(
      'SELECT name, delivery_type FROM dbconnectus.delivery WHERE id_account = 101 AND id_product = 1 AND created_at IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 20'
    );
    const nameAndType = (rows) => rows.map((row) => [row[0], row[1]]);
    assert.deepEqual(nameAndType(page.rows('deliveries-body')), expected.slice(0, 10).map((row) => [row.name, row.delivery_type]));
    assert.equal(page.text('deliveries-page-label'), 'Página 1');
    await page.click('deliveries-next');
    assert.deepEqual(nameAndType(page.rows('deliveries-body')), expected.slice(10, 20).map((row) => [row.name, row.delivery_type]));
    await page.click('deliveries-prev');
    assert.deepEqual(nameAndType(page.rows('deliveries-body')), expected.slice(0, 10).map((row) => [row.name, row.delivery_type]));

    await page.click('menu-query');
    assert.equal(page.element('screen-query').hidden, false);
    assert.equal(page.text('hero-title'), 'Consulta de SMS');
  });

  it('buscar un envío funciona con botón y con Enter, sin submit y con un doble Enter vale una consulta', async () => {
    const page = await openFixtureApp();
    await page.click('menu-deliveries');

    page.element('deliveries-query').value = 'ñandú';
    assert.equal(page.element('deliveries-form').fire('submit').defaultPrevented, true);
    const before = page.calls.length;
    page.element('deliveries-query').fire('keydown', { key: 'Enter' });
    page.element('deliveries-query').fire('keydown', { key: 'Enter' });
    await page.settled();
    assert.equal(page.calls.length, before + 1);
    assert.deepEqual(page.calls.at(-1).query.q, ['ñandú']);
    assert.deepEqual(page.rows('deliveries-body').map((row) => row[0]), ['Promo 100% _especial_ <b>ñandú</b>']);

    page.element('deliveries-query').value = 'no existe ninguno';
    await page.click('deliveries-button');
    assert.equal(page.element('deliveries-table').hidden, true);
    assert.equal(page.text('deliveries-status'), 'No hay envíos que mostrar. Los envíos que hagas aparecerán acá, junto con los programados.');
  });

  it('una fecha que falta se ve con guion en la lista', async () => {
    const page = await openFixtureApp();
    await page.click('menu-deliveries');
    page.element('deliveries-query').value = 'sin fecha programada';
    await page.click('deliveries-button');
    assert.equal(page.rows('deliveries-body')[0][3], '—');
    page.element('deliveries-query').value = 'en cero';
    await page.click('deliveries-button');
    assert.equal(page.rows('deliveries-body')[0][2], '—');
  });

  it('"Envío" lleva al detalle, y "Volver" deja la búsqueda como estaba, sin repetirla', async () => {
    const page = await openFixtureApp();
    await page.search({ 'filter-start': '2026-10-24', 'filter-end': '2026-10-24', 'filter-number': '' });
    const painted = page.rows();
    const row = page.element('results-body').children.findIndex((item) => item.children[4].children.length > 0);
    assert.ok(row >= 0, 'debe haber un SMS con enlace a su envío');

    page.element('results-body').children[row].children[4].children[0].fire('click');
    await page.settled();
    assert.equal(page.element('screen-delivery').hidden, false);
    assert.equal(page.element('back-button').hidden, false);
    assert.match(page.text('hero-title'), /^Envío «/);
    assert.match(page.text('hero-subtitle'), /^Identificador único: [0-9a-f]{32}$/);

    const searches = page.calls.filter((call) => call.path === '/api/sms').length;
    await page.click('back-button');
    assert.equal(page.element('screen-query').hidden, false);
    assert.equal(page.text('hero-title'), 'Consulta de SMS');
    assert.deepEqual(page.rows(), painted);
    assert.equal(page.calls.filter((call) => call.path === '/api/sms').length, searches);
    assert.equal(page.element('back-button').hidden, true);
  });

  it('el SMS de un envío de otro producto muestra el nombre como texto, sin enlace', async () => {
    const page = await openFixtureApp();
    page.network.overrides.set('/api/sms', () => ({
      status: 200,
      body: { items: [{ createdAt: '24/10/2026 10:00', dst: '56900000001', content: 'x', status: 'Entregado', delivery: 'De otro producto', deliveryId: null }], nextCursor: null },
    }));
    await page.search({ 'filter-start': '2026-10-24', 'filter-end': '2026-10-24' });
    const cell = page.element('results-body').children[0].children[4];
    assert.equal(cell.textContent, 'De otro producto');
    assert.equal(cell.children.length, 0);
  });

  it('el detalle completo pinta conteos que suman, dona, datos, respuestas, link y mensajes', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío chico con link único');
    assert.equal(page.text('hero-title'), 'Envío «Envío chico con link único»');
    assert.equal(page.text('hero-subtitle'), `Identificador único: ${uniqueOf(8)}`);
    assert.equal(page.element('delivery-complete').hidden, false);
    assert.equal(page.element('delivery-generating').hidden, true);
    assert.equal(page.element('delivery-failed').hidden, true);

    assert.deepEqual(page.facts('delivery-facts'), [
      ['Tipo', 'CUSTOM'],
      ['Fecha de creación', '24/10/2026 08:55'],
      ['Fecha programada', '24/10/2026 09:00'],
      ['Base', 'Base de prueba 101'],
    ]);

    // Un tramo por petición: el envío chico termina en pocas vueltas, con la pausa que pide el servidor.
    for (let turn = 0; turn < 8 && page.text('stats-status') !== ''; turn += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 1100); });
      await page.elapse();
    }
    assert.equal(page.text('stats-status'), '');
    assert.match(page.text('stats-updated'), /^Actualizado el \d{2}\/\d{2}\/\d{4} a las \d{2}:\d{2}$/);
    assert.deepEqual(page.waits().filter((wait) => wait === 5000), [], 'con la foto lista no sigue consultando');

    const [[{ total }]] = await admin.query('SELECT COUNT(*) AS total FROM dbconnectus.sms_outgoing WHERE id_delivery = 8 AND id_account = 101');
    const national = page.statsOf('stats-national');
    const international = page.statsOf('stats-international');
    assert.deepEqual(national.head, ['Estado', 'Movistar', 'Entel', 'Claro', 'Wom', 'VTR', 'Virgin', 'Otros', 'Total']);
    assert.deepEqual(international.head, ['Estado', 'Perú', 'Colombia', 'México', 'Brasil', 'Argentina', 'Otros', 'Total']);
    assert.equal(national.body.length, 9);
    assert.equal(national.body.at(-1)[0], 'Otros estados');
    const number = (text) => Number(text.replace(/\./g, ''));
    assert.equal(number(national.foot.at(-1)) + number(international.foot.at(-1)), Number(total));
    assert.equal(national.body.reduce((sum, row) => sum + number(row.at(-1)), 0), number(national.foot.at(-1)));

    // Las pestañas no piden nada.
    assert.equal(page.element('stats-national').hidden, false);
    assert.equal(page.element('stats-international').hidden, true);
    const before = page.calls.length;
    await page.click('tab-international');
    assert.equal(page.element('stats-national').hidden, true);
    assert.equal(page.element('stats-international').hidden, false);
    assert.equal(page.element('tab-international').getAttribute('aria-pressed'), 'true');
    assert.equal(page.calls.length, before);

    const slices = page.element('chart-svg').children.filter((node) => node.tag === 'circle');
    assert.ok(slices.length > 0);
    for (const slice of slices) {
      assert.equal(slice.namespace, SVG_NAMESPACE);
      assert.equal(slice.getAttribute('class'), 'donut__slice');
      assert.match(slice.getAttribute('stroke'), /^#[0-9a-f]{6}$/i);
      assert.equal(slice.getAttribute('style'), null);
    }
    assert.ok(page.element('chart-legend').children.length >= 8);

    const [[{ responses }]] = await admin.query('SELECT COUNT(*) AS responses FROM dbconnectus.sms_incoming WHERE id_delivery = 8');
    assert.ok(Number(responses) > 0);
    assert.deepEqual(page.facts('responses-facts'), [['Recibidas', asCount(Number(responses))]]);
    assert.equal(page.element('responses-button').hidden, false);

    assert.equal(page.element('link-card').hidden, false);
    assert.equal(page.text('link-title'), 'Link corto');
    assert.match(page.facts('link-facts')[0][1], /^http:\/\/cnct\.us\/./);
    assert.equal(page.facts('link-facts')[1][0], 'Clics');

    assert.ok(page.rows('messages-body').length > 0);
    assert.equal(page.rows('messages-body').length <= 10, true);
  });

  it('un envío sin base no muestra esa fila, y un dato nulo se ve con guion', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío sin fecha programada');
    assert.deepEqual(page.facts('delivery-facts'), [
      ['Tipo', 'API'],
      ['Fecha de creación', '24/10/2026 10:55'],
      ['Fecha programada', '—'],
    ]);
    assert.equal(page.element('link-card').hidden, true);
    await page.click('back-button');
    page.element('deliveries-query').value = 'con base sin nombre';
    await page.click('deliveries-button');
    await page.press('deliveries-body', 'Envío con base sin nombre');
    assert.deepEqual(page.facts('delivery-facts').at(-1), ['Base', '—']);
  });

  it('el envío en curso muestra su avance y, al terminar, pasa solo al detalle', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío en curso');
    assert.equal(page.element('delivery-generating').hidden, false);
    assert.equal(page.element('delivery-complete').hidden, true);
    assert.deepEqual(page.facts('delivery-generating-facts'), [
      ['Nombre de envío', 'Envío en curso'],
      ['Fecha programada', '20/11/2026 10:00'],
      ['Cantidad de contactos', '100'],
    ]);
    assert.equal(page.element('delivery-progress').getAttribute('max'), '100');
    assert.ok(page.element('delivery-progress').getAttribute('value') !== null);
    assert.match(page.text('delivery-progress-label'), / de 100$/);
    assert.deepEqual(page.waits(), [5000]);

    page.network.overrides.set('/api/delivery/progress', () => ({ status: 200, body: { variant: 'complete', sent: null, contacts: 100 } }));
    page.network.overrides.set('/api/delivery', () => ({
      status: 200,
      body: { id: uniqueOf(9), name: 'Envío en curso', type: 'CUSTOM', createdAt: null, deliverAt: null, hasBase: false, base: null, contacts: 100, variant: 'complete', report: null, incoming: null, responses: 0, link: null },
    }));
    await page.elapse();
    assert.equal(page.element('delivery-generating').hidden, true);
    assert.equal(page.element('delivery-complete').hidden, false);
  });

  it('el envío fallido muestra el motivo y no se consulta de nuevo', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío fallido');
    assert.equal(page.element('delivery-failed').hidden, false);
    assert.equal(page.element('delivery-complete').hidden, true);
    assert.equal(page.text('delivery-failed-reason'), 'No hay saldo suficiente para el envío');
    assert.deepEqual(page.waits(), [], 'un envío fallido no se consulta de nuevo');
  });

  it('un envío que ya no existe muestra el mensaje del servidor', async () => {
    const page = await openFixtureApp();
    page.network.overrides.set('/api/delivery', () => ({ status: 404, body: { error: 'not_found', message: 'Envío no encontrado.' } }));
    await openDeliveryFromList(page, 'Envío chico con link único');
    assert.equal(page.text('delivery-error'), 'Envío no encontrado.');
    assert.equal(page.element('delivery-complete').hidden, true);
  });

  it('los mensajes del envío buscan por número exacto, y el identificador abre el detalle de SMS', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Campaña de prueba 101-B');
    const [rows] = await admin.query(
      'SELECT id_unique, dst_number, sms_content, src_number, status FROM dbconnectus.sms_outgoing WHERE id_delivery = 2 AND id_account = 101 ORDER BY id LIMIT 11'
    );
    assert.deepEqual(page.rows('messages-body').map((row) => row[1]), rows.slice(0, 10).map((row) => row.id_unique));
    assert.equal(page.element('messages-next').disabled, false);
    await page.click('messages-next');
    assert.equal(page.rows('messages-body')[0][1], rows[10].id_unique);
    await page.click('messages-prev');

    const target = rows[0];
    page.element('messages-number').value = String(target.dst_number);
    assert.equal(page.element('messages-form').fire('submit').defaultPrevented, true);
    page.element('messages-number').fire('keydown', { key: 'Enter' });
    await page.settled();
    assert.deepEqual(page.calls.at(-1).query.dst, [String(target.dst_number)]);
    assert.ok(page.rows('messages-body').every((row) => row[2] === String(target.dst_number)));

    page.element('messages-number').value = '56999999999';
    await page.click('messages-button');
    assert.equal(page.text('messages-status'), 'No hay mensajes que mostrar.');
    assert.equal(page.element('messages-table').hidden, true);

    page.element('messages-number').value = String(target.dst_number);
    await page.click('messages-button');
    const painted = page.rows('messages-body');
    await page.press('messages-body', page.rows('messages-body')[0][1]);
    assert.equal(page.element('screen-sms').hidden, false);
    assert.equal(page.text('hero-title'), 'Mensaje enviado');
    const facts = new Map(page.facts('sms-facts'));
    assert.equal(facts.get('Envío'), 'Campaña de prueba 101-B');
    assert.equal(facts.get('Número de destino'), `+${target.dst_number}`);
    assert.ok(facts.has('Estado'));
    assert.match(page.text('sms-equivalent'), /^\d+ mensajes? equivalentes?$/);

    const messageCalls = page.calls.filter((call) => call.path === '/api/delivery/messages').length;
    await page.click('back-button');
    assert.equal(page.element('screen-delivery').hidden, false);
    assert.deepEqual(page.rows('messages-body'), painted, 'al volver, los mensajes siguen como estaban');
    assert.equal(page.calls.filter((call) => call.path === '/api/delivery/messages').length, messageCalls);
  });

  it('un mensaje que no existe muestra el mensaje del servidor, sin tarjeta', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Campaña de prueba 101-B');
    page.network.overrides.set('/api/sms/detail', () => ({ status: 404, body: { error: 'not_found', message: 'Mensaje no encontrado.' } }));
    await page.press('messages-body', page.rows('messages-body')[0][1]);
    assert.equal(page.text('sms-error'), 'Mensaje no encontrado.');
    assert.equal(page.element('sms-card').hidden, true);
  });

  it('el estado lleva la clase de su color, y una etiqueta desconocida queda neutra', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Campaña de prueba 101-B');
    page.network.overrides.set('/api/delivery/messages', () => ({
      status: 200,
      body: {
        items: ['Programado', 'Encolado', 'Entregado', 'No entregable', 'Enviado a proveedor', 'Esperando respuesta', 'Sin saldo', 'Sin información']
          .map((status, index) => ({ status, id: `sms${index}`, dst: '56900000001', provider: 'Otros', country: null, updatedAt: null })),
        nextCursor: null,
      },
    }));
    await page.click('messages-button');
    assert.deepEqual(
      page.element('messages-body').children.map((row) => row.children[0].children[0].className),
      ['info', 'info', 'ok', 'error', 'warn', 'warn', 'muted'].map((tone) => `status-pill status-pill--${tone}`).concat('status-pill')
    );
    assert.equal(page.rows('messages-body')[0][4], '—');
    assert.equal(page.rows('messages-body')[0][5], '—');
  });

  it('"Exportar resultados" encola con los filtros pintados, y el job pasa de Generando a Listo y a una descarga', async () => {
    const page = await openFixtureApp();
    await page.search({ 'filter-number': '56900000002', 'filter-start': '2026-10-10', 'filter-end': '2026-10-12' });
    assert.equal(page.element('results').hidden, false);

    page.element('export-results').fire('click');
    page.element('export-results').fire('click');
    assert.equal(page.text('export-results-status'), 'Encolando reporte…');
    await page.settled();
    const posted = page.calls.filter((call) => call.method === 'POST' && call.path === '/api/exports');
    assert.equal(posted.length, 1, 'el doble clic no crea dos');
    assert.deepEqual(JSON.parse(posted[0].body), { kind: 'sms_csv', account: '101', start: '2026-10-10', end: '2026-10-12', dst: '56900000002' });

    assert.equal(page.rows('exports-body').length, 1);
    assert.deepEqual(page.rows('exports-body')[0].slice(0, 5), ['Cuenta de prueba 101', '56900000002', '10/10/2026 — 12/10/2026', 'Generando', '—']);
    assert.equal(page.element('exports-generating').hidden, false);
    assert.deepEqual(page.waits(), [5000]);

    await finishJob(page);
    assert.deepEqual(page.rows('exports-body')[0].slice(3, 5), ['Listo', 'Descargar']);
    assert.equal(page.element('exports-generating').hidden, true);
    assert.deepEqual(page.waits(), [], 'sin nada generándose deja de consultar');

    assert.equal(page.element('download-help').hidden, true);
    await page.press('exports-body', 'Descargar');
    const [click] = page.document.anchorClicks;
    assert.ok(click.href.startsWith(FILE_URL_PREFIX));
    assert.equal(click.download, 'sms_2026-10-10_2026-10-12.csv');

    // El aviso sale tras cada intento, y el enlace solo al pulsar, nunca con la URL del archivo.
    assert.equal(page.element('download-help').hidden, false);
    assert.equal(page.element('download-help').parent, page.element('exports-card'));
    assert.equal(page.element('download-help-field').hidden, true);
    assert.equal(page.element('download-help-link').value, '');
    await page.click('download-help-show');
    assert.equal(page.element('download-help-field').hidden, false);
    assert.equal(page.element('download-help-link').value, 'http://localhost/#la-url-de-la-app');
    assert.equal(page.element('download-help-link').value.includes(FILE_URL_PREFIX), false);

    await page.click('menu-deliveries');
    assert.equal(page.element('download-help').hidden, true);
    assert.equal(page.element('download-help-link').value, '');
  });

  it('"Generar CSV" valida el rango, funciona con Enter y no manda número', async () => {
    const page = await openFixtureApp();
    assert.equal(page.element('full-report-start').value, page.element('filter-start').value);
    page.element('full-report-start').value = '2026-10-01';
    page.element('full-report-end').value = '2026-10-16';
    const before = page.calls.length;
    page.element('full-report-end').fire('keydown', { key: 'Enter' });
    await page.settled();
    assert.equal(page.text('full-report-error'), RANGE_MESSAGE);
    assert.equal(page.element('full-report-end').getAttribute('aria-invalid'), 'true');
    assert.equal(page.calls.length, before);

    page.element('full-report-start').value = '2026-10-10';
    assert.equal(page.element('full-report-form').fire('submit').defaultPrevented, true);
    page.element('full-report-end').fire('keydown', { key: 'Enter' });
    page.element('full-report-end').fire('keydown', { key: 'Enter' });
    await page.settled();
    assert.equal(page.text('full-report-error'), '');
    const posted = page.calls.filter((call) => call.method === 'POST' && call.path === '/api/exports');
    assert.equal(posted.length, 1);
    assert.deepEqual(JSON.parse(posted[0].body), { kind: 'sms_csv', account: '101', start: '2026-10-10', end: '2026-10-16' });
    assert.equal(page.rows('exports-body')[0][1], 'Todos los números');
  });

  it('un job fallido muestra su mensaje, sin el código, y el tope de exportaciones muestra el del servidor', async () => {
    const page = await openFixtureApp();
    await page.click('full-report-button');
    await finishJob(page, 'failed', ", error_code = 'too_many_rows'");
    const [row] = page.rows('exports-body');
    assert.match(row[3], /^Fallido.*1\.000\.000 de filas/);
    assert.equal(row[3].includes('too_many_rows'), false);
    assert.equal(row[4], '—');

    await admin.query(
      'INSERT INTO connectus_pages.export_job (public_id, id_login, id_account, kind, start_date, end_date, created_at) '
      + "SELECT MD5(CONCAT('tope', n)), ?, 101, 'sms_csv', '2026-10-01', '2026-10-02', ? FROM (SELECT 1 AS n UNION SELECT 2 UNION SELECT 3) numbers",
      [loginId, FIXTURE_NOW.slice(0, 19).replace('T', ' ')]
    );
    await page.click('full-report-button');
    assert.equal(page.text('full-report-error'), 'Ya tienes exportaciones en curso. Espera a que terminen para pedir otra.');
    assert.equal(page.text('full-report-status'), '');
    assert.equal(page.element('full-report-button').disabled, false);
  });

  it('una lista que falla deja el aviso, y "Actualizar" la vuelve a pedir', async () => {
    const page = await openFixtureApp();
    page.network.failure = new TypeError('Failed to fetch');
    await page.click('exports-refresh');
    assert.equal(page.text('exports-error'), GENERIC_ERROR);
    page.network.failure = null;
    await page.click('exports-refresh');
    assert.equal(page.text('exports-error'), '');
  });

  it('"Generar reporte" pasa a Generando y a "Descargar reporte", y al volver al detalle lo retoma', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío chico con link único');
    assert.equal(page.text('report-button'), 'Generar reporte');

    await page.click('report-button');
    assert.deepEqual(JSON.parse(page.calls.findLast((call) => call.method === 'POST').body), { kind: 'delivery_xlsx', account: '101', delivery: uniqueOf(8) });
    assert.equal(page.text('report-button'), 'Generando');
    assert.equal(page.element('report-button').disabled, true);

    // Sale y vuelve: el servidor sabe en qué va, y nada queda consultando mientras está afuera.
    await page.click('back-button');
    assert.deepEqual(page.waits(), []);
    await page.press('deliveries-body', 'Envío chico con link único');
    assert.equal(page.text('report-button'), 'Generando');
    assert.equal(page.element('report-button').disabled, true);

    await finishJob(page);
    assert.equal(page.text('report-button'), 'Descargar reporte');
    assert.equal(page.element('report-button').disabled, false);

    await page.click('report-button');
    const [click] = page.document.anchorClicks;
    assert.ok(click.href.startsWith(FILE_URL_PREFIX));
    assert.match(click.download, /^Reporte_de_envío_\d{2}-\d{2}-\d{4}_[0-9a-f]{8}\.xlsx$/);
    assert.equal(page.element('download-help').parent, page.element('report-card'));
    assert.equal(page.element('download-help').hidden, false);
  });

  for (const [prefix, kind, readyLabel] of [['report', 'delivery_xlsx', 'Descargar reporte'], ['responses', 'incoming_xlsx', 'Descargar']]) {
    it(`${prefix}: uno ya listo muestra su fecha y se puede generar de nuevo, también al volver al detalle`, async () => {
      const page = await openFixtureApp();
      await openDeliveryFromList(page, 'Envío chico con link único');
      assert.equal(page.element(`${prefix}-regenerate`).hidden, true);
      assert.equal(page.element(`${prefix}-note`).hidden, true);

      await page.click(`${prefix}-button`);
      await finishJob(page);
      assert.equal(page.text(`${prefix}-button`), readyLabel);
      assert.equal(page.text(`${prefix}-generated`), 'Generado el 20/11/2026 a las 12:00');
      assert.equal(page.element(`${prefix}-regenerate`).hidden, false);
      assert.equal(page.element(`${prefix}-note`).hidden, false);

      await page.click('back-button');
      await page.press('deliveries-body', 'Envío chico con link único');
      assert.equal(page.text(`${prefix}-generated`), 'Generado el 20/11/2026 a las 12:00');

      await page.click(`${prefix}-regenerate`);
      const posted = page.calls.filter((call) => call.method === 'POST' && call.path === '/api/exports');
      assert.equal(posted.length, 2);
      assert.equal(JSON.parse(posted[1].body).kind, kind);
      assert.equal(page.text(`${prefix}-button`), 'Generando');
      assert.equal(page.element(`${prefix}-button`).disabled, true);
      assert.equal(page.element(`${prefix}-regenerate`).hidden, true);
      assert.equal(page.element(`${prefix}-note`).hidden, true);
      assert.equal(page.text(`${prefix}-generated`), '');
      const [[{ jobs }]] = await admin.query('SELECT COUNT(*) AS jobs FROM connectus_pages.export_job WHERE id_login = ? AND kind = ?', [loginId, kind]);
      assert.equal(Number(jobs), 2);

      await finishJob(page);
      assert.equal(page.text(`${prefix}-button`), readyLabel);
    });

    it(`${prefix}: si el tope rechaza generar de nuevo, queda su mensaje y el archivo sigue disponible`, async () => {
      const page = await openFixtureApp();
      await openDeliveryFromList(page, 'Envío chico con link único');
      await page.click(`${prefix}-button`);
      await finishJob(page);
      page.network.overrides.set('/api/exports', () => ({ status: 429, body: { error: 'export_limit', message: 'Llegaste al tope.' } }));
      await page.click(`${prefix}-regenerate`);
      assert.equal(page.text(`${prefix}-error`), 'Llegaste al tope.');
      assert.equal(page.text(`${prefix}-button`), readyLabel);
      assert.equal(page.element(`${prefix}-button`).disabled, false);
      assert.equal(page.element(`${prefix}-regenerate`).disabled, false);
    });
  }

  it('la línea sobre una descarga fallida se ve antes del clic, y un archivo que ya no está deja el mensaje, sin descarga', async () => {
    const page = await openFixtureApp();
    assert.equal(page.element('exports-note').hidden, true);
    await page.click('full-report-button');
    assert.equal(page.element('exports-note').hidden, true);
    await finishJob(page);
    assert.equal(page.element('exports-note').hidden, false);

    page.network.overrides.set('/api/exports/download', () => ({ status: 404, body: { error: 'not_found', message: 'El archivo ya no está disponible. Genera uno nuevo.' } }));
    await page.press('exports-body', 'Descargar');
    assert.equal(page.text('exports-error'), 'El archivo ya no está disponible. Genera uno nuevo.');
    assert.deepEqual(page.document.anchorClicks, []);
    assert.equal(page.element('download-help').hidden, true);
    assert.equal(page.element('query-view').hidden, false);
  });

  const withoutAccount = async (account, run) => {
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ? AND id_account = ?', [loginId, account]);
    try {
      await run();
    } finally {
      await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, ?)', [loginId, account]);
    }
  };
  const accountOptions = (page) => page.element('account-select').children.map((option) => option.value);

  it('un 403 al descargar de otra cuenta la saca, y la cuenta en uso sigue con sus filtros y resultados', async () => {
    const page = await openFixtureApp();
    await page.search({ 'account-select': '102' });
    await page.click('full-report-button');
    await finishJob(page);
    await page.search({ 'account-select': '101', 'filter-number': '56900000002', 'filter-start': '2026-10-10', 'filter-end': '2026-10-12' });
    assert.ok(page.rows().length > 0);
    assert.deepEqual(page.rows('exports-body')[0].slice(3, 5), ['Listo', 'Descargar']);

    await withoutAccount(102, async () => {
      await page.press('exports-body', 'Descargar');
      assert.deepEqual(accountOptions(page), ['101']);
      assert.equal(page.element('account-select').value, '101');
      assert.equal(page.text('search-error'), 'No tienes acceso a esa cuenta.');
      assert.equal(page.element('filter-number').value, '56900000002');
      assert.ok(page.rows().length > 0);
      assert.deepEqual(page.rows('exports-body'), [], 'la fila de esa cuenta ya no se ofrece');
      assert.deepEqual(page.document.anchorClicks, []);
    });
  });

  it('un 403 al descargar de la cuenta en uso la saca, y parte de cero', async () => {
    const page = await openFixtureApp();
    await page.search({ 'account-select': '102' });
    await page.click('full-report-button');
    await finishJob(page);
    await withoutAccount(102, async () => {
      await page.press('exports-body', 'Descargar');
      assert.deepEqual(accountOptions(page), ['101']);
      assert.equal(page.text('search-error'), 'No tienes acceso a esa cuenta.');
    });
  });

  it('un 403 tardío de un CSV de la cuenta anterior no mueve la cuenta en uso ni borra lo escrito', async () => {
    const page = await openFixtureApp();
    await page.search({ 'account-select': '102' });
    await withoutAccount(102, async () => {
      page.element('full-report-button').fire('click');
      page.setFilter('account-select', '101');
      page.setFilter('filter-number', '56900000002');
      await page.settled();
      assert.deepEqual(accountOptions(page), ['101']);
      assert.equal(page.element('account-select').value, '101');
      assert.equal(page.element('filter-number').value, '56900000002');
      assert.equal(page.text('search-error'), 'No tienes acceso a esa cuenta.');
    });
  });

  describe('salir de Consulta mientras se encola un CSV', () => {
    const LIMIT_MESSAGE = 'Ya tienes exportaciones en curso. Espera a que terminen para pedir otra.';

    function holdPost(page) {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      page.network.overrides.set('/api/exports', async (method) => {
        if (method !== 'POST') return { status: 200, body: { items: [], nextCursor: null } };
        await held;
        return { status: 429, body: { error: 'export_limit', message: LIMIT_MESSAGE } };
      });
      return release;
    }

    it('un rechazo se ve al volver, sin "Encolando" pegado', async () => {
      const page = await openFixtureApp();
      const release = holdPost(page);
      page.element('full-report-button').fire('click');
      assert.equal(page.text('full-report-status'), 'Encolando reporte…');
      page.element('menu-deliveries').fire('click');
      release();
      await page.settled();
      await page.click('menu-query');
      assert.equal(page.text('full-report-status'), '');
      assert.equal(page.text('full-report-error'), LIMIT_MESSAGE);
      assert.equal(page.element('full-report-button').disabled, false);
    });

    it('volver antes de la respuesta: la lista se recarga y sigue consultando', async () => {
      const page = await openFixtureApp();
      page.element('full-report-button').fire('click');
      page.element('menu-deliveries').fire('click');
      page.element('menu-query').fire('click');
      await page.settled();
      assert.equal(page.text('full-report-status'), 'Reporte encolado. Aparece en Exportaciones recientes.');
      assert.equal(page.rows('exports-body').length, 1);
      assert.deepEqual(page.waits(), [5000]);
    });

    it('fuera de Consulta no pide la lista ni deja consultas repetidas, y al volver trae el job', async () => {
      const page = await openFixtureApp();
      page.element('full-report-button').fire('click');
      page.element('menu-deliveries').fire('click');
      await page.settled();
      assert.deepEqual(page.waits(), []);
      assert.equal(page.element('screen-deliveries').hidden, false);
      await page.click('menu-query');
      assert.equal(page.rows('exports-body').length, 1);
    });

    it('cambiar de cuenta sí descarta la respuesta', async () => {
      const page = await openFixtureApp();
      const release = holdPost(page);
      page.element('full-report-button').fire('click');
      page.setFilter('account-select', '102');
      release();
      await page.settled();
      assert.equal(page.text('full-report-status'), '');
      assert.equal(page.text('full-report-error'), '');
    });
  });

  describe('la foto con errores', () => {
    const computing = () => ({ status: 200, body: { state: 'computing', updatedAt: null, progressRows: 0, retryAfterMs: 0, national: null, international: null, chart: null, links: null } });
    const failed = () => ({ status: 500, body: { error: 'internal', message: 'Falló el servidor.' } });

    it('al primer fallo avisa que reintenta, y al tercero seguido muestra el error y "Actualizar", y deja de consultar', async () => {
      const page = await openFixtureApp();
      page.network.overrides.set('/api/delivery/stats', failed);
      await openDeliveryFromList(page, 'Envío chico con link único');
      assert.equal(page.text('stats-status'), 'Reintentando…');
      assert.equal(page.text('stats-error'), '');
      await page.elapse();
      assert.equal(page.text('stats-status'), 'Reintentando…');
      await page.elapse();
      assert.equal(page.text('stats-status'), '');
      assert.equal(page.text('stats-error'), 'Falló el servidor.');
      assert.equal(page.element('stats-refresh').hidden, false);
      assert.deepEqual(page.waits(), []);

      page.network.overrides.delete('/api/delivery/stats');
      await page.click('stats-refresh');
      assert.equal(page.text('stats-error'), '');
      assert.equal(page.element('stats-refresh').hidden, true);
    });

    it('un fallo de red da el error genérico', async () => {
      const page = await openFixtureApp();
      page.network.overrides.set('/api/delivery/stats', () => { throw new TypeError('Failed to fetch'); });
      await openDeliveryFromList(page, 'Envío chico con link único');
      await page.elapse();
      await page.elapse();
      assert.equal(page.text('stats-error'), GENERIC_ERROR);
    });

    it('solo cuentan los fallos seguidos: una respuesta buena reinicia la cuenta', async () => {
      const page = await openFixtureApp();
      let answer = failed;
      page.network.overrides.set('/api/delivery/stats', () => answer());
      await openDeliveryFromList(page, 'Envío chico con link único');
      await page.elapse();
      answer = computing;
      await page.elapse();
      assert.equal(page.text('stats-status'), 'Calculando…');
      answer = failed;
      await page.elapse();
      await page.elapse();
      assert.equal(page.text('stats-status'), 'Reintentando…');
      assert.equal(page.text('stats-error'), '');
      assert.equal(page.waits().length, 1);
    });

    it('si el tope llega con la última respuesta fallida, muestra el error y no "Sigue calculando"', async () => {
      const page = await openFixtureApp();
      let answer = computing;
      page.network.overrides.set('/api/delivery/stats', () => answer());
      await openDeliveryFromList(page, 'Envío chico con link único');
      for (let turn = 0; turn < 57; turn += 1) await page.elapse();
      answer = failed;
      await page.elapse();
      assert.equal(page.text('stats-status'), 'Reintentando…');
      await page.elapse();
      assert.deepEqual(page.waits(), []);
      assert.equal(page.text('stats-status'), '');
      assert.equal(page.text('stats-error'), 'Falló el servidor.');
      assert.equal(page.element('stats-refresh').hidden, false);
    });
  });

  it('un reporte fallido muestra el motivo y deja volver a generarlo', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío chico con link único');
    await page.click('report-button');
    await finishJob(page, 'failed', ", error_code = 'stalled'");
    assert.equal(page.text('report-error'), 'La generación se interrumpió varias veces. Inténtalo de nuevo más tarde.');
    assert.equal(page.text('report-button'), 'Generar reporte');
    assert.equal(page.element('report-button').disabled, false);
  });

  it('"Respuestas" sigue el mismo flujo, con su propio tipo de archivo', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío chico con link único');
    await page.click('responses-button');
    assert.equal(JSON.parse(page.calls.findLast((call) => call.method === 'POST').body).kind, 'incoming_xlsx');
    assert.equal(page.text('responses-button'), 'Generando');
    await finishJob(page);
    assert.equal(page.text('responses-button'), 'Descargar');
    await page.click('responses-button');
    assert.match(page.document.anchorClicks[0].download, /^Respuestas_de_envío_/);
    assert.equal(page.text('report-button'), 'Generar reporte', 'el reporte no se confunde con las respuestas');
  });

  it('sin respuestas no hay nada que descargar', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío sin fecha programada');
    assert.deepEqual(page.facts('responses-facts'), [['Recibidas', '0']]);
    assert.equal(page.element('responses-button').hidden, true);
  });

  it('las consultas repetidas esperan 5 s, crecen ×1,5 hasta 30 s y paran a las 60, con "Sigue generando" y "Actualizar"', async () => {
    const page = await openFixtureApp();
    await page.click('full-report-button');
    const waits = [];
    for (let turn = 0; turn < 60; turn += 1) {
      waits.push(...page.waits());
      await page.elapse();
    }
    assert.deepEqual(waits.slice(0, 7), [5000, 5000, 7500, 11250, 16875, 25312.5, 30000]);
    assert.equal(waits.at(-1), 30000);
    assert.equal(waits.length, 60);
    assert.ok(waits.every((wait) => wait >= 5000 && wait <= 30000));
    assert.deepEqual(page.waits(), []);
    assert.equal(page.text('exports-status'), 'Sigue generando. Presiona Actualizar para revisar de nuevo.');
    assert.equal(page.calls.filter((call) => call.path === '/api/exports' && call.method === 'GET').length, 62);

    await page.click('exports-refresh');
    assert.equal(page.text('exports-status'), '');
    assert.deepEqual(page.waits(), [5000]);
  });

  it('el mismo tope vale para el envío en curso y para el reporte, cada uno con su "Actualizar"', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío en curso');
    const progress = () => ({ status: 200, body: { variant: 'generating', sent: 1, contacts: 100 } });
    page.network.overrides.set('/api/delivery/progress', progress);
    for (let turn = 0; turn < 59; turn += 1) await page.elapse();
    assert.equal(page.text('delivery-progress-status'), 'Sigue generando. Presiona Actualizar para revisar de nuevo.');
    assert.equal(page.element('delivery-progress-refresh').hidden, false);
    assert.deepEqual(page.waits(), []);
    await page.click('delivery-progress-refresh');
    assert.equal(page.element('delivery-progress-refresh').hidden, true);
    assert.deepEqual(page.waits(), [5000]);

    await page.click('back-button');
    await openDeliveryFromList(page, 'Envío chico con link único');
    await page.click('report-button');
    page.network.overrides.set('/api/delivery/stats', () => ({ status: 200, body: { state: 'ready', updatedAt: null, progressRows: 0, retryAfterMs: 0, national: null, international: null, chart: null, links: null } }));
    for (let turn = 0; turn < 60; turn += 1) await page.elapse();
    assert.equal(page.text('report-status'), 'Sigue generando. Presiona Actualizar para revisar de nuevo.');
    assert.equal(page.element('report-refresh').hidden, false);
    await finishJobWithoutTimers();
    await page.click('report-refresh');
    assert.equal(page.text('report-button'), 'Descargar reporte');
    assert.equal(page.element('report-refresh').hidden, true);
  });

  async function finishJobWithoutTimers() {
    await admin.query("UPDATE connectus_pages.export_job SET state = 'finished', storage_key = CONCAT('exports/', public_id) WHERE id_login = ?", [loginId]);
  }

  it('la foto: si suben las filas espera max(5 s, retryAfterMs) sin gastar el tope; sin avance, crece y lo gasta', async () => {
    const page = await openFixtureApp();
    let rows = 0;
    let retryAfterMs = 0;
    const computing = () => ({
      status: 200,
      body: { state: 'computing', updatedAt: null, progressRows: rows, retryAfterMs, national: null, international: null, chart: null, links: null },
    });
    page.network.overrides.set('/api/delivery/stats', computing);
    await openDeliveryFromList(page, 'Envío chico con link único');
    assert.equal(page.text('stats-status'), 'Calculando…');
    assert.equal(page.element('stats-national').hidden, true);

    for (let turn = 0; turn < 100; turn += 1) {
      rows += 5000;
      retryAfterMs = turn % 2 === 0 ? 1000 : 9000;
      await page.elapse();
      assert.deepEqual(page.waits(), [retryAfterMs === 9000 ? 9000 : 5000], `vuelta ${turn}`);
    }
    assert.equal(page.text('stats-status'), 'Calculando: 500.000 filas procesadas.');

    retryAfterMs = 0;
    const waits = [];
    for (let turn = 0; turn < 59; turn += 1) {
      await page.elapse();
      waits.push(...page.waits());
    }
    assert.deepEqual(waits.slice(0, 4), [7500, 11250, 16875, 25312.5]);
    assert.deepEqual(page.waits(), [], 'la primera respuesta y estas 59 sin avance llegan al tope');
    assert.equal(page.text('stats-status'), 'Sigue calculando. Presiona Actualizar para revisar de nuevo.');
    assert.equal(page.element('stats-refresh').hidden, false);

    await page.click('stats-refresh');
    assert.equal(page.element('stats-refresh').hidden, true);
    assert.equal(page.text('stats-status'), 'Calculando: 500.000 filas procesadas.');
  });

  it('mientras recalcula muestra la foto anterior; si falla, el aviso, sin borrarla', async () => {
    const page = await openFixtureApp();
    const table = { columns: ['Otros'], rows: [{ label: 'Entregado', cells: [7], total: 7 }], totals: { cells: [7], total: 7 } };
    const photo = (state) => ({
      status: 200,
      body: { state, updatedAt: '20/11/2026 12:00', progressRows: 0, retryAfterMs: 0, national: table, international: table, chart: [{ label: 'Entregados', color: '#2ccec0', value: 7 }], links: null },
    });
    let state = 'computing';
    page.network.overrides.set('/api/delivery/stats', () => photo(state));
    await openDeliveryFromList(page, 'Envío chico con link único');
    assert.equal(page.text('stats-updated'), 'Actualizado el 20/11/2026 a las 12:00');
    assert.equal(page.statsOf('stats-national').foot.at(-1), '7');
    assert.equal(page.text('stats-status'), 'Calculando…');

    state = 'failed';
    await page.elapse();
    assert.equal(page.text('stats-error'), 'No se pudieron calcular los conteos. Inténtalo más tarde.');
    assert.equal(page.statsOf('stats-national').foot.at(-1), '7');
    assert.deepEqual(page.waits(), []);
  });

  it('con la foto de varios links muestra "Links cortos" y los clics sumados, sin dirección', async () => {
    const page = await openFixtureApp();
    page.network.overrides.set('/api/delivery/stats', () => ({
      status: 200,
      body: { state: 'ready', updatedAt: null, progressRows: 0, retryAfterMs: 0, national: null, international: null, chart: null, links: { distinct: 3, clicks: 1200 } },
    }));
    await openDeliveryFromList(page, 'Envío chico con link único');
    assert.equal(page.text('link-title'), 'Links cortos');
    assert.deepEqual(page.facts('link-facts'), [['Links distintos', '3'], ['Clics', '1.200']]);
  });

  it('con la pestaña oculta no consulta, y al volver sigue', async () => {
    const page = await openFixtureApp();
    await page.click('full-report-button');
    const before = page.calls.length;
    await page.setHidden(true);
    await page.elapse();
    assert.equal(page.calls.length, before);
    assert.deepEqual(page.waits(), []);
    await page.setHidden(false);
    assert.equal(page.calls.length, before + 1);
    assert.deepEqual(page.waits(), [5000]);
  });

  it('al salir de una pantalla se cancela lo suyo, y una respuesta vieja no pisa a la vigente', async () => {
    const page = await openFixtureApp();
    await page.click('full-report-button');
    assert.deepEqual(page.waits(), [5000]);
    await page.click('menu-deliveries');
    assert.deepEqual(page.waits(), [], 'las exportaciones ya no se consultan');

    // Abre un envío y vuelve sin esperar: lo que responda después ya no tiene dónde pintarse.
    page.buttonIn('deliveries-body', page.rows('deliveries-body')[0][0]).fire('click');
    page.element('back-button').fire('click');
    await page.settled();
    assert.equal(page.element('screen-deliveries').hidden, false);
    assert.equal(page.text('hero-title'), 'Historial de envíos SMS');
    assert.equal(page.text('delivery-status'), 'Cargando el envío…', 'la respuesta vieja no llegó a pintarse');
    assert.deepEqual(page.waits(), []);

    // Dos búsquedas seguidas: gana la última, aunque la primera responda después.
    page.element('deliveries-query').value = 'Envío en curso';
    page.element('deliveries-button').fire('click');
    page.element('deliveries-query').value = 'Envío fallido por una excepción';
    page.element('deliveries-button').fire('click');
    await page.settled();
    assert.deepEqual(page.rows('deliveries-body').map((row) => row[0]), ['Envío fallido por una excepción']);
  });

  it('cambiar de cuenta vuelve a Consulta con los filtros limpios y nada de la cuenta anterior', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Envío chico con link único');
    page.element('account-select').value = '102';
    page.element('account-select').fire('change');
    await page.settled();
    assert.equal(page.element('screen-query').hidden, false);
    assert.equal(page.element('screen-delivery').hidden, true);
    assert.equal(page.element('back-button').hidden, true);
    assert.equal(page.text('hero-subtitle'), 'Revisa mensajes y genera reportes para Cuenta de prueba 102.');
    assert.deepEqual(page.rows('messages-body'), []);
    assert.deepEqual(page.waits(), []);

    await page.search({ 'filter-number': '56900000777', 'filter-start': '2026-10-16', 'filter-end': '2026-10-17' });
    assert.ok(page.rows().length > 0);
    page.element('account-select').value = '101';
    page.element('account-select').fire('change');
    await page.settled();
    assert.deepEqual(page.rows(), []);
    assert.equal(page.element('results').hidden, true);
    assert.equal(page.element('filter-number').value, '');
    assert.notEqual(page.element('filter-start').value, '2026-10-16');

    await page.click('menu-deliveries');
    assert.deepEqual(page.calls.at(-1).query.account, ['101']);
  });

  it('un 403 en el detalle saca la cuenta y vuelve a Consulta con el mensaje', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Campaña de prueba 101-B');
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login = ? AND id_account = 101', [loginId]);
    try {
      await page.click('messages-button');
      assert.equal(page.element('screen-query').hidden, false);
      assert.equal(page.element('screen-delivery').hidden, true);
      assert.equal(page.text('search-error'), 'No tienes acceso a esa cuenta.');
      assert.deepEqual(page.element('account-select').children.map((option) => option.value), ['102']);
      assert.deepEqual(page.rows('messages-body'), []);
      assert.deepEqual(page.waits(), []);
    } finally {
      await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, 101)', [loginId]);
    }
  });

  it('un 401 en cualquier pantalla borra todo y vuelve al login', async () => {
    const page = await openFixtureApp();
    await openDeliveryFromList(page, 'Campaña de prueba 101-B');
    assert.ok(page.rows('messages-body').length > 0);
    await page.press('messages-body', page.rows('messages-body')[0][1]);
    assert.equal(page.element('sms-card').hidden, false);

    await admin.query('UPDATE connectus_pages.login SET active = 0 WHERE id = ?', [loginId]);
    try {
      await page.click('back-button');
      assert.equal(page.element('login-view').hidden, false);
      assert.equal(page.element('query-view').hidden, true);
      assert.equal(page.text('login-error'), SESSION_EXPIRED);
      assert.equal(page.text('hero-title'), 'Consulta de SMS');
      assert.deepEqual(page.rows('messages-body'), []);
      assert.deepEqual(page.rows('deliveries-body'), []);
      assert.deepEqual(page.rows('exports-body'), []);
      assert.equal(page.text('sms-content'), '');
      assert.deepEqual(page.waits(), []);
    } finally {
      await admin.query('UPDATE connectus_pages.login SET active = 1 WHERE id = ?', [loginId]);
    }
  });

  it('bajo sandbox sin allow-forms y con CORS abierto, todo el recorrido anda con botón y Enter', async () => {
    const page = await openFixtureApp({ embedded: true, opaque: true, using: opaqueFixtureHandler });
    page.element('deliveries-query').value = 'Campaña de prueba 101-B';
    await page.click('menu-deliveries');
    page.element('deliveries-query').value = 'Campaña de prueba 101-B';
    page.element('deliveries-query').fire('keydown', { key: 'Enter' });
    await page.settled();
    await page.press('deliveries-body', 'Campaña de prueba 101-B');
    assert.equal(page.element('delivery-complete').hidden, false);

    page.element('messages-number').value = '56999999999';
    page.element('messages-number').fire('keydown', { key: 'Enter' });
    await page.settled();
    assert.equal(page.text('messages-status'), 'No hay mensajes que mostrar.');

    await page.click('report-button');
    assert.equal(page.text('report-button'), 'Generando');
    await finishJob(page);
    await page.click('report-button');
    assert.equal(page.document.anchorClicks.length, 1);
    assert.equal(page.element('download-help').hidden, false);
  });
});
