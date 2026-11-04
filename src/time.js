'use strict';

const CHILE_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Santiago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
// Hay fechas en cero, que MySQL admite en filas viejas.
const NOT_A_DATE_PATTERN = /^0000|^\d{4}-00|^\d{4}-\d{2}-00/;

// La hora de Chile como si fuera UTC: los números se pueden restar con los de wallClockMs sin que entre la zona del proceso.
function chileWallClockMs(nowMs) {
  const parts = CHILE_CLOCK.formatToParts(nowMs);
  const part = (type) => Number(parts.find((item) => item.type === type).value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
}

// Un DATETIME de la base tal como viene escrito, sin pasar por la zona del proceso. Sirve para las dos clases de fechas: las de la
// plataforma, comparadas con chileWallClockMs, y las nuestras en UTC, que dan el instante real.
function wallClockMs(text) {
  const match = typeof text === 'string' && !NOT_A_DATE_PATTERN.test(text) ? DATETIME_PATTERN.exec(text) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

// De una fecha nuestra, en UTC, a dd/mm/aaaa HH:MM en hora de Chile.
function formatUtcAsChile(text) {
  const utcMs = wallClockMs(text);
  if (utcMs === null) return null;
  const [date, time] = new Date(chileWallClockMs(utcMs)).toISOString().split('T');
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year} ${time.slice(0, 5)}`;
}

// Un instante, como se guarda en las fechas nuestras.
function utcText(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { chileWallClockMs, formatUtcAsChile, utcText, wallClockMs };
