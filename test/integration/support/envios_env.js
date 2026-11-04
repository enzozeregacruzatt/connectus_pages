'use strict';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const { createApp } = require('../../../src/app');
const { hashPassword } = require('../../../src/auth');
const { loadConfig } = require('../../../src/config');
const { createDb } = require('../../../src/db');
const { createHandler } = require('../../../src/handler');
const { signLink } = require('../../../src/link');
const { adminConnectionOptions, loadTestEnv, localConfigEnv } = require('./test_env');

const PASSWORD = 'clave-desechable-de-los-envios';
const LINK_EXP = Date.parse('2027-06-01T00:00:00Z') / 1000;

// El id_unique de un envío del fixture.
const uniqueOf = (deliveryId) => crypto.createHash('md5').update(`envio-${deliveryId}`).digest('hex');

function restEvent(path, token, params) {
  return {
    httpMethod: 'GET',
    path,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    multiValueHeaders: null,
    queryStringParameters: params,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    requestContext: { identity: { sourceIp: '203.0.113.50' } },
  };
}

// Un login propio de cada archivo, para que la auditoría y los jobs que se miran sean solo los suyos.
async function startEnvironment(username, accounts) {
  const env = loadTestEnv();
  const config = await loadConfig({ env: localConfigEnv(env, { TOKEN_SECRET: crypto.randomBytes(32).toString('hex') }) });
  const admin = await mysql.createConnection(adminConnectionOptions(env));
  const db = createDb(config);

  async function removeLogin() {
    const [rows] = await admin.query('SELECT id FROM connectus_pages.login WHERE username = ?', [username]);
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return;
    await admin.query('DELETE FROM connectus_pages.audit_log WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.export_job WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login_account WHERE id_login IN (?)', [ids]);
    await admin.query('DELETE FROM connectus_pages.login WHERE id IN (?)', [ids]);
  }

  await removeLogin();
  const [created] = await admin.query(
    'INSERT INTO connectus_pages.login (username, password_hash) VALUES (?, ?)',
    [username, await hashPassword(PASSWORD)]
  );
  const loginId = created.insertId;
  for (const account of accounts) {
    await admin.query('INSERT INTO connectus_pages.login_account (id_login, id_account) VALUES (?, ?)', [loginId, account]);
  }
  const link = signLink({ slot: 'a', loginId, linkVersion: 0, exp: LINK_EXP }, config.linkSecrets.a);

  function appAt(isoTime, usingDb = db) {
    return createApp({ db: usingDb, config, clock: () => Date.parse(isoTime), loginFailureFloorMs: 0 });
  }

  function handlerAt(isoTime, usingDb = db) {
    return createHandler(async () => appAt(isoTime, usingDb));
  }

  async function tokenAt(isoTime) {
    const response = await handlerAt(isoTime)({
      ...restEvent('/api/login'),
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link, username, password: PASSWORD }),
    });
    return JSON.parse(response.body).token;
  }

  async function stop() {
    await removeLogin();
    await admin.end();
    await db.end();
  }

  return { admin, appAt, config, db, handlerAt, loginId, stop, tokenAt };
}

module.exports = { restEvent, startEnvironment, uniqueOf };
