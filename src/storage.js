'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { configError } = require('./config');
const { presignDownload } = require('./presign');

const CONNECTION_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 120000;
const MIN_PART_BYTES = 5 * 1024 * 1024;
const KEY_PATTERN = /^exports\/[0-9a-f]{32}$/;
const UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/;

function storageError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

function s3Credentials(env) {
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  };
}

// El SDK lo pone el runtime de Lambda: se carga recién al usarlo, y la app lo usa solo para revisar que el objeto exista antes de firmar.
function buildS3Client(region) {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region,
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
    // Sin esto, según la versión del SDK del runtime, cada parte lleva su propia suma, y completar la carga exige repetirlas todas.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function createS3Storage({ env = process.env, client: givenClient, clock = Date.now } = {}) {
  const bucket = env.EXPORTS_BUCKET;
  const region = env.AWS_REGION;
  if (!bucket || !region) throw configError('config_missing_variable');
  let client = givenClient;

  function send(commandName, input) {
    const commands = require('@aws-sdk/client-s3');
    client ??= buildS3Client(region);
    return client.send(new commands[commandName]({ Bucket: bucket, ...input }));
  }

  return {
    async createUpload({ key, contentType }) {
      const { UploadId } = await send('CreateMultipartUploadCommand', { Key: key, ContentType: contentType });
      return UploadId;
    },
    async uploadPart({ key, uploadId, partNumber, body }) {
      const { ETag } = await send('UploadPartCommand', { Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body });
      return ETag;
    },
    async listParts({ key, uploadId }) {
      const parts = [];
      let marker;
      for (;;) {
        const page = await send('ListPartsCommand', { Key: key, UploadId: uploadId, PartNumberMarker: marker });
        for (const { PartNumber, Size, ETag } of page.Parts ?? []) parts.push({ partNumber: PartNumber, size: Size, etag: ETag });
        if (!page.IsTruncated) return parts;
        marker = page.NextPartNumberMarker;
      }
    },
    async completeUpload({ key, uploadId, parts, objectSize }) {
      await send('CompleteMultipartUploadCommand', {
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })) },
        MpuObjectSize: objectSize,
      });
    },
    async abortUpload({ key, uploadId }) {
      try {
        await send('AbortMultipartUploadCommand', { Key: key, UploadId: uploadId });
      } catch (error) {
        if (error.name !== 'NoSuchUpload' && error.$metadata?.httpStatusCode !== 404) throw error;
      }
    },
    // Sin s3:ListBucket, que este rol no tiene, S3 responde 403 y no 404 por un objeto que no existe.
    async headObject(key) {
      try {
        const { ContentLength } = await send('HeadObjectCommand', { Key: key });
        return { size: ContentLength };
      } catch (error) {
        if ([403, 404].includes(error.$metadata?.httpStatusCode)) return null;
        throw error;
      }
    },
    downloadUrl({ key, filename }) {
      return presignDownload({ bucket, key, region, credentials: s3Credentials(env), filename, nowMs: clock() });
    },
  };
}

// Para probar sin AWS, bajo un directorio temporal. Se comporta como S3 en lo que le importa al trabajador: completar exige partes
// ascendentes de al menos 5 MiB salvo la última, una carga que ya no existe da NoSuchUpload, y volver a subir un número lo reemplaza.
function createDiskStorage(dir, baseUrl = '') {
  const uploadDir = (uploadId) => {
    if (!UPLOAD_ID_PATTERN.test(uploadId)) throw storageError('NoSuchUpload');
    return path.join(dir, 'uploads', uploadId);
  };
  const objectPath = (key) => {
    if (!KEY_PATTERN.test(key)) throw storageError('InvalidKey');
    return path.join(dir, key);
  };
  const partPath = (uploadId, partNumber) => path.join(uploadDir(uploadId), String(partNumber));

  async function assertUpload(uploadId) {
    try {
      await fs.access(uploadDir(uploadId));
    } catch {
      throw storageError('NoSuchUpload');
    }
  }

  async function readParts(uploadId) {
    await assertUpload(uploadId);
    const names = await fs.readdir(uploadDir(uploadId));
    const parts = await Promise.all(names.map(async (name) => {
      const body = await fs.readFile(path.join(uploadDir(uploadId), name));
      return { partNumber: Number(name), size: body.length, etag: crypto.createHash('md5').update(body).digest('hex') };
    }));
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  return {
    objectPath,
    async createUpload({ key }) {
      objectPath(key);
      const uploadId = crypto.randomBytes(16).toString('hex');
      await fs.mkdir(uploadDir(uploadId), { recursive: true });
      return uploadId;
    },
    async uploadPart({ uploadId, partNumber, body }) {
      await assertUpload(uploadId);
      await fs.writeFile(partPath(uploadId, partNumber), body);
      return crypto.createHash('md5').update(body).digest('hex');
    },
    listParts: ({ uploadId }) => readParts(uploadId),
    async completeUpload({ key, uploadId, parts, objectSize }) {
      const stored = new Map((await readParts(uploadId)).map((part) => [part.partNumber, part]));
      let total = 0;
      parts.forEach(({ partNumber, etag }, index) => {
        const part = stored.get(partNumber);
        if (!part || part.etag !== etag) throw storageError('InvalidPart');
        if (index > 0 && parts[index - 1].partNumber >= partNumber) throw storageError('InvalidPartOrder');
        if (index < parts.length - 1 && part.size < MIN_PART_BYTES) throw storageError('EntityTooSmall');
        total += part.size;
      });
      if (total !== objectSize) throw storageError('InvalidRequest');

      const target = objectPath(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rm(target, { force: true });
      for (const { partNumber } of parts) await fs.appendFile(target, await fs.readFile(partPath(uploadId, partNumber)));
      await fs.rm(uploadDir(uploadId), { recursive: true, force: true });
    },
    async abortUpload({ uploadId }) {
      await fs.rm(uploadDir(uploadId), { recursive: true, force: true });
    },
    async headObject(key) {
      try {
        const { size } = await fs.stat(objectPath(key));
        return { size };
      } catch {
        return null;
      }
    },
    downloadUrl({ key, filename }) {
      objectPath(key);
      return `${baseUrl}${key}?filename=${encodeURIComponent(filename)}`;
    },
  };
}

function createStorage(env = process.env) {
  if (env.STAGE === 'local') return createDiskStorage(env.EXPORTS_DIR, env.EXPORTS_BASE_URL);
  return createS3Storage({ env });
}

module.exports = { MIN_PART_BYTES, createDiskStorage, createS3Storage, createStorage };
