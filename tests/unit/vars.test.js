/*
 * Darkrai unit tests: the CSS variable rewriting in the smart engine.
 * engine-smart.js is a content script, so give it a window before loading it.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', '..', 'extension', 'shared', 'color.js'));
const engine = require(path.join(__dirname, '..', '..', 'extension', 'content', 'engine-smart.js'));

const all = () => true;
const none = () => false;

test('role variant names follow the --dr- prefix', () => {
  assert.strictEqual(engine.roleVarName('bg', '--brand'), '--dr-bg--brand');
  assert.strictEqual(engine.roleVarName('fg', '--brand'), '--dr-fg--brand');
  assert.strictEqual(engine.roleVarName('bd', '--line-subtle'), '--dr-bd--line-subtle');
});

test('a var() use points at its role variant, with the original as fallback', () => {
  assert.strictEqual(
    engine.rewriteVarUses('var(--brand)', 'bg', all),
    'var(--dr-bg--brand, var(--brand))'
  );
  assert.strictEqual(
    engine.rewriteVarUses('1px solid var(--line)', 'bd', all),
    '1px solid var(--dr-bd--line, var(--line))'
  );
});

test('an existing fallback is kept inside the original', () => {
  assert.strictEqual(
    engine.rewriteVarUses('var(--brand, #ffffff)', 'fg', all),
    'var(--dr-fg--brand, var(--brand, #ffffff))'
  );
});

test('nested var() chains are rewritten all the way down', () => {
  assert.strictEqual(
    engine.rewriteVarUses('var(--a, var(--b))', 'bg', all),
    'var(--dr-bg--a, var(--a, var(--dr-bg--b, var(--b))))'
  );
});

test('two uses in one value are both rewritten', () => {
  assert.strictEqual(
    engine.rewriteVarUses('linear-gradient(var(--from), var(--to))', 'bg', all),
    'linear-gradient(var(--dr-bg--from, var(--from)), var(--dr-bg--to, var(--to)))'
  );
});

test('a variable we never saw declared is left alone', () => {
  assert.strictEqual(engine.rewriteVarUses('var(--mystery)', 'bg', none), 'var(--mystery)');
});

test('values without var() come back untouched', () => {
  assert.strictEqual(engine.rewriteVarUses('#ffffff', 'bg', all), '#ffffff');
  assert.strictEqual(engine.rewriteVarUses('1px solid red', 'bd', all), '1px solid red');
  assert.strictEqual(engine.rewriteVarUses('', 'bg', all), '');
});

test('the marker attributes are the ones the plan names', () => {
  assert.strictEqual(engine.IDATTR, 'data-dr-id');
  assert.strictEqual(engine.MARK, 'data-darkrai');
});

// A stand-in for CSSStyleDeclaration: only getPropertyValue is used.
const decl = (map) => ({ getPropertyValue: (p) => map[p] || '' });

test('a colour shorthand that holds var() is found, since its longhands read as empty', () => {
  assert.deepStrictEqual(engine.pendingShorthands(decl({ background: 'var(--blue-100, #f0f4ff)' })), ['background']);
  assert.deepStrictEqual(engine.pendingShorthands(decl({ border: '1px solid var(--line)', outline: 'var(--ring) solid 2px' })), ['border', 'outline']);
  assert.deepStrictEqual(engine.pendingShorthands(decl({ background: '#fff' })), [], 'a plain shorthand expands into longhands already');
  assert.deepStrictEqual(engine.pendingShorthands(decl({})), []);
});

test('a declaration block with a CSS mask is recognised as a mask icon', () => {
  assert.strictEqual(engine.hasMask(decl({ 'mask-image': 'url("data:x")' })), true);
  assert.strictEqual(engine.hasMask(decl({ '-webkit-mask': 'url(a.svg) center / 100% no-repeat' })), true);
  assert.strictEqual(engine.hasMask(decl({ 'mask-image': 'none' })), false);
  assert.strictEqual(engine.hasMask(decl({ 'background-color': '#000' })), false);
});
