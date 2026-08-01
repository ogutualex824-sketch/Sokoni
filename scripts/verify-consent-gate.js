#!/usr/bin/env node
/* ============================================================================
   SOKONI — Consent Gate Verification
   ============================================================================
   Guards one invariant:

     No analytics collection happens before the user has consented.

   Before this gate existed, analytics.js injected gtag.js and fired `config`
   with send_page_view on EVERY page load — while security.js was simultaneously
   putting a KDPA consent modal in front of the user. The platform asked for
   consent and then ignored the answer. Layer 2 (the localStorage behavioural
   store) had the same problem: page views, scroll depth, dwell time, hub visits
   and retention were all written before any decision.

   Two halves, because either one alone can pass while the product is broken:

     PART 1 — static contract.  The gate is present, has no bypass, and every
              page that loads analytics.js loads the consent authority FIRST
              (checked against the real HTML script-execution rules, not just
              document order).

     PART 2 — behaviour.  The REAL security.js consent module and the REAL
              analytics.js are executed in a sandboxed DOM across seven
              scenarios, and the observable side effects are asserted:
              was gtag.js requested, was localStorage written.

   Part 2 is what makes this trustworthy. A static check can only prove the code
   looks right; running it proves nothing is transmitted or stored.

   Usage:  node scripts/verify-consent-gate.js
   Exit:   0 all pass · 1 any failure
   Deps:   none (no browser, no jsdom) — safe to run in predeploy and CI.
   ========================================================================= */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT         = path.resolve(__dirname, '..');
const ANALYTICS_JS = path.join(ROOT, 'analytics.js');
const SECURITY_JS  = path.join(ROOT, 'security.js');

let failures = 0;
let passes   = 0;

function ok(name, detail)  { passes++;   console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail) { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function check(cond, name, detail) { cond ? ok(name, detail) : bad(name, detail); return !!cond; }
function section(title) { console.log(`\n${title}\n${'─'.repeat(title.length)}`); }

/* ══════════════════════════════════════════════════════════════════════════
   PART 1 — STATIC CONTRACT
   ══════════════════════════════════════════════════════════════════════════ */

section('PART 1 — static contract');

const analyticsSrc = fs.readFileSync(ANALYTICS_JS, 'utf8');
const securitySrc  = fs.readFileSync(SECURITY_JS, 'utf8');

/* The consent authority exists and is the only implementation of the check. */
check(/window\.SokoniConsent\s*=\s*\{/.test(securitySrc),
  'security.js defines window.SokoniConsent');
check(/granted:\s*function/.test(securitySrc) && /onGrant:\s*function/.test(securitySrc),
  'SokoniConsent exposes granted() and onGrant()');
check(/_notifyGranted\s*&&|SokoniConsent\s*&&\s*window\.SokoniConsent\._notifyGranted|window\.SokoniConsent\._notifyGranted\(\)/.test(securitySrc),
  'the accept handler publishes the grant');

/* analytics.js must not read the consent key itself. Two readers of the same
   localStorage key is exactly how the original drift happened: one of them can
   be updated and the other silently left behind. */
check(!/sokoniPrivacyAccepted/.test(analyticsSrc),
  'analytics.js does not read the consent key directly',
  'it subscribes to SokoniConsent instead');

/* gtag.js injection must live inside the gated initialiser, never at module
   scope. This is the single assertion that would have caught the original bug. */
const initGa = analyticsSrc.match(/function\s+_initGA4\s*\(\)\s*\{[\s\S]*?\n  \}/);
check(!!initGa, 'GA4 initialisation is wrapped in _initGA4()');
if (initGa) {
  check(/googletagmanager\.com\/gtag\/js/.test(initGa[0]),
    'gtag.js injection is inside _initGA4()');
  const outside = analyticsSrc.replace(initGa[0], '');
  check(!/googletagmanager\.com\/gtag\/js/.test(outside),
    'gtag.js is injected nowhere else',
    'no ungated path to the network');
}

/* Layer 2 write choke point. */
check(/function _saveStore\(d\)\s*\{\s*\n\s*if \(!_collect\) return;/.test(analyticsSrc),
  '_saveStore refuses to write before consent');
check(/if \(_collect\) localStorage\.setItem\("_sokoniLastSession"/.test(analyticsSrc),
  'the session stamp is gated too',
  'otherwise a pre-consent visit burns the 30-min session window');

/* Exactly one start point, and it fails closed. */
const startCalls = (analyticsSrc.match(/SokoniConsent\.onGrant\(/g) || []).length;
check(startCalls === 1, 'exactly one consent subscription', `found ${startCalls}`);
check(/_collect = true;[\s\S]{0,200}_initGA4\(\);/.test(analyticsSrc),
  'both layers start from the same point');
check(/analytics disabled/.test(analyticsSrc),
  'missing consent authority fails CLOSED',
  'no silent fallback to the ungated path');

/* Every page that loads analytics.js must run the consent authority first.
   Uses real script-execution semantics: a blocking script always runs before a
   deferred one regardless of position; two deferred scripts run in document
   order; async is unordered and therefore never safe. */
function walkHtml(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'functions' || e.name === 'dist') continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walkHtml(fp, out);
    else if (e.name.endsWith('.html')) out.push(fp);
  }
  return out;
}

const TAG = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const orderProblems = [];
let pagesWithAnalytics = 0;

for (const fp of walkHtml(ROOT, [])) {
  const html = fs.readFileSync(fp, 'utf8');
  let m, sec = null, ana = null, i = 0;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    const tag = m[0], src = m[1];
    const kind = /\basync\b/i.test(tag) ? 'async' : /\bdefer\b/i.test(tag) ? 'defer' : 'blocking';
    const rec = { order: i++, kind };
    if (/(^|\/)security\.js(\?|$)/.test(src)  && !sec) sec = rec;
    if (/(^|\/)analytics\.js(\?|$)/.test(src) && !ana) ana = rec;
  }
  if (!ana) continue;
  pagesWithAnalytics++;
  const rel = path.relative(ROOT, fp).replace(/\\/g, '/');
  if (!sec) { orderProblems.push(`${rel}: analytics.js with no security.js`); continue; }
  if (sec.kind === 'async' || ana.kind === 'async') {
    orderProblems.push(`${rel}: async script — order not guaranteed`); continue;
  }
  let safe;
  if (sec.kind === 'blocking' && ana.kind === 'defer')      safe = true;
  else if (sec.kind === 'defer' && ana.kind === 'blocking') safe = false;
  else                                                      safe = sec.order < ana.order;
  if (!safe) orderProblems.push(`${rel}: security=${sec.kind}@${sec.order} analytics=${ana.kind}@${ana.order}`);
}

check(orderProblems.length === 0,
  `consent authority runs before analytics on all ${pagesWithAnalytics} pages`,
  orderProblems.length ? '\n      ' + orderProblems.join('\n      ') : '');

/* ══════════════════════════════════════════════════════════════════════════
   PART 2 — BEHAVIOUR
   ══════════════════════════════════════════════════════════════════════════ */

section('PART 2 — behaviour (real modules, sandboxed DOM)');

/* The consent module is lifted verbatim out of security.js rather than
   reimplemented, so this test cannot pass against a stub that has drifted from
   what actually ships. */
/* security.js is stored CRLF and analytics.js LF. Normalise for slicing and for
   the sandbox run so this gate is not sensitive to line endings — the repo's
   line-ending settings are load-bearing elsewhere and must not be "fixed" here. */
const securityNorm  = securitySrc.replace(/\r\n/g, '\n');
const analyticsNorm = analyticsSrc.replace(/\r\n/g, '\n');

const CONSENT_START = securityNorm.indexOf('(function(){\n      if (window.SokoniConsent) return;');
if (CONSENT_START === -1) {
  bad('extract SokoniConsent from security.js', 'block markers not found — refusing to test a reimplementation');
} else {
  const CONSENT_END = securityNorm.indexOf('\n    })();', CONSENT_START);
  const consentSrc  = securityNorm.slice(CONSENT_START, CONSENT_END + '\n    })();'.length);

  /* ── Minimal DOM ───────────────────────────────────────────────────────── */
  function makeSandbox(storage) {
    const injected = [];
    const store    = Object.assign({}, storage);

    const localStorage = {
      getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? String(store[k]) : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    };

    const document = {
      visibilityState: 'visible',
      documentElement: { scrollHeight: 5000, clientHeight: 800 },
      head: { appendChild: el => injected.push(el) },
      body: { appendChild: () => {} },
      createElement: () => ({ set src(v) { this._src = v; }, get src() { return this._src; } }),
      getElementById: () => null,
      addEventListener: () => {},
    };

    const win = {
      document,
      localStorage,
      navigator: { userAgent: 'Mozilla/5.0 (consent-gate-test)' },
      location: { pathname: '/index.html', href: 'https://mysokoni.co.ke/' },
      innerHeight: 800,
      scrollY: 0,
      console: { warn: () => {}, log: () => {}, error: () => {} },
      addEventListener: () => {},
      dispatchEvent: () => true,
      CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
      setTimeout: () => 0,
      clearTimeout: () => {},
    };
    win.window = win;

    const ctx = vm.createContext(win);
    return {
      ctx, store, injected,
      /* Observable side effects. These are the only things that matter: what
         left the device, and what was written to it. */
      gaRequested: () => injected.filter(e => /googletagmanager\.com\/gtag\/js/.test(e.src || '')).length,
      localWritten: () => Object.prototype.hasOwnProperty.call(store, 'sokoniAnalytics'),
      pageViews:    () => {
        try {
          const d = JSON.parse(store.sokoniAnalytics || '{}');
          return Object.values(d.days || {}).reduce((n, x) => n + (x.pageViews || 0), 0);
        } catch (e) { return 0; }
      },
      configCalls: () => (win.dataLayer || []).filter(a => a[0] === 'config').length,
    };
  }

  function boot(storage) {
    const sb = makeSandbox(storage);
    vm.runInContext(consentSrc,  sb.ctx, { filename: 'security.js:SokoniConsent' });
    vm.runInContext(analyticsNorm, sb.ctx, { filename: 'analytics.js' });
    return sb;
  }

  /* 1 ── First visit, no consent ─────────────────────────────────────────── */
  {
    const sb = boot({});
    check(sb.gaRequested() === 0, 'S1 first visit: gtag.js is NOT requested', `${sb.gaRequested()} requests`);
    check(!sb.localWritten(),     'S1 first visit: nothing written to localStorage');
    check(typeof sb.ctx.gtag === 'function',
      'S1 first visit: gtag shim exists', 'callers never throw before consent');
  }

  /* 2 ── Tracking calls made BEFORE consent must not collect and must not
          throw. A page can call sokoniTrackProductView the moment it renders. */
  {
    const sb = boot({});
    let threw = null;
    try {
      sb.ctx.sokoniTrackProductView({ id: 'p1', name: 'Test', price: 100, category: 'x' });
      sb.ctx.sokoniTrackSearch('sofa');
      sb.ctx.sokoniTrackEngagement('tap', 1);
    } catch (e) { threw = e; }
    check(!threw, 'S2 pre-consent tracking calls do not throw', threw ? threw.message : '');
    check(sb.gaRequested() === 0, 'S2 pre-consent tracking sends nothing');
    check(!sb.localWritten(),     'S2 pre-consent tracking stores nothing');
  }

  /* 3 ── Accept ──────────────────────────────────────────────────────────── */
  {
    const sb = boot({});
    /* exactly what the accept handler in security.js does */
    sb.ctx.localStorage.setItem('sokoniPrivacyAccepted', String(Date.now()));
    sb.ctx.window.SokoniConsent._notifyGranted();

    check(sb.gaRequested() === 1, 'S3 accept: gtag.js requested exactly once', `${sb.gaRequested()}`);
    check(sb.configCalls() === 1, 'S3 accept: GA config fired exactly once',  `${sb.configCalls()}`);
    check(sb.localWritten(),      'S3 accept: local store begins collecting');
    check(sb.pageViews() === 1,   'S3 accept: page view recorded once',       `${sb.pageViews()}`);
    let ret = {};
    try { ret = JSON.parse(sb.store.sokoniAnalytics).retention || {}; } catch (e) {}
    check(Array.isArray(ret.visitDates) && ret.visitDates.length === 1,
      'S3 accept: retention recorded');
  }

  /* 4 ── Decline. There is no Decline button today: declining is expressed by
          not accepting. The gate must treat that as a hard no, including after
          the user interacts with the page. */
  {
    const sb = boot({});
    sb.ctx.sokoniTrackProductView({ id: 'p1', name: 'T', price: 1, category: 'x' });
    sb.ctx.sokoniTrackAddToCart({ id: 'p1', name: 'T', price: 1, qty: 1 });
    check(sb.gaRequested() === 0, 'S4 decline: still no GA request after interaction');
    check(!sb.localWritten(),     'S4 decline: still nothing stored after interaction');
    check(!Object.prototype.hasOwnProperty.call(sb.store, '_sokoniLastSession'),
      'S4 decline: session stamp not burned',
      'the first consented visit must still count as a session');
  }

  /* 5 ── Refresh after accepting: one page load, one page view. Not two. */
  {
    const sb1 = boot({});
    sb1.ctx.localStorage.setItem('sokoniPrivacyAccepted', String(Date.now()));
    sb1.ctx.window.SokoniConsent._notifyGranted();
    const sb2 = boot(sb1.store);              /* same device storage, new page load */
    check(sb2.gaRequested() === 1, 'S5 refresh: gtag.js requested once per load', `${sb2.gaRequested()}`);
    check(sb2.pageViews() === 2,   'S5 refresh: exactly one more page view',      `total ${sb2.pageViews()}`);
  }

  /* 6 ── Returning visitor: consent already stored, no banner shown. GA must
          initialise on load without waiting for a click that will never come. */
  {
    const sb = boot({ sokoniPrivacyAccepted: '1730000000000' });
    check(sb.gaRequested() === 1, 'S6 returning visitor: GA initialises at load', `${sb.gaRequested()}`);
    check(sb.localWritten(),      'S6 returning visitor: collection active at load');
  }

  /* 7 ── Consent persists, and re-notification cannot double-fire. */
  {
    const sb = boot({ sokoniPrivacyAccepted: '1730000000000' });
    check(sb.ctx.window.SokoniConsent.granted() === true, 'S7 consent persists across loads');
    sb.ctx.window.SokoniConsent._notifyGranted();
    sb.ctx.window.SokoniConsent._notifyGranted();
    check(sb.gaRequested() === 1, 'S7 re-notification does not re-inject gtag.js', `${sb.gaRequested()}`);
    check(sb.configCalls() === 1, 'S7 re-notification does not duplicate config',  `${sb.configCalls()}`);
    check(sb.pageViews() === 1,   'S7 re-notification does not duplicate page views', `${sb.pageViews()}`);
  }

  /* 8 ── Reads stay open. The admin dashboard must keep working; gating writes
          must not break the accessors. */
  {
    const sb = boot({});
    let threw = null, v;
    try { v = sb.ctx.sokoniGetAnalytics(); } catch (e) { threw = e; }
    check(!threw && v && typeof v === 'object',
      'S8 admin read path still works without consent', threw ? threw.message : 'returns {}');
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */

section('Result');
console.log(`  ${passes} passed, ${failures} failed`);
if (failures) {
  console.log('\n  CONSENT GATE FAILED — analytics may collect before consent (KDPA 2019).');
  process.exit(1);
}
console.log('\n  Consent gate intact: no collection before consent.');
process.exit(0);
