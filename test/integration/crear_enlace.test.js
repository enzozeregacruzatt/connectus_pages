'use strict';

// scripts/crear_enlace.js como lo corre quien emite: por pipe y en una terminal de verdad, y el enlace entra por el handler real
// contra el mysqld desechable. Requiere scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { createDb } = require('../../src/db');
const { createHandler } = require('../../src/handler');
const { verifyLink } = require('../../src/link');
const { adminConnectionOptions, loadTestEnv, localConfigEnv } = require('./support/test_env');
const mysql = require('mysql2/promise');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'crear_enlace.js');
const TERMINAL = path.join(__dirname, 'support', 'crear_enlace_terminal.py');
const SECRET = 'secreto-del-enlace-de-la-prueba-con-mas-de-32-bytes';
const BASE = 'https://consulta.example.com/';
const DAY = 86400;
const MAX_INT = 2147483647;
const VALID_ARGS = ['--base', BASE, '--ranura', 'a', '--login', '123', '--version', '0'];

const withArg = (name, value) => {
  const args = [...VALID_ARGS];
  const index = args.indexOf(name);
  if (index === -1) args.push(name, value);
  else args[index + 1] = value;
  return args;
};

function run(args, input = SECRET) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });
}

function linkOf(url) {
  const prefix = `${BASE}#e=`;
  assert.ok(url.startsWith(prefix), 'la URL debe llevar el enlace en el fragmento');
  return url.slice(prefix.length);
}

const verify = (link, secret = SECRET) => verifyLink(link, { a: secret, b: secret }, Math.floor(Date.now() / 1000));

function assertRejected(result, ...privateValues) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '', 'sin URL');
  assert.match(result.stderr, /^crear_enlace: /);
  for (const value of privateValues) assert.equal(result.stderr.includes(value), false, 'el error no repite lo escrito');
}

describe('crear_enlace.js', () => {
  it('saca solo la URL por stdout, sin salto de línea, y por stderr la fecha, el login, la versión y la ranura', () => {
    const before = Math.floor(Date.now() / 1000);
    const result = run(withArg('--version', '4'));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\s/);
    const verified = verify(linkOf(result.stdout));
    assert.equal(verified.ok, true);
    assert.equal(verified.slot, 'a');
    assert.equal(verified.loginId, 123);
    assert.equal(verified.linkVersion, 4);
    assert.ok(verified.exp >= before + 180 * DAY && verified.exp <= before + 180 * DAY + 5, 'son 180 días por omisión');
    assert.match(result.stderr, /login 123/);
    assert.match(result.stderr, /versión 4/);
    assert.match(result.stderr, /ranura a/);
    assert.match(result.stderr, /Vence el \d{2}\/\d{2}\/\d{4}\./);
    assert.equal(result.stderr.includes(linkOf(result.stdout)), false, 'el enlace sale solo por stdout');
  });

  it('el secreto no aparece en la salida ni en los errores', () => {
    for (const result of [run(VALID_ARGS), run(withArg('--dias', '0')), run(withArg('--base', 'http://x/'))]) {
      assert.equal(result.stdout.includes(SECRET), false);
      assert.equal(result.stderr.includes(SECRET), false);
    }
  });

  it('con y sin un salto de línea final da una firma válida para el mismo secreto', () => {
    for (const input of [SECRET, `${SECRET}\n`]) {
      const result = run(VALID_ARGS, input);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(verify(linkOf(result.stdout)).ok, true, JSON.stringify(input.slice(-1)));
    }
  });

  it('quita a lo sumo un salto de línea: el resto es parte del secreto', () => {
    for (const input of [`${SECRET}\n\n`, `${SECRET}\r\n`, `${SECRET} `, `\n${SECRET}`]) {
      const result = run(VALID_ARGS, input);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(verify(linkOf(result.stdout)).reason, 'bad_signature', JSON.stringify(input));
    }
  });

  it('acepta de 1 a 365 días, y la ranura b', () => {
    for (const days of [1, 365]) {
      const result = run(withArg('--dias', String(days)));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(verify(linkOf(result.stdout)).ok, true, `${days} días`);
    }
    assert.equal(verify(linkOf(run(withArg('--ranura', 'b')).stdout)).slot, 'b');
  });

  it('la base sin barra final da la misma forma', () => {
    const result = run(withArg('--base', 'https://consulta.example.com'));
    assert.equal(verify(linkOf(result.stdout)).ok, true);
  });

  for (const [label, name, value] of [
    ['--dias 0', '--dias', '0'],
    ['--dias 366', '--dias', '366'],
    ['--dias negativo', '--dias', '-1'],
    ['--dias decimal', '--dias', '1.5'],
    ['--dias con cero a la izquierda', '--dias', '01'],
    ['--dias que no es número', '--dias', 'VALOR-PRIVADO'],
    ['una base http', '--base', 'http://VALOR-PRIVADO.example.com/'],
    ['una base sin esquema', '--base', 'VALOR-PRIVADO.example.com'],
    ['una base con ruta', '--base', 'https://consulta.example.com/VALOR-PRIVADO'],
    ['una base con query', '--base', 'https://consulta.example.com/?VALOR-PRIVADO'],
    ['una base con fragmento', '--base', 'https://consulta.example.com/#VALOR-PRIVADO'],
    ['otra ranura', '--ranura', 'VALOR-PRIVADO'],
    ['la ranura en mayúscula', '--ranura', 'A'],
    ['un login cero', '--login', '0'],
    ['un login negativo', '--login', '-1'],
    ['un login fuera de INT', '--login', String(MAX_INT + 1)],
    ['un login que no es número', '--login', 'VALOR-PRIVADO'],
    ['una versión negativa', '--version', '-1'],
    ['una versión fuera de INT', '--version', String(MAX_INT + 1)],
    ['una versión con cero a la izquierda', '--version', '01'],
  ]) {
    it(`rechaza ${label}, sin repetir lo escrito`, () => {
      assertRejected(run(withArg(name, value)), 'VALOR-PRIVADO');
    });
  }

  for (const name of ['--base', '--ranura', '--login', '--version']) {
    it(`sin ${name} no emite nada`, () => {
      const index = VALID_ARGS.indexOf(name);
      assertRejected(run(VALID_ARGS.filter((_, position) => position !== index && position !== index + 1)));
    });
  }

  it('no existe la opción --secreto, y su valor no se repite', () => {
    assertRejected(run([...VALID_ARGS, '--secreto', 'VALOR-PRIVADO']), 'VALOR-PRIVADO');
    assertRejected(run([...VALID_ARGS, '--secreto=VALOR-PRIVADO']), 'VALOR-PRIVADO');
    assertRejected(run([...VALID_ARGS, 'VALOR-PRIVADO']), 'VALOR-PRIVADO');
  });

  it('rechaza un secreto de menos de 32 bytes, medidos en bytes, sin mostrarlo', () => {
    assertRejected(run(VALID_ARGS, 'corto-privado'), 'corto-privado');
    assertRejected(run(VALID_ARGS, 'x'.repeat(31)), 'xxxx');
    assertRejected(run(VALID_ARGS, `${'x'.repeat(31)}\n`), 'xxxx');
    assertRejected(run(VALID_ARGS, ''));
    assert.equal(run(VALID_ARGS, 'x'.repeat(32)).status, 0);
    assert.equal(run(VALID_ARGS, 'ñ'.repeat(16)).status, 0);
  });

  it('los argumentos malos fallan antes de leer el secreto', () => {
    const result = spawnSync(process.execPath, [SCRIPT, ...withArg('--dias', '0')], {
      // Un stdin que nunca termina: si leyera antes de validar, se quedaría esperando.
      stdio: [fs.openSync('/dev/zero', 'r'), 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 2);
  });

  it('por un pipe del shell, como en el procedimiento, la salida sigue siendo solo la URL', () => {
    const result = spawnSync(
      'bash',
      ['-c', 'set -o pipefail; printf "%s\\n" "$SECRETO" | "$0" "$@" 2>/dev/null | cat', process.execPath, SCRIPT, ...VALID_ARGS],
      { env: { ...process.env, SECRETO: SECRET }, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(verify(linkOf(result.stdout)).ok, true);
  });

  it('solo usa src/link.js de la app: emitir no carga mysql2', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const local = [...source.matchAll(/require\('(\.[^']+)'\)/g)].map((match) => match[1]);
    assert.deepEqual(local.sort(), ['../src/link', './terminal']);
  });

  describe('con stdin en una terminal', () => {
    let directory;

    before(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-enlace-'));
    });

    after(() => fs.rmSync(directory, { recursive: true, force: true }));

    function onTerminal(typed, args) {
      const file = path.join(directory, `url-${fs.readdirSync(directory).length}`);
      const result = spawnSync('python3', ['-I', TERMINAL, process.execPath, SCRIPT, file, ...args], {
        input: `${typed}\n`,
        encoding: 'utf8',
      });
      return { ...result, url: fs.readFileSync(file, 'utf8') };
    }

    it('pide el secreto sin eco, y la URL sale por stdout', () => {
      const result = onTerminal(SECRET, VALID_ARGS);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stderr.includes('Secreto: '));
      assert.equal(result.stderr.includes(SECRET), false, 'el secreto no debe verse en la terminal');
      assert.equal(verify(linkOf(result.url)).ok, true);
    });

    it('con uno corto termina con error, sin eco y sin URL', () => {
      const result = onTerminal('corto-privado', VALID_ARGS);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.url, '');
      assert.equal(result.stderr.includes('corto-privado'), false);
      assert.match(result.stderr, /al menos 32 bytes/);
    });
  });

  describe('contra el backend real', () => {
    const USERNAME = 'enlace_script';
    const PASSWORD = 'clave-desechable-de-crear-enlace';
    let env;
    let admin;
    let db;
    let handler;
    let loginId;

    async function cleanUp() {
      const [rows] = await admin.query('SELECT id FROM connectus_pages.login WHERE username = ?', [USERNAME]);
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) return;
      await admin.query('DELETE FROM connectus_pages.audit_log WHERE id_login IN (?)', [ids]);
      await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login IN (?)', [ids]);
      await admin.query('DELETE FROM connectus_pages.login WHERE id IN (?)', [ids]);
    }

    before(async () => {
      const { hashPassword } = require('../../src/auth');
      env = loadTestEnv();
      const config = await loadConfig({ env: localConfigEnv(env, { TOKEN_SECRET: 't'.repeat(64) }) });
      db = createDb(config);
      const app = createApp({ db, config, loginFailureFloorMs: 0 });
      handler = createHandler(async () => app);
      admin = await mysql.createConnection(adminConnectionOptions(env));
      await cleanUp();
      const [created] = await admin.query(
        'INSERT INTO connectus_pages.login (username, password_hash) VALUES (?, ?)',
        [USERNAME, await hashPassword(PASSWORD)]
      );
      loginId = created.insertId;
    });

    after(async () => {
      await cleanUp();
      await admin.end();
      await db.end();
    });

    const login = (link) => handler({
      httpMethod: 'POST',
      path: '/api/login',
      headers: { 'Content-Type': 'application/json' },
      multiValueHeaders: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      body: JSON.stringify({ link, username: USERNAME, password: PASSWORD }),
      isBase64Encoded: false,
      requestContext: { identity: { sourceIp: '203.0.113.50' } },
    });

    function emit(version) {
      const result = run(
        ['--base', BASE, '--ranura', 'a', '--login', String(loginId), '--version', String(version)],
        `${env.linkSecretA}\n`
      );
      assert.equal(result.status, 0, result.stderr);
      return linkOf(result.stdout);
    }

    it('el enlace emitido entra, y con una versión equivocada falla en el primer uso', async () => {
      assert.equal((await login(emit(0))).statusCode, 200);
      const wrong = await login(emit(1));
      assert.equal(wrong.statusCode, 401);
      assert.equal(JSON.parse(wrong.body).error, 'invalid_link');
    });
  });
});
