/* Darkrai unit tests: site matching, subdomain inheritance and the per-page decision. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const settings = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'settings.js'));

function store(sites, overrides) {
  const base = settings.defaults();
  base.sites = sites || {};
  Object.assign(base.settings, overrides || {});
  return base;
}

test('an exact host matches', () => {
  const hit = settings.matchSite({ 'example.com': { mode: 'off' } }, 'example.com');
  assert.strictEqual(hit.key, 'example.com');
  assert.strictEqual(hit.entry.mode, 'off');
});

test('a subdomain inherits the main site', () => {
  const sites = { 'youtube.com': { mode: 'off' } };
  assert.strictEqual(settings.matchSite(sites, 'music.youtube.com').key, 'youtube.com');
  assert.strictEqual(settings.matchSite(sites, 'www.youtube.com').key, 'youtube.com');
  assert.strictEqual(settings.matchSite(sites, 'a.b.c.youtube.com').key, 'youtube.com');
  assert.strictEqual(settings.resolveMode(store(sites), 'music.youtube.com'), 'off');
});

test('a host of its own beats the parent', () => {
  const sites = { 'youtube.com': { mode: 'off' }, 'music.youtube.com': { mode: 'on' } };
  assert.strictEqual(settings.matchSite(sites, 'music.youtube.com').key, 'music.youtube.com');
  assert.strictEqual(settings.resolveMode(store(sites), 'music.youtube.com'), 'on');
  assert.strictEqual(settings.resolveMode(store(sites), 'youtube.com'), 'off');
});

test('a public suffix is never treated as a site', () => {
  assert.strictEqual(settings.matchSite({ 'co.uk': { mode: 'off' } }, 'example.co.uk'), null);
  assert.strictEqual(settings.matchSite({ 'com': { mode: 'off' } }, 'example.com'), null);
  assert.strictEqual(settings.resolveMode(store({ 'co.uk': { mode: 'off' } }), 'example.co.uk'), 'auto');
});

test('an unrelated host does not match', () => {
  const sites = { 'example.com': { mode: 'off' } };
  assert.strictEqual(settings.matchSite(sites, 'notexample.com'), null);
  assert.strictEqual(settings.matchSite(sites, 'example.com.evil.com'), null);
  assert.strictEqual(settings.matchSite(sites, ''), null);
  assert.strictEqual(settings.matchSite(null, 'example.com'), null);
});

test('baseDomain', () => {
  assert.strictEqual(settings.baseDomain('www.example.com'), 'example.com');
  assert.strictEqual(settings.baseDomain('music.youtube.com'), 'youtube.com');
  assert.strictEqual(settings.baseDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.strictEqual(settings.baseDomain('example.co.uk'), 'example.co.uk');
  assert.strictEqual(settings.baseDomain('localhost'), 'localhost');
  assert.strictEqual(settings.baseDomain('127.0.0.1'), '127.0.0.1');
  assert.strictEqual(settings.baseDomain(''), '');
});

test('the default mode fills the gaps', () => {
  assert.strictEqual(settings.resolveMode(store({}), 'nowhere.com'), 'auto');
  assert.strictEqual(settings.resolveMode(store({}, { defaultMode: 'on' }), 'nowhere.com'), 'on');
  assert.strictEqual(settings.resolveMode(store({}, { defaultMode: 'off' }), 'nowhere.com'), 'off');
});

test('the per-page decision', () => {
  const decide = settings.decideForPage;
  assert.strictEqual(decide(store({}), 'a.com'), 'detect', 'Auto measures first');
  assert.strictEqual(decide(store({ 'a.com': { mode: 'on' } }), 'a.com'), 'dark');
  assert.strictEqual(decide(store({ 'a.com': { mode: 'off' } }), 'a.com'), 'skip');
  assert.strictEqual(decide(store({}, { enabled: false }), 'a.com'), 'skip', 'off means off');
  assert.strictEqual(
    decide(store({ 'a.com': { mode: 'on' } }, { enabled: false }), 'a.com'),
    'skip',
    'the master switch wins'
  );
  assert.strictEqual(
    decide(store({}, { schedule: { type: 'system' } }), 'a.com', { systemDark: false }),
    'skip',
    'outside the schedule nothing happens'
  );
  assert.strictEqual(
    decide(store({}, { schedule: { type: 'system' } }), 'a.com', { systemDark: true }),
    'detect'
  );
  assert.strictEqual(decide(store({ 'youtube.com': { mode: 'off' } }), 'music.youtube.com'), 'skip',
    'the subdomain inherits Never');
});

test('engine and fixes resolve through the same inheritance', () => {
  const sites = {
    'docs.google.com': { mode: 'on', engine: 'filter' },
    'example.com': { mode: 'auto', fixes: [{ selector: 'header .logo', action: 'invert' }] }
  };
  assert.strictEqual(settings.resolveEngine(store(sites), 'docs.google.com'), 'filter');
  assert.strictEqual(settings.resolveEngine(store(sites), 'mail.google.com'), 'smart');
  assert.strictEqual(settings.resolveFixes(store(sites), 'sub.example.com').length, 1);
  assert.strictEqual(settings.resolveFixes(store(sites), 'other.com').length, 0);
});
