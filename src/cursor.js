'use strict';

const crypto = require('node:crypto');

// El id de sms_outgoing es un autoincremental compartido por todas las cuentas: restando dos, un cliente
// estimaría el volumen de toda la plataforma. Por eso el cursor viaja cifrado, y atado con su etiqueta a la ruta y a lo que pagina:
// sms:<cuenta>, deliveries:<cuenta>, messages:<cuenta>:<envío>, exports:<login>.
const KEY_INFO = 'connectus_pages/cursor/v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ID_BYTES = 8;
const TAG_BYTES = 16;
const DATE_BYTES = 19;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function deriveKey(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), KEY_INFO, KEY_BYTES));
}

function seal(plain, label, secret) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  cipher.setAAD(Buffer.from(label));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url');
}

// Devuelve el contenido, o null si el texto no es un cursor emitido por esta app para esa etiqueta.
function open(text, plainBytes, label, secret) {
  if (typeof text !== 'string' || !CURSOR_PATTERN.test(text)) return null;
  const raw = Buffer.from(text, 'base64url');
  // Los bits sobrantes del último carácter no los cubre la firma: sin recodificar, un cursor tendría más de una escritura.
  if (raw.length !== IV_BYTES + plainBytes + TAG_BYTES || raw.toString('base64url') !== text) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(label));
    decipher.setAuthTag(raw.subarray(IV_BYTES + plainBytes));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, IV_BYTES + plainBytes)), decipher.final()]);
  } catch {
    return null;
  }
}

function writeId(id) {
  const plain = Buffer.alloc(ID_BYTES);
  plain.writeBigUInt64BE(BigInt(id));
  return plain;
}

function readId(plain) {
  const id = Number(plain.readBigUInt64BE());
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function encodeCursor(id, label, secret) {
  return seal(writeId(id), label, secret);
}

function decodeCursor(text, label, secret) {
  const plain = open(text, ID_BYTES, label, secret);
  return plain && readId(plain);
}

// Para las páginas que ordenan por fecha e id. La fecha va como la entrega la base, porque también puede venir en cero.
function encodeDatedCursor({ id, createdAt }, label, secret) {
  if (!DATE_PATTERN.test(createdAt)) throw new Error('unexpected_cursor_date');
  return seal(Buffer.concat([writeId(id), Buffer.from(createdAt, 'latin1')]), label, secret);
}

function decodeDatedCursor(text, label, secret) {
  const plain = open(text, ID_BYTES + DATE_BYTES, label, secret);
  const id = plain && readId(plain.subarray(0, ID_BYTES));
  return id ? { id, createdAt: plain.toString('latin1', ID_BYTES) } : null;
}

module.exports = { decodeCursor, decodeDatedCursor, encodeCursor, encodeDatedCursor };
