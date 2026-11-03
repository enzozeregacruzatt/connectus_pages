'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', contentType: 'text/css; charset=utf-8' }],
]);

async function readStatic(routePath, publicDir = DEFAULT_PUBLIC_DIR) {
  const entry = STATIC_FILES.get(routePath);
  if (!entry) return null;
  const body = await fs.readFile(path.join(publicDir, entry.file), 'utf8');
  return { contentType: entry.contentType, body };
}

module.exports = { STATIC_FILES, readStatic };
