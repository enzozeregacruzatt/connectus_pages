'use strict';

const zlib = require('node:zlib');
const { setTimeout: delay } = require('node:timers/promises');

const { errorCode, isQueryCut, isSchemaError, writeAudit } = require('../db');
const { JOB_COLUMNS, parseJob } = require('../exports');
const { MIN_PART_BYTES } = require('../storage');
const { utcText, wallClockMs } = require('../time');
const { isQuiet } = require('./quiet');
const { openSource } = require('./sources');
const { fillerOf } = require('./xlsx');

const GUARD_MS = 60000;
const STATEMENT_TIMEOUT_MS = 30000;
const CLEANUP_EVERY_MS = 3600000;
const JOB_RETENTION_MS = 7 * 86400000;
const STATS_RETENTION_MS = 30 * 86400000;
const MAX_STALLS = 5;
const MAX_JOB_AGE_MS = 12 * 3600000;
const MAX_WORK_MS = 2 * 3600000;
const MAX_ROWS = 1000000;
const MAX_BATCH_SIZE = 2000;
const MIN_BATCH_SIZE = 500;
const MIN_PAUSE_MS = 250;
const SLOW_BATCH_MS = 5000;
const SLOW_BATCH_PAUSE_MS = 60000;
const PAUSE_FACTOR = 3;
// Pasado esto sin cerrar ninguna parte, lo leído corre riesgo de perderse: conviene llegar a los 5 MiB antes que descansar.
const UNCLOSED_PART_LIMIT_MS = 6 * 60000;
const STATEMENT_DEADLINE = 'statement_deadline';
const TRANSIENT_NAMES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'PROTOCOL_CONNECTION_LOST',
  'SlowDown', 'TimeoutError', 'RequestTimeout', 'ServiceUnavailable', 'InternalError',
]);
const TRANSIENT_ERRNOS = new Set([1040, 1053, 1205, 1213, 4031]);

const SELECT_NEXT_JOB = `SELECT /*+ MAX_EXECUTION_TIME(2000) */ ${JOB_COLUMNS} FROM connectus_pages.export_job `
  + "WHERE state IN ('new', 'processing') ORDER BY id LIMIT 1";
const CLAIM_JOB = "UPDATE connectus_pages.export_job SET state = 'processing', stalls = stalls + 1 WHERE id = ? AND state IN ('new', 'processing')";
const SAVE_UPLOAD = 'UPDATE connectus_pages.export_job SET lo = ?, hi = ?, storage_key = ?, upload_id = ? WHERE id = ?';
const SAVE_BATCH_SIZE = 'UPDATE connectus_pages.export_job SET batch_size = ? WHERE id = ?';
const CLOSE_PART = 'UPDATE connectus_pages.export_job SET last_id = ?, rows_written = ?, next_part = ?, plain_bytes = ?, file_bytes = ?, '
  + 'crc32 = ?, batch_size = ?, work_ms = ?, stalls = 0 WHERE id = ?';
const SAVE_EXIT = 'UPDATE connectus_pages.export_job SET work_ms = ?, stalls = GREATEST(stalls + ?, 0) WHERE id = ?';
const FINISH_JOB = "UPDATE connectus_pages.export_job SET state = 'finished', finished_at = ? WHERE id = ?";
const FAIL_JOB = "UPDATE connectus_pages.export_job SET state = 'failed', error_code = ?, finished_at = ? WHERE id = ?";
const DELETE_OLD_JOBS = 'DELETE FROM connectus_pages.export_job WHERE created_at < ? LIMIT 200';
const DELETE_OLD_STATS = 'DELETE FROM connectus_pages.delivery_stats WHERE updated_at < ? LIMIT 200';
const PURGE_AUDIT = 'CALL connectus_pages.purge_audit_log()';

class JobFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class BatchCutAtMinimum extends Error {}

// Si la base deja de contestar, ninguna sentencia vuelve: al vencer se destruye el pool, para que la corrida termine.
function withStatementDeadline(db, timeoutMs) {
  const guard = async (work) => {
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        db.destroy();
        reject(Object.assign(new Error(STATEMENT_DEADLINE), { code: STATEMENT_DEADLINE }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    query: (sql, params) => guard(db.query(sql, params)),
    write: (sql, params) => guard(db.write(sql, params)),
  };
}

function logEvent(event, code) {
  console.error(JSON.stringify({ event, code }));
}

async function cleanUp({ db, clock, schedule }) {
  const nowMs = clock();
  if (nowMs - schedule.lastCleanupMs < CLEANUP_EVERY_MS) return;
  schedule.lastCleanupMs = nowMs;
  try {
    await db.write(DELETE_OLD_JOBS, [utcText(nowMs - JOB_RETENTION_MS)]);
    await db.write(DELETE_OLD_STATS, [utcText(nowMs - STATS_RETENTION_MS)]);
    await db.write(PURGE_AUDIT);
  } catch (error) {
    if (error.code === STATEMENT_DEADLINE) throw error;
    logEvent(isSchemaError(error) ? 'schema_error' : 'cleanup_failed', errorCode(error));
  }
}

function assertStillAllowed(job, previousStalls, nowMs) {
  if (previousStalls >= MAX_STALLS) throw new JobFailure('stalled');
  if (nowMs - wallClockMs(job.createdAt) > MAX_JOB_AGE_MS) throw new JobFailure('too_old');
  if (job.workMs > MAX_WORK_MS) throw new JobFailure('too_long');
}

async function failJob({ db, storage, clock }, job, code) {
  if (job.uploadId !== null) {
    // Lo que no se alcance a abortar lo limpia el ciclo de vida del bucket: no es motivo para dejar el job sin marcar.
    await storage.abortUpload({ key: job.storageKey, uploadId: job.uploadId }).catch((error) => logEvent('abort_failed', errorCode(error)));
  }
  await db.write(FAIL_JOB, [code, utcText(clock()), job.id]);
  logEvent('export_failed', code);
}

async function startUpload({ db, storage, clock }, job, source, format) {
  const { lo, hi } = await source.fixRange(clock());
  const storageKey = `exports/${job.publicId}`;
  const uploadId = await storage.createUpload({ key: storageKey, contentType: format.contentType });
  await db.write(SAVE_UPLOAD, [lo, hi, storageKey, uploadId, job.id]);
  Object.assign(job, { lo, hi, storageKey, uploadId });
}

function pauseAfter(batchMs, { now, jobStartedAt }, partsClosed) {
  if (partsClosed === 0 && now() - jobStartedAt > UNCLOSED_PART_LIMIT_MS) return batchMs;
  if (batchMs > SLOW_BATCH_MS) return SLOW_BATCH_PAUSE_MS;
  return Math.max(MIN_PAUSE_MS, PAUSE_FACTOR * batchMs);
}

// Escribe desde el último cierre hasta el final, o hasta tener que salir. last_id solo avanza al cerrar una parte: si la Lambda muere,
// lo que no se cerró se vuelve a leer, y la parte se sobrescribe con el mismo número. Devuelve 'done' o 'paused'.
async function writeParts(context, job, source, format, attempt) {
  const { db, storage, now, sleep, remainingMs, quietWindows, clock } = context;
  const file = { crc: job.crc32, plainBytes: job.plainBytes, fileBytes: job.fileBytes, rows: job.rowsWritten, chunks: [], bytes: 0, chunkRows: 0 };
  let position = Math.max(job.lastId, job.lo);
  let partsClosed = 0;

  function appendRaw(bytes) {
    file.chunks.push(bytes);
    file.bytes += bytes.length;
    file.fileBytes += bytes.length;
  }

  function appendPlain(text) {
    const plain = Buffer.from(text, 'utf8');
    file.crc = zlib.crc32(plain, file.crc);
    file.plainBytes += plain.length;
    appendRaw(format.pack(plain));
  }

  async function closePart(lastId) {
    await storage.uploadPart({
      key: job.storageKey,
      uploadId: job.uploadId,
      partNumber: job.nextPart,
      body: Buffer.concat(file.chunks),
    });
    attempt.settleWork();
    const batchSize = Math.min(MAX_BATCH_SIZE, attempt.batchSize * 2);
    await db.write(CLOSE_PART, [
      lastId,
      file.rows,
      job.nextPart + 1,
      file.plainBytes,
      file.fileBytes,
      file.crc,
      batchSize,
      Math.round(attempt.workMs),
      job.id,
    ]);
    Object.assign(job, {
      lastId,
      rowsWritten: file.rows,
      nextPart: job.nextPart + 1,
      plainBytes: file.plainBytes,
      fileBytes: file.fileBytes,
      crc32: file.crc,
    });
    attempt.batchSize = batchSize;
    attempt.counted = false;
    partsClosed += 1;
    file.chunks = [];
    file.bytes = 0;
    file.chunkRows = 0;
  }

  // El XLSX puede cerrar lo que lleva rellenando hasta el mínimo. El CSV no tiene cómo, y lo no cerrado se vuelve a leer.
  async function leave() {
    if (format.canPad && file.chunkRows > 0) {
      if (file.bytes < MIN_PART_BYTES) appendRaw(fillerOf(MIN_PART_BYTES - file.bytes));
      await closePart(position);
    }
    return 'paused';
  }

  if (job.fileBytes === 0) {
    appendRaw(format.prefix());
    appendPlain(format.head());
  }

  for (;;) {
    if (isQuiet(quietWindows, clock()) || remainingMs() < GUARD_MS) return leave();

    attempt.startWork();
    const batchStartedAt = now();
    let batch;
    try {
      batch = await source.next(position, attempt.batchSize);
    } catch (error) {
      if (!isQueryCut(error)) throw error;
      attempt.settleWork();
      if (attempt.batchSize <= MIN_BATCH_SIZE) throw new BatchCutAtMinimum();
      attempt.batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(attempt.batchSize / 2));
      await db.write(SAVE_BATCH_SIZE, [attempt.batchSize, job.id]);
      continue;
    }

    file.rows += batch.rows.length;
    file.chunkRows += batch.rows.length;
    if (file.rows > MAX_ROWS) throw new JobFailure('too_many_rows');
    if (batch.rows.length > 0) appendPlain(format.encodeRows(batch.rows));
    position = batch.position;
    if (format.isTooLarge(file)) throw new JobFailure('too_large');
    const batchMs = now() - batchStartedAt;

    if (batch.done) {
      appendPlain(format.tail());
      appendRaw(format.suffix(file));
      // Solo una carga sin nada más que agregar puede quedar sin esta última parte.
      if (file.bytes > 0) await closePart(job.hi);
      return 'done';
    }
    if (file.bytes >= MIN_PART_BYTES) await closePart(position);
    attempt.settleWork();

    const pause = pauseAfter(batchMs, context, partsClosed);
    await sleep(Math.min(pause, Math.max(0, remainingMs() - GUARD_MS)));
  }
}

async function markFinished({ db, clock }, job) {
  await db.write(FINISH_JOB, [utcText(clock()), job.id]);
  await writeAudit(db, {
    idLogin: job.loginId,
    action: 'export_finished',
    idAccount: job.account,
    detail: `${job.publicId} ${job.rowsWritten}`,
  });
}

// Solo las partes 1..N, las que respaldan file_bytes. Una N+1 es de un intento que murió antes de guardar su cierre, y S3 la descarta.
async function completeJob(context, job) {
  const { storage } = context;
  const count = job.nextPart - 1;
  const parts = (await storage.listParts({ key: job.storageKey, uploadId: job.uploadId })).filter((part) => part.partNumber <= count);
  const total = parts.reduce((sum, part) => sum + part.size, 0);
  const contiguous = parts.length === count && parts.every((part, index) => part.partNumber === index + 1);
  if (!contiguous || total !== job.fileBytes) throw new JobFailure('inconsistent');
  await storage.completeUpload({ key: job.storageKey, uploadId: job.uploadId, parts, objectSize: job.fileBytes });
  await markFinished(context, job);
}

// La carga ya no existe: o se completó y murió antes de marcarlo, o se perdió.
async function recoverMissingUpload(context, job) {
  const object = await context.storage.headObject(job.storageKey);
  if (object?.size !== job.fileBytes) throw new JobFailure('inconsistent');
  await markFinished(context, job);
}

function createAttempt(job, now) {
  let workStartedAt = null;
  return {
    batchSize: job.batchSize,
    workMs: job.workMs,
    // Si el reclamo de este intento sigue sumado en stalls. Una muerte no alcanza a restarlo.
    counted: true,
    startWork() {
      workStartedAt = now();
    },
    // Solo lectura y escritura, sin las pausas.
    settleWork() {
      if (workStartedAt === null) return;
      this.workMs += now() - workStartedAt;
      workStartedAt = null;
    },
  };
}

function isKnownTransient(error) {
  return TRANSIENT_NAMES.has(error.code) || TRANSIENT_NAMES.has(error.name) || TRANSIENT_ERRNOS.has(error.errno)
    || error.$metadata?.httpStatusCode >= 500;
}

// Devuelve { stop, failure }: stop termina la corrida, y failure es el código a registrar.
async function processJob(baseContext, row) {
  const context = { ...baseContext, jobStartedAt: baseContext.now() };
  const { db, clock, now } = context;
  const job = parseJob(row);
  const claim = await db.write(CLAIM_JOB, [job.id]);
  if (claim.affectedRows === 0) return {};
  const attempt = createAttempt(job, now);

  // Salir por su cuenta no es una muerte: resta lo que sumó el reclamo, salvo que cerrar una parte ya lo haya dejado en 0.
  function saveExit(stallChange = attempt.counted ? -1 : 0) {
    attempt.settleWork();
    return db.write(SAVE_EXIT, [Math.round(attempt.workMs), stallChange, job.id]);
  }

  // Sí cuenta como una muerte: deja sumado lo del reclamo, o lo suma si cerrar una parte ya lo dejó en 0.
  const saveCountedExit = () => saveExit(attempt.counted ? 0 : 1);

  try {
    assertStillAllowed(job, job.stalls, clock());
    const source = openSource(job, db);
    const format = await source.loadFormat();
    if (job.uploadId === null) await startUpload(context, job, source, format);

    // Con todo escrito, el último cierre ya incluyó el final del archivo, y volver a escribirlo lo duplicaría.
    const allWritten = job.nextPart > 1 && job.lastId >= job.hi;
    if (!allWritten && await writeParts(context, job, source, format, attempt) === 'paused') {
      await saveExit();
      return { stop: true };
    }
    await completeJob(context, job);
    return {};
  } catch (error) {
    if (error instanceof JobFailure) {
      await failJob(context, job, error.code);
      return {};
    }
    if (isSchemaError(error)) {
      logEvent('schema_error', errorCode(error));
      await failJob(context, job, 'schema_error');
      return {};
    }
    if (error.name === 'AccessDenied') {
      await failJob(context, job, 'storage_denied');
      return {};
    }
    if (error.name === 'NoSuchUpload' && job.uploadId !== null) return recoverAfterMissing(context, job);
    if (error.code === STATEMENT_DEADLINE) return { stop: true, failure: STATEMENT_DEADLINE };
    // La base no da abasto ni con el lote mínimo. Sí cuenta, para no insistir para siempre.
    if (error instanceof BatchCutAtMinimum) {
      await saveCountedExit();
      return { stop: true };
    }
    // La próxima corrida sigue desde el último cierre, sin abortar la carga. Lo que no se conoce como pasajero sí cuenta:
    // si se repite, el job termina en stalled, en lugar de bloquear la cola hasta too_old.
    await (isKnownTransient(error) ? saveExit() : saveCountedExit()).catch(() => {});
    return { stop: true, failure: errorCode(error) };
  }
}

async function recoverAfterMissing(context, job) {
  try {
    await recoverMissingUpload(context, job);
  } catch (error) {
    if (!(error instanceof JobFailure)) throw error;
    await failJob(context, job, error.code);
  }
  return {};
}

async function runWorker({
  db,
  storage,
  quietWindows,
  remainingMs,
  schedule = { lastCleanupMs: -Infinity },
  clock = Date.now,
  now = () => performance.now(),
  sleep = delay,
  statementTimeoutMs = STATEMENT_TIMEOUT_MS,
}) {
  const guarded = withStatementDeadline(db, statementTimeoutMs);
  const context = { db: guarded, storage, quietWindows, remainingMs, schedule, clock, now, sleep };

  if (isQuiet(quietWindows, clock())) return {};
  await cleanUp(context);
  while (remainingMs() >= GUARD_MS && !isQuiet(quietWindows, clock())) {
    const [row] = await guarded.query(SELECT_NEXT_JOB);
    if (!row) return {};
    const { stop, failure } = await processJob(context, row);
    if (stop) return failure ? { failure } : {};
  }
  return {};
}

module.exports = { runWorker };
