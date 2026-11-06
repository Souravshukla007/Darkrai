/* Darkrai unit tests: schedule evaluation. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const settings = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'settings.js'));

const at = (h, m) => new Date(2026, 0, 15, h, m, 0, 0);
const NIGHT = { type: 'hours', from: '19:00', to: '07:00' };
const DAY = { type: 'hours', from: '07:00', to: '19:00' };

test('always is always on', () => {
  assert.strictEqual(settings.scheduleActive({ type: 'always' }, at(3, 0), false), true);
  assert.strictEqual(settings.scheduleActive({ type: 'always' }, at(14, 0), true), true);
  assert.strictEqual(settings.scheduleActive(undefined, at(14, 0), false), true, 'missing means always');
  assert.strictEqual(settings.scheduleActive({ type: 'nonsense' }, at(14, 0), false), true);
});

test('system follows the browser or OS theme', () => {
  assert.strictEqual(settings.scheduleActive({ type: 'system' }, at(14, 0), true), true);
  assert.strictEqual(settings.scheduleActive({ type: 'system' }, at(14, 0), false), false);
  assert.strictEqual(settings.scheduleActive({ type: 'system' }, at(2, 0), false), false,
    'the clock does not matter here');
});

test('custom hours that wrap past midnight', () => {
  assert.strictEqual(settings.scheduleActive(NIGHT, at(19, 0)), true, 'on at the start');
  assert.strictEqual(settings.scheduleActive(NIGHT, at(20, 30)), true);
  assert.strictEqual(settings.scheduleActive(NIGHT, at(23, 59)), true);
  assert.strictEqual(settings.scheduleActive(NIGHT, at(0, 0)), true);
  assert.strictEqual(settings.scheduleActive(NIGHT, at(6, 59)), true);
  assert.strictEqual(settings.scheduleActive(NIGHT, at(7, 0)), false, 'off at the end');
  assert.strictEqual(settings.scheduleActive(NIGHT, at(12, 0)), false);
  assert.strictEqual(settings.scheduleActive(NIGHT, at(18, 59)), false);
});

test('custom hours inside one day', () => {
  assert.strictEqual(settings.scheduleActive(DAY, at(7, 0)), true);
  assert.strictEqual(settings.scheduleActive(DAY, at(12, 0)), true);
  assert.strictEqual(settings.scheduleActive(DAY, at(19, 0)), false);
  assert.strictEqual(settings.scheduleActive(DAY, at(6, 59)), false);
  assert.strictEqual(settings.scheduleActive(DAY, at(23, 0)), false);
});

test('odd hour values do not lock the user out', () => {
  assert.strictEqual(settings.scheduleActive({ type: 'hours', from: '08:00', to: '08:00' }, at(3, 0)), true);
  assert.strictEqual(settings.scheduleActive({ type: 'hours', from: 'x', to: '07:00' }, at(3, 0)), true);
  assert.strictEqual(settings.scheduleActive({ type: 'hours' }, at(3, 0)), true);
});

test('minutesOf parses a time of day', () => {
  assert.strictEqual(settings.minutesOf('00:00'), 0);
  assert.strictEqual(settings.minutesOf('07:30'), 450);
  assert.strictEqual(settings.minutesOf('23:59'), 1439);
  assert.strictEqual(settings.minutesOf('bad'), null);
  assert.strictEqual(settings.minutesOf(''), null);
});

test('the next change is the next boundary', () => {
  const noon = at(12, 0);
  const next = new Date(settings.nextScheduleChange(NIGHT, noon));
  assert.strictEqual(next.getHours(), 19);
  assert.strictEqual(next.getMinutes(), 0);
  assert.strictEqual(next.getDate(), noon.getDate(), 'later the same day');

  const evening = at(20, 0);
  const tomorrow = new Date(settings.nextScheduleChange(NIGHT, evening));
  assert.strictEqual(tomorrow.getHours(), 7);
  assert.strictEqual(tomorrow.getDate(), evening.getDate() + 1, 'rolls over to the morning');

  assert.strictEqual(settings.nextScheduleChange({ type: 'always' }, noon), null);
  assert.strictEqual(settings.nextScheduleChange({ type: 'system' }, noon), null);
  assert.strictEqual(settings.nextScheduleChange({ type: 'hours', from: '08:00', to: '08:00' }, noon), null);
});

test('the schedule gates the whole page decision', () => {
  const store = settings.defaults();
  store.settings.schedule = NIGHT;
  assert.strictEqual(settings.decideForPage(store, 'a.com', { now: at(20, 0) }), 'detect');
  assert.strictEqual(settings.decideForPage(store, 'a.com', { now: at(12, 0) }), 'skip');
});
