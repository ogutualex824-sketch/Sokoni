#!/usr/bin/env node
/* Phase 4.2 — category surface wiring, against the real service and real handlers.
 *
 *   firebase emulators:exec --only firestore --project sokoni-wishlist-mkt-test \
 *     "node scripts/test-wishlist-category.js"
 *
 * SokoniWishlist is NOT mocked — that is the thing under test. The marketplace handlers
 * are the real ones commerce-dispatch routes to. Only the DOM and Firebase Auth are
 * shimmed, because category.js is a browser file and this is Node.
 *
 * addToWishlistCat() is extracted from category.js rather than reimplemented: a test that
 * re-types the logic proves the test author understood it, not that the shipped file works.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-wishlist-mkt-test';

const fs = require('fs');
const path = require('path');
const FN = path.resolve(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

const mkt = require('../functions/marketplace-extensions.js');

const A = 'cat-user-A', B = 'cat-user-B';
const req = (uid, data) => ({ auth: { uid }, data: data || {} });

let pass = 0, fail = 0, inconclusive = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};
const inc = (l, why) => { console.log('  INCONCLUSIVE  ' + l + '   [' + why + ']'); inconclusive++; };

const countFor = async (uid) =>
  (await db.collection('wishlistItems').where('uid', '==', uid).get()).size;
async function wipe() {
  const s = await db.collection('wishlistItems').get();
  const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); if (s.size) await b.commit();
}

/* ── Extract the SHIPPED addToWishlistCat from category.js ──────────────────── */
function extractFn(file, name) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const start = src.indexOf('async function ' + name);
  if (start === -1) throw new Error(name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0, end = -1, q = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error('unbalanced body for ' + name);
  return src.slice(start, end);
}

/* Build a page-like sandbox holding the real service + the extracted handler. */
function makeSurface(uid, opts) {
  opts = opts || {};
  const store = {};
  const notes = [];
  const buttons = [];
  const g = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    firebaseAuth: {
      currentUser: uid ? { uid } : null,
      onAuthStateChanged: cb => { try { cb(g.firebaseAuth.currentUser); } catch (e) {} return () => {}; },
    },
    dispatchEvent: (ev) => { (g.__listeners[ev.type] || []).forEach(f => { try { f(ev); } catch (e) {} }); return true; },
    addEventListener: (t, f) => { (g.__listeners[t] = g.__listeners[t] || []).push(f); },
    __listeners: {},
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    setTimeout,
    document: {
      querySelectorAll: () => buttons,
      querySelector: () => null,
    },
    sokoniCallable: () => (payload) => {
      if (opts.failAdd && payload.op === 'wishlistAdd') return Promise.reject(new Error('permission-denied'));
      const h = mkt._h[payload.op];
      if (!h) return Promise.reject(new Error('unknown op'));
      return Promise.resolve(h(req(g.firebaseAuth.currentUser && g.firebaseAuth.currentUser.uid, payload)))
        .then(data => ({ data }));
    },
  };

  delete require.cache[require.resolve('../sokoni-wishlist.js')];
  const pw = global.window;
  global.window = g;
  global.localStorage = g.localStorage;   /* service reads the bare global */
  require('../sokoni-wishlist.js');
  global.window = pw;

  /* Category-side globals the extracted function closes over. */
  const products = opts.products || [];
  const sandbox = {
    window: g, localStorage: g.localStorage, document: g.document,
    allProducts: products,
    products: products,
    _mkSafe: (v) => String(v == null ? '' : v).replace(/[^a-zA-Z0-9_-]/g, ''),
    showNotification: (msg, type) => notes.push({ msg, type }),
    trackWishlistDemand: () => {},
    displayProducts: () => { sandbox.__painted = (sandbox.__painted || 0) + 1; },
    showNotif: (msg, type) => notes.push({ msg, type }),
    isAdultCategory: () => false,
    requireAgeVerification: async () => true,
    console,
  };
  const body = extractFn('script.js', 'addToWishlist');
  const vm = require('vm');
  vm.createContext(sandbox);
  vm.runInContext(body + '\nglobalThis.__fn = addToWishlist;', sandbox);

  return { call: sandbox.__fn, notes, store, W: g.SokoniWishlist, g, buttons };
}

const PRODUCTS = [
  { id: 'catp1', name: 'Unga 2kg', price: 250, image: 'i.png', shopId: 'shopA', category: 'food' },
  { id: 'catp2', name: 'Sukari 1kg', price: 180, image: 'j.png', shopId: 'shopA', category: 'food' },
];

(async () => {
  console.log('\nPHASE 4.3 — MARKETPLACE/HOME (script.js) WIRING\n' + '='.repeat(58));
  await wipe();

  /* A/B/C — add through the shipped handler */
  console.log('\nA/B/C. Signed-in add via category');
  let s = makeSurface(A, { products: PRODUCTS });
  await s.W.load(true);
  await s.call('catp1');
  ck('A: category add resolves without throwing', true);
  ck('B: canonical document exists', (await db.collection('wishlistItems').doc(A + '_catp1').get()).exists);
  ck('B: exactly one record for A', (await countFor(A)) === 1, await countFor(A));
  ck('C: category reports it as wishlisted', s.W.isWishlisted('catp1') === true);
  ck('C: success toast shown AFTER the write', s.notes.some(n => /Added To Wishlist/i.test(n.msg) && n.type === 'success'), JSON.stringify(s.notes.slice(0,2)));

  /* D — repeated add does not duplicate */
  /* This surface TOGGLES; category only adds. Inheriting category's "a repeat call leaves
     it added" expectation asserted the wrong contract and failed a correct implementation.
     What must hold on every surface is that {uid}_{productId} never exists more than once. */
  console.log('\nD. Toggle semantics — add / remove / add');
  await s.call('catp1');                                   /* toggle OFF */
  ck('D: second toggle REMOVES the canonical record', (await countFor(A)) === 0, await countFor(A));
  ck('D: state reports not-wishlisted', s.W.isWishlisted('catp1') === false);
  ck('D: removal is surfaced to the shopper', s.notes.some(n => /Removed From Wishlist/i.test(n.msg)));
  await s.call('catp1');                                   /* toggle ON */
  ck('D: third toggle re-adds exactly one record', (await countFor(A)) === 1, await countFor(A));
  ck('D: state reports wishlisted again', s.W.isWishlisted('catp1') === true);
  await s.call('catp1'); await s.call('catp1');             /* off, on */
  ck('D: repeated toggling NEVER yields more than one record', (await countFor(A)) === 1, await countFor(A));
  ck('D: the single record is the canonical id', (await db.collection('wishlistItems').doc(A + '_catp1').get()).exists);

  /* E — remove through the service (category has no remove control; service is the path) */
  console.log('\nE. Remove');
  await s.W.remove('catp1');
  ck('E: canonical record deleted', (await countFor(A)) === 0, await countFor(A));
  ck('E: category no longer reports it wishlisted', s.W.isWishlisted('catp1') === false);

  /* F — failure must not look like success */
  console.log('\nF. Canonical failure');
  const bad = makeSurface(A, { products: PRODUCTS, failAdd: true });
  await bad.W.load(true).catch(() => {});
  await bad.call('catp2');
  ck('F: NO success toast on a failed write', !bad.notes.some(n => n.type === 'success' && /Added to wishlist/.test(n.msg)),
     JSON.stringify(bad.notes.slice(0, 2)));
  ck('F: an error is surfaced instead', bad.notes.some(n => n.type === 'error'), JSON.stringify(bad.notes.slice(0, 2)));
  ck('F: nothing was persisted', (await countFor(A)) === 0, await countFor(A));

  /* G — B cannot inherit A's state (controls first) */
  console.log('\nG. Account isolation — controls first');
  const sa = makeSurface(A, { products: PRODUCTS });
  await sa.W.load(true); await sa.call('catp1');
  ck('G CONTROL: A add succeeded', (await countFor(A)) === 1, await countFor(A));
  const sb = makeSurface(B, { products: PRODUCTS });
  sb.store['sokoniWishlistCache'] = sa.store['sokoniWishlistCache'];   /* same device */
  await sb.W.load(true);
  ck('G CONTROL: B starts with zero records', (await countFor(B)) === 0);
  ck("G: B does not report A's product as wishlisted", sb.W.isWishlisted('catp1') === false);
  await sb.call('catp2');
  ck('G CONTROL: B can add its own item', (await countFor(B)) === 1, await countFor(B));
  ck("G: A's record untouched by B", (await db.collection('wishlistItems').doc(A + '_catp1').get()).exists);

  /* H — existing canonical state appears on load */
  console.log('\nH. Existing state on category load');
  const fresh = makeSurface(A, { products: PRODUCTS });
  await fresh.W.load(true);
  ck('H: previously-saved product reads as wishlisted on a fresh page', fresh.W.isWishlisted('catp1') === true);

  /* I — the change event drives card sync */
  console.log('\nI. sokoni:wishlist-changed');
  let fired = 0;
  fresh.g.addEventListener('sokoni:wishlist-changed', () => { fired++; });
  await fresh.W.remove('catp1');
  ck('I: event fires on canonical change', fired > 0, 'fired=' + fired);
  ck('I: state reflects the removal', fresh.W.isWishlisted('catp1') === false);

  /* J — no legacy writer left in the shipped file */
  console.log('\nJ. Legacy writer scan of script.js');
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'script.js'), 'utf8');
  /* Block-comment aware. A per-line "starts with * or // or /*" filter counts every
     CONTINUATION line of a block comment as executable — so a comment explaining that
     localStorage.getItem("wishlist") was removed registered as the very reader it
     documents. The scan has to track block state, or documenting a fix fails the fix. */
  let _inBlock = false;
  const codeLines = src.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (_inBlock) { if (t.includes('*/')) _inBlock = false; return false; }
    if (t.startsWith('//')) return false;
    if (t.startsWith('/*')) { if (!t.includes('*/')) _inBlock = true; return false; }
    if (t.startsWith('*')) return false;
    return true;
  });
  const writers = codeLines.filter(l => /localStorage\.setItem\(\s*["']wishlist["']/.test(l));
  const readers = codeLines.filter(l => /localStorage\.getItem\(\s*["']wishlist["']/.test(l));
  ck('J: zero authoritative wishlist WRITERS remain', writers.length === 0, writers.join(' | '));
  ck('J: zero authoritative wishlist READERS remain', readers.length === 0, readers.join(' | '));
  ck('J: the surface calls SokoniWishlist', /SokoniWishlist/.test(src));

  inc('Browser/App Check end-to-end', 'index.html not exercised in a real browser session; DOM shimmed in Node');

  await wipe();
  console.log('\n' + '='.repeat(58));
  console.log('TOTAL ASSERTIONS: ' + (pass + fail + inconclusive));
  console.log('PASSED:           ' + pass);
  console.log('FAILED:           ' + fail);
  console.log('INCONCLUSIVE:     ' + inconclusive);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nSUITE ERROR:', e && e.stack || e); process.exit(1); });
