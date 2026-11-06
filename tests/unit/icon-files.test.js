/*
 * Darkrai unit tests: the twelve toolbar icon files.
 *
 * These decode the PNGs and look at real pixels. Nothing here checks that a
 * file exists and stops there -- "the file is on disk" would pass against the
 * flat placeholders this build replaced.
 *
 * The two assertions with teeth are OFF being true greyscale and OFF's alpha
 * channel being byte-identical to ON's. Together they say OFF was derived from
 * the ON artwork by a colour transform rather than drawn as a separate grey
 * picture, which is what makes the two states the same mark.
 *
 * Note the file name: unit/icons.test.js already exists and covers the
 * in-page icon-rescue decision. It is unrelated to these files.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// One codec, shared with tools/icons/build-icons.js, so the generator and the
// test can never disagree about what a pixel is.
const png = require(path.join(__dirname, '..', '..', 'tools', 'icons', 'png.js'));

const ICONS = path.join(__dirname, '..', '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const STATES = ['on', 'native', 'off'];

const cache = new Map();

function load(state, size) {
  const key = state + '-' + size;
  if (!cache.has(key)) {
    cache.set(key, png.decode(fs.readFileSync(path.join(ICONS, key + '.png'))));
  }
  return cache.get(key);
}

function spread(rgba, i) {
  return Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) - Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
}

function alphaBytes(rgba) {
  const out = Buffer.alloc(rgba.length / 4);
  for (let i = 0, j = 3; j < rgba.length; i++, j += 4) out[i] = rgba[j];
  return out;
}

/** Alpha-weighted mean of (max-min)/255 over the ink. 0 is perfectly grey. */
function meanChroma(rgba) {
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 0) continue;
    sum += (a / 255) * spread(rgba, i) / 255;
    weight += a / 255;
  }
  return weight > 0 ? sum / weight : 0;
}

/** Sum of alpha over the whole image, in whole-pixel units. */
function inkMass(rgba) {
  let mass = 0;
  for (let i = 3; i < rgba.length; i += 4) mass += rgba[i] / 255;
  return mass;
}

// 1. all twelve decode, as 8-bit non-interlaced RGBA
test('all twelve icon files exist and are valid 8-bit RGBA PNGs', () => {
  for (const state of STATES) {
    for (const size of SIZES) {
      const name = state + '-' + size + '.png';
      const file = path.join(ICONS, name);
      assert.ok(fs.existsSync(file), name + ' is missing from extension/icons');
      const image = load(state, size);
      assert.strictEqual(image.colorType, 6, name + ' has colour type ' + image.colorType +
        ', expected 6 (RGBA)');
      assert.strictEqual(image.depth, 8, name + ' has bit depth ' + image.depth + ', expected 8');
      assert.strictEqual(image.interlace, 0, name + ' is interlaced');
    }
  }
});

// 2. each is exactly its nominal square size
test('each icon is exactly its nominal square size', () => {
  for (const state of STATES) {
    for (const size of SIZES) {
      const image = load(state, size);
      assert.strictEqual(image.width, size,
        state + '-' + size + '.png is ' + image.width + ' px wide, expected ' + size);
      assert.strictEqual(image.height, size,
        state + '-' + size + '.png is ' + image.height + ' px tall, expected ' + size);
    }
  }
});

// 3. OFF is true greyscale
test('every off-* icon is true greyscale', () => {
  for (const size of SIZES) {
    const { rgba } = load('off', size);
    let worst = 0;
    let worstAt = -1;
    let dirtyTransparent = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 0) {
        if (rgba[i] || rgba[i + 1] || rgba[i + 2]) dirtyTransparent++;
        continue;
      }
      const d = spread(rgba, i);
      if (d > worst) { worst = d; worstAt = i / 4; }
    }
    assert.ok(worst <= 1, 'off-' + size + '.png: worst R/G/B spread is ' + worst +
      ' at pixel index ' + worstAt + ', expected 0 or 1');
    assert.strictEqual(dirtyTransparent, 0, 'off-' + size + '.png: ' + dirtyTransparent +
      ' fully transparent pixel(s) carry colour, expected R=G=B=0');
  }
});

// 4. ON is not greyscale
test('every on-* icon carries real colour', () => {
  for (const size of SIZES) {
    const { rgba } = load('on', size);
    let solid = 0;
    let saturated = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] < 200) continue;
      solid++;
      if (spread(rgba, i) >= 24) saturated++;
    }
    assert.ok(solid > 0, 'on-' + size + '.png has no pixel at alpha 200 or above');
    assert.ok(saturated >= 20, 'on-' + size + '.png has only ' + saturated +
      ' saturated pixel(s) among ' + solid + ' solid ones, expected at least 20');
    const share = saturated / solid;
    assert.ok(share >= 0.25, 'on-' + size + '.png: only ' + (share * 100).toFixed(1) +
      '% of its solid pixels are saturated, expected at least 25%');
  }
});

// 5. NATIVE is tellable from both of the others
test('every native-* icon is tellable from both on-* and off-*', () => {
  for (const size of SIZES) {
    const native = load('native', size);
    const on = load('on', size);

    // (a) it has hue, so it is not OFF
    let strong = 0;
    let hued = 0;
    for (let i = 0; i < native.rgba.length; i += 4) {
      if (native.rgba[i + 3] < 128) continue;
      strong++;
      if (spread(native.rgba, i) >= 12) hued++;
    }
    assert.ok(strong > 0, 'native-' + size + '.png has no pixel at alpha 128 or above');
    const huedShare = hued / strong;
    assert.ok(huedShare >= 0.10, 'native-' + size + '.png: only ' + (huedShare * 100).toFixed(1) +
      '% of its strong pixels carry hue, expected at least 10%');

    // (b) its mean ink chroma sits between OFF's (~0) and ON's
    const chromaRatio = meanChroma(native.rgba) / meanChroma(on.rgba);
    assert.ok(chromaRatio >= 0.25 && chromaRatio <= 0.85,
      'native-' + size + '.png: mean ink chroma is ' + chromaRatio.toFixed(3) +
      ' x ON, expected between 0.25 and 0.85');

    // (c) it is ghosted, not solid: the ink-mass measure
    const massRatio = inkMass(native.rgba) / inkMass(on.rgba);
    assert.ok(massRatio >= 0.30 && massRatio <= 0.80,
      'native-' + size + '.png: ink mass is ' + massRatio.toFixed(3) +
      ' x ON, expected between 0.30 and 0.80');
  }
});

// 6. OFF was derived from ON: same alpha, byte for byte
test('on-* and off-* have identical alpha channels', () => {
  for (const size of SIZES) {
    const a = alphaBytes(load('on', size).rgba);
    const b = alphaBytes(load('off', size).rgba);
    assert.strictEqual(a.length, b.length, size + ' px: alpha channel lengths differ');
    let differing = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
    assert.ok(a.equals(b), 'on-' + size + '.png and off-' + size + '.png differ in ' +
      differing + ' of ' + a.length + ' alpha bytes; off must copy on\'s alpha so the two ' +
      'states are the same shape');
  }
});

// 7. NATIVE's alpha is deliberately different, so the ghosting is not a no-op
test('native-* alpha differs from on-*, so the ghosting is doing something', () => {
  for (const size of SIZES) {
    const a = alphaBytes(load('on', size).rgba);
    const b = alphaBytes(load('native', size).rgba);
    let differing = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
    assert.ok(differing > 0, 'native-' + size + '.png has the same alpha as on-' + size +
      '.png in all ' + a.length + ' bytes, so nothing was ghosted');
  }
});
