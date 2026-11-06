/*
 * Darkrai - options/options.js
 *
 * The full settings page: the look, the schedule, your site list (search,
 * change, delete) and a reset (PLAN section 7).
 *
 * Same rules as the popup: the markup is already drawn when this runs, every
 * chrome.* call has a timeout and a fallback, and changes go to
 * chrome.storage.local, which every open tab is listening to.
 */
(function () {
  'use strict';

  var settingsApi = Darkrai.settings;

  var T_STORAGE = 700;
  var SAVE_DEBOUNCE_MS = 180;
  // The reset talks to chrome.* directly, with a timeout on every call, so it
  // still works when the service worker is asleep or wedged. Open tabs are
  // cleaned one by one, so it gets a longer leash than a storage read.
  var T_RESET = 2500;

  var LOOK_NAMES = { gray: 'Dark gray', black: 'True black', soft: 'Soft' };
  var MODE_NAMES = { auto: 'Auto', on: 'Always dark', off: 'Never' };
  var ENGINE_NAMES = { smart: 'Smart', filter: 'Simple' };

  var el = {
    enabled: document.getElementById('enabled'),
    saved: document.getElementById('saved'),
    look: document.getElementById('look'),
    brightness: document.getElementById('brightness'),
    brightnessValue: document.getElementById('brightness-value'),
    contrast: document.getElementById('contrast'),
    contrastValue: document.getElementById('contrast-value'),
    warmth: document.getElementById('warmth'),
    warmthValue: document.getElementById('warmth-value'),
    defaultMode: document.getElementById('default-mode'),
    dimImages: document.getElementById('dim-images'),
    schedule: document.getElementById('schedule'),
    scheduleHelp: document.getElementById('schedule-help'),
    hours: document.getElementById('hours'),
    from: document.getElementById('from'),
    to: document.getElementById('to'),
    search: document.getElementById('search'),
    count: document.getElementById('count'),
    rows: document.getElementById('rows'),
    empty: document.getElementById('empty'),
    main: document.querySelector('main'),
    danger: document.getElementById('danger'),
    resetHost: document.getElementById('reset-host'),
    resetSite: document.getElementById('reset-site'),
    resetSiteStatus: document.getElementById('reset-site-status'),
    reset: document.getElementById('reset'),
    resetStatus: document.getElementById('reset-status'),
    modal: document.getElementById('reset-modal'),
    dialog: document.getElementById('reset-dialog'),
    dialogTitle: document.getElementById('reset-dialog-title'),
    dialogLead: document.getElementById('reset-dialog-lead'),
    dialogStatus: document.getElementById('reset-dialog-status'),
    dialogResult: document.getElementById('reset-dialog-result'),
    dialogCancel: document.getElementById('reset-cancel'),
    dialogGo: document.getElementById('reset-go')
  };

  var store = settingsApi.defaults();
  var query = '';
  var dragging = false;
  var saveTimer = null;
  var savedTimer = null;

  function hasChrome() {
    try { return typeof chrome === 'object' && !!chrome && !!chrome.runtime && !!chrome.runtime.id; }
    catch (e) { return false; }
  }

  // The resets run from this page, not from the worker: the worker is one of
  // the things that might be broken when somebody reaches for a hard reset.
  var resetApi = Darkrai.reset.create({
    chrome: hasChrome() ? chrome : null,
    settings: settingsApi,
    restricted: Darkrai.restricted,
    preloadReg: Darkrai.preloadReg,
    timeoutMs: T_RESET
  });

  function call(fn, ms, fallback) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true; resolve(fallback);
      }, ms);
      try {
        fn(function (value) {
          if (done) return; done = true; clearTimeout(timer); resolve(value);
        });
      } catch (e) {
        if (done) return; done = true; clearTimeout(timer); resolve(fallback);
      }
    });
  }

  function getStore() {
    if (!hasChrome() || !chrome.storage) return Promise.resolve(settingsApi.defaults());
    return call(function (done) {
      chrome.storage.local.get(null, function (raw) {
        void chrome.runtime.lastError;
        done(settingsApi.upgrade(raw));
      });
    }, T_STORAGE, settingsApi.defaults());
  }

  function say(message) {
    el.saved.textContent = message;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(function () {
      el.saved.textContent = 'Changes save as you make them.';
    }, 2500);
  }

  function saveStore(next, message) {
    store = next;
    render();
    if (!hasChrome() || !chrome.storage) { say('Nothing to save to here.'); return Promise.resolve(false); }
    return call(function (done) {
      chrome.storage.local.set(
        {
          schema: next.schema, debug: next.debug === true,
          settings: next.settings, sites: next.sites
        },
        function () { void chrome.runtime.lastError; done(true); }
      );
    }, T_STORAGE, false).then(function (ok) {
      say(ok ? (message || 'Saved.') : 'Could not save. Try again.');
      return ok;
    });
  }

  /** Dragging a slider repaints every open tab, so saves are coalesced. */
  function saveSoon(apply, message) {
    var next = settingsApi.upgrade(store);
    apply(next.settings);
    store = next;
    render();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      dragging = false;
      saveStore(next, message);
    }, SAVE_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------- the site list

  function sortedHosts() {
    var sites = store.sites || {};
    return Object.keys(sites).sort();
  }

  function fixesOf(entry) { return (entry && entry.fixes) || []; }

  function makeSelect(options, value, label, onChange) {
    var select = document.createElement('select');
    Object.keys(options).forEach(function (key) {
      var option = document.createElement('option');
      option.value = key;
      option.textContent = options[key];
      select.appendChild(option);
    });
    select.value = value;
    select.setAttribute('aria-label', label);
    select.addEventListener('change', function () { onChange(select.value); });
    return select;
  }

  function renderRows() {
    var hosts = sortedHosts();
    var shown = hosts.filter(function (host) {
      return !query || host.indexOf(query) > -1;
    });

    el.count.textContent = hosts.length === 1 ? '1 site' : hosts.length + ' sites';
    el.empty.hidden = hosts.length > 0;
    if (hosts.length && !shown.length) {
      el.empty.hidden = false;
      el.empty.textContent = 'No site matches "' + query + '".';
    } else if (!hosts.length) {
      el.empty.textContent = 'No sites of your own yet. Use the popup on any page to add one.';
    }

    el.rows.textContent = '';
    shown.forEach(function (host, index) {
      var entry = store.sites[host] || { mode: 'auto' };
      var tr = document.createElement('tr');
      // Presentation only: the rows arrive one short step apart, on transform
      // and opacity. shared/handheld.css owns the keyframes and the fallbacks.
      tr.className = 'dr-rise';
      tr.style.animationDelay = Math.min(index * 24, 240) + 'ms';

      var site = document.createElement('td');
      site.className = 'site';
      site.textContent = host;
      tr.appendChild(site);

      var mode = document.createElement('td');
      mode.appendChild(makeSelect(MODE_NAMES, entry.mode || 'auto',
        'Setting for ' + host, function (value) {
          saveStore(settingsApi.setSiteMode(store, host, value), host + ' set to ' + MODE_NAMES[value] + '.');
        }));
      tr.appendChild(mode);

      var engine = document.createElement('td');
      engine.appendChild(makeSelect(ENGINE_NAMES, entry.engine === 'filter' ? 'filter' : 'smart',
        'Mode for ' + host, function (value) {
          saveStore(settingsApi.setSiteEngine(store, host, value), host + ' uses ' + ENGINE_NAMES[value] + ' mode.');
        }));
      tr.appendChild(engine);

      var fixes = document.createElement('td');
      var list = fixesOf(entry);
      if (list.length) {
        var clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = list.length === 1 ? 'Clear 1 fix' : 'Clear ' + list.length + ' fixes';
        clear.setAttribute('aria-label', 'Clear the ' + list.length + ' saved fixes for ' + host);
        clear.title = list.map(function (f) { return f.action + ': ' + f.selector; }).join('\n');
        clear.addEventListener('click', function () {
          saveStore(settingsApi.clearSiteFixes(store, host), 'Fixes cleared for ' + host + '.');
        });
        fixes.appendChild(clear);
      } else {
        fixes.textContent = '\u2014';
      }
      tr.appendChild(fixes);

      var remove = document.createElement('td');
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Remove';
      button.setAttribute('aria-label', 'Remove ' + host + ' from the list');
      button.addEventListener('click', function () {
        saveStore(settingsApi.removeSite(store, host), host + ' removed.');
      });
      remove.appendChild(button);
      tr.appendChild(remove);

      el.rows.appendChild(tr);
    });
  }

  /** The danger area's "Reset this site" picker: only sites you really have. */
  function renderResetHosts() {
    var hosts = sortedHosts();
    var keep = el.resetHost.value;
    el.resetHost.textContent = '';
    if (!hosts.length) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = 'No sites of your own yet';
      el.resetHost.appendChild(none);
      el.resetHost.disabled = true;
      el.resetSite.disabled = true;
      return;
    }
    hosts.forEach(function (host) {
      var option = document.createElement('option');
      option.value = host;
      option.textContent = host;
      el.resetHost.appendChild(option);
    });
    el.resetHost.disabled = false;
    el.resetSite.disabled = false;
    if (hosts.indexOf(keep) > -1) el.resetHost.value = keep;
  }

  // ------------------------------------------------------------------- render

  function scheduleText(schedule) {
    if (schedule.type === 'system') return 'Dark while Chrome or your system is in dark mode.';
    if (schedule.type === 'hours') return 'Dark from ' + schedule.from + ' to ' + schedule.to + ' every day.';
    return 'Always on, every hour of the day.';
  }

  function render() {
    var cfg = store.settings;
    el.enabled.checked = !!cfg.enabled;
    // Presentation only: the header band's LED and LCD follow the master switch.
    var band = document.getElementById('band');
    if (band) band.setAttribute('data-state', cfg.enabled ? 'on' : 'off');
    el.look.value = cfg.look;
    el.defaultMode.value = cfg.defaultMode;
    el.dimImages.checked = !!cfg.dimImages;

    if (!dragging) {
      el.brightness.value = String(cfg.brightness);
      el.contrast.value = String(cfg.contrast);
      el.warmth.value = String(cfg.warmth);
    }
    el.brightnessValue.textContent = el.brightness.value;
    el.contrastValue.textContent = el.contrast.value;
    el.warmthValue.textContent = el.warmth.value;

    el.schedule.value = cfg.schedule.type;
    el.hours.hidden = cfg.schedule.type !== 'hours';
    el.from.value = cfg.schedule.from;
    el.to.value = cfg.schedule.to;
    el.scheduleHelp.textContent = scheduleText(cfg.schedule);

    renderRows();
    renderResetHosts();
  }

  // ------------------------------------------------------------------- events

  el.enabled.addEventListener('change', function () {
    var next = settingsApi.upgrade(store);
    next.settings.enabled = el.enabled.checked;
    saveStore(next, next.settings.enabled ? 'Darkrai is on.' : 'Darkrai is off everywhere.');
  });

  el.look.addEventListener('change', function () {
    var next = settingsApi.upgrade(store);
    next.settings.look = el.look.value;
    saveStore(next, 'Look: ' + LOOK_NAMES[next.settings.look] + '.');
  });

  el.defaultMode.addEventListener('change', function () {
    var next = settingsApi.upgrade(store);
    next.settings.defaultMode = el.defaultMode.value;
    saveStore(next, 'New sites start as ' + MODE_NAMES[next.settings.defaultMode] + '.');
  });

  el.dimImages.addEventListener('change', function () {
    var next = settingsApi.upgrade(store);
    next.settings.dimImages = el.dimImages.checked;
    saveStore(next, next.settings.dimImages ? 'Images are dimmed.' : 'Images are left alone.');
  });

  function wireSlider(input, key, label) {
    input.addEventListener('input', function () {
      dragging = true;
      var value = Number(input.value);
      saveSoon(function (settings) { settings[key] = value; }, label + ' ' + value + '.');
    });
    input.addEventListener('change', function () { dragging = false; });
  }

  wireSlider(el.brightness, 'brightness', 'Brightness');
  wireSlider(el.contrast, 'contrast', 'Contrast');
  wireSlider(el.warmth, 'warmth', 'Warmth');

  el.schedule.addEventListener('change', function () {
    var next = settingsApi.upgrade(store);
    next.settings.schedule.type = el.schedule.value;
    saveStore(next, scheduleText(next.settings.schedule));
  });

  function wireTime(input, key) {
    input.addEventListener('change', function () {
      if (!input.value) return;
      var next = settingsApi.upgrade(store);
      next.settings.schedule[key] = input.value;
      saveStore(next, scheduleText(next.settings.schedule));
    });
  }

  wireTime(el.from, 'from');
  wireTime(el.to, 'to');

  el.search.addEventListener('input', function () {
    query = el.search.value.trim().toLowerCase();
    renderRows();
  });

  // ------------------------------------------------- the danger area (FEAT-005)

  // Hosts Darkrai ships with an entry for. settings.upgrade() puts these back
  // whenever they are missing, so "forgotten" is only true until the next
  // store read - and the copy below has to say so rather than promise more.
  var PRESET_HOSTS = Object.keys((settingsApi.defaults().sites) || {});

  /** Forget one site. Small, common, and nothing like the button below it. */
  el.resetSite.addEventListener('click', function () {
    var host = el.resetHost.value;
    if (!host) {
      el.resetSiteStatus.textContent = 'Pick a site first.';
      return;
    }
    el.resetSite.disabled = true;
    el.resetSiteStatus.textContent = 'Forgetting ' + host + '\u2026';
    resetApi.resetSite(store, host).then(function (out) {
      el.resetSite.disabled = false;
      if (out && out.store) { store = out.store; render(); }
      var key = (out && out.host) || host;
      if (out && out.ok) {
        if (out.removed && PRESET_HOSTS.indexOf(key) > -1) {
          el.resetSiteStatus.textContent = key + ': its mode and its saved fixes are gone, and ' +
            'no other site was touched. ' + key + ' is one of the sites Darkrai ships a setting ' +
            'for, so the Simple-mode entry comes back by itself the next time the settings are ' +
            'read. Set it to Never in the list above if you want Darkrai to leave it alone.';
        } else if (out.removed) {
          el.resetSiteStatus.textContent = key + ' is forgotten: its setting, its mode and its ' +
            'saved fixes are gone, and it follows the global default again. No other site was ' +
            'touched.';
        } else {
          el.resetSiteStatus.textContent = key + ' had nothing saved, so nothing changed.';
        }
      } else {
        el.resetSiteStatus.textContent = 'Could not forget ' + host + ': ' +
          ((out && out.error) || 'no answer') + '.';
      }
    });
  });

  /*
   * The two-step confirmation. An in-page dialog, never window.confirm: a
   * native dialog cannot name what is about to be erased, cannot be reached by
   * a screen reader in the same breath as the list, and cannot be styled to
   * look like the thing it belongs to.
   */
  var confirmDialog = (function () {
    var open = false;
    var stage = 1;
    var busy = false;
    var trigger = null;

    function stops() {
      var all = el.dialog.querySelectorAll('button,select,input,textarea,a[href],[tabindex]');
      var out = [];
      for (var i = 0; i < all.length; i++) {
        if (all[i].disabled) continue;
        if (all[i].getAttribute('tabindex') === '-1') continue;
        // A hidden or unrendered control cannot take focus, so counting it as
        // a tab stop would make focus() a no-op and let Tab walk out of the
        // dialog. The Continue button is hidden once the reset has run.
        if (all[i].hidden) continue;
        if (!all[i].getClientRects().length) continue;
        out.push(all[i]);
      }
      return out;
    }

    /** Somewhere inside the dialog to park focus when no control can hold it. */
    function parkFocus() {
      try { el.dialog.focus(); } catch (e) { }
    }

    function paint() {
      var hosts = Object.keys(store.sites || {}).length;
      var fixes = 0;
      Object.keys(store.sites || {}).forEach(function (host) {
        fixes += ((store.sites[host] || {}).fixes || []).length;
      });
      if (stage === 1) {
        el.dialogTitle.textContent = 'Hard reset everything?';
        el.dialogLead.textContent = 'This erases every setting, your site list (' + hosts +
          ' site' + (hosts === 1 ? '' : 's') + '), every saved picker fix (' + fixes + '), the ' +
          'schedule and all per-tab state. Open tabs are cleaned and put back on the defaults.';
        el.dialogGo.textContent = 'Continue';
      } else {
        el.dialogTitle.textContent = 'Last check: erase everything?';
        el.dialogLead.textContent = 'There is nothing after this. Your settings, your ' + hosts +
          ' site' + (hosts === 1 ? '' : 's') + ' and your ' + fixes + ' saved fix' +
          (fixes === 1 ? '' : 'es') + ' are gone for good.';
        el.dialogGo.textContent = 'Yes, erase everything';
      }
    }

    function show(from) {
      if (open) return;
      open = true;
      stage = 1;
      busy = false;
      trigger = from || document.activeElement;
      el.dialogResult.hidden = true;
      el.dialogResult.textContent = '';
      el.dialogStatus.textContent = '';
      el.dialogCancel.textContent = 'Cancel';
      el.dialogCancel.disabled = false;
      el.dialogGo.disabled = false;
      el.dialogGo.hidden = false;
      paint();
      el.modal.hidden = false;
      // Nothing behind the dialog can be reached while it is open, by Tab or
      // by a click. The keydown trap below is the belt to this braces.
      try { el.main.inert = true; } catch (e) { }
      document.addEventListener('keydown', onKey, true);
      // Cancel is the default: the safe answer is the one already under the
      // reader's hands.
      el.dialogCancel.focus();
    }

    function hide() {
      if (!open) return;
      open = false;
      busy = false;
      document.removeEventListener('keydown', onKey, true);
      el.modal.hidden = true;
      try { el.main.inert = false; } catch (e) { }
      var back = trigger;
      trigger = null;
      if (back && back.focus) { try { back.focus(); } catch (e) { } }
    }

    function onKey(event) {
      if (!open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (busy) {
          el.dialogStatus.textContent = 'The reset is already running; it cannot be stopped ' +
            'half way.';
          return;
        }
        el.resetStatus.textContent = 'Cancelled. Nothing was erased.';
        hide();
        return;
      }
      if (event.key !== 'Tab') return;
      var list = stops();
      var active = document.activeElement;
      // While the reset runs both buttons are disabled, so there is no stop to
      // move to. Tab must still do nothing rather than hand focus to the
      // browser chrome: the page behind is inert and there is no way back in.
      if (!list.length) {
        event.preventDefault();
        if (!el.dialog.contains(active)) parkFocus();
        return;
      }
      var first = list[0];
      var last = list[list.length - 1];
      if (!el.dialog.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    /** The itemised result, exactly as hardReset() reported it. */
    function report(result) {
      var steps = (result && result.steps) || [];
      var bad = 0;
      el.dialogResult.textContent = '';
      steps.forEach(function (one) {
        // one.verdict is the summary row, not a step of its own. Counting it
        // would say "3 steps could not be finished" directly above a row
        // reading "2 of 6".
        if (!one.ok && !one.verdict) bad++;
        var li = document.createElement('li');
        li.className = one.ok ? 'good' : 'bad';
        li.textContent = (one.ok ? 'Done: ' : 'Not done: ') + one.name +
          (one.detail ? ' \u2014 ' + one.detail : '') +
          (!one.ok && one.error ? ' \u2014 ' + one.error : '');
        el.dialogResult.appendChild(li);
      });
      el.dialogResult.hidden = !steps.length;
      var tabs = 'Open tabs: ' + result.tabsCleaned + ' cleaned, ' + result.tabsReinjected +
        ' back on the defaults, ' + result.tabsFailed + ' could not be put back';
      el.dialogStatus.textContent = (result.ok
        ? 'Done. Darkrai is exactly as it was when it was installed. '
        : 'Partly done: ' + bad + ' step' + (bad === 1 ? '' : 's') + ' could not be finished, ' +
        'listed below. ') + tabs + '.';
      el.resetStatus.textContent = result.ok
        ? 'Hard reset finished. Everything is back to its defaults.'
        : 'Hard reset finished only partly: ' + bad + ' step' + (bad === 1 ? '' : 's') +
        ' could not be done. Open the dialog again to retry.';
    }

    function run() {
      busy = true;
      el.dialogGo.disabled = true;
      el.dialogCancel.disabled = true;
      // Disabling the button that was focused would drop focus onto <body>,
      // outside an inert page with nothing tabbable left. Park it on the
      // dialog instead, so the trap still has something to hold.
      parkFocus();
      el.dialogStatus.textContent = 'Erasing\u2026 open tabs are being cleaned and put back.';
      resetApi.hardReset().then(function (result) {
        busy = false;
        el.dialogGo.hidden = true;
        el.dialogCancel.disabled = false;
        el.dialogCancel.textContent = 'Close';
        query = '';
        el.search.value = '';
        store = settingsApi.defaults();
        render();
        report(result);
        el.dialogCancel.focus();
      }, function (err) {
        busy = false;
        el.dialogGo.disabled = false;
        el.dialogCancel.disabled = false;
        el.dialogStatus.textContent = 'The reset could not even start: ' +
          String((err && err.message) || err) + '. Nothing was erased.';
      });
    }

    el.dialogCancel.addEventListener('click', function () {
      if (busy) return;
      if (!el.dialogGo.hidden) el.resetStatus.textContent = 'Cancelled. Nothing was erased.';
      hide();
    });

    el.dialogGo.addEventListener('click', function () {
      if (busy) return;
      if (stage === 1) {
        stage = 2;
        paint();
        el.dialogCancel.focus();     // Cancel stays the default on step two
        return;
      }
      run();
    });

    // A click on the scrim is a cancel, like Esc.
    el.modal.addEventListener('mousedown', function (event) {
      if (event.target !== el.modal || busy) return;
      el.resetStatus.textContent = 'Cancelled. Nothing was erased.';
      hide();
    });

    return { show: show };
  })();

  el.reset.addEventListener('click', function () {
    confirmDialog.show(el.reset);
  });

  /** The popup's "Hard reset..." lands here: #danger. */
  function goToDanger() {
    if (location.hash !== '#danger' || !el.danger) return;
    try { el.danger.scrollIntoView({ block: 'start' }); } catch (e) { }
    try { el.danger.focus({ preventScroll: true }); } catch (e) {
      try { el.danger.focus(); } catch (e2) { }
    }
  }

  window.addEventListener('hashchange', goToDanger);

  // Another window (or the popup) may change the same settings while this page
  // is open: follow along rather than fight it.
  if (hasChrome() && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || saveTimer) return;
        getStore().then(function (next) { store = next; render(); });
      });
    } catch (e) { }
  }

  // --------------------------------------------------- presentation plumbing

  /*
   * Look only. Nothing below reads or writes a setting: it keeps will-change
   * alive just while something is animating, and stops the backdrop drifting
   * while this tab is in the background.
   *
   * The "should this move at all?" decision is shared/motion.js, so the popup
   * and this page cannot drift apart on it. The media query below is only the
   * fallback for a page opened without that module.
   */
  (function () {
    function still() {
      var helper = window.Darkrai && window.Darkrai.motion;
      if (helper && typeof helper.animate === 'function') {
        try { return !helper.animate(); } catch (e) { }
      }
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
      catch (e) { return false; }
    }

    function risers() { return document.querySelectorAll('.dr-rise, .dr-lift'); }

    /** will-change costs a compositing layer, so it is only on while needed. */
    function lift(event) {
      // The drifting backdrop lives in pseudo-elements and never ends; hinting
      // their host element would pin a layer open for the page's whole life.
      if (event.pseudoElement) return;
      var node = event.target;
      if (node && node.nodeType === 1 && node.style) node.style.willChange = 'transform, opacity';
    }

    function drop(event) {
      if (event.pseudoElement) return;
      var node = event.target;
      if (!node || node.nodeType !== 1) return;
      if (node.style) node.style.willChange = '';
      if (node.classList && (node.classList.contains('dr-rise') ||
        node.classList.contains('dr-lift'))) {
        node.classList.add('dr-settled');
      }
    }

    function settleAll() {
      var list = risers();
      for (var i = 0; i < list.length; i++) {
        list[i].classList.add('dr-settled');
        if (list[i].style) list[i].style.willChange = '';
      }
    }

    document.addEventListener('animationstart', lift);
    document.addEventListener('transitionrun', lift);
    document.addEventListener('animationend', drop);
    document.addEventListener('animationcancel', drop);
    document.addEventListener('transitionend', drop);
    document.addEventListener('transitioncancel', drop);
    // Belt and braces: an entrance whose end never arrives must not leave
    // will-change behind on a surface that is now sitting still.
    setTimeout(settleAll, 700);

    document.addEventListener('visibilitychange', function () {
      document.documentElement.classList.toggle('dr-still', document.hidden);
    });

    if (still()) settleAll();
  })();

  // --------------------------------------------------------------------- init

  render();
  goToDanger();
  getStore().then(function (next) { store = next; render(); });
})();
