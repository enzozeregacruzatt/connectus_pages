'use strict';

const zlib = require('node:zlib');

const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const MAX_CELL_UNITS = 32767;
// Sin ZIP64: sus campos de tamaño y posición son de 32 bits. El margen es para lo que viene después del contenido.
const MAX_PLAIN_BYTES = 2 ** 32;
const MAX_FILE_BYTES = 2 ** 32 - 65536;

// Bloques "stored" vacíos: el corte de Z_FULL_FLUSH queda alineado a byte, así que se pueden agregar sin tocar nada de lo anterior.
const CLOSE_BLOCK = Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff]);
const FILLER_BLOCK = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff]);

const INVALID_XML_CHARS = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
// Con lookahead, porque dos secuencias pueden compartir el guion bajo.
const EXCEL_ESCAPE = /_(?=x[0-9A-Fa-f]{4}_)/g;
const XML_SPECIALS = /[&<>]/g;
const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const END_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
// Da lo mismo cuál: se fija para que un archivo reanudado salga igual a uno de corrido.
const DOS_DATE = (46 << 9) | (1 << 5) | 1;

function truncateCell(text) {
  if (text.length <= MAX_CELL_UNITS) return text;
  const lastUnit = text.charCodeAt(MAX_CELL_UNITS - 1);
  const splitsPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return text.slice(0, splitsPair ? MAX_CELL_UNITS - 1 : MAX_CELL_UNITS);
}

// Primero se recorta y después se escapa: el límite de Excel es sobre el texto que muestra.
function cellText(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return truncateCell(text.replace(INVALID_XML_CHARS, ''))
    .replace(EXCEL_ESCAPE, '_x005F_')
    .replace(XML_SPECIALS, (char) => XML_ENTITIES[char]);
}

// inlineStr: un texto que parte con = queda como texto, sin nada que neutralizar.
function rowXml(values) {
  const cells = values.map((value) => `<c t="inlineStr"><is><t xml:space="preserve">${cellText(value)}</t></is></c>`);
  return `<row>${cells.join('')}</row>`;
}

function zipHeaderFields({ flags, method, crc, compressedSize, plainSize, nameLength }) {
  const fields = Buffer.alloc(26);
  fields.writeUInt16LE(ZIP_VERSION, 0);
  fields.writeUInt16LE(flags, 2);
  fields.writeUInt16LE(method, 4);
  fields.writeUInt16LE(0, 6);
  fields.writeUInt16LE(DOS_DATE, 8);
  fields.writeUInt32LE(crc, 10);
  fields.writeUInt32LE(compressedSize, 14);
  fields.writeUInt32LE(plainSize, 18);
  fields.writeUInt16LE(nameLength, 22);
  return fields;
}

function localEntry(entry) {
  const signature = Buffer.alloc(4);
  signature.writeUInt32LE(LOCAL_SIGNATURE);
  return Buffer.concat([signature, zipHeaderFields(entry), entry.name, entry.data ?? Buffer.alloc(0)]);
}

function centralEntry(entry, offset) {
  const head = Buffer.alloc(6);
  head.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  head.writeUInt16LE(ZIP_VERSION, 4);
  const tail = Buffer.alloc(14);
  tail.writeUInt32LE(offset, 10);
  return Buffer.concat([head, zipHeaderFields(entry), tail, entry.name]);
}

function fixedEntries(sheetName) {
  const files = {
    '[Content_Types].xml': `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>',
    '_rels/.rels': `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>',
    'xl/workbook.xml': `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>',
  };
  return Object.entries(files).map(([name, text]) => {
    const data = Buffer.from(text, 'utf8');
    return {
      name: Buffer.from(name, 'latin1'),
      data,
      flags: 0,
      method: METHOD_STORED,
      crc: zlib.crc32(data),
      compressedSize: data.length,
      plainSize: data.length,
      nameLength: Buffer.byteLength(name, 'latin1'),
    };
  });
}

// Encabezado del contenido en flujo: su CRC y sus tamaños recién se conocen al final, en el descriptor y en el directorio central.
const sheetEntry = (fields = {}) => ({
  name: Buffer.from(SHEET_PATH, 'latin1'),
  flags: FLAG_DATA_DESCRIPTOR,
  method: METHOD_DEFLATE,
  crc: 0,
  compressedSize: 0,
  plainSize: 0,
  nameLength: SHEET_PATH.length,
  ...fields,
});

function zipSuffix(entries, prefixLength, sheetOffset, { crc, plainBytes, fileBytes }) {
  const compressedSize = fileBytes + CLOSE_BLOCK.length - prefixLength;
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(plainBytes, 12);

  let offset = 0;
  const central = entries.map((entry) => {
    const record = centralEntry(entry, offset);
    offset += 30 + entry.nameLength + entry.data.length;
    return record;
  });
  central.push(centralEntry(sheetEntry({ crc, compressedSize, plainSize: plainBytes }), sheetOffset));
  const centralBytes = Buffer.concat(central);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(fileBytes + CLOSE_BLOCK.length + descriptor.length, 16);
  return Buffer.concat([CLOSE_BLOCK, descriptor, centralBytes, end]);
}

// toValues recibe la fila y devuelve sus celdas, en el orden de columns.
function createXlsxFormat({ sheetName, columns, toValues }) {
  const entries = fixedEntries(sheetName);
  const fixed = Buffer.concat(entries.map(localEntry));
  const prefix = Buffer.concat([fixed, localEntry(sheetEntry())]);
  return {
    contentType: CONTENT_TYPE,
    canPad: true,
    prefix: () => prefix,
    head: () => `${XML_HEADER}<worksheet xmlns="${MAIN_NS}"><sheetData>${rowXml(columns)}`,
    encodeRows: (rows) => rows.map((row) => rowXml(toValues(row))).join(''),
    tail: () => '</sheetData></worksheet>',
    // Cada lote se comprime por su cuenta y deja un corte alineado, sin depender del anterior: así se puede seguir en otra invocación.
    pack: (plain) => zlib.deflateRawSync(plain, { finishFlush: zlib.constants.Z_FULL_FLUSH }),
    suffix: (progress) => zipSuffix(entries, prefix.length, fixed.length, progress),
    isTooLarge: ({ plainBytes, fileBytes }) => plainBytes >= MAX_PLAIN_BYTES || fileBytes >= MAX_FILE_BYTES,
  };
}

// Relleno de bloques vacíos, hasta completar al menos bytes.
function fillerOf(bytes) {
  return Buffer.alloc(Math.ceil(bytes / FILLER_BLOCK.length) * FILLER_BLOCK.length, FILLER_BLOCK);
}

module.exports = { cellText, createXlsxFormat, fillerOf };
