/*
 * Darkrai real-Chrome harness - lib.js
 * Node built-ins only: CDP over --remote-debugging-pipe, a tiny PNG decoder
 * and the contrast arithmetic used on screenshot pixels.
 */
'use strict';
const cp = require('child_process');
const zlib = require('zlib');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout after ' + ms + ' ms: ' + what)), ms); })
  ]).finally(() => clearTimeout(t));
}

/** CDP over the pipe transport: '\0'-terminated UTF-8 JSON on fd 3 (in) / fd 4 (out). */
class PipeCDP {
  constructor(proc) {
    this.proc = proc;
    this.w = proc.stdio[3];
    this.r = proc.stdio[4];
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    let buf = Buffer.alloc(0);
    this.r.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let at;
      while ((at = buf.indexOf(0)) >= 0) {
        const raw = buf.subarray(0, at).toString('utf8');
        buf = buf.subarray(at + 1);
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { continue; }
        this._dispatch(msg);
      }
    });
    this.r.on('close', () => { this.closed = true; this._failAll('pipe closed'); });
    this.w.on('error', () => { });
  }

  _failAll(why) {
    for (const [, p] of this.pending) p.reject(new Error(why));
    this.pending.clear();
  }

  _dispatch(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(p.method + ': ' + (msg.error.message || JSON.stringify(msg.error))));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      // A detached session can never answer: fail what was waiting on it.
      if (msg.method === 'Target.detachedFromTarget' && msg.params && msg.params.sessionId) {
        for (const [id, p] of this.pending) {
          if (p.sessionId === msg.params.sessionId) { this.pending.delete(id); p.reject(new Error('session detached')); }
        }
      }
      for (const fn of this.listeners) { try { fn(msg); } catch (e) { } }
    }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  send(method, params, sessionId, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('pipe closed'));
    const id = ++this.id;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, sessionId });
    });
    this.w.write(JSON.stringify(msg) + '\0');
    return withTimeout(p, timeoutMs || 30000, method).catch((e) => { this.pending.delete(id); throw e; });
  }

  waitFor(pred, ms, what) {
    let off;
    const p = new Promise((resolve) => {
      off = this.on((m) => { if (pred(m)) resolve(m); });
    });
    return withTimeout(p, ms, what || 'event').finally(() => off());
  }
}

function launch(chromePath, args) {
  const proc = cp.spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: false });
  return proc;
}

function killTree(pid) {
  try { cp.execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}

// ------------------------------------------------------------------ PNG

function decodePNG(buf) {
  let p = 8, w = 0, h = 0, ct = 0, bd = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9];
      if (data[12]) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error('PNG type not supported: depth ' + bd + ' colour ' + ct);
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = line[i];
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    for (let xI = 0; xI < w; xI++) {
      px[(y * w + xI) * 3] = cur[xI * bpp];
      px[(y * w + xI) * 3 + 1] = cur[xI * bpp + 1];
      px[(y * w + xI) * 3 + 2] = cur[xI * bpp + 2];
    }
    prev = cur;
  }
  return { w, h, px };
}

function lum(c) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function ratio(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function hex(c) { return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''); }

/**
 * Icon contrast from real pixels: background = median of a ring 2 px outside
 * the box, foreground = the 90th-percentile most distinct pixel inside it.
 */
function iconContrast(img, r) {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(img.w - 1, Math.ceil(r.x + r.w) - 1), y1 = Math.min(img.h - 1, Math.ceil(r.y + r.h) - 1);
  if (x1 - x0 < 3 || y1 - y0 < 3) return null;
  const at = (x, y) => { const i = (y * img.w + x) * 3; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
  const ring = [];
  const ox0 = x0 - 2, oy0 = y0 - 2, ox1 = x1 + 2, oy1 = y1 + 2;
  for (let x = ox0; x <= ox1; x++) {
    if (x < 0 || x >= img.w) continue;
    if (oy0 >= 0) ring.push(at(x, oy0));
    if (oy1 < img.h) ring.push(at(x, oy1));
  }
  for (let y = oy0; y <= oy1; y++) {
    if (y < 0 || y >= img.h) continue;
    if (ox0 >= 0) ring.push(at(ox0, y));
    if (ox1 < img.w) ring.push(at(ox1, y));
  }
  if (ring.length < 8) return null;
  const med = [0, 1, 2].map((k) => ring.map((c) => c[k]).sort((a, b) => a - b)[ring.length >> 1]);
  const rs = [];
  let best = med;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const c = at(x, y);
    rs.push({ v: ratio(c, med), c });
  }
  rs.sort((a, b) => a.v - b.v);
  // A sparse glyph (YouTube's kebab: three 4 px dots, 8.3% of a 24 px box)
  // covers less than a tenth of its box, so the box-wide 90th percentile is a
  // background pixel and reads 1:1 for a glyph that is plainly visible. Take
  // the 90th percentile of the glyph pixels instead in that case only. An
  // invisible glyph has no distinct pixels and still reads as a failure.
  const ink = rs.filter((p) => p.v >= 1.5);
  const sparse = ink.length > 0 && ink.length < rs.length * 0.1;
  const pool = sparse ? ink : rs;
  const pick = pool[Math.floor(pool.length * 0.9)];
  best = pick.c;
  return { ratio: Math.round(pick.v * 100) / 100, fg: hex(best), bg: hex(med) };
}

/**
 * Bright, near-neutral regions of a screenshot that a darkened page should
 * not have: seeded at pixels with relative luminance >= 0.7 and OKLCH chroma
 * < 0.08, grown 4-connected through near-neutral pixels of OKLCH L >= 0.5.
 * Kept: components of at least minArea
 * pixels that fill at least half their box (a glyph of light text does not),
 * and strips at least minStrip px long and 3 px thick.
 * Returns { regions, mask } with mask[i] = 1 for a bright pixel.
 */
function lightRegions(img, opts) {
  opts = opts || {};
  const minArea = opts.minArea || 1500, minStrip = opts.minStrip || 300;
  const W = img.w, H = img.h, N = W * H;
  const LIN = new Float64Array(256);
  for (let v = 0; v < 256; v++) { const c = v / 255; LIN[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  // mask: bright seed pixels. grow: near-neutral pixels of OKLCH L >= 0.5 that
  // a component may spread through from a seed, so a fade (Wikipedia's
  // sidebar fade is 16 px from the page colour to white, only its last 3 rows
  // reach luminance 0.7) is measured as the whole light strip it paints.
  const mask = new Uint8Array(N), grow = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = LIN[img.px[i * 3]], g = LIN[img.px[i * 3 + 1]], b = LIN[img.px[i * 3 + 2]];
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (Y < 0.125) continue;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    if (Math.sqrt(A * A + B * B) >= 0.08) continue;
    grow[i] = 1;
    if (Y >= 0.7) mask[i] = 1;
  }
  const label = new Int32Array(N);
  const stack = new Int32Array(N);
  const regions = [];
  let next = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i] || label[i]) continue;
    next++;
    let sp = 0, count = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    stack[sp++] = i; label[i] = next;
    while (sp) {
      const p = stack[--sp]; count++;
      const x = p % W, y = (p - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && grow[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < W - 1 && grow[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && grow[p - W] && !label[p - W]) { label[p - W] = next; stack[sp++] = p - W; }
      if (y < H - 1 && grow[p + W] && !label[p + W]) { label[p + W] = next; stack[sp++] = p + W; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const solid = count / (bw * bh);
    const big = count >= minArea && solid >= 0.5;
    const strip = Math.max(bw, bh) >= minStrip && Math.min(bw, bh) >= 3 && solid >= 0.5;
    if (!big && !strip) continue;
    // A point that is really inside the component: its box centre when that
    // pixel belongs to it, else the component pixel nearest that centre on the
    // centre row or column.
    let cx = Math.floor(x0 + bw / 2), cy = Math.floor(y0 + bh / 2);
    if (label[cy * W + cx] !== next) {
      let best = null;
      for (let x = x0; x <= x1; x++) if (label[cy * W + x] === next && (!best || Math.abs(x - cx) < Math.abs(best[0] - cx))) best = [x, cy];
      for (let y = y0; y <= y1 && !best; y++) if (label[y * W + cx] === next) best = [cx, y];
      if (best) { cx = best[0]; cy = best[1]; }
    }
    regions.push({ id: next, box: [x0, y0, bw, bh], area: count, solid: Math.round(solid * 100) / 100, x: cx + 0.5, y: cy + 0.5 });
  }
  regions.sort((a, b) => b.area - a.area);
  return { regions, mask };
}

/** Share of bright pixels (lightRegions' mask) inside a box [x, y, w, h]. */
function brightShare(img, mask, box) {
  const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(img.w, Math.ceil(box[0] + box[2])), y1 = Math.min(img.h, Math.ceil(box[1] + box[3]));
  let n = 0, on = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; on += mask[y * img.w + x]; }
  return n ? on / n : 0;
}

/**
 * Explained or not, from what the page said was at the region's point:
 * media (img, picture, video, canvas, object, embed, svg image), a url()
 * background photo, or a cross-origin frame whose box is not mostly bright
 * (an ad creative or a video is varied; a blank canvas or a light widget is
 * not). Everything else, scrollbar gutters included, is unexplained.
 */
function explainLight(region, info, img, mask) {
  const v = (info && info.verdict) || { kind: 'unknown' };
  if (v.kind === 'media') return { explained: true, why: 'inside media ' + v.of };
  if (v.kind === 'background-photo') return { explained: true, why: 'inside a url() background on ' + v.of };
  if (v.kind === 'iframe') {
    const f = v.frame || {};
    const share = f.box ? brightShare(img, mask, f.box) : 1;
    region.frameBrightShare = Math.round(share * 100) / 100;
    if (!f.sameOrigin && share < 0.6) return { explained: true, why: 'cross-origin frame with varied (media-like) content, ' + Math.round(share * 100) + '% of its box bright' };
    if (f.sameOrigin && f.inner && f.inner.media > 0 && f.inner.textChars === 0) return { explained: true, why: 'same-origin frame holding only media' };
    return { explained: false, why: (f.sameOrigin ? 'same-origin' : 'cross-origin') + ' frame painted light (' + Math.round(share * 100) + '% of its box bright, element color-scheme ' + f.elementColorScheme + (f.inner ? ', document color-scheme ' + f.inner.rootColorScheme + ', data-darkrai=' + f.inner.darkrai + ', ' + f.inner.textChars + ' text chars' : '') + ')' };
  }
  if (v.kind === 'scrollbar') return { explained: false, why: 'scrollbar of ' + v.of };
  return { explained: false, why: v.kind === 'painted' ? 'painted light by ' + v.of : 'no element explains it (' + v.kind + ')' };
}

module.exports = { sleep, withTimeout, PipeCDP, launch, killTree, decodePNG, iconContrast, ratio, hex, lightRegions, brightShare, explainLight };
