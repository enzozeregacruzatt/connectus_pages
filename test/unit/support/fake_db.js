'use strict';

// Base en memoria que entiende solo las sentencias que usa la app. Una sentencia desconocida lanza un
// error, para que un cambio de SQL no pase inadvertido en las pruebas.
function createFakeDb(seed = {}) {
  const state = {
    logins: seed.logins || [],
    loginAccounts: seed.loginAccounts || [],
    accounts: seed.accounts || [],
    sms: seed.sms || [],
    deliveries: seed.deliveries || [],
    audit: [],
    nowSeconds: seed.nowSeconds || 1_800_000_000,
  };
  const calls = [];
  const failures = [];

  const isLocked = (row) => (row.lockedUntil > state.nowSeconds ? '1' : '0');
  const findById = (id) => state.logins.find((row) => row.id === id);

  function selectSms(sql, params) {
    if (/sms_de_numero/.test(sql) !== /dst_number = \?/.test(sql)) throw new Error(`Vista equivocada para el filtro: ${sql}`);
    const [account, lo, ...rest] = params;
    let index = 0;
    const hi = /AND id <= \?/.test(sql) ? rest[index++] : Number.POSITIVE_INFINITY;
    const from = rest[index++];
    const to = rest[index++];
    const dst = /dst_number = \?/.test(sql) ? rest[index++] : null;
    const cursor = /AND id < \?/.test(sql) ? rest[index++] : null;
    return state.sms
      .filter((row) => row.id_account === account && row.id > lo && row.id <= hi)
      .filter((row) => row.created_at >= from && row.created_at <= to)
      .filter((row) => dst === null || row.dst_number === String(dst))
      .filter((row) => cursor === null || row.id < cursor)
      .sort((a, b) => b.id - a.id)
      .slice(0, 51)
      .map((row) => ({ ...row }));
  }

  function run(sql, params) {
    if (/\(username = \?\) AS username_ok/.test(sql)) {
      const row = findById(params[1]);
      if (!row) return [];
      // Como en la base: la intercalación no distingue mayúsculas, y una comparación llega como texto por bigNumberStrings.
      const usernameOk = row.username.toLowerCase() === params[0].toLowerCase() ? '1' : '0';
      return [{
        ...row,
        password_hash: row.passwordHash,
        token_version: row.tokenVersion,
        link_version: row.linkVersion,
        username_ok: usernameOk,
        locked: isLocked(row),
      }];
    }
    if (/FROM connectus_pages\.login WHERE id = \?/.test(sql)) {
      const row = findById(params[0]);
      return row ? [{ id: row.id, active: row.active, token_version: row.tokenVersion }] : [];
    }
    if (/^UPDATE connectus_pages\.login SET locked_until = IF\(failed_attempts \+ 1 >= 5/.test(sql)) {
      const row = findById(params[0]);
      if (row.failedAttempts + 1 >= 5) {
        row.lockedUntil = state.nowSeconds + 900;
        row.failedAttempts = 0;
      } else {
        row.failedAttempts += 1;
      }
      return { affectedRows: 1 };
    }
    if (/^UPDATE connectus_pages\.login SET failed_attempts = 0, locked_until = NULL/.test(sql)) {
      const row = findById(params[0]);
      row.failedAttempts = 0;
      row.lockedUntil = 0;
      row.lastLoginAt = state.nowSeconds;
      return { affectedRows: 1 };
    }
    if (/JOIN connectus_pages\.account a ON a\.id = la\.id_account WHERE la\.id_login = \?/.test(sql)) {
      return state.loginAccounts
        .filter((link) => link.idLogin === params[0])
        .map((link) => state.accounts.find((account) => account.id === link.idAccount))
        .filter(Boolean)
        .map((account) => ({ ...account }));
    }
    if (/FROM connectus_pages\.login_account WHERE id_login = \? AND id_account = \?/.test(sql)) {
      return state.loginAccounts
        .filter((link) => link.idLogin === params[0] && link.idAccount === params[1])
        .map(() => ({ allowed: 1 }));
    }
    if (/^INSERT INTO connectus_pages\.audit_log/.test(sql)) {
      const [idLogin, action, idAccount, detail, ip] = params;
      state.audit.push({ idLogin, action, idAccount, detail, ip });
      return { affectedRows: 1 };
    }
    if (/connectus_pages\.sms_cutoff_id\(\?\) AS lo/.test(sql)) {
      const ids = (limit) => state.sms.filter((row) => row.created_at < limit).map((row) => row.id);
      // Como en la base: BIGINT llega como texto por bigNumberStrings.
      const row = { lo: String(Math.max(0, ...ids(params[0]))) };
      if (/AS hi/.test(sql)) row.hi = String(Math.max(0, ...ids(params[1])));
      return [row];
    }
    if (/FROM connectus_pages\.sms_de_(?:cuenta|numero) WHERE id_account = \?/.test(sql)) return selectSms(sql, params);
    if (/FROM connectus_pages\.delivery WHERE id IN \(\?\) AND id_account = \?/.test(sql)) {
      const [ids, account] = params;
      return state.deliveries
        .filter((row) => ids.includes(row.id) && row.id_account === account)
        .map(({ id, id_unique, name, id_product }) => ({ id, id_unique, name, id_product }));
    }
    throw new Error(`Sentencia desconocida para la base falsa: ${sql}`);
  }

  function send(sql, params) {
    calls.push({ sql, params });
    const failure = failures.find(({ pattern }) => pattern.test(sql));
    if (failure) throw failure.error;
    return run(sql, params);
  }

  // Como en db.js, leer y escribir son métodos distintos porque reintentan distinto: una escritura por query podría aplicarse dos veces.
  const isWrite = (sql) => /^(UPDATE|INSERT)\b/.test(sql);

  return {
    state,
    calls,
    failOn(pattern, error) {
      failures.push({ pattern, error });
    },
    clearFailures() {
      failures.length = 0;
    },
    async query(sql, params = []) {
      if (isWrite(sql)) throw new Error(`Escritura por db.query: ${sql}`);
      return send(sql, params);
    },
    async write(sql, params = []) {
      if (!isWrite(sql)) throw new Error(`Lectura por db.write: ${sql}`);
      return send(sql, params);
    },
  };
}

function mysqlError(errno, code, extras = {}) {
  // Igual que mysql2: el mensaje y el SQL traen los parámetros de la consulta.
  const error = new Error(`Fallo con datos 56900000001 y clave-secreta (errno ${errno})`);
  error.errno = errno;
  error.code = code;
  error.sql = "SELECT * FROM x WHERE dst_number = 56900000001 AND password = 'clave-secreta'";
  return Object.assign(error, extras);
}

module.exports = { createFakeDb, mysqlError };
