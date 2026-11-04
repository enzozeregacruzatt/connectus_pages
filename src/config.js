'use strict';

const { MIN_LINK_SECRET_BYTES } = require('./link');

const PARAMETER_PREFIX = '/connectus-pages/prod/';
const REQUIRED_PARAMETERS = ['db_host', 'db_user', 'db_password', 'token_secret'];
const OPTIONAL_PARAMETERS = ['frame_ancestors', 'cors_opaque', 'link_secret_a', 'link_secret_b'];
// Sin comodín en el rol: serverless.yml lista estos nombres, y test/unit/deploy.test.js exige que calcen.
const APP_PARAMETERS = [...REQUIRED_PARAMETERS, ...OPTIONAL_PARAMETERS];
const REQUIRED_LOCAL_VARIABLES = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_SSL_CA_FILE', 'TOKEN_SECRET'];
const PRODUCTION_DB_PORT = 3306;
const MIN_TOKEN_SECRET_BYTES = 32;

function configError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertTokenSecret(secret) {
  if (Buffer.byteLength(secret, 'utf8') < MIN_TOKEN_SECRET_BYTES) {
    throw configError('config_token_secret_too_short');
  }
}

// Dos ranuras para poder rotar con traslape: rotar significa que el cliente edite su archivo. Basta una, sea cual sea.
function buildLinkSecrets(a, b, tokenSecret, missingCode) {
  const secrets = {};
  if (a) secrets.a = a;
  if (b) secrets.b = b;
  const loaded = Object.values(secrets);
  if (loaded.length === 0) throw configError(missingCode);
  if (loaded.some((secret) => Buffer.byteLength(secret, 'utf8') < MIN_LINK_SECRET_BYTES)) {
    throw configError('config_link_secret_too_short');
  }
  // Quien emite enlaces lee estos secretos desde su computador: con token_secret podría forjar sesiones sin clave.
  if (loaded.includes(tokenSecret)) throw configError('config_link_secret_reused');
  if (a === b) throw configError('config_link_secrets_equal');
  return secrets;
}

function fromLocalEnvironment(env) {
  for (const name of REQUIRED_LOCAL_VARIABLES) {
    if (typeof env[name] !== 'string' || env[name] === '') throw configError('config_missing_variable');
  }
  const port = Number(env.DB_PORT);
  if (!Number.isInteger(port) || port <= 0) throw configError('config_invalid_port');
  assertTokenSecret(env.TOKEN_SECRET);
  return {
    stage: 'local',
    db: {
      host: env.DB_HOST,
      port,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      sslCaFile: env.DB_SSL_CA_FILE,
    },
    tokenSecret: env.TOKEN_SECRET,
    linkSecrets: buildLinkSecrets(env.LINK_SECRET_A, env.LINK_SECRET_B, env.TOKEN_SECRET, 'config_missing_variable'),
    frameAncestors: env.FRAME_ANCESTORS || '',
    corsOpaque: env.CORS_OPAQUE === 'on',
  };
}

// El SDK lo pone el runtime de Lambda; cargarlo aquí evita exigirlo en local y en las pruebas.
async function fetchFromParameterStore(names) {
  const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
  const client = new SSMClient({});
  const { Parameters = [] } = await client.send(new GetParametersCommand({
    Names: names,
    WithDecryption: true,
  }));
  return Parameters;
}

async function fromParameterStore(fetchParameters) {
  const names = APP_PARAMETERS.map((name) => PARAMETER_PREFIX + name);
  const parameters = await fetchParameters(names);
  const values = new Map(parameters.map(({ Name, Value }) => [Name.slice(PARAMETER_PREFIX.length), Value]));
  for (const name of REQUIRED_PARAMETERS) {
    if (typeof values.get(name) !== 'string' || values.get(name) === '') throw configError('config_missing_parameter');
  }
  assertTokenSecret(values.get('token_secret'));
  return {
    stage: 'prod',
    db: {
      host: values.get('db_host'),
      port: PRODUCTION_DB_PORT,
      user: values.get('db_user'),
      password: values.get('db_password'),
    },
    tokenSecret: values.get('token_secret'),
    linkSecrets: buildLinkSecrets(
      values.get('link_secret_a'),
      values.get('link_secret_b'),
      values.get('token_secret'),
      'config_missing_parameter'
    ),
    frameAncestors: values.get('frame_ancestors') || '',
    corsOpaque: values.get('cors_opaque') === 'on',
  };
}

async function loadConfig({ env = process.env, fetchParameters = fetchFromParameterStore } = {}) {
  if (env.STAGE === 'local') return fromLocalEnvironment(env);
  return fromParameterStore(fetchParameters);
}

module.exports = { APP_PARAMETERS, PARAMETER_PREFIX, PRODUCTION_DB_PORT, configError, fetchFromParameterStore, loadConfig };
