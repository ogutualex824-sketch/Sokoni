#!/usr/bin/env node
/* test-invoice-payment-settle.js — the invoice payment chain, end to end, on the REAL modules (owner 2026-10-04).
 *   verified webhook → allocation (f3 invoice-allocation, byte-identical) → 15% from the payment-start snapshot on the
 *   APPLIED amount (settlement-authority) → merchant BUSINESS wallet (business-wallet RC, real) → receipt (2f
 *   transaction-receipts, real) → invoice status → audit.  Settlement table + the owner's 12 invariants, each a row.
 * Transactional fake Firestore; the settlement-destination resolver is injected (its contract is certified on the RC line).
 *   node scripts/test-invoice-payment-settle.js
 */
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 300) : '')); } };
let ENV = null;
const load0 = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'firebase-admin') return { apps: [1], initializeApp() {}, firestore: Object.assign(() => ENV.db, { FieldValue: ENV.FieldValue }), auth: () => ({}) };
  if (req === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  return load0.call(this, req, parent, isMain);
};
const newEnv = () => { const F = makeFakeFirestore({}); ENV = { db: F.db, FieldValue: F.FieldValue }; return ENV; };
newEnv();
const IPS = require(path.join(FN, 'invoice-payment-settle.js'));
const BW = require(path.join(FN, 'business-wallet.js'));
const TR = require(path.join(FN, 'transaction-receipts.js'));
const DEST = { ok: true, businessId: 'SOK-BIZ001', ownerUid: 'merchant1', storeId: 'STORE1' };
const SD = { resolveSettlementDestination: async (_db, o) => (o.sellerUid === 'merchant1' && o.paymentVerified === true ? DEST : { ok: false, reason: 'business_unlinked' }) };
let num = 0; const receiptDeps = { nextNumber: async () => 'SKN-RCT-2026-' + String(++num).padStart(6, '0'), serverTs: () => new Date() };
const ADMIN = { firestore: { FieldValue: null } };
const get = async (p) => { const s = await ENV.db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await ENV.db.collection(c).get()).docs.map((d) => Object.assign({ _id: d.id }, d.data()));
const SNAP = { commissionRate: 15, commissionRuleId: 'merchant_invoice@v15', commissionBase: 'invoice_balance', category: 'merchant_invoice', policyVersion: 'v15', capturedOnCents: 1250000 };

async function seedInvoice(id, totalCents, o) {
  const x = Object.assign({ modelVersion: 1, source: 'manual', status: 'issued', currency: 'KES', totalCents, paidCents: 0, balanceCents: totalCents,
    shopId: 'shop1', invoiceNumber: 'INV-0001' }, (o && o.invoice) || {});
  await ENV.db.doc('invoices/' + id).set(x);
  const ref = 'INV-' + id + '-' + x.balanceCents;
  await ENV.db.doc('paymentIntents/' + ref).set(Object.assign({ uid: 'payer1', resourceType: 'invoice', resourceId: id, amountCents: x.balanceCents, currency: 'KES', status: 'created',
    metadata: { type: 'invoice', invoiceId: id, invoiceNumber: 'INV-0001', source: 'manual', shopId: 'shop1', sellerUid: 'merchant1', payeeWallet: 'business',
      balanceCentsAtIntent: x.balanceCents, commissionCategory: 'merchant_invoice', commissionSnapshot: Object.assign({}, SNAP, { capturedOnCents: x.balanceCents }) } }, (o && o.intent) || {}));
  return ref;
}
/* one webhook delivery: the callback claims `kes`; IntaSend's own status confirms `confirmKes` (default: the same) */
const deliver = (ref, kes, o) => IPS.settleInvoicePayment(ENV.db, Object.assign({}, ADMIN, { firestore: { FieldValue: ENV.FieldValue } }), Object.assign({
  apiRef: ref, intentRef: ref, grossAmount: kes, providerMethod: 'M-PESA', invoiceId: 'ISD-' + ref,
  confirm: async (expectedCents) => { const c = Math.round(Number(o && o.confirmKes !== undefined ? o.confirmKes : kes) * 100); return c === expectedCents ? { ok: true } : { ok: false, reason: 'provider_amount_mismatch' }; },
  deps: { BW, SD }, receiptDeps }, (o && o.p) || {}));
const wallet = async () => (await get('businessWallets/SOK-BIZ001')) || {};
const entries = async () => (await all('businessWalletEntries')).filter((e) => e.kind === 'invoice_settlement');
const receiptOf = async (ref) => get('transactionReceipts/' + TR.receiptIdFor('invoice', ref));

(async () => {
  /* ── T: the settlement table (KES 12,500 invoice, captured 15%) ── */
  console.log('\n── settlement table ──');
  newEnv(); let ref = await seedInvoice('invEXACT1', 1250000);
  let r = await deliver(ref, 12500);
  let inv = await get('invoices/invEXACT1'); let w = await wallet();
  ck('T1  EXACT 12,500 → allocated in full, merchant wallet +10,625 (12,500 − 15%), invoice PAID',
    r.outcome === 'settled' && r.appliedCents === 1250000 && r.netCents === 1062500 && w.balanceMinor === 1062500 && inv.status === 'paid' && inv.balanceCents === 0, { r, w: w.balanceMinor, inv: inv.status });
  newEnv(); ref = await seedInvoice('invUNDER1', 1250000);
  r = await deliver(ref, 10000);
  inv = await get('invoices/invUNDER1'); w = await wallet();
  ck('T2  UNDER 10,000 → allocated 10,000, wallet +8,500, invoice PARTIALLY_PAID with 2,500 outstanding',
    r.appliedCents === 1000000 && r.netCents === 850000 && w.balanceMinor === 850000 && inv.status === 'partially_paid' && inv.balanceCents === 250000, { r, inv });
  newEnv(); ref = await seedInvoice('invOVER01', 1250000);
  r = await deliver(ref, 15000);
  inv = await get('invoices/invOVER01'); w = await wallet();
  const xh = await get('invoiceExcessHolds/' + ref);
  ck('T3  OVER 15,000 → 12,500 applied, wallet +10,625 (15% on the APPLIED amount only), 2,500 HELD + flagged, invoice PAID',
    r.appliedCents === 1250000 && r.excessHeldCents === 250000 && r.netCents === 1062500 && w.balanceMinor === 1062500 && !!xh && xh.status === 'held' && xh.excessCents === 250000
      && inv.status === 'paid' && inv.reviewFlag === 'overpaid' && !!(await get('adminAlerts/invoice_overpaid__' + ref)), { r, w: w.balanceMinor, xh });
  const rcO = await receiptOf(ref);
  ck('T4  the receipt never shows more than was resolved: received 15,000 · released (applied) 12,500 = fee 1,875 + merchant 10,625 · held (excess) 2,500',
    !!rcO && rcO.paidCents === 1500000 && rcO.releasedCents === 1250000 && rcO.platformFeeCents === 187500 && rcO.providerNetCents === 1062500 && rcO.heldCents === 250000 && rcO.status === 'partially_released', rcO);

  /* ── I: the owner's 12 invariants ── */
  console.log('\n── invariants ──');
  /* 1 — the verified webhook is the only authority */
  newEnv(); ref = await seedInvoice('invFORGE1', 1250000);
  r = await deliver(ref, 12500, { confirmKes: 0 });
  ck('I1  a FORGED / unconfirmed webhook (IntaSend does not confirm the amount) → nothing allocated, nothing credited, no receipt; HELD + flagged',
    r.outcome === 'held' && !(await get('invoices/invFORGE1/allocations/' + ref)) && (await entries()).length === 0 && !(await receiptOf(ref)) && (await get('invoicePaymentHolds/' + ref)).flagged === true, r);
  newEnv(); ref = await seedInvoice('invCLAIM1', 1250000);
  r = await deliver(ref, 20000, { confirmKes: 12500 });
  ck('I1b the callback CLAIMS 20,000, IntaSend confirms 12,500 → refused (a claim is not evidence), nothing moved', r.outcome === 'held' && (await entries()).length === 0, r);
  /* 2/3/4/11 — duplicate webhooks */
  newEnv(); ref = await seedInvoice('invDUP001', 1250000);
  await deliver(ref, 12500); const again = await deliver(ref, 12500); await deliver(ref, 12500);
  const allocs = await all('invoices/invDUP001/allocations');
  w = await wallet(); const rcs = (await all('transactionReceipts')).filter((x) => x.kind === 'invoice');
  const evs = rcs.length ? await all('transactionReceipts/' + rcs[0]._id + '/events') : [];
  ck('I2  allocation idempotent — THREE deliveries, ONE allocation', allocs.length === 1 && again.allocationReplay === true, allocs.length);
  ck('I3  wallet credit idempotent — ONE entry, the balance moved once (10,625)', (await entries()).length === 1 && w.balanceMinor === 1062500 && again.creditReplay === true, { n: (await entries()).length, bal: w.balanceMinor });
  ck('I4  receipt idempotent — ONE receipt, ONE paid + ONE released event', rcs.length === 1 && evs.length === 2, { receipts: rcs.length, events: evs.map((e) => e._id) });
  ck('I11 duplicate webhooks create no duplicate wallet credit and no duplicate receipt (I2–I4 together)', allocs.length === 1 && (await entries()).length === 1 && rcs.length === 1);
  /* crash recovery: the allocation landed, the credit did not (an earlier attempt stopped) → the next delivery completes ONCE */
  newEnv(); ref = await seedInvoice('invCRASH1', 1250000);
  await require(path.join(FN, 'invoice-allocation.js')).applyVerifiedPayment(ENV.db, { invoiceId: 'invCRASH1', paymentId: ref, amountCents: 1250000, currency: 'KES', FieldValue: ENV.FieldValue });
  r = await deliver(ref, 12500);
  ck('I11b a half-finished earlier attempt (allocated, never credited) is completed exactly once on the next delivery', r.allocationReplay === true && (await entries()).length === 1 && (await wallet()).balanceMinor === 1062500, r);
  /* 5 — no browser / client can mark an invoice paid */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const srcFiles = fs.readdirSync(FN).filter((f) => f.endsWith('.js'));
  const callersOfAlloc = srcFiles.filter((f) => f !== 'invoice-allocation.js' && /applyVerifiedPayment\s*\(/.test(strip(fs.readFileSync(path.join(FN, f), 'utf8'))));
  const callersOfSettle = srcFiles.filter((f) => f !== 'invoice-payment-settle.js' && /settleInvoicePayment\s*\(/.test(strip(fs.readFileSync(path.join(FN, f), 'utf8'))));
  const settleSrc = strip(fs.readFileSync(path.join(FN, 'invoice-payment-settle.js'), 'utf8'));
  ck('I5  only the verified-webhook settlement calls the allocation, only the webhook (index.js) calls the settlement, and neither is a callable',
    JSON.stringify(callersOfAlloc) === '["invoice-payment-settle.js"]' && JSON.stringify(callersOfSettle) === '["index.js"]' && !/onCall|onRequest/.test(settleSrc), { callersOfAlloc, callersOfSettle });
  /* 6 — a payment claim / merchant reference never creates wallet money */
  newEnv(); ref = await seedInvoice('invCLM002', 1250000);
  await ENV.db.doc('invoicePaymentClaims/c1').set({ invoiceId: 'invCLM002', claimedBy: 'merchant1', reference: 'MPESA-QWERTY', amountCents: 1250000, status: 'unverified' });
  await ENV.db.doc('paymentIntents/NOTINV-1').set({ uid: 'payer1', resourceType: 'order', amountCents: 1250000, metadata: { invoiceId: 'invCLM002', sellerUid: 'merchant1' } });
  const notInv = await IPS.settleInvoicePayment(ENV.db, { firestore: { FieldValue: ENV.FieldValue } }, { apiRef: 'NOTINV-1', intentRef: 'NOTINV-1', grossAmount: 12500, confirm: async () => ({ ok: true }), deps: { BW, SD }, receiptDeps });
  ck('I6  a merchant payment CLAIM moves nothing, and a non-invoice payment that merely names an invoice is not settled as one',
    notInv === false && (await entries()).length === 0 && (await get('invoices/invCLM002')).status === 'issued');
  /* 7 — an overpayment never silently enters the merchant wallet (T3 + the entry carries only the applied gross) */
  newEnv(); ref = await seedInvoice('invOVER02', 1250000); await deliver(ref, 30000);
  const eo = (await entries())[0] || {};
  ck('I7  overpayment: the wallet entry is the APPLIED share only (gross 12,500 → +10,625); the 17,500 excess is held, never credited',
    eo.amountMinor === 1062500 && eo.source && eo.source.grossMinor === 1250000 && (await get('invoiceExcessHolds/' + ref)).excessCents === 1750000 && (await wallet()).balanceMinor === 1062500, eo);
  /* 8 — the receipt reflects the verified payment + allocation, never a claim */
  newEnv(); ref = await seedInvoice('invRCPT01', 1250000); await deliver(ref, 10000);
  const rc8 = await receiptOf(ref);
  ck('I8  the receipt = the VERIFIED amount (10,000), released = applied (fee 1,500 + merchant 8,500), confirmation source = the IntaSend webhook, linked to the invoice',
    !!rc8 && rc8.paidCents === 1000000 && rc8.releasedCents === 1000000 && rc8.platformFeeCents === 150000 && rc8.providerNetCents === 850000 && rc8.confirmation.source === 'intasend_webhook' && rc8.links && rc8.links.invoiceId === 'invRCPT01', rc8);
  /* 9 — invoice status derived from authoritative allocations only */
  newEnv(); ref = await seedInvoice('invSTAT01', 1250000);
  await ENV.db.doc('invoices/invSTAT01').set({ status: 'issued', paymentStatus: 'pending' }, { merge: true });
  await deliver(ref, 5000);
  const s1 = (await get('invoices/invSTAT01')).status;
  const ref2 = 'INV-invSTAT01-750000';
  await ENV.db.doc('paymentIntents/' + ref2).set(Object.assign({}, await get('paymentIntents/' + ref), { amountCents: 750000, metadata: Object.assign({}, (await get('paymentIntents/' + ref)).metadata, { balanceCentsAtIntent: 750000 }) }));
  await deliver(ref2, 7500);
  const s2 = await get('invoices/invSTAT01');
  ck('I9  status follows the allocations: 5,000 → partially_paid; + 7,500 → paid (balance 0, two allocations, two credits)',
    s1 === 'partially_paid' && s2.status === 'paid' && s2.balanceCents === 0 && (await all('invoices/invSTAT01/allocations')).length === 2 && (await entries()).length === 2, { s1, s2: s2.status });
  /* 10 — the captured rate is immutable for that payment */
  newEnv(); ref = await seedInvoice('invRATE01', 1250000);
  await ENV.db.doc('commissionConfig/merchant_invoice').set({ rate: 30 });                              /* "today's" table moves */
  await ENV.db.doc('platformConfig/commission').set({ merchant_invoice: 30 }, { merge: true });
  r = await deliver(ref, 12500);
  const st10 = await get('invoiceSettlements/' + ref);
  ck('I10 the fee is the rate CAPTURED at payment start (15%) even after the table changes; the settlement records that snapshot',
    r.commissionCents === 187500 && !!st10 && st10.commissionSnapshot.commissionRate === 15 && st10.commissionSnapshot.commissionRuleId === 'merchant_invoice@v15', { r: r.commissionCents, snap: st10 && st10.commissionSnapshot });
  /* 12 — any unresolved payment is HELD + flagged, never silently settled */
  const unresolved = [
    ['void invoice', async () => { const x = await seedInvoice('invVOID01', 1250000); await ENV.db.doc('invoices/invVOID01').set({ status: 'void' }, { merge: true }); return x; }, 'allocation_refused'],
    ['non-canonical invoice', async () => { const x = await seedInvoice('invNCAN01', 1250000); await ENV.db.doc('invoices/invNCAN01').set({ source: null }, { merge: true }); return x; }, 'allocation_refused'],
    ['no invoice on file', async () => { const x = await seedInvoice('invGONE01', 1250000); await ENV.db.doc('invoices/invGONE01').delete(); return x; }, 'allocation_refused'],
    ['no commission snapshot', async () => seedInvoice('invNOSN01', 1250000, { intent: { metadata: { type: 'invoice', invoiceId: 'invNOSN01', sellerUid: 'merchant1', payeeWallet: 'business' } } }), 'no_commission_snapshot'],
    ['payer is the issuing merchant', async () => seedInvoice('invSELF01', 1250000, { intent: { uid: 'merchant1' } }), 'payer_is_merchant'],
    ['merchant has no business wallet', async () => { const x = await seedInvoice('invNOBW01', 1250000); const i = await get('paymentIntents/' + x); i.metadata.sellerUid = 'merchant2'; await ENV.db.doc('paymentIntents/' + x).set(i); return x; }, 'no_business_wallet'],
    ['zero amount', async () => seedInvoice('invZERO01', 1250000), 'amount_invalid', 0],
  ];
  const leaks = [];
  for (const [label, mk, reason, kes] of unresolved) {
    newEnv(); const rf = await mk();
    const rr = await deliver(rf, kes === undefined ? 12500 : kes);
    const h = await get('invoicePaymentHolds/' + rf);
    if (!(rr.outcome === 'held' && rr.reason === reason && h && h.flagged === true && h.status === 'held' && (await entries()).length === 0 && !(await receiptOf(rf))
      && !!(await get('adminAlerts/invoice_payment_held__' + rf)))) leaks.push({ label, rr, h: !!h });
  }
  ck('I12 every unresolvable payment (void / non-canonical / missing invoice, no snapshot, merchant payer, no business wallet, zero) is HELD + flagged — no wallet, no receipt', leaks.length === 0, leaks);
  const vh = await (async () => { newEnv(); const rf = await unresolved[0][1](); await deliver(rf, 12500); return get('invoicePaymentHolds/' + rf); })();
  ck('I12b the hold records the allocation refusal code (f3 AllocationError) for the reviewer', vh && vh.allocationCode === 'not_payable', vh);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
