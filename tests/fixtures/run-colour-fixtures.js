/*
 * Darkrai - tests/fixtures/run-colour-fixtures.js
 *
 * The colour-coverage fixtures (light regions left light on a darkened page).
 * Opens each in the headless shell (same discovery and server as
 * tests/browser/run-fixtures.js), prints the checks the page makes about
 * itself, and then the pixel checks it asks for in window.__DR_PIXEL_CHECKS__
 * ([{ name, selector, maxLum }]): the mean relative luminance of the real
 * screenshot pixels inside that element's box must stay below maxLum. That
 * is the only way to see what Chrome paints behind a frame.
 *
 *   node fixtures/run-colour-fixtures.js [--ext=./<copy>/]
 *
 * --ext loads another copy of extension/ placed under tests/fixtures/ (the
 * code from before a fix, for a before/after run; no such copy is kept in the
 * repository). Prints SKIPPED and exits 0 when there is no headless binary.
 */
'use strict';

const { launch, startServer, getJson, connect, delay } = require('../browser/chrome.js');
const { decodePNG } = require('../real-chrome/lib.js');

const FILES = ['var-fallback.html'];
const EXT = (process.argv.find((a) => a.startsWith('--ext=')) || '').slice(6);
const TIMEOUT_MS = 20000;

function lum(r, g, b) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

async function pixelChecks(page) {
  const out = [];
  const asks = await page.send('Runtime.evaluate', {
    expression: `JSON.stringify((window.__DR_PIXEL_CHECKS__ || []).map((c) => {
      const el = document.querySelector(c.selector);
      const r = el ? el.getBoundingClientRect() : null;
      return { name: c.name, maxLum: c.maxLum, box: r ? [r.left, r.top, r.width, r.height] : null };
    }))`,
    returnByValue: true
  }).then((r) => JSON.parse(r.result.value || '[]'));
  if (!asks.length) return out;
  await delay(300);
  const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 } }, 15000);
  const img = decodePNG(Buffer.from(shot.data, 'base64'));
  for (const a of asks) {
    if (!a.box) { out.push({ name: a.name, pass: false, detail: 'element not found' }); continue; }
    const x0 = Math.max(0, Math.ceil(a.box[0] + 2)), y0 = Math.max(0, Math.ceil(a.box[1] + 2));
    const x1 = Math.min(img.w, Math.floor(a.box[0] + a.box[2] - 2)), y1 = Math.min(img.h, Math.floor(a.box[1] + a.box[3] - 2));
    let n = 0, sum = 0, max = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * 3;
      const v = lum(img.px[i], img.px[i + 1], img.px[i + 2]);
      sum += v; n++; if (v > max) max = v;
    }
    const mean = n ? sum / n : 1;
    out.push({ name: a.name, pass: n > 0 && mean < a.maxLum, detail: 'screenshot pixels in [' + a.box.map(Math.round).join(',') + ']: mean luminance ' + mean.toFixed(3) + ' (max ' + max.toFixed(3) + '), must be < ' + a.maxLum });
  }
  return out;
}

async function runOne(shell, port, file) {
  const url = 'http://127.0.0.1:' + port + '/tests/fixtures/' + file + (EXT ? '?ext=' + encodeURIComponent(EXT) : '');
  const { targetId } = await shell.browser.send('Target.createTarget', { url: 'about:blank' });
  let ws = null;
  for (let i = 0; i < 40 && !ws; i++) {
    const hit = (await getJson(shell.cdpPort, '/json/list')).find((t) => t.id === targetId);
    if (hit && hit.webSocketDebuggerUrl) ws = hit.webSocketDebuggerUrl; else await delay(100);
  }
  const page = await connect(ws);
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await page.send('Page.navigate', { url });
    const started = Date.now();
    let results = null;
    while (!results && Date.now() - started < TIMEOUT_MS) {
      const r = await page.send('Runtime.evaluate', {
        expression: 'window.__DR_RESULTS_DONE__ ? JSON.stringify(window.__DR_RESULTS__) : ""', returnByValue: true
      }).catch(() => null);
      if (r && r.result && r.result.value) results = JSON.parse(r.result.value);
      else await delay(250);
    }
    if (!results) return [{ name: 'the fixture reported its result', pass: false, detail: 'timed out after ' + TIMEOUT_MS + ' ms' }];
    return results.concat(await pixelChecks(page));
  } finally {
    page.close();
    await shell.browser.send('Target.closeTarget', { targetId }).catch(() => { });
  }
}

async function main() {
  const shell = await launch();
  if (!shell) { console.log('SKIPPED: no headless browser found on this machine.'); return 0; }
  const { server, port } = await startServer();
  let failures = 0;
  try {
    console.log('browser: ' + shell.executable + (EXT ? '\next: ' + EXT : ''));
    for (const file of FILES) {
      let results;
      try { results = await runOne(shell, port, file); }
      catch (e) { results = [{ name: 'the fixture ran', pass: false, detail: String(e.message || e) }]; }
      const bad = results.filter((r) => !r.pass);
      failures += bad.length;
      console.log('\n' + (bad.length ? 'FAIL' : 'PASS') + '  ' + file);
      for (const r of results) console.log((r.skipped ? ' ~  ' : r.pass ? ' ok ' : ' XX ') + r.name + (r.detail ? '\n      ' + r.detail : ''));
    }
  } finally {
    server.close();
    await shell.close();
  }
  console.log('\n' + (failures ? failures + ' check(s) failed' : 'all colour fixture checks passed'));
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
