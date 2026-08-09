'use strict';
/**
 * Money-invariant guard for Claimable Transfers (send-to-anyone).
 *
 *   node scripts/test-claimable-transfers.js
 *
 * Pure simulation of the exact state machine in wallet-engine.js
 * (_sendClaimable / _claimForPhone / sweepExpiredClaimables). Proves the four
 * invariants that make send-to-anyone safe to freeze:
 *   1. Send debits the sender exactly once and escrows the amount.
 *   2. A claimable ends EXACTLY ONCE — claimed (recipient credited) OR expired
 *      (sender refunded) — never both, never twice (pending→terminal guard).
 *   3. Conservation: money is neither created nor destroyed across any path.
 *   4. Replays are no-ops (double-claim, double-sweep, claim-after-expiry,
 *      expiry-after-claim).
 * Mirror of the real transaction guards; keep in lockstep if the logic changes.
 */

/* ── In-memory model mirroring the Firestore transactions ── */
function makeWorld() {
  return { wallets: {}, claims: {}, ledger: [] };
}
const bal = (w, uid) => (w.wallets[uid] ?? 0);
const credit = (w, uid, amt) => { w.wallets[uid] = bal(w, uid) + amt; };
const debit  = (w, uid, amt) => { w.wallets[uid] = bal(w, uid) - amt; };

/* _sendClaimable: debit sender now, create a pending claimable + pending_claim ledger. */
function send(w, { id, senderUid, phone, amount }) {
  if (bal(w, senderUid) < amount) throw new Error('insufficient');
  debit(w, senderUid, amount);
  w.claims[id] = { id, senderUid, phone, amount, status: 'pending' };
  w.ledger.push({ uid: senderUid, type: 'send', dir: 'out', amount, claimableId: id, status: 'pending_claim' });
}

/* _claimForPhone: pending→claimed, credit the claimer once. */
function claim(w, id, claimerUid) {
  const c = w.claims[id];
  if (!c || c.status !== 'pending') return false;      // terminal guard = idempotent
  c.status = 'claimed'; c.claimedByUid = claimerUid;
  credit(w, claimerUid, c.amount);
  w.ledger.push({ uid: claimerUid, type: 'receive', dir: 'in', amount: c.amount, claimableId: id, status: 'completed' });
  return true;
}

/* sweepExpiredClaimables: pending→expired, refund the sender once. */
function sweep(w, id) {
  const c = w.claims[id];
  if (!c || c.status !== 'pending') return false;      // terminal guard = idempotent
  c.status = 'expired';
  credit(w, c.senderUid, c.amount);
  w.ledger.push({ uid: c.senderUid, type: 'refund', dir: 'in', amount: c.amount, claimableId: id, status: 'completed' });
  return true;
}

/* Total money = all wallet balances + amounts still escrowed in pending claimables. */
function totalMoney(w) {
  const walletSum = Object.values(w.wallets).reduce((s, x) => s + x, 0);
  const escrow = Object.values(w.claims).filter((c) => c.status === 'pending').reduce((s, c) => s + c.amount, 0);
  return walletSum + escrow;
}

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); };

console.log('\n=== Claimable Transfers — money-invariant guard ===');

/* Scenario A: send → claim (happy path) + double-claim replay. */
{
  const w = makeWorld(); w.wallets.SENDER = 100;
  const before = totalMoney(w);
  send(w, { id: 'c1', senderUid: 'SENDER', phone: '254700000001', amount: 40 });
  check('A: sender debited exactly once', bal(w, 'SENDER') === 60);
  check('A: amount escrowed (conservation across send)', totalMoney(w) === before);
  check('A: first claim credits recipient once', claim(w, 'c1', 'RCPT') && bal(w, 'RCPT') === 40);
  check('A: claimable is terminal (claimed)', w.claims.c1.status === 'claimed');
  const rcptBefore = bal(w, 'RCPT');
  check('A: DOUBLE-CLAIM is a no-op (no double credit)', claim(w, 'c1', 'RCPT') === false && bal(w, 'RCPT') === rcptBefore);
  check('A: conservation (100 in = 60 sender + 40 recipient)', totalMoney(w) === before);
}

/* Scenario B: send → expire → refund + double-sweep replay. */
{
  const w = makeWorld(); w.wallets.SENDER = 100;
  const before = totalMoney(w);
  send(w, { id: 'c2', senderUid: 'SENDER', phone: '254700000002', amount: 70 });
  check('B: refund credits sender once', sweep(w, 'c2') && bal(w, 'SENDER') === 100);
  check('B: claimable is terminal (expired)', w.claims.c2.status === 'expired');
  check('B: DOUBLE-SWEEP is a no-op', sweep(w, 'c2') === false && bal(w, 'SENDER') === 100);
  check('B: conservation (sender whole again)', totalMoney(w) === before);
}

/* Scenario C: cross-path guards — claim after expiry, and expiry after claim, both no-ops. */
{
  const w = makeWorld(); w.wallets.SENDER = 100;
  send(w, { id: 'c3', senderUid: 'SENDER', phone: '254700000003', amount: 30 });
  sweep(w, 'c3');                                  // expired + refunded
  check('C: claim AFTER expiry is a no-op (money not double-spent)', claim(w, 'c3', 'RCPT') === false);
  check('C: sender refunded, recipient not credited', bal(w, 'SENDER') === 100 && bal(w, 'RCPT') === 0);

  send(w, { id: 'c4', senderUid: 'SENDER', phone: '254700000004', amount: 30 });
  claim(w, 'c4', 'RCPT');                           // claimed
  check('C: expiry AFTER claim is a no-op (sender not wrongly refunded)', sweep(w, 'c4') === false);
  check('C: recipient holds the money, sender does not get it back', bal(w, 'RCPT') === 30 && bal(w, 'SENDER') === 70);
}

/* Scenario D: exactly-one-terminal across a batch — no claimable both claimed and expired. */
{
  const w = makeWorld(); w.wallets.SENDER = 300;
  for (let i = 0; i < 5; i++) send(w, { id: `b${i}`, senderUid: 'SENDER', phone: `25470000010${i}`, amount: 20 });
  claim(w, 'b0', 'R'); claim(w, 'b1', 'R'); sweep(w, 'b2'); sweep(w, 'b3'); /* b4 stays pending */
  const terminals = Object.values(w.claims).filter((c) => c.status !== 'pending');
  check('D: every resolved claimable has exactly one terminal state', terminals.every((c) => c.status === 'claimed' || c.status === 'expired'));
  check('D: conservation across mixed batch', totalMoney(w) === 300);
}

console.log(`\n${fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'}`);
process.exitCode = fail ? 1 : 0;
