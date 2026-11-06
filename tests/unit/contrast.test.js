/* Darkrai unit tests: contrast maths and the WCAG 4.5:1 / 3:1 decisions. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const color = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'color.js'));

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const GRAY = color.resolveLook({ look: 'gray' });

test('contrast ratio matches the WCAG formula', () => {
  assert.ok(Math.abs(color.contrastRatio(WHITE, BLACK) - 21) < 0.01);
  assert.ok(Math.abs(color.contrastRatio(WHITE, WHITE) - 1) < 1e-9);
  assert.ok(Math.abs(color.contrastRatio(BLACK, BLACK) - 1) < 1e-9);
  // #777777 on white is the textbook borderline case, just under 4.5:1.
  const grey = color.contrastRatio(color.parse('#777777'), WHITE);
  assert.ok(grey > 4.4 && grey < 4.55, 'got ' + grey);
  assert.strictEqual(
    Math.round(color.contrastRatio(WHITE, BLACK) * 100),
    Math.round(color.contrastRatio(BLACK, WHITE) * 100),
    'order does not matter'
  );
});

test('relative luminance endpoints', () => {
  assert.ok(Math.abs(color.relativeLuminance(WHITE) - 1) < 1e-9);
  assert.ok(Math.abs(color.relativeLuminance(BLACK)) < 1e-9);
});

test('large text is 24px, or 18.66px when bold', () => {
  assert.strictEqual(color.isLargeText(24, false), true);
  assert.strictEqual(color.isLargeText(23.9, false), false);
  assert.strictEqual(color.isLargeText(18.66, true), true);
  assert.strictEqual(color.isLargeText(18.65, true), false);
  assert.strictEqual(color.isLargeText(19, false), false);
  assert.strictEqual(color.isLargeText('24px', false), true);
});

test('required ratio: 4.5 for normal text, 3 for large text and icons', () => {
  assert.strictEqual(color.requiredRatio({ fontSizePx: 16, bold: false }), 4.5);
  assert.strictEqual(color.requiredRatio({ fontSizePx: 16, bold: true }), 4.5);
  assert.strictEqual(color.requiredRatio({ fontSizePx: 24, bold: false }), 3);
  assert.strictEqual(color.requiredRatio({ fontSizePx: 19, bold: true }), 3);
  assert.strictEqual(color.requiredRatio({ fontSizePx: 12, isIcon: true }), 3);
  assert.strictEqual(color.requiredRatio({}), 4.5, 'unknown size is treated as normal text');
});

test('passes() is inclusive at the threshold', () => {
  assert.strictEqual(color.passes(4.5, 4.5), true);
  assert.strictEqual(color.passes(4.49, 4.5), false);
  assert.strictEqual(color.passes(3, 3), true);
  assert.strictEqual(color.passes(21, 4.5), true);
});

test('alpha compositing', () => {
  const halfWhiteOnBlack = color.composite({ r: 255, g: 255, b: 255, a: 0.5 }, BLACK);
  assert.ok(Math.abs(halfWhiteOnBlack.r - 127.5) < 0.01);
  assert.strictEqual(halfWhiteOnBlack.a, 1);

  const opaque = color.composite(WHITE, BLACK);
  assert.deepStrictEqual(opaque, { r: 255, g: 255, b: 255, a: 1 });

  // Stack is given top-most first.
  const stacked = color.compositeStack([
    { r: 0, g: 0, b: 0, a: 0.5 },
    { r: 255, g: 255, b: 255, a: 1 }
  ]);
  assert.ok(Math.abs(stacked.r - 127.5) < 0.01);

  const nothingOpaque = color.compositeStack([{ r: 0, g: 0, b: 0, a: 0 }]);
  assert.strictEqual(nothingOpaque.a, 1);
});

test('fixForContrast lifts dark-on-dark text until it passes 4.5:1', () => {
  const fg = color.parse('#333333');
  const bg = color.parse('#242424');
  const before = color.contrastRatio(fg, bg);
  assert.ok(before < 4.5, 'starting point is unreadable: ' + before);

  const fixed = color.fixForContrast(fg, bg, 4.5, GRAY);
  assert.strictEqual(fixed.changed, true);
  assert.ok(fixed.ratio >= 4.5 - 0.001, 'ratio reached ' + fixed.ratio);
  assert.ok(color.srgbToOklch(fixed.rgb).l > color.srgbToOklch(fg).l, 'it went lighter, not darker');
});

test('fixForContrast only needs 3:1 for an icon', () => {
  const fg = color.parse('#555555');
  const bg = color.parse('#2b2b2b');
  const icon = color.fixForContrast(fg, bg, 3, GRAY);
  assert.ok(icon.ratio >= 3 - 0.001, icon.ratio);
  const text = color.fixForContrast(fg, bg, 4.5, GRAY);
  assert.ok(text.ratio >= 4.5 - 0.001, text.ratio);
  assert.ok(
    color.srgbToOklch(text.rgb).l >= color.srgbToOklch(icon.rgb).l,
    'the stricter target moves further'
  );
});

test('fixForContrast leaves a readable pair alone', () => {
  const result = color.fixForContrast(color.parse('#e8e8e8'), color.parse('#242424'), 4.5, GRAY);
  assert.strictEqual(result.changed, false);
  assert.ok(result.ratio >= 4.5);
});

test('fixForContrast keeps the hue it was given', () => {
  const fg = color.parse('#8b1a1a');            // dark red
  const bg = color.parse('#2a2a2a');
  const fixed = color.fixForContrast(fg, bg, 4.5, GRAY);
  const before = color.srgbToOklch(fg).h;
  const after = color.srgbToOklch(fixed.rgb).h;
  assert.ok(Math.abs(before - after) < 12, 'hue kept: ' + before + ' vs ' + after);
});

test('fixForContrast picks the side with more contrast', () => {
  // Mid-grey text on a mid-grey background: going light is the only way up.
  const fixed = color.fixForContrast(color.parse('#8a8a8a'), color.parse('#7d7d7d'), 4.5, GRAY);
  assert.strictEqual(fixed.changed, true);
  assert.ok(fixed.ratio >= 4.5 - 0.001, fixed.ratio);
});

test('fixForContrast keeps alpha', () => {
  const fixed = color.fixForContrast({ r: 51, g: 51, b: 51, a: 0.8 }, color.parse('#242424'), 4.5, GRAY);
  assert.ok(Math.abs(fixed.rgb.a - 0.8) < 1e-6, 'alpha survived: ' + fixed.rgb.a);
});
