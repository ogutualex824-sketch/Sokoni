'use strict';
/**
 * CERTIFICATION — payout paid-state guard (extends 61098e9). Runs functions/wallet.js on the Firestore EMULATOR.
 *
 * Invariant: a payout that is terminal, or that a gateway payment may already have paid, must not produce another
 * financial settlement or refund effect. Manual Mark Paid is allowed from `approved` ONLY.
 *
 *   A-*  Mark Paid: approved → settled_manually (exact money effect); every other source refused with NO financial
 *        mutation (status, balance, pendingPayout, ledger all unchanged) and the right reason
 *   L-*  late call on an already-final payout reports the real status (alreadySettled), changes nothing
 *   V-*  REVERSED webhook: refused with no money effect on rejected / failed / reversed / settled_manually / pending /
 *        approved; still applied on processing and outcome_unknown (hold released)
 *   G-*  controls: gateway COMPLETED still settles processing; the evidence requirement still holds
 *   C-*  concurrency: Mark Paid racing Reject on the same approved payout → exactly one financial effect
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-payout-guard';
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
const WATCHDOG = setTimeout(() => { console.log('\n  BLOCKED — watchdog: suite exceeded 280s'); process.exit(3); }, 280000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const { Timestamp } = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const W = require(path.join(FN, 'wallet.js'));

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; console.log('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m); };
/* Silence the code under test. A depth counter, because concurrent calls (C-*) overlap: a naive save/restore lets the
   second call "restore" the already-silenced console and swallow every result after it. */
const _REAL = [console.log, console.warn, console.error];
let _q = 0;
const quiet = async (fn) => {
  if (_q++ === 0) { console.log = console.warn = console.error = () => {}; }
  try { return await fn(); } finally { if (--_q === 0) { [console.log, console.warn, console.error] = _REAL; } }
};
const ADMIN = { auth: { uid: 'guard-admin', token: { admin: true, uid: 'guard-admin' } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false };
async function adminCall(data) {
  try { const r = await quiet(() => W.adminProcessPayout.run(Object.assign({ data }, ADMIN))); return { ok: true, r }; }
  catch (e) { return { ok: false, code: e.code, msg: String(e.message) }; }
}
const PAID = (rid, extra) => Object.assign({ requestId: rid, status: 'paid', externalReference: 'QWE123RTY', attestation: 'sent by finance, M-PESA, 10:30' }, extra || {});
const WH = (rid, status) => quiet(() => W.finalizeB2CPayoutFromWebhook(db, rid, status, { status, paid_amount: /COMPLETE/i.test(status) ? 100 : 0, failed_amount: status === 'FAILED' ? 100 : 0 }));

async function state(uid, rid) {
  const w = (await db.collection('wallets').doc(uid).get()).data() || {};
  const p = (await db.collection('payoutRequests').doc(rid).get()).data() || {};
  const ledger = (await db.collection('walletTransactions').where('uid', '==', uid).get()).docs.map((d) => d.id).sort().join(',');
  return { status: p.status, balance: w.balance, pendingPayout: w.pendingPayout, ledger, history: (p.statusHistory || []).map((h) => h.status) };
}
const money = (s) => JSON.stringify([s.status, s.balance, s.pendingPayout, s.ledger]);
let n = 0;
/* A payout in a given state, with the money where that state leaves it:
   reserved (pending hold 100 of 1000) for pre-final states; returned (1000/0) for rejected/failed/reversed;
   released with a ledger row (900/0) for paid/settled_manually. */
async function payout(status, extra) {
  const tag = 'g' + (++n) + '_' + status, uid = 'seller_' + tag, rid = 'pout_' + tag;
  const returned = ['rejected', 'failed', 'reversed'].includes(status);
  const released = ['paid', 'settled_manually'].includes(status);
  await db.collection('wallets').doc(uid).set({ uid, balance: returned ? 1000 : 900, pendingPayout: (returned || released) ? 0 : 100 });
  if (released) await db.collection('walletTransactions').doc(`${uid}_${rid}_payout`).set({ uid, type: 'payout', amount: 100, status: 'completed' });
  await db.collection('payoutRequests').doc(rid).set(Object.assign({ sellerUid: uid, amount: 100, method: 'mpesa', accountNumber: '0700000000', status,
    createdAt: Timestamp.now(), statusHistory: [] }, extra || {}));
  return { uid, rid };
}

(async () => {
  console.log(`\nPayout paid-state guard   (tree: ${ROOT})\n`);

  console.log('[A] Mark Paid is approved-only');
  { const { uid, rid } = await payout('approved');
    const r = await adminCall(PAID(rid)); const s = await state(uid, rid);
    ok(r.ok && r.r.status === 'settled_manually' && s.status === 'settled_manually' && s.balance === 900 && s.pendingPayout === 0 && s.ledger === `${uid}_${rid}_payout`, 'A-1',
      `approved → settled_manually: hold released once, balance unchanged, one ledger row (${JSON.stringify([s.status, s.balance, s.pendingPayout])})`); }
  const refused = [
    ['A-2', 'pending', /Only an approved payout/],
    ['A-3', 'approving', /gateway payment was sent or is being sent/],
    ['A-4', 'processing', /gateway payment was sent or is being sent/, { intasendRef: 'ISR-A4' }],
    ['A-5', 'retry_scheduled', /gateway payment was sent or is being sent/],
    ['A-6', 'rejected', /funds were already returned/],
    ['A-7', 'failed', /funds were already returned/],
    ['A-8', 'reversed', /funds were already returned/],
    ['A-9', 'outcome_unknown', /unknown provider outcome/],
    ['A-10', 'scheduled', /Only an approved payout/],
  ];
  for (const [id, st, reason, extra] of refused) {
    const { uid, rid } = await payout(st, extra);
    const before = await state(uid, rid); const r = await adminCall(PAID(rid)); const after = await state(uid, rid);
    ok(!r.ok && r.code === 'failed-precondition' && reason.test(r.msg) && money(before) === money(after), id,
      `${st} → Mark Paid REFUSED, no financial effect (${r.ok ? 'ACCEPTED → ' + after.status : '[' + r.code + '] ' + r.msg.slice(0, 70)}; money ${money(before) === money(after) ? 'unchanged' : 'CHANGED ' + money(before) + '→' + money(after)})`);
  }

  console.log('\n[L] a late call on an already-final payout tells the truth');
  for (const [id, st] of [['L-1', 'paid'], ['L-2', 'settled_manually']]) {
    const { uid, rid } = await payout(st);
    const before = await state(uid, rid); const r = await adminCall(PAID(rid)); const after = await state(uid, rid);
    ok(r.ok && r.r.status === st && r.r.alreadySettled === true && money(before) === money(after), id,
      `${st} → Mark Paid reports "${r.ok ? r.r.status : 'error'}" (alreadySettled ${r.ok && r.r.alreadySettled}), never a status it did not record; nothing changes`);
  }

  console.log('\n[V] a REVERSED webhook never pays twice');
  for (const [id, st] of [['V-1', 'rejected'], ['V-2', 'failed'], ['V-3', 'reversed'], ['V-4', 'settled_manually'], ['V-5', 'pending'], ['V-6', 'approved']]) {
    const { uid, rid } = await payout(st);
    const before = await state(uid, rid); await quiet(() => W.finalizeB2CPayoutFromWebhook(db, rid, 'REVERSED', { status: 'REVERSED' })); const after = await state(uid, rid);
    ok(money(before) === money(after), id, `${st} + REVERSED → no financial effect (${money(before) === money(after) ? 'unchanged' : 'CHANGED ' + money(before) + '→' + money(after)})`);
  }
  { const { uid, rid } = await payout('rejected');
    await quiet(() => W.finalizeB2CPayoutFromWebhook(db, rid, 'REVERSED', { status: 'REVERSED' }));
    const s = await state(uid, rid);
    ok(s.history.includes('reversal_refused') && s.status === 'rejected' && s.balance === 1000, 'V-7', 'a refused reversal is RECORDED in the payout history, not silently dropped (history: ' + s.history.join('>') + ')'); }
  for (const [id, st] of [['V-8', 'processing'], ['V-9', 'outcome_unknown']]) {
    const { uid, rid } = await payout(st, { intasendRef: 'ISR-' + id });
    await quiet(() => W.finalizeB2CPayoutFromWebhook(db, rid, 'REVERSED', { status: 'REVERSED' })); const s = await state(uid, rid);
    ok(s.status === 'reversed' && s.balance === 1000 && s.pendingPayout === 0, id, `CONTROL — ${st} + REVERSED is still a real reversal: hold released once (${JSON.stringify([s.status, s.balance, s.pendingPayout])})`);
  }

  console.log('\n[W] the gateway path cannot settle a payout whose funds were returned (61098e9 guard, no requireStatus)');
  for (const [id, st] of [['W-1', 'rejected'], ['W-2', 'failed']]) {
    const { uid, rid } = await payout(st, { intasendRef: 'ISR-' + id });
    const before = await state(uid, rid); await WH(rid, 'Completed'); const after = await state(uid, rid);
    ok(money(before) === money(after), id, `${st} + gateway COMPLETED → no financial effect (${money(before) === money(after) ? 'unchanged' : 'CHANGED ' + money(before) + '→' + money(after)})`);
  }

  console.log('\n[G] controls');
  { const { uid, rid } = await payout('processing', { intasendRef: 'ISR-G1' });
    await WH(rid, 'Completed'); const s = await state(uid, rid);
    ok(s.status === 'paid' && s.balance === 900 && s.pendingPayout === 0 && s.ledger === `${uid}_${rid}_payout`, 'G-1', `CONTROL — gateway COMPLETED still settles a processing payout (${JSON.stringify([s.status, s.balance, s.pendingPayout])})`); }
  { const { uid, rid } = await payout('approved');
    const before = await state(uid, rid); const r = await adminCall({ requestId: rid, status: 'paid', externalReference: 'QWE123RTY' }); const after = await state(uid, rid);
    ok(!r.ok && /requires externalReference/.test(r.msg) && money(before) === money(after), 'G-2', 'CONTROL — an approved payout still needs reference + attestation'); }

  console.log('\n[C] concurrency');
  { const { uid, rid } = await payout('approved');
    const [a, b] = await Promise.all([adminCall(PAID(rid)), adminCall({ requestId: rid, status: 'rejected', note: 'race' })]);
    const s = await state(uid, rid);
    const settledOnly = s.status === 'settled_manually' && s.balance === 900 && s.pendingPayout === 0 && s.ledger === `${uid}_${rid}_payout`;
    const rejectedOnly = s.status === 'rejected' && s.balance === 1000 && s.pendingPayout === 0 && s.ledger === '';
    ok(settledOnly || rejectedOnly, 'C-1', `Mark Paid racing Reject → exactly one financial effect (${s.status}; ${JSON.stringify([s.balance, s.pendingPayout, s.ledger ? 'ledger' : 'no-ledger'])}; paid:${a.ok ? 'ok' : 'refused'} reject:${b.ok ? 'ok' : 'refused'})`); }

  clearTimeout(WATCHDOG);
  console.log(`\npayout-guard: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { clearTimeout(WATCHDOG); console.log('\n  CRASH ' + (e && e.stack || e)); process.exit(5); });
