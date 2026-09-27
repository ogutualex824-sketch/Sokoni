/* test-shop-follow.js — MiniShop follows on ONE authority (functions/reputation.js, type 'shop'), the legacy
 * stores migrated DRY-RUN-FIRST, the follower count read from that authority everywhere, and the REAL
 * storefront (minishop.html) + seller page (seller-public.html) following through it in Chromium.
 * Transactional fake Firestore + real modules. No network, no production.
 *
 * PROVES
 *   authority   follow / duplicate / unfollow / repeated unfollow · count on shops/{id} (followV) · never
 *               negative · self-follow refused · a suspended shop cannot be followed · by owner uid resolves
 *               to the canonical shop · a client-sent uid is ignored · shops have no reviews / share handle
 *   counts      getMinishopPublic: unknown → null (never an invented 0), then the authority's number, and
 *               the shop doc never leaks a stale followerCount · getMinishopAnalytics: the same number
 *   migration   DRY RUN writes nothing · shopFollowers → follows (via server) · client shop follows adopted ·
 *               seller-by-NAME follows mapped only when ONE shop has that name · ambiguous / orphan / self
 *               reported · re-run is a no-op · recount = number of relationships
 *   browser     minishop.html: Follow → Following, count from the server; refresh keeps "Following";
 *               logged-out → sign-in · seller-public.html (?id=<seller uid>): follows the SHOP by account;
 *               a name-only link offers no Follow · no horizontal scroll at 360 / 1280
 *
 *   node scripts/test-shop-follow.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-shop-follow';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const REP = require(Path.join(FN, 'reputation.js'));
const MS = require(Path.join(FN, 'minishop.js'));
const MIG = require(Path.join(ROOT, 'scripts', 'migrate-reputation.js'));
const { makePageHarness, mockHttp } = require('./lib/page-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid) => ({ auth: uid ? { uid, token: {} } : null, rawRequest: { headers: {} } });
const h = (op, uid, data) => REP._h[op]({ ...who(uid), data: data || {} });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
async function publicShop(handle) {
  const { req, res, result } = mockHttp('GET', { handle });
  await MS.getMinishopPublic(req, res);
  const r = result();
  return { status: r.status, body: r.body ? JSON.parse(r.body) : null };
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

(async () => {
  for (const u of ['b1', 'b2', 'b3', 'sellerA', 'sellerB']) await db.doc('users/' + u).set({ displayName: u });
  await db.doc('shops/sellerA').set({ sellerUid: 'sellerA', name: 'Mama Mboga Fresh', status: 'active', followerCount: 999 });   /* legacy stale number */
  await db.doc('shops/legacyShop1').set({ sellerUid: 'sellerB', name: 'Kiondo Crafts', status: 'active' });
  await db.doc('shops/susp').set({ sellerUid: 'sellerS', name: 'Gone', status: 'suspended' });
  await db.doc('shopHandles/mamamboga').set({ shopId: 'sellerA', uid: 'sellerA' });
  await db.doc('minishopConfig/sellerA').set({ handle: 'mamamboga', shopId: 'sellerA', followerCount: 42 });            /* the retired counter */
  await db.doc('products/p1').set({ shopId: 'sellerA', sellerUid: 'sellerA', name: 'Sukuma', price: 5000, status: 'active' });

  /* ═══ authority ═══ */
  say('\n── authority ──');
  let pub = await publicShop('mamamboga');
  ck('before any server follow the public count is UNKNOWN (null) — not the stale 999 nor the retired 42', pub.status === 200 && pub.body.followerCount === null && pub.body.config.followerCount === null && pub.body.shop.followerCount === undefined, { f: pub.body.followerCount, c: pub.body.config && pub.body.config.followerCount, s: pub.body.shop && pub.body.shop.followerCount });
  const f1 = await h('repFollow', 'b1', { type: 'shop', id: 'sellerA' });
  ck('follow → following, count 1 (the base counts follow records, not the stale number)', f1.following && f1.followerCount === 1 && (await get('shops/sellerA')).followV === 1);
  ck('duplicate follow is idempotent', (await h('repFollow', 'b1', { type: 'shop', id: 'sellerA' })).already === true && (await get('shops/sellerA')).followerCount === 1);
  await h('repFollow', 'b2', { type: 'shop', id: 'sellerA' });
  ck('a second follower → 2', (await get('shops/sellerA')).followerCount === 2);
  const u1 = await h('repUnfollow', 'b2', { type: 'shop', id: 'sellerA' }); const u2 = await h('repUnfollow', 'b2', { type: 'shop', id: 'sellerA' });
  ck('unfollow once, a repeat is a no-op, never negative', u1.followerCount === 1 && u2.already === true && (await get('shops/sellerA')).followerCount === 1);
  ck('the owner cannot follow their own shop', (await code(h('repFollow', 'sellerA', { type: 'shop', id: 'sellerA' }))) === 'failed-precondition');
  ck('a suspended shop cannot be followed', (await code(h('repFollow', 'b1', { type: 'shop', id: 'susp' }))) === 'failed-precondition');
  const byUid = await h('repFollow', 'b3', { type: 'shop', id: 'sellerB' });
  ck('following by the OWNER uid resolves to the one canonical shop doc (legacyShop1)', byUid.following && !!(await get('follows/b3--shop--legacyShop1')) && !(await get('follows/b3--shop--sellerB')) && (await get('shops/legacyShop1')).followerCount === 1);
  ck('…and follow state / unfollow by that uid address the same record', (await h('repFollowState', 'b3', { items: [{ type: 'shop', id: 'sellerB' }] })).following['shop:sellerB'] === true && (await h('repUnfollow', 'b3', { type: 'shop', id: 'sellerB' }).catch((e) => ({ err: e.code }))).followerCount === 0);
  await h('repFollow', 'b2', { type: 'shop', id: 'sellerA', uid: 'b9' });
  ck('a client-sent uid is ignored (the follow belongs to the caller)', !(await get('follows/b9--shop--sellerA')) && !!(await get('follows/b2--shop--sellerA')));
  ck('shops carry no provider reviews and no second share-handle system', (await h('repReviews', null, { type: 'shop', id: 'sellerA' })).reviews.length === 0 && (await code(h('repShareLink', null, { type: 'shop', id: 'sellerA' }))) === 'failed-precondition');
  pub = await publicShop('mamamboga');
  ck('getMinishopPublic now shows the AUTHORITY\'s count (2), in every place it is returned', pub.body.followerCount === 2 && pub.body.config.followerCount === 2 && pub.body.shop.followerCount === 2 && pub.body.shop.followV === undefined, pub.body.followerCount);
  const an = await MS.getMinishopAnalytics.run({ ...who('sellerA'), data: { shopId: 'sellerA' } });
  ck('getMinishopAnalytics (owner) reports the same number', an.followerCount === 2, an.followerCount);
  const fs0 = await MS.followShop.run({ ...who('b3'), data: { shopId: 'sellerA', follow: true } });
  ck('the retired followShop callable DELEGATES (3 followers, no shopFollowers doc, no minishopConfig counter change)', fs0.following && fs0.followerCount === 3 && !db._dump('shopFollowers/').length && (await get('minishopConfig/sellerA')).followerCount === 42);

  /* ═══ migration ═══ */
  say('\n── migration (dry run → apply) ──');
  await db.doc('shops/dupA').set({ sellerUid: 'sd1', name: 'Same Name Shop', status: 'active' });
  await db.doc('shops/dupB').set({ sellerUid: 'sd2', name: 'Same Name Shop', status: 'active' });
  await db.doc('shopFollowers/legacyShop1_m1').set({ shopId: 'legacyShop1', uid: 'm1' });             /* legacy relationship */
  await db.doc('shopFollowers/legacyShop1_sellerB').set({ shopId: 'legacyShop1', uid: 'sellerB' });   /* owner self-follow */
  await db.doc('shopFollowers/ghost_m1').set({ shopId: 'ghost', uid: 'm1' });                          /* shop gone */
  await db.doc('follows/m2--shop--legacyShop1').set({ uid: 'm2', type: 'shop', entityId: 'legacyShop1', entityName: 'Kiondo Crafts' });   /* client-written */
  await db.doc('follows/m3--seller--Kiondo_Crafts').set({ uid: 'm3', type: 'seller', entityId: 'Kiondo Crafts', entityName: 'Kiondo Crafts' });
  await db.doc('follows/m4--seller--Same_Name_Shop').set({ uid: 'm4', type: 'seller', entityId: 'Same Name Shop' });
  await db.doc('follows/m5--seller--Nobody').set({ uid: 'm5', type: 'seller', entityId: 'Nobody' });
  const before = JSON.stringify(db._dump('follows/'));
  const dry = await MIG.migrateShopFollows(db, { apply: false });
  ck('DRY RUN: counts reported, NOTHING written', JSON.stringify(db._dump('follows/')) === before && dry.fromShopFollowers === 1 && dry.adoptedClientShopFollows === 1 && dry.fromSellerNames === 1, dry);
  ck('…ambiguous name, orphan shop / name and the owner self-follow are REPORTED, never guessed', dry.ambiguous.length === 1 && dry.orphan.length === 2 && dry.self.length === 1, { a: dry.ambiguous, o: dry.orphan, s: dry.self });
  await MIG.migrateShopFollows(db, { apply: true });
  ck('--apply: the legacy relationship became a server follow; its old doc is stamped', (await get('follows/m1--shop--legacyShop1') || {}).via === 'server' && !!(await get('shopFollowers/legacyShop1_m1')).migratedTo);
  ck('--apply: the client-written shop follow is ADOPTED in place', (await get('follows/m2--shop--legacyShop1')).via === 'server');
  ck('--apply: the by-NAME seller follow became an ACCOUNT follow of the one shop', (await get('follows/m3--shop--legacyShop1') || {}).via === 'server' && !!(await get('follows/m3--seller--Kiondo_Crafts')).migratedTo);
  ck('…nothing for the ambiguous / orphan / self cases', !(await get('follows/m4--shop--dupA')) && !(await get('follows/m4--shop--dupB')) && !(await get('follows/sellerB--shop--legacyShop1')));
  const again = await MIG.migrateShopFollows(db, { apply: true });
  ck('a re-run is a no-op', again.fromShopFollowers === 0 && again.fromSellerNames === 0 && again.alreadyMigrated === 2, again);
  await MIG.recountAll(db, REP, { apply: true });
  ck('recount: legacyShop1 = its relationships (m1, m2, m3) = 3; sellerA = 3', (await get('shops/legacyShop1')).followerCount === 3 && (await get('shops/sellerA')).followerCount === 3 && (await get('shops/legacyShop1')).repV === undefined, [(await get('shops/legacyShop1')).followerCount, (await get('shops/sellerA')).followerCount]);

  /* ═══ browser ═══ */
  say('\n── browser: minishop.html + seller-public.html ──');
  const HAR = makePageHarness({ db, root: ROOT, callables: { bookingDispatch: REP._h }, http: { getMinishopPublic: MS.getMinishopPublic, trackMinishopView: (req, res) => res.status(204).end() } });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    const L = await HAR.page(browser, { viewport: { width: 360, height: 780 } });
    await L.goto(HAR.BASE + '/minishop.html?handle=mamamboga');
    await L.waitForFunction(() => /Mama Mboga Fresh/.test(document.body.innerText) && document.getElementById('msFollowerCount') && document.getElementById('msFollowerCount').textContent.trim() !== '', null, { timeout: 10000 }).catch(() => {});
    ck('logged-out storefront shows the AUTHORITY count (3)', (await L.evaluate(() => (document.getElementById('msFollowerCount') || {}).textContent || '')).trim() === '3', await L.evaluate(() => (document.getElementById('msFollowerCount') || {}).textContent));
    ck('no horizontal scroll at 360 (storefront)', await noOverflow(L));
    await L.evaluate(() => document.getElementById('msFollowBtn') && document.getElementById('msFollowBtn').click());
    await L.waitForURL(/login/, { timeout: 5000 }).catch(() => {});
    ck('logged-out Follow → sign-in (nothing written)', /\/login(\.html)?\?next=/.test(L.url()) && db._dump('follows/').filter((f) => f.uid === null || f.uid === undefined).length === 0, L.url());

    const B = await HAR.page(browser, { user: { uid: 'n1', email: 'n1@x.co', emailVerified: true }, viewport: { width: 1280, height: 900 } });
    await B.goto(HAR.BASE + '/minishop.html?handle=mamamboga');
    await B.waitForSelector('#msFollowBtn', { timeout: 10000 }).catch(() => {});
    await B.waitForTimeout(800);
    await B.click('#msFollowBtn');
    await B.waitForFunction(() => (document.getElementById('msFollowerCount') || {}).textContent === '4', null, { timeout: 6000 }).catch(() => {});
    ck('signed-in Follow → the SERVER writes the follow and the page shows the returned count (4)', !!(await get('follows/n1--shop--sellerA')) && (await get('follows/n1--shop--sellerA')).via === 'server' && (await B.evaluate(() => document.getElementById('msFollowerCount').textContent)) === '4');
    await B.reload(); await B.waitForTimeout(1500);
    ck('a refresh keeps "Following" (state from the authority, not a race with shopFollowers)', /Following/.test(await B.evaluate(() => document.getElementById('msFollowBtn').textContent)), await B.evaluate(() => document.getElementById('msFollowBtn').textContent));
    ck('no horizontal scroll at 1280 (storefront)', await noOverflow(B));
    ck('no page errors on the storefront', B.__errors.length === 0 && L.__errors.length === 0, B.__errors.concat(L.__errors).slice(0, 2));

    const SP = await HAR.page(browser, { user: { uid: 'n2', email: 'n2@x.co', emailVerified: true }, viewport: { width: 360, height: 780 } });
    await SP.goto(HAR.BASE + '/seller-public.html?id=sellerB');
    await SP.waitForFunction(() => window.SokoniDB && document.getElementById('spFollowBtn'), null, { timeout: 10000 }).catch(() => {});
    await SP.waitForTimeout(800);
    await SP.evaluate(() => window.toggleFollow && window.toggleFollow());
    await SP.waitForTimeout(1200);
    ck('seller-public.html follows the SHOP by the seller\'s ACCOUNT (resolves to legacyShop1), never by display name', !!(await get('follows/n2--shop--legacyShop1')) && !db._dump('follows/').some((f) => f.uid === 'n2' && f.type === 'seller'), db._dump('follows/').filter((f) => f.uid === 'n2'));
    ck('…and shows the authority\'s count (4)', /^4\b/.test((await SP.evaluate(() => document.getElementById('spFollowerCount').textContent)).trim()), await SP.evaluate(() => document.getElementById('spFollowerCount').textContent));
    ck('no horizontal scroll at 360 (seller page)', await noOverflow(SP));
    const SN = await HAR.page(browser, { user: { uid: 'n3', email: 'n3@x.co', emailVerified: true }, viewport: { width: 1280, height: 900 } });
    await SN.goto(HAR.BASE + '/seller-public.html?seller=' + encodeURIComponent('Kiondo Crafts'));
    await SN.waitForTimeout(2500);
    ck('a NAME-only seller link offers no Follow (a name is not an identity)', await SN.evaluate(() => { const b = document.getElementById('spFollowBtn'); return !b || b.hidden || getComputedStyle(b).display === 'none'; }));
  } finally { await browser.close(); HAR.stop(); }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
