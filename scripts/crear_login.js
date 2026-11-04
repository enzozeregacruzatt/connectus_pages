#!/usr/bin/env node
// Escribe por stdout el SQL que crea un login, para pasárselo a mysql como master. Con clave escrita a mano, a un archivo:
//   (umask 077; node scripts/crear_login.js --usuario <u> --cuentas 1,2 > login.sql)
//   mysql ... < login.sql
//   rm login.sql
// Con clave generada también se puede canalizar:
//   node scripts/crear_login.js --usuario <u> --cuentas 1,2 --generar | mysql ...
// La clave se pide sin eco por /dev/tty, o se genera con --generar y se muestra una vez por stderr. Nunca va por argumento,
// porque quedaría en el historial y en la lista de procesos.
//
// Sin --generar no se admite un pipe: con mysql -p al otro lado, los dos procesos leen la misma terminal, mysql le devuelve el
// eco mientras se escribe, y la clave nueva queda a la vista en la pantalla sin que nada avise.
//
// No toca allowed_account a propósito: esa lista es la tercera barrera, y un error de tipeo en --cuentas no debe abrir las
// vistas a la cuenta de otro cliente. Si la cuenta no está permitida, la FK de login_account rechaza el SQL (error 1452) y la
// transacción no deja nada. Ampliar la lista es un paso aparte, ver docs/DISENO.md.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const tty = require('node:tty');
const { parseArgs } = require('node:util');

const { UserError, openTerminal } = require('./terminal');

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const ACCOUNT_RE = /^[1-9][0-9]*$/;
const MAX_ACCOUNT_ID = 2147483647;
const MIN_PASSWORD_CHARS = 16;
// El tope de POST /api/login: una clave más larga nunca podría entrar.
const MAX_PASSWORD_CHARS = 256;
const USAGE = 'Uso: node scripts/crear_login.js --usuario <u> --cuentas 1,2 [--generar]. La clave nunca va por argumento.';
const PIPE_ERROR = 'Sin --generar, la salida no puede ir a un pipe: mysql -p usa la misma terminal y la clave quedaría a la '
  + 'vista. Escribe a un archivo: (umask 077; node scripts/crear_login.js ... > login.sql), luego mysql ... < login.sql y '
  + 'rm login.sql.';

function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        usuario: { type: 'string' },
        cuentas: { type: 'string' },
        generar: { type: 'boolean', default: false },
      },
    }));
  } catch {
    // El mensaje de parseArgs podría repetir lo que se escribió, y ahí podría venir una clave.
    throw new UserError(USAGE);
  }
  if (values.usuario === undefined || values.cuentas === undefined) throw new UserError(USAGE);
  if (!USERNAME_RE.test(values.usuario)) {
    throw new UserError('El usuario debe calzar con ^[A-Za-z0-9._@-]{1,64}$.');
  }
  return { username: values.usuario, accounts: parseAccounts(values.cuentas), generate: values.generar };
}

function parseAccounts(text) {
  const accounts = text.split(',').map((item) => {
    if (!ACCOUNT_RE.test(item) || Number(item) > MAX_ACCOUNT_ID) {
      throw new UserError(`Las cuentas deben ser enteros positivos de hasta ${MAX_ACCOUNT_ID}, separados por comas.`);
    }
    return Number(item);
  });
  return [...new Set(accounts)];
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function buildSql(username, accounts, passwordHash) {
  const links = accounts.map((id) => `(@id_login, ${id})`).join(', ');
  return [
    'START TRANSACTION;',
    `INSERT INTO connectus_pages.login (username, password_hash) VALUES (${sqlString(username)}, ${sqlString(passwordHash)});`,
    'SET @id_login = LAST_INSERT_ID();',
    `INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES ${links};`,
    'COMMIT;',
    '',
  ].join('\n');
}

async function askPassword() {
  const terminal = openTerminal('No hay una terminal para pedir la clave. Usa --generar.');
  try {
    const password = await terminal.readHidden('Clave: ');
    if ([...password].length < MIN_PASSWORD_CHARS) {
      throw new UserError(`La clave debe tener al menos ${MIN_PASSWORD_CHARS} caracteres.`);
    }
    if (password.length > MAX_PASSWORD_CHARS) {
      throw new UserError(`La clave puede tener hasta ${MAX_PASSWORD_CHARS} caracteres.`);
    }
    const repeated = await terminal.readHidden('Repite la clave: ');
    if (repeated !== password) throw new UserError('Las claves no coinciden.');
    return password;
  } finally {
    terminal.close();
  }
}

// Node conecta a sus procesos hijos por socket, y un shell, por FIFO.
function stdoutIsPipe() {
  const stat = fs.fstatSync(1);
  return stat.isFIFO() || stat.isSocket();
}

// Node guarda el estado de la terminal al arrancar y lo restaura al salir, aunque nunca la lea, salvo en un fd que ya apunte a otro
// archivo. Con mysql -p al otro lado de un pipe, eso le devolvería el eco mientras se teclea la clave del master, o dejaría la
// terminal sin eco si mysql termina primero. Se reabre en vez de solo cerrar, porque libuv aborta si le toca cerrar un fd menor que 3.
function releaseTerminal() {
  for (const [fd, mode] of [[0, 'r'], [2, 'w']]) {
    if (tty.isatty(fd)) {
      fs.closeSync(fd);
      fs.openSync('/dev/null', mode);
    }
  }
}

async function main() {
  const { username, accounts, generate } = parseCli(process.argv.slice(2));
  if (!generate && stdoutIsPipe()) throw new UserError(PIPE_ERROR);
  const password = generate ? crypto.randomBytes(24).toString('base64url') : await askPassword();
  const sql = buildSql(username, accounts, hashPassword(password));
  if (generate) {
    process.stderr.write(`Clave generada para ${username}. Se muestra una sola vez:\n${password}\n`);
  }
  releaseTerminal();
  process.stdout.write(sql);
}

main().catch((err) => {
  process.stderr.write(`crear_login: ${err instanceof UserError ? err.message : `error inesperado (${err.code || err.name})`}\n`);
  process.exitCode = 2;
  releaseTerminal();
});
