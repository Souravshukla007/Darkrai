/*
 * Darkrai - tests/fixtures/run-rapid-toggle.js
 *
 * Opens fixtures/rapid-toggle.html in the headless shell (the same discovery
 * and server as tests/browser/run-fixtures.js) and prints the checks it makes:
 * after twenty master-switch toggles ~20 ms apart the style set equals the
 * fresh load's, and no task reached 200 ms.
 *
 *   node fixtures/run-rapid-toggle.js [--ext=./some-copy/]
 *
 * --ext points the page at another copy of extension/ under tests/fixtures/.
 * Prints SKIPPED and exits 0 when there is no headless binary.
 */
'use strict';

const { launch, startServer, getJson, connect, delay } = require('../browser/chrome.js');

const EXT = (process.argv.find((a) => a.startsWith('--ext=')) || '').slice(6);
const TIMEOUT_MS = 40000;

async function main() {
  const shell = await launch();
  if (!shell) { console.log('SKIPPED: no headless browser found on this machine.'); return 0; }
  const { server, port } = await startServer();
  let failures = 0;
  try {
    const url = 'http://127.0.0.1:' + port + '/tests/fixtures/rapid-toggle.html' +
      (EXT ? '?ext=' + encodeURIComponent(EXT) : '');
    console.log('browser: ' + shell.executable + '\npage: ' + url);
    const { targetId } = await shell.browser.send('Target.createTarget', { url });
    let ws = null;
    for (let i = 0; i < 40 && !ws; i++) {
      const hit = (await getJson(shell.cdpPort, '/json/list')).find((t) => t.id === targetId);
      if (hit && hit.webSocketDebuggerUrl) ws = hit.webSocketDebuggerUrl; else await delay(100);
    }
    const page = await connect(ws);
    const started = Date.now();
    let results = null;
    while (!results && Date.now() - started < TIMEOUT_MS) {
      const out = await page.send('Runtime.evaluate', {
        expression: 'window.__DR_RESULTS_DONE__ ? JSON.stringify(window.__DR_RESULTS__) : ""',
        returnByValue: true
      }, 10000).catch((e) => ({ error: e.message }));
      if (out && out.result && out.result.value) results = JSON.parse(out.result.value);
      else await delay(250);
    }
    page.close();
    if (!results) results = [{ name: 'the fixture reported its result', pass: false, detail: 'timed out after ' + TIMEOUT_MS + ' ms' }];
    const bad = results.filter((r) => !r.pass);
    failures = bad.length;
    console.log('\n' + (bad.length ? 'FAIL' : 'PASS') + '  rapid-toggle.html' + (EXT ? ' (ext ' + EXT + ')' : ''));
    for (const r of results) console.log((r.skipped ? ' ~  ' : r.pass ? ' ok ' : ' XX ') + r.name + (r.detail ? '\n      ' + r.detail : ''));
  } finally {
    server.close();
    await shell.close();
  }
  console.log('\n' + (failures ? failures + ' check(s) failed' : 'all checks passed'));
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
