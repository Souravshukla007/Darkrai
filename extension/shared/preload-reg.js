/*
 * Darkrai - shared/preload-reg.js
 *
 * The early dark background (PLAN section 6.8) and the schedule alarm, in one
 * place. Extracted from background.js so the hard reset can put back the real
 * registration and the real alarm instead of a second copy that would drift
 * away from the worker's.
 *
 * Every function takes a chrome-like object as its first argument, so the
 * whole module is testable in Node with a fake chrome. `settings` is taken
 * from the Darkrai namespace unless it is passed in deps, which is how
 * background.js (importScripts) and the tests (require) both work.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  var ns = (root.Darkrai = root.Darkrai || {});
  ns.preloadReg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var PRELOAD_ID = 'darkrai-preload';
  var ALARM_SCHEDULE = 'darkrai-schedule';

  function settingsOf(deps) {
    if (deps && deps.settings) return deps.settings;
    var ns = root.Darkrai;
    if (ns && ns.settings) return ns.settings;
    throw new Error('Darkrai.settings is not loaded');
  }

  function nowOf(deps) {
    return deps && deps.now != null ? deps.now : Date.now();
  }

  /** The hosts the user has set to Never: no early dark background for them. */
  function neverHosts(store) {
    var out = [];
    var sites = (store && store.sites) || {};
    Object.keys(sites).forEach(function (host) {
      if (sites[host] && sites[host].mode === 'off') out.push(host);
    });
    return out;
  }

  /**
   * The registration this store asks for, or null when it asks for none.
   * Pure: no chrome.* call, so a test can read the spec straight off.
   */
  function preloadSpec(store, deps) {
    var s = (store && store.settings) || {};
    if (!s.enabled) return null;
    // "Never" as the setting for new sites means almost nothing gets
    // darkened, so an early dark background would only flash and go away.
    if (s.defaultMode === 'off') return null;
    var file = 'preload.css';
    var sch = s.schedule || { type: 'always' };
    if (sch.type === 'system') {
      // The file itself is wrapped in @media (prefers-color-scheme: dark).
      file = 'preload-system.css';
    } else if (sch.type === 'hours') {
      if (!settingsOf(deps).scheduleActive(sch, nowOf(deps))) return null;
    }
    var exclude = [];
    neverHosts(store).forEach(function (host) {
      exclude.push('*://' + host + '/*', '*://*.' + host + '/*');
    });
    var spec = {
      id: PRELOAD_ID,
      css: [file],
      matches: ['http://*/*', 'https://*/*'],
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: true
    };
    if (exclude.length) spec.excludeMatches = exclude;
    return spec;
  }

  // ------------------------------------------------ converging on one state
  //
  // Two contexts register this id: the worker, on every settings or sites
  // change, and the hard reset's page, which also writes storage and so sets
  // the worker off while it is registering itself. Within one context the
  // calls used to run side by side too, one per storage change. Every call is
  // "unregister, then register", so two of them interleave as unregister,
  // unregister, register, register - and the second register is refused with
  // "Duplicate script ID", which is how the hard reset came to report the
  // early dark background as not put back, and how a burst of changes could
  // leave an older store's registration in place.

  // How long a call waits behind an earlier one before going ahead anyway: a
  // chrome.scripting call that never answers must not hold up every later one.
  var QUEUE_WAIT_MS = 3000;
  // Update attempts after a "Duplicate script ID", for a registration from the
  // other context that Chrome has not finished setting up yet.
  var MAX_TRIES = 3;
  var RETRY_MS = 60;
  var SKIPPED = { skipped: true };

  // One queue per chrome object: one per context in the extension, one per
  // fake in the tests.
  var queues = typeof WeakMap === 'function' ? new WeakMap() : null;
  var onlyQueue = null;

  function queueOf(chromeApi) {
    if (!queues || !chromeApi || typeof chromeApi !== 'object') {
      if (!onlyQueue) onlyQueue = { tail: Promise.resolve(), seq: 0, last: null };
      return onlyQueue;
    }
    var q = queues.get(chromeApi);
    if (!q) {
      q = { tail: Promise.resolve(), seq: 0, last: null };
      queues.set(chromeApi, q);
    }
    return q;
  }

  function noop() { }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function waitTurn(tail) {
    return new Promise(function (resolve) {
      var timer = setTimeout(resolve, QUEUE_WAIT_MS);
      tail.then(function () { clearTimeout(timer); resolve(); });
    });
  }

  function errorText(err) {
    return String((err && err.message) || err || '');
  }

  /** Chrome's answer when the id is already registered (or being registered). */
  function isDuplicate(err) {
    return /duplicate/i.test(errorText(err));
  }

  /**
   * What updateContentScripts is handed. An update only replaces the fields it
   * is given, so a Never list left in the old registration would survive an
   * update without one: an empty excludeMatches is passed on purpose.
   */
  function updateOf(spec) {
    var out = {};
    Object.keys(spec).forEach(function (k) { out[k] = spec[k]; });
    if (!out.excludeMatches) out.excludeMatches = [];
    return out;
  }

  function registerOrUpdate(chromeApi, spec, tries) {
    var scripting = chromeApi.scripting;
    return Promise.resolve()
      .then(function () { return scripting.registerContentScripts([spec]); })
      .then(function () { return spec; }, function (err) {
        // The other context registered the id between our unregister and this
        // register. Chrome holds one registration per id, so bring that one to
        // this spec rather than fail. Any other refusal is a real failure.
        if (!isDuplicate(err) || typeof scripting.updateContentScripts !== 'function') throw err;
        return Promise.resolve()
          .then(function () { return scripting.updateContentScripts([updateOf(spec)]); })
          .then(function () { return spec; }, function (err2) {
            // "does not exist or is not fully registered": the other
            // registration was still being set up, or was removed again in
            // between. Start over, a bounded number of times.
            if (tries + 1 >= MAX_TRIES) throw err2;
            return delay(RETRY_MS).then(function () {
              return registerOrUpdate(chromeApi, spec, tries + 1);
            });
          });
      });
  }

  function converge(chromeApi, spec) {
    return Promise.resolve()
      .then(function () {
        return chromeApi.scripting.unregisterContentScripts({ ids: [PRELOAD_ID] });
      })
      // Chrome rejects this when nothing is registered under that id, which is
      // the ordinary case on a fresh worker - and "nothing registered" is
      // exactly what this step is for. Not a failure.
      .catch(function () { })
      .then(function () {
        if (!spec) return null;
        return registerOrUpdate(chromeApi, spec, 0);
      });
  }

  /**
   * Replace the early dark background registration with the one this store
   * asks for. Resolves to the spec that was registered, or null when the store
   * asks for none.
   *
   * Calls in one context run one at a time, and a call that a newer one has
   * already overtaken in the queue does no work of its own: it resolves with
   * the newer call's result, so the last store handed in is the one that ends
   * up registered.
   *
   * A failed registration REJECTS rather than resolving: the caller has to be
   * able to tell a registration that happened from one that did not.
   * background.js ignores the rejection (a failed registration must never take
   * the worker down), and the hard reset reports it as a step that did not
   * finish instead of claiming the early dark background is back.
   */
  function registerPreload(chromeApi, store, deps) {
    var q = queueOf(chromeApi);
    var seq = ++q.seq;
    var job = waitTurn(q.tail).then(function () {
      if (seq !== q.seq) return SKIPPED;
      return converge(chromeApi, preloadSpec(store, deps));
    });
    q.tail = job.then(noop, noop);
    q.last = job;
    function settle(result) {
      return result === SKIPPED ? q.last.then(settle) : result;
    }
    return job.then(settle);
  }

  // ------------------------------------------------------ reading it back

  /** The early dark background in a getRegisteredContentScripts() answer. */
  function findPreload(list) {
    var all = Array.isArray(list) ? list : [];
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === PRELOAD_ID) return all[i];
    }
    return null;
  }

  function sameSet(a, b) {
    var x = (a || []).map(String).sort();
    var y = (b || []).map(String).sort();
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  function files(list) {
    return (list || []).map(function (f) { return String(f).replace(/^\/+/, ''); });
  }

  /**
   * Does what Chrome holds equal the spec? `spec` null means "nothing
   * registered". Pattern lists are compared as sets, since Chrome keeps them in
   * its own order; an absent field means Chrome's default.
   */
  function matchesSpec(found, spec) {
    if (!spec) return !found;
    if (!found) return false;
    return found.id === spec.id &&
      sameSet(files(found.css), files(spec.css)) &&
      !(found.js && found.js.length) &&
      sameSet(found.matches, spec.matches) &&
      sameSet(found.excludeMatches, spec.excludeMatches) &&
      (found.runAt || 'document_idle') === (spec.runAt || 'document_idle') &&
      !!found.allFrames === !!spec.allFrames &&
      (found.persistAcrossSessions !== false) === (spec.persistAcrossSessions !== false);
  }

  /** A short description for the hard reset's itemised report. */
  function describe(reg) {
    if (!reg) return 'no early dark background';
    var ex = reg.excludeMatches && reg.excludeMatches.length;
    return (reg.id || 'a registration') + ' with ' + files(reg.css).join(', ') +
      (ex ? ' and ' + ex + ' excluded pattern(s)' : '');
  }

  /**
   * Clear the schedule alarm and create it again only if the schedule needs
   * one. Resolves to the alarm time, or null when none is needed.
   *
   * Like registerPreload, a failure to create the alarm rejects rather than
   * resolving null: "no alarm was needed" and "the alarm could not be made"
   * must not look the same to the hard reset.
   */
  function scheduleAlarms(chromeApi, store, deps) {
    return Promise.resolve()
      .then(function () { return chromeApi.alarms.clear(ALARM_SCHEDULE); })
      // Clearing an alarm that is not there is not a failure either.
      .catch(function () { })
      .then(function () {
        var sch = (store && store.settings && store.settings.schedule) || { type: 'always' };
        if (sch.type !== 'hours') return null;
        var at = settingsOf(deps).nextScheduleChange(sch, nowOf(deps));
        if (!at) return null;
        return Promise.resolve(chromeApi.alarms.create(ALARM_SCHEDULE, { when: at }))
          .then(function () { return at; });
      });
  }

  return {
    PRELOAD_ID: PRELOAD_ID,
    ALARM_SCHEDULE: ALARM_SCHEDULE,
    neverHosts: neverHosts,
    preloadSpec: preloadSpec,
    registerPreload: registerPreload,
    findPreload: findPreload,
    matchesSpec: matchesSpec,
    describe: describe,
    scheduleAlarms: scheduleAlarms
  };
});
