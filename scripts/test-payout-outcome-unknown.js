/* test-payout-outcome-unknown.js — the payout AMBIGUOUS-OUTCOME state machine,
 * EXECUTED (real functions/wallet.js: requestSellerPayout, adminProcessPayout,
 * processPayoutRetries, adminResolvePayoutOutcome, finalizeB2CPayoutFromWebhook;
 * the transactional fake Firestore; a COUNTING fake B2C adapter; no network).
 *
 * A fake provider response proves the CODE's control flow for that answer — never
 * how real IntaSend behaves. Nothing here is live certification.
 *
 *   W1   over-withdrawal refused before any provider call
 *   W2   concurrent / repeated same-key requests → one payout, one provider call
 *   W3A  definitive 4xx → FAILED, funds released ONCE, never retried
 *   W3B  timeout / 5xx / 429 → OUTCOME_UNKNOWN, funds reserved, no second call —
 *        not from the retry worker, not from an admin approve/reject/mark-paid
 *   W3C  evidence resolution → one PAID; repeat is a no-op
 *   W3D  evidence resolution → one FAILED, funds released once; repeat is a no-op
 *   W3E  concurrent contradicting resolutions → exactly one terminal outcome
 *
 *   node scripts/test-payout-outcome-unknown.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-payout-outcome';
process.env.INTASEND_PRIVATE_KEY = 'harness';
const Path = require('path');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const quiet = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp });
stub('./redis-rate-limiter', { checkRateLimit: async () => true });
stub('./finos-utils', { intasendB2C: async () => { throw new Error('legacy helper must not be used'); } });

/* Counting fake B2C adapter. Errors carry e.gateway exactly as payment-adapters.js
   sendMoneyB2C builds them for an HTTP answer; transport errors carry none. */
let MODE = 'ok'; const sends = [];
const httpErr = (status, code, msg) => { const e = new Error(`IntaSend B2C failed (${status}): [${code}] ${msg}`); e.gateway = { name: 'IntaSend', http: status, code, message: msg }; return e; };
stub('./payment-adapters', { getAdapter: () => ({ sendMoneyB2C: async (a) => {
  sends.push({ ...a, mode: MODE });
  if (MODE === 'reject400') throw httpErr(400, 'INVALID', 'invalid phone number');
  if (MODE === 'timeout')   throw new Error('socket hang up ETIMEDOUT');
  if (MODE === 'http503')   throw httpErr(503, 'HTTP_503', 'upstream unavailable');
  if (MODE === 'http429')   throw httpErr(429, 'HTTP_429', 'rate limited');
  return { tracking_id: 'TRK' + sends.length, status: 'Confirming balance' };
} }) });

const W = require(Path.join(FN, 'wallet.js'));
const ADMIN = { auth: { uid: 'adm1', token: { admin: true } } };
const SUPER = (uid = 'sup1') => ({ auth: { uid, token: { superAdmin: true, email: uid + '@sokoni.test' } } });
const req = (uid, amount, key) => W.requestSellerPayout.run({ auth: { uid, token: {} }, data: { amount, method: 'mpesa', accountNumber: '0712345678', ...(key ? { idempotencyKey: key } : {}) } });
const admin = (rid, status, extra = {}) => W.adminProcessPayout.run({ ...ADMIN, data: { requestId: rid, status, ...extra } });
const resolve = (rid, decision, evidence, who = SUPER()) => W.adminResolvePayoutOutcome.run({ ...who, data: { requestId: rid, decision, evidence } });
const EV_PAID = (ref) => ({ type: 'intasend_transaction', reference: ref, note: 'IntaSend dashboard shows this transfer COMPLETE to 2547****678' });
const EV_NOT = (ref) => ({ type: 'provider_statement', reference: ref, note: 'IntaSend payout statement for the day has no transfer for this number/amount' });
async function out(p) { try { return { ok: await p }; } catch (e) { return { err: e.code || e.message, msg: e.message }; } }
const read = async (p) => (await db.doc(p).get()).data() || null;
const wal = async (u) => { const w = (await read('wallets/' + u)) || {}; return { balance: w.balance, pending: w.pendingPayout || 0 }; };
const countWhere = async (col, f, v) => (await db.collection(col).where(f, '==', v).get()).size;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { quiet('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 140) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  /* INSTANT mode: the provider CAN be reached at request time. */
  await db.doc('config/payouts').set({ enabled: true, autoB2C: true, requirePin: false, instantLimit: 100000, dailyLimit: 1000000, holdNewSellersDays: 0, maxPayoutsPerDay: 50, scheduledAbove: 0 });
  const mkUser = async (u, bal) => { await db.doc('wallets/' + u).set({ balance: bal }); await db.doc('users/' + u).set({ accountStatus: 'active', payoutVerified: true, createdAt: F.Timestamp.fromMillis(Date.now() - 90 * 86400000) }); };

  /* ── W1 ── */
  quiet('\n── W1  over-withdrawal ──');
  await mkUser('w1', 300);
  let n = sends.length;
  const w1 = await out(req('w1', 500, 'W1KEY'));
  ck('W1 request above the balance refused', w1.err === 'failed-precondition', w1.msg);
  ck('W1 zero provider calls', sends.length - n === 0, sends.length - n);
  ck('W1 wallet untouched (300 / 0 reserved)', JSON.stringify(await wal('w1')) === JSON.stringify({ balance: 300, pending: 0 }), await wal('w1'));
  ck('W1 no payout document', (await read('payoutRequests/pout_W1KEY')) === null);

  /* ── W2 ── */
  quiet('\n── W2  duplicate / concurrent ──');
  await mkUser('w2', 1000);
  n = sends.length;
  const dup = await Promise.all(Array.from({ length: 5 }, () => out(req('w2', 200, 'W2KEY'))));
  const again = await out(req('w2', 200, 'W2KEY'));
  ck('W2 5 concurrent + 1 repeat → exactly one provider call', sends.length - n === 1, sends.length - n);
  ck('W2 one payout document', (await countWhere('payoutRequests', 'sellerUid', 'w2')) === 1);
  ck('W2 balance debited once (800 / 200 reserved)', JSON.stringify(await wal('w2')) === JSON.stringify({ balance: 800, pending: 200 }), await wal('w2'));
  ck('W2 the repeat is reported as a duplicate', !!(again.ok && again.ok.deduplicated), again);
  ck('W2 no request errored', dup.every((r) => r.ok), dup.map((r) => r.err || 'ok'));

  /* ── W3A ── */
  quiet('\n── W3A  definitive provider rejection (4xx) ──');
  await mkUser('w3a', 500); MODE = 'reject400';
  n = sends.length;
  const r3a = await out(req('w3a', 200, 'W3A'));
  const p3a = await read('payoutRequests/pout_W3A');
  ck('W3A status FAILED', p3a.status === 'failed', p3a.status);
  ck('W3A seller told the funds were returned', r3a.ok && r3a.ok.status === 'failed', r3a);
  ck('W3A funds released once (500 / 0 reserved)', JSON.stringify(await wal('w3a')) === JSON.stringify({ balance: 500, pending: 0 }), await wal('w3a'));
  MODE = 'ok';
  await W.processPayoutRetries.run({});
  ck('W3A retry worker makes no call', sends.length - n === 1, sends.length - n);
  await W.finalizeB2CPayoutFromWebhook(db, 'pout_W3A', 'FAILED', { status: 'FAILED' });
  ck('W3A a FAILED replay does not release the funds a second time', JSON.stringify(await wal('w3a')) === JSON.stringify({ balance: 500, pending: 0 }), await wal('w3a'));
  ck('W3A approve of a FAILED payout refused (no resend)', (await out(admin('pout_W3A', 'approved'))).err === 'failed-precondition' && sends.length - n === 1);
  ck('W3A manual mark-paid of a FAILED payout refused (funds already returned)', (await out(admin('pout_W3A', 'paid', { externalReference: 'QAB123', attestation: 'sent by hand' }))).err === 'failed-precondition'
    && JSON.stringify(await wal('w3a')) === JSON.stringify({ balance: 500, pending: 0 }), await wal('w3a'));
  ck('W3A exactly one provider call in total', sends.length - n === 1, sends.length - n);

  /* ── W3B ── */
  quiet('\n── W3B  ambiguous outcome (timeout / 5xx / 429) ──');
  await mkUser('w3b', 500); MODE = 'timeout';
  n = sends.length;
  const r3b = await out(req('w3b', 200, 'W3B'));
  let p3b = await read('payoutRequests/pout_W3B');
  ck('W3B timeout → OUTCOME_UNKNOWN', p3b.status === 'outcome_unknown', p3b.status);
  ck('W3B seller is NOT told it was sent', r3b.ok && r3b.ok.status === 'outcome_unknown' && !/sent/i.test(r3b.ok.message.replace('confirming', '')), r3b.ok && r3b.ok.message);
  ck('W3B funds stay reserved (300 / 200)', JSON.stringify(await wal('w3b')) === JSON.stringify({ balance: 300, pending: 200 }), await wal('w3b'));
  ck('W3B flagged for review, no retryAt scheduled', p3b.reconcileFlag === 'needs_review' && p3b.retryAt === undefined, { flag: p3b.reconcileFlag, retryAt: p3b.retryAt ? 'set' : 'none' });
  MODE = 'ok';
  /* Force any backoff into the past, so the worker is not skipping it merely because
     a retry window has not elapsed yet (the unrepaired code resends here). */
  await db.doc('payoutRequests/pout_W3B').update({ retryAt: F.Timestamp.fromMillis(Date.now() - 1) });
  await W.processPayoutRetries.run({});
  await W.processPayoutRetries.run({});
  ck('W3B retry worker skips it — no second provider call', sends.length - n === 1, sends.length - n);
  ck('W3B …still OUTCOME_UNKNOWN', (await read('payoutRequests/pout_W3B')).status === 'outcome_unknown');
  const ap = await out(admin('pout_W3B', 'approved'));
  ck('W3B admin approve refused (would be a second send)', ap.err === 'failed-precondition' && sends.length - n === 1, ap.msg);
  const rj = await out(admin('pout_W3B', 'rejected', { note: 'x' }));
  ck('W3B admin reject refused (money may have left)', rj.err === 'failed-precondition' && JSON.stringify(await wal('w3b')) === JSON.stringify({ balance: 300, pending: 200 }), rj.msg);
  const mp = await out(admin('pout_W3B', 'paid', { externalReference: 'QAB999', attestation: 'I think it went' }));
  ck('W3B generic manual mark-paid refused — evidence path only', mp.err === 'failed-precondition' && (await read('payoutRequests/pout_W3B')).status === 'outcome_unknown', mp.msg);
  const again3b = await out(req('w3b', 200, 'W3B'));
  ck('W3B same-key repeat → duplicate, no provider call', !!(again3b.ok && again3b.ok.deduplicated) && sends.length - n === 1, again3b);
  const other3b = await out(req('w3b', 100, 'W3B-2'));
  ck('W3B a NEW withdrawal while one is unknown is not instant (no provider call)', other3b.ok && other3b.ok.mode !== 'instant' && sends.length - n === 1, other3b.ok && other3b.ok.mode);
  const wh = await W.finalizeB2CPayoutFromWebhook(db, 'TRK-UNRELATED', 'Completed', { status: 'Completed' });
  ck('W3B an unrelated tracking id does not match it (no reference was ever returned)', wh === false && (await read('payoutRequests/pout_W3B')).status === 'outcome_unknown');

  for (const [mode, key, label] of [['http503', 'W3B503', '503'], ['http429', 'W3B429', '429']]) {
    const u = 'u' + key; await mkUser(u, 500); MODE = mode;
    const m0 = sends.length;
    await out(req(u, 200, key));
    MODE = 'ok';
    await W.processPayoutRetries.run({});
    const st = (await read('payoutRequests/pout_' + key)).status;
    ck(`W3B HTTP ${label} → OUTCOME_UNKNOWN, one call, funds reserved`, st === 'outcome_unknown' && sends.length - m0 === 1 && JSON.stringify(await wal(u)) === JSON.stringify({ balance: 300, pending: 200 }), { st, calls: sends.length - m0, w: await wal(u) });
  }

  /* A legacy 'retry_scheduled' payout (written by the old code) is parked, never re-sent. */
  await mkUser('leg', 300);
  await db.doc('payoutRequests/pout_LEGACY').set({ sellerUid: 'leg', amount: 200, method: 'mpesa', accountNumber: '0712345678', status: 'retry_scheduled', retryCount: 1, retryAt: F.Timestamp.fromMillis(Date.now() - 1000), createdAt: F.Timestamp.now() });
  await db.doc('wallets/leg').set({ balance: 100, pendingPayout: 200 });
  n = sends.length;
  await W.processPayoutRetries.run({});
  ck('W3B legacy retry_scheduled → OUTCOME_UNKNOWN with NO provider call', (await read('payoutRequests/pout_LEGACY')).status === 'outcome_unknown' && sends.length - n === 0, sends.length - n);
  ck('W3B legacy funds still reserved', JSON.stringify(await wal('leg')) === JSON.stringify({ balance: 100, pending: 200 }), await wal('leg'));

  /* ── W3C ── */
  quiet('\n── W3C  resolve → PAID (evidence) ──');
  n = sends.length;
  ck('W3C admin (not super admin) refused', (await out(resolve('pout_W3B', 'paid', EV_PAID('ISX-100'), ADMIN))).err === 'permission-denied');
  ck('W3C no evidence refused', (await out(resolve('pout_W3B', 'paid', {}))).err === 'invalid-argument');
  ck('W3C wrong evidence type for paid refused', (await out(resolve('pout_W3B', 'paid', EV_NOT('STMT-1')))).err === 'invalid-argument');
  ck('W3C a note that says nothing refused', (await out(resolve('pout_W3B', 'paid', { type: 'intasend_transaction', reference: 'ISX-100', note: 'ok' }))).err === 'invalid-argument');
  const c1 = await out(resolve('pout_W3B', 'paid', EV_PAID('ISX-100')));
  p3b = await read('payoutRequests/pout_W3B');
  ck('W3C resolved → PAID', c1.ok && c1.ok.status === 'paid' && p3b.status === 'paid', c1);
  /* w3b: 500 − 200 (this payout) − 100 (the W3B-2 request still under review) = 200;
     reserved 300 → 100 once THIS payout's 200 hold is released. */
  ck('W3C hold released once, balance not credited (200 / 100 — only W3B-2 still held)', JSON.stringify(await wal('w3b')) === JSON.stringify({ balance: 200, pending: 100 }), await wal('w3b'));
  const ledger = await read('walletTransactions/w3b_pout_W3B_payout');
  ck('W3C one payout ledger row', !!ledger && ledger.amount === 200 && ledger.type === 'payout');
  ck('W3C gateway reference recorded (reconcile gate: paid WITH a ref)', p3b.intasendRef === 'ISX-100' && p3b.gatewayReference === 'ISX-100');
  const res = await read('payoutResolutions/pout_W3B');
  ck('W3C audit: who, when, previous state, decision, evidence, resulting state', !!res && res.resolvedBy === 'sup1' && !!res.resolvedAt && res.previousStatus === 'outcome_unknown'
    && res.decision === 'paid' && res.evidence.type === 'intasend_transaction' && res.evidence.reference === 'ISX-100' && res.evidence.note.length >= 20 && res.resultingStatus === 'paid', res);
  ck('W3C the payout carries the same record', p3b.outcomeResolution && p3b.outcomeResolution.decision === 'paid');
  const wBefore = JSON.stringify(await wal('w3b'));
  const c2 = await out(resolve('pout_W3B', 'paid', EV_PAID('ISX-100')));
  ck('W3C repeat → no-op (alreadyResolved)', c2.ok && c2.ok.alreadyResolved === true && JSON.stringify(await wal('w3b')) === wBefore, c2);
  const c3 = await out(resolve('pout_W3B', 'not_paid', EV_NOT('STMT-9')));
  ck('W3C contradicting resolution refused', c3.err === 'failed-precondition' && JSON.stringify(await wal('w3b')) === wBefore, c3.msg);
  await W.finalizeB2CPayoutFromWebhook(db, 'pout_W3B', 'FAILED', { status: 'FAILED' });
  ck('W3C a later FAILED webhook cannot undo it', (await read('payoutRequests/pout_W3B')).status === 'paid' && JSON.stringify(await wal('w3b')) === wBefore);
  const reuse = await out(resolve('pout_W3B503', 'paid', EV_PAID('isx-100')));
  ck('W3C the same IntaSend transaction cannot settle a second payout', reuse.err === 'failed-precondition' && (await read('payoutRequests/pout_W3B503')).status === 'outcome_unknown', reuse.msg);
  ck('W3C zero provider calls during resolution', sends.length - n === 0);

  /* ── W3D ── */
  quiet('\n── W3D  resolve → NOT PAID (evidence) ──');
  const d1 = await out(resolve('pout_W3B503', 'not_paid', EV_NOT('STMT-503')));
  ck('W3D resolved → FAILED', d1.ok && d1.ok.status === 'failed' && (await read('payoutRequests/pout_W3B503')).status === 'failed', d1);
  ck('W3D funds released once (500 / 0)', JSON.stringify(await wal('uW3B503')) === JSON.stringify({ balance: 500, pending: 0 }), await wal('uW3B503'));
  const d2 = await out(resolve('pout_W3B503', 'not_paid', EV_NOT('STMT-503')));
  ck('W3D repeat → no-op, no second release', d2.ok && d2.ok.alreadyResolved === true && JSON.stringify(await wal('uW3B503')) === JSON.stringify({ balance: 500, pending: 0 }), await wal('uW3B503'));
  ck('W3D contradicting paid refused', (await out(resolve('pout_W3B503', 'paid', EV_PAID('ISX-503')))).err === 'failed-precondition');
  ck('W3D manual mark-paid afterwards refused (no double outcome)', (await out(admin('pout_W3B503', 'paid', { externalReference: 'QAB503', attestation: 'sent by hand' }))).err === 'failed-precondition'
    && JSON.stringify(await wal('uW3B503')) === JSON.stringify({ balance: 500, pending: 0 }));
  await W.finalizeB2CPayoutFromWebhook(db, 'pout_W3B503', 'Completed', { status: 'Completed', paid_amount: 200 });
  ck('W3D a COMPLETE webhook afterwards does not settle the returned funds a 2nd time', (await read('payoutRequests/pout_W3B503')).status === 'failed'
    && JSON.stringify(await wal('uW3B503')) === JSON.stringify({ balance: 500, pending: 0 }) && (await read('walletTransactions/uW3B503_pout_W3B503_payout')) === null, await wal('uW3B503'));
  const aud = await read('payoutResolutions/pout_W3B503');
  ck('W3D audit record complete', aud && aud.decision === 'not_paid' && aud.previousStatus === 'outcome_unknown' && aud.resultingStatus === 'failed' && aud.evidence.reference === 'STMT-503');

  /* ── W3E ── */
  quiet('\n── W3E  concurrent resolution ──');
  await mkUser('w3e', 500); MODE = 'timeout';
  n = sends.length;
  await out(req('w3e', 200, 'W3E'));
  MODE = 'ok';
  ck('W3E precondition: OUTCOME_UNKNOWN, 300 / 200', (await read('payoutRequests/pout_W3E')).status === 'outcome_unknown' && JSON.stringify(await wal('w3e')) === JSON.stringify({ balance: 300, pending: 200 }));
  const race = await Promise.all([
    out(resolve('pout_W3E', 'paid', EV_PAID('ISX-E1'), SUPER('supA'))),
    out(resolve('pout_W3E', 'not_paid', EV_NOT('STMT-E1'), SUPER('supB'))),
    out(resolve('pout_W3E', 'paid', EV_PAID('ISX-E1'), SUPER('supC'))),
    out(resolve('pout_W3E', 'not_paid', EV_NOT('STMT-E1'), SUPER('supD'))),
    out(W.processPayoutRetries.run({})),
  ]);
  const pe = await read('payoutRequests/pout_W3E');
  const we = await wal('w3e');
  const applied = race.slice(0, 4).filter((r) => r.ok && !r.ok.alreadyResolved);
  const resDocs = (await read('payoutResolutions/pout_W3E'));
  const ledgerE = await read('walletTransactions/w3e_pout_W3E_payout');
  ck('W3E exactly one resolution applied', applied.length === 1, race.map((r) => r.err || (r.ok && (r.ok.alreadyResolved ? 'dup' : r.ok.status || 'ran'))));
  ck('W3E terminal state matches the winner', resDocs && pe.status === resDocs.resultingStatus && ['paid', 'failed'].includes(pe.status), { st: pe.status, won: resDocs && resDocs.decision });
  const onePaid = pe.status === 'paid' && JSON.stringify(we) === JSON.stringify({ balance: 300, pending: 0 }) && !!ledgerE;
  const oneFail = pe.status === 'failed' && JSON.stringify(we) === JSON.stringify({ balance: 500, pending: 0 }) && !ledgerE;
  ck('W3E wallet reflects exactly ONE financial outcome', onePaid || oneFail, { we, ledger: !!ledgerE });
  ck('W3E losers: same decision → no-op, contradicting → refused', race.slice(0, 4).every((r) => (r.ok) || r.err === 'failed-precondition'));
  ck('W3E zero provider calls beyond the original send', sends.length - n === 1, sends.length - n);

  /* same decision ×6 concurrently */
  await mkUser('w3f', 500); MODE = 'timeout';
  await out(req('w3f', 200, 'W3F'));
  MODE = 'ok';
  const same = await Promise.all(Array.from({ length: 6 }, (_, i) => out(resolve('pout_W3F', 'not_paid', EV_NOT('STMT-F'), SUPER('s' + i)))));
  ck('W3E 6 concurrent identical resolutions → funds released exactly once (500 / 0)', JSON.stringify(await wal('w3f')) === JSON.stringify({ balance: 500, pending: 0 }) && same.every((r) => r.ok), await wal('w3f'));

  quiet('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { quiet('HARNESS CRASHED', e && e.stack); process.exit(2); });
