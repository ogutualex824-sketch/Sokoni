/* ══════════════════════════════════════════════════════════════════════════════
   COMMISSION LANE SEPARATION — till 5%, marketplace 15%, and the trap between them
   ══════════════════════════════════════════════════════════════════════════════
   Brief §1: "Tests must prove POS/till sale -> 5%, marketplace/online order -> 15%,
   minimum KES 10. Do not apply marketplace commission to ordinary POS/till sales."

   THE THING THIS SUITE EXISTS FOR, which a naive rate check would miss entirely:

   THERE ARE TWO TILL COMMISSION PATHS, and only one of them uses POS_PLAN_RATES.

     TILL      posCompleteCheckout -> finos-utils.calculateCommission({category:'pos'})
                 -> commission-config.resolveRate('pos')
                 -> ALIASES.pos = 'marketplace'
                 -> RATES.marketplace.pct                      <-- 5
     DISPATCH  recordPOSSale -> pos-sale-commission.planSaleCommission
                 -> commission-config.resolvePosRate()
                 -> POS_PLAN_RATES                             <-- 5

   Both answer 5% today, by DIFFERENT mechanisms. So the sentence "the till is
   protected because resolvePosRate is independent" is only half true: the LIVE till
   path (posCompleteCheckout) does not read POS_PLAN_RATES at all. It reads the
   marketplace CATEGORY.

   CONSEQUENCE, and it is the whole point of this file: raising
   `RATES.marketplace.pct` to 15 to "align it with the online lane" would silently
   charge 15% on every till sale. The brief forbids that change; this suite makes the
   forbidding executable rather than advisory.

   Every rate is DERIVED from commission-config. No literal appears in an assertion —
   a literal here would be the time bomb this repo has already been burned by twice.

   Run: node scripts/test-commission-lane-separation.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs   = require('fs');
const CC   = require(path.join(ROOT, 'functions', 'commission-config.js'));

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS      ' : 'FAIL      ') + l + (d ? '   [' + String(d).slice(0, 110) + ']' : '')); ok ? pass++ : fail++; return ok; };
const up = (l, why) => { console.log('  UNPROVEN  ' + l + '\n              why: ' + why); unproven++; };
const head = t => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* ── The two lane rates, DERIVED ─────────────────────────────────────────────── */
const TILL_VIA_PLAN     = CC.resolvePosRate('seller_free').pct;         /* POS_PLAN_RATES  */
const TILL_VIA_CATEGORY = CC.resolveRate('pos').pct;                     /* ALIASES.pos     */
const MKT               = CC.resolveMarketplaceRate('free').pct;         /* the lane        */
const MKT_CATEGORY      = CC.resolveRate('marketplace').pct;             /* the fallback    */
const MIN_KES           = CC.MIN_COMMISSION_KES;

head('1. The two lanes answer different rates');
ck('till lane resolves a rate', Number.isFinite(TILL_VIA_PLAN), TILL_VIA_PLAN + '%');
ck('marketplace lane resolves a rate', Number.isFinite(MKT), MKT + '%');
ck('THE LANES ARE DIFFERENT — a till sale is not priced as a marketplace sale',
   TILL_VIA_PLAN !== MKT, 'till ' + TILL_VIA_PLAN + '% vs marketplace ' + MKT + '%');
ck('a platform minimum exists', Number.isFinite(MIN_KES), 'KES ' + MIN_KES);

head('2. The till is FLAT — a subscription buys nothing at the counter');
const TILL_PLANS = ['seller_free', 'seller_basic', 'seller_pro', 'seller_enterprise', '', 'bogus'];
ck('every plan pays the same till rate',
   TILL_PLANS.every(p => CC.resolvePosRate(p).pct === TILL_VIA_PLAN),
   TILL_PLANS.map(p => (p || '(none)') + '=' + CC.resolvePosRate(p).pct).join(' '));
ck('an unknown till plan never resolves cheaper than the known ones',
   CC.resolvePosRate('bogus').pct >= Math.min(...TILL_PLANS.map(p => CC.resolvePosRate(p).pct)));

head('3. The marketplace lane is flat too, and never under-quotes');
const MKT_PLANS = ['free', 'professional', 'business', 'enterprise', 'seller_free', 'seller_pro', '', 'bogus'];
ck('every plan pays the same marketplace rate',
   MKT_PLANS.every(p => CC.resolveMarketplaceRate(p).pct === MKT),
   MKT_PLANS.map(p => (p || '(none)') + '=' + CC.resolveMarketplaceRate(p).pct).join(' '));
ck('an unknown plan resolves to the HIGHEST rate, never a free pass',
   CC.resolveMarketplaceRate('bogus').pct >= Math.max(...MKT_PLANS.map(p => CC.resolveMarketplaceRate(p).pct)));
ck('retired seller_* ids still resolve to a real package (a stored tier must not fall through)',
   CC.resolveMarketplaceRate('seller_enterprise').matched === true &&
   CC.resolveMarketplaceRate('seller_free').matched === true);

head('4. THE TRAP — the live till path reads the MARKETPLACE CATEGORY');
/* This is the finding. `pos` is an ALIAS of `marketplace`, so resolveRate('pos') returns the
   marketplace CATEGORY row — which is what posCompleteCheckout's calculateCommission call
   lands on, because `pos` is deliberately NOT in MARKETPLACE_SELLER_CATEGORIES and therefore
   never reaches the marketplace LADDER. */
ck('resolveRate("pos") resolves THROUGH the marketplace category',
   CC.resolveRate('pos').category === 'marketplace', CC.resolveRate('pos').category);
ck('"pos" is NOT a marketplace SELLER sale — so the 15% ladder never applies to the till',
   CC.isMarketplaceSellerSale('pos') === false);
ck('  CONTROL — "marketplace" IS a marketplace seller sale', CC.isMarketplaceSellerSale('marketplace') === true);
ck('so the live till path lands on the category rate, not POS_PLAN_RATES',
   TILL_VIA_CATEGORY === MKT_CATEGORY,
   'resolveRate(pos)=' + TILL_VIA_CATEGORY + '% === RATES.marketplace.pct=' + MKT_CATEGORY + '%');
/* THE GUARD THE BRIEF ASKS FOR, made executable. */
ck('RATES.marketplace.pct still equals the till rate — raising it WOULD charge the till',
   MKT_CATEGORY === TILL_VIA_PLAN,
   'category ' + MKT_CATEGORY + '% vs POS_PLAN_RATES ' + TILL_VIA_PLAN + '% — if these diverge, ' +
   'the two till paths disagree and one of them is wrong');
ck('the marketplace LANE is above the category fallback (the lane is what an online order pays)',
   MKT > MKT_CATEGORY, 'lane ' + MKT + '% > category ' + MKT_CATEGORY + '%');

head('5. The client snapshot agrees with the server, lane by lane');
const SNAP = fs.readFileSync(path.join(ROOT, 'sokoni-commission-rates.js'), 'utf8');
const snapPos = Number((SNAP.match(/var\s+POS_FLAT_PCT\s*=\s*(\d+(?:\.\d+)?)/) || [])[1]);
const snapMin = Number((SNAP.match(/var\s+MIN_COMMISSION_KES\s*=\s*(\d+(?:\.\d+)?)/) || [])[1]);
const snapMkt = Number((SNAP.match(/MARKETPLACE_PLAN_PCT\s*=\s*\{[^}]*?"free"\s*:\s*(\d+(?:\.\d+)?)/) || [])[1]);
ck('snapshot till rate matches the server', snapPos === TILL_VIA_PLAN, snapPos + '% vs ' + TILL_VIA_PLAN + '%');
ck('snapshot marketplace rate matches the server', snapMkt === MKT, snapMkt + '% vs ' + MKT + '%');
ck('snapshot minimum matches the server', snapMin === MIN_KES, snapMin + ' vs ' + MIN_KES);

head('6. The minimum dominates small sales on BOTH lanes');
/* Arithmetic only — money-authority does the real computation; this asserts the POLICY that a
   floor exists and that no non-zero rate escapes it. */
const floorBites = (pct) => {
  const grossKES = 20;                                   /* a small sale */
  const raw = grossKES * (pct / 100);
  return raw < MIN_KES;
};
ck('a KES 20 till sale is dominated by the minimum', floorBites(TILL_VIA_PLAN),
   'KES ' + (20 * TILL_VIA_PLAN / 100).toFixed(2) + ' < KES ' + MIN_KES);
ck('a KES 20 marketplace sale is dominated by the minimum', floorBites(MKT),
   'KES ' + (20 * MKT / 100).toFixed(2) + ' < KES ' + MIN_KES);
const PLANS = CC.MARKETPLACE_PLAN_RATES || {};
ck('no non-zero marketplace plan escapes the floor',
   Object.keys(PLANS).every(k => PLANS[k].rateFraction === 0 || PLANS[k].floorExempt === false));
const POSP = CC.POS_PLAN_RATES || {};
ck('no non-zero till plan escapes the floor',
   Object.keys(POSP).every(k => POSP[k].rateFraction === 0 || POSP[k].floorExempt === false));

head('7. What a static suite cannot settle');
up('that a REAL till sale is charged the till rate end to end',
   'posCompleteCheckout calls finos-utils.calculateCommission, which reads commissionRules ' +
   'overrides, revenueConfig and commission holidays from Firestore — none of which exist in ' +
   'this process. The RESOLUTION path is proven above; the applied figure on a live order is ' +
   'not, and needs an emulator or a real order.');
up('that production charges these rates',
   'the rate is server-computed and functions are NOT deployed from this branch. The repo is ' +
   'self-consistent; production still charges whatever the last functions deploy shipped.');

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' UNPROVEN');
console.log('  Rates are DERIVED from commission-config. No literal is asserted anywhere above.');
process.exit(fail ? 1 : 0);
