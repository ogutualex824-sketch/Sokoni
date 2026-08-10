#!/usr/bin/env node
'use strict';

/**
 * claimMinishopHandle against a REAL Firestore (emulator).
 *
 *   npx firebase emulators:exec --only firestore "node scripts/test-minishop-claim-firestore.js"
 *
 * WHY THIS EXISTS ON TOP OF test-minishop-claim-write.js
 * That suite runs the handler against a Firestore fake. The fake implements optimistic
 * concurrency the way Firestore documents it — which is the point, but it is still my model of
 * Firestore, and a bug in the model would hide a bug in the code. The claim's most important
 * property is a CONCURRENCY property, and a hand-written fake is the weakest possible place to
 * prove one.
 *
 * So this runs the same handler against the real transaction engine, and forces the race for
 * real: N sellers fire claims for the same handle simultaneously and the outcome is counted.
 * Exactly one may win. Under the previous read-then-batch implementation several would "win",
 * the last write silently taking the handle from the others while every caller was told the
 * claim succeeded.
 *
 * The admin SDK bypasses security rules, so this proves the HANDLER, not the rules. Rules for
 * shopHandles/minishopConfig remain unverified and are tracked separately.
 */

const path = require('path');

/* firebase-admin is a dependency of the FUNCTIONS package, not the repo root, and it must be
   the SAME instance minishop.js will resolve — two copies would mean two Firestore clients and
   the handler would not see anything this script writes. */
const FUNCTIONS_DIR = path.join(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FUNCTIONS_DIR] }));

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.log('SKIP — FIRESTORE_EMULATOR_HOST is unset. Run through:');
  console.log('  npx firebase emulators:exec --only firestore "node scripts/test-minishop-claim-firestore.js"');
  process.exit(0);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
const db = admin.firestore();

/* Required AFTER initializeApp — minishop.js resolves getFirestore() at call time. */
const minishop = require('../functions/minishop');
const call = (uid, data) => minishop.claimMinishopHandle.run({ auth: uid ? { uid } : null, data });
const caught = async (p) => { try { return { value: await p }; } catch (e) { return { err: e }; } };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail !== undefined ? '\n      ' + JSON.stringify(detail) : '')); }
};
const group = (n) => console.log('\n' + n);

async function wipe () {
  for (const col of ['shops', 'shopHandles', 'minishopConfig']) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

(async () => {
  console.log('\nclaimMinishopHandle — REAL Firestore (' + process.env.FIRESTORE_EMULATOR_HOST + ')');
  console.log('='.repeat(70));
  await wipe();

  /* ── 1. Ownership comes from shops.sellerUid, and a claim never mints a shop ── */
  group('1. Ownership and shop creation');
  {
    const r = await caught(call('nobody-uid', { handle: 'nobodyshop' }));
    ok('refuses a caller who owns no shop', r.err && r.err.code === 'not-found', r.err && r.err.code);
    ok('created no shop', (await db.collection('shops').get()).empty);
    ok('reserved no handle', !(await db.collection('shopHandles').doc('nobodyshop').get()).exists);
  }

  /* ── 2. A real claim lands in both collections ── */
  group('2. The claim persists where the resolver reads');
  await db.collection('shops').doc('shop-A').set({ sellerUid: 'seller-A', name: 'KASS SHOP' });
  await db.collection('shops').doc('shop-B').set({ sellerUid: 'seller-B', name: 'Other Shop' });
  {
    const r = await caught(call('seller-A', { handle: 'KassShop' }));
    ok('claim succeeds', r.value && r.value.success === true, r.err ? r.err.message : r.value);
    ok('handle normalised to lowercase', r.value && r.value.handle === 'kassshop', r.value && r.value.handle);

    const h = (await db.collection('shopHandles').doc('kassshop').get()).data();
    ok('shopHandles/{handle}.uid is the claiming seller', h && h.uid === 'seller-A', h);
    ok('shopHandles/{handle}.shopId is their existing shop', h && h.shopId === 'shop-A', h);

    const cfg = (await db.collection('minishopConfig').doc('shop-A').get()).data();
    ok('minishopConfig/{shopId}.handle is set', cfg && cfg.handle === 'kassshop', cfg);

    ok('still exactly two shops', (await db.collection('shops').get()).size === 2);
  }

  /* ── 3. The resolver's own query finds it ── */
  group('3. The read path the shell uses actually resolves it');
  {
    /* The exact question merchant.html asks: which shop has sellerUid == my uid. If the writer
       and the resolver disagree about where a claim lives, both can pass alone and the seller
       still gets sent back to the claim screen. */
    const q = await db.collection('shops').where('sellerUid', '==', 'seller-A').limit(1).get();
    ok('shops where sellerUid == uid returns the shop', !q.empty && q.docs[0].id === 'shop-A',
       q.empty ? 'empty' : q.docs[0].id);
    const cfg = (await db.collection('minishopConfig').doc(q.docs[0].id).get()).data();
    ok('minishopConfig keyed by that shopId carries the handle', cfg && cfg.handle === 'kassshop', cfg);
    const hq = await db.collection('shopHandles').where('uid', '==', 'seller-A').limit(1).get();
    ok('shopHandles where uid == uid also resolves the handle',
       !hq.empty && hq.docs[0].data().handle === 'kassshop', hq.empty ? 'empty' : hq.docs[0].data());
  }

  /* ── 4. Idempotence and repair, against real merge semantics ── */
  group('4. Idempotent, and repairs a lost config');
  {
    const r = await caught(call('seller-A', { handle: 'kassshop' }));
    ok('re-claim succeeds', r.value && r.value.success === true, r.err && r.err.message);
    ok('no duplicate handle doc', (await db.collection('shopHandles').get()).size === 1);

    await db.collection('minishopConfig').doc('shop-A').set({ brandColor: '#71ff00' });  // handle wiped
    await call('seller-A', { handle: 'kassshop' });
    const cfg = (await db.collection('minishopConfig').doc('shop-A').get()).data();
    ok('re-claim restores the missing handle', cfg && cfg.handle === 'kassshop', cfg);
    ok('merge preserved the unrelated field', cfg && cfg.brandColor === '#71ff00', cfg);
  }

  /* ── 5. Another seller cannot take it ── */
  group('5. A claimed handle is not available to anyone else');
  {
    const r = await caught(call('seller-B', { handle: 'kassshop' }));
    ok('refused with already-exists', r.err && r.err.code === 'already-exists', r.err && r.err.code);
    const h = (await db.collection('shopHandles').doc('kassshop').get()).data();
    ok('the owner is unchanged', h.uid === 'seller-A', h);
    ok('the shopId is unchanged', h.shopId === 'shop-A', h);
  }

  /* ── 6. THE REAL RACE ── */
  group('6. Six sellers claim the same free handle simultaneously');
  {
    const N = 6;
    const uids = [];
    for (let i = 0; i < N; i++) {
      const uid = 'racer-' + i;
      uids.push(uid);
      await db.collection('shops').doc('shop-racer-' + i).set({ sellerUid: uid, name: 'Racer ' + i });
    }

    /* Fired together, against the real transaction engine — no hook, no injected interleaving. */
    const results = await Promise.all(uids.map((u) => caught(call(u, { handle: 'contested' }))));

    const winners = results.filter((r) => r.value && r.value.success === true);
    const refused = results.filter((r) => r.err && r.err.code === 'already-exists');
    const other   = results.filter((r) => r.err && r.err.code !== 'already-exists');

    ok('exactly one claim succeeded', winners.length === 1,
       'winners=' + winners.length + ' refused=' + refused.length + ' other=' + other.length
       + (other.length ? ' :: ' + other.map((o) => o.err.code + '/' + o.err.message).join(' | ') : ''));
    ok('every other claim was refused, not silently overwritten', refused.length === N - 1,
       'refused=' + refused.length + ' of ' + (N - 1));

    const h = (await db.collection('shopHandles').doc('contested').get()).data();
    ok('the stored owner is the seller who was told they won',
       winners.length === 1 && h && h.uid === winners[0].value.ownerUid, { stored: h, won: winners[0] && winners[0].value });
    ok('the stored shopId matches that same winner',
       winners.length === 1 && h && h.shopId === winners[0].value.shopId, { stored: h, won: winners[0] && winners[0].value });

    /* A loser must not be left holding a config that points at a handle they do not own. */
    const strays = [];
    for (let i = 0; i < N; i++) {
      const cfg = (await db.collection('minishopConfig').doc('shop-racer-' + i).get()).data();
      if (cfg && cfg.handle === 'contested' && uids[i] !== h.uid) strays.push('shop-racer-' + i);
    }
    ok('no loser was left with a config claiming the handle', strays.length === 0, strays);
  }

  /* ── 7. Repeat the race — once is an anecdote ── */
  group('7. The race again, ten more times');
  {
    let anomalies = [];
    for (let round = 0; round < 10; round++) {
      const handle = 'round' + round;
      const results = await Promise.all([0, 1, 2, 3].map((i) =>
        caught(call('racer-' + i, { handle }))));
      const winners = results.filter((r) => r.value && r.value.success === true);
      if (winners.length !== 1) anomalies.push({ round, winners: winners.length });
      const h = (await db.collection('shopHandles').doc(handle).get()).data();
      if (winners.length === 1 && (!h || h.uid !== winners[0].value.ownerUid)) {
        anomalies.push({ round, mismatch: { stored: h && h.uid, told: winners[0].value.ownerUid } });
      }
    }
    ok('10/10 rounds produced exactly one winner who owns the handle', anomalies.length === 0, anomalies);
  }

  await wipe();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('\n  SCOPE: the real handler against the real Firestore transaction engine, with');
  console.log('         genuine concurrent contention. The admin SDK bypasses security rules, so');
  console.log('         rules for shopHandles/minishopConfig are NOT verified here.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
