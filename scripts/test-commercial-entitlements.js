#!/usr/bin/env node
'use strict';
/* ============================================================================
   commercial-entitlements.js + its use in financialPartnerDispatch (2026-10-01). Fake Firestore.
     A  pricing is server-side from ONE config; Enterprise not self-serve; unknown plan/product refused
     B  eligibility: only an approved listing; cannot promote someone else
     C  coexistence: marketplace subscriptions/{uid} untouched; partner entitlement and campaigns separate
     D  fulfilment idempotent on intent.ref (duplicate callback = ONE entitlement / ONE campaign);
        renewal extends; amount mismatch → review, no entitlement
     E  promotion: listing not approved at payment → campaign 'review' (paid, not serving); expiry of a
        campaign leaves the partner plan active; admin stop keeps history
     F  entitlements enforced: product/team caps by plan; expired plan → free base; unknown plan → base
     G  directory: paid category boost ranks, featured flagged, caps hold, unpaid browser cannot activate
   node scripts/test-commercial-entitlements.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); } };
let now = Date.now();   /* the directory reads the real clock */
const F = makeFakeFirestore({ clock: () => now });
const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff, auth: () => ({ getUserByEmail: async (e) => ({ uid: 'st_' + e.split('@')[0], email: e }) }) } };
const COM = require(path.join(FN, 'commercial-entitlements.js'));
const M = require(path.join(FN, 'financial-partner.js'));
const deps = () => ({ db: F.db, now, FieldValue: F.FieldValue, Timestamp: F.Timestamp });
const fulfil = (fn, intent) => F.db.runTransaction((tx) => COM[fn](tx, intent, deps()));
const tryP = async (p) => { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
let ipn = 0;
const call = async (uid, data, token = {}) => { ipn++; try { return { ok: true, v: await M.financialPartnerDispatch.run({ auth: uid ? { uid, token } : null, data, rawRequest: { headers: { 'x-forwarded-for': '10.2.0.' + (ipn % 250) } } }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const keys = (pre) => [...F.db._store.keys()].filter((k) => k.startsWith(pre));

(async () => {
  console.log('commercial entitlements — partner plans + paid promotion\n');
  /* A */
  const a1 = COM.priceFor('partner_subscription', { planId: 'growth', priceKES: 1 });
  const a2 = await tryP(Promise.resolve().then(() => COM.priceFor('partner_subscription', { planId: 'enterprise' })));
  const a3 = await tryP(Promise.resolve().then(() => COM.priceFor('partner_subscription', { planId: 'platinum' })));
  const a4 = COM.priceFor('promotion_purchase', { productId: 'listing_boost_day', days: 3 });
  const a5 = await tryP(Promise.resolve().then(() => COM.priceFor('promotion_purchase', { productId: 'listing_boost_day', days: 31 })));
  const a6 = COM.priceFor('promotion_purchase', { productId: 'homepage_spotlight_7d', days: 1 });
  ck('A1 owner launch prices from ONE config: Growth 5,000 (browser price ignored); Boost 3 days = 900; Spotlight 12,000 for 7 days', a1.amountKES === 5000 && a1.amountCents === 500000 && a4.amountKES === 900 && a6.amountKES === 12000 && a6.meta.days === 7, { a1, a4, a6 });
  ck('A2 Enterprise not self-serve; unknown plan refused; boost over 30 days refused', !a2.ok && a2.code === 'failed-precondition' && !a3.ok && !a5.ok);
  ck('A3 prices: Starter 2,500 · Growth 5,000 · Pro 10,000 · Boost 300/day · Boost 7d 1,500 · Featured 7d 5,000 · Spotlight 7d 12,000',
    COM.PARTNER_PLANS.starter.priceKES === 2500 && COM.PARTNER_PLANS.pro.priceKES === 10000 && COM.PROMOTION_PRODUCTS.listing_boost_7d.priceKES === 1500 && COM.PROMOTION_PRODUCTS.category_featured_7d.priceKES === 5000);

  /* B */
  await F.db.collection('financialProviders').doc('m1').set({ name: 'Mama Sacco', institutionType: 'SACCO', listingStatus: 'approved' });
  await F.db.collection('financialProviders').doc('w1').set({ name: 'Gone Bank', institutionType: 'BANK', listingStatus: 'withdrawn' });
  const b1 = await tryP(COM.checkEligibility(F.db, 'partner_subscription', { planId: 'growth' }, 'w1'));
  const b2 = await tryP(COM.checkEligibility(F.db, 'promotion_purchase', { productId: 'listing_boost_7d', targetId: 'w1' }, 'm1'));
  const b3 = await tryP(COM.checkEligibility(F.db, 'partner_subscription', { planId: 'growth' }, 'm1'));
  ck('B1 withdrawn listing cannot buy; cannot promote someone else; approved partner eligible', !b1.ok && !b2.ok && b2.code === 'permission-denied' && b3.ok);

  /* C + D */
  await F.db.collection('subscriptions').doc('m1').set({ plan: 'marketplace_pro', status: 'active', hub: 'marketplace' });
  const d1 = await fulfil('fulfilPartnerSubscription', { ref: 'PI_1', uid: 'm1', amountKES: 5000, meta: { planId: 'growth' } });
  const d2 = await fulfil('fulfilPartnerSubscription', { ref: 'PI_1', uid: 'm1', amountKES: 5000, meta: { planId: 'growth' } });
  const ent = (await F.db.collection('entitlements').doc('m1__partner').get()).data();
  const mkt = (await F.db.collection('subscriptions').doc('m1').get()).data();
  ck('C1/D1 partner plan fulfilled ONCE (duplicate callback no-op); marketplace subscription untouched', d1.fulfilled && d2.already && ent.planId === 'growth' && ent.status === 'active' && mkt.plan === 'marketplace_pro' && keys('commercialFulfilments/').length === 1, { d1, d2, ent, mkt });
  const end1 = ent.expiresAt.toMillis();
  await F.db.runTransaction((tx) => COM.fulfilPartnerSubscription(tx, { ref: 'PI_2', uid: 'm1', amountKES: 5000, meta: { planId: 'growth' } }, { ...deps(), now: now + 5 * 86400000 }));   /* renew 5 days later */
  const ent2 = (await F.db.collection('entitlements').doc('m1__partner').get()).data();
  ck('D2 renewal extends from the current end (no days lost)', ent2.expiresAt.toMillis() === end1 + 30 * 86400000, { end1, end2: ent2.expiresAt.toMillis() });
  const d3 = await fulfil('fulfilPartnerSubscription', { ref: 'PI_3', uid: 'm1', amountKES: 100, meta: { planId: 'pro' } });
  ck('D3 amount does not match the plan price → review, entitlement unchanged', d3.review === true && (await F.db.collection('entitlements').doc('m1__partner').get()).data().planId === 'growth');

  /* E */
  const e1 = await fulfil('fulfilPromotion', { ref: 'PI_P1', uid: 'm1', amountKES: 1500, meta: { productId: 'listing_boost_7d' } });
  const e1b = await fulfil('fulfilPromotion', { ref: 'PI_P1', uid: 'm1', amountKES: 1500, meta: { productId: 'listing_boost_7d' } });
  const camp = (await F.db.collection('promotionCampaigns').doc('PI_P1').get()).data();
  ck('E1 campaign activates ONCE on verified payment (dated 7 days); partner plan and marketplace untouched', e1.fulfilled && e1b.already && camp.status === 'active' && camp.endAt.toMillis() - camp.startAt.toMillis() === 7 * 86400000 && (await F.db.collection('entitlements').doc('m1__partner').get()).data().planId === 'growth' && (await F.db.collection('subscriptions').doc('m1').get()).data().plan === 'marketplace_pro', camp);
  const e2 = await fulfil('fulfilPromotion', { ref: 'PI_P2', uid: 'w1', amountKES: 5000, meta: { productId: 'category_featured_7d' } });
  ck('E2 listing not approved at payment → campaign "review" (paid, NOT serving)', e2.review && (await F.db.collection('promotionCampaigns').doc('PI_P2').get()).data().status === 'review' && (await F.db.collection('promotionCampaigns').doc('PI_P2').get()).data().reviewReason === 'listing_not_approved');

  /* G — directory serving */
  await F.db.collection('financialProviders').doc('m2').set({ name: 'Another Sacco', institutionType: 'SACCO', listingStatus: 'approved' });
  await F.db.collection('financialProviders').doc('a0').set({ name: 'Aaa Sacco', institutionType: 'SACCO', listingStatus: 'approved' });
  const g1 = await call(null, { op: 'publicDirectory', types: ['SACCO'] });
  ck('G1 the paid boost ranks Mama Sacco first and marks it promoted (alphabetically it is not first)', g1.ok && g1.v.rows[0].partnerUid === 'm1' && g1.v.rows[0].promoted === true && g1.v.rows[0].label === 'Listed by SOKONI', g1.v && g1.v.rows.map((r) => r.name + (r.promoted ? '*' : '')));
  /* a browser-written "active" campaign without payment would still be a doc — but only the webhook creates them; prove caps: */
  for (let i = 0; i < 8; i++) await F.db.collection('promotionCampaigns').doc('X' + i).set({ status: 'active', placement: 'banking_hub_featured', targetId: 'm2', startAt: F.Timestamp.fromMillis(now - 1000 - i), endAt: F.Timestamp.fromMillis(now + 86400000) });
  const g2 = await call(null, { op: 'publicDirectory', types: ['SACCO'] });
  ck('G2 featured placement serves (featured flag) within its cap', g2.ok && g2.v.rows.find((r) => r.partnerUid === 'm2').featured === true, g2.v && g2.v.rows);
  await F.db.collection('promotionCampaigns').doc('PI_P1').update({ endAt: F.Timestamp.fromMillis(Date.now() - 1000) });   /* the 7-day boost has ended */
  const g3 = await call(null, { op: 'publicDirectory', types: ['SACCO'] });
  const entAfter = (await F.db.collection('entitlements').doc('m1__partner').get()).data();
  ck('E3 once the boost ended it is no longer promoted, while the partner plan is still active 8 days on (no longer promoted) while the partner plan stays active', g3.ok && g3.v.rows.find((r) => r.partnerUid === 'm1').promoted === false && COM.effectivePlan(entAfter, Date.now() + 8 * 86400000).active === true, g3.v && g3.v.rows.map((r) => r.name + (r.promoted ? '*' : '')));

  /* F — entitlement enforcement */
  ck('F1 expired plan → free base; unknown plan → base (never "everything")', COM.effectivePlan({ status: 'active', planId: 'growth', expiresAt: F.Timestamp.fromMillis(now - 1) }, now).planId === null && COM.effectivePlan({ status: 'active', planId: 'diamond', expiresAt: F.Timestamp.fromMillis(now + 1e9) }, now).unknownPlan === true && COM.effectivePlan(null).limits.maxProducts === 10);
  const f2 = await call('m2', { op: 'getWorkspace' });
  ck('F2 free partner sees the base plan and no analytics block', f2.ok && f2.v.plan.planId === null && f2.v.analytics === null, f2.v && f2.v.plan);
  const f3 = await call('m1', { op: 'getWorkspace' });
  ck('F3 Growth partner sees its plan and an analytics block', f3.ok && f3.v.plan.planId === 'growth' && f3.v.analytics !== null, f3.v && { plan: f3.v.plan, analytics: f3.v.analytics });
  await call('m2', { op: 'addTeamMember', email: 'a@x.ke', role: 'officer' });
  const f4 = await call('m2', { op: 'addTeamMember', email: 'b@x.ke', role: 'officer' });
  ck('F4 free base allows 1 team member; the 2nd is refused with an upgrade message', !f4.ok && /plan allows 1/.test(f4.msg), f4);
  const f5 = await call('m1', { op: 'getCommercial' });
  ck('F5 partner reads the catalogue (from the config), its plan and its campaigns', f5.ok && f5.v.catalogue.plans.length === 4 && f5.v.catalogue.promotions.length === 4 && f5.v.plan.planId === 'growth' && f5.v.campaigns.length === 1, f5.v && { plan: f5.v.plan, campaigns: f5.v.campaigns });

  /* admin */
  const h1 = await call('m1', { op: 'adminStopCampaign', campaignId: 'PI_P2', reason: 'x' });
  const h2 = await call('adm', { op: 'adminStopCampaign', campaignId: 'PI_P2', reason: 'Listing withdrawn; refund via refund authority' }, { admin: true });
  const h3 = await call('adm', { op: 'adminListCommercial', view: 'campaigns' }, { admin: true });
  ck('H1 only an admin stops a campaign; history kept (status stopped, row still listed)', !h1.ok && h2.ok && (await F.db.collection('promotionCampaigns').doc('PI_P2').get()).data().status === 'stopped' && h3.ok && h3.v.rows.some((r) => r.id === 'PI_P2' && r.status === 'stopped'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
