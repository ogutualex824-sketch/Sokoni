#!/usr/bin/env node
/* Wishlist Phase 2 — canonical model verification against a real Firestore emulator.
 *
 *   firebase emulators:exec --only firestore --project sokoni-wishlist-test \
 *     "node scripts/test-wishlist-canonical.js"
 *
 * WHAT IS REAL HERE
 *   - Firestore: the emulator. Real reads/writes, real queries.
 *   - Handlers:  functions/marketplace-extensions.js `_h.wishlistAdd|Remove|Get` — the
 *                EXACT functions commerce-dispatch.js routes to (`_H = _merge(mktExt._h,…)`).
 *                Nothing about wishlist behaviour is mocked.
 *   - Service:   sokoni-wishlist.js, loaded with a global shim whose sokoniCallable routes
 *                straight into those same handlers. So the client logic under test is the
 *                shipped file, exercised against the shipped server logic.
 *   - Purge:     account-purge-spec.js `purgeUserData` — the real executor.
 *
 * WHAT IS NOT REAL, STATED PLAINLY
 *   The onCall HTTP wrapper and App Check are not exercised; the handler is invoked with a
 *   request object the way the dispatcher invokes it. That boundary is Firebase's, not
 *   SOKONI's, and mocking it would prove less, not more.
 *
 * CONTROLS ARE MANDATORY. Every isolation assertion is preceded by proof that the
 * legitimate operation SUCCEEDS — otherwise a blanket denial (App Check, bad auth, empty
 * database) would read as security working.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-wishlist-test';

const path = require('path');
const FN = path.resolve(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

const mkt = require('../functions/marketplace-extensions.js');
const purgeSpec = require('../functions/account-purge-spec.js');

const A = 'wl-user-A', B = 'wl-user-B';
const req = (uid, data) => ({ auth: { uid }, data: data || {} });

let pass = 0, fail = 0, inconclusive = 0;
const results = {};
function ck(group, label, ok, detail) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '   [' + String(detail).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
  if (results[group] !== 'FAIL') results[group] = ok ? 'PASS' : 'FAIL';
}
function inc(group, label, why) {
  console.log('  INCONCLUSIVE  ' + label + '   [' + why + ']');
  inconclusive++; results[group] = 'INCONCLUSIVE';
}

const docId = (uid, pid) => `${uid}_${pid}`;
const getDoc = (uid, pid) => db.collection('wishlistItems').doc(docId(uid, pid)).get();
async function countFor(uid) {
  const s = await db.collection('wishlistItems').where('uid', '==', uid).get();
  return s.size;
}
async function wipe() {
  const s = await db.collection('wishlistItems').get();
  const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); if (s.size) await b.commit();
}

/* ── the client service, wired to the real handlers ─────────────────────────── */
function loadService(currentUid, opts) {
  opts = opts || {};
  const store = {};
  const g = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    firebaseAuth: {
      currentUser: currentUid ? { uid: currentUid } : null,
      onAuthStateChanged: (cb) => { g.__authCb = cb; try { cb(g.firebaseAuth.currentUser); } catch (e) {} return () => {}; },
    },
    dispatchEvent: () => true,
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    setTimeout,
    sokoniCallable: (name) => (payload) => {
      if (opts.failRead && payload.op === 'wishlistGet') return Promise.reject(new Error('permission-denied'));
      const h = mkt._h[payload.op];
      if (!h) return Promise.reject(new Error('unknown op ' + payload.op));
      return Promise.resolve(h(req(g.firebaseAuth.currentUser && g.firebaseAuth.currentUser.uid, payload)))
        .then((data) => ({ data }));
    },
  };
  delete require.cache[require.resolve('../sokoni-wishlist.js')];
  const prevWindow = global.window, prevLS = global.localStorage;
  global.window = g;
  /* sokoni-wishlist.js reads bare `localStorage` — a global in a browser, absent in Node.
     Without this every cache write falls into its own try/catch and vanishes, and then
     "B does not see A's cached items" passes because no cache ever existed. A false pass,
     so the global must be present for test H to mean anything. */
  global.localStorage = g.localStorage;
  const svc = require('../sokoni-wishlist.js');
  global.window = prevWindow;
  /* global.localStorage is deliberately NOT restored. `root` is captured once at module
     eval, but bare `localStorage` is resolved dynamically on every call — and load() runs
     asynchronously after this function returns. Restoring here put it back to undefined
     before the first cache write, which silently no-op'd inside the service's try/catch.
     The most recently loaded service owns the global store, which is what test H needs. */
  void prevLS;
  return { svc, g, store };
}

(async () => {
  console.log('\nWISHLIST PHASE 2 — canonical model, real emulator\n' + '='.repeat(60));
  await wipe();

  /* ── A. ADD ── */
  console.log('\nA. Add');
  await mkt._h.wishlistAdd(req(A, { productId: 'p1', shopId: 'shopA', name: 'Unga 2kg', price: 250, image: 'i.png' }));
  let d = await getDoc(A, 'p1');
  ck('A', 'canonical document exists at {uid}_{productId}', d.exists, docId(A, 'p1'));
  ck('A', 'carries the caller uid from auth, not from payload', d.exists && d.data().uid === A, d.exists && d.data().uid);
  ck('A', 'preserves productId/shopId/price', d.exists && d.data().productId === 'p1' && d.data().shopId === 'shopA' && d.data().price === 250);
  ck('A', 'exactly one record for A', (await countFor(A)) === 1, await countFor(A));

  /* ── B. IDEMPOTENT ADD ── */
  console.log('\nB. Duplicate add x10');
  for (let i = 0; i < 10; i++) await mkt._h.wishlistAdd(req(A, { productId: 'p1', shopId: 'shopA', name: 'Unga 2kg', price: 250 }));
  ck('B', 'still exactly one record after 10 adds', (await countFor(A)) === 1, await countFor(A));
  d = await getDoc(A, 'p1');
  ck('B', 'document still has the expected uid/productId', d.data().uid === A && d.data().productId === 'p1');

  /* ── C. REMOVE ── */
  console.log('\nC. Remove');
  await mkt._h.wishlistRemove(req(A, { productId: 'p1' }));
  ck('C', 'canonical document is gone', !(await getDoc(A, 'p1')).exists);
  ck('C', 'A has zero records', (await countFor(A)) === 0);

  /* ── D. IDEMPOTENT REMOVE ── */
  console.log('\nD. Remove again');
  let threw = false;
  try { await mkt._h.wishlistRemove(req(A, { productId: 'p1' })); } catch (e) { threw = true; }
  ck('D', 'removing an absent item does not throw', !threw);
  ck('D', 'collection remains clean', (await countFor(A)) === 0);

  /* ── E. ISOLATION (controls first) ── */
  console.log('\nE. Isolation — controls first');
  await mkt._h.wishlistAdd(req(A, { productId: 'pA', name: "A's item" }));
  await mkt._h.wishlistAdd(req(B, { productId: 'pB', name: "B's item" }));
  const listA = (await mkt._h.wishlistGet(req(A))).items;
  const listB = (await mkt._h.wishlistGet(req(B))).items;
  ck('E', 'CONTROL: A reads A — non-empty', listA.length === 1, listA.length);
  ck('E', 'CONTROL: B reads B — non-empty', listB.length === 1, listB.length);
  ck('E', 'A does NOT receive B\'s item', !listA.some(i => i.productId === 'pB'));
  ck('E', 'B does NOT receive A\'s item', !listB.some(i => i.productId === 'pA'));

  /* ── F. CROSS-USER WRITE ── */
  console.log('\nF. Cross-user write protection');
  await mkt._h.wishlistRemove(req(A, { productId: 'pB' }));   /* A tries to remove B's product */
  ck('F', "B's record survives A's remove attempt", (await getDoc(B, 'pB')).exists);
  await mkt._h.wishlistAdd(req(A, { productId: 'pB', name: 'hijack' }));
  const bDoc = await getDoc(B, 'pB');
  ck('F', "A's add cannot overwrite B's document", bDoc.exists && bDoc.data().uid === B && bDoc.data().name === "B's item", bDoc.data().name);
  ck('F', "A's write landed on A's own namespaced doc", (await getDoc(A, 'pB')).exists);
  ck('F', 'ownership derives from auth uid, never payload', (await getDoc(A, 'pB')).data().uid === A);

  /* ── G. PERSISTENCE (service state destroyed) ── */
  console.log('\nG. Persistence across a fresh service instance');
  let { svc } = loadService(A);
  const first = await svc.load(true);
  ck('G', 'fresh service loads A\'s persisted items', first.length >= 1, first.length);
  ck('G', 'isWishlisted reflects server state', svc.isWishlisted('pA') === true);
  const { svc: svc2 } = loadService(A);            /* brand-new instance, empty cache */
  const again = await svc2.load(true);
  ck('G', 'second instance with EMPTY cache still sees the item', again.some(i => i.productId === 'pA'), again.length);

  /* ── H. CACHE OWNER MISMATCH ── */
  console.log('\nH. Cache identity');
  const asA = loadService(A);
  await asA.svc.load(true);
  const cachedRaw = asA.store['sokoniWishlistCache'];
  ck('H', 'cache is stamped with the owning uid', !!cachedRaw && JSON.parse(cachedRaw).ownerUid === A);
  /* Same device/storage, different account: hand B the cache A wrote. */
  const asB = loadService(B);
  asB.store['sokoniWishlistCache'] = cachedRaw;
  ck('H', "B's service does NOT report A's item from the stale cache", asB.svc.isWishlisted('pA') === false);
  const bItems = await asB.svc.load(true);
  ck('H', "after load B sees only B's items", bItems.every(i => i.uid === B), bItems.map(i => i.productId).join(','));
  ck('H', "A's item absent from B's list", !bItems.some(i => i.productId === 'pA'));

  /* ── I. FAILED LOAD MUST NOT BECOME EMPTY ── */
  console.log('\nI. Failed load');
  const failing = loadService(A, { failRead: true });
  let rejected = false, returned;
  try { returned = await failing.svc.load(true); } catch (e) { rejected = true; }
  ck('I', 'load() REJECTS on canonical read failure', rejected, rejected ? '' : JSON.stringify(returned));
  ck('I', 'it does NOT resolve with an empty array', !(Array.isArray(returned) && returned.length === 0));

  /* ── J. STALE / DELETED PRODUCT ── */
  console.log('\nJ. Stale product reference');
  await mkt._h.wishlistAdd(req(A, { productId: 'deleted-product', name: 'Gone', price: null, image: null }));
  let stableList = null, crashed = false;
  try { stableList = (await mkt._h.wishlistGet(req(A))).items; } catch (e) { crashed = true; }
  ck('J', 'wishlistGet does not crash on a product that no longer exists', !crashed);
  ck('J', 'the orphaned entry is still returned (not silently dropped)',
     !!stableList && stableList.some(i => i.productId === 'deleted-product'));
  ck('J', 'no product data is manufactured for it',
     !!stableList && stableList.find(i => i.productId === 'deleted-product').price === null);
  const svcStale = loadService(A).svc;
  let svcCrashed = false;
  try { await svcStale.load(true); } catch (e) { svcCrashed = true; }
  ck('J', 'the client service loads without crashing', !svcCrashed);

  /* ── K. ACCOUNT PURGE ── */
  console.log('\nK. Account purge isolation');
  await wipe();
  await mkt._h.wishlistAdd(req(A, { productId: 'product1' }));
  await mkt._h.wishlistAdd(req(A, { productId: 'product2' }));
  await mkt._h.wishlistAdd(req(B, { productId: 'product1' }));
  ck('K', 'CONTROL: A seeded with 2, B with 1', (await countFor(A)) === 2 && (await countFor(B)) === 1,
     'A=' + (await countFor(A)) + ' B=' + (await countFor(B)));
  const summary = await purgeSpec.purgeUserData(db, admin, A);
  ck('K', "A's wishlist records are deleted", (await countFor(A)) === 0, await countFor(A));
  ck('K', "B's record is untouched", (await countFor(B)) === 1, await countFor(B));
  ck('K', 'purge summary reports the collection',
     (summary.deleted || []).some(s => String(s).startsWith('wishlistItems:')),
     (summary.deleted || []).filter(s => String(s).includes('wishlist')).join(','));

  /* ── L. PURGE LIMIT ── */
  console.log('\nL. Purge ceiling');
  inc('L', '500-record purge ceiling', 'pre-existing, applies to every collection in the spec; seeding 500+ docs is not worth the emulator time in this phase');

  await wipe();

  console.log('\n' + '='.repeat(60));
  console.log('Wishlist Phase 2');
  console.log('================');
  const order = [['A','Add'],['B','Duplicate add'],['C','Remove'],['D','Idempotent remove'],
                 ['E','Isolation'],['F','Cross-user protection'],['G','Persistence'],
                 ['H','Cache identity'],['I','Failed load'],['J','Stale product'],
                 ['K','Purge isolation'],['L','Purge limit']];
  order.forEach(([k, name]) => console.log((name + ':').padEnd(26) + (results[k] || 'NOT RUN')));
  console.log('');
  console.log('TOTAL ASSERTIONS: ' + (pass + fail + inconclusive));
  console.log('PASSED:           ' + pass);
  console.log('FAILED:           ' + fail);
  console.log('INCONCLUSIVE:     ' + inconclusive);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nSUITE ERROR:', e && e.stack || e); process.exit(1); });
