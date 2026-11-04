'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');

const { issueToken, verifyToken } = require('../../src/auth');
const { signLink, verifyLink } = require('../../src/link');

const SECRET_A = 'ranura-a-de-pruebas-que-supera-los-32-bytes';
const SECRET_B = 'ranura-b-de-pruebas-que-supera-los-32-bytes';
const SECRETS = { a: SECRET_A, b: SECRET_B };
const NOW = 1_800_000_000;
const DAY = 86400;
const MAX_INT = 2147483647;
const FIELDS = { slot: 'a', loginId: 123, linkVersion: 0, exp: NOW + 180 * DAY };

const sign = (overrides = {}, secret = SECRET_A) => signLink({ ...FIELDS, ...overrides }, secret);
const reasonOf = (link, secrets = SECRETS, now = NOW) => verifyLink(link, secrets, now).reason;

// La firma de la etiqueta de dominio, a mano: si alguien la cambia, los enlaces ya entregados dejarían de valer.
function forge(body, secret = SECRET_A, domain = 'connectus_pages/link/v1\n') {
  return `${body}.${crypto.createHmac('sha256', secret).update(domain + body).digest('base64url')}`;
}

test('firma y verifica', () => {
  assert.deepEqual(verifyLink(sign(), SECRETS, NOW), { ok: true, slot: 'a', loginId: 123, linkVersion: 0, exp: FIELDS.exp });
  assert.deepEqual(verifyLink(sign({ slot: 'b', linkVersion: 7 }, SECRET_B), SECRETS, NOW), {
    ok: true,
    slot: 'b',
    loginId: 123,
    linkVersion: 7,
    exp: FIELDS.exp,
  });
});

test('el formato es el del contrato y la firma calza con una calculada a mano', () => {
  const link = sign();
  assert.match(link, /^l1\.a\.123\.0\.[0-9]{10}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(link, forge(`l1.a.123.0.${FIELDS.exp}`));
});

test('basta una ranura cargada, cualquiera de las dos', () => {
  assert.equal(verifyLink(sign(), { a: SECRET_A }, NOW).ok, true);
  assert.equal(verifyLink(sign({ slot: 'b' }, SECRET_B), { b: SECRET_B }, NOW).ok, true);
});

test('una ranura retirada rechaza sus enlaces', () => {
  assert.equal(reasonOf(sign(), { b: SECRET_B }), 'unknown_slot');
  assert.equal(reasonOf(sign({ slot: 'b' }, SECRET_B), { a: SECRET_A }), 'unknown_slot');
});

test('la firma de una ranura no sirve para la otra', () => {
  assert.equal(reasonOf(sign({ slot: 'a' }, SECRET_B)), 'bad_signature');
  assert.equal(reasonOf(sign({ slot: 'b' }, SECRET_A)), 'bad_signature');
});

test('cambiar un carácter de la firma, otra escritura base64url o la firma de otro enlace no pasa', () => {
  const link = sign();
  const last = link.at(-1);
  const flipped = `${link.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
  assert.equal(reasonOf(flipped), 'bad_signature');

  // 32 bytes dan 43 caracteres con 2 bits sobrantes: se puede escribir la misma firma de otra forma.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const other = `${link.slice(0, -1)}${alphabet[alphabet.indexOf(last) + 1]}`;
  assert.deepEqual(
    Buffer.from(other.split('.')[5], 'base64url'),
    Buffer.from(link.split('.')[5], 'base64url'),
    'las dos escrituras decodifican a los mismos bytes'
  );
  assert.equal(reasonOf(other), 'bad_signature');
});

for (const [label, overrides] of [
  ['el login', { loginId: 124 }],
  ['la versión', { linkVersion: 1 }],
  ['el vencimiento', { exp: FIELDS.exp + 1 }],
]) {
  test(`cambiar ${label} con la firma original no pasa`, () => {
    const signature = sign().split('.')[5];
    const body = sign(overrides).split('.').slice(0, 5).join('.');
    assert.equal(reasonOf(`${body}.${signature}`), 'bad_signature');
  });
}

test('una firma sin la etiqueta de dominio, o con otra, no pasa', () => {
  const body = `l1.a.123.0.${FIELDS.exp}`;
  assert.equal(reasonOf(forge(body, SECRET_A, '')), 'bad_signature');
  assert.equal(reasonOf(forge(body, SECRET_A, 'connectus_pages/cursor/v1\n')), 'bad_signature');
});

const signature = sign().split('.')[5];

for (const [label, value] of [
  ['no es string', 123],
  ['nulo', null],
  ['ausente', undefined],
  ['objeto', { toString: () => sign() }],
  ['arreglo', [sign()]],
  ['vacío', ''],
  ['otra versión de formato', `l2.a.123.0.${FIELDS.exp}.${signature}`],
  ['ranura desconocida', `l1.c.123.0.${FIELDS.exp}.${signature}`],
  ['ranura en mayúscula', `l1.A.123.0.${FIELDS.exp}.${signature}`],
  ['login cero', `l1.a.0.0.${FIELDS.exp}.${signature}`],
  ['login con cero a la izquierda', `l1.a.0123.0.${FIELDS.exp}.${signature}`],
  ['login negativo', `l1.a.-1.0.${FIELDS.exp}.${signature}`],
  ['login de 11 dígitos', `l1.a.12345678901.0.${FIELDS.exp}.${signature}`],
  ['versión con cero a la izquierda', `l1.a.123.00.${FIELDS.exp}.${signature}`],
  ['vencimiento de 9 dígitos', `l1.a.123.0.999999999.${signature}`],
  ['vencimiento de 11 dígitos', `l1.a.123.0.18000000000.${signature}`],
  ['firma corta', sign().slice(0, -1)],
  ['firma larga', `${sign()}A`],
  ['firma con relleno', `${sign()}=`],
  ['firma en base64 con +', `l1.a.123.0.${FIELDS.exp}.${'+'.repeat(43)}`],
  ['salto de línea final', `${sign()}\n`],
  ['salto de línea inicial', `\n${sign()}`],
  ['espacio final', `${sign()} `],
  ['espacio inicial', ` ${sign()}`],
  ['prefijo', `x${sign()}`],
  ['un campo de más', `${sign()}.extra`],
  ['cadena enorme', 'l1.a.'.repeat(1000)],
]) {
  test(`un enlace con forma inválida se rechaza sin calcular firma: ${label}`, () => {
    assert.equal(reasonOf(value), 'malformed');
  });
}

test('vence en el segundo exacto', () => {
  const exp = NOW + 10;
  assert.equal(verifyLink(sign({ exp }), SECRETS, exp - 1).ok, true);
  assert.equal(reasonOf(sign({ exp }), SECRETS, exp), 'expired');
  assert.equal(reasonOf(sign({ exp }), SECRETS, exp + 1), 'expired');
});

test('el tope de 365 días se exige también al verificar', () => {
  assert.equal(verifyLink(sign({ exp: NOW + 365 * DAY }), SECRETS, NOW).ok, true);
  assert.equal(reasonOf(sign({ exp: NOW + 365 * DAY + 1 }), SECRETS, NOW), 'too_long');
  assert.equal(reasonOf(sign({ exp: NOW + 3650 * DAY }), SECRETS, NOW), 'too_long');
});

test('los valores fuera de INT se rechazan, aun con la firma correcta', () => {
  assert.equal(reasonOf(sign({ loginId: MAX_INT + 1 })), 'out_of_range');
  assert.equal(reasonOf(sign({ linkVersion: MAX_INT + 1 })), 'out_of_range');
  assert.equal(reasonOf(sign({ exp: MAX_INT + 1 })), 'out_of_range');
  assert.equal(verifyLink(sign({ loginId: MAX_INT, linkVersion: MAX_INT }), SECRETS, NOW).ok, true);
});

test('un enlace no sirve como token ni un token como enlace, aunque compartan el secreto', () => {
  const link = sign();
  assert.equal(verifyToken(link, SECRET_A, NOW), null);
  const token = issueToken(123, 0, SECRET_A, NOW);
  assert.equal(reasonOf(token, { a: SECRET_A }), 'malformed');
});

test('el motivo sale siempre de la lista cerrada, sin el enlace ni sus campos', () => {
  const closed = new Set(['malformed', 'unknown_slot', 'bad_signature', 'out_of_range', 'expired', 'too_long']);
  for (const link of [null, 'x', sign({}, SECRET_B), sign({ exp: NOW }), sign({ exp: NOW + 400 * DAY }), sign({ loginId: MAX_INT + 1 })]) {
    assert.ok(closed.has(reasonOf(link)), String(reasonOf(link)));
  }
  assert.ok(closed.has(reasonOf(sign(), { b: SECRET_B })));
  assert.deepEqual(Object.keys(verifyLink(sign({}, SECRET_B), SECRETS, NOW)).sort(), ['ok', 'reason']);
});

test('src/link.js se carga sin mysql2 ni nada más del proyecto', () => {
  const source = path.join(__dirname, '..', '..', 'src', 'link.js');
  const script = `
    require(${JSON.stringify(source)});
    process.stdout.write(JSON.stringify(Object.keys(require.cache)));
  `;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['-e', script]).toString()), [source]);
});
