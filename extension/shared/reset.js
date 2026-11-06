/*
 * Darkrai - shared/reset.js
 *
 * The hard reset, and the much smaller per-site reset.
 *
 * This is the safety net: it has to work when the rest of the extension is
 * misbehaving. So it runs from the page that owns the button and talks to
 * chrome.storage, chrome.scripting, chrome.alarms and chrome.tabs DIRECTLY -
 * never through the service worker, which is exactly the part that might be
 * asleep, wedged or running an old copy of itself.
 *
 * Every chrome.* call is wrapped in its own short timeout, and the seven steps
 * are independent: one failing step cannot stop the other six. The result is
 * itemised and honest. A step that timed out is reported as a step that timed
 * out, never as success.
 *
 * The chrome-like object is injected (create({ chrome: ... })), which is what
 * makes the whole flow unit-testable in Node.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  var ns = (root.Darkrai = root.Darkrai || {});
  ns.reset = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // The page script answers a message in every frame, so a question about
  // "this page" is addressed to the top frame by name.
  var TOP_FRAME = { frameId: 0 };

  var DEFAULT_TIMEOUT_MS = 1500;

  // The same files, in the same order, as manifest.json content_scripts.js
  // and background.js CONTENT_FILES. Pass contentFiles to override.
  var CONTENT_FILES = [
    'shared/timing.js',
    'shared/color.js',
    'shared/settings.js',
    'shared/restricted.js',
    'content/detect.js',
    'content/engine-smart.js',
    'content/engine-simple.js',
    'content/readability.js',
    'content/icons.js',
    'content/picker.js',
    'content/main.js'
  ];

  var OFF_ICONS = {
    16: 'icons/off-16.png', 32: 'icons/off-32.png',
    48: 'icons/off-48.png', 128: 'icons/off-128.png'
  };
  var OFF_TITLE = 'Darkrai - off for this site';

  var STORAGE_AREAS = ['local', 'session', 'sync'];

  function message(err) {
    if (!err) return 'failed';
    return String(err.message || err);
  }

  /**
   * Scrub one tab from the outside. Serialised and injected with
   * chrome.scripting.executeScript, so it must be self-contained: no closure
   * variables, no helpers from this file.
   *
   * It runs in the same isolated world as the content scripts, so the page
   * script's own handle is reachable and is the cleanest way out. Everything
   * after that is the fallback for a page whose script is gone or wedged.
   */
  function sweepPage() {
    var out = { handle: false, styles: 0, hosts: 0, marked: 0, sheets: 0 };
    try {
      if (window.__darkraiHandle && typeof window.__darkraiHandle.teardown === 'function') {
        window.__darkraiHandle.teardown('reset');
        out.handle = true;
      }
    } catch (e) { /* a wedged handle is exactly why the rest of this exists */ }

    try {
      var styles = document.querySelectorAll('style[data-darkrai]');
      for (var i = 0; i < styles.length; i++) {
        if (styles[i].parentNode) { styles[i].parentNode.removeChild(styles[i]); out.styles++; }
      }
    } catch (e) { }

    try {
      var hosts = document.querySelectorAll('[data-darkrai]');
      for (var h = 0; h < hosts.length; h++) {
        var node = hosts[h];
        // The marker also sits on <html>, and that one is set to "off" rather
        // than removed - the element has to survive, and so does the
        // attribute. preload.css darkens html:not([data-darkrai]) from
        // document_start and is already live in this document; unregistering
        // it does not retract it from an open tab. Removing the attribute here
        // would hand the page straight back to that early #242424 background
        // under light content - permanently, on a tab that could not be
        // re-injected. content/main.js teardown() takes this same branch for
        // this same reason.
        if (node === document.documentElement || node === document.body) {
          node.setAttribute('data-darkrai', 'off');
        } else if (node.parentNode) {
          node.parentNode.removeChild(node);
          out.hosts++;
        }
      }
    } catch (e) { }

    try {
      var marked = document.querySelectorAll('[data-dr-id]');
      for (var m = 0; m < marked.length; m++) {
        marked[m].removeAttribute('data-dr-id');
        out.marked++;
      }
    } catch (e) { }

    // Darkrai's constructed stylesheets carry a __darkrai tag (engine-smart,
    // readability and icons all set it), which is how they are told apart
    // from the page's own adopted sheets.
    var drop = function (target) {
      try {
        var list = target.adoptedStyleSheets || [];
        var keep = [];
        for (var k = 0; k < list.length; k++) {
          if (list[k] && list[k].__darkrai) out.sheets++;
          else keep.push(list[k]);
        }
        if (keep.length !== list.length) target.adoptedStyleSheets = keep;
      } catch (e) { }
    };
    drop(document);
    try {
      var all = document.querySelectorAll('*');
      var limit = Math.min(all.length, 4000);
      for (var s = 0; s < limit; s++) {
        var shadow = all[s].shadowRoot;
        if (!shadow) continue;
        drop(shadow);
        // engine-smart.js appends a style[data-darkrai="shadow"] node into
        // every open shadow root it styles, and no document-level selector
        // crosses a shadow boundary - so each root is swept on its own.
        try {
          var inner = shadow.querySelectorAll('style[data-darkrai]');
          for (var si = 0; si < inner.length; si++) {
            if (inner[si].parentNode) {
              inner[si].parentNode.removeChild(inner[si]);
              out.styles++;
            }
          }
          var innerMarked = shadow.querySelectorAll('[data-dr-id]');
          for (var mi = 0; mi < innerMarked.length; mi++) {
            innerMarked[mi].removeAttribute('data-dr-id');
            out.marked++;
          }
        } catch (e2) { }
      }
    } catch (e) { }

    return out;
  }

  function create(deps) {
    var d = deps || {};
    var ns = root.Darkrai || {};
    var chromeApi = d.chrome || root.chrome;
    var settingsApi = d.settings || ns.settings;
    var restrictedApi = d.restricted || ns.restricted;
    var preloadReg = d.preloadReg || ns.preloadReg;
    var contentFiles = d.contentFiles || CONTENT_FILES;
    var T = d.timeoutMs > 0 ? d.timeoutMs : DEFAULT_TIMEOUT_MS;

    /** Is this chrome.* path there at all? */
    function has(path) {
      var node = chromeApi;
      var bits = path.split('.');
      for (var i = 0; i < bits.length; i++) {
        if (!node) return false;
        node = node[bits[i]];
      }
      return !!node;
    }

    /**
     * One chrome.* call, with its own timeout. Resolves - never rejects - to
     * { ok, value } or { ok: false, error, timedOut }.
     */
    function guard(fn) {
      return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          resolve({ ok: false, timedOut: true, error: 'no answer within ' + T + 'ms' });
        }, T);
        var value;
        try {
          value = fn();
        } catch (err) {
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, error: message(err) });
          return;
        }
        Promise.resolve(value).then(function (v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: true, value: v });
        }, function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, error: message(err) });
        });
      });
    }

    /** One step, wrapped so a throw inside it becomes a failed step. */
    function step(name, run) {
      return Promise.resolve().then(run).then(function (out) {
        return {
          name: name,
          ok: !!(out && out.ok),
          detail: (out && out.detail) || '',
          error: (out && out.error) || null
        };
      }, function (err) {
        return { name: name, ok: false, detail: '', error: message(err) };
      });
    }

    // ------------------------------------------------------- 1. clear storage

    function clearStorage() {
      var notes = [];
      var failed = [];
      return STORAGE_AREAS.reduce(function (chain, area) {
        return chain.then(function () {
          if (!has('storage.' + area) || typeof chromeApi.storage[area].clear !== 'function') {
            notes.push(area + ': no such API in this browser, nothing to clear');
            return null;
          }
          return guard(function () { return chromeApi.storage[area].clear(); }).then(function (r) {
            if (!r.ok) {
              failed.push(area);
              notes.push(area + ': ' + r.error);
              return null;
            }
            notes.push(area === 'local'
              ? 'local: cleared (this is where every Darkrai setting lives)'
              : area + ': cleared - Darkrai stores nothing here, but the API exists so it was ' +
              'cleared rather than skipped');
            return null;
          });
        });
      }, Promise.resolve()).then(function () {
        return {
          ok: !failed.length,
          detail: notes.join('; '),
          error: failed.length ? 'could not clear ' + failed.join(' and ') : null
        };
      });
    }

    // ---------------------------------------------------- 2. factory defaults

    function writeDefaults() {
      var store = settingsApi.defaults();
      var presets = Object.keys(store.sites || {});
      return guard(function () {
        return chromeApi.storage.local.set({
          schema: store.schema,
          debug: store.debug === true,
          settings: store.settings,
          sites: store.sites
        });
      }).then(function (r) {
        return {
          ok: r.ok,
          detail: r.ok
            ? 'schema ' + store.schema + ' defaults written back: Auto for new sites, the ' +
            'Dark gray look at 100/100/0, the Always schedule' +
            (presets.length ? ', and the ' + presets.join(', ') + ' Simple-mode preset' : '')
            : 'the defaults could not be written back',
          error: r.ok ? null : r.error
        };
      });
    }

    // ------------------------------------------------- 3. content scripts

    function resetContentScripts() {
      if (!preloadReg) {
        return {
          ok: false,
          detail: 'shared/preload-reg.js is not loaded on this page',
          error: 'no preloadReg'
        };
      }
      if (!has('scripting.getRegisteredContentScripts')) {
        return {
          ok: false,
          detail: 'chrome.scripting is not available here',
          error: 'no chrome.scripting'
        };
      }
      var defaults = settingsApi.defaults();
      var notes = [];
      var problems = [];
      return guard(function () { return chromeApi.scripting.getRegisteredContentScripts(); })
        .then(function (got) {
          if (!got.ok) {
            problems.push('the registered list could not be read (' + got.error + ')');
            return null;
          }
          var list = Array.isArray(got.value) ? got.value : [];
          var ids = [];
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id) ids.push(String(list[i].id));
          }
          if (!ids.length) {
            notes.push('nothing was registered dynamically');
            return null;
          }
          return guard(function () {
            return chromeApi.scripting.unregisterContentScripts({ ids: ids });
          }).then(function (un) {
            if (un.ok) {
              notes.push('unregistered ' + ids.length + ': ' + ids.join(', '));
              return null;
            }
            // The worker reacts to the storage writes above by re-registering,
            // so an id can be gone by the time it is asked for ("Nonexistent
            // script ID"). What matters is what is still there; the early
            // dark background itself is put right by the next part either way.
            return guard(function () { return chromeApi.scripting.getRegisteredContentScripts(); })
              .then(function (again) {
                var left = [];
                if (again.ok) {
                  var now = Array.isArray(again.value) ? again.value : [];
                  for (var j = 0; j < now.length; j++) {
                    var id = now[j] && now[j].id ? String(now[j].id) : '';
                    if (id && ids.indexOf(id) > -1 && id !== preloadReg.PRELOAD_ID) left.push(id);
                  }
                }
                if (again.ok && !left.length) {
                  notes.push('unregistered ' + ids.join(', ') + ' (some were already gone: ' +
                    un.error + ')');
                } else {
                  problems.push('could not unregister ' + (left.length ? left : ids).join(', ') +
                    ' (' + un.error + ')');
                }
                return null;
              });
          });
        })
        .then(function () {
          return guard(function () {
            return preloadReg.registerPreload(chromeApi, defaults, { settings: settingsApi });
          });
        })
        .then(function (re) {
          if (!re.ok) {
            problems.push('the early dark background could not be registered again (' +
              re.error + ')');
            return null;
          }
          return confirmPreload(defaults, 0).then(function (seen) {
            if (!seen.ok) {
              problems.push('the early dark background is not back as the restored defaults ' +
                'ask (' + seen.why + ')');
            } else if (seen.found) {
              notes.push('registered ' + seen.found.id + ' again with ' +
                (seen.found.css || []).join(', ') + ' for the restored defaults, and Chrome ' +
                'reads it back as exactly that');
            } else {
              notes.push('the restored defaults ask for no early dark background, and Chrome ' +
                'reads back none');
            }
          });
        })
        .then(function () {
          return {
            ok: !problems.length,
            detail: notes.concat(problems).join('; '),
            error: problems.length ? problems.join('; ') : null
          };
        });
    }

    /**
     * Chrome's own answer decides the step, not the call that was made. The
     * worker registers the same id on every storage change - the two writes
     * above included - so its unregister can land after ours. A registration
     * that does not read back as the spec for the restored defaults is redone,
     * twice at most, before it is reported as not done.
     */
    function confirmPreload(defaults, tries) {
      var desired = preloadReg.preloadSpec(defaults, { settings: settingsApi });
      return guard(function () {
        return chromeApi.scripting.getRegisteredContentScripts({ ids: [preloadReg.PRELOAD_ID] });
      }).then(function (got) {
        if (!got.ok) {
          return { ok: false, why: 'the registration could not be read back: ' + got.error };
        }
        var found = preloadReg.findPreload(got.value);
        if (preloadReg.matchesSpec(found, desired)) return { ok: true, found: found };
        if (tries >= 2) {
          return {
            ok: false,
            why: 'Chrome holds ' + preloadReg.describe(found) + ' instead of ' +
              preloadReg.describe(desired)
          };
        }
        return new Promise(function (resolve) { setTimeout(resolve, 100); })
          .then(function () {
            return guard(function () {
              return preloadReg.registerPreload(chromeApi, defaults, { settings: settingsApi });
            });
          })
          .then(function () { return confirmPreload(defaults, tries + 1); });
      });
    }

    // ------------------------------------------------------------- 4. alarms

    function resetAlarms() {
      if (!has('alarms.getAll')) {
        return { ok: false, detail: 'chrome.alarms is not available here', error: 'no chrome.alarms' };
      }
      var defaults = settingsApi.defaults();
      var notes = [];
      var problems = [];
      return guard(function () { return chromeApi.alarms.getAll(); })
        .then(function (got) {
          if (!got.ok) {
            problems.push('the alarm list could not be read (' + got.error + ')');
            return null;
          }
          var list = Array.isArray(got.value) ? got.value : [];
          if (!list.length) {
            notes.push('no alarm was set');
            return null;
          }
          return list.reduce(function (chain, alarm) {
            return chain.then(function () {
              var name = alarm && alarm.name ? String(alarm.name) : '';
              return guard(function () { return chromeApi.alarms.clear(name); }).then(function (r) {
                if (r.ok) notes.push('cleared the ' + (name || 'unnamed') + ' alarm');
                else problems.push('could not clear the ' + name + ' alarm (' + r.error + ')');
                return null;
              });
            });
          }, Promise.resolve());
        })
        .then(function () {
          if (!preloadReg) {
            problems.push('shared/preload-reg.js is not loaded, so the schedule alarm could ' +
              'not be put back');
            return { ok: false };
          }
          return guard(function () {
            return preloadReg.scheduleAlarms(chromeApi, defaults, { settings: settingsApi });
          });
        })
        .then(function (re) {
          if (re && re.ok === false && re.error) {
            problems.push('the schedule could not be set up again (' + re.error + ')');
          } else if (re && re.value) {
            notes.push('the schedule alarm was set for ' + new Date(re.value).toISOString());
          } else if (re && re.ok) {
            notes.push('the restored schedule is Always, which needs no alarm, so none was created');
          }
          return {
            ok: !problems.length,
            detail: notes.concat(problems).join('; '),
            error: problems.length ? problems.join('; ') : null
          };
        });
    }

    // --------------------------------------------------------------- 5. tabs

    /** Ask the page script to take itself down. False means it did not answer. */
    function tellTab(tabId) {
      return new Promise(function (resolve) {
        if (!has('tabs.sendMessage')) { resolve(false); return; }
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          resolve(false);
        }, T);
        try {
          chromeApi.tabs.sendMessage(tabId, { type: 'dr-teardown' }, TOP_FRAME, function (reply) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { void chromeApi.runtime.lastError; } catch (e) { }
            resolve(!!(reply && reply.ok));
          });
        } catch (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    }

    function oneTab(tab, counts) {
      var cleaned = false;
      var how = '';
      return tellTab(tab.id).then(function (answered) {
        if (answered) { how = 'its own page script'; return true; }
        if (!has('scripting.executeScript')) return false;
        return guard(function () {
          return chromeApi.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: sweepPage,
            injectImmediately: true
          });
        }).then(function (r) {
          how = r.ok ? 'the sweeper' : 'nothing (' + r.error + ')';
          return r.ok;
        });
      }).then(function (wasCleaned) {
        cleaned = wasCleaned;
        if (cleaned) counts.tabsCleaned++;
        if (!has('scripting.executeScript')) {
          return { ok: false, error: 'no chrome.scripting' };
        }
        return guard(function () {
          return chromeApi.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: contentFiles,
            injectImmediately: true
          });
        });
      }).then(function (re) {
        if (re.ok) counts.tabsReinjected++;
        // The two halves are counted apart, because only one of them decides
        // the icon: a tab that was re-injected is live on the restored
        // defaults whether or not the old styles had to be swept first.
        if (!re.ok) {
          counts.failedTabs.push({
            id: tab.id,
            url: tab.url,
            why: 'could not be re-injected (' + re.error + ')'
          });
        }
        if (!cleaned) {
          counts.dirtyTabs.push({
            id: tab.id,
            url: tab.url,
            why: 'could not be cleaned by ' + how
          });
        }
        if (!cleaned || !re.ok) counts.tabsFailed++;
        return { cleaned: cleaned, reinjected: re.ok };
      });
    }

    function sweepTabs(counts) {
      if (!has('tabs.query')) {
        return { ok: false, detail: 'chrome.tabs is not available here', error: 'no chrome.tabs' };
      }
      return guard(function () { return chromeApi.tabs.query({}); }).then(function (got) {
        if (!got.ok) {
          return {
            ok: false,
            detail: 'the open tabs could not be listed, so none was cleaned',
            error: got.error
          };
        }
        var tabs = Array.isArray(got.value) ? got.value : [];
        var eligible = [];
        var skipped = 0;
        for (var i = 0; i < tabs.length; i++) {
          var tab = tabs[i];
          if (!tab || tab.id == null || !tab.url) { skipped++; continue; }
          if (restrictedApi && restrictedApi.isRestricted(tab.url)) { skipped++; continue; }
          eligible.push(tab);
        }
        counts.tabsSeen = tabs.length;
        counts.tabsSkipped = skipped;
        if (!eligible.length) {
          return {
            ok: true,
            detail: 'no open tab could be touched: ' + tabs.length + ' tab(s), ' + skipped +
              ' of them a page Chrome does not allow extensions on'
          };
        }
        return Promise.all(eligible.map(function (tab) { return oneTab(tab, counts); }))
          .then(function () {
            var bits = [
              counts.tabsCleaned + ' of ' + eligible.length + ' tab(s) cleaned',
              counts.tabsReinjected + ' re-injected on the restored defaults, with no reload'
            ];
            if (skipped) bits.push(skipped + ' skipped as restricted or without a url');
            if (counts.tabsFailed) {
              bits.push(counts.tabsFailed + ' not fully put back: ' +
                counts.dirtyTabs.concat(counts.failedTabs).map(function (t) {
                  return (t.url || 'tab ' + t.id) + ' ' + t.why;
                }).slice(0, 4).join('; '));
            }
            return {
              ok: !counts.tabsFailed,
              detail: bits.join('; '),
              error: counts.tabsFailed ? counts.tabsFailed + ' tab(s) could not be put back' : null
            };
          });
      });
    }

    // ---------------------------------------------------------- 6. tab icons

    function resetIcons(counts) {
      if (!counts.failedTabs.length) {
        return {
          ok: true,
          detail: 'every tab that could be touched came back on the restored defaults, so no ' +
            'toolbar icon needed putting right' +
            (counts.dirtyTabs.length
              ? ' (' + counts.dirtyTabs.length + ' tab(s) kept their old styles until the fresh ' +
              'script took over, but they are running the restored defaults, so their icon is ' +
              'right)'
              : '')
        };
      }
      if (!has('action.setIcon')) {
        return {
          ok: false,
          detail: counts.failedTabs.length + ' tab(s) need an off icon but chrome.action is not ' +
            'available here',
          error: 'no chrome.action'
        };
      }
      var problems = [];
      return counts.failedTabs.reduce(function (chain, tab) {
        return chain.then(function () {
          return guard(function () {
            return chromeApi.action.setIcon({ tabId: tab.id, path: OFF_ICONS });
          }).then(function (r) {
            if (!r.ok) problems.push('tab ' + tab.id + ' icon (' + r.error + ')');
            if (!has('action.setTitle')) return null;
            return guard(function () {
              return chromeApi.action.setTitle({ tabId: tab.id, title: OFF_TITLE });
            }).then(function (t) {
              if (!t.ok) problems.push('tab ' + tab.id + ' title (' + t.error + ')');
              return null;
            });
          });
        });
      }, Promise.resolve()).then(function () {
        return {
          ok: !problems.length,
          detail: counts.failedTabs.length + ' tab(s) could not be re-injected, so they were set ' +
            'to the off icon and title. No Darkrai script is running in them: they were cleaned ' +
            'and left showing the page as the site styles it, and reloading them is what brings ' +
            'the restored defaults back' +
            (problems.length ? '; could not set ' + problems.join(', ') : ''),
          error: problems.length ? problems.join(', ') : null
        };
      });
    }

    // ------------------------------------------------------------- the whole

    /**
     * Seven steps, in order, independent. Resolves to
     * { ok, steps: [{ name, ok, detail, error }], tabsCleaned, tabsReinjected,
     *   tabsFailed } - ok only when every step succeeded.
     */
    function hardReset() {
      var counts = {
        tabsCleaned: 0, tabsReinjected: 0, tabsFailed: 0,
        tabsSeen: 0, tabsSkipped: 0,
        // failedTabs: could not be re-injected, so they need the off icon.
        // dirtyTabs: could not be cleaned, but a fresh script did take over.
        failedTabs: [], dirtyTabs: []
      };
      var steps = [];
      var jobs = [
        ['Saved settings erased', clearStorage],
        ['Factory defaults written back', writeDefaults],
        ['Early dark background re-registered', resetContentScripts],
        ['Schedule timers cleared', resetAlarms],
        ['Open tabs cleaned and put back', function () { return sweepTabs(counts); }],
        ['Toolbar icons put right', function () { return resetIcons(counts); }]
      ];
      return jobs.reduce(function (chain, job) {
        return chain.then(function () {
          return step(job[0], job[1]).then(function (one) { steps.push(one); });
        });
      }, Promise.resolve()).then(function () {
        var ok = steps.every(function (one) { return one.ok; });
        steps.push({
          name: 'Result',
          // The verdict over the six real steps, not a seventh step. Anything
          // counting failures must skip this row or it double-counts: a reset
          // with two failed steps would otherwise be reported as three.
          verdict: true,
          ok: ok,
          detail: ok
            ? 'every step finished: Darkrai is exactly as it was when it was installed'
            : steps.filter(function (one) { return !one.ok; }).length +
            ' of ' + steps.length + ' steps could not be finished - the ones marked below are ' +
            'the only work still outstanding',
          error: null
        });
        return {
          ok: ok,
          steps: steps,
          tabsCleaned: counts.tabsCleaned,
          tabsReinjected: counts.tabsReinjected,
          tabsFailed: counts.tabsFailed
        };
      });
    }

    /**
     * Forget one site: its Auto/Always/Never setting, its Smart/Simple mode
     * and every fix saved for it, so it follows the global default again.
     * Every other site is left exactly as it was.
     */
    function resetSite(store, host) {
      var clean = String(host || '').toLowerCase().replace(/^www\./, '').trim();
      if (!clean) {
        return Promise.resolve({ ok: false, host: '', removed: false, error: 'no site given' });
      }
      var sites = (store && store.sites) || {};
      var hit = settingsApi.matchSite(sites, clean);
      var key = sites[clean] ? clean : (hit ? hit.key : clean);
      var removed = !!sites[key];
      var next = settingsApi.removeSite(store, key);
      if (!removed) {
        return Promise.resolve({ ok: true, host: key, removed: false, store: next });
      }
      if (!has('storage.local')) {
        return Promise.resolve({
          ok: false, host: key, removed: false, store: next,
          error: 'chrome.storage is not available here'
        });
      }
      return guard(function () {
        return chromeApi.storage.local.set({
          schema: next.schema,
          debug: next.debug === true,
          settings: next.settings,
          sites: next.sites
        });
      }).then(function (r) {
        return {
          ok: r.ok,
          host: key,
          removed: r.ok,
          store: next,
          error: r.ok ? null : r.error
        };
      });
    }

    return {
      hardReset: hardReset,
      resetSite: resetSite,
      sweepPage: sweepPage,
      timeoutMs: T
    };
  }

  return {
    create: create,
    CONTENT_FILES: CONTENT_FILES,
    sweepPage: sweepPage,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS
  };
});
