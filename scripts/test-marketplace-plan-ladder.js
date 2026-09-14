#!/usr/bin/env node
/* Marketplace seller plan ladder — and the POS lane it must never touch.
 *
 *   node scripts/test-marketplace-plan-ladder.js
 *
 * OWNER RULING 2026-09-07
 *
 *     MARKETPLACE (online orders)   Free 15%  Basic 10%  Pro 5%  Enterprise 0%
 *     POS / TILL   (shop sales)     FLAT 5%, every plan
 *
 * They are separate commercial products. A subscription buys a smaller cut of the orders
 * SOKONI brings the merchant; it buys nothing on sales the merchant made themselves at their
 * own till.
 *
 * THE TRAP THIS SUITE EXISTS FOR
 * `ALIASES.pos = 'marketplace'`, so a POS sale RESOLVES to the marketplace category. Anything
 * keyed on the RESOLVED category therefore puts every till sale on the ladder and TRIPLES a
 * Free merchant's POS commission. The ladder is keyed on the RAW category instead, and `pos`
 * is deliberately absent from MARKETPLACE_SELLER_CATEGORIES. That absence is load-bearing and
 * is asserted here in both directions.
 *
 * The alias must ALSO survive, because it decides the SETTLEMENT TERM
 * (index.js `_is48hCommission` -> categoryForHub(hub) === 'marketplace'). Removing it to fix
 * pricing would move POS from a 48-hour obligation to monthly invoicing as a silent side
 * effect. Asserted here too.
 *
 * Drives the REAL calculateCommission against an in-memory Firestore — no emulator, no
 * credentials — so every number is the number the engine would actually charge.
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── In-memory Firestore: enough for calculateCommission ─────────────────── */
function makeDb(docs = {}) {
  const empty = { empty: true, docs: [], forEach() {} };
  return {
    collection(name) {
      return {
        doc(id) {
          return { async get() { const d = docs[`${name}/${id}`]; return d ? { exists: true, id, data: () => d } : { exists: false, id, data: () => undefined }; } };
        },
        where() { return this; },
        async get() {
          const rows = Object.entries(docs)
            .filter(([k]) => k.startsWith(name + '/'))
            .map(([k, v]) => ({ id: k.slice(name.length + 1), data: () => v }));
          /* commissionRules / commission_holiday must resolve to nothing in these fixtures —
             a stray rule would outrank the ladder and every assertion below would be vacuous. */
          if (name === 'commissionRules') return empty;
          return { empty: rows.length === 0, docs: rows, forEach(f) { rows.forEach(f); } };
        },
      };
    },
  };
}

/* Stub firebase-admin so finos-utils loads outside a function runtime. */
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') {
    return { firestore: Object.assign(() => ({}), { Timestamp: { now: () => ({ toMillis: () => Date.now() }) }, FieldValue: {} }) };
  }
  return orig.apply(this, arguments);
};
const FU = require(path.join(FN, 'finos-utils.js'));
const CC = require(path.join(FN, 'commission-config.js'));
Module.prototype.require = orig;

/* Seller plan fixture. `_resolveSellerPlan` reads the canonical Subscription Engine, so it is
   stubbed at that boundary rather than reimplemented here. */
/* The shape MUST match what _resolveSellerPlan actually consumes: it requires `found`, reads
   `features.commission_discount_pct`, and derives liveness from `subs.isActive(c.status)` —
   never from an `active` field on the object. An earlier version of this fixture omitted
   `found`, so every lookup returned null and the whole suite silently measured the Free rate.
   Control G1 is what caught it; keep that control. */
function withPlan(tier, active = true) {
  const subCore = require(path.join(FN, 'subscription-core.js'));
  subCore.resolveSubscription = async () => (tier
    ? { found: true, tier, planId: tier, status: active ? 'active' : 'expired', features: {} }
    : { found: false });
  subCore.isActive = (status) => status === 'active' || status === 'trialing';
}

const KES = (cents) => cents / 100;
const SELLER = 'SELLER_A_uid_7f3';       /* never equal to a shop id — see the 2A fixture */

(async () => {

console.log('\nPART A — the marketplace ladder, on the money\n');

const LADDER = [
  ['seller_free',       15, 150000],
  ['seller_basic',      10, 100000],
  ['seller_pro',         5,  50000],
  ['seller_enterprise',  0,      0],
];
for (const [tier, wantPct, wantCents] of LADDER) {
  withPlan(tier);
  const r = await FU.calculateCommission(makeDb(), {
    orderAmountCents: 1000000, category: 'product', sellerId: SELLER,   /* KES 10,000 */
  });
  ck(`A1  ${tier.padEnd(18)} -> ${wantPct}% on KES 10,000 = KES ${KES(wantCents)}`,
    r.effectiveRate === wantPct && r.commissionCents === wantCents,
    `got ${r.effectiveRate}% / ${r.commissionCents} cents`);
  ck(`A2  ${tier.padEnd(18)} records WHY it was priced that way`,
    r.marketplaceLadderApplied === true && r.marketplacePlan === tier
    && r.pricingSource === 'marketplace_plan_ladder',
    r.pricingSource + ' / ' + r.marketplacePlan);
}

{
  withPlan('seller_enterprise');
  const r = await FU.calculateCommission(makeDb(), {
    orderAmountCents: 1000000, category: 'product', sellerId: SELLER,
  });
  ck('A3  Enterprise 0% is genuinely zero — the KES 10 floor does NOT resurrect it',
    r.commissionCents === 0, r.commissionCents + ' cents');
}
{
  /* The floor is KEPT for marketplace sellers. A KES 97 sale at 15% is KES 14.55, above the
     floor; at Pro 5% it is KES 4.85 and the floor lifts it to KES 10. */
  withPlan('seller_pro');
  const r = await FU.calculateCommission(makeDb(), {
    orderAmountCents: 9700, category: 'product', sellerId: SELLER,
  });
  ck('A4  the KES 10 platform minimum still applies to a small marketplace sale',
    r.commissionCents === 1000, 'KES ' + KES(r.commissionCents));
}

console.log('\nPART B — no plan is not a discount\n');
for (const [label, tier, active] of [
  ['no subscription at all', null, true],
  ['expired subscription', 'seller_pro', false],
]) {
  withPlan(tier, active);
  const r = await FU.calculateCommission(makeDb(), {
    orderAmountCents: 1000000, category: 'product', sellerId: SELLER,
  });
  ck(`B1  ${label} -> Free 15%, the HIGHEST rate`,
    r.effectiveRate === 15 && r.marketplacePlan === 'seller_free',
    r.effectiveRate + '% / skipped=' + r.marketplacePlanSkipped);
}
{
  withPlan('seller_pro', false);
  const r = await FU.calculateCommission(makeDb(), {
    orderAmountCents: 1000000, category: 'product', sellerId: SELLER,
  });
  ck('B2  ...and it records that the plan was inactive, not absent',
    r.marketplacePlanSkipped === 'plan_inactive', r.marketplacePlanSkipped);
}

console.log('\nPART C — POS AND TILL ARE NOT ON THE LADDER (the whole point)\n');
for (const tier of ['seller_free', 'seller_basic', 'seller_pro', 'seller_enterprise']) {
  withPlan(tier);
  const r = await FU.calculateCommission(makeDb(), {
    orderAmountCents: 1000000, category: 'pos', sellerId: SELLER,
  });
  ck(`C1  POS on ${tier.padEnd(18)} -> flat 5% = KES 500`,
    r.effectiveRate === 5 && r.commissionCents === 50000,
    `got ${r.effectiveRate}% / KES ${KES(r.commissionCents)}`);
  ck(`C2  POS on ${tier.padEnd(18)} is recorded as lane-EXEMPT, not untiered`,
    r.marketplaceLadderApplied === false && r.commissionLane === 'pos',
    'ladder=' + r.marketplaceLadderApplied + ' lane=' + r.commissionLane);
}
{
  /* The specific regression: a Free merchant's till commission must NOT triple. */
  withPlan('seller_free');
  const pos = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'pos', sellerId: SELLER });
  const mkt = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'product', sellerId: SELLER });
  ck('C3  the SAME Free merchant pays 5% at the till and 15% online — separate products',
    pos.effectiveRate === 5 && mkt.effectiveRate === 15,
    `pos ${pos.effectiveRate}% / marketplace ${mkt.effectiveRate}%`);
}

console.log('\nPART D — the alias survives, so the settlement term does not move\n');
{
  ck('D1  categoryForHub("pos") is still "marketplace" (48h settlement term unchanged)',
    CC.categoryForHub('pos') === 'marketplace', CC.categoryForHub('pos'));
  ck('D2  ...while pos is NOT a ladder category', CC.isMarketplaceSellerSale('pos') === false);
  ck('D3  the two facts are genuinely independent — resolved vs RAW keying',
    CC.categoryForHub('pos') === CC.categoryForHub('product')
    && CC.isMarketplaceSellerSale('product') !== CC.isMarketplaceSellerSale('pos'));
}

console.log('\nPART E — precedence: an admin can still override a seller\n');
{
  withPlan('seller_free');
  const db = makeDb({ ['revenueConfig/seller_' + SELLER]: { commissionPct: 2 } });
  const r = await FU.calculateCommission(db, {
    orderAmountCents: 1000000, category: 'product', sellerId: SELLER,
  });
  ck('E1  revenueConfig for one seller outranks the ladder',
    r.effectiveRate === 2 && r.marketplaceLadderApplied === false,
    r.effectiveRate + '% via ' + r.pricingSource);
}
{
  withPlan('seller_pro');
  const r = await FU.calculateCommission(makeDb(), {
    orderAmountCents: 1000000, category: 'product', sellerId: SELLER,
  });
  ck('E2  the plan DISCOUNT step stands down — the ladder is not discounted twice',
    r.planApplied === false && r.planSkipped === 'marketplace_plan_rate_applied',
    'planApplied=' + r.planApplied + ' skipped=' + r.planSkipped);
}
{
  /* A non-marketplace category must be untouched by any of this. */
  withPlan('seller_pro');
  const r = await FU.calculateCommission(makeDb(), {
    orderAmountCents: 1000000, category: 'services', sellerId: SELLER,
  });
  ck('E3  a services sale is untouched by the marketplace ladder (15% category rate)',
    r.effectiveRate === 15 && r.marketplaceLadderApplied === false,
    r.effectiveRate + '% via ' + r.pricingSource);
}

console.log('\nPART F — the unit, and the single source\n');
{
  ck('F1  the config speaks FRACTIONS and the engine speaks PERCENT, consistently',
    CC.resolveMarketplaceRate('seller_free').rateFraction === 0.15
    && CC.resolveMarketplaceRate('seller_free').pct === 15);
  ck('F2  nobody is charged 1500% — a fraction never reaches the engine as a percent',
    (await (async () => {
      withPlan('seller_free');
      const r = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'product', sellerId: SELLER });
      return r.commissionCents < 1000000;
    })()));
  ck('F3  engineVersion bumped — the resolution ORDER changed',
    (await (async () => {
      withPlan('seller_pro');
      const r = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'product', sellerId: SELLER });
      return r.engineVersion >= 3;
    })()));
  ck('F4  POS lane and marketplace lane are DIFFERENT tables in the one sanctioned file',
    CC.resolvePosRate('seller_free').rateFraction === 0.05
    && CC.resolveMarketplaceRate('seller_free').rateFraction === 0.15
    && CC.resolvePosRate('seller_free').source !== CC.resolveMarketplaceRate('seller_free').source);
}

console.log('\nPART H — the browser must quote what the server charges\n');
{
  /* This platform has already shipped a hosting/functions split where sellers were SHOWN 3%
     and CHARGED 5%. Under a plan ladder the same split is worse: a Free seller shown 5% and
     charged 15% is out by a factor of three. The generated snapshot and the config are
     compared here for EVERY spelling a caller might pass, including the ones that must NOT
     resolve. */
  global.window = global.window || {};
  delete require.cache[require.resolve(path.join(ROOT, 'sokoni-commission-rates.js'))];
  require(path.join(ROOT, 'sokoni-commission-rates.js'));
  const S = global.window.SokoniCommission;

  ck('H1  the generated snapshot exposes the lane API',
    !!S && typeof S.marketplacePct === 'function' && typeof S.posPct === 'function');

  const spellings = ['seller_free', 'seller_basic', 'seller_pro', 'seller_enterprise',
    'free', 'basic', 'pro', 'enterprise', 'starter', 'business', 'nonsense', '', null];
  const mismatches = spellings.filter((p) => S.marketplacePct(p) !== CC.resolveMarketplaceRate(p).pct);
  ck('H2  browser and server agree on the marketplace rate for every plan spelling',
    mismatches.length === 0,
    mismatches.map((p) => p + ': ' + S.marketplacePct(p) + ' vs ' + CC.resolveMarketplaceRate(p).pct).join('; '));

  ck('H3  browser and server agree on the POS rate',
    S.posPct() === CC.resolvePosRate('seller_free').pct,
    S.posPct() + ' vs ' + CC.resolvePosRate('seller_free').pct);

  ck('H4  the browser also excludes POS from the ladder',
    S.isMarketplaceSellerSale('pos') === false && S.isMarketplaceSellerSale('product') === true);

  /* An unmapped tier must fail SAFE on both sides — to the highest rate, not the lowest. */
  ck('H5  an unmapped tier quotes the HIGHEST rate in the browser too',
    S.marketplacePct('business') === S.marketplacePct('seller_free'),
    String(S.marketplacePct('business')));
}

console.log('\nPART G — adversarial controls\n');
{
  /* If the fixture could not change the plan, every ladder assertion would be vacuous. */
  withPlan('seller_free');
  const a = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'product', sellerId: SELLER });
  withPlan('seller_pro');
  const b = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'product', sellerId: SELLER });
  ck('G1  the plan fixture actually moves the rate (not a fixed answer)',
    a.effectiveRate !== b.effectiveRate, a.effectiveRate + ' vs ' + b.effectiveRate);

  ck('G2  an unknown category is NOT silently laddered',
    CC.isMarketplaceSellerSale('zzz_not_a_category') === false);

  /* No sellerId means no plan can be resolved: it must fall to the category rate, never to
     the cheapest one. */
  const c = await FU.calculateCommission(makeDb(), { orderAmountCents: 1000000, category: 'product' });
  ck('G3  no sellerId -> category rate, never a free pass',
    c.marketplaceLadderApplied === false && c.commissionCents > 0,
    c.effectiveRate + '% / ' + c.commissionCents + ' cents');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
