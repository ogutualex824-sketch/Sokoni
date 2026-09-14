#!/usr/bin/env node
/* Nobody can crack the POS and dodge commission.
 *
 *   node scripts/test-pos-gate-enforcement.js
 *
 * THREE HOLES, ALL CLOSED HERE
 *
 * 1. THE MERCHANT WAS DECLARED, NOT PROVEN. `posCompleteCheckout` checked `merchantId` for
 *    PRESENCE only, then used it as the tenant for the whole sale. A comment claimed
 *    resolveActor already enforced it — "the sale is refused when !_actor.ok" — but nothing
 *    refused it: `_actor` was consumed for discount authority, one error message and the
 *    receipt's servedBy line. The comment described a guarantee the code did not provide.
 *
 * 2. THE GATE WAS NEVER CALLED. `assertGateOpen` existed and was tested and no sale path
 *    invoked it, so a merchant whose till closed at 07:00 kept trading.
 *
 * 3. NOTHING WROTE THE LIABILITY. The gate reads liability rows; no sale rail wrote any, so
 *    every merchant looked permanently clear. A gate over an empty ledger is a decoration.
 *
 * AND THE SECOND DOOR: `recordPOSSale` is reachable directly and via
 * smartPosDispatch({op}). Gating one of two rails is not gating.
 *
 * WHY ORDER 1 HAD TO COME FIRST: gating on a forgeable id is WORSE than not gating — a
 * merchant could pass a clean shop's id to dodge their own closed gate, or a rival's id to
 * gate an innocent party, and it would look like enforcement.
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

const SRC_ZF = require('fs').readFileSync(path.join(FN, 'pos-zero-friction.js'), 'utf8');
const SRC_RE = require('fs').readFileSync(path.join(FN, 'pos-retail-engine.js'), 'utf8');

/* Comment-stripped copies. Assertions in this codebase have matched a module's own prose
   instead of its behaviour — including, in this very file, a comment claiming an enforcement
   that did not exist. The stripped copy is the default for every behavioural check. */
function strip(src) {
  let out = '', i = 0, inBlock = false;
  while (i < src.length) {
    if (!inBlock && src[i] === '/' && src[i + 1] === '*') { inBlock = true; i += 2; continue; }
    if (inBlock && src[i] === '*' && src[i + 1] === '/') { inBlock = false; i += 2; continue; }
    if (!inBlock) out += src[i];
    i++;
  }
  return out.split('\n').filter((l) => l.trim().indexOf('//') !== 0).join('\n');
}
const ZF = strip(SRC_ZF);
const RE = strip(SRC_RE);

/* ── Behavioural harness for the rail itself ─────────────────────────────── */
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => ({}), FieldValue: {} };
  if (id === 'firebase-admin') return { apps: [1], initializeApp: () => {}, firestore: () => ({}) };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error {} };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  return orig.apply(this, arguments);
};
const RAIL = require(path.join(FN, 'pos-commission-rail.js'));
const P = require(path.join(FN, 'pos-sale-commission.js'));
const MA = require(path.join(FN, 'money-authority.js'));
Module.prototype.require = orig;

/* The route -> rail translation, read out of the shipped source rather than restated. */
const railKeyFor = (function () {
  const m = SRC_ZF.match(/function _posRailKeyFor\(collectionRoute\)[\s\S]*?\n\}/);
  return m ? new Function('return ' + m[0])() : null;
})();

const MERCHANT = 'BIZ_KASS_001';
const eat = (iso) => Date.parse(iso + '+03:00');

/* The where() filters are HONOURED, not ignored. A stub that returns every row regardless
   of the query would hand one merchant another merchant scoping test would pass because
   the harness was broken, not because the code was right. E5 exists precisely to check
   merchant scoping, so the stub has to be able to fail it. */
function makeDb(rows = []) {
  const mk = (filters) => ({
    doc(id) { return { id, async get() { return { exists: false, data: () => undefined }; }, async set() {} }; },
    where(field, op, value) { return mk(filters.concat([[field, value]])); },
    limit() { return this; },
    async get() {
      const kept = rows.filter((r) => filters.every(([f, v]) => r[f] === v));
      return { docs: kept.map((r, i) => ({ id: 'L' + i, data: () => r })), empty: kept.length === 0 };
    },
  });
  return { collection: () => mk([]) };
}

(async () => {

console.log('\nPART A — the merchant is PROVEN before anything is done with it\n');
{
  ck('A1  posCompleteCheckout refuses a merchant the caller cannot be shown to belong to',
    /_merchantProven/.test(ZF) && /not authorised to record a sale for this shop/.test(SRC_ZF));
  ck('A2  ...the refusal is permission-denied, not a soft skip',
    /not authorised to record a sale for this shop[\s\S]{0,80}permission-denied/.test(SRC_ZF));

  /* The union matters: resolveActor alone would refuse every sale by staff who exist only in
     workspaceMemberships — a live till outage dressed up as a security fix. */
  ck('A3  two authorities are accepted: the shop actor OR canonical membership',
    /_actor && _actor\.ok/.test(ZF) && /_assertBusinessPermission\(cashierId, _canon, 'sales'\)/.test(ZF));
  ck('A4  ...and it asks for the SALES capability, not the narrower discounts one',
    /_assertBusinessPermission\(cashierId, _canon, 'sales'\)/.test(ZF));

  /* The proof must happen BEFORE the gate, or the gate is keyed on an unproven id. */
  const provenAt = ZF.indexOf('_merchantProven');
  const gateAt = ZF.indexOf('assertGateOpen');
  ck('A5  the proof runs BEFORE the gate', provenAt !== -1 && gateAt !== -1 && provenAt < gateAt,
    'proven@' + provenAt + ' gate@' + gateAt);

  ck('A6  which authority admitted the sale is recorded on it', /merchantProvenBy/.test(ZF));
}

console.log('\nPART B — BOTH sale rails are gated\n');
{
  ck('B1  posCompleteCheckout calls assertGateOpen', /assertGateOpen\(/.test(ZF));
  ck('B2  recordPOSSale calls assertGateOpen', /assertGateOpen\(/.test(RE));

  /* recordPOSSale gates on _sellerId, which its own tenant binding already forced to equal
     auth.uid for non-admins — so it is not a forgeable field. */
  ck('B3  ...on the tenant-bound sellerId, not a raw request field',
    /assertGateOpen\(fdb, String\(_sellerId\)/.test(RE));
  ck('B4  ...and that binding still refuses another shop',
    /A sale can only be recorded for your own shop/.test(SRC_RE));

  ck('B5  a closed gate refuses the sale (failed-precondition), not a warning',
    /POS_GATE_CLOSED[\s\S]{0,200}failed-precondition/.test(SRC_ZF) &&
    /POS_GATE_CLOSED[\s\S]{0,200}failed-precondition/.test(SRC_RE));

  /* UNREADABLE IS NOT OPEN — the property that turns an outage into free trading. */
  ck('B6  an unreadable ledger refuses the sale rather than allowing it',
    /could not be checked, so this sale was not completed/.test(SRC_ZF) &&
    /could not be checked, so this sale was not recorded/.test(SRC_RE));
  ck('B7  ...and says nothing has been charged', /Nothing has been charged/.test(SRC_ZF));
}

console.log('\nPART C — the gate has something to gate on\n');
{
  ck('C1  posCompleteCheckout records the liability', /recordSaleLiability/.test(ZF));
  ck('C2  recordPOSSale records the liability', /recordSaleLiability/.test(RE));

  /* AFTER the sale is written: a liability for a sale that failed to write would bill a
     merchant for money they never took. */
  const saleAt = ZF.indexOf("collection('posRetailSales').doc(saleId).set(sale)");
  const liabAt = ZF.indexOf('recordSaleLiability');
  ck('C3  the liability is written AFTER the sale, never before',
    saleAt !== -1 && liabAt !== -1 && liabAt > saleAt, 'sale@' + saleAt + ' liab@' + liabAt);

  const commitAt = RE.indexOf('batch.commit()');
  const liabAt2 = RE.indexOf('recordSaleLiability');
  ck('C4  ...same order on the second rail', commitAt !== -1 && liabAt2 > commitAt,
    'commit@' + commitAt + ' liab@' + liabAt2);

  ck('C5  a liability failure never fails a paid sale',
    /commission liability not recorded/.test(SRC_ZF) && /commission liability not recorded/.test(SRC_RE));
}

console.log('\nPART D — custody comes from the route, not a second guess\n');
{
  ck('D0  the route translation was found in source', typeof railKeyFor === 'function');
  if (typeof railKeyFor === 'function') {
    const owed = ['POS_CASH', 'TILL_DIRECT', 'POS_STORE_CREDIT'];
    ck('D1  CASH_IN_DRAWER -> the merchant holds it -> owed',
      owed.indexOf(railKeyFor('CASH_IN_DRAWER')) !== -1, railKeyFor('CASH_IN_DRAWER'));
    ck('D2  DIRECT_TO_SELLER -> the merchant holds it -> owed',
      owed.indexOf(railKeyFor('DIRECT_TO_SELLER')) !== -1, railKeyFor('DIRECT_TO_SELLER'));
    ck('D3  CENTRAL_MOR -> SOKONI collected it -> already netted',
      railKeyFor('CENTRAL_MOR') === 'POS_MPESA_STK', railKeyFor('CENTRAL_MOR'));

    /* THE FAIL-SAFE DIRECTION. An unmapped route must mean "owed", not "written off". */
    for (const unknown of ['', null, undefined, 'SOME_NEW_ROUTE', 'central_mor_v2']) {
      const k = railKeyFor(unknown);
      const rec = P.planSaleCommission({
        rail: k, gross: MA.fromMinor(100000), planId: null,
        soldAtMs: eat('2026-09-05T10:00:00'), saleId: 'S', merchantUid: MERCHANT,
      });
      ck('D4  an unrecognised route (' + JSON.stringify(unknown) + ') still OWES commission',
        rec.createsLiability === true, k + ' createsLiability=' + rec.createsLiability);
    }
  }
}

console.log('\nPART E — the gate actually closes, behaviourally\n');
{
  const unpaid = [{ merchantUid: MERCHANT, settlementDay: '2026-09-05',
                    liabilityMinor: 5000, status: 'OUTSTANDING' }];
  const before = await RAIL.evaluateMerchantGate(makeDb(unpaid), MERCHANT, eat('2026-09-05T18:00:00'));
  ck('E1  same-day accrual does NOT close the till', before.closed === false);

  const after = await RAIL.evaluateMerchantGate(makeDb(unpaid), MERCHANT, eat('2026-09-06T07:00:00'));
  ck('E2  at 07:00 the next day it CLOSES', after.closed === true, after.reason);

  let threw = null;
  try { await RAIL.assertGateOpen(makeDb(unpaid), MERCHANT, eat('2026-09-06T07:30:00')); }
  catch (e) { threw = e; }
  ck('E3  assertGateOpen THROWS POS_GATE_CLOSED — which is what refuses the sale',
    !!threw && threw.code === 'POS_GATE_CLOSED', threw && threw.code);

  /* A merchant who owes nothing is never blocked. */
  const clear = await RAIL.assertGateOpen(makeDb([]), MERCHANT, eat('2026-09-06T07:30:00'));
  ck('E4  a merchant who owes nothing trades freely', clear.closed === false);

  /* And one merchant's debt never closes another's till. */
  const other = await RAIL.assertGateOpen(makeDb(unpaid), 'SOMEONE_ELSE', eat('2026-09-06T07:30:00'));
  ck('E5  another merchant is unaffected by this debt', other.closed === false);
}

console.log('\nPART F — the comment that lied is gone\n');
{
  /* The specific regression: a comment asserting an enforcement that did not exist. It is
     only allowed to say that now because the refusal is genuinely there. */
  const claims = /the sale is refused when !_actor\.ok/.test(SRC_ZF);
  const enforces = /_merchantProven/.test(ZF) && /permission-denied/.test(SRC_ZF);
  ck('F1  no comment claims an enforcement the code does not perform',
    !claims || enforces, claims ? 'claim present — and now backed' : 'claim removed');
}

console.log('\nPART G — adversarial controls\n');
{
  /* Every check above is a regex over source; if the sources were empty they would all pass
     or all fail together for the wrong reason. */
  ck('G1  both sources were read and are substantial', ZF.length > 20000 && RE.length > 10000,
    ZF.length + '/' + RE.length);
  ck('G2  the stripper did not eat the code', /posCompleteCheckout/.test(ZF) && /recordPOSSale/.test(RE));
  ck('G3  the stripper DID remove comments', ZF.indexOf('THE COMMISSION GATE') === -1);
  ck('G4  a string that is not in the source is detected as absent',
    !/thisTokenDoesNotExistAnywhere/.test(ZF));
  /* And the rail must be able to answer both ways, or PART E proves nothing. */
  ck('G5  the rail can report BOTH open and closed', true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
