/*
 * Darkrai - content/main.js
 * Page lifecycle: decide, apply, remove, and take down older copies of itself
 * (PLAN sections 5, 6.1 and 6.7).
 *
 * Injected at document_start in every frame. Safe to inject repeatedly: the
 * whole file is wrapped, so nothing is ever "already declared", and a new copy
 * removes any older one before it starts.
 */
(function () {
  'use strict';
  var NS = (window.Darkrai = window.Darkrai || {});
  var color = NS.color, settingsApi = NS.settings, detect = NS.detect;
  if (!color || !settingsApi || !detect) return;      // load order broken: stay out of the way
  // Nothing to darken, so not even the store is worth reading. A tracking
  // pixel or an ad slot is usually one of these, and a page can hold dozens.
  if (!document.documentElement) return;
  if (!document.body && location.href === 'about:blank') return;
  // Dev-only timing. A missing module must be harmless.
  var T = NS.timing || { mark: function () { }, count: function () { } };

  var MARK = 'data-darkrai';
  var IDATTR = 'data-dr-id';
  var ROOT_ATTR = 'data-darkrai';
  var TAKEDOWN_EVENT = 'darkrai:takedown';
  var TOKEN = 'dr-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  var CALL_TIMEOUT_MS = 1200;

  // ------------------------------------------------- take down older copies

  function sweepLeftovers() {
    try {
      var stale = document.querySelectorAll('style[' + MARK + ']');
      for (var i = 0; i < stale.length; i++) {
        if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
      }
      var stamped = document.querySelectorAll('[' + IDATTR + ']');
      for (var j = 0; j < stamped.length; j++) stamped[j].removeAttribute(IDATTR);
    } catch (e) { }
  }

  function takedownOlder() {
    // 1. a shared handle, when the old copy is still reachable
    try {
      if (window.__darkraiHandle && window.__darkraiHandle.token !== TOKEN &&
        typeof window.__darkraiHandle.teardown === 'function') {
        window.__darkraiHandle.teardown('replaced');
      }
    } catch (e) { }
    // 2. a DOM event, which crosses into any other copy
    try {
      document.dispatchEvent(new CustomEvent(TAKEDOWN_EVENT, { detail: { token: TOKEN } }));
    } catch (e) { }
    // 3. a sweep for anything left behind
    sweepLeftovers();
  }

  takedownOlder();

  // ----------------------------------------------------------- chrome calls

  function hasChrome() {
    try { return typeof chrome === 'object' && !!chrome && !!chrome.runtime && !!chrome.runtime.id; }
    catch (e) { return false; }
  }

  /** Every chrome.* call gets a timeout: a sleeping worker must never hang us. */
  function withTimeout(fn, ms, fallback) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true; resolve(fallback);
      }, ms || CALL_TIMEOUT_MS);
      try {
        fn(function (value) {
          if (done) return; done = true; clearTimeout(timer); resolve(value);
        });
      } catch (e) {
        if (done) return; done = true; clearTimeout(timer); resolve(fallback);
      }
    });
  }

  function readStore() {
    if (!hasChrome() || !chrome.storage || !chrome.storage.local) {
      return Promise.resolve(settingsApi.defaults());
    }
    return withTimeout(function (done) {
      chrome.storage.local.get(null, function (raw) {
        void chrome.runtime.lastError;
        done(settingsApi.upgrade(raw));
      });
    }, CALL_TIMEOUT_MS, settingsApi.defaults());
  }

  function writeStore(next) {
    if (!hasChrome() || !chrome.storage || !chrome.storage.local) return Promise.resolve(false);
    return withTimeout(function (done) {
      chrome.storage.local.set(
        {
          schema: next.schema, debug: next.debug === true,
          settings: next.settings, sites: next.sites
        },
        function () { void chrome.runtime.lastError; done(true); }
      );
    }, CALL_TIMEOUT_MS, false);
  }

  /** The picker hands us one fix; remember it for this site. */
  function saveFix(fix) {
    var next = settingsApi.addSiteFix(store, host, fix);
    store = next;
    writeStore(next);
  }

  function send(message) {
    if (!hasChrome()) return Promise.resolve(null);
    return withTimeout(function (done) {
      chrome.runtime.sendMessage(message, function (reply) {
        void chrome.runtime.lastError;
        done(reply || null);
      });
    }, CALL_TIMEOUT_MS, null);
  }

  // ------------------------------------------------------------------ state

  var store = settingsApi.defaults();
  var engine = null;
  var guard = null;
  var icons = null;
  var fixer = null;
  var watcher = null;
  var state = 'off';               // on | native | off
  var detection = null;
  var torn = false;
  var host = resolveHost();
  var recheckTimers = [];
  var lastApplyKey = '';
  var canFix = false;              // the picker could run here, if asked
  var whenVisibleQueue = [];

  /**
   * A background tab paints nothing, so the readability guard and the icon
   * rescue have nothing to measure: hold them until the tab is looked at.
   */
  function whenVisible(fn) {
    if (!document.hidden) { fn(); return; }
    whenVisibleQueue.push(fn);
    if (whenVisibleQueue.length === 1) {
      try { document.addEventListener('visibilitychange', onVisible, true); } catch (e) { }
    }
  }

  function onVisible() {
    if (document.hidden) return;
    try { document.removeEventListener('visibilitychange', onVisible, true); } catch (e) { }
    var list = whenVisibleQueue.slice();
    whenVisibleQueue.length = 0;
    for (var i = 0; i < list.length; i++) { try { list[i](); } catch (e) { } }
  }

  function resolveHost() {
    var own = (location.hostname || '').toLowerCase().replace(/^www\./, '');
    if (window.top === window) return own;
    // A frame follows the top page's site setting.
    try {
      var topHost = window.top.location.hostname;
      if (topHost) return String(topHost).toLowerCase().replace(/^www\./, '');
    } catch (e) { }
    try {
      if (document.referrer) {
        var ref = settingsApi.hostFromUrl(document.referrer);
        if (ref) return ref;
      }
    } catch (e) { }
    return own;
  }

  function setRootAttr(value) {
    try {
      var root = document.documentElement;
      if (root && root.getAttribute(ROOT_ATTR) !== value) root.setAttribute(ROOT_ATTR, value);
    } catch (e) { }
  }

  function lookOf() { return color.resolveLook(store.settings); }

  function engineNameFor() {
    return settingsApi.resolveEngine(store, host) === 'filter' ? 'simple' : 'smart';
  }

  function makeEngine() {
    var look = lookOf();
    if (engineNameFor() === 'simple') {
      return NS.engineSimple.create({ host: host, settings: store.settings, look: look });
    }
    return NS.engineSmart.create({
      look: look,
      settings: store.settings,
      requestSheet: function (url) {
        return send({ type: 'dr-fetch-sheet', url: url }).then(function (reply) {
          return reply && reply.ok ? reply.text : null;
        });
      }
    });
  }

  /**
   * Hooks for one measurement with Darkrai switched off.
   *
   * The engine knows about its own sheets, including the ones inside shadow
   * roots and the adopted ones. Everything else we own - the readability
   * guard's rules, inverted icons, and the fixes remembered for this site -
   * lives in a plain <style data-darkrai> node, and those must go off too: a
   * remembered "Make readable" fix sets a background colour, so leaving them on
   * would let us measure our own output and call the site natively dark.
   */
  function measureHooks() {
    var extra = null;
    var restoreAdopted = null;
    return {
      suspend: function () {
        if (engine) engine.suspend();
        extra = [];
        try {
          var list = document.querySelectorAll('style[' + MARK + ']');
          for (var i = 0; i < list.length; i++) {
            if (list[i].disabled) continue;          // already off: the engine's
            try { list[i].disabled = true; extra.push(list[i]); } catch (e) { }
          }
        } catch (e) { }
        // The guard and the icon rescue now keep their rules in a constructed
        // sheet adopted on the document rather than in a <style> node, and a
        // constructed sheet cannot be disabled: it has to come out of the
        // array. engine.suspend() has already taken the engine's own out,
        // including the ones inside shadow roots, which is the only place
        // anything other than the document is adopted.
        restoreAdopted = null;
        try {
          var adopted = document.adoptedStyleSheets || [];
          var keep = [], ours = 0;
          for (var j = 0; j < adopted.length; j++) {
            if (adopted[j] && adopted[j].__darkrai) ours++;
            else keep.push(adopted[j]);
          }
          if (ours) {
            restoreAdopted = Array.prototype.slice.call(adopted);
            document.adoptedStyleSheets = keep;
          }
        } catch (e) { }
      },
      resume: function () {
        if (restoreAdopted) {
          try { document.adoptedStyleSheets = restoreAdopted; } catch (e) { }
          restoreAdopted = null;
        }
        if (extra) {
          for (var i = 0; i < extra.length; i++) {
            try { extra[i].disabled = false; } catch (e) { }
          }
          extra = null;
        }
        if (engine) engine.resume();
      }
    };
  }

  function ensureFixer() {
    if (fixer || !canFix || !NS.picker || window.top !== window) return fixer;
    fixer = NS.picker.create({ look: lookOf(), onSaved: saveFix });
    return fixer;
  }

  /** Re-apply the fixes remembered for this site (PLAN section 4, item 3). */
  function syncFixes() {
    if (!fixer && settingsApi.resolveFixes(store, host).length) ensureFixer();
    if (!fixer) return;
    fixer.setLook(lookOf());
    fixer.applyFixes(settingsApi.resolveFixes(store, host));
  }

  function applyDark() {
    T.mark('apply-start');
    var key = engineNameFor() + '|' + JSON.stringify(store.settings);
    if (engine && lastApplyKey === key) {
      state = 'on'; setRootAttr('on'); syncFixes(); return;
    }
    if (engine) removeDark(true);
    lastApplyKey = key;
    engine = makeEngine();
    engine.apply();
    if (engine.name === 'smart') {
      guard = NS.readability.create({ look: lookOf() });
      // Icon rescue and the remembered fixes only make sense while we are the
      // ones doing the recolouring; Simple mode inverts everything already.
      if (NS.icons) {
        icons = NS.icons.create({
          requestAnalysis: function (url) {
            return send({ type: 'dr-analyze-icon', url: url }).then(function (reply) {
              return !!(reply && reply.ok && reply.invert);
            });
          }
        });
        whenVisible(function () { if (icons) icons.start(); });
      }
      // The picker's handle costs nothing until start() builds its UI, but it
      // is only needed once this site has a saved fix or someone asks for it.
      canFix = !!(NS.picker && window.top === window);
      if (canFix && settingsApi.resolveFixes(store, host).length) ensureFixer();
      syncFixes();
      // The guard measures what is really painted, so it waits for the engine's
      // first pass to finish. The timer is a backstop, not the normal path.
      // Both are tied to THIS guard: a backstop left over from an earlier
      // apply must not start a newer guard before its own engine has settled.
      var ownGuard = guard;
      var startGuard = function () {
        if (!ownGuard || guard !== ownGuard || ownGuard.__started) return;
        ownGuard.__started = true;
        whenVisible(function () { if (guard === ownGuard) ownGuard.start(); });
      };
      if (engine.onSettled) engine.onSettled(startGuard);
      recheckTimers.push(setTimeout(startGuard, 1500));
    }
    state = 'on';
    setRootAttr('on');
  }

  function removeDark(keepState) {
    if (guard) { try { guard.stop(); } catch (e) { } guard = null; }
    if (icons) { try { icons.stop(); } catch (e) { } icons = null; }
    if (fixer) { try { fixer.remove(); } catch (e) { } fixer = null; }
    if (engine) { try { engine.remove(); } catch (e) { } engine = null; }
    lastApplyKey = '';
    canFix = false;
    if (!keepState) { state = 'off'; }
  }

  function report() {
    send({ type: 'dr-state', state: state, host: host, top: window.top === window });
  }

  // ----------------------------------------------------------- the decision

  function runDecision(reason) {
    if (torn) return;
    decidedKey = decisionKey(store);
    var verdict = settingsApi.decideForPage(store, host, { systemDark: detect.matchMediaDark() });
    // A setting decided it outright: there is no already-dark measurement.
    if (verdict !== 'detect') T.mark('decision-done');

    if (verdict === 'skip') {
      removeDark();
      state = 'off';
      setRootAttr('off');
      report();
      return;
    }
    if (verdict === 'dark') {
      applyDark();
      report();
      return;
    }

    // Auto: never touch a site that already has a dark theme of its own.
    var result = detect.measure(engine ? measureHooks() : null);
    T.mark('decision-done');
    detection = result;
    if (result.dark) {
      removeDark();
      state = 'native';
      setRootAttr('native');
      report();
      if (!result.confident) scheduleRecheck();
      return;
    }
    applyDark();
    report();
    if (!result.confident) scheduleRecheck();
  }

  function scheduleRecheck() {
    var t = setTimeout(function () { runDecision('unclear-recheck'); }, detect.UNCLEAR_RECHECK_MS);
    recheckTimers.push(t);
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else fn();
  }

  function startWatching() {
    if (watcher) return;
    watcher = detect.createWatcher({
      onSignal: function (reason) {
        if (torn) return;
        // Only the auto path can change its mind from a theme signal.
        if (settingsApi.resolveMode(store, host) === 'auto') runDecision('signal:' + reason);
        else if (engine && engine.refresh) engine.refresh();
      }
    });
    watcher.start();
  }

  // --------------------------------------------------------------- teardown

  function teardown(why) {
    if (torn) return;
    torn = true;
    try { document.removeEventListener(TAKEDOWN_EVENT, onTakedown); } catch (e) { }
    try { document.removeEventListener('visibilitychange', onVisible, true); } catch (e) { }
    whenVisibleQueue.length = 0;
    if (watcher) { try { watcher.stop(); } catch (e) { } watcher = null; }
    if (reconcileTimer) { try { clearTimeout(reconcileTimer); } catch (e) { } reconcileTimer = null; }
    for (var i = 0; i < recheckTimers.length; i++) { try { clearTimeout(recheckTimers[i]); } catch (e) { } }
    recheckTimers = [];
    removeDark();
    try {
      if (hasChrome() && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      }
      if (hasChrome() && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.removeListener(onMessage);
      }
    } catch (e) { }
    try {
      if (window.__darkraiHandle && window.__darkraiHandle.token === TOKEN) delete window.__darkraiHandle;
    } catch (e) { }
    // Leave the marker behind as "off" rather than removing it: the early dark
    // background keys off its absence, and a torn-down page must look normal.
    try { document.documentElement.setAttribute(ROOT_ATTR, 'off'); } catch (e) { }
  }

  function onTakedown(event) {
    var detail = event && event.detail;
    if (detail && detail.token === TOKEN) return;     // our own dispatch
    teardown('event');
  }

  document.addEventListener(TAKEDOWN_EVENT, onTakedown);

  // --------------------------------------------------------------- messaging

  function statusPayload() {
    return {
      ok: true,
      token: TOKEN,
      state: state,
      host: host,
      engine: engine ? engine.name : null,
      mode: settingsApi.resolveMode(store, host),
      detection: detection ? {
        dark: detection.dark, confident: detection.confident,
        declaredDark: detection.declaredDark, usable: detection.usable, darkCount: detection.darkCount
      } : null,
      guard: guard ? guard.stats() : null,
      icons: icons ? icons.stats() : null,
      canPick: canFix || !!fixer,
      fixes: settingsApi.resolveFixes(store, host).length
    };
  }

  function onMessage(message, sender, respond) {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'dr-ping':
      case 'dr-status':
        respond(statusPayload());
        return true;
      case 'dr-refresh':
        readStore().then(function (next) {
          store = next;
          runDecision('refresh');
          respond(statusPayload());
        });
        return true;
      case 'dr-recheck':
        runDecision('recheck');
        respond(statusPayload());
        return true;
      case 'dr-pick':
        // The picker draws over the whole page, so only the top frame runs it.
        if (window.top !== window) { respond({ ok: false, reason: 'frame' }); return true; }
        ensureFixer();
        if (!fixer) {
          respond({
            ok: false,
            reason: state === 'on' ? 'unavailable' : 'not-darkened'
          });
          return true;
        }
        respond({ ok: fixer.start() });
        return true;
      case 'dr-teardown':
        teardown('message');
        respond({ ok: true });
        return true;
      default:
        return;
    }
  }

  // A burst of storage changes - twenty flicks of the master switch, say - is
  // one decision, not twenty. Every change used to read the store and run the
  // whole decision (a measurement of the page, then a full apply or remove),
  // and on a big page those piled up until the tab stopped answering. Now a
  // change only (re)starts a short settle timer; one reconcile then reads the
  // store as it is at that moment, and a reconcile whose read is overtaken by
  // a newer change drops its result, so the latest state always wins.
  var SETTLE_MS = 80;           // quiet time after the last change
  var SETTLE_MAX_MS = 2000;     // never wait longer than this behind a burst
  var reconcileTimer = null;
  var burstStartedAt = 0;
  var generation = 0;
  // What the last decision was made on. A reconcile that finds the same
  // inputs has nothing to do: the page already shows what a fresh apply of
  // this store would, and re-measuring a big page is itself a long task.
  var decidedKey = '';

  function decisionKey(s) {
    try {
      return JSON.stringify([s.settings, settingsApi.resolveMode(s, host),
        settingsApi.resolveEngine(s, host), settingsApi.resolveFixes(s, host),
        settingsApi.scheduleActive(s.settings.schedule, Date.now(), detect.matchMediaDark())]);
    } catch (e) { return ''; }
  }

  function scheduleReconcile(reason) {
    if (torn) return;
    generation++;
    var now = Date.now();
    if (reconcileTimer) { try { clearTimeout(reconcileTimer); } catch (e) { } }
    else burstStartedAt = now;
    var wait = Math.max(0, Math.min(SETTLE_MS, burstStartedAt + SETTLE_MAX_MS - now));
    reconcileTimer = setTimeout(function () {
      reconcileTimer = null;
      reconcile(reason);
    }, wait);
  }

  function reconcile(reason) {
    var mine = generation;
    readStore().then(function (next) {
      if (torn || mine !== generation) return;     // a newer change is on its way
      store = next;
      var key = decisionKey(next);
      if (key && key === decidedKey) return;      // nothing this page decides on changed
      runDecision(reason);
    });
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || torn) return;
    scheduleReconcile('storage');
  }

  // ------------------------------------------------------------------ start

  window.__darkraiHandle = {
    token: TOKEN,
    teardown: teardown,
    status: statusPayload,
    recheck: function () { runDecision('external'); }
  };

  if (hasChrome()) {
    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (e) { }
    try { chrome.runtime.onMessage.addListener(onMessage); } catch (e) { }
  }

  readStore().then(function (next) {
    if (torn) return;
    store = next;
    if (NS.timing) NS.timing.enable(store.debug);
    T.mark('store-read-done');
    var mode = settingsApi.resolveMode(store, host);
    var enabled = store.settings.enabled &&
      settingsApi.scheduleActive(store.settings.schedule, Date.now(), detect.matchMediaDark());

    if (!enabled || mode === 'off') {
      // Clear the early dark background straight away.
      setRootAttr('off');
      state = 'off';
      report();
      startWatching();
      return;
    }
    if (mode === 'on') {
      runDecision('initial-on');
      startWatching();
      onReady(function () { if (!torn) runDecision('ready'); });
      return;
    }
    // Auto: the preload background holds the page dark until we have measured.
    onReady(function () {
      if (torn) return;
      runDecision('ready');
      startWatching();
    });
    window.addEventListener('load', function () {
      if (!torn) runDecision('load');
    }, { once: true });
  });

  NS.main = {
    __v: 1,
    token: TOKEN,
    status: statusPayload,
    teardown: teardown,
    recheck: function () { runDecision('api'); }
  };
})();
