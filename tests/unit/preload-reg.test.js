/*
 * Darkrai unit tests: the early dark background and the schedule alarm, now
 * shared by background.js and the hard reset.
 *
 * What matters here is that the extraction changed nothing: the same id, the
 * same excludeMatches for a site set to Never, the same preload-system.css
 * for the system schedule, the same skip when new sites start as Never, and
 * the same hours gate.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const settings = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'settings.js'));
const preloadReg = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'preload-reg.js'));
const { createFakeChrome } = require(path.join(__dirname, '..', 'shim', 'fake-chrome.js'));

const deps = { settings: settings };

function storeWith(apply) {
  const store = settings.defaults();
  if (apply) apply(store);
  return store;
}

test('the always schedule registers preload.css for every http(s) page', () => {
  const spec = preloadReg.preloadSpec(settings.defaults(), deps);
  assert.ok(spec, 'a default store asks for an early dark background');
  assert.strictEqual(spec.id, 'darkrai-preload');
  assert.deepStrictEqual(spec.css, ['preload.css']);
  assert.deepStrictEqual(spec.matches, ['http://*/*', 'https://*/*']);
  assert.strictEqual(spec.runAt, 'document_start');
  assert.strictEqual(spec.allFrames, false);
  assert.strictEqual(spec.persistAcrossSessions, true);
  assert.strictEqual(spec.excludeMatches, undefined, 'nothing to exclude by default');
});

test('the system schedule registers the prefers-color-scheme file instead', () => {
  const spec = preloadReg.preloadSpec(storeWith((s) => {
    s.settings.schedule = { type: 'system', from: '19:00', to: '07:00' };
  }), deps);
  assert.deepStrictEqual(spec.css, ['preload-system.css']);
});

test('the hours schedule only registers while it is active', () => {
  const store = storeWith((s) => {
    s.settings.schedule = { type: 'hours', from: '19:00', to: '07:00' };
  });
  const inside = new Date(2026, 0, 2, 21, 30).getTime();
  const outside = new Date(2026, 0, 2, 12, 0).getTime();
  assert.ok(preloadReg.preloadSpec(store, { settings: settings, now: inside }),
    'registered inside the dark hours');
  assert.strictEqual(preloadReg.preloadSpec(store, { settings: settings, now: outside }), null,
    'nothing registered outside them, so no flash of dark');
});

test('nothing is registered when Darkrai is off or new sites start as Never', () => {
  assert.strictEqual(preloadReg.preloadSpec(storeWith((s) => {
    s.settings.enabled = false;
  }), deps), null);
  assert.strictEqual(preloadReg.preloadSpec(storeWith((s) => {
    s.settings.defaultMode = 'off';
  }), deps), null, 'an early dark background would only flash and go away');
});

test('a site set to Never is excluded as both the host and its subdomains', () => {
  const store = storeWith((s) => {
    s.sites = { 'youtube.com': { mode: 'off' }, 'example.com': { mode: 'on' } };
  });
  assert.deepStrictEqual(preloadReg.neverHosts(store), ['youtube.com']);
  const spec = preloadReg.preloadSpec(store, deps);
  assert.deepStrictEqual(spec.excludeMatches, ['*://youtube.com/*', '*://*.youtube.com/*']);
});

test('registerPreload replaces the old registration with the new one', async () => {
  const fake = createFakeChrome({ registered: [{ id: 'darkrai-preload', css: ['stale.css'] }] });
  const spec = await preloadReg.registerPreload(fake.chrome, settings.defaults(), deps);
  const order = fake.state.calls.map((c) => c.api);
  assert.deepStrictEqual(order, [
    'scripting.unregisterContentScripts',
    'scripting.registerContentScripts'
  ], 'the old one goes first, so two can never be registered at once');
  assert.deepStrictEqual(fake.calls('scripting.unregisterContentScripts')[0].args[0],
    { ids: ['darkrai-preload'] });
  assert.strictEqual(fake.state.registered.length, 1);
  assert.deepStrictEqual(fake.state.registered[0].css, ['preload.css']);
  assert.deepStrictEqual(spec.css, ['preload.css'], 'the spec that was registered comes back');
});

test('registerPreload unregisters but registers nothing when the store asks for none', async () => {
  const fake = createFakeChrome({ registered: [{ id: 'darkrai-preload', css: ['preload.css'] }] });
  const spec = await preloadReg.registerPreload(fake.chrome, storeWith((s) => {
    s.settings.enabled = false;
  }), deps);
  assert.strictEqual(spec, null);
  assert.ok(fake.called('scripting.unregisterContentScripts'));
  assert.strictEqual(fake.called('scripting.registerContentScripts'), false);
  assert.strictEqual(fake.state.registered.length, 0);
});

test('scheduleAlarms creates an alarm only for custom hours', async () => {
  const always = createFakeChrome({ alarms: [{ name: 'darkrai-schedule' }] });
  assert.strictEqual(await preloadReg.scheduleAlarms(always.chrome, settings.defaults(), deps),
    null, 'the Always schedule needs no timer');
  assert.ok(always.called('alarms.clear'), 'the old timer is cleared either way');
  assert.strictEqual(always.called('alarms.create'), false);
  assert.strictEqual(always.state.alarms.length, 0);

  const hours = createFakeChrome({});
  const store = storeWith((s) => {
    s.settings.schedule = { type: 'hours', from: '19:00', to: '07:00' };
  });
  const now = new Date(2026, 0, 2, 12, 0).getTime();
  const at = await preloadReg.scheduleAlarms(hours.chrome, store, { settings: settings, now: now });
  assert.strictEqual(at, settings.nextScheduleChange(store.settings.schedule, now));
  assert.strictEqual(hours.state.alarms.length, 1);
  assert.strictEqual(hours.state.alarms[0].name, 'darkrai-schedule');
});

test('a chrome that throws cannot take the worker down with it', async () => {
  const fake = createFakeChrome({
    fail: { 'scripting.unregisterContentScripts': 'no', 'alarms.clear': 'no' }
  });
  const spec = await preloadReg.registerPreload(fake.chrome, settings.defaults(), deps);
  assert.deepStrictEqual(spec.css, ['preload.css'],
    'a failed unregister still leaves the new registration in place');
  assert.strictEqual(await preloadReg.scheduleAlarms(fake.chrome, settings.defaults(), deps), null);
});

test('a registration that did not happen is reported, not reported as done', async () => {
  const fake = createFakeChrome({
    fail: { 'scripting.registerContentScripts': 'this id is already taken' }
  });
  await assert.rejects(
    () => preloadReg.registerPreload(fake.chrome, settings.defaults(), deps),
    /already taken/,
    'the caller has to be able to tell a registration that happened from one that did not');
  assert.strictEqual(fake.state.registered.length, 0);
});

test('an alarm that could not be created is reported too', async () => {
  const fake = createFakeChrome({ fail: { 'alarms.create': 'no room for another alarm' } });
  const store = storeWith((s) => {
    s.settings.schedule = { type: 'hours', from: '19:00', to: '07:00' };
  });
  await assert.rejects(
    () => preloadReg.scheduleAlarms(fake.chrome, store, {
      settings: settings, now: new Date(2026, 0, 2, 12, 0).getTime()
    }),
    /no room/,
    '"no alarm was needed" and "the alarm could not be made" must not look the same');
});
