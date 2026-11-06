/*
 * Darkrai unit tests: the already-dark decision (PLAN section 6.1).
 * detect.js is a content script, so give it a window before loading it. Only
 * the pure decision function is exercised here; the sampling itself needs a
 * real browser and is covered by the fixtures.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', '..', 'extension', 'shared', 'color.js'));
const detect = require(path.join(__dirname, '..', '..', 'extension', 'content', 'detect.js'));

const dark = (n) => Array.from({ length: n }, () => ({ l: 0.12 }));
const light = (n) => Array.from({ length: n }, () => ({ l: 0.98 }));

test('a dark page with light text is left alone', () => {
  const out = detect.decide({ samples: dark(9), textLighter: true });
  assert.strictEqual(out.dark, true);
  assert.strictEqual(out.usable, 9);
  assert.strictEqual(out.darkCount, 9);
  assert.strictEqual(out.needed, 6);
  assert.strictEqual(out.confident, true);
});

test('a plain light page gets darkened', () => {
  const out = detect.decide({ samples: light(9), textLighter: false });
  assert.strictEqual(out.dark, false);
});

test('six of nine dark samples is the threshold', () => {
  const six = detect.decide({ samples: dark(6).concat(light(3)), textLighter: true });
  assert.strictEqual(six.dark, true, 'six passes');
  const five = detect.decide({ samples: dark(5).concat(light(4)), textLighter: true });
  assert.strictEqual(five.dark, false, 'five does not');
});

test('the lightness line is 0.45', () => {
  assert.strictEqual(detect.DARK_L, 0.45);
  const justDark = detect.decide({ samples: Array(9).fill({ l: 0.44 }), textLighter: true });
  assert.strictEqual(justDark.dark, true);
  const justLight = detect.decide({ samples: Array(9).fill({ l: 0.45 }), textLighter: true });
  assert.strictEqual(justLight.dark, false);
});

test('dark panels with dark text are not a dark theme', () => {
  const out = detect.decide({ samples: dark(9), textLighter: false });
  assert.strictEqual(out.dark, false, 'unreadable as it stands, so we help');
});

test('a canvas-colour sample only counts when the page declares dark', () => {
  const samples = Array(9).fill({ l: 0.12, fallback: true });
  assert.strictEqual(detect.decide({ samples, textLighter: true, declaredDark: false }).dark, false);
  assert.strictEqual(detect.decide({ samples, textLighter: true, declaredDark: true }).dark, true);
});

test('a declared dark scheme with nothing light on screen counts as dark', () => {
  // The meta-dark case: Chrome paints the canvas dark and we cannot sample text.
  const out = detect.decide({
    samples: Array(9).fill({ l: 0.12, fallback: true }),
    declaredDark: true,
    textLighter: false
  });
  assert.strictEqual(out.dark, true);
  assert.strictEqual(out.confident, true);
});

test('a declared dark scheme that paints light is not believed', () => {
  const out = detect.decide({ samples: light(9), declaredDark: true, textLighter: false });
  assert.strictEqual(out.dark, false);
});

test('photos and video are skipped, not counted', () => {
  const out = detect.decide({
    samples: dark(4).concat(Array(5).fill({ l: null, media: true })),
    textLighter: true
  });
  assert.strictEqual(out.usable, 4, 'media points drop out');
  assert.strictEqual(out.needed, 3, 'the bar scales with what we could sample');
  assert.strictEqual(out.dark, true);
});

test('no usable samples is never read as dark', () => {
  const out = detect.decide({ samples: [], textLighter: true });
  assert.strictEqual(out.dark, false);
  assert.strictEqual(out.confident, false);
  assert.strictEqual(detect.decide({}).dark, false);
  assert.strictEqual(detect.decide().dark, false);
});

test('a thin but clear sample set still decides', () => {
  const out = detect.decide({ samples: dark(4), textLighter: true });
  assert.strictEqual(out.dark, true);
  assert.strictEqual(out.confident, true);
  const thin = detect.decide({ samples: dark(2), textLighter: true });
  assert.strictEqual(thin.dark, true);
  assert.strictEqual(thin.confident, false, 'and asks for a second look');
});
