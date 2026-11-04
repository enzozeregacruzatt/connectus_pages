'use strict';

const { createDb, errorCode } = require('../db');
const { createStorage } = require('../storage');
const { loadWorkerConfig } = require('./config');
const { runWorker } = require('./run');

// Captura todo: un error de mysql2 trae el número ya interpolado en su sql, y el runtime copia al registro sus propiedades. Solo sale
// el código, también en el Error que dispara la métrica Errors.
function createWorkerHandler({ load = loadWorkerConfig, openDb = createDb, openStorage = createStorage, run = runWorker, ...options } = {}) {
  // Sobrevive entre corridas del mismo contenedor, para no limpiar en todas. Si el contenedor se recicla, limpia una vez de más.
  const schedule = { lastCleanupMs: -Infinity };
  return async (_event, context) => {
    let db = null;
    try {
      // En cada corrida: un cambio de ventana en Parameter Store rige desde la siguiente, sin reciclar el contenedor.
      const config = await load();
      db = openDb(config);
      const { failure } = await run({
        db,
        storage: openStorage(),
        quietWindows: config.quietWindows,
        remainingMs: () => context.getRemainingTimeInMillis(),
        schedule,
        ...options,
      });
      if (failure) throw Object.assign(new Error(failure), { code: failure });
    } catch (error) {
      const code = errorCode(error);
      console.error(JSON.stringify({ event: 'worker_failed', code }));
      throw new Error(code);
    } finally {
      await db?.end().catch((error) => console.error(JSON.stringify({ event: 'worker_close_failed', code: errorCode(error) })));
    }
  };
}

exports.createWorkerHandler = createWorkerHandler;
exports.worker = createWorkerHandler();
