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
for (const fn of ['granted', 'denied', 'decided', 'onGrant', 'onChange', 'grant', 'deny']) {
  check(new RegExp('\\b' + fn + ':\\s*function').test(securitySrc),
    `SokoniConsent exposes ${fn}()`);
}

/* Comment-stripped copy. Several checks below enforce the ABSENCE of a pattern,
   and the comment that records why the pattern was removed would otherwise trip
   the check that removed it. */
const securityCode = securitySrc.replace(/\/\*[\s\S]*?\*\//g, '');

/* The banner must offer both answers, and Reject must cost no more than Accept.
   A reject buried behind a link or a settings page is a dark pattern regardless
   of how correct the code behind it is. */
check(/_sokoniPrivacyRejectBtn/.test(securitySrc),
  'the consent banner has an explicit Reject button');
const btnRow = securityCode.match(/_sokoniPrivacyRejectBtn[\s\S]{0,2000}?Accept<\/button>/);
check(!!btnRow && (btnRow[0].match(/width:calc\(50% - 5px\)/g) || []).length === 2,
  'Reject and Accept are equal width', 'explicit widths, immune to the inline-style !important rules');
/* Both buttons must carry the SAME padding and font-size, because
   button[style*="background:linear-gradient(135deg,#71ff00"] in mobile.css forces
   13px 20px / 14px on Accept only. Matching them here keeps the rule from making
   Reject the visually smaller of the two. */
check(!!btnRow && (btnRow[0].match(/padding:13px 20px;font-size:14px/g) || []).length === 2,
  'Reject and Accept carry identical padding and type size');
check(!/grid-template-columns:1fr 1fr/.test(securityCode),
  'the button row avoids the mobile grid-collapse selector',
  '[style*="grid-template-columns:1fr 1fr"] would stack them');
check(!!btnRow && (btnRow[0].match(/min-height:48px/g) || []).length === 2,
  'Reject and Accept are equal height', 'both above the 44px touch floor');
check(/_decide\(false\)/.test(securitySrc) && /_decide\(true\)/.test(securitySrc),
  'both buttons run the same dismiss path');

/* Gating the prompt on "accepted" alone would re-ask a user who said no on every
   page load — attrition dressed up as a consent prompt. */
check(/if\(!window\.SokoniConsent\.decided\(\)\)\{/.test(securitySrc),
  'the prompt is shown until ANSWERED, not until accepted');
check(/if \(!window\.SokoniConsent\.decided\(\)\) return;/.test(securitySrc),
  'the stale-layer sweeper never removes an unanswered prompt');

/* The banner may no longer claim an answer the user has not given. */
check(!/By continuing you accept/.test(securityCode),
  'no implied-consent wording in the banner');

/* Withdrawal has to be real: gtag.js cannot be unloaded, so the kill switch and
   the on-device purge are the only things that make "reject" mean anything after
   a session in which the user had accepted. */
check(/ga-disable-/.test(analyticsSrc), 'GA kill switch is used');
check(/window\[GA_KILL\] = true;/.test(analyticsSrc),
  'the kill switch defaults ON', 'fail-safe if gtag.js loads by any other path');
check(/function _stopAnalytics\(\)/.test(analyticsSrc),
  'analytics can be stopped, not only started');
check(/removeItem\("sokoniAnalytics"\)/.test(analyticsSrc),
  'withdrawal deletes the on-device store');
check(/function _clearGaCookies\(\)/.test(analyticsSrc),
  'withdrawal clears the GA cookies');

/* Privacy Settings must reuse the authority, not grow a second one. */
const legalSrc = fs.readFileSync(path.join(ROOT, 'legal.html'), 'utf8');
check(/id="cookie-choices"/.test(legalSrc),
  'legal.html has a Privacy Settings control');
check(/C\.grant\(\)/.test(legalSrc) && /C\.deny\(\)/.test(legalSrc),
  'Privacy Settings writes through SokoniConsent');
const legalInline = legalSrc.slice(legalSrc.indexOf('Privacy Settings \u2500'));
check(!/localStorage\.(setItem|removeItem)\(['"]sokoniPrivacy/.test(legalInline),
  'Privacy Settings does not touch the consent keys directly',
  'one writer, or the two drift apart');

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
const startCalls = (analyticsSrc.match(/SokoniConsent\.(onGrant|onChange)\(/g) || []).length;
check(startCalls === 1, 'exactly one consent subscription', `found ${startCalls}`);
check(/SokoniConsent\.onChange\(/.test(analyticsSrc),
  'analytics subscribes to the DECISION, not just to grants',
  'onGrant alone would keep collecting after a withdrawal');
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

    /* A real cookie jar, because "withdrawal clears the GA cookies" is a claim
       about observable state and a stub that swallows writes would let a broken
       purge pass. Honours expiry in the past as a delete, which is the only
       mechanism a page has for removing a cookie. */
    const jar = {};
    Object.defineProperty(document, 'cookie', {
      get() {
        return Object.keys(jar).map(k => k + '=' + jar[k]).join('; ');
      },
      set(str) {
        const parts = String(str).split(';');
        const [name, value] = parts[0].split('=');
        const exp = parts.slice(1).map(p => p.trim().toLowerCase())
          .find(p => p.startsWith('expires='));
        if (exp && new Date(exp.slice(8)).getTime() < 2000000000000 &&
            new Date(exp.slice(8)).getTime() < Date.parse('2000-01-01')) {
          delete jar[name.trim()];
        } else {
          jar[name.trim()] = (value || '').trim();
        }
      },
    });

    const win = {
      document,
      localStorage,
      jar,
      navigator: { userAgent: 'Mozilla/5.0 (consent-gate-test)' },
      location: { pathname: '/index.html', href: 'https://mysokoni.co.ke/', hostname: 'mysokoni.co.ke' },
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
      gaCookies:   () => Object.keys(jar).filter(n => /^_ga(_|$)|^_gid$|^_gat/.test(n)),
      killSwitch:  () => win['ga-disable-' + (win.localStorage.getItem('sokoniGaId') || '')],
      seedGaCookies: () => { jar['_ga'] = 'GA1.1.x'; jar['_gid'] = 'GA1.1.y'; jar['_ga_QT32H65TJS'] = 'GS1.1.z'; },
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

  /* 9 ── Reject. The decision must be RECORDED, not merely obeyed — an
          unrecorded "no" means the prompt returns on the next page load, which
          is attrition, not consent. */
  {
    const sb = boot({});
    sb.ctx.window.SokoniConsent.deny();
    check(sb.ctx.window.SokoniConsent.granted() === false, 'S9 reject: not granted');
    check(sb.ctx.window.SokoniConsent.denied()  === true,  'S9 reject: recorded as denied');
    check(sb.ctx.window.SokoniConsent.decided() === true,
      'S9 reject: counts as answered', 'the prompt will not re-ask');
    check(!Object.prototype.hasOwnProperty.call(sb.store, 'sokoniPrivacyAccepted'),
      'S9 reject: the accept marker is not left behind');
    check(sb.gaRequested() === 0, 'S9 reject: gtag.js never requested');
    check(!sb.localWritten(),     'S9 reject: nothing stored');
  }

  /* 10 ── Reject, then refresh. */
  {
    const sb1 = boot({});
    sb1.ctx.window.SokoniConsent.deny();
    const sb2 = boot(sb1.store);
    check(sb2.gaRequested() === 0, 'S10 refresh after reject: still no GA request');
    check(!sb2.localWritten(),     'S10 refresh after reject: still nothing stored');
    check(sb2.ctx.window.SokoniConsent.decided() === true,
      'S10 refresh after reject: decision persists');
  }

  /* 11 ── Withdrawal mid-session, from Privacy Settings, after having accepted.
           This is the case a grant-only subscription gets WRONG: gtag.js is already
           loaded and cannot be unloaded, so unless the kill switch flips and the
           device is purged, "reject" is cosmetic. */
  {
    const sb = boot({ sokoniPrivacyAccepted: '1730000000000' });
    sb.seedGaCookies();
    check(sb.localWritten(), 'S11 setup: collecting before withdrawal');
    check(sb.gaCookies().length === 3, 'S11 setup: GA cookies present');

    sb.ctx.window.SokoniConsent.deny();

    check(!sb.localWritten(),  'S11 withdrawal: on-device store deleted');
    check(!Object.prototype.hasOwnProperty.call(sb.store, '_sokoniLastSession'),
      'S11 withdrawal: session stamp deleted');
    check(sb.gaCookies().length === 0, 'S11 withdrawal: GA cookies cleared',
      `left: ${sb.gaCookies().join(',') || 'none'}`);
    check(sb.ctx.window['ga-disable-G-QT32H65TJS'] === true,
      'S11 withdrawal: GA kill switch engaged', 'gtag.js sends nothing further');

    /* And it must STAY stopped. */
    sb.ctx.sokoniTrackProductView({ id: 'p9', name: 'After', price: 1, category: 'x' });
    sb.ctx.sokoniTrackEngagement('tap', 1);
    check(!sb.localWritten(), 'S11 withdrawal: later events collect nothing');
  }

  /* 12 ── Accept after previously rejecting. Collection resumes, and the page
           view is NOT recorded twice — the load-time collectors already ran for
           this page load. */
  {
    const sb = boot({ sokoniPrivacyAccepted: '1730000000000' });
    const before = sb.pageViews();
    sb.ctx.window.SokoniConsent.deny();
    sb.ctx.window.SokoniConsent.grant();
    check(sb.gaRequested() === 1, 'S12 re-accept: gtag.js still requested only once',
      `${sb.gaRequested()}`);
    check(sb.configCalls() === 1, 'S12 re-accept: GA config not duplicated', `${sb.configCalls()}`);
    check(sb.ctx.window['ga-disable-G-QT32H65TJS'] === false,
      'S12 re-accept: kill switch released');
    sb.ctx.sokoniTrackEngagement('tap', 1);
    check(sb.localWritten(), 'S12 re-accept: collection resumes');
    check(sb.pageViews() <= before,
      'S12 re-accept: the page view is not recorded again', `before ${before}, now ${sb.pageViews()}`);
  }

  /* 13 ── Returning visitor who previously rejected. */
  {
    const sb = boot({ sokoniPrivacyRejected: '1730000000000' });
    check(sb.gaRequested() === 0, 'S13 returning rejecter: GA not initialised at load');
    check(!sb.localWritten(),     'S13 returning rejecter: nothing collected at load');
    check(sb.ctx.window.SokoniConsent.decided() === true,
      'S13 returning rejecter: not re-asked');
  }

  /* 14 ── Republishing an unchanged decision must not re-initialise anything.
           A cross-tab storage event does exactly this. */
  {
    const sb = boot({ sokoniPrivacyAccepted: '1730000000000' });
    sb.ctx.window.SokoniConsent._publish();
    sb.ctx.window.SokoniConsent._publish();
    sb.ctx.window.SokoniConsent.grant();
    check(sb.gaRequested() === 1, 'S14 no duplicate initialisation', `${sb.gaRequested()} gtag.js requests`);
    check(sb.configCalls() === 1, 'S14 no duplicate GA config',       `${sb.configCalls()}`);
    check(sb.pageViews() === 1,   'S14 no duplicate page view',       `${sb.pageViews()}`);
  }

  /* 15 ── Consent Mode must deny the ad-network calls, and must do so BEFORE config.
           allow_google_signals:false was already in this file and already live, and the
           calls still fired. Measured on https://mysokoni.co.ke/ in a real browser with
           consent granted:

             RES 204            analytics.google.com/g/collect     <- measurement works
             Refused to connect stats.g.doubleclick.net/g/collect
             Refused to load    google.co.ke/ads/ga-audiences

           Both are blocked by CSP and each blocked request POSTs a violation to
           report-uri (cspReportCollect). The config flag is applied by gtag.js only after
           it has decided what to send; Consent Mode is consulted before, which is why it
           stops the request rather than merely disapproving of it.

           ORDER IS THE ASSERTION. gtag.js replays dataLayer in sequence, so a consent
           default pushed after config arrives too late to suppress the first hit — the
           bug would be invisible to a test that only checked the values were present. */
  {
    const sb = boot({ sokoniPrivacyAccepted: '1730000000000' });
    sb.ctx.window.SokoniConsent.grant();
    const dl = (sb.ctx.window.dataLayer || []).map((a) => Array.from(a));
    const iConsent = dl.findIndex((a) => a[0] === 'consent' && a[1] === 'default');
    const iConfig  = dl.findIndex((a) => a[0] === 'config');
    check(iConsent !== -1, 'S15 a consent default is pushed at all', `dataLayer=${dl.map((a) => a[0]).join(',')}`);
    check(iConsent !== -1 && iConfig !== -1 && iConsent < iConfig,
      'S15 consent default precedes config (later = too late to suppress the first hit)',
      `consent@${iConsent} config@${iConfig}`);
    const c = (iConsent !== -1 && dl[iConsent][2]) || {};
    /* SOKONI runs no advertising, so there is no state in which these should be granted —
       they are deliberately NOT wired to the consent modal. */
    ['ad_storage', 'ad_user_data', 'ad_personalization'].forEach((k) => {
      check(c[k] === 'denied', `S15 ${k} denied`, String(c[k]));
    });
    /* Measurement itself must still work — a gate that silently disabled analytics
       would "pass" every ad-network assertion above for entirely the wrong reason. */
    check(c.analytics_storage === 'granted', 'S15 analytics_storage granted (post-consent only)', String(c.analytics_storage));
    check(sb.pageViews() === 1, 'S15 the page view still sends', `${sb.pageViews()}`);
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
