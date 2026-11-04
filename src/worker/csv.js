'use strict';

const { formatWithSeconds } = require('../sms');

const BOM = '\uFEFF';
const SEPARATOR = ';';
const COLUMNS = ['Identificador único', 'Cuenta', 'Envío', 'Número origen', 'Número destino', 'Mensaje', 'Estado', 'Proveedor', 'Fecha'];
const CONTENT_TYPE = 'text/csv; charset=utf-8';

// Una hoja de cálculo evalúa el texto como fórmula si parte con esto, también en su forma de ancho completo.
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;
// Si el archivo se abre con otro separador, lo que sigue a estos caracteres queda al inicio de una celda. Un signo seguido de
// espacio, o al final, no es fórmula: así $10.000,- queda intacto.
const FORMULA_INSIDE = /([,\t\r\n])(?=[=@＝＠]|[+\-＋－]\S)/g;
const NEEDS_QUOTES = /[;"\r\n]/;

function neutralize(text) {
  const inside = text.replace(FORMULA_INSIDE, "$1'");
  return FORMULA_START.test(inside) ? `'${inside}` : inside;
}

function quote(field) {
  return NEEDS_QUOTES.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

const textField = (value) => quote(neutralize(value === null || value === undefined ? '' : String(value)));
const line = (fields) => `${fields.join(SEPARATOR)}\n`;

function createCsvFormat(accountName) {
  return {
    contentType: CONTENT_TYPE,
    canPad: false,
    prefix: () => Buffer.alloc(0),
    head: () => BOM + line(COLUMNS.map(quote)),
    encodeRows: (rows) => rows.map((row) => line([
      textField(row.id_unique),
      textField(accountName),
      textField(row.deliveryName),
      String(row.src_number),
      String(row.dst_number),
      textField(row.sms_content),
      textField(row.status),
      textField(row.dst_provider),
      formatWithSeconds(row.created_at) ?? '',
    ])).join(''),
    tail: () => '',
    pack: (plain) => plain,
    suffix: () => Buffer.alloc(0),
    isTooLarge: () => false,
  };
}

module.exports = { createCsvFormat, neutralize };
