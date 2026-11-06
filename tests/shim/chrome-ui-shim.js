/*
 * Darkrai tests - shim/chrome-ui-shim.js
 *
 * A fake chrome.* API just big enough for popup.js and options.js to render
 * their normal, non-blocked state in a plain tab. The content-script shim
 * (shim/chrome-shim.js) is the one for pages; this one is for the two
 * extension surfaces.
 *
 * It is injected with CDP Page.addScriptToEvaluateOnNewDocument, so it runs
 * before popup.html's own script tags and no test-only <script> is ever added
 * to the shipped HTML.
 *
 * Every call is recorded on window.__drUiShim.calls, so an assertion can check
 * what a button actually did:
 *
 *   __drUiShim.calls                      // [{ api, args, at }, ...]
 *   __drUiShim.find('runtime.openOptionsPage')
 *   __drUiShim.store()                    // the in-memory storage.local
 *   __drUiShim.reset()                    // forget the recorded calls
 */
(function () {
  'use strict';
  if (typeof chrome === 'object' && chrome && chrome.runtime && chrome.runtime.id) return;

  var TAB = { id: 1, url: 'https://example.com/', title: 'Example', active: true, windowId: 1 };
  var TAB_REPLY = { ok: true, state: 'on' };   // __drUiShim.setTabState() changes it

  // Used until shared/settings.js has loaded and can give us the real
  // defaults(); the store is seeded lazily on first access for that reason.
  var FALLBACK = {
    schema: 2,
    debug: false,
    settings: {
      enabled: true,
      defaultMode: 'auto',
      look: 'gray',
      brightness: 100,
      contrast: 100,
      warmth: 0,
      dimImages: false,
      schedule: { type: 'always', from: '19:00', to: '07:00' }
    },
    sites: { 'docs.google.com': { mode: 'on', engine: 'filter' } }
  };

  var calls = [];
  var storageListeners = [];
  var messageListeners = [];
  var alarms = [];
  // Dynamic content scripts, kept like Chrome keeps them so a read-back after
  // a register sees it (the hard reset checks its own registration). As
  // lenient as before: nothing is ever refused, so no call path changes.
  var registered = [];
  var store = null;

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function record(api, args) {
    var safe = [];
    for (var i = 0; i < args.length; i++) {
      var arg = args[i];
      if (typeof arg === 'function') { safe.push('[function]'); continue; }
      try { safe.push(clone(arg)); } catch (e) { safe.push(String(arg)); }
    }
    calls.push({ api: api, args: safe, at: Date.now() });
  }

  function seeded() {
    if (store) return store;
    var base = FALLBACK;
    try {
      if (window.Darkrai && window.Darkrai.settings && window.Darkrai.settings.defaults) {
        base = window.Darkrai.settings.defaults();
      }
    } catch (e) { /* fall back to the literal above */ }
    store = clone(base);
    return store;
  }

  function later(fn) { setTimeout(fn, 0); }

  /** Call the last argument if it is a callback. */
  function back(args, value) {
    var fn = args.length ? args[args.length - 1] : null;
    if (typeof fn === 'function') later(function () { fn(value); });
    return Promise.resolve(value);
  }

  function pick(keys) {
    var data = seeded();
    if (keys == null || typeof keys === 'function') return clone(data);
    if (typeof keys === 'string') keys = [keys];
    var out = {};
    if (Array.isArray(keys)) {
      keys.forEach(function (k) { if (k in data) out[k] = clone(data[k]); });
      return out;
    }
    Object.keys(keys).forEach(function (k) {
      out[k] = k in data ? clone(data[k]) : clone(keys[k]);
    });
    return out;
  }

  function announce(changes) {
    later(function () {
      storageListeners.forEach(function (fn) {
        try { fn(changes, 'local'); } catch (e) { }
      });
    });
  }

  var chromeShim = {
    __shim: true,
    runtime: {
      id: 'darkrai-ui-shim',
      lastError: undefined,
      getURL: function (file) {
        record('runtime.getURL', arguments);
        return new URL('/extension/' + String(file || '').replace(/^\/+/, ''), location.origin).href;
      },
      openOptionsPage: function (callback) {
        record('runtime.openOptionsPage', arguments);
        return back(arguments, undefined);
      },
      getManifest: function () {
        record('runtime.getManifest', arguments);
        return { name: 'Darkrai', version: '1.0.0', manifest_version: 3 };
      },
      sendMessage: function (message, callback) {
        record('runtime.sendMessage', arguments);
        return back(arguments, { ok: true });
      },
      onMessage: {
        addListener: function (fn) { messageListeners.push(fn); },
        removeListener: function (fn) {
          var i = messageListeners.indexOf(fn);
          if (i > -1) messageListeners.splice(i, 1);
        },
        hasListener: function (fn) { return messageListeners.indexOf(fn) > -1; }
      }
    },

    storage: {
      local: {
        get: function (keys, callback) {
          record('storage.local.get', arguments);
          return back(arguments, pick(keys));
        },
        set: function (items, callback) {
          record('storage.local.set', arguments);
          var data = seeded();
          var changes = {};
          Object.keys(items || {}).forEach(function (k) {
            changes[k] = { oldValue: clone(data[k]), newValue: clone(items[k]) };
            data[k] = clone(items[k]);
          });
          announce(changes);
          return back(arguments, undefined);
        },
        remove: function (keys, callback) {
          record('storage.local.remove', arguments);
          var data = seeded();
          var changes = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
            changes[k] = { oldValue: clone(data[k]) };
            delete data[k];
          });
          announce(changes);
          return back(arguments, undefined);
        },
        clear: function (callback) {
          record('storage.local.clear', arguments);
          store = {};
          announce({});
          return back(arguments, undefined);
        }
      },
      onChanged: {
        addListener: function (fn) { storageListeners.push(fn); },
        removeListener: function (fn) {
          var i = storageListeners.indexOf(fn);
          if (i > -1) storageListeners.splice(i, 1);
        },
        hasListener: function (fn) { return storageListeners.indexOf(fn) > -1; }
      }
    },

    tabs: {
      query: function (info, callback) {
        record('tabs.query', arguments);
        return back(arguments, [clone(TAB)]);
      },
      get: function (id, callback) {
        record('tabs.get', arguments);
        return back(arguments, clone(TAB));
      },
      // (tabId, message, options, callback) and (tabId, message, callback).
      sendMessage: function (tabId, message, options, callback) {
        record('tabs.sendMessage', arguments);
        return back(arguments, clone(TAB_REPLY));
      },
      reload: function (tabId, options, callback) {
        record('tabs.reload', arguments);
        return back(arguments, undefined);
      },
      create: function (options, callback) {
        record('tabs.create', arguments);
        return back(arguments, clone(TAB));
      }
    },

    scripting: {
      executeScript: function (details, callback) {
        record('scripting.executeScript', arguments);
        return back(arguments, [{ frameId: 0, result: null }]);
      },
      getRegisteredContentScripts: function (filter, callback) {
        record('scripting.getRegisteredContentScripts', arguments);
        var ids = filter && typeof filter === 'object' && Array.isArray(filter.ids) ? filter.ids : null;
        return back(arguments, clone(registered.filter(function (s) {
          return !ids || ids.indexOf(s.id) > -1;
        })));
      },
      registerContentScripts: function (scripts, callback) {
        record('scripting.registerContentScripts', arguments);
        (Array.isArray(scripts) ? scripts : []).forEach(function (s) {
          registered = registered.filter(function (r) { return r.id !== s.id; });
          registered.push(clone(s));
        });
        return back(arguments, undefined);
      },
      unregisterContentScripts: function (filter, callback) {
        record('scripting.unregisterContentScripts', arguments);
        var ids = filter && typeof filter === 'object' && Array.isArray(filter.ids) ? filter.ids : null;
        registered = ids ? registered.filter(function (r) { return ids.indexOf(r.id) < 0; }) : [];
        return back(arguments, undefined);
      }
    },

    alarms: {
      getAll: function (callback) {
        record('alarms.getAll', arguments);
        return back(arguments, clone(alarms));
      },
      clear: function (name, callback) {
        record('alarms.clear', arguments);
        alarms = alarms.filter(function (a) { return a.name !== name; });
        return back(arguments, true);
      },
      create: function (name, info) {
        record('alarms.create', arguments);
        alarms.push({ name: String(name), scheduledTime: Date.now() + 60000 });
      }
    },

    action: {
      setIcon: function (details, callback) {
        record('action.setIcon', arguments);
        return back(arguments, undefined);
      },
      setTitle: function (details, callback) {
        record('action.setTitle', arguments);
        return back(arguments, undefined);
      }
    }
  };

  window.chrome = chromeShim;

  // window.close() does nothing in a normal tab and logs a warning; the two
  // surfaces call it after "Options" and "Reload this tab". Swallow it so a
  // recorded click stays quiet, and note that it happened.
  try {
    var realClose = window.close.bind(window);
    window.close = function () { record('window.close', arguments); void realClose; };
  } catch (e) { /* leave it alone if the host will not allow the swap */ }

  window.__drUiShim = {
    calls: calls,
    tab: clone(TAB),
    store: function () { return clone(seeded()); },
    raw: function () { return seeded(); },
    find: function (api) {
      return calls.filter(function (c) { return c.api === api; });
    },
    called: function (api) {
      return calls.some(function (c) { return c.api === api; });
    },
    reset: function () { calls.length = 0; },
    /** What the tab answers dr-status / dr-refresh with from now on. */
    setTabState: function (state) { TAB_REPLY.state = String(state); return TAB_REPLY.state; },
    /** Push a storage change the way another window would. */
    change: function (items) { return chromeShim.storage.local.set(items); }
  };
})();
