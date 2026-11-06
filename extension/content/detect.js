/*
 * Darkrai - content/detect.js
 * Already-dark detection (PLAN section 6.1).
 *
 * Content scripts cannot be ES modules, so everything hangs off the single
 * global namespace object and the file is safe to inject more than once.
 */
(function () {
  'use strict';
  var NS = (window.Darkrai = window.Darkrai || {});
  // Always redefine. A tab that was open across an extension update still holds
  // the previous build's namespace, so skipping the redefinition would leave
  // the old code running in that page forever (PLAN section 6.7). Defining
  // these functions costs nothing, and anything already running keeps the copy
  // it captured until main.js tears it down.
  var color = NS.color;

  var DARK_L = 0.45;          // OKLCH lightness below this counts as dark
  var OPAQUE_A = 0.5;         // alpha at or above this counts as opaque
  var GRID = [0.15, 0.5, 0.85];
  var THROTTLE_MS = 500;
  var UNCLEAR_RECHECK_MS = 1500;
  var URL_POLL_MS = 2000;       // only used when the Navigation API is missing

  var MEDIA_TAGS = { IMG: 1, VIDEO: 1, PICTURE: 1, CANVAS: 1, OBJECT: 1, EMBED: 1, IFRAME: 1 };

  /**
   * The decision, kept pure so it can be unit tested.
   * samples: [{ l: number|null, fallback?: boolean, media?: boolean }]
   */
  function decide(input) {
    input = input || {};
    var samples = input.samples || [];
    var declaredDark = !!input.declaredDark;
    var textLighter = !!input.textLighter;

    var usable = [], darkCount = 0, lightCount = 0;
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (!s || s.media || typeof s.l !== 'number' || isNaN(s.l)) continue;
      usable.push(s);
      var isDark = s.l < DARK_L;
      // A canvas-colour fallback only counts as dark when the page itself says
      // it is dark; otherwise an empty area would vote for whatever we guessed.
      if (isDark && (!s.fallback || declaredDark)) darkCount++;
      else if (!isDark && !s.fallback) lightCount++;
    }

    var needed = usable.length >= 9 ? 6 : Math.max(1, Math.ceil(usable.length * 2 / 3));
    var dark = usable.length > 0 && darkCount >= needed && textLighter;

    // The page declared a dark colour scheme and nothing visible contradicts
    // it: respect the site's own choice even if we could not sample text.
    if (!dark && declaredDark && lightCount === 0) dark = true;

    return {
      dark: dark,
      declaredDark: declaredDark,
      textLighter: textLighter,
      usable: usable.length,
      darkCount: darkCount,
      lightCount: lightCount,
      needed: needed,
      confident: usable.length >= 4 || declaredDark
    };
  }

  function lightnessOf(cssColor) {
    var rgb = color.parse(cssColor);
    if (!rgb) return null;
    return { l: color.srgbToOklch(rgb).l, a: rgb.a == null ? 1 : rgb.a, rgb: rgb };
  }

  function hasImageBackground(cs) {
    var bi = cs.backgroundImage;
    return !!bi && bi !== 'none' && bi.indexOf('url(') > -1;
  }

  function declaredDarkScheme(doc) {
    try {
      var metas = doc.querySelectorAll('meta[name="color-scheme" i]');
      for (var i = 0; i < metas.length; i++) {
        var content = (metas[i].getAttribute('content') || '').toLowerCase().trim();
        if (!content) continue;
        var first = content.split(/[\s,]+/)[0];
        if (first === 'dark') return true;
      }
      var rootScheme = '';
      try { rootScheme = getComputedStyle(doc.documentElement).colorScheme || ''; } catch (e) { }
      rootScheme = String(rootScheme).toLowerCase();
      if (rootScheme === 'dark' || /^dark\b/.test(rootScheme)) return true;
      if (rootScheme.indexOf('dark') > -1 && rootScheme.indexOf('light') < 0) return true;
      if (rootScheme.indexOf('dark') > -1 && rootScheme.indexOf('only') > -1) return true;
      // "light dark" plus a dark OS theme means the site renders dark.
      if (rootScheme.indexOf('dark') > -1 && matchMediaDark()) return true;
    } catch (e) { }
    return false;
  }

  function matchMediaDark() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
    catch (e) { return false; }
  }

  /** Background the page paints behind everything, as a lightness or null. */
  function canvasLightness(doc, declaredDark) {
    var el = [doc.documentElement, doc.body];
    for (var i = 0; i < el.length; i++) {
      if (!el[i]) continue;
      var cs;
      try { cs = getComputedStyle(el[i]); } catch (e) { continue; }
      var info = lightnessOf(cs.backgroundColor);
      if (info && info.a >= OPAQUE_A) return { l: info.l, fallback: false };
    }
    // Nothing opaque: Chrome paints its own canvas, dark only under a dark scheme.
    return { l: declaredDark ? 0.12 : 1, fallback: true };
  }

  function sampleGrid(doc, declaredDark) {
    var w = Math.max(1, window.innerWidth || doc.documentElement.clientWidth || 800);
    var h = Math.max(1, window.innerHeight || doc.documentElement.clientHeight || 600);
    var canvas = canvasLightness(doc, declaredDark);
    var out = [];
    for (var gy = 0; gy < GRID.length; gy++) {
      for (var gx = 0; gx < GRID.length; gx++) {
        var x = Math.min(w - 1, Math.max(0, Math.round(w * GRID[gx])));
        var y = Math.min(h - 1, Math.max(0, Math.round(h * GRID[gy])));
        out.push(samplePoint(doc, x, y, canvas));
      }
    }
    return out;
  }

  function samplePoint(doc, x, y, canvas) {
    var stack;
    try { stack = doc.elementsFromPoint(x, y) || []; } catch (e) { stack = []; }
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (!el || el.nodeType !== 1) continue;
      var tag = el.tagName ? el.tagName.toUpperCase() : '';
      if (MEDIA_TAGS[tag]) return { l: null, media: true };
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (hasImageBackground(cs)) return { l: null, media: true };
      var info = lightnessOf(cs.backgroundColor);
      if (info && info.a >= OPAQUE_A) return { l: info.l, fallback: false };
    }
    return { l: canvas.l, fallback: canvas.fallback };
  }

  function textLighterThanBackground(doc, declaredDark) {
    var body = doc.body || doc.documentElement;
    if (!body) return false;
    var cs;
    try { cs = getComputedStyle(body); } catch (e) { return false; }
    var fg = lightnessOf(cs.color);
    var bgInfo = lightnessOf(cs.backgroundColor);
    var bgL;
    if (bgInfo && bgInfo.a >= OPAQUE_A) bgL = bgInfo.l;
    else bgL = canvasLightness(doc, declaredDark).l;
    if (fg && fg.l > bgL + 0.05) return true;
    // Many apps (YouTube, GitHub) leave the body colour at its light-theme
    // default and set the real text colour deeper in the tree. Fall back to
    // the text colour at the sample grid, read against the background there.
    return gridTextLighter(doc, declaredDark);
  }

  /**
   * Read the colour of real visible text runs in the viewport, each against
   * the first opaque background behind it. Capped so it stays cheap.
   */
  function gridTextLighter(doc, declaredDark) {
    var root = doc.body || doc.documentElement;
    if (!root || !doc.createTreeWalker) return false;
    var h = Math.max(1, window.innerHeight || doc.documentElement.clientHeight || 600);
    var canvas = canvasLightness(doc, declaredDark);
    var lighter = 0, darker = 0, measured = 0, visited = 0, seen = [];
    var walker;
    try { walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */); } catch (e) { return false; }
    var node;
    while ((node = walker.nextNode()) && visited < 600 && measured < 24) {
      visited++;
      var el = node.parentElement;
      if (!el || seen.indexOf(el) > -1 || !/\S/.test(node.nodeValue || '')) continue;
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
      seen.push(el);
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!rect || rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > h) continue;
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      var fg = lightnessOf(cs.color);
      if (!fg || fg.a < OPAQUE_A) continue;
      var bg = null;
      for (var a = el; a && a.nodeType === 1; a = a.parentElement) {
        var acs;
        try { acs = a === el ? cs : getComputedStyle(a); } catch (e) { break; }
        var info = lightnessOf(acs.backgroundColor);
        if (info && info.a >= OPAQUE_A) { bg = info.l; break; }
      }
      if (bg == null) bg = canvas.l;
      measured++;
      if (fg.l > bg + 0.05) lighter++;
      else if (fg.l < bg - 0.05) darker++;
    }
    return lighter >= 3 && lighter > darker * 2;
  }

  /**
   * One measurement. `hooks.suspend` / `hooks.resume` let us read the site's own
   * colours while Darkrai is active: both run in this same task, so nothing is
   * painted in between and there is no flicker.
   */
  function measure(hooks) {
    hooks = hooks || {};
    var doc = document;
    var suspended = false;
    try {
      if (hooks.suspend) { hooks.suspend(); suspended = true; }
      var declaredDark = declaredDarkScheme(doc);
      var samples = sampleGrid(doc, declaredDark);
      var textLighter = textLighterThanBackground(doc, declaredDark);
      return decide({ samples: samples, declaredDark: declaredDark, textLighter: textLighter });
    } catch (e) {
      return decide({ samples: [], declaredDark: false, textLighter: false });
    } finally {
      if (suspended && hooks.resume) { try { hooks.resume(); } catch (e) { } }
    }
  }

  /**
   * Watch for the site switching its own theme (YouTube Appearance, GitHub
   * theme picker, in-app navigation) and re-measure, throttled.
   */
  function createWatcher(opts) {
    opts = opts || {};
    var onSignal = opts.onSignal || function () { };
    var timers = [], observers = [], mql = null, lastRun = 0, pending = null;
    var lastUrl = location.href, urlTimer = null, stopped = false, nav = null;

    // Named so stop() can take them off again: a torn-down watcher must leave
    // nothing of itself behind on window (PLAN section 6.7).
    function onPopstate() { ping('popstate'); }
    function onHashchange() { ping('hashchange'); }
    function onScheme() { ping('prefers-color-scheme'); }
    function onNavigate() { ping('navigate'); }

    /**
     * In-app navigation. The Navigation API tells us outright; without it a
     * poll is the only way, so it runs at half the old rate and not at all
     * while the tab is in the background - this is the one thing still running
     * on a page Darkrai has decided to leave alone.
     */
    function checkUrl() {
      if (location.href !== lastUrl) { lastUrl = location.href; ping('url'); }
    }

    function startPoll() {
      if (urlTimer || stopped) return;
      urlTimer = setInterval(checkUrl, URL_POLL_MS);
      timers.push(urlTimer);
    }

    function stopPoll() {
      if (!urlTimer) return;
      try { clearInterval(urlTimer); } catch (e) { }
      var at = timers.indexOf(urlTimer);
      if (at > -1) timers.splice(at, 1);
      urlTimer = null;
    }

    function onVisibility() {
      if (stopped) return;
      if (document.hidden) stopPoll();
      else { checkUrl(); startPoll(); }
    }

    function ping(reason) {
      if (stopped) return;
      var now = Date.now();
      var wait = Math.max(0, THROTTLE_MS - (now - lastRun));
      if (pending) return;
      pending = setTimeout(function () {
        pending = null; lastRun = Date.now();
        try { onSignal(reason); } catch (e) { }
      }, wait);
    }

    function start() {
      // Theme attributes and the meta element.
      try {
        var mo = new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var r = records[i];
            if (r.type === 'attributes') { ping('attr:' + r.attributeName); return; }
            if (r.type === 'childList') { ping('meta'); return; }
          }
        });
        mo.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'dark', 'data-theme', 'data-color-mode',
            'data-color-scheme', 'data-bs-theme', 'theme', 'color-scheme', 'data-mode']
        });
        observers.push(mo);
        if (document.body) {
          var mb = new MutationObserver(function () { ping('body-attr'); });
          mb.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style', 'dark', 'data-theme', 'data-color-mode', 'data-bs-theme']
          });
          observers.push(mb);
        }
        if (document.head) {
          var mh = new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
              var nodes = records[i].addedNodes || [];
              for (var j = 0; j < nodes.length; j++) {
                var n = nodes[j];
                if (n.nodeType === 1 && n.tagName === 'META' &&
                  /color-scheme|theme-color/i.test(n.getAttribute('name') || '')) { ping('meta'); return; }
              }
              if (records[i].type === 'attributes') { ping('meta-attr'); return; }
            }
          });
          mh.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] });
          observers.push(mh);
        }
      } catch (e) { }

      try {
        mql = window.matchMedia('(prefers-color-scheme: dark)');
        if (mql.addEventListener) mql.addEventListener('change', onScheme);
        else if (mql.addListener) mql.addListener(onScheme);
      } catch (e) { }

      // In-app navigation: no history patching in the page world either way.
      nav = null;
      try {
        if (window.navigation && window.navigation.addEventListener) {
          nav = window.navigation;
          nav.addEventListener('navigate', onNavigate);
        }
      } catch (e) { nav = null; }
      if (!nav) {
        try { document.addEventListener('visibilitychange', onVisibility, true); } catch (e) { }
        if (!document.hidden) startPoll();
      }
      window.addEventListener('popstate', onPopstate, true);
      window.addEventListener('hashchange', onHashchange, true);
    }

    function stop() {
      stopped = true;
      for (var i = 0; i < observers.length; i++) { try { observers[i].disconnect(); } catch (e) { } }
      for (var j = 0; j < timers.length; j++) { try { clearInterval(timers[j]); } catch (e) { } }
      observers = []; timers = []; urlTimer = null;
      if (pending) { try { clearTimeout(pending); } catch (e) { } pending = null; }
      try {
        window.removeEventListener('popstate', onPopstate, true);
        window.removeEventListener('hashchange', onHashchange, true);
        document.removeEventListener('visibilitychange', onVisibility, true);
      } catch (e) { }
      if (nav) {
        try { nav.removeEventListener('navigate', onNavigate); } catch (e) { }
        nav = null;
      }
      try {
        if (mql && mql.removeEventListener) mql.removeEventListener('change', onScheme);
        else if (mql && mql.removeListener) mql.removeListener(onScheme);
      } catch (e) { }
      mql = null;
    }

    return { start: start, stop: stop, ping: ping };
  }

  NS.detect = {
    __v: 1,
    DARK_L: DARK_L,
    UNCLEAR_RECHECK_MS: UNCLEAR_RECHECK_MS,
    decide: decide,
    measure: measure,
    sampleGrid: sampleGrid,
    declaredDarkScheme: declaredDarkScheme,
    matchMediaDark: matchMediaDark,
    createWatcher: createWatcher
  };
  if (typeof module === 'object' && module && module.exports) module.exports = NS.detect;
})();
