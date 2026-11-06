/*
 * Darkrai tests - browser/check-manifest.js
 *
 * Does manifest.json still parse, and does every path it names exist?
 * A manifest that points at a file which is not there fails at load time in
 * Chrome with a message that does not say which file, so this is cheaper to
 * run than to debug.
 *
 * It also reads the three 16 px toolbar icons and checks they are visible on a
 * light toolbar and on a dark one (each against its own gate, below), and
 * that native-16 stays tellable from on-16, which is the cheap version of
 * looking at them. Both are pure Node, so this check never skips.
 *
 *   node browser/check-manifest.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const png = require(path.join(__dirname, '..', '..', 'tools', 'icons', 'png.js'));

const EXT = path.join(__dirname, '..', '..', 'extension');
const manifestPath = path.join(EXT, 'manifest.json');

// A toolbar is either near-white or near-black; the mark has to read on both.
const WHITE = [255, 255, 255];
const NEAR_BLACK = [27, 27, 27];
const MIN_CONTRAST = 3.0;
// The share of each 16 px icon's ink mass that has to reach MIN_CONTRAST on
// BOTH toolbars. The pixel-sprite icons carry a metallic mid-tone rim that
// reads on either, so ON has to keep 40%; NATIVE's interior is ghosted on
// purpose while its opaque rim carries the mark, so 30%; OFF keeps the
// original 15% floor.
const MIN_INK_SHARE = { on: 0.40, native: 0.30, off: 0.15 };
// NATIVE has to stay tellable from ON at 16 px: its ink mass, ghosted, at most
// this share of ON's (the same bound tests/unit/icon-files.test.js uses).
const MAX_NATIVE_MASS = 0.80;

function exists(rel) {
  try { return fs.statSync(path.join(EXT, rel)).isFile(); } catch (e) { return false; }
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const paths = [];

function add(rel, where) {
  if (typeof rel === 'string' && rel) paths.push({ rel: rel, where: where });
}

add(manifest.background && manifest.background.service_worker, 'background.service_worker');
add(manifest.action && manifest.action.default_popup, 'action.default_popup');
add(manifest.options_ui && manifest.options_ui.page, 'options_ui.page');

Object.keys((manifest.action && manifest.action.default_icon) || {}).forEach(function (size) {
  add(manifest.action.default_icon[size], 'action.default_icon.' + size);
});
Object.keys(manifest.icons || {}).forEach(function (size) {
  add(manifest.icons[size], 'icons.' + size);
});
(manifest.content_scripts || []).forEach(function (entry, i) {
  (entry.js || []).forEach(function (file, j) { add(file, 'content_scripts[' + i + '].js[' + j + ']'); });
  (entry.css || []).forEach(function (file, j) { add(file, 'content_scripts[' + i + '].css[' + j + ']'); });
});
(manifest.web_accessible_resources || []).forEach(function (entry, i) {
  (entry.resources || []).forEach(function (file, j) {
    add(file, 'web_accessible_resources[' + i + '].resources[' + j + ']');
  });
});

// Not named in the manifest, but registered at runtime by shared/preload-reg.js.
add('preload.css', 'preload-reg.js registerPreload');
add('preload-system.css', 'preload-reg.js registerPreload (system schedule)');

// The manifest only names the on-* set. The other two states are swapped in per
// tab by background.js, and shared/reset.js falls back to off-*, so they fail at
// runtime rather than at load time if one goes missing. Check all twelve.
[16, 32, 48, 128].forEach(function (size) {
  add('icons/native-' + size + '.png', 'background.js ICONS.native.' + size);
  add('icons/off-' + size + '.png', 'background.js ICONS.off.' + size + ' / reset.js OFF_ICONS');
});

const missing = paths.filter(function (p) { return !exists(p.rel); });

console.log('manifest.json parses: manifest_version ' + manifest.manifest_version + ', ' +
  manifest.name + ' ' + manifest.version);
console.log('permissions: ' + (manifest.permissions || []).join(', '));
console.log('host_permissions: ' + (manifest.host_permissions || []).join(', '));
console.log(paths.length + ' declared path(s) checked under ' + EXT);
missing.forEach(function (p) { console.log('MISSING  ' + p.rel + '   (' + p.where + ')'); });
console.log(missing.length ? missing.length + ' path(s) missing' : 'every declared path resolves');

// ------------------------------------------- the 16 px icons on both toolbars

/** What share of an icon's ink mass reaches MIN_CONTRAST once composited on bg. */
function inkShareAtContrast(rgba, bg) {
  const over = png.compositeOver(rgba, bg);
  const bgLum = png.luminance(bg[0], bg[1], bg[2]);
  let total = 0;
  let good = 0;
  for (var i = 0, n = rgba.length / 4; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    if (a === 0) continue;
    total += a;
    const lum = png.luminance(over[i * 3], over[i * 3 + 1], over[i * 3 + 2]);
    if (png.contrast(lum, bgLum) >= MIN_CONTRAST) good += a;
  }
  return total > 0 ? good / total : 0;
}

/** Sum of alpha over the whole image, in whole-pixel units. */
function inkMass(rgba) {
  let mass = 0;
  for (let i = 3; i < rgba.length; i += 4) mass += rgba[i] / 255;
  return mass;
}

const faint = [];
const masses = {};
console.log('');
console.log('16 px icon legibility - share of ink mass at ' + MIN_CONTRAST.toFixed(1) +
  ':1 or better on both toolbars, gates on ' + (MIN_INK_SHARE.on * 100) + '%, native ' +
  (MIN_INK_SHARE.native * 100) + '%, off ' + (MIN_INK_SHARE.off * 100) + '%:');

['on', 'native', 'off'].forEach(function (state) {
  const name = 'icons/' + state + '-16.png';
  const gate = MIN_INK_SHARE[state];
  let image;
  try {
    image = png.decode(fs.readFileSync(path.join(EXT, name)));
  } catch (err) {
    faint.push(name + ' could not be decoded: ' + err.message);
    console.log('  ' + name.padEnd(22) + 'UNREADABLE  ' + err.message);
    return;
  }
  masses[state] = inkMass(image.rgba);
  [['#FFFFFF', WHITE], ['#1B1B1B', NEAR_BLACK]].forEach(function (pair) {
    const share = inkShareAtContrast(image.rgba, pair[1]);
    const ok = share >= gate;
    console.log('  ' + name.padEnd(22) + 'on ' + pair[0] + '  ' +
      (share * 100).toFixed(1).padStart(5) + '%  ' + (ok ? 'ok' : 'TOO FAINT'));
    if (!ok) {
      faint.push(name + ' on ' + pair[0] + ': ' + (share * 100).toFixed(1) +
        '% of its ink reaches ' + MIN_CONTRAST.toFixed(1) + ':1, gate is ' + (gate * 100) + '%');
    }
  });
});

if (masses.on && masses.native !== undefined) {
  const ratio = masses.native / masses.on;
  const ok = ratio <= MAX_NATIVE_MASS;
  console.log('  native-16 ink mass is ' + ratio.toFixed(3) + ' x on-16 (at most ' +
    MAX_NATIVE_MASS.toFixed(2) + ' to stay tellable)  ' + (ok ? 'ok' : 'TOO CLOSE TO ON'));
  if (!ok) faint.push('icons/native-16.png is not ghosted enough to tell from on-16 (' + ratio.toFixed(3) + ')');
}

faint.forEach(function (line) { console.log('FAINT  ' + line); });
console.log(faint.length
  ? faint.length + ' icon gate(s) failed'
  : 'all six icon/background combinations clear their gates, and native-16 stays tellable');

process.exit((missing.length || faint.length) ? 1 : 0);
