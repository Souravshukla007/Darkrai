/*
 * Darkrai - content/engine-smart.js
 * The recolouring engine (PLAN sections 6.2 and 6.3).
 *
 * Nothing is inverted: every colour is mapped by role in OKLCH so hue survives
 * and images, video and canvas are never touched.
 */
(function () {
  'use strict';
  var NS = (window.Darkrai = window.Darkrai || {});
  // Always redefine: see the note in detect.js. A tab open across an extension
  // update must end up running the new build, not the one it was loaded with.
  var color = NS.color;
  // Dev-only timing. A missing module must be harmless.
  var T = NS.timing || { mark: function () { }, count: function () { } };

  var MARK = 'data-darkrai';
  var IDATTR = 'data-dr-id';
  var SLICE_MS = 8;
  var TICK_MS = 1000;
  // The upkeep poll doubles its wait while the page stays quiet and drops back
  // to TICK_MS the moment an observer sees a real change.
  var TICK_MAX_MS = 8000;
  var SHADOW_SWEEP_BUDGET = 4000;

  // One id allocator for every file that stamps data-dr-id, so the smart engine
  // and the readability guard can never hand out the same id.
  NS.ids = NS.ids || { n: 0, next: function () { return ++this.n; } };

  var ATTR_ROLE = {
    bgcolor: ['background-color', 'bg'],
    color: ['color', 'fg'],
    text: ['color', 'fg'],
    link: ['color', 'fg'],
    vlink: ['color', 'fg'],
    alink: ['color', 'fg'],
    fill: ['fill', 'fg'],
    stroke: ['stroke', 'fg']
  };

  function now() {
    return (typeof performance === 'object' && performance.now) ? performance.now() : Date.now();
  }

  function kindOf(rule) {
    var n = (rule && rule.constructor && rule.constructor.name) || '';
    if (n && n !== 'Object') return n;
    if (rule.selectorText != null && rule.style) return 'CSSStyleRule';
    if (rule.styleSheet !== undefined && rule.href !== undefined) return 'CSSImportRule';
    if (rule.media && rule.cssRules) return 'CSSMediaRule';
    if (rule.cssRules) return 'CSSGroupingRule';
    return 'unknown';
  }

  function escapeForText(css) {
    // A </style> sequence inside generated text would end our style element.
    return String(css).replace(/<\/(style)/gi, '<\\/$1');
  }

  // --------------------------------------------------------- var() rewriting

  /**
   * Point every var() use at its role variant, keeping the original as the
   * fallback so a scope we never saw cannot break the declaration.
   *   var(--x)        -> var(--dr-bg--x, var(--x))
   *   var(--x, #fff)  -> var(--dr-bg--x, var(--x, #fff))
   */
  /** `--brand` used as a background becomes `--dr-bg--brand`. */
  function roleVarName(role, name) {
    return '--dr-' + role + '--' + String(name).replace(/^--/, '');
  }

  /**
   * mapFallback (optional) recolours the colours inside a var() fallback: the
   * colour walk skips var() entirely, so a fallback used to stay as written
   * and a token that is not defined at use time painted that light colour.
   */
  function rewriteVarUses(value, role, known, mapFallback) {
    var s = String(value);
    if (s.indexOf('var(') < 0) return s;
    var out = '', i = 0, n = s.length;
    while (i < n) {
      var idx = s.indexOf('var(', i);
      if (idx < 0) { out += s.slice(i); break; }
      out += s.slice(i, idx);
      var depth = 0, e = idx + 3;
      for (; e < n; e++) {
        if (s.charAt(e) === '(') depth++;
        else if (s.charAt(e) === ')') { depth--; if (depth === 0) { e++; break; } }
      }
      var whole = s.slice(idx, e);
      var inner = s.slice(idx + 4, e - 1);
      var m = /^\s*(--[^\s,)]+)\s*(?:,([\s\S]*))?$/.exec(inner);
      var fallback = m && m[2] != null ? m[2] : '';
      var rest = fallback ? rewriteVarUses(fallback, role, known, mapFallback) : '';
      if (rest && mapFallback) rest = mapFallback(rest);
      if (m && (!known || known(m[1]))) {
        out += 'var(' + roleVarName(role, m[1]) + ', var(' + m[1] + (rest ? ',' + rest : '') + '))';
      } else if (m && rest && mapFallback) {
        out += 'var(' + m[1] + ',' + rest + ')';
      } else {
        out += whole;
      }
      i = e;
    }
    return out;
  }

  // Colour-carrying shorthands. Declared with a var() inside, the browser keeps
  // only the shorthand text and reports every longhand as '' (pending
  // substitution), e.g. `background: var(--blue-100, #f0f4ff)`.
  var VAR_SHORTHANDS = ['background', 'border', 'border-top', 'border-right', 'border-bottom',
    'border-left', 'border-color', 'border-block', 'border-inline', 'border-block-start',
    'border-block-end', 'border-inline-start', 'border-inline-end', 'outline', 'column-rule',
    'text-decoration'];

  function pendingShorthands(style) {
    var out = [];
    for (var i = 0; i < VAR_SHORTHANDS.length; i++) {
      var v = '';
      try { v = style.getPropertyValue(VAR_SHORTHANDS[i]); } catch (e) { }
      if (v && v.indexOf('var(') > -1) out.push(VAR_SHORTHANDS[i]);
    }
    return out;
  }

  /**
   * Colour longhands that read '' (lost) while no readable var() shorthand
   * (sh) covers them: what is left when a var() shorthand is followed by one
   * of its own longhands, and CSSOM then reports the shorthand as '' too.
   */
  function lostLonghands(lost, sh) {
    var out = [];
    for (var i = 0; i < lost.length; i++) {
      var covered = false;
      for (var j = 0; j < sh.length; j++) if (lost[i].indexOf(sh[j] + '-') === 0) { covered = true; break; }
      if (!covered) out.push(lost[i]);
    }
    return out;
  }

  function hasMask(style) {
    var props = ['mask-image', '-webkit-mask-image', 'mask', '-webkit-mask'];
    for (var i = 0; i < props.length; i++) {
      var v = '';
      try { v = style.getPropertyValue(props[i]); } catch (e) { }
      v = String(v || '').trim().toLowerCase();
      if (v && v !== 'none' && v !== 'initial' && v !== 'unset' && v !== 'inherit') return true;
    }
    return false;
  }

  var MASKED = { masked: true };
  /** The role context for one declaration block (see color.roleForProperty). */
  function roleCtx(style) { return hasMask(style) ? MASKED : null; }

  function varNamesIn(value) {
    var out = [], re = /var\(\s*(--[^\s,)]+)/g, m;
    while ((m = re.exec(String(value)))) out.push(m[1]);
    return out;
  }

  // ------------------------------------------------------------------ engine

  function create(opts) {
    opts = opts || {};
    var look = opts.look || color.resolveLook({});
    var requestSheet = opts.requestSheet || function () { return Promise.resolve(null); };
    var settings = opts.settings || {};
    var debug = !!opts.debug;

    var active = false;
    var writing = false;                 // guards the observers from our writes
    var nodes = [];                      // <style> elements we created
    var ourSheets = [];                  // { target, sheet } constructed sheets
    var observers = [];
    var intervals = [];
    var shadowRoots = new Set();
    var inlineOriginals = new Map();     // element -> original style attribute
    var inlineRules = new Map();         // id -> css text
    var touchedElements = new Set();
    var sheetRuleCounts = new Map();     // CSSStyleSheet -> rule count
    var processedSheets = new Set();
    var varDecls = new Map();            // name -> [{ scope, value }]
    var varRoles = new Map();            // name -> { bg:1, fg:1, bd:1 }
    var varEdges = new Map();            // name -> [dependency names]
    var queue = [];
    var pumping = false;
    var settledCallbacks = [];
    var settled = false;
    var settleTries = 0;
    var idCounter = 0;
    // { sheet, node }: a constructed sheet when the browser has them, a <style>
    // node as the fallback. Never both.
    var inlineSheetRec = { sheet: null, node: null };
    var varSheetRec = { sheet: null, node: null };
    var inlineDirty = false;
    var varDirty = false;
    var fetchedUrls = new Set();
    var hostQueue = [];                  // shadow roots the observer spotted
    var sweptOnce = false;
    var changedSinceSweep = false;
    var tickTimer = null;
    var tickDelay = TICK_MS;

    // -------------------------------------------------------- style plumbing

    function makeStyle(kind, where, first) {
      var el = document.createElement('style');
      el.setAttribute(MARK, kind);
      el.setAttribute('type', 'text/css');
      var host = where || document.head || document.documentElement;
      writing = true;
      try {
        if (first && host.firstChild) host.insertBefore(el, host.firstChild);
        else host.appendChild(el);
      } finally { writing = false; }
      nodes.push(el);
      T.count('styleNodes', 1);
      return el;
    }

    function setText(el, css) {
      writing = true;
      try { el.textContent = '@media screen{' + escapeForText(css) + '}'; }
      finally { writing = false; }
    }

    function insertAfter(ref, kind, css) {
      var el = document.createElement('style');
      el.setAttribute(MARK, kind);
      writing = true;
      try {
        el.textContent = '@media screen{' + escapeForText(css) + '}';
        if (ref && ref.parentNode) ref.parentNode.insertBefore(el, ref.nextSibling);
        else (document.head || document.documentElement).appendChild(el);
      } finally { writing = false; }
      nodes.push(el);
      T.count('styleNodes', 1);
      return el;
    }

    function adopt(target, css, kind) {
      if (typeof CSSStyleSheet !== 'function') return null;
      var sheet;
      try { sheet = new CSSStyleSheet(); sheet.replaceSync('@media screen{' + css + '}'); }
      catch (e) { return null; }
      // The marker a <style> node carries in its attribute. Our own sheets must
      // be recognisable from outside too: main.js pulls them for the
      // already-dark measurement and must not read back our own output.
      try { sheet.__darkrai = kind || 'adopted'; } catch (e) { }
      try {
        target.adoptedStyleSheets = (target.adoptedStyleSheets || []).concat([sheet]);
        ourSheets.push({ target: target, sheet: sheet });
        T.count('adoptedSheets', 1);
        return sheet;
      } catch (e) { return null; }
    }

    // ------------------------------------------------------------ base sheet

    function baseCss() {
      var bg = color.transformColor('#ffffff', 'bg', look) || 'rgb(36, 36, 36)';
      var fg = color.transformColor('#000000', 'fg', look) || 'rgb(226, 226, 226)';
      var bd = color.transformColor('#cccccc', 'bd', look) || 'rgb(90, 90, 90)';
      var sel = color.transformColor('#3297fd', 'bg', look) || 'rgb(60, 90, 140)';
      var css = ':root{color-scheme:dark !important;}' +
        'html{background-color:' + bg + ';color:' + fg + ';}' +
        'html::-webkit-scrollbar{background-color:' + bg + ';}' +
        'body{color:' + fg + ';}' +
        '::selection{background-color:' + sel + ';color:' + fg + ';}' +
        '::placeholder{color:' + bd + ';}' +
        'input,textarea,select,button{caret-color:' + fg + ';}' +
        'hr{border-color:' + bd + ';}';
      if (settings.dimImages) css += 'img,video,picture{filter:brightness(0.85);}';
      return css;
    }

    // ------------------------------------------------- declaration handling

    function knownVar(name) { return varRoles.has(name) || varDecls.has(name); }

    var fallbackMappers = {};
    /** Recolours the literal colours in a var() fallback for one role. */
    function fallbackMapper(role) {
      if (!fallbackMappers[role]) {
        fallbackMappers[role] = function (v) { return color.hasColor(v) ? color.transformValue(v, role, look) : v; };
      }
      return fallbackMappers[role];
    }

    /**
     * A var() shorthand followed by one of its own longhands in the same block
     * loses its text in CSSOM: Wikipedia's sidebar fade is
     *   background: linear-gradient(rgba(255,255,255,0), var(--background-color-base, #fff));
     *   background-repeat: no-repeat;
     * and then 'background' and every other longhand read '' (see
     * lostLonghands), so no loop can see a colour. The used value is still
     * there on an element the rule matches: read it there and recolour it.
     */
    function resolveLost(selectorText, props, style, ctx) {
      var pm = /::?(before|after)\b/i.exec(selectorText || '');
      var base = String(selectorText || '').replace(/::?(before|after)\b/gi, '').trim();
      var el = null;
      try { el = base ? document.querySelector(base) : null; } catch (e) { el = null; }
      if (!el) return '';
      var cs;
      try { cs = getComputedStyle(el, pm ? '::' + pm[1].toLowerCase() : null); } catch (e) { return ''; }
      var out = '';
      for (var i = 0; i < props.length; i++) {
        var role = color.roleForProperty(props[i], ctx);
        var v = cs.getPropertyValue(props[i]);
        if (!role || !v || v === 'none' || v === 'rgba(0, 0, 0, 0)' || !color.hasColor(v)) continue;
        var t = color.transformValue(v, role, look);
        if (t && t !== v) out += props[i] + ':' + t + (style.getPropertyPriority(props[i]) ? ' !important' : '') + ';';
      }
      return out;
    }

    function transformDecl(prop, value, role) {
      var out = value;
      if (out.indexOf('var(') > -1) out = rewriteVarUses(out, role, knownVar, fallbackMapper(role));
      if (color.hasColor(out)) out = color.transformValue(out, role, look);
      return out === value ? null : out;
    }

    function declsFor(style, selectorText) {
      var out = '';
      var ctx = roleCtx(style);
      var lost = [];
      for (var i = 0; i < style.length; i++) {
        var prop = style[i];
        if (!prop) continue;
        if (prop.charAt(0) === '-' && prop.charAt(1) === '-') continue;  // handled as variables
        var role = color.roleForProperty(prop, ctx);
        if (!role) continue;
        var value = style.getPropertyValue(prop);
        if (value === '') { lost.push(prop); continue; }
        if (!value || value === 'none' || value === 'currentcolor') continue;
        var next = transformDecl(prop, value, role);
        if (next == null) continue;
        out += prop + ':' + next + (style.getPropertyPriority(prop) ? ' !important' : '') + ';';
      }
      // A shorthand holding var() leaves every longhand empty until computed
      // time, so the loop above never sees it: handle the shorthand itself.
      var sh = pendingShorthands(style);
      for (var s = 0; s < sh.length; s++) {
        var srole = color.roleForProperty(sh[s], ctx);
        if (!srole) continue;
        var sv = style.getPropertyValue(sh[s]);
        var snext = transformDecl(sh[s], sv, srole);
        if (snext == null) continue;
        out += sh[s] + ':' + snext + (style.getPropertyPriority(sh[s]) ? ' !important' : '') + ';';
      }
      if (lost.length && selectorText) {
        var gone = lostLonghands(lost, sh);
        if (gone.length) out += resolveLost(selectorText, gone, style, ctx);
      }
      return out;
    }

    // ------------------------------------------------- pass A: collect vars

    function noteVarRole(name, role) {
      var set = varRoles.get(name);
      if (!set) { set = {}; varRoles.set(name, set); }
      set[role] = 1;
    }

    function collectStyle(style, scope) {
      var i, prop, value;
      var ctx = roleCtx(style);
      for (i = 0; i < style.length; i++) {
        prop = style[i];
        if (!prop) continue;
        value = style.getPropertyValue(prop);
        if (prop.charAt(0) === '-' && prop.charAt(1) === '-') {
          if (prop.indexOf('--dr-') === 0) continue;         // one of ours
          if (!color.hasColor(value) && value.indexOf('var(') < 0) continue;
          var list = varDecls.get(prop);
          if (!list) { list = []; varDecls.set(prop, list); }
          list.push({ scope: scope, value: value });
          var deps = varNamesIn(value);
          if (deps.length) varEdges.set(prop, (varEdges.get(prop) || []).concat(deps));
          continue;
        }
        var role = color.roleForProperty(prop, ctx);
        if (!role || value.indexOf('var(') < 0) continue;
        var names = varNamesIn(value);
        for (var j = 0; j < names.length; j++) noteVarRole(names[j], role);
      }
      var sh = pendingShorthands(style);
      for (var s = 0; s < sh.length; s++) {
        var srole = color.roleForProperty(sh[s], ctx);
        if (!srole) continue;
        var snames = varNamesIn(style.getPropertyValue(sh[s]));
        for (var t = 0; t < snames.length; t++) noteVarRole(snames[t], srole);
      }
    }

    function collectRules(rules, scope) {
      if (!rules) return;
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i], k = kindOf(r);
        if (k === 'CSSStyleRule') { collectStyle(r.style, r.selectorText); continue; }
        if (r.cssRules) { collectRules(r.cssRules, scope); continue; }
      }
    }

    function propagateVarRoles() {
      var pending = [];
      varRoles.forEach(function (roles, name) { pending.push(name); });
      var guard = 0;
      while (pending.length && guard++ < 5000) {
        var name = pending.shift();
        var roles = varRoles.get(name) || {};
        var deps = varEdges.get(name) || [];
        for (var i = 0; i < deps.length; i++) {
          var dep = deps[i], depRoles = varRoles.get(dep);
          if (!depRoles) { depRoles = {}; varRoles.set(dep, depRoles); }
          var changed = false;
          for (var rk in roles) if (!depRoles[rk]) { depRoles[rk] = 1; changed = true; }
          if (changed) pending.push(dep);
        }
      }
      // Colour variables nobody used in a colour property yet: give them both
      // common variants so a later use still resolves.
      varDecls.forEach(function (list, name) {
        if (!varRoles.has(name)) varRoles.set(name, { bg: 1, fg: 1 });
      });
    }

    function buildVarCss() {
      var byScope = new Map();
      varDecls.forEach(function (list, name) {
        var roles = varRoles.get(name);
        if (!roles) return;
        for (var i = 0; i < list.length; i++) {
          var entry = list[i], scope = entry.scope || ':root';
          var bucket = byScope.get(scope);
          if (!bucket) { bucket = []; byScope.set(scope, bucket); }
          for (var role in roles) {
            var v = entry.value;
            if (v.indexOf('var(') > -1) v = rewriteVarUses(v, role, knownVar, fallbackMapper(role));
            if (color.hasColor(v)) v = color.transformValue(v, role, look);
            bucket.push(roleVarName(role, name) + ':' + v + ';');
          }
        }
      });
      var css = '';
      byScope.forEach(function (decls, scope) {
        if (!decls.length) return;
        css += scope + '{' + decls.join('') + '}';
      });
      return css;
    }

    /**
     * One constructed sheet, replaced whole once per flush, instead of a
     * <style> node whose textContent is reassigned: the same CSS, but without
     * a DOM mutation and without re-inserting a style element every time.
     * Order inside these two sheets never matters - every rule is keyed on a
     * different variable name or a different data-dr-id - so a single sheet is
     * safe. The per-page override sheets built by insertAfter() stay where they
     * are: their insertion point is what keeps the cascade right (PLAN 6.3).
     */
    function writeOwnSheet(rec, kind, css) {
      if (rec.sheet) {
        try { rec.sheet.replaceSync('@media screen{' + css + '}'); return true; }
        catch (e) { rec.sheet = null; }
      }
      if (!rec.node) {
        rec.sheet = adopt(document, css, kind);
        if (rec.sheet) return true;
        rec.node = makeStyle(kind);              // no constructed sheets here
      }
      setText(rec.node, css);
      return true;
    }

    function flushVars() {
      if (!active) return;
      propagateVarRoles();
      var css = buildVarCss();
      varDirty = false;
      if (!css) return;
      writeOwnSheet(varSheetRec, 'vars', css);
    }

    // ------------------------------------------------ pass B: emit overrides

    function emitRules(rules) {
      if (!rules) return '';
      var out = '';
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i], k = kindOf(r);
        if (k === 'CSSStyleRule') {
          var decls = declsFor(r.style, r.selectorText);
          if (decls) out += r.selectorText + '{' + decls + '}';
          continue;
        }
        if (k === 'CSSMediaRule') {
          var inner = emitRules(r.cssRules);
          if (inner) out += '@media ' + r.conditionText + '{' + inner + '}';
          continue;
        }
        if (k === 'CSSSupportsRule') {
          var s = emitRules(r.cssRules);
          if (s) out += '@supports ' + r.conditionText + '{' + s + '}';
          continue;
        }
        if (k === 'CSSLayerBlockRule') {
          var l = emitRules(r.cssRules);
          // Emit outside the layer: unlayered styles beat layered ones, which
          // is what we want for an override.
          if (l) out += l;
          continue;
        }
        if (k === 'CSSContainerRule') {
          var c = emitRules(r.cssRules);
          if (c) out += '@container ' + (r.conditionText || '') + '{' + c + '}';
          continue;
        }
        if (k === 'CSSImportRule') {
          if (r.styleSheet) queueSheet(r.styleSheet, null);
          continue;
        }
        if (k === 'CSSScopeRule' || k === 'CSSStartingStyleRule' || k === 'CSSGroupingRule') {
          var g = emitRules(r.cssRules);
          if (g) out += g;
          continue;
        }
        // Keyframes, font-face, page and counter-style are left alone.
      }
      return out;
    }

    function readRules(sheet) {
      try { return sheet.cssRules; } catch (e) { return null; }
    }

    /**
     * Our own sheets must never be read back in: transforming our output would
     * feed on itself and grow without end.
     */
    function isOurSheet(sheet) {
      if (!sheet) return true;
      if (sheet.__darkrai) return true;        // a constructed sheet of ours
      var owner = sheet.ownerNode;
      if (owner && owner.nodeType === 1 && owner.hasAttribute && owner.hasAttribute(MARK)) return true;
      for (var i = 0; i < ourSheets.length; i++) if (ourSheets[i].sheet === sheet) return true;
      return false;
    }

    function queueSheet(sheet, ownerNode) {
      if (!sheet || isOurSheet(sheet) || processedSheets.has(sheet)) return;
      processedSheets.add(sheet);
      push(function () { processSheet(sheet, ownerNode || sheet.ownerNode || null); });
    }

    function processSheet(sheet, ownerNode) {
      if (!active) return;
      if (sheet.disabled) return;
      var rules = readRules(sheet);
      if (!rules) {                                   // cross-origin
        if (sheet.href) fetchSheet(sheet.href, ownerNode);
        return;
      }
      sheetRuleCounts.set(sheet, rules.length);
      collectRules(rules, null);
      varDirty = true;
      var css = emitRules(rules);
      if (css) {
        if (ownerNode && ownerNode.parentNode) insertAfter(ownerNode, 'override', css);
        else { var n = makeStyle('override'); setText(n, css); }
      }
    }

    /**
     * Sheets from another domain cannot be read here, so the background worker
     * fetches the text (no cookies, http(s) only, 5 MB cap, 10 s timeout) and we
     * parse it locally.
     */
    function fetchSheet(url, ownerNode) {
      if (!url || fetchedUrls.has(url)) return;
      if (!/^https?:/i.test(url)) return;
      fetchedUrls.add(url);
      requestSheet(url).then(function (text) {
        if (!active || !text) return;
        var cs;
        try { cs = new CSSStyleSheet({ baseURL: url }); cs.replaceSync(text); }
        catch (e) {
          try { cs = new CSSStyleSheet(); cs.replaceSync(text); } catch (e2) { return; }
        }
        var rules = readRules(cs);
        if (!rules) return;
        collectRules(rules, null);
        var css = emitRules(rules);
        if (css) {
          if (ownerNode && ownerNode.parentNode) insertAfter(ownerNode, 'override-xo', css);
          else { var n = makeStyle('override-xo'); setText(n, css); }
        }
        flushVars();
      }).catch(function () { });
    }

    // -------------------------------------------------- inline and attributes

    function idFor(el) {
      var id = el.getAttribute(IDATTR);
      if (id) return id;
      id = String(NS.ids.next());
      idCounter++;
      writing = true;
      try { el.setAttribute(IDATTR, id); } finally { writing = false; }
      touchedElements.add(el);
      return id;
    }

    function inlineDeclsFor(el) {
      var decls = '', style = el.style, i, prop, value, role, next;
      var needsRewrite = [];
      var ctx = style ? roleCtx(style) : null;
      if (style) {
        for (i = 0; i < style.length; i++) {
          prop = style[i];
          value = style.getPropertyValue(prop);
          if (prop.charAt(0) === '-' && prop.charAt(1) === '-') {
            if (!color.hasColor(value)) continue;
            var roles = varRoles.get(prop) || { bg: 1, fg: 1 };
            for (var rk in roles) {
              var tv = color.transformValue(value, rk, look);
              decls += roleVarName(rk, prop) + ':' + tv + ';';
            }
            continue;
          }
          role = color.roleForProperty(prop, ctx);
          if (!role) continue;
          next = transformDecl(prop, value, role);
          if (next == null) continue;
          if (style.getPropertyPriority(prop)) needsRewrite.push([prop, next]);
          else decls += prop + ':' + next + ' !important;';
        }
        var sh = pendingShorthands(style);
        for (i = 0; i < sh.length; i++) {
          role = color.roleForProperty(sh[i], ctx);
          if (!role) continue;
          next = transformDecl(sh[i], style.getPropertyValue(sh[i]), role);
          if (next == null) continue;
          if (style.getPropertyPriority(sh[i])) needsRewrite.push([sh[i], next]);
          else decls += sh[i] + ':' + next + ' !important;';
        }
      }
      // Legacy HTML colour attributes and SVG fill/stroke.
      for (var attr in ATTR_ROLE) {
        if (!el.hasAttribute || !el.hasAttribute(attr)) continue;
        var raw = (el.getAttribute(attr) || '').trim();
        if (!raw || raw === 'none' || raw.indexOf('url(') === 0 || raw === 'currentColor') continue;
        var map = ATTR_ROLE[attr];
        var tv2 = color.transformValue(raw, map[1], look);
        if (tv2 && tv2 !== raw) decls += map[0] + ':' + tv2 + ' !important;';
      }
      // An inline !important value can only be beaten by rewriting it in place.
      if (needsRewrite.length) {
        if (!inlineOriginals.has(el)) inlineOriginals.set(el, el.getAttribute('style'));
        writing = true;
        try {
          for (var k = 0; k < needsRewrite.length; k++) {
            el.style.setProperty(needsRewrite[k][0], needsRewrite[k][1], 'important');
          }
        } catch (e) { } finally { writing = false; }
      }
      return decls;
    }

    function processElement(el) {
      if (!el || el.nodeType !== 1) return;
      if (el.hasAttribute && el.hasAttribute(MARK)) return;
      var decls = inlineDeclsFor(el);
      if (!decls) return;
      var id = idFor(el);
      inlineRules.set(id, '[' + IDATTR + '="' + id + '"]{' + decls + '}');
      inlineDirty = true;
    }

    var INLINE_SELECTOR = '[style],[fill],[stroke],[bgcolor],[color],[text],[link],[vlink],[alink]';

    function processInlineIn(root) {
      var els;
      try { els = root.querySelectorAll(INLINE_SELECTOR); } catch (e) { return; }
      var i = 0;
      function chunk() {
        var start = now();
        while (i < els.length && (now() - start) < SLICE_MS) processElement(els[i++]);
        if (i < els.length) push(chunk);
        else flushInline();
      }
      chunk();
    }

    function flushInline() {
      if (!active || !inlineRules.size) return;
      var css = '';
      inlineRules.forEach(function (rule) { css += rule; });
      writeOwnSheet(inlineSheetRec, 'inline', css);
      inlineDirty = false;
    }

    // ----------------------------------------------------------- shadow DOM

    function processShadowRoot(root) {
      if (!root || shadowRoots.has(root)) return;
      shadowRoots.add(root);
      var css = baseCss();
      // Page sheets inside the shadow root.
      var sheets = root.styleSheets || [];
      for (var i = 0; i < sheets.length; i++) {
        if (isOurSheet(sheets[i])) continue;
        watchStyleText(sheets[i].ownerNode);
        var rules = readRules(sheets[i]);
        if (!rules) continue;
        collectRules(rules, null);
        css += emitRules(rules);
      }
      var adoptedList = root.adoptedStyleSheets || [];
      for (var j = 0; j < adoptedList.length; j++) {
        if (isOurSheet(adoptedList[j])) continue;
        var ar = readRules(adoptedList[j]);
        if (!ar) continue;
        collectRules(ar, null);
        css += emitRules(ar);
      }
      if (!adopt(root, css, 'shadow')) {
        try {
          var el = document.createElement('style');
          el.setAttribute(MARK, 'shadow');
          el.textContent = '@media screen{' + escapeForText(css) + '}';
          root.appendChild(el);
          nodes.push(el);
          T.count('styleNodes', 1);
        } catch (e) { }
      }
      processInlineIn(root);
      observeRoot(root);
      varDirty = true;
    }

    function sweepShadowRoots() {
      var all;
      try { all = document.querySelectorAll('*'); } catch (e) { return; }
      var limit = Math.min(all.length, SHADOW_SWEEP_BUDGET);
      for (var i = 0; i < limit; i++) {
        var el = all[i];
        if (el.shadowRoot && !shadowRoots.has(el.shadowRoot)) processShadowRoot(el.shadowRoot);
      }
    }

    // ------------------------------------------------------------- observers

    function isOurs(node) {
      return !!(node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute(MARK));
    }

    /**
     * A burst of mutation records is collected and handled once, in a single
     * microtask, instead of pushing a job per delivered batch: a page that
     * churns the DOM used to make us queue work as fast as it mutated.
     */
    var pendingEls = [];
    var pendingSheet = false;
    var pendingScheduled = false;

    function drainRecords() {
      pendingScheduled = false;
      if (!active) { pendingEls.length = 0; pendingSheet = false; return; }
      var sawSheet = pendingSheet;
      pendingSheet = false;
      var els = pendingEls.slice();
      pendingEls.length = 0;
      if (sawSheet) push(scanSheets);
      if (hostQueue.length) push(drainHostQueue);
      if (!els.length) return;
      push(function () {
        for (var k = 0; k < els.length; k++) {
          var el = els[k];
          if (!el || el.nodeType !== 1) continue;
          processElement(el);
          if (el.querySelectorAll) {
            var kids;
            try { kids = el.querySelectorAll(INLINE_SELECTOR); } catch (e) { kids = []; }
            for (var q = 0; q < kids.length && q < 500; q++) processElement(kids[q]);
          }
          if (el.shadowRoot) processShadowRoot(el.shadowRoot);
        }
        flushInline();
      });
    }

    function scheduleRecords() {
      if (pendingScheduled) return;
      pendingScheduled = true;
      if (typeof Promise === 'function') Promise.resolve().then(drainRecords);
      else setTimeout(drainRecords, 0);
    }

    /** Something on the page really changed: the upkeep tick goes back to 1s. */
    function noteChange() {
      tickDelay = TICK_MS;
      changedSinceSweep = true;
    }

    /**
     * The text of a page <style> element, watched one element at a time. The
     * document-wide observer used to carry characterData:true, which reports
     * every text node on the page; almost none of them are stylesheets.
     */
    var styleWatchers = 0;
    var STYLE_WATCH_MAX = 60;

    function watchStyleText(node) {
      if (!node || node.tagName !== 'STYLE' || isOurs(node)) return;
      if (node.__drTextWatched || styleWatchers >= STYLE_WATCH_MAX) return;
      try {
        var mo = new MutationObserver(function () {
          if (writing || !active) return;
          noteChange();
          pendingSheet = true;
          scheduleRecords();
        });
        mo.observe(node, { characterData: true, childList: true, subtree: true });
        observers.push(mo);
        node.__drTextWatched = true;
        styleWatchers++;
      } catch (e) { }
    }

    function queueHost(el) {
      if (!el || !el.shadowRoot) return;
      if (shadowRoots.has(el.shadowRoot)) return;
      hostQueue.push(el.shadowRoot);
    }

    function drainHostQueue() {
      var guard = 0;
      while (hostQueue.length && guard++ < 200) {
        var sr = hostQueue.shift();
        if (sr && !shadowRoots.has(sr)) processShadowRoot(sr);
      }
      if (hostQueue.length) push(drainHostQueue);
    }

    function observeRoot(root) {
      var target = root === document ? document.documentElement : root;
      if (!target) return;
      var mo = new MutationObserver(function (records) {
        if (writing || !active) return;
        var touched = false;
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === 'attributes') {
            if (isOurs(r.target)) continue;
            if (r.attributeName === IDATTR) continue;
            pendingEls.push(r.target);
            touched = true;
            continue;
          }
          var added = r.addedNodes || [];
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1 || isOurs(n)) continue;
            touched = true;
            if (n.tagName === 'STYLE' || n.tagName === 'LINK') {
              pendingSheet = true;
              if (n.tagName === 'STYLE') watchStyleText(n);
              continue;
            }
            pendingEls.push(n);
            queueHost(n);
            // A component usually attaches its root while it is being added,
            // so the hosts inside a new subtree are worth a bounded look.
            if (n.querySelectorAll) {
              var kids;
              try { kids = n.querySelectorAll('*'); } catch (e) { kids = []; }
              for (var q = 0; q < kids.length && q < 200; q++) {
                if (kids[q].shadowRoot) queueHost(kids[q]);
                else if (kids[q].tagName === 'STYLE') { pendingSheet = true; watchStyleText(kids[q]); }
              }
            }
          }
        }
        if (!touched) return;
        noteChange();
        scheduleRecords();
      });
      try {
        mo.observe(target, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ['style', 'fill', 'stroke', 'bgcolor', 'color', 'text', 'link', 'href', 'media', 'disabled']
        });
        observers.push(mo);
      } catch (e) { }
    }

    function scanSheets() {
      var sheets = document.styleSheets;
      for (var i = 0; i < sheets.length; i++) {
        queueSheet(sheets[i], sheets[i].ownerNode);
        watchStyleText(sheets[i].ownerNode);
      }
      var adoptedList = document.adoptedStyleSheets || [];
      for (var j = 0; j < adoptedList.length; j++) {
        var sheet = adoptedList[j];
        if (isOurSheet(sheet) || processedSheets.has(sheet)) continue;
        processedSheets.add(sheet);
        var rules = readRules(sheet);
        if (!rules) continue;
        collectRules(rules, null);
        sheetRuleCounts.set(sheet, rules.length);
        var css = emitRules(rules);
        if (css) adopt(document, css, 'override-adopted');
      }
      varDirty = true;
    }

    /**
     * CSS-in-JS calls insertRule directly, which no observer reports, so there
     * has to be a poll. It returns true when it actually found something, which
     * is what lets the caller back the poll off on a page that has gone quiet.
     */
    function tick() {
      if (!active || document.hidden) return false;
      var found = false;
      var sheets = document.styleSheets, i, rules;
      for (i = 0; i < sheets.length; i++) {
        var sheet = sheets[i];
        if (isOurSheet(sheet)) continue;
        rules = readRules(sheet);
        if (!rules) continue;
        var seen = sheetRuleCounts.get(sheet);
        if (seen === undefined) { queueSheet(sheet, sheet.ownerNode); found = true; continue; }
        if (seen !== rules.length) {
          sheetRuleCounts.set(sheet, rules.length);
          collectRules(rules, null);
          var css = emitRules(rules);
          if (css) {
            var node = sheet.ownerNode;
            if (node && node.parentNode) insertAfter(node, 'override-live', css);
            else { var n = makeStyle('override-live'); setText(n, css); }
          }
          varDirty = true;
          found = true;
        }
      }
      // Our adopted sheets are dropped when a page replaces the whole array.
      for (var k = 0; k < ourSheets.length; k++) {
        var rec = ourSheets[k];
        try {
          var list = rec.target.adoptedStyleSheets || [];
          if (list.indexOf(rec.sheet) < 0) {
            rec.target.adoptedStyleSheets = list.concat([rec.sheet]);
            found = true;
          }
        } catch (e) { }
      }
      if (hostQueue.length) { found = true; drainHostQueue(); }
      // attachShadow on an element that is already on the page produces no
      // mutation record at all, so a full sweep is still the only way to find
      // that root - but only after something actually changed. An idle page
      // walks nothing.
      if (changedSinceSweep) {
        changedSinceSweep = false;
        var before = shadowRoots.size;
        sweepShadowRoots();
        if (shadowRoots.size !== before) found = true;
      }
      if (varDirty) { flushVars(); found = true; }
      if (inlineDirty) { flushInline(); found = true; }
      return found;
    }

    function runTick() {
      tickTimer = null;
      if (!active) return;
      var found = false;
      try { found = tick(); } catch (e) { if (debug) console.warn('[Darkrai]', e); }
      tickDelay = found ? TICK_MS : Math.min(tickDelay * 2, TICK_MAX_MS);
      scheduleTick(tickDelay);
    }

    function scheduleTick(ms) {
      if (!active) return;
      if (tickTimer) { try { clearTimeout(tickTimer); } catch (e) { } }
      tickTimer = setTimeout(runTick, ms);
    }

    // -------------------------------------------------------- work scheduling

    function push(fn) {
      queue.push(fn);
      if (!pumping) pump();
    }

    /**
     * The readability guard must measure what we actually painted, so it waits
     * for the first pass over the page to finish.
     */
    function onSettled(callback) {
      if (settled) { try { callback(); } catch (e) { } return; }
      settledCallbacks.push(callback);
    }

    function markSettled() {
      if (settled) return;
      settled = true;
      T.mark('idle');
      var list = settledCallbacks.slice();
      settledCallbacks.length = 0;
      for (var i = 0; i < list.length; i++) { try { list[i](); } catch (e) { } }
    }

    function pump() {
      if (!active) { queue.length = 0; pumping = false; return; }
      pumping = true;
      var start = now();
      while (queue.length && (now() - start) < SLICE_MS) {
        var fn = queue.shift();
        try { fn(); } catch (e) { if (debug) console.warn('[Darkrai]', e); }
      }
      if (!queue.length) { pumping = false; return; }
      var next = function () { pump(); };
      if (document.hidden) setTimeout(next, 250);
      else if (typeof requestIdleCallback === 'function') requestIdleCallback(next, { timeout: 100 });
      else setTimeout(next, 0);
    }

    // ------------------------------------------------------------ public API

    function apply() {
      if (active) return;
      active = true;
      var base = makeStyle('base', document.head || document.documentElement, true);
      setText(base, baseCss());
      T.mark('first-paint');
      push(scanSheets);
      push(function () { processInlineIn(document); });
      push(function () { sweptOnce = true; changedSinceSweep = false; sweepShadowRoots(); });
      push(flushVars);
      push(function settle() {
        // Hold the signal back while the first pass is still queueing work.
        if (queue.length && settleTries++ < 500) { push(settle); return; }
        // One more bounded sweep, but only for the roots attached while the
        // first pass was running; from here on the observer feeds the host
        // queue and the upkeep tick sweeps only after a real change.
        if (changedSinceSweep) { changedSinceSweep = false; sweepShadowRoots(); }
        drainHostQueue();
        flushVars();
        flushInline();
        markSettled();
      });
      observeRoot(document);
      scheduleTick(TICK_MS);
      document.addEventListener('visibilitychange', onVisibility, true);
    }

    function onVisibility() {
      if (!document.hidden && active) {
        if (!pumping && queue.length) pump();
        tickDelay = TICK_MS;
        scheduleTick(0);
      }
    }

    function remove() {
      active = false;
      queue.length = 0;
      pumping = false;
      document.removeEventListener('visibilitychange', onVisibility, true);
      for (var i = 0; i < observers.length; i++) { try { observers[i].disconnect(); } catch (e) { } }
      observers = [];
      for (var j = 0; j < intervals.length; j++) { try { clearInterval(intervals[j]); } catch (e) { } }
      intervals = [];
      if (tickTimer) { try { clearTimeout(tickTimer); } catch (e) { } tickTimer = null; }
      writing = true;
      try {
        for (var k = 0; k < nodes.length; k++) {
          var n = nodes[k];
          if (n && n.parentNode) n.parentNode.removeChild(n);
        }
        nodes = [];
        for (var m = 0; m < ourSheets.length; m++) {
          var rec = ourSheets[m];
          try {
            var list = rec.target.adoptedStyleSheets || [];
            var idx = list.indexOf(rec.sheet);
            if (idx > -1) {
              var next = list.slice();
              next.splice(idx, 1);
              rec.target.adoptedStyleSheets = next;
            }
          } catch (e) { }
        }
        ourSheets = [];
        inlineOriginals.forEach(function (original, el) {
          try {
            if (original == null) el.removeAttribute('style');
            else el.setAttribute('style', original);
          } catch (e) { }
        });
        inlineOriginals.clear();
        touchedElements.forEach(function (el) {
          try { el.removeAttribute(IDATTR); } catch (e) { }
        });
        touchedElements.clear();
      } finally { writing = false; }
      inlineRules.clear();
      settledCallbacks.length = 0;
      settled = false;
      settleTries = 0;
      processedSheets = new Set();
      sheetRuleCounts = new Map();
      shadowRoots = new Set();
      varDecls = new Map();
      varRoles = new Map();
      varEdges = new Map();
      fetchedUrls = new Set();
      inlineSheetRec = { sheet: null, node: null };
      varSheetRec = { sheet: null, node: null };
      hostQueue.length = 0;
      sweptOnce = false;
      changedSinceSweep = false;
      styleWatchers = 0;
      pendingEls.length = 0;
      pendingSheet = false;
      pendingScheduled = false;
      tickDelay = TICK_MS;
    }

    /**
     * Turn our styles off for one synchronous measurement and back on in the
     * same task, so the page never paints without them.
     */
    var suspendState = null;
    function suspend() {
      if (suspendState) return;
      var disabled = [], removed = [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n) continue;
        try { if (!n.disabled) { n.disabled = true; disabled.push(n); } } catch (e) { }
      }
      for (var j = 0; j < ourSheets.length; j++) {
        var rec = ourSheets[j];
        try {
          var list = rec.target.adoptedStyleSheets || [];
          var idx = list.indexOf(rec.sheet);
          if (idx > -1) {
            var next = list.slice(); next.splice(idx, 1);
            rec.target.adoptedStyleSheets = next;
            removed.push(rec);
          }
        } catch (e) { }
      }
      suspendState = { disabled: disabled, removed: removed };
    }

    function resume() {
      if (!suspendState) return;
      for (var i = 0; i < suspendState.disabled.length; i++) {
        try { suspendState.disabled[i].disabled = false; } catch (e) { }
      }
      for (var j = 0; j < suspendState.removed.length; j++) {
        var rec = suspendState.removed[j];
        try {
          var list = rec.target.adoptedStyleSheets || [];
          if (list.indexOf(rec.sheet) < 0) rec.target.adoptedStyleSheets = list.concat([rec.sheet]);
        } catch (e) { }
      }
      suspendState = null;
    }

    function setLook(nextLook) {
      look = nextLook;
      color.clearCache();
      if (!active) return;
      remove();
      apply();
    }

    return {
      name: 'smart',
      apply: apply,
      remove: remove,
      suspend: suspend,
      resume: resume,
      setLook: setLook,
      onSettled: onSettled,
      refresh: function () { if (active) { push(scanSheets); push(function () { processInlineIn(document); }); } },
      isActive: function () { return active; },
      stats: function () {
        return { nodes: nodes.length, inline: inlineRules.size, vars: varDecls.size, queue: queue.length };
      }
    };
  }

  NS.engineSmart = {
    __v: 1,
    create: create,
    rewriteVarUses: rewriteVarUses,
    roleVarName: roleVarName,
    pendingShorthands: pendingShorthands,
    lostLonghands: lostLonghands,
    hasMask: hasMask,
    MARK: MARK,
    IDATTR: IDATTR
  };
  if (typeof module === 'object' && module && module.exports) module.exports = NS.engineSmart;
})();
