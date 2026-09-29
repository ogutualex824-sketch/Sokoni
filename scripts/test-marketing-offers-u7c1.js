/* test-marketing-offers-u7c1.js — universal catalogue U7c1 (2026-09-29): the Offers studio is wired to the ONE merchant
 * offer store and lives inside Marketing.
 *
 * REAL functions/shop-offers.js (normaliseOffer, upsertOffer over the transactional fake Firestore with the shop-access
 * authority stubbed), REAL sokoni-merchant-routes.js (the route contract), and the shipped merchant-v2 wiring.
 *
 * PROVES
 *   OC1 a DRAFT may be saved incomplete (no percent / bundle price / amount); publishing still needs them; a percent
 *       above 100 is refused whatever the status
 *   OC2 upsert: the create is idempotent on the draftToken (a retried save is the SAME offer), an update by offerId
 *       keeps the owner, and another shop's offer id is refused — the store the studio now writes to
 *   OC3 a draft can never price a basket: resolve() ignores it; the same offer published does
 *   OC4 routes: Marketing is a primary destination; Offers and Flash Sale are no longer sidebar entries, and their old
 *       ids (#offers, #flash-sale, #promotions) resolve to Marketing; the contract still validates
 *   OC5 the shell: the studio's ctx is the shopOfferList / shopOfferUpsert callables and the shop's own catalogue; it is
 *       mounted inside Marketing; the old flash module (mktFlashSales) is no longer loaded; a flash-sale link opens a new
 *       flash sale
 *   OC6 the studio no longer sends the { delivery, pickup } object the server stored as "[object Object]", and no longer
 *       prompts for typed-in items
 *
 *   node scripts/test-marketing-offers-u7c1.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-offers-u7c1';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  if (id === 'firebase-admin') return { apps: [{}], initializeApp() {}, firestore: Object.assign(() => db, { FieldValue: F.FieldValue }) };
  if (id === './shop-employees') return {
    /* the owner of shopA, and nobody else, may write there */
    resolveShopAccess: async (uid, shopId) => { if (uid === 'ownerA' && shopId === 'shopA') return { role: 'owner', via: 'owner', shopOwnerId: 'ownerA' };
      if (uid === 'ownerB' && shopId === 'shopB') return { role: 'owner', via: 'owner', shopOwnerId: 'ownerB' }; throw new HttpsError('permission-denied', 'no access'); },
    capabilitiesForRole: () => ['sell', 'discount'] };
  return orig.apply(this, arguments);
};
let SO; try { SO = require(path.join(FN, 'shop-offers.js')); } catch (e) { SO = { __err: e.message }; }
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };
const acodeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };

(async () => {
  if (typeof SO.normaliseOffer !== 'function') { ck('OC0 the offer module loads', false, SO.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  const own = { shopId: 'shopA' };
  /* OC1 */
  const d1 = codeOf(() => SO.normaliseOffer({ type: 'percentage', status: 'draft', name: 'half done' }, own));
  const d2 = codeOf(() => SO.normaliseOffer({ type: 'bundle', status: 'draft' }, own));
  const d3 = codeOf(() => SO.normaliseOffer({ type: 'fixed', status: 'draft' }, own));
  const l1 = codeOf(() => SO.normaliseOffer({ type: 'percentage', status: 'live' }, own));
  const l2 = codeOf(() => SO.normaliseOffer({ type: 'bundle', status: 'live' }, own));
  const l3 = codeOf(() => SO.normaliseOffer({ type: 'fixed', status: 'scheduled' }, own));
  const p1 = codeOf(() => SO.normaliseOffer({ type: 'percentage', status: 'draft', percent: 150 }, own));
  ck('OC1 an incomplete DRAFT saves; publishing still needs its price; percent > 100 refused even for a draft',
    d1 === null && d2 === null && d3 === null && l1 === 'invalid-argument' && l2 === 'invalid-argument' && l3 === 'invalid-argument' && p1 === 'invalid-argument',
    { d1, d2, d3, l1, l2, l3, p1 });

  /* OC2 — fail CLOSED: a refused write is a FAIL line, never a crash */
  let a = {}, again = {}, upd = {}, stored = {}, foreign = null, all = -1;
  try {
  a = await SO.upsertOffer(db, { uid: 'ownerA', shopId: 'shopA', draftToken: 'dt_1', offer: { type: 'percentage', status: 'draft', name: 'Flash' } });
  again = await SO.upsertOffer(db, { uid: 'ownerA', shopId: 'shopA', draftToken: 'dt_1', offer: { type: 'percentage', status: 'draft', name: 'Flash' } });
  upd = await SO.upsertOffer(db, { uid: 'ownerA', shopId: 'shopA', offerId: a.id, offer: { type: 'percentage', status: 'live', percent: 10, shopId: 'shopB' } });
  stored = (await db.doc('shopOffers/' + a.id).get()).data() || {};
  foreign = await acodeOf(SO.upsertOffer(db, { uid: 'ownerB', shopId: 'shopB', offerId: a.id, offer: { type: 'percentage', status: 'live', percent: 90 } }));
  all = (await db.collection('shopOffers').get()).docs.length;
  } catch (e) { a = { err: e.code || e.message }; }
  ck('OC2 create is idempotent on the draftToken; update by id keeps the owner; another shop\'s id is refused',
    a.created && again.id === a.id && !again.created && upd.id === a.id && stored.shopId === 'shopA' && stored.percent === 10 && stored.status === 'live'
    && foreign === 'permission-denied' && all === 1, { a: a.id || a.err, again: again.id, shop: stored.shopId, foreign, all });

  /* OC3 */
  const basket = { lines: [{ listingId: 'x', price: 1000, qty: 1 }] };
  const asDraft = SO.resolve(basket, [{ id: 'o', type: 'percentage', status: 'draft', percent: 50 }], {});
  const asLive = SO.resolve(basket, [{ id: 'o', type: 'percentage', status: 'live', percent: 50 }], {});
  ck('OC3 a draft never prices a basket; the same offer published does', asDraft.total === 1000 && asLive.total === 500, { draft: asDraft.total, live: asLive.total });

  /* OC4 */
  let R = null; try { R = require(path.join(ROOT, 'sokoni-merchant-routes.js')); } catch (_) {}
  const probs = R && R.validate ? R.validate() : ['no validate'];
  const ids = R ? (R.ROUTES || []).map((r) => r.id) : [];
  const mk = R ? (R.ROUTES || []).find((r) => r.id === 'marketing') : null;
  const primary = R ? (R.PRIMARY_ORDER || []) : [];
  const growth = R ? ((R.MORE_GROUPS || []).find((g) => g.key === 'growth') || {}).ids : null;
  ck('OC4 Marketing is primary; Offers and Flash Sale are not sidebar entries; #offers/#flash-sale/#promotions resolve to Marketing',
    R && probs.length === 0 && mk && mk.tier === 'primary' && primary.includes('marketing') && !primary.includes('offers')
    && !ids.includes('offers') && !ids.includes('flash-sale') && R.resolve('offers') === 'marketing' && R.resolve('flash-sale') === 'marketing'
    && R.resolve('promotions') === 'marketing' && Array.isArray(growth) && !growth.includes('flash-sale') && !growth.includes('marketing'),
    { probs, primary: primary.slice(0, 8), growth, tier: mk && mk.tier });

  /* OC5 */
  const mv = src('merchant-v2.html');
  const offersCtx = (mv.match(/function _offersCtx \(\) \{[\s\S]*?\n  \}/) || [''])[0];
  ck('OC5 the shell: studio ctx = shopOfferList/shopOfferUpsert + the shop\'s own catalogue, mounted in Marketing; old flash module gone; #flash-sale opens a flash sale',
    /_callable\('shopOfferList'\)/.test(offersCtx) && /_callable\('shopOfferUpsert'\)/.test(offersCtx) && /SokoniMerchantData\.listProducts\(\{ scope: sc, db: _mdb \}\)/.test(offersCtx)
    && /offers: _offersCtx, initialTab: _mkPending\.tab/.test(mv) && !/<script src="sokoni-merchant-flash\.js"><\/script>/.test(mv) && !/global: 'SokoniMerchantFlash'/.test(mv)
    && /'flash-sale': \['offers', 'flashSale'\]/.test(mv) && /cur\.ui\.setTab\(_mkPending\.tab, _mkPending\.template\)/.test(mv)
    && /data-t="offers">Offers<\/button>/.test(src('sokoni-merchant-marketing.js')),
    { ctxLen: offersCtx.length });

  /* OC6 */
  const st = src('sokoni-merchant-offers.js').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('OC6 the studio sends fulfilment as ONE channel string (never the old object) and never prompts for a typed-in item',
    !/fulfilment: \{ delivery/.test(st) && /d\.fulfilment === 'delivery' \|\| d\.fulfilment === 'pickup'\)\) out\.fulfilment = d\.fulfilment/.test(st)
    && !/window\.prompt\(/.test(st) && !/'manual-' \+ Date\.now\(\)/.test(st));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
