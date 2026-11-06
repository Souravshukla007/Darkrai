/*
 * Darkrai - shared/restricted.js
 * Pages Chrome does not allow any extension to touch (PLAN section 12).
 * Used by the popup to explain, instead of failing silently.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  var ns = (root.Darkrai = root.Darkrai || {});
  ns.restricted = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BLOCKED_SCHEMES = {
    'chrome:': 1, 'chrome-untrusted:': 1, 'chrome-search:': 1, 'chrome-native:': 1,
    'chrome-extension:': 1, 'moz-extension:': 1, 'edge:': 1, 'about:': 1,
    'devtools:': 1, 'view-source:': 1, 'data:': 1, 'blob:': 1, 'filesystem:': 1,
    'chrome-devtools:': 1
  };

  var WEBSTORE_HOSTS = {
    'chromewebstore.google.com': 1,
    'chrome.google.com': 1,
    'microsoftedge.microsoft.com': 1
  };

  var MESSAGES = {
    scheme: "Chrome doesn't allow extensions on this page (settings pages, Web Store, PDF viewer).",
    webstore: "Chrome doesn't allow extensions on the Chrome Web Store.",
    pdf: "Chrome doesn't allow extensions inside the built-in PDF viewer.",
    file: 'Allow Darkrai access to file URLs in chrome://extensions to darken local files.',
    blank: 'No page to darken in this tab.'
  };

  function parts(url) {
    var s = String(url || '');
    var m = /^([a-z][a-z0-9+.-]*:)/i.exec(s);
    var scheme = m ? m[1].toLowerCase() : '';
    var host = '', path = '';
    try {
      var u = new URL(s);
      host = (u.hostname || '').toLowerCase();
      path = u.pathname || '';
    } catch (e) {
      var hm = /^[a-z-]+:\/\/([^\/:?#]+)([^?#]*)/i.exec(s);
      if (hm) { host = hm[1].toLowerCase(); path = hm[2] || ''; }
    }
    return { scheme: scheme, host: host, path: path, raw: s };
  }

  /** Why this page cannot be darkened, or null when it can. */
  function reasonFor(url) {
    var p = parts(url);
    if (!p.raw) return MESSAGES.blank;
    if (p.raw === 'about:blank' || p.raw === 'about:newtab') return MESSAGES.blank;
    if (BLOCKED_SCHEMES[p.scheme]) return MESSAGES.scheme;
    if (p.scheme === 'file:') {
      return /\.pdf($|[?#])/i.test(p.path) ? MESSAGES.pdf : MESSAGES.file;
    }
    if (p.scheme !== 'http:' && p.scheme !== 'https:') return MESSAGES.scheme;
    if (WEBSTORE_HOSTS[p.host]) {
      if (p.host === 'chrome.google.com' && p.path.indexOf('/webstore') !== 0) return null;
      return MESSAGES.webstore;
    }
    if (/\.pdf($|[?#])/i.test(p.path)) return MESSAGES.pdf;
    return null;
  }

  function isRestricted(url) { return reasonFor(url) != null; }

  return {
    MESSAGES: MESSAGES,
    isRestricted: isRestricted,
    reasonFor: reasonFor,
    parts: parts
  };
});
