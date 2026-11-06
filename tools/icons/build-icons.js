/*
 * Darkrai - tools/icons/build-icons.js
 *
 * Produces the twelve toolbar icons in extension/icons/ from the two pixel
 * sprite grids in this folder, or from the older crescent SVGs, or from an
 * image you supply.
 *
 *   node tools\icons\build-icons.js
 *   node tools\icons\build-icons.js --svg
 *   node tools\icons\build-icons.js --from "C:\path\to\my-icon.png"
 *
 * Flags: --from <png|svg>   use this image instead of the sprite grids
 *        --svg              use the crescent marks, mark-large.svg and
 *                           mark-small.svg (needs a headless shell)
 *        --out <dir>        where to write (default extension\icons)
 *        --chrome <path>    a headless-shell binary, instead of discovery
 *        --sprites-only     only rebuild the popup's two pixel sprites (below)
 *
 * The popup's pixel sprites come from the editable grid text files in this
 * folder, darkrai-24.txt (the LCD) and darkrai-16.txt (the header avatar),
 * each carrying its own palette legend. They are written at 1x as
 * extension/popup/screen-art.png and avatar-art.png; the pages scale them by
 * whole numbers with image-rendering: pixelated. No browser is needed for
 * them, and every run of this file rebuilds them.
 *
 * By default the toolbar icons come from the same two grids, scaled by whole
 * numbers with nearest neighbour (see ICON_PLAN) after a rim one sprite pixel
 * wide is drawn round the drawing in a metallic mid-tone, so the mostly black
 * sprite keeps its outline on a dark toolbar as well as on a light one. No
 * browser is needed for that route either.
 *
 * Three states come out of one drawing, so they can never disagree:
 *   on-*      the artwork in full colour              - Darkrai is darkening the tab
 *   off-*     true Rec. 709 luma greyscale, dimmed    - off, Never, out of schedule, blocked
 *   native-*  the colour ghosted behind an opaque rim - the site's own dark theme, left alone
 *
 * OFF copies the ON alpha channel byte for byte. The dim is applied in RGB, not
 * in alpha, so tests/unit/icon-files.test.js can assert the two alpha channels
 * are identical -- which is the proof that OFF was derived and not redrawn.
 *
 * This file lives in tools/, outside extension/, so Chrome never loads it.
 * No dependencies, no build step, nothing downloaded: Node core plus whatever
 * chrome-headless-shell tests/browser/chrome.js already finds on the machine.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const png = require('./png.js');
const chrome = require('../../tests/browser/chrome.js');

const HERE = __dirname;
const PROJECT = path.resolve(HERE, '..', '..');
const DEFAULT_OUT = path.join(PROJECT, 'extension', 'icons');

const SIZES = [16, 32, 48, 128];
const SMALL_SIZES = [16, 32];

// Section 1.1 of the plan. The dim is the largest that keeps OFF above 3:1 on a
// near-black toolbar; 0.80 drops it under.
const OFF_DIM = 0.88;
const NATIVE_DESAT = 0.30;
const NATIVE_INTERIOR_ALPHA = 0.45;
const NATIVE_INSIDE_A = 96;
const NATIVE_RIM_A = 32;

const WHITE = [255, 255, 255];
const NEAR_BLACK = [27, 27, 27];
const MIN_CONTRAST = 3.0;

// The rim round the sprite icons: a cool metallic mid-tone (the design's muted
// silver accent) at about 3.8:1 on #FFFFFF and 4.6:1 on #1B1B1B. It keeps a
// little hue, so NATIVE's opaque rim still reads as colour, not as OFF.
const RIM = [0x7a, 0x84, 0x96];

// Which grid each toolbar size is drawn from, and the whole-number scale. The
// grid plus its one-cell rim is centred on the icon, so where the drawing
// reaches the grid's edge the rim is cropped by the icon's own edge.
const ICON_PLAN = {
  16: { grid: 'darkrai-16.txt', scale: 1 },
  32: { grid: 'darkrai-16.txt', scale: 2 },
  48: { grid: 'darkrai-24.txt', scale: 2 },
  128: { grid: 'darkrai-24.txt', scale: 5 }
};

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const out = { from: null, out: DEFAULT_OUT, chrome: null, spritesOnly: false, svg: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--from') { out.from = value; i++; }
    else if (flag === '--out') { out.out = path.resolve(value || ''); i++; }
    else if (flag === '--chrome') { out.chrome = value; i++; }
    else if (flag === '--sprites-only') { out.spritesOnly = true; }
    else if (flag === '--svg') { out.svg = true; }
    else throw new Error('unknown argument "' + flag + '". Flags: --from, --svg, --out, --chrome, --sprites-only');
  }
  return out;
}

// ------------------------------------------------------------ pixel sprites

const SPRITES = [
  { grid: 'darkrai-24.txt', out: path.join(PROJECT, 'extension', 'popup', 'screen-art.png') },
  { grid: 'darkrai-16.txt', out: path.join(PROJECT, 'extension', 'popup', 'avatar-art.png') }
];

/**
 * One grid file: '#' lines are comments, and the palette legend lives in them
 * as "#   <char>  #RRGGBB  ..." or "#   .  transparent". Every other non-empty
 * line is one row of the square grid, one character per pixel.
 */
function parseSprite(text, name) {
  const palette = {};
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (line[0] === '#') {
      const entry = /^#\s+(\S)\s+(#[0-9a-fA-F]{6}|transparent)\b/.exec(line);
      if (entry) {
        palette[entry[1]] = entry[2] === 'transparent' ? null : [
          parseInt(entry[2].slice(1, 3), 16),
          parseInt(entry[2].slice(3, 5), 16),
          parseInt(entry[2].slice(5, 7), 16)
        ];
      }
      continue;
    }
    rows.push(line);
  }
  const size = rows.length;
  if (!size) throw new Error(name + ': no grid rows');
  const rgba = Buffer.alloc(size * size * 4);
  rows.forEach(function (row, y) {
    if (row.length !== size) {
      throw new Error(name + ': row ' + (y + 1) + ' is ' + row.length + ' wide, the grid is ' +
        size + ' rows tall; it has to be square');
    }
    for (let x = 0; x < size; x++) {
      const ch = row[x];
      if (!(ch in palette)) throw new Error(name + ': "' + ch + '" at ' + x + ',' + y + ' is not in the palette');
      const c = palette[ch];
      if (!c) continue; // transparent stays (0,0,0,0)
      const i = (y * size + x) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  });
  return { size: size, rgba: rgba };
}

/**
 * One toolbar icon from a parsed grid: the grid padded by one cell, the rim
 * drawn on every transparent cell that touches ink on a side, then the whole
 * thing scaled by `scale` with nearest neighbour and centred on a size x size
 * canvas. Every edge stays on the sprite's own pixel grid.
 */
function spriteIcon(parsed, size, scale) {
  const n = parsed.size;
  const m = n + 2;
  const inkAt = function (x, y) {
    return x >= 0 && y >= 0 && x < n && y < n && parsed.rgba[(y * n + x) * 4 + 3] > 0;
  };
  const cells = Buffer.alloc(m * m * 4);
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const o = (y * m + x) * 4;
      const sx = x - 1;
      const sy = y - 1;
      if (inkAt(sx, sy)) {
        const i = (sy * n + sx) * 4;
        parsed.rgba.copy(cells, o, i, i + 4);
      } else if (inkAt(sx - 1, sy) || inkAt(sx + 1, sy) || inkAt(sx, sy - 1) || inkAt(sx, sy + 1)) {
        cells[o] = RIM[0]; cells[o + 1] = RIM[1]; cells[o + 2] = RIM[2]; cells[o + 3] = 255;
      }
    }
  }
  const out = Buffer.alloc(size * size * 4);
  const offset = Math.floor((size - m * scale) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor((x - offset) / scale);
      const cy = Math.floor((y - offset) / scale);
      if (cx < 0 || cy < 0 || cx >= m || cy >= m) continue;
      const from = (cy * m + cx) * 4;
      if (!cells[from + 3]) continue;
      cells.copy(out, (y * size + x) * 4, from, from + 4);
    }
  }
  return out;
}

/** Write each sprite PNG at 1x from its grid. Returns what was written. */
function buildSprites(say) {
  const written = [];
  for (const sprite of SPRITES) {
    const parsed = parseSprite(fs.readFileSync(path.join(HERE, sprite.grid), 'utf8'), sprite.grid);
    const buffer = png.encode(parsed.size, parsed.size, parsed.rgba);
    fs.writeFileSync(sprite.out, buffer);
    written.push(sprite);
    say('    ' + path.basename(sprite.out).padEnd(16) + String(buffer.length).padStart(6) +
      ' bytes   <- ' + sprite.grid + ' (' + parsed.size + 'x' + parsed.size + ')');
  }
  return written;
}

// ----------------------------------------------------------- SVG rasterising

function sizedSvg(svgText, size) {
  return svgText.replace(/<svg\b([^>]*?)(\/?)>/i, function (match, attrs, selfClose) {
    const cleaned = attrs.replace(/\s(width|height)\s*=\s*"[^"]*"/gi, '');
    return '<svg' + cleaned + ' width="' + size + '" height="' + size + '"' + selfClose + '>';
  });
}

function pageFor(svgText, size) {
  return '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'svg{display:block}</style></head><body>' + sizedSvg(svgText, size) + '</body></html>';
}

/**
 * One headless target, reused for every shot.
 * Returns null when there is no binary to use, so the caller can fall back.
 */
async function openRasteriser(executable) {
  if (!executable && !chrome.candidateBrowsers().length) return null;
  const session = await chrome.launch(executable ? { executable: executable } : {});
  if (!session) return null;

  let page = null;
  let targetId = null;
  try {
    const created = await session.browser.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      const list = await chrome.getJson(session.cdpPort, '/json/list');
      const hit = list.find(function (t) { return t.id === targetId && t.webSocketDebuggerUrl; });
      if (hit) wsUrl = hit.webSocketDebuggerUrl;
      else await chrome.delay(100);
    }
    if (!wsUrl) throw new Error('the headless shell never reported a debugger url');
    page = await chrome.connect(wsUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
  } catch (err) {
    if (page) page.close();
    await session.close();
    throw err;
  }

  return {
    executable: session.executable,
    async shoot(svgText, size) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: size, height: size, deviceScaleFactor: 1, mobile: false
      });
      // This is what makes the screenshot transparent rather than white.
      await page.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 0, g: 0, b: 0, a: 0 }
      });
      const tree = await page.send('Page.getFrameTree');
      await page.send('Page.setDocumentContent', {
        frameId: tree.frameTree.frame.id,
        html: pageFor(svgText, size)
      });
      await chrome.delay(120);
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false
      });
      const decoded = png.decode(Buffer.from(shot.data, 'base64'));
      if (decoded.width !== size || decoded.height !== size) {
        throw new Error('the shell returned ' + decoded.width + 'x' + decoded.height +
          ' for a ' + size + 'px shot');
      }
      return decoded.rgba;
    },
    async close() {
      if (page) page.close();
      await session.close();
    }
  };
}

// ----------------------------------------------------------- the transforms

/** True greyscale by Rec. 709 luma, dimmed in RGB. Alpha copied byte for byte. */
function toOff(rgba) {
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 0) continue; // stays (0,0,0,0)
    const y = Math.round(0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]);
    const g = Math.max(0, Math.min(255, Math.round(y * OFF_DIM)));
    out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = a;
  }
  return out;
}

/**
 * Ghosted: a fully opaque coloured rim one pixel wide, the interior dropped to
 * 45% alpha, the whole thing 30% desaturated. Solid versus see-through is a
 * silhouette-level difference, and it still has hue, so it is not OFF.
 *
 * The rim comes from eroding the alpha mask by exactly one pixel, which never
 * destroys a thin limb at any size.
 */
function toNative(rgba, width, height) {
  const out = Buffer.alloc(rgba.length);
  const alphaAt = function (x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return rgba[(y * width + x) * 4 + 3];
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3];
      if (a === 0) continue;
      const inside = a >= NATIVE_INSIDE_A &&
        alphaAt(x - 1, y) >= NATIVE_INSIDE_A && alphaAt(x + 1, y) >= NATIVE_INSIDE_A &&
        alphaAt(x, y - 1) >= NATIVE_INSIDE_A && alphaAt(x, y + 1) >= NATIVE_INSIDE_A;
      const rim = a >= NATIVE_RIM_A && !inside;
      const na = rim ? a : Math.round(a * NATIVE_INTERIOR_ALPHA);
      if (na === 0) continue;
      const y709 = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
      out[i] = Math.round(rgba[i] * (1 - NATIVE_DESAT) + y709 * NATIVE_DESAT);
      out[i + 1] = Math.round(rgba[i + 1] * (1 - NATIVE_DESAT) + y709 * NATIVE_DESAT);
      out[i + 2] = Math.round(rgba[i + 2] * (1 - NATIVE_DESAT) + y709 * NATIVE_DESAT);
      out[i + 3] = na;
    }
  }
  return out;
}

// -------------------------------------------------------------- measurements

function inkMass(rgba) {
  let mass = 0;
  for (let i = 3; i < rgba.length; i += 4) mass += rgba[i] / 255;
  return mass;
}

/** Alpha-weighted mean of (max-min)/255 over the ink. 0 is perfectly grey. */
function meanChroma(rgba) {
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 0) continue;
    const max = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
    const min = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
    sum += (a / 255) * (max - min) / 255;
    weight += a / 255;
  }
  return weight > 0 ? sum / weight : 0;
}

/** Just the alpha channel, so two states can be compared byte for byte. */
function alphaBytes(rgba) {
  const out = Buffer.alloc(rgba.length / 4);
  for (let i = 0, j = 3; j < rgba.length; i++, j += 4) out[i] = rgba[j];
  return out;
}

/** The largest R/G/B spread over any pixel with alpha. 0 or 1 is true greyscale. */
function worstSpread(rgba) {
  let worst = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const spread = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) -
      Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (spread > worst) worst = spread;
  }
  return worst;
}

/** What share of the ink mass reaches MIN_CONTRAST once composited over bg. */
function contrastShare(rgba, bg) {
  const over = png.compositeOver(rgba, bg);
  const bgLum = png.luminance(bg[0], bg[1], bg[2]);
  let total = 0;
  let good = 0;
  for (let i = 0, n = rgba.length / 4; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    if (a === 0) continue;
    total += a;
    const lum = png.luminance(over[i * 3], over[i * 3 + 1], over[i * 3 + 2]);
    if (png.contrast(lum, bgLum) >= MIN_CONTRAST) good += a;
  }
  return total > 0 ? good / total : 0;
}

// ---------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lines = [];
  const say = function (text) { lines.push(text); console.log(text); };

  say('Darkrai icon generator');

  // The popup's pixel sprites need no browser, so they come first and are
  // the whole run with --sprites-only.
  say('  sprites:');
  buildSprites(say);
  if (args.spritesOnly) {
    say('  done (--sprites-only: the toolbar icons were not touched)');
    return;
  }

  say('  out: ' + args.out);

  const custom = args.from ? path.resolve(args.from) : null;
  const customIsSvg = custom ? /\.svgz?$/i.test(custom) : false;
  if (custom && !fs.existsSync(custom)) throw new Error('--from: no such file: ' + custom);

  // ---- decide the route ----
  const useSprites = !custom && !args.svg;
  const needsBrowser = custom ? customIsSvg : !useSprites;
  let raster = null;
  if (needsBrowser) {
    raster = await openRasteriser(args.chrome).catch(function (err) {
      say('  the headless shell would not start: ' + err.message);
      return null;
    });
  }

  // An SVG can only be turned into pixels by the browser. Without one, the
  // run below would quietly fall through to the committed artwork and report
  // success, so the caller's file would be ignored without being told. Refuse
  // instead: a wrong icon that claims to be theirs is worse than no icon.
  if (custom && customIsSvg && !raster) {
    throw new Error(
      '--from ' + custom + ' is an SVG, and rasterising one needs a headless Chrome, ' +
      'which was not found. Point --chrome at a chrome-headless-shell or chrome binary, ' +
      'set DARKRAI_CHROME, or pass a PNG instead. Nothing was written.'
    );
  }

  let route;
  if (useSprites) route = 'pixel sprite grids, whole-number nearest-neighbour scaling (no browser needed)';
  else if (raster) route = 'CDP screenshots (' + raster.executable + ')';
  else if (custom) route = 'node:zlib only (PNG source, no browser needed)';
  else route = 'node:zlib fallback (no headless shell found, SVGs not re-rasterised)';
  say('  route: ' + route);

  try {
    // ---- gather one ON master per size ----
    const masters = {}; // size -> { rgba, source }

    if (useSprites) {
      const grids = {};
      for (const size of SIZES) {
        const plan = ICON_PLAN[size];
        if (!grids[plan.grid]) {
          grids[plan.grid] = parseSprite(fs.readFileSync(path.join(HERE, plan.grid), 'utf8'), plan.grid);
        }
        const grid = grids[plan.grid];
        masters[size] = {
          rgba: spriteIcon(grid, size, plan.scale),
          source: plan.grid + ' (' + grid.size + 'x' + grid.size + ') x' + plan.scale +
            ', rim one sprite pixel wide'
        };
      }
    } else if (custom && !customIsSvg) {
      const src = png.decode(fs.readFileSync(custom));
      say('  source: ' + custom + ' (' + src.width + 'x' + src.height + ', colour type ' +
        src.colorType + ')');
      for (const size of SIZES) {
        masters[size] = {
          rgba: png.resize(src.rgba, src.width, src.height, size, size),
          source: path.basename(custom) + ' resampled ' + src.width + 'x' + src.height +
            ' -> ' + size + 'x' + size
        };
      }
    } else if (raster) {
      const largePath = custom || path.join(HERE, 'mark-large.svg');
      const smallPath = custom || path.join(HERE, 'mark-small.svg');
      const largeSvg = fs.readFileSync(largePath, 'utf8');
      const smallSvg = fs.readFileSync(smallPath, 'utf8');
      for (const size of SIZES) {
        const useSmall = SMALL_SIZES.indexOf(size) !== -1 && !custom;
        const svg = useSmall ? smallSvg : largeSvg;
        const file = useSmall ? smallPath : largePath;
        masters[size] = {
          rgba: await raster.shoot(svg, size),
          source: path.basename(file) + ' rasterised at ' + size + 'x' + size
        };
      }
    } else {
      // No browser and no raster source: keep the committed ON artwork and
      // re-derive the other two states from it.
      for (const size of SIZES) {
        const file = path.join(args.out, 'on-' + size + '.png');
        const src = png.decode(fs.readFileSync(file));
        masters[size] = {
          rgba: src.width === size && src.height === size
            ? src.rgba
            : png.resize(src.rgba, src.width, src.height, size, size),
          source: 'on-' + size + '.png as committed (not re-rasterised)'
        };
      }
      say('  NOTE: the SVGs were not re-rasterised, so the ON artwork is unchanged from what');
      say('        was committed. OFF and NATIVE were re-derived from it.');
    }

    // ---- write the twelve ----
    fs.mkdirSync(args.out, { recursive: true });
    const written = [];
    const stats = {};

    for (const size of SIZES) {
      const on = masters[size].rgba;
      const off = toOff(on);
      const native = toNative(on, size, size);
      const set = { on: on, native: native, off: off };

      for (const state of ['on', 'native', 'off']) {
        const name = state + '-' + size + '.png';
        const buffer = png.encode(size, size, set[state]);
        fs.writeFileSync(path.join(args.out, name), buffer);
        written.push({ name: name, bytes: buffer.length, source: masters[size].source });
      }

      stats[size] = {
        onChroma: meanChroma(on),
        offSpread: worstSpread(off),
        nativeChroma: meanChroma(native),
        onMass: inkMass(on),
        nativeMass: inkMass(native),
        alphaMatch: alphaBytes(on).equals(alphaBytes(off))
      };
    }

    say('');
    say('  wrote ' + written.length + ' file(s):');
    written.forEach(function (f) {
      say('    ' + f.name.padEnd(14) + f.bytes.toString().padStart(6) + ' bytes   <- ' + f.source);
    });

    say('');
    say('  per size:');
    say('    size  ON mean chroma  OFF worst R/G/B spread  NATIVE chroma  NATIVE/ON ink mass  ON=OFF alpha');
    for (const size of SIZES) {
      const s = stats[size];
      say('    ' + String(size).padStart(4) + '  ' +
        s.onChroma.toFixed(3).padStart(14) + '  ' +
        String(s.offSpread).padStart(22) + '  ' +
        s.nativeChroma.toFixed(3).padStart(13) + '  ' +
        (s.nativeMass / s.onMass).toFixed(3).padStart(18) + '  ' +
        (s.alphaMatch ? 'yes' : 'NO').padStart(12));
    }

    say('');
    say('  16 px legibility - share of ink mass at ' + MIN_CONTRAST.toFixed(1) + ':1 or better:');
    for (const state of ['on', 'native', 'off']) {
      const decoded = png.decode(fs.readFileSync(path.join(args.out, state + '-16.png')));
      const onWhite = contrastShare(decoded.rgba, WHITE);
      const onBlack = contrastShare(decoded.rgba, NEAR_BLACK);
      say('    ' + (state + '-16.png').padEnd(14) +
        'on #FFFFFF ' + (onWhite * 100).toFixed(1).padStart(5) + '%   ' +
        'on #1B1B1B ' + (onBlack * 100).toFixed(1).padStart(5) + '%');
    }

    say('');
    const greyOk = SIZES.every(function (s) { return stats[s].offSpread <= 1; });
    const alphaOk = SIZES.every(function (s) { return stats[s].alphaMatch; });
    say('  OFF is true greyscale at every size: ' + (greyOk ? 'yes' : 'NO'));
    say('  OFF alpha equals ON alpha at every size: ' + (alphaOk ? 'yes' : 'NO'));
    say('  done');
    if (!greyOk || !alphaOk) process.exitCode = 1;
  } finally {
    if (raster) await raster.close();
  }
}

main().catch(function (err) {
  console.error('build-icons failed: ' + (err && err.stack || err));
  process.exitCode = 1;
});
