/*
 * Darkrai - content/engine-simple.js
 * Simple mode: the whole-page filter fallback (PLAN section 6.6).
 *
 * For apps that draw their text on a canvas, where recolouring cannot reach.
 * Media is re-inverted so photos and video still look normal.
 */
(function () {
  'use strict';
  var NS = (window.Darkrai = window.Darkrai || {});
  // Always redefine: see the note in detect.js.

  var MARK = 'data-darkrai';

  // Canvas re-inversion is right almost everywhere, but these editors draw the
  // document itself on a canvas: re-inverting it would undo the dark mode.
  var NO_CANVAS_REINVERT = {
    'docs.google.com': 1,
    'sheets.google.com': 1,
    'slides.google.com': 1
  };

  function presetFor(host) {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    return { reinvertCanvas: !NO_CANVAS_REINVERT[host] };
  }

  function create(opts) {
    opts = opts || {};
    var host = opts.host || (location && location.hostname) || '';
    var preset = presetFor(host);
    var settings = opts.settings || {};
    var node = null;
    var active = false;

    function css() {
      var mediaSel = 'img,video,picture,iframe,embed,object,svg[data-dr-media]';
      if (preset.reinvertCanvas) mediaSel += ',canvas';
      var out = 'html{filter:invert(0.9) hue-rotate(180deg) !important;background-color:#fff !important;}' +
        mediaSel + '{filter:invert(1) hue-rotate(180deg) !important;}' +
        '[style*="background-image"]{filter:invert(1) hue-rotate(180deg);}' +
        '[style*="background-image"] > *{filter:invert(1) hue-rotate(180deg);}';
      if (settings.dimImages) out += 'img,video,picture{filter:invert(1) hue-rotate(180deg) brightness(0.85) !important;}';
      return out;
    }

    function apply() {
      if (active) return;
      // A filter on the top document already covers every frame inside it.
      if (window.top !== window) { active = true; return; }
      active = true;
      node = document.createElement('style');
      node.setAttribute(MARK, 'simple');
      node.textContent = '@media screen{' + css() + '}';
      (document.head || document.documentElement).appendChild(node);
    }

    function remove() {
      active = false;
      if (node && node.parentNode) node.parentNode.removeChild(node);
      node = null;
    }

    function suspend() { if (node) { try { node.disabled = true; } catch (e) { } } }
    function resume() { if (node) { try { node.disabled = false; } catch (e) { } } }

    return {
      name: 'simple',
      apply: apply,
      remove: remove,
      suspend: suspend,
      resume: resume,
      setLook: function () { },
      onSettled: function (callback) { try { callback(); } catch (e) { } },
      refresh: function () { },
      isActive: function () { return active; },
      stats: function () { return { preset: preset }; }
    };
  }

  NS.engineSimple = { __v: 1, create: create, presetFor: presetFor, NO_CANVAS_REINVERT: NO_CANVAS_REINVERT };
})();
