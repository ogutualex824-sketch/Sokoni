'use strict';
/* Slice 6 — Premium catalogue consolidation (Billing + grant).
   Proves the two in-scope money-integrity fixes:
     1. GRANT: the forgeable client premium grant is gone. seller.js no longer
        writes/reads localStorage "sokoniPremiumPlan" or claims "Beta FREE"
        premium; the premium tab reflects the SERVER entitlement (SokoniAuthority)
        and upgrading routes to the real paid checkout. sokoni-sync.js no longer
        propagates the retired flag across devices.
     2. BILLING: hub-register.js no longer passes a CLIENT price to the gateway.
        The paid hub registration is priced by the server (createPaymentIntent,
        purpose 'hub_registration') against the application id, and the gateway
        receives the server figure + server reference.
   Regression: the subscription and Slice-5A boost server-intent paths are intact.
   All static/pure — no emulator. Run: node scripts/test-premium-catalogue-billing.js
*/
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'functions', 'payment-purposes.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  [PASS] ' + n); };
const no = (n, d) => { fail++; console.log('  [FAIL] ' + n + (d ? '  -> ' + d : '')); };

const seller = read('seller.js');
const sync   = read('sokoni-sync.js');
const hub    = read('hub-register.js');
const subs   = read('subscriptions.html');
const pay    = read('sokoni-pay.js');
const mkt    = read('marketing.html');

/* Isolate the seller.js premium block so a match elsewhere in the 5k-line file
   cannot mask a regression here. */
const premBlock = (seller.match(/function renderPremiumPlans\([\s\S]*?\n\}/) || [''])[0];
/* Isolate the hub-register paid path. */
const hubPaid = (hub.match(/If paid plan[\s\S]*?\n {4}\}/) || [''])[0];

/* ── 1. GRANT retired (seller.js) ─────────────────────────────────────────── */
(!/function activatePlan\s*\(/.test(seller)) ? ok('seller.js: activatePlan() is removed') : no('activatePlan still defined');
(!/window\.activatePlan\b/.test(seller)) ? ok('seller.js: window.activatePlan is removed') : no('window.activatePlan still exported');
(!/localStorage\.setItem\(\s*["']sokoniPremiumPlan/.test(seller)) ? ok('seller.js: no localStorage WRITE of sokoniPremiumPlan (grant gone)') : no('still writes the forgeable grant');
(!/localStorage\.getItem\(\s*["']sokoniPremiumPlan/.test(seller)) ? ok('seller.js: no localStorage READ of sokoniPremiumPlan (currentPlan not client-held)') : no('still reads the forgeable grant');
(/SokoniAuthority\.getMerchantEntitlements/.test(premBlock)) ? ok('seller.js: premium tab resolves the plan from the SERVER (SokoniAuthority)') : no('premium tab not server-resolved');
(/entitlements-changed/.test(premBlock)) ? ok('seller.js: premium tab re-renders on sokoni:entitlements-changed') : no('no live entitlement re-render');
(/location\.href='subscriptions\.html'|location\.href="subscriptions\.html"/.test(premBlock)) ? ok('seller.js: Upgrade routes to the real paid checkout (subscriptions.html)') : no('upgrade does not route to paid checkout');
(!/Beta FREE|Beta: FREE|currently FREE|All features unlocked|All premium features are active/.test(premBlock)) ? ok('seller.js: no fabricated "Beta FREE / all features unlocked" entitlement claim') : no('still fabricates a free-premium claim');

/* ── 1b. sokoni-sync.js no longer syncs the retired flag ──────────────────── */
(/'sokoniCampaigns'\s*,\s*'sokoniAds'/.test(sync)) ? ok("sokoni-sync.js: 'sokoniPremiumPlan' removed from the synced key list") : no('sokoniPremiumPlan still between the sync keys');
/* The only remaining mention must be inside a comment, never a live array entry. */
(!/^\s*'[^']*',\s*'sokoniPremiumPlan'|'sokoniPremiumPlan'\s*,\s*'sokoni/m.test(sync)) ? ok('sokoni-sync.js: no live array entry for sokoniPremiumPlan remains') : no('sokoniPremiumPlan still an array entry');

/* ── 2. BILLING: hub-register priced by the server ────────────────────────── */
(P.isRegistered('hub_registration')) ? ok('`hub_registration` is a registered server payment purpose') : no('hub_registration not registered');
(/createPaymentIntent'\)\([\s\S]*purpose:\s*'hub_registration'/.test(hubPaid)) ? ok('hub-register: paid path routes through createPaymentIntent(purpose:hub_registration)') : no('hub-register not routed through the server intent');
(/applicationId:\s*applicationId/.test(hubPaid)) ? ok('hub-register: the server prices against the applicationId (not a client field)') : no('applicationId not passed to the intent');
(/depositAmount:\s*_intent\.amount/.test(hubPaid) && /paymentIntentId:\s*_intent\.ref/.test(hubPaid)) ? ok('hub-register: gateway gets the SERVER amount + SERVER reference') : no('gateway not using server figures');
(!/var prices\s*=\s*\{[^}]*starter:\s*500/.test(hub)) ? ok('hub-register: the client price table { starter:500, pro:2000, enterprise:5000 } is GONE') : no('client price table still present');
(!/amount:\s*prices\[/.test(hub)) ? ok('hub-register: no client price is passed to the gateway') : no('client price still passed to gateway');
(/_showSuccess\(data,\s*appRef\s*&&\s*appRef\.id\)/.test(hub) && /function _showSuccess\(data,\s*applicationId\)/.test(hub)) ? ok('hub-register: the addDoc id is threaded through as the applicationId') : no('applicationId not threaded from addDoc');

/* ── 3. Regression: subscription + Slice-5A boost intents intact ──────────── */
(/createPaymentIntent'\)/.test(subs) && /planId:\s*planKey/.test(subs)) ? ok('subscriptions.html: server-priced subscribe path preserved (planId, no client amount)') : no('subscription intent path regressed');
(/purpose:\s*'boost'/.test(pay)) ? ok('sokoni-pay.js: Slice-5A boost intent preserved') : no('boost path regressed');
(/purpose:\s*'marketing_boost'/.test(mkt)) ? ok('marketing.html: Slice-5A marketing_boost intent preserved') : no('marketing boost path regressed');

/* ── 4. COMMISSION DECOUPLING — the invariant: subscriptions pay for CAPABILITIES;
      the single flat marketplace commission pays for the SALE; never charged twice. ── */
const subBilling = read('functions/sub-billing.js');
const subOS      = read('functions/subscription-os.js');
const checkout   = read('checkout.html');
const cfg        = read('functions/commission-config.js');
const plansData  = (subs.match(/const PLANS_DATA[\s\S]*?\n\];/) || [''])[0];

/* (a) subscription purchase ≠ sale commission: NO subscription plan table carries a commission rate/discount. */
(!/commission_discount_pct|commission_pct/.test(subBilling)) ? ok('INVARIANT: sub-billing plans carry NO commission field (no discount, no per-tier rate)') : no('sub-billing still carries a plan commission field');
(!/commissionPct/.test(subOS)) ? ok('INVARIANT: subscription-os MKT_PLANS carries no commissionPct') : no('MKT_PLANS still carries commissionPct');
(!/commission\s*:\s*[0-9]/.test(plansData)) ? ok('INVARIANT: subscriptions.html PLANS_DATA carries no per-tier commission') : no('PLANS_DATA still carries a commission field');
(!/plan-commission">\$\{p\.commission\}/.test(subs)) ? ok('subscriptions.html: the per-tier commission headline is no longer rendered') : no('per-tier commission still rendered');
(!/% platform commission/.test(subs)) ? ok('subscriptions.html: no "% platform commission" tier-feature copy') : no('tier commission feature copy remains');
(!/reduces commission|lower commission rate|Replaces per-transaction commission|pay lower commission/i.test(subs)) ? ok('subscriptions.html: no copy implying a subscription changes the sale commission') : no('subscription-changes-commission copy remains');

/* (b) marketplace sale still applies the SINGLE canonical commission ONCE, server-derived — untouched here.
   Assert the ACTIVE read is the server rate. (checkout.html's comment references the OLD plan-commission
   read historically; we match the live assignment, not the comment.) */
(/_commPct\s*=\s*Number\(_platformFeeRate\)/.test(checkout)) ? ok('INVARIANT: the marketplace SALE reads the server commission rate ONCE (never a plan commission)') : no('checkout does not read the server rate');
(/marketplace\s*:/.test(cfg)) ? ok('commission-config.js still defines the single canonical marketplace commission (engine untouched)') : no('canonical marketplace commission missing');

/* (c) no SECOND commission generated because of a subscription — the only wired coupling (the discount) is gone. */
(!/commission_discount_pct/.test(subBilling)) ? ok('INVARIANT: no subscription-based commission adjustment remains (flat rate regardless of plan)') : no('subscription commission adjustment still wired');

/* (d) subscription/package BILLING still works — capability + price fields survive the commission removal. */
(/seller_pro[\s\S]{0,220}monthly:\s*249900/.test(subBilling)) ? ok('subscription billing intact: sub-billing seller_pro price preserved') : no('plan price lost');
(/pro:\s*\{\s*price:\s*1499/.test(subOS)) ? ok('subscription-os: capability/price fields preserved (only commission dropped)') : no('MKT_PLANS price/capability lost');
(/listings:999/.test(plansData) && /Unlimited leads/.test(plansData)) ? ok('subscriptions.html: plan capabilities (listings/leads/features) preserved') : no('plan capabilities lost');

console.log('\n' + (fail === 0 ? `premium-catalogue-billing: PASS ${pass}/${pass}` : `premium-catalogue-billing: ${fail} FAIL of ${pass + fail}`));
process.exit(fail === 0 ? 0 : 1);
