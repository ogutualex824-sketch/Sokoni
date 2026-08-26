/* Legacy seller deep links must land on the right merchant-v2 module.
 *
 *   node scripts/test-seller-deeplink.js
 *
 * WHAT CHANGED, AND WHY THE OLD SUITE HAD TO GO
 * This file used to assert that seller.html itself rendered five sections, each with a
 * working interactive control. That made the legacy shell a SUPPORTED DESTINATION — the
 * one thing the migration exists to end. Kept as-is it would have blocked the port by
 * demanding the old surface stay alive, so the assertions were rewritten rather than
 * deleted: the contract it protected is still real and still worth a gate.
 *
 * The contract it protected was the address semantics, and those semantics INVERT
 * across the migration — which is the whole reason this needs a test and not a code review:
 *
 *   seller.html    #products   TRANSIENT. Applied, then stripped (history.replaceState) so
 *                              the browser does not anchor-scroll. Cannot survive a reload.
 *                  ?sec=...    DURABLE. The strip preserves location.search.
 *
 *   merchant-v2    #products   DURABLE. go() writes it with pushState and never strips it;
 *                              boot re-reads location.hash through the same contract.
 *                  ?sec=...    not its vocabulary at all.
 *
 * So the durable form on one side is the transient form on the other. A redirect that
 * forwarded `?sec=` verbatim, or that dropped the hash, would look correct on the first
 * click and lose the merchant's destination on the first reload — silently, landing them
 * on Dashboard with no error anywhere. That is the exact silent-wrong-section class the
 * original suite was written for, so it is what this one asserts.
 *
 * WHAT IS ASSERTED
 *   1. contract      every legacy section key resolves to a real merchant-v2 route
 *   2. redirect      the REAL inline resolver, extracted from seller.html and executed
 *   3. recursion     it never fires while embedded — merchant-v2 still iframes this file
 *   4. durability    merchant-v2 keeps its hash rather than stripping it
 *   5. no legacy UI  nothing here requires the old shell to render anything
 *
 * Section 2 runs the source itself in a sandbox rather than re-implementing it. A test that
 * re-implements the logic it checks passes against a build where the real code was never
 * wired in at all — which is how the ENOENT and the empty-bar defects both hid this week.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── 1. CONTRACT ──────────────────────────────────────────────────────────────
   The legacy vocabulary is SELLER_SECTIONS, already declared in the contract and
   already enforced against every route's `sec`. Each key must name a real route. */
console.log('\n1. Contract — every legacy section resolves');
const API = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const SECTIONS = API.SELLER_SECTIONS;

ok(Array.isArray(SECTIONS) && SECTIONS.length >= 16,
   'CONTROL: SELLER_SECTIONS is non-empty (' + (SECTIONS || []).length + ' keys)',
   'An empty vocabulary would make every assertion below vacuously true.');

for (const sec of SECTIONS) {
  const id = API.resolve(sec);
  ok(!!id && !!API.get(id), 'sec=' + sec + ' resolves -> ' + (id || 'NULL'),
     id ? '' : 'resolve() returned null: a merchant on this link is REFUSED, not routed.');
}

/* The converse. resolve() is documented to return null for genuinely unknown ids so the
   caller fails loudly; if it had been loosened into a fallback, every check above would
   pass no matter what the aliases said. */
ok(API.resolve('not-a-section') === null,
   'NEGATIVE CONTROL: an unknown key still resolves to null');
ok(API.resolve('') === null || API.resolve('') === undefined,
   'NEGATIVE CONTROL: an empty key does not resolve');

/* ── 2 & 3. THE REAL REDIRECT ─────────────────────────────────────────────────
   Extract the inline resolver from seller.html and run it against a fake window. */
console.log('\n2. The redirect resolver, executed from seller.html source');
const sellerHtml = R('seller.html');

const MARK = 'LEGACY COMPATIBILITY REDIRECT';
ok(sellerHtml.indexOf(MARK) !== -1, 'CONTROL: the compatibility block is present in seller.html');

/* Take the first <script> after the marker — the resolver is inline and first by design. */
const afterMark = sellerHtml.slice(sellerHtml.indexOf(MARK));
const m = afterMark.match(/<script>([\s\S]*?)<\/script>/);
const RESOLVER = m ? m[1] : '';
ok(RESOLVER.length > 200 && RESOLVER.indexOf('location.replace') !== -1,
   'CONTROL: resolver source extracted (' + RESOLVER.length + ' chars)',
   'Extraction returned nothing usable — every case below would test an empty string.');

/* Run it with a synthetic location. Returns the URL it navigated to, or null. */
function runResolver (href, opts) {
  opts = opts || {};
  const u = new URL(href, 'https://mysokoni.co.ke');
  let replaced = null;
  const win = {
    URLSearchParams,
    location: {
      search: u.search, hash: u.hash, pathname: u.pathname,
      replace: (to) => { replaced = to; },
    },
  };
  /* Embedded: parent is a DIFFERENT object from window. Top-level: parent === window. */
  win.parent = opts.embedded ? {} : win;
  const ctx = vm.createContext(win);
  ctx.window = win;
  vm.runInContext(RESOLVER, ctx, { timeout: 2000 });
  return replaced;
}

const CASES = [
  ['/seller.html?sec=products',            '/merchant-v2#products',  'durable ?sec= forwarded as the hash'],
  ['/seller.html#products',                '/merchant-v2#products',  'transient #hash forwarded'],
  ['/seller.html?sec=orders#products',     '/merchant-v2#products',  'hash wins over ?sec= (more recent navigation)'],
  ['/seller.html',                         '/merchant-v2',           'bare seller.html — no section invented'],
  ['/seller.html?sec=flash',               '/merchant-v2#flash',     'renamed route forwarded RAW, resolved at the far end'],
  ['/seller.html?sec=overview',            '/merchant-v2#overview',  'legacy default forwarded'],
  ['/seller.html?sec=products&product=42', '/merchant-v2?product=42#products', 'unrelated state rides along'],
];
for (const [from, want, why] of CASES) {
  const got = runResolver(from);
  ok(got === want, why + '  [' + from + ' -> ' + (got === null ? 'NO REDIRECT' : got) + ']',
     got === want ? '' : 'expected ' + want);
}

/* An unknown section must still be forwarded, not swallowed: merchant-v2 resolves it,
   and its own boot decides. Swallowing it here would hide a broken inbound link. */
const unknown = runResolver('/seller.html?sec=not-a-section');
ok(unknown === '/merchant-v2#not-a-section',
   'unknown ?sec= is forwarded verbatim, not silently dropped  [' + unknown + ']');
ok(API.resolve('not-a-section') === null,
   '  ...and the far end refuses it rather than guessing a module');

console.log('\n3. Recursion guard — merchant-v2 still iframes this file');
ok(runResolver('/seller.html?sec=products', { embedded: true }) === null,
   'EMBEDDED: no redirect (would load the merchant shell inside its own panel)');
ok(runResolver('/seller.html', { embedded: true }) === null,
   'EMBEDDED: bare seller.html does not redirect either');
ok(runResolver('/seller.html?sec=products&legacy=1') === null,
   'ESCAPE HATCH: ?legacy=1 renders the legacy shell untouched');

/* The guard must be the FRAME CHECK, not a URL test — the shell may address this file
   however it likes, and a URL-shaped guard would break the moment it did. */
ok(/window\.parent\s*!==\s*window/.test(RESOLVER),
   'the guard tests the frame relationship, not the URL');

/* ── 4. DURABILITY AT THE FAR END ─────────────────────────────────────────────
   The redirect is only correct if merchant-v2 KEEPS the hash it is handed. */
console.log('\n4. merchant-v2 keeps its hash');
const mv2 = R('merchant-v2.html');
const goBlock = mv2.slice(mv2.indexOf('function go ('), mv2.indexOf('window.__mgo'));
ok(goBlock.length > 200, 'CONTROL: go() located in merchant-v2.html');
ok(/history\.(pushState|replaceState)\([^)]*'#'\s*\+\s*rid/.test(goBlock),
   'go() writes the route to location.hash');
ok(!/replaceState\([^)]*location\.pathname\s*\+\s*location\.search\s*\)/.test(goBlock),
   'go() does NOT strip the hash the way the legacy shell does');
ok(/CONTRACT\.resolve\(location\.hash/.test(mv2),
   'boot re-reads location.hash through the contract, so a reload restores the module');

/* ── 5. NO LEGACY UI REQUIRED ─────────────────────────────────────────────────
   Guard against this suite quietly becoming a reason to keep the old shell alive.
   Comments are stripped first: the prose above names these sections on purpose, and
   asserting over it would match my own writing rather than the code. */
console.log('\n5. No legacy seller UI is required');
/* Scan sections 1-4 only — the assertions. This guard has to NAME the forbidden
   identifiers to look for them, so including itself made it fail on its own needles.
   Cutting at the marker is exact, and the CONTROL below proves the cut left a body
   to search rather than an empty string that would pass no matter what. */
const CUT = 'LEGACY_DOM_GUARD_BEGINS_HERE';
const selfRaw = fs.readFileSync(__filename, 'utf8');
const selfSrc = selfRaw.slice(0, selfRaw.lastIndexOf(CUT))
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(selfSrc.length > 1500,
   'CONTROL: assertion body retained for scanning (' + selfSrc.length + ' chars)',
   'An empty body would make every check below vacuous.');
/* CUT marker: LEGACY_DOM_GUARD_BEGINS_HERE */
const LEGACY_DOM = ['seller-stats', 'upload-section', 'products-section', 'showDashPage'];
for (const id of LEGACY_DOM) {
  ok(selfSrc.indexOf(id) === -1,
     'asserts nothing about legacy DOM "' + id + '"',
     'This suite would keep seller.html in service.');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
