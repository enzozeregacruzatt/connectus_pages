'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { decodeCursor, decodeDatedCursor, encodeCursor, encodeDatedCursor } = require('../../src/cursor');

const SECRET = 'secreto-de-pruebas-que-supera-los-32-bytes';
const LABEL = 'messages:101:abc';
const DATED = { id: 123, createdAt: '2026-10-24 08:55:00' };

test('un cursor de id vuelve con su etiqueta', () => {
  assert.equal(decodeCursor(encodeCursor(123, LABEL, SECRET), LABEL, SECRET), 123);
});

test('un cursor de id mide 48 caracteres', () => {
  assert.match(encodeCursor(123, LABEL, SECRET), /^[A-Za-z0-9_-]{48}$/);
});

for (const label of ['messages:101:abd', 'messages:102:abc', 'sms:101', 'deliveries:101', 'exports:101', '']) {
  test(`la etiqueta está autenticada: no vale con ${JSON.stringify(label)}`, () => {
    assert.equal(decodeCursor(encodeCursor(123, LABEL, SECRET), label, SECRET), null);
    assert.equal(decodeDatedCursor(encodeDatedCursor(DATED, LABEL, SECRET), label, SECRET), null);
  });
}

test('un cursor con fecha vuelve con su fecha y su id', () => {
  assert.deepEqual(decodeDatedCursor(encodeDatedCursor(DATED, LABEL, SECRET), LABEL, SECRET), DATED);
});

test('admite la fecha en cero', () => {
  const zero = { id: 5, createdAt: '0000-00-00 00:00:00' };
  assert.deepEqual(decodeDatedCursor(encodeDatedCursor(zero, LABEL, SECRET), LABEL, SECRET), zero);
});

test('no cifra una fecha con otra forma', () => {
  for (const createdAt of ['2026-10-24', '2026-10-24 08:55:00.000', null]) {
    assert.throws(() => encodeDatedCursor({ id: 1, createdAt }, LABEL, SECRET));
  }
});

test('la fecha y el id no se ven en el texto', () => {
  const text = encodeDatedCursor(DATED, LABEL, SECRET);
  assert.doesNotMatch(Buffer.from(text, 'base64url').toString('latin1'), /2026|08:55/);
});

test('uno de cada clase no vale como el otro', () => {
  assert.equal(decodeDatedCursor(encodeCursor(123, LABEL, SECRET), LABEL, SECRET), null);
  assert.equal(decodeCursor(encodeDatedCursor(DATED, LABEL, SECRET), LABEL, SECRET), null);
});

test('un cursor tiene una sola escritura: los bits sobrantes del último carácter no valen', () => {
  const text = encodeDatedCursor(DATED, LABEL, SECRET);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(text.at(-1));
  // 55 bytes dejan 4 bits sobrantes en el último carácter: cambiarlos decodifica a los mismos bytes.
  assert.equal(Buffer.from(text, 'base64url').length, 55);
  for (let bits = 1; bits < 16; bits += 1) {
    const variant = text.slice(0, -1) + alphabet[last | bits];
    if (variant !== text) assert.equal(decodeDatedCursor(variant, LABEL, SECRET), null);
  }
  assert.deepEqual(decodeDatedCursor(text, LABEL, SECRET), DATED);
});

test('rechaza lo que no es un cursor emitido', () => {
  const valid = encodeCursor(123, LABEL, SECRET);
  for (const text of ['', '12345', `${valid}A`, valid.slice(0, -1), `${valid.slice(0, -2)}=`, `${valid} `, 123, null, undefined, [valid]]) {
    assert.equal(decodeCursor(text, LABEL, SECRET), null, String(text));
  }
  assert.equal(decodeCursor(valid, LABEL, `${SECRET}x`), null);
  assert.equal(decodeCursor(encodeCursor(0, LABEL, SECRET), LABEL, SECRET), null);
  assert.equal(decodeCursor(encodeCursor(2n ** 60n, LABEL, SECRET), LABEL, SECRET), null);
});
