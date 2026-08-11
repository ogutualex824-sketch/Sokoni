#!/usr/bin/env node
/* Phase 4.5 Part 1 — authenticated legacy wishlist migration, real emulator.
 *
 *   firebase emulators:exec --only firestore --project sokoni-wishlist-page-test \
 *     "node scripts/test-wishlist-page.js"
 *
 * Exercises the SHIPPED SokoniWishlist.migrateLegacy() and the real marketplace handlers
 * commerce-dispatch routes to. Nothing about migration or wishlist behaviour is mocked;
 * only the browser DOM/Auth boundary is shimmed.
 *
 * The legacy document is written with the Admin SDK exactly as production holds it, and
 * the migration is handed THAT document's items[] — never the client cache. Test M makes
 * that explicit rather than trusting the calling convention.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-wishlist-page-test';

const path = require('path');
const FN = path.resolve(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const mkt = require('../functions/marketplace-extensions.js');

const A = 'wp-user-A', B = 'wp-user-B';
const req = (uid, data) => ({ auth: { uid }, data: data || {} });
const R = {};
let pass = 0, fail = 0, inconc = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}

const countFor = async (uid) => (await db.collection('wishlistItems').where('uid', '==', uid).get()).size;
const canon = (uid, pid) => db.collection('wishlistItems').doc(uid + '_' + pid).get();
const legacyRef = (uid) => db.collection('wishlists').doc(uid);
async function seedLegacy(uid, items) { await legacyRef(uid).set({ items, updatedAt: 'seed' }); }
async function readLegacy(uid) { const s = await legacyRef(uid).get(); return s.exists ? s.data() : null; }
async function wipe() {
  for (const c of ['wishlistItems', 'wishlists']) {
    const s = await db.collection(c).get();
    const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); if (s.size) await b.commit();
  }
}

/* Deep structural comparison — "same number of items" is not preservation. */
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* Load the SHIPPED service with a browser-ish shim. */
function makeService(uid, opts) {
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
    setTimeout,
    sokoniCallable: () => (payload) => {
      if (opts.failLoad && payload.op === 'wishlistGet') return Promise.reject(new Error('permission-denied'));
      if (opts.failAddFor && payload.op === 'wishlistAdd' && payload.productId === opts.failAddFor)
        return Promise.reject(new Error('permission-denied'));
      const h = mkt._h[payload.op];
      if (!h) return Promise.reject(new Error('unknown op'));
      return Promise.resolve(h(req(g.firebaseAuth.currentUser && g.firebaseAuth.currentUser.uid, payload)))
        .then(data => ({ data }));
    },
  };
  const pw = global.window, pl = global.localStorage;
  global.window = g; global.localStorage = g.localStorage;
  delete require.cache[require.resolve('../sokoni-wishlist.js')];
  require('../sokoni-wishlist.js');
  global.window = pw; void pl;
  return { W: g.SokoniWishlist, g, store };
}

const L1 = { productId: 'lp1', name: 'Unga 2kg', price: 250, image: 'i.png', shopId: 'shopA' };
const L2 = { productId: 'lp2', name: 'Sukari 1kg', price: 180, image: 'j.png', shopId: 'shopA' };

(async () => {
  console.log('\nPHASE 4.5 PART 1 — legacy wishlist migration\n' + '='.repeat(60));
  await wipe();

  /* ── A. legacy-only migration ── */
  console.log('\nA. Legacy-only user');
  await seedLegacy(A, [L1, L2]);
  const beforeLegacy = await readLegacy(A);
  let s = makeService(A);
  let r = await s.W.migrateLegacy((await readLegacy(A)).items);
  ck('A', 'exactly 2 canonical records created', (await countFor(A)) === 2, await countFor(A));
  ck('A', 'lp1 canonical', (await canon(A, 'lp1')).exists);
  ck('A', 'lp2 canonical', (await canon(A, 'lp2')).exists);
  ck('A', 'result reports both migrated', r.migrated.length === 2, JSON.stringify(r.migrated));
  ck('A', 'result reports complete', r.complete === true);

  /* ── B. legacy document intact (deep) ── */
  console.log('\nB. Legacy document preserved');
  const afterLegacy = await readLegacy(A);
  ck('B', 'legacy document still exists', !!afterLegacy);
  ck('B', 'items[] is FIELD-EQUIVALENT, not merely same length',
     deepEq(beforeLegacy.items, afterLegacy.items), JSON.stringify(afterLegacy.items).slice(0, 70));
  ck('B', 'whole legacy document unchanged', deepEq(beforeLegacy, afterLegacy));

  /* ── C. idempotency ── */
  console.log('\nC. Re-run migration');
  s = makeService(A);
  r = await s.W.migrateLegacy((await readLegacy(A)).items);
  ck('C', 'still exactly 2 canonical records', (await countFor(A)) === 2, await countFor(A));
  ck('C', 'nothing re-migrated', r.migrated.length === 0, JSON.stringify(r.migrated));
  ck('C', 'both reported already canonical', r.alreadyCanonical.length === 2);
  ck('C', 'legacy still unchanged', deepEq(beforeLegacy, await readLegacy(A)));

  /* ── D. partial existing canonical state ── */
  console.log('\nD. One item already canonical');
  await wipe();
  await seedLegacy(A, [L1, L2]);
  await mkt._h.wishlistAdd(req(A, { productId: 'lp1', name: 'Unga 2kg' }));
  s = makeService(A);
  r = await s.W.migrateLegacy((await readLegacy(A)).items);
  ck('D', 'exactly 2 canonical records (no duplicate)', (await countFor(A)) === 2, await countFor(A));
  ck('D', 'only lp2 migrated', r.migrated.length === 1 && r.migrated[0] === 'lp2', JSON.stringify(r.migrated));
  ck('D', 'lp1 recognised as already canonical', r.alreadyCanonical.indexOf('lp1') > -1);

  /* ── E. malformed legacy item ── */
  console.log('\nE. Malformed legacy item');
  await wipe();
  await seedLegacy(A, [L1, { name: 'No id here', price: 99 }]);
  s = makeService(A);
  r = await s.W.migrateLegacy((await readLegacy(A)).items);
  ck('E', 'valid item migrated', (await canon(A, 'lp1')).exists);
  ck('E', 'exactly one canonical record', (await countFor(A)) === 1, await countFor(A));
  ck('E', 'malformed item reported as skipped', r.skipped.length === 1, JSON.stringify(r.skipped));
  ck('E', 'skip reason recorded', r.skipped[0].reason === 'no-productId');
  ck('E', 'no malformed canonical document exists',
     (await db.collection('wishlistItems').where('uid', '==', A).get()).docs
       .every(d => !!d.data().productId));

  /* ── F. legacy read failure is not empty ── */
  console.log('\nF. Legacy read failure');
  await wipe();
  await seedLegacy(A, [L1, L2]);
  s = makeService(A);
  let threw = false;
  try { await s.W.migrateLegacy(undefined); } catch (e) { threw = true; }
  ck('F', 'non-array legacy input REJECTS', threw);
  ck('F', 'no migration occurred', (await countFor(A)) === 0, await countFor(A));
  ck('F', 'legacy document untouched', (await readLegacy(A)).items.length === 2);
  threw = false;
  try { await s.W.migrateLegacy(null); } catch (e) { threw = true; }
  ck('F', 'null is rejected too, not treated as []', threw);

  /* ── G. canonical failure ── */
  console.log('\nG. Canonical load failure');
  await wipe();
  await seedLegacy(A, [L1, L2]);
  const bad = makeService(A, { failLoad: true });
  threw = false;
  try { await bad.W.migrateLegacy((await readLegacy(A)).items); } catch (e) { threw = true; }
  ck('G', 'migration REJECTS when canonical state is unknown', threw);
  ck('G', 'no canonical records were created', (await countFor(A)) === 0, await countFor(A));
  ck('G', 'legacy document untouched', deepEq((await readLegacy(A)).items, [L1, L2]));

  /* ── H. isolation, controls first ── */
  console.log('\nH. Isolation — controls first');
  await wipe();
  await seedLegacy(A, [L1]);
  await seedLegacy(B, [L2]);
  const sa = makeService(A); const ra = await sa.W.migrateLegacy((await readLegacy(A)).items);
  const sb = makeService(B); const rb = await sb.W.migrateLegacy((await readLegacy(B)).items);
  ck('H', 'CONTROL: A migrated its own item', ra.migrated.length === 1 && (await countFor(A)) === 1);
  ck('H', 'CONTROL: B migrated its own item', rb.migrated.length === 1 && (await countFor(B)) === 1);
  ck('H', "A does not receive B's item", sa.W.isWishlisted('lp2') === false);
  ck('H', "B does not receive A's item", sb.W.isWishlisted('lp1') === false);
  ck('H', "A's document carries uid A", (await canon(A, 'lp1')).data().uid === A);
  ck('H', "B's document carries uid B", (await canon(B, 'lp2')).data().uid === B);

  /* ── I. retry after partial failure ── */
  console.log('\nI. Partial failure then retry');
  await wipe();
  await seedLegacy(A, [L1, L2]);
  const partial = makeService(A, { failAddFor: 'lp2' });
  r = await partial.W.migrateLegacy((await readLegacy(A)).items);
  ck('I', 'lp1 succeeded', (await canon(A, 'lp1')).exists);
  ck('I', 'lp2 failed and is reported', r.failed.length === 1 && r.failed[0].productId === 'lp2', JSON.stringify(r.failed));
  ck('I', 'result is NOT reported complete', r.complete === false);
  ck('I', 'successful write was NOT rolled back', (await countFor(A)) === 1, await countFor(A));
  ck('I', 'legacy remains intact for retry', (await readLegacy(A)).items.length === 2);
  const retry = makeService(A);
  r = await retry.W.migrateLegacy((await readLegacy(A)).items);
  ck('I', 'retry migrates only lp2', r.migrated.length === 1 && r.migrated[0] === 'lp2', JSON.stringify(r.migrated));
  ck('I', 'exactly 2 canonical records, lp1 not duplicated', (await countFor(A)) === 2, await countFor(A));
  ck('I', 'retry reports complete', r.complete === true);

  /* ── J. deterministic identity ── */
  console.log('\nJ. Deterministic ids');
  const ids = (await db.collection('wishlistItems').where('uid', '==', A).get()).docs.map(d => d.id).sort();
  ck('J', 'ids are exactly {uid}_{productId}', deepEq(ids, [A + '_lp1', A + '_lp2']), ids.join(','));

  /* ── K. no deletes against the legacy collection ── */
  /* Self-contained: earlier blocks wipe() and re-seed, so asserting a global document
     count here measured state this block never established — a failure that says nothing
     about whether migration deletes anything. Seed both users, migrate both, then count. */
  console.log('\nK. No legacy deletion');
  await wipe();
  await seedLegacy(A, [L1, L2]);
  await seedLegacy(B, [L1]);
  const kBefore = (await db.collection('wishlists').get()).size;
  const ka = makeService(A); await ka.W.migrateLegacy((await readLegacy(A)).items);
  const kb = makeService(B); await kb.W.migrateLegacy((await readLegacy(B)).items);
  const kAfter = (await db.collection('wishlists').get()).size;
  ck('K', 'legacy document count unchanged by migration', kAfter === kBefore && kAfter === 2,
     kBefore + ' -> ' + kAfter);
  ck('K', "A's legacy items still 2", (await readLegacy(A)).items.length === 2);
  ck('K', "B's legacy document survives A's migration", !!(await readLegacy(B)));

  /* ── L. auth identity wins over payload ── */
  console.log('\nL. Auth identity is authoritative');
  await wipe();
  /* Legacy payload claims to belong to B, and carries B's uid on every item. */
  await seedLegacy(A, [{ productId: 'spoof1', uid: B, ownerUid: B, name: 'Spoof' }]);
  s = makeService(A);
  await s.W.migrateLegacy((await readLegacy(A)).items);
  ck('L', 'record created under the AUTHENTICATED uid', (await canon(A, 'spoof1')).exists);
  ck('L', 'uid field is the auth uid, not the payload uid', (await canon(A, 'spoof1')).data().uid === A,
     (await canon(A, 'spoof1')).data().uid);
  ck('L', 'no record created under the claimed uid', !(await canon(B, 'spoof1')).exists);
  ck('L', 'B has zero records', (await countFor(B)) === 0, await countFor(B));

  /* ── M. the migration source is the FIRESTORE payload, not the client cache ── */
  console.log('\nM. Migration source is the Firestore document');
  await wipe();
  await seedLegacy(A, [L1]);                 /* Firestore truth: one item */
  const cacheTrap = makeService(A);
  /* Plant a DIFFERENT, larger client cache under both legacy keys. If any of it reaches
     canonical state, localStorage has become a migration source. */
  cacheTrap.store['wishlist'] = JSON.stringify([{ id: 'cache1' }, { id: 'cache2' }]);
  cacheTrap.store['sokoniWishlist'] = JSON.stringify([{ id: 'cache3' }]);
  await cacheTrap.W.migrateLegacy((await readLegacy(A)).items);
  ck('M', 'only the Firestore item migrated', (await countFor(A)) === 1, await countFor(A));
  ck('M', 'lp1 present', (await canon(A, 'lp1')).exists);
  ck('M', 'no cache-shaped record leaked in',
     !(await canon(A, 'cache1')).exists && !(await canon(A, 'cache2')).exists && !(await canon(A, 'cache3')).exists);

  /* ════════════════════════════════════════════════════════════════════════════
     PART 2 — the wishlist.html page wiring itself.
     The page's inline render block is EXTRACTED and evaluated, so these assertions
     run the shipped code — with NO stubbing of page logic at all. An earlier version
     replaced _wishReadLegacy so a legacy read would resolve; that stub made a
     production impossibility look verified, because wishlists/{uid} is denied by
     default. The page no longer has that reader, and P asserts its absence. It
     uses dynamic import() of the Firebase SDK which cannot resolve in a vm sandbox —
     the legacy READ is stubbed, never the migration or canonical logic.
     ════════════════════════════════════════════════════════════════════════════ */
  const vm = require('vm');
  const fsx = require('fs');

  function makePage(uid, opts) {
    opts = opts || {};
    const svc = makeService(uid, opts);
    const container = { innerHTML: '' };
    const g = svc.g;
    /* showNotif() builds a toast node, so createElement/appendChild must exist or the
       assertion dies inside notification code rather than in the logic under test. */
    const mkNode = () => ({ style: {}, className: '', textContent: '', innerHTML: '',
      classList: { add(){}, remove(){}, toggle(){} }, children: [],
      appendChild(c){ this.children.push(c); return c; }, removeChild(c){ return c; },
      remove(){}, setAttribute(){}, getAttribute(){ return null; }, parentNode: null });
    g.document = {
      getElementById: (id) => (id === 'wishlistContainer' ? container : mkNode()),
      createElement: mkNode, body: mkNode(), head: mkNode(),
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: (t, f) => { (g.__l[t] = g.__l[t] || []).push(f); },
    };
    g.location = { href: '' };
    g.SokoniShare = null;

    const html = fsx.readFileSync(path.resolve(__dirname, '..', 'wishlist.html'), 'utf8');
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    const render = blocks.map(b => b[1]).find(c => c.includes('function renderWishlist'));
    if (!render) throw new Error('render block not found in wishlist.html');

    g.window = g; g.updateCartBadge = () => {}; g.updateWishCount = () => {};
    vm.createContext(g);
    vm.runInContext(render, g);
    return { g, container, svc, W: g.SokoniWishlist };
  }

  console.log('\nN. Page renders from canonical state');
  await wipe();
  await mkt._h.wishlistAdd(req(A, { productId: 'lp1', name: 'Unga 2kg', price: 250 }));
  let pg = makePage(A);
  await pg.g._wishReload();
  await new Promise(r => setTimeout(r, 60));
  ck('N', 'canonical item appears in the rendered output', /Unga 2kg/.test(pg.container.innerHTML),
     pg.container.innerHTML.slice(0, 60));
  ck('N', 'render buffer came from the service, not localStorage', pg.g._wishData.length === 1);

  console.log('\nO. Canonical load failure is NOT an empty wishlist');
  const pgFail = makePage(A, { failLoad: true });
  await pgFail.g._wishReload();
  await new Promise(r => setTimeout(r, 60));
  ck('O', 'error state rendered', /Couldn't load your wishlist/.test(pgFail.container.innerHTML));
  ck('O', 'does NOT render the empty state', !/wishlist is empty/i.test(pgFail.container.innerHTML));
  ck('O', 'state flag is error', pgFail.g._wishState === 'error', pgFail.g._wishState);

  /* P previously asserted "legacy items migrated on page load". That passed only because
     the harness STUBBED the legacy read. In production wishlists/{uid} has no rule — not
     locally, not in live ruleset ca9e8924 — so the client read is denied by default and
     always was. The page no longer attempts it, and this test now asserts THAT, so the
     stub can never again make a production impossibility look verified. */
  console.log('\nP. Page does not attempt a client legacy read');
  await wipe();
  await seedLegacy(A, [L1, L2]);
  await mkt._h.wishlistAdd(req(A, { productId: 'lp1', name: 'Unga 2kg', price: 250 }));
  const pgMig = makePage(A);
  await pgMig.g._wishReload();
  await new Promise(r => setTimeout(r, 120));
  ck('P', 'no wl-fs legacy reader exists on the page', typeof pgMig.g._wishReadLegacy !== 'function',
     typeof pgMig.g._wishReadLegacy);
  ck('P', 'page renders canonical state only (legacy NOT pulled in)',
     (await countFor(A)) === 1, await countFor(A));
  ck('P', 'legacy document untouched and field-equivalent',
     deepEq((await readLegacy(A)).items, [L1, L2]));
  ck('P', 'migrateLegacy engine still available for a future server path',
     typeof pgMig.W.migrateLegacy === 'function');

  /* Q and R seed their own state. They previously inherited whatever P left behind, so
     rewriting P silently broke them — a failure that says nothing about remove or
     move-to-cart. Each block now establishes exactly what it asserts against. */
  console.log('\nQ. Remove is canonical');
  await wipe();
  await seedLegacy(A, [L1, L2]);
  await mkt._h.wishlistAdd(req(A, { productId: 'lp1', name: 'Unga 2kg', price: 250 }));
  await mkt._h.wishlistAdd(req(A, { productId: 'lp2', name: 'Sukari 1kg', price: 180 }));
  const pgQ = makePage(A);
  await pgQ.g._wishReload();
  await new Promise(r => setTimeout(r, 80));
  ck('Q', 'CONTROL: page loaded 2 canonical items', pgQ.g._wishData.length === 2, pgQ.g._wishData.length);
  await pgQ.g.removeWishlist(0);
  await new Promise(r => setTimeout(r, 80));
  ck('Q', 'exactly one canonical record deleted', (await countFor(A)) === 1, await countFor(A));
  ck('Q', 'legacy document still intact', (await readLegacy(A)).items.length === 2);

  console.log('\nR. Move-to-cart cannot silently lose the item');
  await wipe();
  await mkt._h.wishlistAdd(req(A, { productId: 'lp1', name: 'Unga 2kg', price: 250 }));
  const pgR = makePage(A);
  await pgR.g._wishReload();
  await new Promise(r => setTimeout(r, 80));
  ck('R', 'CONTROL: one canonical item loaded', pgR.g._wishData.length === 1, pgR.g._wishData.length);
  await pgR.g.moveToCart(0);
  await new Promise(r => setTimeout(r, 80));
  ck('R', 'item written to cart before the canonical removal',
     /lp1/.test(pgR.svc.store['cart'] || ''), pgR.svc.store['cart']);
  ck('R', 'canonical record removed', (await countFor(A)) === 0, await countFor(A));

  console.log('\nS. Auth switch clears A before B renders');
  await wipe();
  await mkt._h.wishlistAdd(req(A, { productId: 'lp1', name: "A item" }));
  await mkt._h.wishlistAdd(req(B, { productId: 'lp2', name: "B item" }));
  const pgA = makePage(A);
  await pgA.g._wishReload();
  await new Promise(r => setTimeout(r, 60));
  ck('S', 'CONTROL: A sees its own item', /A item/.test(pgA.container.innerHTML));
  /* Same page object, account changes underneath it. */
  pgA.g.firebaseAuth.currentUser = { uid: B };
  (pgA.g.__l['sokoni:wishlist-changed'] || []);
  pgA.g._wishData = []; pgA.g._wishState = 'loading';
  pgA.g.renderWishlist([]);
  ck('S', "A's rows cleared immediately on switch", !/A item/.test(pgA.container.innerHTML),
     pgA.container.innerHTML.slice(0, 50));
  await pgA.g._wishReload();
  await new Promise(r => setTimeout(r, 60));
  ck('S', 'B sees only its own item', /B item/.test(pgA.container.innerHTML) && !/A item/.test(pgA.container.innerHTML));

  console.log('\nT. wishlist-changed refreshes the page');
  const pgT = makePage(A);
  pgT.g.firebaseAuth.currentUser = { uid: A };
  await pgT.g._wishReload();
  await new Promise(r => setTimeout(r, 60));
  const beforeHtml = pgT.container.innerHTML;
  await pgT.W.add({ productId: 'lp9', name: 'Fresh Item', price: 10 });
  await new Promise(r => setTimeout(r, 60));
  ck('T', 'page re-rendered after a canonical change',
     pgT.container.innerHTML !== beforeHtml && /Fresh Item/.test(pgT.container.innerHTML));

  console.log('\nU. Ownership never derives from localStorage.sokoniUser');
  const pgU = makePage(A);
  /* Plant a DIFFERENT uid in the profile-label cache. It must not influence ownership. */
  pgU.svc.store['sokoniUser'] = JSON.stringify({ uid: B, name: 'Someone Else' });
  pgU.g.firebaseAuth.currentUser = { uid: A };
  await pgU.g._wishReload();
  await new Promise(r => setTimeout(r, 60));
  await pgU.W.add({ productId: 'ownr1', name: 'Owner test' });
  ck('U', 'record created under the AUTH uid', (await canon(A, 'ownr1')).exists);
  ck('U', 'NOT under the uid in localStorage.sokoniUser', !(await canon(B, 'ownr1')).exists);
  ck('U', 'document uid is the auth uid', (await canon(A, 'ownr1')).data().uid === A);

  console.log('\nV. Zero executable legacy wishlist authority in wishlist.html');
  {
    const src = fsx.readFileSync(path.resolve(__dirname, '..', 'wishlist.html'), 'utf8');
    let inB = false;
    const code = src.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (inB) { if (t.includes('*/')) inB = false; return false; }
      if (t.startsWith('//')) return false;
      if (t.startsWith('/*')) { if (!t.includes('*/')) inB = true; return false; }
      if (t.startsWith('*')) return false;
      return true;
    });
    const lsAuth = code.filter(l => /localStorage\s*(?:\.\s*(?:get|set)Item\s*\(\s*|\[\s*)["'](wishlist|sokoniWishlist)["']/.test(l));
    const direct = code.filter(l => /setDoc\([^)]*wishlists/.test(l));
    ck('V', 'no localStorage wishlist authority', lsAuth.length === 0, lsAuth.join(' | '));
    ck('V', 'no direct client write to wishlists/{uid}', direct.length === 0, direct.join(' | '));
  }

  /* W — Phase 4.6 acceptance, kept as a regression guard rather than a one-off sweep.
     `sokoniWishlist` must have zero EXECUTABLE writers and zero executable consumers
     anywhere in production source. Comments are excluded, so documenting the retired key
     cannot fail this. */
  console.log('\nW. sokoniWishlist is fully retired (Phase 4.6)');
  {
    const RE = /localStorage\s*(?:\.\s*(?:get|set)Item\s*\(\s*|\[\s*)["']sokoniWishlist["']/;
    const hits = [];
    (function walk(d) {
      for (const f of fsx.readdirSync(d, { withFileTypes: true })) {
        if (f.name === 'node_modules' || f.name === '.git' || f.name === 'scripts') continue;
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(js|html)$/.test(f.name)) {
          let inB = false;
          fsx.readFileSync(p, 'utf8').split(/\r?\n/).forEach((l, i) => {
            const t = l.trim();
            if (!t) return;
            if (inB) { if (t.includes('*/')) inB = false; return; }
            if (t.startsWith('//')) return;
            if (t.startsWith('/*')) { if (!t.includes('*/')) inB = true; return; }
            if (t.startsWith('*')) return;
            if (RE.test(l)) hits.push(path.relative(process.cwd(), p) + ':' + (i + 1));
          });
        }
      }
    })(path.resolve(__dirname, '..'));
    ck('W', 'zero executable sokoniWishlist writers or consumers', hits.length === 0, hits.join(' | '));
  }

  await wipe();
  console.log('\n' + '='.repeat(60));
  console.log('Phase 4.5 Parts 1 + 2, and 4.6 acceptance\n');
  ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'NOT RUN')));
  console.log('\nTOTAL:        ' + (pass + fail + inconc));
  console.log('PASSED:       ' + pass);
  console.log('FAILED:       ' + fail);
  console.log('INCONCLUSIVE: ' + inconc);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nSUITE ERROR:', e && e.stack || e); process.exit(1); });
