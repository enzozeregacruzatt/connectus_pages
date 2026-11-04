'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before } = require('node:test');

const { createApp } = require('../../../src/app');
const { hashPassword } = require('../../../src/auth');
const { signLink } = require('../../../src/link');
const { createFakeDb } = require('./fake_db');

const TOKEN_SECRET = 'secreto-de-pruebas-que-supera-los-32-bytes';
const LINK_SECRET_A = 'ranura-a-de-pruebas-que-supera-los-32-bytes';
const LINK_SECRET_B = 'ranura-b-de-pruebas-que-supera-los-32-bytes';
const LINK_SECRETS = { a: LINK_SECRET_A, b: LINK_SECRET_B };
const PASSWORD = 'clave-de-prueba-correcta';
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const DAY_SECONDS = 86400;

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
    linkVersion: 0,
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
    config: {
      stage: 'test',
      tokenSecret: TOKEN_SECRET,
      linkSecrets: LINK_SECRETS,
      frameAncestors: 'https://embed.example.com',
      corsOpaque: false,
      ...config,
    },
    clock: clock || (() => clockState.now),
    publicDir,
    loginFailureFloorMs,
  });
  return { app, db, clockState };
}

function linkFor(overrides = {}) {
  const { secret = LINK_SECRET_A, ...fields } = overrides;
  return signLink({ slot: 'a', loginId: 1, linkVersion: 0, exp: NOW_SECONDS + 180 * DAY_SECONDS, ...fields }, secret);
}

// Un objeto sin `link` lleva el enlace vigente del login 1. Para mandar otro, o ninguno, se indica: { link: undefined } no viaja.
function withLink(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body) || 'link' in body) return body;
  return { link: linkFor(), ...body };
}

function postLogin(app, body, headers = { 'content-type': 'application/json' }) {
  const payload = withLink(body);
  return app.handle({
    method: 'POST',
    path: '/api/login',
    headers,
    body: typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
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
  DAY_SECONDS,
  LINK_SECRETS,
  LINK_SECRET_A,
  LINK_SECRET_B,
  NOW_MS,
  NOW_SECONDS,
  PASSWORD,
  TOKEN_SECRET,
  VALID_SEARCH,
  buildApp,
  getSms,
  linkFor,
  loginRow,
  postLogin,
  signIn,
  smsRow,
};
