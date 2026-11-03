'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const { loadConfig } = require('../../src/config');

const LONG_SECRET = 's'.repeat(32);
const PREFIX = '/connectus-pages/prod/';

function parameters(overrides = {}) {
  const values = {
    db_host: 'db.invalid',
    db_user: 'pages_app',
    db_password: 'clave-falsa',
    token_secret: LONG_SECRET,
    frame_ancestors: 'https://embed.example.com',
    ...overrides,
  };
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ({ Name: PREFIX + name, Value: value }));
}

const localEnv = (overrides = {}) => ({
  STAGE: 'local',
  DB_HOST: '127.0.0.1',
  DB_PORT: '33077',
  DB_USER: 'pages_app',
  DB_PASSWORD: 'clave-falsa',
  DB_SSL_CA_FILE: '/ruta/ca.pem',
  TOKEN_SECRET: LONG_SECRET,
  FRAME_ANCESTORS: 'http://127.0.0.1:8788',
  ...overrides,
});

test('fuera de local lee Parameter Store bajo el prefijo del contrato', async () => {
  const requested = [];
  const config = await loadConfig({
    env: { STAGE: 'prod' },
    fetchParameters: async (names) => {
      requested.push(...names);
      return parameters();
    },
  });
  assert.deepEqual(requested.sort(), [
    `${PREFIX}db_host`,
    `${PREFIX}db_password`,
    `${PREFIX}db_user`,
    `${PREFIX}frame_ancestors`,
    `${PREFIX}token_secret`,
  ]);
  assert.equal(config.stage, 'prod');
  assert.deepEqual(config.db, { host: 'db.invalid', port: 3306, user: 'pages_app', password: 'clave-falsa' });
  assert.equal(config.tokenSecret, LONG_SECRET);
  assert.equal(config.frameAncestors, 'https://embed.example.com');
});

test('fuera de local ignora las variables de entorno locales', async () => {
  const config = await loadConfig({
    env: { ...localEnv(), STAGE: 'prod', TOKEN_SECRET: 'x'.repeat(64) },
    fetchParameters: async () => parameters(),
  });
  assert.equal(config.db.host, 'db.invalid');
  assert.equal(config.tokenSecret, LONG_SECRET);
  assert.equal(config.db.sslCaFile, undefined);
  assert.equal(config.frameAncestors, 'https://embed.example.com');
});

test('solo STAGE=local exacto activa la rama local', async () => {
  for (const STAGE of [undefined, '', 'LOCAL', 'local ', 'dev', 'test']) {
    const config = await loadConfig({
      env: { ...localEnv(), STAGE },
      fetchParameters: async () => parameters(),
    });
    assert.equal(config.stage, 'prod', `STAGE=${JSON.stringify(STAGE)}`);
  }
});

test('sin frame_ancestors la app arranca, con el valor vacío', async () => {
  const config = await loadConfig({
    env: { STAGE: 'prod' },
    fetchParameters: async () => parameters({ frame_ancestors: undefined }),
  });
  assert.equal(config.frameAncestors, '');
});

for (const name of ['db_host', 'db_user', 'db_password', 'token_secret']) {
  test(`sin ${name} la app no arranca`, async () => {
    await assert.rejects(
      loadConfig({ env: { STAGE: 'prod' }, fetchParameters: async () => parameters({ [name]: undefined }) }),
      { code: 'config_missing_parameter' }
    );
  });
}

test('un token_secret de menos de 32 bytes no deja arrancar', async () => {
  await assert.rejects(
    loadConfig({ env: { STAGE: 'prod' }, fetchParameters: async () => parameters({ token_secret: 's'.repeat(31) }) }),
    { code: 'config_token_secret_too_short' }
  );
  await assert.rejects(loadConfig({ env: localEnv({ TOKEN_SECRET: 's'.repeat(31) }) }), {
    code: 'config_token_secret_too_short',
  });
});

test('el largo del token_secret se mide en bytes', async () => {
  const config = await loadConfig({
    env: { STAGE: 'prod' },
    fetchParameters: async () => parameters({ token_secret: 'ñ'.repeat(16) }),
  });
  assert.equal(Buffer.byteLength(config.tokenSecret), 32);
});

test('el error de configuración no incluye valores', async () => {
  await assert.rejects(
    loadConfig({ env: { STAGE: 'prod' }, fetchParameters: async () => parameters({ token_secret: 'corto-secreto' }) }),
    (error) => !error.message.includes('corto-secreto')
  );
});

test('STAGE=local usa las variables de entorno y no llama a Parameter Store', async () => {
  const config = await loadConfig({
    env: localEnv(),
    fetchParameters: async () => {
      throw new Error('no debía llamarse');
    },
  });
  assert.deepEqual(config, {
    stage: 'local',
    db: { host: '127.0.0.1', port: 33077, user: 'pages_app', password: 'clave-falsa', sslCaFile: '/ruta/ca.pem' },
    tokenSecret: LONG_SECRET,
    frameAncestors: 'http://127.0.0.1:8788',
  });
});

for (const name of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_SSL_CA_FILE', 'TOKEN_SECRET']) {
  test(`en local, sin ${name} no arranca`, async () => {
    await assert.rejects(loadConfig({ env: localEnv({ [name]: undefined }) }), { code: 'config_missing_variable' });
  });
}

test('en local, un puerto que no es número no arranca', async () => {
  await assert.rejects(loadConfig({ env: localEnv({ DB_PORT: 'abc' }) }), { code: 'config_invalid_port' });
});

test('cargar los módulos no carga el SDK de AWS', () => {
  const source = path.join(__dirname, '..', '..', 'src', 'handler.js');
  const script = `
    require(${JSON.stringify(source)});
    const loaded = Object.keys(require.cache).filter((file) => file.includes('@aws-sdk'));
    process.stdout.write(String(loaded.length));
  `;
  assert.equal(execFileSync(process.execPath, ['-e', script]).toString(), '0');
});
