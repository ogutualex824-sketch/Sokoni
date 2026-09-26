/* test-creator-withdrawal.js — royalty WITHDRAWAL on the existing payout rail,
 * EXECUTED (real wallet.js: requestSellerPayout, adminProcessPayout,
 * finalizeB2CPayoutFromWebhook; fake Firestore with transaction semantics;
 * fake B2C adapter; no network).
 *
 * WHAT THESE PROVE (§22–24, §31)
 *   - only RELEASED royalties (in wallets.balance after quarterly distribution)
 *     are withdrawable; accrued / unsettled royalties are not
 *   - a withdrawal can never exceed the available balance
 *   - a duplicate (same idempotency key) is refused as a duplicate — one reserve
 *   - two concurrent withdrawals against one balance → at most the balance moves
 *   - approval initiates B2C and leaves the payout PROCESSING — NOT paid
 *   - only the provider's COMPLETE webhook marks it paid; a replay cannot flip it
 *   - a permanent provider failure → FAILED, funds returned, never paid
 *   - an ambiguous provider failure → outcome_unknown (never retried), never paid
 *     (the full ambiguous-outcome machine: scripts/test-payout-outcome-unknown.js)
 *   - a second approval cannot disburse twice
 *
 *   node scripts/test-creator-withdrawal.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-withdrawal';
process.env.INTASEND_PRIVATE_KEY = 'harness';
const Path = require('path');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const quiet = console.log; console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp });
stub('./redis-rate-limiter', { checkRateLimit: async () => true });
stub('./finos-utils', { intasendB2C: async () => { throw new Error('legacy helper must not be used'); } });
let B2C = 'ok'; const b2cCalls = [];
stub('./payment-adapters', { getAdapter: () => ({ sendMoneyB2C: async (a) => {
  b2cCalls.push(a);
  if (B2C === 'permanent') throw new Error('IntaSend send-money failed (400): invalid phone number');
  if (B2C === 'transient') throw new Error('socket hang up ETIMEDOUT');
  return { tracking_id: 'TRK' + b2cCalls.length, status: 'Confirming balance' };
} }) });

const W = require(Path.join(FN, 'wallet.js'));
const user = (uid) => ({ auth: { uid, token: {} } });
const ADMIN = { auth: { uid: 'adm1', token: { admin: true } } };
const req = (uid, amount, key) => W.requestSellerPayout.run({ ...user(uid), data: { amount, method: 'mpesa', accountNumber: '0712345678', idempotencyKey: key } });
const approve = (rid) => W.adminProcessPayout.run({ ...ADMIN, data: { requestId: rid, status: 'approved' } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const read = async (p) => (await db.doc(p).get()).data() || {};

let pass = 0, fail = 0;
const ck = (l, ok, d) => { quiet('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 120) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  /* p0: royalties ACCRUED in the ledger, quarter not settled → nothing in the wallet */
  await db.doc('royaltyLedger/earn_X_v1_p0').set({ uid: 'p0', kind: 'EARN', amountCents: 50000, periodId: '2026-Q4' });
  /* p1: a quarter was DISTRIBUTED — exactly what creatorAdminDistribute writes */
  await db.doc('wallets/p1').set({ balance: 300 });
  await db.doc('walletTransactions/p1_2026-Q3_royalty').set({ uid: 'p1', type: 'royalty_release', amount: 300, periodId: '2026-Q3' });
  await db.doc('wallets/p2').set({ balance: 300 });
  await db.doc('wallets/p3').set({ balance: 300 });
  for (const u of ['p0', 'p1', 'p2', 'p3']) await db.doc('users/' + u).set({ accountStatus: 'active' });

  quiet('\n── only released royalties are withdrawable ──');
  ck('accrued-but-unsettled royalties cannot be withdrawn', (await code(req('p0', 100, 'k0'))) === 'failed-precondition', await code(req('p0', 100, 'k0b')));
  ck('withdrawal above the available balance refused', (await code(req('p1', 500, 'k1big'))) === 'failed-precondition');
  ck('…balance untouched', (await read('wallets/p1')).balance === 300);

  quiet('\n── request, duplicate, concurrency ──');
  const r1 = await req('p1', 200, 'K1');
  const pr = await read('payoutRequests/pout_K1');
  ck('withdrawal of released funds accepted (deterministic id pout_K1)', !!r1 && pr.amount === 200 && pr.sellerUid === 'p1', JSON.stringify(r1).slice(0, 100));
  ck('funds reserved: balance 100, pendingPayout 200', (await read('wallets/p1')).balance === 100 && (await read('wallets/p1')).pendingPayout === 200);
  ck('not paid at request time', pr.status !== 'paid');
  const dup = await req('p1', 200, 'K1').catch((e) => ({ err: e.code }));
  ck('duplicate (same key) → no second reserve', (await read('wallets/p1')).balance === 100 && (await read('wallets/p1')).pendingPayout === 200, JSON.stringify(dup).slice(0, 80));
  const race = await Promise.allSettled([req('p1', 100, 'K2'), req('p1', 100, 'K3')]);
  const w1 = await read('wallets/p1');
  ck('two concurrent withdrawals on 100 → balance never negative, at most 100 moved', w1.balance >= 0 && w1.pendingPayout <= 300 && race.filter((x) => x.status === 'fulfilled').length <= 1, race.map((x) => x.status).join('/') + ' bal=' + w1.balance);

  quiet('\n── manual mode (default: auto-B2C OFF) ──');
  await db.doc('wallets/p4').set({ balance: 300 }); await db.doc('users/p4').set({ accountStatus: 'active' });
  await req('p4', 150, 'KM');
  const am = await approve('pout_KM');
  ck('manual mode: approval does NOT disburse and does NOT mark paid', am.status === 'approved' && b2cCalls.length === 0 && (await read('payoutRequests/pout_KM')).status === 'approved');
  ck('manual mode: marking paid WITHOUT external reference + attestation refused', (await code(W.adminProcessPayout.run({ ...ADMIN, data: { requestId: 'pout_KM', status: 'paid' } }))) !== null && (await read('payoutRequests/pout_KM')).status === 'approved');

  quiet('\n── auto mode: provider confirmation is the ONLY way to paid ──');
  await db.doc('config/payouts').set({ autoB2C: true }, { merge: true });
  B2C = 'ok';
  await approve('pout_K1');
  const after = await read('payoutRequests/pout_K1');
  ck('approval initiates B2C once', b2cCalls.length === 1 && b2cCalls[0].amountKES === 200);
  ck('after approval: PROCESSING, not paid', after.status === 'processing', after.status);
  ck('second approval cannot disburse again', (await code(approve('pout_K1'))) !== null && b2cCalls.length === 1);
  await W.finalizeB2CPayoutFromWebhook(db, 'pout_K1', 'Processing payment', { status: 'Processing payment' });
  ck('in-flight provider status leaves it PROCESSING', (await read('payoutRequests/pout_K1')).status === 'processing');
  await W.finalizeB2CPayoutFromWebhook(db, 'pout_K1', 'Completed', { status: 'Completed', paid_amount: 200 });
  ck('provider COMPLETE → paid', (await read('payoutRequests/pout_K1')).status === 'paid');
  ck('pendingPayout released on paid (200 released; the 100 race winner still reserved)', (await read('wallets/p1')).pendingPayout === 100, (await read('wallets/p1')).pendingPayout);
  await W.finalizeB2CPayoutFromWebhook(db, 'pout_K1', 'FAILED', { status: 'FAILED' });
  ck('a later FAILED replay cannot flip paid → failed', (await read('payoutRequests/pout_K1')).status === 'paid');

  quiet('\n── provider failure never marks paid ──');
  await req('p2', 200, 'K4');
  B2C = 'permanent';
  await approve('pout_K4').catch(() => {});
  const f4 = await read('payoutRequests/pout_K4');
  ck('permanent provider failure → FAILED, not paid', f4.status === 'failed', f4.status);
  ck('…funds returned to the wallet (300)', (await read('wallets/p2')).balance === 300, JSON.stringify(await read('wallets/p2')));
  await req('p3', 200, 'K5');
  B2C = 'transient';
  await approve('pout_K5').catch(() => {});
  const f5 = await read('payoutRequests/pout_K5');
  ck('ambiguous provider failure → outcome_unknown (not retried), not paid', f5.status === 'outcome_unknown', f5.status);
  ck('…funds still reserved (not released, not paid)', (await read('wallets/p3')).pendingPayout === 200);

  quiet('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { quiet('HARNESS CRASHED', e); process.exit(2); });
