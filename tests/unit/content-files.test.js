/*
 * Darkrai unit tests: one list of content-script files.
 *
 * The page script is injected from three places - manifest.json on every page
 * load, background.js when it re-injects open tabs after an install or update,
 * and shared/reset.js when the hard reset puts open tabs back - and all three
 * must inject the same files in the same order, or a re-injected tab runs a
 * different page script from a freshly loaded one.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..', '..', 'extension');

function manifestFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.content_scripts.length, 1, 'one content_scripts entry');
  return manifest.content_scripts[0].js;
}

function backgroundFiles() {
  // background.js runs through importScripts, so its list is read from the source.
  const src = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  const m = /var CONTENT_FILES = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, 'background.js declares CONTENT_FILES');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('manifest.json, background.js and the hard reset inject the same files in the same order', () => {
  const fromManifest = manifestFiles();
  const fromReset = require(path.join(EXT, 'shared', 'reset.js')).CONTENT_FILES;
  assert.ok(fromManifest.length > 0);
  assert.deepStrictEqual(backgroundFiles(), fromManifest, 'background.js re-injection');
  assert.deepStrictEqual(fromReset, fromManifest, 'shared/reset.js sweep and re-inject');
  fromManifest.forEach((f) => assert.ok(fs.existsSync(path.join(EXT, f)), f + ' exists'));
  assert.strictEqual(fromManifest[fromManifest.length - 1], 'content/main.js',
    'the lifecycle script comes last, after everything it uses');
});
