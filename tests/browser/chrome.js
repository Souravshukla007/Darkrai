/*
 * Darkrai - tests/browser/chrome.js
 *
 * The headless-Chrome harness shared by every browser suite: finding a binary
 * that is already on the machine, the dependency-free static server rooted at
 * the project folder, and the DevTools protocol over the WebSocket client built
 * into Node.
 *
 * Two rules this file exists to keep in one place:
 *   - nothing is ever downloaded (no Playwright, no Puppeteer, no Chromium);
 *   - your everyday Chrome is never launched, only a headless shell.
 *
 * candidateBrowsers() returns an empty list when there is nothing to use, and
 * every runner turns that into "SKIPPED" and exit 0.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');          // Extentions/darkrai
const CALL_TIMEOUT_MS = 8000;

// ------------------------------------------------------------- find a browser

function candidateBrowsers() {
  const list = [];
  if (process.env.DARKRAI_CHROME) list.push(process.env.DARKRAI_CHROME);
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH);
  if (process.env.PUPPETEER_EXECUTABLE_PATH) list.push(process.env.PUPPETEER_EXECUTABLE_PATH);

  // Fallbacks: headless shells that other tooling may already have unpacked
  // locally. Each root is only searched when it exists; none is required,
  // and DARKRAI_CHROME above always wins.
  const searchRoots = [
    path.resolve(ROOT, '..', '..'),            // two folders above this repository
    path.join(os.homedir(), '.cache', 'puppeteer'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright')
  ];
  const wanted = /^(chrome-headless-shell|headless_shell)(\.exe)?$/i;
  for (const base of searchRoots) {
    if (fs.existsSync(base)) walk(base, 0);
  }
  function walk(dir, depth) {
    if (depth > 7) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && wanted.test(entry.name)) { list.push(full); continue; }
      if (!entry.isDirectory()) continue;
      // Only follow paths that could plausibly hold a browser, to stay quick.
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

/** The command line every suite launches the headless shell with. */
function spawnArgs(userDataDir) {
  return [
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
  ];
}

/**
 * Start a headless shell and connect to it.
 * Returns null when there is no binary to use, so the caller can print SKIPPED.
 */
async function launch(options) {
  const opts = options || {};
  const executable = opts.executable || candidateBrowsers()[0];
  if (!executable) return null;

  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'darkrai-cdp-'));
  const child = spawn(executable, spawnArgs(userDataDir), { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 2000); });

  const cleanup = async (browser) => {
    if (browser) {
      await browser.send('Browser.close').catch(() => { });
      browser.close();
    }
    // Wait (briefly) for the process to exit so its file locks are released.
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((r) => child.once('exit', r));
    try { child.kill(); } catch (e) { }
    await Promise.race([exited, delay(3000)]);
    // Remove the temporary profile, retrying while Chrome lets go of files.
    // A failed cleanup is logged, never allowed to fail a suite.
    let lastErr = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await fsp.rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (!fs.existsSync(userDataDir)) { lastErr = null; break; }
      } catch (e) { lastErr = e; }
      await delay(250);
    }
    if (lastErr || fs.existsSync(userDataDir)) {
      console.warn('[chrome.js] could not remove temp profile ' + userDataDir +
        (lastErr ? ': ' + lastErr.message : ''));
    }
  };

  try {
    const cdpPort = await waitForPort(userDataDir);
    const version = await getJson(cdpPort, '/json/version');
    const browser = await connect(version.webSocketDebuggerUrl);
    let closed = false;
    return {
      executable,
      browser,
      cdpPort,
      userDataDir,
      stderr: () => stderr,
      async close() {
        if (closed) return;
        closed = true;
        await cleanup(browser);
      }
    };
  } catch (err) {
    await cleanup(null);
    err.browserStderr = stderr;
    throw err;
  }
}

module.exports = {
  ROOT,
  CALL_TIMEOUT_MS,
  MIME,
  candidateBrowsers,
  startServer,
  connect,
  delay,
  waitForPort,
  getJson,
  spawnArgs,
  launch
};
