/*
 * Darkrai tests - browser/ui-probe.js
 *
 * The page half of run-ui-checks.js. It is injected with CDP
 * Page.addScriptToEvaluateOnNewDocument (never as a <script> tag in the
 * shipped popup.html or options.html) and hangs its API off window.__drUi.
 *
 * It only measures. Every verdict is made by run-ui-checks.js, except the
 * contrast arithmetic, which is deliberately the extension's own
 * Darkrai.color.contrastRatio / requiredRatio so the suite and the product
 * can never disagree about what 4.5:1 means.
 *
 * Written in the same plain-ES5 style as the rest of the extension and the
 * content-script shim, because it runs in the page.
 */
(function () {
  'use strict';

  // The class the Handheld theme's opaque charcoal panels carry. Family (e)
  // asserts every one of them stays opaque with a real border under forced
  // colors and more contrast.
  var GLASS_CLASS = 'dr-panel';

  var HIDE_ID = '__dr-ui-hide-text';

  function round(n) { return Math.round(n * 100) / 100; }

  function label(el) {
    if (!el || el.nodeType !== 1) return String(el);
    var out = el.tagName.toLowerCase();
    if (el.id) return out + '#' + el.id;
    var cls = typeof el.className === 'string' ? el.className.trim() : '';
    if (cls) out += '.' + cls.split(/\s+/).join('.');
    var parent = el.parentElement;
    if (parent && parent !== document.body) {
      var ptag = parent.tagName.toLowerCase();
      out = (parent.id ? ptag + '#' + parent.id : ptag) + ' > ' + out;
    }
    return out;
  }

  function bold(cs) {
    var w = String(cs.fontWeight || '');
    if (w === 'bold' || w === 'bolder') return true;
    return (parseInt(w, 10) || 400) >= 600;
  }

  /** Inside a collapsed <details>, so laid out but never painted. */
  function collapsed(el) {
    if (el.tagName.toLowerCase() === 'summary') return false;
    return !!(el.closest && el.closest('details:not([open])'));
  }

  /** Rendered, big enough to see, and not a visually hidden (sr-only) box. */
  function visible(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') return false;
    if ((parseFloat(cs.opacity) || 0) === 0) return false;
    if (collapsed(el)) return false;
    // Chrome keeps a box for content-visibility: hidden subtrees, so ask the
    // browser rather than trusting the rectangle.
    if (el.checkVisibility) {
      try {
        if (!el.checkVisibility({
          checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true
        })) return false;
      } catch (e) { /* older engine: the checks above stand on their own */ }
    }
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right <= 0 || r.bottom <= 0) return false;
    return true;
  }

  /** Decorative or hidden on purpose: not something a reader has to read. */
  function decorative(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.getAttribute('aria-hidden') === 'true') return true;
      if (n.getAttribute('role') === 'presentation') return true;
      if (n.hasAttribute('hidden')) return true;
    }
    return false;
  }

  function insetPoints(r) {
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var ix = Math.min(Math.max(r.width * 0.25, 1), Math.max(r.width / 2 - 0.5, 0.5));
    var iy = Math.min(Math.max(r.height * 0.25, 1), Math.max(r.height / 2 - 0.5, 0.5));
    return [
      [round(cx), round(cy)],
      [round(r.left + ix), round(r.top + iy)],
      [round(r.right - ix), round(r.top + iy)],
      [round(r.left + ix), round(r.bottom - iy)],
      [round(r.right - ix), round(r.bottom - iy)]
    ];
  }

  function gridPoints(r, n) {
    var out = [];
    for (var i = 1; i <= n; i++) {
      for (var j = 1; j <= n; j++) {
        out.push([round(r.left + r.width * (i / (n + 1))), round(r.top + r.height * (j / (n + 1)))]);
      }
    }
    return out;
  }

  /** The boxes the element's OWN text actually paints in, one per line. */
  function textRects(el) {
    var out = [];
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 3) continue;
      var text = n.nodeValue || '';
      var start = text.search(/\S/);
      if (start < 0) continue;
      var end = text.length - (/\s*$/.exec(text)[0] || '').length;
      var range = document.createRange();
      try {
        range.setStart(n, start);
        range.setEnd(n, end);
      } catch (e) { continue; }
      var list = range.getClientRects();
      var clip = clipRect(el);
      for (var i = 0; i < list.length && out.length < 6; i++) {
        var r = clip ? intersect(list[i], clip) : list[i];
        if (!r) continue;
        if (r.width < 4 || r.height < 4) continue;
        if (r.right <= 0 || r.bottom <= 0) continue;
        out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
      }
    }
    return out;
  }

  function intersect(a, b) {
    var left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
    var right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  /**
   * The visible window of every scrolling or clipping ancestor, intersected.
   * The popup's inner panel scrolls, and text scrolled out of it is not text a
   * reader sees: its box would otherwise be scored against the bezel it sits
   * behind. null when nothing clips.
   */
  function clipRect(el) {
    var box = null;
    for (var n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      var r = n.getBoundingClientRect();
      var own = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      box = box ? intersect(box, own) : own;
      if (!box) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    return box;
  }

  /**
   * The Handheld frame, as rendered: each named piece's box and visibility,
   * the state the device is showing, and the treatments that state drives.
   */
  function handheld(spec) {
    function piece(sel) {
      var node = document.querySelector(sel);
      if (!node) return { sel: sel, found: false };
      var r = node.getBoundingClientRect();
      var cs = getComputedStyle(node);
      return {
        sel: sel, found: true,
        shown: cs.display !== 'none' && cs.visibility === 'visible' && r.width >= 2 && r.height >= 2 &&
          r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
        x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height)
      };
    }
    var pieces = [];
    for (var i = 0; i < spec.pieces.length; i++) pieces.push(piece(spec.pieces[i]));
    var art = document.querySelector(spec.art);
    var led = document.querySelector(spec.led);
    var screen = art ? art.parentElement : null;
    var holder = document.querySelector(spec.stateOn);
    var artCs = art ? getComputedStyle(art) : null;
    // An LED built from lit layers over a lens (the popup) shows the colour of
    // its most opaque layer; a plain LED (the options band) its own.
    var lit = null;
    if (led && led.firstElementChild) {
      var best = null;
      for (var c = led.firstElementChild; c; c = c.nextElementSibling) {
        var cs = getComputedStyle(c);
        var o = parseFloat(cs.opacity) || 0;
        if (!best || o > best.o) best = { o: o, color: cs.backgroundColor };
      }
      if (best && best.o > 0.5) lit = best.color;
    }
    var dot = document.getElementById('dot');
    var sw = document.getElementById('enabled-text');
    return {
      pieces: pieces,
      state: holder ? holder.getAttribute('data-state') : null,
      art: art ? {
        complete: art.complete, naturalWidth: art.naturalWidth,
        width: round(art.getBoundingClientRect().width),
        rendering: artCs.imageRendering, filter: artCs.filter, opacity: artCs.opacity
      } : null,
      led: lit || (led ? getComputedStyle(led).backgroundColor : null),
      backlight: screen ? getComputedStyle(screen, '::after').opacity : null,
      glow: screen ? getComputedStyle(screen, '::before').opacity : null,
      dot: dot ? {
        state: dot.getAttribute('data-state'),
        base: getComputedStyle(dot).backgroundColor,
        on: getComputedStyle(dot, '::before').opacity,
        native: getComputedStyle(dot, '::after').opacity,
        // Where to read the colour a reader actually sees: the dot's own
        // background is the neutral base, and the lit colours are layers.
        centre: (function () {
          var r = dot.getBoundingClientRect();
          return [round(r.left + r.width / 2), round(r.top + r.height / 2)];
        })()
      } : null,
      switchText: sw ? sw.textContent : null,
      status: (document.getElementById('status-text') || {}).textContent || ''
    };
  }

  /**
   * The Minimal Pokedex hardware on the popup: both Poke Balls (where they
   * sit, how big, that they are decoration and nothing else), the speaker
   * holes, the two sprites and how they are scaled.
   */
  function pokedex() {
    function box(el) {
      var r = el.getBoundingClientRect();
      return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height),
        right: round(r.right), bottom: round(r.bottom) };
    }
    function art(sel) {
      var img = document.querySelector(sel);
      if (!img) return null;
      var r = img.getBoundingClientRect();
      return { naturalWidth: img.naturalWidth, width: round(r.width), height: round(r.height),
        rendering: getComputedStyle(img).imageRendering };
    }
    var device = document.getElementById('device');
    var block = document.querySelector('.hw-block');
    var balls = [];
    var list = document.querySelectorAll('.pokeball');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var cs = getComputedStyle(b);
      balls.push({
        cls: b.className, box: box(b),
        round: cs.borderTopLeftRadius === '50%' || parseFloat(cs.borderTopLeftRadius) >= b.offsetWidth / 2 - 0.5,
        decorative: decorative(b),
        focusable: b.tabIndex >= 0 || b.matches('a[href],button,input,select,textarea,summary,[tabindex]'),
        handler: typeof b.onclick === 'function' || b.hasAttribute('onclick'),
        pointer: cs.pointerEvents
      });
    }
    var holes = document.querySelectorAll('.speaker i');
    var shown = 0;
    for (var h = 0; h < holes.length; h++) {
      var hr = holes[h].getBoundingClientRect();
      if (hr.width >= 3 && hr.height >= 3) shown++;
    }
    return {
      device: device ? box(device) : null,
      block: block ? box(block) : null,
      balls: balls,
      holes: holes.length,
      holesShown: shown,
      lcdArt: art('#lcd-art'),
      avatarArt: art('#avatar-art')
    };
  }

  /**
   * Size and fit: the page, the scrolling panel, and every element whose own
   * text does not fit its box (scrollWidth over clientWidth).
   */
  function sizes() {
    var panel = document.getElementById('panel');
    var clipped = [];
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (decorative(el) || !visible(el)) continue;
      var own = false;
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && /\S/.test(n.nodeValue || '')) { own = true; break; }
      }
      if (!own) continue;
      var cs = getComputedStyle(el);
      if (cs.display === 'inline' || cs.display === 'contents') continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        clipped.push(label(el) + ' ' + el.scrollWidth + 'px of text in ' + el.clientWidth + 'px');
      }
      if (el !== panel && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') &&
        el.scrollHeight > el.clientHeight + 1) {
        clipped.push(label(el) + ' ' + el.scrollHeight + 'px tall in ' + el.clientHeight + 'px');
      }
    }
    return {
      bodyWidth: round(document.body.getBoundingClientRect().width),
      height: round(document.documentElement.getBoundingClientRect().height),
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      panel: panel ? panelFit(panel) : null,
      clipped: clipped
    };
  }

  /**
   * The panel's box and how much of it the content really uses. scrollHeight
   * never drops below clientHeight, so it cannot say how much room is left:
   * the content height is measured from the children instead (top padding to
   * the lowest margin edge, plus the bottom padding), and the slack is what
   * remains of the client box.
   */
  function panelFit(panel) {
    var cs = getComputedStyle(panel);
    var box = panel.getBoundingClientRect();
    var top = box.top + panel.clientTop - panel.scrollTop;
    var lowest = parseFloat(cs.paddingTop) || 0;
    for (var c = panel.firstElementChild; c; c = c.nextElementSibling) {
      var ccs = getComputedStyle(c);
      if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
      var r = c.getBoundingClientRect();
      var bottom = r.bottom + (parseFloat(ccs.marginBottom) || 0) - top;
      if (bottom > lowest) lowest = bottom;
    }
    var content = Math.ceil(lowest + (parseFloat(cs.paddingBottom) || 0));
    return {
      height: round(box.height),
      scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
      content: content,
      slack: panel.clientHeight - content
    };
  }

  /**
   * Let a state change land before anything is read. Waits until the device
   * shows the wanted state, finishes whatever family (a) froze (it pauses
   * every animation at a phase and leaves it there, which would pin the
   * sprite and the lit layers mid-fade), then waits for every animation and
   * transition still running on the page to end, so the reading is the
   * settled state rather than a frame of the 120-220ms cross-fade.
   */
  function settle(want, timeoutMs) {
    var limit = Date.now() + (timeoutMs || 3000);
    var device = document.getElementById('device');
    function frames(n) {
      return new Promise(function (resolve) {
        (function step(k) {
          if (k <= 0) resolve();
          else requestAnimationFrame(function () { step(k - 1); });
        })(n);
      });
    }
    function all() {
      try { return document.getAnimations ? document.getAnimations() : []; } catch (e) { return []; }
    }
    function arrived() {
      return !want || !device || device.getAttribute('data-state') === want;
    }
    function waitState() {
      if (arrived() || Date.now() >= limit) return frames(2);
      return new Promise(function (resolve) { setTimeout(resolve, 30); }).then(waitState);
    }
    var finished = 0;
    return waitState().then(function () {
      var list = all();
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        var timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        if (a.playState === 'paused' && timing && isFinite(timing.endTime)) {
          try { a.finish(); finished++; } catch (e) { }
        }
      }
      var pending = all().filter(function (a) { return a.playState === 'running'; })
        .map(function (a) { return a.finished.catch(function () { }); });
      var cap = new Promise(function (resolve) {
        setTimeout(resolve, Math.max(0, limit - Date.now()));
      });
      return Promise.race([Promise.all(pending), cap]);
    }).then(function () { return frames(2); }).then(function () {
      return {
        state: device ? device.getAttribute('data-state') : null,
        arrived: arrived(),
        unfrozen: finished,
        running: all().filter(function (a) { return a.playState === 'running'; }).length
      };
    });
  }

  function isIconish(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'svg') return true;
    var cls = typeof el.className === 'string' ? el.className : '';
    return /(^|[\s_-])icon([\s_-]|$)/i.test(cls);
  }

  /**
   * Everything a reader has to be able to read: one entry per line of an
   * element's own text, plus one per icon. Each entry carries the five points
   * (box centre and four insets) the backdrop is sampled at.
   */
  function targets(scope) {
    var out = [];
    var root = scope ? document.querySelector(scope) : null;
    if (scope && !root) return out;
    var all = root ? root.querySelectorAll('*') : document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (decorative(el) || !visible(el)) continue;
      var cs = getComputedStyle(el);
      if (isIconish(el)) {
        out.push({
          kind: 'icon', label: label(el), color: cs.color,
          fontSizePx: parseFloat(cs.fontSize) || 0, bold: bold(cs), isIcon: true,
          points: insetPoints(el.getBoundingClientRect())
        });
        continue;
      }
      var rects = textRects(el);
      for (var j = 0; j < rects.length; j++) {
        out.push({
          kind: 'text',
          label: label(el) + (rects.length > 1 ? ' [line ' + (j + 1) + ']' : ''),
          color: cs.color,
          fontSizePx: parseFloat(cs.fontSize) || 0, bold: bold(cs), isIcon: false,
          points: insetPoints(rects[j])
        });
      }
    }
    return out;
  }

  /** The extension's own WCAG arithmetic, over a sampled opaque backdrop. */
  function score(list) {
    var color = window.Darkrai && window.Darkrai.color;
    if (!color) return { error: 'Darkrai.color is not loaded in this page' };
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var fg = color.parse(item.color);
      if (!fg) { out.push({ id: item.id, skipped: 'colour not understood: ' + item.color }); continue; }
      if (fg.a != null && fg.a === 0) { out.push({ id: item.id, skipped: 'fully transparent' }); continue; }
      var bg = { r: item.backdrop[0], g: item.backdrop[1], b: item.backdrop[2], a: 1 };
      var flat = color.composite(fg, bg);
      var ratio = color.contrastRatio(flat, bg);
      var required = color.requiredRatio({
        fontSizePx: item.fontSizePx, bold: item.bold, isIcon: item.isIcon
      });
      out.push({
        id: item.id, ratio: round(ratio), required: required,
        pass: color.passes(ratio, required)
      });
    }
    return { results: out };
  }

  /** Plain colour-against-backdrop ratios (used for focus rings). */
  function ratios(list) {
    var color = window.Darkrai && window.Darkrai.color;
    if (!color) return { error: 'Darkrai.color is not loaded in this page' };
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var fg = color.parse(item.color);
      if (!fg) { out.push({ id: item.id, skipped: 'colour not understood: ' + item.color }); continue; }
      var bg = { r: item.backdrop[0], g: item.backdrop[1], b: item.backdrop[2], a: 1 };
      out.push({ id: item.id, ratio: round(color.contrastRatio(color.composite(fg, bg), bg)) });
    }
    return { results: out };
  }

  /** Make every glyph transparent, so a screenshot shows the real backdrop. */
  function hideText(on) {
    var node = document.getElementById(HIDE_ID);
    if (!on) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
      return false;
    }
    if (!node) {
      node = document.createElement('style');
      node.id = HIDE_ID;
      node.textContent = '*,*::before,*::after{color:transparent !important;' +
        '-webkit-text-fill-color:transparent !important;fill:transparent !important;' +
        'stroke:transparent !important;text-shadow:none !important;}';
      document.documentElement.appendChild(node);
    }
    return true;
  }

  // ------------------------------------------------------- stylesheet walking

  function sheetProps() {
    var transitions = [], frames = [], notes = [];
    var sheets = [].slice.call(document.styleSheets || []);
    if (document.adoptedStyleSheets) sheets = sheets.concat([].slice.call(document.adoptedStyleSheets));

    function where(sheet) {
      if (sheet && sheet.href) return String(sheet.href).split('/').pop();
      if (sheet && sheet.ownerNode && sheet.ownerNode.id === HIDE_ID) return HIDE_ID;
      return 'adopted or inline';
    }

    function walk(rules, from) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (window.CSSKeyframesRule && rule instanceof window.CSSKeyframesRule) {
          var seen = {};
          for (var k = 0; k < rule.cssRules.length; k++) {
            var st = rule.cssRules[k].style;
            for (var p = 0; p < st.length; p++) seen[st[p]] = 1;
          }
          frames.push({ name: rule.name, from: from, props: Object.keys(seen) });
          continue;
        }
        if (rule.cssRules && rule.cssRules.length) { walk(rule.cssRules, from); continue; }
        if (!rule.style) continue;
        var tp = rule.style.getPropertyValue('transition-property');
        // A shorthand carrying var() leaves its longhands pending until
        // computed time, so read the property names off the shorthand itself.
        if (!tp) {
          var sh = rule.style.getPropertyValue('transition');
          if (sh) {
            tp = sh.split(',').map(function (part) {
              return part.trim().split(/\s+/)[0] || '';
            }).join(', ');
          }
        }
        if (tp) {
          transitions.push({
            selector: rule.selectorText || '(no selector)',
            from: from,
            value: tp
          });
        }
      }
    }

    for (var s = 0; s < sheets.length; s++) {
      var rules = null;
      try { rules = sheets[s].cssRules; } catch (e) {
        notes.push('a stylesheet could not be read: ' + where(sheets[s]));
        continue;
      }
      if (rules) walk(rules, where(sheets[s]));
    }
    return { transitions: transitions, keyframes: frames, notes: notes };
  }

  // ------------------------------------------------------------ layout boxes

  /**
   * Inside a closed <details>, outside its summary: never painted, and Chrome
   * skips its layout (content-visibility: hidden on ::details-content), so
   * getBoundingClientRect there reads all zeros or a real box depending on
   * what last forced a layout. Its geometry means nothing until it opens.
   */
  function unpainted(el) {
    var up = el.parentElement;
    var shut = up && up.closest ? up.closest('details:not([open])') : null;
    if (!shut) return false;
    var summary = el.closest('summary');
    return !(summary && summary.parentElement === shut);
  }

  function boxes() {
    var all = document.querySelectorAll('body, body *');
    var items = [];
    for (var i = 0; i < all.length; i++) {
      if (unpainted(all[i])) continue;
      var r = all[i].getBoundingClientRect();
      items.push({
        k: i, label: label(all[i]),
        x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height)
      });
    }
    return { scrollHeight: document.documentElement.scrollHeight, items: items };
  }

  // ---------------------------------------------------------- glass surfaces

  function surfaces() {
    var color = window.Darkrai && window.Darkrai.color;
    var list = document.getElementsByClassName(GLASS_CLASS);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      // A surface nobody can see has no pixels to read: the confirmation
      // dialog carries the glass classes while it waits, hidden, in the
      // markup, and measuring its zero-sized box would say nothing true.
      if (!visible(el)) continue;
      var cs = getComputedStyle(el);
      var bg = color ? color.parse(cs.backgroundColor) : null;
      var r = el.getBoundingClientRect();
      out.push({
        label: label(el),
        backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
        backgroundColor: cs.backgroundColor,
        bgAlpha: bg ? (bg.a == null ? 1 : bg.a) : null,
        borderWidth: Math.max(
          parseFloat(cs.borderTopWidth) || 0, parseFloat(cs.borderBottomWidth) || 0,
          parseFloat(cs.borderLeftWidth) || 0, parseFloat(cs.borderRightWidth) || 0
        ),
        borderStyle: cs.borderTopStyle,
        points: gridPoints(r, 4)
      });
    }
    return out;
  }

  // ----------------------------------------------------------- focus walking

  function candidateNodes() {
    return document.querySelectorAll('input,select,button,summary,textarea,a[href],[tabindex]');
  }

  /** Every control a reader could land on, with its place in document order. */
  function focusables() {
    var all = candidateNodes();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.disabled) continue;
      if (el.getAttribute('tabindex') === '-1') continue;
      if (decorative(el)) continue;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (collapsed(el)) continue;
      out.push({ idx: i, label: label(el) });
    }
    return out;
  }

  function indexOfActive() {
    var all = candidateNodes();
    for (var i = 0; i < all.length; i++) if (all[i] === document.activeElement) return i;
    return -1;
  }

  function bigEnough(el) {
    if (!el || el.nodeType !== 1) return false;
    var r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  }

  function hasRing(el) {
    if (!bigEnough(el)) return false;
    var cs = getComputedStyle(el);
    return cs.outlineStyle !== 'none' && (parseFloat(cs.outlineWidth) || 0) >= 1;
  }

  /**
   * The element that actually shows the ring. A visually hidden input (the
   * popup's switch and its segmented radios) is styled through its label or
   * its next sibling, which is where the ring is drawn, so take the first
   * candidate that carries an outline and fall back to the first visible one.
   */
  function indicatorFor(el) {
    var candidates = [el];
    if (el.id) candidates.push(document.querySelector('label[for="' + el.id + '"]'));
    candidates.push(el.nextElementSibling, el.previousElementSibling, el.parentElement);
    var i;
    for (i = 0; i < candidates.length; i++) {
      if (hasRing(candidates[i])) return candidates[i];
    }
    for (i = 0; i < candidates.length; i++) {
      if (bigEnough(candidates[i])) return candidates[i];
    }
    return el;
  }

  function edgePoints(r, offset, width) {
    var out = Math.max(offset, 0) + Math.max(width, 1) + 2;
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return {
      outside: [
        [round(cx), round(r.top - out)], [round(r.right + out), round(cy)],
        [round(cx), round(r.bottom + out)], [round(r.left - out), round(cy)]
      ],
      inside: [
        [round(cx), round(r.top + 2)], [round(r.right - 2), round(cy)],
        [round(cx), round(r.bottom - 2)], [round(r.left + 2), round(cy)]
      ]
    };
  }

  function activeInfo() {
    var el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return { none: true, tag: el ? el.tagName.toLowerCase() : 'null' };
    }
    var ind = indicatorFor(el);
    var cs = getComputedStyle(ind);
    var offset = parseFloat(cs.outlineOffset) || 0;
    var width = parseFloat(cs.outlineWidth) || 0;
    return {
      idx: indexOfActive(),
      key: label(el),
      indicator: ind === el ? 'self' : label(ind),
      outlineStyle: cs.outlineStyle,
      outlineWidth: round(width),
      outlineColor: cs.outlineColor,
      outlineOffset: round(offset),
      boxShadow: cs.boxShadow,
      edge: edgePoints(ind.getBoundingClientRect(), offset, width)
    };
  }

  /**
   * Focus one candidate by its place in document order. Used for the controls
   * Tab cannot reach on its own (the unchecked radio of a group, and anything
   * past a <select>, which eats the key in headless). Chrome keeps the
   * keyboard modality set by the real Tab presses, so :focus-visible still
   * matches and the ring we read is the ring a reader would see.
   */
  function focusAt(idx) {
    var all = candidateNodes();
    var el = all[idx];
    if (!el) return { none: true, tag: 'missing' };
    try { el.focus(); } catch (e) { }
    return activeInfo();
  }

  function dropFocus() {
    try {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    } catch (e) { }
    return true;
  }

  /** Focus one element by id (the dialog's buttons are checked by name). */
  function focusId(id) {
    var el = document.getElementById(id);
    if (!el) return { none: true, tag: 'missing #' + id };
    try { el.focus(); } catch (e) { }
    return activeInfo();
  }

  // ------------------------------------------------------- the modal dialog

  /** A real click, so the page's own handler is what opens the dialog. */
  function press(selector) {
    var el = document.querySelector(selector);
    if (!el) return { ok: false, why: 'nothing matches ' + selector };
    if (el.disabled) return { ok: false, why: selector + ' is disabled' };
    try { el.click(); } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
    return { ok: true };
  }

  /** Everything the dialog assertions need, in one round trip. */
  function dialogState(dialogSel, modalSel) {
    var dialog = document.querySelector(dialogSel);
    var modal = modalSel ? document.querySelector(modalSel) : null;
    if (!dialog) return { found: false };
    var labelId = dialog.getAttribute('aria-labelledby');
    var labelNode = labelId ? document.getElementById(labelId) : null;
    var active = document.activeElement;
    var main = document.querySelector('main');
    var list = dialog.querySelectorAll('button,select,input,textarea,a[href],[tabindex]');
    var stops = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].disabled) continue;
      if (list[i].getAttribute('tabindex') === '-1') continue;
      // Hidden and unrendered controls cannot take focus, so they are not tab
      // stops - the page's own trap filters them the same way.
      if (list[i].hidden) continue;
      if (!list[i].getClientRects().length) continue;
      stops.push({ id: list[i].id, label: label(list[i]) });
    }
    return {
      found: true,
      hidden: !!(modal && modal.hasAttribute('hidden')),
      visible: visible(dialog),
      role: dialog.getAttribute('role'),
      ariaModal: dialog.getAttribute('aria-modal'),
      name: labelNode ? (labelNode.textContent || '').trim()
        : (dialog.getAttribute('aria-label') || ''),
      active: active && active.nodeType === 1 ? label(active) : 'nothing',
      activeId: active && active.id ? active.id : '',
      activeInside: !!(active && dialog.contains(active)),
      mainInert: !!(main && main.inert),
      stops: stops
    };
  }

  // ------------------------------------------------------------- the budget

  function budget() {
    var paint = [];
    try { paint = performance.getEntriesByType('paint') || []; } catch (e) { }
    var fcp = null;
    for (var i = 0; i < paint.length; i++) {
      if (paint[i].name === 'first-contentful-paint') fcp = round(paint[i].startTime);
    }
    return {
      fcp: fcp,
      bodyWidth: round(document.body.getBoundingClientRect().width),
      scrollHeight: document.documentElement.scrollHeight,
      animations: document.getAnimations ? document.getAnimations().length : 0
    };
  }

  function contentHeight() { return document.documentElement.scrollHeight; }

  /** Freeze every animation at a fraction of its duration. */
  function setPhase(fraction) {
    var list = [];
    try { list = document.getAnimations ? document.getAnimations() : []; } catch (e) { }
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].pause();
        var duration = 0;
        var timing = list[i].effect && list[i].effect.getTiming ? list[i].effect.getTiming() : null;
        if (timing && typeof timing.duration === 'number') duration = timing.duration;
        list[i].currentTime = duration * fraction;
      } catch (e) { }
    }
    return list.length;
  }

  window.__drUi = {
    GLASS_CLASS: GLASS_CLASS,
    targets: targets,
    score: score,
    ratios: ratios,
    hideText: hideText,
    sheetProps: sheetProps,
    boxes: boxes,
    surfaces: surfaces,
    focusables: focusables,
    activeInfo: activeInfo,
    focusAt: focusAt,
    focusId: focusId,
    dropFocus: dropFocus,
    press: press,
    dialogState: dialogState,
    budget: budget,
    handheld: handheld,
    pokedex: pokedex,
    sizes: sizes,
    settle: settle,
    contentHeight: contentHeight,
    setPhase: setPhase,
    dpr: function () { return window.devicePixelRatio || 1; }
  };
})();
