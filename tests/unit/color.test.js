/* Darkrai unit tests: colour parsing, the OKLCH transform and role mapping. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const color = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'color.js'));

const GRAY = color.resolveLook({ look: 'gray', brightness: 100, contrast: 100, warmth: 0 });

function L(cssColor) {
  const rgb = color.parse(cssColor);
  assert.ok(rgb, 'should parse ' + cssColor);
  return color.srgbToOklch(rgb).l;
}

test('parses every syntax we promise to transform', () => {
  assert.deepStrictEqual(color.parse('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepStrictEqual(color.parse('#000000'), { r: 0, g: 0, b: 0, a: 1 });
  const half = color.parse('#00000080');
  assert.ok(Math.abs(half.a - 0.502) < 0.01);
  assert.deepStrictEqual(color.parse('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.strictEqual(color.parse('rgba(0, 0, 0, 0.5)').a, 0.5);
  assert.strictEqual(color.parse('rgb(0 0 0 / 25%)').a, 0.25);

  const red = color.parse('hsl(0 100% 50%)');
  assert.ok(Math.round(red.r) === 255 && Math.round(red.g) === 0 && Math.round(red.b) === 0);

  const named = color.parse('rebeccapurple');
  assert.deepStrictEqual(named, { r: 0x66, g: 0x33, b: 0x99, a: 1 });

  const white = color.parse('oklch(1 0 0)');
  assert.ok(Math.round(white.r) === 255);
  assert.ok(color.parse('oklab(0 0 0)'));
  assert.ok(color.parse('hwb(0 0% 0%)'));
  assert.ok(color.parse('color(srgb 1 1 1)'));
  assert.ok(color.parse('lab(100 0 0)'));
});

test('leaves keywords and system colours alone', () => {
  ['transparent', 'currentColor', 'inherit', 'initial', 'unset', 'none',
    'Canvas', 'CanvasText', 'ButtonFace', 'LinkText'].forEach((keyword) => {
      assert.strictEqual(color.parse(keyword), null, keyword + ' must not parse');
      assert.strictEqual(color.transformColor(keyword, 'bg', GRAY), null);
    });
});

test('the look table matches the plan', () => {
  assert.deepStrictEqual(color.LOOKS.gray, { base: 0.21, top: 0.90 });
  assert.deepStrictEqual(color.LOOKS.black, { base: 0.00, top: 0.92 });
  assert.deepStrictEqual(color.LOOKS.soft, { base: 0.27, top: 0.82 });
  assert.strictEqual(GRAY.base, 0.21);
  assert.strictEqual(GRAY.top, 0.90);
  const brighter = color.resolveLook({ look: 'gray', brightness: 150, contrast: 100, warmth: 0 });
  assert.ok(brighter.base > GRAY.base, 'brightness lifts the base');
  const unknown = color.resolveLook({ look: 'neon' });
  assert.strictEqual(unknown.name, 'gray');
});

test('background transform: light goes dark, dark stays dark', () => {
  // L >= 0.5 -> base + (1 - L) * 0.6, chroma * 0.8
  const white = color.transformOklch({ l: 1, c: 0, h: 0 }, 'bg', GRAY);
  assert.ok(Math.abs(white.l - 0.21) < 1e-9, 'white -> base');

  const mid = color.transformOklch({ l: 0.5, c: 0.1, h: 30 }, 'bg', GRAY);
  assert.ok(Math.abs(mid.l - (0.21 + 0.5 * 0.6)) < 1e-9);
  assert.ok(Math.abs(mid.c - 0.08) < 1e-9, 'chroma x 0.8');

  // L < 0.5 -> keep, clamped into [base, 0.5]
  const alreadyDark = color.transformOklch({ l: 0.3, c: 0.05, h: 200 }, 'bg', GRAY);
  assert.strictEqual(alreadyDark.l, 0.3, 'a dark header stays as it is');
  assert.strictEqual(alreadyDark.c, 0.05, 'chroma untouched below 0.5');

  const nearBlack = color.transformOklch({ l: 0.05, c: 0, h: 0 }, 'bg', GRAY);
  assert.strictEqual(nearBlack.l, 0.21, 'clamped up to the base');
});

test('text transform: dark goes light, light is kept', () => {
  const black = color.transformOklch({ l: 0, c: 0, h: 0 }, 'fg', GRAY);
  assert.ok(Math.abs(black.l - 0.90) < 1e-9, 'black -> top');

  const dark = color.transformOklch({ l: 0.4, c: 0, h: 0 }, 'fg', GRAY);
  assert.ok(Math.abs(dark.l - (0.90 - 0.4 * 0.35)) < 1e-9);

  const light = color.transformOklch({ l: 0.8, c: 0, h: 0 }, 'fg', GRAY);
  assert.strictEqual(light.l, 0.8, 'already-light text is kept');

  const veryLight = color.transformOklch({ l: 1, c: 0, h: 0 }, 'fg', GRAY);
  assert.ok(Math.abs(veryLight.l - 0.95) < 1e-9, 'capped at top + 0.05');
});

test('border transform lands inside 0.30 - 0.55', () => {
  for (let l = 0; l <= 1.0001; l += 0.1) {
    const out = color.transformOklch({ l, c: 0.02, h: 10 }, 'bd', GRAY);
    assert.ok(out.l >= 0.30 - 1e-9 && out.l <= 0.55 + 1e-9, 'L=' + l + ' -> ' + out.l);
  }
  assert.ok(Math.abs(color.transformOklch({ l: 0, c: 0, h: 0 }, 'bd', GRAY).l - 0.55) < 1e-9);
  assert.ok(Math.abs(color.transformOklch({ l: 1, c: 0, h: 0 }, 'bd', GRAY).l - 0.30) < 1e-9);
});

test('role mapping by property name', () => {
  const r = color.roleForProperty;
  assert.strictEqual(r('background-color'), 'bg');
  assert.strictEqual(r('background'), 'bg');
  assert.strictEqual(r('background-image'), 'bg');
  assert.strictEqual(r('color'), 'fg');
  assert.strictEqual(r('fill'), 'fg');
  assert.strictEqual(r('stroke'), 'fg');
  assert.strictEqual(r('caret-color'), 'fg');
  assert.strictEqual(r('-webkit-text-fill-color'), 'fg');
  assert.strictEqual(r('border-top-color'), 'bd');
  assert.strictEqual(r('border'), 'bd');
  assert.strictEqual(r('outline-color'), 'bd');
  assert.strictEqual(r('box-shadow'), 'bd');
  assert.strictEqual(r('column-rule-color'), 'bd');
  assert.strictEqual(r('width'), null);
  assert.strictEqual(r('font-size'), null);
  assert.strictEqual(r('--brand'), null, 'custom properties take their role from use');
});

test('a masked element paints its glyph with background colour, so that is a foreground role', () => {
  const r = color.roleForProperty;
  const masked = { masked: true };
  assert.strictEqual(r('background-color', masked), 'fg');
  assert.strictEqual(r('background', masked), 'fg');
  assert.strictEqual(r('background-image', masked), 'bg', 'only the colour is the glyph');
  assert.strictEqual(r('color', masked), 'fg');
  assert.strictEqual(r('border-color', masked), 'bd');
  assert.strictEqual(r('background-color', { masked: false }), 'bg');
  assert.strictEqual(r('background-color', null), 'bg');
  // Dark Codex token #202122 must come out light under the foreground role.
  const L = (css) => color.srgbToOklch(color.parse(css)).l;
  assert.ok(L(color.transformColor('#202122', 'fg', color.resolveLook({}))) > 0.7);
});

test('transformColor darkens backgrounds and lightens text, keeping hue', () => {
  const bg = color.transformColor('#ffffff', 'bg', GRAY);
  assert.ok(L(bg) < 0.3, 'white background became dark: ' + bg);

  const fg = color.transformColor('#000000', 'fg', GRAY);
  assert.ok(L(fg) > 0.85, 'black text became light: ' + fg);

  const srcHue = color.srgbToOklch(color.parse('#c62828')).h;
  const outHue = color.srgbToOklch(color.parse(color.transformColor('#c62828', 'bg', GRAY))).h;
  assert.ok(Math.abs(srcHue - outHue) < 8, 'a red button stays red (' + srcHue + ' vs ' + outHue + ')');

  const alpha = color.transformColor('rgba(255, 255, 255, 0.4)', 'bg', GRAY);
  assert.ok(/^rgba\(/.test(alpha) && /0\.4\)$/.test(alpha), 'alpha is kept: ' + alpha);
});

test('out-of-gamut results are pulled back into sRGB', () => {
  const out = color.oklchToSrgb({ l: 0.9, c: 0.4, h: 140 });
  [out.r, out.g, out.b].forEach((channel) => {
    assert.ok(channel >= 0 && channel <= 255, 'channel in range: ' + channel);
  });
});

test('transformValue walks whole declaration values', () => {
  const grad = color.transformValue('linear-gradient(to right, #ffffff, #000000)', 'bg', GRAY);
  assert.ok(grad.startsWith('linear-gradient(to right,'), grad);
  assert.ok(!grad.includes('#ffffff') && !grad.includes('#000000'), 'both stops moved: ' + grad);

  const mixed = color.transformValue('color-mix(in oklab, #ffffff 50%, #000000)', 'bg', GRAY);
  assert.ok(mixed.startsWith('color-mix(in oklab,'), mixed);
  assert.ok(!mixed.includes('#ffffff'), 'arguments transformed: ' + mixed);

  const withUrl = color.transformValue('url(photo.png) no-repeat #ffffff', 'bg', GRAY);
  assert.ok(withUrl.includes('url(photo.png)'), 'url() untouched: ' + withUrl);
  assert.ok(!withUrl.includes('#ffffff'));

  const lightDark = color.transformValue('light-dark(#ffffff, #101010)', 'bg', GRAY);
  assert.strictEqual(lightDark, 'light-dark(#ffffff, #101010)', 'light-dark() is the site\'s own choice');

  const vars = color.transformValue('var(--brand)', 'bg', GRAY);
  assert.strictEqual(vars, 'var(--brand)', 'var() is handled by the variable pass');

  const shadow = color.transformValue('0 1px 2px rgba(0, 0, 0, 0.2)', 'bd', GRAY);
  assert.ok(shadow.startsWith('0 1px 2px '), shadow);

  const quoted = color.transformValue('"white"', 'fg', GRAY);
  assert.strictEqual(quoted, '"white"', 'strings are left alone');

  assert.strictEqual(color.transformValue('12px', 'bg', GRAY), '12px');
});

test('hasColor spots values worth transforming', () => {
  assert.ok(color.hasColor('#abc'));
  assert.ok(color.hasColor('rgb(1,2,3)'));
  assert.ok(color.hasColor('1px solid red'));
  assert.ok(!color.hasColor('1px solid'));
  assert.ok(!color.hasColor('12px'));
  assert.ok(!color.hasColor('transparent'));
});

test('results are cached in a bounded LRU', () => {
  color.clearCache();
  assert.strictEqual(color.cacheSize(), 0);
  color.transformColor('#123456', 'bg', GRAY);
  const first = color.cacheSize();
  assert.ok(first > 0);
  color.transformColor('#123456', 'bg', GRAY);
  assert.strictEqual(color.cacheSize(), first, 'a repeat hit adds nothing');
  for (let i = 0; i < 12000; i++) {
    color.transformColor('rgb(' + (i % 256) + ',' + (Math.floor(i / 256) % 256) + ',' + (i % 251) + ')', 'fg', GRAY);
  }
  assert.ok(color.cacheSize() <= 10000, 'cache stays bounded: ' + color.cacheSize());
  assert.ok(color.cacheSize() > 9000, 'and it is actually full: ' + color.cacheSize());
  color.clearCache();
});

test('a cached transformValue is the same answer as an uncached one', () => {
  const cases = [
    'color-mix(in oklch, #ff0000 40%, white)',
    'linear-gradient(to right, #ffffff 0%, rgba(0, 0, 0, 0.4) 50%, red 100%)',
    'var(--brand, #336699)',
    '1px solid #cccccc',
    'url("photo.png") no-repeat #ffffff'
  ];
  for (const value of cases) {
    for (const role of ['bg', 'fg', 'bd']) {
      color.clearCache();
      const cold = color.transformValue(value, role, GRAY);
      const warm = color.transformValue(value, role, GRAY);     // straight from the cache
      assert.strictEqual(warm, cold, value + ' as ' + role);
    }
  }
});

test('a cached hasColor is the same answer as an uncached one', () => {
  const cases = ['#abc', 'rgb(1,2,3)', '1px solid red', '1px solid', '12px', 'transparent',
    'color-mix(in oklch, red, blue)', 'var(--x)'];
  for (const value of cases) {
    color.clearCache();
    const cold = color.hasColor(value);
    assert.strictEqual(color.hasColor(value), cold, value);
  }
});

test('clearCache empties the value and hasColor caches too', () => {
  color.clearCache();
  assert.deepStrictEqual(color.cacheSizes(), { color: 0, value: 0, hasColor: 0 });
  color.transformValue('linear-gradient(red, #0000ff)', 'bg', GRAY);
  color.hasColor('1px solid red');
  const sizes = color.cacheSizes();
  assert.ok(sizes.value > 0, 'transformValue filled its cache');
  assert.ok(sizes.hasColor > 0, 'hasColor filled its cache');
  color.clearCache();
  assert.deepStrictEqual(color.cacheSizes(), { color: 0, value: 0, hasColor: 0 });
});

test('the value and hasColor caches stay bounded', () => {
  color.clearCache();
  for (let i = 0; i < 5000; i++) color.transformValue('1px solid #' + (i % 1000 + 1000) + '0', 'bd', GRAY);
  for (let i = 0; i < 3000; i++) color.hasColor('margin-' + i + ': 1px');
  const sizes = color.cacheSizes();
  assert.ok(sizes.value <= 4000, 'transformValue cache bounded: ' + sizes.value);
  assert.ok(sizes.hasColor <= 2000, 'hasColor cache bounded: ' + sizes.hasColor);
  color.clearCache();
});
