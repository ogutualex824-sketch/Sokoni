/* returns Firestore rules — emulator-backed.

   Run:  firebase emulators:exec --only firestore --project sokoni-returns-rules-test \
           "node scripts/test-returns-rules.js"

   WHY THIS EXISTS
   The `returns` collection previously had NO rule block at all. Firestore denies by
   default, so every read failed with permission-denied — and returns.html reported
   that to merchants as "Failed to load returns", including for shops that simply had
   none. The fix is a rule, and a rule is only worth what its tests prove.

   The boundary being asserted: exactly two parties plus admin may read a return —
   the buyer who filed it and the seller it is against. NOT `isAuthed()`, which would
   expose every shop's return history (customer names, order ids, refund amounts) to
   any signed-in account. All writes belong to the returns-engine Cloud Functions.

   Both real queries from returns.html are exercised as LIST operations, because a
   get() passing proves nothing about whether the merchant's actual query is allowed.
*/
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};
const check = async (label, p) => {
  try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); }
};

const BUYER = 'buyer-uid-1', SELLER = 'seller-uid-1', OTHER = 'seller-uid-2', ADMIN = 'admin-uid-1';

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-returns-rules-test',
    firestore: {
      rules: fs.readFileSync(path.resolve(__dirname, '..', process.env.RULES_FILE || 'firestore.rules'), 'utf8'),
      host: '127.0.0.1', port: 8080,
    },
  });

  /* Seed with rules disabled — these documents are written by Cloud Functions in
     production, which bypass rules via the Admin SDK. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.collection('returns').doc('ret_order1_buyer').set({
      returnId: 'ret_order1_buyer', orderId: 'order1',
      buyerId: BUYER, sellerId: SELLER,
      status: 'submitted', reason: 'damaged', resolution: 'refund',
      submittedAt: new Date('2026-08-01T10:00:00Z'), createdAt: new Date('2026-08-01T10:00:00Z'),
    });
    await db.collection('returns').doc('ret_order2_other').set({
      returnId: 'ret_order2_other', orderId: 'order2',
      buyerId: 'someone-else', sellerId: OTHER,
      status: 'submitted', reason: 'wrong item', resolution: 'refund',
      submittedAt: new Date('2026-08-02T10:00:00Z'), createdAt: new Date('2026-08-02T10:00:00Z'),
    });
  });

  const buyer  = env.authenticatedContext(BUYER).firestore();
  const seller = env.authenticatedContext(SELLER).firestore();
  const other  = env.authenticatedContext(OTHER).firestore();
  const admin  = env.authenticatedContext(ADMIN, { admin: true }).firestore();
  const anon   = env.unauthenticatedContext().firestore();

  console.log('\nRETURNS RULES');
  console.log('='.repeat(66));

  console.log('\n1. Owner reads (the two legitimate parties)');
  await check('seller reads a return against their shop',
    assertSucceeds(seller.collection('returns').doc('ret_order1_buyer').get()));
  await check('buyer reads the return they filed',
    assertSucceeds(buyer.collection('returns').doc('ret_order1_buyer').get()));

  console.log('\n2. Isolation — the boundary that `isAuthed()` would have destroyed');
  await check('a DIFFERENT seller cannot read it',
    assertFails(other.collection('returns').doc('ret_order1_buyer').get()));
  await check('the buyer cannot read another buyer\'s return',
    assertFails(buyer.collection('returns').doc('ret_order2_other').get()));
  await check('an anonymous visitor cannot read any return',
    assertFails(anon.collection('returns').doc('ret_order1_buyer').get()));

  console.log('\n3. The REAL queries from returns.html (list, not get)');
  await check('seller list: where sellerId == uid, orderBy submittedAt desc',
    assertSucceeds(seller.collection('returns')
      .where('sellerId', '==', SELLER).orderBy('submittedAt', 'desc').limit(100).get()));
  await check('buyer list: where buyerId == uid, orderBy submittedAt desc',
    assertSucceeds(buyer.collection('returns')
      .where('buyerId', '==', BUYER).orderBy('submittedAt', 'desc').limit(50).get()));
  await check('an UNFILTERED list is refused for a merchant',
    assertFails(seller.collection('returns').orderBy('submittedAt', 'desc').limit(100).get()));
  await check('a seller cannot list ANOTHER shop\'s returns',
    assertFails(seller.collection('returns')
      .where('sellerId', '==', OTHER).orderBy('submittedAt', 'desc').limit(100).get()));

  console.log('\n4. EMPTY is a permitted, successful query — not an error');
  /* This is the whole point: a shop with zero returns must reach EMPTY, never ERROR. */
  const emptySeller = env.authenticatedContext('seller-with-no-returns').firestore();
  await check('a shop with no returns gets an allowed, empty result',
    assertSucceeds(emptySeller.collection('returns')
      .where('sellerId', '==', 'seller-with-no-returns')
      .orderBy('submittedAt', 'desc').limit(100).get()));
  try {
    const snap = await emptySeller.collection('returns')
      .where('sellerId', '==', 'seller-with-no-returns')
      .orderBy('submittedAt', 'desc').limit(100).get();
    ck('empty result is size 0 and NOT an exception', snap.empty && snap.size === 0, 'size=' + snap.size);
  } catch (e) { ck('empty result is size 0 and NOT an exception', false, e.message); }

  console.log('\n5. Admin');
  await check('admin reads any return',
    assertSucceeds(admin.collection('returns').doc('ret_order2_other').get()));
  await check('admin lists all returns unfiltered',
    assertSucceeds(admin.collection('returns').orderBy('submittedAt', 'desc').limit(200).get()));

  console.log('\n6. Writes belong to the returns-engine Cloud Functions only');
  await check('seller cannot approve a return client-side',
    assertFails(seller.collection('returns').doc('ret_order1_buyer').update({ status: 'approved' })));
  await check('buyer cannot rewrite their own return',
    assertFails(buyer.collection('returns').doc('ret_order1_buyer').update({ refundAmount: 999999 })));
  await check('buyer cannot forge a new return document',
    assertFails(buyer.collection('returns').doc('forged').set({ buyerId: BUYER, sellerId: SELLER })));
  await check('admin cannot write directly either (Admin SDK only)',
    assertFails(admin.collection('returns').doc('ret_order1_buyer').update({ status: 'approved' })));

  /* ── 7. Composite indexes ──────────────────────────────────────────────────
     The emulator does NOT enforce composite indexes — every query above would pass
     even with none declared, while production fails with FAILED_PRECONDITION. So the
     index declarations are checked structurally, against the exact query shapes
     returns.html runs. This is the half the emulator cannot prove. */
  console.log('\n7. Composite indexes match the production queries');
  const idx = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'firestore.indexes.json'), 'utf8'));
  const shape = (i) => i.fields.map((f) => f.fieldPath + ':' + (f.order || f.arrayConfig)).join(',');
  const returnsIdx = (idx.indexes || []).filter((i) => i.collectionGroup === 'returns').map(shape);
  /* Exactly the equality-then-orderBy shape Firestore requires for
       where(X,'==',uid).orderBy('submittedAt','desc') */
  [['buyerId', 'buyer'], ['sellerId', 'seller']].forEach(([field, who]) => {
    const want = field + ':ASCENDING,submittedAt:DESCENDING';
    ck(who + ' query has its composite index (' + field + ' + submittedAt desc)',
       returnsIdx.includes(want), returnsIdx.join(' | ') || 'none declared');
  });
  ck('no unexpected returns indexes (drift check)', returnsIdx.length === 2, returnsIdx.length + ' declared');

  await env.cleanup();
  console.log('\n' + '='.repeat(66));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('suite error:', e && e.message); process.exit(1); });
