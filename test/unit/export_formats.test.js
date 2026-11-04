'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const zlib = require('node:zlib');

const { createCsvFormat, neutralize } = require('../../src/worker/csv');
const { cellText, createXlsxFormat, fillerOf } = require('../../src/worker/xlsx');

for (const [text, expected] of [
  ['=1+1', "'=1+1"],
  ['+56900000001', "'+56900000001"],
  ['-1', "'-1"],
  ['@x', "'@x"],
  ['\t=1', "'\t'=1"],
  ['\r=1+1', "'\r'=1+1"],
  ['\n=1', "'\n'=1"],
  ['＝1', "'＝1"],
  ['＋1', "'＋1"],
  ['－1', "'－1"],
  ['＠1', "'＠1"],
  ['hola,=1+1', "hola,'=1+1"],
  ['hola,@x', "hola,'@x"],
  ['hola,＝1', "hola,'＝1"],
  ['hola,+1', "hola,'+1"],
  ['hola\t-1', "hola\t'-1"],
  ['hola\n＋1', "hola\n'＋1"],
  ['$10.000,-', '$10.000,-'],
  ['$10.000,- pesos', '$10.000,- pesos'],
  ['hola, -1', 'hola, -1'],
  ['a=1', 'a=1'],
  ['a-1', 'a-1'],
  ['correo@x.cl', 'correo@x.cl'],
  ['', ''],
]) {
  test(`el CSV neutraliza ${JSON.stringify(text)}`, () => {
    assert.equal(neutralize(text), expected);
  });
}

const CSV_ROW = {
  id_unique: 'abc',
  deliveryName: null,
  src_number: '1000',
  dst_number: '56900000001',
  sms_content: 'a;b "c"\nd',
  status: null,
  dst_provider: 'Entel',
  created_at: '2026-10-05 01:02:03',
};

test('el CSV entrecomilla lo que hace falta, y la fila lleva las 9 columnas', () => {
  const format = createCsvFormat('Cuenta; "A"');
  assert.equal(
    format.encodeRows([CSV_ROW]),
    'abc;"Cuenta; ""A""";;1000;56900000001;"a;b ""c""\nd";;Entel;05/10/2026 01:02:03\n'
  );
  assert.ok(format.head().startsWith('﻿Identificador único;Cuenta;'));
  assert.ok(format.head().endsWith('\n'));
});

test('un CR va entre comillas', () => {
  assert.equal(createCsvFormat('x').encodeRows([{ ...CSV_ROW, sms_content: 'a\rb' }]).split(';')[5], '"a\rb"');
});

for (const [value, expected] of [
  [null, ''],
  [undefined, ''],
  [5, '5'],
  ['a&b<c>d', 'a&amp;b&lt;c&gt;d'],
  ['a\u0000b\u0001c\u0008d\u000be\u000cf\u000eg\u001fh', 'abcdefgh'],
  ['a\tb\nc\rd', 'a\tb\nc\rd'],
  ['a퟿bc�d', 'a퟿bc�d'],
  ['a￾b￿c', 'abc'],
  ['a\ud800b\udc00c', 'abc'],
  ['😀', '😀'],
  ['_x0041_', '_x005F_x0041_'],
  ['_x00E9_ y _xabcd_', '_x005F_x00E9_ y _x005F_xabcd_'],
  ['_x004_ _x00411_ x0041_', '_x004_ _x00411_ x0041_'],
  ['_x0041_x0042_', '_x005F_x0041_x005F_x0042_'],
  ['a_x0041_x0042_x0043_b', 'a_x005F_x0041_x005F_x0042_x005F_x0043_b'],
]) {
  test(`una celda de XLSX escribe ${JSON.stringify(value)} como corresponde`, () => {
    assert.equal(cellText(value), expected);
  });
}

test('una celda se recorta a 32.767 unidades, sin partir un par sustituto', () => {
  assert.equal(cellText('a'.repeat(40000)).length, 32767);
  assert.equal(cellText('a'.repeat(32767)).length, 32767);
  const pairAtEdge = cellText(`${'a'.repeat(32766)}😀b`);
  assert.equal(pairAtEdge, 'a'.repeat(32766));
  const pairFits = cellText(`${'a'.repeat(32765)}😀b`);
  assert.equal(pairFits, `${'a'.repeat(32765)}😀`);
});

test('el recorte es sobre el texto que se ve: el escape no le quita espacio', () => {
  const text = cellText(`_x0041_${'a'.repeat(40000)}`);
  assert.ok(text.startsWith('_x005F_x0041_'));
  assert.equal(text.length, 32767 + '_x005F'.length);
});

test('cada lote comprimido se puede concatenar, y el relleno no cambia el contenido', () => {
  const format = createXlsxFormat({ sheetName: 'Hoja', columns: ['A'], toValues: (row) => row });
  const chunks = ['uno ', 'dos ', 'tres'].map((text) => format.pack(Buffer.from(text)));
  const stream = Buffer.concat([chunks[0], fillerOf(11), chunks[1], chunks[2], Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff])]);
  assert.equal(zlib.inflateRawSync(stream).toString(), 'uno dos tres');
});

test('el relleno mide lo pedido o un poco más, en bloques enteros', () => {
  assert.equal(fillerOf(5).length, 5);
  assert.equal(fillerOf(6).length, 10);
  assert.equal(fillerOf(6).toString('hex'), '000000ffff000000ffff');
});

test('too_large al llegar a 4 GiB de contenido, sin ZIP64', () => {
  const format = createXlsxFormat({ sheetName: 'Hoja', columns: ['A'], toValues: (row) => row });
  assert.equal(format.isTooLarge({ plainBytes: 2 ** 32 - 1, fileBytes: 0 }), false);
  assert.equal(format.isTooLarge({ plainBytes: 2 ** 32, fileBytes: 0 }), true);
  assert.equal(format.isTooLarge({ plainBytes: 0, fileBytes: 2 ** 32 - 1 }), true);
});
