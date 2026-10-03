/* ============================================================================
   VEHICLE BOOSTS — paid placement for Car Hub listings (owner 2026-10-03, via sokoni-f3)
   ----------------------------------------------------------------------------
   Owner prices (one-off, per vehicle listing): Quick 24h KES 50 · Standard 3d 100 · Featured 7d 200 · Premium 14d 350
   · Top Spotlight 30d 600; bundles of 7-day boosts: 5 → 800 · 10 → 1,500 · 20 → 2,500.
   Owner: "make the prices configurable … not hard-coded" → the defaults below are the SEED; an AdminOS/Super Admin
   price override lives in revenueConfig/vehicle_boosts and is read at payment time (no deploy for a promotion).
   Durations and bundle sizes are part of the product definition and stay in code.

   FLOW (SOKONI revenue, never a seller credit):
     createPaymentIntent({purpose:'vehicle_boost', boostKey, listingId?}) → priced HERE from config, never the request
     → IntaSend → verified webhook → fulfilVehicleBoost (idempotent on the payment ref):
         single boost → listingBoosts/{apiRef}  { uid, listingId, boostKey, placement, startsAt, endsAt }
         bundle       → boostCredits/{uid}.credits7d += count, ledger boostCreditLedger/{apiRef}
     consumeBoostCredit (Car Hub calls it after IT has verified the caller owns the listing) turns one credit into a
     7-day listingBoosts row, transactionally.
   'vehicle_boost' is a self-settling purpose: the webhook never runs the generic seller-credit path for it.
   ============================================================================ */
'use strict';

const CONFIG_DOC = ['revenueConfig', 'vehicle_boosts'];
const H = 3600000, D = 86400000;
const DEFAULTS = Object.freeze({
  quick_24h:     Object.freeze({ label: 'Quick boost',    kes: 50,   ms: 24 * H, count: 1, placement: 'boosted' }),
  standard_3d:   Object.freeze({ label: 'Standard boost', kes: 100,  ms: 3 * D,  count: 1, placement: 'boosted' }),
  featured_7d:   Object.freeze({ label: 'Featured',       kes: 200,  ms: 7 * D,  count: 1, placement: 'featured' }),
  premium_14d:   Object.freeze({ label: 'Premium',        kes: 350,  ms: 14 * D, count: 1, placement: 'premium' }),
  spotlight_30d: Object.freeze({ label: 'Top Spotlight',  kes: 600,  ms: 30 * D, count: 1, placement: 'spotlight' }),
  bundle_5x7d:   Object.freeze({ label: '5 × 7-day boosts',  kes: 800,  ms: 7 * D, count: 5,  placement: 'featured', bundle: true }),
  bundle_10x7d:  Object.freeze({ label: '10 × 7-day boosts', kes: 1500, ms: 7 * D, count: 10, placement: 'featured', bundle: true }),
  bundle_20x7d:  Object.freeze({ label: '20 × 7-day boosts', kes: 2500, ms: 7 * D, count: 20, placement: 'featured', bundle: true }),
});
const MAX_KES = 100000;

function _validPrice(v) { return Number.isInteger(v) && v >= 1 && v <= MAX_KES; }

/** The catalogue with AdminOS overrides applied. An invalid override is IGNORED (the seed stands) and reported. */
async function catalogue(db) {
  let ov = {};
  try {
    const s = await db.collection(CONFIG_DOC[0]).doc(CONFIG_DOC[1]).get();
    ov = (s && s.exists && s.data() && s.data().prices) || {};
  } catch (_) { ov = {}; }
  const out = {}, ignored = [];
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const o = ov[k];
    let kes = d.kes, source = 'default';
    if (o !== undefined) { if (_validPrice(o)) { kes = o; source = 'admin_override'; } else ignored.push(k); }
    out[k] = Object.assign({ key: k }, d, { kes, source });
  }
  return { products: out, ignored };
}

async function priceFor(db, key) {
  const k = String(key || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) return null;
  return (await catalogue(db)).products[k];
}

/** Fulfil a VERIFIED payment. Idempotent on apiRef (create()). Never credits a seller. */
async function fulfilVehicleBoost(db, intent, apiRef, deps) {
  const d = deps || {};
  const now = d.now ? d.now() : new Date();
  const ts = d.tsFromDate || ((x) => x);
  const inc = d.inc;
  const m = (intent && intent.metadata) || {};
  const key = String(m.boostKey || '');
  const def = DEFAULTS[key];
  if (!def || !intent || !intent.uid) return { ok: false, code: 'bad_intent' };
  const ref = String(apiRef);
  return db.runTransaction(async (t) => {
    if (def.bundle) {
      t.create(db.collection('boostCreditLedger').doc(ref), { uid: intent.uid, boostKey: key, credits: def.count, kind: 'grant', paymentRef: ref, at: ts(now) });
      t.set(db.collection('boostCredits').doc(String(intent.uid)), { uid: intent.uid, credits7d: inc ? inc(def.count) : def.count, updatedAt: ts(now) }, { merge: true });
      return { ok: true, kind: 'credits', credits: def.count };
    }
    const listingId = String(intent.resourceId || m.listingId || '');
    if (!listingId) throw Object.assign(new Error('single boost without a listing'), { code: 'no_listing' });
    t.create(db.collection('listingBoosts').doc(ref), {
      uid: intent.uid, listingId, boostKey: key, placement: def.placement,
      startsAt: ts(now), endsAt: ts(new Date(now.getTime() + def.ms)), paymentRef: ref, source: 'purchase',
    });
    return { ok: true, kind: 'boost', listingId, endsAt: new Date(now.getTime() + def.ms).toISOString() };
  });
}

/** One credit → one 7-day boost. The CALLER (Car Hub) must already have verified that uid owns listingId. */
async function consumeBoostCredit(db, uid, listingId, ref, deps) {
  const d = deps || {};
  const now = d.now ? d.now() : new Date();
  const ts = d.tsFromDate || ((x) => x);
  if (!uid || !listingId || !ref) return { ok: false, code: 'bad_request' };
  const cRef = db.collection('boostCredits').doc(String(uid));
  return db.runTransaction(async (t) => {
    const s = await t.get(cRef);
    const have = s.exists ? Number(s.data().credits7d) || 0 : 0;
    if (have < 1) return { ok: false, code: 'no_credits' };
    t.create(db.collection('listingBoosts').doc('credit_' + String(ref)), {
      uid, listingId: String(listingId), boostKey: 'credit_7d', placement: 'featured',
      startsAt: ts(now), endsAt: ts(new Date(now.getTime() + 7 * D)), source: 'credit',
    });
    t.update(cRef, { credits7d: have - 1, updatedAt: ts(now) });
    t.create(db.collection('boostCreditLedger').doc('use_' + String(ref)), { uid, credits: -1, kind: 'use', listingId: String(listingId), at: ts(now) });
    return { ok: true, remaining: have - 1 };
  });
}

/* ── deployables ── */
let vehicleBoostCatalogue, adminSetVehicleBoostPrices;
{
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  const _db = () => require('firebase-admin').firestore();
  vehicleBoostCatalogue = onCall({ region: 'us-central1', maxInstances: 20 }, async () => {
    const c = await catalogue(_db());
    return { ok: true, products: Object.values(c.products).map((p) => ({ key: p.key, label: p.label, priceKES: p.kes, days: p.ms / D, count: p.count, bundle: !!p.bundle, placement: p.placement })) };
  });
  /* Super Admin only. Prices in whole KES (1..100,000); unknown keys refused; every change audited. */
  adminSetVehicleBoostPrices = onCall({ region: 'us-central1', maxInstances: 5 }, async (req) => {
    const tk = req.auth && req.auth.token;
    if (!tk || tk.superAdmin !== true) throw new HttpsError('permission-denied', 'Only a Super Admin can change boost prices.');
    const prices = (req.data && req.data.prices) || {};
    const keys = Object.keys(prices);
    if (!keys.length) throw new HttpsError('invalid-argument', 'No prices supplied.');
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) throw new HttpsError('invalid-argument', 'Unknown boost: ' + k);
      if (!_validPrice(prices[k])) throw new HttpsError('invalid-argument', 'Price for ' + k + ' must be a whole number of shillings, 1–' + MAX_KES + '.');
    }
    const admin = require('firebase-admin');
    const db = _db();
    const patch = {}; keys.forEach((k) => { patch['prices.' + k] = prices[k]; });
    await db.collection(CONFIG_DOC[0]).doc(CONFIG_DOC[1]).set({ prices: {} }, { merge: true });
    await db.collection(CONFIG_DOC[0]).doc(CONFIG_DOC[1]).update(Object.assign(patch, { updatedBy: req.auth.uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
    await db.collection('adminAudit').add({ action: 'vehicle_boost_prices', hub: 'car', by: req.auth.uid, prices, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true, updated: keys };
  });
}

module.exports = { DEFAULTS, CONFIG_DOC, catalogue, priceFor, fulfilVehicleBoost, consumeBoostCredit, vehicleBoostCatalogue, adminSetVehicleBoostPrices };
