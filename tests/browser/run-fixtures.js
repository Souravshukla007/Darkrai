/*
 * Darkrai - tests/browser/run-fixtures.js
 *
 * Opens every fixture in a headless Chromium and reports the checks each page
 * makes about itself. No dependencies: a small static server, the DevTools
 * protocol over the WebSocket client built into Node, and nothing else.
 *
 * It never downloads a browser and never launches your everyday Chrome. Point
 * it at an existing headless binary:
 *
 *   set DARKRAI_CHROME=C:\path\to\chrome-headless-shell.exe
 *   node tests/browser/run-fixtures.js
 *
 * With no binary to use it prints SKIPPED and exits 0, so the fixtures can
 * still be opened by hand from tests/fixtures/index.html.
 */
'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// The browser discovery, the static server and the CDP client live in one
// place (browser/chrome.js) so every browser suite behaves - and skips - the
// same way.
const {
  ROOT,
  candidateBrowsers,
  startServer,
  connect,
  delay,
  waitForPort,
  getJson,
  spawnArgs
} = require('./chrome.js');

const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const PAGE_TIMEOUT_MS = 20000;
const POLL_MS = 250;

const FIXTURE_FILES = [
  'light.html',
  'native-dark.html',
  'meta-dark.html',
  'css-variables.html',
  'inline.html',
  'low-contrast.html',
  'shadow-dom.html',
  'iframe.html',
  'small-icons.html',
  'runtime-theme-switch.html',
  'canvas-app.html',
  'mask-icons.html',
  'var-shorthand.html'
];

// ------------------------------------------------------------------- the run

async function runFixture(browser, port, baseUrl, file) {
  const { targetId } = await browser.send('Target.createTarget', { url: baseUrl + '/tests/fixtures/' + file });
  let page = null;
  try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      const list = await getJson(port, '/json/list');
      const hit = list.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
      if (hit) wsUrl = hit.webSocketDebuggerUrl;
      else await delay(100);
    }
    if (!wsUrl) throw new Error('no debugger url for ' + file);
    page = await connect(wsUrl);
    await page.send('Runtime.enable');

    const started = Date.now();
    let lastError = '';
    while (Date.now() - started < PAGE_TIMEOUT_MS) {
      let out = null;
      try {
        out = await page.send('Runtime.evaluate', {
          expression: 'window.__DR_RESULTS_DONE__ ? JSON.stringify(window.__DR_RESULTS__) : ""',
          returnByValue: true
        });
      } catch (err) {
        lastError = String(err.message || err);
        break;
      }
      const value = out && out.result && out.result.value;
      if (value) return JSON.parse(value);
      await delay(POLL_MS);
    }
    if (lastError) {
      return [{ name: 'the page stayed responsive', pass: false, detail: lastError }];
    }
    const errors = await page.send('Runtime.evaluate', {
      expression: 'document.documentElement.getAttribute("data-darkrai") + "|" + (window.Darkrai ? "scripts-loaded" : "no-scripts")',
      returnByValue: true
    }).catch(() => null);
    return [{
      name: 'the fixture reported its result',
      pass: false,
      detail: 'timed out after ' + PAGE_TIMEOUT_MS + 'ms (' +
        ((errors && errors.result && errors.result.value) || 'no state') + ')'
    }];
  } finally {
    if (page) page.close();
    await browser.send('Target.closeTarget', { targetId }).catch(() => { });
  }
}

async function main() {
  const browsers = candidateBrowsers();
  if (!browsers.length) {
    console.log('SKIPPED: no headless browser found on this machine.');
    console.log('  Nothing was downloaded. Set DARKRAI_CHROME to a chrome-headless-shell');
    console.log('  binary, or open tests/fixtures/index.html by hand to see the same checks.');
    return 0;
  }
  const executable = browsers[0];
  console.log('browser: ' + executable);

  const { server, port: httpPort } = await startServer();
  const baseUrl = 'http://127.0.0.1:' + httpPort;
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'darkrai-cdp-'));

  const child = spawn(executable, spawnArgs(userDataDir), { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 2000); });

  let failures = 0;
  let browser = null;
  try {
    const cdpPort = await waitForPort(userDataDir);
    const version = await getJson(cdpPort, '/json/version');
    browser = await connect(version.webSocketDebuggerUrl);

    for (const file of FIXTURE_FILES) {
      let results;
      try {
        results = await runFixture(browser, cdpPort, baseUrl, file);
      } catch (err) {
        results = [{ name: 'the fixture ran', pass: false, detail: String(err.message || err) }];
      }
      const bad = results.filter((r) => !r.pass);
      failures += bad.length;
      console.log('\n' + (bad.length ? 'FAIL' : 'PASS') + '  ' + file);
      for (const r of results) {
        const mark = r.skipped ? ' ~  ' : (r.pass ? ' ok ' : ' XX ');
        console.log(mark + r.name + (r.detail ? '\n      ' + r.detail : ''));
      }
    }
  } catch (err) {
    console.log('ERROR: ' + (err.message || err));
    if (stderr) console.log('browser said: ' + stderr.split('\n').slice(0, 6).join('\n'));
    failures++;
  } finally {
    if (browser) {
      await browser.send('Browser.close').catch(() => { });
      browser.close();
    }
    try { child.kill(); } catch (e) { }
    server.close();
    await delay(200);
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => { });
  }

  console.log('\n' + (failures ? failures + ' check(s) failed' : 'all fixture checks passed'));
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
