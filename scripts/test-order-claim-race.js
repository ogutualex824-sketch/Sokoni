#!/usr/bin/env node
/* Atomic order claim — REAL concurrency, against the Firestore emulator.
 *
 *   firebase emulators:exec --only firestore --project sokoni-claim-race \
 *     "node scripts/test-order-claim-race.js"
 *
 * WHY THIS RUNS AGAINST AN EMULATOR
 * A test that calls the claim twice in sequence proves nothing about a race. The
 * whole question is what Firestore does when N transactions contend for one
 * document, so the transactions must actually contend. Every claim below is fired
 * with Promise.all against a live emulator — no mocks, no stubs, no simulated
 * ordering.
 *
 * THE BAR
 *   10 concurrent claimers, 1 order   → exactly 1 win, 9 clean losses
 *   10 orders, 10 stations            → distributed, none claimed twice
 *   losers cause NOTHING              → no status/payment/inventory side effects
 */
'use strict';

const path = require('path');
/* firebase-admin lives in functions/node_modules, not at the repo root. Resolved
   explicitly, the same way test-auth-email-challenge.js does it. */
const FN    = path.join(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('\n  REFUSING TO RUN: FIRESTORE_EMULATOR_HOST is not set.\n' +
    '  This suite must contend against a real Firestore. Run it via:\n' +
    '    firebase emulators:exec --only firestore --project sokoni-claim-race \\\n' +
    '      "node scripts/test-order-claim-race.js"\n');
  process.exit(1);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-claim-race' });
const db = admin.firestore();

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const { claimOrderFor } = require('../functions/order-claim');

const SHOP = 'shop_supermarket_1';
const EMPLOYEES = Array.from({ length: 10 }, (_, i) => 'emp_' + (i + 1));

async function seedEmployees() {
  await Promise.all(EMPLOYEES.map((uid) =>
    db.collection('shopEmployees').doc(uid).set({ shopOwnerId: SHOP, name: uid })));
}

async function seedOrder(id, extra) {
  await db.collection('orders').doc(id).set({
    id, sellerUid: SHOP, status: 'paid', amount: 1000,
    claimedBy: null, claimStatus: null, ...(extra || {}),
  });
}

(async () => {
  await seedEmployees();

  /* ══ A. TEN CONCURRENT CLAIMERS, ONE ORDER ══════════════════════════════ */
  console.log('\nA. 10 concurrent claimers → exactly 1 winner\n');
  {
    const orderId = 'ORDER_RACE_1';
    await seedOrder(orderId);

    /* Fired together. No await between them — this is the actual contention. */
    const results = await Promise.all(
      EMPLOYEES.map((uid) => claimOrderFor(uid, orderId, { deviceId: 'dev_' + uid })));

    const wins   = results.filter((r) => r.ok && r.reason === 'claimed');
    const losses = results.filter((r) => !r.ok && r.reason === 'already_claimed');

    console.log(`\n    ORDER: ${orderId}`);
    console.log(`    Concurrent claimers: ${results.length}`);
    console.log(`    Successful claims:   ${wins.length}`);
    console.log(`    Rejected claims:     ${losses.length}\n`);

    ck('exactly ONE successful claim', wins.length === 1, wins.length + ' wins');
    ck('every other caller lost cleanly', losses.length === EMPLOYEES.length - 1,
       losses.length + ' losses');
    ck('no caller errored or hung', results.every((r) => r && typeof r.ok === 'boolean'));

    const doc = (await db.collection('orders').doc(orderId).get()).data();
    ck('the document names ONE claimant', !!doc.claimedBy, String(doc.claimedBy));
    ck('  ...and it is the caller that won', doc.claimedBy === wins[0].claimedBy);
    ck('every loser names that SAME winner',
       losses.every((l) => l.claimedBy === doc.claimedBy));
    console.log(`    Final authoritative claimant: ${doc.claimedBy}\n`);

    /* ── The loser must cause NOTHING ────────────────────────────────────── */
    ck('Duplicate fulfilment: 0 — status untouched', doc.status === 'paid', doc.status);
    ck('Duplicate payment transition: 0 — no paymentStatus written',
       doc.paymentStatus === undefined);
    ck('Duplicate inventory movement: 0 — no inventoryApplied',
       doc.inventoryApplied === undefined);
    ck('Duplicate notification: 0 — no notify flag written',
       doc.notified === undefined && doc.customerNotified === undefined);
    ck('claim role recorded for audit', doc.claimedByRole === 'employee', doc.claimedByRole);
    ck('device recorded for audit', !!doc.claimDeviceId, doc.claimDeviceId);
  }

  /* ══ B. REPEATED DOUBLE-TAPS BY THE WINNER ══════════════════════════════ */
  console.log('\nB. The winner double-tapping is idempotent\n');
  {
    const orderId = 'ORDER_RACE_1';
    const doc = (await db.collection('orders').doc(orderId).get()).data();
    const winner = doc.claimedBy;

    const again = await Promise.all(Array.from({ length: 5 }, () =>
      claimOrderFor(winner, orderId, {})));
    ck('5 repeat taps by the winner all succeed idempotently',
       again.every((r) => r.ok && r.idempotent === true));

    const after = (await db.collection('orders').doc(orderId).get()).data();
    ck('  ...and the claimant never changes', after.claimedBy === winner);
  }

  /* ══ C. TEN ORDERS ACROSS TEN STATIONS ══════════════════════════════════ */
  console.log('\nC. 10 orders × 10 stations → distributed, none claimed twice\n');
  {
    const ids = Array.from({ length: 10 }, (_, i) => 'ORDER_DIST_' + (i + 1));
    await Promise.all(ids.map((id) => seedOrder(id)));

    /* Every employee races for every order — 100 concurrent claims. */
    const all = await Promise.all(
      ids.flatMap((id) => EMPLOYEES.map((uid) => claimOrderFor(uid, id, {})
        .then((r) => ({ id, uid, r })))));

    const winsByOrder = {};
    all.forEach(({ id, uid, r }) => {
      if (r.ok && r.reason === 'claimed') (winsByOrder[id] = winsByOrder[id] || []).push(uid);
    });

    ck('all 10 orders were claimed', Object.keys(winsByOrder).length === 10,
       Object.keys(winsByOrder).length + '/10');
    const doubles = Object.entries(winsByOrder).filter(([, w]) => w.length !== 1);
    ck('NO order was claimed twice', doubles.length === 0,
       doubles.length ? JSON.stringify(doubles) : 'each has exactly 1');

    const docs = await Promise.all(ids.map((id) => db.collection('orders').doc(id).get()));
    ck('every order document names exactly one claimant',
       docs.every((s) => !!s.data().claimedBy));
    ck('  ...matching the caller that won it',
       docs.every((s) => s.data().claimedBy === winsByOrder[s.id][0]));
    ck('total successful claims === number of orders',
       all.filter((x) => x.r.ok && x.r.reason === 'claimed').length === 10);

    /* Not a single-cashier queue: the work should spread. Not asserted as a
       hard guarantee — Firestore picks the winner, not us — but a total collapse
       onto one employee would mean the race is not really concurrent. */
    const distinct = new Set(Object.values(winsByOrder).map((w) => w[0])).size;
    console.log(`\n    Orders: 10   Distinct winning employees: ${distinct}\n`);
    ck('work did not collapse onto a single cashier', distinct >= 2, distinct + ' distinct');
  }

  /* ══ D. AUTHORITY ═══════════════════════════════════════════════════════ */
  console.log('\nD. Authority\n');
  {
    const orderId = 'ORDER_AUTH_1';
    await seedOrder(orderId);

    const stranger = await claimOrderFor('emp_from_another_shop', orderId, {});
    ck('an employee of ANOTHER shop cannot claim',
       !stranger.ok && stranger.reason === 'not_authorised_for_shop');

    await db.collection('shopEmployees').doc('emp_other').set({ shopOwnerId: 'some_other_shop' });
    const wrongShop = await claimOrderFor('emp_other', orderId, {});
    ck('  ...even with an employee record for a different shop',
       !wrongShop.ok && wrongShop.reason === 'not_authorised_for_shop');

    const owner = await claimOrderFor(SHOP, orderId, {});
    ck('the shop owner can claim', owner.ok && owner.role === 'owner');

    const doc = (await db.collection('orders').doc(orderId).get()).data();
    ck('  ...and is recorded as owner, not employee', doc.claimedByRole === 'owner');
  }

  /* ══ E. TERMINAL ORDERS AND RELEASE ═════════════════════════════════════ */
  console.log('\nE. Unclaimable states\n');
  {
    for (const st of ['completed', 'cancelled', 'refunded']) {
      const id = 'ORDER_TERM_' + st;
      await seedOrder(id, { status: st });
      const r = await claimOrderFor(EMPLOYEES[0], id, {});
      ck(`a ${st} order cannot be claimed`, !r.ok && r.reason === 'order_not_claimable');
    }
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n  HARNESS ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});
