'use strict';
/**
 * CERTIFICATION — M0-3: POS commission settles through ONE state machine (owner ruling 2026-09-28).
 *
 *   posCommissionLiabilities (the ONLY debt) ─▶ attempt posCommissionPayments/{payId} over a FROZEN set of debts
 *                                           ─▶ claim posCommissionSettlementClaims/{debtId} (create()-only)
 *                                           ─▶ SETTLED once, only on PROVEN money
 *   methods: IntaSend STK · IntaSend hosted checkout (card + every account-enabled method; card data never
 *   touches SOKONI) · cash (a SOKONI admin who is not the requester confirms, with a receipt number)
 *
 * NOTHING IS SENT. `https.request` is replaced IN-PROCESS by a scripted IntaSend double before any module loads;
 * the suite refuses to run if the double is not the transport in use, and any unscripted request fails the suite.
 * Runs the REAL callables against the Firestore EMULATOR.
 *
 * Pointed at the pre-M0-3 tree (REPAIR_ROOT = export of 8fc7ce2) there is no settlement authority at all, and the
 * old day-based rail.applySettlement lets two payments settle the SAME debt (L-1).
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const EventEmitter = require('events');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-m03-pay';
process.env.INTASEND_PRIVATE_KEY = 'test-only-private';        /* read by defineSecret().value() off-platform */
delete process.env.INTASEND_PUBLISHABLE_KEY;
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 280s\n'); process.exit(3); }, 280000);

/* ── the IntaSend double ─────────────────────────────────────────────────────────────────────────── */
const https = require('https');
const CALLS = [];
const SCRIPT = { stk: [], checkout: [], status: {} };     /* status keyed by invoice id → queue of bodies */
let UNSCRIPTED = 0;
https.request = function (opts, cb) {
  const req = new EventEmitter(); let body = '';
  req.write = (c) => { body += c; }; req.setTimeout = () => req;
  req.end = () => setImmediate(() => {
    const call = { host: opts.hostname, path: opts.path, headers: Object.assign({}, opts.headers), body: body ? JSON.parse(body) : null };
    CALLS.push(call);
    let reply = null;
    if (opts.path === '/api/v1/payment/mpesa-stk-push/') reply = SCRIPT.stk.shift();
    else if (opts.path === '/api/v1/checkout/') reply = SCRIPT.checkout.shift();
    else if (opts.path === '/api/v1/payment/status/') { const q = SCRIPT.status[call.body && call.body.invoice_id] || []; reply = q.length > 1 ? q.shift() : q[0]; }
    if (!reply) { UNSCRIPTED++; req.emit('error', new Error('UNSCRIPTED IntaSend call ' + opts.path)); return; }
    if (reply.throw) { req.emit('error', new Error(reply.throw)); return; }
    const res = new EventEmitter(); res.statusCode = reply.status;
    cb(res); res.emit('data', JSON.stringify(reply.body || {})); res.emit('end');
  });
  return req;
};
if (require('https').request !== https.request) { console.log('  ✖ SETUP — the IntaSend double is not installed'); process.exit(2); }

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr), cw: console.warn, ce: console.error, cl: console.log };
let _q = 0;
async function quiet(fn) {
  if (_q++ === 0) { process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {}; }
  try { return await fn(); } finally { if (--_q === 0) { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; } }
}
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const why = (r) => (r.ok ? 'OK ' + JSON.stringify(r.out).slice(0, 110) : 'refused [' + r.code + ']: ' + r.msg.slice(0, 80));

let RAIL, PS = null;
try { RAIL = require(path.join(FN, 'pos-commission-rail.js')); } catch (e) { console.log('  ✖ SETUP — ' + e.message); process.exit(2); }
try { PS = require(path.join(FN, 'pos-commission-settlement.js')); } catch (e) { PS = null; }
const P = require(path.join(FN, 'pos-sale-commission.js')); const MA = require(path.join(FN, 'money-authority.js'));
const REQ = (uid, data, token) => ({ data, auth: uid ? { uid, token: Object.assign({ uid }, token || {}) } : null, rawRequest: { headers: {} }, acceptsStreaming: false });
const call = (name, uid, data, token) => (PS ? res(quiet(() => PS._h[name](REQ(uid, data, token)))) : Promise.resolve({ ok: false, code: 'absent', msg: 'no settlement authority in this tree' }));
/* Null-safe: a missing precondition (e.g. an attempt a mutant never created) must become a FAIL for that test,
   never a crash of the whole run — a crash is not a refusal. */
const debt = async (id) => { if (!id) return {}; const s = await db.collection('posCommissionLiabilities').doc(id).get(); return s.exists ? s.data() : {}; };
const payDoc = async (id) => { if (!id) return {}; const s = await db.collection('posCommissionPayments').doc(id).get(); return s.exists ? s.data() : {}; };
const upd = async (id, v) => { if (!id) return; const r = db.collection('posCommissionPayments').doc(id); if ((await r.get()).exists) await r.update(v); };
const claimsOf = async (payId) => !payId ? [] : (await db.collection('posCommissionSettlementClaims').where('payId', '==', payId).get()).docs.map((d) => d.data());
const stkCalls = () => CALLS.filter((c) => c.path === '/api/v1/payment/mpesa-stk-push/');
const sale = (sid, uid, kes) => RAIL.recordSaleLiability(db, P.planSaleCommission({ rail: 'POS_CASH', gross: MA.fromMinor(Math.round(kes * 100)), planId: null, soldAtMs: Date.now(), saleId: sid, merchantUid: uid }));
const COMPLETE = (payId, kes) => ({ status: 200, body: { invoice: { invoice_id: 'INV-' + String(payId || '').slice(-6), state: 'COMPLETE', api_ref: payId, value: kes, currency: 'KES', provider: 'M-PESA' } } });

(async () => {
  process.stdout.write(`\nM0-3 — POS commission settles through ONE state machine   (tree: ${ROOT})\n\n`);
  const OWNER = 'm03-owner', FIN = 'm03-fin', CASHIER = 'm03-cashier', LONE = 'm03-lone', ADMIN = 'm03-admin', OTHER = 'm03-other';
  await db.collection('businesses').doc('SOK-M03-A').set({ ownerId: OWNER, name: 'A Ltd', status: 'active' });
  await db.collection('businesses').doc('SOK-M03-B').set({ ownerId: OTHER, name: 'B Ltd', status: 'active' });
  await db.collection('workspaceMemberships').doc(FIN + '_SOK-M03-A').set({ uid: FIN, businessId: 'SOK-M03-A', status: 'active', permissions: ['finance'] });
  await db.collection('workspaceMemberships').doc(CASHIER + '_SOK-M03-A').set({ uid: CASHIER, businessId: 'SOK-M03-A', status: 'active', permissions: ['pos', 'sales'] });
  for (const [sid, kes] of [['A1', 1000], ['A2', 201], ['A3', 20]]) await sale('m03-' + sid, OWNER, kes);   /* 5000 + 1005 + 1000 = 7005 minor */
  await sale('m03-B1', OTHER, 1000);
  await sale('m03-L1', LONE, 1000);                                                                        /* no business → unresolved */
  const A = ['poscomm_m03-A1', 'poscomm_m03-A2', 'poscomm_m03-A3'];
  const dA = await debt(A[0]);
  ok(!!dA && dA.businessId === 'SOK-M03-A' && (await debt('poscomm_m03-L1')).businessUnresolved === true, 'C-0',
    'fixtures: three debts owned by SOK-M03-A (7005 minor), one of another business, one unresolved — made by the M0-1 rail itself');

  process.stdout.write('\n[L] the legacy day-based settle path\n');
  { await sale('m03-LEG1', 'm03-legacy', 1000);
    const day = (await debt('poscomm_m03-LEG1')).settlementDay;
    const rs = await Promise.all([res(RAIL.applySettlement(db, { merchantUid: 'm03-legacy', settlementDays: [day], settlementRef: 'PAY-X', method: 'MPESA', nowMs: Date.now() })),
                                  res(RAIL.applySettlement(db, { merchantUid: 'm03-legacy', settlementDays: [day], settlementRef: 'PAY-Y', method: 'MPESA', nowMs: Date.now() }))]);
    const both = rs.filter((r) => r.ok).length;
    ok(both === 0 && rs.every((r) => r.code === 'SETTLEMENT_RETIRED'), 'L-1',
      'two payments with different refs can NOT both "settle" one debt through the old path — it is retired: ' + rs.map(why).join(' | ')); }

  if (!PS) {
    /* No settlement authority in this tree: every remaining property is ABSENT — reported as a failure,
       never a crash (a crash is not a refusal). */
    for (const id of ['O-1', 'O-2', 'O-3', 'O-4', 'O-5', 'O-6', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6', 'F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6', 'F-7', 'K-1', 'K-2', 'K-3', 'X-1', 'X-2', 'X-3', 'X-4', 'X-5']) {
      ok(false, id, 'no single settlement authority exists in this tree (pos-commission-settlement absent)');
    }
    ok(RAIL.GATE_ENFORCED === false, 'G-1', 'the till gate is still OFF (P0): GATE_ENFORCED=' + RAIL.GATE_ENFORCED);
    ok(UNSCRIPTED === 0, 'G-2', 'no unscripted outbound call: ' + UNSCRIPTED);
    process.stdout.write(`\n${pass} pass / ${fail} fail\n`); clearTimeout(WATCHDOG); process.exit(fail ? 1 : 0);
  }

  process.stdout.write('\n[O] opening a payment — frozen debts, one claim each\n');
  let pay1;
  { SCRIPT.stk.push({ status: 200, body: { invoice: { invoice_id: 'INV-STK-1' } } });
    const r = await call('posCommissionPayNow', OWNER, { businessId: 'SOK-M03-A', method: 'INTASEND_STK', phone: '254700000001', idempotencyKey: 'pay-key-0001' });
    pay1 = r.ok && r.out.payId;
    const pd = pay1 ? await payDoc(pay1) : null; const cl = pay1 ? await claimsOf(pay1) : [];
    const stk = stkCalls().slice(-1)[0];
    ok(r.ok && pd && pd.totalMinor === 7005 && pd.chargedMinor === 7100 && pd.roundingMinor === 95 && (pd.debtIds || []).length === 3 && cl.length === 3
      && stk && stk.body.api_ref === pay1 && stk.body.amount === 71 && /^Bearer /.test(stk.headers.Authorization) && (await debt(A[0])).status === 'OUTSTANDING', 'O-1',
      'Pay Now freezes the exact debts (3, 7005 minor from the debts themselves), charges whole shillings (71 = 7100, rounding 95 recorded), holds one claim per debt, sends ONE STK to SOKONI with api_ref = payId — and settles NOTHING yet: ' + why(r)); }
  { const n0 = stkCalls().length;
    const r = await call('posCommissionPayNow', OWNER, { businessId: 'SOK-M03-A', method: 'INTASEND_STK', phone: '254700000001', idempotencyKey: 'pay-key-0001' });
    ok(r.ok && r.out.payId === pay1 && r.out.replayed === true && stkCalls().length === n0 && (await claimsOf(pay1)).length === 3, 'O-2',
      'the same idempotency key → the SAME attempt, no second STK, no new claims: ' + why(r)); }
  { const n0 = stkCalls().length;
    const r = await call('posCommissionPayNow', FIN, { businessId: 'SOK-M03-A', method: 'INTASEND_STK', phone: '254700000002', idempotencyKey: 'pay-key-0002' });
    ok(!r.ok && r.code === 'failed-precondition' && stkCalls().length === n0, 'O-3',
      'a DIFFERENT key while those debts are held → "already in progress", no second claim, no STK: ' + why(r)); }
  { const rs = [];
    for (const [uid, label] of [['m03-stranger', 'a stranger'], [CASHIER, 'a cashier without finance'], [OTHER, "another business's owner"]]) {
      rs.push([label, await call('posCommissionPayNow', uid, { businessId: 'SOK-M03-A', method: 'INTASEND_STK', phone: '254700000003', idempotencyKey: 'pay-key-x-' + uid })]);
    }
    const adminR = await call('posCommissionPayNow', ADMIN, { businessId: 'SOK-M03-A', method: 'INTASEND_STK', phone: '254700000003', idempotencyKey: 'pay-key-admin1' }, { admin: true });
    ok(rs.every(([, r]) => !r.ok && r.code === 'permission-denied') && !adminR.ok && adminR.code === 'permission-denied', 'O-4',
      'who may pay: a stranger, a cashier without `finance`, another business owner, and a platform admin who is not a member are all refused: ' + rs.map(([l, r]) => l + '=' + (r.ok ? 'OK' : r.code)).join(', ') + ', admin=' + (adminR.ok ? 'OK' : adminR.code)); }
  { const r = await call('posCommissionPayNow', OWNER, { businessId: 'SOK-M03-A', method: 'INTASEND_STK', phone: '254700000001', idempotencyKey: 'pay-key-card1', cardNumber: '4111111111111111', cvv: '123' });
    ok(!r.ok && r.code === 'invalid-argument' && /never sent to SOKONI/.test(r.msg), 'O-5', 'card details sent to SOKONI are REFUSED outright: ' + why(r)); }
  { const r = await call('posCommissionPayNow', OWNER, { businessId: 'SOK-M03-A', method: 'INTASEND_STK', phone: '254700000001' });
    ok(!r.ok && r.code === 'invalid-argument', 'O-6', 'no idempotency key → refused: ' + why(r)); }

  process.stdout.write('\n[C] confirming — only proven money settles, once\n');
  { SCRIPT.status['INV-STK-1'] = [{ status: 200, body: { invoice: { invoice_id: 'INV-STK-1', state: 'PENDING', api_ref: pay1 } } }];
    const r = await call('posCommissionPayNowConfirm', OWNER, { payId: pay1 });
    ok(r.ok && (await payDoc(pay1)).status === 'OPEN' && (await debt(A[0])).status === 'OUTSTANDING', 'C-1', 'provider PENDING → nothing changes: ' + why(r)); }
  { SCRIPT.status['INV-STK-1'] = [{ status: 200, body: { invoice: { invoice_id: 'INV-STK-1', state: 'COMPLETE', api_ref: pay1, value: 70, currency: 'KES' } } }];
    const r = await call('posCommissionPayNowConfirm', OWNER, { payId: pay1 });
    ok(r.ok && (await payDoc(pay1)).status === 'NEEDS_REVIEW' && (await debt(A[0])).status === 'OUTSTANDING', 'C-2',
      'COMPLETE but the AMOUNT is not the frozen charge (70 ≠ 71) → NOT settled, flagged NEEDS_REVIEW: ' + why(r)); }
  let pay2;
  { await upd(pay1, { status: 'OPEN' });   /* reviewer reopens (manual test step) */
    SCRIPT.status['INV-STK-1'] = [{ status: 200, body: { invoice: { invoice_id: 'INV-STK-1', state: 'COMPLETE', api_ref: 'poscs_somethingelse', value: 71, currency: 'KES' } } }];
    await call('posCommissionPayNowConfirm', OWNER, { payId: pay1 });
    const ok1 = (await payDoc(pay1)).status === 'NEEDS_REVIEW' && (await debt(A[0])).status === 'OUTSTANDING';
    await upd(pay1, { status: 'OPEN' });
    SCRIPT.status['INV-STK-1'] = [{ status: 200, body: { invoice: { invoice_id: 'INV-STK-1', state: 'COMPLETE', api_ref: pay1, value: 71 } } }];
    await call('posCommissionPayNowConfirm', OWNER, { payId: pay1 });
    const ok2 = (await payDoc(pay1)).status === 'NEEDS_REVIEW' && (await debt(A[0])).status === 'OUTSTANDING';
    ok(ok1 && ok2, 'C-3', 'COMPLETE naming ANOTHER api_ref, or with NO currency stated → not settled (missing is "not proven", never "matches")'); }
  { await upd(pay1, { status: 'OPEN' });
    SCRIPT.status['INV-STK-1'] = [COMPLETE(pay1, 71)];
    const rs = await Promise.all(Array.from({ length: 5 }, () => call('posCommissionPayNowConfirm', OWNER, { payId: pay1 })));
    const pd = await payDoc(pay1); const ds = await Promise.all(A.map(debt));
    ok(rs.every((r) => r.ok) && pd.status === 'PAID' && ds.every((d) => d.status === 'SETTLED' && d.settlementRef === pay1) && (pd.settledDebtIds || []).length === 3, 'C-4',
      'proven COMPLETE (api_ref, 71 KES, KES) → all 3 debts SETTLED once, even with 5 concurrent confirms: ' + pd.status + ', ' + ds.map((d) => d.status).join('/')); }
  { const before = JSON.stringify(await Promise.all(A.map(debt)));
    const r = await call('posCommissionPayNowConfirm', OWNER, { payId: pay1 });
    ok(r.ok && r.out.replayed === true && JSON.stringify(await Promise.all(A.map(debt))) === before, 'C-5', 'confirming again changes nothing (replayed): ' + why(r)); }
  { const r = await call('posCommissionPayNow', OWNER, { businessId: 'SOK-M03-A', method: 'INTASEND_STK', phone: '254700000001', idempotencyKey: 'pay-key-0009' });
    ok(!r.ok && r.code === 'failed-precondition' && /no outstanding/.test(r.msg), 'C-6', 'once settled there is nothing left to pay: ' + why(r)); }

  process.stdout.write('\n[F] failure leaves the debt outstanding\n');
  let payF;
  { SCRIPT.stk.push({ status: 200, body: { invoice: { invoice_id: 'INV-STK-F' } } });
    const r = await call('posCommissionPayNow', OTHER, { businessId: 'SOK-M03-B', method: 'INTASEND_STK', phone: '254700000009', idempotencyKey: 'pay-key-fail1' });
    payF = r.ok && r.out.payId;
    SCRIPT.status['INV-STK-F'] = [{ status: 200, body: { invoice: { invoice_id: 'INV-STK-F', state: 'FAILED', api_ref: payF } } }];
    await call('posCommissionPayNowConfirm', OTHER, { payId: payF });
    ok((await payDoc(payF)).status === 'FAILED' && (await claimsOf(payF)).length === 0 && (await debt('poscomm_m03-B1')).status === 'OUTSTANDING', 'F-1',
      'provider FAILED (cancelled / insufficient) → attempt FAILED, claims RELEASED, the debt stays OUTSTANDING'); }
  { SCRIPT.stk.push({ status: 400, body: { detail: 'bad phone' } });
    const r = await call('posCommissionPayNow', OTHER, { businessId: 'SOK-M03-B', method: 'INTASEND_STK', phone: '254700000009', idempotencyKey: 'pay-key-rej01' });
    const pd = r.ok ? await payDoc(r.out.payId) : null;
    ok(r.ok && pd && pd.status === 'FAILED' && (await claimsOf(pd.payId)).length === 0 && (await debt('poscomm_m03-B1')).status === 'OUTSTANDING', 'F-2',
      'the gateway REJECTS the push → FAILED at once, claims released, debt OUTSTANDING: ' + (pd && pd.status)); }
  let payU;
  { SCRIPT.stk.push({ status: 503, body: {} });
    const r = await call('posCommissionPayNow', OTHER, { businessId: 'SOK-M03-B', method: 'INTASEND_STK', phone: '254700000009', idempotencyKey: 'pay-key-unk01' });
    payU = r.ok && r.out.payId; const pd = payU ? await payDoc(payU) : null;
    ok(r.ok && pd.status === 'OPEN' && pd.gatewayOutcome === 'OUTCOME_UNKNOWN' && (await claimsOf(payU)).length === 1 && (await debt('poscomm_m03-B1')).status === 'OUTSTANDING', 'F-3',
      'a gateway NON-answer (5xx) → claims stay HELD (money may be moving), nothing settled, nothing released: ' + (pd && pd.gatewayOutcome)); }
  { await upd(payU, { providerRef: 'INV-STK-U' });
    SCRIPT.status['INV-STK-U'] = [{ status: 200, body: { invoice: { invoice_id: 'INV-STK-U', state: 'FAILED', api_ref: payU } } }];
    await call('posCommissionPayNowConfirm', OTHER, { payId: payU });
    const failedFirst = (await payDoc(payU)).status === 'FAILED';
    SCRIPT.status['INV-STK-U'] = [COMPLETE(payU, 50)];
    await res(PS ? PS.completeAttempt(payU, { source: 'late-test' }, 'test') : Promise.reject(new Error('absent')));
    const pd = await payDoc(payU);
    ok(failedFirst && pd.status === 'PAID' && (await debt('poscomm_m03-B1')).status === 'SETTLED', 'F-4',
      'a LATE proven COMPLETE after a FAILED still settles a debt that is still outstanding and unclaimed (money received is honoured): ' + pd.status); }
  { const pX = 'poscs_' + 'x'.repeat(32);
    await db.collection('posCommissionPayments').doc(pX).set({ payId: pX, method: 'INTASEND_STK', debtIds: ['poscomm_m03-B1'], status: 'FAILED', chargedMinor: 5000, totalMinor: 5000, scope: { kind: 'BUSINESS', businessId: 'SOK-M03-B' }, requestedBy: OTHER });
    const r = await res(PS ? PS.completeAttempt(pX, { source: 'late-test' }, 'test') : Promise.reject(new Error('absent')));
    const d = await debt('poscomm_m03-B1'); const pd = await payDoc(pX);
    ok(r.ok && pd.status === 'PAID_RECONCILE' && d.settlementRef === payU && (pd.unsettledDebtIds || []).length === 1, 'F-5',
      'a second late COMPLETE for a debt ALREADY settled by another payment → PAID_RECONCILE (money kept for reconciliation), the debt is NOT settled twice: ' + (pd && pd.status)); }

  { /* A debt HELD by one open attempt must not be settled by a late COMPLETE of a different, failed one. */
    await sale('m03-B2', OTHER, 1000);
    SCRIPT.stk.push({ status: 200, body: { invoice: { invoice_id: 'INV-HOLD' } } });
    const holder = await call('posCommissionPayNow', OTHER, { businessId: 'SOK-M03-B', method: 'INTASEND_STK', phone: '254700000009', idempotencyKey: 'pay-key-hold1' });
    const pY = 'poscs_' + 'y'.repeat(32);
    await db.collection('posCommissionPayments').doc(pY).set({ payId: pY, method: 'INTASEND_STK', debtIds: ['poscomm_m03-B2'], status: 'FAILED', chargedMinor: 5000, totalMinor: 5000, scope: { kind: 'BUSINESS', businessId: 'SOK-M03-B' }, requestedBy: OTHER });
    await res(PS.completeAttempt(pY, { source: 'late-test' }, 'test'));
    const d = await debt('poscomm_m03-B2'); const pd = await payDoc(pY);
    ok(holder.ok && d.status === 'OUTSTANDING' && pd.status === 'PAID_RECONCILE' && ((await db.collection('posCommissionSettlementClaims').doc('poscomm_m03-B2').get()).data() || {}).payId === holder.out.payId, 'F-6',
      'a late COMPLETE of a DIFFERENT (failed) attempt cannot settle a debt another open attempt holds → reconcile, the holder keeps it: ' + (pd && pd.status)); }

  { /* The OUTSTANDING precondition on its own: a debt already SETTLED with NO claim (settled by some path outside
       this machine) must not be re-settled by a late COMPLETE — the claim guard cannot catch this one. */
    await sale('m03-B3', OTHER, 1000);
    await db.collection('posCommissionLiabilities').doc('poscomm_m03-B3').update({ status: 'SETTLED', settlementRef: 'LEGACY-PAY' });
    const pZ = 'poscs_' + 'z'.repeat(32);
    await db.collection('posCommissionPayments').doc(pZ).set({ payId: pZ, method: 'INTASEND_STK', debtIds: ['poscomm_m03-B3'], status: 'FAILED', chargedMinor: 5000, totalMinor: 5000, scope: { kind: 'BUSINESS', businessId: 'SOK-M03-B' }, requestedBy: OTHER });
    await res(PS.completeAttempt(pZ, { source: 'late-test' }, 'test'));
    const d = await debt('poscomm_m03-B3'); const pd = await payDoc(pZ);
    ok(d.settlementRef === 'LEGACY-PAY' && pd.status === 'PAID_RECONCILE', 'F-7',
      'a debt already SETTLED elsewhere (no claim) is not re-settled by a late COMPLETE → reconcile, its settlementRef is untouched: ' + d.settlementRef + ' / ' + pd.status); }

  process.stdout.write('\n[K] card and every account-enabled method — hosted checkout\n');
  { const r = await call('posCommissionPayNow', LONE, { scope: 'unresolved', method: 'INTASEND_CHECKOUT', idempotencyKey: 'pay-key-chk01' });
    ok(!r.ok && r.code === 'failed-precondition' && /not configured/.test(r.msg) && !(await claimsOf('poscs_none')).length, 'K-1',
      'with NO publishable key configured (production today) checkout is refused before anything is claimed: ' + why(r)); }
  let payK;
  { process.env.INTASEND_PUBLISHABLE_KEY = 'ISPubKey_test_only';
    SCRIPT.checkout.push({ status: 200, body: { id: 'CHK-1', url: 'https://payment.intasend.com/checkout/CHK-1/', invoice: { invoice_id: 'INV-CHK-1' } } });
    const r = await call('posCommissionPayNow', LONE, { scope: 'unresolved', method: 'INTASEND_CHECKOUT', idempotencyKey: 'pay-key-chk02', email: 'owner@example.test' });
    payK = r.ok && r.out.payId; const chk = CALLS.filter((c) => c.path === '/api/v1/checkout/').slice(-1)[0];
    ok(r.ok && r.out.checkoutUrl === 'https://payment.intasend.com/checkout/CHK-1/' && chk && chk.body.api_ref === payK && chk.body.method === undefined
      && chk.headers.INTASEND_PUBLIC_API_KEY === 'ISPubKey_test_only' && !chk.headers.Authorization, 'K-2',
      "the unresolved owner's debt → a hosted checkout URL (card + every method the ACCOUNT enables — no method named), public-key flow, api_ref = payId: " + why(r)); }
  { SCRIPT.status['INV-CHK-1'] = [{ status: 200, body: { invoice: { invoice_id: 'INV-CHK-1', state: 'COMPLETE', api_ref: payK, value: 50, currency: 'KES', provider: 'CARD-PAYMENT' } } }];
    await call('posCommissionPayNowConfirm', LONE, { payId: payK });
    const pd = await payDoc(payK); const d = await debt('poscomm_m03-L1');
    ok(pd.status === 'PAID' && d.status === 'SETTLED' && d.settledVia === 'INTASEND_CHECKOUT' && (pd.evidence || {}).method === 'CARD-PAYMENT', 'K-3',
      'a proven CARD payment settles through the SAME state machine: ' + pd.status + ' via ' + ((pd.evidence || {}).method));
    delete process.env.INTASEND_PUBLISHABLE_KEY; }

  process.stdout.write('\n[X] cash — recorded by the business, confirmed only by SOKONI\n');
  await sale('m03-A4', OWNER, 1000);
  let payC;
  { const r = await call('posCommissionCashRecord', FIN, { businessId: 'SOK-M03-A', idempotencyKey: 'cash-key-001', note: 'handed to agent' });
    payC = r.ok && r.out.payId;
    ok(r.ok && (await payDoc(payC)).status === 'OPEN' && (await debt('poscomm_m03-A4')).status === 'OUTSTANDING', 'X-1',
      'a finance member records cash handed over → OPEN, the debt is NOT settled by saying so: ' + why(r)); }
  { const self = await call('posCommissionCashConfirm', FIN, { payId: payC, receiptNo: 'RCPT-001' }, { admin: true });
    const cashier = await call('posCommissionCashConfirm', CASHIER, { payId: payC, receiptNo: 'RCPT-001' });
    const owner = await call('posCommissionCashConfirm', OWNER, { payId: payC, receiptNo: 'RCPT-001' });
    const noReceipt = await call('posCommissionCashConfirm', ADMIN, { payId: payC }, { admin: true });
    ok(!self.ok && !cashier.ok && !owner.ok && !noReceipt.ok && (await debt('poscomm_m03-A4')).status === 'OUTSTANDING', 'X-2',
      'the requester (even holding an admin claim), a cashier, the business owner, and an admin with no receipt number all FAIL to confirm: ' + [self, cashier, owner, noReceipt].map((r) => r.ok ? 'OK' : r.code).join(', ')); }
  { const r = await call('posCommissionCashConfirm', ADMIN, { payId: payC, receiptNo: 'RCPT-001' }, { admin: true });
    const pd = await payDoc(payC); const d = await debt('poscomm_m03-A4');
    ok(r.ok && pd.status === 'PAID' && d.status === 'SETTLED' && d.settledVia === 'CASH' && (pd.evidence || {}).receiptNo === 'RCPT-001' && (pd.evidence || {}).confirmedBy === ADMIN, 'X-3',
      'a SOKONI admin who is not the requester, with a receipt number → SETTLED through the same state machine, evidence recorded: ' + why(r)); }
  { await sale('m03-A5', OWNER, 1000);
    const r1 = await call('posCommissionCashRecord', OWNER, { businessId: 'SOK-M03-A', idempotencyKey: 'cash-key-002' });
    const r2 = await call('posCommissionCashCancel', OWNER, { payId: r1.ok && r1.out.payId });
    const d = await debt('poscomm_m03-A5');
    ok(r1.ok && r2.ok && (await payDoc(r1.out.payId)).status === 'FAILED' && d.status === 'OUTSTANDING' && (await claimsOf(r1.out.payId)).length === 0, 'X-4',
      'a cash request cancelled (nothing received) → released, the debt stays OUTSTANDING: ' + why(r2)); }
  { await sale('m03-A6', OWNER, 1000);
    SCRIPT.stk.push({ status: 200, body: { invoice: { invoice_id: 'INV-RACE' } } });
    const [a, b] = await Promise.all([
      call('posCommissionPayNow', OWNER, { businessId: 'SOK-M03-A', method: 'INTASEND_STK', phone: '254700000001', idempotencyKey: 'race-key-stk1' }),
      call('posCommissionCashRecord', FIN, { businessId: 'SOK-M03-A', idempotencyKey: 'race-key-cash1' }),
    ]);
    const winners = [a, b].filter((r) => r.ok).length;
    const cl = (await db.collection('posCommissionSettlementClaims').doc('poscomm_m03-A6').get()).data();
    ok(winners === 1 && !!cl, 'X-5', 'Pay Now by STK and a cash record RACING for the same debt → exactly one holds it: ' + [a, b].map((r) => r.ok ? 'OK' : r.code).join(' / ')); }

  process.stdout.write('\n[G] nothing else moved\n');
  ok(RAIL.GATE_ENFORCED === false, 'G-1', 'the till gate is still OFF (P0): GATE_ENFORCED=' + RAIL.GATE_ENFORCED);
  ok(UNSCRIPTED === 0 && CALLS.every((c) => /intasend\.com$/.test(c.host)), 'G-2', 'every outbound call went to the IntaSend double, none unscripted: ' + CALLS.length + ' calls, ' + UNSCRIPTED + ' unscripted');

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
