'use strict';

// Abre los archivos generados con las herramientas de verdad: python (csv, zipfile, openpyxl), unzip y LibreOffice. Lo que falte se salta
// de forma explícita. Todo queda en un directorio aparte bajo TMPDIR. Requiere scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { after, before, describe, it } = require('node:test');

const { csvRows, startExportEnvironment } = require('./support/exports_env');

const CHECKER = path.join(__dirname, 'support', 'check_export.py');
const DELIVERY = 902;
const FIRST_ID = 600000;
const FILLER_ROWS = 700;
const SOFFICE_LIMIT_MS = 180000;
const PROCESS_EXIT_LIMIT_MS = 30000;
// Tope por archivo, en bloques de 1 KiB, para lo que lancen estas pruebas.
const SHELL_LIMIT = 'ulimit -f 4194304; exec "$@"';

const LONG = 'ñ'.repeat(40000);
const NASTY = [
  ['control', 'a\u0001b\u000bc\u001fd￾e￿z', 'abcdez'],
  // openpyxl entrega el texto de un inlineStr sin decodificar el escape. Lo que importa es que no quede como una A ni una é.
  ['escape', 'pre _x0041_ post _x00e9_', 'pre _x005F_x0041_ post _x005F_x00e9_'],
  ['formula', '=1+1', '=1+1'],
  ['formula_cr', '\r=1+1', null],
  ['formula_coma', 'hola,=1+1', 'hola,=1+1'],
  ['precio', '$10.000,-', '$10.000,-'],
  ['arroba', '@SUMA(1)', '@SUMA(1)'],
  ['ancho', '＝1+1', '＝1+1'],
  ['menos', '-1', '-1'],
  ['xml', '<b>x</b> & "y";z', '<b>x</b> & "y";z'],
  ['acentos', 'canción ¿qué?', 'canción ¿qué?'],
  ['salto', 'uno\ndos', 'uno\ndos'],
  ['largo', LONG, LONG.slice(0, 32767)],
];

const hasPythonLibraries = spawnSync('python3', ['-I', '-c', 'import openpyxl, zipfile, csv'], { stdio: 'ignore' }).status === 0;
const hasUnzip = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
const hasSoffice = spawnSync('sh', ['-c', 'command -v soffice'], { stdio: 'ignore' }).status === 0;

function openWith(kind, file) {
  const output = execFileSync('python3', ['-I', CHECKER, kind, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output);
}

function pidsMentioning(needle) {
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\n')
    .filter((line) => line.includes(needle))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

// Termina por PID, y un proceso cuenta como terminado solo cuando su PID ya no existe.
async function waitUntilGone(needle) {
  const deadline = Date.now() + PROCESS_EXIT_LIMIT_MS;
  while (Date.now() < deadline) {
    const pids = pidsMentioning(needle);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Ya no está.
      }
    }
    await delay(500);
  }
  for (const pid of pidsMentioning(needle)) process.kill(pid, 'SIGKILL');
  await delay(1000);
  assert.deepEqual(pidsMentioning(needle), [], 'quedó un proceso de LibreOffice');
}

function runSoffice(work, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', SHELL_LIMIT, 'sh', 'soffice', '--headless', `-env:UserInstallation=file://${work}/perfil`, ...args], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), SOFFICE_LIMIT_MS);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// LibreOffice escribe con comas, y csvRows separa por punto y coma.
function convertedRows(file) {
  return csvRows(Buffer.from(fs.readFileSync(file, 'utf8').replaceAll(',', ';')));
}

describe('los archivos, abiertos con otras herramientas', () => {
  let environment;
  let admin;
  let s3;
  let work;
  const files = {};

  before(async () => {
    environment = await startExportEnvironment('exportador_archivos', [101]);
    ({ admin, s3 } = environment);
    await admin.query('DELETE FROM connectus_pages.export_job');
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-archivos-'));
    await admin.query(`INSERT INTO dbconnectus.delivery (id, id_unique, id_account, delivery_type, name, deliver_at, created_at, id_product, status)
      VALUES (?, MD5('envio-archivos'), 101, 'CUSTOM', '=Envío; "raro"', '2026-08-10 00:00:00', '2026-08-10 00:00:00', 1, 'completed')`, [DELIVERY]);

    const outgoing = [];
    const incoming = [];
    const add = (index, label, content) => {
      const id = FIRST_ID + index;
      outgoing.push([id, `${label}-${index}`, 101, DELIVERY, 'DELIVRD', 1000, 56900002000 + (index % 50), content, 1, '2026-08-10 12:00:00', '2026-08-10 12:01:00', '=Entel', 'Chile']);
      incoming.push([id, `${label}-${index}`, 101, DELIVERY, 56900002000 + (index % 50), 1000, content, '2026-08-10 12:00:00']);
    };
    NASTY.forEach(([label, content], index) => add(index, label, content));
    for (let index = 0; index < FILLER_ROWS; index += 1) add(NASTY.length + index, 'relleno', `Texto común ${index}`);
    await admin.query(`INSERT INTO dbconnectus.sms_outgoing (id, id_unique, id_account, id_delivery, status, src_number, dst_number, sms_content, multiplier,
      created_at, updated_at, dst_provider, dst_country) VALUES ?`, [outgoing]);
    await admin.query(`INSERT INTO dbconnectus.sms_incoming (id, id_unique, id_account, id_delivery, src_number, dst_number, sms_content, created_at) VALUES ?`, [incoming]);
    // Para que el corte por fecha parta aquí y el CSV no recorra el resto del fixture.
    await admin.query(`INSERT INTO dbconnectus.sms_outgoing (id, id_unique, id_account, status, src_number, dst_number, created_at) VALUES (?, 'margen', 101, 'DELIVRD', 1000, 56900002000, '2026-08-01 00:00:00')`, [FIRST_ID - 1]);

    const clock = () => Date.parse('2026-08-20T12:00:00Z');
    const csvJob = await environment.insertJob({ kind: 'sms_csv', start_date: '2026-08-05', end_date: '2026-08-15', created_at: '2026-08-20 11:00:00' });
    const detailJob = await environment.insertJob({ kind: 'delivery_xlsx', id_delivery: DELIVERY, delivery_name: '=Envío; "raro"', created_at: '2026-08-20 11:00:00', batch_size: 500 });
    const incomingJob = await environment.insertJob({ kind: 'incoming_xlsx', id_delivery: DELIVERY, delivery_name: '=Envío; "raro"', created_at: '2026-08-20 11:00:00', batch_size: 500 });
    await environment.work({ clock });
    // El relleno de cierre: la primera corrida se corta después de un lote, y cierra rellenando hasta 5 MiB.
    const paddedJob = await environment.insertJob({ kind: 'delivery_xlsx', id_delivery: DELIVERY, delivery_name: 'Con relleno', created_at: '2026-08-20 11:00:00', batch_size: 500 });
    let batches = 0;
    await environment.work({
      clock,
      db: {
        query(sql, params) {
          if (/LIMIT 500$/.test(sql)) batches += 1;
          return environment.workerDb.query(sql, params);
        },
        write: (sql, params) => environment.workerDb.write(sql, params),
        destroy: () => environment.workerDb.destroy(),
      },
      remainingMs: () => (batches >= 1 ? 59000 : 800000),
    });
    const padded = await environment.jobOf(paddedJob);
    assert.equal(padded.state, 'processing');
    assert.ok(Number(padded.file_bytes) >= 5 * 1024 * 1024);
    await environment.work({ clock });
    assert.equal((await environment.jobOf(paddedJob)).state, 'finished');

    for (const [name, publicId, extension] of [['csv', csvJob, 'csv'], ['detail', detailJob, 'xlsx'], ['incoming', incomingJob, 'xlsx'], ['padded', paddedJob, 'xlsx']]) {
      files[name] = path.join(work, `${name}.${extension}`);
      fs.copyFileSync(s3.pathOf(publicId), files[name]);
    }
  });

  after(async () => {
    await admin.query('DELETE FROM dbconnectus.sms_outgoing WHERE id >= ?', [FIRST_ID - 1]);
    await admin.query('DELETE FROM dbconnectus.sms_incoming WHERE id >= ?', [FIRST_ID]);
    await admin.query('DELETE FROM dbconnectus.delivery WHERE id = ?', [DELIVERY]);
    await admin.query('DELETE FROM connectus_pages.export_job');
    await environment.stop();
    await waitUntilGone(work);
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('CSV: csv de python lee todas las columnas, con los textos neutralizados', { skip: hasPythonLibraries ? false : 'falta python3 con openpyxl' }, () => {
    const { rows } = openWith('csv', files.csv);
    assert.deepEqual(rows[0], ['Identificador único', 'Cuenta', 'Envío', 'Número origen', 'Número destino', 'Mensaje', 'Estado', 'Proveedor', 'Fecha']);
    assert.equal(rows.length, 1 + NASTY.length + FILLER_ROWS);
    assert.ok(rows.every((row) => row.length === 9));
    const message = (label) => rows.find((row) => row[0].startsWith(`${label}-`))[5];
    assert.equal(message('formula'), "'=1+1");
    assert.equal(message('formula_cr'), "'\r'=1+1");
    assert.equal(message('formula_coma'), "hola,'=1+1");
    assert.equal(message('precio'), '$10.000,-');
    assert.equal(message('arroba'), "'@SUMA(1)");
    assert.equal(message('ancho'), "'＝1+1");
    assert.equal(message('menos'), "'-1");
    assert.equal(message('xml'), '<b>x</b> & "y";z');
    assert.equal(message('salto'), 'uno\ndos');
    assert.equal(message('largo'), LONG);
    assert.equal(rows[1][2], "'=Envío; \"raro\"");
    assert.equal(rows[1][7], "'=Entel");
    assert.equal(rows[1][8], '10/08/2026 12:00:00');
    assert.ok(fs.readFileSync(files.csv).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  });

  for (const [name, sheet, width] of [['detail', 'Detalle', 11], ['incoming', 'Respuestas', 6], ['padded', 'Detalle', 11]]) {
    it(`XLSX ${name}: zipfile y openpyxl lo abren, con los caracteres inválidos fuera y el texto intacto`, { skip: hasPythonLibraries ? false : 'falta python3 con openpyxl' }, () => {
      const book = openWith('xlsx', files[name]);
      assert.equal(book.sheet, sheet);
      assert.equal(book.rows.length, 1 + NASTY.length + FILLER_ROWS);
      assert.ok(book.rows.every((row) => row.length === width));
      assert.ok(!book.cellTypes.includes('f'), 'ninguna celda es una fórmula');
      const contentColumn = 3;
      for (const [label, , expected] of NASTY) {
        const row = book.rows.find((candidate) => candidate[0].startsWith(`${label}-`));
        if (expected !== null) assert.equal(row[contentColumn], expected, label);
      }
      assert.equal(book.rows.find((row) => row[0].startsWith('largo-'))[contentColumn].length, 32767);
      assert.deepEqual(book.rows.slice(14).map((row) => row[contentColumn]).slice(0, 2), ['Texto común 0', 'Texto común 1']);
    });

    it(`XLSX ${name}: unzip -t no encuentra errores`, { skip: hasUnzip ? false : 'falta unzip' }, () => {
      const result = spawnSync('unzip', ['-t', files[name]], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout);
    });
  }

  it('LibreOffice abre los tres XLSX y el CSV, sin evaluar nada, y termina', { skip: hasSoffice ? false : 'falta soffice' }, async () => {
    const out = path.join(work, 'convertidos');
    fs.mkdirSync(out);
    for (const name of ['detail', 'incoming', 'padded']) {
      assert.equal(await runSoffice(work, ['--convert-to', 'csv', '--outdir', out, files[name]]), 0);
      const rows = convertedRows(path.join(out, `${name}.csv`));
      assert.ok(rows.length > FILLER_ROWS, name);
      const formula = rows.find((row) => row[0].startsWith('formula-'));
      assert.ok(formula.includes('=1+1'), 'la fórmula queda como texto');
      assert.ok(!formula.includes('2'));
      assert.ok(rows.find((row) => row[0].startsWith('escape-')).includes('pre _x0041_ post _x00e9_'), 'el escape se lee como el texto original');
      assert.equal(rows.find((row) => row[0].startsWith('control-'))[3], 'abcdez');
      await waitUntilGone(`${work}/perfil`);
    }
    fs.copyFileSync(files.csv, path.join(work, 'fuente.csv'));
    const converted = path.join(work, 'convertidos2');
    fs.mkdirSync(converted);
    assert.equal(await runSoffice(work, ['--infilter=CSV:59,34,76,1', '--convert-to', 'csv', '--outdir', converted, path.join(work, 'fuente.csv')]), 0);
    assert.ok(fs.readFileSync(path.join(converted, 'fuente.csv'), 'utf8').includes("'=1+1"));
    await waitUntilGone(`${work}/perfil`);
  });
});
