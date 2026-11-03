'use strict';

const { decodeCursor, encodeCursor } = require('./cursor');

const PAGE_SIZE = 50;
const MAX_RANGE_DAYS = 15;
const DAY_MS = 86400000;
const MIN_YEAR = 1001;
const MAX_YEAR = 9998;
const TIME_ZONE = 'America/Santiago';
// Cuántos días deben separar el fin del rango de hoy para que la cota superior de id sirva. Ver searchSms.
const UPPER_BOUND_MIN_AGE_DAYS = 2;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const DST_PATTERN = /^\d{1,15}$/;
const CREATED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/;

const SEARCH_PARAMETERS = ['account', 'start', 'end', 'dst', 'cursor'];

const UNKNOWN_STATUS_LABEL = 'Sin información';
const UNDELIVERABLE_LABEL = 'No entregable';
const STATUS_LABELS = new Map([
  ['NEW', 'Programado'],
  ['DELIVRD', 'Entregado'],
  ['UNDELIV', UNDELIVERABLE_LABEL],
  ['SENT_TO_ESME', 'Enviado a proveedor'],
  ['ESME_ROK', 'Esperando respuesta'],
  ['QUEUED', 'Encolado'],
  ['OUTBALANCE', 'Sin saldo'],
]);

// MAX_EXECUTION_TIME es por sentencia, y una búsqueda corre estas tres en serie: la suma de los topes tiene
// que caber en el timeout de la Lambda, o esta muere sin alcanzar a responder el 504.
const SELECT_LOWER_CUTOFF = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ connectus_pages.sms_cutoff_id(?) AS lo';
const SELECT_CUTOFFS = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ '
  + 'connectus_pages.sms_cutoff_id(?) AS lo, connectus_pages.sms_cutoff_id(?) AS hi';
const SELECT_SMS = 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_delivery, dst_number, sms_content, status, created_at '
  + 'FROM connectus_pages.sms '
  + 'WHERE id_account = ? AND id > ?';
const SELECT_DELIVERIES = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, name FROM connectus_pages.delivery '
  + 'WHERE id IN (?) AND id_account = ?';

const CHILE_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function statusLabel(status) {
  if (typeof status !== 'string') return UNKNOWN_STATUS_LABEL;
  if (STATUS_LABELS.has(status)) return STATUS_LABELS.get(status);
  return status.includes('ESME_') ? UNDELIVERABLE_LABEL : UNKNOWN_STATUS_LABEL;
}

// Se trabaja sobre el texto: created_at es hora de Chile sin zona, y pasar por Date la movería según
// la zona del proceso.
function formatCreatedAt(createdAt) {
  const match = typeof createdAt === 'string' ? CREATED_AT_PATTERN.exec(createdAt) : null;
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

// Date.UTC no depende de la zona del proceso. Los años quedan acotados porque las cotas de id corren
// la fecha un día hacia cada lado y no deben salirse del rango de DATETIME.
function toDayNumber(text) {
  const match = typeof text === 'string' ? DATE_PATTERN.exec(text) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return time / DAY_MS;
}

function shiftDate(text, days) {
  return new Date((toDayNumber(text) + days) * DAY_MS).toISOString().slice(0, 10);
}

function chileDayNumber(nowMs) {
  const parts = CHILE_DATE.formatToParts(nowMs);
  const part = (type) => Number(parts.find((item) => item.type === type).value);
  return Date.UTC(part('year'), part('month') - 1, part('day')) / DAY_MS;
}

function parsePositiveInteger(text) {
  if (typeof text !== 'string' || !POSITIVE_INTEGER_PATTERN.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function invalid(code, message) {
  return { ok: false, code, message };
}

function parseSearch(query, { cursorSecret } = {}) {
  const values = {};
  for (const name of SEARCH_PARAMETERS) {
    const given = query[name];
    if (given === undefined) continue;
    const list = Array.isArray(given) ? given : [given];
    if (list.length !== 1) return invalid('invalid_request', 'Cada parámetro debe venir una sola vez.');
    values[name] = list[0];
  }

  const account = parsePositiveInteger(values.account);
  if (account === null) return invalid('invalid_request', 'Debes indicar una cuenta válida.');

  const startDay = toDayNumber(values.start);
  const endDay = toDayNumber(values.end);
  if (startDay === null || endDay === null || endDay < startDay || endDay - startDay >= MAX_RANGE_DAYS) {
    return invalid('invalid_range', 'El rango debe ser válido y no superar 15 días.');
  }

  // Igual que en la plataforma: vacío o solo espacios cuenta como no indicado.
  let dst = null;
  if (values.dst !== undefined && String(values.dst).trim() !== '') {
    dst = String(values.dst).replace(/\D/g, '');
    if (!DST_PATTERN.test(dst)) return invalid('invalid_number', 'Debes indicar un número destino válido.');
  }

  let cursor = null;
  if (values.cursor !== undefined) {
    cursor = decodeCursor(values.cursor, account, cursorSecret);
    if (cursor === null) return invalid('invalid_request', 'El cursor no es válido.');
  }

  return { ok: true, account, start: values.start, end: values.end, dst, cursor };
}

// Los ids llegan como texto por bigNumberStrings. Se pasan como número porque query() deja los
// números sin comillas, y así se comparan contra la columna sin conversión a texto.
function toSafeId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) {
    const error = new Error('unexpected_id');
    error.code = 'unexpected_id';
    throw error;
  }
  return id;
}

async function fetchDeliveryNames(db, rows, account) {
  const ids = [...new Set(rows.filter((row) => row.id_delivery !== null).map((row) => toSafeId(row.id_delivery)))];
  if (ids.length === 0) return new Map();
  const deliveries = await db.query(SELECT_DELIVERIES, [ids, account]);
  return new Map(deliveries.map(({ id, name }) => [toSafeId(id), name]));
}

async function searchSms(db, { account, start, end, dst, cursor }, { nowMs, cursorSecret }) {
  const lowerLimit = `${shiftDate(start, -1)} 00:00:00`;
  // hi es la fila con el created_at mayor bajo el fin más 1 día. Mientras ese día no haya pasado no quedan filas de
  // margen delante del rango: hi es la fila más nueva por created_at, no la de id mayor, y dejaría fuera cualquier
  // fila con id mayor y created_at menor, de cualquier cuenta. Ahí tampoco ahorra nada. El día extra de holgura cubre
  // el cambio de hora.
  const useUpperBound = toDayNumber(end) < chileDayNumber(nowMs) - UPPER_BOUND_MIN_AGE_DAYS;
  const [cutoffs] = useUpperBound
    ? await db.query(SELECT_CUTOFFS, [lowerLimit, `${shiftDate(end, 1)} 23:59:59`])
    : await db.query(SELECT_LOWER_CUTOFF, [lowerLimit]);

  let sql = SELECT_SMS;
  const params = [account, toSafeId(cutoffs.lo)];
  if (useUpperBound) {
    sql += ' AND id <= ?';
    params.push(toSafeId(cutoffs.hi));
  }
  sql += ' AND created_at BETWEEN ? AND ?';
  params.push(`${start} 00:00:00`, `${end} 23:59:59`);
  if (dst !== null) {
    sql += ' AND dst_number = ?';
    params.push(Number(dst));
  }
  if (cursor !== null) {
    sql += ' AND id < ?';
    params.push(cursor);
  }
  sql += ` ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`;

  const rows = await db.query(sql, params);
  const page = rows.slice(0, PAGE_SIZE);
  const deliveryNames = await fetchDeliveryNames(db, page, account);

  return {
    items: page.map((row) => ({
      createdAt: formatCreatedAt(row.created_at),
      dst: String(row.dst_number),
      content: row.sms_content ?? '',
      status: statusLabel(row.status),
      delivery: row.id_delivery === null ? null : deliveryNames.get(toSafeId(row.id_delivery)) ?? null,
    })),
    nextCursor: rows.length > PAGE_SIZE ? encodeCursor(toSafeId(page[page.length - 1].id), account, cursorSecret) : null,
  };
}

module.exports = { formatCreatedAt, parseSearch, searchSms, statusLabel };
