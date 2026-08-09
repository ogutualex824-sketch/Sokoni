/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT ROUTE CONTRACT GATE  (Phase 2A / 2D / 2J)
   ══════════════════════════════════════════════════════════════════════════════
   Static half of the merchant route gate. Proves the registry is internally
   consistent AND that every target it names really exists in the repo:

     · contract self-validation (ids, kinds, roles, context, mobile/desktop flags)
     · every seller `sec` is a REAL key in seller.js DASH_PAGES         (2A)
     · every pos `tab` is a REAL data-tab in pos.html                   (2A)
     · every page `src` is a REAL file on disk                          (2A)
     · no route targets a legacy dashboard / external URL               (2J)
     · the shell contains no window.open / target=_blank / top-level nav (2J)
     · the shell renders its sidebar FROM the contract, not a private list (2C)
     · Plan is present and primary                                       (2B)

   No browser required — this must pass in CI. The runtime half (click -> module
   mounted -> old module gone) lives in scripts/test-merchant-route-gate.js.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const R = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\nMERCHANT ROUTE CONTRACT GATE');
console.log('='.repeat(70));

const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));

/* ── 1. Contract self-validation ─────────────────────────────────────────── */
console.log('\n1. Contract integrity');
const errs = C.validate();
check('contract validates clean', errs.length === 0, errs.length ? errs.join(' | ') : String(C.ROUTES.length) + ' routes');
errs.forEach(e => console.log('        ✗ ' + e));

/* ── 2. seller `sec` keys really exist in seller.js DASH_PAGES ───────────── */
console.log('\n2. Seller section targets exist (a bad sec silently renders Overview)');
const sellerJs = R('seller.js');
const dashStart = sellerJs.indexOf('const DASH_PAGES = {');
check('seller.js DASH_PAGES located', dashStart > -1);
/* Slice to the object's closing brace, then read only its top-level keys. */
const dashBlock = sellerJs.slice(dashStart, sellerJs.indexOf('\n};', dashStart));
const realSecs = [...dashBlock.matchAll(/^\s{2}([a-zA-Z_][\w]*)\s*:/gm)].map(m => m[1]);
check('DASH_PAGES keys parsed', realSecs.length > 5, realSecs.join(','));

C.ROUTES.filter(r => r.kind === 'seller').forEach(r => {
  check('seller sec exists: ' + r.id + ' -> "' + r.sec + '"', realSecs.includes(r.sec));
});
/* The contract's vocabulary must not drift from the real file either. */
const drift = C.SELLER_SECTIONS.filter(s => !realSecs.includes(s));
check('contract SELLER_SECTIONS matches seller.js', drift.length === 0, drift.length ? 'stale: ' + drift.join(',') : 'in sync');

/* ── 3. pos `tab` targets really exist in pos.html ───────────────────────── */
console.log('\n3. POS tab targets exist');
const posHtml = R('pos.html');
const realTabs = [...new Set([...posHtml.matchAll(/data-tab="([a-z-]+)"/g)].map(m => m[1]))];
check('pos.html tabs parsed', realTabs.length > 3, realTabs.join(','));
C.ROUTES.filter(r => r.kind === 'pos').forEach(r => {
  check('pos tab exists: ' + r.id + ' -> "' + r.tab + '"', realTabs.includes(r.tab));
});

/* ── 4. page `src` targets are real files ────────────────────────────────── */
console.log('\n4. Page targets exist on disk');
C.ROUTES.filter(r => r.kind === 'page').forEach(r => {
  const file = r.src.split('?')[0].split('#')[0];
  check('page src exists: ' + r.id + ' -> ' + file, fs.existsSync(path.join(ROOT, file)));
});

/* ── 5. Phase 2J — no legacy / escaping targets anywhere in the contract ─── */
console.log('\n5. No legacy dashboard or shell-escaping targets (2J)');
const legacy = C.ROUTES.filter(r => r.src && /dashboard\.html|seller-dashboard|^https?:|^\/\//i.test(r.src));
check('no route targets a legacy dashboard or external URL', legacy.length === 0,
      legacy.map(r => r.id).join(',') || 'clean');

const shell = R('merchant.html');
/* Only real navigation escapes count — the words appearing inside comments do not. */
const stripped = shell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
check('shell has no window.open',        !/window\.open\s*\(/.test(stripped));
check('shell has no target="_blank"',    !/target\s*=\s*["']_blank/.test(stripped));
/* Exactly ONE top-level navigation is legitimate: escalating to the real login flow when the
   shell itself has no session. That is the authentication boundary — modules are forbidden
   from redirecting their own panel precisely so this single, deliberate escalation is the only
   way out of /merchant. Anything else navigating the tab is a shell escape. */
const navs = [...stripped.matchAll(/location\.(href|assign|replace)\s*[=(]/g)].map(m => m[0]);
const loginEscalations = [...stripped.matchAll(/location\.replace\('login\.html\?next='/g)].length;
check('shell has no top-level navigation except the login escalation',
      navs.length === loginEscalations && loginEscalations <= 1,
      navs.length + ' nav(s), ' + loginEscalations + ' sanctioned login escalation(s)');

/* ── 6. Phase 2C — the shell projects the contract, it does not re-declare it ─ */
console.log('\n6. Sidebar is a projection of the contract (2C)');
check('shell loads sokoni-merchant-routes.js', /src=["']sokoni-merchant-routes\.js["']/.test(shell));
check('shell reads SokoniMerchantRoutes',      /SokoniMerchantRoutes/.test(shell));
check('shell declares no private MODULES array', !/var\s+MODULES\s*=\s*\[/.test(stripped),
      /var\s+MODULES\s*=\s*\[/.test(stripped) ? 'a second nav list still exists' : 'single source');

/* ── 7. Phase 2B — Plan is a first-class primary destination ─────────────── */
console.log('\n7. Plan is first-class (2B)');
const plan = C.get('plan');
check('plan route registered',            !!plan);
check('plan is primary tier',             plan && plan.tier === 'primary');
check('plan is mobile + desktop safe',    plan && plan.mobile === true && plan.desktop === true);
check('plan does not target a dashboard', plan && !/dashboard/i.test(plan.src || ''));
check('plan requires merchant context',   plan && plan.ctx.includes('sellerUid') && plan.ctx.includes('shopId'));
/* The plan page must be backed by canonical, exported Cloud Functions. */
const fnIndex = R('functions/index.js');
['subGetStatus', 'subGetPlans', 'subActivate'].forEach(fn => {
  check('CF exported: ' + fn, new RegExp('exports\\.' + fn + '\\s*=').test(fnIndex));
});

/* ── 8. Bottom nav integrity ─────────────────────────────────────────────── */
console.log('\n8. Bottom navigation (2G)');
check('bottom nav has exactly 4 entries', C.BOTTOM_NAV.length === 4, String(C.BOTTOM_NAV.length));
check('every bottom-nav id is a real route or __more',
      C.BOTTOM_NAV.every(b => b.id === '__more' || !!C.get(b.id)));
check('Plan is NOT in the bottom nav (must not crowd it)',
      !C.BOTTOM_NAV.some(b => b.id === 'plan'));

/* ── 9. Coverage — the founder's canonical sidebar is fully represented ──── */
console.log('\n9. Founder sidebar coverage');
/* The founder's canonical sidebar, in order. This literal is the SPEC — the contract must
   match it, not the other way round. Marketing moved to the More tier; Disputes is primary. */
const FOUNDER_SIDEBAR = ['dashboard','plan','products','inventory','cashier','orders','analytics',
  'revenue','payments','deliveries','returns','receipts','staff','messages','disputes','settings'];

FOUNDER_SIDEBAR.forEach(id => {
  const r = C.get(id);
  check('primary: ' + id, !!r && r.tier === 'primary',
        r ? r.kind + (r.sec ? ':' + r.sec : r.tab ? ':' + r.tab : r.src ? ':' + r.src : '') : 'MISSING');
});
const actual = C.primary().map(r => r.id);
check('sidebar ORDER matches the canonical spec exactly',
      actual.join(',') === FOUNDER_SIDEBAR.join(','), actual.join(','));
check('no extra primary destinations', actual.length === FOUNDER_SIDEBAR.length,
      actual.length + ' vs ' + FOUNDER_SIDEBAR.length);

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
