'use strict';

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/;
const FRAME_ANCESTORS_OPEN = 'sin-restriccion';

// Un documento sandbox sin allow-same-origin tiene origen opaco: fetch a su propia API es cross-origin y llega con Origin: null.
// Nunca Allow-Credentials: la sesión viaja en Authorization, y sin cookies no hay autoridad ambiental que abrirle a nadie.
const OPAQUE_ORIGIN = 'null';
const OPAQUE_CORS_HEADERS = { 'Access-Control-Allow-Origin': OPAQUE_ORIGIN, Vary: 'Origin' };
const OPAQUE_PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

// Se separa solo por el espacio literal: un salto de línea queda dentro del elemento, el
// elemento no calza y se descarta, así que nunca llega a la cabecera.
function parseFrameAncestors(raw, stage) {
  if (typeof raw !== 'string') return [];
  const elements = raw.split(' ').filter((element) => element !== '');
  const valid = elements.filter(
    (element) => HTTPS_ORIGIN.test(element) || (stage === 'local' && LOCAL_ORIGIN.test(element))
  );
  if (valid.length !== elements.length) {
    console.error(JSON.stringify({
      event: 'frame_ancestors_invalid',
      discarded: elements.length - valid.length,
    }));
  }
  return valid;
}

function buildContentSecurityPolicy(frameAncestors, stage) {
  const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
    + "connect-src 'self'; form-action 'none'; base-uri 'none'";
  // Omitir, porque frame-ancestors * bloquea justo los ancestros probables en un BI de escritorio: file: y orígenes opacos.
  // Comparación exacta: con un espacio, mayúsculas u otro origen al lado, cae en la lista y queda cerrado.
  if (frameAncestors === FRAME_ANCESTORS_OPEN) return policy;
  const allowed = parseFrameAncestors(frameAncestors, stage);
  return `${policy}; frame-ancestors ${allowed.length > 0 ? allowed.join(' ') : "'none'"}`;
}

function buildSecurityHeaders({ frameAncestors, stage } = {}) {
  return {
    'Content-Security-Policy': buildContentSecurityPolicy(frameAncestors, stage),
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
  };
}

module.exports = {
  FRAME_ANCESTORS_OPEN,
  OPAQUE_CORS_HEADERS,
  OPAQUE_ORIGIN,
  OPAQUE_PREFLIGHT_HEADERS,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  parseFrameAncestors,
};
