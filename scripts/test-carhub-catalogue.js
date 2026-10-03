#!/usr/bin/env node
'use strict';
/* ============================================================================
   Car Hub paid products in the ONE catalogue (owner 2026-10-03, via sokoni-f3)
     C1  dealer plans: Free + Starter 1,500 (10/2) · Growth 3,000 (30/5) · Pro 5,000 (75/10) · Business 8,000 (150/20)
         · Enterprise 15,000 (300/40); monthly only (annual refused); in-app leads
     C2  tracking plans: Basic 300 · Standard 500 · Pro 800 (1 vehicle) · Fleet5 2,000 · Fleet10 3,500 · Fleet25 7,500
     C3  entitlements answer through subscription-catalog.requireFeature (listings_limit / featured_credits_monthly /
         vehicle_limit) with upgradeRequired from the real table
     B1  boost seed prices exactly as the owner set; an AdminOS override applies; an invalid override is ignored
     B2  fulfilment after a verified payment: single → listingBoosts row (endsAt = now + duration); bundle → credits;
         replay → nothing twice; a credit → one 7-day boost; no credit → refused
     B3  wiring: purpose vehicle_boost priced from the catalogue; self-settling; webhook hook on the early intent read
   NODE_PATH=<functions/node_modules> node scripts/test-carhub-catalogue.js
   ============================================================================ */
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const PLANS = require(path.join(ROOT, 'functions/sub-billing.js')).PLANS;
const C = require(path.join(ROOT, 'functions/subscription-catalog.js'));
const VB = require(path.join(ROOT, 'functions/vehicle-boosts.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 220) : '')); } };

function fakeDb (seed) {
  const docs = new Map(Object.entries(seed || {})); const INC = Symbol('i');
  const apply = (c, p) => { const o = Object.assign({}, c || {}); for (const [k, v] of Object.entries(p)) o[k] = (v && v[INC] !== undefined) ? (Number(o[k]) || 0) + v[INC] : v; return o; };
  const ref = (p) => ({ path: p, id: p.split('/').pop(), get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }) });
  return { _docs: docs, inc: (n) => ({ [INC]: n }), collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
    async runTransaction (fn) {
      const w = []; const t = { get: async (r) => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }),
        create: (r, v) => w.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, apply(null, v)); }),
        set: (r, v, o) => w.push(() => docs.set(r.path, apply(o && o.merge ? docs.get(r.path) : null, v))),
        update: (r, v) => w.push(() => docs.set(r.path, apply(docs.get(r.path), v))) };
      const out = await fn(t); const snap = new Map(docs);
      try { w.forEach((f) => f()); } catch (e) { docs.clear(); snap.forEach((v, k) => docs.set(k, v)); throw e; }
      return out; } };
}

(async () => {
  const dl = ['car_dealer_starter', 'car_dealer_growth', 'car_dealer_pro', 'car_dealer_business', 'car_dealer_enterprise'].map((id) => PLANS[id]);
  ck('C1 dealer plans: prices 1,500/3,000/5,000/8,000/15,000; listings 10/30/75/150/300; featured 2/5/10/20/40; in-app leads; Free kept',
    dl.map((p) => p.price.monthly / 100).join() === '1500,3000,5000,8000,15000' && dl.map((p) => p.features.listings_limit).join() === '10,30,75,150,300'
    && dl.map((p) => p.features.featured_credits_monthly).join() === '2,5,10,20,40' && dl.every((p) => p.features.in_app_leads === true && p.price.annual === null)
    && PLANS.car_dealer_free && PLANS.car_dealer_free.price.monthly === 0);
  const tr = ['tracking_basic', 'tracking_standard', 'tracking_pro', 'tracking_fleet5', 'tracking_fleet10', 'tracking_fleet25'].map((id) => PLANS[id]);
  ck('C2 tracking plans: 300/500/800/2,000/3,500/7,500; vehicles 1/1/1/5/10/25; location + trips + status on every tier',
    tr.map((p) => p.price.monthly / 100).join() === '300,500,800,2000,3500,7500' && tr.map((p) => p.features.vehicle_limit).join() === '1,1,1,5,10,25'
    && tr.every((p) => p.hubType === 'vehicle_tracking' && p.features.location_tracking && p.features.trip_history && p.features.vehicle_status));
  const q1 = C.requireFeature({ plan: 'car_dealer_starter', status: 'active' }, { hubType: 'car_dealer', feature: 'listings_limit', needed: 11 });
  const q2 = C.requireFeature({ plan: 'tracking_fleet5', status: 'active' }, { hubType: 'vehicle_tracking', feature: 'vehicle_limit', needed: 6 });
  const q3 = C.requireFeature(null, { hubType: 'car_dealer', feature: 'featured_credits_monthly', needed: 1 });
  ck('C3 entitlements: 11th listing on Starter → Growth; 6th vehicle on Fleet5 → Fleet10; Free has no featured credits → Starter',
    q1.upgradeRequired && q1.upgradeRequired.minPlanId === 'car_dealer_growth' && q2.upgradeRequired.minPlanId === 'tracking_fleet10' && q3.upgradeRequired && q3.upgradeRequired.minPlanId === 'car_dealer_starter', [q1, q2, q3]);

  let c = await VB.catalogue(fakeDb());
  const seed = Object.values(c.products).map((p) => p.key + '=' + p.kes).join(',');
  ck('B1 seed prices exactly as the owner set (24h 50, 3d 100, 7d 200, 14d 350, 30d 600; 5×7d 800, 10×7d 1,500, 20×7d 2,500)',
    seed === 'quick_24h=50,standard_3d=100,featured_7d=200,premium_14d=350,spotlight_30d=600,bundle_5x7d=800,bundle_10x7d=1500,bundle_20x7d=2500', seed);
  c = await VB.catalogue(fakeDb({ 'revenueConfig/vehicle_boosts': { prices: { featured_7d: 150, spotlight_30d: -5, premium_14d: '999' } } }));
  ck('B1b AdminOS override applies (featured 7d → 150); invalid overrides (negative, string) are IGNORED, seed stands, reported',
    c.products.featured_7d.kes === 150 && c.products.featured_7d.source === 'admin_override' && c.products.spotlight_30d.kes === 600 && c.products.premium_14d.kes === 350 && c.ignored.slice().sort().join() === 'premium_14d,spotlight_30d', c.ignored);
  ck('B1c unknown boost → no price', (await VB.priceFor(fakeDb(), 'free_forever')) === null);

  const NOW = new Date('2026-10-03T10:00:00Z'); let db = fakeDb();
  const intent = (key, extra) => Object.assign({ uid: 'dealer_1', resourceId: 'veh_0001', metadata: { boostKey: key } }, extra || {});
  let r = await VB.fulfilVehicleBoost(db, intent('featured_7d'), 'PAY_1', { now: () => NOW, inc: db.inc });
  const b = db._docs.get('listingBoosts/PAY_1');
  ck('B2a verified payment → listingBoosts row for the listing, 7 days, placement featured', r.ok && b && b.listingId === 'veh_0001' && new Date(b.endsAt).toISOString() === '2026-10-10T10:00:00.000Z' && b.placement === 'featured', b);
  let replay = null; try { await VB.fulfilVehicleBoost(db, intent('featured_7d'), 'PAY_1', { now: () => NOW, inc: db.inc }); } catch (e) { replay = e.code; }
  ck('B2b a replayed payment fulfils nothing twice (create() refuses)', replay === 6 && [...db._docs.keys()].filter((k) => k.startsWith('listingBoosts/')).length === 1);
  await VB.fulfilVehicleBoost(db, intent('bundle_5x7d', { resourceId: 'dealer_1' }), 'PAY_2', { now: () => NOW, inc: db.inc });
  ck('B2c bundle → 5 credits on the account (+ ledger), no boost yet', db._docs.get('boostCredits/dealer_1').credits7d === 5 && db._docs.has('boostCreditLedger/PAY_2'));
  r = await VB.consumeBoostCredit(db, 'dealer_1', 'veh_0002', 'use1', { now: () => NOW });
  ck('B2d a credit → one 7-day boost; 4 left', r.ok && r.remaining === 4 && db._docs.has('listingBoosts/credit_use1'));
  r = await VB.consumeBoostCredit(fakeDb(), 'dealer_2', 'veh_0003', 'use2', { now: () => NOW });
  ck('B2e no credits → refused', r.ok === false && r.code === 'no_credits');
  let nl = null; try { await VB.fulfilVehicleBoost(fakeDb(), intent('quick_24h', { resourceId: '' }), 'PAY_3', { now: () => NOW }); } catch (e) { nl = e.code; }
  ck('B2f a single boost without a listing is refused (nothing written)', nl === 'no_listing');

  const PP = fs.readFileSync(path.join(ROOT, 'functions/payment-purposes.js'), 'utf8');
  const SS = require(path.join(ROOT, 'functions/shared/self-settling-purposes.js'));
  const IX = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
  ck('B3a purpose vehicle_boost prices from the catalogue (never the request), needs the listing for a single boost',
    /vehicle_boost: \{[\s\S]{0,400}require\('\.\/vehicle-boosts'\)\.priceFor\(db\(\), data\.boostKey/.test(PP) && /Choose the vehicle listing to boost/.test(PP) && /amountCents: p\.kes \* 100/.test(PP));
  ck('B3b vehicle_boost is self-settling (the webhook never runs a seller credit for it)', SS.isSelfSettling('vehicle_boost'));
  const early = IX.indexOf("_fiSnap.data().resourceType === 'vehicleBoost'"), self = IX.indexOf('self-settling purpose — no generic commission');
  ck('B3c webhook fulfils on the EXISTING early intent read, before the self-settling exit and any seller credit', early > 0 && early < self);
  ck('B3d Super Admin–only price editor, whole KES 1–100,000, audited', /tk\.superAdmin !== true/.test(fs.readFileSync(path.join(ROOT, 'functions/vehicle-boosts.js'), 'utf8')) && /adminAudit/.test(fs.readFileSync(path.join(ROOT, 'functions/vehicle-boosts.js'), 'utf8')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
