/* ══════════════════════════════════════════════════════════════════════════════
   GATE P IMPLEMENTATION — the merchant offer authority vs REAL FIRESTORE
   ──────────────────────────────────────────────────────────────────────────────
     npx firebase emulators:exec --only firestore \
       "node scripts/test-shop-offers-emulator.mjs"

   The design gate proved the schema and pinned the boundary. Four obligations were left
   explicitly UNPROVEN because they need a running write authority. This suite closes them:

     1  runtime authorization refusal   non-member, unsupported role, permitted role, admin
     2  cross-shop isolation AT REST    verified by querying the server, not by UI filtering
     3  independent redemption          its own ledger; promotionUsage must stay untouched
     4  charge-time application         the persisted offer decides; the client cannot

   Every refusal is verified by READING FIRESTORE afterwards. "Nothing was written" means the
   collection is empty on the server, not that a function returned an error — a writer that
   throws after writing would pass the second test and fail the first.

   Authorization runs against the REAL resolveShopAccess, with real `shops` and
   `shopEmployees` documents, so what is proven is the platform's own access rule rather than
   a stub that agrees with me.
   ══════════════════════════════════════════════════════════════════════════════ */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.log('\n  ENV — FIRESTORE_EMULATOR_HOST is unset. Run through:');
  console.log('    npx firebase emulators:exec --only firestore "node scripts/test-shop-offers-emulator.mjs"\n');
  process.exit(2);
}

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-test';
/* Rooted at functions/package.json so subpath exports ("firebase-admin/auth") resolve the
   way they do inside a deployed function, rather than through a hand-built path. */
const fnRequire = createRequire(path.join(ROOT, 'functions', 'package.json'));
const admin = fnRequire('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

/* getAuth().getUser() is consulted only for the platform-admin branch. The emulator has no
   Auth users, so it is stubbed to return the claims this suite is testing with — the branch
   under test is resolveShopAccess's, not the Auth SDK's. */
const authModule = fnRequire('firebase-admin/auth');
const CLAIMS = new Map();
const realGetAuth = authModule.getAuth;
authModule.getAuth = () => ({
  getUser: async (uid) => ({ uid, customClaims: CLAIMS.get(uid) || {} }),
});

const OFF = fnRequire('./shop-offers.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const head = t => console.log('\n' + t);

const SHOP_A = 'shopA', SHOP_B = 'shopB';
const OWNER_A = 'ownerA', OWNER_B = 'ownerB';
const MANAGER_A = 'mgrA', CASHIER_A = 'cashA', SUPPORT_A = 'supA', STRANGER = 'nobody', ADMIN = 'plat';

async function wipe (col) {
  const s = await db.collection(col).get();
  await Promise.all(s.docs.map(d => d.ref.delete()));
}
async function seed () {
  await Promise.all([wipe(OFF.COL), wipe(OFF.COL_REDEMPTIONS), wipe('shops'),
                     wipe('shopEmployees'), wipe('promotionUsage')]);
  await db.collection('shops').doc(SHOP_A).set({ ownerId: OWNER_A, name: 'Shop A' });
  await db.collection('shops').doc(SHOP_B).set({ ownerId: OWNER_B, name: 'Shop B' });
  const emp = (shopId, uid, role, owner) => db.collection('shopEmployees')
    .doc(`${shopId}_${uid}`).set({ shopId, uid, role, active: true, shopOwnerId: owner });
  await Promise.all([
    emp(SHOP_A, MANAGER_A, 'manager', OWNER_A),
    emp(SHOP_A, CASHIER_A, 'cashier', OWNER_A),
    emp(SHOP_A, SUPPORT_A, 'support', OWNER_A),
  ]);
  CLAIMS.set(ADMIN, { admin: true });
}
const offerOf = (over = {}) => Object.assign({
  type: 'fixed', amount: 500, name: 'Test offer', status: 'live',
}, over);
async function count (col) { return (await db.collection(col).get()).size; }
async function tryWrite (fn) {
  try { return { ok: true, res: await fn() }; }
  catch (e) { return { ok: false, code: e.code || e.message, msg: e.message }; }
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  GATE P IMPLEMENTATION — shopOffers vs real Firestore');
console.log('══════════════════════════════════════════════════════════════════');

await seed();

/* ── 1. RUNTIME AUTHORIZATION ───────────────────────────────────────────────── */
head('1 - authorization refusal, verified by querying the server');
{
  const r = await tryWrite(() => OFF.upsertOffer(db, {
    uid: STRANGER, shopId: SHOP_A, offer: offerOf(), draftToken: 't1' }));
  ck('an authenticated NON-MEMBER is refused', !r.ok, r.code);
  ck('and wrote nothing', await count(OFF.COL) === 0, (await count(OFF.COL)) + ' documents');

  const anon = await tryWrite(() => OFF.upsertOffer(db, {
    uid: null, shopId: SHOP_A, offer: offerOf(), draftToken: 't2' }));
  ck('an UNAUTHENTICATED caller is refused', !anon.ok, anon.code);
  ck('and wrote nothing', await count(OFF.COL) === 0);

  /* THE ROLE POLICY, EXPLICIT. An offer is a discount, so writing one needs the discount
     capability: owner, admin and manager hold it; cashier, inventory and support do not. */
  const cash = await tryWrite(() => OFF.upsertOffer(db, {
    uid: CASHIER_A, shopId: SHOP_A, offer: offerOf(), draftToken: 't3' }));
  ck('a CASHIER cannot write an offer', !cash.ok, cash.msg);
  ck('and wrote nothing', await count(OFF.COL) === 0);

  const sup = await tryWrite(() => OFF.upsertOffer(db, {
    uid: SUPPORT_A, shopId: SHOP_A, offer: offerOf(), draftToken: 't4' }));
  ck('a SUPPORT member cannot write an offer', !sup.ok, sup.msg);

  /* A cashier trying to PUBLISH specifically — the case the gate named. */
  const cashPub = await tryWrite(() => OFF.upsertOffer(db, {
    uid: CASHIER_A, shopId: SHOP_A, offer: offerOf({ status: 'live' }), draftToken: 't5' }));
  ck('a cashier cannot PUBLISH either', !cashPub.ok, cashPub.msg);
  ck('still nothing written', await count(OFF.COL) === 0);

  const owner = await tryWrite(() => OFF.upsertOffer(db, {
    uid: OWNER_A, shopId: SHOP_A, offer: offerOf(), draftToken: 'own-1' }));
  ck('the OWNER may write', owner.ok, owner.ok ? owner.res.id : owner.msg);
  ck('and the document exists on the server', await count(OFF.COL) === 1);

  const mgr = await tryWrite(() => OFF.upsertOffer(db, {
    uid: MANAGER_A, shopId: SHOP_A, offer: offerOf({ name: 'Manager offer' }), draftToken: 'mgr-1' }));
  ck('a MANAGER may write', mgr.ok, mgr.ok ? 'role ' + mgr.res.role : mgr.msg);

  /* The explicit via:'admin' branch, preserved rather than inferred. */
  const adm = await tryWrite(() => OFF.upsertOffer(db, {
    uid: ADMIN, shopId: SHOP_A, offer: offerOf({ name: 'Admin offer' }), draftToken: 'adm-1' }));
  ck('a platform ADMIN may write, by the explicit admin path', adm.ok,
     adm.ok ? 'role ' + adm.res.role : adm.msg);
  ck('three offers now exist', await count(OFF.COL) === 3, (await count(OFF.COL)) + '');
}

/* ── 2. CROSS-SHOP ISOLATION, AT REST ───────────────────────────────────────── */
head('2 - cross-shop isolation, checked on the server');
{
  const forged = await tryWrite(() => OFF.upsertOffer(db, {
    uid: OWNER_A, shopId: SHOP_A, draftToken: 'forge-1',
    /* The payload claims another shop. It must be DISCARDED, not honoured. */
    offer: offerOf({ shopId: SHOP_B, sellerUid: OWNER_B, name: 'Forged' }),
  }));
  ck('a payload naming another shop still writes', forged.ok, forged.ok ? '' : forged.msg);
  const fdoc = (await db.collection(OFF.COL).doc(forged.res.id).get()).data();
  ck('but the STORED shopId is the caller\'s own', fdoc.shopId === SHOP_A, fdoc.shopId);
  ck('and the stored sellerUid is the real owner', fdoc.sellerUid === OWNER_A, fdoc.sellerUid);

  /* Shop B's owner attacking Shop A's document by id. */
  const aDoc = forged.res.id;
  const cross = await tryWrite(() => OFF.upsertOffer(db, {
    uid: OWNER_B, shopId: SHOP_B, offerId: aDoc, offer: offerOf({ amount: 9999 }) }));
  ck('shop B cannot UPDATE shop A\'s offer by id', !cross.ok, cross.code);
  const after = (await db.collection(OFF.COL).doc(aDoc).get()).data();
  ck('and the stored amount is unchanged', after.amount === 500, String(after.amount));

  const bList = await OFF.listShopOffers(db, { uid: OWNER_B, shopId: SHOP_B });
  ck('shop B lists none of shop A\'s offers', bList.offers.length === 0,
     bList.offers.length + ' returned');
  const aList = await OFF.listShopOffers(db, { uid: OWNER_A, shopId: SHOP_A });
  ck('control — shop A lists its own', aList.offers.length === 4, aList.offers.length + '');
  ck('and every one is stamped with shop A',
     aList.offers.every(o => o.shopId === SHOP_A));

  const bReadsA = await tryWrite(() => OFF.listShopOffers(db, { uid: OWNER_B, shopId: SHOP_A }));
  ck('shop B cannot list shop A by naming it', !bReadsA.ok, bReadsA.code);
}

/* ── 3. IDEMPOTENCY ─────────────────────────────────────────────────────────── */
head('3 - idempotency, to the product writer\'s standard');
{
  await wipe(OFF.COL);
  const a = await OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A, offer: offerOf(), draftToken: 'idem' });
  const b = await OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A, offer: offerOf(), draftToken: 'idem' });
  ck('the same draft token returns the same id', a.id === b.id, a.id);
  ck('the replay is reported as such', b.created === false && b.replayed === true);
  ck('and only ONE document exists', await count(OFF.COL) === 1, (await count(OFF.COL)) + '');

  /* Concurrent replay — the transaction, not a get-then-set, is what makes this safe. */
  await wipe(OFF.COL);
  const races = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() =>
    OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A, offer: offerOf(), draftToken: 'race' })));
  ck('8 concurrent creates produce ONE document', await count(OFF.COL) === 1,
     (await count(OFF.COL)) + ' documents');
  ck('and all 8 return the same id', new Set(races.map(r => r.id)).size === 1, races[0].id);
  ck('exactly one reports created', races.filter(r => r.created).length === 1,
     races.filter(r => r.created).length + ' claimed creation');

  const other = await OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A, offer: offerOf(), draftToken: 'race-2' });
  ck('a different token makes a different offer', other.id !== races[0].id);
  ck('now two exist', await count(OFF.COL) === 2);

  const noTok = await tryWrite(() => OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A, offer: offerOf() }));
  ck('a create without a draft token is refused', !noTok.ok, noTok.msg);
}

/* ── 4. VALIDATION ──────────────────────────────────────────────────────────── */
head('4 - malformed offers fail closed, and write nothing');
{
  await wipe(OFF.COL);
  const cases = [
    ['an unknown type', { type: 'nonsense' }],
    ['a percentage over 100', { type: 'percentage', percent: 150 }],
    ['a bundle with no price', { type: 'bundle' }],
    ['a fixed with no amount', { type: 'fixed' }],
    ['a negative amount', { type: 'fixed', amount: -5 }],
  ];
  for (const [label, o] of cases) {
    const r = await tryWrite(() => OFF.upsertOffer(db, {
      uid: OWNER_A, shopId: SHOP_A, offer: o, draftToken: 'bad-' + label }));
    ck(label + ' is refused', !r.ok, r.msg);
  }
  ck('and NOTHING was written by any of them', await count(OFF.COL) === 0,
     (await count(OFF.COL)) + ' documents');
}

/* ── 5. REDEMPTION — ITS OWN LEDGER ─────────────────────────────────────────── */
head('5 - redemption accounting is independent of promotionUsage');
{
  await wipe(OFF.COL); await wipe(OFF.COL_REDEMPTIONS); await wipe('promotionUsage');
  const o = await OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A,
    offer: offerOf({ inventoryLimit: 3 }), draftToken: 'red-1' });

  await OFF.recordOfferRedemption(db, { offerId: o.id, shopId: SHOP_A, buyerUid: 'buyer1', orderId: 'ord1', discount: 500 });
  await OFF.recordOfferRedemption(db, { offerId: o.id, shopId: SHOP_A, buyerUid: 'buyer2', orderId: 'ord2', discount: 500 });

  ck('redemptions land in their own collection', await count(OFF.COL_REDEMPTIONS) === 2,
     OFF.COL_REDEMPTIONS);
  const doc = (await db.collection(OFF.COL).doc(o.id).get()).data();
  ck('the offer\'s own counter incremented', doc.redemptionCount === 2, String(doc.redemptionCount));

  /* THE POINT OF P3: the FinOS money ledger is untouched. */
  ck('promotionUsage was NOT written', await count('promotionUsage') === 0,
     (await count('promotionUsage')) + ' documents');
  const red = (await db.collection(OFF.COL_REDEMPTIONS).limit(1).get()).docs[0].data();
  ck('and no funding-attribution field was copied into it',
     !('fundedBy' in red) && !('platformFundingPct' in red) && !('sellerFundingPct' in red),
     Object.keys(red).join(','));

  const usage = await OFF.usageFor(db, { offerId: o.id, buyerUid: 'buyer1' });
  ck('usage counts total redemptions', usage.totalRedemptions === 2, String(usage.totalRedemptions));
  ck('and this customer\'s own', usage.customerRedemptions === 1, String(usage.customerRedemptions));
}

/* ── 6. CHARGE TIME ─────────────────────────────────────────────────────────── */
head('6 - the charge path resolves the PERSISTED offer');
{
  await wipe(OFF.COL); await wipe(OFF.COL_REDEMPTIONS);
  const basket = { subtotal: 1000, deliveryFee: 150,
    lines: [{ listingId: 'a', price: 1000, qty: 1 }] };

  const live = await OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A,
    offer: offerOf({ amount: 300, status: 'live' }), draftToken: 'chg-1' });
  const r1 = await OFF.resolveOfferForCharge(db, {
    shopId: SHOP_A, offerIds: [live.id], basket, buyerUid: 'buyer1' });
  ck('a live persisted offer discounts the basket', r1.discount === 300, String(r1.discount));
  ck('and names what applied', r1.applied.length === 1 && r1.applied[0].id === live.id);

  /* THE CLIENT CANNOT ASSERT MONEY. Only an id crosses the boundary; the figure comes from
     the stored document. A tampered basket total cannot inflate the discount. */
  const tampered = Object.assign({}, basket, { subtotal: 999999, discount: 99999, total: 1 });
  const r2 = await OFF.resolveOfferForCharge(db, {
    shopId: SHOP_A, offerIds: [live.id], basket: tampered, buyerUid: 'buyer1' });
  ck('a client-supplied discount field is ignored', r2.discount === 300, String(r2.discount));

  const draft = await OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A,
    offer: offerOf({ amount: 900, status: 'draft' }), draftToken: 'chg-2' });
  const r3 = await OFF.resolveOfferForCharge(db, { shopId: SHOP_A, offerIds: [draft.id], basket });
  ck('a DRAFT offer discounts nothing at charge time', r3.discount === 0, String(r3.discount));

  const expired = await OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A,
    offer: offerOf({ amount: 900, status: 'live', endsAt: '2026-01-01T00:00:00' }), draftToken: 'chg-3' });
  ck('an EXPIRED offer discounts nothing',
     (await OFF.resolveOfferForCharge(db, { shopId: SHOP_A, offerIds: [expired.id], basket })).discount === 0);

  const broken = await OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A,
    offer: offerOf({ amount: 900, status: 'live', schedule: { from: 'nonsense', to: '9' } }), draftToken: 'chg-4' });
  ck('a MALFORMED schedule fails closed at charge time',
     (await OFF.resolveOfferForCharge(db, { shopId: SHOP_A, offerIds: [broken.id], basket })).discount === 0);

  const missing = await OFF.resolveOfferForCharge(db, {
    shopId: SHOP_A, offerIds: ['does_not_exist'], basket });
  ck('an offer that does not exist is ignored, not fatal', missing.discount === 0);

  /* CROSS-SHOP AT CHARGE TIME: shop B naming shop A's offer must get nothing. */
  const crossCharge = await OFF.resolveOfferForCharge(db, {
    shopId: SHOP_B, offerIds: [live.id], basket });
  ck('another shop naming this offer gets no discount', crossCharge.discount === 0,
     String(crossCharge.discount));

  /* EXHAUSTION. Absent counters are unmetered; a real limit binds. */
  const capped = await OFF.upsertOffer(db, { uid: OWNER_A, shopId: SHOP_A,
    offer: offerOf({ amount: 100, status: 'live', totalRedemptionLimit: 1 }), draftToken: 'chg-5' });
  const before = await OFF.resolveOfferForCharge(db, { shopId: SHOP_A, offerIds: [capped.id], basket });
  ck('control — an unexhausted capped offer applies', before.discount === 100, String(before.discount));
  await OFF.recordOfferRedemption(db, { offerId: capped.id, shopId: SHOP_A, buyerUid: 'b', orderId: 'o', discount: 100 });
  const afterUse = await OFF.resolveOfferForCharge(db, { shopId: SHOP_A, offerIds: [capped.id], basket });
  ck('once its limit is reached it applies nothing', afterUse.discount === 0, String(afterUse.discount));

  /* QUOTE AND CHARGE COME FROM ONE CALCULATION. */
  const quote = await OFF.resolveOfferForCharge(db, { shopId: SHOP_A, offerIds: [live.id], basket, buyerUid: 'b2' });
  const charge = await OFF.resolveOfferForCharge(db, { shopId: SHOP_A, offerIds: [live.id], basket, buyerUid: 'b2' });
  ck('the quoted and charged amounts are identical',
     JSON.stringify(quote) === JSON.stringify(charge), 'discount ' + quote.discount);
}

/* ── 7. NEITHER EXISTING AUTHORITY WAS TOUCHED ──────────────────────────────── */
head('7 - offers and promotions are untouched at rest');
{
  ck('no document was written to `offers`', await count('offers') === 0);
  ck('no document was written to `promotions`', await count('promotions') === 0);
  ck('no document was written to `promotionUsage`', await count('promotionUsage') === 0);
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  App Check enforcement   [the emulator does not enforce it; production does]');
console.log('  UNPROVEN  deployment              [a separately authorised gate]');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
authModule.getAuth = realGetAuth;
process.exit(fail ? 1 : 0);
