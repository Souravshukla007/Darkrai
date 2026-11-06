/*
 * Darkrai - background.js (Manifest V3 service worker)
 *
 * The worker keeps no state of its own (PLAN section 5). Everything it needs it
 * reads from chrome.storage.local or from the message it is answering, so it is
 * free to be shut down at any moment.
 *
 * Jobs: install/update setup, re-injection into open tabs, the keyboard
 * shortcut, registering the early dark background, fetching other-domain
 * stylesheets and icons, the per-tab icon, and schedule alarms.
 */
'use strict';

importScripts('shared/settings.js', 'shared/restricted.js', 'shared/color.js',
  'shared/preload-reg.js');

var settingsApi = Darkrai.settings;
var restricted = Darkrai.restricted;
var color = Darkrai.color;
// The early dark background and the schedule alarm live in their own module
// so the hard reset can put back the real registration, not a copy of it.
var preloadReg = Darkrai.preloadReg;

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

var ALARM_SCHEDULE = preloadReg.ALARM_SCHEDULE;
// The page script runs in every frame and every frame answers a message, so a
// question about "this page" has to be addressed to the top frame by name.
var TOP_FRAME = { frameId: 0 };
var MAX_SHEET_BYTES = 5 * 1024 * 1024;   // 5 MB cap
var FETCH_TIMEOUT_MS = 10000;            // 10 s timeout

var ICONS = {
  on: { 16: 'icons/on-16.png', 32: 'icons/on-32.png', 48: 'icons/on-48.png', 128: 'icons/on-128.png' },
  native: { 16: 'icons/native-16.png', 32: 'icons/native-32.png', 48: 'icons/native-48.png', 128: 'icons/native-128.png' },
  off: { 16: 'icons/off-16.png', 32: 'icons/off-32.png', 48: 'icons/off-48.png', 128: 'icons/off-128.png' }
};

var TITLES = {
  on: 'Darkrai - darkening this site',
  native: "Darkrai - this site's own dark theme, left alone",
  off: 'Darkrai - off for this site'
};

// ------------------------------------------------------------------- storage

function readStore() {
  return chrome.storage.local.get(null)
    .then(function (raw) { return settingsApi.upgrade(raw); })
    .catch(function () { return settingsApi.defaults(); });
}

function writeStore(store) {
  return chrome.storage.local.set({
    schema: store.schema, debug: store.debug === true,
    settings: store.settings, sites: store.sites
  }).catch(function () { });
}

// --------------------------------------------- early dark background (6.8)

// Both of these are shared/preload-reg.js now, with this worker's chrome
// object handed in. Same ids, same excludeMatches, same preload-system.css
// choice for the system schedule, same hours gate - the module is the
// extraction of what used to be written out here.
function registerPreload(store) {
  return preloadReg.registerPreload(chrome, store, { settings: settingsApi })
    .catch(function () { });
}

function scheduleAlarms(store) {
  return preloadReg.scheduleAlarms(chrome, store, { settings: settingsApi })
    .catch(function () { });
}

// -------------------------------------------- re-inject into open tabs (6.7)

function reinjectTab(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    files: CONTENT_FILES,
    injectImmediately: true
  }).catch(function () { });
}

function reinjectAllTabs() {
  return chrome.tabs.query({}).then(function (tabs) {
    var jobs = [];
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (!tab || tab.id == null || !tab.url) continue;
      if (restricted.isRestricted(tab.url)) continue;
      jobs.push(reinjectTab(tab.id));
    }
    return Promise.all(jobs);
  }).catch(function () { });
}

// ------------------------------------------------------------- icon per tab

function setTabIcon(tabId, state) {
  var key = ICONS[state] ? state : 'off';
  if (chrome.action.setIcon) {
    chrome.action.setIcon({ tabId: tabId, path: ICONS[key] }).catch(function () { });
  }
  if (chrome.action.setTitle) {
    chrome.action.setTitle({ tabId: tabId, title: TITLES[key] }).catch(function () { });
  }
}

// ------------------------------------------------- cross-origin fetch relay

/**
 * Fetch a stylesheet the page already links to. The content script only ever
 * passes URLs it read from a <link> or an @import in the page, and we add the
 * hard limits here: no cookies, http(s) only, a 5 MB cap and a 10 s timeout.
 */
function fetchSheet(url, sender) {
  if (!sender || !sender.tab) return Promise.resolve({ ok: false, error: 'no-tab' });
  if (!/^https?:\/\//i.test(String(url || ''))) return Promise.resolve({ ok: false, error: 'scheme' });
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  return fetch(url, {
    credentials: 'omit',
    cache: 'force-cache',
    redirect: 'follow',
    signal: controller.signal
  }).then(function (res) {
    if (!res.ok) throw new Error('status ' + res.status);
    var len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_SHEET_BYTES) throw new Error('too big');
    return res.text();
  }).then(function (text) {
    clearTimeout(timer);
    if (text.length > MAX_SHEET_BYTES) return { ok: false, error: 'too-big' };
    return { ok: true, text: text };
  }).catch(function (err) {
    clearTimeout(timer);
    return { ok: false, error: String(err && err.message || err) };
  });
}

/**
 * Icon rescue for images from another domain (PLAN section 6.5): analyse here
 * and return only yes or no, never the pixels.
 */
function analyzeIcon(url, sender) {
  if (!sender || !sender.tab) return Promise.resolve({ ok: false });
  if (!/^https?:\/\//i.test(String(url || ''))) return Promise.resolve({ ok: false });
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    return Promise.resolve({ ok: false });
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  return fetch(url, { credentials: 'omit', cache: 'force-cache', signal: controller.signal })
    .then(function (res) {
      if (!res.ok) throw new Error('status');
      return res.blob();
    })
    .then(function (blob) {
      clearTimeout(timer);
      if (blob.size > MAX_SHEET_BYTES) throw new Error('too big');
      return createImageBitmap(blob);
    })
    .then(function (bitmap) {
      var size = 32;
      var canvas = new OffscreenCanvas(size, size);
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(bitmap, 0, 0, size, size);
      var data = ctx.getImageData(0, 0, size, size).data;
      var transparent = 0, visible = 0, darkish = 0, colourful = 0;
      for (var i = 0; i < data.length; i += 4) {
        var a = data[i + 3] / 255;
        if (a < 0.1) { transparent++; continue; }
        visible++;
        var oklch = color.srgbToOklch({ r: data[i], g: data[i + 1], b: data[i + 2] });
        if (oklch.l < 0.35) darkish++;
        if (oklch.c > 0.06) colourful++;
      }
      bitmap.close && bitmap.close();
      var total = size * size;
      var invert = visible > 0 &&
        transparent / total >= 0.25 &&
        darkish / visible >= 0.75 &&
        colourful / visible <= 0.15;
      return { ok: true, invert: invert };
    })
    .catch(function () { clearTimeout(timer); return { ok: false }; });
}

// ------------------------------------------------------------------ toggle

function toggleSite(tab) {
  if (!tab || !tab.url || restricted.isRestricted(tab.url)) return Promise.resolve();
  var host = settingsApi.hostFromUrl(tab.url);
  if (!host) return Promise.resolve();
  return readStore().then(function (store) {
    var current = settingsApi.resolveMode(store, host);
    var next = current === 'off' ? 'on' : 'off';
    var updated = settingsApi.setSiteMode(store, host, next);
    return writeStore(updated).then(function () {
      // Open tabs pick the change up from storage; nudge the top frame in case
      // its page script is missing (for example after an update). Frames follow
      // storage, so they need no nudge of their own.
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'dr-refresh' }, TOP_FRAME, function () {
          void chrome.runtime.lastError;
        });
      }
      return registerPreload(updated);
    });
  });
}

// ------------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(function (details) {
  readStore().then(function (store) {
    return writeStore(store).then(function () {
      return Promise.all([
        registerPreload(store),
        scheduleAlarms(store),
        // After an install or an update, open tabs still hold an old copy of
        // the page script (or none at all): give every one of them a fresh copy.
        reinjectAllTabs()
      ]);
    });
  }).catch(function () { });
  void details;
});

chrome.runtime.onStartup.addListener(function () {
  readStore().then(function (store) {
    return Promise.all([registerPreload(store), scheduleAlarms(store)]);
  }).catch(function () { });
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (!changes.settings && !changes.sites) return;
  readStore().then(function (store) {
    return Promise.all([registerPreload(store), scheduleAlarms(store)]);
  }).catch(function () { });
});

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name !== ALARM_SCHEDULE) return;
    readStore().then(function (store) {
      return Promise.all([registerPreload(store), scheduleAlarms(store)]);
    }).catch(function () { });
  });
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(function (command) {
    if (command !== 'toggle-site') return;
    chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      return toggleSite(tabs && tabs[0]);
    }).catch(function () { });
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, respond) {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'dr-state':
      if (sender.tab && sender.tab.id != null && message.top !== false) {
        setTabIcon(sender.tab.id, message.state);
      }
      respond({ ok: true });
      return false;
    case 'dr-fetch-sheet':
      fetchSheet(message.url, sender).then(respond);
      return true;
    case 'dr-analyze-icon':
      analyzeIcon(message.url, sender).then(respond);
      return true;
    case 'dr-reinject':
      if (message.tabId != null) reinjectTab(message.tabId).then(function () { respond({ ok: true }); });
      else reinjectAllTabs().then(function () { respond({ ok: true }); });
      return true;
    case 'dr-register-preload':
      readStore().then(registerPreload).then(function () { respond({ ok: true }); });
      return true;
    default:
      return false;
  }
});

// Keep the toolbar icon honest when the user switches tabs: ask the tab, and
// fall back to off if nothing answers.
chrome.tabs.onActivated.addListener(function (info) {
  chrome.tabs.sendMessage(info.tabId, { type: 'dr-status' }, TOP_FRAME, function (reply) {
    void chrome.runtime.lastError;
    setTabIcon(info.tabId, reply && reply.state ? reply.state : 'off');
  });
});

// A navigation starts from a clean slate: grey while the new page is loading,
// and grey for good on a page Chrome does not let us touch. The page script
// reports 'on' or 'native' as soon as it has decided (PLAN section 4, item 5).
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status === 'loading' && changeInfo.url !== undefined) {
    setTabIcon(tabId, 'off');
    return;
  }
  if (changeInfo.status !== 'complete') return;
  if (tab && tab.url && restricted.isRestricted(tab.url)) {
    setTabIcon(tabId, 'off');
    return;
  }
  chrome.tabs.sendMessage(tabId, { type: 'dr-status' }, TOP_FRAME, function (reply) {
    void chrome.runtime.lastError;
    if (reply && reply.state) setTabIcon(tabId, reply.state);
  });
});
