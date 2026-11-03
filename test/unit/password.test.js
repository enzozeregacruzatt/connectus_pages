'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { DUMMY_HASH, hashPassword, verifyPassword } = require('../../src/auth');

test('el hash sigue el formato y los parámetros del contrato', async () => {
  const hash = await hashPassword('una clave');
  const match = /^scrypt\$32768\$8\$1\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(hash);
  assert.ok(match);
  assert.equal(Buffer.from(match[1], 'base64').length, 16);
  assert.equal(Buffer.from(match[2], 'base64').length, 32);
});

test('verifica la clave correcta y rechaza una incorrecta', async () => {
  const hash = await hashPassword('una clave');
  assert.equal(await verifyPassword('una clave', hash), true);
  assert.equal(await verifyPassword('otra clave', hash), false);
  assert.equal(await verifyPassword('una clav', hash), false);
});

test('admite claves con caracteres no ASCII', async () => {
  const hash = await hashPassword('contraseña ñandú 🔐');
  assert.equal(await verifyPassword('contraseña ñandú 🔐', hash), true);
  assert.equal(await verifyPassword('contrasena nandu', hash), false);
});

test('dos hashes de la misma clave usan sal distinta', async () => {
  assert.notEqual(await hashPassword('una clave'), await hashPassword('una clave'));
});

test('un hash malformado o con otros parámetros nunca valida', async () => {
  const hash = await hashPassword('una clave');
  const [, , , , salt, key] = hash.split('$');
  const malformed = [
    '',
    null,
    undefined,
    'texto plano',
    `scrypt$16384$8$1$${salt}$${key}`,
    `scrypt$32768$1$1$${salt}$${key}`,
    `bcrypt$32768$8$1$${salt}$${key}`,
    `scrypt$32768$8$1$${salt}`,
    `scrypt$32768$8$1$${salt}$${key}$extra`,
    `scrypt$32768$8$1$${salt}$AAAA`,
    `scrypt$32768$8$1$AAAA$${key}`,
  ];
  for (const stored of malformed) {
    assert.equal(await verifyPassword('una clave', stored), false);
  }
});

test('el hash ficticio no valida ninguna clave de uso común', async () => {
  for (const password of ['', 'password', 'admin', 'connectus']) {
    assert.equal(await verifyPassword(password, DUMMY_HASH), false);
  }
});
