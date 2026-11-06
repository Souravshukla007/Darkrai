/* Darkrai unit tests: the storage schema and its upgrades. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const settings = require(path.join(__dirname, '..', '..', 'extension', 'shared', 'settings.js'));

test('defaults match the plan', () => {
  const d = settings.defaults();
  assert.strictEqual(d.schema, 2);
  assert.strictEqual(d.debug, false, 'the dev-only timing flag is off for everybody');
  assert.strictEqual(d.settings.enabled, true);
  assert.strictEqual(d.settings.defaultMode, 'auto', 'every new site starts on Auto');
  assert.strictEqual(d.settings.look, 'gray');
  assert.strictEqual(d.settings.brightness, 100);
  assert.strictEqual(d.settings.contrast, 100);
  assert.strictEqual(d.settings.warmth, 0);
  assert.strictEqual(d.settings.dimImages, false);
  assert.deepStrictEqual(d.settings.schedule, { type: 'always', from: '19:00', to: '07:00' });
  assert.deepStrictEqual(d.sites['docs.google.com'], { mode: 'on', engine: 'filter' },
    'Google Docs ships on Simple mode');
});

test('upgrade copes with nothing at all', () => {
  [undefined, null, {}, 'nonsense', 42, []].forEach((input) => {
    const out = settings.upgrade(input);
    assert.strictEqual(out.schema, 2);
    assert.strictEqual(out.settings.enabled, true);
    assert.strictEqual(out.settings.look, 'gray');
    assert.ok(out.sites && typeof out.sites === 'object');
  });
});

test('upgrade keeps good values and repairs bad ones', () => {
  const out = settings.upgrade({
    schema: 1,
    settings: {
      enabled: false,
      defaultMode: 'sometimes',
      look: 'neon',
      brightness: 9999,
      contrast: -40,
      warmth: 55,
      dimImages: 'yes',
      schedule: { type: 'weekends', from: '99:99', to: '07:00' }
    },
    sites: { 'Example.COM': { mode: 'on' } }
  });
  assert.strictEqual(out.settings.enabled, false, 'a real choice survives');
  assert.strictEqual(out.settings.defaultMode, 'auto');
  assert.strictEqual(out.settings.look, 'gray');
  assert.strictEqual(out.settings.brightness, 150, 'clamped, not dropped');
  assert.strictEqual(out.settings.contrast, 50);
  assert.strictEqual(out.settings.warmth, 55);
  assert.strictEqual(out.settings.dimImages, true);
  assert.strictEqual(out.settings.schedule.type, 'always');
  assert.strictEqual(out.settings.schedule.from, '19:00');
  assert.strictEqual(out.settings.schedule.to, '07:00');
  assert.deepStrictEqual(out.sites['example.com'], { mode: 'on' }, 'host keys are lower-cased');
});

test('upgrade migrates older shapes', () => {
  const fromStrings = settings.upgrade({ sites: { 'a.com': 'off', 'www.b.com': 'auto' } });
  assert.deepStrictEqual(fromStrings.sites['a.com'], { mode: 'off' });
  assert.deepStrictEqual(fromStrings.sites['b.com'], { mode: 'auto' }, 'www. is stripped');

  const fromSiteList = settings.upgrade({ siteList: { 'c.com': { mode: 'on', engine: 'filter' } } });
  assert.deepStrictEqual(fromSiteList.sites['c.com'], { mode: 'on', engine: 'filter' });

  const keepsPreset = settings.upgrade({ sites: { 'd.com': { mode: 'on' } } });
  assert.deepStrictEqual(keepsPreset.sites['docs.google.com'], { mode: 'on', engine: 'filter' });

  const userWins = settings.upgrade({ sites: { 'docs.google.com': { mode: 'off' } } });
  assert.deepStrictEqual(userWins.sites['docs.google.com'], { mode: 'off' },
    'the user overrides the preset');
});

test('upgrade filters the per-site fix list', () => {
  const out = settings.upgrade({
    sites: {
      'e.com': {
        mode: 'auto',
        engine: 'nope',
        fixes: [
          { selector: 'header .logo', action: 'invert' },
          { selector: '.a', action: 'readable' },
          { selector: '', action: 'invert' },
          { selector: '.b', action: 'explode' },
          'junk',
          null
        ]
      }
    }
  });
  assert.strictEqual(out.sites['e.com'].engine, undefined, 'an unknown engine is dropped');
  assert.deepStrictEqual(out.sites['e.com'].fixes, [
    { selector: 'header .logo', action: 'invert' },
    { selector: '.a', action: 'readable' }
  ]);
});

test('upgrade is idempotent', () => {
  const once = settings.upgrade({ settings: { look: 'soft' }, sites: { 'f.com': { mode: 'off' } } });
  const twice = settings.upgrade(once);
  assert.deepStrictEqual(twice, once);
});

test('upgrade drops absurd keys but keeps the rest', () => {
  const long = 'x'.repeat(300) + '.com';
  const out = settings.upgrade({ sites: { [long]: { mode: 'off' }, 'g.com': { mode: 'off' } } });
  assert.ok(!(long in out.sites));
  assert.ok('g.com' in out.sites);
});

test('setSiteMode writes at the registrable domain', () => {
  let store = settings.defaults();
  store = settings.setSiteMode(store, 'music.youtube.com', 'off');
  assert.deepStrictEqual(store.sites['youtube.com'], { mode: 'off' });
  assert.strictEqual(settings.resolveMode(store, 'music.youtube.com'), 'off');
  assert.strictEqual(settings.resolveMode(store, 'youtube.com'), 'off');

  store = settings.setSiteMode(store, 'youtube.com', 'auto');
  assert.strictEqual(settings.resolveMode(store, 'youtube.com'), 'auto');

  const bad = settings.setSiteMode(settings.defaults(), 'h.com', 'banana');
  assert.strictEqual(settings.resolveMode(bad, 'h.com'), 'auto');
});

test('setSiteEngine stays on the exact host it was set for', () => {
  let store = settings.defaults();
  store = settings.setSiteEngine(store, 'app.example.com', 'filter');
  assert.strictEqual(settings.resolveEngine(store, 'app.example.com'), 'filter');
  assert.strictEqual(settings.resolveEngine(store, 'other.example.com'), 'smart');
  store = settings.setSiteEngine(store, 'app.example.com', 'smart');
  assert.strictEqual(settings.resolveEngine(store, 'app.example.com'), 'smart');
});

test('a schema-1 store survives the move to schema 2', () => {
  // Exactly what an older build would have written.
  const old = {
    schema: 1,
    settings: {
      enabled: true,
      defaultMode: 'auto',
      look: 'soft',
      brightness: 110,
      contrast: 95,
      warmth: 20,
      dimImages: true,
      schedule: { type: 'hours', from: '20:30', to: '06:15' }
    },
    sites: {
      'news.example.com': { mode: 'on', engine: 'filter' },
      'shop.example.org': {
        mode: 'auto',
        fixes: [
          { selector: 'header .logo', action: 'invert' },
          { selector: '.price', action: 'readable' }
        ]
      }
    }
  };
  const out = settings.upgrade(old);

  assert.strictEqual(out.schema, 2, 'the schema is bumped');
  assert.strictEqual(out.debug, false, 'an old store had no flag, so it is off');

  assert.deepStrictEqual(out.sites['news.example.com'], { mode: 'on', engine: 'filter' },
    'the mode and the engine are both kept');
  assert.deepStrictEqual(out.sites['shop.example.org'], {
    mode: 'auto',
    fixes: [
      { selector: 'header .logo', action: 'invert' },
      { selector: '.price', action: 'readable' }
    ]
  }, 'every remembered fix is kept, in order');

  assert.strictEqual(out.settings.look, 'soft');
  assert.strictEqual(out.settings.brightness, 110);
  assert.strictEqual(out.settings.warmth, 20);
  assert.deepStrictEqual(out.settings.schedule, { type: 'hours', from: '20:30', to: '06:15' });
  assert.deepStrictEqual(out.sites['docs.google.com'], { mode: 'on', engine: 'filter' },
    'the Docs preset is still there');
});

test('upgrade carries the debug flag through', () => {
  assert.strictEqual(settings.upgrade({ debug: true }).debug, true);
  assert.strictEqual(settings.upgrade({ debug: 'yes' }).debug, false, 'only a real true counts');
  assert.strictEqual(settings.upgrade({}).debug, false);
  // It survives a round trip, so a surface that saves cannot drop it.
  const once = settings.upgrade({ debug: true, sites: { 'a.com': { mode: 'off' } } });
  assert.strictEqual(settings.upgrade(once).debug, true);
  assert.strictEqual(settings.setSiteMode(once, 'b.com', 'on').debug, true);
});

test('hostFromUrl', () => {
  assert.strictEqual(settings.hostFromUrl('https://www.Example.com/a/b?c=1'), 'example.com');
  assert.strictEqual(settings.hostFromUrl('http://sub.example.co.uk/'), 'sub.example.co.uk');
  assert.strictEqual(settings.hostFromUrl('file:///C:/tmp/a.html'), '');
  assert.strictEqual(settings.hostFromUrl(''), '');
  assert.strictEqual(settings.hostFromUrl(null), '');
});
