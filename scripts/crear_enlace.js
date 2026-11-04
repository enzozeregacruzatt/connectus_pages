#!/usr/bin/env node
// Emite el enlace firmado de un login: la URL sale por stdout, y por stderr la fecha, el login, la versión y la ranura. No toca
// la base: una versión equivocada da un enlace que falla en el primer uso, sin riesgo.
//
// Como master, para obtener id y versión:
//   SELECT id, link_version FROM connectus_pages.login WHERE username = ?;
// El secreto entra por stdin, y se canaliza a pbcopy para que el enlace no quede en el scrollback:
//   aws ssm get-parameter --name /connectus-pages/prod/link_secret_a --with-decryption \
//       --query Parameter.Value --output text \
//     | node scripts/crear_enlace.js --base "https://$PAGES_DOMAIN_NAME/" --ranura a --login <id> --version <n> --dias 180 \
//     | pbcopy
// Si stdin es una terminal, el secreto se pide sin eco. Nunca va por argumento, porque quedaría en el historial y en la lista de
// procesos.
//
// Subir un secreto nuevo, con el archivo temporal fuera del repo:
//   secreto=$(mktemp)
//   openssl rand -hex 32 | tr -d '\n' > "$secreto"
//   aws ssm put-parameter --name /connectus-pages/prod/link_secret_a --type SecureString --value "file://$secreto"
//   rm "$secreto"
'use strict';

const tty = require('node:tty');
const { parseArgs } = require('node:util');

const { DAY_SECONDS, MAX_INT, MAX_LINK_DAYS, MIN_LINK_SECRET_BYTES, signLink } = require('../src/link');
const { UserError, openTerminal } = require('./terminal');

const TIME_ZONE = 'America/Santiago';
const DEFAULT_DAYS = '180';
const BASE_RE = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/?$/;
const SLOT_RE = /^[ab]$/;
const LOGIN_RE = /^[1-9][0-9]{0,9}$/;
const VERSION_RE = /^(?:0|[1-9][0-9]{0,9})$/;
const DAYS_RE = /^[1-9][0-9]{0,2}$/;
const USAGE = 'Uso: node scripts/crear_enlace.js --base https://<host>/ --ranura a|b --login <id> --version <n> [--dias 180]. '
  + 'El secreto entra por stdin, nunca por argumento.';

function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' },
        ranura: { type: 'string' },
        login: { type: 'string' },
        version: { type: 'string' },
        dias: { type: 'string', default: DEFAULT_DAYS },
      },
    }));
  } catch {
    // El mensaje de parseArgs podría repetir lo que se escribió, y ahí podría venir el secreto.
    throw new UserError(USAGE);
  }
  if (values.base === undefined || values.ranura === undefined || values.login === undefined || values.version === undefined) {
    throw new UserError(USAGE);
  }
  if (!BASE_RE.test(values.base)) throw new UserError('La base debe ser https://<host>/, sin ruta, query ni fragmento.');
  if (!SLOT_RE.test(values.ranura)) throw new UserError('La ranura debe ser a o b.');
  if (!LOGIN_RE.test(values.login) || Number(values.login) > MAX_INT) {
    throw new UserError(`El login debe ser un entero positivo de hasta ${MAX_INT}.`);
  }
  if (!VERSION_RE.test(values.version) || Number(values.version) > MAX_INT) {
    throw new UserError(`La versión debe ser un entero de 0 a ${MAX_INT}.`);
  }
  if (!DAYS_RE.test(values.dias) || Number(values.dias) > MAX_LINK_DAYS) {
    throw new UserError(`Los días deben ser un entero de 1 a ${MAX_LINK_DAYS}.`);
  }
  return {
    base: values.base.endsWith('/') ? values.base : `${values.base}/`,
    slot: values.ranura,
    loginId: Number(values.login),
    linkVersion: Number(values.version),
    days: Number(values.dias),
  };
}

async function readSecretFromPipe() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  // Solo el salto que agrega aws --output text: cualquier otro carácter es parte del secreto.
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

async function readSecretFromTerminal() {
  const terminal = openTerminal('No hay una terminal para pedir el secreto. Pásalo por stdin.');
  try {
    return await terminal.readHidden('Secreto: ');
  } finally {
    terminal.close();
  }
}

function formatDate(exp) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, dateStyle: 'short' }).format(exp * 1000);
}

async function main() {
  const { base, slot, loginId, linkVersion, days } = parseCli(process.argv.slice(2));
  const secret = tty.isatty(0) ? await readSecretFromTerminal() : await readSecretFromPipe();
  if (Buffer.byteLength(secret, 'utf8') < MIN_LINK_SECRET_BYTES) {
    throw new UserError(`El secreto debe tener al menos ${MIN_LINK_SECRET_BYTES} bytes.`);
  }
  const exp = Math.floor(Date.now() / 1000) + days * DAY_SECONDS;
  const url = `${base}#e=${signLink({ slot, loginId, linkVersion, exp }, secret)}`;
  process.stderr.write(`Enlace del login ${loginId}, versión ${linkVersion}, ranura ${slot}. Vence el ${formatDate(exp)}.\n`);
  // Sin salto de línea en un pipe: acabaría pegado junto con la URL en el archivo del BI.
  process.stdout.write(process.stdout.isTTY ? `${url}\n` : url);
}

main().catch((err) => {
  process.stderr.write(`crear_enlace: ${err instanceof UserError ? err.message : `error inesperado (${err.code || err.name})`}\n`);
  process.exitCode = 2;
});
