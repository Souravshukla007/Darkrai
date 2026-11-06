/*
 * Darkrai - shared/settings.js
 * Storage schema (PLAN section 5), safe upgrades, site matching, schedule.
 * No chrome.* calls at load time; the read/write helpers are optional extras.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  var ns = (root.Darkrai = root.Darkrai || {});
  ns.settings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 2;
  var MODES = { auto: 1, on: 1, off: 1 };
  var LOOKS = { gray: 1, black: 1, soft: 1 };
  var ENGINES = { smart: 1, filter: 1 };
  var SCHEDULES = { always: 1, system: 1, hours: 1 };

  function defaults() {
    return {
      schema: SCHEMA,
      // Schema 2 added this: dev-only timing, off for everybody by default.
      debug: false,
      settings: {
        enabled: true,
        defaultMode: 'auto',
        look: 'gray',
        brightness: 100,
        contrast: 100,
        warmth: 0,
        dimImages: false,
        schedule: { type: 'always', from: '19:00', to: '07:00' }
      },
      sites: {
        // Canvas-drawn editors cannot be recoloured; Simple mode is the preset.
        'docs.google.com': { mode: 'on', engine: 'filter' }
      }
    };
  }

  // Multi-part public suffixes we must not treat as a registrable domain.
  var MULTI_SUFFIX = ('co.uk org.uk ac.uk gov.uk me.uk net.uk sch.uk com.au net.au org.au edu.au ' +
    'gov.au co.nz net.nz org.nz co.jp or.jp ne.jp ac.jp go.jp com.br net.br org.br com.cn net.cn ' +
    'org.cn gov.cn com.mx com.ar com.tr com.sg com.hk com.tw co.in net.in org.in co.za co.kr ' +
    'com.pl com.ua co.il com.my com.ph com.vn com.sa com.eg').split(' ')
    .reduce(function (m, k) { m[k] = 1; return m; }, {});

  function clampInt(v, lo, hi, dflt) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    return n < lo ? lo : n > hi ? hi : n;
  }

  function isTime(s) { return typeof s === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s); }

  function normalizeSiteEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var mode = MODES[raw.mode] ? raw.mode : 'auto';
    var out = { mode: mode };
    if (ENGINES[raw.engine]) out.engine = raw.engine;
    if (Array.isArray(raw.fixes)) {
      var fixes = [];
      for (var i = 0; i < raw.fixes.length && fixes.length < 200; i++) {
        var f = raw.fixes[i];
        if (f && typeof f.selector === 'string' && f.selector &&
          (f.action === 'invert' || f.action === 'readable')) {
          fixes.push({ selector: f.selector, action: f.action });
        }
      }
      if (fixes.length) out.fixes = fixes;
    }
    return out;
  }

  /**
   * Accept anything from storage (missing, partial, from an older build or
   * corrupted) and return a valid, complete store. Never throws.
   */
  function upgrade(raw) {
    var d = defaults();
    if (!raw || typeof raw !== 'object') return d;

    // Unknown future schema: keep what we understand rather than wiping it.
    var s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    var out = d;
    // We rebuild from the defaults, so a top-level flag has to be carried over
    // by hand or a schema-1 store would lose it.
    out.debug = raw.debug === true;
    out.settings.enabled = s.enabled === undefined ? true : !!s.enabled;
    out.settings.defaultMode = MODES[s.defaultMode] ? s.defaultMode : 'auto';
    out.settings.look = LOOKS[s.look] ? s.look : 'gray';
    out.settings.brightness = clampInt(s.brightness, 50, 150, 100);
    out.settings.contrast = clampInt(s.contrast, 50, 150, 100);
    out.settings.warmth = clampInt(s.warmth, 0, 100, 0);
    out.settings.dimImages = !!s.dimImages;

    var sch = s.schedule && typeof s.schedule === 'object' ? s.schedule : {};
    out.settings.schedule = {
      type: SCHEDULES[sch.type] ? sch.type : 'always',
      from: isTime(sch.from) ? sch.from : '19:00',
      to: isTime(sch.to) ? sch.to : '07:00'
    };

    // Pre-schema builds stored the site list at the top level as `siteList`.
    var rawSites = raw.sites && typeof raw.sites === 'object' ? raw.sites
      : (raw.siteList && typeof raw.siteList === 'object' ? raw.siteList : null);
    if (rawSites) {
      var sites = {};
      var keys = Object.keys(rawSites);
      for (var i = 0; i < keys.length; i++) {
        var key = String(keys[i]).toLowerCase().replace(/^www\./, '').trim();
        if (!key || key.length > 255) continue;
        var entry = rawSites[keys[i]];
        // A bare string mode was the old shape: { "a.com": "off" }
        if (typeof entry === 'string') entry = { mode: entry };
        var norm = normalizeSiteEntry(entry);
        if (norm) sites[key] = norm;
      }
      // Keep the Docs preset unless the user has an entry for it already.
      if (!sites['docs.google.com']) sites['docs.google.com'] = d.sites['docs.google.com'];
      out.sites = sites;
    }
    out.schema = SCHEMA;
    return out;
  }

  function hostFromUrl(url) {
    if (!url) return '';
    try {
      var u = new URL(url);
      return (u.hostname || '').toLowerCase().replace(/^www\./, '');
    } catch (e) {
      var m = /^[a-z-]+:\/\/([^\/:?#]+)/i.exec(String(url));
      return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
    }
  }

  /** The key we write when the user makes a choice: the registrable domain. */
  function baseDomain(host) {
    if (!host) return '';
    host = String(host).toLowerCase().replace(/^www\./, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.indexOf('.') < 0) return host;
    var parts = host.split('.');
    if (parts.length <= 2) return host;
    var lastTwo = parts.slice(-2).join('.');
    if (MULTI_SUFFIX[lastTwo]) return parts.slice(-3).join('.');
    return lastTwo;
  }

  /**
   * Find the stored entry for a host. A subdomain inherits its parent unless it
   * has an entry of its own: music.youtube.com follows youtube.com.
   * Returns { key, entry } or null.
   */
  function matchSite(sites, host) {
    if (!sites || !host) return null;
    host = String(host).toLowerCase().replace(/^www\./, '');
    if (sites[host]) return { key: host, entry: sites[host] };
    var parts = host.split('.');
    for (var i = 1; i < parts.length - 1; i++) {
      var candidate = parts.slice(i).join('.');
      if (MULTI_SUFFIX[candidate]) break;       // never match a public suffix
      if (parts.length - i < 2) break;
      if (sites[candidate]) return { key: candidate, entry: sites[candidate] };
    }
    return null;
  }

  /** auto | on | off for this host, falling back to the global default. */
  function resolveMode(store, host) {
    var s = store && store.settings ? store.settings : defaults().settings;
    var hit = matchSite(store && store.sites, host);
    if (hit && MODES[hit.entry.mode]) return hit.entry.mode;
    return MODES[s.defaultMode] ? s.defaultMode : 'auto';
  }

  /** smart | filter for this host. */
  function resolveEngine(store, host) {
    var hit = matchSite(store && store.sites, host);
    if (hit && ENGINES[hit.entry.engine]) return hit.entry.engine;
    return 'smart';
  }

  function resolveFixes(store, host) {
    var hit = matchSite(store && store.sites, host);
    return (hit && hit.entry.fixes) || [];
  }

  function minutesOf(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /**
   * Is the dark theme in force right now?
   * always  -> yes
   * system  -> yes when the OS/Chrome theme is dark (caller supplies it)
   * hours   -> yes between from and to, handling the wrap past midnight
   */
  function scheduleActive(schedule, now, systemDark) {
    var sch = schedule && typeof schedule === 'object' ? schedule : { type: 'always' };
    if (sch.type === 'system') return !!systemDark;
    if (sch.type !== 'hours') return true;
    var from = minutesOf(sch.from), to = minutesOf(sch.to);
    if (from == null || to == null) return true;
    var d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    var cur = d.getHours() * 60 + d.getMinutes();
    if (from === to) return true;
    if (from < to) return cur >= from && cur < to;
    return cur >= from || cur < to;         // wraps past midnight
  }

  /** The next minute-of-day at which scheduleActive() would flip. */
  function nextScheduleChange(schedule, now) {
    var sch = schedule && typeof schedule === 'object' ? schedule : { type: 'always' };
    if (sch.type !== 'hours') return null;
    var from = minutesOf(sch.from), to = minutesOf(sch.to);
    if (from == null || to == null || from === to) return null;
    var d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    var cur = d.getHours() * 60 + d.getMinutes();
    var next = [from, to].filter(function (m) { return m > cur; }).sort(function (a, b) { return a - b; })[0];
    var at = new Date(d.getTime());
    at.setSeconds(0, 0);
    if (next == null) { at.setDate(at.getDate() + 1); next = Math.min(from, to); }
    at.setHours(Math.floor(next / 60), next % 60, 0, 0);
    return at.getTime();
  }

  /** Should a page be darkened? Returns 'dark' | 'skip' | 'detect'. */
  function decideForPage(store, host, opts) {
    opts = opts || {};
    var s = (store && store.settings) || defaults().settings;
    if (!s.enabled) return 'skip';
    if (!scheduleActive(s.schedule, opts.now, opts.systemDark)) return 'skip';
    var mode = resolveMode(store, host);
    if (mode === 'off') return 'skip';
    if (mode === 'on') return 'dark';
    return 'detect';
  }

  function setSiteMode(store, host, mode) {
    var out = upgrade(store);
    var key = baseDomain(host);
    if (!key) return out;
    var existing = out.sites[key] || (matchSite(out.sites, host) || {}).entry;
    var entry = normalizeSiteEntry(existing) || { mode: 'auto' };
    if (!MODES[mode]) mode = 'auto';
    entry.mode = mode;
    // A host-specific entry wins; write at the registrable domain so that
    // subdomains inherit the choice.
    out.sites[key] = entry;
    if (out.sites[host] && host !== key) out.sites[host].mode = mode;
    return out;
  }

  function setSiteEngine(store, host, engine) {
    var out = upgrade(store);
    var key = baseDomain(host);
    if (!key) return out;
    // Engine is usually host-specific (docs.google.com, not google.com).
    var target = out.sites[host] ? host : (out.sites[key] ? key : host);
    var entry = normalizeSiteEntry(out.sites[target]) || { mode: resolveMode(out, host) };
    if (ENGINES[engine]) entry.engine = engine; else delete entry.engine;
    out.sites[target] = entry;
    return out;
  }

  /** Which entry a per-site change should be written to. */
  function targetKey(store, host) {
    var key = baseDomain(host);
    if (!key) return '';
    // A host-specific entry that already exists keeps the change local to it
    // (docs.google.com, not google.com).
    return store.sites[host] ? host : key;
  }

  /**
   * Remember one picker fix for a site (PLAN section 2, problem 3).
   * The newer choice for a selector replaces the older one.
   */
  function addSiteFix(store, host, fix) {
    var out = upgrade(store);
    var target = targetKey(out, host);
    if (!target) return out;
    if (!fix || typeof fix.selector !== 'string' || !fix.selector) return out;
    if (fix.action !== 'invert' && fix.action !== 'readable') return out;
    var entry = normalizeSiteEntry(out.sites[target]) || { mode: resolveMode(out, host) };
    var fixes = entry.fixes || [];
    var next = [];
    for (var i = 0; i < fixes.length; i++) {
      if (fixes[i].selector !== fix.selector) next.push(fixes[i]);
    }
    next.push({ selector: fix.selector, action: fix.action });
    if (next.length > 200) next = next.slice(next.length - 200);
    entry.fixes = next;
    out.sites[target] = entry;
    return out;
  }

  function removeSiteFix(store, host, selector) {
    var out = upgrade(store);
    var hit = matchSite(out.sites, host);
    if (!hit) return out;
    var entry = normalizeSiteEntry(hit.entry) || { mode: 'auto' };
    var fixes = entry.fixes || [];
    var next = [];
    for (var i = 0; i < fixes.length; i++) {
      if (fixes[i].selector !== selector) next.push(fixes[i]);
    }
    if (next.length) entry.fixes = next; else delete entry.fixes;
    out.sites[hit.key] = entry;
    return out;
  }

  function clearSiteFixes(store, host) {
    var out = upgrade(store);
    var hit = matchSite(out.sites, host);
    if (!hit) return out;
    var entry = normalizeSiteEntry(hit.entry) || { mode: 'auto' };
    delete entry.fixes;
    out.sites[hit.key] = entry;
    return out;
  }

  /** Forget a site entirely: it goes back to following the global default. */
  function removeSite(store, key) {
    var out = upgrade(store);
    var k = String(key || '').toLowerCase().replace(/^www\./, '').trim();
    if (k && out.sites[k]) delete out.sites[k];
    return out;
  }

  return {
    SCHEMA: SCHEMA,
    MODES: MODES,
    LOOKS: LOOKS,
    ENGINES: ENGINES,
    SCHEDULES: SCHEDULES,
    defaults: defaults,
    upgrade: upgrade,
    hostFromUrl: hostFromUrl,
    baseDomain: baseDomain,
    matchSite: matchSite,
    resolveMode: resolveMode,
    resolveEngine: resolveEngine,
    resolveFixes: resolveFixes,
    scheduleActive: scheduleActive,
    nextScheduleChange: nextScheduleChange,
    decideForPage: decideForPage,
    setSiteMode: setSiteMode,
    setSiteEngine: setSiteEngine,
    addSiteFix: addSiteFix,
    removeSiteFix: removeSiteFix,
    clearSiteFixes: clearSiteFixes,
    removeSite: removeSite,
    minutesOf: minutesOf
  };
});
