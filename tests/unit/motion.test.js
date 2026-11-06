/*
 * Darkrai unit tests: the one piece of the liquid-glass look that is logic.
 * "Should this move?" and "is this surface glass or solid?" live in one place
 * so the popup and the options page cannot answer them differently.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const motion = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'motion.js'));

test('motion runs when nothing is asking it not to', () => {
  assert.strictEqual(motion.shouldAnimate({
    reducedMotion: false, forcedColors: false, highContrast: false, hidden: false
  }), true);
  assert.strictEqual(motion.shouldAnimate({}), true, 'an empty question means no objection');
  assert.strictEqual(motion.shouldAnimate(), true);
});

test('motion is off for reduced motion, a hidden surface and forced colors', () => {
  assert.strictEqual(motion.shouldAnimate({ reducedMotion: true }), false);
  assert.strictEqual(motion.shouldAnimate({ hidden: true }), false,
    'a popup that is not on screen animates nothing');
  assert.strictEqual(motion.shouldAnimate({ forcedColors: true }), false);
});

test('more contrast asks for a readable surface, not a still one', () => {
  assert.strictEqual(motion.shouldAnimate({ highContrast: true }), true);
  assert.strictEqual(motion.surfaceMode({ highContrast: true }), 'solid');
});

test('surfaceMode is solid for forced colors and more contrast, glass otherwise', () => {
  assert.strictEqual(motion.surfaceMode({ forcedColors: true }), 'solid');
  assert.strictEqual(motion.surfaceMode({ forcedColors: true, highContrast: true }), 'solid');
  assert.strictEqual(motion.surfaceMode({ forcedColors: false, highContrast: false }), 'glass');
  assert.strictEqual(motion.surfaceMode({}), 'glass');
  assert.strictEqual(motion.surfaceMode(), 'glass');
});

test('reading the environment never throws where there is no matchMedia', () => {
  // This is Node: no window, no matchMedia, no document.
  assert.deepStrictEqual(motion.state(), {
    reducedMotion: false, forcedColors: false, highContrast: false, hidden: false
  });
  assert.strictEqual(motion.animate(), true);
  assert.strictEqual(motion.surface(), 'glass');
});

test('a matchMedia that answers yes is believed, and one that throws is not fatal', () => {
  const held = globalThis.matchMedia;
  try {
    globalThis.matchMedia = function (query) {
      return { matches: query === '(prefers-reduced-motion: reduce)' };
    };
    assert.strictEqual(motion.reduced(), true);
    assert.strictEqual(motion.forcedColors(), false);
    assert.strictEqual(motion.animate(), false);

    globalThis.matchMedia = function () { throw new Error('no media engine here'); };
    assert.strictEqual(motion.reduced(), false);
    assert.strictEqual(motion.animate(), true, 'a broken media query must not stop the UI');
  } finally {
    if (held === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = held;
  }
});
