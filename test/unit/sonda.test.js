'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { sonda } = require('../../sonda/handler');

const ROOT = path.join(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const originalLog = console.log;
afterEach(() => {
  console.log = originalLog;
});

function call(rawPath, { method = 'GET', headers = {} } = {}) {
  return sonda({ rawPath, rawQueryString: '', headers, requestContext: { http: { method } } });
}

function captureLogs() {
  const lines = [];
  console.log = (line) => lines.push(line);
  return lines;
}

test('la página no lleva frame-ancestors, para que cualquiera pueda embeberla', async () => {
  captureLogs();
  const response = await call('/');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['Content-Type'], /^text\/html/);
  assert.ok(!response.headers['Content-Security-Policy'].includes('frame-ancestors'));
  assert.ok(!('X-Frame-Options' in response.headers));
  assert.equal(response.body, read('sonda/index.html'));
});

test('sirve su script como JavaScript, para que pase con nosniff', async () => {
  captureLogs();
  const response = await call('/sonda.js');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['Content-Type'], /^text\/javascript/);
  assert.equal(response.body, read('sonda/sonda.js'));
});

test('/eco abre CORS solo para el origen null, y /eco-sin-cors no', async () => {
  captureLogs();
  const echo = await call('/eco');
  assert.equal(echo.headers['Access-Control-Allow-Origin'], 'null');
  assert.ok(!('Access-Control-Allow-Credentials' in echo.headers));
  const closed = await call('/eco-sin-cors');
  assert.equal(closed.statusCode, 200);
  assert.ok(!('Access-Control-Allow-Origin' in closed.headers));
});

test('/eco devuelve un texto fijo, sin nada de la petición', async () => {
  captureLogs();
  const marker = 'marcador-de-la-peticion';
  const headers = { origin: marker, 'user-agent': marker, authorization: marker, 'x-otra': marker };
  const first = await call('/eco', { headers });
  const second = await call('/eco');
  assert.equal(first.body, second.body);
  assert.ok(!JSON.stringify(first).includes(marker));
});

test('/eco responde el preflight de Authorization, y las demás rutas no', async () => {
  captureLogs();
  const preflight = await call('/eco', { method: 'OPTIONS' });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'null');
  assert.equal(preflight.headers['Access-Control-Allow-Headers'], 'Authorization');
  assert.equal((await call('/eco-sin-cors', { method: 'OPTIONS' })).statusCode, 405);
  assert.equal((await call('/', { method: 'POST' })).statusCode, 405);
});

test('/descarga baja como archivo, con un texto fijo', async () => {
  captureLogs();
  const response = await call('/descarga');
  assert.equal(response.headers['Content-Disposition'], 'attachment; filename="sonda.txt"');
  assert.equal(response.body, (await call('/descarga')).body);
});

test('/descarga-falla responde como un error de S3: sin attachment, con un texto fijo', async () => {
  captureLogs();
  const response = await call('/descarga-falla');
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers['Content-Type'], 'application/xml');
  assert.equal(response.headers['Content-Disposition'], undefined);
  assert.match(response.body, /<Error>/);
  assert.equal(response.body, (await call('/descarga-falla', { headers: { referer: 'https://x.invalid/marca' } })).body);
  assert.match(read('sonda/index.html'), /href="descarga-falla"/);
});

test('una ruta desconocida da 404 sin reflejarla ni registrarla', async () => {
  const lines = captureLogs();
  const response = await call('/<script>desconocida');
  assert.equal(response.statusCode, 404);
  assert.ok(!response.body.includes('desconocida'));
  assert.deepEqual(lines, []);
  assert.equal((await call('/__proto__')).statusCode, 404);
});

test('registra las cabeceras acordadas y nada más', async () => {
  const lines = captureLogs();
  await call('/', {
    headers: {
      'sec-fetch-dest': 'iframe',
      'sec-fetch-site': 'cross-site',
      'user-agent': 'navegador de prueba',
      referer: 'https://informes.example/ruta/secreta?e=marcador',
      authorization: 'Bearer marcador',
      cookie: 'marcador=1',
      'x-forwarded-for': '192.0.2.1',
    },
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'sonda',
    route: '/',
    secFetchDest: 'iframe',
    secFetchSite: 'cross-site',
    userAgent: 'navegador de prueba',
    refererOrigin: 'https://informes.example',
  });
});

test('del Referer solo queda el origen, o el esquema si no tiene origen', async () => {
  const lines = captureLogs();
  await call('/', { headers: { referer: 'file:///C:/Users/alguien/informe.archivo?e=marcador' } });
  await call('/', { headers: { referer: 'qrc:/ruta/secreta' } });
  await call('/', { headers: { referer: 'esto no es una url' } });
  await call('/');
  assert.deepEqual(lines.map((line) => JSON.parse(line).refererOrigin), ['file:', 'qrc:', null, null]);
  assert.ok(!lines.join('').includes('marcador'));
  assert.ok(!lines.join('').includes('alguien'));
});

test('cada valor registrado se corta a 256 caracteres, en una sola línea', async () => {
  const lines = captureLogs();
  await call('/', {
    headers: {
      'sec-fetch-dest': 'a'.repeat(300),
      'sec-fetch-site': 'b'.repeat(300),
      'user-agent': `c\n{"event":"inventado"}${'c'.repeat(300)}`,
      referer: `https://${'d'.repeat(300)}.example/`,
    },
  });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('\n'));
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'sonda');
  for (const field of ['secFetchDest', 'secFetchSite', 'userAgent', 'refererOrigin']) {
    assert.equal(entry[field].length, 256, field);
  }
});

test('el front pinta con textContent y no carga nada de afuera', () => {
  const script = read('sonda/sonda.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(script));
  const page = read('sonda/index.html');
  assert.ok(!/https?:\/\//.test(page));
  assert.ok(!/ on[a-z]+=|<style|style=/.test(page));
  assert.equal([...page.matchAll(/<script/g)].length, 1);
});

test('la sonda es un servicio aparte: acotada, con registros cortos y fuera del paquete de la app', () => {
  const yml = read('sonda/serverless.yml');
  assert.match(yml, /^service: connectus-pages-sonda$/m);
  assert.match(yml, /^ {4}reservedConcurrency: 2$/m);
  assert.match(yml, /^ {2}logRetentionInDays: 7$/m);
  assert.match(yml, /^ {4}url: true$/m);
  assert.ok(!/^ {2}iam:/m.test(yml));

  const packaged = /^package:\n([\s\S]*?)\n\nresources:/m.exec(read('serverless.yml'))[1];
  assert.match(packaged, /- '!\*\*'/);
  assert.ok(!packaged.includes('sonda'));
  const { dependencies } = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(dependencies).sort(), ['aws-ssl-profiles', 'mysql2']);
  for (const file of ['sonda/handler.js', 'sonda/sonda.js']) {
    const required = [...read(file).matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    assert.ok(required.every((name) => name.startsWith('node:')), file);
  }
});
