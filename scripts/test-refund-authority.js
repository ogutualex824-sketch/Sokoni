'use strict';
/**
 * CERTIFICATION — Track F: one refund authority, idempotency, seller-credit reversal, evidence.
 * docs/REFUND_AFTER_WEBHOOK_CREDIT_INVESTIGATION.md is the defect record.
 *
 * Runs against a REAL Firestore emulator (real transactions and contention). It drives the REAL
 * wired callables — wallet.refundToWallet, financial-os.fosSubmitRefund / fosApproveRefund — via
 * their `.run()` entry, with the IntaSend adapter replaced by a stub that COUNTS every chargeback.
 * It refuses to run without FIRESTORE_EMULATOR_HOST.
 *
 * Fixtures reproduce exactly what the webhook writes for a paid marketplace order: the payment's
 * credit markers, the FinOS `sale` credit row, the seller wallet's cents fields, and the order's
 * lowercase `settlementStatus: "settled"`.
 */
const path = require('path');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
process.env.INTASEND_PRIVATE_KEY = process.env.INTASEND_PRIVATE_KEY || 'test-key-not-real';

const FN = process.env.REFUND_FUNCTIONS_DIR || path.join(__dirname, '..', 'functions');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-refund-authority' });
const db = admin.firestore();
const TS = admin.firestore.Timestamp;

/* ── IntaSend stub: every chargeback is counted; behaviour is switchable per test ── */
const gateway = { calls: [], mode: 'success' };
const fakeAdapter = { async initiateRefund(a) {
  gateway.calls.push(a);
  if (gateway.mode === 'throw') throw new Error('socket hang up');
  if (gateway.mode === 'fail') return { success: false, error: 'TF999 declined' };
  return { success: true, refundId: 'CB_' + gateway.calls.length };
} };
const adaptersPath = require.resolve(path.join(FN, 'payment-adapters.js'));
require.cache[adaptersPath] = { id: adaptersPath, filename: adaptersPath, loaded: true,
  exports: { getAdapter: () => fakeAdapter, listAdapters: () => [] } };

const RA = require(path.join(FN, 'refund-authority.js'));
const wallet = require(path.join(FN, 'wallet.js'));
const fos = require(path.join(FN, 'financial-os.js'));
const OS = require(path.join(FN, 'order-settlement.js'));
const quietRun = async (fn, req) => fn.run(req);
/* A call whose FAILURE is itself the evidence: captured, never allowed to crash the run (a crash is not a verdict). */
const tryRun = async (fn, req) => { try { return await fn.run(req); } catch (e) { return { __error: e.code || e.message }; } };
const ADMIN = { auth: { uid: 'admin_1', token: { admin: true } } };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
/* Field reads on a doc that may be ABSENT (unpatched code never writes it): absent reads as {}, so the
   assertion FAILS instead of crashing the run. Existence checks keep using get(). */
const getv = async (p) => (await get(p)) || {};
const refusal = async (p) => { try { await p; return null; } catch (e) { return e; } };
const reasonOf = (e) => e && ((e.details && e.details.reason) || e.reason || (e.message || ''));

async function wipe() {
  for (const c of ['payments', 'orders', 'wallets', 'walletTransactions', 'refundAuthority', 'fosRefundQueue',
                   'businessWallets', 'finosAudit', 'notifications', 'fosTransactions']) {
    const s = await db.collection(c).get();
    for (const d of s.docs) {
      for (const sub of await d.ref.listCollections()) { const ss = await sub.get(); await Promise.all(ss.docs.map((x) => x.ref.delete())); }
      await d.ref.delete();
    }
  }
  gateway.calls = []; gateway.mode = 'success';
}

const SELLER = 'seller_kass_like', BUYER = 'buyer_1';
/* What the webhook leaves behind for one paid marketplace order (FinOS family by default). */
async function seedWebhookCredit(o = {}) {
  const ref = o.ref || 'SKN_PAID_1', orderId = o.orderId === undefined ? ref : o.orderId;
  const seller = o.seller || SELLER, buyer = o.buyer === undefined ? BUYER : o.buyer;
  const gross = o.gross || 97, net = o.net || 8700;
  const pay = { status: 'COMPLETE', amount: gross, uid: buyer, meta: orderId ? { orderId } : {},
    walletCreditedAt: TS.now(), walletCreditCents: net, walletCreditedTo: seller };
  if (o.noMarker) { delete pay.walletCreditedAt; delete pay.walletCreditCents; delete pay.walletCreditedTo; }
  if (o.payment) Object.assign(pay, o.payment);
  await db.doc(`payments/${ref}`).set(pay);
  if (orderId) {
    await db.doc(`orders/${orderId}`).set(Object.assign({ id: orderId, sellerUid: seller, buyerUid: buyer, uid: buyer,
      status: 'confirmed', settlementStatus: 'settled', paymentVerified: true }, o.order || {}));
  }
  if (o.family === 'BALANCE') {
    await db.doc(`walletTransactions/${seller}_${ref}_booking`).set({ uid: seller, type: 'booking_earning', amount: net / 100 });
  } else if (!o.noLedgerRow) {
    await db.collection('wallets').doc(seller).collection('transactions').add({ type: 'sale', direction: 'credit',
      amountCents: o.ledgerAmount || net, orderId: ref, createdAt: TS.now() });
  }
  await db.doc(`wallets/${seller}`).set(Object.assign({ entityId: seller }, o.sellerWallet || {
    availableBalance: net, withdrawableBalance: net, lifetimeEarnings: net, balance: 0 }), { merge: true });
  return { ref, orderId, seller, buyer, gross, net };
}
const sellerW = () => getv(`wallets/${SELLER}`);
const buyerBal = async () => Number(((await getv(`wallets/${BUYER}`)) || {}).balance || 0);

(async () => {
  console.log('[F1] previously settled payment -> refunded EXACTLY ONCE (wallet rail, real refundToWallet)');
  await wipe();
  { const s = await seedWebhookCredit();
    const r = await tryRun(wallet.refundToWallet, Object.assign({ data: { orderId: s.orderId, amount: 97, reason: 'test' } }, ADMIN));
    const w = await sellerW(); const auth = await getv(`refundAuthority/${s.ref}`);
    ok(r.success && r.recipientUid === BUYER, `refund paid to the PAYER (${r.recipientUid}), not the calling admin`);
    ok(await buyerBal() === 97, `buyer wallet +KES 97 (${await buyerBal()})`);
    ok(auth && auth.status === 'COMPLETED' && auth.rail === 'wallet', 'authority COMPLETED on the wallet rail');
    ok(w.availableBalance === 0 && w.withdrawableBalance === 0 && w.lifetimeEarnings === 0 && (w.balance || 0) === 0,
      `seller FinOS credit reversed in the fields that received it (avail ${w.availableBalance}, wd ${w.withdrawableBalance}, lifetime ${w.lifetimeEarnings})`);
    ok(!!(await get(`wallets/${SELLER}/transactions/refund_reversal_${s.ref}`)), 'mirror debit row written in the SAME FinOS ledger');
    ok(!!(await get(`walletTransactions/${SELLER}_${s.ref}_refund_reversal`)), 'seller reversal visible in walletTransactions');

    console.log('\n[F2] repeated refund -> NO second financial mutation');
    const e1 = await refusal(quietRun(wallet.refundToWallet, Object.assign({ data: { orderId: s.orderId } }, ADMIN)));
    const e2 = await refusal(quietRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref } }, ADMIN)));
    ok(e1 && /already/.test(e1.code || '') && e2 && /already/.test(e2.code || ''), `repeats refused as already-exists (${e1 && e1.code}, ${e2 && e2.code})`);
    const w2 = await sellerW();
    ok(await buyerBal() === 97 && w2.availableBalance === 0 && (w2.balance || 0) === 0 && !w2.refundRecoveryDebt, 'balances unchanged by the repeats');

    console.log('\n[F3] competing path AFTER wallet refund: chargeback refused, gateway NEVER called');
    const e3 = await refusal(quietRun(fos.fosSubmitRefund, Object.assign({ data: { payRef: s.ref, amountKES: 97, reason: 'dup' } }, ADMIN)));
    ok(e3 && /already/.test(e3.code || ''), `fosSubmitRefund refused (${e3 && e3.code}: ${reasonOf(e3)})`);
    ok(gateway.calls.length === 0, `IntaSend chargeback calls: ${gateway.calls.length}`);

    console.log('\n[F6] settlement evidence preserved');
    const o = await getv(`orders/${s.orderId}`), p = await getv(`payments/${s.ref}`);
    ok(o.settlementStatus === 'settled', `order settlementStatus still "settled" (${o.settlementStatus})`);
    ok(o.refundStatus === 'REFUNDED' && o.refundRail === 'wallet' && o.refundAuthorityId === s.ref, 'refund recorded as NEW fields on the order');
    ok(p.walletCreditedAt && p.walletCreditCents === 8700 && p.walletCreditedTo === SELLER, 'payment credit markers intact');
    ok(p.refundStatus === 'REFUNDED' && p.sellerCreditReversedCents === 8700, 'payment records the reversal as a subsequent event');
  }

  console.log('\n[F3b] competing path the OTHER way: chargeback first, then wallet refund refused');
  await wipe();
  { const s = await seedWebhookCredit({ ref: 'SKN_CB_1' });
    const r = await tryRun(fos.fosSubmitRefund, Object.assign({ data: { payRef: s.ref, amountKES: 97, reason: 'cb' } }, ADMIN));
    ok(r.status === 'processed' && gateway.calls.length === 1, `chargeback processed once (status ${r.status}, calls ${gateway.calls.length})`);
    const w = await sellerW();
    ok(w.availableBalance === 0 && w.lifetimeEarnings === 0, 'seller credit reversed on the chargeback rail');
    const e = await refusal(quietRun(wallet.refundToWallet, Object.assign({ data: { orderId: s.orderId } }, ADMIN)));
    ok(e && /already/.test(e.code || ''), `wallet refund refused afterwards (${e && e.code})`);
    ok(await buyerBal() === 0, 'buyer NOT also credited to the wallet');
    const q = await getv('fosRefundQueue/ref_SKN_CB_1');
    const e2 = await refusal(quietRun(fos.fosApproveRefund, Object.assign({ data: { refundId: 'ref_SKN_CB_1' } }, ADMIN)));
    ok(q.status === 'processed' && e2 && gateway.calls.length === 1, `fosApproveRefund on the processed record: refused, still ${gateway.calls.length} chargeback`);
    ok((await getv(`orders/${s.orderId}`)).settlementStatus === 'settled', 'order evidence preserved on the chargeback rail');
  }

  console.log('\n[F3c] the defect sequence: a failed chargeback leaves NO second-chargeback opening');
  await wipe();
  { const s = await seedWebhookCredit({ ref: 'SKN_CB_2' });
    gateway.mode = 'fail';
    const r = await tryRun(fos.fosSubmitRefund, Object.assign({ data: { payRef: s.ref, amountKES: 97, reason: 'x' } }, ADMIN));
    ok(r.status === 'failed', `gateway failure reported (${r.status})`);
    const a = await getv(`refundAuthority/${s.ref}`);
    ok(a.status === 'CHARGEBACK_FAILED', 'claim KEPT as CHARGEBACK_FAILED');
    gateway.mode = 'success';
    const e1 = await refusal(quietRun(fos.fosApproveRefund, Object.assign({ data: { refundId: 'ref_SKN_CB_2' } }, ADMIN)));
    const e2 = await refusal(quietRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref } }, ADMIN)));
    ok(e1 && e2 && gateway.calls.length === 1, `approve + wallet both refused; chargeback attempts stay at ${gateway.calls.length}`);
    const w = await sellerW();
    ok(w.availableBalance === 8700, 'seller NOT reversed for a chargeback that did not happen');
  }

  console.log('\n[F3d] gateway succeeded but completion failed -> approve FINISHES it, no second chargeback');
  await wipe();
  { const s = await seedWebhookCredit({ ref: 'SKN_CB_3' });
    /* Break completion AFTER the claim: delete the credit ledger row once the gateway is called. */
    const orig = fakeAdapter.initiateRefund;
    fakeAdapter.initiateRefund = async (a) => {
      const res = await orig(a);
      const rows = await db.collection('wallets').doc(SELLER).collection('transactions').get();
      await Promise.all(rows.docs.map((d) => d.ref.delete()));
      return res;
    };
    const r = await tryRun(fos.fosSubmitRefund, Object.assign({ data: { payRef: s.ref, amountKES: 97, reason: 'x' } }, ADMIN));
    fakeAdapter.initiateRefund = orig;
    ok(r.status === 'gateway_succeeded_completion_failed', `completion failure surfaced (${r.status})`);
    ok((await getv(`refundAuthority/${s.ref}`)).status === 'CHARGEBACK_PENDING', 'authority stays CHARGEBACK_PENDING');
    await db.collection('wallets').doc(SELLER).collection('transactions').add({ type: 'sale', direction: 'credit', amountCents: 8700, orderId: s.ref });
    const r2 = await tryRun(fos.fosApproveRefund, Object.assign({ data: { refundId: 'ref_SKN_CB_3' } }, ADMIN));
    ok(r2.status === 'processed' && gateway.calls.length === 1, `approve completed it with ${gateway.calls.length} chargeback total`);
    ok((await sellerW()).availableBalance === 0, 'seller reversed exactly once');
  }

  console.log('\n[F4] seller reversal follows the money (planSellerReversal, then applied)');
  const P = RA.planSellerReversal;
  { const p = P('FINOS_CENTS', { availableBalance: 8700, withdrawableBalance: 8700, balance: 0 }, 8700);
    ok(p.fromFinosCents === 8700 && p.fromBalanceShillings === 0 && p.debtShillings === 0, 'unswept: all from FinOS'); }
  { const p = P('FINOS_CENTS', { availableBalance: 0, withdrawableBalance: 0, balance: 87 }, 8700);
    ok(p.fromFinosCents === 0 && p.fromBalanceShillings === 87 && p.changeCents === 0, 'fully swept: all from balance'); }
  { const p = P('FINOS_CENTS', { availableBalance: 30, withdrawableBalance: 30, balance: 100 }, 8750);
    const removed = p.fromFinosCents + p.fromBalanceShillings * 100 - p.changeCents;
    ok(removed === 8750 && p.changeCents === 80 && p.fromBalanceShillings === 88, `partly swept, sub-shilling: exactly 8750c removed (finos ${p.fromFinosCents}, balance ${p.fromBalanceShillings}, change ${p.changeCents})`); }
  { const p = P('FINOS_CENTS', { availableBalance: 0, withdrawableBalance: 0, balance: 20 }, 8700);
    ok(p.fromBalanceShillings === 20 && p.debtShillings === 67, 'seller already withdrew: balance floored at 0, 67 -> refundRecoveryDebt'); }
  { const p = P('BALANCE_SHILLINGS', { balance: 500 }, 18400);
    ok(p.fromBalanceShillings === 184 && p.finosDeltaCents === 0, 'booking family: reversed from balance only'); }
  await wipe();
  { const s = await seedWebhookCredit({ ref: 'SKN_SWEPT', sellerWallet: { availableBalance: 0, withdrawableBalance: 0, lifetimeEarnings: 8700, balance: 50 } });
    await tryRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref } }, ADMIN));
    const w = await sellerW();
    ok(w.balance === 0 && w.refundRecoveryDebt === 37 && w.availableBalance === 0 && w.lifetimeEarnings === 0,
      `applied, swept + partly withdrawn: balance ${w.balance}, debt ${w.refundRecoveryDebt}, lifetime ${w.lifetimeEarnings}`); }
  await wipe();
  { const s = await seedWebhookCredit({ ref: 'BKG_1', orderId: null, family: 'BALANCE', net: 18400, gross: 200,
      sellerWallet: { balance: 184 } });
    await tryRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref } }, ADMIN));
    const w = await sellerW();
    ok(w.balance === 0 && !w.availableBalance, `booking credit reversed from balance (${w.balance})`); }

  console.log('\n[F5] no valid original credit marker -> FAIL CLOSED, nothing written');
  const failClosed = async (label, seedOpts, reasonRx) => {
    await wipe();
    const s = await seedWebhookCredit(seedOpts);
    const before = JSON.stringify([await sellerW(), await get(`orders/${s.orderId || 'x'}`), await get(`payments/${s.ref}`)]);
    const e = await refusal(quietRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref } }, ADMIN)));
    const e2 = await refusal(quietRun(fos.fosSubmitRefund, Object.assign({ data: { payRef: s.ref, amountKES: s.gross, reason: 'x' } }, ADMIN)));
    const after = JSON.stringify([await sellerW(), await get(`orders/${s.orderId || 'x'}`), await get(`payments/${s.ref}`)]);
    ok(e && e2 && reasonRx.test(reasonOf(e)) && reasonRx.test(reasonOf(e2)) && before === after && await buyerBal() === 0
      && gateway.calls.length === 0 && !(await get(`refundAuthority/${s.ref}`)),
      `${label}: both rails refused [${reasonOf(e)}], no writes, no chargeback`);
  };
  await failClosed('no credit markers on the payment', { ref: 'NM1', noMarker: true }, /no-seller-credit-marker/);
  await failClosed('markers but no ledger row', { ref: 'NM2', noLedgerRow: true }, /credit-ledger-row-not-found/);
  await failClosed('ledger row disagrees with marker amount', { ref: 'NM3', ledgerAmount: 5000 }, /credit-ledger-row-not-found/);
  await failClosed('order names a different seller', { ref: 'NM4', order: { sellerUid: 'someone_else' } }, /seller-disagrees/);
  await failClosed('payment not COMPLETE', { ref: 'NM5', payment: { status: 'PENDING' } }, /not-complete/);
  { await wipe(); const s = await seedWebhookCredit({ ref: 'NM6', buyer: null, payment: { uid: null } });
    const e = await refusal(quietRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref } }, ADMIN)));
    ok(e && /no-buyer/.test(reasonOf(e)) && (await sellerW()).availableBalance === 8700 && !(await get(`refundAuthority/${s.ref}`)),
      `payment naming no payer: wallet rail refused, seller untouched (${reasonOf(e)})`); }
  { await wipe(); const s = await seedWebhookCredit({ ref: 'NM7' });
    const e = await refusal(quietRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref, amount: 50 } }, ADMIN)));
    ok(e && /partial/.test(reasonOf(e)) && await buyerBal() === 0, `partial amount refused (${reasonOf(e)})`);
    const e2 = await refusal(quietRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref, targetUid: 'attacker' } }, ADMIN)));
    ok(e2 && /not-the-payer/.test(reasonOf(e2)) && !(await get('wallets/attacker')), `recipient other than the payer refused (${reasonOf(e2)})`); }
  { await wipe(); await db.doc('orders/ORD_NO_PAY').set({ sellerUid: SELLER, settlementStatus: 'settled' });
    const e = await refusal(quietRun(wallet.refundToWallet, Object.assign({ data: { orderId: 'ORD_NO_PAY', amount: 97, targetUid: BUYER } }, ADMIN)));
    ok(e && /no-payment-record/.test(reasonOf(e)) && await buyerBal() === 0, `order with no payment refused, no legacy credit (${reasonOf(e)})`); }

  console.log('\n[F7] concurrent / replayed invocation cannot double-reverse');
  await wipe();
  { const s = await seedWebhookCredit({ ref: 'CONC_1' });
    const attempts = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => quietRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref } }, ADMIN))),
      ...Array.from({ length: 3 }, () => quietRun(fos.fosSubmitRefund, Object.assign({ data: { payRef: s.ref, amountKES: 97, reason: 'race' } }, ADMIN))),
    ]);
    const won = attempts.filter((x) => x.status === 'fulfilled' && x.value && (x.value.success || x.value.status === 'processed'));
    const w = await sellerW();
    const reversalRows = (await db.collection('walletTransactions').where('type', '==', 'refund_reversal').get()).size;
    ok(won.length === 1, `7 concurrent attempts across BOTH rails -> exactly 1 outcome (${won.length})`);
    ok(w.availableBalance === 0 && w.lifetimeEarnings === 0 && !w.refundRecoveryDebt && reversalRows === 1, `seller reversed once (rows ${reversalRows}, avail ${w.availableBalance})`);
    const viaWallet = (await buyerBal()) === 97, viaChargeback = gateway.calls.length === 1;
    ok(viaWallet !== viaChargeback && gateway.calls.length <= 1, `buyer refunded by exactly ONE rail (wallet KES ${await buyerBal()}, chargebacks ${gateway.calls.length})`); }
  await wipe();
  { const s = await seedWebhookCredit({ ref: 'CONC_2' });
    await RA.claimChargeback(db, { paymentRef: s.ref, requestedBy: 'admin_1' });
    const replays = await Promise.allSettled(Array.from({ length: 5 }, () => RA.completeChargeback(db, { paymentRef: s.ref, gatewayRefundId: 'CB_X' })));
    const applied = replays.filter((x) => x.status === 'fulfilled' && x.value.idempotent === false).length;
    const w = await sellerW();
    ok(applied === 1 && w.availableBalance === 0 && w.lifetimeEarnings === 0, `5 concurrent completeChargeback replays -> 1 reversal (${applied})`); }

  console.log('\n[F8] unrelated wallet / business-wallet behaviour unchanged');
  await wipe();
  { await db.doc('wallets/bystander').set({ balance: 500, availableBalance: 1200 });
    await db.doc('businessWallets/SOK-TEST').set({ businessId: 'SOK-TEST', ownerId: 'o', balanceMinor: 4200 });
    const r = await tryRun(wallet.refundToWallet, Object.assign({ data: { orderId: 'GOODWILL-NOT-AN-ORDER', amount: 25, targetUid: 'goodwill_user', reason: 'goodwill' } }, ADMIN));
    const g = await getv('wallets/goodwill_user');
    ok(r.success && g.balance === 25 && !!(await get('walletTransactions/goodwill_user_GOODWILL-NOT-AN-ORDER_refund')),
      'a reference matching nothing SOKONI collected keeps the legacy admin credit');
    ok(JSON.stringify(await getv('wallets/bystander')) === JSON.stringify({ balance: 500, availableBalance: 1200 }), 'bystander wallet untouched');
    ok((await getv('businessWallets/SOK-TEST')).balanceMinor === 4200, 'businessWallets untouched');
    const s = await seedWebhookCredit({ ref: 'F8' });
    await tryRun(wallet.refundToWallet, Object.assign({ data: { paymentRef: s.ref } }, ADMIN));
    ok((await getv('businessWallets/SOK-TEST')).balanceMinor === 4200 && (await db.collection('businessWallets').get()).size === 1,
      'an authority refund writes NOTHING to businessWallets'); }

  console.log('\n[F9] refund REQUEST (initiateRefund routing) no longer erases settlement evidence');
  await wipe();
  { await db.doc('orders/REQ_1').set({ sellerUid: SELLER, settlementStatus: 'settled' });
    const r = await OS.handleOrderRefund(db, admin, 'REQ_1', { reason: 'x' });
    ok(r.outcome === 'webhook-credited' && (await getv('orders/REQ_1')).settlementStatus === 'settled', `lowercase settled left intact (${r.outcome})`);
    await db.doc('orders/REQ_2').set({ sellerUid: SELLER, settlementStatus: ' Settled ' });
    const r2 = await OS.markRefundedIfUnsettled(db, admin, 'REQ_2');
    ok(r2.outcome === 'already-settled' && (await getv('orders/REQ_2')).settlementStatus === ' Settled ', 'markRefundedIfUnsettled never overwrites any settled spelling');
    await db.doc('orders/REQ_3').set({ sellerUid: SELLER, settlementStatus: 'HELD' });
    const r3 = await OS.handleOrderRefund(db, admin, 'REQ_3', {});
    ok(r3.outcome === 'marked-refunded' && (await getv('orders/REQ_3')).settlementStatus === 'REFUNDED', 'CONTROL: an unsettled order is still marked REFUNDED (blocks settlement)'); }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a verdict):', e && e.stack || e); process.exit(3); });
