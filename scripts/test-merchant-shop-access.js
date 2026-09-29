#!/usr/bin/env node
/* Merchant → canonical shop access, and the navigation that must survive it.
 *
 *   node scripts/test-merchant-shop-access.js
 *
 * THE FAILURE THIS PINS
 * `SokoniBranch.init()` synthesises a branch when its device-local list is
 * empty:
 *
 *     branches = [{ id: 'main', name: 'Main Branch', … }];
 *
 * and merchant.html assigned that straight to `SokoniShell.activeShopId`. On any
 * fresh device the workspace therefore asked for `products where shopId=='main'`
 * and `shops/main` — neither of which exists — and a correctly-provisioned
 * merchant looked like a broken account. The identity chain
 * (auth.uid → sellerUid → activeShopId → shops/{id}) was never the problem;
 * merchant.html simply did not consult it.
 *
 * This is NOT a claim problem, and nothing here grants a claim.
 *
 * FIXTURES
 *   SELLER_A ≠ SHOP_B   the shop id is not the account id, so a substitution
 *                       cannot pass by coincidence
 *   KASS                control — its canonical shop id equals its uid AS A
 *                       FACT OF THE DATA (shops/{uid} exists), which the
 *                       resolver must confirm by reading, not assume
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const KASS = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';

function makeDb(docs) {
  const reads = [];
  return {
    reads,
    getDoc: async (coll, id) => { reads.push(`${coll}/${id}`); return docs[`${coll}/${id}`] || null; },
  };
}

(async () => {
/* ═══ A — the placeholder that caused it ═══ */
console.log('\nPART A — a branch placeholder is not a shop\n');
{
  ck('A1  "main" is recognised as a placeholder', MD.isPlaceholderShopId('main') === true);
  ck('A2  ...as are default/empty/null-ish', ['default', '', 'null', 'undefined'].every(MD.isPlaceholderShopId));
  ck('A3  a real shop id is not a placeholder',
    MD.isPlaceholderShopId(SHOP_B) === false && MD.isPlaceholderShopId(KASS) === false);

  const s = MD.resolveScope({ uid: SELLER_A, activeShopId: 'main' });
  ck('A4  a scope built from "main" is REFUSED, not used',
    s.ok === false && s.reason === 'placeholder_shop_id' && s.shopId === null, JSON.stringify(s));
  ck('A5  ...and the rejected value is reported for diagnosis', s.rejected === 'main');

  let threw = false;
  try { MD.productQuery(s); } catch (_) { threw = true; }
  ck('A6  ...so no product query can be built from it', threw);
}

/* ═══ B — canonical resolution ═══ */
console.log('\nPART B — the shop comes from Firestore, in a defined order\n');
{
  /* 1. An explicit users.activeShopId, confirmed to exist. */
  const db1 = makeDb({
    [`users/${SELLER_A}`]: { activeShopId: SHOP_B },
    [`shops/${SHOP_B}`]: { ownerId: SELLER_A, name: 'Shop B Traders' },
  });
  const r1 = await MD.resolveShopId({ uid: SELLER_A, db: db1 });
  ck('B1  users.activeShopId wins when its shop exists',
    r1.shopId === SHOP_B && r1.source === 'users.activeShopId');
  ck('B2  ...and SHOP_B is not the account id', r1.shopId !== SELLER_A);

  /* 2. A declared shop that does NOT exist must not be trusted. */
  const db2 = makeDb({
    [`users/${SELLER_A}`]: { activeShopId: 'GHOST_SHOP' },
    [`shops/${SELLER_A}`]: { ownerId: SELLER_A, name: 'Fallback shop' },
  });
  const r2 = await MD.resolveShopId({ uid: SELLER_A, db: db2 });
  ck('B3  a declared shop that does not exist is discarded', r2.shopId !== 'GHOST_SHOP');
  ck('B4  ...and the owned shop document is used instead', r2.source === 'shops/{uid}');

  /* 3. A declared placeholder must never be honoured. */
  const db3 = makeDb({ [`users/${SELLER_A}`]: { activeShopId: 'main' }, [`shops/main`]: { ownerId: 'x' } });
  const r3 = await MD.resolveShopId({ uid: SELLER_A, db: db3 });
  ck('B5  a declared "main" is refused even if a shops/main document existed',
    r3.shopId !== 'main', JSON.stringify(r3));

  /* 4. Registry-only merchants. */
  const db4 = makeDb({ [`sellers/${SELLER_A}`]: { name: 'Registry only' } });
  const r4 = await MD.resolveShopId({ uid: SELLER_A, db: db4 });
  ck('B6  a registry-only merchant resolves through sellers/{uid}', r4.source === 'sellers/{uid}');

  /* 5. No shop at all → null, never an invented id. */
  const db5 = makeDb({ [`users/${SELLER_A}`]: {} });
  const r5 = await MD.resolveShopId({ uid: SELLER_A, db: db5 });
  ck('B7  no shop → null and a stated reason, never a guess',
    r5.shopId === null && r5.source === 'no_shop');

  /* 6. The uid is used to LOOK UP a shop; the returned id is the document's. */
  const db6 = makeDb({});
  const r6 = await MD.resolveShopId({ uid: SELLER_A, db: db6 });
  ck('B8  with no documents at all, the uid is NOT returned as a shop id', r6.shopId === null);
  ck('B9  ...and every candidate was actually read, not assumed',
    db6.reads.includes(`shops/${SELLER_A}`) && db6.reads.includes(`sellers/${SELLER_A}`),
    db6.reads.join(','));
}

/* ═══ C — KASS as a control ═══ */
console.log('\nPART C — KASS (control): resolves by the same rules, no bypass\n');
{
  const db = makeDb({
    [`users/${KASS}`]: { roles: ['buyer', 'rider', 'seller', 'driver'] },   /* no activeShopId field */
    [`shops/${KASS}`]: { ownerId: KASS, name: 'kassshop', handle: 'kassshop' },
    /* NB: no seller custom claim anywhere — access must not depend on one. */
  });
  const r = await MD.resolveShopId({ uid: KASS, db });
  ck('C1  KASS resolves to its canonical shop', r.shopId === KASS && r.source === 'shops/{uid}');
  ck('C2  ...because shops/{uid} was READ and exists, not because uid was assumed',
    db.reads.includes(`shops/${KASS}`) && !!r.shop, db.reads.join(','));
  ck('C3  ...carrying the shop identity (kassshop)', r.shop.handle === 'kassshop');

  const scope = MD.resolveScope({ uid: KASS, activeShopId: r.shopId, source: r.source });
  ck('C4  the scope resolves ok', scope.ok === true && scope.shopId === KASS);

  const q = MD.productQuery(scope);
  ck('C5  ...and products are queried by the canonical shopId (not "main")',
    q.where[0][2] === KASS, JSON.stringify(q.where));

  /* The whole point: no claim was consulted anywhere in this path. */
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8');
  ck('C6  shop access never consults a custom claim',
    !/customClaims|getIdTokenResult|token\.seller/.test(src));

  /* A merchant with NO shop must not silently become their own shop. */
  const empty = makeDb({ [`users/${KASS}`]: {} });
  const none = await MD.resolveShopId({ uid: KASS, db: empty });
  ck('C7  a KASS-shaped account with no shop document resolves to null',
    none.shopId === null);
}

/* ═══ D — merchant.html actually uses it, and keeps its navigation ═══ */
console.log('\nPART D — the shell wiring, and no silent deletion\n');
{
  const shell = fs.readFileSync(path.join(ROOT, 'merchant.html'), 'utf8');

  ck('D1  merchant.html loads the merchant data layer',
    /<script src="sokoni-merchant-data\.js"><\/script>/.test(shell));
  ck('D2  ...and resolves the shop canonically at boot',
    /resolveShopId\(/.test(shell) && /_resolveCanonicalShop/.test(shell));
  ck('D3  ...and no longer assigns a raw branch id as the shop',
    !/activeShopId = b \? b\.id : null/.test(shell));
  ck('D4  ...while the branch switcher keeps its own job',
    /activeBranchId/.test(shell) && /SokoniBranch/.test(shell));

  /* The navigation must survive the fix — every route still present. */
  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  ck('D5  the route contract still validates', C.validate().length === 0);
  /* A FLOOR, not an exact count. This assertion exists to catch a route being REMOVED, and D7
     below does that properly by name. Pinning the total at exactly 30 also failed the moment a
     route was legitimately ADDED (2D-1C: `sell`, `inventory`) — which is not the defect it was
     written to catch, and "delete the new route" is the wrong way to make it green again. */
  ck('D6  no merchant route was removed (>= 30 registered)', C.ROUTES.length >= 30, String(C.ROUTES.length));

  const EXPECTED = ['dashboard', 'orders', 'analytics', 'revenue', 'payments', 'settings', 'reports',
    'availability', 'devices', 'products', 'receipts', 'staff', 'messages', 'marketing',
    'flash-sale', 'kra-tax', 'stories', 'disputes', 'customers', 'shop', 'pos', 'deliveries',
    'returns', 'plan', 'minishop', 'fulfilment', 'riders', 'verification', 'pos-setup', 'home'];
  /* SUPERSEDED 2026-09-29 (U7c1, owner): Flash Sale is no longer a sidebar route — it is an offer type inside
     Marketing › Offers, and #flash-sale is an ALIAS that opens it there. An id that still RESOLVES through the
     registry is still reachable, so it is not a removed button; an id that resolves nowhere still fails here. */
  const missing = EXPECTED.filter(id => !C.ROUTES.some(r => r.id === id) && !(C.resolve && C.resolve(id)));
  ck('D7  no merchant button was removed by this fix', missing.length === 0, missing.join(','));

  ck('D8  the sidebar still renders FROM the contract (no private list)',
    /CONTRACT\.ROUTES/.test(shell) && /CONTRACT\.BOTTOM_NAV/.test(shell));
  ck('D9  POS and Plan remain reachable', !!C.get('pos') && !!C.get('plan'));
}

/* ═══ E — mutation control ═══ */
console.log('\nPART E — mutation control\n');
{
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8');
  const mutants = [
    { label: 'M1  "main" is accepted as a shop id again',
      src: src.replace("var NOT_A_SHOP_ID = ['main',", "var NOT_A_SHOP_ID = ['__never__',"),
      check: (M) => M.resolveScope({ uid: SELLER_A, activeShopId: 'main' }).ok === true },
    { label: 'M2  the resolver returns the uid without reading a shop',
      src: src.replace("    return { shopId: null, source: 'no_shop' };",
        "    return { shopId: String(uid), source: 'assumed' };"),
      check: async (M) => (await M.resolveShopId({ uid: SELLER_A, db: makeDb({}) })).shopId === SELLER_A },
    { label: 'M3  a declared shop is trusted without confirming it exists',
      src: src.replace(/      var declaredShop = await db\.getDoc\('shops', declared\);\n      if \(declaredShop\)/,
        '      var declaredShop = null;\n      if (true)'),
      check: async (M) => {
        const r = await M.resolveShopId({ uid: SELLER_A, db: makeDb({ [`users/${SELLER_A}`]: { activeShopId: 'GHOST_SHOP' } }) });
        return r.shopId === 'GHOST_SHOP'; } },
  ];

  for (const mu of mutants) {
    if (mu.src === src) { ck(mu.label + ' → mutation applied', false, 'no-op replace'); continue; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
    const file = path.join(dir, 'sokoni-merchant-data.js');
    fs.writeFileSync(file, mu.src);
    delete require.cache[require.resolve(file)];
    let caught = false, detail = '';
    try { caught = await mu.check(require(file)); } catch (e) { caught = true; detail = 'threw: ' + e.message; }
    ck(mu.label + ' → detected', caught, detail);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
