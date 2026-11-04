'use strict';

const { chileWallClockMs } = require('../time');

const NONE = 'none';
const WINDOW_PATTERN = /^(?:d([1-9]|[12][0-9]|3[01]):)?([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])$/;
const DAY_MS = 86400000;

// HH:MM-HH:MM,... en hora de Chile, con d<N>: para el día N del mes, o none. Una ventana puede cruzar la medianoche. Devuelve null si
// el texto no es válido: el parámetro es obligatorio, y sin él no se sabe cuándo leer.
function parseQuietWindows(text) {
  if (typeof text !== 'string') return null;
  if (text === NONE) return [];
  const windows = [];
  for (const item of text.split(',')) {
    const match = WINDOW_PATTERN.exec(item);
    if (!match) return null;
    const [day, startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    if (start === end) return null;
    windows.push({ day: match[1] === undefined ? null : day, start, end });
  }
  return windows;
}

function isQuiet(windows, nowMs) {
  const today = new Date(chileWallClockMs(nowMs));
  const yesterday = new Date(today.getTime() - DAY_MS).getUTCDate();
  const minute = today.getUTCHours() * 60 + today.getUTCMinutes();
  const applies = (window, date) => window.day === null || window.day === date;
  return windows.some((window) => {
    if (window.start < window.end) return applies(window, today.getUTCDate()) && minute >= window.start && minute < window.end;
    return (applies(window, today.getUTCDate()) && minute >= window.start) || (applies(window, yesterday) && minute < window.end);
  });
}

module.exports = { isQuiet, parseQuietWindows };
