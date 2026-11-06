/*
 * Darkrai - tools/icons/png.js
 *
 * A minimal PNG codec over node:zlib. No dependencies, nothing downloaded.
 *
 * It exists because the icon generator and the icon unit test both need to see
 * real pixels, and they must agree about what those pixels are -- so there is
 * one codec here rather than two that can drift apart.
 *
 * This file lives in tools/, outside extension/, so Chrome never loads it.
 *
 *   decode(buffer)                      -> { width, height, rgba, colorType, depth, interlace }
 *   encode(width, height, rgba)         -> Buffer   (RGBA8, filter 0, one IDAT)
 *   resize(rgba, srcW, srcH, dstW, dstH)-> Buffer   (alpha-premultiplied resample)
 *   luminance(r, g, b)                  -> relative luminance, WCAG
 *   contrast(l1, l2)                    -> contrast ratio
 *   compositeOver(rgba, bg)             -> Buffer   (RGB over an opaque colour)
 */
'use strict';

const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

// ------------------------------------------------------------------- CRC32

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  CRC_TABLE = table;
  return table;
}

function crc32(buf) {
  const table = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ------------------------------------------------------------------- decode

function unfilter(type, line, cur, prev, bpp) {
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const raw = line[i];
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = (prev && i >= bpp) ? prev[i - bpp] : 0;
    let value;
    switch (type) {
      case 0: value = raw; break;
      case 1: value = raw + a; break;
      case 2: value = raw + b; break;
      case 3: value = raw + ((a + b) >> 1); break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        value = raw + pred;
        break;
      }
      default: throw new Error('unknown PNG filter type ' + type);
    }
    cur[i] = value & 0xff;
  }
}

function decode(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG: the 8-byte signature does not match');
  }

  let header = null;
  const idat = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        compression: data[10],
        filterMethod: data[11],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!header) throw new Error('not a PNG: no IHDR chunk');
  if (!idat.length) throw new Error('not a PNG: no IDAT chunk');
  if (header.depth !== 8 || !CHANNELS[header.colorType] || header.interlace !== 0) {
    throw new Error('unsupported PNG: colour type ' + header.colorType + ', bit depth ' +
      header.depth + ', interlace ' + header.interlace +
      '. Re-save it as a non-interlaced 8-bit RGBA PNG.');
  }

  const { width, height, colorType } = header;
  const bpp = CHANNELS[colorType];
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) {
    throw new Error('truncated PNG: expected ' + (height * (stride + 1)) +
      ' filtered bytes, got ' + raw.length);
  }

  const flat = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = flat.subarray(y * stride, (y + 1) * stride);
    const prev = y ? flat.subarray((y - 1) * stride, y * stride) : null;
    unfilter(filterType, line, cur, prev, bpp);
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * bpp;
    const d = i * 4;
    if (colorType === 6) {
      rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = flat[s + 3];
    } else if (colorType === 2) {
      rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = 255;
    } else if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = 255;
    } else { // 4: grey + alpha
      rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = flat[s + 1];
    }
  }

  return {
    width: width,
    height: height,
    rgba: rgba,
    colorType: colorType,
    depth: header.depth,
    interlace: header.interlace
  };
}

// ------------------------------------------------------------------- encode

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encode(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error('encode: expected ' + (width * height * 4) + ' RGBA bytes, got ' + rgba.length);
  }
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter 0 on every scanline
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // non-interlaced
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ------------------------------------------------------------------- resize

/**
 * Resample RGBA. Area-average when shrinking, bilinear when growing.
 *
 * Alpha is premultiplied before resampling and divided back out after.
 * Resampling straight RGBA blends the colour of fully transparent pixels into
 * the edge and haloes the mark; this is the one place where that bites.
 */
function resize(rgba, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return Buffer.from(rgba);

  const pre = new Float64Array(srcW * srcH * 4);
  for (let i = 0, n = srcW * srcH; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    pre[i * 4] = rgba[i * 4] * a;
    pre[i * 4 + 1] = rgba[i * 4 + 1] * a;
    pre[i * 4 + 2] = rgba[i * 4 + 2] * a;
    pre[i * 4 + 3] = rgba[i * 4 + 3];
  }

  const out = Buffer.alloc(dstW * dstH * 4);
  const shrinking = dstW <= srcW && dstH <= srcH;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      if (shrinking) {
        const x0 = x * srcW / dstW;
        const x1 = (x + 1) * srcW / dstW;
        const y0 = y * srcH / dstH;
        const y1 = (y + 1) * srcH / dstH;
        let weight = 0;
        for (let sy = Math.floor(y0); sy < Math.min(srcH, Math.ceil(y1)); sy++) {
          const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
          if (wy <= 0) continue;
          for (let sx = Math.floor(x0); sx < Math.min(srcW, Math.ceil(x1)); sx++) {
            const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
            if (wx <= 0) continue;
            const w = wx * wy;
            const s = (sy * srcW + sx) * 4;
            r += pre[s] * w; g += pre[s + 1] * w; b += pre[s + 2] * w; a += pre[s + 3] * w;
            weight += w;
          }
        }
        if (weight > 0) { r /= weight; g /= weight; b /= weight; a /= weight; }
      } else {
        const fx = Math.min(srcW - 1, Math.max(0, (x + 0.5) * srcW / dstW - 0.5));
        const fy = Math.min(srcH - 1, Math.max(0, (y + 0.5) * srcH / dstH - 0.5));
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(srcW - 1, x0 + 1), y1 = Math.min(srcH - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        for (const [sx, sy, w] of [
          [x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)],
          [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]
        ]) {
          if (w <= 0) continue;
          const s = (sy * srcW + sx) * 4;
          r += pre[s] * w; g += pre[s + 1] * w; b += pre[s + 2] * w; a += pre[s + 3] * w;
        }
      }

      const d = (y * dstW + x) * 4;
      const alpha = Math.max(0, Math.min(255, Math.round(a)));
      if (alpha === 0) continue; // leave it (0,0,0,0)
      const scale = 255 / a;
      out[d] = Math.max(0, Math.min(255, Math.round(r * scale)));
      out[d + 1] = Math.max(0, Math.min(255, Math.round(g * scale)));
      out[d + 2] = Math.max(0, Math.min(255, Math.round(b * scale)));
      out[d + 3] = alpha;
    }
  }
  return out;
}

// -------------------------------------------------------------- colour maths

function channelLuminance(byte) {
  const c = byte / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an opaque sRGB colour. */
function luminance(r, g, b) {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two relative luminances. */
function contrast(l1, l2) {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite straight RGBA over an opaque [r,g,b] background. Returns RGB triples. */
function compositeOver(rgba, bg) {
  const out = Buffer.alloc((rgba.length / 4) * 3);
  for (let i = 0, n = rgba.length / 4; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    out[i * 3] = Math.round(rgba[i * 4] * a + bg[0] * (1 - a));
    out[i * 3 + 1] = Math.round(rgba[i * 4 + 1] * a + bg[1] * (1 - a));
    out[i * 3 + 2] = Math.round(rgba[i * 4 + 2] * a + bg[2] * (1 - a));
  }
  return out;
}

module.exports = {
  SIGNATURE,
  crc32,
  decode,
  encode,
  resize,
  luminance,
  contrast,
  compositeOver
};
