#!/usr/bin/env node
/* Stage E1 — server-side product write authority.
 *
 *   npm run test:product:authority
 *
 * WHY THIS EXISTS
 * `products` writes made through the Admin SDK bypass firestore.rules completely. A
 * census of every server-side product mutation (Stage E0) found two callables where
 * that mattered:
 *
 *   C1 posSyncToMarketplace — checked only that the caller was signed in, then
 *      decremented `stock` on a client-supplied productId. Any authenticated account
 *      could alter any seller's inventory.
 *   C2 cycleCountComplete   — bounded the caller to a shop but never proved the
 *      counted productIds belonged to that shop.
 *
 * WHAT IS TESTED
 * §1-3 exercise the real predicate against a stub Firestore.
 * §4 asserts the two call sites are wired so the check happens BEFORE the commit —
 *    a correct predicate called after batch.commit() would protect nothing.
 * §5 is the negative control: it re-runs the same scenarios with the ownership
 *    comparison neutered and requires the vulnerability to come back. Without it,
 *    every "DENY" assertion could be passing for the wrong reason.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const PA = require(path.join(ROOT, 'functions', 'shared', 'product-authority.js'));

/* ── stub Firestore: only what the predicate touches ─────────────────────────── */
function stubDb(products, shops) {
  return {
    collection: (name) => ({
      doc: (id) => ({ __col: name, __id: id, id,
        get: async () => {
          const bag = name === 'products' ? products : (shops || {});
          const data = bag[id];
          return { exists: !!data, id, data: () => data, ref: { __col: name, __id: id, id } };
        } }),
    }),
    getAll: async (...refs) => refs.map((r) => {
      const data = products[r.__id];
      return { exists: !!data, id: r.__id, data: () => data, ref: r };
    }),
  };
}

const SELLER_A = 'uidSellerA', SELLER_B = 'uidSellerB', BUYER = 'uidBuyer';
const PRODUCTS = {
  pA1: { sellerUid: SELLER_A, stock: 10 },
  pA2: { sellerUid: SELLER_A, stock: 5 },
  pB1: { sellerUid: SELLER_B, stock: 7 },
  pNoOwner: { stock: 1 },
};
const db = stubDb(PRODUCTS, { shopA: { sellerUid: SELLER_A }, shopLegacy: { uid: SELLER_B } });

const denied = async (fn) => {
  try { await fn(); return false; } catch (e) { return /permission-denied/.test(e.code || e.message || ''); }
};

(async () => {
  /* ══ 1 · ownership ══ */
  head('1 · ownership is required for every target product');

  /* case 1 — authorized seller + own product */
  const r1 = await PA.resolveOwnedProducts(db, ['pA1', 'pA2'], SELLER_A, {});
  ck('authorized seller + own products -> PASS', r1.found.size === 2 && r1.missing.length === 0);

  /* case 2 — buyer + another seller's product */
  ck('buyer + another seller product -> DENY',
     await denied(() => PA.resolveOwnedProducts(db, ['pA1'], BUYER, {})));

  /* case 3 — approved seller + another seller's product (the regression that a
     seller-only check, without ownership, would reintroduce) */
  ck('seller B + seller A product -> DENY',
     await denied(() => PA.resolveOwnedProducts(db, ['pA1'], SELLER_B, {})));

  /* case 6 — forged sellerId: identity is a parameter derived from the token by the
     caller; a body-supplied value that does not own the product still denies */
  ck('forged sellerId (not the owner) -> DENY',
     await denied(() => PA.resolveOwnedProducts(db, ['pA1'], 'uidForged', {})));

  ck('caller with NO seller identity -> DENY',
     await denied(() => PA.resolveOwnedProducts(db, ['pA1'], null, {})));
  ck('product with no sellerUid at all -> DENY',
     await denied(() => PA.resolveOwnedProducts(db, ['pNoOwner'], SELLER_A, {})));

  /* ══ 2 · batch integrity ══ */
  head('2 · a mixed batch authorises nothing');
  /* case 8 — one foreign product must reject the WHOLE set, before any commit */
  ck('mixed owned+foreign -> throws (no partial authorisation)',
     await denied(() => PA.resolveOwnedProducts(db, ['pA1', 'pB1', 'pA2'], SELLER_A, {})));
  const r8 = await PA.resolveOwnedProducts(db, ['pA1', 'unknownId', 'pA2'], SELLER_A, {});
  ck('unknown products are reported, not thrown (POS basket may be unlisted)',
     r8.found.size === 2 && r8.missing.length === 1 && r8.missing[0] === 'unknownId');
  const r0 = await PA.resolveOwnedProducts(db, [], SELLER_A, {});
  ck('empty set is a no-op', r0.found.size === 0 && r0.missing.length === 0);

  /* ══ 3 · shop -> seller resolution ══ */
  head('3 · shop resolves to its seller by the LIVE model, not ownerId');
  ck('shop.sellerUid wins', PA.shopSellerUidFrom({ sellerUid: SELLER_A }, 'shopA') === SELLER_A);
  ck('legacy shop.uid is honoured', PA.shopSellerUidFrom({ uid: SELLER_B }, 'shopLegacy') === SELLER_B);
  ck('doc id is the last resort (shops are keyed by owner uid)',
     PA.shopSellerUidFrom({}, SELLER_A) === SELLER_A);
  ck('ownerId is NOT treated as authority',
     PA.shopSellerUidFrom({ ownerId: 'uidSomeoneElse' }, SELLER_A) === SELLER_A);

  /* cases 4/5/7 — POS user against their own vs another shop, and a forged shopId.
     Authority flows caller -> shop -> sellerUid -> product.sellerUid. */
  const shopASeller = PA.shopSellerUidFrom({ sellerUid: SELLER_A }, 'shopA');
  const r4 = await PA.resolveOwnedProducts(db, ['pA1'], shopASeller, {});
  ck('POS user + product of THEIR shop -> PASS', r4.found.size === 1);
  ck('POS user + product of ANOTHER shop -> DENY',
     await denied(() => PA.resolveOwnedProducts(db, ['pB1'], shopASeller, {})));
  const forgedShopSeller = PA.shopSellerUidFrom({ sellerUid: SELLER_B }, 'shopB');
  ck('forged shopId cannot reach another seller\'s product',
     await denied(() => PA.resolveOwnedProducts(db, ['pA1'], forgedShopSeller, {})));

  head('3b · elevated callers');
  const rE = await PA.resolveOwnedProducts(db, ['pA1', 'pB1'], null, { elevated: true });
  ck('platform admin may act across sellers', rE.found.size === 2);
  ck('isElevated recognises the existing spellings',
     PA.isElevated({ token: { admin: true } }) && PA.isElevated({ token: { role: 'super_admin' } })
     && PA.isElevated({ token: { role: 5 } }) && !PA.isElevated({ token: { role: 'cashier' } }));

  /* ══ 4 · call sites are wired correctly ══ */
  head('4 · both call sites check BEFORE they commit');
  const C1 = fs.readFileSync(path.join(ROOT, 'functions', 'pos-retail.js'), 'utf8');
  const C2 = fs.readFileSync(path.join(ROOT, 'functions', 'pos-completeness.js'), 'utf8');

  const c1Fn = C1.slice(C1.indexOf('exports.posSyncToMarketplace'));
  const c1Check = c1Fn.indexOf('resolveOwnedProducts');
  const c1Commit = c1Fn.indexOf('batch.commit()');
  ck('C1 calls the predicate', c1Check > -1);
  ck('C1 checks BEFORE batch.commit()', c1Check > -1 && c1Commit > c1Check);
  ck('C1 derives identity from the token, not the body',
     /resolveOwnedProducts\([\s\S]{0,200}?request\.auth\.uid/.test(c1Fn));
  ck('C1 does NOT treat branchId as authority',
     !/resolveOwnedProducts\([\s\S]{0,200}?branchId/.test(c1Fn));
  /* case 9 — idempotency preserved */
  ck('C1 idempotency guard preserved', /posSyncIdempotency/.test(c1Fn) && /duplicate: true/.test(c1Fn));

  const c2Fn = C2.slice(C2.indexOf('exports.cycleCountComplete'));
  const c2Check = c2Fn.indexOf('resolveOwnedProducts');
  const c2Commit = c2Fn.indexOf('batch.commit()');
  ck('C2 calls the predicate', c2Check > -1);
  ck('C2 checks BEFORE batch.commit()', c2Check > -1 && c2Commit > c2Check);
  ck('C2 keeps the existing POS shop authorization', /_assertPOS\(req\.auth, shopId\)/.test(c2Fn));
  ck('C2 derives the seller from the shop, not from req.data',
     /shopSellerUidFrom\(_shop, shopId\)/.test(c2Fn));
  ck('C2 does not silently repair the ownerId divergence',
     /shop\.ownerId === uid/.test(C2));   /* _assertPOS left exactly as it was */

  /* ══ 5 · NEGATIVE CONTROL ══ */
  head('5 · negative control — remove the ownership comparison, vulnerability returns');
  const SRC = fs.readFileSync(path.join(ROOT, 'functions', 'shared', 'product-authority.js'), 'utf8');
  /* The copy runs from a temp dir where firebase-functions is not resolvable, so the
     import is stubbed rather than writing a scratch file into the repo. */
  const HTTPS_IMPORT = "const { HttpsError } = require('firebase-functions/v2/https');";
  const HTTPS_STUB = 'class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }';
  const NEUTERED = SRC
    .replace(HTTPS_IMPORT, HTTPS_STUB)
    .replace('if (!o.elevated && owner !== sellerUid) {', 'if (false) {');
  ck('the ownership comparison was actually removed for this run',
     NEUTERED !== SRC && !NEUTERED.includes("require('firebase-functions") && NEUTERED.includes('if (false) {'));

  const tmp = path.join(require('os').tmpdir(), 'pa-neutered-' + process.pid + '.js');
  fs.writeFileSync(tmp, NEUTERED);
  const NPA = require(tmp);
  const bad = await NPA.resolveOwnedProducts(db, ['pA1'], BUYER, {});
  ck('un-guarded predicate lets a BUYER reach another seller\'s product (defect reproduced)',
     bad.found.size === 1);
  const badMix = await NPA.resolveOwnedProducts(db, ['pA1', 'pB1'], SELLER_A, {});
  ck('un-guarded predicate authorises a mixed batch (defect reproduced)', badMix.found.size === 2);
  fs.unlinkSync(tmp);

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
