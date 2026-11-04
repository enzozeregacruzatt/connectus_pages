'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { chileWallClockMs, formatUtcAsChile, wallClockMs } = require('../../src/time');

test('la hora de Chile sale igual, sea cual sea la zona del proceso', () => {
  assert.equal(chileWallClockMs(Date.UTC(2026, 10, 20, 15)), Date.UTC(2026, 10, 20, 12));
  assert.equal(chileWallClockMs(Date.UTC(2026, 6, 1, 12)), Date.UTC(2026, 6, 1, 8), 'en invierno son 4 horas');
});

test('la medianoche de Chile no se confunde con las 24', () => {
  assert.equal(formatUtcAsChile('2026-11-20 03:00:00'), '20/11/2026 00:00');
});

test('de UTC a Chile cruza el día', () => {
  assert.equal(formatUtcAsChile('2026-11-20 02:30:00'), '19/11/2026 23:30');
  assert.equal(formatUtcAsChile('2026-07-01 12:00:00'), '01/07/2026 08:00');
});

test('sin fecha, sin resultado', () => {
  for (const value of [null, undefined, '', '0000-00-00 00:00:00', '2026-00-10 00:00:00', '2026-10-00 00:00:00', 'hola']) {
    assert.equal(wallClockMs(value), null, String(value));
    assert.equal(formatUtcAsChile(value), null, String(value));
  }
});

test('wallClockMs lee el texto tal como viene', () => {
  assert.equal(wallClockMs('2026-10-24 08:55:01'), Date.UTC(2026, 9, 24, 8, 55, 1));
});
