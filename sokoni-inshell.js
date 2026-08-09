/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — IN-SHELL MODULE BOUNDARY
   ══════════════════════════════════════════════════════════════════════════════
   Loaded by every page hosted inside the merchant shell (/merchant). It answers one
   question — "am I a module inside the shell, or a standalone page?" — and enforces
   the consequences, so each module does not have to remember them.

   WHY THIS EXISTS (all three observed on a real iPhone):

     1. COMPETING CHROME. Modules ship their own fixed bottom bars, consent modals
        and floating buttons. Inside the shell those stack on top of the shell's own
        header/bottom-nav — e.g. SmartPOS's .pos-quick-nav pinned to the iframe's
        bottom sat directly above the merchant bottom nav, giving the merchant TWO
        stacked navigation bars and burying the POS charge bar.

     2. LOGIN INSIDE A PANEL. Several modules do
        `if (!user) location.href = '/login.html'`. In an iframe that renders a full
        login screen INSIDE the merchant OS under the previous module's title. The
        shell owns authentication; a module must never navigate itself to login.

     3. DUPLICATE CONSENT. security.js renders the Privacy & Cookies modal per
        document. The top-level document owns consent — a module rendering its own
        blocks the module the merchant was trying to use.

   The shell is authoritative for: navigation, header, consent, update prompts,
   push-permission prompts, and authentication. A module owns only its own content.

   Load it EARLY (before the module's own CSS/JS decisions) and synchronously, so the
   html class is present for the first paint and there is no flash of competing chrome.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── Am I embedded? ──────────────────────────────────────────────────────────
     Cross-origin parents throw on property access, so treat any throw as "not our
     shell". We additionally require the parent to look like the merchant shell, so
     an unrelated same-origin embed does not silently get shell semantics. */
  var embedded = false, shellParent = false;
  try {
    embedded = !!(global.parent && global.parent !== global);
    if (embedded) {
      /* Same-origin check — reading .location.pathname throws cross-origin. */
      var pp = global.parent.location.pathname || '';
      shellParent = /\/merchant(\.html)?$/.test(pp) || !!global.parent.SokoniShell;
    }
  } catch (_) { embedded = true; shellParent = false; }

  /* Treat "embedded in our own merchant shell" as in-shell. A page embedded somewhere
     else keeps its standalone behaviour — we must not suppress a login redirect for a
     context we do not control. */
  var inShell = embedded && shellParent;

  if (inShell) {
    var de = document.documentElement;
    de.classList.add('sk-in-shell');
    /* Also expose it as an attribute so CSS written before this file can hook it. */
    de.setAttribute('data-sk-shell', 'merchant');
  }

  /* ── Suppress competing chrome ───────────────────────────────────────────────
     Injected as a stylesheet rather than by mutating elements, so it applies to
     chrome created LATER (consent banners and quick-nav strips are built at runtime)
     without needing observers. Scoped entirely under .sk-in-shell — a standalone page
     is completely unaffected by this file. */
  if (inShell) {
    var css = [
      /* SmartPOS's own mobile bottom strip — the shell's bottom nav replaces it. */
      '.sk-in-shell .pos-quick-nav{display:none !important}',
      '.sk-in-shell #pos-app{padding-bottom:0 !important}',
      /* Per-document consent + push prompts — the top-level document owns these.
         security.js also guards at the source now; this is belt-and-braces for a banner
         built before this stylesheet lands, and it costs nothing. Selector verified against
         security.js (`b.id = "_sokoniPrivacyBanner"`), not guessed. */
      '.sk-in-shell #_sokoniPrivacyBanner{display:none !important}',
      /* Floating helpers that belong to a full page, not to a panel. Verified against
         scroll-top.js (`btn.id = "sokoniScrollTop"`). */
      '.sk-in-shell #sokoniScrollTop{display:none !important}',
      /* A module must never paint its own app-level header inside the shell. */
      '.sk-in-shell .sk-shared-header,.sk-in-shell #shared-header{display:none !important}',
      /* The module viewport IS the panel: never let a module reserve space for chrome
         that the shell already accounts for, and never let it scroll horizontally. */
      '.sk-in-shell,.sk-in-shell body{max-width:100% !important;overflow-x:hidden !important}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'sk-inshell-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  var API = {
    /** True only when hosted inside the SOKONI merchant shell. */
    inShell: inShell,
    /** True when in ANY iframe (used for decisions that apply to all embeds). */
    embedded: embedded,

    /**
     * Auth gate for a hosted module.
     * Standalone → redirects to login exactly as before (unchanged behaviour).
     * In-shell    → NEVER navigates. The shell guarantees an authenticated merchant,
     *               so a null user here means the session lapsed or App Check failed.
     *               We surface that honestly and ask the shell to handle re-auth.
     * @returns {boolean} true when the caller may proceed.
     */
    requireAuth: function (user, opts) {
      if (user) return true;
      var o = opts || {};
      if (!inShell) {
        global.location.href = o.loginUrl || ('/login.html' + (o.redirect ? '?redirect=' + encodeURIComponent(o.redirect) : ''));
        return false;
      }
      try {
        global.parent.postMessage({ __sokoniModule: true, action: 'authRequired',
                                    module: (o.redirect || document.title || '') }, global.location.origin);
      } catch (_) {}
      if (typeof o.onBlocked === 'function') { try { o.onBlocked(); } catch (_) {} }
      return false;
    },

    /**
     * Classify a data-load outcome so EMPTY can never be reported as ERROR.
     * An empty result set is a SUCCESSFUL query — this is the boundary the founder
     * asked for, kept in one place so the bug cannot reappear page by page.
     * @returns {'EMPTY'|'READY'}
     */
    settle: function (rows) {
      return (Array.isArray(rows) ? rows.length : (rows && rows.size) || 0) === 0 ? 'EMPTY' : 'READY';
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.SokoniInShell = API;
})(typeof window !== 'undefined' ? window : globalThis);
