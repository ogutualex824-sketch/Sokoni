#!/usr/bin/env node
/* Manager approval now GATES a refund — the first mutation that actually spends one.
 *
 *   node scripts/test-refund-approval-gate.js
 *
 * WHAT WAS BROKEN
 * `_consumeApproval` (functions/pos-staff-ops.js) has been complete for weeks —
 * transactional, replay-safe, binding-checked, shop-scoped — and had ZERO CALL SITES. Its
 * own comment said so: "NOTHING CONSUMES ONE YET... manager approval is not enforceable
 * end-to-end until they do."
 *
 * So the Sales Control Centre could show a manager approving a refund, record the decision,
 * and authorise nothing. The refund proceeded on `_assertRefundAuthority` alone, approved or
 * not. An approval that gates nothing is theatre — the same shape as the delivery PIN that
 * was securely issued and released no money.
 *
 * THE PROPERTY THAT MATTERS MOST — and the one a comment cannot establish:
 * the approval is CONSUMED BEFORE the refund is written. The other order refunds first and
 * then tries to spend the approval, so a failure between the two returns money on an
 * authorisation nobody verified. This order fails the safe way: a burned approval on a
 * refund that did not happen, which a manager can re-approve.
 *
 * OPTIONAL BY DESIGN. Refund authority is unchanged — a manager may still refund directly.
 * What changed is that a presented approval is now verified and spent. Making it mandatory
 * is a policy decision with a live blast radius and is not made here.
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

/* ── A Firestore with transactions, shared by both modules ───────────────── */
const DOCS = new Map();
let FAIL_REFUND_WRITE = false;

class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

function makeDb() {
  const coll = (name) => ({
    doc(id) {
      const key = name + '/' + id;
      return {
        _key: key, id,
        async get() {
          const d = DOCS.get(key);
          return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) };
        },
        async set(v) { DOCS.set(key, Object.assign({}, v)); },
        async update(v) { DOCS.set(key, Object.assign({}, DOCS.get(key) || {}, v)); },
      };
    },
    where() { return this; },
    limit() { return this; },
    async get() { return { empty: true, docs: [], forEach() {} }; },
  });
  return {
    collection: coll,
    async runTransaction(fn) {
      const writes = [];
      const txn = {
        async get(ref) { return ref.get(); },
        set(ref, v) { writes.push([ref._key, v, false]); },
        update(ref, v) { writes.push([ref._key, v, true]); },
        /* real Firestore transactions have create() (fails if the doc exists); the shared restore writes its ledger row with it */
        create(ref, v) { if (DOCS.has(ref._key)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push([ref._key, v, false]); },
      };
      const out = await fn(txn);
      /* Simulate the refund write failing AFTER the approval was already consumed by its
         own transaction — the exact window the ordering property is about. */
      if (FAIL_REFUND_WRITE && writes.some(([k]) => k.indexOf('posRefunds/') === 0)) {
        throw new Error('simulated write failure');
      }
      for (const [key, v, merge] of writes) {
        DOCS.set(key, merge ? Object.assign({}, DOCS.get(key) || {}, v) : Object.assign({}, v));
      }
      return out;
    },
  };
}
const DB = makeDb();

const FieldValue = {
  serverTimestamp: () => 'TS',
  increment: (n) => ({ __inc: n }),
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } };
  if (id === 'firebase-admin') return { apps: [1], initializeApp: () => {}, auth: () => ({}), firestore: Object.assign(() => DB, { FieldValue, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } }) };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  /* merchant-identity is REAL here as of 2026-09-07 — restored from the deployed canonical
     blob ccc43cf and verified by hash. The stub that stood here is gone. */
  return orig.apply(this, arguments);
};

let STAFF, ZF, loadErr = null;
try {
  STAFF = require(path.join(FN, 'pos-staff-ops.js'));
  ZF = require(path.join(FN, 'pos-zero-friction.js'));
} catch (e) { loadErr = e; }
Module.prototype.require = orig;

const MERCHANT = 'BIZ_KASS_001';
const MANAGER  = 'MGR_uid_991';
const CASHIER  = 'CSH_uid_442';
const SALE     = 'SALE_0001';

const auth = { uid: MANAGER, token: { posRole: 'manager' } };

function reset() {
  DOCS.clear();
  FAIL_REFUND_WRITE = false;
  DOCS.set('businesses/' + MERCHANT, { ownerId: MANAGER });
  DOCS.set('posRetailSales/' + SALE, {
    merchantId: MERCHANT, status: 'completed', branchId: 'default',
    items: [{ productId: 'P1', qty: 2, unitPrice: 100 }],
  });
  DOCS.set('products/P1', { stock: 5, trackInventory: true });
}

function seedApproval(id, over = {}) {
  DOCS.set('posApprovals/' + id, Object.assign({
    sellerId: MERCHANT, type: 'refund', status: 'approved',
    binding: { saleId: SALE, amount: 200 },
    reviewedBy: MANAGER, requestedBy: CASHIER, expiresAt: null,
  }, over));
}

const refund = (over = {}) => ZF.posProcessRefund({
  data: Object.assign({
    saleId: SALE, items: [{ productId: 'P1', qty: 2 }], reason: 'damaged',
    merchantId: MERCHANT, idempotencyKey: 'K' + Math.random().toString(36).slice(2),
  }, over),
  auth,
});

(async () => {

ck('S0  both modules load against the stubbed runtime', !loadErr, loadErr && loadErr.message);
if (loadErr) { console.log('\nCANNOT PROCEED.\n'); process.exit(1); }
/* The dependency that was missing is now PRESENT. Asserted so a regression is caught rather
   than silently re-stubbed — the stub is gone and must stay gone. */
const MI_PRESENT = require('fs').existsSync(path.join(FN, 'merchant-identity.js'));
ck('S2  functions/merchant-identity.js is PRESENT — no stub needed', MI_PRESENT === true,
  MI_PRESENT ? 'real module in use' : 'ABSENT — pos-zero-friction cannot load');
ck('S1  the approval primitive is reachable from the refund module\'s dependency',
  !!(STAFF._approvals && typeof STAFF._approvals.consume === 'function'));

console.log('\nPART A — nothing breaks for callers that present no approval\n');
{
  reset();
  const r = await refund();
  ck('A1  a manager can still refund directly', !!r && r.refundTotal === 200, r && String(r.refundTotal));
  const rec = [...DOCS.keys()].find((k) => k.indexOf('posRefunds/') === 0);
  ck('A2  ...the refund is recorded', !!rec);
  ck('A3  ...and approvalId is null — honest, not unknown',
    DOCS.get(rec).approvalId === null, String(DOCS.get(rec).approvalId));
  /* 2026-10-03: the shared restore writes the absolute result read in-transaction (5 + 2), not an increment sentinel. */
  ck('A4  ...stock is returned', DOCS.get('products/P1').stock === 7,
    JSON.stringify(DOCS.get('products/P1').stock));
}

console.log('\nPART B — a presented approval is VERIFIED and SPENT\n');
{
  reset(); seedApproval('APV_1');
  const r = await refund({ approvalId: 'APV_1' });
  ck('B1  the refund proceeds', !!r && r.refundTotal === 200);
  ck('B2  the approval is CONSUMED, not merely read',
    DOCS.get('posApprovals/APV_1').status === 'consumed',
    DOCS.get('posApprovals/APV_1').status);
  ck('B3  ...recording who spent it', DOCS.get('posApprovals/APV_1').consumedBy === MANAGER);
  const rec = DOCS.get([...DOCS.keys()].find((k) => k.indexOf('posRefunds/') === 0));
  ck('B4  the refund records which approval authorised it', rec.approvalId === 'APV_1', rec.approvalId);
  ck('B5  ...and who approved and who requested', rec.approvedBy === MANAGER && rec.requestedBy === CASHIER,
    rec.approvedBy + '/' + rec.requestedBy);
}

console.log('\nPART C — an approval authorises ONE operation, at ONE amount\n');
{
  const cases = [
    ['a different amount',    { binding: { saleId: SALE, amount: 2000 } }],
    ['a different sale',      { binding: { saleId: 'SALE_OTHER', amount: 200 } }],
    ['another shop',          { sellerId: 'BIZ_OTHER' }],
    ['a different operation', { type: 'void' }],
    ['still pending',         { status: 'pending' }],
    ['already consumed',      { status: 'consumed' }],
    ['rejected',              { status: 'rejected' }],
    ['expired',               { expiresAt: new Date(Date.now() - 60000) }],
  ];
  for (const [label, over] of cases) {
    reset(); seedApproval('APV_X', over);
    let threw = null;
    try { await refund({ approvalId: 'APV_X' }); } catch (e) { threw = e; }
    ck('C1  ' + label + ' -> REFUSED', !!threw, threw && (threw.code || threw.message));
    ck('C2  ' + label + ' -> and NO refund was written',
      ![...DOCS.keys()].some((k) => k.indexOf('posRefunds/') === 0));
    ck('C3  ' + label + ' -> and the sale is NOT marked refunded',
      DOCS.get('posRetailSales/' + SALE).status !== 'refunded');
  }
}
{
  reset();
  let threw = null;
  try { await refund({ approvalId: 'APV_MISSING' }); } catch (e) { threw = e; }
  ck('C4  an approval id that does not exist -> REFUSED', !!threw, threw && threw.code);
}

console.log('\nPART D — THE ORDER: consumed BEFORE the refund is written\n');
{
  /* The refund write fails. If consumption happened FIRST (correct), the approval is spent
     and no refund exists — recoverable by re-approving, and money never moved on an
     unverified authorisation. If the refund were written first, this test could not
     distinguish the two, so the failure is injected at the refund write specifically. */
  reset(); seedApproval('APV_ORD');
  FAIL_REFUND_WRITE = true;
  let threw = null;
  try { await refund({ approvalId: 'APV_ORD' }); } catch (e) { threw = e; }
  FAIL_REFUND_WRITE = false;

  ck('D1  a failing refund write surfaces as an error', !!threw, threw && threw.message);
  ck('D2  the approval WAS already consumed — proving consumption ran first',
    DOCS.get('posApprovals/APV_ORD').status === 'consumed',
    DOCS.get('posApprovals/APV_ORD').status);
  ck('D3  ...and NO refund record exists', ![...DOCS.keys()].some((k) => k.indexOf('posRefunds/') === 0));
  ck('D4  ...and the sale was NOT marked refunded',
    DOCS.get('posRetailSales/' + SALE).status !== 'refunded');
  ck('D5  ...so no money moved on an unverified approval — the safe failure',
    DOCS.get('posApprovals/APV_ORD').status === 'consumed'
    && ![...DOCS.keys()].some((k) => k.indexOf('posRefunds/') === 0));
}

console.log('\nPART E — the amount comes from the SALE, never from the caller\n');
{
  /* A caller inflating the refund must not be able to make the approval appear to cover it:
     the bound amount is recomputed from the original sale's own unit prices. */
  reset(); seedApproval('APV_AMT', { binding: { saleId: SALE, amount: 999999 } });
  let threw = null;
  try { await refund({ approvalId: 'APV_AMT', amount: 999999, refundTotal: 999999 }); }
  catch (e) { threw = e; }
  ck('E1  a caller-supplied total cannot satisfy an inflated approval', !!threw,
    threw && (threw.code || threw.message));
  ck('E2  ...the approval was NOT consumed', DOCS.get('posApprovals/APV_AMT').status === 'approved',
    DOCS.get('posApprovals/APV_AMT').status);

  /* And a partial refund binds to the partial amount, not the whole sale. */
  reset(); seedApproval('APV_HALF', { binding: { saleId: SALE, amount: 100 } });
  const r = await refund({ approvalId: 'APV_HALF', items: [{ productId: 'P1', qty: 1 }] });
  ck('E3  a partial refund binds to its own amount', !!r && r.refundTotal === 100, r && String(r.refundTotal));
  ck('E4  ...and consumes the approval', DOCS.get('posApprovals/APV_HALF').status === 'consumed');
}

console.log('\nPART F — adversarial controls\n');
{
  /* If the harness could not produce a successful refund, every "refused" assertion above
     would pass for the wrong reason. */
  reset(); seedApproval('APV_OK');
  const r = await refund({ approvalId: 'APV_OK' });
  ck('F1  the harness CAN complete an approved refund', !!r && r.refundTotal === 200);

  /* And it must be able to refuse — from the same fixture with one field changed. */
  reset(); seedApproval('APV_BAD', { status: 'pending' });
  let threw = null;
  try { await refund({ approvalId: 'APV_BAD' }); } catch (e) { threw = e; }
  ck('F2  ...and refuse one, from the same fixture minus the approval', !!threw);

  /* The consume primitive must genuinely be the thing refusing — not a coincidence. */
  reset(); seedApproval('APV_REPLAY');
  await refund({ approvalId: 'APV_REPLAY' });
  const saleDoc = DOCS.get('posRetailSales/' + SALE);
  DOCS.set('posRetailSales/' + SALE, Object.assign({}, saleDoc, { status: 'completed' }));
  let threw2 = null;
  try { await refund({ approvalId: 'APV_REPLAY', idempotencyKey: 'DIFFERENT' }); }
  catch (e) { threw2 = e; }
  ck('F3  a SECOND refund cannot reuse the same approval', !!threw2, threw2 && threw2.code);
  ck('F4  ...reported as already-used, distinctly from never-approved',
    !!threw2 && /already been used/i.test(threw2.message), threw2 && threw2.message);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
