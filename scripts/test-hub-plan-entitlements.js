#!/usr/bin/env node
'use strict';
/* ============================================================================
   Hub plan entitlements in the ONE subscription catalogue (2026-10-03; Food Gate 5, Fitness, every vertical)
     H1  no sub-billing hub plan resolves to FREE by accident (unmappedPlanIds over ALL of PLANS is empty)
     H2  restaurant_free/basic/pro → hubType 'food' (billingHubType 'restaurant') with their real tiers + features
     H3  entitlementFor(hub sub).hub carries the plan; lapsed → the hub's FREE plan (a known state); seller fields
         unchanged
     H4  requireFeature: allowed with limit; otherwise upgradeRequired {capability, feature, minTier, minPlanId}
         computed from the plan table (cheapest active plan that satisfies), never invented
     H5  limits: -1 unlimited; `needed` vs the limit; booleans
     H6  fail closed: unknown feature / hub / capability refused with a reason; another hub's plan grants nothing;
         no subscription = the hub's free plan
     H7  capability keys line up with the capability engine (feat/capability-engine-on-c7e26b6) when available
   NODE_PATH=<functions/node_modules> node scripts/test-hub-plan-entitlements.js
   ============================================================================ */
const path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'functions/subscription-catalog.js'));
const PLANS = require(path.join(ROOT, 'functions/sub-billing.js')).PLANS;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };

/* H1 */
const free = Object.values(PLANS).filter((p) => p.price && p.price.monthly === 0).map((p) => p.id);
const unmapped = C.unmappedPlanIds(Object.keys(PLANS), free);
ck('H1 every sub-billing plan id (' + Object.keys(PLANS).length + ') resolves to a real plan or a hub plan — none to FREE by accident', unmapped.length === 0, unmapped);

/* H2 */
const r = ['restaurant_free', 'restaurant_basic', 'restaurant_pro'].map(C.hubPlan);
ck('H2 restaurant_* → hubType food, billingHubType restaurant, tiers free/basic/pro, features from sub-billing',
  r.every((v) => v && v.hubType === 'food' && v.billingHubType === 'restaurant') && r.map((v) => v.tier).join() === 'free,basic,pro' && r[2].features.kds_integration === true && r[0].features.menu_items === 20, r);
ck('H2b seller / provider / generic ids are NOT hub plans (their own authorities)', ['seller_pro', 'provider_pro', 'pro', 'business', 'enterprise'].every((id) => C.hubPlan(id) === null));

/* H3 */
let e = C.entitlementFor({ plan: 'restaurant_pro', status: 'active' });
ck('H3a active Restaurant Pro → hub entitlement pro (was: silent FREE)', e.hub && e.hub.tier === 'pro' && e.hub.planId === 'restaurant_pro' && e.hub.entitled === true, e.hub);
e = C.entitlementFor({ plan: 'restaurant_pro', status: 'expired' });
ck('H3b lapsed → the hub\'s FREE plan (restaurant_free), subscribedPlanId kept', e.hub && e.hub.planId === 'restaurant_free' && e.hub.subscribedPlanId === 'restaurant_pro' && e.hub.entitled === false, e.hub);
const seller = C.entitlementFor({ plan: 'seller_pro', status: 'active' });
ck('H3c seller entitlement unchanged; hub = null for non-hub plans', seller.hub === null && seller.plan === C.resolve('seller_pro').id);

/* H4 */
let q = C.requireFeature({ plan: 'restaurant_basic', status: 'active' }, { hubType: 'food', feature: 'online_ordering', capability: 'FOOD_MENU' });
ck('H4a basic + online_ordering → allowed', q.allowed === true && q.tier === 'basic', q);
q = C.requireFeature({ plan: 'restaurant_basic', status: 'active' }, { hubType: 'food', feature: 'kds_integration', capability: 'KITCHEN' });
ck('H4b basic + kds_integration → upgradeRequired {KITCHEN, minTier pro, restaurant_pro}', q.allowed === false && q.upgradeRequired && q.upgradeRequired.capability === 'KITCHEN' && q.upgradeRequired.minTier === 'pro' && q.upgradeRequired.minPlanId === 'restaurant_pro' && q.upgradeRequired.currentTier === 'basic', q);
q = C.requireFeature(null, { hubType: 'restaurant', feature: 'online_ordering' });
ck('H4c no subscription → hub free plan → upgrade to basic (cheapest that offers it)', q.allowed === false && q.upgradeRequired.minPlanId === 'restaurant_basic' && q.upgradeRequired.currentTier === 'free', q);

/* H5 */
q = C.requireFeature({ plan: 'restaurant_free', status: 'active' }, { hubType: 'food', feature: 'menu_items', needed: 21 });
ck('H5a free: 21st menu item → upgradeRequired basic (limit 20)', q.allowed === false && q.upgradeRequired.minPlanId === 'restaurant_basic' && q.upgradeRequired.currentLimit === 20, q);
q = C.requireFeature({ plan: 'restaurant_pro', status: 'active' }, { hubType: 'food', feature: 'menu_items', needed: 5000 });
ck('H5b pro: -1 = unlimited', q.allowed === true && q.limit === -1, q);
q = C.requireFeature({ plan: 'restaurant_basic', status: 'active' }, { hubType: 'food', feature: 'menu_items', needed: 101 });
ck('H5c basic: 101st → pro', q.allowed === false && q.upgradeRequired.minTier === 'pro', q);

/* H6 */
ck('H6a unknown feature refused with a reason (never silently allowed)', C.requireFeature({ plan: 'restaurant_pro', status: 'active' }, { hubType: 'food', feature: 'teleport' }).reason === 'unknown_feature');
ck('H6b unknown hub refused', C.requireFeature({}, { hubType: 'spaceport', feature: 'x' }).reason === 'unknown_hub');
ck('H6c malformed capability refused', C.requireFeature({ plan: 'restaurant_pro', status: 'active' }, { hubType: 'food', feature: 'analytics', capability: 'kitchen; drop' }).reason === 'unknown_capability');
q = C.requireFeature({ plan: 'hotel_enterprise', status: 'active' }, { hubType: 'food', feature: 'analytics' });
ck('H6d a HOTEL plan grants nothing in FOOD (falls to the food free plan)', q.allowed === false && q.upgradeRequired.currentTier === 'free', q);

/* H7 */
let keys = null;
try { keys = cp.execSync('git show 13f74f3:functions/shared/service-capabilities.js', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (_) {}
if (keys) ck('H7 the food capability keys used by gates exist in the capability engine (13f74f3)', ['FOOD_MENU', 'KITCHEN', 'DRINKS', 'CATERING', 'BAKERY'].every((k) => new RegExp('\\b' + k + ':\\s*\\{ label').test(keys)));
else console.log('  N/A   H7 capability engine commit 13f74f3 not available in this clone');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
