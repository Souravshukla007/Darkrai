/*
 * Darkrai - tests/browser/dom-contract.js
 *
 * The popup / options DOM contract, the first functional oracle for a
 * presentation-only redesign (UI family (j), the behaviour replay, is the
 * second). dom-contract.before.json beside it was recorded before the Pokedex
 * redesigns.
 *
 *   node browser/dom-contract.js snapshot <out.json>
 *   node browser/dom-contract.js compare browser/dom-contract.before.json <out.json>
 *
 * snapshot: every id, name, for, role, aria-*, type, tabindex, data-*, value
 * (on inputs/options), checked, hidden, disabled attribute in popup.html and
 * options.html, plus every getElementById / getElementsByName / querySelector
 * target and every addEventListener binding in popup.js and options.js.
 * compare: every item of before must still exist in after with the same
 * values. Additions are allowed. Known, deliberate difference since the
 * Lovable port: #lcd-art src "screen-art.png" -> "art/lcd-darkrai.png".
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.resolve(__dirname, '..', '..', 'extension');
const HTML = ['popup/popup.html', 'options/options.html'];
const JS = ['popup/popup.js', 'options/options.js'];
const KEEP = /^(id|name|for|role|type|tabindex|value|checked|hidden|disabled|href|src|min|max|step|aria-.+|data-.+)$/i;

function attrsOf(text) {
  const out = {};
  const re = /([:\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase();
    const value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : ''));
    out[name] = value;
  }
  return out;
}

function htmlItems(file) {
  let src = fs.readFileSync(path.join(EXT, file), 'utf8');
  src = src.replace(/<!--[\s\S]*?-->/g, '');
  const items = [];
  const re = /<([a-zA-Z][\w-]*)(\s[^>]*)?>/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1].toLowerCase();
    const all = attrsOf(m[2] || '');
    const kept = {};
    Object.keys(all).forEach((k) => { if (KEEP.test(k)) kept[k] = all[k]; });
    // Decorative sprite symbols and presentation-only SVG pieces are not
    // part of the functional contract.
    if (tag === 'symbol' || tag === 'use' || tag === 'path' || tag === 'circle' || tag === 'rect') continue;
    if (!Object.keys(kept).length) continue;
    if (tag === 'svg' || tag === 'img') {
      // only record ids on art/svg, everything else on them is decoration
      if (!kept.id) continue;
    }
    let key;
    if (kept.id) key = '#' + kept.id;
    else if (tag === 'option') key = 'option[value=' + kept.value + ']@' + items.filter((i) => i.tag === 'select').slice(-1).map((i) => i.key)[0];
    else if (kept.for) key = tag + '[for=' + kept.for + ']';
    else if (kept.name) key = tag + '[name=' + kept.name + '][value=' + (kept.value || '') + ']';
    else key = tag + JSON.stringify(kept);
    items.push({ key, tag, attrs: kept });
  }
  return items;
}

function jsItems(file) {
  const src = fs.readFileSync(path.join(EXT, file), 'utf8');
  const out = { ids: [], names: [], selectors: [], bindings: [] };
  let m;
  const ids = /getElementById\(\s*'([^']+)'\s*\)/g;
  while ((m = ids.exec(src))) out.ids.push(m[1]);
  const idsDq = /getElementById\(\s*"([^"]+)"\s*\)/g;
  while ((m = idsDq.exec(src))) out.ids.push(m[1]);
  const names = /getElementsByName\(\s*'([^']+)'\s*\)/g;
  while ((m = names.exec(src))) out.names.push(m[1]);
  const sels = /querySelector(?:All)?\(\s*'([^']+)'\s*\)/g;
  while ((m = sels.exec(src))) out.selectors.push(m[1]);
  const binds = /([\w.\[\]]+)\.addEventListener\(\s*'([^']+)'/g;
  while ((m = binds.exec(src))) out.bindings.push(m[1] + ' -> ' + m[2]);
  for (const k of Object.keys(out)) out[k] = Array.from(new Set(out[k])).sort();
  return out;
}

function snapshot() {
  const out = { html: {}, js: {} };
  for (const f of HTML) out.html[f] = htmlItems(f);
  for (const f of JS) out.js[f] = jsItems(f);
  return out;
}

function compare(before, after) {
  const problems = [];
  let checked = 0;
  for (const f of Object.keys(before.html)) {
    const map = new Map((after.html[f] || []).map((i) => [i.key, i]));
    for (const item of before.html[f]) {
      checked++;
      const now = map.get(item.key);
      if (!now) { problems.push(f + ': ' + item.key + ' is gone'); continue; }
      if (now.tag !== item.tag) problems.push(f + ': ' + item.key + ' changed tag ' + item.tag + ' -> ' + now.tag);
      for (const [k, v] of Object.entries(item.attrs)) {
        if (!(k in now.attrs)) problems.push(f + ': ' + item.key + ' lost ' + k + '="' + v + '"');
        else if (now.attrs[k] !== v) problems.push(f + ': ' + item.key + ' ' + k + ' "' + v + '" -> "' + now.attrs[k] + '"');
      }
    }
  }
  for (const f of Object.keys(before.js)) {
    for (const kind of Object.keys(before.js[f])) {
      const have = new Set((after.js[f] || {})[kind] || []);
      for (const v of before.js[f][kind]) {
        checked++;
        if (!have.has(v)) problems.push(f + ': ' + kind + ' ' + v + ' is gone');
      }
    }
  }
  return { checked, problems };
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'snapshot') {
  fs.writeFileSync(a, JSON.stringify(snapshot(), null, 2));
  const s = JSON.parse(fs.readFileSync(a, 'utf8'));
  console.log('wrote ' + a + ': ' + Object.values(s.html).reduce((n, l) => n + l.length, 0) + ' html items');
} else if (cmd === 'compare') {
  const r = compare(JSON.parse(fs.readFileSync(a, 'utf8')), JSON.parse(fs.readFileSync(b, 'utf8')));
  console.log(r.checked + ' contract items checked, ' + r.problems.length + ' problem(s)');
  for (const p of r.problems) console.log('  ' + p);
  process.exitCode = r.problems.length ? 1 : 0;
} else {
  console.log('usage: node browser/dom-contract.js snapshot <out> | compare <before> <after>');
}
