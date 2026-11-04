'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');

const { TOKEN_TTL_SECONDS, issueToken, verifyToken } = require('../../src/auth');

const SECRET = 'secreto-de-pruebas-que-supera-los-32-bytes';
const NOW = 1_800_000_000;
const STANDARD_HEADER = '{"alg":"HS256","typ":"JWT"}';
const VALID_CLAIMS = { loginId: 7, tokenVersion: 0 };

const encode = (text) => Buffer.from(text).toString('base64url');

function forge({ header = STANDARD_HEADER, claims = {}, secret = SECRET, algorithm = 'sha256' } = {}) {
  const payload = { iss: 'connectus_pages', sub: 7, ver: 0, iat: NOW, exp: NOW + 3600, ...claims };
  const data = `${encode(header)}.${encode(JSON.stringify(payload))}`;
  return `${data}.${crypto.createHmac(algorithm, secret).update(data).digest('base64url')}`;
}

test('un token emitido se verifica y devuelve el id de login y la versión', () => {
  assert.deepEqual(verifyToken(issueToken(7, 3, SECRET, NOW), SECRET, NOW), { loginId: 7, tokenVersion: 3 });
});

test('la cabecera emitida es exactamente la fija y dura una hora', () => {
  const [header, payload] = issueToken(7, 0, SECRET, NOW).split('.');
  assert.equal(Buffer.from(header, 'base64url').toString(), STANDARD_HEADER);
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), {
    iss: 'connectus_pages',
    sub: 7,
    ver: 0,
    iat: NOW,
    exp: NOW + 3600,
  });
  assert.equal(TOKEN_TTL_SECONDS, 3600);
});

test('el token forjado por la prueba calza con el real, para que los rechazos midan lo que dicen', () => {
  assert.deepEqual(verifyToken(forge(), SECRET, NOW), VALID_CLAIMS);
});

test('rechaza una firma alterada', () => {
  const token = issueToken(7, 0, SECRET, NOW);
  const [header, payload, signature] = token.split('.');
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  assert.equal(verifyToken(`${header}.${payload}.${flipped}`, SECRET, NOW), null);
  assert.equal(verifyToken(`${header}.${payload}.`, SECRET, NOW), null);
  assert.equal(verifyToken(`${header}.${payload}`, SECRET, NOW), null);
});

test('rechaza otra escritura base64url de la misma firma', () => {
  const [header, payload, signature] = issueToken(7, 0, SECRET, NOW).split('.');
  // Una firma de 32 bytes deja bits sobrantes en el último carácter; esta variante decodifica igual.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(signature.at(-1));
  const variant = signature.slice(0, -1) + alphabet[last + 1];
  assert.deepEqual(Buffer.from(variant, 'base64url'), Buffer.from(signature, 'base64url'));
  assert.equal(verifyToken(`${header}.${payload}.${variant}`, SECRET, NOW), null);
});

test('rechaza un payload cambiado con la firma original', () => {
  const [header, , signature] = issueToken(7, 0, SECRET, NOW).split('.');
  const payload = encode(JSON.stringify({ iss: 'connectus_pages', sub: 1, iat: NOW, exp: NOW + 3600 }));
  assert.equal(verifyToken(`${header}.${payload}.${signature}`, SECRET, NOW), null);
});

test('rechaza alg none, con y sin firma', () => {
  const header = encode('{"alg":"none","typ":"JWT"}');
  const payload = encode(JSON.stringify({ iss: 'connectus_pages', sub: 7, iat: NOW, exp: NOW + 3600 }));
  assert.equal(verifyToken(`${header}.${payload}.`, SECRET, NOW), null);
  assert.equal(verifyToken(forge({ header: '{"alg":"none","typ":"JWT"}' }), SECRET, NOW), null);
});

test('rechaza otro alg, aunque la firma esté bien hecha', () => {
  assert.equal(verifyToken(forge({ header: '{"alg":"HS512","typ":"JWT"}', algorithm: 'sha512' }), SECRET, NOW), null);
  assert.equal(verifyToken(forge({ header: '{"alg":"RS256","typ":"JWT"}' }), SECRET, NOW), null);
});

test('exige la cabecera byte a byte, aunque sea equivalente', () => {
  assert.equal(verifyToken(forge({ header: '{"typ":"JWT","alg":"HS256"}' }), SECRET, NOW), null);
  assert.equal(verifyToken(forge({ header: '{"alg": "HS256", "typ": "JWT"}' }), SECRET, NOW), null);
  assert.equal(verifyToken(forge({ header: '{"alg":"HS256","typ":"JWT","kid":"1"}' }), SECRET, NOW), null);
});

test('rechaza un token firmado con otro secreto', () => {
  assert.equal(verifyToken(forge({ secret: 'otro-secreto-de-pruebas-tambien-largo' }), SECRET, NOW), null);
});

test('rechaza un token vencido, desde el segundo exacto de exp', () => {
  const token = issueToken(7, 0, SECRET, NOW);
  assert.deepEqual(verifyToken(token, SECRET, NOW + 3599), VALID_CLAIMS);
  assert.equal(verifyToken(token, SECRET, NOW + 3600), null);
  assert.equal(verifyToken(token, SECRET, NOW + 100000), null);
});

test('rechaza otro iss', () => {
  assert.equal(verifyToken(forge({ claims: { iss: 'otra_app' } }), SECRET, NOW), null);
  assert.equal(verifyToken(forge({ claims: { iss: undefined } }), SECRET, NOW), null);
});

for (const sub of [0, -1, 1.5, '7', null, true, [7], { id: 7 }, undefined, Number.MAX_SAFE_INTEGER + 2]) {
  test(`rechaza un sub inválido: ${JSON.stringify(sub)}`, () => {
    assert.equal(verifyToken(forge({ claims: { sub } }), SECRET, NOW), null);
  });
}

for (const ver of [-1, 1.5, '0', null, true, [0], undefined]) {
  test(`rechaza una versión inválida: ${JSON.stringify(ver)}`, () => {
    assert.equal(verifyToken(forge({ claims: { ver } }), SECRET, NOW), null);
  });
}

test('rechaza un exp o un iat que no sean enteros', () => {
  assert.equal(verifyToken(forge({ claims: { exp: String(NOW + 3600) } }), SECRET, NOW), null);
  assert.equal(verifyToken(forge({ claims: { exp: undefined } }), SECRET, NOW), null);
  assert.equal(verifyToken(forge({ claims: { iat: 'ayer' } }), SECRET, NOW), null);
});

test('rechaza un payload firmado que no es JSON de objeto', () => {
  const data = `${encode(STANDARD_HEADER)}.${encode('no es json')}`;
  const sign = (text) => crypto.createHmac('sha256', SECRET).update(text).digest('base64url');
  assert.equal(verifyToken(`${data}.${sign(data)}`, SECRET, NOW), null);
  const nullData = `${encode(STANDARD_HEADER)}.${encode('null')}`;
  assert.equal(verifyToken(`${nullData}.${sign(nullData)}`, SECRET, NOW), null);
});

test('rechaza lo que ni siquiera parece un token', () => {
  for (const value of ['', 'a', 'a.b', 'a.b.c.d', null, undefined, 7, {}]) {
    assert.equal(verifyToken(value, SECRET, NOW), null);
  }
});
