/* ══════════════════════════════════════════════════════════════════════════════
   ENTITLEMENT AUTHORITY — certification
   ══════════════════════════════════════════════════════════════════════════════
   The KASS incident is the regression test: a paid KES 499 `ai_starter` merchant
   received the FREE allowance of 10 while their subscription reported ACTIVE.

   Three mechanisms produced it, each sufficient alone:
     1. `ai_*` absent from the catalogue aliases -> paid plan resolved to FREE
     2. aiSubscriptions/{uid} is not subscriptions/{subId} -> sync never fired
     3. resolveSubscription() takes the FIRST source that hits and consults the
        AI store LAST, so the SmartPOS trial document SHADOWED the paid plan

   (3) is why fixing the alias alone would not have been enough. Every one is
   asserted here with the defect reconstructed, because an invariant test that
   cannot fail is not evidence.

   Emulator required for the resolution half:
     firebase emulators:exec --only firestore "node scripts/test-entitlement-authority.js"
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const catalog = require(path.join(ROOT, 'functions/subscription-catalog.js'));
/* The stale ceiling a counter may carry, and the entitled one — both read from
   the catalogue so this file defines no plan limits of its own. */
const FREE_LIMIT = catalog.PLANS.FREE.listingLimit;
const STARTER_LIMIT = catalog.PLANS.STARTER.listingLimit;

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nENTITLEMENT AUTHORITY — the KASS regression');
console.log('='.repeat(74));

head('1 - THE KASS REGRESSION: a paid ai_starter is no longer FREE');
const kass = catalog.entitlementFor({ status: 'active', plan: 'ai_starter' });
ck('an ACTIVE ai_starter resolves to STARTER', kass.plan === 'STARTER', kass.plan);
ck('...with 100 products, not 10', kass.listingLimit === 100, String(kass.listingLimit));
ck('...and reports ACTIVE consistently', kass.subscriptionStatus === 'ACTIVE');
/* The contradiction that made this invisible: status ACTIVE, entitlement FREE. */
ck('status and entitlement no longer contradict each other',
   !(kass.subscriptionStatus === 'ACTIVE' && kass.plan === 'FREE'));

head('2 - every AI plan resolves, not just the one that was reported');
const aiMap = { ai_free: 'FREE', ai_starter: 'STARTER', ai_pro: 'GROWTH', ai_enterprise: 'ENTERPRISE' };
Object.keys(aiMap).forEach((id) => {
  ck(id + ' -> ' + aiMap[id], catalog.resolve(id).id === aiMap[id], catalog.resolve(id).id);
});

head('3 - the completeness guard that stops the next catalogue doing this');
const unmapped = catalog.unmappedPlanIds(catalog.KNOWN_PLAN_IDS,
  ['free', 'seller_free', 'ai_free', 'FREE', 'trial']);
ck('no known production plan id falls to FREE by accident', unmapped.length === 0, unmapped.join(', ') || 'none');
/* MUTATION CONTROL: the guard must actually catch an unmapped id. */
ck('MC an invented plan id IS reported as unmapped',
   catalog.unmappedPlanIds(['ai_ultra_2027'], []).length === 1);
ck('MC ...and a legitimately-free id is NOT reported',
   catalog.unmappedPlanIds(['ai_free'], ['ai_free']).length === 0);
ck('MC ...while the same id unlisted WOULD be flagged if it did not resolve',
   catalog.unmappedPlanIds(['totally_unknown'], []).length === 1);

head('4 - a trial status is entitled, in both spellings');
ck("status 'trialing' is entitled", catalog.entitlementFor({ status: 'trialing', plan: 'ai_starter' }).plan === 'STARTER');
ck("status 'trial' is entitled too (ai-subscriptions spelling)",
   catalog.entitlementFor({ status: 'trial', plan: 'ai_starter' }).plan === 'STARTER');
ck('NC an EXPIRED subscription still falls to FREE',
   catalog.entitlementFor({ status: 'expired', plan: 'ai_starter' }).plan === 'FREE');
ck('NC ...and a CANCELLED one too',
   catalog.entitlementFor({ status: 'cancelled', plan: 'ai_starter' }).plan === 'FREE');
ck('...but neither reports ACTIVE',
   catalog.entitlementFor({ status: 'expired', plan: 'ai_starter' }).subscriptionStatus === 'INACTIVE');

head('5 - FINDING: the AI price and the catalogue price disagree');
/* Recorded, not silently reconciled. ai_starter is KES 499; catalogue STARTER is
   priceKES 99900. Mapping the ENTITLEMENT is correct and is what unblocks the
   merchant; what the plan should COST is a commercial decision, not a code one. */
ck('catalogue STARTER is priced at 99900', catalog.PLANS.STARTER.priceKES === 99900);
const aiSrc = require('fs').readFileSync(path.join(ROOT, 'functions/ai-subscriptions.js'), 'utf8');
const aiPrice = (aiSrc.match(/ai_starter:\s*\{\s*price:\s*(\d+)/) || [])[1];
ck('ai_starter is priced at 499 in its own catalogue', aiPrice === '499', 'KES ' + aiPrice);
/* The field is called priceKES but holds CENTS: 99900 is KES 999.00, matching
   sub-billing's seller_basic price:{monthly:99900}. A field named for one unit
   and holding another is how a pricing page ends up off by 100. */
ck('the catalogue field named priceKES actually holds CENTS',
   catalog.PLANS.STARTER.priceKES === 99900 &&
   /price:\{monthly:99900/.test(require('fs').readFileSync(path.join(ROOT, 'functions/sub-billing.js'), 'utf8')
     .replace(/\s+/g, '')), 'matches sub-billing seller_basic');
ck('...so Starter is KES 999 there against KES 499 for ai_starter',
   catalog.PLANS.STARTER.priceKES / 100 === 999 && Number(aiPrice) === 499,
   'KES 999 vs KES 499');
un('which price is commercially correct for Starter',
   'a pricing decision — entitlement mapped, price left alone');

/* ────────────────────────────────────────────────────────────────────────────
   PART B — resolution across stores, against real Firestore
   ──────────────────────────────────────────────────────────────────────────── */
(async () => {
  let admin = null;
  try {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-entitlements' });
    await admin.firestore().collection('_ping').doc('x').set({ ok: true });
  } catch (e) {
    head('6-10 - resolution across stores');
    un('the entire resolution half', 'emulator unavailable: ' + String((e && e.message) || e).slice(0, 60));
    console.log('\n' + '='.repeat(74));
    console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + (unproven + 1) + ' unproven');
    console.log('='.repeat(74) + '\n');
    process.exit(fail ? 1 : 0);
  }

  const EA = require(path.join(ROOT, 'functions/entitlement-authority.js'));
  const db = admin.firestore();
  const KASS = 'kassShopUid';

  /* THE EXACT SHAPE THAT BROKE: a SmartPOS free-trial document in subscriptions/
     AND a paid ai_starter in aiSubscriptions/. */
  const future = admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 86400000);
  await db.doc('subscriptions/' + KASS).set({
    merchantId: KASS, uid: KASS, hubType: 'seller', planId: 'seller_free',
    plan: 'trial', status: 'trialing', trial: true,
    trialEndsAt: future, currentPeriodEnd: future,
  });
  await db.doc('aiSubscriptions/' + KASS).set({
    uid: KASS, plan: 'ai_starter', status: 'active', billing: 'monthly',
    currentPeriodEnd: future,
  });

  head('6 - the paid plan is no longer SHADOWED by the free trial document');
  const eff = await EA.resolveEffective(KASS);
  ck('both subscription records were considered', eff.considered >= 2, String(eff.considered));
  ck('the PAID plan wins', eff.plan === 'STARTER', eff.plan + ' from ' + eff.resolvedFrom);
  ck('...resolved from the ai store', eff.resolvedFrom === 'ai', String(eff.resolvedFrom));
  ck('...with 100 products', eff.listingLimit === 100, String(eff.listingLimit));
  /* MUTATION CONTROL: first-hit semantics, the defect, reconstructed. */
  const firstHit = await require(path.join(ROOT, 'functions/subscription-core.js'))
    .resolveSubscription(KASS, {});
  ck('MC first-hit resolution still returns the FREE trial document',
     catalog.entitlementFor({ status: firstHit.status, plan: firstHit.tier || firstHit.plan }).plan === 'FREE',
     'source ' + firstHit.source);
  ck('MC ...which is exactly the 10-product allowance the merchant saw',
     catalog.entitlementFor({ status: firstHit.status, plan: firstHit.tier }).listingLimit === 10);
  ck('MC ...and the new authority disagrees with it, deliberately',
     eff.listingLimit !== 10);

  head('7 - one entitlement call, and the counter is read honestly');
  await db.doc('productCounters/' + KASS).set({ uid: KASS, count: 23, maxProducts: FREE_LIMIT });
  const ent = await EA.getMerchantEntitlement(KASS);
  ck('plan STARTER, status ACTIVE', ent.plan === 'STARTER' && ent.status === 'ACTIVE');
  ck('products 23 / 100', ent.limits.productsUsed === 23 && ent.limits.products === 100);
  ck('...remaining 77', ent.limits.productsRemaining === 77, String(ent.limits.productsRemaining));
  ck('the STALE maxProducts:10 on the counter did NOT win',
     ent.limits.products === 100, 'counter said 10');
  ck('can create a product', (await EA.canCreateProduct(KASS)).allowed === true);

  head('8 - the limit is enforced, and deletion frees capacity');
  await db.doc('productCounters/' + KASS).set({ uid: KASS, count: 100, maxProducts: STARTER_LIMIT });
  const atLimit = await EA.canCreateProduct(KASS);
  ck('at 100/100 creation is BLOCKED', atLimit.allowed === false && atLimit.reason === 'product-limit-reached');
  ck('...and the way out is stated, not left to support', !!atLimit.remedy, atLimit.remedy);
  await db.doc('productCounters/' + KASS).set({ uid: KASS, count: 99, maxProducts: STARTER_LIMIT });
  ck('after deleting one, creation is allowed again', (await EA.canCreateProduct(KASS)).allowed === true);
  ck('inventory-add uses the SAME authority',
     JSON.stringify(await EA.canAddInventory(KASS)) === JSON.stringify(await EA.canCreateProduct(KASS)));

  head('9 - EXISTING OVER-LIMIT products are never deleted or hidden');
  /* 80 products against a 50 plan: creation blocked, nothing destroyed. */
  await db.doc('productCounters/overLimitShop').set({ uid: 'overLimitShop', count: 80 });
  await db.doc('aiSubscriptions/overLimitShop').set({ uid: 'overLimitShop', plan: 'ai_starter', status: 'active', currentPeriodEnd: future });
  const over = await EA.getMerchantEntitlement('overLimitShop');
  ck('the merchant keeps all 80 visible in the count', over.limits.productsUsed === 80);
  ck('remaining is floored at 0, never negative', over.limits.productsRemaining === 20 || over.limits.productsRemaining === 0,
     String(over.limits.productsRemaining));
  const overCreate = await EA.canCreateProduct('overLimitShop');
  ck('creation is blocked only when used >= limit',
     overCreate.allowed === (80 < over.limits.products), 'used 80, limit ' + over.limits.products);
  ck('nothing in this module deletes or archives a product',
     !/delete\(|\.remove\(/.test(require('fs').readFileSync(path.join(ROOT, 'functions/entitlement-authority.js'), 'utf8')));

  head('10 - an unreadable count is NOT zero');
  await db.doc('aiSubscriptions/noCounter').set({ uid: 'noCounter', plan: 'ai_starter', status: 'active', currentPeriodEnd: future });
  const noCount = await EA.getMerchantEntitlement('noCounter');
  ck('a missing counter reports used = null', noCount.limits.productsUsed === null);
  ck('...and remaining = null, so a UI shows a dash, not 0', noCount.limits.productsRemaining === null);
  const blocked = await EA.canCreateProduct('noCounter');
  ck('creation fails CLOSED when the count cannot be read',
     blocked.allowed === false && blocked.reason === 'count-unavailable');
  ck('...but the merchant is asked to retry, not downgraded', blocked.plan === 'STARTER');

  head('11 - a trial is granted ONCE, ever');
  const T = 'trialUser';
  const st0 = await EA.trialState(T);
  ck('a fresh merchant is eligible', st0.eligible === true && st0.used === false);
  const g1 = await EA.startTrial(T, 'ai_starter', 14);
  ck('the trial is granted', g1.ok === true && g1.plan === 'STARTER');
  const g2 = await EA.startTrial(T, 'ai_starter', 14);
  ck('a SECOND trial is REFUSED', g2.ok === false && g2.reason === 'trial-already-used', g2.reason);
  const st1 = await EA.trialState(T);
  ck('the ledger records it as used', st1.used === true && st1.eligible === false);
  ck('...with days remaining', st1.daysRemaining > 0 && st1.daysRemaining <= 14, String(st1.daysRemaining));
  ck('the ledger is claimed with create(), so a double-tap cannot mint two',
     /\.create\(\{/.test(require('fs').readFileSync(path.join(ROOT, 'functions/entitlement-authority.js'), 'utf8')));
  /* A merchant already paying is not offered a trial. */
  const st2 = await EA.trialState(KASS);
  ck('a merchant on a PAID plan is not eligible for a trial',
     st2.eligible === false && st2.reason === 'already-on-a-paid-plan', st2.reason);

  head('12 - the purchase is never silently converted');
  const kEnt = await EA.getMerchantEntitlement(KASS);
  const pur = kEnt.purchase;
  ck('the entitlement records WHAT WAS BOUGHT', pur && pur.planId === 'ai_starter', pur && pur.planId);
  ck('...the price actually paid', pur && pur.pricePaidKES === 499, pur && ('KES ' + pur.pricePaidKES));
  ck('...the tier it maps to', pur && pur.mappedTier === 'STARTER');
  ck('...and that tier list price', pur && pur.tierPriceKES === 999, pur && ('KES ' + pur.tierPriceKES));
  ck('the price MISMATCH is named, not hidden', pur && pur.priceMatchesTier === false);
  ck('the source catalogue is named too', pur && pur.sourceCatalogue === 'ai-subscriptions');
  /* A plan we cannot price must report null, never a confident `false` — an
     unknown mismatch is not a known match. */
  await db.doc('aiSubscriptions/unknownPlanShop').set({ uid: 'unknownPlanShop', plan: 'seller_basic', status: 'active', currentPeriodEnd: future });
  const unk = (await EA.resolveEffective('unknownPlanShop')).purchase;
  ck('NC a plan absent from the AI catalogue reports priceMatchesTier null',
     unk && unk.priceMatchesTier === null && unk.pricePaidKES === null, JSON.stringify(unk && unk.sourceCatalogue));
  ck('NC ...while still naming the tier it mapped to', unk && unk.mappedTier === 'STARTER');

  head('13 - the merchant-facing panel says the right sentence');
  const P = require(path.join(ROOT, 'sokoni-plan-panel.js'));
  /* Back to the state a real merchant would be in. */
  await db.doc('productCounters/' + KASS).set({ uid: KASS, count: 23, maxProducts: FREE_LIMIT });
  const vKass = P.render(await EA.getMerchantEntitlement(KASS));
  ck('KASS reads as STARTER / Active', vKass.heading === 'Starter' && vKass.subheading === 'Active');
  ck('...products 23 / 100', vKass.products.text === '23 / 100', vKass.products.text);
  ck('...and add-product is offered', vKass.canAddProduct === true);
  /* Asserted on the STRUCTURE. A substring search for '"limit":10' matches
     '"limit":100' — the same collision that has bitten this repo four times now.
     The stale ceiling is productCounters.maxProducts:10; what must be true is
     that the panel took the ENTITLED limit instead. */
  ck('...with the entitled 100, not the stale counter ceiling of 10',
     vKass.products.limit === 100 && vKass.products.remaining === 77,
     'limit ' + vKass.products.limit + ', remaining ' + vKass.products.remaining);
  ck('NC and the stale ceiling really was 10 in the counter',
     (await db.doc('productCounters/' + KASS).get()).data().maxProducts === 10);

  head('13b - FREE, TRIAL and AT-LIMIT read correctly too');
  await db.doc('aiSubscriptions/freeShop').set({ uid: 'freeShop', plan: 'ai_free', status: 'active', currentPeriodEnd: future });
  await db.doc('productCounters/freeShop').set({ uid: 'freeShop', count: 4 });
  const vFree = P.render(await EA.getMerchantEntitlement('freeShop'));
  ck('FREE reads as Free / 4 / 10', vFree.heading === 'Free' && vFree.products.text === '4 / 10', vFree.products.text);
  ck('...and offers Upgrade', vFree.actions.some((a) => a.id === 'upgrade'));
  const vTrial = P.render({ plan: 'STARTER', label: 'Starter', status: 'ACTIVE',
    trial: { active: true, daysRemaining: 12, used: true }, limits: { products: 100, productsUsed: 5, productsRemaining: 95 }, features: {} });
  ck('TRIAL reads as Starter Trial / 12 days remaining',
     vTrial.heading === 'Starter Trial' && vTrial.subheading === '12 days remaining', vTrial.subheading);
  ck('...and offers Continue selling', vTrial.actions.some((a) => a.id === 'continue'));
  ck('a 1-day trial is singular, not "1 days"',
     P.render({ plan: 'STARTER', label: 'Starter', status: 'ACTIVE', trial: { active: true, daysRemaining: 1 },
       limits: {}, features: {} }).subheading === '1 day remaining');
  await db.doc('productCounters/' + KASS).set({ uid: KASS, count: 100, maxProducts: STARTER_LIMIT });
  const vFull = P.render(await EA.getMerchantEntitlement(KASS));
  ck('AT LIMIT says so in the merchant’s words',
     vFull.notice && /reached your Starter limit/.test(vFull.notice.text), vFull.notice && vFull.notice.text);
  ck('...offers Manage products AND Upgrade, not "contact support"',
     vFull.notice.actions.map((a) => a.id).join(',') === 'manage-products,upgrade');
  ck('...and add-product is withheld', vFull.canAddProduct === false);
  await db.doc('productCounters/' + KASS).set({ uid: KASS, count: 99, maxProducts: STARTER_LIMIT });
  const vAfter = P.render(await EA.getMerchantEntitlement(KASS));
  ck('after deleting one, 99 / 100 and add-product returns',
     vAfter.products.text === '99 / 100' && vAfter.canAddProduct === true, vAfter.products.text);
  const vUnknown = P.render(await EA.getMerchantEntitlement('noCounter'));
  ck('an unreadable count shows a dash, NEVER 0',
     vUnknown.products.text.indexOf('—') === 0 && vUnknown.products.used === null, vUnknown.products.text);
  ck('...and add-product is withheld rather than guessed', vUnknown.canAddProduct === false);

  head('14 - what is NOT proven');
  un('the KASS payment / webhook / renewal chain',
     'not traced; scripts/verify-kass-subscription.js runs it against production');
  un('that the live KASS account now resolves to STARTER',
     'needs production credentials — nothing here touched live data');
  const plSrc = require('fs').readFileSync(path.join(ROOT, 'functions/product-limit.js'), 'utf8');
  ck('the ceiling now re-syncs on an AI subscription change too',
     plSrc.indexOf('aiSubscriptions/{aiUid}') > -1 && plSrc.indexOf('onAiSubscriptionChangedSyncLimit') > -1);
  ck('...through the SAME handler, so the two cannot drift apart',
     (plSrc.split('_syncFromEvent(').length - 1) === 3, String(plSrc.split('_syncFromEvent(').length - 1));
  ck('...and product-limit resolves via resolveEffective, not first-hit',
     plSrc.indexOf('ea.resolveEffective(uid)') > -1);
  un('that the new trigger fires in production', 'not deployed');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})();
