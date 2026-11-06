/*
 * Darkrai tests - shim/chrome-shim.js
 * A fake chrome.* API so the real content scripts run in a plain browser tab.
 * Load this BEFORE the content scripts.
 *
 * A fixture can set window.__DR_SHIM__ first to control what the shim serves:
 *   window.__DR_SHIM__ = {
 *     settings: { ... },        // merged over the defaults
 *     site:     { mode: 'on', engine: 'filter' },   // entry for the live host
 *     sites:    { 'other.com': { mode: 'off' } },
 *     debug:    true            // turns the dev-only timing module on
 *   };
 */
(function () {
  'use strict';
  if (typeof chrome === 'object' && chrome && chrome.runtime && chrome.runtime.id) return;

  var config = window.__DR_SHIM__ || {};

  function liveHost() {
    var host = (location.hostname || '').toLowerCase().replace(/^www\./, '');
    return host || 'fixture.local';
  }

  var store = {
    schema: 2,
    debug: config.debug === true,
    settings: Object.assign({
      enabled: true,
      defaultMode: 'auto',
      look: 'gray',
      brightness: 100,
      contrast: 100,
      warmth: 0,
      dimImages: false,
      schedule: { type: 'always', from: '19:00', to: '07:00' }
    }, config.settings || {}),
    sites: Object.assign({}, config.sites || {})
  };
  if (config.site) store.sites[liveHost()] = config.site;

  var storageListeners = [];
  var messageListeners = [];
  var log = [];

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function pick(keys) {
    if (keys == null) return clone(store);
    if (typeof keys === 'string') keys = [keys];
    var out = {};
    if (Array.isArray(keys)) {
      keys.forEach(function (k) { if (k in store) out[k] = clone(store[k]); });
      return out;
    }
    Object.keys(keys).forEach(function (k) {
      out[k] = k in store ? clone(store[k]) : clone(keys[k]);
    });
    return out;
  }

  function later(fn) { setTimeout(fn, 0); }

  var chromeShim = {
    __shim: true,
    runtime: {
      id: 'darkrai-fixture-shim',
      lastError: undefined,
      getURL: function (path) { return new URL('../../extension/' + path, location.href).href; },
      sendMessage: function (message, callback) {
        log.push(message);
        later(function () {
          var reply = { ok: true };
          if (message && message.type === 'dr-fetch-sheet') {
            // Offline on purpose: the fixtures never need another domain.
            reply = { ok: false, error: 'shim-offline' };
          }
          if (message && message.type === 'dr-state') {
            window.__DR_LAST_STATE__ = message.state;
          }
          if (typeof callback === 'function') callback(reply);
        });
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
          var result = pick(keys);
          if (typeof keys === 'function') { callback = keys; result = clone(store); }
          later(function () { if (callback) callback(result); });
          return Promise.resolve(result);
        },
        set: function (items, callback) {
          var changes = {};
          Object.keys(items || {}).forEach(function (k) {
            changes[k] = { oldValue: clone(store[k]), newValue: clone(items[k]) };
            store[k] = clone(items[k]);
          });
          later(function () {
            storageListeners.forEach(function (fn) {
              try { fn(changes, 'local'); } catch (e) { }
            });
            if (callback) callback();
          });
          return Promise.resolve();
        },
        remove: function (keys, callback) {
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete store[k]; });
          later(function () { if (callback) callback(); });
          return Promise.resolve();
        },
        clear: function (callback) {
          store = { schema: 2, debug: store.debug, settings: store.settings, sites: {} };
          later(function () { if (callback) callback(); });
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener: function (fn) { storageListeners.push(fn); },
        removeListener: function (fn) {
          var i = storageListeners.indexOf(fn);
          if (i > -1) storageListeners.splice(i, 1);
        }
      }
    }
  };

  window.chrome = chromeShim;

  // Handles for the fixture assertions.
  window.__darkraiShim = {
    store: function () { return clone(store); },
    raw: function () { return store; },
    messages: log,
    /** Deliver a message to the content script, as the popup would. */
    send: function (message) {
      return new Promise(function (resolve) {
        var answered = false;
        messageListeners.forEach(function (fn) {
          try {
            fn(message, { id: 'darkrai-fixture-shim' }, function (reply) {
              if (answered) return; answered = true; resolve(reply);
            });
          } catch (e) { }
        });
        setTimeout(function () { if (!answered) resolve(null); }, 500);
      });
    },
    /** Change a setting the way the popup does, through storage. */
    setSiteMode: function (mode) {
      var sites = clone(store.sites);
      sites[liveHost()] = Object.assign({}, sites[liveHost()], { mode: mode });
      return chromeShim.storage.local.set({ sites: sites });
    },
    liveHost: liveHost
  };
})();
