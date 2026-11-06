/*
 * Darkrai - content/picker.js
 * "Fix something unreadable" (PLAN sections 2 and 4).
 *
 * The backstop for anything the engine and the readability guard still get
 * wrong: point at the element, pick "Make readable" or "Invert this", and the
 * fix is remembered for that site in sites[].fixes.
 *
 * The picker's own UI lives in a closed shadow root behind a [data-darkrai]
 * host, so neither the page's styles nor Darkrai's own ever reach it.
 */
(function () {
  'use strict';
  var NS = (window.Darkrai = window.Darkrai || {});
  // Always redefine: see the note in detect.js.
  var color = NS.color;

  var MARK = 'data-darkrai';
  var MAX_LEVELS = 5;
  var MAX_MATCHES = 4;         // a selector may match a few siblings, not a page
  var TOAST_MS = 1400;

  /*
   * The picker's liquid glass, in the same vocabulary as popup.css and
   * options.css but written out in full: this lives in a CLOSED shadow root,
   * so neither the page's custom properties nor Darkrai's own reach it, and
   * none of the extension's shared stylesheets are loaded here either.
   *
   * The page behind this is arbitrary - it could be white, it could be a
   * photograph - so the panels are high-alpha (0.82) over a modest blur. Then
   * the contrast of every word on them is a fact rather than a hope: #f2f2f5
   * on that panel clears 8:1 even over pure white, and the 11px secondary text
   * clears 5:1. The blur is there for the look, never for the legibility.
   *
   * Motion is transform and opacity only, and all three fallbacks are honoured
   * at the bottom.
   */
  var UI_CSS = [
    ':host{all:initial;}',
    '*{box-sizing:border-box;font:13px/1.4 system-ui,"Segoe UI",Roboto,sans-serif;}',

    // The hover ring. Its geometry is set from script every time the pointer
    // moves, so it must never transition - it would lag a frame behind the
    // element it is pointing at. It fades in once, on opacity, when it first
    // appears.
    '.ring{position:fixed;z-index:2147483647;pointer-events:none;',
    'border:2px solid #b4a4ff;border-radius:6px;',
    'box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 14px rgba(180,164,255,.45);',
    'transition:none;animation:dr-pick-ring 140ms linear;}',

    '.bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;',
    'display:flex;align-items:center;gap:10px;max-width:92vw;padding:10px 14px;',
    'border:1px solid rgba(255,255,255,.16);border-radius:16px;',
    'background:rgba(24,25,30,.82);-webkit-backdrop-filter:blur(14px) saturate(1.5);',
    'backdrop-filter:blur(14px) saturate(1.5);color:#f2f2f5;',
    'box-shadow:0 10px 30px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18);',
    'animation:dr-pick-bar 220ms cubic-bezier(.22,1.2,.36,1);}',

    '.menu{position:fixed;z-index:2147483647;display:flex;flex-direction:column;gap:5px;',
    'padding:8px;border:1px solid rgba(255,255,255,.16);border-radius:16px;',
    'background:rgba(24,25,30,.82);-webkit-backdrop-filter:blur(14px) saturate(1.5);',
    'backdrop-filter:blur(14px) saturate(1.5);color:#f2f2f5;',
    'box-shadow:0 10px 30px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18);',
    'animation:dr-pick-menu 200ms cubic-bezier(.22,1.2,.36,1);}',

    '.menu p{margin:0 3px 3px;max-width:230px;color:#c6c9d1;font-size:11px;word-break:break-all;}',

    'button{padding:7px 11px;border:1px solid rgba(255,255,255,.18);border-radius:11px;',
    'background:rgba(255,255,255,.10);color:#f2f2f5;font:inherit;text-align:left;',
    'cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.14);',
    'transition:transform 150ms cubic-bezier(.34,1.56,.64,1),',
    'background-color 150ms ease,border-color 150ms ease;}',
    'button:hover{background:rgba(255,255,255,.17);border-color:#b4a4ff;}',
    'button:active{transform:scale(.955);}',
    'button:focus-visible{outline:2px solid #b4a4ff;outline-offset:2px;}',

    '.hint{color:#c6c9d1;font-size:11px;}',

    '@keyframes dr-pick-ring{from{opacity:0;}to{opacity:1;}}',
    '@keyframes dr-pick-bar{from{opacity:0;',
    'transform:translateX(-50%) translateY(14px) scale(.96);}',
    'to{opacity:1;transform:translateX(-50%) translateY(0) scale(1);}}',
    '@keyframes dr-pick-menu{from{opacity:0;transform:translateY(-7px) scale(.97);}',
    'to{opacity:1;transform:translateY(0) scale(1);}}',

    // Fallback 1: the reader asked for less motion.
    '@media (prefers-reduced-motion:reduce){',
    '.ring,.bar,.menu{animation:none;}',
    'button{transition:background-color 150ms ease,border-color 150ms ease;}',
    'button:active{transform:none;}}',

    // Fallback 2 and 3: no translucency, no blur, real borders, system ink.
    '@media (forced-colors:active){',
    '.bar,.menu{background:Canvas;color:CanvasText;border:1px solid CanvasText;',
    '-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none;animation:none;}',
    '.menu p,.hint{color:CanvasText;}',
    '.ring{border-color:Highlight;box-shadow:none;animation:none;}',
    'button{background:ButtonFace;color:ButtonText;border:1px solid ButtonText;',
    'box-shadow:none;transition:none;}',
    'button:active{transform:none;}',
    'button:focus-visible{outline:2px solid Highlight;}}',

    '@media (prefers-contrast:more){',
    '.bar,.menu{background:#000000;color:#ffffff;border:1px solid #ffffff;',
    '-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none;}',
    '.menu p,.hint{color:#ffffff;}',
    '.ring{border-color:#ffffff;box-shadow:0 0 0 2px #000000;}',
    'button{background:#000000;color:#ffffff;border:1px solid #ffffff;box-shadow:none;}',
    'button:hover{background:#1a1a1a;border-color:#ffffff;}',
    'button:focus-visible{outline:2px solid #ffffff;outline-offset:2px;}}'
  ].join('');

  // ------------------------------------------------------------- selectors

  function esc(s) {
    try { if (window.CSS && CSS.escape) return CSS.escape(String(s)); } catch (e) { }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  /** Ids and classes that frameworks generate are useless tomorrow. */
  function looksGenerated(token) {
    var t = String(token || '');
    if (!t || t.length > 40) return true;
    if (/^\d/.test(t)) return true;
    if (/\d{4,}/.test(t)) return true;
    if (/^(ember|react|radix|headlessui|mui|aria|ui-id|:r|__)/i.test(t)) return true;
    if (/^(css|sc|jsx|emotion)-[a-z0-9]{5,}$/i.test(t)) return true;
    if (/^dr-/.test(t)) return true;
    return false;
  }

  function classPart(el) {
    var out = '';
    var list = [];
    try { list = el.classList ? Array.prototype.slice.call(el.classList) : []; } catch (e) { }
    var used = 0;
    for (var i = 0; i < list.length && used < 2; i++) {
      if (looksGenerated(list[i])) continue;
      out += '.' + esc(list[i]);
      used++;
    }
    return out;
  }

  function nthPart(el) {
    var parent = el.parentElement;
    if (!parent) return '';
    var tag = el.tagName;
    var index = 0, seen = 0;
    for (var i = 0; i < parent.children.length; i++) {
      var kid = parent.children[i];
      if (kid.tagName !== tag) continue;
      seen++;
      if (kid === el) index = seen;
    }
    if (seen < 2) return '';
    return ':nth-of-type(' + index + ')';
  }

  function partFor(el, withNth) {
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';
    if (el.id && !looksGenerated(el.id)) return '#' + esc(el.id);
    var part = el.tagName.toLowerCase() + classPart(el);
    if (withNth) part += nthPart(el);
    return part;
  }

  function matchCount(selector) {
    try { return document.querySelectorAll(selector).length; }
    catch (e) { return 0; }
  }

  /**
   * A selector for this element that is specific enough to be useful and loose
   * enough to survive the page being rebuilt. Returns '' when nothing works.
   */
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    var own = partFor(el, false);
    if (own.charAt(0) === '#' && matchCount(own) === 1) return own;

    var parts = [partFor(el, true)];
    var node = el.parentElement;
    for (var level = 0; level < MAX_LEVELS && node; level++) {
      var selector = parts.join(' > ');
      var hits = matchCount(selector);
      if (hits > 0 && hits <= MAX_MATCHES) return selector;
      var part = partFor(node, true);
      parts.unshift(part);
      if (part === 'body' || part === 'html' || part.charAt(0) === '#') break;
      node = node.parentElement;
    }
    var full = parts.join(' > ');
    return matchCount(full) > 0 ? full : own;
  }

  // ----------------------------------------------------------- the two fixes

  function flat(l) {
    var rgb = color.oklchToSrgb({ l: color.clamp(l, 0, 1), c: 0, h: 0 });
    return color.toCss({ r: rgb.r, g: rgb.g, b: rgb.b, a: 1 });
  }

  /** The CSS one remembered fix turns into. */
  function ruleFor(fix, look) {
    if (!fix || !fix.selector) return '';
    var sel = fix.selector;
    if (fix.action === 'invert') {
      return sel + '{filter:invert(1) hue-rotate(180deg) !important;}';
    }
    var fg = flat(look.top);
    var bg = flat(look.base);
    return sel + '{color:' + fg + ' !important;-webkit-text-fill-color:' + fg + ' !important;' +
      'background-color:' + bg + ' !important;background-image:none !important;' +
      'text-shadow:none !important;}' +
      sel + ' *{color:' + fg + ' !important;-webkit-text-fill-color:' + fg + ' !important;' +
      'fill:' + fg + ' !important;stroke:' + fg + ' !important;text-shadow:none !important;}';
  }

  // ------------------------------------------------------------------ handle

  function create(opts) {
    opts = opts || {};
    var look = opts.look || color.resolveLook({});
    var onSaved = typeof opts.onSaved === 'function' ? opts.onSaved : function () { };
    var fixes = [];
    var sheetNode = null;
    var hostNode = null;
    var shadow = null;
    var ring = null, bar = null, menu = null;
    var picking = false;
    var hover = null;
    var chosen = null;
    var toastTimer = null;

    // --------------------------------------------------------- stored fixes

    function renderFixes() {
      var css = '';
      for (var i = 0; i < fixes.length; i++) css += ruleFor(fixes[i], look);
      if (!css) {
        if (sheetNode && sheetNode.parentNode) sheetNode.parentNode.removeChild(sheetNode);
        sheetNode = null;
        return;
      }
      if (!sheetNode) {
        sheetNode = document.createElement('style');
        sheetNode.setAttribute(MARK, 'fixes');
        (document.head || document.documentElement).appendChild(sheetNode);
      }
      sheetNode.textContent = '@media screen{' + css + '}';
    }

    function applyFixes(list) {
      fixes = [];
      for (var i = 0; i < (list || []).length; i++) {
        var f = list[i];
        if (f && typeof f.selector === 'string' && f.selector &&
          (f.action === 'invert' || f.action === 'readable')) {
          fixes.push({ selector: f.selector, action: f.action });
        }
      }
      renderFixes();
    }

    function setLook(next) {
      look = next || look;
      renderFixes();
    }

    // ------------------------------------------------------------------- UI

    function ui() {
      if (shadow) return shadow;
      hostNode = document.createElement('div');
      hostNode.setAttribute(MARK, 'picker');
      hostNode.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;' +
        'z-index:2147483647;';
      // A closed root: nothing on the page, and nothing of ours, can style it.
      shadow = hostNode.attachShadow ? hostNode.attachShadow({ mode: 'closed' }) : null;
      (document.body || document.documentElement).appendChild(hostNode);
      if (!shadow) return null;
      var style = document.createElement('style');
      style.textContent = UI_CSS;
      shadow.appendChild(style);
      return shadow;
    }

    function makeBar() {
      bar = document.createElement('div');
      bar.className = 'bar';
      bar.setAttribute('role', 'status');
      var text = document.createElement('span');
      text.textContent = 'Click the part that is hard to read.';
      var hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'Enter picks the focused element \u00b7 Esc cancels';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', function () { stop(); });
      bar.appendChild(text);
      bar.appendChild(hint);
      bar.appendChild(cancel);
      shadow.appendChild(bar);
      return text;
    }

    function positionRing(el) {
      if (!ring) {
        ring = document.createElement('div');
        ring.className = 'ring';
        shadow.appendChild(ring);
      }
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { return; }
      ring.style.left = Math.max(0, r.left - 2) + 'px';
      ring.style.top = Math.max(0, r.top - 2) + 'px';
      ring.style.width = Math.max(0, r.width + 4) + 'px';
      ring.style.height = Math.max(0, r.height + 4) + 'px';
      ring.hidden = false;
    }

    function closeMenu() {
      if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
      menu = null;
    }

    function openMenu(el) {
      closeMenu();
      chosen = el;
      menu = document.createElement('div');
      menu.className = 'menu';
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-label', 'Fix this element');

      var what = document.createElement('p');
      what.textContent = describe(el);
      menu.appendChild(what);

      var readable = document.createElement('button');
      readable.type = 'button';
      readable.textContent = 'Make readable';
      readable.addEventListener('click', function () { choose('readable'); });

      var invertIt = document.createElement('button');
      invertIt.type = 'button';
      invertIt.textContent = 'Invert this';
      invertIt.addEventListener('click', function () { choose('invert'); });

      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', function () { closeMenu(); chosen = null; });

      menu.appendChild(readable);
      menu.appendChild(invertIt);
      menu.appendChild(cancel);
      shadow.appendChild(menu);

      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { r = { left: 20, bottom: 20 }; }
      var left = Math.min(Math.max(r.left, 8), Math.max(8, (window.innerWidth || 800) - 260));
      var top = Math.min(r.bottom + 8, Math.max(8, (window.innerHeight || 600) - 150));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      readable.focus();
    }

    function describe(el) {
      var out = el.tagName ? el.tagName.toLowerCase() : 'element';
      if (el.id && !looksGenerated(el.id)) out += '#' + el.id;
      var text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (text) out += ' \u2014 "' + text.slice(0, 40) + (text.length > 40 ? '\u2026' : '') + '"';
      return out;
    }

    function toast(message) {
      if (!bar) return;
      bar.textContent = '';
      var span = document.createElement('span');
      span.textContent = message;
      bar.appendChild(span);
      toastTimer = setTimeout(function () { teardownUi(); }, TOAST_MS);
    }

    function choose(action) {
      var el = chosen;
      closeMenu();
      chosen = null;
      if (!el) { stop(); return; }
      var selector = selectorFor(el);
      if (!selector) { toast('Could not pin that element down.'); detach(); return; }
      var fix = { selector: selector, action: action };
      fixes = fixes.concat([fix]);
      renderFixes();
      detach();
      if (ring) ring.hidden = true;
      toast(action === 'invert' ? 'Inverted, and remembered for this site.'
        : 'Made readable, and remembered for this site.');
      try { onSaved(fix); } catch (e) { }
    }

    // --------------------------------------------------------------- events

    function ours(event) {
      // Shadow DOM retargets, so anything from our UI arrives as the host.
      var t = event.target;
      return !!(t && (t === hostNode || (t.nodeType === 1 && t.hasAttribute && t.hasAttribute(MARK))));
    }

    function onMove(event) {
      if (!picking || menu || ours(event)) return;
      var el = event.target;
      if (!el || el.nodeType !== 1 || el === hover) return;
      hover = el;
      positionRing(el);
    }

    function onClick(event) {
      if (!picking) return;
      if (ours(event)) return;          // let our own buttons work
      event.preventDefault();
      event.stopPropagation();
      var el = event.target;
      if (el && el.nodeType === 1) openMenu(el);
    }

    function onKey(event) {
      if (!picking) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (menu) { closeMenu(); chosen = null; return; }
        stop();
        return;
      }
      if ((event.key === 'Enter' || event.key === ' ') && !menu && !ours(event)) {
        var el = document.activeElement;
        if (el && el !== document.body && el.nodeType === 1) {
          event.preventDefault();
          event.stopPropagation();
          positionRing(el);
          openMenu(el);
        }
      }
    }

    function onScroll() {
      if (!picking) return;
      if (hover && hover.isConnected) positionRing(hover);
      if (menu && chosen) openMenu(chosen);
    }

    function attach() {
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll, true);
    }

    function detach() {
      picking = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll, true);
    }

    function teardownUi() {
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      closeMenu();
      if (hostNode && hostNode.parentNode) hostNode.parentNode.removeChild(hostNode);
      hostNode = null; shadow = null; ring = null; bar = null;
      hover = null; chosen = null;
    }

    function start() {
      if (picking) return true;
      if (!ui()) return false;          // no shadow DOM: nothing safe to draw in
      makeBar();
      picking = true;
      attach();
      return true;
    }

    function stop() {
      detach();
      teardownUi();
    }

    function remove() {
      stop();
      if (sheetNode && sheetNode.parentNode) sheetNode.parentNode.removeChild(sheetNode);
      sheetNode = null;
      fixes = [];
    }

    return {
      start: start,
      stop: stop,
      remove: remove,
      applyFixes: applyFixes,
      setLook: setLook,
      isPicking: function () { return picking; },
      stats: function () { return { fixes: fixes.length, picking: picking }; }
    };
  }

  NS.picker = {
    __v: 1,
    create: create,
    selectorFor: selectorFor,
    ruleFor: ruleFor,
    looksGenerated: looksGenerated
  };
  if (typeof module === 'object' && module && module.exports) module.exports = NS.picker;
})();
