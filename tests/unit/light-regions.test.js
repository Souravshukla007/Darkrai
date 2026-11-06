/*
 * The real-Chrome light-region probe (tests/real-chrome/lib.js): bright,
 * near-neutral regions of a screenshot and how each is explained.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { lightRegions, explainLight } = require('../real-chrome/lib.js');

const BG = 24;
function canvas(w, h) { return { w, h, px: Buffer.alloc(w * h * 3, BG) }; }
function fill(img, x0, y0, w, h, v) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * img.w + x) * 3;
    const c = typeof v === 'function' ? v(x, y) : v;
    img.px[i] = c; img.px[i + 1] = c; img.px[i + 2] = c;
  }
}

test('a white box left on a dark page is found, with a point inside it', () => {
  const img = canvas(400, 200);
  fill(img, 50, 40, 120, 30, 255);
  const { regions } = lightRegions(img);
  assert.strictEqual(regions.length, 1);
  assert.deepStrictEqual(regions[0].box, [50, 40, 120, 30]);
  assert.ok(regions[0].x > 50 && regions[0].x < 170 && regions[0].y > 40 && regions[0].y < 70);
});

test('a 16 px fade to white is measured as the whole strip, not its last rows', () => {
  // Wikipedia's sidebar fade: 208 px wide, page colour to white in 16 rows.
  const img = canvas(400, 200);
  fill(img, 32, 100, 208, 16, (x, y) => Math.round(BG + (248 - BG) * (y - 100) / 15));
  const { regions } = lightRegions(img);
  assert.strictEqual(regions.length, 1);
  assert.ok(regions[0].area >= 1500, 'area ' + regions[0].area);
  assert.ok(regions[0].box[3] >= 6, 'height ' + regions[0].box[3]);
});

test('light text glyphs, small boxes and saturated colours are not regions', () => {
  const img = canvas(400, 200);
  for (let k = 0; k < 20; k++) fill(img, 10 + k * 12, 20, 2, 14, 240); // glyph stems
  fill(img, 300, 20, 30, 30, 255);                                     // 900 px box
  const { regions } = lightRegions(img);
  assert.strictEqual(regions.length, 0);
  const red = canvas(200, 100);
  for (let y = 10; y < 60; y++) for (let x = 10; x < 110; x++) { const i = (y * 200 + x) * 3; red.px[i] = 255; red.px[i + 1] = 200; red.px[i + 2] = 0; }
  assert.strictEqual(lightRegions(red).regions.length, 0);
});

test('a long thin strip counts, a 2 px line does not', () => {
  const img = canvas(400, 400);
  fill(img, 380, 20, 6, 320, 230);   // a scrollbar-like strip
  fill(img, 20, 380, 340, 2, 255);   // an underline
  const { regions } = lightRegions(img);
  assert.strictEqual(regions.length, 1);
  assert.deepStrictEqual(regions[0].box, [380, 20, 6, 320]);
});

test('explanations: media and url() backgrounds are explained, scrollbars and painted boxes are not', () => {
  const img = canvas(100, 100);
  const { mask } = lightRegions(img);
  const r = { box: [0, 0, 10, 10] };
  assert.strictEqual(explainLight(r, { verdict: { kind: 'media', of: 'img' } }, img, mask).explained, true);
  assert.strictEqual(explainLight(r, { verdict: { kind: 'background-photo', of: 'div' } }, img, mask).explained, true);
  assert.strictEqual(explainLight(r, { verdict: { kind: 'scrollbar', of: 'nav' } }, img, mask).explained, false);
  assert.strictEqual(explainLight(r, { verdict: { kind: 'painted', of: 'div' } }, img, mask).explained, false);
  assert.strictEqual(explainLight(r, null, img, mask).explained, false);
});

test('explanations: a cross-origin frame is media only when its box is not mostly bright', () => {
  const img = canvas(200, 100);
  fill(img, 0, 0, 100, 100, 255);                         // a blank white frame
  fill(img, 100, 0, 100, 100, (x, y) => ((x + y) % 4 ? 30 : 250)); // a varied creative
  const { mask } = lightRegions(img);
  const blank = explainLight({}, { verdict: { kind: 'iframe', of: 'iframe', frame: { sameOrigin: false, box: [0, 0, 100, 100], elementColorScheme: 'dark' } } }, img, mask);
  const media = explainLight({}, { verdict: { kind: 'iframe', of: 'iframe', frame: { sameOrigin: false, box: [100, 0, 100, 100], elementColorScheme: 'dark' } } }, img, mask);
  assert.strictEqual(blank.explained, false);
  assert.strictEqual(media.explained, true);
});
