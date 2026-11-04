'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { createApp } = require('../../../src/app');
const { createDb } = require('../../../src/db');
const { createDiskStorage } = require('../../../src/storage');
const { runWorker } = require('../../../src/worker/run');
const { startEnvironment } = require('./envios_env');
const { loadTestEnv } = require('./test_env');

const REMAINING = () => 800000;
// Un número de ejemplo que no se le asigna a nadie: la prueba mira que no aparezca en la consola.
const JOB_NUMBER = '56911100099';

// S3 falso en proceso, sobre un directorio temporal propio: completar exige lo mismo que S3. before y after inyectan fallas por operación.
function createFakeS3() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-s3-'));
  const disk = createDiskStorage(dir, 'http://descarga.invalid/');
  const hooks = { before: new Map(), after: new Map() };
  const calls = [];
  const wrapped = { objectPath: disk.objectPath };
  for (const operation of ['createUpload', 'uploadPart', 'listParts', 'completeUpload', 'abortUpload', 'headObject']) {
    wrapped[operation] = async (input) => {
      calls.push({ operation, input });
      await hooks.before.get(operation)?.(input);
      const result = await disk[operation](input);
      await hooks.after.get(operation)?.(input, result);
      return result;
    };
  }
  wrapped.downloadUrl = disk.downloadUrl;
  return {
    storage: wrapped,
    disk,
    calls,
    before: (operation, hook) => hooks.before.set(operation, hook),
    after: (operation, hook) => hooks.after.set(operation, hook),
    clearHooks() {
      hooks.before.clear();
      hooks.after.clear();
    },
    count: (operation) => calls.filter((call) => call.operation === operation).length,
    read: (publicId) => fs.readFileSync(disk.objectPath(`exports/${publicId}`)),
    pathOf: (publicId) => disk.objectPath(`exports/${publicId}`),
    reset() {
      calls.length = 0;
      hooks.before.clear();
      hooks.after.clear();
      fs.rmSync(path.join(dir, 'uploads'), { recursive: true, force: true });
      fs.rmSync(path.join(dir, 'exports'), { recursive: true, force: true });
    },
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Una muerte de verdad no alcanza a limpiar nada: desde que se la provoca, toda sentencia y toda llamada a S3 fallan.
function createMortal() {
  const death = { dead: false };
  const fail = () => Promise.reject(Object.assign(new Error('muerte'), { code: 'muerte' }));
  return {
    kill() {
      death.dead = true;
    },
    db(db, onStatement = () => {}) {
      const call = (method) => async (sql, params) => {
        if (death.dead) return fail();
        await onStatement(sql, params);
        if (death.dead) return fail();
        return db[method](sql, params);
      };
      return { query: call('query'), write: call('write'), destroy: () => db.destroy() };
    },
    storage(storage) {
      const mortal = { ...storage };
      for (const name of ['createUpload', 'uploadPart', 'listParts', 'completeUpload', 'abortUpload', 'headObject']) {
        mortal[name] = async (input) => (death.dead ? fail() : storage[name](input));
      }
      return mortal;
    },
  };
}

// Lee el contenido sin depender de nada externo: el directorio central, el CRC y los tamaños tienen que calzar.
function readXlsxSheet(file) {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = file.readUInt16LE(end + 10);
  let offset = file.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const nameLength = file.readUInt16LE(offset + 28);
    const name = file.toString('latin1', offset + 46, offset + 46 + nameLength);
    if (name === 'xl/worksheets/sheet1.xml') {
      const crc = file.readUInt32LE(offset + 16);
      const compressedSize = file.readUInt32LE(offset + 20);
      const plainSize = file.readUInt32LE(offset + 24);
      const localOffset = file.readUInt32LE(offset + 42);
      const dataStart = localOffset + 30 + file.readUInt16LE(localOffset + 26) + file.readUInt16LE(localOffset + 28);
      const plain = zlib.inflateRawSync(file.subarray(dataStart, dataStart + compressedSize));
      if (plain.length !== plainSize) throw new Error('tamaño distinto');
      if (zlib.crc32(plain) !== crc) throw new Error('CRC distinto');
      return plain.toString('utf8');
    }
    offset += 46 + nameLength + file.readUInt16LE(offset + 30) + file.readUInt16LE(offset + 32);
  }
  throw new Error('sin hoja');
}

function xlsxRows(file) {
  const xml = readXlsxSheet(file);
  return [...xml.matchAll(/<row>(.*?)<\/row>/gs)].map(([, row]) => [...row.matchAll(/<t xml:space="preserve">(.*?)<\/t>/gs)].map(([, text]) => text));
}

// Filas de un CSV de los nuestros: entiende comillas y saltos de línea dentro de un campo.
function csvRows(file) {
  const text = file.toString('utf8');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ';') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  return rows;
}

function workerDbConfig(env, port = env.port) {
  return {
    stage: 'local',
    db: { host: env.host, port: Number(port), user: env.workerUser, password: env.workerPassword, sslCaFile: env.caFile },
  };
}

async function startExportEnvironment(username, accounts) {
  const base = await startEnvironment(username, accounts);
  const env = loadTestEnv();
  const s3 = createFakeS3();
  const workerDb = createDb(workerDbConfig(env));

  function appAt(isoTime, { db = base.db, storage = s3.storage } = {}) {
    return createApp({ db, config: base.config, storage, clock: () => Date.parse(isoTime), loginFailureFloorMs: 0 });
  }

  async function insertJob(fields) {
    const row = {
      public_id: crypto.randomBytes(16).toString('hex'),
      id_login: base.loginId,
      id_account: 101,
      kind: 'sms_csv',
      state: 'new',
      created_at: '2026-09-25 11:00:00',
      ...fields,
    };
    await base.admin.query('INSERT INTO connectus_pages.export_job SET ?', [row]);
    return row.public_id;
  }

  async function jobOf(publicId) {
    const [[row]] = await base.admin.query('SELECT * FROM connectus_pages.export_job WHERE public_id = ?', [publicId]);
    return row;
  }

  function work(options = {}) {
    return runWorker({
      db: workerDb,
      storage: s3.storage,
      quietWindows: [],
      remainingMs: REMAINING,
      clock: () => Date.parse('2026-09-25T12:00:00Z'),
      sleep: async () => {},
      ...options,
    });
  }

  async function stop() {
    await workerDb.end();
    s3.remove();
    await base.stop();
  }

  return { ...base, env, s3, workerDb, appAt, insertJob, jobOf, work, stop };
}

module.exports = { JOB_NUMBER, createMortal, csvRows, startExportEnvironment, workerDbConfig, xlsxRows };
