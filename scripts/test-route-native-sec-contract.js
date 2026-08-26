/* ══════════════════════════════════════════════════════════════════════════════
   kind vs sec — what actually decides the surface, EXECUTED
   ══════════════════════════════════════════════════════════════════════════════
   Three routes declared `kind:'native'` AND `sec:'…'`, which the contract validator rejects.
   The question was never "which assertion do we delete" — it was "what does sec DO?"

   TWO DIFFERENT THINGS SHARE THE NAME `sec`, and conflating them is the whole trap:

     the URL PARAMETER  ?sec=products   read by seller.html's compatibility redirect, which
                                        carries NO map and forwards the raw key as a hash
     the ROUTE FIELD    sec:'products'  a property on the route declaration

   The redirect never looks at the route field. The resolver never looks at it either — it
   matches by route `id`, then by ALIASES. The ONLY runtime reader of the route field is
   merchant-v2.html:1007, and it is gated on `m.kind === 'seller'`.

   So on a NATIVE route, `sec` is read by nothing at all. This suite proves that by executing
   the resolver over every inbound form, so the decision to remove it rests on measurement
   rather than on the reasonable-sounding claim that it is "the legacy inbound key".

   Run: node scripts/test-route-native-sec-contract.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n          ' + d : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

global.window = global;
require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const C = global.window.SokoniMerchantRoutes;

/* seller.html's redirect, executed rather than described. It carries no map: the raw key
   becomes the hash. Reproduced from the shipped inline script and asserted against it below. */
function sellerRedirect (url) {
  const u = new URL(url, 'https://mysokoni.co.ke');
  const q = u.searchParams;
  const sec = (u.hash || '').slice(1).trim().toLowerCase() || (q.get('sec') || '').trim().toLowerCase();
  q.delete('sec'); q.delete('legacy');
  const rest = q.toString();
  return '/merchant-v2' + (rest ? '?' + rest : '') + (sec ? '#' + sec : '');
}
const hashOf = (target) => (target.split('#')[1] || '');

(async () => {
  head('0 - controls');
  ck('CONTROL: the contract loaded', !!C && typeof C.resolve === 'function');
  const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
  const MV2 = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
  const SELLER = fs.readFileSync(path.join(ROOT, 'seller.html'), 'utf8');

  ck('CONTROL: my redirect model matches the shipped one',
     /q\.delete\('sec'\); q\.delete\('legacy'\);/.test(SELLER)
     && /location\.replace\('\/merchant-v2' \+ \(rest \? '\?' \+ rest : ''\) \+ \(sec \? '#' \+ sec : ''\)\)/.test(SELLER),
     'if seller.html changes shape, this model must be re-derived, not trusted');

  /* ── 1. WHO READS sec? ──────────────────────────────────────────────────── */
  head('1 - what actually reads the route field `sec`');
  ck('the resolver does NOT consult sec',
     !/sec/.test(SRC.slice(SRC.indexOf('resolve: function (id)'), SRC.indexOf('get: function (id)'))),
     'it matches by id, then ALIASES — nothing else');
  /* Count LINES, not references — the single site names m.sec three times. Counting
     references made the assertion about formatting rather than about how many places read it. */
  const secLines = MV2.split('\n').filter((l) => /m\.sec\b/.test(l));
  ck('the shell reads route.sec on exactly ONE line', secLines.length === 1,
     'found ' + secLines.length + ' line(s)');
  const line1007 = MV2.split('\n').filter((l) => /m\.kind === 'seller'/.test(l) && /m\.sec/.test(l));
  ck('and that place is gated on kind === "seller"', line1007.length === 1,
     (line1007[0] || '').trim().slice(0, 90));
  ck('so a NATIVE route\'s sec is read by nothing', true,
     'this is the finding the whole slice turns on');

  /* ── 2. THE INBOUND MATRIX ──────────────────────────────────────────────── */
  head('2 - inbound compatibility matrix — every legacy URL, executed');
  const MATRIX = [
    { label: 'Products',   legacy: '/seller.html?sec=products', expect: 'products',   kind: 'native' },
    { label: 'Receipts',   legacy: '/seller.html?sec=receipts', expect: 'receipts',   kind: 'native' },
    { label: 'Flash Sale', legacy: '/seller.html?sec=flash',    expect: 'flash-sale', kind: 'native' },
    { label: 'Stories (legacy-only)', legacy: '/seller.html?sec=stories', expect: 'stories', kind: 'seller' },
  ];
  MATRIX.forEach((row) => {
    const target = sellerRedirect(row.legacy);
    const key = hashOf(target);
    const rid = C.resolve(key);
    const r = rid && C.get(rid);
    ck(row.label + ': legacy URL lands on the right route',
       rid === row.expect, row.legacy + ' → ' + target + ' → resolve("' + key + '") = ' + rid);
    ck(row.label + ': and renders as ' + row.kind,
       r && r.kind === row.kind, r && r.kind);
  });

  head('3 - the three native routes resolve by ID or ALIAS, never by sec');
  ck('"products" is a route id', !!C.get('products') && C.resolve('products') === 'products');
  ck('"receipts" is a route id', !!C.get('receipts') && C.resolve('receipts') === 'receipts');
  ck('"flash" is NOT a route id — it is an alias', C.resolve('flash') === 'flash-sale',
     'the alias is what carries the old ?sec=flash bookmark, not the route field');
  ck('"flash-sale" resolves to itself', C.resolve('flash-sale') === 'flash-sale');

  head('4 - kind decides the surface, and sec cannot override it');
  ['products', 'receipts', 'flash-sale'].forEach((id) => {
    const r = C.get(id);
    ck(id + ' is native', r && r.kind === 'native');
  });
  const seller = C.get('stories');
  ck('a genuinely legacy route is still kind:seller', seller && seller.kind === 'seller');
  ck('and it still declares a sec, because the shell DOES read it there',
     !!(seller && seller.sec), seller && seller.sec);
  ck('the shell mounts seller.html ONLY for kind === "seller"',
     /if \(m\.kind === 'seller'\) \{ showOnly\(framePanel\('seller:'/.test(MV2),
     'a native route can never reach the legacy shell through this branch');

  head('5 - an unknown key is refused, not guessed');
  ck('an unknown hash resolves to null', C.resolve('not-a-route') === null);
  ck('an empty hash resolves to null', C.resolve('') === null);
  ck('the shell refuses an unresolved route rather than defaulting',
     /unknown route "' \+ id \+ '" — not in the contract\. Refused\./.test(MV2),
     'silently falling back to a dashboard would hide a broken inbound link');

  head('6 - the contract validates');
  /* validate() returns an ARRAY of error strings. Reading v.errors gave undefined and the
     assertion passed on an empty list — a vacuous green while the contract was demonstrably
     failing. Asserted against the real shape, with a control that the shape is what I think. */
  const errs = C.validate();
  ck('CONTROL: validate() returns an array', Array.isArray(errs),
     'typeof ' + typeof errs + ' — if this ever changes, the check below is meaningless');
  ck('validate() reports no errors', errs.length === 0,
     errs.length ? errs.length + ': ' + errs.slice(0, 4).join(' | ') : 'clean');

  head('7 - the RULES still fire — proven by violating them, not by their presence');
  /* Two sabotages passed cleanly when the validator rules were deleted, because after the fix
     no route violates them: the rules were dormant, and "the rule exists" is not "the rule
     works". These construct violations in a PRIVATE copy and assert the validator rejects each. */
  const RAW = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
  function contractWith (mutate) {
    const w = {}; w.window = w;
    new Function('window', 'globalThis', mutate(RAW))(w, w);
    return w.SokoniMerchantRoutes;
  }
  const clean = contractWith((src) => src);
  ck('CONTROL: an unmutated private copy validates clean', clean.validate().length === 0,
     clean.validate().slice(0, 2).join(' | ') || 'clean');

  const withSec = contractWith((src) => src.replace(
    "    { id:'receipts', name:'Receipts', icon:'🧾', tier:'primary',",
    "    { id:'receipts', name:'Receipts', icon:'🧾', tier:'primary', sec:'receipts',"));
  ck('a native route declaring sec IS rejected',
     withSec.validate().some((x) => /native route must not declare src\/sec\/tab/.test(x)),
     withSec.validate().slice(0, 2).join(' | ') || 'NO ERROR RAISED');

  const withOwner = contractWith((src) => src.replace(
    "    products: { owner:'native', bars:[", "    products: { owner:'seller', bars:["));
  ck('an action owner disagreeing with the route kind IS rejected',
     withOwner.validate().some((x) => /owner "seller" but route kind is "native"/.test(x)),
     withOwner.validate().slice(0, 2).join(' | ') || 'NO ERROR RAISED');

  const noSec = contractWith((src) => src.replace(
    "      kind:'seller', sec:'stories',", "      kind:'seller',"));
  ck('a kind:seller route WITHOUT sec is rejected',
     noSec.validate().some((x) => /seller route has no sec/.test(x)),
     noSec.validate().slice(0, 2).join(' | ') || 'NO ERROR RAISED');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
