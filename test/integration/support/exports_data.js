'use strict';

const crypto = require('node:crypto');

// Filas grandes y que casi no se comprimen, para que un archivo pase de 5 MiB también en XLSX. Quedan fuera de los meses que usan las
// demás pruebas, con ids altos, y se borran al terminar.
const FIRST_ID = 500000;
const MARGIN_ID = FIRST_ID - 1;
const BIG_DELIVERY = 900;
const FOREIGN_DELIVERY = 901;
const ROW_COUNT = 7000;
const CONTENT_BYTES = 4000;
const INSERT_CHUNK = 400;
const RANGE = { start: '2026-09-05', end: '2026-09-19' };
const SEARCHED_NUMBER = 56911100099;
const CITED_NUMBER_EVERY = 500;

async function insertChunked(admin, sql, rows) {
  for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
    await admin.query(sql, [rows.slice(index, index + INSERT_CHUNK)]);
  }
}

function secondsOf(index) {
  const base = Date.parse('2026-09-06T00:00:00Z') + index * 60000;
  return new Date(base).toISOString().slice(0, 19).replace('T', ' ');
}

const randomContent = () => crypto.randomBytes((CONTENT_BYTES * 3) / 4).toString('base64');

async function insertExportData(admin) {
  await admin.query(`INSERT INTO dbconnectus.delivery (id, id_unique, id_account, delivery_type, name, deliver_at, created_at, id_product, status)
    VALUES (?, MD5(?), 101, 'CUSTOM', 'Envío de exportación', '2026-09-06 00:00:00', '2026-09-05 23:00:00', 1, 'completed'),
           (?, MD5(?), 102, 'CUSTOM', 'Envío de la otra cuenta', '2026-09-06 00:00:00', '2026-09-05 23:00:00', 1, 'completed')`,
  [BIG_DELIVERY, `envio-${BIG_DELIVERY}`, FOREIGN_DELIVERY, `envio-${FOREIGN_DELIVERY}`]);

  // Antes del rango, para que el corte por fecha parta justo aquí, y los lotes no se gasten en las filas del resto del fixture.
  const rows = [[
    MARGIN_ID,
    crypto.createHash('md5').update(`exportacion-${MARGIN_ID}`).digest('hex'),
    101,
    null,
    'DELIVRD',
    1000,
    56900001000,
    'Antes del rango',
    1,
    '2026-09-01 00:00:00',
    '2026-09-01 00:00:00',
    'Entel',
    'Chile',
  ]];
  const incoming = [];
  for (let index = 0; index < ROW_COUNT; index += 1) {
    const id = FIRST_ID + index;
    // Una de cada cinco es de otra cuenta, y queda entremedio del rango de ids.
    const foreign = index % 5 === 4;
    const dst = !foreign && index % CITED_NUMBER_EVERY === 0 ? SEARCHED_NUMBER : 56900001000 + (index % 100);
    rows.push([
      id,
      crypto.createHash('md5').update(`exportacion-${id}`).digest('hex'),
      foreign ? 102 : 101,
      foreign ? FOREIGN_DELIVERY : BIG_DELIVERY,
      'DELIVRD',
      1000,
      dst,
      randomContent(),
      1,
      secondsOf(index),
      secondsOf(index + 1),
      'Entel',
      'Chile',
    ]);
    incoming.push([
      id,
      crypto.createHash('md5').update(`respuesta-exportacion-${id}`).digest('hex'),
      foreign ? 102 : 101,
      BIG_DELIVERY,
      dst,
      1000,
      randomContent(),
      secondsOf(index),
    ]);
  }
  await insertChunked(admin, `INSERT INTO dbconnectus.sms_outgoing (id, id_unique, id_account, id_delivery, status, src_number, dst_number,
    sms_content, multiplier, created_at, updated_at, dst_provider, dst_country) VALUES ?`, rows);
  await insertChunked(admin, `INSERT INTO dbconnectus.sms_incoming (id, id_unique, id_account, id_delivery, src_number, dst_number,
    sms_content, created_at) VALUES ?`, incoming);
}

async function removeExportData(admin) {
  await admin.query('DELETE FROM dbconnectus.sms_outgoing WHERE id >= ?', [MARGIN_ID]);
  await admin.query('DELETE FROM dbconnectus.sms_incoming WHERE id >= ?', [FIRST_ID]);
  await admin.query('DELETE FROM dbconnectus.delivery WHERE id IN (?)', [[BIG_DELIVERY, FOREIGN_DELIVERY]]);
}

// Lo que el archivo tiene que traer, en orden, directo de la base.
async function expectedSmsIds(admin, where = '') {
  const [rows] = await admin.query(`SELECT id_unique FROM dbconnectus.sms_outgoing WHERE id_account = 101 AND id >= ${FIRST_ID} ${where} ORDER BY id`);
  return rows.map((row) => row.id_unique);
}

async function expectedIncomingIds(admin) {
  const [rows] = await admin.query(`SELECT id_unique FROM dbconnectus.sms_incoming WHERE id_account = 101 AND id >= ${FIRST_ID} ORDER BY id`);
  return rows.map((row) => row.id_unique);
}

module.exports = {
  BIG_DELIVERY,
  FIRST_ID,
  FOREIGN_DELIVERY,
  RANGE,
  SEARCHED_NUMBER,
  expectedIncomingIds,
  expectedSmsIds,
  insertExportData,
  removeExportData,
};
