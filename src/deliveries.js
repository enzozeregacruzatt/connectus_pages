'use strict';

const { decodeCursor, decodeDatedCursor, encodeCursor, encodeDatedCursor } = require('./cursor');
const { isQueryCut } = require('./db');
const { lastDeliveryJob } = require('./exports');
const {
  INVALID_ACCOUNT,
  INVALID_CURSOR,
  INVALID_NUMBER,
  INVALID_UNIQUE_ID,
  REPEATED_PARAMETER,
  SMS_PRODUCT_ID,
  formatCreatedAt,
  invalid,
  parseDst,
  parsePositiveInteger,
  parseUniqueId,
  readParameters,
  statusLabel,
  toSafeId,
} = require('./sms');
const { chileWallClockMs, wallClockMs } = require('./time');

const PAGE_SIZE = 10;
const MAX_QUERY_LENGTH = 100;
const DAY_MS = 86400000;
const ZERO_DATE = '0000-00-00 00:00:00';
const FIRST_VALID_DATE = '1000-01-01 00:00:00';
const SHORT_LINK_BASE = 'http://cnct.us/';
const NO_ERROR_REASON = 'No quedó registrado el motivo.';
// Las columnas de la plataforma son utf8mb3: no pueden contener un carácter de estos, y compararlos contra ellas da error.
const OUTSIDE_COLUMN_CHARSET = /[\u{10000}-\u{10FFFF}]/u;
const LIKE_SPECIALS = /[!%_]/g;

const VARIANT_GENERATING = 'generating';
const VARIANT_FAILED = 'failed';
const VARIANT_COMPLETE = 'complete';

const LIST_PARAMETERS = ['account', 'q', 'cursor'];
const DELIVERY_PARAMETERS = ['account', 'id'];
const MESSAGES_PARAMETERS = ['account', 'id', 'dst', 'cursor'];

const SELECT_LIST = 'SELECT /*+ MAX_EXECUTION_TIME(3000) */ id, id_unique, name, delivery_type, created_at, deliver_at '
  + `FROM connectus_pages.delivery WHERE id_account = ? AND id_product = ${SMS_PRODUCT_ID} AND created_at IS NOT NULL`;
const SELECT_TARGET = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, deliver_at FROM connectus_pages.delivery '
  + `WHERE id_unique = ? AND id_account = ? AND id_product = ${SMS_PRODUCT_ID}`;
const SELECT_DATOS = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, id_unique, name, delivery_type, deliver_at, created_at, status, '
  + 'error_status, has_base, contact_list_name, number_of_contacts FROM connectus_pages.delivery_datos '
  + `WHERE id_unique = ? AND id_account = ? AND id_product = ${SMS_PRODUCT_ID}`;
const COUNT_SENT = 'SELECT /*+ MAX_EXECUTION_TIME(1500) */ COUNT(*) AS n FROM connectus_pages.sms_ids_de_envio WHERE id_delivery = ?';
const COUNT_RESPONSES = 'SELECT /*+ MAX_EXECUTION_TIME(1500) */ COUNT(*) AS n FROM connectus_pages.incoming_ids_de_envio '
  + 'WHERE id_delivery = ?';
const SELECT_LINK = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id_unique, clicks FROM connectus_pages.link_de_envio '
  + 'WHERE id_delivery = ? AND id_account = ? LIMIT 1';
const MESSAGE_COLUMNS = 'id, id_unique, status, dst_number, dst_provider, dst_country, updated_at';
const SELECT_MESSAGES = `SELECT /*+ MAX_EXECUTION_TIME(3000) */ ${MESSAGE_COLUMNS} FROM connectus_pages.sms_de_envio `
  + 'WHERE id_delivery = ? AND id_account = ?';
const SELECT_MESSAGES_OF_NUMBER = `SELECT /*+ MAX_EXECUTION_TIME(3000) */ ${MESSAGE_COLUMNS} FROM connectus_pages.sms_de_numero `
  + 'WHERE id_delivery = ? AND id_account = ? AND dst_number = ?';

const listCursorLabel = (account) => `deliveries:${account}`;
const messagesCursorLabel = (account, id) => `messages:${account}:${id}`;

function parseDeliveryList(query, { cursorSecret }) {
  const values = readParameters(query, LIST_PARAMETERS);
  if (!values) return REPEATED_PARAMETER;
  const account = parsePositiveInteger(values.account);
  if (account === null) return INVALID_ACCOUNT;

  const q = values.q === undefined ? '' : String(values.q).trim();
  if ([...q].length > MAX_QUERY_LENGTH) return invalid('invalid_request', 'La búsqueda no puede superar los 100 caracteres.');

  let cursor = null;
  if (values.cursor !== undefined) {
    cursor = decodeDatedCursor(values.cursor, listCursorLabel(account), cursorSecret);
    if (cursor === null) return INVALID_CURSOR;
  }
  return { ok: true, account, q: q === '' ? null : q, cursor };
}

function parseDeliveryRef(query) {
  const values = readParameters(query, DELIVERY_PARAMETERS);
  if (!values) return REPEATED_PARAMETER;
  const account = parsePositiveInteger(values.account);
  if (account === null) return INVALID_ACCOUNT;
  const id = parseUniqueId(values.id);
  if (id === null) return INVALID_UNIQUE_ID;
  return { ok: true, account, id };
}

function parseDeliveryMessages(query, { cursorSecret }) {
  const values = readParameters(query, MESSAGES_PARAMETERS);
  if (!values) return REPEATED_PARAMETER;
  const account = parsePositiveInteger(values.account);
  if (account === null) return INVALID_ACCOUNT;
  const id = parseUniqueId(values.id);
  if (id === null) return INVALID_UNIQUE_ID;
  const dst = parseDst(values.dst);
  if (dst === undefined) return INVALID_NUMBER;

  let cursor = null;
  if (values.cursor !== undefined) {
    cursor = decodeCursor(values.cursor, messagesCursorLabel(account, id), cursorSecret);
    if (cursor === null) return INVALID_CURSOR;
  }
  return { ok: true, account, id, dst, cursor };
}

async function listDeliveries(db, { account, q, cursor }, { cursorSecret }) {
  if (q !== null && OUTSIDE_COLUMN_CHARSET.test(q)) return { items: [], nextCursor: null };

  let sql = SELECT_LIST;
  const params = [account];
  if (cursor !== null) {
    // Según el sql_mode, comparar contra la fecha en cero da el error 1525 desde 8.0. Bajo ella solo quedan otras filas en cero.
    if (cursor.createdAt === ZERO_DATE) {
      sql += ' AND created_at < ? AND id < ?';
      params.push(FIRST_VALID_DATE, cursor.id);
    } else {
      sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
  }
  if (q !== null) {
    sql += " AND name LIKE ? ESCAPE '!'";
    params.push(`%${q.replace(LIKE_SPECIALS, '!$&')}%`);
  }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ${PAGE_SIZE + 1}`;

  const rows = await db.query(sql, params);
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id_unique,
      name: row.name ?? null,
      type: row.delivery_type ?? null,
      createdAt: formatCreatedAt(row.created_at),
      deliverAt: formatCreatedAt(row.deliver_at),
    })),
    nextCursor: rows.length > PAGE_SIZE
      ? encodeDatedCursor({ id: toSafeId(last.id), createdAt: last.created_at }, listCursorLabel(account), cursorSecret)
      : null,
  };
}

// Las fechas de la plataforma ya están en hora de Chile. Un deliver_at nulo cuenta como reciente, igual que allá.
function deliveryVariant(row, nowMs) {
  const deliverAt = wallClockMs(row.deliver_at);
  const recent = deliverAt === null || chileWallClockMs(nowMs) - deliverAt < DAY_MS;
  if (!recent) return VARIANT_COMPLETE;
  const inProgress = (row.status === 'new' || row.status === 'processing') && Number(row.has_base) === 1;
  if (inProgress) return VARIANT_GENERATING;
  return row.status === 'failed' ? VARIANT_FAILED : VARIANT_COMPLETE;
}

// Un conteo que no alcanza a terminar no invalida el resto de la pantalla: se muestra "—".
async function countOrNull(db, sql, deliveryId) {
  try {
    const [row] = await db.query(sql, [deliveryId]);
    return toSafeId(row.n);
  } catch (error) {
    if (isQueryCut(error)) return null;
    throw error;
  }
}

const contactsOf = (row) => row.number_of_contacts ?? null;

async function readLink(db, deliveryId, account) {
  const [row] = await db.query(SELECT_LINK, [deliveryId, account]);
  return row ?? null;
}

async function readDelivery(db, { account, id }, { loginId, nowMs }) {
  const [row] = await db.query(SELECT_DATOS, [id, account]);
  if (!row) return null;

  const deliveryId = toSafeId(row.id);
  const variant = deliveryVariant(row, nowMs);
  const detail = {
    id: row.id_unique,
    name: row.name ?? null,
    type: row.delivery_type ?? null,
    createdAt: formatCreatedAt(row.created_at),
    deliverAt: formatCreatedAt(row.deliver_at),
    hasBase: Number(row.has_base) === 1,
    base: row.contact_list_name ?? null,
    contacts: contactsOf(row),
    variant,
    report: await lastDeliveryJob(db, { loginId, deliveryId, kind: 'delivery_xlsx', nowMs }),
    incoming: await lastDeliveryJob(db, { loginId, deliveryId, kind: 'incoming_xlsx', nowMs }),
  };
  if (variant === VARIANT_FAILED) detail.errorMessage = row.error_status || NO_ERROR_REASON;
  if (variant === VARIANT_COMPLETE) {
    detail.responses = await countOrNull(db, COUNT_RESPONSES, deliveryId);
    const link = await readLink(db, deliveryId, account);
    detail.link = link && { address: `${SHORT_LINK_BASE}${link.id_unique}`, clicks: toSafeId(link.clicks ?? 0) };
  }
  return detail;
}

async function readProgress(db, { account, id }, { nowMs }) {
  const [row] = await db.query(SELECT_DATOS, [id, account]);
  if (!row) return null;
  const variant = deliveryVariant(row, nowMs);
  return {
    variant,
    sent: variant === VARIANT_GENERATING ? await countOrNull(db, COUNT_SENT, toSafeId(row.id)) : null,
    contacts: contactsOf(row),
  };
}

// Lo mínimo para acotar lo que venga después a un envío de la cuenta y del producto.
async function findDelivery(db, account, id) {
  const [row] = await db.query(SELECT_TARGET, [id, account]);
  return row ? { id: toSafeId(row.id), account, deliverAt: row.deliver_at } : null;
}

async function readMessages(db, { account, id, dst, cursor }, { cursorSecret }) {
  const delivery = await findDelivery(db, account, id);
  if (!delivery) return null;

  let sql = dst === null ? SELECT_MESSAGES : SELECT_MESSAGES_OF_NUMBER;
  const params = dst === null ? [delivery.id, account] : [delivery.id, account, Number(dst)];
  if (cursor !== null) {
    sql += ' AND id > ?';
    params.push(cursor);
  }
  sql += ` ORDER BY id LIMIT ${PAGE_SIZE + 1}`;

  const rows = await db.query(sql, params);
  const page = rows.slice(0, PAGE_SIZE);
  return {
    items: page.map((row) => ({
      status: statusLabel(row.status),
      id: row.id_unique,
      dst: String(row.dst_number),
      provider: row.dst_provider ?? 'Otros',
      country: row.dst_country ?? null,
      updatedAt: formatCreatedAt(row.updated_at),
    })),
    nextCursor: rows.length > PAGE_SIZE
      ? encodeCursor(toSafeId(page[page.length - 1].id), messagesCursorLabel(account, id), cursorSecret)
      : null,
  };
}

module.exports = {
  deliveryVariant,
  findDelivery,
  listDeliveries,
  parseDeliveryList,
  parseDeliveryMessages,
  parseDeliveryRef,
  readDelivery,
  readLink,
  readMessages,
  readProgress,
};
