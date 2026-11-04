'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const { MIN_PART_BYTES, createDiskStorage, createS3Storage, createStorage } = require('../../src/storage');

const hasSdk = (() => {
  try {
    require.resolve('@aws-sdk/client-s3');
    return true;
  } catch {
    return false;
  }
})();

const KEY = `exports/${'a'.repeat(32)}`;
const ENV = { EXPORTS_BUCKET: 'mi-bucket', AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', AWS_SECRET_ACCESS_KEY: 'clave-de-ejemplo' };

function fakeClient(replies = {}) {
  const sent = [];
  return {
    sent,
    async send(command) {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      const reply = replies[name];
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(command.input) : reply ?? {};
    },
  };
}

describe('almacén S3', { skip: hasSdk ? false : 'falta @aws-sdk/client-s3' }, () => {
  it('sin bucket o sin región no arranca', () => {
    assert.throws(() => createS3Storage({ env: { AWS_REGION: 'r' } }), { code: 'config_missing_variable' });
    assert.throws(() => createS3Storage({ env: { EXPORTS_BUCKET: 'b' } }), { code: 'config_missing_variable' });
  });

  it('manda a S3 lo que corresponde, siempre con su bucket', async () => {
    const client = fakeClient({
      CreateMultipartUploadCommand: { UploadId: 'u1' },
      UploadPartCommand: { ETag: '"e1"' },
    });
    const storage = createS3Storage({ env: ENV, client });
    assert.equal(await storage.createUpload({ key: KEY, contentType: 'text/csv' }), 'u1');
    assert.equal(await storage.uploadPart({ key: KEY, uploadId: 'u1', partNumber: 2, body: Buffer.from('x') }), '"e1"');
    await storage.completeUpload({ key: KEY, uploadId: 'u1', objectSize: 9, parts: [{ partNumber: 1, size: 9, etag: '"e1"' }] });
    await storage.abortUpload({ key: KEY, uploadId: 'u1' });
    assert.deepEqual(client.sent.map(({ name }) => name), [
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
      'AbortMultipartUploadCommand',
    ]);
    assert.ok(client.sent.every(({ input }) => input.Bucket === 'mi-bucket' && input.Key === KEY));
    assert.equal(client.sent[1].input.PartNumber, 2);
    assert.deepEqual(client.sent[2].input.MultipartUpload, { Parts: [{ PartNumber: 1, ETag: '"e1"' }] });
    assert.equal(client.sent[2].input.MpuObjectSize, 9);
  });

  it('listParts recorre todas las páginas', async () => {
    const client = fakeClient({
      ListPartsCommand: ({ PartNumberMarker }) => (PartNumberMarker === undefined
        ? { Parts: [{ PartNumber: 1, Size: 5, ETag: 'a' }], IsTruncated: true, NextPartNumberMarker: '1' }
        : { Parts: [{ PartNumber: 2, Size: 6, ETag: 'b' }], IsTruncated: false }),
    });
    const parts = await createS3Storage({ env: ENV, client }).listParts({ key: KEY, uploadId: 'u' });
    assert.deepEqual(parts, [{ partNumber: 1, size: 5, etag: 'a' }, { partNumber: 2, size: 6, etag: 'b' }]);
  });

  it('abortar tolera que la carga ya no exista, y nada más', async () => {
    const missing = Object.assign(new Error('x'), { name: 'NoSuchUpload' });
    await createS3Storage({ env: ENV, client: fakeClient({ AbortMultipartUploadCommand: missing }) }).abortUpload({ key: KEY, uploadId: 'u' });
    const notFound = Object.assign(new Error('x'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    await createS3Storage({ env: ENV, client: fakeClient({ AbortMultipartUploadCommand: notFound }) }).abortUpload({ key: KEY, uploadId: 'u' });
    const slow = Object.assign(new Error('x'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } });
    await assert.rejects(createS3Storage({ env: ENV, client: fakeClient({ AbortMultipartUploadCommand: slow }) }).abortUpload({ key: KEY, uploadId: 'u' }), { name: 'SlowDown' });
  });

  it('HeadObject: sin s3:ListBucket, un objeto que no existe da 403', async () => {
    const head = (reply) => createS3Storage({ env: ENV, client: fakeClient({ HeadObjectCommand: reply }) }).headObject(KEY);
    assert.deepEqual(await head({ ContentLength: 12 }), { size: 12 });
    assert.equal(await head(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 404 } })), null);
    assert.equal(await head(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 403 } })), null);
    await assert.rejects(head(Object.assign(new Error('x'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } })), { name: 'SlowDown' });
  });
});

describe('downloadUrl de S3', () => {
  it('firma con las credenciales de las variables de Lambda, y sin cargar el SDK', () => {
    const url = createS3Storage({ env: { ...ENV, AWS_SESSION_TOKEN: 'token' }, client: {}, clock: () => 0 }).downloadUrl({ key: KEY, filename: 'a.csv' });
    assert.ok(url.startsWith(`https://mi-bucket.s3.us-west-2.amazonaws.com/${KEY}?`));
    assert.ok(url.includes('X-Amz-Security-Token=token'));
    assert.ok(url.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(!url.includes('clave-de-ejemplo'));
  });
});

describe('almacén en disco', () => {
  let dir;
  let storage;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-disco-'));
    storage = createDiskStorage(dir, 'http://localhost/');
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const part = (bytes, fill = 'x') => Buffer.alloc(bytes, fill);

  async function uploadWith(...bodies) {
    const uploadId = await storage.createUpload({ key: KEY });
    const parts = [];
    for (const [index, body] of bodies.entries()) {
      const etag = await storage.uploadPart({ key: KEY, uploadId, partNumber: index + 1, body });
      parts.push({ partNumber: index + 1, size: body.length, etag });
    }
    return { uploadId, parts };
  }

  it('como S3: una parte que no es la última con menos de 5 MiB da EntityTooSmall', async () => {
    const { uploadId, parts } = await uploadWith(part(MIN_PART_BYTES - 1), part(1));
    await assert.rejects(
      storage.completeUpload({ key: KEY, uploadId, parts, objectSize: MIN_PART_BYTES }),
      { name: 'EntityTooSmall' }
    );
    await storage.abortUpload({ key: KEY, uploadId });
  });

  it('completa con 5 MiB justos y una última chica, y el objeto trae las partes en orden', async () => {
    const { uploadId, parts } = await uploadWith(part(MIN_PART_BYTES, 'a'), part(3, 'b'));
    await storage.completeUpload({ key: KEY, uploadId, parts, objectSize: MIN_PART_BYTES + 3 });
    assert.deepEqual(await storage.headObject(KEY), { size: MIN_PART_BYTES + 3 });
    assert.equal(fs.readFileSync(storage.objectPath(KEY)).subarray(-4).toString(), 'abbb');
    await assert.rejects(storage.listParts({ key: KEY, uploadId }), { name: 'NoSuchUpload' });
    fs.rmSync(storage.objectPath(KEY));
  });

  it('el tamaño declarado debe calzar, y una parte con otro ETag no entra', async () => {
    const { uploadId, parts } = await uploadWith(part(4));
    await assert.rejects(storage.completeUpload({ key: KEY, uploadId, parts, objectSize: 5 }), { name: 'InvalidRequest' });
    await assert.rejects(storage.completeUpload({ key: KEY, uploadId, parts: [{ ...parts[0], etag: 'otro' }], objectSize: 4 }), { name: 'InvalidPart' });
    await storage.abortUpload({ key: KEY, uploadId });
  });

  it('subir el mismo número reemplaza la parte, y una carga abortada da NoSuchUpload', async () => {
    const uploadId = await storage.createUpload({ key: KEY });
    await storage.uploadPart({ key: KEY, uploadId, partNumber: 1, body: part(1) });
    await storage.uploadPart({ key: KEY, uploadId, partNumber: 1, body: part(2) });
    assert.equal((await storage.listParts({ key: KEY, uploadId }))[0].size, 2);
    await storage.abortUpload({ key: KEY, uploadId });
    await storage.abortUpload({ key: KEY, uploadId });
    await assert.rejects(storage.uploadPart({ key: KEY, uploadId, partNumber: 1, body: part(1) }), { name: 'NoSuchUpload' });
  });

  it('no sale de su directorio', async () => {
    assert.throws(() => storage.objectPath('exports/../../fuera'), { name: 'InvalidKey' });
    assert.throws(() => storage.downloadUrl({ key: '../fuera', filename: 'x' }), { name: 'InvalidKey' });
    await assert.rejects(storage.uploadPart({ uploadId: '../fuera', partNumber: 1, body: part(1) }), { name: 'NoSuchUpload' });
    assert.equal(await storage.headObject(KEY), null);
  });

  it('la URL local lleva el nombre codificado', () => {
    assert.equal(storage.downloadUrl({ key: KEY, filename: 'Envío 1.xlsx' }), `http://localhost/${KEY}?filename=Env%C3%ADo%201.xlsx`);
  });
});

describe('createStorage', () => {
  it('en local usa el disco, y si no, S3', () => {
    assert.equal(typeof createStorage({ STAGE: 'local', EXPORTS_DIR: '/x' }).objectPath, 'function');
    assert.equal(createStorage(ENV).objectPath, undefined);
  });
});
