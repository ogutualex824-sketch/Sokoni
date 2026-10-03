#!/usr/bin/env node
'use strict';
/* ============================================================================
   Service booking refund AFTER settlement — ledger reversal (owner 2026-10-03, relayed by sokoni-f3 / sokoni-5b)
   provider-ops.reverseServiceSettlement(bookingId, { decision:'refund_full', actor, reason })
     V1  only a SETTLED booking reverses (before settlement the held money is refunded, not reversed)
     V2  full reversal: providerPayouts reversal row negates gross / commission / net (SOKONI's 5% backed out — no
         second commission); original row marked reversed
     V3  provider business wallet debited exactly what settlement credited; deterministic walletTransaction
     V4  buyer refunded what the booking paid (price + fee snapshot) to the SOKONI wallet + one ledger row
     V5  provider already withdrew → balance goes negative, shortfall recorded (payouts refuse while below amount)
     V6  idempotent: a replay reverses nothing twice; a partial decision is refused (not decided)
   In-memory Firestore (all-or-nothing transactions, create() fails on existing). No network.
   NODE_PATH=<functions/node_modules> node scripts/test-service-settlement-reversal.js
   ============================================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-reversal-test' });   /* offline: nothing below touches the network */
const PO = require(path.join(ROOT, 'functions/provider-ops.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };

function fakeDb (seed) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const INC = Symbol('inc');
  const apply = (cur, patch) => { const o = Object.assign({}, cur || {}); for (const [k, v] of Object.entries(patch)) o[k] = (v && v[INC] !== undefined) ? (Number(o[k]) || 0) + v[INC] : v; return o; };
  const ref = (p) => ({ path: p, id: p.split('/').pop() });
  const db = {
    _docs: docs, inc: (n) => ({ [INC]: n }),
    collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
    async runTransaction (fn) {
      const w = [];
      const get = async (r) => { const d = docs.get(r.path); return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; };
      const t = {
        get,
        create: (r, v) => w.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, apply(null, v)); }),
        set: (r, v, o) => w.push(() => docs.set(r.path, apply(o && o.merge ? docs.get(r.path) : null, v))),
        update: (r, v) => w.push(() => docs.set(r.path, apply(docs.get(r.path), v))),
      };
      const out = await fn(t);
      const snap = new Map(docs);
      try { w.forEach((f) => f()); } catch (e) { docs.clear(); snap.forEach((v, k) => docs.set(k, v)); throw e; }
      return out;
    },
  };
  return db;
}
/* KES 2,000 booking (+ KES 0 fee), settled at 5%: commission KES 100, provider credited KES 1,900 */
const seed = (walletBal) => ({
  'providerBookings/bk_1': { providerId: 'prov_A', customerUid: 'buyer_1', price: 200000, fee: 0, heldAmount: 200000, paymentStatus: 'settled', status: 'completed', service: 'Plumbing' },
  'providerPayouts/bk_1': { providerId: 'prov_A', bookingId: 'bk_1', gross: 200000, commission: 10000, net: 190000, fee: 0, settlementCents: 190000, amount: 190000, status: 'settled', netShillingsCredited: 1900 },
  'wallets/prov_A': { balance: walletBal },
});
const run = async (db, o) => PO.reverseServiceSettlement('bk_1', Object.assign({ decision: 'refund_full', actor: 'admin_9', reason: 'service not delivered', deps: { db, inc: db.inc, ts: () => 'TS' } }, o || {}));

(async () => {
  let db = fakeDb(seed(1900));
  db._docs.set('providerBookings/bk_1', Object.assign(db._docs.get('providerBookings/bk_1'), { paymentStatus: 'paid_held' }));
  let r = await run(db);
  ck('V1 a booking that is still HELD is not reversed (refund the hold instead)', r.ok === false && r.code === 'not_settled', r);

  db = fakeDb(seed(1900));
  r = await run(db);
  const rev = db._docs.get('providerPayouts/bk_1_reversal');
  ck('V2 reversal row negates gross / commission / net — SOKONI 5% (KES 100) backed out, no second commission',
    r.ok && rev && rev.gross === -200000 && rev.commission === -10000 && rev.net === -190000 && rev.kind === 'reversal' && db._docs.get('providerPayouts/bk_1').status === 'reversed' && r.commissionReversedCents === 10000, { r, rev });
  ck('V3 provider wallet debited exactly what settlement credited (KES 1,900 → 0); deterministic walletTransaction',
    db._docs.get('wallets/prov_A').balance === 0 && db._docs.get('walletTransactions/prov_A_bk_1_bookingreverse').amount === -1900);
  ck('V4 buyer refunded KES 2,000 (what the booking paid) to the SOKONI wallet + one ledger row; booking refunded_after_settlement',
    db._docs.get('users/buyer_1').walletBalance === 2000 && db._docs.has('ledger/buyer_1_bk_1_booking_refund_after_settlement') && db._docs.get('providerBookings/bk_1').paymentStatus === 'refunded_after_settlement');

  db = fakeDb(seed(400));
  r = await run(db);
  ck('V5 provider already withdrew (balance KES 400): balance −1,500, shortfall KES 1,500 recorded (payouts refuse until repaid)',
    r.ok && db._docs.get('wallets/prov_A').balance === -1500 && r.clawbackShortfallShillings === 1500 && db._docs.get('providerPayouts/bk_1_reversal').clawbackShortfallShillings === 1500, r);

  db = fakeDb(seed(1900));
  await run(db);
  r = await run(db);
  ck('V6 replay → alreadyReversed, nothing debited or refunded twice', r.ok && r.alreadyReversed === true && db._docs.get('wallets/prov_A').balance === 0 && db._docs.get('users/buyer_1').walletBalance === 2000, r);
  r = await PO.reverseServiceSettlement('bk_1', { decision: 'refund_partial', deps: { db: fakeDb(seed(1900)) } });
  ck('V6b a partial refund after settlement is refused (not decided)', r.ok === false && r.code === 'decision_not_supported', r);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
