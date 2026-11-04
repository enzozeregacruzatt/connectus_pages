'use strict';

const net = require('node:net');

const ignore = () => {};

// Proxy TCP entre mysql2 y el mysqld desechable. Pasa los bytes tal cual: el TLS va de punta a punta, así que no ve el SQL y hay
// que avisarle justo antes de la sentencia que debe afectar.
function createTcpProxy(targetPort) {
  const links = new Set();
  let silenceNew = false;
  let nextCut = null;

  function openUpstream(link) {
    const upstream = net.connect(targetPort, '127.0.0.1');
    link.upstream = upstream;
    upstream.on('error', ignore);
    upstream.on('close', () => { if (!link.silent) link.client.destroy(); });
    upstream.on('data', (chunk) => {
      if (link.silent) return;
      if (!link.cut) {
        link.client.write(chunk);
        return;
      }
      link.silent = true;
      if (link.cut === 'fin') link.client.end();
      else link.client.resetAndDestroy();
      upstream.destroy();
    });
    link.client.on('data', (chunk) => {
      if (link.silent) return;
      if (nextCut) {
        link.cut = nextCut;
        nextCut = null;
      }
      upstream.write(chunk);
    });
  }

  const server = net.createServer((client) => {
    proxy.connections += 1;
    const link = { client, upstream: null, silent: silenceNew, cut: null };
    links.add(link);
    client.on('error', ignore);
    client.on('close', () => {
      links.delete(link);
      link.upstream?.destroy();
    });
    if (!silenceNew) openUpstream(link);
  });

  const proxy = {
    connections: 0,
    port: null,
    // Las conexiones abiertas dejan de pasar bytes, sin FIN ni RST: una red que se queda callada.
    silenceOpenConnections() {
      for (const link of links) link.silent = true;
    },
    // Las conexiones nuevas se aceptan, pero el saludo del servidor nunca llega.
    setSilentForNewConnections(silent) {
      silenceNew = silent;
    },
    // La próxima sentencia llega al servidor y se aplica, pero se pierde la respuesta y se corta al cliente, con 'fin' o 'rst'.
    cutAfterNextStatement(kind) {
      nextCut = kind;
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          proxy.port = server.address().port;
          resolve(proxy);
        });
      });
    },
    close() {
      for (const link of links) {
        link.client.destroy();
        link.upstream?.destroy();
      }
      return new Promise((resolve) => { server.close(resolve); });
    },
  };
  return proxy;
}

module.exports = { createTcpProxy };
