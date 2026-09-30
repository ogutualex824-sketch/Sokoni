'use strict';
/**
 * test-secure-release.js — SOKONI Secure Release (2026-09-30): a TWO-KEY withdrawal.
 *
 * Owner: "Admin approval authorizes the withdrawal. The wallet owner performs the final release. Money does not move
 * until both approvals exist." PIN at request (salted verifier, server lockout), the amount RESERVED (no double
 * claims), AdminOS approval moves nothing, the owner's "CONFIRM & RELEASE" re-verifies everything, APPROVED →
 * OWNER_CONFIRMED → PROCESSING → PAID or OUTCOME_UNKNOWN (never re-sent), the approved amount/destination immutable,
 * approvals expire, a new destination cools, the owner can cancel before releasing.
 *
 * REAL functions/wallet.js + functions/wallet-engine.js (the ONE PIN authority) over the transactional fake Firestore;
 * a COUNTING fake B2C adapter (no network); notifications captured; SMS stubbed to THROW (SMS is live — never sent).
 *
 * PROVES
 *   SR1  no wallet PIN → the request is refused (PIN_NOT_SET); nothing reserved, no request written
 *   SR2  a wrong PIN is refused and counted; at the cap the wallet locks — and a locked wallet cannot request
 *   SR3  a LEGACY sha256 PIN still works once and is UPGRADED to a salted scrypt verifier (the weak hash removed); a
 *        newly set PIN is stored only as a salted verifier (no pinHash, the PIN itself nowhere)
 *   SR4  a request with the right PIN: held (balance − / reserved +), status pending, PIN-verified on the timeline,
 *        the owner notified — and NOTHING sent, even with automatic payouts fully on and the request instant-eligible
 *   SR5  no double claims: 5 concurrent requests for the whole balance reserve it ONCE; the balance never goes negative
 *   SR6  admin approval moves NOTHING: approved, a fingerprint of exactly what was approved, a release window,
 *        "ready to release" sent to the owner, zero provider calls
 *   SR7  Mark Paid before the owner's release is refused (money never leaves on one key)
 *   SR8  the owner's release: another user cannot (not-found), a wrong PIN cannot; the right PIN → owner_confirmed;
 *        then (manual mode) Mark Paid settles it once
 *   SR9  automatic mode: the release sends EXACTLY once — 5 concurrent releases + a repeat → one provider call, processing
 *   SR10 immutability: an approved withdrawal whose destination or amount no longer matches the approval is refused —
 *        nothing sent
 *   SR11 expiry: a release after the window cancels it and returns the funds; the scheduled sweep expires an untouched
 *        approval and returns its funds
 *   SR12 a NEW destination cannot be released to before its cooling period ends (the refusal says until when)
 *   SR13 the owner can cancel before releasing (pending / approved → funds back); not after; not someone else's
 *   SR14 an owner-confirmed withdrawal can still be declined by the admin (nothing was sent) — funds back
 *   SR15 a frozen wallet cannot release
 *   SR16 changing an existing PIN needs the current PIN or a fresh sign-in — a stolen session alone cannot re-PIN
 *   SR17 an unknown provider outcome on release: outcome_unknown, funds held, never re-sent
 *   SR18 control: with config secureRelease = false the one-key flow is exactly as before (instant send at request)
 *
 *   node scripts/test-secure-release.js
 */
const Path = require('path');
const crypto = require('crypto');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp });
stub('firebase-admin/auth', { getAuth: () => ({ getUserByPhoneNumber: async () => { const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; } }) });
stub('./redis-rate-limiter', { checkRateLimit: async () => true });
stub('./finos-utils', { intasendB2C: async () => { throw new Error('legacy helper must not be used'); } });
stub('./sokoni-at', new Proxy({}, { get: (_, k) => (k === 'secrets' ? [] : () => { throw new Error('SMS must never be sent by a test'); }) }));
const NOTES = [];
stub('./notify', { notify: async (n) => { NOTES.push(n); return { ok: true }; } });
let MODE = 'ok'; const sends = [];
stub('./payment-adapters', { getAdapter: () => ({ sendMoneyB2C: async (a) => {
  sends.push({ ...a, mode: MODE });
  if (MODE === 'timeout') throw new Error('socket hang up ETIMEDOUT');
  return { tracking_id: 'TRK' + sends.length, status: 'Confirming balance' };
} }) });

let W, WE;
try { W = require(Path.join(FN, 'wallet.js')); WE = require(Path.join(FN, 'wallet-engine.js')); } catch (e) { say('LOAD FAILED ' + e.stack); process.exit(1); }
const ADMIN = { auth: { uid: 'adm1', token: { admin: true } } };
const U = (uid, extraToken) => ({ auth: { uid, token: Object.assign({}, extraToken || {}) } });
const request = (uid, amount, key, pin, acct) => W.requestSellerPayout.run({ ...U(uid), data: { amount, method: 'mpesa', accountNumber: acct || '0712345678', idempotencyKey: key, ...(pin != null ? { pin } : {}) } });
const admin = (rid, status, extra = {}) => W.adminProcessPayout.run({ ...ADMIN, data: { requestId: rid, status, ...extra } });
const release = (uid, rid, pin) => W.confirmPayoutRelease.run({ ...U(uid), data: { requestId: rid, pin } });
const cancel = (uid, rid) => W.cancelPayoutRequest.run({ ...U(uid), data: { requestId: rid } });
const setPin = (uid, pin, currentPin, token) => WE.walletV2SetPin.run({ ...U(uid, token), data: { pin, ...(currentPin ? { currentPin } : {}) } });
/* setup steps record their outcome instead of throwing — a mutant's refusal must show as a FAIL, never crash the run */
const sReq = (...a) => out(request(...a)), sAdm = (...a) => out(admin(...a)), sRel = (...a) => out(release(...a));
async function out(p) { try { return { ok: await p }; } catch (e) { return { err: e.code || e.message, msg: String(e.message), details: e.details }; } }
const read = async (p) => (await db.doc(p).get()).data() || null;
const wal = async (u) => { const w = (await read('wallets/' + u)) || {}; return { balance: w.balance, pending: w.pendingPayout || 0 }; };
const J = (x) => JSON.stringify(x);
const PAID = { externalReference: 'QWE123RTY', attestation: 'sent by finance, M-PESA, 10:30' };

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? J(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };

/* config: automatic payouts fully ON and every instant condition met — so ANY money moving at the wrong step shows up */
const CFG = { enabled: true, autoB2C: false, requirePin: true, instantLimit: 100000, dailyLimit: 1000000, holdNewSellersDays: 0, maxPayoutsPerDay: 50, scheduledAbove: 0,
  secureRelease: true, releaseWindowHours: 72, newDestinationCoolingHours: 0, maxPerRequest: 150000 };
const setCfg = (x) => db.doc('config/payouts').set(Object.assign({}, CFG, x || {}));
const PIN = '482915';
async function mkUser(u, bal, opts = {}) {
  await db.doc('users/' + u).set({ accountStatus: 'active', payoutVerified: true, createdAt: F.Timestamp.fromMillis(Date.now() - 90 * 86400000) });
  const w = { balance: bal, pendingPayout: 0 };
  if (opts.legacyPin) w.pinHash = crypto.createHash('sha256').update(opts.legacyPin + u, 'utf8').digest('hex');
  else if (opts.pin !== false) w.pinVerifier = WE._pinAuthority.makePinVerifier(opts.pin || PIN);
  await db.doc('wallets/' + u).set(w);
}
const steps = async (rid) => ((await read('payoutRequests/' + rid)) || {}).statusHistory ? (await read('payoutRequests/' + rid)).statusHistory.map((e) => e.status) : [];

(async () => {
  if (!W.confirmPayoutRelease || !W.cancelPayoutRequest || !WE._pinAuthority) { ck('SR0 Secure Release exists', false, 'missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await setCfg({ autoB2C: true });

  /* SR1 */
  await mkUser('s1', 1000, { pin: false });
  let n = sends.length;
  const r1 = await out(request('s1', 500, 'S1', PIN));
  ck('SR1 no wallet PIN → refused (PIN_NOT_SET); nothing reserved, no request written, nothing sent',
    r1.err === 'failed-precondition' && /PIN_NOT_SET/.test(r1.msg) && J(await wal('s1')) === J({ balance: 1000, pending: 0 }) && !(await read('payoutRequests/pout_S1')) && sends.length === n, r1);

  /* SR2 */
  await mkUser('s2', 1000);
  const wrong = [];
  for (let i = 0; i < 5; i++) wrong.push((await out(request('s2', 100, 'S2W' + i, '000000'))).err);
  const w2 = await read('wallets/s2');
  const after = await out(request('s2', 100, 'S2OK', PIN));
  ck('SR2 wrong PINs refused and counted; at the cap the wallet locks — and a locked wallet cannot request',
    wrong.slice(0, 4).every((e) => e === 'permission-denied') && w2.pinLocked === true && after.err === 'failed-precondition' && J(await wal('s2')) === J({ balance: 1000, pending: 0 }), { wrong, locked: w2.pinLocked, after: after.msg });

  /* SR3 */
  await mkUser('s3', 1000, { legacyPin: '4321' });
  const r3 = await out(request('s3', 100, 'S3', '4321'));
  const w3 = await read('wallets/s3');
  const sp = await out(setPin('s3b', '135790'));
  await mkUser('s3b', 0, { pin: false });
  const sp2 = await out(setPin('s3b', '135790'));
  const w3b = await read('wallets/s3b');
  ck('SR3 a legacy PIN works once and is UPGRADED to a salted verifier; a new PIN is stored only as a salted verifier',
    r3.ok && w3.pinVerifier && w3.pinVerifier.salt && !('pinHash' in w3) && sp2.ok && w3b.pinVerifier && !('pinHash' in w3b) && !J(w3b).includes('135790')
    && WE._pinAuthority.pinMatches(w3b, 's3b', '135790') && !WE._pinAuthority.pinMatches(w3b, 's3b', '135791'), { r3: r3.err || 'ok', v: !!w3.pinVerifier, legacyGone: !('pinHash' in w3), sp: sp.err });

  /* SR4 */
  await mkUser('s4', 1000);
  n = sends.length; const notes0 = NOTES.length;
  const r4 = await out(request('s4', 400, 'S4', PIN));
  const p4 = await read('payoutRequests/pout_S4');
  ck('SR4 the right PIN: held (600 / 400 reserved), pending, PIN-verified on the timeline, owner told — and NOTHING sent though auto payouts are fully on',
    r4.ok && r4.ok.status === 'pending' && p4.secureRelease === true && J(await wal('s4')) === J({ balance: 600, pending: 400 }) && (await steps('pout_S4')).includes('pin_verified')
    && sends.length === n && NOTES.slice(notes0).some((x) => x.type === 'payout_requested' && x.uid === 's4'), { r4: r4.ok || r4.msg, steps: await steps('pout_S4') });

  /* SR5 */
  await mkUser('s5', 1000);
  const five = await Promise.all(Array.from({ length: 5 }, (_, i) => out(request('s5', 1000, 'S5K' + i, PIN))));
  const w5 = await wal('s5');
  ck('SR5 five concurrent requests for the whole balance reserve it ONCE; never negative',
    five.filter((r) => r.ok).length === 1 && J(w5) === J({ balance: 0, pending: 1000 }), { ok: five.filter((r) => r.ok).length, w5 });

  /* SR6 */
  n = sends.length; const notes6 = NOTES.length;
  const a6 = await out(admin('pout_S4', 'approved'));
  const p6 = await read('payoutRequests/pout_S4');
  const hrs = p6.approval && (p6.approval.expiresAt.toMillis() - Date.now()) / 3600000;
  ck('SR6 admin approval moves NOTHING: approved + fingerprint + a 72h window + "ready to release" — zero provider calls',
    a6.ok && a6.ok.status === 'approved' && a6.ok.awaitingOwner === true && p6.status === 'approved' && p6.approval.amount === 400 && p6.approval.sellerUid === 's4'
    && typeof p6.approval.destinationKey === 'string' && hrs > 71.9 && hrs <= 72 && sends.length === n && J(await wal('s4')) === J({ balance: 600, pending: 400 })
    && NOTES.slice(notes6).some((x) => x.type === 'payout_release_ready'), { a6: a6.ok || a6.msg, hrs });

  /* SR7 */
  const m7 = await out(admin('pout_S4', 'paid', PAID));
  ck('SR7 Mark Paid before the owner releases is refused — money never leaves on one key', m7.err === 'failed-precondition' && /owner has not confirmed/.test(m7.msg) && (await read('payoutRequests/pout_S4')).status === 'approved', m7.msg);

  /* SR8 (manual mode) */
  await setCfg({ autoB2C: false });
  const x8 = await out(release('intruder', 'pout_S4', PIN));
  const b8 = await out(release('s4', 'pout_S4', '111111'));
  n = sends.length;
  const g8 = await out(release('s4', 'pout_S4', PIN));
  const m8 = await out(admin('pout_S4', 'paid', PAID));
  const m8b = await out(admin('pout_S4', 'paid', PAID));
  ck('SR8 another user cannot release (not-found), a wrong PIN cannot; the right PIN → owner_confirmed; then Mark Paid settles it ONCE',
    x8.err === 'not-found' && b8.err === 'permission-denied' && g8.ok && g8.ok.status === 'owner_confirmed' && m8.ok && m8.ok.status === 'settled_manually'
    && (m8b.ok ? m8b.ok.alreadySettled === true : false) && J(await wal('s4')) === J({ balance: 600, pending: 0 }) && sends.length === n
    && (await steps('pout_S4')).join('>').includes('awaiting_owner>owner_confirmed'), { x8: x8.err, b8: b8.err, g8: g8.ok || g8.msg, m8: m8.ok || m8.msg, w: await wal('s4') });

  /* SR9 (automatic) */
  await setCfg({ autoB2C: true });
  await mkUser('s9', 1000);
  await sReq('s9', 300, 'S9', PIN); await sAdm('pout_S9', 'approved');
  n = sends.length;
  const r9 = await Promise.all(Array.from({ length: 5 }, () => out(release('s9', 'pout_S9', PIN))));
  const r9b = await out(release('s9', 'pout_S9', PIN));
  const p9 = await read('payoutRequests/pout_S9');
  ck('SR9 automatic mode: five concurrent releases + a repeat → EXACTLY one provider call; processing',
    sends.length - n === 1 && p9.status === 'processing' && r9.every((r) => r.ok) && r9b.ok && r9b.ok.alreadyConfirmed === true && sends[sends.length - 1].amountKES === 300 && sends[sends.length - 1].ref === 'pout_S9', { sent: sends.length - n, st: p9.status, r9: r9.map((r) => r.err ? r.msg : r.ok.status + (r.ok.alreadyConfirmed ? '*' : '')), r9b: r9b.ok || r9b.msg });

  /* SR10 immutability */
  await mkUser('s10', 1000);
  await sReq('s10', 200, 'S10A', PIN); await sAdm('pout_S10A', 'approved');
  await sReq('s10', 200, 'S10B', PIN); await sAdm('pout_S10B', 'approved');
  await db.doc('payoutRequests/pout_S10A').update({ accountNumber: '0711999999' });    /* a destination swapped after approval */
  await db.doc('payoutRequests/pout_S10B').update({ amount: 20000 });                   /* an amount raised after approval */
  n = sends.length;
  const t10a = await out(release('s10', 'pout_S10A', PIN)), t10b = await out(release('s10', 'pout_S10B', PIN));
  ck('SR10 an approved withdrawal whose destination or amount no longer matches the approval is refused — nothing sent',
    t10a.err === 'failed-precondition' && /no longer matches/.test(t10a.msg) && t10b.err === 'failed-precondition' && sends.length === n
    && (await read('payoutRequests/pout_S10A')).status === 'approved', { a: t10a.msg, b: t10b.msg });

  /* SR11 expiry */
  await mkUser('s11', 1000);
  await sReq('s11', 250, 'S11A', PIN); await sAdm('pout_S11A', 'approved');
  await sReq('s11', 250, 'S11B', PIN); await sAdm('pout_S11B', 'approved');
  const past = F.Timestamp.fromMillis(Date.now() - 1000);
  for (const r of ['pout_S11A', 'pout_S11B']) { const p = await read('payoutRequests/' + r); await db.doc('payoutRequests/' + r).update({ approval: Object.assign({}, p.approval, { expiresAt: past }) }); }
  n = sends.length;
  const e11 = await out(release('s11', 'pout_S11A', PIN));
  await W.reconcilePayouts.run({});
  ck('SR11 a release after the window expires it (funds back); the sweep expires an untouched approval (funds back); nothing sent',
    e11.err === 'failed-precondition' && /expired/.test(e11.msg) && (await read('payoutRequests/pout_S11A')).status === 'expired' && (await read('payoutRequests/pout_S11B')).status === 'expired'
    && J(await wal('s11')) === J({ balance: 1000, pending: 0 }) && sends.length === n, { e11: e11.msg, w: await wal('s11') });

  /* SR12 cooling */
  await setCfg({ autoB2C: true, newDestinationCoolingHours: 24 });
  await mkUser('s12', 1000);
  await sReq('s12', 100, 'S12', PIN, '0799000111'); await sAdm('pout_S12', 'approved');
  n = sends.length;
  const c12 = await out(release('s12', 'pout_S12', PIN));
  /* a destination first used 2 days ago is past its cooling */
  await mkUser('s12b', 1000);
  await sReq('s12b', 100, 'S12B', PIN, '0799000222'); await sAdm('pout_S12B', 'approved');
  await db.doc('payoutRequests/pout_S12B').update({ destinationFirstSeenAt: F.Timestamp.fromMillis(Date.now() - 48 * 3600000) });
  const c12b = await out(release('s12b', 'pout_S12B', PIN));
  ck('SR12 a NEW destination cannot be released to before its 24h cooling ends (says until when); an older one can',
    c12.err === 'failed-precondition' && /new destination/i.test(c12.msg) && c12.details && c12.details.coolingUntil > Date.now() && c12b.ok && sends.length - n === 1, { c12: c12.msg, c12b: c12b.ok || c12b.msg });
  await setCfg({ autoB2C: true, newDestinationCoolingHours: 0 });

  /* SR13 cancel */
  await mkUser('s13', 1000);
  await sReq('s13', 100, 'S13A', PIN);
  await sReq('s13', 100, 'S13B', PIN); await sAdm('pout_S13B', 'approved');
  await sReq('s13', 100, 'S13C', PIN); await sAdm('pout_S13C', 'approved');
  await setCfg({ autoB2C: false }); await sRel('s13', 'pout_S13C', PIN); await setCfg({ autoB2C: true });
  const k1 = await out(cancel('s13', 'pout_S13A')), k2 = await out(cancel('s13', 'pout_S13B')), k3 = await out(cancel('s13', 'pout_S13C')), k4 = await out(cancel('other', 'pout_S13B'));
  ck('SR13 the owner cancels before releasing (pending, approved → funds back); not after releasing; not someone else\'s',
    k1.ok && k2.ok && k3.err === 'failed-precondition' && k4.err === 'not-found' && J(await wal('s13')) === J({ balance: 900, pending: 100 })
    && (await read('payoutRequests/pout_S13A')).status === 'cancelled', { k1: k1.err || 'ok', k2: k2.err || 'ok', k3: k3.err, k4: k4.err, w: await wal('s13') });

  /* SR14 */
  const d14 = await out(admin('pout_S13C', 'rejected', { note: 'declined' }));
  ck('SR14 an owner-confirmed withdrawal can still be declined by the admin (nothing was sent) — funds back', d14.ok && J(await wal('s13')) === J({ balance: 1000, pending: 0 }), d14.ok || d14.msg);

  /* SR15 */
  await mkUser('s15', 1000);
  await sReq('s15', 100, 'S15', PIN); await sAdm('pout_S15', 'approved');
  await db.doc('wallets/s15').update({ frozen: true });
  n = sends.length;
  const f15 = await out(release('s15', 'pout_S15', PIN));
  ck('SR15 a frozen wallet cannot release', f15.err === 'failed-precondition' && /locked/.test(f15.msg) && sends.length === n, f15.msg);

  /* SR16 */
  await mkUser('s16', 0);
  const old = Math.floor(Date.now() / 1000) - 3600, fresh = Math.floor(Date.now() / 1000) - 30;
  const q1 = await out(setPin('s16', '999999', null, { auth_time: old }));
  const q2 = await out(setPin('s16', '999999', '123123', { auth_time: old }));
  const q3 = await out(setPin('s16', '999999', PIN, { auth_time: old }));
  const q4 = await out(setPin('s16', '777777', null, { auth_time: fresh }));
  ck('SR16 changing a PIN needs the current PIN or a fresh sign-in — a stolen session alone cannot re-PIN',
    q1.err === 'failed-precondition' && /CURRENT_PIN_REQUIRED/.test(q1.msg) && q2.err === 'permission-denied' && q3.ok && q4.ok
    && WE._pinAuthority.pinMatches(await read('wallets/s16'), 's16', '777777'), { q1: q1.msg, q2: q2.err, q3: q3.err || 'ok', q4: q4.err || 'ok' });

  /* SR17 */
  await mkUser('s17', 1000);
  await sReq('s17', 150, 'S17', PIN); await sAdm('pout_S17', 'approved');
  MODE = 'timeout'; n = sends.length;
  const u17 = await out(release('s17', 'pout_S17', PIN));
  MODE = 'ok';
  const u17b = await out(release('s17', 'pout_S17', PIN));
  await W.processPayoutRetries.run({});
  ck('SR17 an unknown provider outcome on release: outcome_unknown, funds held, never re-sent',
    u17.ok && u17.ok.status === 'outcome_unknown' && (await read('payoutRequests/pout_S17')).status === 'outcome_unknown' && sends.length - n === 1
    && J(await wal('s17')) === J({ balance: 850, pending: 150 }) && u17b.ok && u17b.ok.alreadyConfirmed !== false, { u17: u17.ok || u17.msg, sent: sends.length - n });

  /* SR18 control */
  await setCfg({ autoB2C: true, secureRelease: false, requirePin: false });
  await mkUser('s18', 1000, { pin: false });
  n = sends.length;
  const r18 = await out(request('s18', 100, 'S18'));
  ck('SR18 control: with secureRelease off the one-key flow is as before (instant send at request, no PIN required)',
    r18.ok && r18.ok.status === 'processing' && sends.length - n === 1, r18.ok || r18.msg);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
