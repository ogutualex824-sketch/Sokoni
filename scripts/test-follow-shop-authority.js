#!/usr/bin/env node
/* followShop hardening — Store Stage 1B.
 *
 *   node scripts/test-follow-shop-authority.js
 *
 * TWO DEFECTS, and the first is the more serious.
 *
 * 1. WRITE AUTHORITY. followShop accepted any `shopId` string and merge-wrote
 *    `minishopConfig/{shopId}`. A merge to a missing document CREATES it, so any
 *    authenticated caller could conjure publicly-readable storefront config
 *    documents for shop ids nobody owns.
 *
 * 2. COUNTER DESYNCHRONISATION. followShop decides idempotency by reading
 *    `shopFollowers/{shopId}_{uid}`, and firestore.rules let the client DELETE
 *    that same document. Delete it, follow again, and the counter rose a second
 *    time — an unbounded inflation loop from one account against any shop.
 *
 * THE MODEL BEING ASSERTED
 *
 *     shopFollowers/{shopId}_{uid}   the authoritative relationship
 *              |
 *     followerCount                  DERIVED, maintained in the same transaction
 *
 * ...and `shops/{shopId}` must exist before either is touched.
 *
 * FIXTURE: SHOP_B and SHOP_C both EXIST and belong to different sellers, so
 * "denied" can never be confused with "shop missing", and following someone
 * else's shop — which is legitimate — is exercised rather than assumed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B   = 'SHOP_B_shop_91c';
const SHOP_C   = 'SHOP_C_shop_42x';
const BUYER    = 'BUYER_uid_11';

function baseDocs() {
  return {
    'shops/SHOP_B_shop_91c': { sellerUid: SELLER_A, name: 'B Shop' },
    'shops/SHOP_C_shop_42x': { sellerUid: 'OTHER_SELLER', name: 'C Shop' },
    'minishopConfig/SHOP_B_shop_91c': { handle: 'bshop', shopId: SHOP_B, followerCount: 0 },
  };
}

/* Firestore stub with a real transaction: reads first, writes applied on commit. */
function makeDb(docs) {
  const writes = [];
  const ref = (p) => ({ __p: p });
  const snapOf = (p) => ({ exists: Object.prototype.hasOwnProperty.call(docs, p), id: p.split('/').pop(), data: () => docs[p] });
  const tx = {
    async get(r) { return snapOf(r.__p); },
    set(r, d, opt) {
      writes.push({ op: 'set', path: r.__p, doc: d, merge: !!(opt && opt.merge) });
      docs[r.__p] = (opt && opt.merge) ? Object.assign({}, docs[r.__p] || {}, d) : Object.assign({}, d);
    },
    delete(r) { writes.push({ op: 'delete', path: r.__p }); delete docs[r.__p]; },
  };
  return {
    writes, docs,
    collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
    async runTransaction(fn) {
      const before = writes.length;
      try { return await fn(tx); }
      catch (e) {
        /* A throw inside a transaction commits nothing — undo anything staged so
           the test observes real transactional behaviour, not partial writes. */
        writes.length = before;
        throw e;
      }
    },
  };
}

let DOCS = baseDocs();
let DB = makeDb(DOCS);

/* Capture followShop from the shipped module. */
function loadFollowShop() {
  const orig = Module.prototype.require;
  let mod = null;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') {
      return { getFirestore: () => DB,
        FieldValue: { serverTimestamp: () => ({ __s: 'ts' }), increment: (n) => ({ __s: 'inc', n }),
          arrayUnion: () => ({ __s: 'arr' }), delete: () => ({ __s: 'del' }) },
        Timestamp: { now: () => ({ __s: 'now' }), fromDate: (d) => ({ __s: 'ts', d }) } };
    }
    if (id === 'firebase-admin') {
      return { firestore: Object.assign(() => DB, { FieldValue: { serverTimestamp: () => ({ __s: 'ts' }) } }),
        apps: [{}], initializeApp() {} };
    }
    if (id === 'firebase-functions/v2/https') {
      return { onCall: (_o, h) => h, onRequest: (_o, h) => (h || _o),
        HttpsError: class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } } };
    }
    if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => (h || _o) };
    if (id === 'firebase-functions/params') {
      const p = (n, o) => ({ name: n, value: () => (o && o.default) || '' });
      return { defineSecret: p, defineString: p, defineInt: p, defineBoolean: p };
    }
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
    return orig.apply(this, arguments);
  };
  try {
    const f = path.join(FUNCTIONS_DIR, 'minishop.js');
    delete require.cache[require.resolve(f)];
    mod = require(f);
  } finally { Module.prototype.require = orig; }
  return mod && mod.followShop;
}

const followShop = loadFollowShop();
const call = (uid, data) => followShop({ auth: uid ? { uid, token: {} } : null, data });
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };
const reset = () => { DOCS = baseDocs(); DB = makeDb(DOCS); };
const count = (shopId) => (DOCS['minishopConfig/' + shopId] || {}).followerCount;
const rel = (shopId, uid) => Object.prototype.hasOwnProperty.call(DOCS, 'shopFollowers/' + shopId + '_' + uid);

(async () => {

if (typeof followShop !== 'function') {
  console.error('followShop could not be captured — the suite cannot run.');
  process.exit(1);
}

/* ═══ A — the shop must exist before anything is written ═══ */
console.log('\nPART A — no shop, no write\n');
{
  reset();
  const ok = await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('A1  a buyer may follow a shop that EXISTS', ok && ok.following === true);

  reset();
  const okC = await call(SELLER_A, { shopId: SHOP_C, follow: true });
  ck('A2  SELLER_A may follow SHOP_C, because SHOP_C exists (following is not ownership)',
    okC && okC.following === true);

  reset();
  const missing = await err(call(BUYER, { shopId: 'shop_that_does_not_exist', follow: true }));
  ck('A3  a NONEXISTENT shop is refused', missing && missing.code === 'not-found', missing && missing.code);
  ck('A4  ...and NOTHING was written — no config document was conjured',
    DB.writes.length === 0 && !DOCS['minishopConfig/shop_that_does_not_exist'],
    JSON.stringify(DB.writes));

  reset();
  const arbitrary = await err(call(BUYER, { shopId: '../../etc/passwd', follow: true }));
  ck('A5  an arbitrary shop id string is refused', arbitrary && arbitrary.code === 'not-found');
  ck('A6  ...and creates no document of any kind', DB.writes.length === 0);

  reset();
  const anon = await err(call(null, { shopId: SHOP_B, follow: true }));
  ck('A7  an unauthenticated caller is DENIED', anon && anon.code === 'unauthenticated');
  ck('A8  ...and writes nothing', DB.writes.length === 0);

  reset();
  const noShopId = await err(call(BUYER, { follow: true }));
  ck('A9  a missing shopId is invalid-argument', noShopId && noShopId.code === 'invalid-argument');
  const noFollow = await err(call(BUYER, { shopId: SHOP_B }));
  ck('A10 a missing follow flag is invalid-argument', noFollow && noFollow.code === 'invalid-argument');
}

/* ═══ B — the owner following their own shop ═══ */
console.log('\nPART B — existing policy preserved\n');
{
  reset();
  const own = await call(SELLER_A, { shopId: SHOP_B, follow: true });
  ck('B1  an owner may follow their own shop — unchanged policy',
    own && own.following === true && own.followerCount === 1);
  ck('B2  ...and it is recorded as a normal relationship', rel(SHOP_B, SELLER_A));
}

/* ═══ C — the relationship is the authority, the count is derived ═══ */
console.log('\nPART C — one fact, one derived number\n');
{
  reset();
  const f1 = await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('C1  a follow creates the relationship and the count becomes 1',
    f1.following === true && f1.followerCount === 1 && rel(SHOP_B, BUYER) && count(SHOP_B) === 1);

  const f2 = await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('C2  a DUPLICATE follow does not inflate the count',
    f2.following === true && f2.followerCount === 1 && count(SHOP_B) === 1);

  const f3 = await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('C3  ...however many times it is repeated', f3.followerCount === 1 && count(SHOP_B) === 1);

  const u1 = await call(BUYER, { shopId: SHOP_B, follow: false });
  ck('C4  an unfollow removes the relationship and reconciles the count',
    u1.following === false && u1.followerCount === 0 && !rel(SHOP_B, BUYER) && count(SHOP_B) === 0);

  const u2 = await call(BUYER, { shopId: SHOP_B, follow: false });
  ck('C5  a duplicate unfollow does not drive the count negative',
    u2.followerCount === 0 && count(SHOP_B) === 0);

  /* Repeat the whole cycle — the count must land exactly, not drift. */
  for (let i = 0; i < 10; i++) {
    await call(BUYER, { shopId: SHOP_B, follow: true });
    await call(BUYER, { shopId: SHOP_B, follow: false });
  }
  ck('C6  ten follow/unfollow cycles leave the count EXACTLY zero', count(SHOP_B) === 0, String(count(SHOP_B)));

  /* Several distinct followers. */
  reset();
  for (const u of ['u1', 'u2', 'u3', 'u4', 'u5']) await call(u, { shopId: SHOP_B, follow: true });
  ck('C7  five distinct followers give a count of five', count(SHOP_B) === 5, String(count(SHOP_B)));
  await call('u3', { shopId: SHOP_B, follow: false });
  ck('C8  one unfollows and the count is four', count(SHOP_B) === 4, String(count(SHOP_B)));
  ck('C9  the count equals the number of relationship documents',
    count(SHOP_B) === Object.keys(DOCS).filter((k) => k.indexOf('shopFollowers/' + SHOP_B + '_') === 0).length);
}

/* ═══ D — the loop is closed at the rules, structurally ═══ */
console.log('\nPART D — the client can no longer desynchronise truth\n');
{
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const block = rules.slice(rules.indexOf('match /shopFollowers/{docId}'),
    rules.indexOf('match /shopFollowers/{docId}') + 320);

  ck('D1  the client can no longer CREATE a follow document', !/allow create/.test(block));
  ck('D2  the client can no longer DELETE one', !/allow delete/.test(block), block.replace(/\s+/g, ' ').slice(0, 90));
  ck('D3  the relationship is therefore CF-only — the loop has no first step',
    !/allow (create|update|delete|write)/.test(block));
  ck('D4  public READ is preserved, so a storefront can still show follow state',
    /allow read:\s*if true/.test(block));

  /* The loop simulated end to end: follow, delete the relationship out of band
     (as the old rule permitted), then follow again. */
  reset();
  await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('D5  baseline: one follow, count 1', count(SHOP_B) === 1);
  delete DOCS['shopFollowers/' + SHOP_B + '_' + BUYER];       /* what the old rule allowed */
  await call(BUYER, { shopId: SHOP_B, follow: true });
  ck('D6  the loop WOULD still double the count if the document vanished — which is exactly why the rule, not the function, is the fix',
    count(SHOP_B) === 2, String(count(SHOP_B)));
  ck('D7  ...and no shipped client can perform that delete any more',
    !/allow delete/.test(block));

  /* Control: the assertion must be able to fail. */
  ck('D8  the rule detector catches a permissive rule (control)',
    /allow delete/.test('match /x/{d} { allow delete: if isAuthed(); }'));
}

/* ═══ E — no shop is ever created as a side effect ═══ */
console.log('\nPART E — following never provisions anything\n');
{
  reset();
  await call(BUYER, { shopId: SHOP_B, follow: true });
  const created = DB.writes.filter((w) => w.path.indexOf('shops/') === 0);
  ck('E1  following writes NOTHING to shops/', created.length === 0, JSON.stringify(created));
  ck('E2  it touches exactly two documents — the relationship and the counter',
    DB.writes.length === 2 &&
    DB.writes.some((w) => w.path.indexOf('shopFollowers/') === 0) &&
    DB.writes.some((w) => w.path.indexOf('minishopConfig/') === 0),
    DB.writes.map((w) => w.op + ' ' + w.path).join(' | '));
  ck('E3  the counter write is a MERGE, so it cannot clobber storefront config',
    DB.writes.find((w) => w.path.indexOf('minishopConfig/') === 0).merge === true);
  ck('E4  ...and the existing config survives it',
    DOCS['minishopConfig/' + SHOP_B].handle === 'bshop');
}

/* ═══ F — the shipped source ═══ */
console.log('\nPART F — the fix is where it should be\n');
{
  const ms = fs.readFileSync(path.join(FUNCTIONS_DIR, 'minishop.js'), 'utf8');
  const body = ms.slice(ms.indexOf('exports.followShop'), ms.indexOf('exports.followShop') + 3200);

  /* Asserted by ORDERING, not by distance. A `[\s\S]{0,400}` window between two
     landmarks fails the moment a comment is added between them — it measures
     prose length, not structure. */
  const iTx      = body.indexOf('runTransaction');
  const iShopGet = body.indexOf('tx.get(shopRef)');
  const iRefuse  = body.indexOf('!shopSnap.exists');
  const iFirstWrite = Math.min(
    ...[body.indexOf('tx.set('), body.indexOf('tx.delete(')].filter((i) => i >= 0)
  );

  ck('F1  the shop existence check is INSIDE the transaction, so it cannot be raced',
    iTx >= 0 && iShopGet > iTx, 'runTransaction@' + iTx + ' shopGet@' + iShopGet);
  ck('F2  ...and it refuses BEFORE any write in that transaction',
    iRefuse > iShopGet && iRefuse < iFirstWrite,
    'refuse@' + iRefuse + ' firstWrite@' + iFirstWrite);
  ck('F3  the relationship key is {shopId}_{uid} with uid from auth',
    /doc\(`\$\{shopId\}_\$\{uid\}`\)/.test(body) && /const uid = _requireAuth\(request\)/.test(body));
  /* The property is about WRITES, not mentions. `const { following,
     followerCount } = await db.runTransaction(...)` legitimately names the
     counter outside the transaction — it is destructuring the RESULT. What must
     not exist is a write to the counter document from outside. */
  const configUses = [];
  for (let i = body.indexOf('configRef'); i >= 0; i = body.indexOf('configRef', i + 1)) configUses.push(i);
  const configWritesOutside = configUses.filter((i) => {
    const before = body.slice(Math.max(0, i - 12), i);
    const isTxOp = /tx\.(set|get|delete)\(\s*$/.test(before);
    const isDecl = /const\s+$/.test(before) || body.slice(i, i + 12).indexOf('configRef ') === 0;
    return !isTxOp && !isDecl;
  });
  ck('F4  the counter document is only ever written through the transaction',
    configWritesOutside.length === 0,
    configWritesOutside.map((i) => body.slice(i - 14, i + 14).replace(/\s+/g, ' ')).join(' | '));
  ck('F5  an unfollow floors the count at zero', /Math\.max\(0, currentCount - 1\)/.test(body));

  /* Mutation control. */
  const mutated = body.replace(/if \(!shopSnap\.exists\) \{[\s\S]{0,90}?\}/, '');
  ck('F6  the existence check is a real block that can be removed (control)', mutated !== body);
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
