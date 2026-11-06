/*
 * Darkrai tests - shim/fake-chrome.js
 *
 * A fake chrome.* object for the Node unit tests: storage, scripting, alarms,
 * tabs and action, each one recording what it was asked to do.
 *
 * It is deliberately able to misbehave, because that is the interesting half
 * of a safety net. Pass `fail`:
 *
 *   createFakeChrome({ fail: { 'alarms.getAll': 'disk is on fire' } })  -> rejects
 *   createFakeChrome({ fail: { 'tabs.sendMessage': 'silent' } })        -> never answers
 *
 * Nothing here is loaded by the extension; it exists only for `node --test`.
 */
'use strict';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const SILENT = 'silent';

function createFakeChrome(options) {
  const o = options || {};
  const fail = o.fail || {};
  const areas = o.areas || ['local', 'session', 'sync'];

  const state = {
    local: o.store ? clone(o.store) : {},
    session: {},
    sync: {},
    registered: o.registered ? clone(o.registered) : [],
    alarms: o.alarms ? clone(o.alarms) : [],
    tabs: o.tabs ? clone(o.tabs) : [],
    calls: [],
    executed: [],
    messaged: [],
    icons: [],
    titles: []
  };

  function record(api, args) {
    state.calls.push({ api: api, args: clone(args) });
  }

  /**
   * Promise-style call: resolves, rejects or never answers.
   *
   * `failKey` lets one api be made to fail only in one of its shapes -
   * 'scripting.executeScript.func' fails the sweeper while the file injection
   * still works, which is how the two halves are told apart.
   */
  function act(api, args, run, failKey) {
    record(api, args);
    const how = (failKey && failKey in fail) ? fail[failKey] : fail[api];
    if (how === SILENT) return new Promise(function () { });
    if (how) return Promise.reject(new Error(String(how)));
    return Promise.resolve().then(run);
  }

  function areaApi(name) {
    return {
      get: function (keys) {
        return act('storage.' + name + '.get', [keys], function () {
          if (keys == null) return clone(state[name]);
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
            if (k in state[name]) out[k] = clone(state[name][k]);
          });
          return out;
        });
      },
      set: function (items) {
        return act('storage.' + name + '.set', [items], function () {
          Object.keys(items || {}).forEach(function (k) {
            state[name][k] = clone(items[k]);
          });
        });
      },
      remove: function (keys) {
        return act('storage.' + name + '.remove', [keys], function () {
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete state[name][k]; });
        });
      },
      clear: function () {
        return act('storage.' + name + '.clear', [], function () { state[name] = {}; });
      }
    };
  }

  const storage = {};
  areas.forEach(function (name) { storage[name] = areaApi(name); });

  const chromeApi = {
    runtime: { id: 'darkrai-fake', lastError: undefined },

    storage: storage,

    scripting: {
      getRegisteredContentScripts: function (filter) {
        return act('scripting.getRegisteredContentScripts', [filter], function () {
          return clone(state.registered);
        });
      },
      registerContentScripts: function (scripts) {
        return act('scripting.registerContentScripts', [scripts], function () {
          (scripts || []).forEach(function (spec) { state.registered.push(clone(spec)); });
        });
      },
      unregisterContentScripts: function (filter) {
        return act('scripting.unregisterContentScripts', [filter], function () {
          const ids = (filter && filter.ids) || null;
          state.registered = state.registered.filter(function (spec) {
            return ids ? ids.indexOf(spec.id) < 0 : false;
          });
        });
      },
      executeScript: function (details) {
        const which = details && details.func ? 'func' : 'files';
        return act('scripting.executeScript', [{
          target: details && details.target,
          files: details && details.files,
          func: details && details.func ? '[function]' : undefined
        }], function () {
          state.executed.push({
            tabId: details && details.target && details.target.tabId,
            files: clone((details && details.files) || null),
            func: !!(details && details.func)
          });
          return [{ frameId: 0, result: null }];
        }, 'scripting.executeScript.' + which);
      }
    },

    alarms: {
      getAll: function () {
        return act('alarms.getAll', [], function () { return clone(state.alarms); });
      },
      clear: function (name) {
        return act('alarms.clear', [name], function () {
          const before = state.alarms.length;
          state.alarms = state.alarms.filter(function (a) { return a.name !== name; });
          return before !== state.alarms.length;
        });
      },
      create: function (name, info) {
        return act('alarms.create', [name, info], function () {
          state.alarms.push({ name: String(name), scheduledTime: (info && info.when) || 0 });
        });
      }
    },

    tabs: {
      query: function (info) {
        return act('tabs.query', [info], function () { return clone(state.tabs); });
      },
      // Callback style, like the real one when options are passed.
      sendMessage: function (tabId, msg, opts, callback) {
        record('tabs.sendMessage', [tabId, msg, opts]);
        state.messaged.push({ tabId: tabId, type: msg && msg.type, options: clone(opts) });
        const how = fail['tabs.sendMessage'];
        if (how === SILENT) return undefined;          // never answers
        setTimeout(function () {
          if (typeof callback !== 'function') return;
          if (how) { chromeApi.runtime.lastError = { message: String(how) }; callback(undefined); }
          else callback({ ok: true });
        }, 0);
        return undefined;
      }
    },

    action: {
      setIcon: function (details) {
        return act('action.setIcon', [details], function () {
          state.icons.push(clone(details));
        });
      },
      setTitle: function (details) {
        return act('action.setTitle', [details], function () {
          state.titles.push(clone(details));
        });
      }
    }
  };

  return {
    chrome: chromeApi,
    state: state,
    store: function () { return clone(state.local); },
    calls: function (api) {
      return state.calls.filter(function (c) { return c.api === api; });
    },
    called: function (api) {
      return state.calls.some(function (c) { return c.api === api; });
    }
  };
}

module.exports = { createFakeChrome: createFakeChrome, clone: clone };
