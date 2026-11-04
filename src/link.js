'use strict';

// Solo depende de node:crypto: scripts/crear_enlace.js lo usa desde un computador, sin cargar mysql2.
const crypto = require('node:crypto');

const LINK_PREFIX = 'l1';
const SIGNING_DOMAIN = 'connectus_pages/link/v1\n';
// Una sola escritura posible por enlace: sin ceros a la izquierda, sin relleno y sin nada alrededor.
const LINK_PATTERN = /^(l1\.([ab])\.([1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.([1-9][0-9]{9}))\.([A-Za-z0-9_-]{43})$/;
const MAX_INT = 2147483647;
const DAY_SECONDS = 86400;
const MAX_LINK_DAYS = 365;
const MIN_LINK_SECRET_BYTES = 32;

function linkSignature(body, secret) {
  return crypto.createHmac('sha256', secret).update(SIGNING_DOMAIN + body).digest('base64url');
}

function signLink({ slot, loginId, linkVersion, exp }, secret) {
  const body = `${LINK_PREFIX}.${slot}.${loginId}.${linkVersion}.${exp}`;
  return `${body}.${linkSignature(body, secret)}`;
}

const rejected = (reason) => ({ ok: false, reason });

// Devuelve { ok: true, slot, loginId, linkVersion, exp }, o { ok: false, reason } con un motivo de lista cerrada que se puede
// registrar. Los valores se miran después de la firma, y el vencimiento se exige aquí también: un descuido al emitir no deja
// un enlace eterno.
function verifyLink(link, secrets, nowSeconds) {
  const match = typeof link === 'string' ? LINK_PATTERN.exec(link) : null;
  if (!match) return rejected('malformed');
  const [, body, slot, loginText, versionText, expText, signature] = match;

  const secret = secrets[slot];
  if (!secret) return rejected('unknown_slot');

  // Se compara el texto y no los bytes decodificados: base64url admite más de una escritura para la misma firma.
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(linkSignature(body, secret)))) {
    return rejected('bad_signature');
  }

  const loginId = Number(loginText);
  const linkVersion = Number(versionText);
  const exp = Number(expText);
  if (loginId > MAX_INT || linkVersion > MAX_INT || exp > MAX_INT) return rejected('out_of_range');
  if (nowSeconds >= exp) return rejected('expired');
  if (exp - nowSeconds > MAX_LINK_DAYS * DAY_SECONDS) return rejected('too_long');
  return { ok: true, slot, loginId, linkVersion, exp };
}

module.exports = { DAY_SECONDS, MAX_INT, MAX_LINK_DAYS, MIN_LINK_SECRET_BYTES, signLink, verifyLink };
