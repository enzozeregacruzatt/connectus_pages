(function () {
  'use strict';

  const TIME_ZONE = 'America/Santiago';
  const MAX_RANGE_DAYS = 15;
  const MAX_NUMBER_DIGITS = 15;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const LOGIN_PATH = 'api/login';
  const SMS_PATH = 'api/sms';
  const SMS_DETAIL_PATH = 'api/sms/detail';
  const DELIVERIES_PATH = 'api/deliveries';
  const DELIVERY_PATH = 'api/delivery';
  const PROGRESS_PATH = 'api/delivery/progress';
  const STATS_PATH = 'api/delivery/stats';
  const MESSAGES_PATH = 'api/delivery/messages';
  const EXPORTS_PATH = 'api/exports';
  const EXPORT_STATUS_PATH = 'api/exports/status';
  const EXPORT_DOWNLOAD_PATH = 'api/exports/download';

  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const NOTHING = '—';

  const KIND_CSV = 'sms_csv';
  const KIND_REPORT = 'delivery_xlsx';
  const KIND_RESPONSES = 'incoming_xlsx';

  const SCREEN_QUERY = 'query';
  const SCREEN_DELIVERIES = 'deliveries';
  const SCREEN_DELIVERY = 'delivery';
  const SCREEN_SMS = 'sms';

  const VARIANT_GENERATING = 'generating';
  const VARIANT_FAILED = 'failed';

  const JOB_GENERATING = 'generating';
  const JOB_READY = 'ready';
  const JOB_FAILED = 'failed';
  const JOB_LABELS = new Map([[JOB_GENERATING, 'Generando'], [JOB_READY, 'Listo'], [JOB_FAILED, 'Fallido']]);

  // Mínimo de 5 s y un tope, porque cada consulta repetida es carga sobre la misma base de la operación.
  const POLL_MIN_MS = 5000;
  const POLL_MAX_MS = 30000;
  const POLL_GROWTH = 1.5;
  const POLL_LIMIT = 60;
  const POLL_DONE = 'done';

  // La misma forma que exige el servidor. Quien decide si el enlace vale es él: esto solo evita mostrar un formulario inútil.
  const LINK_PATTERN = /^l1\.[ab]\.[1-9][0-9]{0,9}\.(?:0|[1-9][0-9]{0,9})\.([1-9][0-9]{9})\.[A-Za-z0-9_-]{43}$/;
  const LINK_WARNING_DAYS = 30;

  const NO_LINK_NOTICE = 'Esta consulta se abre desde el enlace que te entregó Connectus.';
  const CREDENTIALS_ERROR = 'Debes indicar un usuario y una contraseña válidos.';
  const RANGE_ERROR = 'El rango debe ser válido y no superar 15 días.';
  const NUMBER_ERROR = 'Debes indicar un número destino válido.';
  const GENERIC_ERROR = 'No se pudo completar la solicitud. Inténtalo de nuevo.';
  const SESSION_EXPIRED = 'Tu sesión venció. Vuelve a ingresar.';
  const EMPTY_RESULTS = 'No se encontraron SMS para estos filtros.';
  const FILTERS_CHANGED = 'Los filtros cambiaron. Presiona Buscar para ver los resultados.';
  const EMPTY_EXPORTS = 'Todavía no hay exportaciones.';
  const EMPTY_DELIVERIES = 'No hay envíos que mostrar. Los envíos que hagas aparecerán acá, junto con los programados.';
  const EMPTY_MESSAGES = 'No hay mensajes que mostrar.';
  const STILL_GENERATING = 'Sigue generando. Presiona Actualizar para revisar de nuevo.';
  const STILL_COMPUTING = 'Sigue calculando. Presiona Actualizar para revisar de nuevo.';
  const STATS_FAILED = 'No se pudieron calcular los conteos. Inténtalo más tarde.';
  const STATS_RETRYING = 'Reintentando…';
  const STATS_MAX_FAILURES = 3;

  // Los mismos colores de la plataforma: cada etiqueta que entrega la API, a su clase en app.css.
  const STATUS_TONES = new Map([
    ['Programado', 'info'],
    ['Encolado', 'info'],
    ['Entregado', 'ok'],
    ['No entregable', 'error'],
    ['Enviado a proveedor', 'warn'],
    ['Esperando respuesta', 'warn'],
    ['Sin saldo', 'muted'],
  ]);

  const byId = (id) => document.getElementById(id);
  const pagerElements = (nav, prev, label, next) => ({ nav: byId(nav), prev: byId(prev), label: byId(label), next: byId(next) });

  const els = {
    loadNotice: byId('load-notice'),
    linkNotice: byId('link-notice'),
    loginView: byId('login-view'),
    loginForm: byId('login-form'),
    username: byId('login-username'),
    password: byId('login-password'),
    loginButton: byId('login-button'),
    loginStatus: byId('login-status'),
    loginError: byId('login-error'),
    queryView: byId('query-view'),
    heroTitle: byId('hero-title'),
    heroSubtitle: byId('hero-subtitle'),
    heroLimit: byId('hero-limit'),
    logoutButton: byId('logout-button'),
    backButton: byId('back-button'),
    menuQuery: byId('menu-query'),
    menuDeliveries: byId('menu-deliveries'),
    screens: new Map([
      [SCREEN_QUERY, byId('screen-query')],
      [SCREEN_DELIVERIES, byId('screen-deliveries')],
      [SCREEN_DELIVERY, byId('screen-delivery')],
      [SCREEN_SMS, byId('screen-sms')],
    ]),
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
    exportResults: byId('export-results'),
    exportResultsStatus: byId('export-results-status'),
    exportResultsError: byId('export-results-error'),
    pager: pagerElements('pager', 'page-prev', 'page-label', 'page-next'),
    fullReportForm: byId('full-report-form'),
    fullReportStart: byId('full-report-start'),
    fullReportEnd: byId('full-report-end'),
    fullReportButton: byId('full-report-button'),
    fullReportStatus: byId('full-report-status'),
    fullReportError: byId('full-report-error'),
    exportsCard: byId('exports-card'),
    exportsGenerating: byId('exports-generating'),
    exportsRefresh: byId('exports-refresh'),
    exportsStatus: byId('exports-status'),
    exportsError: byId('exports-error'),
    exportsNote: byId('exports-note'),
    exportsTable: byId('exports-table'),
    exportsBody: byId('exports-body'),
    exportsPager: pagerElements('exports-pager', 'exports-prev', 'exports-page-label', 'exports-next'),
    deliveriesCard: byId('deliveries-card'),
    deliveriesForm: byId('deliveries-form'),
    deliveriesQuery: byId('deliveries-query'),
    deliveriesButton: byId('deliveries-button'),
    deliveriesStatus: byId('deliveries-status'),
    deliveriesError: byId('deliveries-error'),
    deliveriesTable: byId('deliveries-table'),
    deliveriesBody: byId('deliveries-body'),
    deliveriesPager: pagerElements('deliveries-pager', 'deliveries-prev', 'deliveries-page-label', 'deliveries-next'),
    deliveryStatus: byId('delivery-status'),
    deliveryError: byId('delivery-error'),
    deliveryGenerating: byId('delivery-generating'),
    deliveryProgress: byId('delivery-progress'),
    deliveryProgressLabel: byId('delivery-progress-label'),
    deliveryGeneratingFacts: byId('delivery-generating-facts'),
    deliveryProgressStatus: byId('delivery-progress-status'),
    deliveryProgressRefresh: byId('delivery-progress-refresh'),
    deliveryFailed: byId('delivery-failed'),
    deliveryFailedReason: byId('delivery-failed-reason'),
    deliveryComplete: byId('delivery-complete'),
    deliveryFacts: byId('delivery-facts'),
    reportCard: byId('report-card'),
    reportButton: byId('report-button'),
    reportRegenerate: byId('report-regenerate'),
    reportGenerated: byId('report-generated'),
    reportNote: byId('report-note'),
    reportRefresh: byId('report-refresh'),
    reportStatus: byId('report-status'),
    reportError: byId('report-error'),
    statsUpdated: byId('stats-updated'),
    statsStatus: byId('stats-status'),
    statsError: byId('stats-error'),
    statsRefresh: byId('stats-refresh'),
    statsNational: byId('stats-national'),
    statsInternational: byId('stats-international'),
    tabNational: byId('tab-national'),
    tabInternational: byId('tab-international'),
    messagesCard: byId('messages-card'),
    messagesForm: byId('messages-form'),
    messagesNumber: byId('messages-number'),
    messagesButton: byId('messages-button'),
    messagesStatus: byId('messages-status'),
    messagesError: byId('messages-error'),
    messagesTable: byId('messages-table'),
    messagesBody: byId('messages-body'),
    messagesPager: pagerElements('messages-pager', 'messages-prev', 'messages-page-label', 'messages-next'),
    chartArea: byId('chart-area'),
    chartSvg: byId('chart-svg'),
    chartLegend: byId('chart-legend'),
    chartEmpty: byId('chart-empty'),
    responsesCard: byId('responses-card'),
    responsesFacts: byId('responses-facts'),
    responsesButton: byId('responses-button'),
    responsesRegenerate: byId('responses-regenerate'),
    responsesGenerated: byId('responses-generated'),
    responsesNote: byId('responses-note'),
    responsesRefresh: byId('responses-refresh'),
    responsesStatus: byId('responses-status'),
    responsesError: byId('responses-error'),
    linkCard: byId('link-card'),
    linkTitle: byId('link-title'),
    linkFacts: byId('link-facts'),
    smsStatus: byId('sms-status'),
    smsError: byId('sms-error'),
    smsCard: byId('sms-card'),
    smsFacts: byId('sms-facts'),
    smsContent: byId('sms-content'),
    smsEquivalent: byId('sms-equivalent'),
    downloadHelp: byId('download-help'),
    downloadHelpShow: byId('download-help-show'),
    downloadHelpField: byId('download-help-field'),
    downloadHelpLink: byId('download-help-link'),
  };

  const link = readLink();
  let token = null;
  let accounts = [];
  // Pila de pantallas, en memoria: el fragmento de la URL lleva el enlace, así que la navegación no puede vivir ahí.
  let screens = [];
  // Sube al cambiar de pantalla: lo que se pidió antes, como un POST que no conviene abortar, ya no tiene dónde pintarse.
  let screenEpoch = 0;
  let filtersEpoch = 0;
  // Página pintada: { filters, cursor, stack, next }. Si existe, coincide con lo que dice el formulario.
  let page = null;
  const searchSlot = createSlot();
  let exportsPage = { cursor: null, stack: [], next: null };
  let exportsPainted = null;
  let exportsPoll = null;
  const exportsSlot = createSlot();
  // Null mientras no haya una lista pintada de la cuenta actual; al volver del detalle se reutiliza.
  let deliveriesPage = null;
  const deliveriesSlot = createSlot();
  // El envío abierto: { account, id, detail }.
  let delivery = null;
  const deliverySlot = createSlot();
  let messagesPage = null;
  const messagesSlot = createSlot();
  let progressPoll = null;
  let statsPoll = null;
  const smsSlot = createSlot();
  const polls = new Set();
  const reportControl = {
    kind: KIND_REPORT,
    job: null,
    poll: null,
    card: els.reportCard,
    button: els.reportButton,
    regenerate: els.reportRegenerate,
    generated: els.reportGenerated,
    note: els.reportNote,
    refresh: els.reportRefresh,
    status: els.reportStatus,
    error: els.reportError,
    idleLabel: 'Generar reporte',
    busyLabel: 'Generando',
    readyLabel: 'Descargar reporte',
  };
  const responsesControl = {
    kind: KIND_RESPONSES,
    job: null,
    poll: null,
    card: els.responsesCard,
    button: els.responsesButton,
    regenerate: els.responsesRegenerate,
    generated: els.responsesGenerated,
    note: els.responsesNote,
    refresh: els.responsesRefresh,
    status: els.responsesStatus,
    error: els.responsesError,
    idleLabel: 'Generar archivo',
    busyLabel: 'Generando',
    readyLabel: 'Descargar',
  };

  function setMessage(element, text) {
    element.textContent = text;
  }

  // El fragmento no llega a los registros del servidor; la query es el respaldo para un BI que pierda el #. No se borra de la URL:
  // recargar el marco lo volvería a necesitar.
  function readLink() {
    const value = new URLSearchParams(location.hash.slice(1)).get('e') ?? new URLSearchParams(location.search).get('e');
    return value !== null && LINK_PATTERN.test(value) ? value : null;
  }

  function formatLinkDate(time) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, dateStyle: 'short' }).format(time);
  }

  // El reloj de este computador solo decide qué aviso se ve.
  function readLinkState() {
    if (link === null) return { notice: NO_LINK_NOTICE, usable: false };
    const expiresAt = Number(LINK_PATTERN.exec(link)[1]) * 1000;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      return { notice: `El enlace venció el ${formatLinkDate(expiresAt)}. Pide uno nuevo a tu contacto de Connectus.`, usable: false };
    }
    if (remaining <= LINK_WARNING_DAYS * DAY_MS) {
      return { notice: `El enlace vence el ${formatLinkDate(expiresAt)}. Pide uno nuevo a tu contacto de Connectus.`, usable: true };
    }
    return { notice: '', usable: true };
  }

  function showLinkNotice(text) {
    setMessage(els.linkNotice, text);
    els.linkNotice.hidden = text === '';
  }

  function showLoginIfUsable() {
    const { notice, usable } = readLinkState();
    showLinkNotice(notice);
    els.loginView.hidden = !usable;
  }

  // Enter no depende del formulario: bajo un sandbox sin allow-forms, el navegador corta el envío sin avisar. La tecla sostenida
  // o el Enter que confirma un texto compuesto no son una segunda orden.
  function runOnEnter(fields, action) {
    for (const field of fields) {
      field.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.repeat || event.isComposing) return;
        event.preventDefault();
        action();
      });
    }
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

  function buildUrl(path, params) {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '') query.set(name, value);
    }
    return `${path}?${query}`;
  }

  // Null si no hubo respuesta legible: abortada o TypeError. Bajo CORS, un TypeError también puede ser una respuesta del WAF o de
  // API Gateway que no se puede leer, así que no se afirma que fue la red.
  async function getJson(url, signal) {
    try {
      return await requestJson(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal,
      });
    } catch (err) {
      return null;
    }
  }

  async function postJson(path, payload) {
    try {
      return await requestJson(path, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return null;
    }
  }

  // Una petición vigente por lugar de la pantalla: la nueva aborta a la anterior, y la anterior, aunque responda, ya no pinta.
  function createSlot() {
    return { controller: null, url: null };
  }

  function cancelSlot(slot) {
    if (slot.controller) slot.controller.abort();
    slot.controller = null;
    slot.url = null;
  }

  // Undefined si ya no es la vigente. La misma URL no se relanza: abortar en el navegador no detiene la consulta en la base, y un
  // doble clic no debe sumar otra.
  async function fetchLatest(slot, path, params) {
    const url = buildUrl(path, params);
    if (slot.url === url) return undefined;
    cancelSlot(slot);
    const controller = new AbortController();
    slot.controller = controller;
    slot.url = url;
    const result = await getJson(url, controller.signal);
    if (slot.controller !== controller) return undefined;
    slot.controller = null;
    slot.url = null;
    return result;
  }

  // Devuelve si ya se hizo cargo. Un 401 cierra todo, y un 403 saca la cuenta, venga la respuesta de la pantalla que venga.
  function handleDenied(result, account) {
    if (result && result.status === 401) {
      endSession(SESSION_EXPIRED);
      return true;
    }
    if (result && result.status === 403 && account) {
      loseAccount(account, serverMessage(result.body));
      return true;
    }
    return false;
  }

  function stopPoll(poll) {
    if (!poll) return;
    polls.delete(poll);
    clearTimeout(poll.timer);
    if (poll.controller) poll.controller.abort();
  }

  // load pide con la señal que se le da. handle pinta y dice cómo sigue: POLL_DONE, { advanced, waitMs } o nada, que es una respuesta
  // sin avance. Una respuesta sin avance alarga la espera y gasta el tope; una con avance, ninguna de las dos.
  function startPoll({ load, handle, onLimit }, firstDelayMs = POLL_MIN_MS) {
    const poll = { load, handle, onLimit, timer: null, controller: null, delayMs: POLL_MIN_MS, idleAnswers: 0, paused: false };
    polls.add(poll);
    if (firstDelayMs === 0) runPoll(poll);
    else poll.timer = setTimeout(() => runPoll(poll), firstDelayMs);
    return poll;
  }

  async function runPoll(poll) {
    if (document.hidden) {
      poll.paused = true;
      return;
    }
    poll.controller = new AbortController();
    const result = await poll.load(poll.controller.signal);
    if (!polls.has(poll)) return;

    const next = poll.handle(result);
    if (!polls.has(poll)) return;
    if (next === POLL_DONE) {
      polls.delete(poll);
      return;
    }
    const waitMs = next && next.waitMs ? next.waitMs : 0;
    if (next && next.advanced) {
      poll.timer = setTimeout(() => runPoll(poll), Math.max(POLL_MIN_MS, waitMs));
      return;
    }
    poll.idleAnswers += 1;
    if (poll.idleAnswers >= POLL_LIMIT) {
      polls.delete(poll);
      poll.onLimit();
      return;
    }
    poll.timer = setTimeout(() => runPoll(poll), Math.max(poll.delayMs, waitMs));
    poll.delayMs = Math.min(POLL_MAX_MS, poll.delayMs * POLL_GROWTH);
  }

  function resumePolls() {
    if (document.hidden) return;
    for (const poll of polls) {
      if (!poll.paused) continue;
      poll.paused = false;
      runPoll(poll);
    }
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
    const from = toIsoDate(today - (MAX_RANGE_DAYS - 1) * DAY_MS);
    const to = toIsoDate(today);
    els.start.value = from;
    els.end.value = to;
    els.fullReportStart.value = from;
    els.fullReportEnd.value = to;
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

  function renderPager(pager, target, busy) {
    const hasPrev = target !== null && target.stack.length > 0;
    const hasNext = target !== null && target.next !== null;
    pager.nav.hidden = !hasPrev && !hasNext;
    pager.prev.disabled = busy || !hasPrev;
    pager.next.disabled = busy || !hasNext;
    pager.label.textContent = target ? `Página ${target.stack.length + 1}` : '';
  }

  function previousOf(target) {
    return { ...target, cursor: target.stack[target.stack.length - 1], stack: target.stack.slice(0, -1) };
  }

  function nextOf(target) {
    return { ...target, cursor: target.next, stack: [...target.stack, target.cursor] };
  }

  function setBusy(busy) {
    els.results.setAttribute('aria-busy', String(busy));
    renderPager(els.pager, page, busy);
  }

  function clearResults() {
    page = null;
    els.resultsBody.replaceChildren();
    els.resultsSummary.textContent = '';
    els.results.hidden = true;
    setMessage(els.exportResultsStatus, '');
    setMessage(els.exportResultsError, '');
    setBusy(false);
  }

  function addCell(row, text, className) {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = text;
    row.append(cell);
    return cell;
  }

  function buildPill(text, tone) {
    const pill = document.createElement('span');
    pill.className = tone ? `status-pill status-pill--${tone}` : 'status-pill';
    pill.textContent = text;
    return pill;
  }

  // Un botón con aspecto de enlace, porque abre una pantalla en memoria y no una URL.
  function buildLinkButton(text, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-button';
    button.textContent = text;
    button.addEventListener('click', action);
    return button;
  }

  function buildRow(item) {
    const row = document.createElement('tr');
    addCell(row, item.createdAt, 'sms-table__date');
    addCell(row, item.dst, 'sms-table__number');
    addCell(row, item.content, 'sms-table__message');
    addCell(row, '').append(buildPill(item.status));

    if (item.delivery === null || item.delivery === undefined) {
      addCell(row, 'Sin envío', 'sms-table__delivery sms-table__none');
    } else if (item.deliveryId) {
      addCell(row, '', 'sms-table__delivery').append(buildLinkButton(item.delivery, () => openScreen({ name: SCREEN_DELIVERY, id: item.deliveryId })));
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
    const url = buildUrl(SMS_PATH, { ...target.filters, cursor: target.cursor });
    // Un doble clic no debe lanzar otra consulta pesada: abortar en el navegador no la detiene en la base.
    if (searchSlot.url === url) return;

    setMessage(els.searchError, '');
    setMessage(els.searchStatus, 'Buscando mensajes…');
    const request = fetchLatest(searchSlot, SMS_PATH, { ...target.filters, cursor: target.cursor });
    setBusy(true);
    const result = await request;
    if (result === undefined) return;

    if (handleDenied(result, target.filters.account)) return;

    const body = result && result.body;
    if (result && result.status === 200 && body && Array.isArray(body.items)) {
      page = { ...target, next: typeof body.nextCursor === 'string' ? body.nextCursor : null };
      renderPage(body.items);
    } else {
      setMessage(els.searchStatus, '');
      setMessage(els.searchError, result ? serverMessage(body) : GENERIC_ERROR);
    }

    setBusy(false);
    // El botón pulsado queda deshabilitado durante la carga y perdería el foco; además el aviso queda arriba.
    if (moveFocus) els.resultsTitle.focus();
  }

  function runSearch() {
    if (els.searchButton.disabled) return;
    clearInvalidMarks();
    setMessage(els.searchError, '');
    const filters = readFilters();
    if (filters) loadPage({ filters, cursor: null, stack: [] }, false);
  }

  // La tabla nunca muestra datos que no correspondan a lo que dice el formulario.
  function onFilterInput() {
    clearInvalidMarks();
    setMessage(els.searchError, '');
    if (!page && !searchSlot.controller) return;
    cancelSlot(searchSlot);
    clearResults();
    setMessage(els.searchStatus, FILTERS_CHANGED);
  }

  function onPrevPage() {
    if (page && page.stack.length > 0) loadPage(previousOf(page), true);
  }

  function onNextPage() {
    if (page && page.next !== null) loadPage(nextOf(page), true);
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
    const none = accounts.length === 0;
    els.searchButton.disabled = none;
    els.fullReportButton.disabled = none;
    els.menuDeliveries.disabled = none;
  }

  function currentAccount() {
    return els.accountSelect.value;
  }

  function currentAccountLabel() {
    const account = accounts.find(({ id }) => String(id) === currentAccount());
    return account ? accountLabel(account) : '';
  }

  function focusFirstFilter() {
    (els.accountChoice.hidden ? els.number : els.accountSelect).focus();
  }

  function setList(body, table, items, buildItemRow) {
    body.replaceChildren(...items.map(buildItemRow));
    table.hidden = items.length === 0;
  }

  function settleList(card, status, pager, target) {
    card.setAttribute('aria-busy', 'false');
    setMessage(status, '');
    renderPager(pager, target, false);
  }

  // Un valor puede ser un elemento, como una etiqueta de estado. Lo que falta se ve como un guion, nunca vacío.
  function renderFacts(list, facts) {
    list.replaceChildren(...facts.flatMap(([label, value]) => {
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      if (value !== null && typeof value === 'object') detail.append(value);
      else detail.textContent = value === null || value === undefined || value === '' ? NOTHING : String(value);
      return [term, detail];
    }));
  }

  const formatCount = (value) => (typeof value === 'number' ? new Intl.NumberFormat('es-CL').format(value) : NOTHING);

  function formatIsoDate(value) {
    const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    return match ? `${match[3]}/${match[2]}/${match[1]}` : NOTHING;
  }

  const statusPill = (label) => buildPill(label, STATUS_TONES.get(label));

  // Pantallas

  function setHero(title, subtitle, withLimit) {
    els.heroTitle.textContent = title;
    els.heroSubtitle.textContent = subtitle;
    els.heroSubtitle.hidden = subtitle === '';
    els.heroLimit.hidden = !withLimit;
  }

  function setQueryHero() {
    const label = currentAccountLabel();
    setHero('Consulta de SMS', label ? `Revisa mensajes y genera reportes para ${label}.` : '', true);
  }

  function deliveryTitle(name) {
    return name ? `Envío «${name}»` : 'Envío';
  }

  function hideDownloadHelp() {
    els.downloadHelp.hidden = true;
    els.downloadHelpField.hidden = true;
    els.downloadHelpLink.value = '';
  }

  function stopDeliveryWork() {
    cancelSlot(deliverySlot);
    cancelSlot(messagesSlot);
    for (const poll of [progressPoll, statsPoll, reportControl.poll, responsesControl.poll]) stopPoll(poll);
  }

  // Salir de una pantalla cancela todo lo suyo. Lo pintado queda, porque "Volver" lo reutiliza.
  function leaveScreen() {
    screenEpoch += 1;
    cancelSlot(exportsSlot);
    cancelSlot(deliveriesSlot);
    cancelSlot(smsSlot);
    stopPoll(exportsPoll);
    stopDeliveryWork();
    hideDownloadHelp();
  }

  function showEntry(entry, returning) {
    leaveScreen();
    for (const [name, element] of els.screens) element.hidden = name !== entry.name;
    els.backButton.hidden = screens.length <= 1;
    const isQuery = screens[0].name === SCREEN_QUERY;
    const current = (button, active) => {
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    };
    current(els.menuQuery, isQuery);
    current(els.menuDeliveries, !isQuery);

    if (entry.name === SCREEN_QUERY) enterQuery();
    else if (entry.name === SCREEN_DELIVERIES) enterDeliveries(returning);
    else if (entry.name === SCREEN_DELIVERY) enterDelivery(entry.id, returning);
    else enterSms(entry.id);
  }

  function openScreen(entry) {
    screens.push(entry);
    showEntry(entry, false);
    els.heroTitle.focus();
  }

  function openRoot(name) {
    screens = [{ name }];
    if (name === SCREEN_DELIVERIES) deliveriesPage = null;
    showEntry(screens[0], false);
    els.heroTitle.focus();
  }

  function goBack() {
    if (screens.length <= 1) return;
    screens.pop();
    showEntry(screens[screens.length - 1], true);
    els.heroTitle.focus();
  }

  // Descarga

  // Solo al pulsar: una captura de la pantalla no debe llevarse el enlace. Es la URL de la app, que pide la clave, y nunca la del archivo.
  function showDownloadLink() {
    els.downloadHelpLink.value = location.href;
    els.downloadHelpField.hidden = false;
    els.downloadHelpLink.focus();
  }

  // Con un <a>, sin iframe oculto. Un sandbox sin allow-downloads lo corta sin avisar, por eso el aviso sale siempre.
  function clickDownload(url, filename) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.hidden = true;
    els.queryView.append(anchor);
    anchor.click();
    anchor.remove();
  }

  async function downloadJob(id, { card, error, account }) {
    const epoch = screenEpoch;
    setMessage(error, '');
    const result = await getJson(buildUrl(EXPORT_DOWNLOAD_PATH, { id }));
    if (epoch !== screenEpoch || handleDenied(result, account)) return;
    if (!result || result.status !== 200 || !result.body || typeof result.body.url !== 'string') {
      setMessage(error, result ? serverMessage(result.body) : GENERIC_ERROR);
      return;
    }
    clickDownload(result.body.url, result.body.filename);
    card.append(els.downloadHelp);
    els.downloadHelp.hidden = false;
  }

  // Consulta

  function isQueryVisible() {
    return !els.screens.get(SCREEN_QUERY).hidden;
  }

  function enterQuery() {
    setQueryHero();
    loadExports(exportsPage);
  }

  function buildExportRow(item) {
    const row = document.createElement('tr');
    addCell(row, item.accountName ?? NOTHING);
    addCell(row, item.filter ?? NOTHING, 'sms-table__delivery');
    addCell(row, `${formatIsoDate(item.start)} — ${formatIsoDate(item.end)}`, 'sms-table__date');

    const statusCell = addCell(row, '');
    const tone = item.state === JOB_READY ? 'ok' : item.state === JOB_FAILED ? 'error' : 'info';
    statusCell.append(buildPill(JOB_LABELS.get(item.state) ?? NOTHING, tone));
    if (item.errorMessage) {
      const reason = document.createElement('p');
      reason.className = 'muted sms-table__reason';
      reason.textContent = item.errorMessage;
      statusCell.append(reason);
    }

    if (item.state === JOB_READY) {
      const button = buildLinkButton('Descargar', async () => {
        button.disabled = true;
        await downloadJob(item.id, { card: els.exportsCard, error: els.exportsError, account: item.account });
        button.disabled = false;
      });
      addCell(row, '').append(button);
    } else {
      addCell(row, NOTHING);
    }
    return row;
  }

  // Devuelve si queda algo generándose, o null si la respuesta no sirve. Repintar igual le quitaría el foco a "Descargar" cada 5 s.
  function paintExports(result, target) {
    const body = result && result.body;
    if (!result || result.status !== 200 || !body || !Array.isArray(body.items)) return null;
    const signature = JSON.stringify(body);
    exportsPage = { ...target, next: typeof body.nextCursor === 'string' ? body.nextCursor : null };
    if (signature !== exportsPainted) {
      exportsPainted = signature;
      setList(els.exportsBody, els.exportsTable, body.items, buildExportRow);
    }
    els.exportsNote.hidden = !body.items.some((item) => item.state === JOB_READY);
    const generating = body.items.some((item) => item.state === JOB_GENERATING);
    els.exportsGenerating.hidden = !generating;
    setMessage(els.exportsStatus, body.items.length === 0 ? EMPTY_EXPORTS : '');
    renderPager(els.exportsPager, exportsPage, false);
    return generating;
  }

  function exportsUrlParams(target) {
    return { kind: KIND_CSV, cursor: target.cursor };
  }

  function startExportsPoll(target) {
    exportsPoll = startPoll({
      load: (signal) => getJson(buildUrl(EXPORTS_PATH, exportsUrlParams(target)), signal),
      handle(result) {
        if (handleDenied(result)) return POLL_DONE;
        return paintExports(result, target) === false ? POLL_DONE : undefined;
      },
      onLimit: () => setMessage(els.exportsStatus, STILL_GENERATING),
    });
  }

  async function loadExports(target) {
    stopPoll(exportsPoll);
    setMessage(els.exportsError, '');
    els.exportsCard.setAttribute('aria-busy', 'true');
    renderPager(els.exportsPager, exportsPage, true);
    const result = await fetchLatest(exportsSlot, EXPORTS_PATH, exportsUrlParams(target));
    if (result === undefined) return;
    els.exportsCard.setAttribute('aria-busy', 'false');
    if (handleDenied(result)) return;

    const generating = paintExports(result, target);
    if (generating === null) {
      setMessage(els.exportsError, result ? serverMessage(result.body) : GENERIC_ERROR);
      renderPager(els.exportsPager, exportsPage, false);
    } else if (generating) {
      startExportsPoll(target);
    }
  }

  // Por cuenta y no por pantalla: quien sale y vuelve tiene que ver cómo terminó su pedido.
  async function requestCsv(filters, { button, status, error }) {
    const epoch = filtersEpoch;
    setMessage(error, '');
    setMessage(status, 'Encolando reporte…');
    button.disabled = true;
    const result = await postJson(EXPORTS_PATH, {
      kind: KIND_CSV,
      account: filters.account,
      start: filters.start,
      end: filters.end,
      ...(filters.dst ? { dst: filters.dst } : {}),
    });
    button.disabled = false;
    if (handleDenied(result, filters.account)) return;
    if (epoch !== filtersEpoch) return;

    setMessage(status, '');
    if (result && (result.status === 200 || result.status === 201)) {
      setMessage(status, 'Reporte encolado. Aparece en Exportaciones recientes.');
      exportsPage = { cursor: null, stack: [], next: null };
      if (isQueryVisible()) loadExports(exportsPage);
    } else {
      setMessage(error, result ? serverMessage(result.body) : GENERIC_ERROR);
    }
  }

  // Exporta lo que está pintado, que por regla es lo que dice el formulario.
  function runExportResults() {
    if (els.exportResults.disabled || !page) return;
    requestCsv(page.filters, { button: els.exportResults, status: els.exportResultsStatus, error: els.exportResultsError });
  }

  function runFullReport() {
    if (els.fullReportButton.disabled) return;
    const start = els.fullReportStart.value;
    const end = els.fullReportEnd.value;
    els.fullReportStart.removeAttribute('aria-invalid');
    els.fullReportEnd.removeAttribute('aria-invalid');
    if (!isValidRange(start, end)) {
      els.fullReportStart.setAttribute('aria-invalid', 'true');
      els.fullReportEnd.setAttribute('aria-invalid', 'true');
      setMessage(els.fullReportStatus, '');
      setMessage(els.fullReportError, RANGE_ERROR);
      els.fullReportStart.focus();
      return;
    }
    requestCsv({ account: currentAccount(), start, end }, {
      button: els.fullReportButton,
      status: els.fullReportStatus,
      error: els.fullReportError,
    });
  }

  // Envíos

  function buildDeliveryRow(item) {
    const open = () => openScreen({ name: SCREEN_DELIVERY, id: item.id });
    const row = document.createElement('tr');
    addCell(row, '', 'sms-table__delivery').append(buildLinkButton(item.name ?? NOTHING, open));
    addCell(row, item.type ?? NOTHING);
    addCell(row, item.createdAt ?? NOTHING, 'sms-table__date');
    addCell(row, item.deliverAt ?? NOTHING, 'sms-table__date');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button';
    button.setAttribute('aria-label', `Ver detalle de ${item.name ?? 'este envío'}`);
    const icon = svgNode('svg', { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    icon.append(svgNode('circle', { cx: 11, cy: 11, r: 7 }), svgNode('path', { d: 'M16.5 16.5L21 21' }));
    button.append(icon);
    button.addEventListener('click', open);
    addCell(row, '').append(button);
    return row;
  }

  function enterDeliveries(returning) {
    setHero('Historial de envíos SMS', '', false);
    if (returning && deliveriesPage) {
      // Si al salir había una carga en curso, se canceló: la lista queda como estaba pintada.
      settleList(els.deliveriesCard, els.deliveriesStatus, els.deliveriesPager, deliveriesPage);
      return;
    }
    els.deliveriesQuery.value = '';
    loadDeliveries({ q: '', cursor: null, stack: [] });
  }

  async function loadDeliveries(target) {
    const account = currentAccount();
    setMessage(els.deliveriesError, '');
    setMessage(els.deliveriesStatus, 'Buscando envíos…');
    els.deliveriesCard.setAttribute('aria-busy', 'true');
    renderPager(els.deliveriesPager, deliveriesPage, true);
    const result = await fetchLatest(deliveriesSlot, DELIVERIES_PATH, { account, q: target.q, cursor: target.cursor });
    if (result === undefined) return;
    els.deliveriesCard.setAttribute('aria-busy', 'false');
    if (handleDenied(result, account)) return;

    const body = result && result.body;
    if (result && result.status === 200 && body && Array.isArray(body.items)) {
      deliveriesPage = { ...target, next: typeof body.nextCursor === 'string' ? body.nextCursor : null };
      setList(els.deliveriesBody, els.deliveriesTable, body.items, buildDeliveryRow);
      setMessage(els.deliveriesStatus, body.items.length === 0 ? EMPTY_DELIVERIES : '');
    } else {
      setMessage(els.deliveriesStatus, '');
      setMessage(els.deliveriesError, result ? serverMessage(body) : GENERIC_ERROR);
    }
    renderPager(els.deliveriesPager, deliveriesPage, false);
  }

  function runDeliveriesSearch() {
    loadDeliveries({ q: els.deliveriesQuery.value.trim(), cursor: null, stack: [] });
  }

  // Detalle de envío

  function hideDeliveryParts() {
    els.deliveryGenerating.hidden = true;
    els.deliveryFailed.hidden = true;
    els.deliveryComplete.hidden = true;
  }

  function clearDelivery() {
    delivery = null;
    messagesPage = null;
    hideDeliveryParts();
    els.messagesNumber.value = '';
    els.messagesBody.replaceChildren();
    els.messagesTable.hidden = true;
    renderPager(els.messagesPager, null, false);
    for (const element of [els.messagesStatus, els.messagesError, els.statsUpdated, els.statsStatus, els.statsError]) setMessage(element, '');
    els.statsNational.replaceChildren();
    els.statsInternational.replaceChildren();
    els.statsNational.hidden = true;
    els.statsInternational.hidden = true;
    els.statsRefresh.hidden = true;
    selectTab(true);
    els.chartArea.hidden = true;
    els.chartEmpty.hidden = true;
    els.linkCard.hidden = true;
    setMessage(els.deliveryFailedReason, '');
    for (const list of [els.deliveryFacts, els.deliveryGeneratingFacts, els.responsesFacts, els.linkFacts]) renderFacts(list, []);
    showJob(reportControl, null);
    showJob(responsesControl, null);
  }

  function enterDelivery(id, returning) {
    if (!returning || !delivery || delivery.id !== id) clearDelivery();
    setHero(delivery ? deliveryTitle(delivery.detail.name) : 'Envío', `Identificador único: ${id}`, false);
    loadDelivery(id);
  }

  async function loadDelivery(id) {
    const account = currentAccount();
    setMessage(els.deliveryError, '');
    setMessage(els.deliveryStatus, 'Cargando el envío…');
    const result = await fetchLatest(deliverySlot, DELIVERY_PATH, { account, id });
    if (result === undefined) return;
    setMessage(els.deliveryStatus, '');
    if (handleDenied(result, account)) return;

    const body = result && result.body;
    if (!result || result.status !== 200 || !body || typeof body.variant !== 'string') {
      hideDeliveryParts();
      setMessage(els.deliveryError, result ? serverMessage(body) : GENERIC_ERROR);
      return;
    }
    const keepsMessages = delivery !== null && delivery.id === id && messagesPage !== null;
    delivery = { account, id, detail: body };
    renderDelivery(body, keepsMessages);
  }

  function renderDelivery(detail, keepsMessages) {
    setHero(deliveryTitle(detail.name), `Identificador único: ${detail.id}`, false);
    hideDeliveryParts();
    if (detail.variant === VARIANT_GENERATING) {
      els.deliveryGenerating.hidden = false;
      renderFacts(els.deliveryGeneratingFacts, [
        ['Nombre de envío', detail.name],
        ['Fecha programada', detail.deliverAt],
        ['Cantidad de contactos', formatCount(detail.contacts)],
      ]);
      renderProgress(null, detail.contacts);
      startProgressPoll(0);
    } else if (detail.variant === VARIANT_FAILED) {
      els.deliveryFailed.hidden = false;
      setMessage(els.deliveryFailedReason, detail.errorMessage);
    } else {
      els.deliveryComplete.hidden = false;
      renderComplete(detail);
      showJob(reportControl, detail.report);
      showJob(responsesControl, detail.incoming);
      startStatsPoll(0);
      if (keepsMessages) settleList(els.messagesCard, els.messagesStatus, els.messagesPager, messagesPage);
      else loadMessages({ dst: '', cursor: null, stack: [] });
    }
  }

  function renderComplete(detail) {
    renderFacts(els.deliveryFacts, [
      ['Tipo', detail.type],
      ['Fecha de creación', detail.createdAt],
      ['Fecha programada', detail.deliverAt],
      ...(detail.hasBase ? [['Base', detail.base]] : []),
    ]);
    renderFacts(els.responsesFacts, [['Recibidas', formatCount(detail.responses)]]);
    renderLink(detail.link, null);
  }

  // El link del envío viene en la cabecera; "Links distintos" y los clics sumados, en la foto.
  function renderLink(link, stats) {
    els.linkCard.hidden = !link;
    if (!link) return;
    const clicks = formatCount(stats ? stats.clicks : link.clicks);
    if (stats && stats.distinct > 1) {
      els.linkTitle.textContent = 'Links cortos';
      renderFacts(els.linkFacts, [['Links distintos', formatCount(stats.distinct)], ['Clics', clicks]]);
    } else {
      els.linkTitle.textContent = 'Link corto';
      renderFacts(els.linkFacts, [['Dirección', link.address], ['Clics', clicks]]);
    }
  }

  // Envío en curso

  function renderProgress(sent, contacts) {
    if (typeof contacts === 'number' && contacts > 0) els.deliveryProgress.setAttribute('max', String(contacts));
    else els.deliveryProgress.removeAttribute('max');
    // Sin value, <progress> se muestra indeterminado: no hay cómo saber cuánto falta.
    if (typeof sent === 'number' && typeof contacts === 'number' && contacts > 0) {
      els.deliveryProgress.setAttribute('value', String(Math.min(sent, contacts)));
      setMessage(els.deliveryProgressLabel, `${formatCount(sent)} de ${formatCount(contacts)}`);
    } else {
      els.deliveryProgress.removeAttribute('value');
      setMessage(els.deliveryProgressLabel, '');
    }
  }

  function startProgressPoll(firstDelayMs) {
    stopPoll(progressPoll);
    const { account, id } = delivery;
    els.deliveryProgressRefresh.hidden = true;
    setMessage(els.deliveryProgressStatus, '');
    progressPoll = startPoll({
      load: (signal) => getJson(buildUrl(PROGRESS_PATH, { account, id }), signal),
      handle(result) {
        if (handleDenied(result, account)) return POLL_DONE;
        const body = result && result.status === 200 ? result.body : null;
        if (!body) return undefined;
        if (body.variant !== VARIANT_GENERATING) {
          loadDelivery(id);
          return POLL_DONE;
        }
        renderProgress(body.sent, body.contacts);
        return undefined;
      },
      onLimit() {
        setMessage(els.deliveryProgressStatus, STILL_GENERATING);
        els.deliveryProgressRefresh.hidden = false;
      },
    }, firstDelayMs);
  }

  // Foto de conteos

  function selectTab(national) {
    els.tabNational.setAttribute('aria-pressed', String(national));
    els.tabInternational.setAttribute('aria-pressed', String(!national));
    const painted = els.statsNational.children.length > 0;
    els.statsNational.hidden = !painted || !national;
    els.statsInternational.hidden = !painted || national;
  }

  function buildStatsTable(table, caption) {
    const header = (text, scope) => {
      const cell = document.createElement('th');
      cell.setAttribute('scope', scope);
      cell.textContent = text;
      return cell;
    };
    const countRow = (label, cells, total) => {
      const row = document.createElement('tr');
      row.append(header(label, 'row'));
      for (const value of cells) addCell(row, formatCount(value), 'stats-table__count');
      addCell(row, formatCount(total), 'stats-table__count stats-table__total');
      return row;
    };

    const element = document.createElement('table');
    element.className = 'sms-table stats-table';
    const title = document.createElement('caption');
    title.className = 'visually-hidden';
    title.textContent = caption;
    const headRow = document.createElement('tr');
    headRow.append(header('Estado', 'col'), ...table.columns.map((column) => header(column, 'col')), header('Total', 'col'));
    const head = document.createElement('thead');
    head.append(headRow);
    const body = document.createElement('tbody');
    body.append(...table.rows.map((row) => countRow(row.label, row.cells, row.total)));
    const foot = document.createElement('tfoot');
    foot.append(countRow('Total', table.totals.cells, table.totals.total));
    element.append(title, head, body, foot);
    return element;
  }

  // Colores por atributo: la CSP no deja usar style, y un atributo de presentación no cuenta como estilo.
  function svgNode(name, attributes) {
    const node = document.createElementNS(SVG_NAMESPACE, name);
    for (const [attribute, value] of Object.entries(attributes)) node.setAttribute(attribute, String(value));
    return node;
  }

  // El radio hace que la circunferencia mida 100, así que largo y desfase quedan en porcentaje. El desfase parte a las 12 en punto.
  const DONUT_RADIUS = 100 / (2 * Math.PI);
  const DONUT_GAP = 0.6;
  const DONUT_MIN_SLICE = 0.5;

  function buildSlice(entry, startShare, share) {
    const drawn = share === 100 ? 100 : Math.max(share - DONUT_GAP, DONUT_MIN_SLICE);
    const slice = svgNode('circle', {
      class: 'donut__slice',
      cx: 21,
      cy: 21,
      r: DONUT_RADIUS,
      stroke: entry.color,
      'stroke-dasharray': `${drawn} ${100 - drawn}`,
      'stroke-dashoffset': 25 - startShare,
    });
    const title = svgNode('title', {});
    title.textContent = `${entry.label}: ${formatCount(entry.value)}`;
    slice.append(title);
    return slice;
  }

  function renderDonut(chart) {
    const total = chart.reduce((sum, entry) => sum + entry.value, 0);
    els.chartArea.hidden = total === 0;
    els.chartEmpty.hidden = total !== 0;

    let counted = 0;
    const slices = [];
    for (const entry of chart) {
      if (entry.value === 0) continue;
      slices.push(buildSlice(entry, counted * 100 / total, entry.value * 100 / total));
      counted += entry.value;
    }
    const center = svgNode('text', { class: 'donut__total', x: 21, y: 21, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    center.textContent = formatCount(total);
    els.chartSvg.replaceChildren(...slices, center);

    els.chartLegend.replaceChildren(...chart.map((entry) => {
      const item = document.createElement('li');
      const swatch = svgNode('svg', { class: 'donut__swatch', viewBox: '0 0 10 10', 'aria-hidden': 'true' });
      swatch.append(svgNode('rect', { width: 10, height: 10, rx: 2, fill: entry.color }));
      const label = document.createElement('span');
      label.textContent = entry.label;
      const count = document.createElement('strong');
      count.textContent = formatCount(entry.value);
      item.append(swatch, label, count);
      return item;
    }));
  }

  function formatUpdatedAt(text) {
    const [date, time] = typeof text === 'string' ? text.split(' ') : [];
    return time ? `Actualizado el ${date} a las ${time}` : '';
  }

  function paintStats(stats) {
    setMessage(els.statsUpdated, formatUpdatedAt(stats.updatedAt));
    if (stats.national && stats.international) {
      els.statsNational.replaceChildren(buildStatsTable(stats.national, 'Mensajes nacionales por estado y proveedor'));
      els.statsInternational.replaceChildren(buildStatsTable(stats.international, 'Mensajes internacionales por estado y país'));
      selectTab(els.tabNational.getAttribute('aria-pressed') === 'true');
      renderDonut(stats.chart);
    }
    renderLink(delivery.detail.link, stats.links);
  }

  function startStatsPoll(firstDelayMs) {
    stopPoll(statsPoll);
    const { account, id } = delivery;
    let lastRows = -1;
    let failures = 0;
    let lastFailure = null;
    const showFailure = () => {
      setMessage(els.statsStatus, '');
      setMessage(els.statsError, lastFailure ? serverMessage(lastFailure.body) : GENERIC_ERROR);
      els.statsRefresh.hidden = false;
    };
    els.statsRefresh.hidden = true;
    setMessage(els.statsError, '');
    statsPoll = startPoll({
      load: (signal) => getJson(buildUrl(STATS_PATH, { account, id }), signal),
      handle(result) {
        if (handleDenied(result, account)) return POLL_DONE;
        const body = result && result.status === 200 ? result.body : null;
        if (!body) {
          if (result && result.status === 404) {
            setMessage(els.statsStatus, '');
            setMessage(els.statsError, serverMessage(result.body));
            return POLL_DONE;
          }
          failures += 1;
          lastFailure = result;
          if (failures >= STATS_MAX_FAILURES) {
            showFailure();
            return POLL_DONE;
          }
          setMessage(els.statsStatus, STATS_RETRYING);
          return undefined;
        }
        failures = 0;
        paintStats(body);
        if (body.state === 'failed') {
          setMessage(els.statsStatus, '');
          setMessage(els.statsError, STATS_FAILED);
          return POLL_DONE;
        }
        if (body.state !== 'computing') {
          setMessage(els.statsStatus, '');
          return POLL_DONE;
        }
        const rows = typeof body.progressRows === 'number' ? body.progressRows : 0;
        setMessage(els.statsStatus, rows > 0 ? `Calculando: ${formatCount(rows)} filas procesadas.` : 'Calculando…');
        const advanced = rows > lastRows && lastRows >= 0;
        lastRows = Math.max(lastRows, rows);
        return { advanced, waitMs: body.retryAfterMs };
      },
      onLimit() {
        if (failures > 0) {
          showFailure();
          return;
        }
        setMessage(els.statsStatus, STILL_COMPUTING);
        els.statsRefresh.hidden = false;
      },
    }, firstDelayMs);
  }

  // Mensajes del envío

  function buildMessageRow(item) {
    const row = document.createElement('tr');
    addCell(row, '').append(statusPill(item.status));
    addCell(row, '').append(buildLinkButton(item.id, () => openScreen({ name: SCREEN_SMS, id: item.id })));
    addCell(row, item.dst, 'sms-table__number');
    addCell(row, item.provider ?? NOTHING);
    addCell(row, item.country ?? NOTHING);
    addCell(row, item.updatedAt ?? NOTHING, 'sms-table__date');
    return row;
  }

  async function loadMessages(target) {
    const { account, id } = delivery;
    setMessage(els.messagesError, '');
    setMessage(els.messagesStatus, 'Buscando mensajes…');
    els.messagesCard.setAttribute('aria-busy', 'true');
    renderPager(els.messagesPager, messagesPage, true);
    const result = await fetchLatest(messagesSlot, MESSAGES_PATH, { account, id, dst: target.dst, cursor: target.cursor });
    if (result === undefined) return;
    els.messagesCard.setAttribute('aria-busy', 'false');
    if (handleDenied(result, account)) return;

    const body = result && result.body;
    if (result && result.status === 200 && body && Array.isArray(body.items)) {
      messagesPage = { ...target, next: typeof body.nextCursor === 'string' ? body.nextCursor : null };
      setList(els.messagesBody, els.messagesTable, body.items, buildMessageRow);
      setMessage(els.messagesStatus, body.items.length === 0 ? EMPTY_MESSAGES : '');
    } else {
      setMessage(els.messagesStatus, '');
      setMessage(els.messagesError, result ? serverMessage(body) : GENERIC_ERROR);
    }
    renderPager(els.messagesPager, messagesPage, false);
  }

  function runMessagesSearch() {
    if (delivery) loadMessages({ dst: els.messagesNumber.value.trim(), cursor: null, stack: [] });
  }

  // Reporte y respuestas: el mismo flujo, generar, esperar y descargar

  function formatGeneratedAt(text) {
    const [date, time] = typeof text === 'string' ? text.split(' ') : [];
    return time ? `Generado el ${date} a las ${time}` : '';
  }

  function showJob(control, job) {
    stopPoll(control.poll);
    control.job = job;
    control.refresh.hidden = true;
    setMessage(control.status, '');
    setMessage(control.error, '');
    const state = job ? job.state : null;
    control.button.disabled = state === JOB_GENERATING;
    control.button.textContent = state === JOB_GENERATING ? control.busyLabel : state === JOB_READY ? control.readyLabel : control.idleLabel;
    control.regenerate.hidden = state !== JOB_READY;
    control.regenerate.disabled = false;
    control.note.hidden = state !== JOB_READY;
    control.generated.textContent = state === JOB_READY ? formatGeneratedAt(job.createdAt) : '';
    if (state === JOB_FAILED) setMessage(control.error, job.errorMessage);
    if (state === JOB_GENERATING) startJobPoll(control, POLL_MIN_MS);
    if (control === responsesControl) {
      const responses = delivery ? delivery.detail.responses : null;
      control.button.hidden = !job && !(typeof responses === 'number' && responses > 0);
    }
  }

  function startJobPoll(control, firstDelayMs) {
    stopPoll(control.poll);
    const { account } = delivery;
    const { id } = control.job;
    control.refresh.hidden = true;
    setMessage(control.status, '');
    control.poll = startPoll({
      load: (signal) => getJson(buildUrl(EXPORT_STATUS_PATH, { id }), signal),
      handle(result) {
        if (handleDenied(result, account)) return POLL_DONE;
        if (result && result.status === 404) {
          showJob(control, null);
          return POLL_DONE;
        }
        const job = result && result.status === 200 ? result.body : null;
        if (!job || job.state === JOB_GENERATING) return undefined;
        showJob(control, job);
        return POLL_DONE;
      },
      onLimit() {
        setMessage(control.status, STILL_GENERATING);
        control.refresh.hidden = false;
      },
    }, firstDelayMs);
  }

  function setJobButtonsDisabled(control, disabled) {
    control.button.disabled = disabled;
    control.regenerate.disabled = disabled;
  }

  async function requestJob(control) {
    const { account, id } = delivery;
    const epoch = screenEpoch;
    setMessage(control.error, '');
    setJobButtonsDisabled(control, true);
    const result = await postJson(EXPORTS_PATH, { kind: control.kind, account, delivery: id });
    if (handleDenied(result, account)) return;
    if (epoch !== screenEpoch) return;
    if (result && (result.status === 200 || result.status === 201) && result.body) {
      showJob(control, result.body);
    } else {
      setJobButtonsDisabled(control, false);
      setMessage(control.error, result ? serverMessage(result.body) : GENERIC_ERROR);
    }
  }

  async function runJobButton(control) {
    if (control.button.disabled || !delivery) return;
    if (control.job && control.job.state === JOB_READY) {
      setJobButtonsDisabled(control, true);
      await downloadJob(control.job.id, { card: control.card, error: control.error, account: delivery.account });
      setJobButtonsDisabled(control, false);
      return;
    }
    requestJob(control);
  }

  function runRegenerate(control) {
    if (!control.regenerate.disabled && delivery) requestJob(control);
  }

  // Detalle de SMS

  function enterSms(id) {
    setHero('Mensaje enviado', `Identificador único: ${id}`, false);
    els.smsCard.hidden = true;
    loadSms(id);
  }

  async function loadSms(id) {
    const account = currentAccount();
    setMessage(els.smsError, '');
    setMessage(els.smsStatus, 'Cargando el mensaje…');
    const result = await fetchLatest(smsSlot, SMS_DETAIL_PATH, { account, id });
    if (result === undefined) return;
    setMessage(els.smsStatus, '');
    if (handleDenied(result, account)) return;

    const body = result && result.body;
    if (!result || result.status !== 200 || !body) {
      setMessage(els.smsError, result ? serverMessage(body) : GENERIC_ERROR);
      return;
    }
    renderFacts(els.smsFacts, [
      ['Envío', body.delivery],
      ['Número de origen', `+${body.src}`],
      ['Número de destino', `+${body.dst}`],
      ['País de destino', body.country],
      ['Última actualización', body.updatedAt],
      ['Proveedor', body.provider],
      ['Estado', statusPill(body.status)],
    ]);
    els.smsContent.textContent = body.content;
    els.smsEquivalent.textContent = body.equivalent === 1 ? '1 mensaje equivalente' : `${body.equivalent} mensajes equivalentes`;
    els.smsCard.hidden = false;
  }

  // Sesión

  function resetFilters() {
    filtersEpoch += 1;
    clearInvalidMarks();
    cancelSlot(searchSlot);
    clearResults();
    setMessage(els.searchStatus, '');
    setMessage(els.searchError, '');
    setMessage(els.fullReportStatus, '');
    setMessage(els.fullReportError, '');
    els.searchForm.reset();
    els.fullReportForm.reset();
    setDefaultDates();
    deliveriesPage = null;
    leaveScreen();
    clearDelivery();
  }

  function goToQuery() {
    screens = [{ name: SCREEN_QUERY }];
    showEntry(screens[0], false);
  }

  // Cambiar de cuenta parte de cero: nada de la cuenta anterior sigue en pantalla ni en un filtro.
  function onAccountChange() {
    resetFilters();
    goToQuery();
    focusFirstFilter();
  }

  // Le quitaron la cuenta: nada de ella debe seguir en pantalla, ni la cuenta en el selector.
  function loseAccount(id, message) {
    const selected = currentAccount();
    if (id !== selected) {
      // Otra cuenta, no la que está en uso: se queda en esta, con sus filtros y resultados.
      accounts = accounts.filter((account) => String(account.id) !== id);
      renderAccounts();
      els.accountSelect.value = selected;
      setMessage(els.searchError, message);
      if (isQueryVisible()) loadExports(exportsPage);
      return;
    }
    resetFilters();
    accounts = accounts.filter((account) => String(account.id) !== id);
    renderAccounts();
    goToQuery();
    setMessage(els.searchError, message);
    focusFirstFilter();
  }

  function startSession(body) {
    token = body.token;
    accounts = body.accounts;
    els.loginForm.reset();
    renderAccounts();
    exportsPage = { cursor: null, stack: [], next: null };
    resetFilters();
    els.loginView.hidden = true;
    els.queryView.hidden = false;
    goToQuery();
    focusFirstFilter();
  }

  function endSession(notice) {
    token = null;
    accounts = [];
    screens = [];
    resetFilters();
    exportsPainted = null;
    els.exportsBody.replaceChildren();
    els.exportsTable.hidden = true;
    renderPager(els.exportsPager, null, false);
    for (const element of [els.exportsStatus, els.exportsError, els.deliveriesStatus, els.deliveriesError, els.deliveryError, els.smsError]) setMessage(element, '');
    els.deliveriesBody.replaceChildren();
    els.deliveriesTable.hidden = true;
    renderPager(els.deliveriesPager, null, false);
    els.smsFacts.replaceChildren();
    els.smsContent.textContent = '';
    els.smsCard.hidden = true;
    els.accountSelect.replaceChildren();
    els.accountName.textContent = '';
    els.loginForm.reset();
    els.queryView.hidden = true;
    setHero('Consulta de SMS', '', true);
    showLoginIfUsable();
    setMessage(els.loginStatus, '');
    setMessage(els.loginError, notice);
    els.username.focus();
  }

  async function runLogin() {
    if (els.loginButton.disabled) return;

    const credentials = { link, username: els.username.value.trim(), password: els.password.value };
    // Sin un botón de envío, el navegador ya no revisa required.
    if (!credentials.username || !credentials.password) {
      setMessage(els.loginError, CREDENTIALS_ERROR);
      (credentials.username ? els.password : els.username).focus();
      return;
    }

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
      setMessage(els.loginError, GENERIC_ERROR);
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
    } else if (result.status === 401 && body && body.error === 'invalid_link') {
      els.loginForm.reset();
      els.loginView.hidden = true;
      showLinkNotice(serverMessage(body));
    } else {
      setMessage(els.loginError, serverMessage(body));
      els.password.focus();
    }
  }

  // El <form> sigue para el relleno automático, pero no se envía: lo que corre es el botón o Enter, con o sin allow-forms.
  for (const form of [els.loginForm, els.searchForm, els.fullReportForm, els.deliveriesForm, els.messagesForm]) {
    form.addEventListener('submit', (event) => event.preventDefault());
  }
  els.loginButton.addEventListener('click', runLogin);
  els.searchButton.addEventListener('click', runSearch);
  els.fullReportButton.addEventListener('click', runFullReport);
  els.deliveriesButton.addEventListener('click', runDeliveriesSearch);
  els.messagesButton.addEventListener('click', runMessagesSearch);
  runOnEnter([els.username, els.password], runLogin);
  runOnEnter([els.number, els.start, els.end], runSearch);
  runOnEnter([els.fullReportStart, els.fullReportEnd], runFullReport);
  runOnEnter([els.deliveriesQuery], runDeliveriesSearch);
  runOnEnter([els.messagesNumber], runMessagesSearch);
  els.searchForm.addEventListener('input', onFilterInput);
  els.accountSelect.addEventListener('change', onAccountChange);
  els.logoutButton.addEventListener('click', () => endSession(''));
  els.backButton.addEventListener('click', goBack);
  els.menuQuery.addEventListener('click', () => openRoot(SCREEN_QUERY));
  els.menuDeliveries.addEventListener('click', () => openRoot(SCREEN_DELIVERIES));
  els.pager.prev.addEventListener('click', onPrevPage);
  els.pager.next.addEventListener('click', onNextPage);
  els.exportResults.addEventListener('click', runExportResults);
  els.exportsRefresh.addEventListener('click', () => loadExports(exportsPage));
  els.exportsPager.prev.addEventListener('click', () => loadExports(previousOf(exportsPage)));
  els.exportsPager.next.addEventListener('click', () => loadExports(nextOf(exportsPage)));
  els.deliveriesPager.prev.addEventListener('click', () => loadDeliveries(previousOf(deliveriesPage)));
  els.deliveriesPager.next.addEventListener('click', () => loadDeliveries(nextOf(deliveriesPage)));
  els.messagesPager.prev.addEventListener('click', () => loadMessages(previousOf(messagesPage)));
  els.messagesPager.next.addEventListener('click', () => loadMessages(nextOf(messagesPage)));
  els.tabNational.addEventListener('click', () => selectTab(true));
  els.tabInternational.addEventListener('click', () => selectTab(false));
  els.statsRefresh.addEventListener('click', () => startStatsPoll(0));
  els.deliveryProgressRefresh.addEventListener('click', () => startProgressPoll(0));
  for (const control of [reportControl, responsesControl]) {
    control.button.addEventListener('click', () => runJobButton(control));
    control.regenerate.addEventListener('click', () => runRegenerate(control));
    control.refresh.addEventListener('click', () => startJobPoll(control, 0));
  }
  els.downloadHelpShow.addEventListener('click', showDownloadLink);
  document.addEventListener('visibilitychange', resumePolls);

  // Al final, y con todo ya conectado: si algo falla antes o este archivo no llega, sigue a la vista el aviso de index.html.
  els.loadNotice.hidden = true;
  showLoginIfUsable();

  // Embebida, enfocar al cargar le quitaría el foco a la página del cliente y la haría saltar hasta el iframe.
  if (self === top) els.username.focus();
}());
