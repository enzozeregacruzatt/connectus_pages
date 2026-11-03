(function () {
  'use strict';

  const TIME_ZONE = 'America/Santiago';
  const MAX_RANGE_DAYS = 15;
  const MAX_NUMBER_DIGITS = 15;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const LOGIN_PATH = 'api/login';
  const SMS_PATH = 'api/sms';

  const RANGE_ERROR = 'El rango debe ser válido y no superar 15 días.';
  const NUMBER_ERROR = 'Debes indicar un número destino válido.';
  const NETWORK_ERROR = 'No se pudo conectar con el servidor. Inténtalo de nuevo.';
  const GENERIC_ERROR = 'No se pudo completar la solicitud. Inténtalo de nuevo.';
  const SESSION_EXPIRED = 'Tu sesión venció. Vuelve a ingresar.';
  const EMPTY_RESULTS = 'No se encontraron SMS para estos filtros.';
  const FILTERS_CHANGED = 'Los filtros cambiaron. Presiona Buscar para ver los resultados.';

  const byId = (id) => document.getElementById(id);

  const els = {
    loadNotice: byId('load-notice'),
    loginView: byId('login-view'),
    loginForm: byId('login-form'),
    username: byId('login-username'),
    password: byId('login-password'),
    loginButton: byId('login-button'),
    loginStatus: byId('login-status'),
    loginError: byId('login-error'),
    queryView: byId('query-view'),
    logoutButton: byId('logout-button'),
    searchForm: byId('search-form'),
    accountChoice: byId('account-choice'),
    accountSelect: byId('account-select'),
    accountSingle: byId('account-single'),
    accountName: byId('account-name'),
    number: byId('filter-number'),
    start: byId('filter-start'),
    end: byId('filter-end'),
    searchButton: byId('search-button'),
    searchStatus: byId('search-status'),
    searchError: byId('search-error'),
    results: byId('results'),
    resultsTitle: byId('results-title'),
    resultsSummary: byId('results-summary'),
    resultsBody: byId('results-body'),
    pager: byId('pager'),
    pagePrev: byId('page-prev'),
    pageLabel: byId('page-label'),
    pageNext: byId('page-next'),
  };

  let token = null;
  let accounts = [];
  // Página pintada: { filters, cursor, stack, next }. Si existe, coincide con lo que dice el formulario.
  let page = null;
  // Búsqueda en curso: { query, controller }. Una respuesta solo se pinta si sigue siendo esta.
  let pending = null;

  function setMessage(element, text) {
    element.textContent = text;
  }

  async function requestJson(path, options) {
    const response = await fetch(path, { credentials: 'omit', ...options });
    let body = null;
    try {
      body = await response.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
    return { status: response.status, body };
  }

  // API Gateway también responde errores propios, en inglés y sin `error`: esos no se muestran.
  function serverMessage(body) {
    if (body && typeof body.error === 'string' && typeof body.message === 'string' && body.message) {
      return body.message;
    }
    return GENERIC_ERROR;
  }

  // Aritmética de calendario sobre medianoche UTC, para que el cambio de hora de Chile no mueva los días.
  function todayInSantiago() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type) => Number(parts.find((item) => item.type === type).value);
    return Date.UTC(part('year'), part('month') - 1, part('day'));
  }

  function toIsoDate(time) {
    return new Date(time).toISOString().slice(0, 10);
  }

  function parseIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return toIsoDate(time) === value ? time : null;
  }

  function isValidRange(startValue, endValue) {
    const start = parseIsoDate(startValue);
    const end = parseIsoDate(endValue);
    if (start === null || end === null) return false;
    return end >= start && (end - start) / DAY_MS < MAX_RANGE_DAYS;
  }

  function setDefaultDates() {
    const today = todayInSantiago();
    els.start.value = toIsoDate(today - (MAX_RANGE_DAYS - 1) * DAY_MS);
    els.end.value = toIsoDate(today);
  }

  function clearInvalidMarks() {
    [els.number, els.start, els.end].forEach((field) => field.removeAttribute('aria-invalid'));
  }

  function rejectFilters(message, fields) {
    fields.forEach((field) => field.setAttribute('aria-invalid', 'true'));
    setMessage(els.searchStatus, '');
    setMessage(els.searchError, message);
    fields[0].focus();
  }

  // El servidor valida de verdad; esto solo evita un viaje para los errores evidentes.
  function readFilters() {
    const start = els.start.value;
    const end = els.end.value;
    if (!isValidRange(start, end)) {
      rejectFilters(RANGE_ERROR, [els.start, els.end]);
      return null;
    }

    const rawNumber = els.number.value.trim();
    const dst = rawNumber.replace(/\D/g, '');
    if (rawNumber && (dst.length === 0 || dst.length > MAX_NUMBER_DIGITS)) {
      rejectFilters(NUMBER_ERROR, [els.number]);
      return null;
    }

    return { account: els.accountSelect.value, start, end, dst };
  }

  function buildQuery(filters, cursor) {
    const params = new URLSearchParams({
      account: filters.account,
      start: filters.start,
      end: filters.end,
    });
    if (filters.dst) params.set('dst', filters.dst);
    if (cursor) params.set('cursor', cursor);
    return params.toString();
  }

  function cancelPending() {
    if (pending) pending.controller.abort();
    pending = null;
  }

  function updatePager(busy) {
    const hasPrev = page !== null && page.stack.length > 0;
    const hasNext = page !== null && page.next !== null;
    els.pager.hidden = !hasPrev && !hasNext;
    els.pagePrev.disabled = busy || !hasPrev;
    els.pageNext.disabled = busy || !hasNext;
    els.pageLabel.textContent = page ? `Página ${page.stack.length + 1}` : '';
  }

  function setBusy(busy) {
    els.results.setAttribute('aria-busy', String(busy));
    updatePager(busy);
  }

  function clearResults() {
    page = null;
    els.resultsBody.replaceChildren();
    els.resultsSummary.textContent = '';
    els.results.hidden = true;
    setBusy(false);
  }

  function addCell(row, text, className) {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = text;
    row.append(cell);
    return cell;
  }

  function buildRow(item) {
    const row = document.createElement('tr');
    addCell(row, item.createdAt, 'sms-table__date');
    addCell(row, item.dst, 'sms-table__number');
    addCell(row, item.content, 'sms-table__message');

    const statusCell = addCell(row, '');
    const pill = document.createElement('span');
    pill.className = 'status-pill';
    pill.textContent = item.status;
    statusCell.append(pill);

    if (item.delivery === null || item.delivery === undefined) {
      addCell(row, 'Sin envío', 'sms-table__delivery sms-table__none');
    } else {
      addCell(row, item.delivery, 'sms-table__delivery');
    }
    return row;
  }

  function renderPage(items) {
    els.resultsBody.replaceChildren(...items.map(buildRow));
    els.resultsSummary.textContent = page.filters.dst
      ? `Mensajes enviados a ${page.filters.dst}.`
      : 'Todos los mensajes del período seleccionado.';
    // Una página posterior puede quedar vacía si cambian los datos; ahí sigue haciendo falta "Anterior".
    els.results.hidden = items.length === 0 && page.stack.length === 0;

    if (items.length === 0) {
      setMessage(els.searchStatus, EMPTY_RESULTS);
    } else {
      const noun = items.length === 1 ? 'mensaje' : 'mensajes';
      setMessage(els.searchStatus, `${items.length} ${noun} en esta página.`);
    }
  }

  async function loadPage(target, moveFocus) {
    const query = buildQuery(target.filters, target.cursor);
    // Un doble clic no debe lanzar otra consulta pesada: abortar en el navegador no la detiene en la base.
    if (pending && pending.query === query) return;

    cancelPending();
    const current = { query, controller: new AbortController() };
    pending = current;
    setMessage(els.searchError, '');
    setMessage(els.searchStatus, 'Buscando mensajes…');
    setBusy(true);

    let result = null;
    try {
      result = await requestJson(`${SMS_PATH}?${query}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: current.controller.signal,
      });
    } catch (err) {
      // Abortada o de red: se decide abajo, según si sigue siendo la búsqueda vigente.
    }

    if (pending !== current) return;
    pending = null;

    if (result && result.status === 401) {
      endSession(SESSION_EXPIRED);
      return;
    }

    const body = result && result.body;
    // Le quitaron la cuenta: nada de ella debe seguir en pantalla, ni la cuenta en el selector.
    if (result && result.status === 403) {
      clearResults();
      forgetAccount(target.filters.account);
      setMessage(els.searchStatus, '');
      setMessage(els.searchError, serverMessage(body));
      focusFirstFilter();
      return;
    }

    if (result && result.status === 200 && body && Array.isArray(body.items)) {
      page = { ...target, next: typeof body.nextCursor === 'string' ? body.nextCursor : null };
      renderPage(body.items);
    } else {
      setMessage(els.searchStatus, '');
      setMessage(els.searchError, result ? serverMessage(body) : NETWORK_ERROR);
    }

    setBusy(false);
    // El botón pulsado queda deshabilitado durante la carga y perdería el foco; además el aviso queda arriba.
    if (moveFocus) els.resultsTitle.focus();
  }

  function onSearchSubmit(event) {
    event.preventDefault();
    clearInvalidMarks();
    setMessage(els.searchError, '');
    const filters = readFilters();
    if (filters) loadPage({ filters, cursor: null, stack: [] }, false);
  }

  // La tabla nunca muestra datos que no correspondan a lo que dice el formulario.
  function onFilterInput() {
    clearInvalidMarks();
    setMessage(els.searchError, '');
    if (!page && !pending) return;
    cancelPending();
    clearResults();
    setMessage(els.searchStatus, FILTERS_CHANGED);
  }

  function onPrevPage() {
    if (!page || page.stack.length === 0) return;
    const stack = page.stack.slice(0, -1);
    loadPage({ filters: page.filters, cursor: page.stack[page.stack.length - 1], stack }, true);
  }

  function onNextPage() {
    if (!page || page.next === null) return;
    const stack = [...page.stack, page.cursor];
    loadPage({ filters: page.filters, cursor: page.next, stack }, true);
  }

  function accountLabel(account) {
    return account.name || `Cuenta ${account.id}`;
  }

  // El select también lleva la cuenta única, aunque oculto: así hay una sola fuente para `account`.
  function renderAccounts() {
    els.accountSelect.replaceChildren(...accounts.map((account) => {
      const option = document.createElement('option');
      option.value = String(account.id);
      option.textContent = accountLabel(account);
      return option;
    }));
    els.accountChoice.hidden = accounts.length <= 1;
    els.accountSingle.hidden = accounts.length > 1;
    els.accountName.textContent = accounts.length > 0 ? accountLabel(accounts[0]) : 'Sin cuentas asignadas';
    els.searchButton.disabled = accounts.length === 0;
  }

  function forgetAccount(id) {
    accounts = accounts.filter((account) => String(account.id) !== id);
    renderAccounts();
  }

  function focusFirstFilter() {
    (els.accountChoice.hidden ? els.number : els.accountSelect).focus();
  }

  function startSession(body) {
    token = body.token;
    accounts = body.accounts;
    els.loginForm.reset();
    renderAccounts();
    els.searchForm.reset();
    setDefaultDates();
    els.loginView.hidden = true;
    els.queryView.hidden = false;
    focusFirstFilter();
  }

  function endSession(notice) {
    token = null;
    accounts = [];
    cancelPending();
    clearResults();
    clearInvalidMarks();
    setMessage(els.searchStatus, '');
    setMessage(els.searchError, '');
    els.searchForm.reset();
    els.accountSelect.replaceChildren();
    els.accountName.textContent = '';
    els.loginForm.reset();
    els.queryView.hidden = true;
    els.loginView.hidden = false;
    setMessage(els.loginStatus, '');
    setMessage(els.loginError, notice);
    els.username.focus();
  }

  async function onLoginSubmit(event) {
    event.preventDefault();
    if (els.loginButton.disabled) return;

    const credentials = { username: els.username.value.trim(), password: els.password.value };
    els.password.value = '';
    setMessage(els.loginError, '');
    setMessage(els.loginStatus, 'Ingresando…');
    els.loginButton.disabled = true;

    let result = null;
    try {
      result = await requestJson(LOGIN_PATH, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
    } catch (err) {
      setMessage(els.loginError, NETWORK_ERROR);
    }

    els.loginButton.disabled = false;
    setMessage(els.loginStatus, '');
    if (!result) {
      els.password.focus();
      return;
    }

    const body = result.body;
    if (result.status === 200 && body && typeof body.token === 'string' && Array.isArray(body.accounts)) {
      startSession(body);
    } else {
      setMessage(els.loginError, serverMessage(body));
      els.password.focus();
    }
  }

  els.loginForm.addEventListener('submit', onLoginSubmit);
  els.searchForm.addEventListener('submit', onSearchSubmit);
  els.searchForm.addEventListener('input', onFilterInput);
  els.logoutButton.addEventListener('click', () => endSession(''));
  els.pagePrev.addEventListener('click', onPrevPage);
  els.pageNext.addEventListener('click', onNextPage);

  // Al final, y con todo ya conectado: si algo falla antes o este archivo no llega, sigue a la vista el aviso de index.html.
  els.loadNotice.hidden = true;
  els.loginView.hidden = false;

  // Embebida, enfocar al cargar le quitaría el foco a la página del cliente y la haría saltar hasta el iframe.
  if (self === top) els.username.focus();
}());
