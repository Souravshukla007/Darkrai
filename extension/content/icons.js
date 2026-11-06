/*
 * Darkrai - content/icons.js
 * Icon rescue (PLAN section 6.5).
 *
 * Photos, video and canvas are never inverted. A black logo on a transparent
 * background, though, disappears on a dark page, so that one image is inverted
 * on its own:
 *   - candidates are images up to 128 px tall, plus SVG images at any size;
 *   - each one is sampled at 32x32;
 *   - it is inverted when at least 25% of the pixels are transparent and the
 *     visible pixels are dark and nearly colourless;
 *   - images from another domain cannot be read from a canvas here, so the
 *     background worker analyses them and answers only yes or no;
 *   - every verdict is cached by URL.
 */
(function () {
  'use strict';
  var NS = (window.Darkrai = window.Darkrai || {});
  // Always redefine: see the note in detect.js. The verdict cache below hangs
  // off the namespace separately, so it survives a re-injection either way.
  var color = NS.color;

  var MARK = 'data-darkrai';
  var IDATTR = 'data-dr-id';

  var MAX_HEIGHT = 128;          // images up to 128 px tall
  var SAMPLE = 32;               // sample at 32x32
  var MIN_TRANSPARENT = 0.25;    // at least a quarter transparent
  var DARK_L = 0.35;             // OKLCH lightness that counts as dark
  var DARK_SHARE = 0.75;         // ... for most of the visible pixels
  var COLOUR_C = 0.06;           // OKLCH chroma that counts as colourful
  var COLOUR_SHARE = 0.15;       // ... for only a few of them
  var SLICE_MS = 8;
  var BATCH = 40;
  var CACHE_MAX = 600;

  // Verdicts live on the namespace so a re-injected copy keeps the cache.
  var verdicts = NS.__iconVerdicts || (NS.__iconVerdicts = new Map());

  function cacheGet(url) {
    if (!url || !verdicts.has(url)) return undefined;
    var v = verdicts.get(url);
    verdicts.delete(url); verdicts.set(url, v);     // refresh recency
    return v;
  }

  function cacheSet(url, value) {
    if (!url) return value;
    if (verdicts.size >= CACHE_MAX) {
      var oldest = verdicts.keys().next();
      if (!oldest.done) verdicts.delete(oldest.value);
    }
    verdicts.set(url, value);
    return value;
  }

  function isSvgUrl(url) {
    if (!url) return false;
    var s = String(url);
    if (/^data:image\/svg\+xml/i.test(s)) return true;
    return /\.svg($|[?#])/i.test(s.split('#')[0]);
  }

  function urlOf(el) {
    try {
      var src = el.currentSrc || el.src || el.getAttribute('src') || '';
      if (!src) return '';
      return new URL(src, location.href).href;
    } catch (e) {
      return String((el && (el.currentSrc || el.src)) || '');
    }
  }

  function readableHere(url) {
    // Same-origin pixels can be read from a canvas; anything else taints it
    // unless the page opted the image into CORS.
    if (!url) return false;
    if (/^(data:|blob:)/i.test(url)) return true;
    try { return new URL(url, location.href).origin === location.origin; }
    catch (e) { return false; }
  }

  /** Count what a 32x32 sample is made of. Pure: the unit tests use it. */
  function countPixels(data) {
    var total = 0, transparent = 0, visible = 0, dark = 0, colourful = 0;
    for (var i = 0; i + 3 < data.length; i += 4) {
      total++;
      if (data[i + 3] / 255 < 0.1) { transparent++; continue; }
      visible++;
      var oklch = color.srgbToOklch({ r: data[i], g: data[i + 1], b: data[i + 2] });
      if (oklch.l < DARK_L) dark++;
      if (oklch.c > COLOUR_C) colourful++;
    }
    return { total: total, transparent: transparent, visible: visible, dark: dark, colourful: colourful };
  }

  /** The decision from PLAN section 6.5. Mirrors the worker's copy exactly. */
  function shouldInvert(counts) {
    if (!counts || !counts.total || !counts.visible) return false;
    return counts.transparent / counts.total >= MIN_TRANSPARENT &&
      counts.dark / counts.visible >= DARK_SHARE &&
      counts.colourful / counts.visible <= COLOUR_SHARE;
  }

  function now() {
    return (typeof performance === 'object' && performance.now) ? performance.now() : Date.now();
  }

  function create(opts) {
    opts = opts || {};
    var requestAnalysis = typeof opts.requestAnalysis === 'function' ? opts.requestAnalysis : null;
    var debug = !!opts.debug;
    var active = false;
    var writing = false;
    var sheetNode = null;
    var sheetObj = null;          // constructed sheet, when the browser has them
    var mediaRule = null;         // the @media screen block inside it
    var ruleKeys = [];            // parallel to mediaRule.cssRules
    var rules = new Map();        // data-dr-id -> css text
    var queue = [];
    var queued = new Set();
    var seen = new Set();         // elements already decided
    var stamped = new Set();
    var inFlight = new Set();     // urls waiting on the worker
    var observers = [];
    var io = null;
    var pumping = false;
    var dirty = false;
    var checked = 0, inverted = 0, remote = 0;

    function idFor(el) {
      var id = el.getAttribute(IDATTR);
      if (id) return id;
      id = String(NS.ids ? NS.ids.next() : Math.floor(Math.random() * 1e9));
      writing = true;
      try { el.setAttribute(IDATTR, id); } finally { writing = false; }
      stamped.add(el);
      return id;
    }

    /**
     * One constructed stylesheet, adopted once, with each verdict appended
     * through insertRule. Reassigning textContent re-parsed every rule we had
     * written so far, and invert() flushes after every single image.
     */
    function ensureSheet() {
      if (sheetObj || sheetNode) return;
      if (typeof CSSStyleSheet === 'function') {
        try {
          var sheet = new CSSStyleSheet();
          sheet.replaceSync('@media screen{}');
          var media = sheet.cssRules[0];
          if (media && media.insertRule) {
            sheet.__darkrai = 'icons';
            document.adoptedStyleSheets = (document.adoptedStyleSheets || []).concat([sheet]);
            sheetObj = sheet;
            mediaRule = media;
            return;
          }
        } catch (e) { sheetObj = null; mediaRule = null; }
      }
      sheetNode = document.createElement('style');
      sheetNode.setAttribute(MARK, 'icons');
      writing = true;
      try { (document.head || document.documentElement).appendChild(sheetNode); }
      finally { writing = false; }
    }

    function setRule(key, css) {
      rules.set(key, css);
      ensureSheet();
      if (!mediaRule) { dirty = true; flush(); return; }
      var at = ruleKeys.indexOf(key);
      writing = true;
      try {
        if (at > -1) { mediaRule.deleteRule(at); ruleKeys.splice(at, 1); }
        mediaRule.insertRule(css, mediaRule.cssRules.length);
        ruleKeys.push(key);
      } catch (e) { dirty = true; }
      finally { writing = false; }
    }

    function dropRule(key) {
      if (!rules.has(key)) return;
      rules.delete(key);
      if (!mediaRule) { dirty = true; return; }
      var at = ruleKeys.indexOf(key);
      if (at < 0) return;
      writing = true;
      try { mediaRule.deleteRule(at); ruleKeys.splice(at, 1); }
      catch (e) { }
      finally { writing = false; }
    }

    function flush() {
      if (!active || !rules.size) { dirty = false; return; }
      ensureSheet();
      if (!sheetNode) { dirty = false; return; }       // the adopted sheet is live
      var css = '';
      rules.forEach(function (r) { css += r; });
      writing = true;
      try { sheetNode.textContent = '@media screen{' + css + '}'; }
      finally { writing = false; }
      dirty = false;
    }

    function invert(el) {
      var id = idFor(el);
      // Nearly colourless by the time we get here, so a plain invert is enough
      // and no hue rotation is needed.
      setRule(id, '[' + IDATTR + '="' + id + '"]{filter:invert(1) !important;}');
      inverted++;
      if (debug) console.debug('[Darkrai] icon inverted', el);
    }

    function candidate(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.hasAttribute && el.hasAttribute(MARK)) return false;
      var tag = el.tagName ? el.tagName.toUpperCase() : '';
      if (tag === 'INPUT') { if (String(el.type || '').toLowerCase() !== 'image') return false; }
      else if (tag !== 'IMG') return false;
      var url = urlOf(el);
      if (!url) return false;
      if (isSvgUrl(url)) return true;                 // SVG images, any size
      var h = 0;
      try { h = el.getBoundingClientRect().height; } catch (e) { h = 0; }
      if (h <= 0) h = el.naturalHeight || 0;
      return h > 0 && h <= MAX_HEIGHT;
    }

    /** Read the pixels here. Returns true/false, or null when we cannot look. */
    function analyseHere(el) {
      try {
        if (el.tagName.toUpperCase() === 'IMG' && !el.complete) return null;
        var canvas = document.createElement('canvas');
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.clearRect(0, 0, SAMPLE, SAMPLE);
        ctx.drawImage(el, 0, 0, SAMPLE, SAMPLE);
        var data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
        return shouldInvert(countPixels(data));
      } catch (e) {
        return null;        // tainted canvas, or an image we cannot decode
      }
    }

    function askWorker(el, url) {
      if (!requestAnalysis || inFlight.has(url)) return;
      inFlight.add(url);
      remote++;
      requestAnalysis(url).then(function (answer) {
        inFlight.delete(url);
        if (!active) return;
        var yes = answer === true;
        cacheSet(url, yes);
        if (yes && el.isConnected) invert(el);
      }, function () {
        inFlight.delete(url);
        cacheSet(url, false);
      });
    }

    function check(el) {
      if (!active || !candidate(el)) return;
      var url = urlOf(el);
      var cached = cacheGet(url);
      checked++;
      if (cached !== undefined) {
        if (cached) invert(el);
        return;
      }
      var canLookHere = readableHere(url) || !!el.crossOrigin;
      var local = canLookHere ? analyseHere(el) : null;
      if (local === null) { askWorker(el, url); return; }
      cacheSet(url, local);
      if (local) invert(el);
    }

    function enqueue(el, front) {
      if (!el || el.nodeType !== 1 || queued.has(el) || seen.has(el)) return;
      if (!candidate(el)) return;
      seen.add(el);
      queued.add(el);
      if (front) queue.unshift(el); else queue.push(el);
      if (io) { try { io.observe(el); } catch (e) { } }
      if (!pumping) pump();
    }

    function pump() {
      if (!active) { pumping = false; return; }
      pumping = true;
      var start = now(), count = 0;
      while (queue.length && count < BATCH) {
        if (now() - start > SLICE_MS) break;
        var el = queue.shift();
        queued.delete(el);
        try { check(el); } catch (e) { if (debug) console.warn('[Darkrai]', e); }
        count++;
      }
      if (dirty) flush();
      if (!queue.length) { pumping = false; return; }
      var next = function () { pump(); };
      if (document.hidden) setTimeout(next, 250);
      else if (typeof requestIdleCallback === 'function') requestIdleCallback(next, { timeout: 250 });
      else setTimeout(next, 0);
    }

    function collect(root) {
      var els;
      try { els = (root || document).querySelectorAll('img,input[type="image"]'); } catch (e) { return; }
      for (var i = 0; i < els.length; i++) enqueue(els[i]);
      // Open shadow roots hold icons too.
      var hosts;
      try { hosts = (root || document).querySelectorAll('*'); } catch (e) { hosts = []; }
      for (var j = 0; j < hosts.length; j++) {
        if (hosts[j].shadowRoot) collect(hosts[j].shadowRoot);
      }
    }

    function recheck(el) {
      seen.delete(el);
      var id = el.getAttribute && el.getAttribute(IDATTR);
      if (id) dropRule(id);
      enqueue(el, true);
    }

    function onLoad(event) {
      var el = event.target;
      if (el && el.nodeType === 1) recheck(el);
    }

    function watch() {
      try {
        var mo = new MutationObserver(function (records) {
          if (writing || !active) return;
          for (var i = 0; i < records.length; i++) {
            var r = records[i];
            if (r.type === 'attributes') {
              if (r.attributeName === IDATTR) continue;
              recheck(r.target);
              continue;
            }
            var added = r.addedNodes || [];
            for (var j = 0; j < added.length; j++) {
              var n = added[j];
              if (n.nodeType !== 1) continue;
              if (n.hasAttribute && n.hasAttribute(MARK)) continue;
              enqueue(n);
              if (n.querySelectorAll) {
                var kids;
                try { kids = n.querySelectorAll('img,input[type="image"]'); } catch (e) { kids = []; }
                for (var k = 0; k < kids.length && k < 200; k++) enqueue(kids[k]);
              }
            }
          }
        });
        mo.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ['src', 'srcset']
        });
        observers.push(mo);
      } catch (e) { }

      // An image that was still loading gets a second look once it is decoded.
      try { document.addEventListener('load', onLoad, true); } catch (e) { }

      // The visible area goes first.
      if (typeof IntersectionObserver === 'function') {
        try {
          io = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
              if (entries[i].isIntersecting) {
                seen.delete(entries[i].target);
                enqueue(entries[i].target, true);
              }
            }
          }, { rootMargin: '100px' });
        } catch (e) { io = null; }
      }
    }

    function start() {
      if (active) return;
      active = true;
      watch();
      collect(document);
    }

    function stop() {
      active = false;
      queue.length = 0;
      queued.clear();
      seen.clear();
      inFlight.clear();
      for (var i = 0; i < observers.length; i++) { try { observers[i].disconnect(); } catch (e) { } }
      observers = [];
      if (io) { try { io.disconnect(); } catch (e) { } io = null; }
      try { document.removeEventListener('load', onLoad, true); } catch (e) { }
      writing = true;
      try {
        if (sheetNode && sheetNode.parentNode) sheetNode.parentNode.removeChild(sheetNode);
        if (sheetObj) {
          var list = document.adoptedStyleSheets || [];
          var at = list.indexOf(sheetObj);
          if (at > -1) {
            var next = list.slice();
            next.splice(at, 1);
            document.adoptedStyleSheets = next;
          }
        }
        stamped.forEach(function (el) { try { el.removeAttribute(IDATTR); } catch (e) { } });
      } catch (e) { } finally { writing = false; }
      stamped.clear();
      rules.clear();
      ruleKeys.length = 0;
      sheetNode = null;
      sheetObj = null;
      mediaRule = null;
    }

    return {
      start: start,
      stop: stop,
      check: check,
      rescan: function () { seen.clear(); collect(document); },
      stats: function () {
        return {
          checked: checked, inverted: inverted, remote: remote,
          pending: queue.length, cached: verdicts.size
        };
      }
    };
  }

  NS.icons = {
    __v: 1,
    create: create,
    countPixels: countPixels,
    shouldInvert: shouldInvert,
    isSvgUrl: isSvgUrl,
    MAX_HEIGHT: MAX_HEIGHT,
    SAMPLE: SAMPLE,
    MIN_TRANSPARENT: MIN_TRANSPARENT,
    clearCache: function () { verdicts.clear(); }
  };
  if (typeof module === 'object' && module && module.exports) module.exports = NS.icons;
})();
