'use strict';
/* F2 — fosAdminSettleEscrow TOCTOU double-credit: emulator proof.
 *
 * Drives the REAL deployed handler (finos-admin.js `fosAdminSettleEscrow`, invoked via v2
 * onCall `.run()`) against the REAL Firestore emulator, so the fix is proven against
 * Firestore's actual optimistic concurrency — not a mock.
 *
 *   A  single settle credits once, escrow released, one ledger entry
 *   B  N concurrent settles on ONE held escrow → EXACTLY ONE credit (the fix)
 *   C  settling an already-released escrow throws failed-precondition, no credit
 *   NEG  faithful PRE-FIX body (guard OUTSIDE txn, txn reads only wallet) under a forced
 *        interleave → DOUBLE credit — proving the test detects the TOCTOU the fix removes
 *
 * Run:  firebase emulators:exec --only firestore --project sokoni-test \
 *         "node functions/emulator-tests/f2-escrow-settle-toctou.emul.js"
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-test';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const INC = admin.firestore.FieldValue.increment;
const TS  = () => admin.firestore.FieldValue.serverTimestamp();

const { fosAdminSettleEscrow } = require('../finos-admin.js');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const REQ = (escrowId) => ({ data: { escrowId, reason: 'test settle' }, auth: { uid: 'admin1', token: { admin: true } } });
const AMT = 10000, SELLER = 's1';

async function clearCol(name) {
  const snap = await db.collection(name).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}
async function reset() {
  await Promise.all(['escrows', 'wallets', 'ledgerEntries', 'subscriptionAuditLog'].map(clearCol));
}
async function seedEscrow(id, status = 'held') {
  await db.collection('escrows').doc(id).set({ status, amountCents: AMT, sellerId: SELLER, hubType: 'x', createdAt: TS() });
  await db.collection('wallets').doc(SELLER).set({ sellerId: SELLER, availableBalance: 0, lifetimeEarnings: 0, createdAt: TS(), updatedAt: TS() });
}
const wallet = async () => (await db.collection('wallets').doc(SELLER).get()).data();
const escrow = async (id) => (await db.collection('escrows').doc(id).get()).data();
const ledgerFor = async (id) => (await db.collection('ledgerEntries').where('escrowId', '==', id).get()).size;

(async () => {
  // ── A: single settle ──────────────────────────────────────────────
  await reset(); await seedEscrow('eA');
  await fosAdminSettleEscrow.run(REQ('eA'));
  ok((await wallet()).availableBalance === AMT, `A: single settle credits once (${(await wallet()).availableBalance})`);
  ok((await escrow('eA')).status === 'released', 'A: escrow released');
  ok((await ledgerFor('eA')) === 1, 'A: exactly one ledger entry');

  // ── B: N concurrent settles on ONE held escrow → exactly one credit (THE FIX) ──
  await reset(); await seedEscrow('eB');
  const N = 5;
  const results = await Promise.allSettled(Array.from({ length: N }, () => fosAdminSettleEscrow.run(REQ('eB'))));
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const rejected  = results.filter((r) => r.status === 'rejected');
  const wB = (await wallet()).availableBalance;
  ok(succeeded === 1, `B: exactly 1 of ${N} concurrent settles succeeds (got ${succeeded})`);
  ok(wB === AMT, `B: wallet credited EXACTLY ONCE under concurrency (got ${wB}, not ${N * AMT})`);
  ok((await ledgerFor('eB')) === 1, `B: exactly one ledger entry (got ${await ledgerFor('eB')})`);
  ok((await escrow('eB')).status === 'released', 'B: escrow released once');
  ok(rejected.every((r) => /failed-precondition/.test(String(r.reason && (r.reason.code || r.reason.message || r.reason)))),
     `B: the ${rejected.length} losers reject with failed-precondition`);

  // ── C: already-released escrow → failed-precondition, no credit ──
  await reset(); await seedEscrow('eC', 'released');
  let threwC = false;
  try { await fosAdminSettleEscrow.run(REQ('eC')); }
  catch (e) { threwC = /failed-precondition/.test(String(e.code || e.message || e)); }
  ok(threwC, 'C: settling an already-released escrow throws failed-precondition');
  ok((await wallet()).availableBalance === 0, 'C: no credit on already-released escrow');

  // ── NEGATIVE CONTROL: faithful PRE-FIX body double-credits (test has teeth) ──
  // Replicates the pre-fix structure verbatim: status guard OUTSIDE the txn; the txn's
  // read set is { wallet } only (escrow never read in-txn). Forcing both callers past the
  // outside guard before either commits is exactly the interleave the pre-fix code permits.
  await reset(); await seedEscrow('eN');
  const eRef = db.collection('escrows').doc('eN');
  async function preFixOutsideRead() {                    // phase 1: the OUTSIDE read+guard
    const snap = await eRef.get();
    const e = snap.data();
    if (!['held', 'disputed'].includes(e.status)) throw new Error('bad status');
    return e;
  }
  async function preFixTxn(e) {                            // phase 2: txn reads ONLY the wallet
    const walletRef = db.collection('wallets').doc(e.sellerId);
    const ledgerRef = db.collection('ledgerEntries').doc();
    await db.runTransaction(async (tx) => {
      const w = await tx.get(walletRef);
      tx.update(eRef, { status: 'released' });
      if (w.exists) tx.update(walletRef, { availableBalance: INC(e.amountCents), lifetimeEarnings: INC(e.amountCents) });
      tx.set(ledgerRef, { type: 'escrow_release', escrowId: 'eN', sellerId: e.sellerId, amountCents: e.amountCents });
    });
  }
  const [e1, e2] = await Promise.all([preFixOutsideRead(), preFixOutsideRead()]); // both see 'held'
  await Promise.allSettled([preFixTxn(e1), preFixTxn(e2)]);                        // both credit
  const wN = (await wallet()).availableBalance;
  ok(wN === 2 * AMT, `NEG: pre-fix body DOUBLE-credits under the TOCTOU (got ${wN} = 2×${AMT}) — test detects the defect`);
  ok((await ledgerFor('eN')) === 2, `NEG: pre-fix writes two release ledger entries (got ${await ledgerFor('eN')})`);

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ': ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e && e.stack || e); process.exit(2); });
