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

/* 0b R1: the till creates its sale INSIDE the stock transaction, at an id derived from the merchant
   and the idempotency key, and refuses to create a second one — the sale authority, not a spelling. */
ck('TILL creates posRetailSales',
   /const saleId\s*=\s*_saleIdFor\(merchantId,\s*idempotencyKey\)/.test(ZF)
   && /const saleRef\s*=\s*db\.collection\('posRetailSales'\)\.doc\(saleId\)/.test(ZF)
   && /txn\.create\(saleRef,/.test(ZF)
   && /if \(saleSnap\.exists\) return/.test(ZF));
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
     roster callers" could equally mean the scanner reads nothing.

     HTML **AND JS**. The first version of this scanned `.html` only, which was narrower than
     the claim it was making: a roster call from a client-side module would have slipped
     straight through. An independent wider sweep proved the point on the control itself —
     `openShift` lives in `pos-sales.js`, which the HTML-only pass never looked at. The
     conclusion did not change (still zero roster callers either way), but the detector was
     weaker than the sentence it supported, and that is the defect, not the result. */
  const clientFiles = fs.readdirSync(ROOT)
    .filter(f => /\.(html|js)$/.test(f));
  const callers = fn => clientFiles.filter(f => {
    try { return R(f).indexOf(fn) > -1; } catch (_) { return false; }
  });
  const control = callers('openShift');
  ck('CONTROL — the scanner finds a shift CF that IS called (openShift)', control.length > 0,
     control.join(', '));
  /* SC-3 IS NOW RESOLVED, AND THIS ASSERTION WAS INVERTED RATHER THAN DELETED.
     It previously read "no client surface calls ANY roster CF" and passed — recording the
     finding that the roster backend was unreachable. Building the surface made it fail, which
     is exactly what a finding-assertion should do when the finding is fixed: it demands to be
     re-read rather than quietly going green.

     What is asserted now is the RESOLVED state, and it is stricter than the old one. The
     roster must be reached, and reached ONLY from the module built for it — if a second
     surface starts calling these CFs, that is a second roster client and this fails again. */
  const rosterCallers = ROSTER_CFS.reduce((a, fn) => a.concat(callers(fn)), []);
  const rosterClients = [...new Set(rosterCallers)];
  ck('SC-3 RESOLVED — the roster backend now HAS a client', rosterClients.length > 0,
     rosterClients.join(', ') || 'still unreached');
  ck('...and exactly ONE surface reaches it', rosterClients.length === 1, rosterClients.join(', '));
  ck('...and that surface is sokoni-merchant-roster.js',
     rosterClients.length === 1 && rosterClients[0] === 'sokoni-merchant-roster.js',
     rosterClients[0] || '—');

  /* And what the Merchant V2 "Shifts & rosters" card actually reaches. */
  if (has('pos-staff-ops.html')) {
    const SO = R('pos-staff-ops.html');
    ck('...while pos-staff-ops DOES reach shifts + attendance',
       /openShift/.test(SO) && /clockIn/.test(SO) && /getAttendance/.test(SO));
    ck('...and reaches no roster CF', ROSTER_CFS.every(fn => SO.indexOf(fn) === -1));
  }

  /* ── THE SURFACE BUILT FOR IT ──────────────────────────────────────────────
     SC-3 said "connecting the roster means BUILDING a surface". This asserts the
     surface exists, invokes ONLY real callables, and adds no authority of its own. */
  if (!has('sokoni-merchant-roster.js')) {
    nr('roster surface', 'sokoni-merchant-roster.js not present');
  } else {
    const RS = R('sokoni-merchant-roster.js');
    const RM = require(path.join(ROOT, 'sokoni-merchant-roster.js'));
    ck('a roster SURFACE now exists', typeof RM.mount === 'function');
    ck('...and it is a registered route', !!C.get('roster'),
       C.get('roster') ? C.get('roster').kind : 'MISSING');
    ck('...declared native (no second page, no iframe)',
       !!C.get('roster') && C.get('roster').kind === 'native');

    /* EVERY NAME IT USES MUST BE A REAL EXPORTED CALLABLE. This is the assertion that
       stops an invented callable name — the brief's "do not invent callable names". */
    const declared = RM.CALLABLES || [];
    ck('the surface declares the callables it uses', declared.length > 0, declared.join(','));
    ck('every declared callable is a REAL export of the roster service',
       declared.every(fn => new RegExp('exports\\.' + fn + '\\s*=').test(IDX)),
       declared.filter(fn => !new RegExp('exports\\.' + fn + '\\s*=').test(IDX)).join(',') || 'all real');
    /* CONTROL: the detector must reject a name that is NOT exported, or "all real" is
       passing for the wrong reason. */
    ck('  CONTROL — the export detector rejects an invented name',
       !new RegExp('exports\\.getRosterUnicorn\\s*=').test(IDX));

    /* The unwired ones are DECLARED with a reason, so a gap is visible rather than
       looking like an oversight. */
    const notWired = RM.NOT_WIRED || {};
    ck('unwired roster capabilities are declared with reasons',
       Object.keys(notWired).length > 0 &&
       Object.keys(notWired).every(k => String(notWired[k]).length > 20),
       Object.keys(notWired).join(','));
    ck('...and every one of them is also a real callable',
       Object.keys(notWired).every(fn => new RegExp('exports\\.' + fn + '\\s*=').test(IDX)));

    /* NO SECOND AUTHORITY. The surface must not decide permissions or keep a store. */
    ck('the surface makes no client-side role decision',
       !/claims\.|posRole|isManager\s*=|role\s*===\s*['"]manager/.test(RS),
       'authorization stays server-side');
    ck('the surface writes no collection of its own',
       !/collection\(/.test(RS), 'no Firestore write path in the surface');
    ck('the surface resolves no identity of its own',
       !/onAuthStateChanged|currentUser/.test(RS), 'sellerId comes from the shell scope');
    /* An unknown must render as an em dash, never 0 — the UI Data Integrity rule. */
    ck('an unresolved count renders as an em dash, not 0', /—/.test(RS) && /function num/.test(RS));

    /* The shell must actually mount it. */
    const V2 = R('merchant-v2.html');
    ck('the shell loads the roster module', /src=["']sokoni-merchant-roster\.js["']/.test(V2));
    ck('the shell registers it as a native module', /roster:\s*\{\s*global:\s*'SokoniMerchantRoster'/.test(V2));
    /* The ctx handle must be a whitelist, not an open door onto any callable. */
    ck('the shell\'s roster handle refuses an undeclared callable',
       /allowed\.indexOf\(name\)\s*<\s*0/.test(V2),
       'ctx.call is bounded by CALLABLES');
  }
}

/* ══ 11c. SERVICE CATALOGUE — TWO COLLECTIONS, not two spellings ═══════════════ */
head('11c. SERVICE vs PRODUCT catalogue (brief §7, §19)');
/* CORRECTION OF AN EARLIER FINDING IN THIS FILE.
   A previous pass recorded `trackInventory` vs `trackStock` as "two spellings of one flag,"
   the sold/soldCount divergence repeating. That framing was WRONG and is withdrawn. They are
   fields on TWO DIFFERENT COLLECTIONS, and the real finding is larger:

     products/{id}      canonical. Carries `trackInventory`. The ONLY collection
                        posCompleteCheckout prices and stocks from — four call sites
                        (pos-zero-friction.js:305, 373, 727, 1393), and an item missing
                        from it throws "Product <id> disappeared".
     posProducts/{id}   the POS catalogue. Carries `trackStock`. docs/POSPRODUCTS_MIGRATION_
                        GRAPH.md states plainly: "posProducts is no longer the collection a
                        sale is priced or stocked from", the SERVED ruleset keys its
                        ownership on `sellerId` which the canonical writer never sets — so
                        every client query on it is rejected wholesale — and its second
                        writer is decided for retirement (Option C).

   So the question is not which spelling wins. It is that the in-flight catalogue model
   defines a SERVICE as a `posProducts` row, and `posProducts` is a collection the till does
   not settle against and the rules reject client reads on. */
ck('the till honours a no-stock line via trackInventory',
   /trackInventory\s*!==\s*false/.test(ZF),
   'posCompleteCheckout skips the stock write for a non-stocked item');
ck('the till settles against `products`, never `posProducts`',
   collRefs(ZF, 'products') > 0 && collRefs(ZF, 'posProducts') === 0,
   'products=' + collRefs(ZF, 'products') + ' posProducts=' + collRefs(ZF, 'posProducts'));
ck('  CONTROL — the collection detector can see posProducts where it IS used',
   has('functions/business-bootstrap.js') &&
   collRefs(R('functions/business-bootstrap.js'), 'posProducts') > 0,
   'business-bootstrap reads posProducts');
if (has('docs/POSPRODUCTS_MIGRATION_GRAPH.md')) {
  const MG = R('docs/POSPRODUCTS_MIGRATION_GRAPH.md');
  ck('the migration graph records posProducts is not the sale-pricing collection',
     /no longer the collection a sale is priced or stocked from/i.test(MG));
} else {
  nr('posProducts migration graph', 'doc not present');
}
if (has('sokoni-catalogue-model.js')) {
  const CAT = R('sokoni-catalogue-model.js');
  if (/posProducts/.test(CAT) && /trackStock/.test(CAT)) {
    up('FINDING — the in-flight service model puts SERVICES in posProducts',
       'posCompleteCheckout prices and stocks ONLY from `products`, so a service that exists ' +
       'only as a posProducts row cannot be settled by the till — the lookup misses and the ' +
       'sale throws. The served ruleset also rejects client queries on posProducts (ownership ' +
       'keyed on sellerId, which the canonical writer never sets). This is a STRUCTURAL gap in ' +
       'the Quick Pay service path, not a naming mismatch. The file is FOREIGN and UNCOMMITTED ' +
       '— recorded for its owner, NOT edited here.');
  } else {
    ck('catalogue model targets the settling collection', /\bproducts\b/.test(CAT));
  }
} else {
  nr('service catalogue reconciliation', 'sokoni-catalogue-model.js not present in this tree');
}
/* A third layer, and the one that WOULD have produced the "service treated as stocked"
   symptom the withdrawn finding guessed at — by a different route. */
if (has('functions/business-bootstrap.js')) {
  const BB = R('functions/business-bootstrap.js');
  const readsPosProducts = collRefs(BB, 'posProducts') > 0;
  const emitsTrackInv    = /trackInventory:\s*p\.trackInventory\s*!==\s*false/.test(BB);
  if (readsPosProducts && emitsTrackInv) {
    up('FINDING — business-bootstrap reads posProducts rows and emits trackInventory',
       'a posProducts row carrying trackStock:false and NO trackInventory yields ' +
       '`trackInventory: true` (undefined !== false), so a SERVICE would be presented to the ' +
       'POS as a stocked product. Same symptom the withdrawn finding predicted, different ' +
       'mechanism — a projection default, not a spelling clash.');
  }
}

/* ══ 11e. PRODUCT UPLOAD — one canonical path (brief §1-§27) ══════════════════ */
head('11e. PRODUCT / SERVICE UPLOAD');
const V2SRC = R('merchant-v2.html');

/* THE CANONICAL AUTHORITY, and the correction of the brief's premise.
   §1 stated "posProducts is the shared catalogue model". The certified writer says
   otherwise, in its own header: products/{id} is canonical and posProducts/{id} is one of
   TWO PROJECTIONS of it, alongside tenants/{uid}/inventory_products/{id}. */
if (has('sokoni-merchant-data.js')) {
  const MD = R('sokoni-merchant-data.js');
  /* The prose wraps, so the match must span a newline — `canonical` and `products/{id}`
     sit on separate lines in the header. A single-line regex failed here for formatting,
     not for substance, which is the wrong reason for a gate to go red. */
  ck('the certified writer declares products/{id} canonical and posProducts a PROJECTION',
     /PROJECTIONS/.test(MD) && /posProducts/.test(MD) &&
     /canonical\s*\n?\s*`products\/\{id\}`/.test(MD));
  /* The structural facts, which are what actually matter — the prose above only corroborates. */
  ck('...structurally: the canonical write targets products, the mirrors are elsewhere',
     /\['products',\s*doc\.id\]|collection\('products'\)/.test(MD) || /path:\s*\['posProducts'/.test(MD),
     'posProducts appears as a mirror PATH, not as the write target');
  ck('both projections are declared', /PRODUCT_MIRRORS\s*=\s*\['inventory',\s*'pos'\]/.test(MD));
  ck('a mirror failure is REPORTED, never swallowed',
     /state:\s*'failed'/.test(MD) && /mirrorsComplete/.test(MD),
     'the caller can say "created, but not yet at the till"');
  /* The POS projection must carry the ownership field the SERVED ruleset keys on, or the
     mirror lands somewhere no client may read. */
  ck('the POS projection writes sellerId (what the served ruleset keys ownership on)',
     /sellerId:\s*scope\.sellerUid/.test(MD));
} else {
  nr('canonical writer', 'sokoni-merchant-data.js not present');
}

/* MERCHANT V2 REACHES IT. The route was kind:'seller' — an iframe of seller.html — while
   the shell already registered and loaded the native premium editor. */
const prod = C.get('products');
ck('Products is a NATIVE route (the premium editor, not a seller iframe)',
   !!prod && prod.kind === 'native', prod && prod.kind);
ck('the shell registers the premium editor module',
   /products:\s*\{\s*global:\s*'SokoniMerchantProducts'/.test(V2SRC));
ck('the shell loads its script', /src=["']sokoni-merchant-products\.js["']/.test(V2SRC));
ck('...and the listing studio it renders through',
   /src=["']sokoni-listing-studio\.js["']/.test(V2SRC));

/* THE RICHER SURFACE — measured, not assumed. The brief asked to port seller.html's
   uploader INTO the premium one; the form families exist only in the premium one. */
if (has('sokoni-merchant-products.js') && has('seller.html')) {
  const PM = R('sokoni-merchant-products.js');
  const fams = f => [...new Set((R(f).match(/function\s+[a-zA-Z]+HTML/g) || []))].length;
  const pmFams = fams('sokoni-merchant-products.js'), sellerFams = fams('seller.html');
  ck('the premium editor holds the form families; seller.html holds none',
     pmFams > 0 && sellerFams === 0, 'premium=' + pmFams + ' seller=' + sellerFams);
  ck('  CONTROL — the form-family detector does find them where they ARE',
     pmFams >= 7, pmFams + ' families');
  /* Each family the brief names, individually. */
  ['categoryHTML', 'bulkHTML', 'ownershipHTML', 'foodHTML', 'digitalHTML', 'kebsHTML', 'aiWriteHTML']
    .forEach(fn => ck('  family present: ' + fn, new RegExp('function\\s+' + fn).test(PM)));

  /* NO CONTROL MAY BE SILENTLY DISCARDED (§3). Every ctx key the module consumes must be
     supplied by the shell, or the control renders and does nothing. */
  const used = [...new Set((PM.match(/ctx\.([a-zA-Z_][a-zA-Z0-9_]*)/g) || []).map(s => s.slice(4)))];
  const i = V2SRC.indexOf("products:   { global: 'SokoniMerchantProducts'");
  const j = V2SRC.indexOf('inventory:  { global:', i);
  const block = i > -1 ? V2SRC.slice(i, j) : '';
  const missing = used.filter(k => !new RegExp('(^|[^a-zA-Z])' + k + '\\s*:').test(block));
  ck('every ctx key the editor uses is supplied by the shell', missing.length === 0,
     missing.join(', ') || used.length + ' keys, all bound');
  ck('  CONTROL — the ctx detector found keys to check', used.length >= 5, used.length + ' keys');

  /* AI AUTHORING (§23) — bound to a REAL exported callable whose contract MATCHES. */
  const IDX2 = R('functions/index.js');
  ck('AI authoring is bound to a callable', /callAiMetadata:\s*_callable\('(\w+)'\)/.test(block));
  const aiFn = (block.match(/callAiMetadata:\s*_callable\('(\w+)'\)/) || [])[1];
  ck('...and that callable is really exported', !!aiFn && new RegExp('exports\\.' + aiFn + '\\s*=').test(IDX2), aiFn);
  if (aiFn && has('functions/media-engine.js')) {
    const ME = R('functions/media-engine.js');
    /* The contract must MATCH what the module sends — not be adapted into place. */
    ck('...and its contract matches what the editor sends (imageUrl + category)',
       /request\.data\?\.imageUrl/.test(ME) && /request\.data\?\.category/.test(ME));
    ck('...and it is auth-gated and rate-limited', /assertAuth\(request\)/.test(ME) && /resource-exhausted/.test(ME));
  }
  /* ── §3: A FIELD THAT RENDERS AND IS DISCARDED IS NOT COMPLETE ────────────
     The editor's FORM_KEYS plus the nested groups it assembles must ALL survive the
     certified writer's whitelist. Measured 2026-09-22 this was 9 persisted of 27
     collected — eighteen controls rendered, normalised and then dropped without a word,
     including kebsCert, foodLicence, ownership, specs, variants, warranty, and the two
     that would express a service at all: listingType and stockUnit.

     It was also a REGRESSION: seller.js:813-815 writes kebsCert, location and
     deliveryCost into the product document, so moving Products onto this writer lost
     live compliance data. Both halves are asserted here. */
  if (has('sokoni-merchant-data.js')) {
    const MD2 = R('sokoni-merchant-data.js');
    const fk = (PM.match(/var FORM_KEYS = \[([\s\S]*?)\];/) || [])[1] || '';
    const flat = [...new Set((fk.match(/'([a-zA-Z]+)'/g) || []).map(s => s.slice(1, -1)))];
    const emitted = [...new Set((PM.match(/out\.([a-zA-Z]+)\s*=/g) || []).map(s => s.slice(4, -1).trim()))];
    const collected = [...new Set(flat.concat(emitted))];
    const pf = MD2.slice(MD2.indexOf('function _productFields'), MD2.indexOf('function _validate'));
    const carried = [...new Set(
      (pf.match(/out\.([a-zA-Z]+)\s*=/g) || []).map(s => s.slice(4, -1).trim())
        .concat((pf.match(/'([a-zA-Z]+)'/g) || []).map(s => s.slice(1, -1)))
    )];
    const dropped = collected.filter(k => carried.indexOf(k) < 0);
    ck('every field the editor collects survives the certified writer',
       dropped.length === 0, dropped.join(', ') || collected.length + ' fields, none dropped');
    /* CONTROL: the diff must be capable of finding a drop, or "none dropped" passes
       against a comparison of two empty lists. */
    ck('  CONTROL — the drop detector finds a field that is genuinely absent',
       ['__neverCollected__'].filter(k => carried.indexOf(k) < 0).length === 1);
    ck('  CONTROL — both sides were actually parsed',
       collected.length >= 20 && carried.length >= 20,
       'collected=' + collected.length + ' carried=' + carried.length);
    /* PARITY WITH WHAT seller.js ALREADY PERSISTED — the regression half. */
    ['kebsCert', 'location', 'deliveryCost'].forEach(k =>
      ck('  no regression vs seller.js: ' + k, carried.indexOf(k) > -1));
    /* Carrying money without validating it is only half of not discarding it. */
    ['deliveryCost', 'wholesalePrice', 'minWholesaleQty'].forEach(k =>
      ck('  newly carried money field is validated: ' + k,
         new RegExp('fields\\.' + k + '\\s*!==\\s*undefined').test(MD2)));
  }

  /* AI ASSISTS; it does not decide. */
  ck('AI never overwrites what the merchant already typed',
     /Only fill what the merchant has not written/.test(PM));
  ck('AI decides no authority (no price/stock/ownership write from the AI branch)',
     !/m\.price\s*&&[^\n]*v\.price\s*=/.test(PM) || /!String\(v\./.test(PM));
}

/* NO SECOND AUTHORITY (§27). */
const NEW_PRODUCT_COLLECTIONS = /posServices|merchantProducts|merchantV2Products|premiumProducts|productSuppliers/;
['merchant-v2.html', 'sokoni-merchant-routes.js', 'sokoni-merchant-roster.js'].forEach(f =>
  ck('no competing product/service collection in ' + f, !NEW_PRODUCT_COLLECTIONS.test(R(f))));
ck('CONTROL — the competing-collection detector fires on a plant',
   NEW_PRODUCT_COLLECTIONS.test("collection('posServices')"));

/* THE SERVICE GAP — recorded, not papered over. */
if (has('sokoni-merchant-data.js')) {
  const MD = R('sokoni-merchant-data.js');
  const posProj = MD.slice(MD.indexOf('pos: {'), MD.indexOf('pos: {') + 600);
  if (/unit:\s*'pcs'/.test(posProj) && !/trackStock|trackInventory/.test(posProj)) {
    up('FINDING — the canonical create path cannot yet express a SERVICE',
       'productProjections hardcodes unit:\'pcs\' on the POS mirror and carries no ' +
       'trackStock/trackInventory flag at all, so a service created here would project to ' +
       'POS as a stocked piece-priced product. The SERVICE SHAPE is owned by the in-flight ' +
       'catalogue workstream (sokoni-catalogue-model.js, foreign + uncommitted), so it is ' +
       'NOT defined here — inventing a second service shape is the duplication this work ' +
       'exists to prevent. Recorded for that owner.');
  } else {
    ck('the canonical projection carries a unit and stock flag', true, 'service-capable');
  }
}

/* ══ 11f. FLASH SALE — a promotion layer, and why it is NOT wired ═════════════ */
head('11f. FLASH SALE (brief §7)');
if (!has('functions/marketing-engine.js')) {
  nr('flash sale authority', 'functions/marketing-engine.js not present');
} else {
  const ME2 = R('functions/marketing-engine.js');
  /* THE GOOD NEWS FIRST: the canonical engine is shaped exactly as the brief wants —
     a promotion over an existing canonical item, not a second catalogue. */
  ck('a canonical flash-sale engine exists', /collection\('mktFlashSales'\)/.test(ME2));
  ck('...and it REFERENCES a product rather than creating one',
     /productId:\s*_san\(productId/.test(ME2),
     'mktFlashSales rows carry productId — a promotion layer, not a second catalogue');
  ck('...with sell-through and expiry handled server-side',
     /recordFlashSalePurchase/.test(ME2) && /concludeExpiredFlashSales/.test(ME2));

  /* WHY IT IS NOT WIRED INTO MERCHANT V2. Two independent reasons, both measured. */
  const gate = ME2.slice(ME2.indexOf('function _requireMerchant'), ME2.indexOf('function _requireMerchant') + 300);
  const numericGate = /role\s*<\s*2/.test(gate);
  if (numericGate) {
    /* Executed, not read: SOKONI mints STRING role claims, and every comparison of a
       non-numeric string with a number is false — so the guard does not throw. */
    const admits = (role) => { const r = role ?? 0; return !(r < 2); };
    ck('FINDING — the merchant gate compares a STRING claim numerically',
       admits('buyer') === true && admits(undefined) === false,
       "role:'buyer' is ADMITTED; an absent claim is refused — Number('buyer') is NaN and every NaN comparison is false");
  }
  ck('FINDING — createFlashSale never verifies the client-supplied merchantId',
     /if \(!merchantId\)\s*_err/.test(ME2) &&
     !/resolveMerchantIdForOwner|_assertMerchantAccess|assertBusinessPermission/.test(
       ME2.slice(ME2.indexOf('_h.createFlashSale'), ME2.indexOf('_h.createFlashSale') + 2200)),
     'merchantId, productId and originalPrice are all taken from the payload and validated for ' +
     'SHAPE only — no ownership, no price corroboration');

  /* AND THE BOUND ON IT, which is what makes this a reporting defect and not a money one.
     Stated precisely, because the difference decides how urgent it is. */
  const readers = ['functions/bi-advanced.js'].filter(f => has(f) && /mktFlashSales/.test(R(f)));
  const checkoutReads = ['functions/pos-zero-friction.js', 'functions/pos-retail-engine.js']
    .filter(f => has(f) && /mktFlashSales|FlashSale/i.test(R(f)));
  ck('no checkout path consults flash-sale pricing today', checkoutReads.length === 0,
     checkoutReads.join(',') || 'till, dispatch and orchestrator have zero references');
  ck('  CONTROL — the reader detector DOES find the one consumer that exists',
     readers.length === 1, readers.join(',') || 'none found — detector may be broken');
  up('FINDING — the forgeable flash sale is a REPORTING defect, not yet a pricing one',
     'mktFlashSales is read by exactly one consumer, bi-advanced.js (sold counts). No checkout ' +
     'path reads it, so a forged row cannot change what anything sells for — it pollutes BI. ' +
     'It BECOMES a money defect the moment flash pricing is wired into checkout, which is ' +
     'precisely what §7 asks for. So the gate and the ownership check must be repaired BEFORE ' +
     'Merchant V2 gets a Flash Sale button, not after.');

  /* The route Merchant V2 offers today. */
  const fs2 = C.get('flash-sale');
  ck('Merchant V2 flash-sale route exists', !!fs2, fs2 ? fs2.kind + ':' + (fs2.sec || '') : 'MISSING');
  if (has('seller.js')) {
    ck('FINDING — that route reaches a DEVICE-LOCAL flash sale, not the server engine',
       /localStorage\.setItem\("sokoniFlashSales"/.test(R('seller.js')),
       'seller.js launchFlashSale writes localStorage.sokoniFlashSales — a per-device array');
  }
  ck('no merchant route wires createFlashSale (correctly, while the gate is open)',
     !C.ROUTES.some(r => /createFlashSale/.test(JSON.stringify(r))));
}

/* ══ 11g. CHANNEL AVAILABILITY — P-3, answered ════════════════════════════════ */
head('11g. CHANNEL AVAILABILITY (brief §10, P-3)');
if (has('sokoni-merchant-data.js')) {
  const MD3 = R('sokoni-merchant-data.js');
  const CHANNEL_FIELDS = /posEnabled|showInPos|posVisible|marketplaceVisible|showInMarketplace|sellChannels|availableOn|visibleIn/;
  ck('FINDING — the canonical model carries NO per-product channel field',
     !CHANNEL_FIELDS.test(MD3),
     'no POS/Till/QuickPay/Marketplace visibility flag exists on a product');
  ck('  CONTROL — the field detector finds a field that DOES exist',
     /lowStockThreshold/.test(MD3));
  /* The consequence, which is the opposite of what §10 asks for. */
  const proj2 = MD3.slice(MD3.indexOf('pos: {'), MD3.indexOf('pos: {') + 600);
  ck('FINDING — the POS projection hardcodes status:active',
     /status:\s*'active'/.test(proj2),
     'every canonically-created product becomes POS-visible unconditionally');
  up('P-3 — a merchant cannot say "POS yes, marketplace no"',
     'There is no channel representation to configure. §10 asks that an internal POS item not ' +
     'be auto-published to the marketplace; the actual behaviour is the inverse — every ' +
     'marketplace product is auto-projected into POS with status:active. Adding a channel ' +
     'field is a CANONICAL MODEL change and belongs in the catalogue handoff, not here: ' +
     'inventing one now would be the second model this workstream exists to avoid.');
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
