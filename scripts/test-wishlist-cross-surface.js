#!/usr/bin/env node
/* Track 3 FINAL — cross-surface agreement.
 *
 *   firebase emulators:exec --only firestore --project sokoni-wishlist-cross-test \
 *     "node scripts/test-wishlist-cross-surface.js"
 *
 * Phases 4.1–4.7 each proved ONE page in isolation. Isolation is exactly what the old
 * four-model wishlist also passed: every surface was internally consistent and they
 * disagreed with each other. So this suite loads several SHIPPED surfaces in one run and
 * asserts they see the same thing — save on one page, and the others must already know.
 *
 * Surfaces exercised, all real files, no reimplementation:
 *   market-actions.js   (car-hub, category, healthcare, index, services)
 *   cart.js             moveToWishlist
 *   flashsale.html      fsAddWish  (inline block)
 *   wishlist.html       render block
 *
 * Each surface gets its OWN sandbox with its OWN localStorage, because sharing one would
 * hide precisely the defect this migration removed: a per-device store looks perfectly
 * consistent until the second device shows up. Separate stores, one uid, one server.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-wishlist-cross-test';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const FN = path.resolve(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const mkt = require('../functions/marketplace-extensions.js');
const ROOT = path.resolve(__dirname, '..');

const A = 'xs-user-A', B = 'xs-user-B';
const req = (uid, data) => ({ auth: { uid }, data: data || {} });
const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 95) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const read = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8');
const countFor = async (uid) => (await db.collection('wishlistItems').where('uid', '==', uid).get()).size;
async function wipe() {
  const s = await db.collection('wishlistItems').get();
  const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); if (s.size) await b.commit();
}

const mkNode = () => ({ style: {}, className: '', textContent: '', innerHTML: '', id: '', dataset: {},
  classList: { add() {}, remove() {}, toggle() {} }, children: [],
  appendChild(c) { this.children.push(c); return c; }, removeChild(c) { return c; },
  remove() {}, setAttribute() {}, getAttribute() { return null; }, parentNode: null });

/* One sandbox = one "device". Its own localStorage, its own service instance. */
function device(uid) {
  const store = {};
  const g = {
    localStorage: { getItem: k => (k in store ? store[k] : null),
                    setItem: (k, v) => { store[k] = String(v); },
                    removeItem: k => { delete store[k]; } },
    firebaseAuth: { currentUser: uid ? { uid } : null,
                    onAuthStateChanged: cb => { try { cb(g.firebaseAuth.currentUser); } catch (e) {} return () => {}; } },
    __l: {},
    addEventListener: (t, f) => { (g.__l[t] = g.__l[t] || []).push(f); },
    dispatchEvent: ev => { (g.__l[ev.type] || []).forEach(f => { try { f(ev); } catch (e) {} }); return true; },
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    setTimeout, clearTimeout, console, requestAnimationFrame: (f) => setTimeout(f, 0),
    JSON, Date, Math, String, Number, Object, Array, Promise, Error, Set, Boolean, RegExp,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    sokoniCallable: () => (payload) => {
      const h = mkt._h[payload.op];
      if (!h) return Promise.reject(new Error('unknown op'));
      return Promise.resolve(h(req(g.firebaseAuth.currentUser && g.firebaseAuth.currentUser.uid, payload)))
        .then(data => ({ data }));
    },
  };
  g.window = g; g.toasts = []; g.store = store;
  g.container = { innerHTML: '' };
  g.document = {
    getElementById: (id) => (id === 'wishlistContainer' ? g.container : (() => { const n = mkNode(); n.id = id; return n; })()),
    createElement: mkNode, body: mkNode(), head: mkNode(),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (t, f) => { (g.__l[t] = g.__l[t] || []).push(f); },
  };
  g.location = { href: '' };
  /* The service is run INSIDE the context, not require()d in the host realm. It reads a
     bare `localStorage`, which in the host realm resolves to one shared global — so every
     "device" would have quietly written to the same store and the isolation this suite
     exists to prove would have been simulated rather than tested. Inside the context,
     `localStorage` and `window` are this sandbox's own. */
  vm.createContext(g);
  vm.runInContext(read('sokoni-wishlist.js'), g);
  if (!g.SokoniWishlist) throw new Error('SokoniWishlist did not define in sandbox');
  return g;
}

function inlineBlock(file, marker) {
  const html = read(file);
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const code = blocks.map(b => b[1]).find(c => c.includes(marker));
  if (!code) throw new Error(marker + ' not found in ' + file);
  return code;
}

/* ── the four surfaces ── */
function marketSurface(uid) {
  const g = device(uid);
  vm.runInContext(read('market-actions.js'), g);
  if (!g.SokoniMarket) throw new Error('SokoniMarket did not define');
  return g;
}
function cartSurface(uid, items) {
  const g = device(uid);
  vm.runInContext(read('cart.js'), g);
  g.showNotif = (m, t) => { g.toasts.push({ msg: m, type: t }); };
  g.__seed = items;
  vm.runInContext('cart.length = 0; __seed.forEach(function (i) { cart.push(i); });', g);
  g.getCart = () => vm.runInContext('cart', g);
  return g;
}
function flashSurface(uid, products) {
  const g = device(uid);
  try { vm.runInContext(inlineBlock('flashsale.html', 'function fsAddWish'), g); } catch (e) {}
  if (typeof g.fsAddWish !== 'function') throw new Error('fsAddWish did not define');
  g.__seed = products;
  vm.runInContext('allProducts = __seed.slice();', g);
  g.showToast = (m) => { g.toasts.push({ msg: m }); };
  return g;
}
function pageSurface(uid) {
  const g = device(uid);
  g.updateCartBadge = () => {}; g.updateWishCount = () => {}; g.SokoniShare = null;
  vm.runInContext(inlineBlock('wishlist.html', 'function renderWishlist'), g);
  return g;
}

const P1 = { id: 'x1', productId: 'x1', name: 'Jiko', price: 2400, image: 'a.png', shopId: 'shopA' };
const P2 = { id: 'x2', productId: 'x2', name: 'Thermos', price: 1500, image: 'b.png', shopId: 'shopB' };

(async () => {
  console.log('\nTRACK 3 FINAL — CROSS-SURFACE AGREEMENT\n' + '='.repeat(64));
  await wipe();

  /* ══ A. save on a marketplace card, see it on the wishlist page ══ */
  console.log('\nA. market-actions save → wishlist page (different sandbox)');
  const mkt1 = marketSurface(A);
  await mkt1.SokoniMarket.toggleWishlist(P1);
  ck('A', 'one canonical record', (await countFor(A)) === 1, await countFor(A));

  const page1 = pageSurface(A);
  await page1._wishReload();
  await new Promise(r => setTimeout(r, 60));
  ck('A', 'wishlist page shows the item saved elsewhere', /Jiko/.test(page1.container.innerHTML),
     page1.container.innerHTML.slice(0, 70));
  ck('A', 'page did NOT read it from local state', page1.localStorage.getItem('wishlist') === null);
  ck('A', 'the two sandboxes never shared a store',
     mkt1.store !== page1.store && page1.store.sokoniWishlistCache !== undefined);

  /* ══ B. flash sale save is visible to a marketplace card ══ */
  console.log('\nB. flashsale save → marketplace card state');
  const flash1 = flashSurface(A, [P2]);
  await flash1.fsAddWish('x2');
  ck('B', 'two canonical records now', (await countFor(A)) === 2, await countFor(A));

  const mkt2 = marketSurface(A);
  await mkt2.SokoniWishlist.load(true);
  ck('B', 'a fresh card surface knows x2 is saved', mkt2.SokoniMarket.isInWishlist('x2'));
  ck('B', 'and still knows about x1', mkt2.SokoniMarket.isInWishlist('x1'));
  ck('B', 'and does not invent one it never saw', !mkt2.SokoniMarket.isInWishlist('x999'));

  /* ══ C. cart move is visible everywhere ══ */
  console.log('\nC. cart move → every other surface');
  const P3 = { id: 'x3', name: 'Sufuria', price: 800, image: 'c.png', shopId: 'shopA' };
  const cart1 = cartSurface(A, [P3]);
  await cart1.moveToWishlist(0);
  ck('C', 'three canonical records', (await countFor(A)) === 3, await countFor(A));

  const page2 = pageSurface(A);
  await page2._wishReload();
  await new Promise(r => setTimeout(r, 60));
  ck('C', 'wishlist page shows the moved item', /Sufuria/.test(page2.container.innerHTML));
  ck('C', 'wishlist page shows all three', page2._wishData.length === 3, page2._wishData.length);

  /* ══ D. removal propagates too — the direction that used to be silently lost ══ */
  console.log('\nD. Remove on one surface → gone on the others');
  const mkt3 = marketSurface(A);
  await mkt3.SokoniWishlist.load(true);
  await mkt3.SokoniMarket.toggleWishlist(P1);          /* toggle OFF */
  ck('D', 'two canonical records left', (await countFor(A)) === 2, await countFor(A));

  const page3 = pageSurface(A);
  await page3._wishReload();
  await new Promise(r => setTimeout(r, 60));
  ck('D', 'wishlist page no longer shows it', !/Jiko/.test(page3.container.innerHTML));
  const flash2 = flashSurface(A, [P1]);
  await flash2.SokoniWishlist.load(true);
  ck('D', 'flash sale surface agrees it is gone', !flash2.SokoniWishlist.isWishlisted('x1'));

  /* ══ E. THE ORIGINAL DEFECT — one shopper never sees another's saved items ══
     This is what the localStorage model got wrong: a device, not an account, owned the
     wishlist. Same sandbox, second account. */
  console.log('\nE. A second account on the same device sees its OWN wishlist');
  const shared = device(A);
  await shared.SokoniWishlist.load(true);
  ck('E', 'account A sees its 2 items', shared.SokoniWishlist.count() === 2, shared.SokoniWishlist.count());
  const cacheBefore = shared.localStorage.getItem('sokoniWishlistCache');
  ck('E', 'a paint cache exists (control — there IS something to leak)', !!cacheBefore);

  /* Sign in as B on the very same device, cache and all. */
  shared.firebaseAuth.currentUser = { uid: B };
  await shared.SokoniWishlist.load(true);
  ck('E', "account B does NOT inherit A's items", shared.SokoniWishlist.count() === 0,
     shared.SokoniWishlist.count());
  ck('E', "B cannot see A's product ids", !shared.SokoniWishlist.isWishlisted('x2'));
  ck('E', "the cache is now stamped to B, not A",
     (JSON.parse(shared.localStorage.getItem('sokoniWishlistCache') || '{}').ownerUid || null) !== A,
     shared.localStorage.getItem('sokoniWishlistCache'));

  /* And B saving must not touch A. */
  await shared.SokoniWishlist.add({ productId: 'b1', name: "B's item" });
  ck('E', 'B has exactly 1', (await countFor(B)) === 1, await countFor(B));
  ck('E', 'A still has exactly 2 — untouched', (await countFor(A)) === 2, await countFor(A));

  /* ══ F. server-side isolation, independent of any client ══ */
  console.log('\nF. Server scopes reads to the caller');
  const asA = await mkt._h.wishlistGet(req(A, {}));
  const asB = await mkt._h.wishlistGet(req(B, {}));
  ck('F', 'A gets 2', (asA.items || []).length === 2, (asA.items || []).length);
  ck('F', 'B gets 1', (asB.items || []).length === 1, (asB.items || []).length);
  ck('F', 'no overlap between the two result sets',
     !(asA.items || []).some(i => (asB.items || []).some(j => j.productId === i.productId)));
  ck('F', 'every row A receives is owned by A', (asA.items || []).every(i => i.uid === A));

  /* ══ G. a failed read is never rendered as an empty wishlist ══
     "Unknown ≠ empty": the whole point of load() rejecting instead of returning []. */
  console.log('\nG. A failed canonical read is not an empty wishlist');
  {
    const g = device(A);
    await g.SokoniWishlist.load(true);
    ck('G', 'starts with 2 (control)', g.SokoniWishlist.count() === 2, g.SokoniWishlist.count());
    g.sokoniCallable = () => () => Promise.reject(new Error('permission-denied'));
    let threw = false;
    try { await g.SokoniWishlist.load(true); } catch (e) { threw = true; }
    ck('G', 'load REJECTS rather than resolving []', threw);
    ck('G', 'it did not silently zero the count', g.SokoniWishlist.count() === 2, g.SokoniWishlist.count());
  }

  /* ══ H. the page reports the failure instead of rendering "empty" ══ */
  console.log('\nH. wishlist.html shows an error state, not "no saved items"');
  {
    const g = pageSurface(A);
    /* Let the service's own sign-in load settle FIRST. load(force) returns the in-flight
       promise when one exists, so swapping the transport mid-flight would have handed the
       page the earlier SUCCESSFUL result and this block would have proved nothing. */
    await g.SokoniWishlist.load(true).catch(() => {});
    g.sokoniCallable = () => () => Promise.reject(new Error('permission-denied'));
    try { await g._wishReload(); } catch (e) { /* the page handles it; H asserts HOW */ }
    await new Promise(r => setTimeout(r, 60));
    const html = g.container.innerHTML;
    /* Assert on what the SHOPPER reads, not on markup: the error state reuses the
       .wish-empty layout class, so matching raw HTML for "empty" flags the stylesheet
       rather than the message and fails a page that is behaving correctly. */
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    ck('H', 'state is error, not ready', g._wishState === 'error', g._wishState);
    ck('H', 'the visible text does not claim the wishlist is empty',
       !/no saved items|nothing saved|wishlist is empty/i.test(text), text.slice(0, 90));
    ck('H', 'it says the items are safe, not gone', /safe/i.test(text), text.slice(0, 90));
    ck('H', 'offers a retry', /try again|retry/i.test(text), text.slice(0, 90));
  }

  /* ── summary ── */
  console.log('\n' + '='.repeat(64));
  console.log('Track 3 cross-surface acceptance\n');
  ['A','B','C','D','E','F','G','H'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
  console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
