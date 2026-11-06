/*
 * Darkrai - shared/color.js
 * Colour parsing, OKLCH transform, role mapping, contrast maths.
 *
 * Loaded in four places, so it must stay dependency-free and must never touch
 * `document` or `chrome` at load time:
 *   - content scripts (plain script, exposes window.Darkrai.color)
 *   - background service worker (importScripts)
 *   - popup (script tag)
 *   - node --test (module.exports)
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  var ns = (root.Darkrai = root.Darkrai || {});
  ns.color = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- constants

  var LOOKS = {
    gray: { base: 0.21, top: 0.90 },
    black: { base: 0.00, top: 0.92 },
    soft: { base: 0.27, top: 0.82 }
  };

  // Roles. bg = background, fg = foreground/text, bd = border/divider.
  var BG_PROPS = {
    'background': 1, 'background-color': 1, 'background-image': 1,
    '-webkit-tap-highlight-color': 1, 'accent-color': 1
  };
  var FG_PROPS = {
    'color': 1, '-webkit-text-fill-color': 1, '-webkit-text-stroke-color': 1,
    'caret-color': 1, 'text-decoration-color': 1, 'text-decoration': 1,
    'text-emphasis-color': 1, 'fill': 1, 'stroke': 1, 'stop-color': 1,
    'flood-color': 1, 'lighting-color': 1
  };
  var BD_PROPS = {
    'border': 1, 'border-color': 1, 'border-top': 1, 'border-right': 1,
    'border-bottom': 1, 'border-left': 1, 'border-top-color': 1,
    'border-right-color': 1, 'border-bottom-color': 1, 'border-left-color': 1,
    'border-block': 1, 'border-inline': 1, 'border-block-color': 1,
    'border-inline-color': 1, 'border-block-start-color': 1,
    'border-block-end-color': 1, 'border-inline-start-color': 1,
    'border-inline-end-color': 1, 'outline': 1, 'outline-color': 1,
    'column-rule': 1, 'column-rule-color': 1, 'box-shadow': 1,
    'text-shadow': 1, 'border-image': 1, 'scrollbar-color': 1
  };

  // Keywords and system colours we never touch. `color-scheme: dark` makes
  // Chrome pick the site's own dark value for these, which is what we want.
  var LEAVE_ALONE = ('transparent currentcolor inherit initial unset revert revert-layer none auto ' +
    'accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext ' +
    'field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem ' +
    'selecteditemtext visitedtext activeborder activecaption appworkspace background buttonhighlight ' +
    'buttonshadow captiontext inactiveborder inactivecaption inactivecaptiontext infobackground ' +
    'infotext menu menutext scrollbar threeddarkshadow threedface threedhighlight ' +
    'threedlightshadow threedshadow window windowframe windowtext').split(' ')
    .reduce(function (m, k) { m[k] = 1; return m; }, {});

  var NAMED = (function () {
    var src = 'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff ' +
      'beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 ' +
      'brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 ' +
      'cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b ' +
      'darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b ' +
      'darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 ' +
      'darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f ' +
      'darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff ' +
      'dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 ' +
      'forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 ' +
      'goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 ' +
      'hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa ' +
      'lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 ' +
      'lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 ' +
      'lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa ' +
      'lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 ' +
      'limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa ' +
      'mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 ' +
      'mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 ' +
      'midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead ' +
      'navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 ' +
      'orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 ' +
      'papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 ' +
      'purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 ' +
      'saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee ' +
      'sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 ' +
      'snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 ' +
      'tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 ' +
      'yellow ffff00 yellowgreen 9acd32';
    var parts = src.split(/\s+/), map = {};
    for (var i = 0; i < parts.length - 1; i += 2) map[parts[i]] = parts[i + 1];
    return map;
  })();

  var COLOR_FNS = { rgb: 1, rgba: 1, hsl: 1, hsla: 1, hwb: 1, lab: 1, lch: 1, oklab: 1, oklch: 1, color: 1 };
  var RECURSE_FNS = {
    'color-mix': 1, 'linear-gradient': 1, 'radial-gradient': 1, 'conic-gradient': 1,
    'repeating-linear-gradient': 1, 'repeating-radial-gradient': 1, 'repeating-conic-gradient': 1,
    '-webkit-linear-gradient': 1, '-webkit-radial-gradient': 1, '-webkit-gradient': 1,
    'image-set': 1, '-webkit-image-set': 1, 'cross-fade': 1, 'drop-shadow': 1
  };
  // `light-dark()` resolves to the site's own dark value once color-scheme is
  // dark, so touching it would override a choice the site already made.
  var SKIP_FNS = { 'light-dark': 1, url: 1, 'var': 1, env: 1, attr: 1, counter: 1, counters: 1 };

  // ------------------------------------------------------------------- helpers

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function alphaOf(tok) {
    if (tok == null) return 1;
    tok = String(tok).trim();
    if (tok === '' || tok === 'none') return 1;
    if (tok.charAt(tok.length - 1) === '%') return clamp(parseFloat(tok) / 100, 0, 1);
    var v = parseFloat(tok);
    return isNaN(v) ? 1 : clamp(v, 0, 1);
  }

  function hueOf(tok) {
    if (tok == null) return 0;
    var s = String(tok).trim().toLowerCase();
    if (s === 'none') return 0;
    var v = parseFloat(s);
    if (isNaN(v)) return 0;
    if (s.indexOf('grad') > -1) v = v * 0.9;
    else if (s.indexOf('rad') > -1) v = v * 180 / Math.PI;
    else if (s.indexOf('turn') > -1) v = v * 360;
    return ((v % 360) + 360) % 360;
  }

  // Split a function argument list on commas and whitespace, honouring nesting
  // and the modern `/ alpha` syntax.
  function splitArgs(body) {
    var out = [], depth = 0, cur = '', i, ch;
    for (i = 0; i < body.length; i++) {
      ch = body.charAt(i);
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth === 0 && (ch === ',' || ch === '/' || /\s/.test(ch))) {
        if (ch === '/' ) { if (cur.trim()) out.push(cur.trim()); out.push('/'); cur = ''; continue; }
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  /**
   * Split a colour function body into channels plus alpha.
   * `channels` is how many channel values the function takes, so a trailing
   * value can be read as the legacy comma alpha. color() has no legacy form,
   * so it passes null and only the `/ alpha` syntax applies.
   */
  function argsAndAlpha(body, channels) {
    var toks = splitArgs(body), slash = toks.indexOf('/');
    var a = 1;
    if (slash > -1) { a = alphaOf(toks[slash + 1]); toks = toks.slice(0, slash); }
    else if (channels != null && toks.length === channels + 1) {
      a = alphaOf(toks[channels]);
      toks = toks.slice(0, channels);
    }
    return { args: toks, a: a };
  }

  // ------------------------------------------------------------------ parsing

  function hexToRgb(h) {
    var r, g, b, a = 1;
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h.charAt(0) + h.charAt(0), 16);
      g = parseInt(h.charAt(1) + h.charAt(1), 16);
      b = parseInt(h.charAt(2) + h.charAt(2), 16);
      if (h.length === 4) a = parseInt(h.charAt(3) + h.charAt(3), 16) / 255;
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    } else return null;
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return { r: r, g: g, b: b, a: a };
  }

  function hslToRgb(h, s, l, a) {
    h = ((h % 360) + 360) % 360 / 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    function f(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
    }
    return { r: r * 255, g: g * 255, b: b * 255, a: a };
  }

  function hwbToRgb(h, w, bl, a) {
    w = clamp(w, 0, 1); bl = clamp(bl, 0, 1);
    if (w + bl >= 1) { var g = w / (w + bl) * 255; return { r: g, g: g, b: g, a: a }; }
    var base = hslToRgb(h, 1, 0.5, 1);
    return {
      r: (base.r / 255 * (1 - w - bl) + w) * 255,
      g: (base.g / 255 * (1 - w - bl) + w) * 255,
      b: (base.b / 255 * (1 - w - bl) + w) * 255,
      a: a
    };
  }

  /** Parse any CSS colour we transform. Returns {r,g,b,a} (0-255, a 0-1) or null. */
  function parse(input) {
    if (input == null) return null;
    var s = String(input).trim();
    if (!s) return null;
    var lower = s.toLowerCase();
    if (LEAVE_ALONE[lower]) return null;
    if (s.charAt(0) === '#') return hexToRgb(s.slice(1));
    if (NAMED[lower]) return hexToRgb(NAMED[lower]);

    var m = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(s);
    if (!m) return null;
    var fn = m[1].toLowerCase();
    var aa = argsAndAlpha(m[2], fn === 'color' ? null : 3), args = aa.args, a = aa.a;

    if (fn === 'rgb' || fn === 'rgba') {
      var rv = args.map(function (t) {
        return t.charAt(t.length - 1) === '%' ? parseFloat(t) / 100 * 255 : parseFloat(t);
      });
      if (rv.length < 3 || rv.some(isNaN)) return null;
      return { r: rv[0], g: rv[1], b: rv[2], a: a };
    }
    if (fn === 'hsl' || fn === 'hsla') {
      if (args.length < 3) return null;
      return hslToRgb(hueOf(args[0]), parseFloat(args[1]) / 100, parseFloat(args[2]) / 100, a);
    }
    if (fn === 'hwb') {
      if (args.length < 3) return null;
      return hwbToRgb(hueOf(args[0]), parseFloat(args[1]) / 100, parseFloat(args[2]) / 100, a);
    }
    if (fn === 'oklch' || fn === 'lch') {
      if (args.length < 3) return null;
      var L = args[0].charAt(args[0].length - 1) === '%' ? parseFloat(args[0]) / 100 : parseFloat(args[0]);
      var C = parseFloat(args[1]);
      if (args[1].charAt(args[1].length - 1) === '%') C = parseFloat(args[1]) / 100 * (fn === 'oklch' ? 0.4 : 150);
      var H = hueOf(args[2]);
      if (fn === 'lch') return labToRgb(L, C * Math.cos(H * Math.PI / 180), C * Math.sin(H * Math.PI / 180), a);
      var rgb = oklchToSrgb({ l: L, c: C, h: H });
      rgb.a = a; return rgb;
    }
    if (fn === 'oklab' || fn === 'lab') {
      if (args.length < 3) return null;
      var Ll = args[0].charAt(args[0].length - 1) === '%' ? parseFloat(args[0]) / 100 : parseFloat(args[0]);
      var A = parseFloat(args[1]), B = parseFloat(args[2]);
      if (fn === 'lab') return labToRgb(Ll, A, B, a);
      var o = oklabToSrgb(Ll, A, B); o.a = a; return o;
    }
    if (fn === 'color') {
      // color(srgb r g b) / color(srgb-linear ...) / color(display-p3 ...)
      var space = (args[0] || '').toLowerCase(), c = args.slice(1).map(function (t) {
        return t.charAt(t.length - 1) === '%' ? parseFloat(t) / 100 : parseFloat(t);
      });
      if (c.length < 3 || c.some(isNaN)) return null;
      if (space === 'srgb') return { r: c[0] * 255, g: c[1] * 255, b: c[2] * 255, a: a };
      if (space === 'srgb-linear') {
        return { r: lin2srgb(c[0]) * 255, g: lin2srgb(c[1]) * 255, b: lin2srgb(c[2]) * 255, a: a };
      }
      if (space === 'display-p3' || space === 'rec2020' || space === 'a98-rgb' || space === 'prophoto-rgb') {
        // Close enough for theming: treat the encoded channels as sRGB.
        return { r: c[0] * 255, g: c[1] * 255, b: c[2] * 255, a: a };
      }
      return null;
    }
    return null;
  }

  // ----------------------------------------------------------- colour spaces

  function srgb2lin(v) { v = v / 1; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lin2srgb(v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }

  function srgbToOklab(rgb) {
    var r = srgb2lin(clamp(rgb.r, 0, 255) / 255),
      g = srgb2lin(clamp(rgb.g, 0, 255) / 255),
      b = srgb2lin(clamp(rgb.b, 0, 255) / 255);
    var l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
      m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
      s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    var l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return {
      L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    };
  }

  function oklabToLinear(L, a, b) {
    var l_ = L + 0.3963377774 * a + 0.2158037573 * b,
      m_ = L - 0.1055613458 * a - 0.0638541728 * b,
      s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return {
      r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    };
  }

  function oklabToSrgb(L, a, b) {
    var li = oklabToLinear(L, a, b);
    return {
      r: clamp(lin2srgb(li.r) * 255, 0, 255),
      g: clamp(lin2srgb(li.g) * 255, 0, 255),
      b: clamp(lin2srgb(li.b) * 255, 0, 255),
      a: 1
    };
  }

  function labToRgb(L, A, B, alpha) {
    // CIE Lab (D50-ish) -> sRGB. Only used to read lab()/lch() inputs.
    var fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
    function f(t) { var t3 = t * t * t; return t3 > 0.008856 ? t3 : (116 * t - 16) / 903.3; }
    var X = f(fx) * 0.96422, Y = (L > 8 ? Math.pow(fy, 3) : L / 903.3) * 1.0, Z = f(fz) * 0.82521;
    var r = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z,
      g = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z,
      bb = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
    return {
      r: clamp(lin2srgb(r) * 255, 0, 255),
      g: clamp(lin2srgb(g) * 255, 0, 255),
      b: clamp(lin2srgb(bb) * 255, 0, 255),
      a: alpha == null ? 1 : alpha
    };
  }

  function srgbToOklch(rgb) {
    var o = srgbToOklab(rgb);
    var c = Math.sqrt(o.a * o.a + o.b * o.b);
    var h = c < 1e-6 ? 0 : (Math.atan2(o.b, o.a) * 180 / Math.PI + 360) % 360;
    return { l: o.L, c: c, h: h };
  }

  function inGamut(li) {
    var e = 0.0001;
    return li.r >= -e && li.r <= 1 + e && li.g >= -e && li.g <= 1 + e && li.b >= -e && li.b <= 1 + e;
  }

  /** OKLCH -> sRGB, pulling out-of-range colours back by reducing chroma. */
  function oklchToSrgb(oklch) {
    var L = clamp(oklch.l, 0, 1), C = Math.max(0, oklch.c), H = oklch.h || 0;
    var rad = H * Math.PI / 180, lo = 0, hi = C, mid = C;
    var li = oklabToLinear(L, C * Math.cos(rad), C * Math.sin(rad));
    if (!inGamut(li)) {
      for (var i = 0; i < 18; i++) {
        mid = (lo + hi) / 2;
        li = oklabToLinear(L, mid * Math.cos(rad), mid * Math.sin(rad));
        if (inGamut(li)) lo = mid; else hi = mid;
      }
      li = oklabToLinear(L, lo * Math.cos(rad), lo * Math.sin(rad));
    }
    return {
      r: clamp(lin2srgb(clamp(li.r, 0, 1)) * 255, 0, 255),
      g: clamp(lin2srgb(clamp(li.g, 0, 1)) * 255, 0, 255),
      b: clamp(lin2srgb(clamp(li.b, 0, 1)) * 255, 0, 255),
      a: 1
    };
  }

  // -------------------------------------------------------------- the look

  function resolveLook(settings) {
    settings = settings || {};
    var preset = LOOKS[settings.look] || LOOKS.gray;
    var brightness = settings.brightness == null ? 100 : settings.brightness;
    var contrast = settings.contrast == null ? 100 : settings.contrast;
    var warmth = clamp(settings.warmth == null ? 0 : settings.warmth, 0, 100);
    var name = LOOKS[settings.look] ? settings.look : 'gray';
    if (brightness === 100 && contrast === 100) {
      // The common case: use the preset numbers exactly as the plan lists them.
      return { base: preset.base, top: preset.top, warmth: warmth, name: name };
    }
    var b = (brightness - 100) / 100;
    var c = contrast / 100;
    var base = preset.base + b * 0.15;
    var top = preset.top + b * 0.10;
    var mid = (base + top) / 2;
    base = mid - (mid - base) * c;
    top = mid + (top - mid) * c;
    return { base: clamp(base, 0, 0.6), top: clamp(top, 0.4, 1), warmth: warmth, name: name };
  }

  function lookKey(look) {
    return look.name + ':' + look.base.toFixed(3) + ':' + look.top.toFixed(3) + ':' + look.warmth;
  }

  /**
   * opts.masked: the declaration paints an element that has a CSS mask
   * (mask-image / -webkit-mask-image). Its background colour is then the
   * glyph of a mask icon - Wikimedia Codex draws every icon this way - so it
   * is a foreground colour: dark must become light, not stay dark.
   */
  function roleForProperty(prop, opts) {
    if (!prop) return null;
    var p = String(prop).toLowerCase().trim();
    if (p.charAt(0) === '-' && p.charAt(1) === '-') return null; // custom property: role comes from usage
    if (opts && opts.masked && (p === 'background-color' || p === 'background')) return 'fg';
    if (BG_PROPS[p]) return 'bg';
    if (FG_PROPS[p]) return 'fg';
    if (BD_PROPS[p]) return 'bd';
    if (/(^|-)border.*color$/.test(p)) return 'bd';
    if (/color$/.test(p)) return 'fg';
    return null;
  }

  /**
   * The transform from PLAN section 6.2. Lightness is 0..1 in OKLCH.
   */
  function transformOklch(src, role, look) {
    var l = src.l, c = src.c, h = src.h;
    if (role === 'bg') {
      if (l >= 0.5) { l = look.base + (1 - l) * 0.6; c = c * 0.8; }
      else { l = clamp(l, look.base, 0.5); }
    } else if (role === 'fg') {
      if (l < 0.6) { l = look.top - l * 0.35; }
      else { l = Math.min(l, look.top + 0.05); }
    } else { // bd: mapped into 0.30 - 0.55
      l = 0.55 - l * 0.25;
    }
    if (look.warmth > 0) {
      var amt = look.warmth / 100;
      if (c < 0.03) { h = 70; c = c + amt * 0.02; }
      else { c = c * (1 + amt * 0.05); }
    }
    return { l: clamp(l, 0, 1), c: Math.max(0, c), h: h };
  }

  function fmt(rgb, a) {
    var r = Math.round(clamp(rgb.r, 0, 255)), g = Math.round(clamp(rgb.g, 0, 255)), b = Math.round(clamp(rgb.b, 0, 255));
    if (a == null || a >= 0.999) return 'rgb(' + r + ', ' + g + ', ' + b + ')';
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + Math.round(a * 1000) / 1000 + ')';
  }

  // --------------------------------------------------------------- LRU cache

  var CACHE_MAX = 10000;
  var cache = new Map();
  // transformValue walks a whole declaration value, so the same value coming
  // back from a second rule costs the whole walk again; hasColor runs a regex
  // and a word scan over every declaration the engine looks at.
  var VALUE_CACHE_MAX = 4000;
  var valueCache = new Map();
  var HAS_COLOR_CACHE_MAX = 2000;
  var hasColorCache = new Map();

  function lruGet(map, key) {
    if (!map.has(key)) return undefined;
    var v = map.get(key);
    map.delete(key); map.set(key, v); // refresh recency
    return v;
  }
  function lruSet(map, key, val, max) {
    if (map.size >= max) {
      var oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    map.set(key, val);
    return val;
  }

  function cacheGet(key) { return lruGet(cache, key); }
  function cacheSet(key, val) { return lruSet(cache, key, val, CACHE_MAX); }
  function clearCache() { cache.clear(); valueCache.clear(); hasColorCache.clear(); }

  /** Transform one colour string for a role. Returns null when untouched. */
  function transformColor(input, role, look) {
    if (!role) return null;
    look = look && look.base != null ? look : resolveLook(look);
    var key = role + '|' + lookKey(look) + '|' + input;
    var hit = cacheGet(key);
    if (hit !== undefined) return hit;
    var rgb = parse(input);
    if (!rgb) return cacheSet(key, null);
    var out = oklchToSrgb(transformOklch(srgbToOklch(rgb), role, look));
    return cacheSet(key, fmt(out, rgb.a));
  }

  // ----------------------------------------------------- CSS value scanning

  function isIdentChar(ch) { return /[-a-zA-Z0-9_\u00a0-\uffff\\]/.test(ch); }

  /**
   * Walk a declaration value and transform every colour token inside it.
   * Recurses into color-mix() and gradients; skips url(), var(), light-dark().
   */
  function transformValue(value, role, look) {
    if (value == null) return value;
    var s = String(value);
    if (!s || !role) return s;
    if (s.indexOf('(') < 0 && s.indexOf('#') < 0 && !/[a-z]/i.test(s)) return s;
    look = look && look.base != null ? look : resolveLook(look);
    var key = role + '|' + lookKey(look) + '|' + s;
    var hit = lruGet(valueCache, key);
    if (hit !== undefined) return hit;
    return lruSet(valueCache, key, walkValue(s, role, look), VALUE_CACHE_MAX);
  }

  function walkValue(s, role, look) {
    var out = '', i = 0, n = s.length;
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === '"' || ch === "'") { // string literal: copy verbatim
        var q = ch; out += ch; i++;
        while (i < n) { out += s.charAt(i); if (s.charAt(i) === q && s.charAt(i - 1) !== '\\') { i++; break; } i++; }
        continue;
      }
      if (ch === '#') {
        var j = i + 1;
        while (j < n && /[0-9a-fA-F]/.test(s.charAt(j))) j++;
        var hex = s.slice(i, j);
        var t = transformColor(hex, role, look);
        out += (t || hex); i = j; continue;
      }
      if (/[a-zA-Z-]/.test(ch)) {
        var k = i;
        while (k < n && isIdentChar(s.charAt(k))) k++;
        var ident = s.slice(i, k), lowerIdent = ident.toLowerCase();
        if (s.charAt(k) === '(') {
          // find matching close paren
          var depth = 0, e = k;
          for (; e < n; e++) {
            if (s.charAt(e) === '(') depth++;
            else if (s.charAt(e) === ')') { depth--; if (depth === 0) { e++; break; } }
          }
          var whole = s.slice(i, e), body = s.slice(k + 1, e - 1);
          if (SKIP_FNS[lowerIdent]) { out += whole; }
          else if (COLOR_FNS[lowerIdent]) {
            var tc = transformColor(whole, role, look);
            out += (tc || whole);
          } else if (RECURSE_FNS[lowerIdent]) {
            out += ident + '(' + transformValue(body, role, look) + ')';
          } else {
            out += ident + '(' + transformValue(body, role, look) + ')';
          }
          i = e; continue;
        }
        if (NAMED[lowerIdent] && !LEAVE_ALONE[lowerIdent]) {
          var tn = transformColor(lowerIdent, role, look);
          out += (tn || ident);
        } else out += ident;
        i = k; continue;
      }
      out += ch; i++;
    }
    return out;
  }

  /** True when a declaration value contains something we would recolour. */
  function hasColor(value) {
    if (value == null) return false;
    var s = String(value);
    var hit = lruGet(hasColorCache, s);
    if (hit !== undefined) return hit;
    return lruSet(hasColorCache, s, scanForColor(s), HAS_COLOR_CACHE_MAX);
  }

  function scanForColor(s) {
    if (s.indexOf('#') > -1) return true;
    if (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/i.test(s)) return true;
    var m = s.toLowerCase().match(/[a-z][a-z0-9-]*/g);
    if (m) for (var i = 0; i < m.length; i++) if (NAMED[m[i]] && !LEAVE_ALONE[m[i]]) return true;
    return false;
  }

  // ------------------------------------------------------------- contrast

  function relativeLuminance(rgb) {
    var r = srgb2lin(clamp(rgb.r, 0, 255) / 255),
      g = srgb2lin(clamp(rgb.g, 0, 255) / 255),
      b = srgb2lin(clamp(rgb.b, 0, 255) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(a, b) {
    var la = relativeLuminance(a), lb = relativeLuminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** WCAG: 3:1 for large text and icons, 4.5:1 for everything else. */
  function isLargeText(fontSizePx, bold) {
    var size = parseFloat(fontSizePx) || 0;
    return size >= 24 || (!!bold && size >= 18.66);
  }

  function requiredRatio(opts) {
    opts = opts || {};
    if (opts.isIcon) return 3;
    return isLargeText(opts.fontSizePx, opts.bold) ? 3 : 4.5;
  }

  function passes(ratio, required) { return ratio >= required - 0.001; }

  /** Composite a (possibly translucent) colour over an opaque backdrop. */
  function composite(fg, bg) {
    var a = fg.a == null ? 1 : clamp(fg.a, 0, 1);
    if (a >= 0.999) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: 1
    };
  }

  function compositeStack(layers) {
    // layers: top-most first. Returns an opaque colour; white if nothing opaque.
    var out = null;
    for (var i = layers.length - 1; i >= 0; i--) {
      var l = layers[i];
      if (!l) continue;
      if (out == null) { out = composite(l, { r: 255, g: 255, b: 255, a: 1 }); continue; }
      out = composite(l, out);
    }
    return out || { r: 255, g: 255, b: 255, a: 1 };
  }

  /**
   * Nudge lightness (hue kept) until the colour clears `required` against bg.
   * Searches toward whichever end gives more contrast. Returns the new colour
   * plus the ratio reached, or changed:false when it already passed.
   */
  function fixForContrast(fg, bg, required, look) {
    var bgOpaque = bg.a == null || bg.a >= 0.999 ? bg : composite(bg, { r: 255, g: 255, b: 255, a: 1 });
    var alpha = fg.a == null ? 1 : fg.a;
    var flat = composite(fg, bgOpaque);
    var start = contrastRatio(flat, bgOpaque);
    if (passes(start, required)) return { rgb: { r: fg.r, g: fg.g, b: fg.b, a: alpha }, ratio: start, changed: false };

    var src = srgbToOklch(fg);
    var bgL = srgbToOklch(bgOpaque).l;
    var up = bgL < 0.5; // lighter text on dark backdrop, darker on light

    function at(l) {
      var c = oklchToSrgb({ l: l, c: src.c, h: src.h });
      c.a = alpha;
      return { rgb: c, ratio: contrastRatio(composite(c, bgOpaque), bgOpaque) };
    }
    var edge = at(up ? 1 : 0);
    if (!passes(edge.ratio, required)) {
      var other = at(up ? 0 : 1);
      if (other.ratio > edge.ratio) { up = !up; edge = other; }
    }
    if (!passes(edge.ratio, required)) {
      // Cannot be reached with this hue: take the best end, drop chroma a bit.
      var desat = oklchToSrgb({ l: up ? 1 : 0, c: src.c * 0.5, h: src.h });
      desat.a = alpha;
      var dr = contrastRatio(composite(desat, bgOpaque), bgOpaque);
      if (dr > edge.ratio) return { rgb: desat, ratio: dr, changed: true };
      return { rgb: edge.rgb, ratio: edge.ratio, changed: true };
    }
    // Binary search for the smallest change that still passes.
    var lo = src.l, hi = up ? 1 : 0, best = edge;
    for (var i = 0; i < 18; i++) {
      var mid = (lo + hi) / 2, r = at(mid);
      if (passes(r.ratio, required)) { best = r; hi = mid; }
      else lo = mid;
    }
    return { rgb: best.rgb, ratio: best.ratio, changed: true };
  }

  function toCss(rgb) { return fmt(rgb, rgb.a); }

  return {
    LOOKS: LOOKS,
    NAMED: NAMED,
    LEAVE_ALONE: LEAVE_ALONE,
    parse: parse,
    srgbToOklch: srgbToOklch,
    oklchToSrgb: oklchToSrgb,
    srgbToOklab: srgbToOklab,
    resolveLook: resolveLook,
    roleForProperty: roleForProperty,
    transformOklch: transformOklch,
    transformColor: transformColor,
    transformValue: transformValue,
    hasColor: hasColor,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    isLargeText: isLargeText,
    requiredRatio: requiredRatio,
    passes: passes,
    composite: composite,
    compositeStack: compositeStack,
    fixForContrast: fixForContrast,
    toCss: toCss,
    clamp: clamp,
    clearCache: clearCache,
    cacheSize: function () { return cache.size; },
    cacheSizes: function () {
      return { color: cache.size, value: valueCache.size, hasColor: hasColorCache.size };
    }
  };
});
