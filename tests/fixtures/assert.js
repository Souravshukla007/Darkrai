/*
 * Darkrai fixture assertions.
 *
 * Each fixture declares what it expects on <html>:
 *   data-dr-expect = "dark"   -> Darkrai must darken this page
 *                    "native" -> Darkrai must leave it alone
 *                    "simple" -> Darkrai must use the whole-page filter
 *   data-dr-settle = milliseconds to wait before measuring (default 1000)
 *
 * Results land in window.__DR_RESULTS__, a panel on the page, and
 * window.__DR_RESULTS_DONE__ for the headless runner.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var expect = root.getAttribute('data-dr-expect') || 'dark';
  var settle = Number(root.getAttribute('data-dr-settle') || 1000);
  var results = [];
  var PANEL_ID = 'dr-test-results';
  var SVG_TAGS = { SVG: 1, PATH: 1, CIRCLE: 1, RECT: 1, POLYGON: 1, POLYLINE: 1, LINE: 1, ELLIPSE: 1, G: 1 };

  function add(name, ok, detail) {
    results.push({ name: name, pass: !!ok, detail: detail || '' });
  }

  function skip(name, detail) {
    results.push({ name: name, pass: true, skipped: true, detail: detail || '' });
  }

  function describe(el) {
    var out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    else if (el.className && typeof el.className === 'string') out += '.' + el.className.trim().split(/\s+/)[0];
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return out + (text ? ' "' + text + '"' : '');
  }

  function lightnessOf(css) {
    var rgb = window.Darkrai.color.parse(css);
    return rgb ? window.Darkrai.color.srgbToOklch(rgb).l : null;
  }

  function ownStyleNodes() {
    return document.querySelectorAll('style[data-darkrai]');
  }

  /**
   * Darkrai also keeps rules in constructed stylesheets adopted on the
   * document and on shadow roots. Counting only <style data-darkrai> nodes
   * would let "Darkrai applied no styles at all" pass just because the styles
   * moved somewhere else.
   */
  function ownAdoptedSheets() {
    var n = 0;
    function countIn(root) {
      var list;
      try { list = root.adoptedStyleSheets || []; } catch (e) { return; }
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].__darkrai) n++;
    }
    countIn(document);
    var all;
    try { all = document.querySelectorAll('*'); } catch (e) { all = []; }
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) countIn(all[j].shadowRoot);
    }
    return n;
  }

  function contrastSweep() {
    var color = window.Darkrai.color;
    var ra = window.Darkrai.readability;
    var els = document.querySelectorAll('body *');
    var failures = [], checked = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest && el.closest('#' + PANEL_ID)) continue;
      if (el.hasAttribute && el.hasAttribute('data-darkrai')) continue;
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'BR' || tag === 'HR') continue;
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (!ra.isVisible(el, cs)) continue;

      var isIcon = false, raw = null;
      if (SVG_TAGS[tag] && el.ownerSVGElement !== undefined) {
        raw = cs.fill;
        isIcon = true;
        if (!raw || raw === 'none') continue;
      } else if (ra.hasOwnText(el)) {
        raw = cs.color;
      } else continue;

      var fg = color.parse(raw);
      if (!fg || fg.a < 0.05) continue;
      var bg = ra.effectiveBackground(el);
      if (!bg) continue;

      var required = color.requiredRatio({
        fontSizePx: parseFloat(cs.fontSize) || 16,
        bold: ra.isBold(cs),
        isIcon: isIcon
      });
      var ratio = color.contrastRatio(color.composite(fg, bg), bg);
      checked++;
      if (!color.passes(ratio, required)) {
        failures.push(describe(el) + ' ' + ratio.toFixed(2) + ':1 < ' + required + ':1');
      }
    }
    add('every visible text and icon meets its WCAG target',
      failures.length === 0,
      checked + ' measured' + (failures.length ? '; FAILED: ' + failures.join(' | ') : '; none below target'));
  }

  function run() {
    if (!window.Darkrai || !window.Darkrai.color) {
      add('Darkrai content scripts loaded', false, 'window.Darkrai is missing');
      return finish();
    }
    add('Darkrai content scripts loaded', true, '');

    var state = root.getAttribute('data-darkrai');
    var styles = ownStyleNodes();
    var adopted = ownAdoptedSheets();
    var tally = styles.length + ' style nodes, ' + adopted + ' adopted sheets';

    if (expect === 'native') {
      add('this site keeps its own dark theme', state === 'native', 'data-darkrai="' + state + '"');
      add('Darkrai applied no styles at all', styles.length === 0 && adopted === 0, tally);
    } else {
      add('the page is darkened', state === 'on', 'data-darkrai="' + state + '"');
      add('Darkrai applied styles', styles.length > 0 || adopted > 0, tally);
      if (expect === 'simple') {
        // Simple mode inverts at paint time, so the computed background colour
        // stays as the page set it. Check the filter instead.
        var rootFilter = getComputedStyle(root).filter;
        add('the whole page is inverted', /invert/.test(rootFilter), 'html filter = ' + rootFilter);
      } else {
        var rootL = lightnessOf(getComputedStyle(root).backgroundColor);
        add('the page background is dark',
          rootL != null && rootL < 0.45,
          'root background OKLCH L = ' + (rootL == null ? 'n/a' : rootL.toFixed(3)));
      }
    }

    if (expect === 'simple') {
      var filter = document.querySelector('style[data-darkrai="simple"]');
      if (location.protocol === 'file:') {
        skip('Simple mode is in use', 'needs an http origin for the per-site setting; serve the folder and reload');
      } else {
        add('Simple mode is in use', !!filter, filter ? 'filter style present' : 'no filter style found');
      }
    }

    if (expect === 'dark') contrastSweep();

    if (typeof window.__DR_EXTRA_CHECKS__ === 'function') {
      try { window.__DR_EXTRA_CHECKS__({ add: add, skip: skip, lightnessOf: lightnessOf }); }
      catch (e) { add('fixture-specific checks ran', false, String(e && e.message || e)); }
    }

    finish();
  }

  function finish() {
    window.__DR_RESULTS__ = results;
    window.__DR_RESULTS_DONE__ = true;
    paint();
  }

  function paint() {
    var failed = results.filter(function (r) { return !r.pass; }).length;
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('data-darkrai', 'test-panel');
    panel.setAttribute('style', [
      'position:fixed', 'right:8px', 'bottom:8px', 'z-index:2147483647',
      'max-width:380px', 'max-height:50vh', 'overflow:auto',
      'padding:10px 12px', 'border-radius:8px',
      'background:#101010', 'color:#f0f0f0',
      'font:12px/1.5 ui-monospace,Consolas,monospace',
      'box-shadow:0 2px 12px rgba(0,0,0,.5)', 'filter:none'
    ].join(';'));
    var html = '<strong style="color:' + (failed ? '#ff8a80' : '#9bffa0') + '">' +
      (failed ? failed + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED') +
      '</strong><br>expect=' + expect + '<br>';
    results.forEach(function (r) {
      var mark = r.skipped ? '~' : (r.pass ? 'PASS' : 'FAIL');
      var colour = r.skipped ? '#ffd27f' : (r.pass ? '#9bffa0' : '#ff8a80');
      html += '<div style="margin-top:4px"><span style="color:' + colour + '">' + mark + '</span> ' +
        r.name + (r.detail ? '<br><span style="opacity:.75">' + r.detail + '</span>' : '') + '</div>';
    });
    panel.innerHTML = html;
    (document.body || document.documentElement).appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(run, settle); });
  } else {
    setTimeout(run, settle);
  }
})();
