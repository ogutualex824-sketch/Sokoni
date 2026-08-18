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
/* resolve, not join: an absolute path (used by the exit-contract mutation controls
   to point the gate at a deliberately broken copy of a shell) must survive. */
const R = f => fs.readFileSync(path.resolve(ROOT, f), 'utf8');
const SHELL_FILE = process.env.MERCHANT_SHELL || 'merchant.html';

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\nMERCHANT ROUTE CONTRACT GATE  \u2014  shell: ' + SHELL_FILE);
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

/* Which shell is under test. Defaults to merchant.html so CI and every existing
   caller are unchanged; MERCHANT_SHELL=merchant-v2.html runs the SAME contract
   assertions against the certified v2 shell. Two shells reading ONE registry is
   the whole point of the contract — a gate that can only see one of them cannot
   prove that. */
const shell = R(SHELL_FILE);
/* Only real navigation escapes count — the words appearing inside comments do not. */
const stripped = shell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
check('shell has no window.open',        !/window\.open\s*\(/.test(stripped));
check('shell has no target="_blank"',    !/target\s*=\s*["']_blank/.test(stripped));
/* The rule is "no navigation the MERCHANT did not ask for", and it must keep catching the
   escalation that caused the outage (a MODULE's postMessage ending the session) while
   ALLOWING a merchant pressing a Sign out button they can see. Those two are told apart by
   exactly one thing: whether the navigation resolves through a contract-declared kind:'exit'
   route. So the check is per-navigation-site and structural, not a global count — a count
   could be kept at zero by deleting an unrelated navigation, and a global regex would pass a
   shell where the guard and the navigation live in different functions.

   Two sanctioned shapes, because the shells legitimately differ:
     inline     if (m.kind === 'exit') { location.assign(m.href); return; }      (v1)
     primitive  function leaveShell(rid){ … if (m.kind !== 'exit') return; … }   (v2)
   Both are "the navigation is inside a body that first proved the route is an exit". */
const EXIT_GUARD = /\bkind\s*(===|!==)\s*['"]exit['"]/;
const navSites = [...stripped.matchAll(/location\.(href|assign|replace)\s*[=(]/g)];

check('every shell navigation site is guarded by a contract exit check',
      navSites.every(m => {
        /* Walk back to the enclosing function and require the guard to precede the
           navigation inside THAT body — not merely somewhere in the file. */
        const fnAt = stripped.lastIndexOf('function', m.index);
        if (fnAt < 0) return false;
        return EXIT_GUARD.test(stripped.slice(fnAt, m.index));
      }),
      navSites.length + ' navigation site(s)');

/* A navigation whose target is a string literal cannot have come from the contract. This is
   what forbids the hardcoded '/login?next=/merchant-v2.html' the v2 shell shipped with. */
check('...and none of them navigates to a literal URL (target must come from the contract)',
      !/location\.(href|assign|replace)\s*[=(]\s*['"`]/.test(stripped));

/* cleanUrls:true 301-redirects a .html target. The contract already refuses one in href and
   next; this stops a shell from composing one by hand on the way out. */
check('...and the shell composes no .html exit target (cleanUrls 301s it)',
      !/[?&]next=[^'"`\s)]*\.html/.test(stripped));

/* An exit that ends the session must not be reachable before the sign-out resolves, or the
   merchant leaves with a live session behind them. If the contract declares one, the shell
   has to show it knows. */
/* Conditional on the shell actually OFFERING the exit, for the same reason the capability
   layer exists: a contract that declares a capability must not break a shell that does not
   implement it. merchant.html has no sign-out at all — it does not withhold the guard, it
   withholds the whole control — so demanding the guard there would be demanding it build a
   feature. A shell that DOES reach the route gets no such latitude. */
const termExits = C.ROUTES.filter(r => r.kind === 'exit' && r.terminatesSession);
const offered = termExits.filter(r => new RegExp("['\"]" + r.id + "['\"]").test(stripped));
check('session-terminating exits are guarded until the sign-out completes',
      offered.length === 0 || /terminatesSession/.test(stripped),
      offered.length ? 'offers ' + offered.map(r => r.id).join(',')
                     : 'shell offers no session-terminating exit (' +
                       (termExits.map(r => r.id).join(',') || 'none declared') + ' declared)');
/* The escalation that actually caused the outage: a module's postMessage ending the session.
   Assert no navigation reaches an auth destination from anywhere in the shell. */
check('shell never navigates the tab to login/auth (module word cannot end a session)',
      !/location\.(href|assign|replace)\s*[=(]\s*['"`][^'"`]*(login|signin|sign-in|auth)/i.test(stripped));
/* An exit must exist and be declared, or the dead-end is back and nobody notices. */
const exitRoutes = C.ROUTES.filter(r => r.kind === 'exit');
check('the contract declares a way out of the shell', exitRoutes.length > 0,
      exitRoutes.map(r => r.id + '->' + r.href).join(',') || 'NONE — /merchant is a dead-end');
check('every exit href is root-relative and not .html (cleanUrls 301s)',
      exitRoutes.every(r => /^\/[^/]*$/.test(r.href || '') && !/\.html$/.test(r.href || '')),
      exitRoutes.map(r => r.href).join(','));

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
/* Cashier and Inventory MERGED into one POS route. They were two sidebar rows opening the same
   application at different tabs, which forced the shell to deep-switch into it and made the
   src hash load-bearing. POS now owns the in-shop operation (Checkout / Inventory / Audit Log)
   through the POS app's own tabs, and opens on Checkout. Products stays separate: catalogue
   management is a different job from in-shop stock operations. Both old ids alias to 'pos'. */
/* The founder sidebar and its ORDER are a product decision, so they are written out here in
   full rather than read back out of the contract. Deriving this list from C.primary() would
   make the assertion compare the contract to itself and pass for any sidebar whatsoever —
   the check would still be green the day a route silently went missing.
   Updated for the certified registry, which adds Sell and Inventory: 15 -> 17. That was a
   deliberate decision about what a merchant sees first, NOT a count bumped to quiet a gate,
   which is why the two additions are asserted BY NAME below in their agreed positions. */
const FOUNDER_SIDEBAR = ['dashboard','plan','sell','products','inventory','pos','orders','analytics',
  'revenue','payments','deliveries','returns','receipts','staff','messages','disputes','settings'];

/* The two additions, named and positioned. A count of 17 alone would also be satisfied by two
   entirely different routes appearing. */
const SIDEBAR_ADDITIONS = [
  { id: 'sell',      after: 'plan',     before: 'products' },
  { id: 'inventory', after: 'products', before: 'pos' }
];
SIDEBAR_ADDITIONS.forEach(a => {
  const r = C.get(a.id);
  check('founder addition is a real primary route: ' + a.id,
        !!r && r.tier === 'primary', r ? r.tier + '/' + r.kind : 'MISSING');
  check('founder addition prefers a native surface: ' + a.id,
        !!r && r.kind === 'native', r ? r.kind : 'MISSING');
  const i = FOUNDER_SIDEBAR.indexOf(a.id);
  check('founder addition sits between ' + a.after + ' and ' + a.before + ': ' + a.id,
        i > 0 && FOUNDER_SIDEBAR[i - 1] === a.after && FOUNDER_SIDEBAR[i + 1] === a.before,
        FOUNDER_SIDEBAR.slice(Math.max(0, i - 1), i + 2).join(' > '));
});
/* Negative control: the expected list must NOT be a copy of the contract's own output. If a
   future edit replaces it with C.primary(), this fails and the vacuous-assertion trap is
   caught at the moment it is introduced rather than the day it matters. */
check('the expected sidebar is declared, not derived from the contract',
      FOUNDER_SIDEBAR !== C.PRIMARY_ORDER && !Object.is(FOUNDER_SIDEBAR, C.primary()),
      'independent literal');

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
