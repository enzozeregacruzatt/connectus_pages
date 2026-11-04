'use strict';

const { isQueryCut } = require('./db');
const { readLink } = require('./deliveries');
const { toSafeId } = require('./sms');
const { chileWallClockMs, formatUtcAsChile, wallClockMs } = require('./time');

const DAY_MS = 86400000;
const FRESH_DAYS = 4;
const SETTLED_DAYS = 15;
const FIXED_AFTER_DAYS = 16;
const FRESH_MAX_AGE_SECONDS = 10 * 60;
const SETTLED_MAX_AGE_SECONDS = 6 * 3600;
const FAILURE_PAUSE_SECONDS = 10 * 60;
const STEP_GUARD_MS = 8000;
const LINK_STEP = 2000;
const MIN_STEP = 500;
const MIN_STEP_PAUSE_MS = 1000;

const COLUMN_OTHER = 'Otros';
const NATIONAL_COUNTRY = 'Chile';
const NATIONAL_COLUMNS = ['Movistar', 'Entel', 'Claro', 'Wom', 'VTR', 'Virgin'].map((value) => ({ value, label: value }));
const INTERNATIONAL_COLUMNS = [
  { value: 'Peru', label: 'Perú' },
  { value: 'Colombia', label: 'Colombia' },
  { value: 'Mexico', label: 'México' },
  { value: 'Brasil', label: 'Brasil' },
  { value: 'Argentina', label: 'Argentina' },
];
// El orden importa: UNDELIVRD contiene DELIVRD, y cada estado cae en una sola fila para que la tabla sume el total.
const CATEGORIES = [
  { match: 'NEW', label: 'Programado', chartLabel: 'Programados', color: '#5db7e5' },
  { match: 'QUEUED', label: 'En cola', chartLabel: 'En Cola', color: '#5db7e5' },
  { match: 'ESME_RI', label: 'Número inválido', chartLabel: 'Número Inválido', color: '#66748e' },
  { match: 'SENT_TO_ESME', label: 'Enviado al proveedor', chartLabel: 'Enviado a Proveedor', color: '#ffc107' },
  { match: 'ESME_ROK', label: 'Esperando respuesta', chartLabel: 'Esperando Respuesta', color: '#ffc107' },
  { match: 'UNDELIV', label: 'No entregable', chartLabel: 'No entregables', color: '#f55343' },
  { match: 'OUTBALANCE', label: 'Sin saldo', chartLabel: 'Sin Saldo', color: '#f55343' },
  { match: 'DELIVRD', label: 'Entregado', chartLabel: 'Entregados', color: '#2ccec0' },
];
const OTHER_CATEGORY = { label: 'Otros estados', chartLabel: 'Otros estados', color: '#adb5bd' };
const ALL_CATEGORIES = [...CATEGORIES, OTHER_CATEGORY];

const SELECT_STATS = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ counts, links_distinct, clicks_sum, counted_at, work_phase, work_counts, '
  + 'work_links_distinct, work_clicks_sum, work_last_id, work_rows, work_step, work_started_at, '
  + 'TIMESTAMPDIFF(SECOND, counted_at, UTC_TIMESTAMP()) AS counted_age_s, '
  + 'TIMESTAMPDIFF(SECOND, failed_at, UTC_TIMESTAMP()) AS failed_age_s, '
  + 'TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), next_step_at) AS next_step_in_us '
  + 'FROM connectus_pages.delivery_stats WHERE id_delivery = ?';
const INSERT_STATS = 'INSERT IGNORE INTO connectus_pages.delivery_stats (id_delivery, id_account, next_step_at, updated_at) '
  + 'VALUES (?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP())';
const SELECT_LAST_ROW = 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ created_at FROM connectus_pages.sms_de_envio '
  + 'WHERE id_delivery = ? AND id_account = ? ORDER BY id DESC LIMIT 1';

// Un trabajo sigue siendo de quien lo tomó, salvo que lleve 10 minutos sin moverse. MySQL evalúa el SET de izquierda a derecha, y
// por eso work_phase y updated_at, de los que depende la condición, van al final.
const ABANDONED = "(work_phase = 'idle' OR updated_at < UTC_TIMESTAMP() - INTERVAL 10 MINUTE)";
const CLAIM = 'UPDATE connectus_pages.delivery_stats SET '
  + `work_counts = IF(${ABANDONED}, NULL, work_counts), `
  + `work_links_distinct = IF(${ABANDONED}, NULL, work_links_distinct), `
  + `work_clicks_sum = IF(${ABANDONED}, NULL, work_clicks_sum), `
  + `work_last_id = IF(${ABANDONED}, 0, work_last_id), `
  + `work_rows = IF(${ABANDONED}, 0, work_rows), `
  + `work_started_at = IF(${ABANDONED}, UTC_TIMESTAMP(), work_started_at), `
  + `work_phase = IF(${ABANDONED}, 'counts', work_phase), `
  + 'next_step_at = UTC_TIMESTAMP(3) + INTERVAL 15 SECOND, updated_at = UTC_TIMESTAMP() '
  + 'WHERE id_delivery = ? AND next_step_at <= UTC_TIMESTAMP(3)';

const SELECT_STEP_LIMIT = 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ id FROM connectus_pages.sms_ids_de_envio '
  + 'WHERE id_delivery = ? AND id > ? ORDER BY id LIMIT 1 OFFSET ?';
const COUNT_STEP = 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ status, dst_provider, dst_country, COUNT(*) AS n '
  + 'FROM connectus_pages.sms_de_envio WHERE id_delivery = ? AND id_account = ? AND id > ?';
const COUNT_STEP_GROUP = ' GROUP BY status, dst_provider, dst_country';
const SUM_LINKS_STEP = 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ COUNT(DISTINCT id_short_link) AS links, '
  + 'COALESCE(SUM(clicks), 0) AS clics FROM connectus_pages.link_de_sms WHERE id_delivery = ? AND id_sms > ?';

// Si otro retomó el trabajo mientras este tramo corría, ninguna de estas escrituras encuentra su fila. La fase va porque al pasar a
// links work_last_id vuelve a 0, y un escritor tardío del primer tramo calzaría con ella.
const SAME_WORK = ' WHERE id_delivery = ? AND work_phase = ? AND work_last_id = ? AND work_started_at = ?';
const NEXT_STEP_AT = 'next_step_at = UTC_TIMESTAMP(3) + INTERVAL ? * 1000 MICROSECOND, updated_at = UTC_TIMESTAMP()';
const SAVE_STEP = 'UPDATE connectus_pages.delivery_stats SET work_phase = ?, work_counts = ?, work_links_distinct = ?, '
  + `work_clicks_sum = ?, work_last_id = ?, work_rows = ?, ${NEXT_STEP_AT}${SAME_WORK}`;
const SHRINK_STEP = `UPDATE connectus_pages.delivery_stats SET work_step = ?, ${NEXT_STEP_AT}${SAME_WORK}`;
const RESET_WORK = "work_phase = 'idle', work_step = 5000, work_last_id = 0, work_rows = 0, work_counts = NULL, "
  + 'work_links_distinct = NULL, work_clicks_sum = NULL, work_started_at = NULL, '
  + 'next_step_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP()';
// counted_at tiene que leer work_started_at antes de que se borre.
const PUBLISH = 'UPDATE connectus_pages.delivery_stats SET counts = ?, links_distinct = ?, clicks_sum = ?, '
  + `counted_at = work_started_at, failed_at = NULL, ${RESET_WORK}${SAME_WORK}`;
const GIVE_UP = `UPDATE connectus_pages.delivery_stats SET failed_at = UTC_TIMESTAMP(), ${RESET_WORK}${SAME_WORK}`;

const ER_LOCK_DEADLOCK = 1213;
const CREATE_ROW_ATTEMPTS = 3;

const STEP_ADVANCED = 'advanced';
const STEP_PUBLISHED = 'published';

function isWithinStepGuard(startedAtMs) {
  return performance.now() - startedAtMs < STEP_GUARD_MS;
}

function categoryOf(status) {
  if (typeof status !== 'string') return OTHER_CATEGORY;
  return CATEGORIES.find((category) => status.includes(category.match)) ?? OTHER_CATEGORY;
}

function isInternational(row) {
  return row.country !== null && row.country !== NATIONAL_COUNTRY;
}

function buildTable(rows, columns, columnValueOf) {
  const labels = [...columns.map((column) => column.label), COLUMN_OTHER];
  const indexOf = (value) => {
    const index = columns.findIndex((column) => column.value === value);
    return index === -1 ? columns.length : index;
  };
  const cells = new Map(ALL_CATEGORIES.map((category) => [category, labels.map(() => 0)]));
  for (const row of rows) cells.get(categoryOf(row.status))[indexOf(columnValueOf(row))] += row.n;

  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const tableRows = ALL_CATEGORIES.map((category) => ({
    label: category.label,
    cells: cells.get(category),
    total: sum(cells.get(category)),
  }));
  const totalCells = labels.map((_, index) => sum(tableRows.map((row) => row.cells[index])));
  return { columns: labels, rows: tableRows, totals: { cells: totalCells, total: sum(totalCells) } };
}

// Las tablas y el gráfico se arman aquí: 8.x no ordena el GROUP BY.
function buildTables(counts) {
  const international = counts.filter(isInternational);
  const national = counts.filter((row) => !isInternational(row));
  const chart = CATEGORIES.map((category) => ({ label: category.chartLabel, color: category.color, value: 0 }));
  let otherStates = 0;
  for (const row of counts) {
    const index = CATEGORIES.indexOf(categoryOf(row.status));
    if (index === -1) otherStates += row.n;
    else chart[index].value += row.n;
  }
  if (otherStates > 0) chart.push({ label: OTHER_CATEGORY.chartLabel, color: OTHER_CATEGORY.color, value: otherStates });
  return {
    national: buildTable(national, NATIONAL_COLUMNS, (row) => row.provider),
    international: buildTable(international, INTERNATIONAL_COLUMNS, (row) => row.country),
    chart,
  };
}

function mergeCounts(previous, rows) {
  const merged = new Map();
  const add = ({ status, provider, country, n }) => {
    const key = JSON.stringify([status, provider, country]);
    const entry = merged.get(key);
    if (entry) entry.n += n;
    else merged.set(key, { status, provider, country, n });
  };
  (previous ?? []).forEach(add);
  rows.forEach((row) => add({ status: row.status, provider: row.dst_provider, country: row.dst_country, n: toSafeId(row.n) }));
  return [...merged.values()];
}

// baseMs está en hora de Chile, igual que nowWallMs. Una foto fija deja de recalcularse sola: basta con que se haya tomado después
// del plazo, con 1 día de holgura porque counted_at es UTC.
function isStale({ countedAt, countedAgeSeconds, baseMs, nowWallMs }) {
  if (countedAt === null) return true;
  const baseAgeMs = baseMs === null ? 0 : nowWallMs - baseMs;
  if (baseAgeMs < FRESH_DAYS * DAY_MS) return countedAgeSeconds > FRESH_MAX_AGE_SECONDS;
  if (baseAgeMs <= SETTLED_DAYS * DAY_MS) return countedAgeSeconds > SETTLED_MAX_AGE_SECONDS;
  return wallClockMs(countedAt) < baseMs + FIXED_AFTER_DAYS * DAY_MS;
}

async function readRow(db, deliveryId) {
  const [row] = await db.query(SELECT_STATS, [deliveryId]);
  return row;
}

// La primera vez, varias pantallas a la vez pueden chocar en el INSERT con un 1213. La que gana todavía puede no haber confirmado
// cuando la perdedora relee, y por eso se intenta de nuevo.
async function readOrCreateRow(db, delivery) {
  for (let attempt = 0; attempt < CREATE_ROW_ATTEMPTS; attempt += 1) {
    const row = await readRow(db, delivery.id);
    if (row) return row;
    try {
      await db.write(INSERT_STATS, [delivery.id, delivery.account]);
    } catch (error) {
      if (error.errno !== ER_LOCK_DEADLOCK) throw error;
    }
  }
  const row = await readRow(db, delivery.id);
  if (!row) throw Object.assign(new Error('stats_row_missing'), { code: 'stats_row_missing' });
  return row;
}

// JSON llega ya interpretado por mysql2.
function workState(row) {
  return {
    counts: row.work_counts,
    linksDistinct: row.work_links_distinct === null ? null : toSafeId(row.work_links_distinct),
    clicksSum: row.work_clicks_sum === null ? null : toSafeId(row.work_clicks_sum),
    lastId: toSafeId(row.work_last_id),
    rows: toSafeId(row.work_rows),
  };
}

async function stepLimit(db, deliveryId, lastId, size) {
  const [row] = await db.query(SELECT_STEP_LIMIT, [deliveryId, lastId, size - 1]);
  return row ? toSafeId(row.id) : null;
}

function withUpperBound(sql, params, limit, column) {
  return limit === null ? { sql, params } : { sql: `${sql} AND ${column} <= ?`, params: [...params, limit] };
}

async function runCountsStep(db, delivery, row, work) {
  const limit = await stepLimit(db, delivery.id, work.lastId, toSafeId(row.work_step));
  const { sql, params } = withUpperBound(COUNT_STEP, [delivery.id, delivery.account, work.lastId], limit, 'id');
  const rows = await db.query(sql + COUNT_STEP_GROUP, params);
  const counts = mergeCounts(work.counts, rows);
  const counted = work.rows + rows.reduce((total, item) => total + toSafeId(item.n), 0);

  if (limit !== null) return { next: { phase: 'counts', counts, lastId: limit, rows: counted } };
  if (await readLink(db, delivery.id, delivery.account)) {
    return { next: { phase: 'links', counts, linksDistinct: 0, clicksSum: 0, lastId: 0, rows: counted } };
  }
  return { publish: { counts, linksDistinct: null, clicksSum: null } };
}

function linkStepSize(row) {
  return Math.min(LINK_STEP, toSafeId(row.work_step));
}

async function runLinksStep(db, delivery, row, work) {
  const size = linkStepSize(row);
  const limit = await stepLimit(db, delivery.id, work.lastId, size);
  const { sql, params } = withUpperBound(SUM_LINKS_STEP, [delivery.id, work.lastId], limit, 'id_sms');
  const [sums] = await db.query(sql, params);
  const links = toSafeId(sums.links);

  // Con un solo link por envío, seguir sería recorrer todas las filas para no encontrar nada.
  if (work.lastId === 0 && links === 0) return { publish: { counts: work.counts, linksDistinct: 0, clicksSum: 0 } };

  const linksDistinct = work.linksDistinct + links;
  const clicksSum = work.clicksSum + toSafeId(sums.clics);
  if (limit === null) return { publish: { counts: work.counts, linksDistinct, clicksSum } };
  return { next: { phase: 'links', counts: work.counts, linksDistinct, clicksSum, lastId: limit, rows: work.rows + size } };
}

function pauseAfter(startedMs) {
  return Math.max(MIN_STEP_PAUSE_MS, 3 * Math.ceil(performance.now() - startedMs));
}

async function handleCut(db, row, sameWork, startedMs) {
  const size = row.work_phase === 'links' ? linkStepSize(row) : toSafeId(row.work_step);
  if (size <= MIN_STEP) {
    await db.write(GIVE_UP, sameWork);
    return;
  }
  await db.write(SHRINK_STEP, [Math.max(MIN_STEP, Math.floor(size / 2)), pauseAfter(startedMs), ...sameWork]);
}

// Corre un tramo del trabajo ya reclamado. Un error que no sea un corte sube a la petición, y el trabajo queda para el próximo que
// lo reclame cuando venza next_step_at.
async function runStep(db, delivery, row) {
  // Otro publicó entre el reclamo y la relectura.
  if (row.work_phase === 'idle') return STEP_ADVANCED;
  const startedMs = performance.now();
  const work = workState(row);
  const sameWork = [delivery.id, row.work_phase, work.lastId, row.work_started_at];
  let outcome;
  try {
    outcome = await (row.work_phase === 'links' ? runLinksStep : runCountsStep)(db, delivery, row, work);
  } catch (error) {
    if (!isQueryCut(error)) throw error;
    await handleCut(db, row, sameWork, startedMs);
    return STEP_ADVANCED;
  }

  if (outcome.publish) {
    const { counts, linksDistinct, clicksSum } = outcome.publish;
    const written = await db.write(PUBLISH, [JSON.stringify(counts), linksDistinct, clicksSum, ...sameWork]);
    return written.affectedRows === 1 ? STEP_PUBLISHED : STEP_ADVANCED;
  }
  const { phase, counts, linksDistinct = null, clicksSum = null, lastId, rows } = outcome.next;
  await db.write(SAVE_STEP, [phase, JSON.stringify(counts), linksDistinct, clicksSum, lastId, rows, pauseAfter(startedMs), ...sameWork]);
  return STEP_ADVANCED;
}

async function buildLinks(db, delivery, row) {
  const link = await readLink(db, delivery.id, delivery.account);
  if (!link) return null;
  const clicksSum = row.clicks_sum === null ? 0 : toSafeId(row.clicks_sum);
  return {
    distinct: row.links_distinct === null ? 0 : toSafeId(row.links_distinct),
    clicks: clicksSum > 0 ? clicksSum : toSafeId(link.clicks ?? 0),
  };
}

function hasRecentFailure(row) {
  return row.failed_age_s !== null && Number(row.failed_age_s) < FAILURE_PAUSE_SECONDS;
}

async function readDeliveryStats(db, delivery, { nowMs, startedAtMs }) {
  let baseMs;
  let baseUnknown = false;
  const staleNow = async (row) => {
    if (row.counted_at === null) return true;
    if (baseUnknown) return false;
    if (baseMs === undefined) {
      let last;
      try {
        [last] = await db.query(SELECT_LAST_ROW, [delivery.id, delivery.account]);
      } catch (error) {
        if (!isQueryCut(error)) throw error;
        // Con la base así no se reclama un tramo: sale la foto que ya está en la fila.
        baseUnknown = true;
        return false;
      }
      const candidates = [wallClockMs(delivery.deliverAt), wallClockMs(last?.created_at)].filter((value) => value !== null);
      baseMs = candidates.length === 0 ? null : Math.max(...candidates);
    }
    return isStale({
      countedAt: row.counted_at,
      countedAgeSeconds: Number(row.counted_age_s),
      baseMs,
      nowWallMs: chileWallClockMs(nowMs),
    });
  };

  let row = await readOrCreateRow(db, delivery);
  let published = false;
  if (await staleNow(row) && !hasRecentFailure(row) && isWithinStepGuard(startedAtMs)) {
    const claim = await db.write(CLAIM, [delivery.id]);
    if (claim.affectedRows === 1) {
      published = await runStep(db, delivery, await readRow(db, delivery.id)) === STEP_PUBLISHED;
    }
    row = await readRow(db, delivery.id);
  }

  let state = 'ready';
  if (!published && await staleNow(row)) state = hasRecentFailure(row) ? 'failed' : 'computing';

  const hasPhoto = row.counted_at !== null;
  const tables = hasPhoto ? buildTables(row.counts) : { national: null, international: null, chart: null };
  return {
    state,
    updatedAt: formatUtcAsChile(row.counted_at),
    progressRows: toSafeId(row.work_rows),
    retryAfterMs: state === 'computing' ? Math.max(0, Math.ceil(Number(row.next_step_in_us) / 1000)) : 0,
    ...tables,
    links: hasPhoto ? await buildLinks(db, delivery, row) : null,
  };
}

module.exports = { buildTables, categoryOf, isStale, mergeCounts, readDeliveryStats };
