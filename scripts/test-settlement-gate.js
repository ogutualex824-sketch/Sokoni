'use strict';
/* THE SETTLEMENT GATE (owner, 2026-10-01): a seller is credited only for an order SOKONI was paid for
   (paymentVerified, server-set), whose delivery the buyer proved (rider_pin | buyer_confirmation), and whose
   buyer is not the seller. Runs the REAL functions/order-settlement.js settleOrder against an in-memory
   Firestore. The settlement ENGINE is stubbed to a fixed 5% breakdown — this suite tests the gate, not rates.
     node scripts/test-settlement-gate.js            (this tree)
     BASE=<rev> node scripts/test-settlement-gate.js (the live 00065-fud baseline 106db63 must FAIL) */
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || path.join('C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules');
process.env.NODE_PATH = [NM, process.env.NODE_PATH || ''].join(path.delimiter); Module._initPaths();

let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };

/* ── load the module under test (this tree, or BASE's copy) with the engine stubbed ── */
const dir = process.env.BASE ? fs.mkdtempSync(path.join(os.tmpdir(), 'settle-')) : path.join(ROOT, 'functions');
if (process.env.BASE) fs.writeFileSync(path.join(dir, 'order-settlement.js'), execSync('git show ' + process.env.BASE + ':functions/order-settlement.js', { cwd: ROOT, encoding: 'utf8' }));
const enginePath = path.join(dir, 'settlement-engine.js');
if (process.env.BASE) fs.writeFileSync(enginePath, 'module.exports = {};');   /* resolvable; replaced by the stub below */
require.cache[enginePath] = { id: enginePath, filename: enginePath, loaded: true, exports: {
  computeSettlement: async (_db, o) => { ENGINE_CALLS++; const c = Math.round(o.grossCents * 0.05); return { sellerNetCents: o.grossCents - c, commission: { cents: c, rate: 0.05 }, ledgerPlan: [] }; },
} };
/* finos-utils.creditWalletTxn — stubbed with its exact write shape (identical in the webhook and this lineage) so the
   in-memory db can apply it; ENGINE_CALLS spies the rate engine (an escrow release must make none). */
let ENGINE_CALLS = 0;
const finosPath = path.join(dir, 'finos-utils.js');
if (process.env.BASE) fs.writeFileSync(finosPath, 'module.exports = {};');
require.cache[finosPath] = { id: finosPath, filename: finosPath, loaded: true, exports: {
  creditWalletTxn: (txn, _db, entityId, entityType, amountCents, o) => {
    txn.set({ path: 'wallets/' + entityId }, { entityId, entityType, availableBalance: { __inc: amountCents }, withdrawableBalance: { __inc: amountCents } }, { merge: true });
    txn.set({ path: 'finosTx/' + entityId + '_' + o.orderId }, { amountCents, orderId: o.orderId, type: o.type });
  } } };
const OS = require(path.join(dir, 'order-settlement.js'));

/* ── in-memory Firestore (enough for settleOrder) ── */
const DOCS = new Map(); let WRITES = []; let BEFORE_TXN = null;   /* runs once, between settleOrder's first read and its txn */
const INC = (n) => ({ __inc: n });
const apply = (prev, data, merge) => { const out = merge ? Object.assign({}, prev || {}) : {}; for (const [k, v] of Object.entries(data)) out[k] = (v && v.__inc !== undefined) ? (Number((prev || {})[k]) || 0) + v.__inc : v; return out; };
const ref = (p) => ({ path: p, get: async () => ({ exists: DOCS.has(p), data: () => DOCS.get(p) }) });
const db = { collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
  runTransaction: async (fn) => { if (BEFORE_TXN) { const h = BEFORE_TXN; BEFORE_TXN = null; h(); } const t = {
    get: async (r) => ({ exists: DOCS.has(r.path), data: () => DOCS.get(r.path) }),
    set: (r, d, o) => { WRITES.push(r.path); DOCS.set(r.path, apply(DOCS.get(r.path), d, o && o.merge)); },
    update: (r, d) => { WRITES.push(r.path); DOCS.set(r.path, apply(DOCS.get(r.path), d, true)); } };
    return fn(t); } };
const adminSdk = { firestore: { FieldValue: { serverTimestamp: () => 'TS', increment: INC, delete: () => undefined } } };

const SELLER = 'seller_1', BUYER = 'buyer_1';
const order = (id, o) => DOCS.set('orders/' + id, Object.assign({ status: 'completed', sellerUid: SELLER, buyerUid: BUYER, uid: BUYER, orderTotal: 1000, deliveryFee: 0 }, o));
const bal = (uid) => (DOCS.get('wallets/' + uid) || {}).balance || 0;
const reset = () => { DOCS.clear(); WRITES = []; };

(async () => {
  console.log('\nSettlement gate   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

  /* honest orders still settle, exactly once */
  reset(); order('o1', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin' });
  let r = await OS.settleOrder(db, adminSdk, 'o1'); const r2 = await OS.settleOrder(db, adminSdk, 'o1');
  ck('G1', r.outcome === 'settled' && bal(SELLER) === 950 && r2.outcome === 'already-settled' && bal(SELLER) === 950, 'paid + buyer PIN → seller credited ONCE (950 of 1000); a replay is a no-op', { r, r2, bal: bal(SELLER) });
  reset(); order('o1b', { paymentVerified: true, deliveryAuthorizedBy: 'buyer_confirmation' });
  r = await OS.settleOrder(db, adminSdk, 'o1b');
  ck('G2', r.outcome === 'settled' && bal(SELLER) === 950, 'paid + buyer confirmation → credited', r);

  /* THE EXPLOIT: unpaid, seller == buyer, "confirmed" by the same account, self-written total */
  reset(); order('x1', { sellerUid: 'mallory', buyerUid: 'mallory', uid: 'mallory', orderTotal: 1000000, deliveryAuthorizedBy: 'buyer_confirmation' });
  r = await OS.settleOrder(db, adminSdk, 'x1');
  ck('X-1', r.outcome === 'held' && bal('mallory') === 0 && !DOCS.has('walletTransactions/mallory_x1_ordersettle'), 'SELF-MINT: an unpaid self-dealt order "confirmed" by its own buyer credits NOTHING', { r, bal: bal('mallory') });
  ck('X-2', DOCS.get('orders/x1').settlementStatus === 'HELD' && DOCS.get('orders/x1').settlementNote === 'payment_not_verified_by_sokoni', 'it is HELD with a reason AdminOS can list (never a silent pass)', DOCS.get('orders/x1'));

  /* each gate condition on its own */
  reset(); order('g3', { paymentVerified: false, paymentAttestedBy: 'merchant', deliveryAuthorizedBy: 'buyer_confirmation' });
  r = await OS.settleOrder(db, adminSdk, 'g3');
  ck('G3', r.outcome === 'held' && r.reason === 'payment_not_verified_by_sokoni' && bal(SELLER) === 0, 'a merchant-ATTESTED cash order (the merchant holds the cash) is never credited into the wallet', r);
  reset(); order('g4', { paymentVerified: true });
  r = await OS.settleOrder(db, adminSdk, 'g4');
  ck('G4', r.outcome === 'held' && r.reason === 'awaiting_delivery_proof' && bal(SELLER) === 0, 'paid but NO buyer PIN / confirmation → held (seller money waits for the PIN)', r);
  reset(); order('g5', { paymentVerified: true, deliveryAuthorizedBy: 'admin_override' });
  r = await OS.settleOrder(db, adminSdk, 'g5');
  ck('G5', r.outcome === 'held' && r.reason === 'awaiting_delivery_proof', 'only rider_pin / buyer_confirmation count as proof (any other label is not)', r);
  reset(); order('g6', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin', buyerUid: SELLER, uid: SELLER });
  r = await OS.settleOrder(db, adminSdk, 'g6');
  ck('G6', r.outcome === 'held' && r.reason === 'self_dealing_review' && bal(SELLER) === 0, 'even PAID, a buyer == seller order is held for review, not auto-credited', r);
  reset(); order('g6b', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin', buyerUid: null, uid: null, userId: SELLER });
  r = await OS.settleOrder(db, adminSdk, 'g6b');
  ck('G6b', r.outcome === 'held' && r.reason === 'self_dealing_review', 'the buyer is resolved across buyerUid / uid / userId / customerUid', r);

  /* replay of a held order: still held, no credit, no write churn */
  reset(); order('g7', { paymentVerified: true });
  await OS.settleOrder(db, adminSdk, 'g7'); WRITES = [];
  r = await OS.settleOrder(db, adminSdk, 'g7');
  ck('G7', r.outcome === 'held' && WRITES.length === 0 && bal(SELLER) === 0, 'a held order replayed stays held and writes nothing', { r, WRITES });
  /* a held order whose proof later arrives settles on the next completion event */
  DOCS.set('orders/g7', Object.assign(DOCS.get('orders/g7'), { deliveryAuthorizedBy: 'rider_pin' }));
  r = await OS.settleOrder(db, adminSdk, 'g7');
  ck('G8', r.outcome === 'settled' && bal(SELLER) === 950, 'HELD is not terminal: once the proof is present the same order settles (once)', r);

  /* unchanged paths */
  reset(); order('g9', { settlementStatus: 'settled', paymentVerified: true });
  r = await OS.settleOrder(db, adminSdk, 'g9');
  ck('G9', r.outcome === 'already-settled' && bal(SELLER) === 0, 'an order already settled at payment (webhook) stays a no-op — no double credit', r);
  reset(); order('g10', { status: 'cancelled', paymentVerified: true, deliveryAuthorizedBy: 'rider_pin' });
  r = await OS.settleOrder(db, adminSdk, 'g10');
  ck('G10', r.outcome === 'terminal-skip' && bal(SELLER) === 0, 'cancelled stays a terminal skip (unchanged)', r);
  ck('G11', process.env.BASE ? true : (typeof OS.settlementHoldReason === 'function' && OS.settlementHoldReason({ paymentVerified: true, deliveryAuthorizedBy: 'rider_pin', buyerUid: 'b' }, 's') === null), 'settlementHoldReason is exported for AdminOS / tests');

  /* PAYMENT-TIME ESCROW RELEASE (owner 2026-10-01): "Payment determines the economic terms; verified completion
     determines when the already-recorded seller amount becomes withdrawable." */
  const avail = (uid) => (DOCS.get('wallets/' + uid) || {}).availableBalance || 0;
  const esc = (o) => Object.assign({ creditVia: 'finos', heldNetCents: 95000, commissionCents: 5000, grossCents: 100000, paymentRef: 'ref1', sellerUid: SELLER }, o);
  reset(); ENGINE_CALLS = 0; order('e1', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin', escrow: esc() });
  r = await OS.settleOrder(db, adminSdk, 'e1'); const e1r = await OS.settleOrder(db, adminSdk, 'e1');
  ck('E-1', r.outcome === 'settled' && avail(SELLER) === 95000 && bal(SELLER) === 0 && ENGINE_CALLS === 0 && e1r.outcome === 'already-settled' && avail(SELLER) === 95000,
    'OWNER INVARIANT 3: paid + PIN + buyer ≠ seller → EXACTLY the payment-time net (95000c) released ONCE; no rate recompute', { r, e1r, avail: avail(SELLER), bal: bal(SELLER), ENGINE_CALLS });
  ck('E-2', (DOCS.get('settlements/e1') || {}).source === 'payment_escrow' && DOCS.get('orders/e1').escrow.released === 95000 && ![...DOCS.keys()].some((k) => k.indexOf('ledger/e1') === 0),
    'settlement record says payment_escrow; escrow.released stamped; NO second commission ledger (recorded at payment)', DOCS.get('settlements/e1'));
  reset(); order('e3', { paymentVerified: true, escrow: esc() });
  r = await OS.settleOrder(db, adminSdk, 'e3');
  ck('E-3', r.outcome === 'held' && r.reason === 'awaiting_delivery_proof' && avail(SELLER) === 0, 'OWNER INVARIANT 2: paid + completed WITHOUT valid proof → the amount stays held', r);
  reset(); order('e3b', { deliveryAuthorizedBy: 'rider_pin', escrow: esc() });
  r = await OS.settleOrder(db, adminSdk, 'e3b');
  ck('E-3b', r.outcome === 'held' && avail(SELLER) === 0 && bal(SELLER) === 0, 'OWNER INVARIANT 1: UNPAID + completed + valid PIN → seller payout ZERO (even with an escrow field present)', r);
  reset(); ENGINE_CALLS = 0; order('e4', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin', escrow: esc({ sellerUid: 'someone_else' }) });
  r = await OS.settleOrder(db, adminSdk, 'e4');
  ck('E-4', r.outcome === 'held' && r.reason === 'escrow_invalid_review' && avail(SELLER) === 0 && bal(SELLER) === 0 && ENGINE_CALLS === 0,
    'an escrow recorded for ANOTHER seller is held for review — never re-settled by the engine into a different wallet', { r, ENGINE_CALLS });
  reset(); order('e5', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin', escrow: esc({ heldNetCents: 950.5 }) });
  r = await OS.settleOrder(db, adminSdk, 'e5');
  ck('E-5', r.outcome === 'held' && avail(SELLER) === 0 && bal(SELLER) === 0, 'a non-integer / non-positive escrow amount is never released', r);
  reset(); order('e6', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin', escrow: esc(), buyerUid: SELLER, uid: SELLER });
  r = await OS.settleOrder(db, adminSdk, 'e6');
  ck('E-6', r.outcome === 'held' && r.reason === 'self_dealing_review' && avail(SELLER) === 0, 'the gate runs BEFORE any release (self-dealt escrow held)', r);
  reset(); order('e7', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin', escrow: esc() });
  const par = await Promise.all([1, 2, 3].map(() => OS.settleOrder(db, adminSdk, 'e7')));
  ck('E-7', par.filter((x) => x.outcome === 'settled').length === 1 && avail(SELLER) === 95000, 'three concurrent completion events release ONCE', par.map((x) => x.outcome));

  /* the escrow CHANGES between settleOrder's first read and its transaction (a concurrent writer) */
  reset(); order('e8', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin', escrow: esc() });
  BEFORE_TXN = () => { const o = DOCS.get('orders/e8'); DOCS.set('orders/e8', Object.assign({}, o, { escrow: esc({ heldNetCents: 9999999 }) })); };
  r = await OS.settleOrder(db, adminSdk, 'e8');
  ck('E-8', r.outcome === 'held' && r.reason === 'escrow_changed_review' && avail(SELLER) === 0, 'an escrow amount that changed mid-settlement is held for review, never released at either value', r);
  reset(); order('e9', { paymentVerified: true, deliveryAuthorizedBy: 'rider_pin' });
  BEFORE_TXN = () => { const o = DOCS.get('orders/e9'); DOCS.set('orders/e9', Object.assign({}, o, { escrow: esc() })); };
  r = await OS.settleOrder(db, adminSdk, 'e9');
  ck('E-9', r.outcome === 'held' && avail(SELLER) === 0 && bal(SELLER) === 0, 'an escrow that APPEARS after the first read (engine already priced) is held, not paid twice ways', r);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
