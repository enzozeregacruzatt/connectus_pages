'use strict';

const { PARAMETER_PREFIX, PRODUCTION_DB_PORT, configError, fetchFromParameterStore } = require('../config');
const { parseQuietWindows } = require('./quiet');

// Su propio cargador: el trabajador no puede leer token_secret ni link_secret_*, y serverless.yml le da solo esto.
const WORKER_PARAMETERS = ['db_host', 'worker_db_user', 'worker_db_password', 'worker_quiet_windows'];
const REQUIRED_LOCAL_VARIABLES = ['DB_HOST', 'DB_PORT', 'WORKER_DB_USER', 'WORKER_DB_PASSWORD', 'DB_SSL_CA_FILE', 'WORKER_QUIET_WINDOWS'];

function quietWindowsOf(text) {
  const windows = parseQuietWindows(text);
  if (windows === null) throw configError('config_quiet_windows_invalid');
  return windows;
}

function fromLocalEnvironment(env) {
  for (const name of REQUIRED_LOCAL_VARIABLES) {
    if (typeof env[name] !== 'string' || env[name] === '') throw configError('config_missing_variable');
  }
  const port = Number(env.DB_PORT);
  if (!Number.isInteger(port) || port <= 0) throw configError('config_invalid_port');
  return {
    stage: 'local',
    db: {
      host: env.DB_HOST,
      port,
      user: env.WORKER_DB_USER,
      password: env.WORKER_DB_PASSWORD,
      sslCaFile: env.DB_SSL_CA_FILE,
    },
    quietWindows: quietWindowsOf(env.WORKER_QUIET_WINDOWS),
  };
}

async function fromParameterStore(fetchParameters) {
  const parameters = await fetchParameters(WORKER_PARAMETERS.map((name) => PARAMETER_PREFIX + name));
  const values = new Map(parameters.map(({ Name, Value }) => [Name.slice(PARAMETER_PREFIX.length), Value]));
  for (const name of WORKER_PARAMETERS) {
    if (typeof values.get(name) !== 'string' || values.get(name) === '') throw configError('config_missing_parameter');
  }
  return {
    stage: 'prod',
    db: {
      host: values.get('db_host'),
      port: PRODUCTION_DB_PORT,
      user: values.get('worker_db_user'),
      password: values.get('worker_db_password'),
    },
    quietWindows: quietWindowsOf(values.get('worker_quiet_windows')),
  };
}

async function loadWorkerConfig({ env = process.env, fetchParameters = fetchFromParameterStore } = {}) {
  if (env.STAGE === 'local') return fromLocalEnvironment(env);
  return fromParameterStore(fetchParameters);
}

module.exports = { WORKER_PARAMETERS, loadWorkerConfig };
