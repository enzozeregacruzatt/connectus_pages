'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before } = require('node:test');

const { createApp } = require('../../../src/app');
const { hashPassword } = require('../../../src/auth');
const { createFakeDb } = require('./fake_db');

const TOKEN_SECRET = 'secreto-de-pruebas-que-supera-los-32-bytes';
const PASSWORD = 'clave-de-prueba-correcta';
const NOW_MS = 1_800_000_000_000;

let passwordHash;
let publicDir;

// Los estáticos de las pruebas viven en una carpeta temporal: así no dependen del front real.
before(async () => {
  passwordHash = await hashPassword(PASSWORD);
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connectus-pages-public-'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>prueba</title>');
  fs.writeFileSync(path.join(publicDir, 'app.js'), '// js de prueba');
  fs.writeFileSync(path.join(publicDir, 'app.css'), '/* css de prueba */');
});

after(() => {
  if (publicDir) fs.rmSync(publicDir, { recursive: true, force: true });
});

function loginRow(overrides = {}) {
  return {
    id: 1,
    username: 'demo',
    passwordHash,
    active: 1,
    tokenVersion: 0,
    failedAttempts: 0,
    lockedUntil: 0,
    lastLoginAt: null,
    ...overrides,
  };
}

function smsRow(id, overrides = {}) {
  return {
    id,
    id_account: 101,
    id_delivery: null,
    dst_number: '56900000001',
    sms_content: `Mensaje de prueba ${id}`,
    status: 'DELIVRD',
    created_at: '2026-10-15 12:00:00',
    ...overrides,
  };
}

// Sin el piso de tiempo de las fallas de login, salvo en las pruebas que lo miden: hay decenas de fallas por archivo.
function buildApp({ seed, config, clock, loginFailureFloorMs = 0 } = {}) {
  const db = createFakeDb({
    logins: [loginRow()],
    loginAccounts: [{ idLogin: 1, idAccount: 101 }, { idLogin: 1, idAccount: 102 }],
    accounts: [{ id: 101, name: 'Cuenta Demo 101' }, { id: 102, name: 'Cuenta Demo 102' }],
    nowSeconds: NOW_MS / 1000,
    ...seed,
  });
  const clockState = { now: NOW_MS };
  const app = createApp({
    db,
    config: { stage: 'test', tokenSecret: TOKEN_SECRET, frameAncestors: 'https://embed.example.com', ...config },
    clock: clock || (() => clockState.now),
    publicDir,
    loginFailureFloorMs,
  });
  return { app, db, clockState };
}

function postLogin(app, body, headers = { 'content-type': 'application/json' }) {
  return app.handle({
    method: 'POST',
    path: '/api/login',
    headers,
    body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    ip: '203.0.113.10',
  });
}

function toQuery(params) {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, [].concat(value)]));
}

function getSms(app, token, params, overrides = {}) {
  return app.handle({
    method: 'GET',
    path: '/api/sms',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query: toQuery(params),
    ip: '203.0.113.10',
    ...overrides,
  });
}

async function signIn(app) {
  const response = await postLogin(app, { username: 'demo', password: PASSWORD });
  return JSON.parse(response.body).token;
}

const VALID_SEARCH = { account: '101', start: '2026-10-01', end: '2026-10-15' };

module.exports = {
  NOW_MS,
  PASSWORD,
  TOKEN_SECRET,
  VALID_SEARCH,
  buildApp,
  getSms,
  loginRow,
  postLogin,
  signIn,
  smsRow,
};
