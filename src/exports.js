'use strict';

const crypto = require('node:crypto');

const { listLoginAccounts, parseLoginBody } = require('./auth');
const { decodeCursor, encodeCursor } = require('./cursor');
const {
  INVALID_CURSOR,
  REPEATED_PARAMETER,
  SMS_PRODUCT_ID,
  invalid,
  parsePositiveInteger,
  parseSearch,
  parseUniqueId,
  readParameters,
  toSafeId,
} = require('./sms');
const { chileWallClockMs, formatUtcAsChile, utcText, wallClockMs } = require('./time');

const STATE_LABELS = new Map([
  ['new', 'generating'],
  ['processing', 'generating'],
  ['finished', 'ready'],
  ['failed', 'failed'],
]);
// El trabajador se rinde a las 12 h. El margen cubre lo que tarda en darse cuenta, y un trabajador detenido no alcanza a marcarlo.
const JOB_MAX_AGE_MS = (12 * 60 + 15) * 60000;
const DAY_MS = 86400000;
const PAGE_SIZE = 10;
const MAX_JOBS_PER_DAY = 10;
// Uno en curso y dos en cola: el trabajador toma de a uno, así que basta con contar los que no han terminado.
const MAX_UNFINISHED_JOBS = 3;
const LOCK_WAIT_SECONDS = 2;
const PUBLIC_ID_BYTES = 16;
const NUMBER_LABEL_ALL = 'Todos los números';

const KIND_SMS = 'sms_csv';
const KIND_DELIVERY = 'delivery_xlsx';
const KIND_INCOMING = 'incoming_xlsx';
const KINDS = new Set([KIND_SMS, KIND_DELIVERY, KIND_INCOMING]);
const FILE_PREFIXES = { [KIND_DELIVERY]: 'Reporte_de_envío', [KIND_INCOMING]: 'Respuestas_de_envío' };

const GENERIC_ERROR_MESSAGE = 'No se pudo generar el archivo. Inténtalo de nuevo.';
const ERROR_MESSAGES = new Map([
  ['too_many_rows', 'El archivo supera el máximo de 1.000.000 de filas. Acota las fechas o indica un número.'],
  ['too_large', 'El archivo resultó demasiado grande. Acota las fechas o indica un número.'],
  ['too_old', 'La generación tardó demasiado. Inténtalo de nuevo.'],
  ['too_long', 'La generación tardó demasiado. Inténtalo de nuevo.'],
  ['stalled', 'La generación se interrumpió varias veces. Inténtalo de nuevo más tarde.'],
]);
const LIMIT_MESSAGES = {
  perDay: 'Alcanzaste el máximo de 10 exportaciones en 24 horas. Inténtalo más tarde.',
  unfinished: 'Ya tienes exportaciones en curso. Espera a que terminen para pedir otra.',
};

const PUBLIC_ID_PATTERN = /^[0-9a-f]{32}$/;
const SEARCH_BODY_FIELDS = ['kind', 'account', 'start', 'end', 'dst'];
const DELIVERY_BODY_FIELDS = ['kind', 'account', 'delivery'];
const LIST_PARAMETERS = ['kind', 'cursor'];
const JOB_PARAMETERS = ['id'];

const JOB_COLUMNS = 'id, public_id, id_login, id_account, kind, id_delivery, delivery_name, start_date, end_date, dst_number, state, '
  + 'lo, hi, last_id, rows_written, plain_bytes, file_bytes, crc32, storage_key, upload_id, next_part, batch_size, work_ms, stalls, '
  + 'error_code, created_at, finished_at';
const SELECT_LAST_DELIVERY_JOB = `SELECT /*+ MAX_EXECUTION_TIME(2000) */ ${JOB_COLUMNS} `
  + 'FROM connectus_pages.export_job WHERE id_login = ? AND id_delivery = ? AND kind = ? ORDER BY id DESC LIMIT 1';
const SELECT_JOB = `SELECT /*+ MAX_EXECUTION_TIME(2000) */ ${JOB_COLUMNS} `
  + 'FROM connectus_pages.export_job WHERE public_id = ? AND id_login = ?';
const SELECT_JOB_LIST = `SELECT /*+ MAX_EXECUTION_TIME(2000) */ ${JOB_COLUMNS} `
  + 'FROM connectus_pages.export_job WHERE id_login = ? AND id_account IN (?)';
// Hay un tope de jobs al día, así que son pocas filas: el LIMIT solo acota si ese tope llegara a fallar.
const SELECT_RECENT_JOBS = `SELECT /*+ MAX_EXECUTION_TIME(2000) */ ${JOB_COLUMNS} `
  + 'FROM connectus_pages.export_job WHERE id_login = ? AND created_at > ? ORDER BY id DESC LIMIT 100';
const SELECT_DELIVERY = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, name FROM connectus_pages.delivery '
  + `WHERE id_unique = ? AND id_account = ? AND id_product = ${SMS_PRODUCT_ID}`;
const INSERT_JOB = 'INSERT INTO connectus_pages.export_job '
  + '(public_id, id_login, id_account, kind, id_delivery, delivery_name, start_date, end_date, dst_number, created_at) '
  + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const GET_LOCK = `SELECT GET_LOCK(?, ${LOCK_WAIT_SECONDS}) AS acquired`;
const RELEASE_LOCK = 'SELECT RELEASE_LOCK(?) AS released';

const optionalNumber = (value) => (value === null ? null : toSafeId(value));

// Con bigNumberStrings, los BIGINT llegan como texto. Toda fila de export_job pasa por aquí antes de operar con ella.
function parseJob(row) {
  return {
    id: toSafeId(row.id),
    publicId: row.public_id,
    loginId: toSafeId(row.id_login),
    account: toSafeId(row.id_account),
    kind: row.kind,
    deliveryId: optionalNumber(row.id_delivery),
    deliveryName: row.delivery_name,
    start: row.start_date,
    end: row.end_date,
    dst: row.dst_number === null ? null : String(row.dst_number),
    state: row.state,
    lo: optionalNumber(row.lo),
    hi: optionalNumber(row.hi),
    lastId: toSafeId(row.last_id),
    rowsWritten: toSafeId(row.rows_written),
    plainBytes: toSafeId(row.plain_bytes),
    fileBytes: toSafeId(row.file_bytes),
    crc32: toSafeId(row.crc32),
    storageKey: row.storage_key,
    uploadId: row.upload_id,
    nextPart: toSafeId(row.next_part),
    batchSize: toSafeId(row.batch_size),
    workMs: toSafeId(row.work_ms),
    stalls: toSafeId(row.stalls),
    errorCode: row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function jobFilename(job) {
  if (job.kind === KIND_SMS) return `sms_${job.start}_${job.end}.csv`;
  const [year, month, day] = new Date(chileWallClockMs(wallClockMs(job.createdAt))).toISOString().slice(0, 10).split('-');
  return `${FILE_PREFIXES[job.kind]}_${day}-${month}-${year}_${job.publicId.slice(0, 8)}.xlsx`;
}

const isUnfinished = (job) => job.state === 'new' || job.state === 'processing';
const isAbandoned = (job, nowMs) => isUnfinished(job) && nowMs - wallClockMs(job.createdAt) > JOB_MAX_AGE_MS;

// Lo muestra así aunque el trabajador no haya alcanzado a escribirlo: pages_app no puede cambiar el estado de un job.
function jobSummary(job, nowMs) {
  const abandoned = isAbandoned(job, nowMs);
  const state = abandoned ? 'failed' : STATE_LABELS.get(job.state);
  return {
    id: job.publicId,
    state,
    filename: state === 'ready' ? jobFilename(job) : null,
    errorMessage: state === 'failed' ? ERROR_MESSAGES.get(abandoned ? 'too_old' : job.errorCode) ?? GENERIC_ERROR_MESSAGE : null,
    createdAt: formatUtcAsChile(job.createdAt),
  };
}

function jobFilter(job) {
  if (job.kind !== KIND_SMS) return job.deliveryName;
  return job.dst ?? NUMBER_LABEL_ALL;
}

function jobItem(job, accountNames, nowMs) {
  return {
    ...jobSummary(job, nowMs),
    kind: job.kind,
    account: String(job.account),
    accountName: accountNames.get(job.account) ?? null,
    filter: jobFilter(job),
    start: job.start,
    end: job.end,
  };
}

async function lastDeliveryJob(db, { loginId, deliveryId, kind, nowMs }) {
  const [row] = await db.query(SELECT_LAST_DELIVERY_JOB, [loginId, deliveryId, kind]);
  return row ? jobSummary(parseJob(row), nowMs) : null;
}

async function accountNamesOf(db, loginId) {
  const accounts = await listLoginAccounts(db, loginId);
  return new Map(accounts.map(({ id, name }) => [toSafeId(id), name]));
}

const INVALID_EXPORT = invalid('invalid_request', 'La solicitud no es válida.');

function hasOnlyStrings(body, fields) {
  return Object.entries(body).every(([name, value]) => fields.includes(name) && typeof value === 'string');
}

// Solo llegan los campos con nombre, así que un cursor en el cuerpo no alcanza a parseSearch.
function parseExportBody(rawBody) {
  const body = parseLoginBody(rawBody);
  if (!body || !KINDS.has(body.kind)) return INVALID_EXPORT;

  if (body.kind === KIND_SMS) {
    if (!hasOnlyStrings(body, SEARCH_BODY_FIELDS)) return INVALID_EXPORT;
    const search = parseSearch({ account: body.account, start: body.start, end: body.end, dst: body.dst });
    if (!search.ok) return search;
    return { ok: true, kind: body.kind, account: search.account, start: search.start, end: search.end, dst: search.dst };
  }

  if (!hasOnlyStrings(body, DELIVERY_BODY_FIELDS)) return INVALID_EXPORT;
  const account = parsePositiveInteger(body.account);
  const delivery = parseUniqueId(body.delivery);
  if (account === null || delivery === null) return INVALID_EXPORT;
  return { ok: true, kind: body.kind, account, delivery };
}

function matchesRequest(job, { account, kind, deliveryId, start, end, dst }) {
  return job.account === account && job.kind === kind && job.deliveryId === deliveryId
    && job.start === start && job.end === end && job.dst === dst;
}

function limitExceeded(recentJobs, nowMs) {
  if (recentJobs.filter((job) => isUnfinished(job) && !isAbandoned(job, nowMs)).length >= MAX_UNFINISHED_JOBS) {
    return LIMIT_MESSAGES.unfinished;
  }
  return recentJobs.length >= MAX_JOBS_PER_DAY ? LIMIT_MESSAGES.perDay : null;
}

// Si no se pudo soltar el candado, la conexión no vuelve al pool con él tomado.
async function withLoginLock(db, loginId, work) {
  const lock = `pages_export:${loginId}`;
  return db.withConnection(async (connection) => {
    const [{ acquired }] = await connection.query(GET_LOCK, [lock]);
    if (Number(acquired) !== 1) return { outcome: 'busy' };
    try {
      return await work(connection);
    } finally {
      await connection.query(RELEASE_LOCK, [lock]).catch(() => connection.destroy());
    }
  });
}

// Devuelve { outcome }, que es created, duplicate, busy, not_found o limit, con el job o el mensaje que corresponda.
async function createExport(db, params, { loginId, nowMs }) {
  let delivery = null;
  if (params.kind !== KIND_SMS) {
    [delivery] = await db.query(SELECT_DELIVERY, [params.delivery, params.account]);
    if (!delivery) return { outcome: 'not_found' };
  }
  const request = {
    account: params.account,
    kind: params.kind,
    deliveryId: delivery ? toSafeId(delivery.id) : null,
    start: params.start ?? null,
    end: params.end ?? null,
    dst: params.dst ?? null,
  };

  const result = await withLoginLock(db, loginId, async (connection) => {
    const rows = await connection.query(SELECT_RECENT_JOBS, [loginId, utcText(nowMs - DAY_MS)]);
    const recentJobs = rows.map(parseJob);
    const duplicate = recentJobs.find((job) => isUnfinished(job) && !isAbandoned(job, nowMs) && matchesRequest(job, request));
    if (duplicate) return { outcome: 'duplicate', job: duplicate };

    const message = limitExceeded(recentJobs, nowMs);
    if (message) return { outcome: 'limit', message };

    const publicId = crypto.randomBytes(PUBLIC_ID_BYTES).toString('hex');
    await connection.query(INSERT_JOB, [
      publicId,
      loginId,
      request.account,
      request.kind,
      request.deliveryId,
      delivery?.name ?? null,
      request.start,
      request.end,
      request.dst === null ? null : Number(request.dst),
      utcText(nowMs),
    ]);
    const [row] = await connection.query(SELECT_JOB, [publicId, loginId]);
    return { outcome: 'created', job: parseJob(row) };
  });
  if (!result.job) return result;
  return { ...result, item: jobItem(result.job, await accountNamesOf(db, loginId), nowMs) };
}

function exportAuditDetail(job) {
  if (job.kind === KIND_SMS) return `${job.kind} ${job.start}..${job.end} ${job.dst === null ? 'sin_numero' : 'con_numero'} ${job.publicId}`;
  return `${job.kind} ${job.publicId}`;
}

const listCursorLabel = (loginId) => `exports:${loginId}`;

function parseExportList(query, { cursorSecret, loginId }) {
  const values = readParameters(query, LIST_PARAMETERS);
  if (!values) return REPEATED_PARAMETER;
  if (values.kind !== undefined && !KINDS.has(values.kind)) return INVALID_EXPORT;
  let cursor = null;
  if (values.cursor !== undefined) {
    cursor = decodeCursor(values.cursor, listCursorLabel(loginId), cursorSecret);
    if (cursor === null) return INVALID_CURSOR;
  }
  return { ok: true, kind: values.kind ?? null, cursor };
}

// El orden es por id, así que el cursor pagina sobre el índice del login. Una cuenta quitada al login deja de aparecer al tiro.
async function listExports(db, { kind, cursor }, { loginId, nowMs, cursorSecret }) {
  const accountNames = await accountNamesOf(db, loginId);
  if (accountNames.size === 0) return { items: [], nextCursor: null };

  let sql = SELECT_JOB_LIST;
  const params = [loginId, [...accountNames.keys()]];
  if (kind !== null) {
    sql += ' AND kind = ?';
    params.push(kind);
  }
  if (cursor !== null) {
    sql += ' AND id < ?';
    params.push(cursor);
  }
  sql += ` ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`;

  const rows = await db.query(sql, params);
  const jobs = rows.slice(0, PAGE_SIZE).map(parseJob);
  return {
    items: jobs.map((job) => jobItem(job, accountNames, nowMs)),
    nextCursor: rows.length > PAGE_SIZE ? encodeCursor(jobs[jobs.length - 1].id, listCursorLabel(loginId), cursorSecret) : null,
  };
}

function parseJobRef(query) {
  const values = readParameters(query, JOB_PARAMETERS);
  if (!values) return REPEATED_PARAMETER;
  if (typeof values.id !== 'string' || !PUBLIC_ID_PATTERN.test(values.id)) return invalid('invalid_request', 'El identificador no es válido.');
  return { ok: true, id: values.id };
}

async function findJob(db, publicId, loginId) {
  const [row] = await db.query(SELECT_JOB, [publicId, loginId]);
  return row ? parseJob(row) : null;
}

async function readExportStatus(db, publicId, { loginId, nowMs }) {
  const job = await findJob(db, publicId, loginId);
  if (!job) return null;
  const accountNames = await accountNamesOf(db, loginId);
  return accountNames.has(job.account) ? jobItem(job, accountNames, nowMs) : null;
}

module.exports = {
  JOB_COLUMNS,
  KIND_DELIVERY,
  KIND_INCOMING,
  KIND_SMS,
  createExport,
  exportAuditDetail,
  findJob,
  jobFilename,
  lastDeliveryJob,
  listExports,
  parseExportBody,
  parseExportList,
  parseJob,
  parseJobRef,
  readExportStatus,
};
