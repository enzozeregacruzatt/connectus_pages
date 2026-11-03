'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

const html = read('index.html');
const js = read('app.js');
const css = read('app.css');

const stripHtmlComments = (source) => source.replace(/<!--[\s\S]*?-->/g, '');

function openingTags(source) {
  return stripHtmlComments(source).match(/<[a-zA-Z][^<>]*>/g) || [];
}

function inlineScripts(source) {
  const scripts = [...stripHtmlComments(source).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  return scripts.filter(([, attributes, content]) => !/\ssrc\s*=/i.test(attributes) || content.trim() !== '');
}

const hasStyleTag = (source) => /<style\b/i.test(stripHtmlComments(source));
const eventAttributes = (source) => openingTags(source).filter((tag) => /\son[a-z]+\s*=/i.test(tag));
const styleAttributes = (source) => openingTags(source).filter((tag) => /\sstyle\s*=/i.test(tag));

const EXTERNAL_URL = /(?:\b(?:https?|wss?|ftp|file):)|(?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+)|(?:\bdata:[a-z]+\/)/i;

const FORBIDDEN_JS = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\s*\.\s*write(?:ln)?\b/],
  ['eval', /\beval\s*\(/],
  ['new Function', /\bnew\s+Function\b/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['document.cookie', /\bdocument\s*\.\s*cookie\b/],
  ['window', /\bwindow\b/],
  ['globalThis', /\bglobalThis\b/],
  ['element.style', /\.\s*style\b/],
];

function forbiddenApis(source) {
  return FORBIDDEN_JS.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

test('los detectores reconocen las infracciones', () => {
  assert.equal(inlineScripts('<script>alert(1)</script>').length, 1);
  assert.equal(inlineScripts('<script src="a.js">alert(1)</script>').length, 1);
  assert.equal(inlineScripts('<script src="a.js"></script>').length, 0);
  assert.equal(hasStyleTag('<style>p{}</style>'), true);
  assert.equal(eventAttributes('<img src="x" onerror="alert(1)">').length, 1);
  assert.equal(styleAttributes('<p style="color:red">').length, 1);
  assert.equal(EXTERNAL_URL.test('https://example.test/a.js'), true);
  assert.equal(EXTERNAL_URL.test('//example.test/a.js'), true);
  assert.equal(EXTERNAL_URL.test('api/login'), false);
  assert.deepEqual(forbiddenApis('el.innerHTML = x; eval("1"); localStorage.a = 1;'), [
    'innerHTML',
    'eval',
    'localStorage',
  ]);
  assert.deepEqual(forbiddenApis('el.textContent = x; evaluate(1);'), []);
});

test('index.html no tiene scripts ni estilos en línea', () => {
  assert.deepEqual(inlineScripts(html), []);
  assert.equal(hasStyleTag(html), false);
  assert.deepEqual(eventAttributes(html), []);
  assert.deepEqual(styleAttributes(html), []);
});

test('index.html solo carga los recursos propios', () => {
  const references = [...html.matchAll(/\s(?:src|href|action|formaction|poster|srcset)\s*=\s*"([^"]*)"/gi)].map(
    (match) => match[1],
  );
  assert.deepEqual(references.sort(), ['app.css', 'app.js']);
});

test('no hay URLs externas en ningún archivo', () => {
  for (const [name, source] of [['index.html', html], ['app.js', js], ['app.css', css]]) {
    assert.equal(EXTERNAL_URL.test(source), false, `${name} contiene una URL externa`);
  }
  assert.equal(/@import\b/i.test(css), false);
  assert.equal(/\burl\s*\(/i.test(css), false);
  assert.equal(/\bimport\s*\(|\bimportScripts\b/.test(js), false);
});

test('app.js no usa APIs prohibidas', () => {
  assert.deepEqual(forbiddenApis(js), []);
});

test('app.js solo usa self y top para saber si está embebida', () => {
  assert.deepEqual(js.match(/\b(?:self|top)\b/g), ['self', 'top']);
  assert.match(js, /if \(self === top\) els\.username\.focus\(\);/);
});

test('si app.js no carga o tarda, queda un aviso estático y neutro, con el login oculto, y el <noscript> sigue', () => {
  assert.match(html, /<p class="notice" id="load-notice" role="status">La consulta está tardando en cargar\. Si no aparece, recarga la página\.<\/p>/);
  assert.match(css, /#load-notice,\s*#login-status:not\(:empty\),\s*#search-status:not\(:empty\)\s*\{\s*background: var\(--status-bg\);/);
  assert.match(html, /<section\b[^>]*\bid="login-view"[^>]*\shidden>/);
  assert.match(html, /<noscript>\s*<p class="notice notice--error">Esta consulta necesita JavaScript para funcionar\.<\/p>\s*<\/noscript>/);
});

test('app.js cambia el aviso por el login solo al final, con todo ya conectado', () => {
  const swap = js.search(/els\.loadNotice\.hidden = true;\n\s+els\.loginView\.hidden = false;/);
  assert.ok(swap > 0, 'app.js debe ocultar el aviso y mostrar el login');
  assert.ok(swap > js.lastIndexOf('addEventListener('));
  assert.ok(swap < js.indexOf('if (self === top) els.username.focus();'), 'un elemento oculto no puede recibir el foco');
});

test('el aviso espera antes de verse, para no asomarse en una carga normal', () => {
  assert.match(css, /#load-notice\s*\{\s*animation: load-notice-appears 0s linear \d+s both;/);
  assert.match(css, /@keyframes load-notice-appears\s*\{\s*from\s*\{\s*visibility: hidden;/);
  assert.match(css, /@media \(scripting: none\)\s*\{\s*#load-notice\s*\{\s*display: none;/);
});

test('el token queda encerrado en un IIFE', () => {
  assert.match(js, /^\(function \(\) \{\n {2}'use strict';/);
  assert.match(js, /\}\(\)\);\s*$/);
  assert.match(js, /^ {2}let token = null;$/m);
});

test('la zona horaria y las rutas de la API son las del contrato', () => {
  assert.match(js, /'America\/Santiago'/);
  assert.match(js, /'api\/login'/);
  assert.match(js, /'api\/sms'/);
  assert.match(js, /AbortController/);
  assert.ok(js.includes('El rango debe ser válido y no superar 15 días.'));
  assert.ok(js.includes('Debes indicar un número destino válido.'));
});

test('todo id que usa app.js existe en index.html', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const used = [...js.matchAll(/byId\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(used.length > 0);
  assert.deepEqual(used.filter((id) => !ids.has(id)), []);
});

test('index.html no repite ids', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
});

test('cada label apunta a un control existente y cada control tiene label', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const targets = [...html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(targets.filter((id) => !ids.has(id)), []);

  const controls = openingTags(html).filter((tag) => /^<(?:input|select|textarea)\b/i.test(tag));
  assert.ok(controls.length > 0);
  for (const tag of controls) {
    const id = /\sid="([^"]+)"/.exec(tag);
    assert.ok(id && targets.includes(id[1]), `control sin label: ${tag}`);
  }
});

test('la tabla tiene las columnas del contrato con scope', () => {
  const headers = [...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headers, ['Fecha', 'Número destino', 'Mensaje', 'Estado', 'Envío']);
  assert.equal(/<th(?=[\s>])(?![^>]*\sscope=)/.test(html), false);
});

test('el login tiene los autocomplete correctos y hay regiones aria-live', () => {
  assert.match(html, /id="login-username"[^>]*autocomplete="username"/);
  assert.match(html, /id="login-password"[^>]*type="password"[^>]*autocomplete="current-password"/);
  assert.match(html, /id="search-status"[^>]*aria-live="polite"/);
  assert.match(html, /id="login-status"[^>]*aria-live="polite"/);
});

test('index.html y app.css llevan los textos y el aspecto del contrato', () => {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const expected of ['Acceso de solo lectura', 'Consulta de SMS', 'Hasta 15 días por consulta', 'Buscar', 'Salir']) {
    assert.ok(text.includes(expected), `falta el texto: ${expected}`);
  }
  assert.ok(css.includes('linear-gradient(135deg, #344767 0%, #416f96 58%, #5db7e5 100%)'));
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /body\s*\{[^}]*background:/);
  for (const color of ['#344767', '#67748e', '#dce4ec', '#5db7e5']) {
    assert.ok(css.includes(color), `falta el color: ${color}`);
  }
});
