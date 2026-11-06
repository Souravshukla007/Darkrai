/*
 * Darkrai real-Chrome harness - browser.js
 * Launch real Google Chrome on a throwaway profile, load the unpacked
 * extension with Extensions.loadUnpacked, and drive tabs over CDP.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sleep, PipeCDP, launch, killTree } = require('./lib');
const { OBSERVE_MAIN, OBSERVE_ISOLATED } = require('./probe');

class Browser {
  static async start(opts) {
    const b = new Browser();
    b.profile = opts.profile;
    fs.mkdirSync(path.join(b.profile, 'Default'), { recursive: true });
    // Developer mode on in the throwaway profile: since M134 an unpacked
    // extension that calls chrome.runtime.reload() with developer mode off is
    // left disabled (crbug.com/402532200). A real developer has it on.
    fs.writeFileSync(path.join(b.profile, 'Default', 'Preferences'),
      JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
    const args = [
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--user-data-dir=' + b.profile,
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--disable-features=ChromeWhatsNewUI,CalculateNativeWinOcclusion',
      // A headed window Chrome believes is covered stops painting, and
      // Page.captureScreenshot then waits for a frame that never comes.
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--window-size=1280,860', '--window-position=40,40', '--force-device-scale-factor=1',
      'about:blank'
    ];
    b.proc = launch(opts.chrome, args);
    b.exited = false;
    b.proc.on('exit', () => { b.exited = true; });
    const log = fs.createWriteStream(opts.logFile);
    b.proc.stdout.pipe(log); b.proc.stderr.pipe(log);
    b.cdp = new PipeCDP(b.proc);
    b.errors = [];        // { where, kind, text }
    b.roleOf = new Map(); // sessionId -> role
    b.contexts = new Map(); // sessionId -> Map(ctxId -> ctx)
    b.cdp.on((m) => b._event(m));
    const v = await b.cdp.send('Browser.getVersion', {}, null, 20000);
    b.version = v.product;
    const r = await b.cdp.send('Extensions.loadUnpacked', { path: opts.extension }, null, 20000);
    b.extId = r.id;
    return b;
  }

  _event(m) {
    const sid = m.sessionId;
    if (!sid) return;
    const ctxs = this.contexts.get(sid);
    if (m.method === 'Runtime.executionContextCreated' && ctxs) ctxs.set(m.params.context.id, m.params.context);
    else if (m.method === 'Runtime.executionContextDestroyed' && ctxs) ctxs.delete(m.params.executionContextId);
    else if (m.method === 'Runtime.executionContextsCleared' && ctxs) ctxs.clear();
    const role = this.roleOf.get(sid);
    if (!role) return;
    if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')) {
      const ctxId = m.method === 'Runtime.exceptionThrown'
        ? m.params.exceptionDetails && m.params.exceptionDetails.executionContextId
        : m.params.executionContextId;
      let where = role;
      if (role === 'site') {
        const c = ctxs && ctxs.get(ctxId);
        if (!c || c.name !== 'Darkrai') return; // the page's own errors are not ours
        where = 'darkrai-isolated';
      }
      let text;
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        text = (d.exception && d.exception.description) || d.text || 'exception';
      } else {
        text = (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
      }
      this.errors.push({ where, kind: m.method === 'Runtime.exceptionThrown' ? 'exception' : 'console.error', text: String(text).split('\n')[0].slice(0, 300) });
    }
  }

  async targets() { return (await this.cdp.send('Target.getTargets')).targetInfos; }

  async swTargets() {
    const pre = 'chrome-extension://' + this.extId + '/';
    return (await this.targets()).filter((t) => t.type === 'service_worker' && t.url.startsWith(pre));
  }

  /** Attach to an existing target (flat session). */
  async attach(targetId, role) {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.contexts.set(sessionId, new Map());
    if (role) this.roleOf.set(sessionId, role);
    const t = new Tab(this, targetId, sessionId);
    await Promise.all([t.send('Page.enable').catch(() => { }), t.send('Runtime.enable')]);
    return t;
  }

  async newTab(url, opts) {
    opts = opts || {};
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank', background: !!opts.background });
    const t = await this.attach(targetId, opts.role || 'site');
    if (opts.scheme) await t.scheme(opts.scheme);
    if (opts.metrics !== false) {
      await t.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    }
    if (url && url !== 'about:blank') await t.go(url);
    return t;
  }

  async close() {
    const pid = this.proc.pid;
    let how = 'Browser.close';
    try { await this.cdp.send('Browser.close', {}, null, 5000); } catch (e) { }
    for (let i = 0; i < 40 && !this.exited; i++) await sleep(250);
    if (!this.exited) { how = 'taskkill /pid ' + pid + ' /t /f'; killTree(pid); await sleep(1000); }
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(this.profile, { recursive: true, force: true, maxRetries: 3 }); break; }
      catch (e) { await sleep(500); }
    }
    return { how, profileRemoved: !fs.existsSync(this.profile) };
  }
}

class Tab {
  constructor(b, targetId, sessionId) { this.b = b; this.targetId = targetId; this.sessionId = sessionId; }
  send(method, params, timeoutMs) { return this.b.cdp.send(method, params, this.sessionId, timeoutMs); }

  async scheme(value) {
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  }

  async go(url, timeoutMs) {
    const sid = this.sessionId;
    const load = this.b.cdp.waitFor((m) => m.sessionId === sid && m.method === 'Page.loadEventFired', timeoutMs || 30000, 'load ' + url)
      .catch(() => 'load-timeout');
    const r = await this.send('Page.navigate', { url }, timeoutMs || 30000);
    const l = await load;
    return { errorText: r.errorText || null, loadTimedOut: l === 'load-timeout' };
  }

  async eval(expression, contextId, timeoutMs) {
    const p = { expression, returnByValue: true, awaitPromise: true, userGesture: true };
    if (contextId) p.contextId = contextId;
    const r = await this.send('Runtime.evaluate', p, timeoutMs || 20000);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval: ' + ((d.exception && d.exception.description) || d.text).split('\n')[0]);
    }
    return r.result.value;
  }

  /** Darkrai isolated-world contexts in the main frame (frame id == target id). */
  darkraiContexts() {
    const ctxs = this.b.contexts.get(this.sessionId) || new Map();
    return [...ctxs.values()].filter((c) => c.name === 'Darkrai' && c.auxData && c.auxData.type === 'isolated' &&
      c.auxData.frameId === this.targetId).sort((a, b) => a.id - b.id);
  }

  async observe() {
    const main = await this.eval(OBSERVE_MAIN);
    const iso = [];
    for (const c of this.darkraiContexts()) {
      try { iso.push(Object.assign({ ctx: c.id }, await this.eval(OBSERVE_ISOLATED, c.id, 5000))); }
      catch (e) { iso.push({ ctx: c.id, error: e.message }); }
    }
    const live = iso.filter((x) => x.status && x.status.ok);
    main.darkraiAdopted = iso.reduce((a, x) => a + (x.adopted || 0), 0);
    main.isolatedWorlds = iso.length;
    main.status = live.length ? live[live.length - 1].status : null;
    main.timing = live.length ? live[live.length - 1].timing : null;
    main.darkraiStyles = main.styleNodes + main.darkraiAdopted;
    return main;
  }

  /** Wait until Darkrai's decision and style count hold still for 1.5 s. */
  async settle(maxMs) {
    const end = Date.now() + (maxMs || 15000);
    let last = null, stable = 0, o = null;
    while (Date.now() < end) {
      try { o = await this.observe(); } catch (e) { o = { error: e.message }; }
      const key = o.error ? 'err' : o.attr + '|' + o.darkraiStyles;
      if (key === last && o.attr) stable++; else stable = 0;
      last = key;
      if (stable >= 6) { o.settled = true; return o; }
      await sleep(250);
    }
    if (o) o.settled = false;
    return o;
  }

  async poll(fn, ms, every) {
    const end = Date.now() + ms;
    const t0 = Date.now();
    let o = null;
    while (Date.now() < end) {
      try { o = await this.observe(); } catch (e) { o = null; }
      if (o && fn(o)) { o.afterMs = Date.now() - t0; return o; }
      await sleep(every || 50);
    }
    if (o) o.afterMs = null;
    return o;
  }

  /**
   * PNG of this page. The page is brought to the front first so an occluded
   * window cannot stall the capture. opts.clip === false captures the page's
   * own viewport (a popup) instead of the 1280x800 site viewport.
   */
  async screenshot(opts) {
    opts = opts || {};
    await this.send('Page.bringToFront', {}, 5000).catch(() => { });
    const params = { format: 'png' };
    if (opts.clip !== false) params.clip = { x: 0, y: 0, width: 1280, height: 800, scale: 1 };
    const r = await this.send('Page.captureScreenshot', params, opts.timeoutMs || 30000);
    return Buffer.from(r.data, 'base64');
  }

  /** Real mouse click at viewport coordinates. */
  async clickAt(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base, { button: 'none' }));
    await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
    await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base));
  }

  /** Real key press (down and up) on whatever has focus in this page. */
  async key(name) {
    const vk = { Escape: 27, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[name];
    const p = { key: name, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, p));
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, p));
  }

  /** Real mouse click at the centre of sel (or fallback when sel is hidden). */
  async click(sel, fallback) {
    const box = await this.eval(`(() => {
      const pick = (s) => s ? document.querySelector(s) : null;
      let e = pick(${JSON.stringify(sel)});
      if (!e) return null;
      e.scrollIntoView({ block: 'center' });
      let b = e.getBoundingClientRect();
      if ((b.width < 2 || b.height < 2) && pick(${JSON.stringify(fallback || '')})) b = pick(${JSON.stringify(fallback || '')}).getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
    })()`);
    if (!box) throw new Error('no element ' + sel);
    await this.clickAt(box.x, box.y);
    return box;
  }

  async activate() { await this.b.cdp.send('Target.activateTarget', { targetId: this.targetId }); }
  async close() { try { await this.b.cdp.send('Target.closeTarget', { targetId: this.targetId }, null, 5000); } catch (e) { } }
}

module.exports = { Browser, Tab };
