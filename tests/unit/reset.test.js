/*
 * Darkrai unit tests: the hard reset and the per-site reset.
 *
 * The hard reset is the safety net, so these tests are mostly about what it
 * does when things are broken: a chrome.* call that rejects, one that never
 * answers at all, and an API that is not there. Partial success has to be
 * reported as partial success, and the steps that did work have to still work.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..', '..', 'extension');
const settings = require(path.join(EXT, 'shared', 'settings.js'));
const restricted = require(path.join(EXT, 'shared', 'restricted.js'));
const preloadReg = require(path.join(EXT, 'shared', 'preload-reg.js'));
const resetModule = require(path.join(EXT, 'shared', 'reset.js'));
const { createFakeChrome } = require(path.join(__dirname, '..', 'shim', 'fake-chrome.js'));

const TABS = [
  { id: 1, url: 'https://example.com/' },
  { id: 2, url: 'https://news.example.org/article' },
  { id: 3, url: 'chrome://extensions/' },          // Chrome allows nothing here
  { id: 4 }                                        // no url at all
];

/** A store that has been lived in: changed settings, two sites, saved fixes. */
function dirtyStore() {
  return {
    schema: 2,
    debug: true,
    settings: {
      enabled: false,
      defaultMode: 'on',
      look: 'black',
      brightness: 130,
      contrast: 80,
      warmth: 45,
      dimImages: true,
      schedule: { type: 'hours', from: '18:30', to: '06:30' }
    },
    sites: {
      'a.com': { mode: 'off', engine: 'filter', fixes: [{ selector: '.logo', action: 'invert' }] },
      'b.com': {
        mode: 'on',
        fixes: [{ selector: '#head', action: 'readable' }, { selector: '.tag', action: 'invert' }]
      }
    }
  };
}

function makeReset(options) {
  const o = options || {};
  const fake = createFakeChrome({
    store: o.store === undefined ? dirtyStore() : o.store,
    tabs: o.tabs === undefined ? TABS : o.tabs,
    registered: o.registered === undefined
      ? [{ id: 'darkrai-preload', css: ['preload-system.css'] }]
      : o.registered,
    alarms: o.alarms === undefined ? [{ name: 'darkrai-schedule' }] : o.alarms,
    areas: o.areas,
    fail: o.fail
  });
  const api = resetModule.create({
    chrome: fake.chrome,
    settings: settings,
    restricted: restricted,
    preloadReg: preloadReg,
    contentFiles: ['shared/settings.js', 'content/main.js'],
    timeoutMs: o.timeoutMs || 40
  });
  return { fake: fake, api: api };
}

function stepNamed(result, fragment) {
  return result.steps.filter(function (s) { return s.name.indexOf(fragment) > -1; })[0];
}

test('hardReset puts the store back to the exact factory defaults', async () => {
  const { fake, api } = makeReset();
  const result = await api.hardReset();

  assert.strictEqual(result.ok, true, JSON.stringify(result.steps, null, 2));
  assert.deepStrictEqual(fake.store(), settings.defaults(),
    'what is in storage afterwards is defaults(), key for key');
  assert.deepStrictEqual(fake.store().sites['docs.google.com'], { mode: 'on', engine: 'filter' },
    'the Google Docs Simple-mode preset comes back with everything else');
  assert.strictEqual(fake.store().schema, 2);
  assert.strictEqual(fake.store().debug, false, 'the dev-only timing flag is off again');
  assert.strictEqual(fake.store().sites['a.com'], undefined);
  assert.strictEqual(fake.store().sites['b.com'], undefined);

  assert.strictEqual(result.steps.length, 7, 'seven steps, itemised');
  result.steps.forEach(function (step) {
    assert.strictEqual(step.ok, true, step.name + ': ' + step.error);
    assert.ok(step.detail, step.name + ' says what it did');
  });
});

test('hardReset clears storage first, then writes the defaults over the top', async () => {
  const { fake, api } = makeReset();
  await api.hardReset();
  const order = fake.state.calls.map((c) => c.api);
  assert.ok(order.indexOf('storage.local.clear') > -1);
  assert.ok(order.indexOf('storage.local.clear') < order.indexOf('storage.local.set'),
    'a half-upgraded key left behind would survive the other way round');
  assert.ok(fake.called('storage.session.clear'));
  assert.ok(fake.called('storage.sync.clear'));
});

test('hardReset says so when an area exists but Darkrai does not use it', async () => {
  const { fake, api } = makeReset();
  const result = await api.hardReset();
  const step = stepNamed(result, 'Saved settings erased');
  assert.match(step.detail, /session: cleared/);
  assert.match(step.detail, /Darkrai stores nothing here/);
  void fake;
});

test('hardReset says so when there is no session or sync area at all', async () => {
  const { fake, api } = makeReset({ areas: ['local'] });
  const result = await api.hardReset();
  const step = stepNamed(result, 'Saved settings erased');
  assert.strictEqual(step.ok, true, 'a missing area is not a failure');
  assert.match(step.detail, /session: no such API/);
  assert.match(step.detail, /sync: no such API/);
  assert.strictEqual(fake.called('storage.session.clear'), false);
});

test('hardReset re-registers the real early dark background, not a copy', async () => {
  const { fake, api } = makeReset();
  const result = await api.hardReset();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fake.state.registered.length, 1);
  assert.strictEqual(fake.state.registered[0].id, preloadReg.PRELOAD_ID);
  assert.deepStrictEqual(fake.state.registered[0].css, ['preload.css'],
    'the stale preload-system.css registration is gone, the Always-schedule one is back');
  assert.match(stepNamed(result, 'Early dark background').detail, /darkrai-preload/);
});

test('hardReset clears the alarms and states that the restored schedule needs none', async () => {
  const { fake, api } = makeReset();
  const result = await api.hardReset();
  const step = stepNamed(result, 'Schedule timers');
  assert.strictEqual(step.ok, true);
  assert.match(step.detail, /cleared the darkrai-schedule alarm/);
  assert.match(step.detail, /needs no alarm/);
  assert.strictEqual(fake.state.alarms.length, 0);
  assert.strictEqual(fake.called('alarms.create'), false);
});

test('hardReset cleans and re-injects the tabs it is allowed to touch', async () => {
  const { fake, api } = makeReset();
  const result = await api.hardReset();

  assert.strictEqual(result.tabsCleaned, 2);
  assert.strictEqual(result.tabsReinjected, 2);
  assert.strictEqual(result.tabsFailed, 0);

  assert.deepStrictEqual(fake.state.messaged.map((m) => m.tabId), [1, 2],
    'the restricted tab and the tab with no url are left alone');
  fake.state.messaged.forEach(function (m) {
    assert.strictEqual(m.type, 'dr-teardown');
    assert.deepStrictEqual(m.options, { frameId: 0 }, 'the top frame answers for the page');
  });
  assert.deepStrictEqual(fake.state.executed.map((e) => e.tabId), [1, 2]);
  fake.state.executed.forEach(function (e) {
    assert.deepStrictEqual(e.files, ['shared/settings.js', 'content/main.js'],
      'the tab comes back on the restored defaults with no reload');
    assert.strictEqual(e.func, false, 'the sweeper is only for a tab that does not answer');
  });
  assert.strictEqual(fake.state.icons.length, 0, 'no tab was left needing an off icon');
});

test('a tab that never answers is swept from the outside instead', async () => {
  const { fake, api } = makeReset({ fail: { 'tabs.sendMessage': 'silent' } });
  const result = await api.hardReset();

  assert.strictEqual(result.ok, true, JSON.stringify(result.steps, null, 2));
  assert.strictEqual(result.tabsCleaned, 2);
  assert.strictEqual(result.tabsReinjected, 2);
  const sweeps = fake.state.executed.filter((e) => e.func);
  assert.strictEqual(sweeps.length, 2, 'one sweeper per silent tab');
  assert.deepStrictEqual(sweeps.map((e) => e.tabId), [1, 2]);
});

test('hardReset is idempotent: twice in a row leaves the same store and verdict', async () => {
  const { fake, api } = makeReset();
  const first = await api.hardReset();
  const afterFirst = fake.store();
  const second = await api.hardReset();

  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.deepStrictEqual(fake.store(), afterFirst);
  assert.deepStrictEqual(fake.store(), settings.defaults());
  assert.deepStrictEqual(second.steps.map((s) => s.name), first.steps.map((s) => s.name));
  assert.strictEqual(second.tabsCleaned, first.tabsCleaned);
  assert.strictEqual(second.tabsReinjected, first.tabsReinjected);
  assert.strictEqual(fake.state.registered.length, 1, 'not two registrations, one');
  assert.strictEqual(fake.state.alarms.length, 0);
});

test('one broken chrome.* call cannot stop the other steps, and is reported', async () => {
  const { fake, api } = makeReset({
    fail: {
      'alarms.getAll': 'the alarm store is unreadable',
      'tabs.sendMessage': 'silent',
      'scripting.executeScript': 'this tab cannot be scripted'
    }
  });
  const result = await api.hardReset();

  assert.strictEqual(result.ok, false, 'partial success is never reported as success');

  const storageStep = stepNamed(result, 'Saved settings erased');
  const defaultsStep = stepNamed(result, 'Factory defaults');
  assert.strictEqual(storageStep.ok, true, 'the work that could be done was done');
  assert.strictEqual(defaultsStep.ok, true);
  assert.deepStrictEqual(fake.store(), settings.defaults());

  const alarmStep = stepNamed(result, 'Schedule timers');
  assert.strictEqual(alarmStep.ok, false);
  assert.match(alarmStep.error, /unreadable/, 'the reason travels with the step');

  const tabStep = stepNamed(result, 'Open tabs');
  assert.strictEqual(tabStep.ok, false);
  assert.strictEqual(result.tabsCleaned, 0);
  assert.strictEqual(result.tabsReinjected, 0);
  assert.strictEqual(result.tabsFailed, 2, 'both eligible tabs are counted as failed');

  const iconStep = stepNamed(result, 'Toolbar icons');
  assert.strictEqual(iconStep.ok, true);
  assert.strictEqual(fake.state.icons.length, 2, 'a tab that cannot be put back goes grey');
  // The detail has to say the page needs the reload, not only the icon: no
  // Darkrai script is left running in a tab that could not be re-injected.
  assert.match(iconStep.detail, /reloading them is what brings the restored defaults back/);
  assert.match(iconStep.detail, /No Darkrai script is running in them/);

  const report = stepNamed(result, 'Result');
  assert.strictEqual(report.ok, false);
  assert.match(report.detail, /could not be finished/);

  // The verdict row is the summary, not a seventh step. It is the only row
  // flagged this way, and a caller that counts failures must skip it: here
  // two real steps failed, so anything that says three is double-counting
  // the summary and contradicting the row right below it.
  assert.strictEqual(report.verdict, true, 'the summary row is flagged as the verdict');
  assert.strictEqual(
    result.steps.filter((one) => one.verdict).length, 1,
    'exactly one row is the verdict'
  );
  const realFailures = result.steps.filter((one) => !one.ok && !one.verdict);
  assert.deepStrictEqual(
    realFailures.map((one) => one.name).sort(),
    ['Open tabs cleaned and put back', 'Schedule timers cleared'],
    'two real steps failed'
  );
  assert.match(
    report.detail,
    new RegExp('^' + realFailures.length + ' of 6 steps could not be finished'),
    'the summary names the same count a caller would arrive at'
  );
});

test('a failed re-registration is reported as a step that did not finish', async () => {
  const { fake, api } = makeReset({
    fail: { 'scripting.registerContentScripts': 'this id is already taken' }
  });
  const result = await api.hardReset();

  const step = stepNamed(result, 'Early dark background');
  assert.strictEqual(step.ok, false,
    'the one step whose silent failure leaves the extension changed cannot claim success');
  assert.match(step.error, /could not be registered again/);
  assert.match(step.error, /already taken/, 'the reason travels with the step');
  assert.doesNotMatch(step.detail, /registered darkrai-preload again/);
  assert.strictEqual(result.ok, false, 'and the whole reset is not reported as done');
  assert.strictEqual(fake.state.registered.length, 0, 'nothing is registered, as reported');

  const storageStep = stepNamed(result, 'Saved settings erased');
  assert.strictEqual(storageStep.ok, true, 'the other six steps still ran');
  assert.deepStrictEqual(fake.store(), settings.defaults());
});

test('a tab that was re-injected keeps its icon even if the sweep failed', async () => {
  const { fake, api } = makeReset({
    fail: {
      'tabs.sendMessage': 'silent',                       // so the sweeper is tried
      'scripting.executeScript.func': 'this frame cannot be scripted'
    }
  });
  const result = await api.hardReset();

  assert.strictEqual(result.tabsCleaned, 0, 'neither tab could be swept');
  assert.strictEqual(result.tabsReinjected, 2, 'but both came back on the restored defaults');
  assert.strictEqual(result.tabsFailed, 2, 'reported as not fully put back');

  const iconStep = stepNamed(result, 'Toolbar icons');
  assert.strictEqual(iconStep.ok, true);
  assert.strictEqual(fake.state.icons.length, 0,
    'a live content script must not be shown behind an off icon');
  assert.match(iconStep.detail, /came back on the restored defaults/);
  assert.doesNotMatch(iconStep.detail, /until they are reloaded/);
});

test('a call that never answers times out instead of hanging the page', async () => {
  const started = Date.now();
  const { api } = makeReset({
    fail: { 'storage.local.clear': 'silent' },
    timeoutMs: 40
  });
  const result = await api.hardReset();
  const step = stepNamed(result, 'Saved settings erased');
  assert.strictEqual(step.ok, false);
  assert.match(step.detail, /no answer within 40ms/);
  assert.ok(Date.now() - started < 4000, 'the whole flow still finished quickly');
  assert.strictEqual(stepNamed(result, 'Factory defaults').ok, true,
    'the next step runs even though the first one timed out');
});

test('hardReset reports honestly when a whole API is missing', async () => {
  const api = resetModule.create({
    chrome: { runtime: { id: 'x' } },        // nothing else at all
    settings: settings,
    restricted: restricted,
    preloadReg: preloadReg,
    timeoutMs: 40
  });
  const result = await api.hardReset();
  assert.strictEqual(result.ok, false);
  assert.match(stepNamed(result, 'Early dark background').detail, /chrome.scripting is not/);
  assert.match(stepNamed(result, 'Schedule timers').detail, /chrome.alarms is not/);
  assert.match(stepNamed(result, 'Open tabs').detail, /chrome.tabs is not/);
});

// ------------------------------------------------------------- reset one site

test('resetSite forgets one site and leaves every other one byte-identical', async () => {
  const { fake, api } = makeReset();
  const store = settings.upgrade(dirtyStore());
  const before = JSON.stringify(store.sites['b.com']);

  const out = await api.resetSite(store, 'a.com');

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.host, 'a.com');
  assert.strictEqual(out.removed, true);
  assert.strictEqual(out.store.sites['a.com'], undefined,
    'its mode, its engine and its fixes are all gone');
  assert.strictEqual(JSON.stringify(out.store.sites['b.com']), before,
    "b.com's entry and its two fixes are untouched");
  assert.deepStrictEqual(fake.store().sites['b.com'], store.sites['b.com']);
  assert.strictEqual(fake.store().sites['a.com'], undefined);
  assert.deepStrictEqual(fake.store().settings, store.settings,
    'nothing but the site list changed');
});

test('resetSite writes nothing and says so when the site has nothing saved', async () => {
  const { fake, api } = makeReset();
  const out = await api.resetSite(settings.upgrade(dirtyStore()), 'never-seen.example');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.removed, false);
  assert.strictEqual(fake.called('storage.local.set'), false);
});

test('resetSite finds the entry a subdomain is following', async () => {
  const { api } = makeReset();
  const store = settings.upgrade({
    schema: 2,
    sites: { 'youtube.com': { mode: 'off' }, 'a.com': { mode: 'on' } }
  });
  const out = await api.resetSite(store, 'music.youtube.com');
  assert.strictEqual(out.host, 'youtube.com');
  assert.strictEqual(out.removed, true);
  assert.strictEqual(out.store.sites['youtube.com'], undefined);
  assert.deepStrictEqual(out.store.sites['a.com'], { mode: 'on' });
});

test('resetSite reports a failed write instead of claiming it worked', async () => {
  const { api } = makeReset({ fail: { 'storage.local.set': 'storage is full' } });
  const out = await api.resetSite(settings.upgrade(dirtyStore()), 'a.com');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.removed, false, 'nothing is claimed to have been removed');
  assert.match(out.error, /storage is full/);
});

// --------------------------------------------------------------- the sweeper

test('the sweeper is self-contained, so chrome.scripting can serialise it', () => {
  const src = String(resetModule.sweepPage);
  assert.match(src, /__darkraiHandle/);
  assert.match(src, /style\[data-darkrai\]/);
  assert.match(src, /data-dr-id/);
  assert.match(src, /adoptedStyleSheets/);
  assert.match(src, /__darkrai/, 'our own constructed sheets are told apart by their tag');
  // Anything from this module's scope would be undefined once the function is
  // serialised and run in the page.
  assert.strictEqual(/\bCONTENT_FILES\b|\bOFF_ICONS\b|\bTOP_FRAME\b/.test(src), false);
});

test('the sweeper leaves the root marker as "off" and reaches into open shadow roots', () => {
  const src = String(resetModule.sweepPage);
  // preload.css darkens html:not([data-darkrai]) and cannot be retracted from
  // an open tab, so removing the marker would re-arm the early dark background
  // on the page the sweeper just cleaned. content/main.js teardown() parks it
  // at "off" for the same reason, and the two paths have to agree.
  assert.match(src, /setAttribute\('data-darkrai', 'off'\)/);
  assert.strictEqual(/removeAttribute\('data-darkrai'\)/.test(src), false,
    'the marker is set to off, never removed');
  // No document-level selector crosses a shadow boundary, so each open root is
  // swept for the style node engine-smart.js appends into it.
  assert.match(src, /shadow\.querySelectorAll\('style\[data-darkrai\]'\)/);
  assert.match(src, /shadow\.querySelectorAll\('\[data-dr-id\]'\)/);
  // Whether it really leaves a usable page is asserted against a real document
  // by family (i) of tests/browser/run-ui-checks.js.
});

test('no window.confirm anywhere in the extension', () => {
  const offenders = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); return; }
      if (!/\.(js|html)$/i.test(entry.name)) return;
      const text = fs.readFileSync(full, 'utf8');
      if (/window\s*\.\s*confirm\s*\(/.test(text) || /(^|[^.\w$])confirm\s*\(/.test(text)) {
        offenders.push(path.relative(EXT, full));
      }
    });
  })(EXT);
  assert.deepStrictEqual(offenders, [],
    'the confirmation is an in-page dialog that can name what it is about to erase');
});
