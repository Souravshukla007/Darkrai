/*
 * Darkrai unit tests: the early dark background when two callers register it
 * at once.
 *
 * The worker re-registers on every settings or sites change, and the hard
 * reset's page writes storage (which sets the worker off) and registers too.
 * The fake here keeps ONE registration table for both contexts and answers
 * the way Chrome does: a second register of an id is refused with
 * "Duplicate script ID", an unregister of a missing id with "Nonexistent
 * script ID", and every call answers a few milliseconds later, so the two
 * contexts interleave the way they do in the browser.
 *
 * DARKRAI_EXT_DIR=<copy of extension/> runs the same tests against another
 * copy of the code (that is how they were shown to fail before the fix).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const EXT_OVERRIDE = String(process.env.DARKRAI_EXT_DIR || '').trim();
const EXT = EXT_OVERRIDE
  ? path.resolve(EXT_OVERRIDE)
  : path.join(__dirname, '..', '..', 'extension');
const settings = require(path.join(EXT, 'shared', 'settings.js'));
const restricted = require(path.join(EXT, 'shared', 'restricted.js'));
const preloadReg = require(path.join(EXT, 'shared', 'preload-reg.js'));
const resetModule = require(path.join(EXT, 'shared', 'reset.js'));
const { createFakeChrome, clone } = require(path.join(__dirname, '..', 'shim', 'fake-chrome.js'));

const deps = { settings: settings };
const ID = 'darkrai-preload';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * One table of registrations, shared by every context made from it, with
 * Chrome's answers. `latency` is how long each call takes; `before(ctx, api)`
 * runs just before a call takes effect, which is where a test makes the other
 * context's call land first.
 */
function createRegistry(options) {
  const o = options || {};
  const table = new Map();
  (o.registered || []).forEach((s) => table.set(s.id, clone(s)));
  const log = [];
  const latency = o.latency == null ? 3 : o.latency;

  function scriptingFor(ctx) {
    function call(api, run) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            if (o.before) o.before(ctx, api);
            const out = run();
            log.push(ctx + ' ' + api + ' ok');
            resolve(out);
          } catch (err) {
            log.push(ctx + ' ' + api + ' ' + err.message);
            reject(err);
          }
        }, latency);
      });
    }
    return {
      registerContentScripts(scripts) {
        return call('register', () => {
          for (const s of scripts) {
            if (table.has(s.id)) throw new Error("Duplicate script ID '" + s.id + "'");
          }
          for (const s of scripts) table.set(s.id, clone(s));
        });
      },
      unregisterContentScripts(filter) {
        return call('unregister', () => {
          const ids = (filter && filter.ids) || [...table.keys()];
          for (const id of ids) {
            if (!table.has(id)) throw new Error("Nonexistent script ID '" + id + "'");
          }
          for (const id of ids) table.delete(id);
        });
      },
      updateContentScripts(scripts) {
        return call('update', () => {
          for (const s of scripts) {
            if (!table.has(s.id)) {
              throw new Error("Script with ID '" + s.id + "' does not exist or is not fully registered");
            }
          }
          for (const s of scripts) table.set(s.id, Object.assign(table.get(s.id), clone(s)));
        });
      },
      getRegisteredContentScripts(filter) {
        return call('getRegistered', () => {
          const ids = filter && filter.ids;
          return [...table.values()].filter((s) => !ids || ids.includes(s.id)).map(clone);
        });
      },
      executeScript() {
        return call('executeScript', () => [{ frameId: 0, result: null }]);
      }
    };
  }

  /** The worker's own reaction to a storage change, as background.js does it. */
  function workerRegisters(workerChrome, store) {
    return preloadReg.registerPreload(workerChrome, store, deps).then(
      (spec) => ({ ok: true, spec }),
      (err) => ({ ok: false, error: err.message })
    );
  }

  return {
    table,
    log,
    current: () => (table.has(ID) ? clone(table.get(ID)) : null),
    chromeFor: (ctx) => ({ runtime: { id: 'fake-' + ctx }, scripting: scriptingFor(ctx) }),
    workerRegisters
  };
}

function storeWith(apply) {
  const store = settings.defaults();
  if (apply) apply(store);
  return store;
}

const neverWiki = () => storeWith((s) => { s.sites['wikipedia.org'] = { mode: 'off' }; });

test('the worker and the reset page registering at once both end registered, no duplicate', async () => {
  const reg = createRegistry({ registered: [preloadReg.preloadSpec(neverWiki(), deps)] });
  const worker = reg.chromeFor('worker');
  const page = reg.chromeFor('page');
  const defaults = settings.defaults();

  // The interleaving the real hard reset hits: the worker's unregister and
  // register run between the page's own unregister and register.
  const [w, p] = await Promise.all([
    reg.workerRegisters(worker, defaults),
    preloadReg.registerPreload(page, defaults, deps).then(
      (spec) => ({ ok: true, spec }), (err) => ({ ok: false, error: err.message }))
  ]);

  assert.deepStrictEqual(w.ok, true, 'worker: ' + w.error);
  assert.deepStrictEqual(p.ok, true, 'page: ' + p.error + '\n' + reg.log.join('\n'));
  assert.ok(preloadReg.matchesSpec(reg.current(), preloadReg.preloadSpec(defaults, deps)),
    'what is registered is the spec for the defaults: ' + JSON.stringify(reg.current()));
  assert.strictEqual(reg.table.size, 1, 'one registration, not two');
});

test('a duplicate from the other context is brought to this spec, Never list included', async () => {
  const defaults = settings.defaults();
  let landed = false;
  const reg = createRegistry({
    before(ctx, api) {
      // Just before the page registers, the worker's own registration for the
      // OLD store (with wikipedia.org set to Never) lands.
      if (ctx === 'page' && api === 'register' && !landed) {
        landed = true;
        reg.table.set(ID, clone(preloadReg.preloadSpec(neverWiki(), deps)));
      }
    }
  });
  const page = reg.chromeFor('page');
  const spec = await preloadReg.registerPreload(page, defaults, deps);
  assert.ok(spec, 'resolves to the spec that is now registered');
  const now = reg.current();
  assert.ok(preloadReg.matchesSpec(now, preloadReg.preloadSpec(defaults, deps)),
    'the stale registration was updated to the defaults: ' + JSON.stringify(now));
  assert.deepStrictEqual(now.excludeMatches || [], [], 'the old Never list did not survive');
});

test('rapid changes in one context end on the LAST store, not an older one', async () => {
  // A burst of storage changes in the worker: an older store with a Never
  // site, then the current one without it.
  const reg = createRegistry({ registered: [preloadReg.preloadSpec(settings.defaults(), deps)] });
  const worker = reg.chromeFor('worker');
  const older = neverWiki();
  const latest = settings.defaults();
  const results = await Promise.all([
    reg.workerRegisters(worker, older),
    reg.workerRegisters(worker, latest)
  ]);
  results.forEach((r, i) => assert.strictEqual(r.ok, true, 'call ' + i + ': ' + r.error));
  assert.ok(preloadReg.matchesSpec(reg.current(), preloadReg.preloadSpec(latest, deps)),
    'the latest store is what is registered: ' + JSON.stringify(reg.current()));
});

test('switched off then on quickly: the early dark background is registered at the end', async () => {
  const reg = createRegistry({ registered: [preloadReg.preloadSpec(settings.defaults(), deps)] });
  const worker = reg.chromeFor('worker');
  const off = storeWith((s) => { s.settings.enabled = false; });
  const on = settings.defaults();
  await Promise.all([
    reg.workerRegisters(worker, on),
    reg.workerRegisters(worker, off),
    reg.workerRegisters(worker, on)
  ]);
  assert.ok(preloadReg.matchesSpec(reg.current(), preloadReg.preloadSpec(on, deps)),
    'on was the last word: ' + JSON.stringify(reg.current()));

  await Promise.all([
    reg.workerRegisters(worker, off),
    reg.workerRegisters(worker, on),
    reg.workerRegisters(worker, off)
  ]);
  assert.strictEqual(reg.current(), null, 'off was the last word, so nothing is registered');
});

test('the desired state "none" with nothing registered is done, not a failure', async () => {
  const reg = createRegistry({});
  const spec = await preloadReg.registerPreload(reg.chromeFor('worker'),
    storeWith((s) => { s.settings.enabled = false; }), deps);
  assert.strictEqual(spec, null);
  assert.strictEqual(reg.current(), null);
});

test('matchesSpec compares what Chrome reads back, field by field', () => {
  const spec = preloadReg.preloadSpec(neverWiki(), deps);
  const back = Object.assign({}, spec, {
    // Chrome keeps patterns in its own order and adds its own defaults.
    excludeMatches: spec.excludeMatches.slice().reverse(),
    matchOriginAsFallback: false,
    world: 'ISOLATED'
  });
  assert.strictEqual(preloadReg.matchesSpec(back, spec), true);
  assert.strictEqual(preloadReg.matchesSpec(null, spec), false, 'missing is not equal');
  assert.strictEqual(preloadReg.matchesSpec(null, null), true, 'none wanted, none there');
  assert.strictEqual(preloadReg.matchesSpec(back, null), false, 'none wanted, one there');
  assert.strictEqual(preloadReg.matchesSpec(Object.assign({}, back, { css: ['preload-system.css'] }), spec), false);
  assert.strictEqual(preloadReg.matchesSpec(Object.assign({}, back, { excludeMatches: [] }), spec), false,
    'a lost Never list is a difference');
});

// ------------------------------------------------------------ the hard reset

function resetWithWorker(extra) {
  const reg = createRegistry({
    registered: [preloadReg.preloadSpec(neverWiki(), deps)],
    before: extra && extra.before
  });
  const page = reg.chromeFor('page');
  const worker = reg.chromeFor('worker');
  const fake = createFakeChrome({
    store: neverWiki(),
    tabs: [],
    alarms: []
  });
  // The page's storage, scripting and alarms; the worker reacts to every
  // storage write the way background.js's onChanged listener does.
  const workerJobs = [];
  const local = fake.chrome.storage.local;
  ['clear', 'set'].forEach((name) => {
    const real = local[name];
    local[name] = function () {
      return real.apply(local, arguments).then((v) => {
        const store = settings.upgrade(fake.store());
        workerJobs.push(wait(1).then(() => reg.workerRegisters(worker, store)));
        return v;
      });
    };
  });
  const chromeApi = Object.assign({}, fake.chrome, { scripting: page.scripting });
  const api = resetModule.create({
    chrome: chromeApi,
    settings: settings,
    restricted: restricted,
    preloadReg: preloadReg,
    contentFiles: ['content/main.js'],
    timeoutMs: 1500
  });
  return { reg, api, workerJobs };
}

test('hard reset: the early dark background step is done while the worker registers too', async () => {
  // The worker's registration lands between the page's unregister and its
  // register: exactly the "Duplicate script ID 'darkrai-preload'" the real
  // reset reported as Partly done.
  let fired = false;
  const holder = {};
  const { reg, api, workerJobs } = resetWithWorker({
    before(ctx, apiName) {
      if (ctx === 'page' && apiName === 'register' && !fired) {
        fired = true;
        holder.reg.table.set(ID, clone(preloadReg.preloadSpec(settings.defaults(), deps)));
      }
    }
  });
  holder.reg = reg;
  const result = await api.hardReset();
  await Promise.all(workerJobs);
  const step = result.steps.find((s) => /Early dark background/.test(s.name));
  assert.strictEqual(step.ok, true, step.detail + '\n' + reg.log.join('\n'));
  assert.match(step.detail, /reads it back as exactly that/);
  assert.ok(preloadReg.matchesSpec(reg.current(), preloadReg.preloadSpec(settings.defaults(), deps)),
    'and Chrome really holds the defaults spec: ' + JSON.stringify(reg.current()));
});

test('hard reset: a registration that does not read back as the defaults is reported', async () => {
  // Something keeps putting the old Never-list registration back after every
  // write: the step must not claim the defaults are registered.
  const holder = {};
  const { reg, api } = resetWithWorker({
    before(ctx, apiName) {
      if (ctx === 'page' && apiName === 'getRegistered') {
        holder.reg.table.set(ID, clone(preloadReg.preloadSpec(neverWiki(), deps)));
      }
    }
  });
  holder.reg = reg;
  const result = await api.hardReset();
  const step = result.steps.find((s) => /Early dark background/.test(s.name));
  assert.strictEqual(step.ok, false, 'not ok while Chrome holds something else');
  assert.match(step.error, /not back as the restored defaults ask/);
  assert.match(step.error, /excluded pattern/);
  assert.strictEqual(result.ok, false);
});
