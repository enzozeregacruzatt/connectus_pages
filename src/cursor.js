'use strict';

const crypto = require('node:crypto');

// El id de sms_outgoing es un autoincremental compartido por todas las cuentas: restando dos, un cliente
// estimaría el volumen de toda la plataforma. Por eso el cursor viaja cifrado y atado a la cuenta.
const KEY_INFO = 'connectus_pages/cursor/v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ID_BYTES = 8;
const TAG_BYTES = 16;
// 36 bytes dan 48 caracteres de base64url sin bits sobrantes: cada cursor tiene una sola escritura.
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{48}$/;

function deriveKey(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), KEY_INFO, KEY_BYTES));
}

function encodeCursor(id, account, secret) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  cipher.setAAD(Buffer.from(String(account)));
  const plain = Buffer.alloc(ID_BYTES);
  plain.writeBigUInt64BE(BigInt(id));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url');
}

// Devuelve el id, o null si el cursor no es uno emitido por esta app para esa cuenta.
function decodeCursor(text, account, secret) {
  if (typeof text !== 'string' || !CURSOR_PATTERN.test(text)) return null;
  const raw = Buffer.from(text, 'base64url');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(String(account)));
    decipher.setAuthTag(raw.subarray(IV_BYTES + ID_BYTES, IV_BYTES + ID_BYTES + TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, IV_BYTES + ID_BYTES)), decipher.final()]);
    const id = Number(plain.readBigUInt64BE());
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

module.exports = { decodeCursor, encodeCursor };
