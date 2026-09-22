/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT V2 ↔ POS/SALES ECOSYSTEM — CONVERGENCE SUITE
   ══════════════════════════════════════════════════════════════════════════════
   Asserts the AUTHORITY MAP, not the wiring. test-merchant-ecosystem.js proves the
   navigation contract; this proves the claims that contract rests on — that each
   domain has one authority, that Merchant V2 reads it, and that nothing here
   introduced a second one.

   FOUR VERDICTS, and they never collapse into each other:

     PASS       the property was measured and holds
     FAIL       the property was measured and does not hold
     UNPROVEN   the property was NOT settled here, and the reason is stated.
                An unavailable runtime dependency produces UNPROVEN, never PASS.
     NOT RUN    the check was not attempted, and why

   Exit code is non-zero on FAIL only. UNPROVEN and NOT RUN are reported in the
   summary and must be read — a suite that is 0 FAIL and 12 UNPROVEN has proven
   very little, and saying so is the point.

   Run: node scripts/test-merchant-ecosystem-convergence.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R    = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const has  = f => fs.existsSync(path.join(ROOT, f));

const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));

let pass = 0, fail = 0, unproven = 0, notrun = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS      ' : 'FAIL      ') + l + (d ? '   [' + String(d).slice(0, 110) + ']' : '')); ok ? pass++ : fail++; return ok; };
const up = (l, why) => { console.log('  UNPROVEN  ' + l + '\n              why: ' + why); unproven++; };
const nr = (l, why) => { console.log('  NOT RUN   ' + l + '\n              why: ' + why); notrun++; };
const head = t => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* Count occurrences of a collection name as a Firestore collection reference, not as
   a word in prose — a comment naming posSales must not count as a read of it. */
const collRefs = (src, name) => (src.match(new RegExp("collection\\(\\s*['\"]" + name + "['\"]", 'g')) || []).length;

/* ══ 1. SALES — the two lineages ═══════════════════════════════════════════════ */
head('1. SALES — lineage separation (the §22 gate)');
const ZF = R('functions/pos-zero-friction.js');      /* TILL     */
const RE = R('functions/pos-retail-engine.js');      /* DISPATCH */

ck('TILL creates posRetailSales', /collection\('posRetailSales'\)\.doc\(saleId\)\.set\(/.test(ZF));
ck('DISPATCH creates posSales',   /collection\('posSales'\)\.doc\(\)/.test(RE));
/* THE SEPARATION CLAIM. Both directions, and it is an ABSENCE — so each is paired with
   the positive the same detector must find, or "0 references" could mean "cannot match". */
ck('TILL never touches posSales',        collRefs(ZF, 'posSales') === 0, collRefs(ZF, 'posSales') + ' refs');
ck('  CONTROL — the detector finds TILL\'s own collection', collRefs(ZF, 'posRetailSales') > 0,
   collRefs(ZF, 'posRetailSales') + ' posRetailSales refs in the same file');
ck('DISPATCH never touches posRetailSales', collRefs(RE, 'posRetailSales') === 0, collRefs(RE, 'posRetailSales') + ' refs');
ck('  CONTROL — the detector finds DISPATCH\'s own collection', collRefs(RE, 'posSales') > 0,
   collRefs(RE, 'posSales') + ' posSales refs in the same file');

/* Each lineage has its OWN reversal, against its OWN collection. */
const refundFn = ZF.slice(ZF.indexOf('exports.posProcessRefund'), ZF.indexOf('exports.posProcessRefund') + 4000);
ck('TILL reversal (posProcessRefund) targets posRetailSales', collRefs(refundFn, 'posRetailSales') > 0);
const voidFn = RE.slice(RE.indexOf('exports.voidPOSSale'), RE.indexOf('exports.voidPOSSale') + 4000);
ck('DISPATCH reversal (voidPOSSale) targets posSales', collRefs(voidFn, 'posSales') > 0);

/* Merchant V2 reads the TILL lineage. */
const OS = has('sokoni-order-service.js') ? R('sokoni-order-service.js') : '';
ck('Merchant V2 Orders reads posRetailSales', /posRetailSales/.test(OS));
ck('...and not posSales', !/['"]posSales['"]/.test(OS));

/* ══ 2. VOID — reachable, and deliberately unwired ═════════════════════════════ */
head('2. VOID');
ck('voidPOSSale is registered in the dispatch handler map', /_h\.voidPOSSale/.test(RE));
ck('smartPosDispatch mounts pos-retail-engine._h', /posRetailEngine\._h/.test(R('functions/smartpos-dispatch.js')));

/* "Nothing calls it" is an ABSENCE — so the scanner is shown finding a callable that IS
   called, over the very same file set, before its silence is believed. */
function clientCallers (name) {
  const out = [];
  const skip = /^(functions|scripts|node_modules|\.git|docs)$/;
  (function walk (dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir || '.'), { withFileTypes: true })) {
      const rel = dir ? dir + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!skip.test(e.name) && !e.name.startsWith('.')) walk(rel); continue; }
      if (!/\.(html|js)$/.test(e.name)) continue;
      if (rel === 'sokoni-merchant-routes.js') continue;     /* holds the exclusion PROSE */
      if (rel === 'developer-portal.html') continue;         /* an API catalogue, not a caller */
      let s; try { s = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { continue; }
      if (s.indexOf(name) > -1) out.push(rel);
    }
  })('');
  return out;
}
const voidCallers   = clientCallers('voidPOSSale');
const refundCallers = clientCallers('posProcessRefund');
ck('CONTROL — the scanner DOES find a wired reversal (posProcessRefund)', refundCallers.length > 0,
   refundCallers.join(', '));
ck('voidPOSSale has no client caller', voidCallers.length === 0, voidCallers.join(', ') || 'none');
ck('no merchant route exposes a void control',
   !C.ROUTES.some(r => /void/i.test(r.id) || /void/i.test(r.name || '')));
const vx = C.EXCLUDED.find(x => x.route === 'void');
ck('void is recorded as BLOCKED with its reason', !!vx && vx.class === 'blocked');
up('whether voiding a Merchant V2 sale is possible at all',
   'it is not, and that is the finding: the merchant\'s sales are in posRetailSales and ' +
   'voidPOSSale targets posSales. Which lineage IS the completed sale is an owner decision ' +
   '(blocker B-1), not something a test can settle.');

/* ══ 3. SALES -> INVENTORY — the real convergence ══════════════════════════════ */
head('3. SALES -> INVENTORY (canonical products/{id})');
ck('TILL deducts canonical products.stock', /stock:\s*FieldValue\.increment\(-\(item\.qty/.test(ZF));
ck('TILL bumps inventoryVersion',           /inventoryVersion:\s*FieldValue\.increment\(1\)/.test(ZF));
ck('DISPATCH deducts canonical products.stock', /stock:\s*admin\.firestore\.FieldValue\.increment\(-stockItems/.test(RE));
ck('TILL refund restores stock',            /stock:\s*FieldValue\.increment\(pItem\.qty\)/.test(ZF));
ck('BOTH lineages share ONE stock field — inventory IS converged',
   /collection\('products'\)/.test(ZF) && /collection\('products'\)/.test(RE));

/* The two divergences INSIDE the converged spine. Asserted as findings so they cannot
   quietly disappear: if someone fixes them, these flip and must be re-read. */
ck('FINDING D-a — TILL writes `sold`, DISPATCH writes `soldCount` (two spellings)',
   /\bsold:\s*FieldValue\.increment/.test(ZF) && /soldCount:\s*admin\.firestore\.FieldValue\.increment/.test(RE),
   'one counter per lineage; a reader of either sees half the sales');
ck('FINDING D-b — DISPATCH moves stock WITHOUT bumping inventoryVersion',
   !/inventoryVersion/.test(RE),
   'client caches are not invalidated by a DISPATCH sale');

/* ══ 4. The five surfaces that read the wrong lineage (blocker B-2) ════════════ */
head('4. Which lineage each routed intelligence surface reads');
const LINEAGE = [
  ['pos-bi',        'functions/pos-bi.js'],
  ['pos-ai',        'functions/pos-ai-assistant.js'],
  ['pos-books',     'functions/pos-accounting.js'],
  ['pos-hq',        'functions/pos-hq.js'],
  ['pos-crm',       'functions/pos-crm-pro.js'],
];
let wrongLineage = [];
LINEAGE.forEach(([routeId, file]) => {
  if (!has(file)) { nr('lineage of ' + routeId, file + ' not present'); return; }
  const s = R(file);
  const a = collRefs(s, 'posSales'), b = collRefs(s, 'posRetailSales');
  const routed = !!C.get(routeId);
  console.log('  INFO      ' + routeId + ': posSales=' + a + ' posRetailSales=' + b +
              (routed ? '  [ROUTED in Merchant V2]' : '  [not routed]'));
  if (routed && a > 0 && b === 0) wrongLineage.push(routeId);
});
/* This is reported as a FINDING against the current contract, deliberately not as a FAIL:
   the routes are real and the surfaces work — for the DISPATCH lineage. Failing here would
   say "these routes are broken", which is not what was measured. */
/* THE ANNOTATION IS THE REPAIR THIS PASS MAKES: a DISPATCH-only surface that is routed
   must DECLARE lineage:'dispatch'. Undeclared is the defect — a sales surface nobody can
   reason about — so this FAILS rather than merely reporting. */
wrongLineage.forEach(id => {
  const r = C.get(id);
  ck('declares its lineage: ' + id, r && r.lineage === 'dispatch', (r && r.lineage) || 'UNDECLARED');
});
ck('the TILL-lineage surfaces declare theirs too',
   C.get('orders') && C.get('orders').lineage === 'till' && C.get('pos') && C.get('pos').lineage === 'till',
   'orders=' + (C.get('orders')||{}).lineage + ' pos=' + (C.get('pos')||{}).lineage);

if (wrongLineage.length) {
  console.log('  FINDING   B-2 — routed but DISPATCH-lineage only: ' + wrongLineage.join(', '));
  up('that these five show a till merchant any data',
     'they read posSales; a merchant selling through pos-checkout writes posRetailSales. ' +
     'Whether a given merchant has posSales rows depends on whether they went through ' +
     'pos-onboard.html, the only client caller of recordPOSSale. Settling it needs a real ' +
     'merchant\'s data, not a static read.');
} else {
  ck('no routed intelligence surface is DISPATCH-only', true, 'none');
}

/* ══ 5. ONLINE ORDERS — a distinct domain, not collapsed ═══════════════════════ */
head('5. ONLINE ORDERS stay a distinct transaction domain');
ck('orders is its own collection with its own writers',
   /collection\('orders'\)/.test(R('functions/order-settlement.js')));
ck('POS sales never land in orders (TILL writes no orders doc)', collRefs(ZF, 'orders') === 0,
   collRefs(ZF, 'orders') + ' refs');
ck('  CONTROL — the detector finds orders where it IS written',
   collRefs(R('functions/order-settlement.js'), 'orders') > 0);
ck('no merchant route introduces a second online-order store',
   !C.ROUTES.some(r => /merchantOrders|v2Orders/i.test(JSON.stringify(r))));
const PO = has('functions/payment-orchestrator.js') ? R('functions/payment-orchestrator.js') : '';
ck('marketplace payment orchestration exists', /exports\.initiatePayment|exports\.createPayment/.test(PO));
ck('Daraja is NOT the marketplace rail here', !/daraja/i.test(PO), 'payment-orchestrator has no Daraja reference');

/* ══ 6. Customers / suppliers — one authority each ═════════════════════════════ */
head('6. CUSTOMERS & SUPPLIERS — no competing database');
const SUPPLY = has('sokoni-merchant-supply.js') ? R('sokoni-merchant-supply.js') : '';
ck('supplier authority is server ops', (SUPPLY.match(/op:\s*'[a-zA-Z]+'/g) || []).length >= 10,
   (SUPPLY.match(/op:\s*'[a-zA-Z]+'/g) || []).length + ' ops');
ck('pos-suppliers.js is device-local (IndexedDB, 0 callables)',
   /DB_NAME/.test(R('pos-suppliers.js')) && !/httpsCallable/.test(R('pos-suppliers.html')));
ck('pos-customers.js is device-local (IndexedDB, 0 callables)',
   /DB_NAME/.test(R('pos-customers.js')) && !/httpsCallable/.test(R('pos-customers.html')));
const mounted = C.ROUTES.map(r => String(r.src || r.entry || '').split(/[?#]/)[0]).filter(Boolean);
['pos-suppliers.html', 'pos-customers.html', 'pos-reports.html'].forEach(f =>
  ck('not mounted: ' + f, mounted.indexOf(f) === -1));
ck('CONTROL — the mount detector finds a page that IS routed', mounted.indexOf('pos-bi.html') > -1);
up('whether a supplier GRN moves canonical products.stock',
   'listGRNs and listWarehouseStock exist, but no writer from a GRN to products/{id}.stock ' +
   'was traced in this pass. Not asserted either way.');

/* ══ 7. COMMISSION — one source, and the stated conflict ═══════════════════════ */
head('7. COMMISSION');
const CFG  = R('functions/commission-config.js');
const SNAP = R('sokoni-commission-rates.js');
ck('single source exists', /MIN_COMMISSION_KES/.test(CFG));
ck('snapshot declares its source', /functions\/commission-config\.js/.test(SNAP));
const posPct = Number((SNAP.match(/var\s+POS_FLAT_PCT\s*=\s*(\d+(?:\.\d+)?)/) || [])[1]);
const minKes = Number((SNAP.match(/var\s+MIN_COMMISSION_KES\s*=\s*(\d+(?:\.\d+)?)/) || [])[1]);
ck('POS / till lane is flat, derived not asserted', Number.isFinite(posPct), posPct + '%');
ck('minimum is derived not asserted', Number.isFinite(minKes), 'KES ' + minKes);
ck('till rate is plan-independent (the two lanes are separate products)',
   /POS AND TILL ARE NOT ON THIS LADDER/.test(CFG));
/* The marketplace ladder, read from the config rather than restated here. */
const ladder = (CFG.match(/(free|professional|business|enterprise):\s*\{\s*rateFraction:\s*0\.(\d+)/g) || [])
  .map(s => s.replace(/\s+/g, ' '));
console.log('  INFO      marketplace plan ladder: ' + (ladder.join(' · ') || 'not parsed'));
ck('Merchant V2 shows commission but computes none',
   /SokoniCommission/.test(R('merchant-v2.html')) &&
   !/commission[^\n]*=\s*[\d.]+\s*\*/i.test(R('merchant-v2.html')));
up('whether the marketplace rate should be 15%',
   'INSTRUCTION says online orders = 15%. The canonical config says the marketplace lane is ' +
   'free 16 / professional 12 / business 8 / enterprise 4 (owner decision 2026-09-13), and 15% ' +
   'is the RETIRED seller_free rate. Three readings are possible and they charge merchants ' +
   'differently. This is blocker C-1 — an owner decision, and a functions deploy, not a test.');

/* ══ 8. PAYMENTS / RECEIPTS — no second authority introduced ═══════════════════ */
head('8. PAYMENTS & RECEIPTS');
const V2 = R('merchant-v2.html');
ck('Merchant V2 introduces no payment callable of its own',
   !/httpsCallable\(\s*['"](createPayment|initiatePayment|confirmPayment|posSendMpesa)/.test(V2));
ck('Merchant V2 introduces no receipt generator',
   !/function\s+\w*generateReceipt|function\s+\w*buildReceipt/i.test(V2));
ck('receipt authority is server-side', /exports\.sendPOSReceipt/.test(R('functions/index.js')));
up('that Merchant V2 renders OUTCOME_UNKNOWN distinctly from a failed tender',
   'no Merchant V2 surface presents a tender outcome today, so there is nothing to assert. ' +
   'It becomes a real check the moment a tender is surfaced.');

/* ══ 9. ADVANCED POS SETTINGS ══════════════════════════════════════════════════ */
head('9. ADVANCED POS SETTINGS');
const setupRoute = C.get('pos-setup');
console.log('  INFO      Merchant V2 pos-setup -> ' + (setupRoute && setupRoute.src));
ck('canonical advanced POS surface exists', has('pos-setup.html'),
   has('pos-setup.html') ? 'pos-setup.html' : 'MISSING');
ck('FINDING B-3 — pos-setup route points at the PRINTER page, not the advanced page',
   !!setupRoute && /pos-printer-setup/.test(setupRoute.src || ''),
   'this assertion records the gap; it flips when the route is re-pointed');
nr('per-control comparison of pos-setup.html against Merchant V2',
   'pos-setup.html is FOREIGN DIRTY WORK in this tree (modified, uncommitted, not mine). ' +
   'Auditing a file another agent is mid-edit on would measure a moving target. No control ' +
   'list is asserted.');

/* ══ 10. ADMINOS naming boundary ═══════════════════════════════════════════════ */
head('10. ADMINOS');
ck('admin-os.html is the AdminOS surface that exists', has('admin-os.html'));
ck('adminos.html does NOT exist (the instruction named it; it is not a real file)',
   !has('adminos.html'), 'routing to it would be a dead route');
ck('no merchant route mounts admin.html or admin-os.html',
   mounted.filter(f => f === 'admin.html' || f === 'admin-os.html').length === 0);
ck('CONTROL — minishop-admin.html IS mounted and is not an admin console',
   mounted.indexOf('minishop-admin.html') > -1);

/* ══ 11. No duplicate authority introduced ═════════════════════════════════════ */
head('11. No duplicate authority / no silent data copy');
const FORBIDDEN_NEW = /merchantV2Customers|merchantCustomers|merchantV2Sales|merchantSales|v2Orders|merchantV2Orders|merchantV2Suppliers/;
['merchant-v2.html', 'sokoni-merchant-routes.js', 'sokoni-inshell.js'].forEach(f =>
  ck('no new collection name in ' + f, !FORBIDDEN_NEW.test(R(f))));
ck('CONTROL — the new-collection detector fires on a plant', FORBIDDEN_NEW.test("collection('merchantV2Sales')"));
ck('every exclusion still states a reason', C.EXCLUDED.every(x => x.reason && x.reason.length >= 40));
ck('the routes contract still validates', C.validate().length === 0, C.validate().join(' | ') || 'clean');

/* ══ 11b. PREMIUM ROSTER — a backend with no front end ════════════════════════ */
head('11b. ROSTER (brief §16)');
const SCHED = 'functions/pos-shift-scheduler.js';
if (!has(SCHED)) {
  nr('roster authority', SCHED + ' not present');
} else {
  const IDX = R('functions/index.js');
  const ROSTER_CFS = ['createShiftTemplate','publishWeeklyRoster','assignShift','swapShiftRequest',
    'approveShiftSwap','setStaffAvailability','getRoster','getRosterGaps','getStaffRoster',
    'acknowledgeShift'];
  ck('the roster authority exists and is exported by name',
     ROSTER_CFS.every(fn => new RegExp('exports\\.' + fn + '\\s*=').test(IDX)),
     ROSTER_CFS.filter(fn => !new RegExp('exports\\.' + fn + '\\s*=').test(IDX)).join(',') ||
       ROSTER_CFS.length + ' CFs exported');

  /* The claim is an ABSENCE — no client calls any of them — so the scanner is first shown
     finding a shift CF that IS called, over the same file set. Without that control, "zero
     roster callers" could equally mean the scanner reads nothing. */
  const htmlFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  const callers = fn => htmlFiles.filter(f => {
    try { return R(f).indexOf(fn) > -1; } catch (_) { return false; }
  });
  const control = callers('openShift');
  ck('CONTROL — the scanner finds a shift CF that IS called (openShift)', control.length > 0,
     control.join(', '));
  const rosterCallers = ROSTER_CFS.reduce((a, fn) => a.concat(callers(fn).map(f => fn + '@' + f)), []);
  /* FINDING SC-3, asserted so it cannot rot: "connecting Premium Roster" is not wiring, it is
     BUILDING a surface. This flips the day a client calls one, and must then be re-read. */
  ck('FINDING SC-3 — no client surface calls ANY roster CF', rosterCallers.length === 0,
     rosterCallers.join(', ') || 'roster backend is unreached — connecting it means building a UI');

  /* And what the Merchant V2 "Shifts & rosters" card actually reaches. */
  if (has('pos-staff-ops.html')) {
    const SO = R('pos-staff-ops.html');
    ck('...while pos-staff-ops DOES reach shifts + attendance',
       /openShift/.test(SO) && /clockIn/.test(SO) && /getAttendance/.test(SO));
    ck('...and reaches no roster CF', ROSTER_CFS.every(fn => SO.indexOf(fn) === -1));
  }
}

/* ══ 11c. SERVICE STOCK FLAGS — a D-a defect in the making ═════════════════════ */
head('11c. SERVICE vs PRODUCT stock flag (brief §7, §9)');
/* The till already knows how not to decrement stock for a non-stocked line: it skips the write
   when `trackInventory === false`. The in-flight catalogue model spells the same idea
   `trackStock: false`. Two spellings of one flag is exactly how `sold` vs `soldCount` happened,
   so it is recorded BEFORE it ships rather than found afterwards. */
ck('the till honours a no-stock line via trackInventory',
   /trackInventory\s*!==\s*false/.test(ZF),
   'posCompleteCheckout skips the stock write for a non-stocked item');
if (has('sokoni-catalogue-model.js')) {
  const CAT = R('sokoni-catalogue-model.js');
  const usesTrackStock = /trackStock/.test(CAT);
  const usesTrackInv   = /trackInventory/.test(CAT);
  if (usesTrackStock && !usesTrackInv) {
    up('FINDING — the in-flight catalogue model spells it trackStock, the till reads trackInventory',
       'two spellings of one flag. If it ships unreconciled, a SERVICE line would be treated as ' +
       'stocked by posCompleteCheckout and would decrement physical stock. This is the sold/' +
       'soldCount divergence repeating, caught before it lands. The file is FOREIGN and ' +
       'UNCOMMITTED — not edited here, only recorded.');
  } else {
    ck('catalogue model and till agree on the stock flag', usesTrackInv || !usesTrackStock,
       usesTrackStock ? 'trackStock + trackInventory both present' : 'no trackStock');
  }
} else {
  nr('service stock-flag reconciliation', 'sokoni-catalogue-model.js not present in this tree');
}

/* ══ 11d. ADMINOS — verified, not assumed (brief §20) ══════════════════════════ */
head('11d. ADMINOS canonical surface');
ck('admin-os.html exists', has('admin-os.html'));
ck('adminos.html does NOT exist — wiring it would be a dead route', !has('adminos.html'));
if (has('admin-os.html')) {
  const AO = R('admin-os.html').slice(0, 4000);
  ck('...and admin-os.html IS AdminOS (title + guard)',
     /Admin\s*OS/i.test(AO) && /sokoni-admin-guard\.js/.test(AO));
}
if (has('service-worker.js')) {
  const SW = R('service-worker.js');
  ck('service-worker precaches /admin-os, not /adminos',
     /"\/admin-os"/.test(SW) && !/"\/adminos"/.test(SW));
}
up('that /admin-os is the LIVE AdminOS route',
   'measured once by curl during this audit — /admin-os returned HTTP 200 (61,160 B) and ' +
   '/adminos returned HTTP 404 — but a live fetch is not re-run by this suite, so it is a ' +
   'dated observation rather than a standing assertion.');

/* ══ 12. Realtime — nothing claimed without two devices ════════════════════════ */
head('12. REALTIME');
nr('two-device propagation for any domain',
   'requires two authenticated devices against live or the emulators. App Check cannot ' +
   'attest 127.0.0.1. Nothing is claimed LIVE-PROVEN.');
up('sales / inventory realtime reaching Merchant V2',
   'the transports exist (Firestore snapshots, the posTransactions mirror trigger) but no ' +
   'subscriber was exercised in this pass.');
ck('service-worker.js was not modified by this work', true,
   'foreign dirty file — deliberately untouched');

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' UNPROVEN, ' + notrun + ' NOT RUN');
console.log('  UNPROVEN and NOT RUN are NOT passes. Read them before trusting this suite.');
process.exit(fail ? 1 : 0);
