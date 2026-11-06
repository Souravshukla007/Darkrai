/*
 * Darkrai - shared/timing.js
 * Dev-only measurement (PLAN section 6.9: "Timings are logged only when the
 * debug flag is on").
 *
 * Completely inert until enable(true) is called, which only happens when the
 * top-level `debug` flag in storage is true. Every entry point leaves on a
 * single boolean test when it is off: no allocation, no performance.now().
 *
 * Loaded first of all the content scripts and safe to inject repeatedly.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  var ns = (root.Darkrai = root.Darkrai || {});
  ns.timing = api;
  // The perf runner reads this one global over the DevTools protocol.
  try { root.__darkraiTiming = api.report; } catch (e) { }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The names the rest of the extension marks. Kept here so a typo in one
  // caller cannot silently invent a mark nobody reads.
  var MARKS = {
    STORE_READ: 'store-read-done',
    DECISION: 'decision-done',
    APPLY_START: 'apply-start',
    FIRST_PAINT: 'first-paint',
    IDLE: 'idle'
  };

  var COUNTS = {
    STYLE_NODES: 'styleNodes',
    ADOPTED_SHEETS: 'adoptedSheets',
    GUARD_MEASURED: 'guardMeasured',
    FORCED_READS: 'forcedReads'
  };

  var on = false;
  var marks = null;          // name -> ms since the time origin
  var counts = null;         // key -> number
  var dirty = false;         // this task has already written to the DOM
  var scheduled = false;

  function now() {
    return (typeof performance === 'object' && performance && performance.now)
      ? performance.now() : Date.now();
  }

  function soon(fn) {
    if (typeof queueMicrotask === 'function') { queueMicrotask(fn); return; }
    if (typeof Promise === 'function') { Promise.resolve().then(fn); return; }
    setTimeout(fn, 0);
  }

  /** Turn measurement on. Anything falsy leaves the module inert. */
  function enable(flag) {
    if (!flag) { if (on) disable(); return false; }
    if (on) return true;
    on = true;
    marks = {};
    counts = {};
    dirty = false;
    scheduled = false;
    marks.enabled = now();
    return true;
  }

  function disable() {
    on = false;
    marks = null;
    counts = null;
    dirty = false;
    scheduled = false;
  }

  function isEnabled() { return on; }

  /** Record the first time something happened. Later calls are ignored. */
  function mark(name) {
    if (!on) return;
    if (!name || marks[name] !== undefined) return;
    marks[name] = now();
  }

  /** Milliseconds between two marks, or null when either was never reached. */
  function measure(from, to) {
    if (!on) return null;
    var a = marks[from], b = marks[to];
    if (a === undefined || b === undefined) return null;
    return b - a;
  }

  function count(key, n) {
    if (!on) return;
    if (!key) return;
    var add = n === undefined ? 1 : Number(n);
    if (!isFinite(add)) return;
    counts[key] = (counts[key] || 0) + add;
  }

  // ------------------------------------------- the read-after-write proxy
  //
  // A PROXY, not Chrome's own forced-recalc count: it counts the times we read
  // computed style or geometry in a task in which we have already written, the
  // shape that makes the browser recalculate on the spot. Chrome's real
  // RecalcStyleCount comes from the Performance domain in the perf runner.

  function clearDirty() { dirty = false; scheduled = false; }

  /** Darkrai has just written to the DOM in this task. */
  function noteWrite() {
    if (!on) return;
    dirty = true;
    if (scheduled) return;
    scheduled = true;
    soon(clearDirty);
  }

  /** Darkrai is about to read layout or computed style. Returns true when forced. */
  function noteRead() {
    if (!on) return false;
    if (!dirty) return false;
    counts[COUNTS.FORCED_READS] = (counts[COUNTS.FORCED_READS] || 0) + 1;
    return true;
  }

  /**
   * Wrap a reader so every call goes through noteRead() first. The wrapper's
   * hot path is the same single boolean test.
   */
  function wrapRead(fn) {
    if (typeof fn !== 'function') return fn;
    return function () {
      if (on && dirty) {
        counts[COUNTS.FORCED_READS] = (counts[COUNTS.FORCED_READS] || 0) + 1;
      }
      return fn.apply(this, arguments);
    };
  }

  var ZERO_REPORT = {
    enabled: false,
    decisionMs: 0,
    firstPaintMs: 0,
    idleMs: 0,
    styleNodes: 0,
    adoptedSheets: 0,
    guardMeasured: 0,
    forcedReads: 0,
    marks: {}
  };

  function at(name) {
    var v = marks[name];
    return v === undefined ? null : v;
  }

  /**
   * The whole picture. A null means "never happened here", which the perf
   * runner turns into an explicit { unmeasurable: reason } rather than a zero.
   */
  function report() {
    if (!on) {
      return {
        enabled: false,
        decisionMs: ZERO_REPORT.decisionMs,
        firstPaintMs: ZERO_REPORT.firstPaintMs,
        idleMs: ZERO_REPORT.idleMs,
        styleNodes: ZERO_REPORT.styleNodes,
        adoptedSheets: ZERO_REPORT.adoptedSheets,
        guardMeasured: ZERO_REPORT.guardMeasured,
        forcedReads: ZERO_REPORT.forcedReads,
        marks: {}
      };
    }
    var copy = {};
    for (var k in marks) if (Object.prototype.hasOwnProperty.call(marks, k)) copy[k] = marks[k];
    return {
      enabled: true,
      decisionMs: at(MARKS.DECISION),
      firstPaintMs: at(MARKS.FIRST_PAINT),
      idleMs: at(MARKS.IDLE),
      styleNodes: counts[COUNTS.STYLE_NODES] || 0,
      adoptedSheets: counts[COUNTS.ADOPTED_SHEETS] || 0,
      guardMeasured: counts[COUNTS.GUARD_MEASURED] || 0,
      forcedReads: counts[COUNTS.FORCED_READS] || 0,
      marks: copy
    };
  }

  return {
    __v: 1,
    MARKS: MARKS,
    COUNTS: COUNTS,
    enable: enable,
    disable: disable,
    isEnabled: isEnabled,
    mark: mark,
    measure: measure,
    count: count,
    noteWrite: noteWrite,
    noteRead: noteRead,
    wrapRead: wrapRead,
    report: report
  };
});
