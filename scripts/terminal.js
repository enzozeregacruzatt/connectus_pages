'use strict';

const fs = require('node:fs');
const tty = require('node:tty');

// Un error de uso: su mensaje se muestra tal cual, y nunca debe repetir lo que se escribió.
class UserError extends Error {}

function openTerminal(noTerminalMessage) {
  let readFd;
  let writeFd;
  try {
    readFd = fs.openSync('/dev/tty', 'r');
    writeFd = fs.openSync('/dev/tty', 'w');
  } catch {
    throw new UserError(noTerminalMessage);
  }
  const input = new tty.ReadStream(readFd);
  input.setEncoding('utf8');
  return {
    write: (text) => fs.writeSync(writeFd, text),
    readHidden(prompt) {
      return new Promise((resolve, reject) => {
        let value = '';
        const finish = (settle, result) => {
          input.removeListener('data', onData);
          input.setRawMode(false);
          input.pause();
          fs.writeSync(writeFd, '\n');
          settle(result);
        };
        const onData = (chunk) => {
          for (const char of chunk) {
            if (char === '\r' || char === '\n') return finish(resolve, value);
            if (char === '\u0003' || char === '\u0004') return finish(reject, new UserError('Cancelado.'));
            if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
            else if (char === '\u0015') value = '';
            else if (char >= ' ') value += char;
          }
        };
        // Antes del aviso: lo que se escriba apenas aparece no debe alcanzar a verse en pantalla.
        input.setRawMode(true);
        fs.writeSync(writeFd, prompt);
        input.resume();
        input.on('data', onData);
      });
    },
    close() {
      input.destroy();
      fs.closeSync(writeFd);
    },
  };
}

module.exports = { UserError, openTerminal };
