/*
 * A colour inside a var() fallback is recoloured for the declaration's role
 * (Wikipedia's sticky-sidebar fade: linear-gradient(transparent,
 * var(--background-color-base, #fff)) with the token not declared, so the
 * fallback is what paints). Without a mapper the old output is unchanged.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// engine-smart.js is a content script: give it a window before loading it.
global.window = global;
require(path.join(__dirname, '..', '..', 'extension', 'shared', 'color.js'));
const engine = require(path.join(__dirname, '..', '..', 'extension', 'content', 'engine-smart.js'));

const all = () => true;
const none = () => false;
// Stand-in for the engine's mapper: marks what it was handed.
const mark = (v) => '<' + v.trim() + '>';

test('without a mapper a fallback is kept exactly as written', () => {
  assert.strictEqual(engine.rewriteVarUses('var(--bg, #fff)', 'bg', all), 'var(--dr-bg--bg, var(--bg, #fff))');
  assert.strictEqual(engine.rewriteVarUses('var(--bg, #fff)', 'bg', none), 'var(--bg, #fff)');
});

test('the fallback of a known variable goes through the mapper', () => {
  assert.strictEqual(engine.rewriteVarUses('var(--bg, #fff)', 'bg', all, mark), 'var(--dr-bg--bg, var(--bg,<#fff>))');
});

test('the fallback of a variable never seen declared goes through the mapper too', () => {
  assert.strictEqual(
    engine.rewriteVarUses('linear-gradient(rgba(255, 255, 255, 0), var(--background-color-base, #fff))', 'bg', none, mark),
    'linear-gradient(rgba(255, 255, 255, 0), var(--background-color-base,<#fff>))'
  );
});

test('a var() without a fallback is not touched by the mapper', () => {
  assert.strictEqual(engine.rewriteVarUses('var(--x)', 'bg', none, mark), 'var(--x)');
  assert.strictEqual(engine.rewriteVarUses('var(--x)', 'bg', all, mark), 'var(--dr-bg--x, var(--x))');
});

test('lost longhands: kept unless a readable shorthand covers them', () => {
  const lost = ['background-image', 'background-color', 'border-top-color'];
  assert.deepStrictEqual(engine.lostLonghands(lost, []), lost);
  assert.deepStrictEqual(engine.lostLonghands(lost, ['background']), ['border-top-color']);
  assert.deepStrictEqual(engine.lostLonghands(lost, ['background', 'border']), []);
  assert.deepStrictEqual(engine.lostLonghands([], ['background']), []);
});

test('nested fallbacks are mapped once at each level, innermost first', () => {
  assert.strictEqual(
    engine.rewriteVarUses('var(--a, var(--b, #fff))', 'bg', all, mark),
    'var(--dr-bg--a, var(--a,<var(--dr-bg--b, var(--b,<#fff>))>))'
  );
});
