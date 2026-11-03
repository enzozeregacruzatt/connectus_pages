'use strict';

const PARAMETER_PREFIX = '/connectus-pages/prod/';
const REQUIRED_PARAMETERS = ['db_host', 'db_user', 'db_password', 'token_secret'];
const OPTIONAL_PARAMETERS = ['frame_ancestors'];
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
    frameAncestors: env.FRAME_ANCESTORS || '',
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
  const names = [...REQUIRED_PARAMETERS, ...OPTIONAL_PARAMETERS].map((name) => PARAMETER_PREFIX + name);
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
    frameAncestors: values.get('frame_ancestors') || '',
  };
}

async function loadConfig({ env = process.env, fetchParameters = fetchFromParameterStore } = {}) {
  if (env.STAGE === 'local') return fromLocalEnvironment(env);
  return fromParameterStore(fetchParameters);
}

module.exports = { loadConfig, PARAMETER_PREFIX };
