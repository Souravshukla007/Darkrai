/*
 * Darkrai - popup/popup.js
 *
 * Rules this file lives by (PLAN section 2, problem 1):
 *   - the markup is already on screen before this runs, so the popup is never
 *     blank and never says "loading";
 *   - it reads settings straight from chrome.storage.local and never waits on
 *     the background worker, which Chrome is free to have asleep;
 *   - every single chrome.* call has a short timeout and a fallback;
 *   - choices are saved to storage, which is what open tabs listen to, and the
 *     tab is also nudged directly (and re-injected) in case its page script is
 *     missing after an extension update.
 */
(function () {
  'use strict';

  var settingsApi = Darkrai.settings;
  var restricted = Darkrai.restricted;

  var T_STORAGE = 500;
  var T_TABS = 700;
  var T_MESSAGE = 700;
  var T_INJECT = 2000;

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

  var LOOK_NAMES = { gray: 'Dark gray', black: 'True black', soft: 'Soft' };

  var el = {
    enabled: document.getElementById('enabled'),
    enabledText: document.getElementById('enabled-text'),
    host: document.getElementById('host'),
    dot: document.getElementById('dot'),
    statusText: document.getElementById('status-text'),
    notice: document.getElementById('notice'),
    siteFieldset: document.getElementById('site-fieldset'),
    siteHelp: document.getElementById('site-help'),
    engineFieldset: document.getElementById('engine-fieldset'),
    lookFieldset: document.getElementById('look-fieldset'),
    lookSummary: document.getElementById('look-summary'),
    look: document.getElementById('look'),
    brightness: document.getElementById('brightness'),
    brightnessValue: document.getElementById('brightness-value'),
    contrast: document.getElementById('contrast'),
    contrastValue: document.getElementById('contrast-value'),
    warmth: document.getElementById('warmth'),
    warmthValue: document.getElementById('warmth-value'),
    dimImages: document.getElementById('dim-images'),
    pick: document.getElementById('pick'),
    pickHelp: document.getElementById('pick-help'),
    schedule: document.getElementById('schedule'),
    hours: document.getElementById('hours'),
    from: document.getElementById('from'),
    to: document.getElementById('to'),
    reload: document.getElementById('reload'),
    options: document.getElementById('options'),
    resetSite: document.getElementById('reset-site'),
    resetSiteText: document.getElementById('reset-site-text'),
    hardReset: document.getElementById('hard-reset'),
    device: document.getElementById('device'),
    shortcut: document.getElementById('shortcut')
  };

  /** The button keeps its icon: only the text span is rewritten. */
  function setResetSiteText(text) {
    (el.resetSiteText || el.resetSite).textContent = text;
  }

  var store = settingsApi.defaults();
  var tab = null;
  var host = '';
  var blocked = null;          // message string when Chrome blocks this page
  var tabState = null;         // 'on' | 'native' | 'off' | null (no answer)
  var reached = false;
  var dragging = false;        // a slider is being dragged: don't fight the user
  var pickMessage = '';        // what the picker last told us
  var resetMessage = '';       // what the per-site reset last did
  var saveTimer = null;

  function hasChrome() {
    try { return typeof chrome === 'object' && !!chrome && !!chrome.runtime && !!chrome.runtime.id; }
    catch (e) { return false; }
  }

  var siteResetArmed = false;

  /** Never let a chrome.* call hang the popup. */
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

  function saveStore(next) {
    store = next;
    render();
    if (!hasChrome() || !chrome.storage) return Promise.resolve(false);
    return call(function (done) {
      chrome.storage.local.set(
        {
          schema: next.schema, debug: next.debug === true,
          settings: next.settings, sites: next.sites
        },
        function () { void chrome.runtime.lastError; done(true); }
      );
    }, T_STORAGE, false).then(function (ok) {
      nudgeTab();
      return ok;
    });
  }

  function getTab() {
    if (!hasChrome() || !chrome.tabs) return Promise.resolve(null);
    return call(function (done) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        void chrome.runtime.lastError;
        done(tabs && tabs[0] ? tabs[0] : null);
      });
    }, T_TABS, null);
  }

  /**
   * Always the top frame. The page script runs in every frame and each one
   * answers, so without frameId the reply could come from an advert iframe and
   * the popup would report that frame's state instead of the page's.
   */
  var TOP_FRAME = { frameId: 0 };

  function askTab() {
    if (!tab || tab.id == null || !hasChrome() || !chrome.tabs) return Promise.resolve(null);
    return call(function (done) {
      chrome.tabs.sendMessage(tab.id, { type: 'dr-status' }, TOP_FRAME, function (reply) {
        void chrome.runtime.lastError;
        done(reply && reply.ok ? reply : null);
      });
    }, T_MESSAGE, null);
  }

  function injectTab() {
    if (!tab || tab.id == null || !hasChrome() || !chrome.scripting) return Promise.resolve(false);
    return call(function (done) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: CONTENT_FILES,
        injectImmediately: true
      }, function () { void chrome.runtime.lastError; done(true); });
    }, T_INJECT, false);
  }

  // Frames do not need the nudge: they follow chrome.storage.onChanged like
  // the top frame does. The nudge exists to find out whether the top frame has
  // a page script at all, so it has to be answered by the top frame only.
  function nudgeTab() {
    if (!tab || tab.id == null || !hasChrome() || !chrome.tabs) return;
    chrome.tabs.sendMessage(tab.id, { type: 'dr-refresh' }, TOP_FRAME, function (reply) {
      void chrome.runtime.lastError;
      if (!reply) {
        // The tab has no page script (an update, or it loaded before install).
        injectTab().then(function () { setTimeout(refreshStatus, 150); });
      } else {
        tabState = reply.state || tabState;
        reached = true;
        render();
      }
    });
  }

  // ------------------------------------------------------------------ render

  function statusFor() {
    if (blocked) return { state: 'off', text: blocked };
    if (!store.settings.enabled) return { state: 'off', text: 'Darkrai is off everywhere.' };
    if (!settingsApi.scheduleActive(store.settings.schedule, Date.now(), prefersDark())) {
      return { state: 'off', text: 'Outside your schedule, so nothing is darkened right now.' };
    }
    if (tabState === 'on') return { state: 'on', text: 'Darkened by Darkrai' };
    if (tabState === 'native') return { state: 'native', text: "This site's own dark theme, left alone" };
    if (tabState === 'off') return { state: 'off', text: 'Off for this site' };
    if (!reached) {
      return {
        state: 'unknown',
        text: 'This tab has not answered yet. Your choice is saved; reload the tab if nothing changes.'
      };
    }
    var mode = settingsApi.resolveMode(store, host);
    if (mode === 'off') return { state: 'off', text: 'Off for this site' };
    return { state: 'unknown', text: 'Waiting for this tab.' };
  }

  function prefersDark() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
    catch (e) { return false; }
  }

  function setRadio(name, value) {
    var inputs = document.getElementsByName(name);
    for (var i = 0; i < inputs.length; i++) inputs[i].checked = (inputs[i].value === value);
  }

  function setFieldsetEnabled(fieldset, enabled) {
    var inputs = fieldset.querySelectorAll('input,select,button');
    for (var i = 0; i < inputs.length; i++) inputs[i].disabled = !enabled;
    fieldset.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }

  function render() {
    el.enabled.checked = !!store.settings.enabled;
    el.enabledText.textContent = store.settings.enabled ? 'On' : 'Off';
    el.enabled.setAttribute('aria-label', 'Darkrai is ' + (store.settings.enabled ? 'on' : 'off'));

    el.host.textContent = host || (tab && tab.url ? tab.url : 'this page');

    var s = statusFor();
    el.dot.setAttribute('data-state', s.state);
    // The device's LED, LCD backlight and screen art follow the same verdict.
    if (el.device) el.device.setAttribute('data-state', s.state);
    // The per-site reset reports on this line too, and what it just did
    // outranks a state the reader can already see in the controls below.
    el.statusText.textContent = resetMessage || s.text;

    if (blocked) {
      el.notice.hidden = false;
      el.notice.textContent = blocked;
    } else {
      el.notice.hidden = true;
      el.notice.textContent = '';
    }

    setRadio('site-mode', settingsApi.resolveMode(store, host));
    setRadio('engine', settingsApi.resolveEngine(store, host));

    // The look: preset, the three sliders, and the optional image dimming.
    var cfg = store.settings;
    el.look.value = cfg.look;
    if (!dragging) {
      el.brightness.value = String(cfg.brightness);
      el.contrast.value = String(cfg.contrast);
      el.warmth.value = String(cfg.warmth);
    }
    el.brightnessValue.textContent = el.brightness.value;
    el.contrastValue.textContent = el.contrast.value;
    el.warmthValue.textContent = el.warmth.value;
    el.dimImages.checked = !!cfg.dimImages;
    el.lookSummary.textContent = 'Look: ' + (LOOK_NAMES[cfg.look] || cfg.look) +
      ' \u00b7 Brightness ' + el.brightness.value;

    el.schedule.value = cfg.schedule.type;
    // Presentation only: the From / To row is always on screen, so nothing
    // moves when the schedule changes, and it takes input only for custom
    // hours. The values and their handlers are exactly as before.
    var customHours = cfg.schedule.type === 'hours';
    el.hours.hidden = false;
    el.from.disabled = !customHours;
    el.to.disabled = !customHours;
    el.hours.setAttribute('aria-disabled', customHours ? 'false' : 'true');
    el.from.value = cfg.schedule.from;
    el.to.value = cfg.schedule.to;

    var canSite = !blocked && !!host;
    setFieldsetEnabled(el.siteFieldset, canSite);
    setFieldsetEnabled(el.engineFieldset, canSite);
    el.siteHelp.textContent = canSite
      ? 'Auto leaves a site alone when it already has a dark theme.'
      : 'No site to set here.';

    // The picker needs a page that Darkrai is actually darkening.
    el.pick.disabled = !!blocked || tabState !== 'on';
    if (!pickMessage) {
      el.pickHelp.textContent = el.pick.disabled
        ? 'Available while Darkrai is darkening this page.'
        : 'Click an element, then choose how to fix it.';
    }

    // The danger row. Forgetting one site needs a site; the hard reset, which
    // only opens the options page at its danger area, never does.
    el.resetSite.disabled = !canSite;
    if (!siteResetArmed) {
      setResetSiteText('Reset this site');
      el.resetSite.setAttribute('aria-label',
        host ? 'Reset ' + host + ': forget its setting, mode and saved fixes' : 'Reset this site');
    }

    paint.pills();   // presentation only: the sliding pill follows :checked
  }

  function refreshStatus() {
    askTab().then(function (reply) {
      if (reply) { reached = true; tabState = reply.state; }
      render();
    });
  }

  // ------------------------------------------------------------------ events

  el.enabled.addEventListener('change', function () {
    var next = settingsApi.upgrade(store);
    next.settings.enabled = el.enabled.checked;
    saveStore(next);
  });

  var siteInputs = document.getElementsByName('site-mode');
  for (var i = 0; i < siteInputs.length; i++) {
    siteInputs[i].addEventListener('change', function (event) {
      if (!host) return;
      saveStore(settingsApi.setSiteMode(store, host, event.target.value));
    });
  }

  var engineInputs = document.getElementsByName('engine');
  for (var j = 0; j < engineInputs.length; j++) {
    engineInputs[j].addEventListener('change', function (event) {
      if (!host) return;
      saveStore(settingsApi.setSiteEngine(store, host, event.target.value));
    });
  }

  el.look.addEventListener('change', function () {
    var next = settingsApi.upgrade(store);
    next.settings.look = el.look.value;
    saveStore(next);
  });

  /** Dragging a slider repaints the page, so saves are coalesced. */
  function saveSoon(apply) {
    var next = settingsApi.upgrade(store);
    apply(next.settings);
    store = next;
    render();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      dragging = false;
      saveStore(next);
    }, 180);
  }

  function wireSlider(input, key) {
    input.addEventListener('input', function () {
      dragging = true;
      var value = Number(input.value);
      saveSoon(function (settings) { settings[key] = value; });
    });
    input.addEventListener('change', function () { dragging = false; });
  }

  wireSlider(el.brightness, 'brightness');
  wireSlider(el.contrast, 'contrast');
  wireSlider(el.warmth, 'warmth');

  el.dimImages.addEventListener('change', function () {
    var next = settingsApi.upgrade(store);
    next.settings.dimImages = el.dimImages.checked;
    saveStore(next);
  });

  el.schedule.addEventListener('change', function () {
    var next = settingsApi.upgrade(store);
    next.settings.schedule.type = el.schedule.value;
    saveStore(next);
  });

  function wireTime(input, key) {
    input.addEventListener('change', function () {
      if (!input.value) return;            // an empty time field means nothing
      var next = settingsApi.upgrade(store);
      next.settings.schedule[key] = input.value;
      saveStore(next);
    });
  }

  wireTime(el.from, 'from');
  wireTime(el.to, 'to');

  el.pick.addEventListener('click', function () {
    if (!tab || tab.id == null || !hasChrome() || !chrome.tabs) return;
    el.pick.disabled = true;
    pickMessage = 'Starting the picker\u2026';
    el.pickHelp.textContent = pickMessage;
    call(function (done) {
      chrome.tabs.sendMessage(tab.id, { type: 'dr-pick' }, TOP_FRAME, function (reply) {
        void chrome.runtime.lastError;
        done(reply || null);
      });
    }, T_MESSAGE, null).then(function (reply) {
      if (reply && reply.ok) { window.close(); return; }
      pickMessage = reply && reply.reason === 'not-darkened'
        ? 'Nothing to fix: Darkrai is not darkening this page.'
        : 'This tab did not answer. Reload it and try again.';
      el.pickHelp.textContent = pickMessage;
      el.pick.disabled = false;
    });
  });

  el.options.addEventListener('click', function () {
    if (!hasChrome()) return;
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage(function () { void chrome.runtime.lastError; });
      window.close();
      return;
    }
    if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
      window.close();
    }
  });

  // ------------------------------------------------- the danger row (FEAT-005)

  /**
   * Which stored entry is in charge of this host: its own, or the one it is
   * inheriting from (music.youtube.com follows youtube.com).
   */
  function siteKeyFor(name) {
    var sites = store.sites || {};
    if (sites[name]) return name;
    var hit = settingsApi.matchSite(sites, name);
    return hit ? hit.key : name;
  }

  /*
   * "Reset this site" acts here, in place: one inline confirmation, then the
   * site's setting, its mode and its saved fixes are forgotten and it follows
   * the global default again. No other site is touched.
   *
   * It goes through settings.removeSite and the popup's own saveStore, which
   * is the same write path every other control here uses - so the open tab
   * follows it at once and the parse cost of the full reset module stays out
   * of a surface with a 100ms paint budget. The full hard reset, which does
   * need that module, lives on the options page.
   */
  el.resetSite.addEventListener('click', function () {
    if (!host || el.resetSite.disabled) return;
    var key = siteKeyFor(host);
    if (!siteResetArmed) {
      siteResetArmed = true;
      setResetSiteText('Confirm: forget ' + key);
      resetMessage = 'Click again to forget ' + key + '\u2019s setting, mode and saved fixes. ' +
        'Esc keeps them.';
      render();
      return;
    }
    siteResetArmed = false;
    setResetSiteText('Reset this site');
    if (!(store.sites || {})[key]) {
      resetMessage = 'Nothing of your own was saved for ' + key + '.';
      render();
      return;
    }
    // The entry that governs this host may be a parent domain, in which case
    // every other subdomain following it goes back to the global default too -
    // so say that rather than "no other site changed".
    var done = key === host
      ? key + ' is forgotten: it follows the global default again. No other entry changed.'
      : key + ' is forgotten, so ' + host + ' and any other site under it follow the global ' +
      'default again. No other entry changed.';
    resetMessage = 'Forgetting ' + key + '\u2026';
    // Report from the write, not before it: saveStore resolves false on a
    // storage error or after its timeout, and a reset that did not land must
    // never read as done.
    saveStore(settingsApi.removeSite(store, key)).then(function (ok) {
      resetMessage = ok
        ? done
        : 'Could not forget ' + key + ': the change was not saved, so it comes back on the ' +
        'next read. Try again.';
      render();
    });
    render();
  });

  /*
   * Two clicks from the toolbar icon: here, then the dialog on the options
   * page. The full reset lives there because it needs room to say what it is
   * about to erase and to report what it did.
   *
   * chrome.runtime.openOptionsPage() cannot carry a URL fragment, so the
   * danger area is reached through the options URL itself and openOptionsPage
   * is the fallback for a browser without chrome.tabs.create.
   */
  el.hardReset.addEventListener('click', function () {
    if (!hasChrome()) return;
    if (chrome.tabs && chrome.tabs.create && chrome.runtime.getURL) {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#danger') });
      window.close();
      return;
    }
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage(function () { void chrome.runtime.lastError; });
      window.close();
    }
  });

  // An armed per-site reset is disarmed by Esc, like any other "are you sure".
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !siteResetArmed) return;
    siteResetArmed = false;
    resetMessage = '';
    setResetSiteText('Reset this site');
    render();
  });

  // A themed list (shared/select.css, appearance: base-select) is drawn in
  // the page, and Chrome closes the whole popup on an Esc the page leaves
  // unhandled. Esc on an open list closes the list only: the key is consumed
  // (which also cancels the list's own Esc handling), so the list is closed
  // here by taking the select out of base-select for one style recalc and
  // putting it back in the same task: nothing paints, no input or change
  // event fires, the value is untouched, and focus goes back to the select.
  // Chrome without customizable select never gets here.
  document.addEventListener('keydown', function (event) {
    // Focus sits on the select or, while its list is open, on an option in it.
    var s = event.target && event.target.closest ? event.target.closest('select') : null;
    if (event.key !== 'Escape' || !s) return;
    var open = false;
    try { open = s.matches(':open'); } catch (e) { return; }
    if (!open) return;
    event.preventDefault();
    s.style.setProperty('appearance', 'auto', 'important');
    void s.offsetWidth;
    s.style.removeProperty('appearance');
    s.focus();
  }, true);

  el.reload.addEventListener('click', function () {
    if (!tab || tab.id == null || !hasChrome() || !chrome.tabs) return;
    el.reload.disabled = true;
    call(function (done) {
      chrome.tabs.reload(tab.id, {}, function () { void chrome.runtime.lastError; done(true); });
    }, T_TABS, false).then(function () { window.close(); });
  });

  // Keep the popup honest if another window changes settings while it is open.
  if (hasChrome() && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        // The tab follows the same change, so ask it again what it is doing:
        // the device's state has to track the tab, not only the settings.
        getStore().then(function (next) { store = next; render(); refreshStatus(); });
      });
    } catch (e) { }
  }

  // The footer shows the real shortcut, so it stays right if the reader has
  // changed it at chrome://extensions/shortcuts. The markup holds the
  // manifest default until (and unless) Chrome answers.
  if (hasChrome() && chrome.commands && chrome.commands.getAll && el.shortcut) {
    call(function (done) {
      chrome.commands.getAll(function (list) { void chrome.runtime.lastError; done(list || []); });
    }, T_STORAGE, null).then(function (list) {
      if (!list) return;
      for (var c = 0; c < list.length; c++) {
        if (list[c] && list[c].name === 'toggle-site') {
          el.shortcut.textContent = list[c].shortcut || 'not set';
          return;
        }
      }
    });
  }

  // --------------------------------------------------- presentation plumbing

  /*
   * Look only. Nothing below reads or writes a setting, sends a message or
   * injects anything: it sizes and moves the sliding pill, keeps will-change
   * alive only while something is actually animating, and stops the backdrop
   * drifting while the popup is not on screen.
   *
   * The "should this move at all?" decision is shared/motion.js, so this page
   * and the options page cannot drift apart on it. The media query below is
   * only the fallback for a popup opened without that module.
   */
  var paint = (function () {
    var segs = document.querySelectorAll('.seg');
    var risers = document.querySelectorAll('.dr-rise, .dr-lift');

    function still() {
      var helper = window.Darkrai && window.Darkrai.motion;
      if (helper && typeof helper.animate === 'function') {
        try { return !helper.animate(); } catch (e) { }
      }
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
      catch (e) { return false; }
    }

    /**
     * Size and place each segmented control's pill from the selected label
     * itself, so it stays right whatever the labels say. CSS already has the
     * even-thirds fallback, which is what paints before this first runs.
     */
    function pills() {
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        var pill = seg.querySelector('.seg-pill');
        if (!pill) continue;
        var checked = seg.querySelector('input:checked');
        var label = checked && checked.id
          ? seg.querySelector('label[for="' + checked.id + '"]')
          : null;
        if (!label || !label.offsetWidth) continue;
        seg.style.setProperty('--dr-pill-w', label.offsetWidth + 'px');
        seg.style.setProperty('--dr-pill-x', label.offsetLeft + 'px');
      }
    }

    /** will-change costs a compositing layer, so it is only on while needed. */
    function lift(event) {
      // The drifting backdrop lives in pseudo-elements and never ends; hinting
      // their host element would pin a layer open for the popup's whole life.
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
      for (var i = 0; i < risers.length; i++) {
        risers[i].classList.add('dr-settled');
        if (risers[i].style) risers[i].style.willChange = '';
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

    document.addEventListener('change', function (event) {
      var node = event.target;
      if (node && (node.name === 'site-mode' || node.name === 'engine')) pills();
    });

    document.addEventListener('visibilitychange', function () {
      document.documentElement.classList.toggle('dr-still', document.hidden);
    });

    if (still()) settleAll();

    return { pills: pills };
  })();

  // -------------------------------------------------------------------- init

  render();   // draw with defaults first; no waiting, ever

  getStore().then(function (next) { store = next; render(); });

  getTab().then(function (found) {
    tab = found;
    if (tab && tab.url) {
      blocked = restricted.reasonFor(tab.url);
      host = blocked ? '' : settingsApi.hostFromUrl(tab.url);
      if (!host && !blocked) host = settingsApi.hostFromUrl(tab.url);
    } else {
      // Darkrai can see the URL of every http(s) page, so a tab with no URL
      // is a Chrome page (chrome://, new tab) that extensions may not touch.
      // With no tab at all there is genuinely nothing to darken.
      blocked = tab ? restricted.MESSAGES.scheme : restricted.MESSAGES.blank;
    }
    render();
    if (blocked) return;
    return askTab().then(function (reply) {
      if (reply) { reached = true; tabState = reply.state; render(); return; }
      // No answer: inject on the spot and ask once more.
      return injectTab().then(function () {
        return new Promise(function (resolve) { setTimeout(resolve, 200); });
      }).then(askTab).then(function (second) {
        if (second) { reached = true; tabState = second.state; }
        render();
      });
    });
  });
})();
