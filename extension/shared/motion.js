/*
 * Darkrai - shared/motion.js
 *
 * The one piece of the liquid-glass look that is logic rather than CSS:
 * "should motion run right now?" and "is this surface glass or solid?".
 *
 * The stylesheets keep their own media queries - this module never writes a
 * style. It is what popup.js and options.js consult before they set
 * will-change, start the drifting backdrop or run an entrance stagger, so
 * that decision is in one testable place instead of three.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  var ns = (root.Darkrai = root.Darkrai || {});
  ns.motion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /** Never throws, and answers false where there is no matchMedia at all. */
  function media(query) {
    try {
      if (typeof root.matchMedia !== 'function') return false;
      var m = root.matchMedia(query);
      return !!(m && m.matches);
    } catch (e) { return false; }
  }

  function reduced() { return media('(prefers-reduced-motion: reduce)'); }
  function forcedColors() { return media('(forced-colors: active)'); }
  function highContrast() { return media('(prefers-contrast: more)'); }

  function hidden() {
    try { return !!(root.document && root.document.hidden); } catch (e) { return false; }
  }

  /** What the four inputs are right now, read from the environment. */
  function state() {
    return {
      reducedMotion: reduced(),
      forcedColors: forcedColors(),
      highContrast: highContrast(),
      hidden: hidden()
    };
  }

  /**
   * Motion runs unless the reader asked for less of it, the OS has taken the
   * palette over, or the surface is not on screen at all.
   *
   * prefers-contrast: more is deliberately NOT in this list: it asks for a
   * readable surface, not a still one. It is surfaceMode() that it changes.
   */
  function shouldAnimate(opts) {
    var o = opts || {};
    if (o.reducedMotion) return false;
    if (o.forcedColors) return false;
    if (o.hidden) return false;
    return true;
  }

  /** 'glass' (translucent, blurred) or 'solid' (opaque, real borders). */
  function surfaceMode(opts) {
    var o = opts || {};
    return (o.forcedColors || o.highContrast) ? 'solid' : 'glass';
  }

  /** The two questions above, asked about the environment as it is. */
  function animate() { return shouldAnimate(state()); }
  function surface() { return surfaceMode(state()); }

  return {
    shouldAnimate: shouldAnimate,
    surfaceMode: surfaceMode,
    reduced: reduced,
    forcedColors: forcedColors,
    highContrast: highContrast,
    hidden: hidden,
    state: state,
    animate: animate,
    surface: surface
  };
});
