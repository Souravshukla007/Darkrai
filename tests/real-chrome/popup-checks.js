/*
 * Darkrai real-Chrome harness - popup-checks.js
 * P1 problem 1 (the toolbar icon always works), P3 (hard reset) and P4
 * (every popup control, end to end, in the real popup).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sleep, decodePNG, ratio, hex } = require('./lib');
const { OBSERVE_EXTRA } = require('./probe');

/** Chrome's default light-blue highlight: hue 195-230, light, chromatic (as UI family k). */
function isDefaultBlue(px) {
  const r = px[0] / 255, g = px[1] / 255, b = px[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
  if (c <= 0.06 || (max + min) / 2 < 0.55) return false;
  let h;
  if (max === r) h = 60 * (((g - b) / c) % 6);
  else if (max === g) h = 60 * ((b - r) / c + 2);
  else h = 60 * ((r - g) / c + 4);
  if (h < 0) h += 360;
  return h >= 195 && h <= 230;
}

const OPEN_POPUP = `(async () => {
  const w = await chrome.windows.getCurrent();
  const once = async () => { try { await chrome.windows.update(w.id, { focused: true }); } catch (e) { } await chrome.action.openPopup({ windowId: w.id }); };
  try { await once(); return 'ok'; }
  catch (e) {
    await new Promise((r) => setTimeout(r, 500));
    try { await once(); return 'ok after retry (first: ' + (e && e.message) + ')'; }
    catch (e2) { return 'error: ' + (e2 && e2.message || e2); }
  }
})()`;

const POPUP_READ = `(() => {
  const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const notice = document.getElementById('notice');
  return {
    fcpMs: fcp ? Math.round(fcp.startTime) : null,
    status: t('status-text'), host: t('host'),
    notice: notice && !notice.hidden ? notice.textContent.trim() : null,
    enabledChecked: document.getElementById('enabled').checked,
    mode: (document.querySelector('input[name=site-mode]:checked') || {}).value || null,
    bodyText: document.body.innerText.trim().length,
    dot: document.getElementById('dot').getAttribute('data-state')
  };
})()`;

// Long tasks in the page's main world from now on (P1-1c).
const LONGTASK_START = `(() => {
  window.__drLT = []; window.__drLT0 = performance.now();
  try {
    if (window.__drLTObs) window.__drLTObs.disconnect();
    window.__drLTObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__drLT.push([e.startTime, e.duration]); });
    window.__drLTObs.observe({ type: 'longtask' });
    return 'observing';
  } catch (e) { return 'error: ' + e.message; }
})()`;
const LONGTASK_READ = `(() => {
  const t0 = window.__drLT0 || 0;
  const l = (window.__drLT || []).filter((x) => x[0] >= t0);
  return { count: l.length, longestMs: Math.round(l.reduce((a, x) => Math.max(a, x[1]), 0)),
    tbtMs: Math.round(l.reduce((a, x) => a + Math.max(0, x[1] - 50), 0)),
    windowMs: Math.round(performance.now() - t0), top: l.map((x) => Math.round(x[1])).sort((a, b) => b - a).slice(0, 5) };
})()`;
// A probe that gets no answer at all within this long is counted as unanswered.
const PROBE_CAP_MS = 5000;

function summariseProbes(list) {
  const part = (ph) => {
    const xs = list.filter((x) => x.phase === ph);
    const got = xs.filter((x) => x.ms != null).map((x) => x.ms);
    return { n: xs.length, unanswered: xs.length - got.length, maxMs: got.length ? Math.max(...got) : null, medianMs: got.length ? got.sort((a, b) => a - b)[got.length >> 1] : null };
  };
  const answered = list.filter((x) => x.ms != null).map((x) => x.ms);
  return {
    n: list.length,
    unanswered: list.length - answered.length,
    maxMs: answered.length ? Math.max(...answered) : null,
    over1s: answered.filter((ms) => ms >= 1000).length,
    during: part('toggling'),
    after: part('after')
  };
}

async function popupTargets(b) {
  return (await b.targets()).filter((t) => t.url.startsWith('chrome-extension://' + b.extId + '/popup/popup.html'));
}

/**
 * Darkrai switched on and no entry of the test site's own (nor of a parent
 * domain), so a check that failed earlier cannot leak its state into the
 * popup checks. extra(settings, sites) can reset more.
 */
async function cleanSlate(driver, host, extra) {
  return driver.eval(`(async () => {
    const s = await chrome.storage.local.get(null);
    const st = s.settings || {};
    const sites = s.sites || {};
    const host = ${JSON.stringify(host)};
    st.enabled = true;
    for (const k of Object.keys(sites)) if (k === host || host.endsWith('.' + k)) delete sites[k];
    (${extra || '() => { }'})(st, sites);
    await chrome.storage.local.set({ settings: st, sites });
    return { settings: st, sites };
  })()`);
}

async function openPopup(ctx, driver) {
  const b = ctx.b;
  for (const t of await popupTargets(b)) { try { await b.cdp.send('Target.closeTarget', { targetId: t.targetId }); } catch (e) { } }
  await sleep(200);
  const t0 = Date.now();
  const result = await driver.eval(OPEN_POPUP, null, 10000);
  let target = null;
  for (let i = 0; i < 50 && !target; i++) { target = (await popupTargets(b))[0]; if (!target) await sleep(100); }
  if (!target) return { result, popup: null, ms: Date.now() - t0 };
  const popup = await b.attach(target.targetId, 'popup');
  return { result, popup, ms: Date.now() - t0 };
}

/** Wait for the state line to leave its placeholder. */
async function readPopup(popup, ms) {
  const end = Date.now() + (ms || 3000);
  let r = null;
  while (Date.now() < end) {
    r = await popup.eval(POPUP_READ);
    if (r.status && !/^Checking this tab/.test(r.status) && !/^Waiting for this tab/.test(r.status)) return r;
    await sleep(100);
  }
  return r;
}

function goodStatus(r) {
  return !!(r && r.status && r.bodyText > 0 && !/loading|error|undefined|null/i.test(r.status) &&
    !/^Checking this tab/.test(r.status));
}

async function newDriver(ctx, tries) {
  const url = 'chrome-extension://' + ctx.b.extId + '/options/options.html';
  const d = await ctx.b.newTab(url, { background: true, role: 'options', metrics: false });
  // Right after a reload the page can come up before the extension is back.
  for (let i = 0; i < (tries || 20); i++) {
    const ok = await d.eval('typeof chrome === "object" && !!chrome.windows && !!chrome.storage').catch(() => false);
    if (ok) return d;
    await sleep(500);
    if (i % 6 === 5) await d.go(url).catch(() => { });
  }
  throw new Error('driver page has no extension APIs (extension not loaded?)');
}

/** Painted: an FCP entry, any paint entry, or a screenshot that is not one flat colour. */
async function painted(popup, r) {
  const paints = await popup.eval(`performance.getEntriesByType('paint').map((e) => e.name + ':' + Math.round(e.startTime))`).catch(() => []);
  let colours = null;
  try {
    const img = decodePNG(await popup.screenshot({ clip: false }));
    const set = new Set();
    for (let i = 0; i < img.px.length && set.size < 50; i += 3 * 37) set.add(img.px[i] + ',' + img.px[i + 1] + ',' + img.px[i + 2]);
    colours = set.size;
  } catch (e) { colours = 'screenshot failed: ' + e.message; }
  return { fcpMs: r.fcpMs, paintEntries: paints, screenshotColours: colours, ok: r.fcpMs != null || paints.length > 0 || (typeof colours === 'number' && colours > 3) };
}

async function problem1(ctx) {
  const { b, check } = ctx;
  const SITE = 'https://en.wikipedia.org/wiki/Moon';
  let site = ctx.site;
  let driver = null, popup = null, before = null;
  // An earlier failure (a readability site that timed out with Darkrai
  // switched off, say) must not decide what the popup checks see.
  if (ctx.driver) await cleanSlate(ctx.driver, 'en.wikipedia.org').catch(() => { });

  await check('P1-1a', 'P1', 'popup opens and is filled while the service worker is asleep', async () => {
    await site.scheme('light');
    await site.go(SITE);
    await site.activate();
    before = await site.settle();
    if (ctx.driver) { await ctx.driver.close(); ctx.driver = null; }
    driver = await newDriver(ctx);
    await site.activate();
    // Hands off: no navigations, nothing attached to the worker.
    const t0 = Date.now();
    await sleep(35000);
    let sw = await b.swTargets();
    while (sw.length && Date.now() - t0 < 45000) { await sleep(2000); sw = await b.swTargets(); }
    let asleepBy = sw.length ? null : 'idle timeout (' + Math.round((Date.now() - t0) / 1000) + ' s)';
    if (sw.length) {
      const spare = await b.newTab('chrome://serviceworker-internals/', { background: true, role: null, metrics: false });
      await sleep(1500);
      const clicked = await spare.eval(`(() => {
        const id = ${JSON.stringify(b.extId)};
        const regs = [...document.querySelectorAll('.serviceworker-registration, .serviceworker-version, div')]
          .filter((d) => d.innerText && d.innerText.includes(id));
        for (const r of regs.reverse()) { const btn = r.querySelector('button.stop, button[class*=stop]'); if (btn) { btn.click(); return true; } }
        return false;
      })()`).catch((e) => 'error ' + e.message);
      await spare.close();
      await sleep(1500);
      sw = await b.swTargets();
      asleepBy = sw.length ? null : 'chrome://serviceworker-internals Stop (clicked=' + clicked + ')';
    }
    await site.activate();
    const o = await openPopup(ctx, driver);
    popup = o.popup;
    if (!popup) return { status: 'FAIL', evidence: { openPopup: o.result, asleepBy }, reason: 'no popup target appeared (' + o.result + ')' };
    const r = await readPopup(popup, 3000);
    const swAtRead = (await b.swTargets()).length;
    const paint = await painted(popup, r);
    const host = 'en.wikipedia.org';
    const expected = before && before.attr === 'on' ? 'Darkened by Darkrai' : null;
    const ok = !!asleepBy && paint.ok && goodStatus(r) && r.host === host && (!expected || r.status === expected);
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { openPopup: o.result, popupTargetAfterMs: o.ms, asleepBy, serviceWorkerRunningAtRead: swAtRead > 0, popup: r, paint, siteBefore: before && before.attr },
      reason: ok ? '' : [!asleepBy && 'service worker never went to sleep', !paint.ok && 'no evidence the popup painted',
        !goodStatus(r) && 'state line not filled: "' + r.status + '"', r.host !== host && 'host shown "' + r.host + '"',
        expected && r.status !== expected && 'state "' + r.status + '" != "' + expected + '"'].filter(Boolean).join('; ')
    };
    // The idle wait alone is 35-45 s by design, before the popup is even
    // opened, so the default 45 s per-check timeout cut this check off
    // whenever Chrome took a few seconds longer to stop the worker.
  }, 120000);

  await check('P1-1b', 'P1', 'Never / Auto in the popup apply to the tab within 1 s, no reload', async () => {
    if (!popup) return { status: 'NOT RUN', reason: 'no popup from P1-1a' };
    const navs = [];
    const off = b.cdp.on((m) => { if (m.sessionId === site.sessionId && m.method === 'Page.frameNavigated' && !m.params.frame.parentId) navs.push(m.params.frame.url); });
    await popup.click('#mode-off', 'label[for=mode-off]');
    const o1 = await site.poll((o) => o.attr !== 'on' && o.darkraiStyles === 0, 1000);
    await sleep(300);
    await popup.click('#mode-auto', 'label[for=mode-auto]');
    const o2 = await site.poll((o) => o.attr === 'on' && o.darkraiStyles > 0, 2000);
    off();
    const ok = o1 && o1.afterMs != null && o2 && o2.afterMs != null && navs.length === 0;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { neverAfterMs: o1 && o1.afterMs, neverAttr: o1 && o1.attr, neverStyles: o1 && o1.darkraiStyles, autoAfterMs: o2 && o2.afterMs, autoAttr: o2 && o2.attr, autoStyles: o2 && o2.darkraiStyles, reloads: navs.length },
      reason: ok ? '' : 'Never took ' + (o1 && o1.afterMs) + ' ms (attr ' + (o1 && o1.attr) + ', ' + (o1 && o1.darkraiStyles) + ' styles); Auto ' + (o2 && o2.afterMs) + ' ms; reloads ' + navs.length
    };
  });

  let perf = null;
  await check('P1-1c', 'P1', '20 rapid master-switch toggles end consistent, no style leaks', async () => {
    if (!popup) return { status: 'NOT RUN', reason: 'no popup from P1-1a' };
    const pre = await site.settle(6000);
    // Main-thread health while the switch is flicked: long tasks in the page's
    // main world, and how long the tab takes to answer Runtime.evaluate.
    const ltStarted = await site.eval(LONGTASK_START).catch((e) => 'error: ' + e.message);
    const probes = [];
    let phase = 'toggling', probing = true;
    const t0 = Date.now();
    const prober = (async () => {
      while (probing) {
        const at = Date.now();
        let ms = null;
        try { await site.send('Runtime.evaluate', { expression: '1', returnByValue: true }, PROBE_CAP_MS); ms = Date.now() - at; } catch (e) { ms = null; }
        probes.push({ phase, atMs: at - t0, ms });
        await sleep(200);
      }
    })();
    for (let i = 0; i < 20; i++) { await popup.click('#enabled', 'label.switch .track'); await sleep(20); }
    phase = 'after';
    await sleep(1500);
    const store = await driver.eval('chrome.storage.local.get(null)');
    const pr = await popup.eval(POPUP_READ);
    const post = await site.settle(6000);
    probing = false;
    await prober;
    const lt = await site.eval(LONGTASK_READ).catch((e) => ({ error: e.message }));
    perf = { longtaskObserver: ltStarted, longtasks: lt, probes: summariseProbes(probes) };
    const stored = store.settings.enabled;
    if (stored !== true) {
      await driver.eval(`(async () => { const s = await chrome.storage.local.get(null); s.settings.enabled = true; await chrome.storage.local.set({ settings: s.settings }); })()`);
      await site.settle(6000);
    }
    const final = await site.observe();
    const agree = stored === pr.enabledChecked && (stored ? post.attr === 'on' : post.attr !== 'on');
    // The baseline taken right after P1-1b can hold override nodes a fresh
    // apply would not; a fresh load of the same page is the honest reference.
    const fresh = await b.newTab(SITE, { scheme: 'light' });
    const freshO = await fresh.settle();
    await fresh.close();
    await site.activate();
    const sig = (o) => JSON.stringify(o.styleGroups) + '/' + o.darkraiAdopted;
    const noLeak = final.duplicateStyles === 0 && (sig(final) === sig(pre) || sig(final) === sig(freshO));
    return {
      status: agree && noLeak ? 'PASS' : 'FAIL',
      evidence: { storedEnabled: stored, switchChecked: pr.enabledChecked, pageAttr: post.attr, equalsFreshLoad: sig(final) === sig(freshO), before: { styles: pre.styleGroups, adopted: pre.darkraiAdopted }, after: { styles: final.styleGroups, adopted: final.darkraiAdopted, duplicates: final.duplicateStyles }, freshLoad: { styles: freshO.styleGroups, adopted: freshO.darkraiAdopted } },
      reason: (agree ? '' : 'storage/switch/page disagree; ') + (noLeak ? '' : 'style set after toggling matches neither the baseline nor a fresh load, or has duplicates')
    };
    // Two settles of up to 6 s, plus a fresh load of the page for reference:
    // more than the default 45 s on a slow page.
  }, 90000);

  // The same 20 toggles, judged on the page's main thread: every probe of the
  // tab answered within 1 s, during and after the toggles, and no long task
  // reached 200 ms.
  if (perf) {
    const p = perf.probes;
    const lt = perf.longtasks || {};
    const ok = p.unanswered === 0 && p.maxMs != null && p.maxMs < 1000 && typeof lt.longestMs === 'number' && lt.longestMs < 200;
    ctx.record('P1-1c-main-thread', 'P1', '20 rapid toggles: the tab answers within 1 s at every probe, no task of 200 ms or more', ok ? 'PASS' : 'FAIL', perf,
      ok ? '' : 'slowest answer ' + (p.unanswered ? 'none within ' + PROBE_CAP_MS + ' ms (' + p.unanswered + ' probe(s))' : p.maxMs + ' ms') + ', longest task ' + lt.longestMs + ' ms, total blocking ' + lt.tbtMs + ' ms');
  } else {
    ctx.record('P1-1c-main-thread', 'P1', '20 rapid toggles: the tab answers within 1 s at every probe, no task of 200 ms or more', 'NOT RUN', null, 'P1-1c did not get as far as the toggles');
  }

  ctx.driver = driver;
  await restrictedPages(ctx, driver);
  await site.activate();

  ctx.record('P1-1f', 'P1', 'keyboard shortcut Alt+Shift+D (the physical key press)', 'NOT RUN', null,
    'browser accelerators cannot be triggered through CDP; P4-shortcut-key checks the binding and P4-shortcut-proxy the handler, the key press itself stays on the README manual checklist');
}

/**
 * P1-1d runs last of all: in this harness an extension added with
 * Extensions.loadUnpacked has not come back from chrome.runtime.reload(),
 * which would take every later check down with it.
 */
async function reloadCheck(ctx) {
  const { b, check } = ctx;
  const SITE = 'https://en.wikipedia.org/wiki/Moon';
  const site = ctx.site;
  let driver = ctx.driver || await newDriver(ctx);
  let popup = null;
  await cleanSlate(driver, 'en.wikipedia.org').catch(() => { });
  await site.scheme('light');
  await site.go(SITE);
  await site.settle();
  await site.activate();

  await check('P1-1d', 'P1', 'after an extension reload the old tab still responds, one copy of styles', async () => {
    const pre = await site.observe();
    try { await driver.eval('chrome.runtime.reload()', null, 3000); } catch (e) { }
    popup = null; driver = null; ctx.driver = null;
    let sw = [];
    for (let i = 0; i < 24 && !sw.length; i++) { await sleep(250); sw = await b.swTargets(); }
    await sleep(1500);
    let reloadedBy = 'chrome.runtime.reload()';
    const tReload = Date.now();
    try { driver = await newDriver(ctx, 50); reloadedBy += ', extension back after ' + Math.round((Date.now() - tReload) / 1000) + ' s'; }
    catch (e) {
      // An extension added with Extensions.loadUnpacked may not come back from
      // chrome.runtime.reload(); loading the same path again is the same reload.
      reloadedBy = 'chrome.runtime.reload() left the extension unloaded; reloaded with Extensions.loadUnpacked again';
      const r = await b.cdp.send('Extensions.loadUnpacked', { path: ctx.extension }, null, 20000);
      b.extId = r.id;
      for (let i = 0; i < 24 && !sw.length; i++) { await sleep(250); sw = await b.swTargets(); }
      await sleep(1000);
      try { driver = await newDriver(ctx); }
      catch (e2) {
        return {
          status: 'NOT RUN', evidence: { newWorker: sw.length > 0, reloadedBy },
          reason: 'harness limit: after chrome.runtime.reload() the CDP-loaded unpacked extension stayed disabled, also after a second Extensions.loadUnpacked and with developer_mode set in the profile (see crbug.com/402532200); needs the manual check: reload at chrome://extensions, then use an old tab'
        };
      }
    }
    ctx.driver = driver;
    await site.activate();
    const o = await openPopup(ctx, driver);
    if (!o.popup) return { status: 'FAIL', evidence: { openPopup: o.result, newWorker: sw.length > 0, reloadedBy }, reason: 'popup did not open after reload' };
    popup = o.popup;
    const pr = await readPopup(popup, 3000);
    await popup.click('#mode-off', 'label[for=mode-off]');
    const offO = await site.poll((x) => x.attr !== 'on' && x.darkraiStyles === 0, 1500);
    await sleep(300);
    await popup.click('#mode-auto', 'label[for=mode-auto]');
    const onO = await site.poll((x) => x.attr === 'on' && x.darkraiStyles > 0, 3000);
    const oldTab = await site.settle(8000);
    const fresh = await b.newTab(SITE, { scheme: 'light' });
    const freshO = await fresh.settle();
    await fresh.close();
    await site.activate();
    const sameCopy = JSON.stringify(oldTab.styleGroups) === JSON.stringify(freshO.styleGroups) && oldTab.darkraiAdopted === freshO.darkraiAdopted;
    const ok = sw.length > 0 && offO && offO.afterMs != null && onO && onO.afterMs != null && sameCopy;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { reloadedBy, newWorker: sw.length > 0, popupStatus: pr && pr.status, beforeReload: pre.styleGroups, neverAfterMs: offO && offO.afterMs, autoAfterMs: onO && onO.afterMs, oldTab: { groups: oldTab.styleGroups, adopted: oldTab.darkraiAdopted, worlds: oldTab.isolatedWorlds }, freshTab: { groups: freshO.styleGroups, adopted: freshO.darkraiAdopted } },
      reason: ok ? '' : [!sw.length && 'no new service worker', !(offO && offO.afterMs != null) && 'old tab did not drop styles on Never', !(onO && onO.afterMs != null) && 'old tab did not come back on Auto', !sameCopy && 'old tab style set differs from a fresh load'].filter(Boolean).join('; ')
    };
  }, 100000);
  await site.activate();
}

async function restrictedPages(ctx, driver) {
  const { b, check } = ctx;
  const restricted = [
    ['chrome://extensions/', /doesn't allow/i],
    ['chrome://settings/', /doesn't allow/i],
    ['https://chromewebstore.google.com/', /doesn't allow/i],
    ['https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', /doesn't allow/i]
  ];
  for (const [url, re] of restricted) {
    await check('P1-1e ' + url, 'P1', 'popup explains restricted page ' + url, async () => {
      if (!driver) return { status: 'NOT RUN', reason: 'no driver page' };
      const tab = await b.newTab(url, { role: null, metrics: false });
      await sleep(2000);
      await tab.activate();
      const o = await openPopup(ctx, driver);
      if (!o.popup) { await tab.close(); return { status: 'FAIL', evidence: { openPopup: o.result }, reason: 'no popup' }; }
      const r = await readPopup(o.popup, 3000);
      await tab.close();
      const ok = r && r.bodyText > 0 && re.test(r.status || '') ;
      return { status: ok ? 'PASS' : 'FAIL', evidence: r, reason: ok ? '' : 'state line "' + (r && r.status) + '", notice "' + (r && r.notice) + '"' };
    });
  }
}

async function hardReset(ctx) {
  const { b, check } = ctx;
  await check('P3-reset', 'P3', 'hard reset from options.html#danger restores factory defaults', async () => {
    const defaults = require(path.join(ctx.extension, 'shared', 'settings.js')).defaults();
    const site = ctx.site;
    const driver = ctx.driver || await newDriver(ctx);
    await driver.eval(`(async () => {
      const s = await chrome.storage.local.get(null);
      s.sites = s.sites || {}; s.sites['wikipedia.org'] = { mode: 'off' };
      s.settings.look = 'black';
      await chrome.storage.local.set({ sites: s.sites, settings: s.settings });
    })()`);
    await sleep(800);
    const changed = await site.observe();
    const opt = await b.newTab('chrome-extension://' + b.extId + '/options/options.html#danger', { role: 'options', metrics: false });
    await opt.activate();
    await sleep(1000);
    await opt.click('#reset');
    await sleep(400);
    await opt.click('#reset-go');
    await sleep(400);
    const stage2 = await opt.eval(`document.getElementById('reset-go').textContent`);
    await opt.click('#reset-go');
    let status = '';
    for (let i = 0; i < 60; i++) {
      status = await opt.eval(`document.getElementById('reset-dialog-status').textContent`).catch(() => status);
      if (/Done|Partly/.test(status)) break;
      await sleep(250);
    }
    await sleep(800);
    const steps = await opt.eval(`[...document.querySelectorAll('#reset-dialog-result li')].map((li) => li.textContent.trim())`).catch(() => []);
    const store = await opt.eval('chrome.storage.local.get(null)');
    const scripts = await opt.eval('chrome.scripting.getRegisteredContentScripts()');
    const alarms = await opt.eval('chrome.alarms.getAll()');
    await site.activate();
    const after = await site.settle(8000);
    await opt.close();
    const norm = (o) => JSON.stringify(o, Object.keys(o).sort());
    const deep = (o) => JSON.stringify(sortKeys(o));
    const storeOk = deep(store) === deep(defaults);
    const preloadOk = scripts.some((s) => s.id === 'darkrai-preload');
    const alarmsOk = alarms.length === 0;
    const tabOk = after.attr === 'on' && after.darkraiStyles > 0;
    void norm;
    const dialogOk = /^Done/.test(status);
    const ok = storeOk && preloadOk && alarmsOk && tabOk && dialogOk;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { changedTabAttr: changed.attr, stage2Button: stage2, dialogStatus: status, dialogSteps: steps, store, registered: scripts.map((s) => s.id), alarms: alarms.map((a) => a.name), tabAfter: { attr: after.attr, styles: after.styleGroups } },
      reason: ok ? '' : [!storeOk && 'storage != defaults()', !preloadOk && 'darkrai-preload not registered', !alarmsOk && 'stray alarms', !tabOk && 'open tab not back on defaults (attr ' + after.attr + ')', !dialogOk && 'dialog reported: ' + status].filter(Boolean).join('; ')
    };
  });
}

function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o).sort()) r[k] = sortKeys(o[k]); return r; }
  return o;
}

// ------------------------------------------------------------------- P4

const P4_SITE = 'https://en.wikipedia.org/wiki/Moon';
const P4_HOST = 'en.wikipedia.org';
const P4_RESET = `(st, sites) => {
  if (st.schedule) st.schedule.type = 'always';
  st.brightness = 100;
  delete sites['youtube.com']; delete sites['example.org'];
}`;

// Every value a reader can see in the popup (persistence compares these).
const POPUP_STATE = `(() => {
  const g = (id) => document.getElementById(id);
  const v = (id) => { const e = g(id); return e ? (e.type === 'checkbox' ? e.checked : e.value) : null; };
  const t = (id) => { const e = g(id); return e ? e.textContent.trim() : null; };
  const r = (name) => (document.querySelector('input[name="' + name + '"]:checked') || {}).value || null;
  const hours = g('hours');
  return {
    enabled: v('enabled'), siteMode: r('site-mode'), engine: r('engine'),
    look: v('look'), brightness: v('brightness'), contrast: v('contrast'), warmth: v('warmth'),
    dimImages: v('dim-images'), lookSummary: t('look-summary'),
    schedule: v('schedule'), from: v('from'), to: v('to'),
    hoursShown: !!hours && !hours.hidden && hours.getClientRects().length > 0,
    status: t('status-text'), host: t('host'), shortcut: t('shortcut')
  };
})()`;

// The fit in the real popup (the same rules as family (f) in
// tests/browser/ui-probe.js sizes()): the page, the scrolling screen panel,
// the panel's scrollbar and content width, and every element whose own text
// does not fit its box. Decorative, hidden and closed-<details> boxes are skipped.
const FIT = `(() => {
  const panel = document.getElementById('panel');
  const pcs = getComputedStyle(panel);
  const px = (v) => parseFloat(v) || 0;
  const decorative = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.getAttribute('aria-hidden') === 'true' || n.getAttribute('role') === 'presentation' || n.hasAttribute('hidden')) return true; } return false; };
  const visible = (el) => { const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible' || px(cs.opacity) === 0) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect(); return r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : ''));
  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    if (decorative(el) || !visible(el)) continue;
    let own = false;
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\\S/.test(n.nodeValue || '')) { own = true; break; }
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'inline' || cs.display === 'contents') continue;
    if (el.scrollWidth > el.clientWidth + 1) clipped.push(name(el) + ' ' + el.scrollWidth + 'px of text in ' + el.clientWidth + 'px');
    if (el !== panel && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') && el.scrollHeight > el.clientHeight + 1) clipped.push(name(el) + ' ' + el.scrollHeight + 'px tall in ' + el.clientHeight + 'px');
  }
  return {
    innerWidth, innerHeight,
    bodyWidth: Math.round(document.body.getBoundingClientRect().width * 100) / 100,
    pageScrollHeight: document.documentElement.scrollHeight, pageClientHeight: document.documentElement.clientHeight,
    panelOverflowY: pcs.overflowY, panelScrollHeight: panel.scrollHeight, panelClientHeight: panel.clientHeight,
    panelScrollbar: panel.offsetWidth - panel.clientWidth - px(pcs.borderLeftWidth) - px(pcs.borderRightWidth),
    panelContentWidth: Math.round((panel.clientWidth - px(pcs.paddingLeft) - px(pcs.paddingRight)) * 100) / 100,
    schedule: (document.getElementById('schedule') || {}).value, lookOpen: !!(document.getElementById('look-details') || {}).open,
    clipped
  };
})()`;

// Where a reader would click to operate control #id: the control itself, or
// the label that operates it when the control is visually hidden. The point
// is hit-tested, so a covered control is reported rather than clicked.
const POINT = (id) => `(() => {
  const e = document.getElementById(${JSON.stringify(id)});
  if (!e) return { missing: true };
  if (e.disabled) return { disabled: true };
  const hits = (x, y) => {
    const t = document.elementFromPoint(x, y);
    if (!t) return false;
    if (t === e || e.contains(t)) return true;
    const l = t.closest && t.closest('label');
    return !!(l && l.control === e);
  };
  const cands = [e, document.querySelector('label[for="' + e.id + '"]'), e.closest('label')].filter(Boolean);
  let first = null;
  for (const n of cands) {
    n.scrollIntoView({ block: 'center', inline: 'center' });
    const b = n.getBoundingClientRect();
    if (b.width < 4 || b.height < 4) continue;
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    if (hits(x, y)) return { x, y, via: n === e ? 'control' : 'label' };
    if (!first) first = { x, y, via: 'unverified ' + n.tagName.toLowerCase() };
  }
  return first || { hidden: true };
})()`;

// Native <select> lists and time fields are drawn outside the page, where CDP
// mouse events cannot reach: set the value and fire what a reader's choice fires.
const SET_VALUE = (id, value) => `(() => {
  const e = document.getElementById(${JSON.stringify(id)});
  if (!e) return 'missing';
  if (e.disabled) return 'disabled';
  e.focus();
  e.value = ${JSON.stringify(value)};
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return e.value;
})()`;

async function until(fn, ms, every) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    await sleep(every || 150);
  }
  return null;
}

const storeOf = (driver) => driver.eval('chrome.storage.local.get(null)');
const alarmOf = (driver) => driver.eval(`chrome.alarms.get('darkrai-schedule').then((a) => a ? { name: a.name, when: new Date(a.scheduledTime).toString() } : null)`);
const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const unclickable = (pt, id) => pt.missing ? 'the popup has no #' + id : pt.disabled ? '#' + id + ' is disabled' : pt.hidden ? '#' + id + ' has no visible box' : null;

function watchNavs(b, tab) {
  const navs = [];
  const off = b.cdp.on((m) => {
    if (m.sessionId === tab.sessionId && m.method === 'Page.frameNavigated' && !m.params.frame.parentId) navs.push(m.params.frame.url);
  });
  return { navs, off };
}

/** P4: every control in the real popup, end to end, on a real page. */
async function popupControls(ctx) {
  const { b, check, record } = ctx;
  const site = ctx.site;
  const driver = ctx.driver || await newDriver(ctx);
  ctx.driver = driver;
  let popup = null;

  const closePopup = async () => {
    for (const t of await popupTargets(b)) await b.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => { });
    popup = null;
    await sleep(300);
  };
  const ensurePopup = async () => {
    if (popup && (await popupTargets(b)).some((t) => t.targetId === popup.targetId)) return popup;
    popup = null;
    await site.activate();
    const o = await openPopup(ctx, driver);
    if (!o.popup) throw new Error('popup did not open (' + o.result + ')');
    popup = o.popup;
    await readPopup(popup, 3000);
    await sleep(250);
    return popup;
  };
  // A real click where a reader would click. Buttons that close the popup
  // can take the session with them before the click is acknowledged.
  const tap = async (id) => {
    const p = await ensurePopup();
    const pt = await p.eval(POINT(id));
    if (unclickable(pt, id)) return pt;
    await p.clickAt(pt.x, pt.y).catch((e) => { pt.clickError = e.message; });
    return pt;
  };
  const toWiki = async () => {
    await site.scheme('light');
    const href = await site.eval('location.href').catch(() => '');
    if (href !== P4_SITE) await site.go(P4_SITE);
    return site.settle(8000);
  };
  const failNoClick = (pt, id) => ({ status: 'FAIL', evidence: pt, reason: unclickable(pt, id) });

  await cleanSlate(driver, P4_HOST, P4_RESET).catch(() => { });

  await check('P4-always-youtube', 'P4', 'This site: Always on YouTube in its own dark theme turns Darkrai on, Auto hands it back (no reload)', async () => {
    await closePopup();
    try {
      await site.scheme('dark');
      await site.go('https://www.youtube.com/');
      const o0 = await site.settle();
      if (o0.attr !== 'native') {
        return { status: 'NOT RUN', evidence: { attr: o0.attr, url: o0.url }, reason: 'YouTube did not come up in its own dark theme under prefers-color-scheme dark (data-darkrai="' + o0.attr + '"), so there was no native page to override' };
      }
      const w = watchNavs(b, site);
      let on = null, back = null, popupOn = null, t1, t2;
      try {
        t1 = await tap('mode-on');
        if (unclickable(t1, 'mode-on')) return failNoClick(t1, 'mode-on');
        on = await site.poll((o) => o.attr === 'on' && o.darkraiStyles > 0, 3000, 100);
        popupOn = await popup.eval(POPUP_STATE).catch(() => null);
        t2 = await tap('mode-auto');
        if (unclickable(t2, 'mode-auto')) return failNoClick(t2, 'mode-auto');
        back = await site.poll((o) => o.attr === 'native' && o.darkraiStyles === 0, 5000, 100);
      } finally { w.off(); }
      const entry = ((await storeOf(driver)).sites || {})['youtube.com'] || null;
      const ok = !!(on && on.afterMs != null && back && back.afterMs != null) && w.navs.length === 0;
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: { alwaysAfterMs: on && on.afterMs, alwaysStyles: on && on.darkraiStyles, popupWhileAlways: popupOn && { siteMode: popupOn.siteMode, status: popupOn.status }, autoAfterMs: back && back.afterMs, autoAttr: back && back.attr, autoStyles: back && back.darkraiStyles, storedEntry: entry, reloads: w.navs.length, clickedVia: [t1.via, t2.via] },
        reason: ok ? '' : 'Always: ' + (on && on.afterMs != null ? 'on after ' + on.afterMs + ' ms' : 'page not darkened (attr ' + (on && on.attr) + ')') + '; Auto: ' + (back && back.afterMs != null ? 'native after ' + back.afterMs + ' ms' : 'not handed back (attr ' + (back && back.attr) + ', ' + (back && back.darkraiStyles) + ' styles)') + '; reloads ' + w.navs.length
      };
    } finally {
      await closePopup();
      await toWiki();
    }
  }, 75000);

  await check('P4-master', 'P4', 'master switch off then on: the page drops its styles and gets them back, no reload', async () => {
    const pre = await toWiki();
    if (pre.attr !== 'on') return { status: 'FAIL', evidence: { attr: pre.attr, url: pre.url }, reason: 'the light page was not darkened before the switch was touched (data-darkrai="' + pre.attr + '")' };
    const w = watchNavs(b, site);
    let off = null, on = null, offStore, onStore, offPopup = null, offPick = null, t1, t2;
    try {
      t1 = await tap('enabled');
      if (unclickable(t1, 'enabled')) return failNoClick(t1, 'enabled');
      off = await site.poll((o) => o.attr !== 'on' && o.darkraiStyles === 0, 2000, 100);
      offStore = (await storeOf(driver)).settings.enabled;
      offPopup = await popup.eval(POPUP_STATE).catch(() => null);
      // What "Fix something unreadable" tells a reader while Darkrai is off for this tab.
      offPick = await popup.eval(`(() => { const b = document.getElementById('pick'), h = document.getElementById('pick-help');
        return { disabled: !!(b && b.disabled), help: h ? h.textContent.trim() : null }; })()`).catch(() => null);
      t2 = await tap('enabled');
      on = await site.poll((o) => o.attr === 'on' && o.darkraiStyles > 0, 3000, 100);
      onStore = (await storeOf(driver)).settings.enabled;
    } finally { w.off(); }
    const offText = offPopup && offPopup.status;
    const ok = !!(off && off.afterMs != null && on && on.afterMs != null) && offStore === false && onStore === true &&
      w.navs.length === 0 && offText === 'Darkrai is off everywhere.';
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { offAfterMs: off && off.afterMs, offAttr: off && off.attr, offStyles: off && off.darkraiStyles, storedWhileOff: offStore, popupWhileOff: offPopup && { enabled: offPopup.enabled, status: offText }, pickWhileOff: offPick, onAfterMs: on && on.afterMs, onStyles: on && on.darkraiStyles, storedAfterOn: onStore, reloads: w.navs.length, clickedVia: [t1.via, t2 && t2.via] },
      reason: ok ? '' : [!(off && off.afterMs != null) && 'page kept its styles after Off (attr ' + (off && off.attr) + ', ' + (off && off.darkraiStyles) + ' styles)', offStore !== false && 'storage enabled=' + offStore + ' after Off',
        offText !== 'Darkrai is off everywhere.' && 'status line while off: "' + offText + '"', !(on && on.afterMs != null) && 'page not darkened again after On (attr ' + (on && on.attr) + ')',
        onStore !== true && 'storage enabled=' + onStore + ' after On', w.navs.length && w.navs.length + ' reload(s)'].filter(Boolean).join('; ')
    };
  });

  await check('P4-shot', 'P4', 'real-Chrome screenshot of the popup: results/<run>/popup-real.png, under 2000 px a side', async () => {
    const p = await ensurePopup();
    await sleep(900);   // the entrance motion is over well within this
    const buf = await p.screenshot({ clip: false });
    fs.writeFileSync(path.join(ctx.out, 'popup-real.png'), buf);
    const img = decodePNG(buf);
    const stillOpen = (await popupTargets(b)).some((t) => t.targetId === p.targetId);
    const ok = img.w > 100 && img.h > 100 && img.w < 2000 && img.h < 2000;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { file: 'popup-real.png', width: img.w, height: img.h, popupOpenAfterShot: stillOpen },
      reason: ok ? '' : 'popup screenshot is ' + img.w + 'x' + img.h + ' px'
    };
  });

  // The height decision (README, "The popup's Lovable design"): the design is
  // taller than the 600px Chrome gives a popup, so the casing and both
  // hardware strips stay whole and only the dark screen (#panel) scrolls.
  await check('P4-fit', 'P4', 'default state in the real popup: 360px wide, the page does not scroll, only the screen panel does, no clipped text', async () => {
    const p = await ensurePopup();
    await sleep(300);
    const s = await p.eval(FIT);
    const pageScrolls = s.pageScrollHeight > s.pageClientHeight + 1 || s.innerHeight > 600;
    const panelScrolls = /auto|scroll/.test(s.panelOverflowY) && s.panelScrollHeight > s.panelClientHeight;
    const problems = [Math.round(s.bodyWidth) !== 360 && 'body ' + s.bodyWidth + 'px wide, not 360',
      pageScrolls && 'the page scrolls (' + s.pageScrollHeight + ' in ' + s.pageClientHeight + 'px, window ' + s.innerHeight + 'px)',
      !panelScrolls && 'the screen panel does not scroll (' + s.panelOverflowY + ', ' + s.panelScrollHeight + ' in ' + s.panelClientHeight + 'px)',
      s.schedule !== 'always' && 'not the default state (schedule ' + s.schedule + ')', s.lookOpen && 'not the default state (Look open)',
      s.clipped.length && 'clipped text: ' + s.clipped.slice(0, 4).join('; ')].filter(Boolean);
    return { status: problems.length ? 'FAIL' : 'PASS', evidence: s, reason: problems.join('; ') };
  });

  const p11b = (ctx.checks || []).find((c) => c.id === 'P1-1b');
  record('P4-never-auto', 'P4', 'This site: Never then Auto (the same real clicks as P1-1b)', p11b ? p11b.status : 'NOT RUN',
    p11b ? { sameAs: 'P1-1b' } : null, p11b ? (p11b.reason ? 'P1-1b: ' + p11b.reason : '') : 'P1-1b did not run in this run (it runs with problem1)');

  await check('P4-engine', 'P4', 'Mode: Smart -> Simple applies the filter engine (html filter style), Smart again restores the recolouring', async () => {
    await toWiki();
    const t1 = await tap('engine-filter');
    if (unclickable(t1, 'engine-filter')) return failNoClick(t1, 'engine-filter');
    const simple = await site.poll((o) => (o.styleGroups.simple || 0) > 0, 3000, 100);
    const xSimple = await site.eval(OBSERVE_EXTRA);
    const sSimple = await storeOf(driver);
    const t2 = await tap('engine-smart');
    if (unclickable(t2, 'engine-smart')) return failNoClick(t2, 'engine-smart');
    const smart = await site.poll((o) => !o.styleGroups.simple && o.attr === 'on' && o.darkraiStyles > 0, 4000, 100);
    const xSmart = await site.eval(OBSERVE_EXTRA);
    const sSmart = await storeOf(driver);
    const entry = (s) => { const h = s.sites || {}; return h[P4_HOST] || h['wikipedia.org'] || {}; };
    const simpleOk = !!(simple && simple.afterMs != null) && /invert/.test(xSimple.htmlFilter) && entry(sSimple).engine === 'filter';
    const smartOk = !!(smart && smart.afterMs != null) && !/invert/.test(xSmart.htmlFilter) && entry(sSmart).engine !== 'filter';
    return {
      status: simpleOk && smartOk ? 'PASS' : 'FAIL',
      evidence: { simpleAfterMs: simple && simple.afterMs, simpleGroups: simple && simple.styleGroups, simpleEngine: simple && simple.status && simple.status.engine, htmlFilterSimple: xSimple.htmlFilter, storedSimple: entry(sSimple), smartAfterMs: smart && smart.afterMs, smartGroups: smart && smart.styleGroups, smartEngine: smart && smart.status && smart.status.engine, htmlFilterSmart: xSmart.htmlFilter, storedSmart: entry(sSmart) },
      reason: (simpleOk ? '' : 'Simple: groups ' + JSON.stringify(simple && simple.styleGroups) + ', html filter "' + xSimple.htmlFilter + '", stored engine ' + entry(sSimple).engine + '. ') +
        (smartOk ? '' : 'Smart again: groups ' + JSON.stringify(smart && smart.styleGroups) + ', html filter "' + xSmart.htmlFilter + '", stored engine ' + entry(sSmart).engine)
    };
  });

  await check('P4-brightness', 'P4', 'Look panel: a brightness change is saved and repaints the page', async () => {
    await toWiki();
    const p = await ensurePopup();
    const s0 = (await storeOf(driver)).settings.brightness;
    const panel = await p.eval(`(() => { const d = document.getElementById('look-details'); const r = document.getElementById('brightness');
      return { open: d ? d.open : null, slider: !!r, visible: !!r && r.getClientRects().length > 0 }; })()`);
    if (!panel.slider) return { status: 'FAIL', evidence: panel, reason: 'the popup has no #brightness slider' };
    let openedBy = 'already open';
    if (!panel.visible || panel.open === false) {
      const t = await tap('look-summary');
      openedBy = unclickable(t, 'look-summary') || 'real click on #look-summary';
      await sleep(450);
    }
    const x0 = await site.eval(OBSERVE_EXTRA);
    await p.eval(`document.getElementById('brightness').focus()`);
    await p.key('ArrowRight');
    await sleep(600);
    let v = Number(await p.eval(`document.getElementById('brightness').value`));
    let via = 'keyboard: ArrowRight on the focused slider';
    if (v === s0) {
      v = s0 >= 150 ? s0 - 5 : s0 + 5;
      await p.eval(SET_VALUE('brightness', String(v)));
      via = 'value set + input/change events (the key press did not move the slider)';
      await sleep(600);
    }
    const saved = await until(async () => { const s = await storeOf(driver); return s.settings.brightness === v ? s : null; }, 3000);
    const x1 = await until(async () => {
      const x = await site.eval(OBSERVE_EXTRA);
      return x.rootBg !== x0.rootBg || x.bodyBg !== x0.bodyBg || x.bodyColor !== x0.bodyColor || x.styleHash !== x0.styleHash ? x : null;
    }, 3000);
    const summary = (await p.eval(POPUP_STATE)).lookSummary || '';
    const summaryOk = new RegExp('Brightness\\s*' + v).test(summary);
    const ok = v !== s0 && !!saved && !!x1 && summaryOk;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { panelOpenedBy: openedBy, input: via, before: s0, after: v, stored: saved && saved.settings.brightness, summary, page: { before: { rootBg: x0.rootBg, bodyBg: x0.bodyBg, bodyColor: x0.bodyColor }, after: x1 && { rootBg: x1.rootBg, bodyBg: x1.bodyBg, bodyColor: x1.bodyColor, styleTextChanged: x1.styleHash !== x0.styleHash } } },
      reason: ok ? '' : [v === s0 && 'slider did not move', !saved && 'storage brightness never became ' + v, !x1 && "the page's Darkrai styles and colours did not change", !summaryOk && 'summary reads "' + summary + '"'].filter(Boolean).join('; ')
    };
  });

  await check('P4-persist', 'P4', 'close the popup and open it again: every control shows the same state', async () => {
    const p = await ensurePopup();
    await readPopup(p, 3000);
    const a = await p.eval(POPUP_STATE);
    await closePopup();
    const p2 = await ensurePopup();
    const c = await p2.eval(POPUP_STATE);
    const diff = Object.keys(Object.assign({}, a, c)).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(c[k]));
    const ok = diff.length === 0;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { state: a, nonDefault: a.brightness !== '100' ? ['brightness ' + a.brightness] : [] },
      reason: ok ? '' : 'changed after reopening: ' + diff.map((k) => k + ' ' + JSON.stringify(a[k]) + ' -> ' + JSON.stringify(c[k])).join(', ')
    };
  });

  await check('P4-pick', 'P4', 'Fix something unreadable: the picker comes up in the page, Escape cancels it, nothing is saved', async () => {
    await toWiki();
    const p = await ensurePopup();
    const before = await storeOf(driver);
    const t = await tap('pick');
    if (unclickable(t, 'pick')) {
      const pr = await p.eval(POPUP_STATE).catch(() => null);
      return { status: 'FAIL', evidence: Object.assign({ popupStatus: pr && pr.status }, t), reason: unclickable(t, 'pick') + ' while the page is darkened' };
    }
    const up = await until(async () => { const x = await site.eval(OBSERVE_EXTRA); return x.picker ? x : null; }, 3000, 100);
    const popupClosed = !!(await until(async () => (await popupTargets(b)).length === 0, 2000, 100));
    popup = null;
    let via = 'real Escape key press in the page';
    await site.send('Page.bringToFront', {}, 5000).catch(() => { });
    await site.key('Escape');
    let down = await until(async () => { const x = await site.eval(OBSERVE_EXTRA); return !x.picker ? x : null; }, 2000, 100);
    if (!down && up) {
      via = 'keydown Escape dispatched on the document (the CDP key press did not reach the page)';
      await site.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      down = await until(async () => { const x = await site.eval(OBSERVE_EXTRA); return !x.picker ? x : null; }, 2000, 100);
    }
    await sleep(500);
    const after = await storeOf(driver);
    const saved = JSON.stringify(sortKeys(after.sites)) !== JSON.stringify(sortKeys(before.sites));
    const ok = !!up && !!down && !saved && !down.fixesStyle;
    return {
      status: ok ? 'PASS' : 'FAIL',
      note: ok && /dispatched/.test(via) ? via : undefined,
      evidence: { clickedVia: t.via, pickerShown: !!up, popupClosedItself: popupClosed, cancelledBy: via, pickerGone: !!down, fixesStyleLeft: !!(down && down.fixesStyle), sitesChanged: saved },
      reason: ok ? '' : [!up && 'no picker overlay ([data-darkrai="picker"]) appeared in the page', up && !down && 'Escape did not cancel the picker', saved && 'storage sites changed: ' + JSON.stringify(after.sites), down && down.fixesStyle && 'a fixes style was left in the page'].filter(Boolean).join('; ')
    };
  });

  await check('P4-schedule', 'P4', 'Schedule: Custom hours enables From/To, editing them saves and sets the schedule alarm, Always removes it', async () => {
    const p = await ensurePopup();
    const FIELDS = `(() => { const f = (id) => { const e = document.getElementById(id);
      return e ? { shown: e.getClientRects().length > 0, disabled: !!e.disabled, value: e.value } : null; };
      return { schedule: f('schedule'), from: f('from'), to: f('to') }; })()`;
    const f0 = await p.eval(FIELDS);
    const r1 = await p.eval(SET_VALUE('schedule', 'hours'));
    await sleep(500);
    const f1 = await p.eval(FIELDS);
    const usable = (x) => !!(x && x.shown && !x.disabled);
    const enabledByHours = usable(f1.from) && usable(f1.to);
    // Hours around now, so the page stays darkened while they are in force.
    const now = Date.now();
    const from = hhmm(new Date(now - 60 * 60000)), to = hhmm(new Date(now + 120 * 60000));
    const rf = await p.eval(SET_VALUE('from', from));
    await sleep(300);
    const rt = await p.eval(SET_VALUE('to', to));
    const saved = await until(async () => {
      const sc = (await storeOf(driver)).settings.schedule;
      return sc.type === 'hours' && sc.from === from && sc.to === to ? sc : null;
    }, 3000);
    const alarm = await until(() => alarmOf(driver), 5000, 200);
    const r2 = await p.eval(SET_VALUE('schedule', 'always'));
    const back = await until(async () => { const sc = (await storeOf(driver)).settings.schedule; return sc.type === 'always' ? sc : null; }, 3000);
    const gone = !!(await until(async () => !(await alarmOf(driver)), 5000, 200));
    const f2 = await p.eval(FIELDS);
    const ok = r1 === 'hours' && enabledByHours && rf === from && rt === to && !!saved && !!alarm && !!back && gone;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { input: 'value set + input/change events (native select and time widgets are outside the page)', fieldsAlways: f0, fieldsHours: f1, edited: { from, to }, stored: saved, alarm, storedAfterAlways: back, alarmGoneAfterAlways: gone, fieldsBackToAlways: f2 },
      reason: ok ? '' : [r1 !== 'hours' && 'could not choose Custom hours (' + r1 + ')', !enabledByHours && 'From/To not usable after Custom hours: ' + JSON.stringify({ from: f1.from, to: f1.to }),
        (rf !== from || rt !== to) && 'time fields took ' + rf + ' / ' + rt, !saved && 'storage did not get hours ' + from + '-' + to, !alarm && 'no darkrai-schedule alarm was created',
        !back && 'storage did not go back to always', !gone && 'the alarm was still there after Always'].filter(Boolean).join('; ')
    };
  });

  // Themed dropdowns (shared/select.css, appearance: base-select): the open
  // list is drawn in the page, so real clicks reach its options and the
  // popup's own screenshot shows it.
  await check('P4-dropdowns', 'P4', 'Look and Schedule lists open on a real click, are themed (no default light blue), fit 360x600, real option clicks save; keyboard and Escape; options #default-mode', async () => {
    await toWiki();
    const p = await ensurePopup();
    const problems = [], ev = {};
    ev.baseSelect = await p.eval(`CSS.supports('appearance', 'base-select')`);
    if (!ev.baseSelect) return { status: 'NOT RUN', evidence: ev, reason: 'this Chrome has no customizable select; the classic list is outside the page' };
    const LIST = (id) => `(() => { const s = document.getElementById(${JSON.stringify(id)}); if (!s) return null;
      const pill = (s.closest('.select-pill') || s).getBoundingClientRect();
      const rows = [...s.options].map((o) => { const r = o.getBoundingClientRect(); return { value: o.value, label: o.textContent.trim(), checked: o.selected, x: r.left, y: r.top, w: r.width, h: r.height }; });
      return { open: s.matches(':open'), value: s.value, vw: innerWidth, vh: innerHeight, pill: { x: pill.left, y: pill.top, w: pill.width, h: pill.height }, rows }; })()`;
    const open = async (doc, id, block) => {
      await doc.eval(`(() => { const s = document.getElementById(${JSON.stringify(id)}); (s.closest('.select-pill') || s).scrollIntoView({ block: ${JSON.stringify(block || 'center')} }); })()`);
      await sleep(700);
      const l0 = await doc.eval(LIST(id));
      await doc.clickAt(l0.pill.x + l0.pill.w / 2, l0.pill.y + l0.pill.h / 2);
      await sleep(450);
      return doc.eval(LIST(id));
    };
    // Pixels and contrast from the screenshot, the same rules as UI family (k).
    const inspect = async (doc, l, tag, file) => {
      const buf = await doc.screenshot({ clip: false });
      fs.writeFileSync(path.join(ctx.out, file), buf);
      const img = decodePNG(buf);
      const k = img.w / l.vw;
      const at = (x, y) => { const X = Math.min(img.w - 1, Math.max(0, Math.round(x * k))), Y = Math.min(img.h - 1, Math.max(0, Math.round(y * k))); const i = (Y * img.w + X) * 3; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
      const out = { file, width: img.w, height: img.h, scale: +k.toFixed(2), rows: [] };
      if (img.w >= 2000 || img.h >= 2000) problems.push(tag + ': screenshot ' + img.w + 'x' + img.h);
      for (const r of l.rows) {
        if (r.x < 0 || r.y < 0 || r.x + r.w > l.vw + 0.5 || r.y + r.h > l.vh + 0.5) problems.push(tag + ': "' + r.label + '" lies outside the ' + l.vw + 'x' + l.vh + ' viewport');
        const bg = at(r.x + 4, r.y + r.h / 2);
        let best = 1;
        for (let y = r.y + 4; y < r.y + r.h - 4; y += 1 / k) for (let x = r.x + 8; x < r.x + r.w - 8; x += 1 / k) { const q = ratio(bg, at(x, y)); if (q > best) best = q; }
        const lumBg = (bg[0] + bg[1] + bg[2]) / 3;
        out.rows.push({ label: r.label, checked: r.checked, bg: hex(bg), textContrast: +best.toFixed(2) });
        if (r.checked && lumBg < 190) problems.push(tag + ': selected "' + r.label + '" is ' + hex(bg) + ', not silver');
        if (!r.checked && lumBg > 90) problems.push(tag + ': unselected "' + r.label + '" is ' + hex(bg) + ', not dark');
        if (best < 4.5) problems.push(tag + ': "' + r.label + '" text reads ' + best.toFixed(2) + ':1');
      }
      const x0 = Math.min(...l.rows.map((r) => r.x)) - 5, y0 = Math.min(...l.rows.map((r) => r.y)) - 5;
      const x1 = Math.max(...l.rows.map((r) => r.x + r.w)) + 5, y1 = Math.max(...l.rows.map((r) => r.y + r.h)) + 5;
      let blue = 0, n = 0;
      for (let y = y0 + 14; y < y1 - 14; y += 3) for (let x = x0 + 14; x < x1 - 14; x += 3) { n++; if (isDefaultBlue(at(x, y))) blue++; }
      out.list = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), pillY: Math.round(l.pill.y), above: y0 < l.pill.y, sampled: n, defaultBlue: blue };
      if (blue) problems.push(tag + ': ' + blue + '/' + n + ' sampled list pixels are the default light blue');
      return out;
    };
    const clickRow = async (doc, id, value) => {
      const l = await doc.eval(LIST(id));
      const r = l.rows.find((x) => x.value === value);
      await doc.clickAt(r.x + r.w / 2, r.y + r.h / 2);
      await sleep(400);
      return doc.eval(LIST(id));
    };
    const alive = async () => (await popupTargets(b)).some((t) => t.targetId === p.targetId);
    const store = async () => (await storeOf(driver)).settings;
    // Which step was running if the popup goes away (a real Escape or click can close it).
    let step = 'look: open';
    try {
    // Look
    const panel = await p.eval(`(() => { const d = document.getElementById('look-details'); return d ? d.open : null; })()`);
    if (panel === false) { await tap('look-summary'); await sleep(450); }
    const look0 = await open(p, 'look');
    if (!look0.open) problems.push('#look: a real click did not open the list');
    else {
      ev.look = await inspect(p, look0, 'popup #look', 'popup-dropdown-look.png');
      const x0 = await site.eval(OBSERVE_EXTRA);
      step = 'look: real click on True black';
      const after = await clickRow(p, 'look', 'black');
      const saved = await until(async () => (await store()).look === 'black', 3000);
      const x1 = await until(async () => { const x = await site.eval(OBSERVE_EXTRA); return x.rootBg !== x0.rootBg || x.bodyBg !== x0.bodyBg || x.styleHash !== x0.styleHash ? x : null; }, 3000);
      ev.lookTrueBlack = { listClosed: !after.open, value: after.value, stored: !!saved, pageRepainted: !!x1 };
      if (after.value !== 'black' || after.open || !saved || !x1) problems.push('#look True black by real click: ' + JSON.stringify(ev.lookTrueBlack));
      step = 'look: reopen and real click on Dark gray';
      const l2 = await open(p, 'look');
      const back = l2.open ? await clickRow(p, 'look', 'gray') : l2;
      const saved2 = await until(async () => (await store()).look === 'gray', 3000);
      ev.lookDarkGray = { value: back.value, stored: !!saved2 };
      if (back.value !== 'gray' || !saved2) problems.push('#look Dark gray again: ' + JSON.stringify(ev.lookDarkGray));
    }

    // Escape with the list open: the list closes, the popup stays, the value holds.
    step = 'escape: open #look';
    const e0 = await open(p, 'look');
    step = 'escape: real Escape with the #look list open';
    await p.key('Escape');
    await sleep(400);
    const stillOpen = await alive();
    const e1 = stillOpen ? await p.eval(LIST('look')) : null;
    ev.escape = { listWasOpen: e0.open, popupStaysOpen: stillOpen, listClosed: !!e1 && !e1.open, value: e1 && e1.value };
    if (!e0.open || !stillOpen || !e1 || e1.open || e1.value !== 'gray') problems.push('Escape on the open #look list: ' + JSON.stringify(ev.escape));

    // Keyboard: closed + ArrowDown, then Enter opens, ArrowDown + Enter selects.
    if (stillOpen) {
      const k = async (name, vk, text) => {
        const q = { key: name, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
        await p.send('Input.dispatchKeyEvent', Object.assign({ type: text ? 'keyDown' : 'rawKeyDown', text }, q));
        await p.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, q));
        await sleep(250);
      };
      await p.eval(`document.getElementById('look').focus()`);
      await k('ArrowDown', 40);
      const kd = await p.eval(LIST('look'));
      if (kd.open) { await p.key('Escape'); await sleep(300); }
      if (kd.value !== 'gray') { await p.eval(SET_VALUE('look', 'gray')); await sleep(400); }
      await p.eval(`document.getElementById('look').focus()`);
      await k('Enter', 13, '\r');
      const ke = await p.eval(LIST('look'));
      await k('ArrowDown', 40);
      await k('Enter', 13, '\r');
      const ks = await p.eval(LIST('look'));
      const kSaved = await until(async () => (await store()).look === ks.value, 3000);
      ev.keyboard = { closedArrowDown: { opened: kd.open, valueChangedTo: kd.value !== 'gray' ? kd.value : null }, enterOpens: ke.open, arrowDownEnterSelects: ks.value, listClosedAfter: !ks.open, stored: !!kSaved, popupStaysOpen: await alive() };
      if (!ke.open || ks.value !== 'black' || ks.open || !kSaved) problems.push('keyboard Enter/ArrowDown/Enter: ' + JSON.stringify(ev.keyboard));
      await p.eval(SET_VALUE('look', 'gray'));
      await until(async () => (await store()).look === 'gray', 3000);
    }

    // Schedule
    step = 'schedule';
    const s0 = await open(p, 'schedule');
    if (!s0.open) problems.push('#schedule: a real click did not open the list');
    else {
      ev.schedule = await inspect(p, s0, 'popup #schedule', 'popup-dropdown-schedule.png');
      const h = await clickRow(p, 'schedule', 'hours');
      await sleep(300);
      const fields = await p.eval(`(() => ['from', 'to'].map((id) => { const e = document.getElementById(id); return !!e && !e.disabled && e.getClientRects().length > 0; }))()`);
      const alarm = await until(() => alarmOf(driver), 5000, 200);
      const l3 = await open(p, 'schedule');
      const a = l3.open ? await clickRow(p, 'schedule', 'always') : l3;
      const gone = !!(await until(async () => !(await alarmOf(driver)), 5000, 200));
      ev.scheduleClicks = { hoursValue: h.value, fromToEnabled: fields, alarm, alwaysValue: a.value, alarmGone: gone, stored: (await store()).schedule };
      if (h.value !== 'hours' || !fields.every(Boolean) || !alarm || a.value !== 'always' || !gone) problems.push('#schedule real option clicks: ' + JSON.stringify(ev.scheduleClicks));
    }
    // The pill at the very bottom of the scrolled panel: no room below, so the
    // list flips above it, stays inside 360x600, and a real click picks a row.
    step = 'schedule at the bottom: open';
    const se = await open(p, 'schedule', 'end');
    if (!se.open) problems.push('#schedule at the bottom of the panel: a real click did not open the list');
    else {
      const top = Math.min(...se.rows.map((r) => r.y)) - 5, bottom = Math.max(...se.rows.map((r) => r.y + r.h)) + 5;
      ev.scheduleAtBottom = {
        pillY: Math.round(se.pill.y), rows: se.rows.map((r) => Math.round(r.y) + '..' + Math.round(r.y + r.h)),
        inside: se.rows.every((r) => r.y >= 0 && r.y + r.h <= se.vh + 0.5), above: bottom <= se.pill.y + 0.5,
        list: { x: Math.round(se.rows[0].x - 5), y: Math.round(top), w: Math.round(se.rows[0].w + 10), h: Math.round(bottom - top) },
        pill: { x: Math.round(se.pill.x), w: Math.round(se.pill.w) }, gap: +(se.pill.y - bottom).toFixed(1)
      };
      ev.scheduleAtBottom.shot = await inspect(p, se, 'popup #schedule at the bottom', 'popup-dropdown-schedule-bottom.png');
      if (!ev.scheduleAtBottom.inside || !ev.scheduleAtBottom.above) problems.push('#schedule at the bottom of the panel: ' + JSON.stringify(ev.scheduleAtBottom));
      step = 'schedule at the bottom: real click on Custom hours';
      const sh = await clickRow(p, 'schedule', 'hours');
      if (sh.open) { await p.key('Escape'); await sleep(300); }
      const alarmH = await until(() => alarmOf(driver), 5000, 200);
      step = 'schedule at the bottom: back to Always';
      const l4 = await open(p, 'schedule');
      const a4 = l4.open ? await clickRow(p, 'schedule', 'always') : l4;
      const gone4 = !!(await until(async () => !(await alarmOf(driver)), 5000, 200));
      ev.scheduleAtBottom.customHoursClick = { value: sh.value, listClosed: !sh.open, alarm: !!alarmH, backToAlways: a4.value, alarmGone: gone4 };
      if (sh.value !== 'hours' || sh.open || !alarmH || a4.value !== 'always' || !gone4) problems.push('#schedule at the bottom, real click on Custom hours: ' + JSON.stringify(ev.scheduleAtBottom.customHoursClick));
    }

    } catch (e) {
      const gone = !(await alive().catch(() => false));
      popup = null;
      problems.push('stopped at "' + step + '": ' + e.message + (gone ? ' (the popup had closed)' : ''));
      ev.stoppedAt = { step, popupClosed: gone };
    }

    // Options page #default-mode (runs even when the popup part stopped)
    try {
      await driver.activate();
      const o0 = await open(driver, 'default-mode');
      if (!o0.open) problems.push('options #default-mode: a real click did not open the list');
      else {
        ev.options = await inspect(driver, o0, 'options #default-mode', 'options-dropdown.png');
        await driver.key('Escape');
        await sleep(300);
        const o1 = await driver.eval(LIST('default-mode'));
        ev.options.escape = { listClosed: !o1.open, value: o1.value, unchanged: o1.value === o0.value };
        if (o1.open || o1.value !== o0.value) problems.push('options Escape: ' + JSON.stringify(ev.options.escape));
      }
    } catch (e) {
      problems.push('options #default-mode: ' + e.message);
    } finally { await site.activate().catch(() => { }); }
    return { status: problems.length ? 'FAIL' : 'PASS', evidence: ev, reason: problems.join('; ') };
  }, 90000);

  await check('P4-reset-site', 'P4', "Reset this site forgets this site's entry and leaves every other entry alone", async () => {
    await toWiki();
    // This site needs an entry of its own, and there must be a bystander.
    await driver.eval(`(async () => {
      const s = await chrome.storage.local.get(null);
      s.sites = s.sites || {};
      s.sites[${JSON.stringify(P4_HOST)}] = Object.assign({ mode: 'auto' }, s.sites[${JSON.stringify(P4_HOST)}], { engine: 'smart' });
      s.sites['example.org'] = { mode: 'off' };
      await chrome.storage.local.set({ sites: s.sites });
    })()`);
    await sleep(400);
    const before = await storeOf(driver);
    const key = before.sites[P4_HOST] ? P4_HOST : (Object.keys(before.sites).find((k) => P4_HOST.endsWith('.' + k)) || P4_HOST);
    const p = await ensurePopup();
    const t1 = await tap('reset-site');
    if (unclickable(t1, 'reset-site')) return failNoClick(t1, 'reset-site');
    await sleep(300);
    const armed = await p.eval(`(document.getElementById('reset-site') || {}).textContent`).catch(() => null);
    const t2 = await tap('reset-site');
    const after = await until(async () => { const s = await storeOf(driver); return !(key in (s.sites || {})) ? s : null; }, 3000);
    const status = await p.eval(`(document.getElementById('status-text') || {}).textContent`).catch(() => null);
    const others = Object.keys(before.sites).filter((k) => k !== key);
    const changed = after ? others.filter((k) => JSON.stringify(after.sites[k]) !== JSON.stringify(before.sites[k])) : others;
    const added = after ? Object.keys(after.sites).filter((k) => !(k in before.sites)) : [];
    const settingsSame = !!after && JSON.stringify(sortKeys(after.settings)) === JSON.stringify(sortKeys(before.settings));
    const ok = !!after && changed.length === 0 && added.length === 0 && settingsSame;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { forgot: key, armedText: armed && armed.trim(), statusAfter: status && status.trim(), othersKept: others, clickedVia: [t1.via, t2.via] },
      reason: ok ? '' : [!after && key + ' still stored after the second click', changed.length && 'other entries changed: ' + changed.join(', '), added.length && 'entries added: ' + added.join(', '), after && !settingsSame && 'global settings changed'].filter(Boolean).join('; ')
    };
  });

  await check('P4-hard-reset', 'P4', 'Hard reset… opens options.html#danger and resets nothing by itself', async () => {
    await ensurePopup();
    const before = await storeOf(driver);
    const known = new Set((await b.targets()).map((t) => t.targetId));
    const t = await tap('hard-reset');
    if (unclickable(t, 'hard-reset')) return failNoClick(t, 'hard-reset');
    const opened = await until(async () => (await b.targets()).find((x) => !known.has(x.targetId) && x.type === 'page' && /\/options\/options\.html#danger$/.test(x.url)) || null, 4000, 150);
    popup = null;
    await sleep(500);
    const after = await storeOf(driver);
    if (opened) await b.cdp.send('Target.closeTarget', { targetId: opened.targetId }).catch(() => { });
    await site.activate();
    const same = JSON.stringify(sortKeys(after)) === JSON.stringify(sortKeys(before));
    const ok = !!opened && same;
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { opened: opened && opened.url, storageUnchanged: same, clickedVia: t.via, clickError: t.clickError },
      reason: ok ? '' : [!opened && 'no options.html#danger tab opened', !same && 'storage changed on the click alone'].filter(Boolean).join('; ')
    };
  });

  await check('P4-options', 'P4', 'Options opens options.html', async () => {
    const base = 'chrome-extension://' + b.extId + '/options/options.html';
    await ensurePopup();
    const known = new Set((await b.targets()).map((t) => t.targetId));
    const t = await tap('options');
    if (unclickable(t, 'options')) return failNoClick(t, 'options');
    // openOptionsPage() reuses an options tab that is already open, and the
    // harness's own driver page is one: either outcome is the button working.
    const res = await until(async () => {
      const fresh = (await b.targets()).find((x) => !known.has(x.targetId) && x.type === 'page' && x.url.startsWith(base));
      if (fresh) return { how: 'opened a new options tab', target: fresh };
      const act = await driver.eval(`chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0] ? t[0].url : null)`).catch(() => null);
      if (act && act.startsWith(base)) return { how: 'brought the already-open options tab to the front', url: act };
      return null;
    }, 4000, 150);
    popup = null;
    if (res && res.target) await b.cdp.send('Target.closeTarget', { targetId: res.target.targetId }).catch(() => { });
    await site.activate();
    return {
      status: res ? 'PASS' : 'FAIL',
      evidence: res ? { how: res.how, url: res.url || res.target.url } : null,
      reason: res ? '' : 'no options.html tab opened or came to the front'
    };
  });

  await check('P4-reload', 'P4', 'Reload this tab reloads it exactly once', async () => {
    await toWiki();
    await ensurePopup();
    const w = watchNavs(b, site);
    const load = b.cdp.waitFor((m) => m.sessionId === site.sessionId && m.method === 'Page.loadEventFired', 20000, 'reload load').catch(() => null);
    let t;
    try {
      t = await tap('reload');
      if (unclickable(t, 'reload')) return failNoClick(t, 'reload');
      await load;
      await sleep(2500);
    } finally { w.off(); }
    popup = null;
    const o = await site.settle(8000);
    const ok = w.navs.length === 1 && o.attr === 'on';
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { mainFrameNavigations: w.navs, attrAfter: o.attr, stylesAfter: o.darkraiStyles },
      reason: ok ? '' : w.navs.length + ' main-frame navigation(s)' + (o.attr !== 'on' ? ', page not darkened after the reload (attr ' + o.attr + ')' : '')
    };
  });

  await check('P4-shortcut-key', 'P4', 'chrome.commands.getAll(): toggle-site has Alt+Shift+D assigned', async () => {
    const list = await driver.eval('chrome.commands.getAll()');
    const c = (list || []).find((x) => x.name === 'toggle-site');
    const ok = !!c && c.shortcut === 'Alt+Shift+D';
    return {
      status: ok ? 'PASS' : 'FAIL',
      evidence: { commands: list },
      reason: ok ? '' : !c ? 'no toggle-site command' : !c.shortcut ? 'no key assigned: an empty shortcut means another extension (or Chrome) already holds Alt+Shift+D' : 'assigned "' + c.shortcut + '" instead'
    };
  });

  await check('P4-shortcut-proxy', 'P4', "the shortcut's handler, toggleSite(active tab) in the service worker, turns the site off and on", async () => {
    await closePopup();
    await toWiki();
    await site.activate();
    let sw = (await b.swTargets())[0];
    if (!sw) {
      await driver.eval(`new Promise((r) => chrome.runtime.sendMessage({ type: 'dr-register-preload' }, () => { void chrome.runtime.lastError; r(true); }))`).catch(() => { });
      sw = await until(async () => (await b.swTargets())[0] || null, 5000, 200);
    }
    if (!sw) return { status: 'NOT RUN', reason: 'the service worker could not be woken to call the handler' };
    const w = await b.attach(sw.targetId, 'service-worker');
    try {
      const probe = await w.eval(`({ toggleSite: typeof toggleSite, onCommandListeners: chrome.commands && chrome.commands.onCommand && chrome.commands.onCommand.hasListeners ? chrome.commands.onCommand.hasListeners() : null })`);
      if (probe.toggleSite !== 'function') {
        return { status: 'NOT RUN', evidence: probe, reason: 'background.js does not expose the command handler as a named function on the worker global; background.js was not modified' };
      }
      // Exactly what the onCommand listener does after its name filter.
      const CALL = `(async () => { const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); const t = tabs && tabs[0]; await toggleSite(t); return t ? t.url : null; })()`;
      const pre = await site.observe();
      const url1 = await w.eval(CALL, null, 10000);
      const off = await site.poll((o) => o.attr !== 'on' && o.darkraiStyles === 0, 3000, 100);
      const s1 = await storeOf(driver);
      const url2 = await w.eval(CALL, null, 10000);
      const on = await site.poll((o) => o.attr === 'on' && o.darkraiStyles > 0, 3000, 100);
      const s2 = await storeOf(driver);
      const mode = (s) => ((s.sites || {})['wikipedia.org'] || (s.sites || {})[P4_HOST] || {}).mode;
      const ok = pre.attr === 'on' && url1 === P4_SITE && !!(off && off.afterMs != null) && mode(s1) === 'off' && !!(on && on.afterMs != null) && mode(s2) === 'on';
      return {
        status: ok ? 'PASS' : 'FAIL',
        note: "the onCommand listener's own name filter and the physical Alt+Shift+D press are not exercised (manual checklist)",
        evidence: Object.assign(probe, { activeTab: url1, firstCall: { offAfterMs: off && off.afterMs, storedMode: mode(s1) }, secondCall: { activeTab: url2, onAfterMs: on && on.afterMs, storedMode: mode(s2) } }),
        reason: ok ? '' : [pre.attr !== 'on' && 'page not darkened before (attr ' + pre.attr + ')', url1 !== P4_SITE && 'active tab was ' + url1, !(off && off.afterMs != null) && 'first call did not turn the page off', mode(s1) !== 'off' && 'stored mode after the first call: ' + mode(s1),
          !(on && on.afterMs != null) && 'second call did not turn it back on', mode(s2) !== 'on' && 'stored mode after the second call: ' + mode(s2)].filter(Boolean).join('; ')
      };
    } finally {
      await b.cdp.send('Target.detachFromTarget', { sessionId: w.sessionId }).catch(() => { });
      b.roleOf.delete(w.sessionId);
      b.contexts.delete(w.sessionId);
    }
  });

  // Leave the profile as P4 found it for the checks that follow.
  await closePopup().catch(() => { });
  await cleanSlate(driver, P4_HOST, P4_RESET).catch(() => { });
  await site.activate().catch(() => { });
  await site.settle(6000).catch(() => { });
}

module.exports = { problem1, reloadCheck, hardReset, popupControls };
