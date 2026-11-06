/*
 * Darkrai - tests/browser/popup-behaviour.js
 *
 * The popup's behaviour, as chrome.* sees it. Every control is driven once
 * against popup.html with the UI shim standing in for chrome.*, and what each
 * action made the popup do is recorded: every chrome.* call with its
 * arguments, every storage write, and the words and values the popup was
 * left showing.
 *
 *   node browser/popup-behaviour.js            record now and compare with the baseline
 *   node browser/popup-behaviour.js --write    record now and save it as the baseline
 *
 * run-ui-checks.js family (j) runs the same comparison. The baseline,
 * popup-behaviour.baseline.json, was recorded against the popup BEFORE the
 * Minimal Pokedex redesign, so a difference is a regression in the popup and
 * not a new truth to re-record.
 *
 * What counts as the same: identical calls with identical arguments (as a
 * multiset), identical storage writes in identical order, and an identical
 * UI read-out. Only timestamps and the test server's random port are
 * ignored. A pure reordering of non-write calls is reported, not failed:
 * the shim answers on timers, and two equal timers may interleave.
 *
 * The page clock is pinned to 23:30 local time (CLOCK below). The baseline
 * was recorded at 23:55, inside every custom-hours window it exercises
 * (19:00-07:00, 20:30-07:00, 19:00-06:15), so the pinned clock gives the
 * same schedule verdicts. Without the pin those status lines would depend on
 * the time of day the check happens to run.
 *
 * Same contract as every suite here: nothing is downloaded and with no
 * headless binary it prints SKIPPED and exits 0.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT,
  candidateBrowsers,
  startServer,
  connect,
  delay,
  getJson,
  launch
} = require('./chrome.js');

const BASELINE = path.join(__dirname, 'popup-behaviour.baseline.json');
const SHIM = path.join(ROOT, 'tests', 'shim', 'chrome-ui-shim.js');

/*
 * The page clock, pinned to 23:30 local and running on from there, so timers
 * and the order of events are untouched. Date() with arguments is the real
 * thing; only "now" moves.
 */
const CLOCK = `(function () {
  var Real = Date;
  var started = Real.now();
  var pinned = new Real(2026, 10, 2, 23, 30, 0, 0).getTime();
  function now() { return pinned + (Real.now() - started); }
  function Pinned(y, mo, d, h, mi, s, ms) {
    if (!(this instanceof Pinned)) return new Real(now()).toString();
    if (arguments.length === 0) return new Real(now());
    if (arguments.length === 1) return new Real(y);
    return new Real(y, mo, d === undefined ? 1 : d, h || 0, mi || 0, s || 0, ms || 0);
  }
  Pinned.prototype = Real.prototype;
  Pinned.now = now;
  Pinned.parse = Real.parse;
  Pinned.UTC = Real.UTC;
  window.Date = Pinned;
})();`;
const POPUP = '/extension/popup/popup.html';
// Longer than the sliders' 180ms save debounce plus the nudge and the
// status refresh that follow every save.
const SETTLE_MS = 700;

// ------------------------------------------------------------ page actions

/*
 * Each helper acts the way a reader's input does, on the real control: a
 * click, or a new value followed by the events the browser fires itself.
 * A control that is disabled or not rendered refuses, because a reader
 * could not have used it either.
 */
function usable(id) {
  return 'var n = document.getElementById(' + JSON.stringify(id) + ');' +
    'if (!n) return { ok: false, why: "#' + id + ' is not in the markup" };' +
    'if (n.disabled) return { ok: false, why: "#' + id + ' is disabled" };' +
    'if (!n.getClientRects().length) return { ok: false, why: "#' + id + ' is not rendered" };';
}

function click(id) {
  return '(function () {' + usable(id) + 'n.click(); return { ok: true }; })()';
}

/** A <select>, a time field or a slider: set the value, fire input + change. */
function setValue(id, value) {
  return '(function () {' + usable(id) +
    'n.value = ' + JSON.stringify(value) + ';' +
    'n.dispatchEvent(new Event("input", { bubbles: true }));' +
    'n.dispatchEvent(new Event("change", { bubbles: true }));' +
    'return { ok: n.value === ' + JSON.stringify(value) + ', why: "value is " + n.value }; })()';
}

function keydown(key) {
  return '(function () {' +
    'document.dispatchEvent(new KeyboardEvent("keydown", { key: ' + JSON.stringify(key) +
    ', bubbles: true }));' +
    'return { ok: true }; })()';
}

/** The Look panel has to be open before its controls can be used. */
const OPEN_LOOK = '(function () {' +
  'var d = document.getElementById("look-details");' +
  'if (!d) return { ok: false, why: "#look-details is not in the markup" };' +
  'if (!d.open) document.getElementById("look-summary").click();' +
  'return { ok: d.open, why: "the Look panel did not open" }; })()';

const ACTIONS = [
  { name: 'open the popup', load: true },
  { name: 'master toggle: off', steps: [click('enabled')] },
  { name: 'master toggle: back on', setup: [click('enabled')], steps: [click('enabled')] },
  { name: 'this site: Always', steps: [click('mode-on')] },
  { name: 'this site: Never', steps: [click('mode-off')] },
  { name: 'this site: Auto (from Always)', setup: [click('mode-on')], steps: [click('mode-auto')] },
  { name: 'mode: Simple', steps: [click('engine-filter')] },
  { name: 'mode: Smart (from Simple)', setup: [click('engine-filter')], steps: [click('engine-smart')] },
  { name: 'look: open the panel', steps: [click('look-summary')] },
  { name: 'look: True black', setup: [OPEN_LOOK], steps: [setValue('look', 'black')] },
  { name: 'look: Soft', setup: [OPEN_LOOK], steps: [setValue('look', 'soft')] },
  { name: 'look: Dark gray (from Soft)', setup: [OPEN_LOOK, setValue('look', 'soft')], steps: [setValue('look', 'gray')] },
  { name: 'look: brightness 120', setup: [OPEN_LOOK], steps: [setValue('brightness', '120')] },
  { name: 'look: contrast 80', setup: [OPEN_LOOK], steps: [setValue('contrast', '80')] },
  { name: 'look: warmth 30', setup: [OPEN_LOOK], steps: [setValue('warmth', '30')] },
  { name: 'look: dim images', setup: [OPEN_LOOK], steps: [click('dim-images')] },
  { name: 'fix something unreadable', steps: [click('pick')] },
  { name: 'schedule: Follow system', steps: [setValue('schedule', 'system')] },
  { name: 'schedule: Custom hours', steps: [setValue('schedule', 'hours')] },
  { name: 'schedule: Always (from Custom hours)', setup: [setValue('schedule', 'hours')], steps: [setValue('schedule', 'always')] },
  { name: 'schedule: From 20:30', setup: [setValue('schedule', 'hours')], steps: [setValue('from', '20:30')] },
  { name: 'schedule: To 06:15', setup: [setValue('schedule', 'hours')], steps: [setValue('to', '06:15')] },
  { name: 'reload this tab', steps: [click('reload')] },
  { name: 'options', steps: [click('options')] },
  { name: 'reset this site: arm, then Esc', setup: [click('mode-on')], steps: [click('reset-site'), keydown('Escape')] },
  { name: 'reset this site: arm, then confirm', setup: [click('mode-on')], steps: [click('reset-site'), click('reset-site')] },
  { name: 'hard reset', steps: [click('hard-reset')] }
];

/** What the popup is showing: its words and its control values. */
const READ_UI = '(function () {' +
  'function t(id) { var n = document.getElementById(id); return n ? n.textContent.replace(/\\s+/g, " ").trim() : null; }' +
  'function v(id) { var n = document.getElementById(id); return n ? n.value : null; }' +
  'function c(id) { var n = document.getElementById(id); return n ? !!n.checked : null; }' +
  'function r(name) { var n = document.querySelector("input[name=\\"" + name + "\\"]:checked"); return n ? n.value : null; }' +
  'return { status: t("status-text"), enabledText: t("enabled-text"), host: t("host"),' +
  '  siteHelp: t("site-help"), pickHelp: t("pick-help"), resetSite: t("reset-site-text"),' +
  '  lookSummary: t("look-summary"), shortcut: t("shortcut"),' +
  '  enabled: c("enabled"), siteMode: r("site-mode"), engine: r("engine"),' +
  '  look: v("look"), brightness: v("brightness"), contrast: v("contrast"), warmth: v("warmth"),' +
  '  dimImages: c("dim-images"), schedule: v("schedule"), from: v("from"), to: v("to"),' +
  '  dot: (document.getElementById("dot") || { getAttribute: function () { return null; } }).getAttribute("data-state") };' +
  '})()';

// --------------------------------------------------------------- CDP plumbing

async function evaluate(page, expression, timeoutMs) {
  const out = await page.send('Runtime.evaluate', {
    expression: '(function(){ return Promise.resolve((function(){ return (' + expression +
      '); })()).then(function (v) { return JSON.stringify(v === undefined ? null : v); }); })()',
    returnByValue: true,
    awaitPromise: true
  }, timeoutMs || 20000);
  if (out.exceptionDetails) {
    const ex = out.exceptionDetails;
    throw new Error('page threw on ' + expression.slice(0, 60) + ': ' +
      ((ex.exception && (ex.exception.description || ex.exception.value)) || ex.text));
  }
  const value = out.result && out.result.value;
  return value == null ? null : JSON.parse(value);
}

async function openTarget(session) {
  const { targetId } = await session.browser.send('Target.createTarget', { url: 'about:blank' });
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    const list = await getJson(session.cdpPort, '/json/list');
    const hit = list.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
    if (hit) wsUrl = hit.webSocketDebuggerUrl;
    else await delay(100);
  }
  if (!wsUrl) throw new Error('no debugger url for the behaviour target');
  const page = await connect(wsUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(SHIM, 'utf8') });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 360, height: 600, deviceScaleFactor: 1, mobile: false
  });
  return { page, targetId };
}

/** A fresh popup: a new document, so a fresh shim with a fresh store. */
async function freshPopup(page, url) {
  await page.send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await evaluate(page, 'document.readyState === "complete" && !!window.__drUiShim')
      .catch(() => false);
    if (!ready) await delay(50);
  }
  if (!ready) throw new Error('the popup never finished loading');
  // Settled once the tab has been asked what it is doing and has answered.
  for (let i = 0; i < 40; i++) {
    const asked = await evaluate(page, '__drUiShim.find("tabs.sendMessage").length > 0').catch(() => false);
    if (asked) break;
    await delay(50);
  }
  await delay(300);
}

// ---------------------------------------------------------------- recording

/** Calls without timestamps, with the server's random origin made stable. */
function normalise(calls) {
  const text = JSON.stringify(calls.map((c) => ({ api: c.api, args: c.args })));
  return JSON.parse(text.replace(/https?:\/\/127\.0\.0\.1:\d+/g, '<origin>'));
}

function writesOf(calls) {
  return calls
    .filter((c) => /^storage\.local\.(set|remove|clear)$/.test(c.api))
    .map((c) => ({ api: c.api, items: c.args[0] === '[function]' ? null : c.args[0] }));
}

async function runAction(page, url, action) {
  await freshPopup(page, url);
  const blocked = [];
  if (!action.load) {
    for (const step of action.setup || []) {
      const out = await evaluate(page, step);
      if (!out || !out.ok) blocked.push('setup: ' + ((out && out.why) || 'no answer'));
      await delay(80);
    }
    if (action.setup && action.setup.length) await delay(SETTLE_MS);
    await evaluate(page, '__drUiShim.reset()');
    for (const step of action.steps) {
      const out = await evaluate(page, step);
      if (!out || !out.ok) blocked.push((out && out.why) || 'no answer');
      await delay(120);
    }
    await delay(SETTLE_MS);
  }
  const calls = normalise(await evaluate(page, '__drUiShim.calls'));
  return {
    name: action.name,
    blocked: blocked,
    calls: calls,
    writes: writesOf(calls),
    ui: await evaluate(page, READ_UI)
  };
}

/** Drive every action once, each in a fresh popup. */
async function recordAll(session, baseUrl) {
  const { page, targetId } = await openTarget(session);
  const out = [];
  try {
    for (const action of ACTIONS) out.push(await runAction(page, baseUrl + POPUP, action));
  } finally {
    page.close();
    await session.browser.send('Target.closeTarget', { targetId }).catch(() => { });
  }
  return out;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
}

function sortedJson(list) {
  return list.map((x) => JSON.stringify(x)).sort();
}

/** Every difference between a recording and the baseline, in words. */
function compare(recorded, baseline) {
  const problems = [];
  const notes = [];
  const now = new Map(recorded.map((r) => [r.name, r]));
  for (const want of baseline.actions) {
    const got = now.get(want.name);
    if (!got) { problems.push(want.name + ': not replayed'); continue; }
    if (got.blocked.length) problems.push(want.name + ': could not be done - ' + got.blocked.join('; '));
    if (JSON.stringify(got.writes) !== JSON.stringify(want.writes)) {
      problems.push(want.name + ': storage writes differ\n        was ' +
        JSON.stringify(want.writes).slice(0, 300) + '\n        now ' +
        JSON.stringify(got.writes).slice(0, 300));
    }
    const a = sortedJson(want.calls);
    const b = sortedJson(got.calls);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const missing = a.filter((x) => !b.includes(x));
      const extra = b.filter((x) => !a.includes(x));
      problems.push(want.name + ': chrome.* calls differ (' + want.calls.length + ' -> ' +
        got.calls.length + ')' +
        (missing.length ? '\n        missing ' + missing.slice(0, 3).join(' | ').slice(0, 300) : '') +
        (extra.length ? '\n        extra ' + extra.slice(0, 3).join(' | ').slice(0, 300) : ''));
    } else if (JSON.stringify(want.calls) !== JSON.stringify(got.calls)) {
      notes.push(want.name + ': same calls in a different order');
    }
    for (const key of Object.keys(want.ui || {})) {
      if (JSON.stringify(want.ui[key]) !== JSON.stringify((got.ui || {})[key])) {
        problems.push(want.name + ': the popup now shows ' + key + ' = ' +
          JSON.stringify((got.ui || {})[key]) + ', was ' + JSON.stringify(want.ui[key]));
      }
    }
  }
  return { problems, notes, actions: baseline.actions.length };
}

// ---------------------------------------------------------------------- CLI

async function main() {
  const write = process.argv.includes('--write');
  const browsers = candidateBrowsers();
  if (!browsers.length) {
    console.log('SKIPPED: no headless browser found on this machine. Nothing was downloaded.');
    return 0;
  }
  let session = null;
  let server = null;
  try {
    session = await launch({ executable: browsers[0] });
    const started = await startServer();
    server = started.server;
    const recorded = await recordAll(session, 'http://127.0.0.1:' + started.port);
    if (write) {
      fs.writeFileSync(BASELINE, JSON.stringify({
        recordedAgainst: 'extension/popup/popup.html before the Minimal Pokedex redesign',
        recordedAt: new Date().toISOString().slice(0, 10),
        clock: 'page clock pinned to 23:30 local (popup-behaviour.js CLOCK)',
        shim: 'tests/shim/chrome-ui-shim.js, tab https://example.com/ answering state "on"',
        actions: recorded
      }, null, 2) + '\n');
      console.log('wrote ' + path.relative(ROOT, BASELINE) + ': ' + recorded.length + ' actions, ' +
        recorded.reduce((n, r) => n + r.calls.length, 0) + ' chrome.* calls, ' +
        recorded.reduce((n, r) => n + r.writes.length, 0) + ' storage writes');
      const blocked = recorded.filter((r) => r.blocked.length);
      for (const r of blocked) console.log('  BLOCKED ' + r.name + ': ' + r.blocked.join('; '));
      return blocked.length ? 1 : 0;
    }
    const baseline = loadBaseline();
    if (!baseline) { console.log('no baseline at ' + BASELINE + '; run with --write first'); return 1; }
    const result = compare(recorded, baseline);
    console.log(result.actions + ' actions replayed, ' + result.problems.length + ' difference(s)');
    for (const p of result.problems) console.log('  XX ' + p);
    for (const n of result.notes) console.log('  ~  ' + n);
    return result.problems.length ? 1 : 0;
  } finally {
    if (session) await session.close();
    if (server) server.close();
  }
}

module.exports = { ACTIONS, BASELINE, recordAll, compare, loadBaseline };

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(1);
  });
}
