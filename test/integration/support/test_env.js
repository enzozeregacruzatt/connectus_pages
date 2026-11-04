'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const ENV_FILE = path.join(__dirname, '..', '..', '.env.local');

// Lo que deja scripts/mysql_prueba.sh up.
function loadTestEnv() {
  let raw;
  try {
    raw = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
  } catch {
    throw new Error("No existe test/.env.local: corre 'scripts/mysql_prueba.sh up' antes de las pruebas de integración.");
  }
  const env = {
    host: raw.DB_HOST,
    port: raw.DB_PORT,
    user: raw.DB_USER,
    password: raw.DB_PASSWORD,
    caFile: raw.DB_SSL_CA_FILE,
    adminUser: raw.DB_ADMIN_USER,
    workerUser: raw.WORKER_DB_USER,
    workerPassword: raw.WORKER_DB_PASSWORD,
    linkSecretA: raw.LINK_SECRET_A,
    demoLink: raw.LINK_DEMO,
    demoPassword: raw.LOGIN_DEMO_PASSWORD,
    solo102Password: raw.LOGIN_SOLO102_PASSWORD,
    inactivePassword: raw.LOGIN_INACTIVO_PASSWORD,
  };
  if (Object.values(env).some((value) => !value)) {
    throw new Error("Faltan variables en test/.env.local: corre 'scripts/mysql_prueba.sh up'.");
  }
  return env;
}

// La cuenta de administración local entra sin clave: solo existe en el mysqld desechable.
function adminConnectionOptions(env) {
  return {
    host: env.host,
    port: Number(env.port),
    user: env.adminUser,
    ssl: { ca: fs.readFileSync(env.caFile), rejectUnauthorized: true, verifyIdentity: false },
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
  };
}

function localConfigEnv(env, overrides = {}) {
  return {
    STAGE: 'local',
    DB_HOST: env.host,
    DB_PORT: env.port,
    DB_USER: env.user,
    DB_PASSWORD: env.password,
    DB_SSL_CA_FILE: env.caFile,
    LINK_SECRET_A: env.linkSecretA,
    FRAME_ANCESTORS: 'http://127.0.0.1:8788',
    ...overrides,
  };
}

module.exports = { adminConnectionOptions, loadTestEnv, localConfigEnv };
