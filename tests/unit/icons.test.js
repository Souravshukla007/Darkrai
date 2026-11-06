/*
 * Darkrai unit tests: the icon-rescue decision and the picker's CSS.
 * Both are content scripts, so give them a window before loading them.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

global.window = global;
const color = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'color.js'));
const icons = require(path.join(__dirname, '..', '..', 'extension', 'content', 'icons.js'));
const picker = require(path.join(__dirname, '..', '..', 'extension', 'content', 'picker.js'));

const SIZE = 32 * 32;

/** Build a 32x32 RGBA sample: `share` of it transparent, the rest one colour. */
function sample(share, rgb) {
  const data = new Uint8ClampedArray(SIZE * 4);
  const clear = Math.round(SIZE * share);
  for (let i = 0; i < SIZE; i++) {
    const at = i * 4;
    if (i < clear) continue;                 // left at 0,0,0,0
    data[at] = rgb[0];
    data[at + 1] = rgb[1];
    data[at + 2] = rgb[2];
    data[at + 3] = 255;
  }
  return data;
}

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const DARK_GREY = [40, 42, 46];
const RED = [220, 30, 30];

test('counting a sample adds up', () => {
  const counts = icons.countPixels(sample(0.5, BLACK));
  assert.strictEqual(counts.total, SIZE);
  assert.strictEqual(counts.transparent, SIZE / 2);
  assert.strictEqual(counts.visible, SIZE / 2);
  assert.strictEqual(counts.dark, SIZE / 2);
  assert.strictEqual(counts.colourful, 0);
});

test('a dark, nearly colourless glyph on transparency is inverted', () => {
  assert.strictEqual(icons.shouldInvert(icons.countPixels(sample(0.5, BLACK))), true);
  assert.strictEqual(icons.shouldInvert(icons.countPixels(sample(0.3, DARK_GREY))), true);
  assert.strictEqual(icons.shouldInvert(icons.countPixels(sample(0.25, BLACK))), true,
    'exactly a quarter transparent still counts');
});

test('a light glyph is left alone: it is already visible on a dark page', () => {
  assert.strictEqual(icons.shouldInvert(icons.countPixels(sample(0.5, WHITE))), false);
});

test('a coloured logo is left alone, hue and all', () => {
  assert.strictEqual(icons.shouldInvert(icons.countPixels(sample(0.5, RED))), false);
});

test('a photo with no transparency is never inverted', () => {
  assert.strictEqual(icons.shouldInvert(icons.countPixels(sample(0, BLACK))), false);
  assert.strictEqual(icons.shouldInvert(icons.countPixels(sample(0.2, BLACK))), false,
    'under a quarter transparent is a picture, not an icon');
});

test('an empty or unreadable sample decides nothing', () => {
  assert.strictEqual(icons.shouldInvert(null), false);
  assert.strictEqual(icons.shouldInvert({ total: 0, visible: 0 }), false);
  assert.strictEqual(icons.shouldInvert(icons.countPixels(sample(1, BLACK))), false,
    'all transparent: nothing to invert');
});

test('SVG images are recognised at any size', () => {
  assert.strictEqual(icons.isSvgUrl('https://a.com/logo.svg'), true);
  assert.strictEqual(icons.isSvgUrl('https://a.com/logo.svg?v=3'), true);
  assert.strictEqual(icons.isSvgUrl('data:image/svg+xml;base64,AAAA'), true);
  assert.strictEqual(icons.isSvgUrl('https://a.com/photo.png'), false);
  assert.strictEqual(icons.isSvgUrl('https://a.com/page#logo.svg'), false);
  assert.strictEqual(icons.isSvgUrl(''), false);
});

test('the thresholds are the ones the plan names', () => {
  assert.strictEqual(icons.MAX_HEIGHT, 128);
  assert.strictEqual(icons.SAMPLE, 32);
  assert.strictEqual(icons.MIN_TRANSPARENT, 0.25);
});

test('a remembered fix turns into CSS that matches the look', () => {
  const look = color.resolveLook({ look: 'gray' });
  const invert = picker.ruleFor({ selector: 'header .logo', action: 'invert' }, look);
  assert.ok(invert.indexOf('header .logo{filter:invert(1)') === 0, invert);
  assert.ok(invert.indexOf('!important') > -1);

  const readable = picker.ruleFor({ selector: '.note', action: 'readable' }, look);
  assert.ok(readable.indexOf('.note{color:rgb(') === 0, readable);
  assert.ok(readable.indexOf('.note *{') > -1, 'descendants follow the text colour');
  assert.strictEqual(picker.ruleFor({ action: 'invert' }, look), '', 'no selector, no rule');
});

test('generated ids and classes are not used in a saved selector', () => {
  assert.strictEqual(picker.looksGenerated('css-1x7zq9'), true);
  assert.strictEqual(picker.looksGenerated('ember1234'), true);
  assert.strictEqual(picker.looksGenerated('item-12345'), true);
  assert.strictEqual(picker.looksGenerated('dr-ring'), true);
  assert.strictEqual(picker.looksGenerated(''), true);
  assert.strictEqual(picker.looksGenerated('site-header'), false);
  assert.strictEqual(picker.looksGenerated('logo'), false);
});
