'use strict';

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/;

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
  const allowed = parseFrameAncestors(frameAncestors, stage);
  const ancestors = allowed.length > 0 ? allowed.join(' ') : "'none'";
  return "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
    + "connect-src 'self'; form-action 'none'; base-uri 'none'; "
    + `frame-ancestors ${ancestors}`;
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

module.exports = { buildContentSecurityPolicy, buildSecurityHeaders, parseFrameAncestors };
