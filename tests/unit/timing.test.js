/* Darkrai unit tests: the dev-only timing module. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const timing = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'timing.js'));

test('a disabled module records nothing at all', () => {
  timing.disable();
  assert.strictEqual(timing.isEnabled(), false);

  // No performance.now() call may happen while it is off, so watch for one.
  const real = performance.now;
  let calls = 0;
  performance.now = function () { calls++; return real.call(performance); };
  try {
    timing.mark('decision-done');
    timing.mark('first-paint');
    timing.count('styleNodes', 5);
    timing.count('guardMeasured');
    timing.noteWrite();
    assert.strictEqual(timing.noteRead(), false);
    assert.strictEqual(timing.measure('decision-done', 'first-paint'), null);
    const wrapped = timing.wrapRead(function () { return 'read'; });
    assert.strictEqual(wrapped(), 'read', 'a wrapped reader still works');
  } finally {
    performance.now = real;
  }
  assert.strictEqual(calls, 0, 'the clock is never read while timing is off');

  assert.deepStrictEqual(timing.report(), {
    enabled: false,
    decisionMs: 0,
    firstPaintMs: 0,
    idleMs: 0,
    styleNodes: 0,
    adoptedSheets: 0,
    guardMeasured: 0,
    forcedReads: 0,
    marks: {}
  });
});

test('enable(false) and enable(undefined) leave it inert', () => {
  timing.disable();
  assert.strictEqual(timing.enable(false), false);
  assert.strictEqual(timing.isEnabled(), false);
  assert.strictEqual(timing.enable(undefined), false);
  assert.strictEqual(timing.isEnabled(), false);
  timing.mark('idle');
  assert.strictEqual(timing.report().idleMs, 0);
});

test('an enabled module accumulates marks and counts', () => {
  timing.disable();
  assert.strictEqual(timing.enable(true), true);

  timing.mark('store-read-done');
  timing.mark('decision-done');
  timing.mark('first-paint');
  timing.mark('idle');

  timing.count('styleNodes', 3);
  timing.count('styleNodes');
  timing.count('adoptedSheets', 2);
  timing.count('guardMeasured', 418);
  timing.count('styleNodes', 'nonsense');

  const out = timing.report();
  assert.strictEqual(out.enabled, true);
  assert.strictEqual(out.styleNodes, 4, 'the default step is one, and junk is ignored');
  assert.strictEqual(out.adoptedSheets, 2);
  assert.strictEqual(out.guardMeasured, 418);
  assert.ok(typeof out.decisionMs === 'number' && out.decisionMs >= 0);
  assert.ok(out.firstPaintMs >= out.decisionMs, 'marks move forward in time');
  assert.ok(out.marks['store-read-done'] !== undefined);

  // A mark that was never reached reads as null, not as a zero.
  assert.strictEqual(out.marks['apply-start'], undefined);
  assert.strictEqual(timing.measure('store-read-done', 'never-happened'), null);
  assert.ok(timing.measure('store-read-done', 'idle') >= 0);

  // The first value for a name wins, so a repeat cannot overwrite it.
  const firstPaint = out.firstPaintMs;
  timing.mark('first-paint');
  assert.strictEqual(timing.report().firstPaintMs, firstPaint);

  timing.disable();
});

test('the forced-read proxy counts a read after a write in the same task', async () => {
  timing.disable();
  timing.enable(true);

  // A read with nothing written yet is free.
  assert.strictEqual(timing.noteRead(), false);
  assert.strictEqual(timing.report().forcedReads, 0);

  timing.noteWrite();
  assert.strictEqual(timing.noteRead(), true, 'a read straight after a write is forced');
  assert.strictEqual(timing.noteRead(), true);
  assert.strictEqual(timing.report().forcedReads, 2);

  // The task ends at the microtask boundary, and the slate is wiped.
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(timing.noteRead(), false, 'a new task starts clean');
  assert.strictEqual(timing.report().forcedReads, 2);

  // wrapRead goes through the same counter.
  timing.noteWrite();
  const read = timing.wrapRead(function (a, b) { return a + b; });
  assert.strictEqual(read(2, 3), 5);
  assert.strictEqual(timing.report().forcedReads, 3);

  timing.disable();
  assert.strictEqual(timing.report().forcedReads, 0, 'disabling throws the numbers away');
});

test('the mark and count names the extension uses are the ones reported', () => {
  timing.disable();
  timing.enable(true);
  timing.mark(timing.MARKS.DECISION);
  timing.mark(timing.MARKS.FIRST_PAINT);
  timing.mark(timing.MARKS.IDLE);
  timing.count(timing.COUNTS.STYLE_NODES, 7);
  timing.count(timing.COUNTS.ADOPTED_SHEETS, 1);
  timing.count(timing.COUNTS.GUARD_MEASURED, 9);
  const out = timing.report();
  assert.ok(out.decisionMs !== null);
  assert.ok(out.firstPaintMs !== null);
  assert.ok(out.idleMs !== null);
  assert.strictEqual(out.styleNodes, 7);
  assert.strictEqual(out.adoptedSheets, 1);
  assert.strictEqual(out.guardMeasured, 9);
  timing.disable();
});

test('report() is a copy, so a caller cannot corrupt the numbers', () => {
  timing.disable();
  timing.enable(true);
  timing.mark('idle');
  const out = timing.report();
  out.marks.idle = -1;
  out.styleNodes = 999;
  assert.notStrictEqual(timing.report().marks.idle, -1);
  assert.strictEqual(timing.report().styleNodes, 0);
  timing.disable();
});
