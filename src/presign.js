'use strict';

const crypto = require('node:crypto');

const DOWNLOAD_EXPIRES_SECONDS = 300;
const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

// encodeURIComponent no escapa estos, y S3 sí los escapa al calcular la firma.
function encodeRfc3986(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest();
const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function signingKey(secret, day, region) {
  return ['s3', 'aws4_request'].reduce(hmac, hmac(hmac(`AWS4${secret}`, day), region));
}

// URL prefirmada de un GET en S3, con SigV4 en la query. Sin el presigner del SDK: no consta que venga en el runtime de Lambda.
function presignGet({ host, path, region, credentials, query = {}, expiresIn, nowMs }) {
  const timestamp = new Date(nowMs).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const signed = {
    ...query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': timestamp,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  if (credentials.sessionToken) signed['X-Amz-Security-Token'] = credentials.sessionToken;

  const queryText = Object.entries(signed)
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .sort()
    .join('&');
  const encodedPath = path.split('/').map(encodeRfc3986).join('/');
  const canonicalRequest = ['GET', encodedPath, queryText, `host:${host}`, '', 'host', UNSIGNED_PAYLOAD].join('\n');
  const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(credentials.secretAccessKey, day, region), stringToSign).toString('hex');
  return `https://${host}${encodedPath}?${queryText}&X-Amz-Signature=${signature}`;
}

// El nombre ASCII es para el cliente que no entienda filename*, y sin comillas ni barras no se puede salir del parámetro.
function contentDisposition(filename) {
  const ascii = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc3986(filename)}`;
}

function presignDownload({ bucket, key, region, credentials, filename, nowMs }) {
  return presignGet({
    host: `${bucket}.s3.${region}.amazonaws.com`,
    path: `/${key}`,
    region,
    credentials,
    query: {
      'response-cache-control': 'private, no-store',
      'response-content-disposition': contentDisposition(filename),
    },
    expiresIn: DOWNLOAD_EXPIRES_SECONDS,
    nowMs,
  });
}

module.exports = { DOWNLOAD_EXPIRES_SECONDS, contentDisposition, encodeRfc3986, presignDownload, presignGet };
