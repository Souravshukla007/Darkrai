/*
 * Darkrai - content/readability.js
 * The readability guard (PLAN section 6.4).
 *
 * After theming, measure the real contrast of visible text and icons against
 * what is actually behind them, and nudge anything that falls short of WCAG.
 */
(function () {
  'use strict';
  var NS = (window.Darkrai = window.Darkrai || {});
  // Always redefine: see the note in detect.js.
  var color = NS.color;
  // Dev-only timing. A missing module must be harmless.
  var T = NS.timing || {
    mark: function () { }, count: function () { },
    noteWrite: function () { }, noteRead: function () { return false; }
  };

  var MARK = 'data-darkrai';
  var IDATTR = 'data-dr-id';
  var BATCH = 300;              // elements per idle slice
  var MIN_SLICE_MS = 2;         // stop when the slice has less than this left
  var OBSERVE_MAX = 5000;       // elements watched for "visible area first"
  var MARGIN = 1.08;            // overshoot the WCAG target by a little
  var SLICE_MS = 8;
  var MEDIA_TAGS = { IMG: 1, VIDEO: 1, PICTURE: 1, CANVAS: 1, OBJECT: 1, EMBED: 1, IFRAME: 1 };
  var CONTROL_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1, OPTION: 1, METER: 1, PROGRESS: 1 };
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1, BR: 1, HR: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var ICON_FONTS = /icon|material|fontawesome|fa-|glyph|feather|ionicons|octicons/i;

  function now() {
    return (typeof performance === 'object' && performance.now) ? performance.now() : Date.now();
  }

  function hasOwnText(el) {
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3 && n.nodeValue && /\S/.test(n.nodeValue)) return true;
    }
    return false;
  }

  function isVisible(el, cs) {
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity) < 0.1) return false;
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.width < 1 || r.height < 1) return false;
    return true;
  }

  function isBold(cs) {
    var w = cs.fontWeight;
    if (w === 'bold' || w === 'bolder') return true;
    var n = parseInt(w, 10);
    return !isNaN(n) && n >= 700;
  }

  function hasIconPseudo(el) {
    try {
      var before = getComputedStyle(el, '::before');
      if (before) {
        var c = before.content;
        if (c && c !== 'none' && c !== 'normal' && c !== '""' && c !== "''") {
          if (ICON_FONTS.test(before.fontFamily || '') || (c.length <= 4 && !/\s/.test(c))) return true;
        }
      }
    } catch (e) { }
    return false;
  }

  /** A CSS-mask icon: masked, and drawn with a background colour. */
  function isMaskIcon(cs) {
    var m = cs.maskImage || cs.webkitMaskImage || '';
    if (!m || m === 'none') return false;
    var c = color.parse(cs.backgroundColor);
    return !!(c && c.a >= 0.05);
  }

  /**
   * The colour actually painted behind this element's text. skipSelf: start
   * below the element (a mask icon's own background is its glyph).
   */
  function effectiveBackground(el, skipSelf) {
    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return null; }
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    var x = Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), (window.innerWidth || 1024) - 1));
    var y = Math.round(Math.min(Math.max(rect.top + Math.min(rect.height / 2, 12), 1), (window.innerHeight || 768) - 1));
    var stack;
    try { stack = document.elementsFromPoint(x, y) || []; } catch (e) { stack = []; }
    var start = stack.indexOf(el);
    if (start < 0) start = 0;
    else if (skipSelf) start++;
    var layers = [], opaque = false;
    for (var i = start; i < stack.length; i++) {
      var node = stack[i];
      if (!node || node.nodeType !== 1) continue;
      var tag = node.tagName ? node.tagName.toUpperCase() : '';
      if (MEDIA_TAGS[tag] && node !== el) return null;     // a photo underneath: leave it
      var cs;
      try { cs = getComputedStyle(node); } catch (e) { continue; }
      var bi = cs.backgroundImage;
      if (bi && bi !== 'none' && bi.indexOf('url(') > -1) return null;
      var rgb = color.parse(cs.backgroundColor);
      if (!rgb || !rgb.a) continue;
      layers.push(rgb);
      if (rgb.a >= 0.999) { opaque = true; break; }
    }
    if (!opaque) {
      var rootBg = null;
      try { rootBg = color.parse(getComputedStyle(document.documentElement).backgroundColor); } catch (e) { }
      if (rootBg && rootBg.a >= 0.999) layers.push(rootBg);
      else layers.push({ r: 255, g: 255, b: 255, a: 1 });
    }
    if (!layers.length) return null;
    return color.compositeStack(layers);
  }

  function create(opts) {
    opts = opts || {};
    var look = opts.look || color.resolveLook({});
    var debug = !!opts.debug;
    var active = false;
    var writing = false;
    var sheetNode = null;
    var sheetObj = null;          // constructed sheet, when the browser has them
    var mediaRule = null;         // the @media screen block inside it
    var ruleKeys = [];            // parallel to mediaRule.cssRules
    var rules = new Map();        // id:prop -> css text
    var queue = [];
    var queued = new Set();
    var fixed = new Map();        // element -> signature of what we fixed
    var stamped = new Set();
    var observers = [];
    var io = null;
    var observed = 0;
    var pumping = false;
    var scheduled = false;
    var dirty = false;
    var checked = 0, fixes = 0;
    // The composited colour behind an element, keyed on the element and thrown
    // away as soon as anything the guard watches changes, or as soon as the
    // element has moved. Working it out walks the paint stack and reads a
    // computed style per layer, which is the expensive half of a measurement.
    var bgCache = new WeakMap();
    var generation = 0;

    function idFor(el) {
      var id = el.getAttribute(IDATTR);
      if (id) return id;
      id = String(NS.ids.next());
      writing = true;
      try { el.setAttribute(IDATTR, id); } finally { writing = false; }
      T.noteWrite();
      stamped.add(el);
      return id;
    }

    /**
     * One constructed stylesheet, adopted once, with each new per-element rule
     * appended through insertRule. Reassigning textContent used to re-parse
     * every rule we had ever written, on every flush.
     */
    function ensureSheet() {
      if (sheetObj || sheetNode) return;
      if (typeof CSSStyleSheet === 'function') {
        try {
          var sheet = new CSSStyleSheet();
          sheet.replaceSync('@media screen{}');
          var media = sheet.cssRules[0];
          if (media && media.insertRule) {
            sheet.__darkrai = 'readability';
            document.adoptedStyleSheets = (document.adoptedStyleSheets || []).concat([sheet]);
            sheetObj = sheet;
            mediaRule = media;
            T.count('adoptedSheets', 1);
            return;
          }
        } catch (e) { sheetObj = null; mediaRule = null; }
      }
      sheetNode = document.createElement('style');
      sheetNode.setAttribute(MARK, 'readability');
      writing = true;
      try { (document.head || document.documentElement).appendChild(sheetNode); }
      finally { writing = false; }
      T.count('styleNodes', 1);
    }

    function setRule(key, css) {
      rules.set(key, css);
      ensureSheet();
      if (!mediaRule) { dirty = true; return; }
      var at = ruleKeys.indexOf(key);
      writing = true;
      try {
        if (at > -1) { mediaRule.deleteRule(at); ruleKeys.splice(at, 1); }
        mediaRule.insertRule(css, mediaRule.cssRules.length);
        ruleKeys.push(key);
      } catch (e) { dirty = true; }
      finally { writing = false; }
      T.noteWrite();
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
      T.noteWrite();
      dirty = false;
    }

    function rectOf(el) {
      try { return el.getBoundingClientRect(); } catch (e) { return null; }
    }

    function placeKey(rect) {
      if (!rect) return 'none';
      return generation + '|' + Math.round(rect.left) + ',' + Math.round(rect.top) +
        ',' + Math.round(rect.width) + ',' + Math.round(rect.height);
    }

    function backgroundFor(el, key, skipSelf) {
      var hit = bgCache.get(el);
      if (hit && hit.key === key) return hit.bg;
      var bg = effectiveBackground(el, skipSelf);
      bgCache.set(el, { key: key, bg: bg });
      return bg;
    }

    /**
     * Measure one element. Reads only: no attribute is stamped and no rule is
     * written, so every element in a slice can be measured before anything is
     * touched. Returns null, or what commit() should do about it.
     */
    function measure(el) {
      if (!el || el.nodeType !== 1 || !el.isConnected) return null;
      var tag = el.tagName ? el.tagName.toUpperCase() : '';
      if (SKIP_TAGS[tag] || MEDIA_TAGS[tag]) return null;
      if (el.hasAttribute && el.hasAttribute(MARK)) return null;
      var cs;
      // A computed-style read right after one of our own writes is the shape
      // that forces a recalculation; the counter is a proxy for how often.
      T.noteRead();
      try { cs = getComputedStyle(el); } catch (e) { return null; }
      if (!isVisible(el, cs)) return null;

      var isSvg = tag === 'SVG' || (el.ownerSVGElement != null);
      var isIcon = false, masked = false, prop = 'color', raw = cs.color;
      if (isSvg) {
        var fill = cs.fill;
        if (fill && fill !== 'none' && fill !== 'currentcolor') { prop = 'fill'; raw = fill; isIcon = true; }
        else if (cs.stroke && cs.stroke !== 'none') { prop = 'stroke'; raw = cs.stroke; isIcon = true; }
        else return null;
      } else if (!hasOwnText(el) && !CONTROL_TAGS[tag]) {
        if (isMaskIcon(cs)) {
          // A CSS-mask icon: the glyph is the element's own background colour,
          // and what it must stand out from is whatever is painted behind it.
          isIcon = true; masked = true; prop = 'background-color'; raw = cs.backgroundColor;
        } else if (!hasIconPseudo(el)) return null;
        else isIcon = true;
      }

      var fg = color.parse(raw);
      if (!fg || fg.a < 0.05) return null;

      var bg = backgroundFor(el, placeKey(rectOf(el)) + (masked ? '|m' : ''), masked);
      if (!bg) return null;

      var fontSize = parseFloat(cs.fontSize) || 16;
      var required = color.requiredRatio({
        fontSizePx: fontSize, bold: isBold(cs), isIcon: isIcon
      });
      var flat = color.composite(fg, bg);
      var ratio = color.contrastRatio(flat, bg);
      checked++;
      T.count('guardMeasured', 1);
      var signature = raw + '|' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + '|' + required;
      if (fixed.get(el) === signature) return null;

      if (color.passes(ratio, required)) return { el: el, signature: signature };

      // Aim a little past the target: landing exactly on it leaves the result
      // at the mercy of rounding and of whatever repaints next.
      var result = color.fixForContrast(fg, bg, required * MARGIN, look);
      if (!result.changed) return { el: el, signature: signature };
      return {
        el: el, signature: signature, prop: prop,
        css: color.toCss(result.rgb), ratio: ratio, fixedRatio: result.ratio
      };
    }

    /** The write phase: every stamp and every rule for one slice, together. */
    function commit(plans) {
      for (var i = 0; i < plans.length; i++) {
        var plan = plans[i];
        fixed.set(plan.el, plan.signature);
        if (!plan.css) continue;
        var id = idFor(plan.el);
        setRule(id + ':' + plan.prop,
          '[' + IDATTR + '="' + id + '"]{' + plan.prop + ':' + plan.css + ' !important;}');
        fixes++;
        if (debug) {
          console.debug('[Darkrai] readability fix', plan.el,
            plan.ratio.toFixed(2), '->', plan.fixedRatio.toFixed(2));
        }
      }
    }

    /** Measure one element and fix it when it misses its WCAG target. */
    function check(el) {
      var plan = measure(el);
      if (plan) commit([plan]);
    }

    function enqueue(el, front) {
      if (!el || el.nodeType !== 1 || queued.has(el)) return;
      queued.add(el);
      if (front) queue.unshift(el); else queue.push(el);
      // Watching an element lets the observer pull it to the front of the queue
      // as soon as it scrolls into view, which is how the visible area gets
      // measured first (PLAN section 6.4). Capped so a huge page cannot turn
      // the observer itself into the expensive part.
      if (io && observed < OBSERVE_MAX) {
        try { io.observe(el); observed++; } catch (e) { }
      }
      if (!pumping) schedulePump();
    }

    /**
     * The first pump of a burst goes through a microtask rather than running
     * inside the observer callback that queued it. The engine answers the same
     * mutation records and now coalesces its own work into a microtask too, so
     * running here and now would mean measuring an element the engine has not
     * recoloured yet - and recording it as already readable.
     */
    function schedulePump() {
      if (pumping || scheduled) return;
      scheduled = true;
      var run = function () { scheduled = false; pump(); };
      if (typeof Promise === 'function') Promise.resolve().then(run);
      else setTimeout(run, 0);
    }

    function pump() {
      if (!active) { pumping = false; return; }
      pumping = true;
      var start = now(), count = 0;
      // Read phase: nothing is written, so the second element in a slice no
      // longer pays for a style recalculation caused by the first one.
      var plans = [];
      while (queue.length && count < BATCH) {
        var left = SLICE_MS - (now() - start);
        if (left < MIN_SLICE_MS) break;
        var el = queue.shift();
        queued.delete(el);
        try {
          var plan = measure(el);
          if (plan) plans.push(plan);
        } catch (e) { if (debug) console.warn('[Darkrai]', e); }
        count++;
      }
      // Write phase: every stamp and every rule for the slice, in one go.
      if (plans.length) { try { commit(plans); } catch (e) { if (debug) console.warn('[Darkrai]', e); } }
      if (dirty) flush();
      if (!queue.length) { pumping = false; return; }
      var next = function () { pump(); };
      if (document.hidden) setTimeout(next, 250);
      else if (typeof requestIdleCallback === 'function') requestIdleCallback(next, { timeout: 200 });
      else setTimeout(next, 0);
    }

    function collect(root) {
      var els;
      try { els = (root || document).querySelectorAll('*'); } catch (e) { return; }
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var tag = el.tagName ? el.tagName.toUpperCase() : '';
        if (SKIP_TAGS[tag]) continue;
        if (el.hasAttribute && el.hasAttribute(MARK)) continue;
        enqueue(el);
        if (el.shadowRoot) collect(el.shadowRoot);
      }
    }

    function watch() {
      try {
        var mo = new MutationObserver(function (records) {
          if (writing || !active) return;
          // Anything at all moved: every cached backdrop is now a guess.
          generation++;
          for (var i = 0; i < records.length; i++) {
            var r = records[i];
            if (r.type === 'attributes') {
              if (r.attributeName === IDATTR) continue;
              fixed.delete(r.target);
              enqueue(r.target);
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
                try { kids = n.querySelectorAll('*'); } catch (e) { kids = []; }
                for (var k = 0; k < kids.length && k < 300; k++) enqueue(kids[k]);
              }
            }
            if (r.type === 'characterData' && r.target.parentNode) {
              fixed.delete(r.target.parentNode);
              enqueue(r.target.parentNode);
            }
          }
        });
        mo.observe(document.documentElement, {
          childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['style', 'class', 'fill', 'stroke']
        });
        observers.push(mo);
      } catch (e) { }

      // The visible area goes first.
      if (typeof IntersectionObserver === 'function') {
        try {
          io = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
              if (!entries[i].isIntersecting) continue;
              var el = entries[i].target;
              if (queued.has(el)) {
                // Already waiting its turn: move it to the front instead.
                var at = queue.indexOf(el);
                if (at > 0) { queue.splice(at, 1); queue.unshift(el); }
                continue;
              }
              enqueue(el, true);
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

    function scan() {
      if (!active) return;
      fixed.clear();
      generation++;
      collect(document);
    }

    function stop() {
      active = false;
      scheduled = false;
      queue.length = 0;
      queued.clear();
      for (var i = 0; i < observers.length; i++) { try { observers[i].disconnect(); } catch (e) { } }
      observers = [];
      if (io) { try { io.disconnect(); } catch (e) { } io = null; }
      observed = 0;
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
      fixed.clear();
      bgCache = new WeakMap();
      generation++;
      sheetNode = null;
      sheetObj = null;
      mediaRule = null;
    }

    return {
      start: start,
      stop: stop,
      scan: scan,
      check: check,
      effectiveBackground: effectiveBackground,
      stats: function () { return { checked: checked, fixes: fixes, pending: queue.length }; }
    };
  }

  NS.readability = {
    __v: 1,
    create: create,
    hasOwnText: hasOwnText,
    isVisible: isVisible,
    isBold: isBold,
    hasIconPseudo: hasIconPseudo,
    isMaskIcon: isMaskIcon,
    effectiveBackground: effectiveBackground,
    BATCH: BATCH
  };
})();
