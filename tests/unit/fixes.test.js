/* Darkrai unit tests: the picker's remembered fixes and removing a site. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const settings = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'settings.js'));

test('a fix is remembered at the registrable domain, so subdomains inherit it', () => {
  const store = settings.defaults();
  const next = settings.addSiteFix(store, 'music.youtube.com', {
    selector: 'header .logo', action: 'invert'
  });
  assert.deepStrictEqual(next.sites['youtube.com'].fixes, [
    { selector: 'header .logo', action: 'invert' }
  ]);
  assert.strictEqual(next.sites['music.youtube.com'], undefined);
  assert.strictEqual(settings.resolveFixes(next, 'music.youtube.com').length, 1,
    'the subdomain reads the parent entry');
});

test('a fix stays local to a host that already has its own entry', () => {
  // docs.google.com is in the default store with its own entry, so the fix
  // belongs to that host and not to all of google.com.
  const store = settings.defaults();
  const next = settings.addSiteFix(store, 'docs.google.com', {
    selector: '.toolbar', action: 'readable'
  });
  assert.strictEqual(next.sites['docs.google.com'].fixes.length, 1);
  assert.strictEqual(next.sites['docs.google.com'].engine, 'filter', 'its Simple mode is kept');
  assert.strictEqual(next.sites['google.com'], undefined);
});

test('adding a fix keeps the site setting it already had', () => {
  let store = settings.defaults();
  store = settings.setSiteMode(store, 'example.com', 'on');
  const next = settings.addSiteFix(store, 'example.com', { selector: 'a', action: 'readable' });
  assert.strictEqual(next.sites['example.com'].mode, 'on');
});

test('the newer choice for a selector replaces the older one', () => {
  let store = settings.defaults();
  store = settings.addSiteFix(store, 'example.com', { selector: '.x', action: 'readable' });
  store = settings.addSiteFix(store, 'example.com', { selector: '.y', action: 'invert' });
  store = settings.addSiteFix(store, 'example.com', { selector: '.x', action: 'invert' });
  assert.deepStrictEqual(store.sites['example.com'].fixes, [
    { selector: '.y', action: 'invert' },
    { selector: '.x', action: 'invert' }
  ]);
});

test('nonsense is not stored as a fix', () => {
  const store = settings.defaults();
  assert.strictEqual(settings.addSiteFix(store, 'example.com', null).sites['example.com'], undefined);
  assert.strictEqual(
    settings.addSiteFix(store, 'example.com', { selector: '.x', action: 'explode' }).sites['example.com'],
    undefined
  );
  assert.strictEqual(
    settings.addSiteFix(store, 'example.com', { selector: '', action: 'invert' }).sites['example.com'],
    undefined
  );
  assert.strictEqual(settings.addSiteFix(store, '', { selector: '.x', action: 'invert' }).sites[''], undefined);
});

test('a single fix can be removed, and all of them cleared', () => {
  let store = settings.defaults();
  store = settings.addSiteFix(store, 'example.com', { selector: '.x', action: 'readable' });
  store = settings.addSiteFix(store, 'example.com', { selector: '.y', action: 'invert' });

  const one = settings.removeSiteFix(store, 'example.com', '.x');
  assert.deepStrictEqual(one.sites['example.com'].fixes, [{ selector: '.y', action: 'invert' }]);

  const none = settings.clearSiteFixes(store, 'example.com');
  assert.strictEqual(none.sites['example.com'].fixes, undefined);
  assert.strictEqual(none.sites['example.com'].mode, 'auto', 'the site itself stays');
  assert.strictEqual(settings.resolveFixes(none, 'example.com').length, 0);
});

test('removing a fix from a site with none changes nothing', () => {
  const store = settings.defaults();
  const next = settings.removeSiteFix(store, 'nowhere.com', '.x');
  assert.deepStrictEqual(Object.keys(next.sites), Object.keys(store.sites));
});

test('a site can be forgotten, and then follows the global default again', () => {
  let store = settings.defaults();
  store = settings.setSiteMode(store, 'example.com', 'off');
  assert.strictEqual(settings.resolveMode(store, 'example.com'), 'off');

  store = settings.removeSite(store, 'example.com');
  assert.strictEqual(store.sites['example.com'], undefined);
  assert.strictEqual(settings.resolveMode(store, 'example.com'), 'auto');
});

test('a fix survives a storage round trip through upgrade()', () => {
  let store = settings.defaults();
  store = settings.addSiteFix(store, 'example.com', { selector: 'header .logo', action: 'invert' });
  const reloaded = settings.upgrade(JSON.parse(JSON.stringify(store)));
  assert.deepStrictEqual(reloaded.sites['example.com'].fixes, [
    { selector: 'header .logo', action: 'invert' }
  ]);
});

test('the Google Docs preset comes back after it is removed', () => {
  // Documented in the README's known limits: the preset is part of the default
  // store, so a reload re-adds it. Set it to Never instead.
  const removed = settings.removeSite(settings.defaults(), 'docs.google.com');
  assert.strictEqual(removed.sites['docs.google.com'], undefined);
  const reloaded = settings.upgrade(JSON.parse(JSON.stringify(removed)));
  assert.ok(reloaded.sites['docs.google.com'], 'back again on the next read');
});
