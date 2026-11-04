'use strict';

const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { writeAudit } = require('./db');
const { verifyLink } = require('./link');

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const SCRYPT_OPTIONS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt\$32768\$8\$1\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;
const HASH_PREFIX = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}`;

// No es la huella de ninguna clave: solo da algo contra qué calcular el scrypt cuando no hay un hash
// real que comparar, para que el tiempo de respuesta no delate qué usuarios existen.
const DUMMY_HASH = `${HASH_PREFIX}$${Buffer.alloc(SALT_BYTES, 0x5a).toString('base64')}`
  + `$${Buffer.alloc(KEY_BYTES, 0xa5).toString('base64')}`;

const TOKEN_ISSUER = 'connectus_pages';
const TOKEN_TTL_SECONDS = 3600;
const TOKEN_HEADER = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;
const MAX_PASSWORD_LENGTH = 256;

// Toda falla tarda al menos esto, para que la escritura extra de un usuario existente no se note. Tiene
// que superar el peor caso normal en Lambda, donde 256 MB dan menos de un sexto de vCPU para el scrypt.
const LOGIN_FAILURE_FLOOR_MS = 1500;

// El usuario se compara en SQL para conservar la intercalación de la columna, igual que un WHERE username = ?.
const SELECT_LOGIN_OF_LINK = 'SELECT id, password_hash, active, token_version, link_version, '
  + '(username = ?) AS username_ok, '
  + '(locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()) AS locked '
  + 'FROM connectus_pages.login WHERE id = ? LIMIT 1';
const SELECT_LOGIN_BY_ID = 'SELECT id, active, token_version FROM connectus_pages.login WHERE id = ? LIMIT 1';
// MySQL evalúa el SET de izquierda a derecha: locked_until tiene que leer failed_attempts antes de
// que se reinicie.
const REGISTER_FAILURE = 'UPDATE connectus_pages.login '
  + 'SET locked_until = IF(failed_attempts + 1 >= 5, UTC_TIMESTAMP() + INTERVAL 15 MINUTE, locked_until), '
  + 'failed_attempts = IF(failed_attempts + 1 >= 5, 0, failed_attempts + 1) WHERE id = ?';
const REGISTER_SUCCESS = 'UPDATE connectus_pages.login '
  + 'SET failed_attempts = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?';
const SELECT_ACCOUNTS = 'SELECT a.id, a.name FROM connectus_pages.login_account la '
  + 'JOIN connectus_pages.account a ON a.id = la.id_account WHERE la.id_login = ? ORDER BY a.name, a.id';
const SELECT_ACCOUNT_MEMBERSHIP = 'SELECT 1 AS allowed FROM connectus_pages.login_account '
  + 'WHERE id_login = ? AND id_account = ? LIMIT 1';

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_BYTES, SCRYPT_OPTIONS, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt);
  return `${HASH_PREFIX}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseHash(stored) {
  const match = typeof stored === 'string' ? HASH_PATTERN.exec(stored) : null;
  if (!match) return null;
  const salt = Buffer.from(match[1], 'base64');
  const key = Buffer.from(match[2], 'base64');
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return null;
  return { salt, key };
}

// Un hash malformado también gasta su scrypt: no debe distinguirse de una clave incorrecta.
async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  const { salt, key } = parsed || parseHash(DUMMY_HASH);
  const derived = await deriveKey(password, salt);
  return crypto.timingSafeEqual(derived, key) && parsed !== null;
}

function signToken(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function issueToken(loginId, tokenVersion, secret, nowSeconds) {
  const claims = {
    iss: TOKEN_ISSUER,
    sub: loginId,
    ver: tokenVersion,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };
  const data = `${TOKEN_HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${data}.${signToken(data, secret)}`;
}

function parseClaims(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Devuelve { loginId, tokenVersion }, o null si el token no vale.
function verifyToken(token, secret, nowSeconds) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (header !== TOKEN_HEADER) return null;

  // Se compara el texto y no los bytes decodificados: base64url admite más de una escritura para la
  // misma firma, y así un token alterado en el último carácter no pasa.
  const expected = Buffer.from(signToken(`${header}.${payload}`, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  const claims = parseClaims(payload);
  if (claims === null || typeof claims !== 'object') return null;
  if (claims.iss !== TOKEN_ISSUER) return null;
  if (!Number.isSafeInteger(claims.sub) || claims.sub <= 0) return null;
  if (!Number.isSafeInteger(claims.ver) || claims.ver < 0) return null;
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return null;
  if (nowSeconds >= claims.exp) return null;
  return { loginId: claims.sub, tokenVersion: claims.ver };
}

function nowInSeconds(clock) {
  return Math.floor(clock() / 1000);
}

function parseLoginBody(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

// Un rechazo aquí no toca la base ni calcula un scrypt: sin el enlace, nadie gasta más que esta comparación. Tampoco se audita,
// porque sería una escritura por petición a voluntad de cualquiera, y el enlace nunca se registra.
function acceptLink(link, config, clock) {
  const verified = verifyLink(link, config.linkSecrets, nowInSeconds(clock));
  if (verified.ok) return verified;
  console.error(JSON.stringify({ event: 'link_rejected', reason: verified.reason }));
  return null;
}

function parseCredentials({ username, password }) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (!USERNAME_PATTERN.test(username)) return null;
  if (password.length < 1 || password.length > MAX_PASSWORD_LENGTH) return null;
  return { username, password };
}

function isActive(row) {
  return Number(row.active) === 1;
}

async function holdFailure(startedAt, floorMs) {
  const elapsed = performance.now() - startedAt;
  if (elapsed < floorMs) {
    await sleep(floorMs - elapsed);
  } else if (floorMs > 0) {
    console.error(JSON.stringify({ event: 'login_floor_exceeded', elapsedMs: Math.round(elapsed) }));
  }
}

// Un enlace bien firmado que no sirve es la señal de que se filtró o quedó viejo: además de la auditoría, va a una alarma.
async function auditSuspectLink(db, idLogin, detail, ip) {
  console.error(JSON.stringify({ event: 'link_suspect', detail }));
  await writeAudit(db, { idLogin, action: 'login_fail', detail, ip });
}

function linkAuditDetail({ slot, linkVersion, exp }) {
  return `enlace ${slot} v${linkVersion} vence ${new Date(exp * 1000).toISOString().slice(0, 10)}`;
}

// Devuelve { session }, o { failure } con el código de error. Un enlace revocado no pasa por el scrypt ni por el piso: dormir
// retendría un cupo de la Lambda, y no hay nada que esconder, porque se decide antes de mirar al usuario. Un usuario que no calza
// sí, y no suma un fallo: quien tiene un enlace y prueba otros usuarios no bloquea a nadie.
async function login({ db, config, clock, link, username, password, ip, failureFloorMs = LOGIN_FAILURE_FLOOR_MS }) {
  const startedAt = performance.now();
  const [row] = await db.query(SELECT_LOGIN_OF_LINK, [username, link.loginId]);
  if (!row || Number(row.link_version) !== link.linkVersion) {
    await auditSuspectLink(db, link.loginId, 'enlace_revocado', ip);
    return { failure: 'invalid_link' };
  }

  const usernameMatches = Number(row.username_ok) === 1;
  const canEnter = usernameMatches && isActive(row) && Number(row.locked) !== 1;
  const matches = await verifyPassword(password, canEnter ? row.password_hash : DUMMY_HASH);

  if (!canEnter || !matches) {
    if (canEnter) await db.write(REGISTER_FAILURE, [row.id]);
    if (usernameMatches) await writeAudit(db, { idLogin: row.id, action: 'login_fail', ip });
    else await auditSuspectLink(db, row.id, 'usuario_no_coincide', ip);
    await holdFailure(startedAt, failureFloorMs);
    return { failure: 'invalid_credentials' };
  }

  await db.write(REGISTER_SUCCESS, [row.id]);
  const accounts = await listLoginAccounts(db, row.id);
  await writeAudit(db, { idLogin: row.id, action: 'login_ok', detail: linkAuditDetail(link), ip });
  return {
    session: {
      token: issueToken(Number(row.id), Number(row.token_version), config.tokenSecret, nowInSeconds(clock)),
      expiresIn: TOKEN_TTL_SECONDS,
      accounts: accounts.map(({ id, name }) => ({ id: Number(id), name })),
    },
  };
}

// Relee el login en cada petición para que revocar un acceso tenga efecto inmediato. No mira el bloqueo:
// ese frena adivinar claves en el login, y si cortara también las sesiones abiertas, cualquiera que supiera
// un nombre de usuario podría expulsarlo sin tener ninguna credencial.
async function authenticate({ db, config, clock, authorization }) {
  const match = /^Bearer (\S+)$/.exec(authorization || '');
  if (!match) return null;
  const claims = verifyToken(match[1], config.tokenSecret, nowInSeconds(clock));
  if (claims === null) return null;
  const [row] = await db.query(SELECT_LOGIN_BY_ID, [claims.loginId]);
  if (!row || !isActive(row) || Number(row.token_version) !== claims.tokenVersion) return null;
  return claims.loginId;
}

function listLoginAccounts(db, loginId) {
  return db.query(SELECT_ACCOUNTS, [loginId]);
}

async function loginHasAccount(db, loginId, accountId) {
  const rows = await db.query(SELECT_ACCOUNT_MEMBERSHIP, [loginId, accountId]);
  return rows.length > 0;
}

module.exports = {
  DUMMY_HASH,
  LOGIN_FAILURE_FLOOR_MS,
  TOKEN_TTL_SECONDS,
  acceptLink,
  authenticate,
  hashPassword,
  issueToken,
  listLoginAccounts,
  login,
  loginHasAccount,
  parseCredentials,
  parseLoginBody,
  verifyPassword,
  verifyToken,
};
