/*
 * Darkrai real-Chrome harness - probe.js
 * Page-side expressions, evaluated over CDP. Ported from
 * tests/fixtures/assert.js (style-node / adopted-sheet counting) and
 * tests/browser/ui-probe.js (visibility, elementsFromPoint, alpha compositing).
 */
'use strict';

// Main world: what anyone can see on the document.
const OBSERVE_MAIN = `(() => {
  const g = {};
  document.querySelectorAll('style[data-darkrai]').forEach((s) => {
    const k = s.getAttribute('data-darkrai') || '';
    g[k] = (g[k] || 0) + 1;
  });
  let total = 0;
  const cnt = (r) => { try { total += (r.adoptedStyleSheets || []).length; } catch (e) { } };
  cnt(document);
  for (const e of document.querySelectorAll('*')) if (e.shadowRoot) cnt(e.shadowRoot);
  const de = document.documentElement;
  const texts = new Set();
  let dup = 0;
  document.querySelectorAll('style[data-darkrai]').forEach((s) => {
    const k = (s.getAttribute('data-darkrai') || '') + '\\u0000' + s.textContent;
    if (s.textContent && texts.has(k)) dup++; else texts.add(k);
  });
  return {
    url: location.href,
    attr: de.getAttribute('data-darkrai'),
    duplicateStyles: dup,
    styleNodes: Object.values(g).reduce((a, b) => a + b, 0),
    styleGroups: g,
    adoptedTotal: total,
    ytDarkAttr: de.hasAttribute('dark'),
    rootBg: getComputedStyle(de).backgroundColor,
    bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null,
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches
  };
})()`;

// Main world, for the popup checks (P4): the filter engine on <html>, the
// picker's host node, and a fingerprint of Darkrai's <style> text and of the
// colours it paints, so a look change can be seen to reach the page.
const OBSERVE_EXTRA = `(() => {
  const txt = [...document.querySelectorAll('style[data-darkrai]')]
    .map((s) => s.getAttribute('data-darkrai') + ':' + s.textContent).join('\\n');
  let h = 0;
  for (let i = 0; i < txt.length; i++) h = (h * 31 + txt.charCodeAt(i)) | 0;
  const de = document.documentElement;
  return {
    htmlFilter: getComputedStyle(de).filter,
    picker: !!document.querySelector('[data-darkrai="picker"]'),
    fixesStyle: !!document.querySelector('style[data-darkrai="fixes"]'),
    styleHash: h,
    styleChars: txt.length,
    rootBg: getComputedStyle(de).backgroundColor,
    bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null,
    bodyColor: document.body ? getComputedStyle(document.body).color : null
  };
})()`;

// Darkrai's isolated world: the __darkrai expando on adopted sheets is only
// visible from the world that set it, so the adopted count must be read here.
const OBSERVE_ISOLATED = `(() => {
  let n = 0;
  const cnt = (r) => { try { for (const s of (r.adoptedStyleSheets || [])) if (s && s.__darkrai) n++; } catch (e) { } };
  cnt(document);
  for (const e of document.querySelectorAll('*')) if (e.shadowRoot) cnt(e.shadowRoot);
  let status = null, timing = null;
  try { status = window.Darkrai && Darkrai.main && Darkrai.main.status ? Darkrai.main.status() : null; } catch (e) { status = { error: String(e) }; }
  try { timing = typeof window.__darkraiTiming === 'function' ? window.__darkraiTiming() : null; } catch (e) { }
  if (status) { delete status.guard; delete status.icons; }
  return { adopted: n, status, timing };
})()`;

// Readability sweep of the viewport. Text: computed colours composited over
// the real stack under the glyphs. Icons: boxes returned for pixel sampling.
const PROBE = `(() => {
  const VW = innerWidth, VH = innerHeight;
  function num(s) { s = String(s).trim(); return s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s); }
  function parse(c) {
    if (!c) return null;
    let m = /^rgba?\\(([^)]+)\\)/.exec(c);
    if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean); return { r: num(p[0]), g: num(p[1]), b: num(p[2]), a: p.length > 3 ? num(p[3]) : 1 }; }
    m = /^color\\(srgb ([^)]+)\\)/.exec(c);
    if (m) { const p = m[1].split(/[\\s\\/]+/).filter(Boolean); return { r: num(p[0]) * 255, g: num(p[1]) * 255, b: num(p[2]) * 255, a: p.length > 3 ? num(p[3]) : 1 }; }
    return null;
  }
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const CR = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const hx = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  function sel(el) {
    let out = el.tagName.toLowerCase();
    if (el.id) return out + '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim() : (el.className && el.className.baseVal) || '';
    if (cls) out += '.' + cls.split(/\\s+/).slice(0, 2).join('.');
    const p = el.parentElement;
    if (p && p !== document.body) out = (p.id ? p.tagName.toLowerCase() + '#' + p.id : p.tagName.toLowerCase()) + ' > ' + out;
    return out;
  }
  function vis(el) {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    // Stop below <html>: it carries data-darkrai="on" itself, and only
    // Darkrai's own UI (picker, panels) below it should be skipped.
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('hidden')) return false;
      if (n.hasAttribute('data-darkrai')) return false;
    }
    return true;
  }
  function filtered(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const f = getComputedStyle(n).filter;
      if (f && f !== 'none' && /invert|hue-rotate/.test(f)) return f;
    }
    return null;
  }
  // The colour under (x, y) beneath el, alpha-composited bottom-up.
  function bgAt(el, x, y) {
    const list = document.elementsFromPoint(x, y);
    let i = list.indexOf(el);
    if (i < 0) i = list.findIndex((e) => e.contains(el));
    if (i < 0) return { hidden: true };
    for (let k = 0; k < i; k++) {
      const e = list[k];
      if (e.contains(el) || el.contains(e)) continue;
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a >= 0.95) return { covered: true };
    }
    const layers = [];
    let image = false;
    for (let k = i; k < list.length; k++) {
      const cs = getComputedStyle(list[k]);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') image = true;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
      if (image) break;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let k = layers.length - 1; k >= 0; k--) base = over(layers[k], base);
    return { bg: base, image };
  }

  // exempt: text inside a disabled control. WCAG 1.4.3 exempts text that is
  // part of an inactive user interface component, so it is counted, not judged.
  const text = { measured: 0, below: 0, uncertain: 0, exempt: 0, worst: [] };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let n, guard = 0;
  while ((n = walker.nextNode()) && guard++ < 6000) {
    if (!/\\S/.test(n.nodeValue || '')) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
    seen.add(el);
    if (el.closest(':disabled, [aria-disabled="true"]')) { text.exempt++; continue; }
    const range = document.createRange();
    range.selectNodeContents(n);
    const rect = Array.from(range.getClientRects()).find((r) => r.width >= 2 && r.height >= 4 && r.bottom > 0 && r.right > 0 && r.top < VH && r.left < VW);
    if (!rect) continue;
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color);
    if (!fg || fg.a < 0.05) continue;
    const x = Math.min(VW - 1, Math.max(0, rect.left + rect.width / 2)), y = Math.min(VH - 1, Math.max(0, rect.top + rect.height / 2));
    const b = bgAt(el, x, y);
    if (b.hidden || b.covered) continue;
    const fs = parseFloat(cs.fontSize) || 16, bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
    const need = fs >= 24 || (bold && fs >= 18.66) ? 3 : 4.5;
    const f = filtered(el);
    if (b.image || f) { text.uncertain++; continue; }
    const r = CR(over(fg, b.bg), b.bg);
    text.measured++;
    if (r < need) {
      text.below++;
      text.worst.push({ selector: sel(el), text: (n.nodeValue || '').trim().slice(0, 30), fg: cs.color, bg: hx(b.bg), ratio: Math.round(r * 100) / 100, need, fontPx: fs });
    }
  }
  text.worst.sort((a, b) => a.ratio - b.ratio);
  text.worst = text.worst.slice(0, 5);

  const icons = [];
  const cand = document.querySelectorAll('svg, img, i, span[class*="icon"], [class*="icon"]:not(svg *), [class*="fa-"]');
  for (const el of cand) {
    if (icons.length >= 200) break;
    if (el.tagName.toLowerCase() === 'svg' && el.parentElement && el.parentElement.closest('svg')) continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    // Not an icon: an element that says it has none (Wikipedia's tabs carry
    // vector-tab-noicon, which [class*="icon"] matches), or one with its own
    // text, which the text sweep above already measures as text.
    const clsText = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    if (/-noicon\\b/.test(clsText)) continue;
    if (Array.prototype.some.call(el.childNodes, (c) => c.nodeType === 3 && /\\S/.test(c.nodeValue || ''))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.width > 64 || r.height > 64) continue;
    if (r.bottom <= 2 || r.right <= 2 || r.top >= VH - 2 || r.left >= VW - 2) continue;
    const isFont = el.tagName !== 'svg' && el.tagName !== 'IMG' && !el.querySelector('svg,img');
    if (isFont) {
      const before = getComputedStyle(el, '::before').content;
      const hasText = /\\S/.test(el.textContent || '');
      if ((!before || before === 'none' || before === 'normal') && !hasText && getComputedStyle(el).backgroundImage === 'none') continue;
    }
    if (!vis(el)) continue;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || !(top === el || el.contains(top) || top.contains(el))) continue;
    icons.push({ selector: sel(el), kind: el.tagName.toLowerCase(), x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return { viewport: [VW, VH], text, icons };
})()`;

// Light regions (problem 3, "doesn't fit the theme"): for each bright region
// found in the screenshot, what is painted at a point inside it. The stack
// from elementsFromPoint, each element's own and ::before/::after
// backgrounds, whether the point is in an element's scrollbar gutter, and for
// an <iframe> its colour schemes and, when readable, its document.
function LIGHT_EXPLAIN(points) {
  return `((points) => {
  const MEDIA = { IMG: 1, PICTURE: 1, VIDEO: 1, CANVAS: 1, OBJECT: 1, EMBED: 1, image: 1 };
  const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '...' : s; };
  function sel(el) {
    if (!el || el.nodeType !== 1) return String(el);
    let out = el.tagName.toLowerCase();
    if (el.id) return out + '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim() : (el.className && el.className.baseVal) || '';
    if (cls) out += '.' + cls.split(/\\s+/).slice(0, 3).join('.');
    const p = el.parentElement;
    if (p) out = (p.id ? p.tagName.toLowerCase() + '#' + p.id : p.tagName.toLowerCase()) + ' > ' + out;
    return out;
  }
  function alpha(c) { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return 1; const p = m[1].split(/[\\s,\\/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; }
  function pseudo(el, which) {
    const cs = getComputedStyle(el, which);
    if (!cs.content || cs.content === 'none' || cs.content === 'normal') return null;
    if (cs.backgroundImage === 'none' && alpha(cs.backgroundColor) === 0) return null;
    return { bgColor: cs.backgroundColor, bgImage: cut(cs.backgroundImage, 200), position: cs.position };
  }
  function gutter(el, x, y) {
    if (el === document.documentElement || el === document.body) return null;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
    const vw = el.offsetWidth - el.clientWidth - bl - br, hh = el.offsetHeight - el.clientHeight - bt - bb;
    const inV = vw > 0 && x >= r.right - br - vw - 0.5 && x <= r.right - br + 0.5 && y >= r.top && y <= r.bottom;
    const inH = hh > 0 && y >= r.bottom - bb - hh - 0.5 && y <= r.bottom - bb + 0.5 && x >= r.left && x <= r.right;
    if (!inV && !inH) return null;
    return { axis: inV ? 'vertical' : 'horizontal', size: inV ? vw : hh, colorScheme: cs.colorScheme, scrollbarColor: cs.scrollbarColor,
      scrollbarWidth: cs.scrollbarWidth, overflowY: cs.overflowY, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
  }
  function frameInfo(f) {
    const r = f.getBoundingClientRect();
    const out = { src: cut(f.getAttribute('src') || '(none)', 160), id: f.id || '', title: cut(f.title || f.getAttribute('aria-label') || '', 60),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      elementColorScheme: getComputedStyle(f).colorScheme, sameOrigin: false };
    let d = null;
    try { d = f.contentDocument; } catch (e) { d = null; }
    if (d && d.documentElement) {
      out.sameOrigin = true;
      const de = d.documentElement, body = d.body;
      out.inner = { url: cut(d.URL, 120), darkrai: de.getAttribute('data-darkrai'), rootColorScheme: getComputedStyle(de).colorScheme,
        rootBg: getComputedStyle(de).backgroundColor, bodyBg: body ? getComputedStyle(body).backgroundColor : null,
        textChars: ((body && body.innerText) || '').trim().length, elements: d.getElementsByTagName('*').length,
        media: d.querySelectorAll('img,picture,video,canvas,svg,iframe,object,embed').length };
    }
    return out;
  }
  // document.elementsFromPoint stops at a shadow host; go on inside open roots.
  function stackAt(x, y) {
    let list = document.elementsFromPoint(x, y);
    for (let depth = 0; depth < 4 && list[0] && list[0].shadowRoot; depth++) {
      const inner = list[0].shadowRoot.elementsFromPoint(x, y).filter((e) => list.indexOf(e) < 0 && list[0].shadowRoot.contains(e));
      if (!inner.length) break;
      list = inner.concat(list);
    }
    return list;
  }
  return points.map((p) => {
    const x = p.x, y = p.y;
    const list = stackAt(x, y).slice(0, 8);
    const stack = [];
    let verdict = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i], cs = getComputedStyle(e);
      const item = { el: sel(e), bgColor: cs.backgroundColor, bgImage: cut(cs.backgroundImage, 200), colorScheme: cs.colorScheme };
      const b = pseudo(e, '::before'), a = pseudo(e, '::after');
      if (b) item.before = b;
      if (a) item.after = a;
      const g = gutter(e, x, y);
      if (g) item.scrollbar = g;
      stack.push(item);
      if (verdict) continue;
      if (g) { verdict = { kind: 'scrollbar', of: sel(e) }; continue; }
      if (MEDIA[e.tagName] || MEDIA[e.localName]) { verdict = { kind: 'media', of: sel(e) }; continue; }
      if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') { item.frame = frameInfo(e); verdict = { kind: 'iframe', of: sel(e), frame: item.frame }; continue; }
      if (/url\\(/.test(cs.backgroundImage)) { verdict = { kind: 'background-photo', of: sel(e) }; continue; }
      if (alpha(cs.backgroundColor) >= 0.95 || (cs.backgroundImage && cs.backgroundImage !== 'none')) verdict = { kind: 'painted', of: sel(e) };
    }
    if (!verdict && x >= document.documentElement.clientWidth) verdict = { kind: 'scrollbar', of: 'viewport' };
    return { id: p.id, x, y, verdict: verdict || { kind: 'unknown' }, stack: stack.slice(0, 5) };
  });
})(${JSON.stringify(points)})`;
}

module.exports = { OBSERVE_MAIN, OBSERVE_EXTRA, OBSERVE_ISOLATED, PROBE, LIGHT_EXPLAIN };
