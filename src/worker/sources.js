'use strict';

const { KIND_DELIVERY, KIND_INCOMING, KIND_SMS } = require('../exports');
const { formatCreatedAt, readIdCutoffs, toSafeId } = require('../sms');
const { createCsvFormat } = require('./csv');
const { createXlsxFormat } = require('./xlsx');

const SMS_COLUMNS = 'id, id_unique, id_delivery, src_number, dst_number, sms_content, status, dst_provider, created_at';
const SELECT_TOP_OF_ACCOUNT = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id FROM connectus_pages.sms_de_cuenta '
  + 'WHERE id_account = ? ORDER BY id DESC LIMIT 1';
const SELECT_ACCOUNT_NAME = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ name FROM connectus_pages.account WHERE id = ?';
const SELECT_DELIVERY_NAMES = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, name FROM connectus_pages.delivery '
  + 'WHERE id IN (?) AND id_account = ?';
// Dos pasos, para que cada sentencia lea como máximo un lote: primero el límite, solo con el índice, y después esas filas.
const selectBatchLimit = (batchSize) => 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ id FROM connectus_pages.sms_de_cuenta '
  + `WHERE id_account = ? AND id > ? AND id <= ? ORDER BY id LIMIT 1 OFFSET ${batchSize - 1}`;
const SELECT_ACCOUNT_BATCH = `SELECT /*+ MAX_EXECUTION_TIME(8000) */ ${SMS_COLUMNS} FROM connectus_pages.sms_de_cuenta `
  + 'WHERE id_account = ? AND id > ? AND id <= ? AND created_at BETWEEN ? AND ? ORDER BY id';
const selectNumberBatch = (batchSize) => `SELECT /*+ MAX_EXECUTION_TIME(8000) */ ${SMS_COLUMNS} FROM connectus_pages.sms_de_numero `
  + `WHERE id_account = ? AND id > ? AND id <= ? AND dst_number = ? AND created_at BETWEEN ? AND ? ORDER BY id LIMIT ${batchSize}`;
const SELECT_TOP_OF_DELIVERY = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id FROM connectus_pages.sms_de_envio '
  + 'WHERE id_delivery = ? AND id_account = ? ORDER BY id DESC LIMIT 1';
const selectDeliveryBatch = (batchSize) => 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_unique, src_number, dst_number, sms_content, '
  + 'multiplier, dst_country, dst_provider, created_at, updated_at, status FROM connectus_pages.sms_de_envio '
  + `WHERE id_delivery = ? AND id_account = ? AND id > ? AND id <= ? ORDER BY id LIMIT ${batchSize}`;
const SELECT_TOP_OF_INCOMING = 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ id FROM connectus_pages.sms_incoming_de_envio '
  + 'WHERE id_delivery = ? AND id_account = ? ORDER BY id DESC LIMIT 1';
const selectIncomingBatch = (batchSize) => 'SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_unique, src_number, dst_number, sms_content, '
  + 'created_at FROM connectus_pages.sms_incoming_de_envio '
  + `WHERE id_delivery = ? AND id_account = ? AND id > ? AND id <= ? ORDER BY id LIMIT ${batchSize}`;

const DELIVERY_COLUMNS = [
  'Identificador único',
  'Número de origen',
  'Número de destino',
  'Contenido mensaje',
  'Multiplicador',
  'País de destino',
  'Proveedor de destino',
  'Fecha y Hora',
  'Fecha y hora de entrega',
  'Estado',
  'Nombre de envío',
];
const INCOMING_COLUMNS = ['Identificador', 'Número de origen', 'Número destino', 'Contenido', 'Creación', 'Envío'];

async function topId(db, sql, params) {
  const [row] = await db.query(sql, params);
  return row ? toSafeId(row.id) : 0;
}

// El lote va en keyset y con LIMIT. Terminó si vino corto o si llegó al tope.
function keysetBatch(rows, batchSize, hi) {
  const last = rows.length > 0 ? toSafeId(rows[rows.length - 1].id) : null;
  const done = rows.length < batchSize || last >= hi;
  return { rows, position: done ? hi : last, done };
}

// Por job, nunca a nivel de módulo: un envío mezclado de otra cuenta no debe sacar el nombre de lo que quedó de un job anterior.
function smsSource(job, db) {
  const dates = [`${job.start} 00:00:00`, `${job.end} 23:59:59`];
  const names = new Map();

  async function withDeliveryNames(rows) {
    const missing = [...new Set(rows.filter((row) => row.id_delivery !== null).map((row) => toSafeId(row.id_delivery)))]
      .filter((id) => !names.has(id));
    if (missing.length > 0) {
      const found = await db.query(SELECT_DELIVERY_NAMES, [missing, job.account]);
      // Después de la consulta: si se corta, el reintento del lote tiene que volver a preguntar por estos envíos.
      for (const id of missing) names.set(id, null);
      for (const { id, name } of found) names.set(toSafeId(id), name);
    }
    return rows.map((row) => ({ ...row, deliveryName: row.id_delivery === null ? null : names.get(toSafeId(row.id_delivery)) }));
  }

  return {
    async fixRange(nowMs) {
      const { lo, hi } = await readIdCutoffs(db, job.start, job.end, nowMs);
      return { lo, hi: hi ?? await topId(db, SELECT_TOP_OF_ACCOUNT, [job.account]) };
    },
    async loadFormat() {
      const [account] = await db.query(SELECT_ACCOUNT_NAME, [job.account]);
      return createCsvFormat(account?.name ?? '');
    },
    async next(position, batchSize) {
      if (position >= job.hi) return { rows: [], position: job.hi, done: true };
      if (job.dst !== null) {
        const rows = await db.query(selectNumberBatch(batchSize), [job.account, position, job.hi, Number(job.dst), ...dates]);
        return { ...keysetBatch(rows, batchSize, job.hi), rows: await withDeliveryNames(rows) };
      }
      const [limit] = await db.query(selectBatchLimit(batchSize), [job.account, position, job.hi]);
      const upTo = limit ? toSafeId(limit.id) : job.hi;
      const rows = await db.query(SELECT_ACCOUNT_BATCH, [job.account, position, upTo, ...dates]);
      return { rows: await withDeliveryNames(rows), position: upTo, done: upTo >= job.hi };
    },
  };
}

function deliverySource(job, db, { topSql, selectBatch, format }) {
  return {
    async fixRange() {
      return { lo: 0, hi: await topId(db, topSql, [job.deliveryId, job.account]) };
    },
    loadFormat: async () => format,
    async next(position, batchSize) {
      if (position >= job.hi) return { rows: [], position: job.hi, done: true };
      const rows = await db.query(selectBatch(batchSize), [job.deliveryId, job.account, position, job.hi]);
      return keysetBatch(rows, batchSize, job.hi);
    },
  };
}

function openSource(job, db) {
  if (job.kind === KIND_SMS) return smsSource(job, db);
  if (job.kind === KIND_DELIVERY) {
    return deliverySource(job, db, {
      topSql: SELECT_TOP_OF_DELIVERY,
      selectBatch: selectDeliveryBatch,
      format: createXlsxFormat({
        sheetName: 'Detalle',
        columns: DELIVERY_COLUMNS,
        toValues: (row) => [
          row.id_unique,
          row.src_number,
          row.dst_number,
          row.sms_content,
          row.multiplier,
          row.dst_country,
          row.dst_provider,
          formatCreatedAt(row.created_at),
          formatCreatedAt(row.updated_at),
          row.status,
          job.deliveryName,
        ],
      }),
    });
  }
  if (job.kind === KIND_INCOMING) {
    return deliverySource(job, db, {
      topSql: SELECT_TOP_OF_INCOMING,
      selectBatch: selectIncomingBatch,
      format: createXlsxFormat({
        sheetName: 'Respuestas',
        columns: INCOMING_COLUMNS,
        toValues: (row) => [
          row.id_unique,
          row.src_number,
          row.dst_number,
          row.sms_content,
          formatCreatedAt(row.created_at),
          job.deliveryName,
        ],
      }),
    });
  }
  throw Object.assign(new Error('unexpected_kind'), { code: 'unexpected_kind' });
}

module.exports = { openSource };
