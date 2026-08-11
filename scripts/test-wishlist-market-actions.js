#!/usr/bin/env node
/* Phase 4.4d — market-actions.js wishlist, against real handlers and a real emulator.
 *
 *   firebase emulators:exec --only firestore --project sokoni-wishlist-market-actions-test \
 *     "node scripts/test-wishlist-market-actions.js"
 *
 * The shipped market-actions.js and sokoni-wishlist.js are LOADED, not reimplemented.
 * SokoniMarket's own exported API is what the assertions call. The marketplace handlers
 * are the real ones commerce-dispatch routes to. Only DOM and Auth are shimmed.
 *
 * market-actions.js is an IIFE assigning window.SokoniMarket, so it is evaluated in a
 * sandbox rather than extracted function-by-function — extracting would test a fragment
 * and miss the wiring (badges, event listener) that this phase actually changed.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-wishlist-market-actions-test';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FN = path.resolve(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const mkt = require('../functions/marketplace-extensions.js');

const A = 'ma-user-A', B = 'ma-user-B';
const req = (uid, data) => ({ auth: { uid }, data: data || {} });
const R = {};
let pass = 0, fail = 0, inconc = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
function inc(g, l, why) { console.log('  INCONCLUSIVE  ' + l + '   [' + why + ']'); inconc++; R[g] = 'INCONCLUSIVE'; }

const countFor = async (uid) => (await db.collection('wishlistItems').where('uid', '==', uid).get()).size;
const docOf = (uid, pid) => db.collection('wishlistItems').doc(uid + '_' + pid).get();
async function wipe() {
  const s = await db.collection('wishlistItems').get();
  const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); if (s.size) await b.commit();
}

/* ── block-comment-aware source scanner (shared by J and K–O) ───────────────── */
const LEGACY = /localStorage\s*(?:\.\s*(?:get|set)Item\s*\(\s*|\[\s*)["'](wishlist|sokoniWishlist)["']/;
function codeLines(src) {
  let inBlock = false;
  return src.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (inBlock) { if (t.includes('*/')) inBlock = false; return false; }
    if (t.startsWith('//')) return false;
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return false; }
    if (t.startsWith('*')) return false;
    return true;
  });
}
function scanFile(rel) {
  const p = path.resolve(__dirname, '..', rel);
  if (!fs.existsSync(p)) return [];
  return codeLines(fs.readFileSync(p, 'utf8')).filter((l) => LEGACY.test(l));
}
function scanPage(rel) {
  const p = path.resolve(__dirname, '..', rel);
  const html = fs.readFileSync(p, 'utf8');
  const hits = [];
  [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
    .forEach((m, i) => { if (codeLines(m[1]).some(l => LEGACY.test(l))) hits.push(rel + ' inline#' + i); });
  const srcs = new Set([...html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map(m => m[1])
    .filter(s => !/^https?:/.test(s)).map(s => s.replace(/^\.?\//, '').split('?')[0]));
  srcs.forEach((s) => { if (scanFile(s).length) hits.push(s); });
  return hits;
}

/* ── page sandbox holding the SHIPPED service + market-actions ──────────────── */
function makePage(uid, opts) {
  opts = opts || {};
  const store = {};
  const toasts = [];
  const els = [];
  const mkEl = () => {
    const e = { style: {}, classList: { toggle(){}, add(){}, remove(){} }, dataset: {},
      children: [], attrs: {}, textContent: '', innerHTML: '', title: '',
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; }, removeChild(c) { return c; },
      querySelector() { return null; }, querySelectorAll() { return []; }, remove() {} };
    els.push(e); return e;
  };
  const g = {
    localStorage: { getItem: k => (k in store ? store[k] : null),
                    setItem: (k, v) => { store[k] = String(v); },
                    removeItem: k => { delete store[k]; } },
    firebaseAuth: { currentUser: uid ? { uid } : null,
                    onAuthStateChanged: cb => { try { cb(g.firebaseAuth.currentUser); } catch (e) {} return () => {}; } },
    __listeners: {},
    addEventListener: (t, f) => { (g.__listeners[t] = g.__listeners[t] || []).push(f); },
    dispatchEvent: (ev) => { (g.__listeners[ev.type] || []).forEach(f => { try { f(ev); } catch (e) {} }); return true; },
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    document: { head: mkEl(), body: mkEl(), createElement: mkEl,
                getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                addEventListener: () => {}, readyState: 'complete' },
    sokoniCallable: () => (payload) => {
      if (opts.fail && /wishlist(Add|Remove)/.test(payload.op)) return Promise.reject(new Error('permission-denied'));
      const h = mkt._h[payload.op];
      if (!h) return Promise.reject(new Error('unknown op ' + payload.op));
      return Promise.resolve(h(req(g.firebaseAuth.currentUser && g.firebaseAuth.currentUser.uid, payload)))
        .then(data => ({ data }));
    },
  };
  g.window = g;

  const prevW = global.window;
  global.window = g;
  global.localStorage = g.localStorage;      /* service reads the bare global */
  delete require.cache[require.resolve('../sokoni-wishlist.js')];
  require('../sokoni-wishlist.js');
  global.window = prevW;

  /* Evaluate the SHIPPED market-actions.js in the same sandbox. */
  const ctx = vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', 'market-actions.js'), 'utf8'), ctx);
  /* Its toasts go through DOM; capture via the exported API's side effects instead. */
  return { g, M: g.SokoniMarket, W: g.SokoniWishlist, store, toasts, els };
}

const P1 = { id: 'map1', name: 'Unga 2kg', price: 250, image: 'i.png', shopId: 'shopA' };
const P2 = { id: 'map2', name: 'Sukari 1kg', price: 180, image: 'j.png', shopId: 'shopA' };

(async () => {
  console.log('\nPHASE 4.4d — market-actions.js wishlist\n' + '='.repeat(58));
  await wipe();

  /* A — existing canonical state recognised */
  console.log('\nA. Existing canonical state');
  await mkt._h.wishlistAdd(req(A, { productId: P1.id, name: P1.name, price: P1.price, shopId: P1.shopId }));
  let p = makePage(A);
  await p.W.load(true);
  ck('A', 'seeded canonical record is recognised by SokoniMarket', p.M.isInWishlist(P1.id) === true);
  ck('A', 'an unsaved product is not', p.M.isInWishlist(P2.id) === false);

  /* B — add */
  console.log('\nB. Add via the shipped API');
  await wipe(); p = makePage(A); await p.W.load(true);
  await p.M.addToWishlist(P1);
  ck('B', 'exactly one canonical record', (await countFor(A)) === 1, await countFor(A));
  ck('B', 'stored at the deterministic id', (await docOf(A, P1.id)).exists);
  ck('B', 'uid comes from auth', (await docOf(A, P1.id)).data().uid === A);

  /* C — duplicate safety */
  console.log('\nC. Duplicate safety');
  await p.M.addToWishlist(P1); await p.M.addToWishlist(P1);
  ck('C', 'still exactly one record', (await countFor(A)) === 1, await countFor(A));
  ck('C', 'same deterministic document id', (await docOf(A, P1.id)).exists);

  /* D — remove */
  console.log('\nD. Remove');
  await p.M.removeFromWishlist(P1.id);
  ck('D', 'canonical count is 0', (await countFor(A)) === 0, await countFor(A));
  ck('D', 'state reports not wishlisted', p.M.isInWishlist(P1.id) === false);

  /* E — toggle semantics */
  console.log('\nE. Toggle semantics');
  await p.M.toggleWishlist(P1);
  ck('E', 'toggle → 1', (await countFor(A)) === 1, await countFor(A));
  await p.M.toggleWishlist(P1);
  ck('E', 'toggle → 0', (await countFor(A)) === 0, await countFor(A));
  await p.M.toggleWishlist(P1);
  ck('E', 'toggle → 1', (await countFor(A)) === 1, await countFor(A));
  for (let i = 0; i < 6; i++) await p.M.toggleWishlist(P1);
  ck('E', 'repeated toggling never exceeds 1', (await countFor(A)) <= 1, await countFor(A));

  /* F — failure handling */
  console.log('\nF. Canonical failure');
  await wipe();
  const bad = makePage(A, { fail: true });
  await bad.W.load(true).catch(() => {});
  const before = await countFor(A);
  const res = await bad.M.addToWishlist(P2);
  ck('F', 'add reports failure (falsy), not success', res === false, String(res));
  ck('F', 'no canonical record was created', (await countFor(A)) === before, await countFor(A));
  ck('F', 'state does not claim the item is saved', bad.M.isInWishlist(P2.id) === false);

  /* G — isolation, controls first */
  console.log('\nG. Account isolation — controls first');
  await wipe();
  const pa = makePage(A); await pa.W.load(true); await pa.M.addToWishlist(P1);
  const pb = makePage(B); await pb.W.load(true); await pb.M.addToWishlist(P2);
  ck('G', 'CONTROL: A added its own item', (await countFor(A)) === 1, await countFor(A));
  ck('G', 'CONTROL: B added its own item', (await countFor(B)) === 1, await countFor(B));
  ck('G', 'A sees A\'s item', pa.M.isInWishlist(P1.id) === true);
  ck('G', 'B sees B\'s item', pb.M.isInWishlist(P2.id) === true);
  ck('G', 'A does NOT see B\'s item', pa.M.isInWishlist(P2.id) === false);
  ck('G', 'B does NOT see A\'s item', pb.M.isInWishlist(P1.id) === false);
  await pa.M.removeFromWishlist(P2.id);          /* A tries to remove B's product */
  ck('G', "B's canonical record survives A's remove", (await docOf(B, P2.id)).exists);
  await pb.M.removeFromWishlist(P1.id);          /* B tries to remove A's product */
  ck('G', "A's canonical record survives B's remove", (await docOf(A, P1.id)).exists);
  ck('G', 'documents retain the correct uid',
     (await docOf(A, P1.id)).data().uid === A && (await docOf(B, P2.id)).data().uid === B);

  /* H — event synchronisation */
  console.log('\nH. sokoni:wishlist-changed');
  let fired = 0;
  pa.g.addEventListener('sokoni:wishlist-changed', () => { fired++; });
  await pa.M.toggleWishlist(P1);
  ck('H', 'canonical change emits the event', fired > 0, 'fired=' + fired);
  ck('H', 'SokoniMarket projection follows the change', pa.M.isInWishlist(P1.id) === false);

  /* I — persistence across page/service recreation */
  console.log('\nI. Persistence');
  await wipe();
  const p1 = makePage(A); await p1.W.load(true); await p1.M.addToWishlist(P1);
  const p2 = makePage(A);                       /* brand-new page, empty cache */
  await p2.W.load(true);
  ck('I', 'a fresh page recovers canonical state', p2.M.isInWishlist(P1.id) === true);
  ck('I', 'canonical record still single', (await countFor(A)) === 1, await countFor(A));

  /* J — no legacy persistence in the shipped file */
  console.log('\nJ. market-actions.js legacy scan');
  const jHits = scanFile('market-actions.js');
  ck('J', 'zero executable legacy wishlist refs', jHits.length === 0, jHits.join(' | '));

  /* K–O — page scope */
  console.log('\nK–O. Page scope');
  [['K', 'car-hub.html'], ['L', 'category.html'], ['M', 'healthcare.html'],
   ['N', 'index.html'], ['O', 'services.html']].forEach(([g2, page]) => {
    const hits = scanPage(page);
    ck(g2, page + ' — zero executable legacy wishlist refs', hits.length === 0, hits.join(' | '));
  });

  inc('BROWSER', 'real browser + App Check integration', 'pages not loaded in a browser session; DOM/Auth shimmed in Node');

  await wipe();
  console.log('\n' + '='.repeat(58));
  console.log('Phase 4.4d — market-actions wishlist\n');
  ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O']
    .forEach(k => console.log('  ' + k + ': ' + (R[k] || 'NOT RUN')));
  console.log('\nTOTAL:        ' + (pass + fail + inconc));
  console.log('PASSED:       ' + pass);
  console.log('FAILED:       ' + fail);
  console.log('INCONCLUSIVE: ' + inconc);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nSUITE ERROR:', e && e.stack || e); process.exit(1); });
