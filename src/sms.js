'use strict';

const { decodeCursor, encodeCursor } = require('./cursor');
const { chileWallClockMs } = require('./time');

const PAGE_SIZE = 50;
const MAX_RANGE_DAYS = 15;
const DAY_MS = 86400000;
const MIN_YEAR = 1001;
const MAX_YEAR = 9998;
// Cuántos días deben separar el fin del rango de hoy para que la cota superior de id sirva. Ver searchSms.
const UPPER_BOUND_MIN_AGE_DAYS = 2;
const SMS_PRODUCT_ID = 1;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const DST_PATTERN = /^\d{1,15}$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const UNIQUE_ID_PATTERN = /^[0-9A-Za-z-]{1,32}$/;

const SEARCH_PARAMETERS = ['account', 'start', 'end', 'dst', 'cursor'];
const DETAIL_PARAMETERS = ['account', 'id'];
const MESSAGE_BYTES = 160;

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
// Cada vista lleva fijado su índice: sin número, el de la cuenta; con número, el del número.
const SELECT_SMS_OF_ACCOUNT = 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_delivery, dst_number, sms_content, status, created_at '
  + 'FROM connectus_pages.sms_de_cuenta '
  + 'WHERE id_account = ? AND id > ?';
const SELECT_SMS_OF_NUMBER = 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_delivery, dst_number, sms_content, status, created_at '
  + 'FROM connectus_pages.sms_de_numero '
  + 'WHERE id_account = ? AND id > ?';
const SELECT_DELIVERIES = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, id_unique, name, id_product FROM connectus_pages.delivery '
  + 'WHERE id IN (?) AND id_account = ?';

// El índice único gana solo, y sms_content entra porque esta es la pantalla que lo muestra.
const SELECT_SMS_DETAIL = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id_unique, id_delivery, src_number, dst_number, dst_country, '
  + 'updated_at, dst_provider, status, sms_content FROM connectus_pages.sms WHERE id_unique = ? AND id_account = ?';

function statusLabel(status) {
  if (typeof status !== 'string') return UNKNOWN_STATUS_LABEL;
  if (STATUS_LABELS.has(status)) return STATUS_LABELS.get(status);
  return status.includes('ESME_') ? UNDELIVERABLE_LABEL : UNKNOWN_STATUS_LABEL;
}

// Se trabaja sobre el texto: created_at es hora de Chile sin zona, y pasar por Date la movería según
// la zona del proceso.
function formatCreatedAt(createdAt) {
  const seconds = formatWithSeconds(createdAt);
  return seconds && seconds.slice(0, -3);
}

function formatWithSeconds(text) {
  const match = typeof text === 'string' ? DATETIME_PATTERN.exec(text) : null;
  // Una fecha en cero no dice nada: se muestra igual que una nula.
  if (!match || match[1] === '0000') return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
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
  return Math.floor(chileWallClockMs(nowMs) / DAY_MS);
}

function parsePositiveInteger(text) {
  if (typeof text !== 'string' || !POSITIVE_INTEGER_PATTERN.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function invalid(code, message) {
  return { ok: false, code, message };
}

// Devuelve null si un parámetro viene más de una vez.
function readParameters(query, names) {
  const values = {};
  for (const name of names) {
    const given = query[name];
    if (given === undefined) continue;
    const list = Array.isArray(given) ? given : [given];
    if (list.length !== 1) return null;
    values[name] = list[0];
  }
  return values;
}

const REPEATED_PARAMETER = invalid('invalid_request', 'Cada parámetro debe venir una sola vez.');
const INVALID_ACCOUNT = invalid('invalid_request', 'Debes indicar una cuenta válida.');
const INVALID_NUMBER = invalid('invalid_number', 'Debes indicar un número destino válido.');
const INVALID_CURSOR = invalid('invalid_request', 'El cursor no es válido.');
const INVALID_UNIQUE_ID = invalid('invalid_request', 'El identificador no es válido.');

// Igual que en la plataforma: vacío o solo espacios cuenta como no indicado. Devuelve undefined si no es un número válido.
function parseDst(value) {
  if (value === undefined || String(value).trim() === '') return null;
  const dst = String(value).replace(/\D/g, '');
  return DST_PATTERN.test(dst) ? dst : undefined;
}

// Siempre texto, con su forma: un número deja la columna sin índice, y un carácter que la columna no puede guardar da error.
function parseUniqueId(value) {
  return typeof value === 'string' && UNIQUE_ID_PATTERN.test(value) ? value : null;
}

const smsCursorLabel = (account) => `sms:${account}`;

function parseSearch(query, { cursorSecret } = {}) {
  const values = readParameters(query, SEARCH_PARAMETERS);
  if (!values) return REPEATED_PARAMETER;

  const account = parsePositiveInteger(values.account);
  if (account === null) return INVALID_ACCOUNT;

  const startDay = toDayNumber(values.start);
  const endDay = toDayNumber(values.end);
  if (startDay === null || endDay === null || endDay < startDay || endDay - startDay >= MAX_RANGE_DAYS) {
    return invalid('invalid_range', 'El rango debe ser válido y no superar 15 días.');
  }

  const dst = parseDst(values.dst);
  if (dst === undefined) return INVALID_NUMBER;

  let cursor = null;
  if (values.cursor !== undefined) {
    cursor = decodeCursor(values.cursor, smsCursorLabel(account), cursorSecret);
    if (cursor === null) return INVALID_CURSOR;
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

async function fetchDeliveries(db, rows, account) {
  const ids = [...new Set(rows.filter((row) => row.id_delivery !== null).map((row) => toSafeId(row.id_delivery)))];
  if (ids.length === 0) return new Map();
  const deliveries = await db.query(SELECT_DELIVERIES, [ids, account]);
  return new Map(deliveries.map((delivery) => [toSafeId(delivery.id), delivery]));
}

// Cotas de id de un rango de fechas. hi es null cuando no sirve.
async function readIdCutoffs(db, start, end, nowMs) {
  const lowerLimit = `${shiftDate(start, -1)} 00:00:00`;
  // hi es la fila con el created_at mayor bajo el fin más 1 día. Mientras ese día no haya pasado no quedan filas de
  // margen delante del rango: hi es la fila más nueva por created_at, no la de id mayor, y dejaría fuera cualquier
  // fila con id mayor y created_at menor, de cualquier cuenta. Ahí tampoco ahorra nada. El día extra de holgura cubre
  // el cambio de hora.
  const useUpperBound = toDayNumber(end) < chileDayNumber(nowMs) - UPPER_BOUND_MIN_AGE_DAYS;
  const [cutoffs] = useUpperBound
    ? await db.query(SELECT_CUTOFFS, [lowerLimit, `${shiftDate(end, 1)} 23:59:59`])
    : await db.query(SELECT_LOWER_CUTOFF, [lowerLimit]);
  return { lo: toSafeId(cutoffs.lo), hi: useUpperBound ? toSafeId(cutoffs.hi) : null };
}

async function searchSms(db, { account, start, end, dst, cursor }, { nowMs, cursorSecret }) {
  const { lo, hi } = await readIdCutoffs(db, start, end, nowMs);

  let sql = dst === null ? SELECT_SMS_OF_ACCOUNT : SELECT_SMS_OF_NUMBER;
  const params = [account, lo];
  if (hi !== null) {
    sql += ' AND id <= ?';
    params.push(hi);
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
  const deliveries = await fetchDeliveries(db, page, account);

  return {
    items: page.map((row) => {
      const delivery = row.id_delivery === null ? undefined : deliveries.get(toSafeId(row.id_delivery));
      return {
        createdAt: formatCreatedAt(row.created_at),
        dst: String(row.dst_number),
        content: row.sms_content ?? '',
        status: statusLabel(row.status),
        delivery: delivery?.name ?? null,
        // Solo los envíos del producto SMS tienen detalle: de los demás, el nombre queda como texto.
        deliveryId: delivery?.id_product === SMS_PRODUCT_ID ? delivery.id_unique : null,
      };
    }),
    nextCursor: rows.length > PAGE_SIZE ? encodeCursor(toSafeId(page[page.length - 1].id), smsCursorLabel(account), cursorSecret) : null,
  };
}

function parseSmsDetail(query) {
  const values = readParameters(query, DETAIL_PARAMETERS);
  if (!values) return REPEATED_PARAMETER;
  const account = parsePositiveInteger(values.account);
  if (account === null) return INVALID_ACCOUNT;
  const id = parseUniqueId(values.id);
  if (id === null) return INVALID_UNIQUE_ID;
  return { ok: true, account, id };
}

async function readSmsDetail(db, { account, id }) {
  const [row] = await db.query(SELECT_SMS_DETAIL, [id, account]);
  if (!row) return null;
  const deliveries = await fetchDeliveries(db, [row], account);
  const content = row.sms_content ?? '';
  return {
    id: row.id_unique,
    delivery: row.id_delivery === null ? null : deliveries.get(toSafeId(row.id_delivery))?.name ?? null,
    src: String(row.src_number),
    dst: String(row.dst_number),
    country: row.dst_country ?? null,
    updatedAt: formatWithSeconds(row.updated_at),
    provider: row.dst_provider ?? 'Otros',
    status: statusLabel(row.status),
    content,
    equivalent: Math.ceil(Buffer.byteLength(content, 'utf8') / MESSAGE_BYTES),
  };
}

module.exports = {
  INVALID_ACCOUNT,
  INVALID_CURSOR,
  INVALID_NUMBER,
  INVALID_UNIQUE_ID,
  REPEATED_PARAMETER,
  SMS_PRODUCT_ID,
  formatCreatedAt,
  formatWithSeconds,
  invalid,
  parseDst,
  parsePositiveInteger,
  parseSearch,
  parseSmsDetail,
  parseUniqueId,
  readIdCutoffs,
  readParameters,
  readSmsDetail,
  searchSms,
  statusLabel,
  toSafeId,
};
