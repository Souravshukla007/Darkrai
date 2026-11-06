/*
 * Darkrai - tests/browser/run-perf.js
 *
 * Measures what Darkrai costs on the fixtures, so an optimisation can be
 * compared against something real instead of against a feeling.
 *
 * Built exactly like run-fixtures.js: a small static server, the DevTools
 * protocol over the WebSocket client built into Node, no dependencies, nothing
 * downloaded, and your everyday Chrome is never launched. Point it at an
 * existing headless binary:
 *
 *   set DARKRAI_CHROME=C:\path\to\chrome-headless-shell.exe
 *   node tests/browser/run-perf.js [output.json]
 *
 * With no binary to use it prints SKIPPED and exits 0.
 *
 * Two kinds of number come back:
 *   - Darkrai's own, from the dev-only timing module (shared/timing.js), which
 *     this runner switches on by forcing debug into the test shim's store.
 *   - Chrome's own, from the Performance domain (RecalcStyleCount, LayoutCount
 *     and their durations).
 * Anything the harness genuinely cannot see is written as
 * { unmeasurable: "<reason>" } rather than as a zero.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');          // Extentions/darkrai
const PAGE_TIMEOUT_MS = 25000;
const CALL_TIMEOUT_MS = 8000;
const POLL_MS = 100;
const DEFAULT_OUT = path.join(ROOT, '.agents', 'tasks', 'perf-before.json');

// The six pages the engine really works on, plus native-dark as the near-zero
// control: Darkrai leaves it alone, so its numbers are the floor.
const MEASURED = [
  'light.html',
  'css-variables.html',
  'inline.html',
  'low-contrast.html',
  'shadow-dom.html',
  'small-icons.html',
  'native-dark.html'
];

const CONTROL = 'native-dark.html';

// Darkrai's own numbers, then Chrome's.
const METRICS = [
  ['decisionMs', 'time to the already-dark decision (ms)'],
  ['firstPaintMs', 'time to the first Darkrai paint (ms)'],
  ['idleMs', 'time to idle (ms)'],
  ['styleNodes', 'style nodes created'],
  ['adoptedSheets', 'adopted Darkrai sheets'],
  ['guardMeasured', 'elements the readability guard measured'],
  ['forcedReads', 'read-after-write proxy (NOT Chrome\'s own count)'],
  ['recalcStyleCount', 'Chrome RecalcStyleCount'],
  ['layoutCount', 'Chrome LayoutCount'],
  ['recalcStyleDurationMs', 'Chrome RecalcStyleDuration (ms)'],
  ['layoutDurationMs', 'Chrome LayoutDuration (ms)']
];

// Forces the dev-only debug flag into the page before any of its own scripts
// run. The fixtures set window.__DR_SHIM__ themselves, so we cannot simply
// assign it: we install an accessor that merges debug into whatever they set.
const FORCE_DEBUG = [
  '(function () {',
  '  var value = { debug: true };',
  '  try {',
  '    Object.defineProperty(window, "__DR_SHIM__", {',
  '      configurable: true,',
  '      get: function () { return value; },',
  '      set: function (next) {',
  '        value = Object.assign({}, next || {}, { debug: true });',
  '      }',
  '    });',
  '  } catch (e) { window.__DR_SHIM__ = value; }',
  '})();'
].join('\n');

// ------------------------------------------------------------- find a browser

function candidateBrowsers() {
  const list = [];
  if (process.env.DARKRAI_CHROME) list.push(process.env.DARKRAI_CHROME);
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH);
  if (process.env.PUPPETEER_EXECUTABLE_PATH) list.push(process.env.PUPPETEER_EXECUTABLE_PATH);

  // Fallbacks, each searched only when it exists; DARKRAI_CHROME always wins.
  const searchRoots = [
    path.resolve(ROOT, '..', '..'),            // two folders above this repository
    path.join(os.homedir(), '.cache', 'puppeteer'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright')
  ];
  const wanted = /^(chrome-headless-shell|headless_shell)(\.exe)?$/i;
  for (const base of searchRoots) if (fs.existsSync(base)) walk(base, 0);
  function walk(dir, depth) {
    if (depth > 7) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && wanted.test(entry.name)) { list.push(full); continue; }
      if (!entry.isDirectory()) continue;
      if (depth === 0 && !/^(node_modules|\.cache|AppData|chrome.*|.*playwright.*|.*puppeteer.*|youtube.*|\.kiro.*)$/i.test(entry.name)) continue;
      walk(full, depth + 1);
    }
  }
  return list.filter((file, i) => list.indexOf(file) === i && fs.existsSync(file));
}

// ---------------------------------------------------------- static file server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const target = path.resolve(ROOT, '.' + decodeURIComponent(url.pathname));
      if (!target.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
      fs.readFile(target, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, {
          'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-store'
        });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// --------------------------------------------------------------- CDP plumbing

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) bad(new Error(msg.error.message || 'cdp error'));
        else ok(msg.result);
      }
    });
    socket.addEventListener('error', () => reject(new Error('websocket error: ' + wsUrl)));
    socket.addEventListener('open', () => {
      resolve({
        // Every call has a deadline: a page that locks up must report a
        // failure rather than stall the whole run.
        send(method, params, timeoutMs) {
          const id = nextId++;
          return new Promise((ok, bad) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              bad(new Error(method + ' timed out after ' + (timeoutMs || CALL_TIMEOUT_MS) + 'ms'));
            }, timeoutMs || CALL_TIMEOUT_MS);
            pending.set(id, {
              resolve: (value) => { clearTimeout(timer); ok(value); },
              reject: (err) => { clearTimeout(timer); bad(err); }
            });
            socket.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() { try { socket.close(); } catch (e) { } }
      });
    });
  });
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForPort(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 160; i++) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      const port = Number(text.split('\n')[0]);
      if (port) return port;
    } catch (e) { /* not written yet */ }
    await delay(125);
  }
  throw new Error('the browser never reported a DevTools port');
}

async function getJson(port, route) {
  const res = await fetch('http://127.0.0.1:' + port + route);
  return res.json();
}

// -------------------------------------------------------------- measurement

function unmeasurable(reason) { return { unmeasurable: reason }; }

function numberOr(value, reason) {
  return typeof value === 'number' && isFinite(value) ? value : unmeasurable(reason);
}

function metricsToMap(list) {
  const out = new Map();
  for (const entry of list || []) out.set(entry.name, entry.value);
  return out;
}

/** Open one fixture with debug forced on and read both sets of numbers. */
async function measureFixture(browser, port, baseUrl, file) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
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

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    let perfOn = true;
    try { await page.send('Performance.enable'); }
    catch (e) { perfOn = false; }

    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FORCE_DEBUG });
    await page.send('Page.navigate', { url: baseUrl + '/tests/fixtures/' + file });

    // The fixture tells us when it has finished measuring itself.
    const started = Date.now();
    let done = false;
    while (Date.now() - started < PAGE_TIMEOUT_MS) {
      const out = await page.send('Runtime.evaluate', {
        expression: 'window.__DR_RESULTS_DONE__ === true',
        returnByValue: true
      });
      if (out && out.result && out.result.value === true) { done = true; break; }
      await delay(POLL_MS);
    }
    if (!done) throw new Error('the fixture never reported it had settled');

    const raw = await page.send('Runtime.evaluate', {
      expression: 'typeof window.__darkraiTiming === "function" ? JSON.stringify(window.__darkraiTiming()) : ""',
      returnByValue: true
    });
    const text = raw && raw.result && raw.result.value;
    const timing = text ? JSON.parse(text) : null;

    let chrome = new Map();
    if (perfOn) {
      try {
        const got = await page.send('Performance.getMetrics');
        chrome = metricsToMap(got && got.metrics);
      } catch (e) { perfOn = false; }
    }

    const state = await page.send('Runtime.evaluate', {
      expression: 'document.documentElement.getAttribute("data-darkrai") || "none"',
      returnByValue: true
    }).catch(() => null);

    return {
      timing: timing,
      chrome: chrome,
      perfOn: perfOn,
      state: (state && state.result && state.result.value) || 'none'
    };
  } finally {
    if (page) page.close();
    await browser.send('Target.closeTarget', { targetId }).catch(() => { });
  }
}

/** Turn one raw reading into the recorded row, with honest gaps. */
function rowFor(file, reading) {
  if (reading.error) {
    const row = { state: 'error', error: reading.error };
    for (const [key] of METRICS) row[key] = unmeasurable('the page could not be measured: ' + reading.error);
    return row;
  }

  const t = reading.timing;
  const left = file === CONTROL
    ? 'Darkrai left this page alone: it has a dark theme of its own, so there is nothing to time'
    : 'Darkrai never reached this mark on this page';

  let timingGap = null;
  if (!t) timingGap = 'shared/timing.js did not load, so window.__darkraiTiming was missing';
  else if (!t.enabled) timingGap = 'the timing module stayed disabled: the debug flag never reached the page';

  const own = (key, reason) => {
    if (timingGap) return unmeasurable(timingGap);
    return numberOr(t[key], reason);
  };

  const chromeNum = (name, scale) => {
    if (!reading.perfOn) return unmeasurable('the Performance domain was not available in this browser');
    if (!reading.chrome.has(name)) return unmeasurable('this build of Chrome does not report ' + name);
    const v = reading.chrome.get(name);
    return numberOr(typeof v === 'number' ? v * (scale || 1) : v, 'Chrome reported ' + name + ' as ' + v);
  };

  return {
    state: reading.state,
    decisionMs: own('decisionMs', 'no already-dark measurement ran: a setting decided this page outright'),
    firstPaintMs: own('firstPaintMs', left),
    idleMs: own('idleMs', left),
    styleNodes: own('styleNodes', left),
    adoptedSheets: own('adoptedSheets', left),
    guardMeasured: own('guardMeasured', left),
    forcedReads: own('forcedReads', left),
    recalcStyleCount: chromeNum('RecalcStyleCount'),
    layoutCount: chromeNum('LayoutCount'),
    recalcStyleDurationMs: chromeNum('RecalcStyleDuration', 1000),
    layoutDurationMs: chromeNum('LayoutDuration', 1000),
    marks: timingGap ? unmeasurable(timingGap) : (t.marks || {})
  };
}

function show(value) {
  if (value && typeof value === 'object' && value.unmeasurable) return 'unmeasurable (' + value.unmeasurable + ')';
  if (typeof value !== 'number') return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// ------------------------------------------------------------------- the run

async function main() {
  // A relative path is read against the project folder, not the shell's
  // working directory: `node browser/run-perf.js .agents/tasks/perf-after.json`
  // run from tests/ has to land beside perf-before.json.
  const arg = process.argv[2];
  const outPath = !arg ? DEFAULT_OUT
    : (path.isAbsolute(arg) ? arg : path.resolve(ROOT, arg));

  const browsers = candidateBrowsers();
  if (!browsers.length) {
    console.log('SKIPPED: no headless browser found on this machine.');
    console.log('  Nothing was downloaded and no numbers were invented. Set DARKRAI_CHROME');
    console.log('  to a chrome-headless-shell binary to record a baseline.');
    return 0;
  }
  const executable = browsers[0];
  console.log('browser: ' + executable);
  console.log('writing: ' + outPath);

  const { server, port: httpPort } = await startServer();
  const baseUrl = 'http://127.0.0.1:' + httpPort;
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'darkrai-perf-'));

  const child = spawn(executable, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--window-size=1280,900',
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 2000); });

  const rows = {};
  let failures = 0;
  let browser = null;
  try {
    const cdpPort = await waitForPort(userDataDir);
    const version = await getJson(cdpPort, '/json/version');
    browser = await connect(version.webSocketDebuggerUrl);

    for (const file of MEASURED) {
      let reading;
      try {
        reading = await measureFixture(browser, cdpPort, baseUrl, file);
      } catch (err) {
        reading = { error: String(err.message || err) };
        failures++;
      }
      const row = rowFor(file, reading);
      rows[file] = row;
      console.log('\n' + file + (file === CONTROL ? '   (control: left alone)' : '') +
        '   data-darkrai=' + row.state);
      for (const [key, label] of METRICS) {
        console.log('  ' + label.padEnd(52) + show(row[key]));
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
    // Windows keeps the profile locked until the browser has really exited,
    // so wait for that (up to 3 s) and retry, as chrome.js launch() does.
    for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
    for (let i = 0; i < 10 && fs.existsSync(userDataDir); i++) {
      await fsp.rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => { });
      if (fs.existsSync(userDataDir)) await delay(250);
    }
    if (fs.existsSync(userDataDir)) console.warn('could not remove temp profile ' + userDataDir);
  }

  const payload = {
    recorded: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    browser: executable,
    control: CONTROL,
    notes: {
      forcedReads: 'A PROXY, not Chrome\'s forced-recalc count: the number of times Darkrai read computed style or geometry in a task in which it had already written.',
      timing: 'Darkrai\'s own marks come from extension/shared/timing.js and are milliseconds since the page time origin.',
      chrome: 'RecalcStyleCount, LayoutCount and the two durations come from the DevTools Performance domain and cover the whole page, the fixture\'s own scripts included.',
      settle: 'Each page is read as soon as its own checks report __DR_RESULTS_DONE__; the engine\'s one-second upkeep tick may still run after that.'
    },
    fixtures: rows
  };

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log('\n' + (failures ? failures + ' fixture(s) could not be measured' : 'perf baseline written'));
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
