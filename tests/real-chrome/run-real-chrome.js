#!/usr/bin/env node
/*
 * Darkrai - real Google Chrome harness for the three user problems.
 *
 *   node tests/real-chrome/run-real-chrome.js
 *
 * Launches the installed Google Chrome on a fresh throwaway profile (never the
 * user's own), loads the unpacked extension with CDP Extensions.loadUnpacked
 * over --remote-debugging-pipe, and checks real public sites.
 * Exit 0 only when every P1 check passes. Prints SKIPPED and exits 0 when
 * Chrome is not installed. No dependencies: Node built-ins only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sleep, withTimeout, decodePNG, iconContrast, lightRegions, explainLight } = require('./lib');
const { PROBE, LIGHT_EXPLAIN } = require('./probe');
const { Browser } = require('./browser');
const { problem1, reloadCheck, hardReset, popupControls } = require('./popup-checks');

const DARKRAI = path.resolve(__dirname, '..', '..');
// DARKRAI_EXTENSION points a debug run at a copy of extension/, and
// DARKRAI_RESULTS keeps that run's results and report out of this folder.
const EXTENSION = process.env.DARKRAI_EXTENSION ? path.resolve(process.env.DARKRAI_EXTENSION) : path.join(DARKRAI, 'extension');
const RESULTS = process.env.DARKRAI_RESULTS ? path.resolve(process.env.DARKRAI_RESULTS) : path.join(__dirname, 'results');
const REPORT_MD = process.env.DARKRAI_RESULTS ? path.join(RESULTS, 'REAL-CHROME-REPORT.md') : path.join(__dirname, 'REAL-CHROME-REPORT.md');
// Every run's throwaway profile is <PROFILE_ROOT>\profile-<ms>, by default in
// the OS temp folder (DARKRAI_PROFILE_ROOT moves it). A Chrome left behind by
// a killed run is found by that root on its command line (--user-data-dir).
// The Chrome log goes with the run's results, so a run writes nothing else.
const PROFILE_ROOT = process.env.DARKRAI_PROFILE_ROOT
  ? path.resolve(process.env.DARKRAI_PROFILE_ROOT)
  : path.join(require('os').tmpdir(), 'darkrai-realchrome');
// DARKRAI_CHROME names the Chrome to drive (it must be real Chrome, not a
// headless shell: the harness needs Extensions.loadUnpacked).
const CHROME = process.env.DARKRAI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
const OUT = path.join(RESULTS, RUN_ID);
const SITE_TIMEOUT = 45000;
// A full run was 5-6 minutes before P4 added about two more.
const CAP_MIN = 14;
const OVERALL_CAP = CAP_MIN * 60 * 1000;

// --only=problem2,problem3,problem1,p4,p2,p3 runs a subset (each run has its
// own cap) and merges the rest from the previous run's report.json.
const ONLY = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean);
const want = (g) => !ONLY.length || ONLY.includes(g);
// Test-only: --sites=wikipedia,youtube limits problem 3 to URLs containing one of these.
const SITES = ((process.argv.find((a) => a.startsWith('--sites=')) || '').slice(8)).split(',').filter(Boolean);
const LATEST = path.join(RESULTS, 'latest-run.txt');

const checks = [];
const readability = [];
const started = Date.now();

function record(id, priority, name, status, evidence, reason) {
  checks.push({ id, priority, name, status, evidence: evidence || null, reason: reason || '' });
  console.log(status.padEnd(8) + id + '  ' + name + (reason ? '  -- ' + reason : ''));
}

async function check(id, priority, name, fn, ms) {
  if (Date.now() - started > OVERALL_CAP - 20000) return record(id, priority, name, 'NOT RUN', null, 'overall ' + CAP_MIN + '-minute cap reached');
  try {
    const r = await withTimeout(fn(), ms || SITE_TIMEOUT, id);
    record(id, priority, name, r.status, r.note ? Object.assign({ note: r.note }, r.evidence) : r.evidence,
      r.reason);
    if (r.note) console.log('        note: ' + r.note);
  } catch (e) {
    record(id, priority, name, 'NOT RUN', null, 'harness: ' + (e && e.message || e));
  }
}

const ctx = { record, check, checks, extension: EXTENSION, out: OUT, b: null, site: null, driver: null };

async function setStore(patch) {
  // patch(settings, store) runs in the driver page.
  return ctx.driver.eval(`(async () => {
    const s = await chrome.storage.local.get(null);
    (${patch})(s.settings, s);
    await chrome.storage.local.set({ settings: s.settings, debug: s.debug === true });
    return s.settings;
  })()`);
}

// ------------------------------------------------------------- problem 2

async function nativeCheck(id, pri, url, scheme, expect) {
  await check(id, pri, url + ' in ' + scheme + ' -> ' + expect, async () => {
    const site = ctx.site;
    await site.scheme(scheme);
    const nav = await site.go(url);
    const o = await site.settle();
    if (/\/sorry\//.test(o.url || '')) return { status: 'NOT RUN', evidence: { finalUrl: o.url }, reason: 'Google served its bot-check (/sorry/) page instead of results' };
    let ok;
    if (expect === 'native') ok = o.attr === 'native' && o.styleNodes === 0 && o.darkraiAdopted === 0;
    else ok = o.attr === 'on' && o.darkraiStyles > 0;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { finalUrl: o.url, nav, attr: o.attr, styleNodes: o.styleNodes, darkraiAdopted: o.darkraiAdopted, groups: o.styleGroups, settled: o.settled, siteDarkAttr: o.ytDarkAttr, rootBg: o.rootBg, detection: o.status && o.status.detection },
      reason: ok ? '' : 'got data-darkrai="' + o.attr + '", ' + o.styleNodes + ' style nodes, ' + o.darkraiAdopted + ' adopted sheets at ' + o.url
    };
  });
}

// Relative luminance of a computed 'rgb(...)' / 'rgba(...)' value; null when
// it is transparent or unparseable.
function bgLum(c) {
  const m = /rgba?\(([^)]+)\)/.exec(c || '');
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (p.length > 3 && p[3] < 0.5) return null;
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
}
// The page's own background: the body's when it paints one, else the root's.
function ownBg(o) { const b = bgLum(o.bodyBg); return b != null ? b : bgLum(o.rootBg); }

/**
 * P1-2c on MDN, which follows prefers-color-scheme through media queries, so
 * flipping the emulated scheme switches its own theme without a reload.
 * Light: Darkrai darkens it. Dark: MDN's own theme is dark (Darkrai's styles
 * are gone, so the computed background is MDN's) and Darkrai goes native with
 * 0 style nodes and 0 adopted sheets. Light again: Darkrai darkens it again.
 * When MDN does not switch either, the YouTube attempt runs as the fallback.
 */
async function liveSwitch() {
  let mdnEvidence = null;
  await check('P1-2c', 'P1', 'live theme switch (no reload) on MDN: native when the site turns dark, darkened again when it turns light', async () => {
    const site = ctx.site;
    await setStore('(st) => { st.enabled = true; }');
    await site.scheme('light');
    await site.go('https://developer.mozilla.org/en-US/docs/Web/CSS');
    const before = await site.settle();
    await site.scheme('dark');
    const dark = await site.poll((o) => o.attr === 'native' && o.styleNodes === 0 && o.darkraiAdopted === 0, 6000, 250) || await site.observe();
    let mdnOwnDark = dark.attr === 'native' && dark.darkraiStyles === 0 ? ownBg(dark) : null;
    let offMeasure = null;
    if (mdnOwnDark == null) {
      // Darkrai still applied: measure MDN's own background with it off.
      await setStore('(st) => { st.enabled = false; }');
      try { offMeasure = await site.poll((x) => x.attr !== 'on' && x.darkraiStyles === 0, 3000, 100); }
      finally { await setStore('(st) => { st.enabled = true; }'); }
      mdnOwnDark = offMeasure ? ownBg(offMeasure) : null;
      await site.poll((x) => x.attr === 'on', 4000, 100);
    }
    const switched = mdnOwnDark != null && mdnOwnDark < 0.2;
    await site.scheme('light');
    const back = await site.poll((o) => o.attr === 'on' && o.darkraiStyles > 0, 6000, 250) || await site.observe();
    mdnEvidence = {
      before: { attr: before.attr, styles: before.darkraiStyles, rootBg: before.rootBg, bodyBg: before.bodyBg },
      dark: { attr: dark.attr, styleNodes: dark.styleNodes, adopted: dark.darkraiAdopted, afterMs: dark.afterMs, rootBg: dark.rootBg, bodyBg: dark.bodyBg, prefersDark: dark.prefersDark },
      offMeasure: offMeasure && { attr: offMeasure.attr, rootBg: offMeasure.rootBg, bodyBg: offMeasure.bodyBg },
      mdnOwnBgLuminance: mdnOwnDark == null ? null : Math.round(mdnOwnDark * 1000) / 1000, mdnSwitchedLive: switched,
      back: { attr: back.attr, styles: back.darkraiStyles, afterMs: back.afterMs, rootBg: back.rootBg }
    };
    if (!switched) return { status: 'NOT RUN', evidence: mdnEvidence, reason: 'MDN did not switch its own theme live (own background luminance ' + mdnEvidence.mdnOwnBgLuminance + ' after the flip); YouTube fallback follows as P1-2c-yt' };
    const ok = before.attr === 'on' && dark.attr === 'native' && dark.styleNodes === 0 && dark.darkraiAdopted === 0 && dark.afterMs != null && back.attr === 'on' && back.darkraiStyles > 0;
    return {
      status: ok ? 'PASS' : 'FAIL', evidence: mdnEvidence,
      reason: ok ? '' : 'before ' + before.attr + '; after dark: data-darkrai="' + dark.attr + '", ' + dark.styleNodes + ' style nodes, ' + dark.darkraiAdopted + ' adopted; back to light: ' + back.attr + ' with ' + back.darkraiStyles + ' styles'
    };
  }, 60000);
  const c = checks.find((x) => x.id === 'P1-2c');
  if (c && c.status !== 'NOT RUN') return;
  await check('P1-2c-yt', 'P2', 'fallback: YouTube light -> dark live (no reload): Darkrai steps aside', async () => {
    const site = ctx.site;
    await site.scheme('light');
    await site.go('https://www.youtube.com/');
    const before = await site.settle();
    await site.scheme('dark');
    const after = await site.poll((o) => o.attr === 'native' && o.darkraiStyles === 0, 8000, 250);
    const final = after || await site.observe();
    const ytSwitched = !!final.ytDarkAttr;
    const steppedAside = final.attr === 'native' && final.styleNodes === 0 && final.darkraiAdopted === 0;
    // If YouTube itself does not switch without a reload, the page is still
    // light and Darkrai keeping it dark is the right outcome. But then the
    // case under test (a site switching its own theme while Darkrai is
    // applied) never happened, so this run proves nothing about it either
    // way: report NOT RUN rather than a PASS that was never exercised. The
    // runtime-theme-switch fixture covers the behaviour itself.
    const ok = before.attr === 'on' && (ytSwitched ? steppedAside : final.attr === 'on');
    if (ok && !ytSwitched) {
      return {
        status: 'NOT RUN',
        evidence: { before: { attr: before.attr, styles: before.darkraiStyles }, after: { attr: final.attr, ytDark: final.ytDarkAttr } },
        reason: 'YouTube did not switch its own theme without a reload, so the live-switch case could not be exercised on a real site (Darkrai correctly kept the still-light page dark); the runtime-theme-switch fixture covers it'
      };
    }
    return {
      status: ok ? 'PASS' : 'FAIL',
      note: ytSwitched ? 'YouTube switched its own theme live' : 'YouTube did NOT switch its own theme live (no <html dark> after the flip); Darkrai ' + (final.attr === 'on' ? 'kept darkening the still-light page' : 'went to ' + final.attr),
      evidence: { before: { attr: before.attr, styles: before.darkraiStyles, ytDark: before.ytDarkAttr }, after: { attr: final.attr, styleNodes: final.styleNodes, adopted: final.darkraiAdopted, ytDark: final.ytDarkAttr, afterMs: final.afterMs, rootBg: final.rootBg }, youtubeSwitchedItselfLive: ytSwitched },
      reason: ok ? '' : 'before ' + before.attr + '; after: YouTube own dark=' + ytSwitched + ', data-darkrai="' + final.attr + '", ' + final.styleNodes + ' style nodes, ' + final.darkraiAdopted + ' adopted'
    };
  }, 60000);
}

// ------------------------------------------------------------- problem 3

async function readable(url) {
  const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
  await check('P1-3 ' + url, 'P1', 'readability on darkened ' + url, async () => {
    const site = ctx.site;
    // Start every site from Darkrai switched on. A previous site that timed
    // out during its "off" comparison shot would otherwise leave Darkrai
    // disabled, and every later site would be misreported as "not darkened".
    await setStore('(st) => { st.enabled = true; }');
    await site.scheme('light');
    await site.go(url);
    const o = await site.settle();
    if (o.attr !== 'on') {
      return { status: 'FAIL', evidence: { attr: o.attr, url: o.url }, reason: 'Darkrai did not darken this light page (data-darkrai="' + o.attr + '")' };
    }
    await site.eval('window.scrollTo(0, 0)');
    await sleep(300);
    const on = await site.screenshot();
    fs.writeFileSync(path.join(OUT, slug + '-on.png'), on);
    const p = await site.eval(PROBE, null, 30000);
    const img = decodePNG(on);
    const icons = { measured: 0, below: 0, worst: [] };
    for (const ic of p.icons) {
      const r = iconContrast(img, ic);
      if (!r) continue;
      icons.measured++;
      if (r.ratio < 3) { icons.below++; icons.worst.push(Object.assign({ selector: ic.selector, kind: ic.kind }, r, { need: 3, box: [Math.round(ic.x), Math.round(ic.y), Math.round(ic.w), Math.round(ic.h)] })); }
    }
    icons.worst.sort((a, b) => a.ratio - b.ratio);
    icons.worst = icons.worst.slice(0, 5);
    // Light regions in the same shot, each explained by what is painted there.
    const lr = lightRegions(img);
    const pts = lr.regions.slice(0, 25).map((r) => ({ id: r.id, x: r.x, y: r.y }));
    let infos = [];
    try { infos = pts.length ? await site.eval(LIGHT_EXPLAIN(pts), null, 15000) : []; } catch (e) { infos = pts.map((p) => ({ id: p.id, verdict: { kind: 'probe-error: ' + e.message } })); }
    const light = { found: lr.regions.length, unexplained: 0, regions: [] };
    for (const r of lr.regions.slice(0, 25)) {
      const info = infos.find((i) => i && i.id === r.id);
      const ex = explainLight(r, info, img, lr.mask);
      if (!ex.explained) light.unexplained++;
      light.regions.push(Object.assign({}, r, ex, { stack: info && info.stack }));
    }
    // Darkrai off, live, for the comparison shot. Always switch it back on,
    // even when the screenshot fails (an occluded headed window can stall
    // Page.captureScreenshot), so the failure stays with this site.
    await setStore('(st) => { st.enabled = false; }');
    try {
      await site.poll((x) => x.attr !== 'on', 3000, 100);
      await sleep(700);
      fs.writeFileSync(path.join(OUT, slug + '-off.png'), await site.screenshot());
    } finally {
      await setStore('(st) => { st.enabled = true; }');
    }
    await site.poll((x) => x.attr === 'on', 4000, 100);
    const t = o.timing && o.timing.enabled ? { decisionMs: o.timing.decisionMs, firstPaintMs: o.timing.firstPaintMs, settleMs: o.timing.idleMs } : null;
    const entry = { url, finalUrl: o.url, text: p.text, icons, light: { found: light.found, unexplained: light.unexplained }, timing: t, shots: [slug + '-off.png', slug + '-on.png'] };
    readability.push(entry);
    // A separate check, so readability and "left light" are reported apart.
    const bad = light.regions.filter((r) => !r.explained);
    record('P1-3L ' + url, 'P1', 'no unexplained light regions on darkened ' + url, bad.length ? 'FAIL' : 'PASS',
      { finalUrl: o.url, found: light.found, unexplained: bad.length, regions: light.regions },
      bad.length ? bad.length + ' light region(s) not explained: ' + bad.slice(0, 4).map((r) => '[' + r.box.join(',') + '] ' + r.why).join('; ') : '');
    if (p.text.measured < 5) {
      return { status: 'NOT RUN', evidence: entry, reason: 'only ' + p.text.measured + ' text runs measurable at ' + o.url + ' (probe could not see the page), no verdict' };
    }
    const ok = p.text.below === 0 && icons.below === 0;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: entry,
      reason: ok ? '' : p.text.below + '/' + p.text.measured + ' text runs and ' + icons.below + '/' + icons.measured + ' icons below WCAG' +
        (o.url !== url ? ' (landed on ' + o.url + ')' : '')
    };
  }, 60000);
}

// ------------------------------------------------------------------ main

async function main() {
  if (!fs.existsSync(CHROME)) { console.log('SKIPPED: Google Chrome not found at ' + CHROME); return 0; }
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  const profile = path.join(PROFILE_ROOT, 'profile-' + Date.now());
  const b = await Browser.start({ chrome: CHROME, extension: EXTENSION, profile, logFile: path.join(OUT, 'chrome-' + RUN_ID + '.log') });
  ctx.b = b;
  console.log('Chrome: ' + b.version + '  extension id: ' + b.extId);
  let closeInfo = null;
  const cap = setTimeout(() => { console.log('overall cap hit, closing'); finish(b, 'cap').then((c) => process.exit(c)); }, OVERALL_CAP);
  try {
    // Close the about:blank start tab after our own site tab exists.
    const initial = (await b.targets()).filter((t) => t.type === 'page');
    ctx.site = await b.newTab('about:blank', {});
    for (const t of initial) await b.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => { });
    await ctx.site.activate();
    ctx.driver = await b.newTab('chrome-extension://' + b.extId + '/options/options.html', { background: true, role: 'options', metrics: false });
    await sleep(1500);

    // P1, problem 2
    if (want('problem2')) {
      await nativeCheck('P1-2a', 'P1', 'https://www.youtube.com/', 'dark', 'native');
      await nativeCheck('P1-2b', 'P1', 'https://www.youtube.com/', 'light', 'on');
      await liveSwitch();
    }

    // P1, problem 3 (debug flag on for the timing harness, off again after)
    if (want('problem3')) {
      await setStore('(st, s) => { s.debug = true; }').catch(() => { });
      for (const url of ['https://en.wikipedia.org/wiki/Moon', 'https://news.ycombinator.com/', 'https://developer.mozilla.org/en-US/docs/Web/CSS',
        'https://www.bbc.com/news', 'https://stackoverflow.com/questions', 'https://old.reddit.com/', 'https://www.youtube.com/']) {
        if (SITES.length && !SITES.some((s) => url.includes(s))) continue;
        await readable(url);
      }
      await setStore('(st, s) => { s.debug = false; }').catch(() => { });
    }

    // P1, problem 1
    if (want('problem1')) await problem1(ctx);

    // P4: every popup control end to end. After P1-1a, which needs the
    // service worker to fall asleep, and before P1-1d, which can leave the
    // extension disabled.
    if (want('p4')) await popupControls(ctx);

    // P2
    if (want('p2')) {
      await nativeCheck('P2-gh-dark', 'P2', 'https://github.com/', 'dark', 'native');
      await nativeCheck('P2-gh-light', 'P2', 'https://github.com/', 'light', 'on');
      await nativeCheck('P2-g-dark', 'P2', 'https://www.google.com/search?q=dark+mode', 'dark', 'native');
      await nativeCheck('P2-g-light', 'P2', 'https://www.google.com/search?q=dark+mode', 'light', 'on');
    }

    // P3
    if (want('p3')) await hardReset(ctx);

    // P1-1d last: an extension reload can leave the CDP-loaded copy disabled.
    if (want('problem1')) await reloadCheck(ctx);

    // P2: errors, the service worker last of all (attaching keeps it awake).
    if (want('p2')) await check('P2-errors', 'P2', 'exceptions and console errors (popup, options, isolated worlds, worker)', async () => {
      const sw = (await b.swTargets())[0];
      if (sw) { await b.attach(sw.targetId, 'service-worker').catch(() => { }); await sleep(1500); }
      const by = {};
      for (const e of b.errors) { by[e.where] = by[e.where] || { count: 0, first: [] }; by[e.where].count++; if (by[e.where].first.length < 5) by[e.where].first.push(e.kind + ': ' + e.text); }
      return {
        status: b.errors.length ? 'FAIL' : 'PASS',
        evidence: { byWhere: by, note: 'popups are attached after they open, so errors thrown before attach are not seen; the worker is only watched after the sleep test' },
        reason: b.errors.length ? b.errors.length + ' error(s) seen' : ''
      };
    });
  } catch (e) {
    record('HARNESS', 'P1', 'harness ran to the end', 'NOT RUN', null, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
  }
  clearTimeout(cap);
  return finish(b);
}

let finished = false;
async function finish(b, why) {
  if (finished) return 1;
  finished = true;
  let closeInfo = null;
  try { closeInfo = await b.close(); } catch (e) { closeInfo = { error: e.message }; }
  // A subset run keeps every other check from the previous run, tagged with it.
  const merged = [];
  if (ONLY.length && fs.existsSync(LATEST)) {
    try {
      const prevId = fs.readFileSync(LATEST, 'utf8').trim();
      const prev = JSON.parse(fs.readFileSync(path.join(RESULTS, prevId, 'report.json'), 'utf8'));
      const mine = new Set(checks.map((c) => c.id));
      for (const c of prev.checks) if (!mine.has(c.id)) merged.push(Object.assign({}, c, { fromRun: c.fromRun || prevId }));
      const urls = new Set(readability.map((x) => x.url));
      for (const x of prev.readability || []) if (!urls.has(x.url)) readability.push(Object.assign({}, x, { fromRun: x.fromRun || prevId }));
    } catch (e) { }
  }
  checks.unshift(...merged);
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(LATEST, RUN_ID);
  const p1 = checks.filter((c) => c.priority === 'P1');
  const p1Pass = p1.length > 0 && p1.every((c) => c.status === 'PASS');
  const report = { runId: RUN_ID, only: ONLY, chrome: b.version, extension: EXTENSION, extensionId: b.extId, durationS: Math.round((Date.now() - started) / 1000), stoppedBy: why || 'end', close: closeInfo, p1AllPass: p1Pass, checks, readability };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(REPORT_MD, markdown(report));
  console.log('report: ' + path.join(OUT, 'report.json'));
  console.log('P1 all pass: ' + p1Pass + '  (' + checks.filter((c) => c.status === 'PASS').length + ' PASS, ' +
    checks.filter((c) => c.status === 'FAIL').length + ' FAIL, ' + checks.filter((c) => c.status === 'NOT RUN').length + ' NOT RUN)');
  return p1Pass ? 0 : 1;
}

function short(v) {
  if (v == null) return '';
  const s = JSON.stringify(v);
  return (s.length > 400 ? s.slice(0, 400) + '...' : s).replace(/\|/g, '/');
}

function markdown(r) {
  const L = [];
  L.push('# Darkrai in real Google Chrome', '');
  L.push('> `results/` is generated locally by each run and is git-ignored, so the `results/...` paths below exist only on the machine that ran it. `evidence/` holds the committed copies of Darkrai\'s own UI screenshots (popup and dropdowns), never screenshots of third-party sites.', '');
  L.push('Run `' + r.runId + '` on ' + r.chrome + ', extension id `' + r.extensionId + '`, ' + r.durationS + ' s. Full evidence: `results/' + r.runId + '/report.json`.', '');
  L.push('Every P1 check passed: **' + (r.p1AllPass ? 'yes' : 'no') + '**. Browser closed with ' + (r.close && r.close.how) + ', throwaway profile removed: ' + (r.close && r.close.profileRemoved) + '.', '');
  L.push('Re-run from the repository\'s `tests` folder: `node real-chrome/run-real-chrome.js`', '');
  L.push('| ID | Pri | Check | Result | Evidence / reason |', '|---|---|---|---|---|');
  for (const c of r.checks) L.push('| ' + c.id + (c.fromRun ? ' (run ' + c.fromRun + ')' : '') + ' | ' + c.priority + ' | ' + c.name + ' | ' + c.status + ' | ' + (c.reason ? c.reason.replace(/\|/g, '/') + ' ' : '') + short(c.status === 'PASS' || !c.reason ? c.evidence : null) + ' |');
  L.push('');
  if (r.readability.length) {
    L.push('## Readability (problem 3)', '');
    L.push('Text: computed colour over the alpha-composited stack from `elementsFromPoint`; text over background images or inside an invert filter is counted as uncertain, not measured. Icons: real screenshot pixels, 90th-percentile pixel inside the box against the median of a ring 2 px outside it. Targets: 4.5:1 text, 3:1 large text and icons.', '');
    for (const s of r.readability) {
      L.push('### ' + s.url, '');
      L.push('Text ' + s.text.below + ' of ' + s.text.measured + ' below target (' + s.text.uncertain + ' uncertain' + (s.text.exempt ? ', ' + s.text.exempt + ' exempt: inside disabled controls' : '') + ')' + (s.light ? '; light regions ' + s.light.unexplained + ' unexplained of ' + s.light.found : '') + '; icons ' + s.icons.below + ' of ' + s.icons.measured + ' below 3:1. Screenshots: ' + s.shots.map((x) => '`results/' + r.runId + '/' + x + '`').join(', ') + '.');
      if (s.timing) L.push('Timing (ms since navigation start): decision ' + fmt(s.timing.decisionMs) + ', first paint ' + fmt(s.timing.firstPaintMs) + ', settle ' + fmt(s.timing.settleMs) + '.');
      L.push('');
      const rows = s.text.worst.map((w) => '| text | `' + w.selector.replace(/\|/g, '/') + '` "' + String(w.text).replace(/\|/g, '/') + '" | ' + w.fg + ' on ' + w.bg + ' | ' + w.ratio + ' < ' + w.need + ' |')
        .concat(s.icons.worst.map((w) => '| icon (' + w.kind + ') | `' + w.selector.replace(/\|/g, '/') + '` | ' + w.fg + ' on ' + w.bg + ' | ' + w.ratio + ' < 3 |'));
      if (rows.length) L.push('| Kind | Element | Colours | Ratio |', '|---|---|---|---|', ...rows, '');
    }
  }
  const shot = r.checks.find((c) => c.id === 'P4-shot' && c.status === 'PASS' && !c.fromRun);
  if (shot) L.push('## Popup (P4)', '', 'Real-Chrome screenshot of the popup: `results/' + r.runId + '/popup-real.png` (' + shot.evidence.width + 'x' + shot.evidence.height + ' px).', '');
  L.push('## Not automatable', '', '- The Alt+Shift+D key press itself: browser accelerators cannot be sent through CDP. P4-shortcut-key checks the binding with chrome.commands.getAll() and P4-shortcut-proxy calls the handler\'s toggleSite() for the active tab; the key press stays on the README manual checklist.', '');
  return L.join('\n');
}
function fmt(v) { return v == null ? 'n/a' : Math.round(v); }

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
