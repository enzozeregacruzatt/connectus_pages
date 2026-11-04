'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { DOWNLOAD_EXPIRES_SECONDS, contentDisposition, encodeRfc3986, presignDownload, presignGet } = require('../../src/presign');

// La clave de ejemplo que publica AWS en su documentación.
const EXAMPLE_CREDENTIALS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

test('calza con el ejemplo publicado por AWS', () => {
  const url = presignGet({
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    region: 'us-east-1',
    credentials: EXAMPLE_CREDENTIALS,
    expiresIn: 86400,
    nowMs: Date.parse('2013-05-24T00:00:00Z'),
  });
  assert.equal(new URL(url).searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

// Vector generado una vez con @smithy/signature-v4 y dejado fijo, con filename*, í y un token de sesión con caracteres raros.
test('calza con el vector congelado del SDK', () => {
  const url = presignDownload({
    bucket: 'mi-bucket',
    key: `exports/${'b'.repeat(32)}`,
    region: 'us-west-2',
    credentials: { ...EXAMPLE_CREDENTIALS, sessionToken: "token/de+ejemplo=con'raros*(y)!" },
    filename: 'Reporte_de_envío_19-11-2026_bbbbbbbb.xlsx',
    nowMs: Date.parse('2026-11-20T15:04:05Z'),
  });
  assert.equal(new URL(url).searchParams.get('X-Amz-Signature'), '165d0b645a61a4aa0718d0b4db87b6a052f90a5580103f1e671d455b47e890c5');
  assert.equal(new URL(url).hostname, 'mi-bucket.s3.us-west-2.amazonaws.com');
  assert.equal(new URL(url).pathname, `/exports/${'b'.repeat(32)}`);
  assert.ok(url.includes('X-Amz-Security-Token=token%2Fde%2Bejemplo%3Dcon%27raros%2A%28y%29%21'));
  assert.ok(url.includes('response-cache-control=private%2C%20no-store'));
  assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), String(DOWNLOAD_EXPIRES_SECONDS));
  assert.equal(DOWNLOAD_EXPIRES_SECONDS, 300);
});

test('la codificación es RFC 3986 estricta', () => {
  assert.equal(encodeRfc3986("a b*c'd(e)f!g~h-i_j.k/l"), 'a%20b%2Ac%27d%28e%29f%21g~h-i_j.k%2Fl');
  assert.equal(encodeRfc3986('í'), '%C3%AD');
});

test('el nombre va en ASCII y en UTF-8, y no se puede salir del parámetro', () => {
  assert.equal(
    contentDisposition('Reporte_de_envío.xlsx'),
    "attachment; filename=\"Reporte_de_envio.xlsx\"; filename*=UTF-8''Reporte_de_env%C3%ADo.xlsx"
  );
  assert.ok(contentDisposition('a"b\\c\r\n.csv').startsWith('attachment; filename="a_b_c__.csv"'));
});

test('sin token de sesión no agrega el parámetro', () => {
  const url = presignGet({ host: 'h', path: '/k', region: 'r', credentials: EXAMPLE_CREDENTIALS, expiresIn: 1, nowMs: 0 });
  assert.ok(!url.includes('X-Amz-Security-Token'));
});
