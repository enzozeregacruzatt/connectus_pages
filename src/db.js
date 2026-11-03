'use strict';

const fs = require('node:fs');
const mysql = require('mysql2/promise');

// Topes de servidor para lo que no lleva hint: un SELECT sin MAX_EXECUTION_TIME, o un UPDATE o INSERT esperando un bloqueo,
// durarían más que la Lambda con los valores por defecto. El hint de una sentencia gana sobre max_execution_time.
const SESSION_SETUP = 'SET SESSION wait_timeout = 120, max_execution_time = 3000, lock_wait_timeout = 5, '
  + 'innodb_lock_wait_timeout = 5';
const INSERT_AUDIT = 'INSERT INTO connectus_pages.audit_log (id_login, action, id_account, detail, ip, created_at) '
  + 'VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())';
const MAX_IP_LENGTH = 45;
const DEAD_CONNECTION_CODES = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE']);
const ER_CLIENT_INTERACTION_TIMEOUT = 4031;

// Nunca err.message ni err.sql: mysql2 incluye ahí los parámetros de la consulta.
function errorCode(error) {
  return (error && (error.code || error.name)) || 'unknown';
}

function buildSslOptions(config) {
  if (config.stage === 'local') {
    return { ca: fs.readFileSync(config.db.sslCaFile), rejectUnauthorized: true, verifyIdentity: false };
  }
  return { ca: require('aws-ssl-profiles').ca, rejectUnauthorized: true, verifyIdentity: true };
}

function buildPoolOptions(config) {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    ssl: buildSslOptions(config),
    connectionLimit: 1,
    connectTimeout: 5000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
    stringifyObjects: true,
  };
}

// El servidor no alcanzó a ejecutar la sentencia. MySQL 8.0.24 o superior avisa con 4031 antes de cerrar por wait_timeout: un
// contenedor que recién despierta lo recibe como respuesta de su consulta, y mysql2 no lo marca fatal. El error fatal sin
// código es el de usar una conexión que ya se cerró: mysql2 no llega a enviar nada.
function wasNotExecuted(error) {
  if (!error) return false;
  return error.errno === ER_CLIENT_INTERACTION_TIMEOUT || (Boolean(error.fatal) && !error.code);
}

function isDeadConnection(error) {
  if (!error) return false;
  return wasNotExecuted(error) || (Boolean(error.fatal) && DEAD_CONNECTION_CODES.has(error.code));
}

// Un error que no es fatal deja la conexión muerta en el pool, y el reintento volvería a salir por ella.
async function discardIdleConnection(pool) {
  const connection = await pool.getConnection();
  connection.destroy();
}

async function sendOnceMore(pool, sql, params, canResend) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (error) {
    if (!canResend(error)) throw error;
    if (!error.fatal) await discardIdleConnection(pool);
    const [rows] = await pool.query(sql, params);
    return rows;
  }
}

function createDb(config, createPool = mysql.createPool) {
  const pool = createPool(buildPoolOptions(config));

  // Un contenedor congelado deja la conexión abierta; sin esto, con el wait_timeout de 28800 s de
  // Aurora, se agotaría MAX_USER_CONNECTIONS.
  pool.on('connection', (connection) => {
    connection.query(SESSION_SETUP, (error) => {
      if (error) console.error(JSON.stringify({ event: 'session_setup_failed', code: errorCode(error) }));
    });
  });

  return {
    // Ese mismo wait_timeout hace que un contenedor que estuvo congelado más de 120 s despierte con
    // la conexión ya cerrada. Se reintenta una vez para no devolverle un 503 al usuario por eso.
    query(sql, params) {
      return sendOnceMore(pool, sql, params, isDeadConnection);
    },
    // Si se pierde la conexión con la escritura ya enviada, el servidor pudo aplicarla y no se sabe: reenviarla contaría dos
    // veces un intento de login. Solo se reenvía si es seguro que no se ejecutó.
    write(sql, params) {
      return sendOnceMore(pool, sql, params, wasNotExecuted);
    },
    end() {
      return pool.end();
    },
  };
}

// Una falla de auditoría no debe tumbar la petición.
async function writeAudit(db, { idLogin = null, action, idAccount = null, detail = null, ip = null }) {
  const safeIp = typeof ip === 'string' && ip.length <= MAX_IP_LENGTH ? ip : null;
  try {
    await db.write(INSERT_AUDIT, [idLogin, action, idAccount, detail, safeIp]);
  } catch (error) {
    console.error(JSON.stringify({ event: 'audit_insert_failed', code: errorCode(error) }));
  }
}

module.exports = { buildPoolOptions, createDb, errorCode, writeAudit };
