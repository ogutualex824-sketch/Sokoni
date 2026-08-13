#!/usr/bin/env node
/* Phase 4.7 — cart.js, profile.js, flashsale.html, and the final repo-wide sweep.
 *
 *   firebase emulators:exec --only firestore --project sokoni-wishlist-47-test \
 *     "node scripts/test-wishlist-phase47.js"
 *
 * Runs the SHIPPED moveToWishlist() and fsAddWish() against the real marketplace
 * handlers through the real SokoniWishlist service. Nothing about wishlist behaviour
 * is mocked; only the browser DOM/Auth boundary is shimmed.
 *
 * The point of this phase is not "the button works". Moving to a wishlist became an
 * operation that can FAIL the moment it stopped being a localStorage write, so the
 * assertions that matter are the failure ones: block D proves the cart line survives a
 * rejected save, which the pre-migration code could not have done and the post-migration
 * code would silently get wrong if the remove were left outside the .then().
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-wishlist-47-test';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const FN = path.resolve(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const mkt = require('../functions/marketplace-extensions.js');
const ROOT = path.resolve(__dirname, '..');
const scanner = require('./scan-legacy-wishlist.js');

const A = 'p47-user-A';
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
const canon = (uid, pid) => db.collection('wishlistItems').doc(uid + '_' + pid).get();
async function wipe() {
  const s = await db.collection('wishlistItems').get();
  const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); if (s.size) await b.commit();
}

/* ── shared browser shim ──────────────────────────────────────────────────── */
const mkNode = () => ({ style: {}, className: '', textContent: '', innerHTML: '', id: '',
  classList: { add() {}, remove() {}, toggle() {} }, children: [],
  appendChild(c) { this.children.push(c); return c; }, removeChild(c) { return c; },
  remove() {}, setAttribute() {}, getAttribute() { return null; }, parentNode: null });

function makeGlobal(uid, opts) {
  opts = opts || {};
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
    setTimeout, clearTimeout, console,
    JSON, Date, Math, String, Number, Object, Array, Promise, Error, Set, Boolean, RegExp, isNaN, parseInt, parseFloat,
    sokoniCallable: () => (payload) => {
      if (opts.failAdd && payload.op === 'wishlistAdd') return Promise.reject(new Error(opts.failAdd));
      const h = mkt._h[payload.op];
      if (!h) return Promise.reject(new Error('unknown op'));
      return Promise.resolve(h(req(g.firebaseAuth.currentUser && g.firebaseAuth.currentUser.uid, payload)))
        .then(data => ({ data }));
    },
  };
  g.window = g;
  g.toasts = [];
  g.document = {
    getElementById: (id) => { const n = mkNode(); n.id = id; return n; },
    createElement: mkNode, body: mkNode(), head: mkNode(),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (t, f) => { (g.__l[t] = g.__l[t] || []).push(f); },
  };
  g.location = { href: '' };

  /* Load the SHIPPED service into this sandbox. */
  const pw = global.window, pl = global.localStorage;
  global.window = g; global.localStorage = g.localStorage;
  delete require.cache[require.resolve('../sokoni-wishlist.js')];
  require('../sokoni-wishlist.js');
  global.window = pw; global.localStorage = pl;
  return g;
}

/* Run the SHIPPED cart.js inside the sandbox.
   `cart` is a top-level `let`, so it lives in the context's lexical scope and is NOT a
   property of the global object — reading g.cart returns undefined and would have made
   every "item still in the cart" assertion vacuously pass against nothing. It is reached
   through the context instead, so the tests observe the module's real state. */
/* ── SokoniCart double — the cart is a SERVICE now (Track 2) ──────────────────
   This suite used to seed and read cart.js's module-scope `cart` array directly. That was
   correct when the array WAS the cart. Track 2 moved ownership to window.SokoniCart and left
   `cart` as a render projection refilled by _syncCart() — cart.js:21 says so in as many words —
   and removeFromCart() now delegates to the service.

   With no service in the sandbox, _cartSvc() returned null and removeFromCart() took its
   "Cart is still loading" branch and removed nothing. Four assertions then failed against
   code that is behaving exactly as designed: the suite was describing an obsolete design.

   The fix is to give the sandbox the collaborator the shipped code expects, NOT to relax the
   assertions. This makes them STRONGER — they now prove the service is actually called and
   that the correct line is removed through it, rather than that a local array was spliced.
   Only the methods cart.js really calls are implemented (list/lines/removeAt/removeByCartId/
   setQty/clear), so a new dependency on this service shows up as a TypeError here rather than
   being silently absorbed by a permissive stub. */
function makeCartService(items) {
  let lines = items.map((i) => ({ ...i }));
  return {
    list:  () => lines.map((i) => ({ ...i })),   /* a COPY, like the real service — callers must not mutate the cart by reference */
    lines: () => lines.length,
    removeAt: (i) => {
      if (!Number.isInteger(i) || i < 0 || i >= lines.length) return false;
      lines.splice(i, 1);
      return true;
    },
    removeByCartId: (cartId) => {
      const want = String(cartId || '');
      const i = lines.findIndex((l) => String((l && l.cartId) || '') === want);
      if (i === -1) return false;
      lines.splice(i, 1);
      return true;
    },
    /* Mirrors the real removeById: matches on id||productId and removes exactly ONE line,
       not every line sharing the id — duplicate rows carry independent quantities. */
    removeById: (id) => {
      const want = String(id || '');
      if (!want) return false;
      const i = lines.findIndex((l) => String((l && (l.id || l.productId)) || '') === want);
      if (i === -1) return false;
      lines.splice(i, 1);
      return true;
    },
    setQty: (i, q) => {
      if (!lines[i]) return false;
      if (q <= 0) { lines.splice(i, 1); return true; }
      lines[i].qty = q; return true;
    },
    clear: () => { lines = []; return true; },
    /* Test-only window onto the service's own state, so assertions can read what the CART
       holds rather than what the projection happens to have been refilled with. */
    __lines: () => lines,
  };
}

function makeCart(uid, cartItems, opts) {
  const g = makeGlobal(uid, opts);
  g.SokoniCart = makeCartService(cartItems || []);
  vm.createContext(g);
  vm.runInContext(read('cart.js'), g);
  /* AFTER the module runs, never before: cart.js declares its own showNotif(), and a
     function declaration overwrites a pre-seeded property — so an early shim captures
     nothing and every toast assertion reads an empty array (i.e. passes the negative
     ones for the wrong reason). */
  g.showNotif = (msg, type) => { g.toasts.push({ msg: msg, type: type }); };
  /* Read the SERVICE, not the projection. `cart` in cart.js is refilled by _syncCart() only
     when renderCart() runs, so asserting on it would test when the view last refreshed rather
     than what the cart contains — and would pass or fail on render timing. */
  g.getCart = () => g.SokoniCart.__lines();
  if (!Array.isArray(g.getCart())) throw new Error('cart service not reachable in sandbox');
  /* The projection must still be wired, or cart.js is not running the code we think it is. */
  if (!Array.isArray(vm.runInContext('cart', g))) throw new Error('cart projection missing in cart.js');
  return g;
}

/* Run the SHIPPED flashsale.html inline block inside the sandbox. */
function makeFlash(uid, products, opts) {
  const g = makeGlobal(uid, opts);
  const html = read('flashsale.html');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const code = blocks.map(b => b[1]).find(c => c.includes('function fsAddWish'));
  if (!code) throw new Error('fsAddWish block not found in flashsale.html');
  vm.createContext(g);
  try { vm.runInContext(code, g); } catch (e) { /* later page wiring may need DOM we lack */ }
  if (typeof g.fsAddWish !== 'function') throw new Error('fsAddWish did not define');
  /* allProducts/flashProducts are top-level let/const, so they live in the context's
     lexical scope: assigning g.allProducts creates a shadowed property the page never
     reads, _findProduct returns null, and fsAddWish silently returns before doing
     anything — which looks exactly like a failed write. Seed through the context. */
  g.__seed = products;
  vm.runInContext('allProducts = __seed.slice();', g);
  g.getFound = (id) => vm.runInContext('_findProduct(' + JSON.stringify(id) + ')', g);
  if (!g.getFound(products[0].id)) throw new Error('product not reachable in sandbox');
  g.showToast = (m) => { g.toasts.push({ msg: m }); };
  return g;
}

const ITEM = { id: 'fs1', name: 'Kettle', price: 1200, image: 'k.png', shopId: 'shopA' };

(async () => {
  console.log('\nPHASE 4.7 — cart.js · profile.js · flashsale.html · final sweep\n' + '='.repeat(64));
  await wipe();

  /* ══ A. cart.js — move writes canonically ══ */
  console.log('\nA. cart.js moveToWishlist writes the canonical record');
  let g = makeCart(A, [{ ...ITEM }]);
  await g.moveToWishlist(0);
  ck('A', 'canonical record created', (await canon(A, 'fs1')).exists);
  ck('A', 'exactly one canonical record', (await countFor(A)) === 1, await countFor(A));
  ck('A', 'record carries the product fields', (await canon(A, 'fs1')).data().name === 'Kettle');
  ck('A', 'success toast shown', /Moved to wishlist/.test((g.toasts[0] || {}).msg || ''), JSON.stringify(g.toasts));

  /* ══ B. the cart line is removed on success ══ */
  console.log('\nB. Successful move empties the cart line');
  ck('B', 'item left the cart', g.getCart().length === 0, JSON.stringify(g.getCart()));
  ck('B', 'cart persisted without it', JSON.parse(g.localStorage.getItem('cart') || '[]').length === 0);

  /* ══ C. no legacy key is touched anywhere in the flow ══ */
  console.log('\nC. localStorage["wishlist"] is never written');
  ck('C', 'legacy key absent after a successful move', g.localStorage.getItem('wishlist') === null,
     String(g.localStorage.getItem('wishlist')));

  /* ══ D. THE ONE THAT MATTERS — failure must not destroy the item ══ */
  console.log('\nD. Failed save keeps the item in the cart (no silent data loss)');
  await wipe();
  g = makeCart(A, [{ ...ITEM }], { failAdd: 'permission-denied' });
  const rD = await g.moveToWishlist(0);
  ck('D', 'move reports failure', rD === false, String(rD));
  ck('D', 'NOTHING was written canonically', (await countFor(A)) === 0, await countFor(A));
  ck('D', 'item is STILL in the cart', g.getCart().length === 1 && g.getCart()[0].id === 'fs1', JSON.stringify(g.getCart()));
  ck('D', 'persisted cart still holds it',
     JSON.parse(g.localStorage.getItem('cart') || '[]').length === 1 ||
     g.localStorage.getItem('cart') === null);
  ck('D', 'toast reports the failure, not success',
     g.toasts.length === 1 && /kept in your cart|Sign in/.test(g.toasts[0].msg) && g.toasts[0].type === 'error',
     JSON.stringify(g.toasts));
  ck('D', 'no success toast was shown first',
     !g.toasts.some(t => /Moved to wishlist/.test(t.msg)), JSON.stringify(g.toasts));

  /* ══ E. signed-out ══ */
  console.log('\nE. Signed-out shopper');
  await wipe();
  g = makeCart(null, [{ ...ITEM }]);
  const rE = await g.moveToWishlist(0);
  ck('E', 'move reports failure', rE === false);
  ck('E', 'item stays in the cart', g.getCart().length === 1, JSON.stringify(g.getCart()));
  ck('E', 'told to sign in', /Sign in/.test((g.toasts[0] || {}).msg || ''), JSON.stringify(g.toasts));
  ck('E', 'nothing written for a null uid', (await db.collection('wishlistItems').get()).size === 0);

  /* ══ F. already-saved item ══ */
  console.log('\nF. Item already in the wishlist');
  await wipe();
  await mkt._h.wishlistAdd(req(A, { productId: 'fs1', name: 'Kettle' }));
  g = makeCart(A, [{ ...ITEM }]);
  await g.SokoniWishlist.load(true);
  const rF = await g.moveToWishlist(0);
  ck('F', 'reported as handled', rF === true, String(rF));
  ck('F', 'still exactly one canonical record (no duplicate)', (await countFor(A)) === 1, await countFor(A));
  ck('F', 'cart line removed — the item IS saved', g.getCart().length === 0, JSON.stringify(g.getCart()));
  ck('F', 'told it was already saved', /Already in wishlist/.test((g.toasts[0] || {}).msg || ''),
     JSON.stringify(g.toasts));

  /* ══ G. stale index — the await opens a window for the cart to change ══ */
  console.log('\nG. Cart mutated during the await (stale index)');
  await wipe();
  g = makeCart(A, [{ ...ITEM }, { id: 'other', name: 'Sufuria', price: 900 }]);
  const pG = g.moveToWishlist(0);
  g.getCart().unshift({ id: 'jumped-in', name: 'Race' });   /* index 0 is now a DIFFERENT item */
  await pG;
  ck('G', 'the saved item is the one that left', !g.getCart().some(i => i.id === 'fs1'), JSON.stringify(g.getCart().map(i => i.id)));
  ck('G', 'the item that jumped in is untouched', g.getCart().some(i => i.id === 'jumped-in'),
     JSON.stringify(g.getCart().map(i => i.id)));
  ck('G', 'the unrelated item is untouched', g.getCart().some(i => i.id === 'other'),
     JSON.stringify(g.getCart().map(i => i.id)));

  /* ══ H. flashsale.html ══ */
  console.log('\nH. flashsale.html fsAddWish writes canonically');
  await wipe();
  let f = makeFlash(A, [{ ...ITEM }]);
  await f.fsAddWish('fs1');
  ck('H', 'canonical record created', (await canon(A, 'fs1')).exists);
  ck('H', 'legacy key never written', f.localStorage.getItem('wishlist') === null,
     String(f.localStorage.getItem('wishlist')));
  ck('H', 'success toast shown', /Added to wishlist/.test((f.toasts[0] || {}).msg || ''), JSON.stringify(f.toasts));

  /* ══ I. flashsale failure does not claim success ══ */
  console.log('\nI. flashsale.html failure is reported honestly');
  await wipe();
  f = makeFlash(A, [{ ...ITEM }], { failAdd: 'permission-denied' });
  const rI = await f.fsAddWish('fs1');
  ck('I', 'reports failure', rI === false, String(rI));
  ck('I', 'nothing written canonically', (await countFor(A)) === 0, await countFor(A));
  ck('I', 'no "Added to wishlist" toast', !f.toasts.some(t => /Added to wishlist/.test(t.msg)),
     JSON.stringify(f.toasts));
  ck('I', 'failure toast shown', /try again|Sign in/.test((f.toasts[0] || {}).msg || ''), JSON.stringify(f.toasts));

  /* ══ J. profile.js ══ */
  console.log('\nJ. profile.js holds no legacy wishlist reader');
  const prof = scanner.stripComments(read('profile.js'));
  ck('J', 'no localStorage wishlist read survives', !/localStorage[\s\S]{0,24}["']wishlist["']/.test(prof));
  ck('J', 'no fabricated wishlist count is rendered', !/wishlistCount["']\s*\)[\s\S]{0,80}\.length/.test(prof));
  /* This asserted that profile.js STILL contained getItem("cart") — the point being that the
     wishlist migration must not collaterally damage the cart read, which was Track 2's
     business and not 4.7's. Correct at the time; obsolete now. Track 2.3.7 (8b785ba) removed
     that read DELIBERATELY, and profile.js records why: it fed #cartItemsCount, which
     profile.html has not contained for some time, and it counted LINES while every badge on
     the platform counts units — so rerouting it mechanically would have silently changed a
     number an owner reads.
     Keeping the old assertion would demand the reintroduction of a legacy localStorage read
     that the file's own contract forbids in writing. The property worth holding is the one
     profile.js actually states, and it is the same rule as its wishlist twin: no localStorage
     cart read, of any shape. That is strictly stronger than the string-presence check. */
  ck('J', 'no localStorage cart read survives (Track 2.3.7 removed it deliberately)',
     !/localStorage[\s\S]{0,24}["']cart["']/.test(prof));
  ck('J', 'and no cart count is fabricated from a local array length',
     !/cartItemsCount["']\s*\)[\s\S]{0,80}\.length/.test(prof));

  /* ══ K. wishlist.js is gone ══ */
  console.log('\nK. Orphaned wishlist.js deleted');
  ck('K', 'file no longer exists', !fs.existsSync(path.resolve(ROOT, 'wishlist.js')));
  ck('K', 'service-worker precache no longer names it',
     !/["']\/wishlist\.js["']/.test(scanner.stripComments(read('service-worker.js'))));
  ck('K', 'the canonical service file is still present', fs.existsSync(path.resolve(ROOT, 'sokoni-wishlist.js')));

  /* ══ L. every consumer page actually loads the service ══
     A migrated page that never loads sokoni-wishlist.js fails CLOSED — _wl() is null, so
     the heart answers "still loading" forever. That is not visible in any per-file scan,
     which is how car-hub, healthcare and services shipped migrated-but-inert. */
  console.log('\nL. Every page that calls SokoniWishlist loads it');
  {
    const pages = fs.readdirSync(ROOT).filter(n => n.endsWith('.html'));
    const consumers = [], missing = [];
    /* A page consumes the service directly (inline SokoniWishlist) or indirectly via a
       migrated script it loads. */
    const INDIRECT = ['market-actions.js', 'cart.js', 'product.js', 'category.js', 'script.js'];
    pages.forEach(p => {
      const src = read(p);
      const inline = scanner.keepOnly(src, scanner.htmlScriptRegions(src));
      const usesInline = /SokoniWishlist/.test(scanner.stripComments(inline));
      const viaScript = INDIRECT.some(s => new RegExp('src=["\']' + s.replace('.', '\\.') + '["\']').test(src));
      if (!usesInline && !viaScript) return;
      consumers.push(p);
      if (!/src=["']sokoni-wishlist\.js["']/.test(src)) missing.push(p);
    });
    ck('L', 'consumer pages were found at all (control)', consumers.length >= 5, consumers.join(','));
    ck('L', 'every consumer page loads sokoni-wishlist.js', missing.length === 0, missing.join(', '));
  }

  /* ══ M. scanner positive controls ══
     A sweep that reports zero is only meaningful if it can report non-zero. These feed the
     real scanner synthetic sources and require it to catch each shape it claims to cover. */
  console.log('\nM. Sweep positive controls (it must be able to FAIL)');
  {
    const S = scanner.stripComments;
    const hit = (src) => {
      const stripped = S(src);
      return /localStorage\s*(?:\.\s*(?:get|set|remove)Item\s*\(\s*|\[\s*)["'](wishlist|sokoniWishlist)["']/.test(stripped);
    };
    ck('M', 'catches a plain writer', hit('localStorage.setItem("wishlist", x);'));
    ck('M', 'catches a bracket writer', hit("localStorage['wishlist'] = x;"));
    ck('M', 'catches a reader', hit('var w = localStorage.getItem("wishlist");'));
    ck('M', 'catches the other key', hit("localStorage.getItem('sokoniWishlist')"));
    ck('M', 'IGNORES a block comment', !hit('/* we removed localStorage.getItem("wishlist") */'));
    ck('M', 'IGNORES a line comment', !hit('// localStorage.setItem("wishlist", x)'));
    ck('M', 'survives the regex-vs-string trap that broke v1',
       hit('a.replace(/"/g,"&quot;").replace(/\'/g,"&#x27;");\nlocalStorage.setItem("wishlist", x);'));
    /* inline <script> extraction */
    const html = '<script src="x.js"></script>\n<script>localStorage.setItem("wishlist",1)</script>';
    const inl = scanner.keepOnly(html, scanner.htmlScriptRegions(html));
    ck('M', 'reaches inline <script> in HTML', hit(inl));
    const htmlSrcOnly = '<script src="wishlist-thing.js"></script>';
    ck('M', 'does not invent hits from a src tag',
       !hit(scanner.keepOnly(htmlSrcOnly, scanner.htmlScriptRegions(htmlSrcOnly))));
  }

  /* ══ N. the final invariant ══ */
  console.log('\nN. FINAL INVARIANT — repo-wide, executable code only');
  {
    const { hits, suppressed } = scanner.scan();
    const byKey = (k) => hits.filter(h => h.key === k);
    ['wishlist', 'sokoniWishlist'].forEach(k => {
      const m = byKey(k);
      ck('N', "localStorage['" + k + "'] — zero executable writers",
         m.filter(h => h.kind === 'WRITE').length === 0,
         m.filter(h => h.kind === 'WRITE').map(h => h.file + ':' + h.line).join(', '));
      ck('N', "localStorage['" + k + "'] — zero executable readers",
         m.filter(h => h.kind === 'READ').length === 0,
         m.filter(h => h.kind === 'READ').map(h => h.file + ':' + h.line).join(', '));
      ck('N', "localStorage['" + k + "'] — zero other executable references",
         m.filter(h => h.kind !== 'READ' && h.kind !== 'WRITE').length === 0,
         m.filter(h => h.kind !== 'READ' && h.kind !== 'WRITE').map(h => h.file + ':' + h.line).join(', '));
    });
    /* The suppressed bucket is reported, not trusted silently: if the stripper ever
       over-blanks, the count moves and this line makes it visible in the log. */
    console.log('     (' + suppressed.length + ' mentions suppressed as prose — listed by scan-legacy-wishlist.js)');
    ck('N', 'suppressed mentions are documentation only, never assignments',
       suppressed.every(h => !/=\s*JSON|setItem/.test(h.text) || /\/\*|\*|used to|no longer|retired|removed|wrote|read/i.test(h.text)),
       suppressed.filter(h => /setItem/.test(h.text)).map(h => h.file + ':' + h.line).join(', '));
  }

  /* ══ O. the canonical service is still the only holder of the legacy names ══ */
  console.log('\nO. sokoni-wishlist.js names the legacy keys only to DELETE them');
  {
    const svc = scanner.stripComments(read('sokoni-wishlist.js'));
    ck('O', 'declares them as LEGACY_KEYS', /LEGACY_KEYS\s*=\s*\['wishlist',\s*'sokoniWishlist'\]/.test(svc));
    ck('O', 'uses them with removeItem', /LEGACY_KEYS\.forEach[\s\S]{0,120}removeItem/.test(svc));
    ck('O', 'never setItem on a legacy key', !/setItem\s*\(\s*["'](wishlist|sokoniWishlist)["']/.test(svc));
    ck('O', 'never getItem', !/getItem\s*\(\s*["'](wishlist|sokoniWishlist)["']/.test(svc));
  }

  /* ── summary ── */
  console.log('\n' + '='.repeat(64));
  console.log('Phase 4.7 acceptance\n');
  ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
  console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
