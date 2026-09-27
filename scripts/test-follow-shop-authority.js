#!/usr/bin/env node
/* Shop follows — ONE authority (CHANGELOG 211; was Store Stage 1B's followShop/shopFollowers).
 *
 *   node scripts/test-follow-shop-authority.js
 *
 * THE MODEL BEING ASSERTED
 *
 *     follows/{uid}--shop--{shopId}   the relationship — written ONLY by functions/reputation.js
 *              |                      (repFollow / repUnfollow, type 'shop'); uid from auth
 *     shops/{shopId}.followerCount    DERIVED, maintained in the same transaction (followV marks it)
 *
 * `followShop` (functions/minishop.js) was a SECOND authority — shopFollowers/{shopId}_{uid} plus a
 * counter in minishopConfig — beside the follows docs the storefront actually wrote. It now delegates.
 * Every property Stage 1B proved is kept:
 *   A  the shop must EXIST before anything is written; nothing is conjured (no config doc, no shop)
 *   C  one fact, one derived number: duplicates never inflate, unfollows never go negative, cycles land exact
 *   D  the client cannot desynchronise truth: no client write to a shop follow or to shopFollowers
 *   E  following never provisions anything
 *   F  the shipped source delegates — no second writer is left
 * ONE deliberate policy change: an owner may no longer follow their own shop (it inflated their own count;
 * the reputation authority refuses self-follows for every entity).
 *
 * FIXTURE: SHOP_B and SHOP_C both EXIST and belong to different sellers, so "denied" can never be confused
 * with "shop missing", and following someone else's shop — which is legitimate — is exercised.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-follow-shop';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B   = 'SHOP_B_shop_91c';
const SHOP_C   = 'SHOP_C_shop_42x';
const BUYER    = 'BUYER_uid_11';

let F, db;
const stub = (m, exp) => { const p = m.startsWith('./') ? path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
function freshDb() {
  F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
  db = F.db;
}
freshDb();
const ADMIN = { apps: [{}], initializeApp() {}, app: () => ({}),
  firestore: Object.assign(() => db, { get FieldValue() { return F.FieldValue; }, get Timestamp() { return F.Timestamp; }, get FieldPath() { return F.FieldPath; } }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin', ADMIN);
stub('firebase-admin/firestore', { getFirestore: () => db, get FieldValue() { return F.FieldValue; }, get Timestamp() { return F.Timestamp; }, get FieldPath() { return F.FieldPath; } });
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });
const quiet = console.log; console.info = console.warn = console.debug = () => {};

const MS = require(path.join(FN, 'minishop.js'));
const followShop = MS.followShop && (MS.followShop.run || MS.followShop);
const call = (uid, data) => followShop({ auth: uid ? { uid, token: {} } : null, data, rawRequest: { headers: {} } });
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };
const all = async (col) => db._dump(col + '/');
const count = async (shopId) => ((await db.doc('shops/' + shopId).get()).data() || {}).followerCount;
const rel = async (shopId, uid) => (await db.doc('follows/' + uid + '--shop--' + shopId.replace(/[^a-zA-Z0-9]/g, '_')).get()).exists;
async function reset() {
  freshDb();
  await db.doc('shops/' + SHOP_B).set({ sellerUid: SELLER_A, name: 'B Shop' });
  await db.doc('shops/' + SHOP_C).set({ sellerUid: 'OTHER_SELLER', name: 'C Shop' });
  await db.doc('minishopConfig/' + SHOP_B).set({ handle: 'bshop', shopId: SHOP_B });
}
const snapshot = async () => JSON.stringify(db._dump(''));

(async () => {
if (typeof followShop !== 'function') { console.error('followShop could not be captured — the suite cannot run.'); process.exit(1); }

/* ═══ A — the shop must exist before anything is written ═══ */
quiet('\nPART A — no shop, no write\n');
{
  await reset();
  const ok = await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('A1  a buyer may follow a shop that EXISTS', ok && ok.following === true);

  await reset();
  const okC = await call(SELLER_A, { shopId: SHOP_C, follow: true });
  ck('A2  SELLER_A may follow SHOP_C, because SHOP_C exists (following is not ownership)', okC && okC.following === true);

  await reset();
  const before = await snapshot();
  const missing = await err(call(BUYER, { shopId: 'shop_that_does_not_exist', follow: true }));
  ck('A3  a NONEXISTENT shop is refused', missing && missing.code === 'not-found', missing && missing.code);
  ck('A4  ...and NOTHING was written — no config, no shop, no follow conjured', (await snapshot()) === before);

  await reset();
  const b2 = await snapshot();
  const arbitrary = await err(call(BUYER, { shopId: '../../etc/passwd', follow: true }));
  ck('A5  an arbitrary shop id string is refused', arbitrary && ['not-found', 'invalid-argument'].includes(arbitrary.code), arbitrary && arbitrary.code);
  ck('A6  ...and creates no document of any kind', (await snapshot()) === b2);

  await reset();
  const b3 = await snapshot();
  const anon = await err(call(null, { shopId: SHOP_B, follow: true }));
  ck('A7  an unauthenticated caller is DENIED', anon && anon.code === 'unauthenticated');
  ck('A8  ...and writes nothing', (await snapshot()) === b3);

  const noShopId = await err(call(BUYER, { follow: true }));
  ck('A9  a missing shopId is invalid-argument', noShopId && noShopId.code === 'invalid-argument');
  const noFollow = await err(call(BUYER, { shopId: SHOP_B }));
  ck('A10 a missing follow flag is invalid-argument', noFollow && noFollow.code === 'invalid-argument');
}

/* ═══ B — policy ═══ */
quiet('\nPART B — self-follow policy\n');
{
  await reset();
  const own = await err(call(SELLER_A, { shopId: SHOP_B, follow: true }));
  ck('B1  an owner can NOT follow their own shop (it inflated their own count — CHANGELOG 211)', own && own.code === 'failed-precondition', own && own.code);
  ck('B2  ...and no relationship was recorded', !(await rel(SHOP_B, SELLER_A)) && (await count(SHOP_B)) === undefined);
}

/* ═══ C — the relationship is the authority, the count is derived ═══ */
quiet('\nPART C — one fact, one derived number\n');
{
  await reset();
  const f1 = await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('C1  a follow creates the relationship and the count becomes 1',
    f1.following === true && f1.followerCount === 1 && (await rel(SHOP_B, BUYER)) && (await count(SHOP_B)) === 1);
  const f2 = await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('C2  a DUPLICATE follow does not inflate the count', f2.following === true && f2.followerCount === 1 && (await count(SHOP_B)) === 1);
  const f3 = await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('C3  ...however many times it is repeated', f3.followerCount === 1 && (await count(SHOP_B)) === 1);
  const u1 = await call(BUYER, { shopId: SHOP_B, follow: false });
  ck('C4  an unfollow removes the relationship and reconciles the count',
    u1.following === false && u1.followerCount === 0 && !(await rel(SHOP_B, BUYER)) && (await count(SHOP_B)) === 0);
  const u2 = await call(BUYER, { shopId: SHOP_B, follow: false });
  ck('C5  a duplicate unfollow does not drive the count negative', u2.followerCount === 0 && (await count(SHOP_B)) === 0);
  for (let i = 0; i < 10; i++) { await call(BUYER, { shopId: SHOP_B, follow: true }); await call(BUYER, { shopId: SHOP_B, follow: false }); }
  ck('C6  ten follow/unfollow cycles leave the count EXACTLY zero', (await count(SHOP_B)) === 0, String(await count(SHOP_B)));

  await reset();
  await Promise.all(['u1', 'u2', 'u3', 'u4', 'u5'].map((u) => call(u, { shopId: SHOP_B, follow: true })));
  ck('C7  five CONCURRENT distinct followers give a count of five', (await count(SHOP_B)) === 5, String(await count(SHOP_B)));
  await call('u3', { shopId: SHOP_B, follow: false });
  ck('C8  one unfollows and the count is four', (await count(SHOP_B)) === 4, String(await count(SHOP_B)));
  ck('C9  the count equals the number of relationship documents',
    (await count(SHOP_B)) === (await all('follows')).filter((f) => f.type === 'shop' && f.entityId === SHOP_B).length);
  ck('C10 a shop reached by its OWNER\'s uid resolves to the ONE canonical shop (no second key)',
    (await call('u9', { shopId: SELLER_A, follow: true })).following === true && (await rel(SHOP_B, 'u9')) && !(await rel(SELLER_A, 'u9')) && (await count(SHOP_B)) === 5);
}

/* ═══ D — the client cannot desynchronise truth ═══ */
quiet('\nPART D — the client can no longer desynchronise truth\n');
{
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const block = rules.slice(rules.indexOf('match /shopFollowers/{docId}'), rules.indexOf('match /shopFollowers/{docId}') + 320);
  ck('D1  the client can not create or delete a legacy shopFollowers document', !/allow (create|update|delete|write)/.test(block));
  const fblock = rules.slice(rules.indexOf('match /follows/{followId}'), rules.indexOf('match /follows/{followId}') + 700);
  ck('D2  the client can not create a SHOP follow (server-counted type)', /allow create:[\s\S]*!followId\.matches\('\.\*--\(provider\|venue\|creator\|shop\)--\.\*'\)/.test(fblock), fblock.replace(/\s+/g, ' ').slice(0, 160));
  ck('D3  ...nor delete one', /allow delete:[\s\S]*!followId\.matches\('\.\*--\(provider\|venue\|creator\|shop\)--\.\*'\)/.test(fblock));
  ck('D4  public READ of the legacy store is preserved (old data stays inspectable)', /allow read:\s*if true/.test(block));
  /* the old inflation loop: delete the relationship out of band, follow again */
  await reset();
  await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('D5  baseline: one follow, count 1', (await count(SHOP_B)) === 1);
  const again = await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('D6  following again while the relationship exists never inflates (idempotent on the server-owned doc)', again.followerCount === 1 && (await count(SHOP_B)) === 1);
  ck('D7  the rule detector catches a permissive rule (control)', /allow delete/.test('match /x/{d} { allow delete: if isAuthed(); }'));
}

/* ═══ E — no shop is ever created as a side effect ═══ */
quiet('\nPART E — following never provisions anything\n');
{
  await reset();
  const cfgBefore = JSON.stringify((await db.doc('minishopConfig/' + SHOP_B).get()).data());
  await call(BUYER, { shopId: SHOP_B, follow: true });
  const shops = await all('shops');
  ck('E1  following creates no shop (still exactly the two fixture shops)', shops.length === 2);
  ck('E2  it writes the relationship and the counter on the EXISTING shop doc (merge — name kept)',
    (await rel(SHOP_B, BUYER)) && (await db.doc('shops/' + SHOP_B).get()).data().name === 'B Shop' && (await db.doc('shops/' + SHOP_B).get()).data().followV === 1);
  ck('E3  the storefront config is not touched', JSON.stringify((await db.doc('minishopConfig/' + SHOP_B).get()).data()) === cfgBefore);
  ck('E4  no legacy shopFollowers document is written any more', (await all('shopFollowers')).length === 0);
}

/* ═══ F — the shipped source ═══ */
quiet('\nPART F — no second writer is left\n');
{
  const ms = fs.readFileSync(path.join(FN, 'minishop.js'), 'utf8');
  const body = ms.slice(ms.indexOf('exports.followShop'), ms.indexOf('exports.getMyMinishop') > 0 ? ms.indexOf('exports.getMyMinishop') : ms.indexOf('exports.followShop') + 3000);
  ck('F1  followShop delegates to the reputation authority', /require\('\.\/reputation'\)/.test(body) && /repFollow/.test(body) && /repUnfollow/.test(body));
  ck('F2  it no longer writes shopFollowers', !/collection\('shopFollowers'\)/.test(body));
  ck('F3  ...nor a counter in minishopConfig', !/collection\('minishopConfig'\)/.test(body));
  ck('F4  the uid still comes only from auth', /_requireAuth\(request\)/.test(body) && /auth: request\.auth/.test(body) && !/request\.data\.uid/.test(body));
  const rep = fs.readFileSync(path.join(FN, 'reputation.js'), 'utf8');
  ck('F5  the authority floors an unfollow at zero', /const next = Math\.max\(0, cur - 1\);/.test(rep));
  ck('F6  the detector can fail (control)', !/collection\('shopFollowers'\)/.test("db.collection('shopFollowers')") === false);
}

quiet('\n' + '='.repeat(70));
quiet('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
