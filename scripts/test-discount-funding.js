#!/usr/bin/env node
/* Discount funding — who pays for a discount  (Priority 3)
 *
 *   node scripts/test-discount-funding.js
 *
 * WHY THIS EXISTS
 * The settlement engine has always accepted `discountCents` + `discountFundedBy`
 * and handled them correctly. Neither production caller ever passed them:
 *
 *   order-settlement.js:59      computeSettlement(db, { grossCents, category, sellerId, hubId })
 *   settlement-executor.js:186  computeSettlement(db, { grossCents, category, sellerId,
 *                                                       gatewayFeeCents, deliveryFeeCents, riderId })
 *
 * so `discountCents` defaulted to 0, the platform-funded branch was unreachable, and
 * no PLATFORM_PROMOS entry was ever written. Because `grossCents` is derived from the
 * order total AFTER the discount, the seller absorbed 100% of every discount —
 * including loyalty points that SOKONI itself issued.
 *
 * Funding model (founder decision, 2026-08-15):
 *   loyalty redemption  → ALWAYS platform-funded. SOKONI issued the points.
 *   promo code          → the promo record's own `fundedBy`.
 *   no silent fallback that changes the economic meaning.
 *
 * Forward-only: settled orders are completed financial events and are never
 * recalculated.
 *
 * The rider is deliberately absent from most of this file. Delivery is split on a
 * SEPARATE path (onOrderStatusChange → deliveryFees) from `order.deliveryFee`, never
 * from the discounted total — free delivery to the buyer is not free delivery to the
 * rider. One test below pins that separation.
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SE = require(path.join(ROOT, 'functions', 'settlement-engine.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 72) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

/* Fake Firestore: enough for calculateCommission to resolve its default rules.
   It insists on a real-looking db (a past bug bound opts to db and silently earned
   the platform nothing), so the shape matters. */
const fakeDb = () => ({
  collection: () => ({
    doc: () => ({ get: async () => ({ exists: false, data: () => null }) }),
    where: function () { return this; },
    orderBy: function () { return this; },
    limit: function () { return this; },
    get: async () => ({ empty: true, docs: [], size: 0 }),
  }),
});

const KES = (c) => 'KES ' + (c / 100).toLocaleString();

(async () => {
  const db = fakeDb();

  /* A KES 10,000 order of goods. A KES 1,000 discount is applied, so the buyer pays
     KES 9,000 and `grossCents` — derived from the order total — is 900,000. */
  const FULL = 1000000, DISC = 100000, PAID = FULL - DISC;

  const base = { category: 'marketplace', sellerId: 'seller1', hubId: 'marketplace' };
  const run = (extra) => SE.computeSettlement(db, Object.assign({ grossCents: PAID }, base, extra));

  /* ══ 1 · baseline: no discount ══ */
  head('1 · no discount — the existing settlement is unchanged');
  const none = await SE.computeSettlement(db, Object.assign({ grossCents: FULL }, base));
  ck('seller nets gross minus commission',
     none.sellerNetCents === FULL - none.commission.cents,
     KES(none.sellerNetCents) + ' of ' + KES(FULL));
  ck('no promotion ledger entry', !none.ledgerPlan.some((e) => e.type === 'promotion'));
  ck('discount is recorded as zero', none.discount.cents === 0);
  const NO_DISC_SELLER = none.sellerNetCents;

  /* ══ 2 · seller-funded discount ══ */
  head('2 · seller-funded — the seller absorbs it');
  const sellerFunded = await run({ discountCents: DISC, discountFundedBy: 'seller' });
  ck('the seller basis is the DISCOUNTED amount',
     sellerFunded.sellerNetCents === PAID - sellerFunded.commission.cents,
     KES(sellerFunded.sellerNetCents));
  ck('the seller earns LESS than an undiscounted order',
     sellerFunded.sellerNetCents < NO_DISC_SELLER,
     KES(NO_DISC_SELLER - sellerFunded.sellerNetCents) + ' less');
  ck('the platform does NOT bear it — no promotion entry',
     !sellerFunded.ledgerPlan.some((e) => e.type === 'promotion'));
  ck('funding is recorded on the breakdown', sellerFunded.discount.fundedBy === 'seller');

  /* ══ 3 · platform-funded discount — THE DEFECT ══ */
  head('3 · platform-funded — the seller is made whole and SOKONI pays');
  const platformFunded = await run({ discountCents: DISC, discountFundedBy: 'platform' });

  /* The seller sold at full price as far as they are concerned. SOKONI gave the
     money away, so SOKONI funds the gap — not the merchant. */
  ck('the seller is MADE WHOLE (earns as if there were no discount)',
     platformFunded.sellerNetCents === NO_DISC_SELLER,
     KES(platformFunded.sellerNetCents) + ' vs ' + KES(NO_DISC_SELLER));
  ck('...which is MORE than the cash actually collected less commission',
     platformFunded.sellerNetCents > PAID - platformFunded.commission.cents);

  const promo = platformFunded.ledgerPlan.filter((e) => e.type === 'promotion');
  ck('a PLATFORM_PROMOS entry records the funding', promo.length === 1,
     promo[0] && promo[0].debitAccount + ' → ' + promo[0].creditAccount);
  ck('...for the exact discount amount', promo[0] && promo[0].amountCents === DISC,
     promo[0] && KES(promo[0].amountCents));
  ck('...debited to the promotions account', promo[0] && /promo/i.test(promo[0].debitAccount),
     promo[0] && promo[0].debitAccount);
  ck('the platform net absorbs the discount',
     platformFunded.platformNetCents < sellerFunded.platformNetCents,
     KES(sellerFunded.platformNetCents - platformFunded.platformNetCents) + ' borne');

  /* Cash actually received is the DISCOUNTED amount — the ledger must not claim the
     gateway handed over money it never did. */
  const paid = platformFunded.ledgerPlan.find((e) => e.type === 'payment_received');
  ck('payment_received still records only the cash actually collected',
     paid && paid.amountCents === PAID, paid && KES(paid.amountCents));

  /* ══ 4 · the ledger still balances ══ */
  head('4 · the ledger plan stays net-zero');
  [['no discount', none], ['seller-funded', sellerFunded], ['platform-funded', platformFunded]]
    .forEach(([label, b]) => {
      const bal = {};
      b.ledgerPlan.forEach((e) => {
        bal[e.debitAccount] = (bal[e.debitAccount] || 0) - e.amountCents;
        bal[e.creditAccount] = (bal[e.creditAccount] || 0) + e.amountCents;
      });
      const net = Object.values(bal).reduce((s, v) => s + v, 0);
      ck(label + ': debits equal credits', net === 0, 'net ' + net);
      ck(label + ': every entry has both accounts and a positive amount',
         b.ledgerPlan.every((e) => e.debitAccount && e.creditAccount && e.amountCents > 0));
    });

  /* ══ 5 · loyalty is platform-funded ══ */
  head('5 · loyalty redemption is platform-funded');
  const loyalty = await run({ discountCents: DISC, discountFundedBy: 'platform' });
  ck('a loyalty redemption makes the seller whole', loyalty.sellerNetCents === NO_DISC_SELLER);
  ck('...and SOKONI records the funding',
     loyalty.ledgerPlan.some((e) => e.type === 'promotion' && e.amountCents === DISC));
  /* An unknown/absent funder must never silently become "seller" — that would move
     money away from the merchant on a typo. */
  const unknownFunder = await run({ discountCents: DISC, discountFundedBy: 'nonsense' });
  ck('an unrecognised funder does NOT default to the seller',
     unknownFunder.discount.fundedBy === 'platform', unknownFunder.discount.fundedBy);

  /* ══ 6 · 100% platform-funded goods discount ══ */
  head('6 · a 100% platform-funded discount does not zero the seller');
  const freeGoods = await SE.computeSettlement(db, Object.assign(
    { grossCents: 0, discountCents: FULL, discountFundedBy: "platform" }, base));
  ck('the seller still earns on the full goods value',
     freeGoods.sellerNetCents === NO_DISC_SELLER,
     KES(freeGoods.sellerNetCents));
  ck('...and is NOT zero', freeGoods.sellerNetCents > 0);
  ck('SOKONI funds the entire amount',
     freeGoods.ledgerPlan.some((e) => e.type === 'promotion' && e.amountCents === FULL));

  /* ══ 7 · the rider is untouched by any of this ══ */
  head('7 · delivery / rider payout is independent of discount funding');
  const DELIV = 30000;
  const withRider = await SE.computeSettlement(db, Object.assign(
    { grossCents: PAID, deliveryFeeCents: DELIV, riderId: 'rider1',
      discountCents: DISC, discountFundedBy: 'platform' }, base));
  const noDiscRider = await SE.computeSettlement(db, Object.assign(
    { grossCents: FULL, deliveryFeeCents: DELIV, riderId: 'rider1' }, base));
  ck('the rider is paid the SAME with or without a discount',
     withRider.delivery.riderNetCents === noDiscRider.delivery.riderNetCents,
     KES(withRider.delivery.riderNetCents));
  ck('...derived from the delivery fee, not the discounted total',
     withRider.delivery.riderNetCents > 0 && withRider.delivery.feeCents === DELIV);
  const riderLine = withRider.ledgerPlan.find((e) => e.type === 'delivery_fee');
  ck('the rider ledger entry is unchanged',
     riderLine && riderLine.amountCents === withRider.delivery.riderNetCents);
  ck('a seller-funded discount also leaves the rider untouched',
     (await SE.computeSettlement(db, Object.assign(
       { grossCents: PAID, deliveryFeeCents: DELIV, riderId: 'rider1',
         discountCents: DISC, discountFundedBy: 'seller' }, base))).delivery.riderNetCents
     === noDiscRider.delivery.riderNetCents);

  /* ══ 8 · the platform's true cost is not hidden ══
     _int() floors at zero, which reported platformNet = 0 for an order that actually
     cost SOKONI money. Unreachable before funding was wired (discountCents was always
     0); reachable now, and the figure someone would use to price a campaign. */
  head('8 · a campaign that costs more than it earns reports a NEGATIVE platform net');
  const expensive = await run({ discountCents: DISC, discountFundedBy: 'platform' });
  ck('platform net is negative, not floored to zero',
     expensive.platformNetCents < 0, KES(expensive.platformNetCents));
  ck('...and equals commission minus the funded discount',
     expensive.platformNetCents === expensive.platformGrossCents - DISC,
     KES(expensive.platformGrossCents) + ' − ' + KES(DISC));
  const profitable = await SE.computeSettlement(db, Object.assign({ grossCents: FULL }, base));
  ck('an ordinary order still reports a positive net', profitable.platformNetCents > 0,
     KES(profitable.platformNetCents));
  ck('seller payout is never negative (only the platform net may be)',
     expensive.sellerNetCents > 0 && expensive.delivery.riderNetCents >= 0);

  /* ══ 9 · the ORDER SHAPE resolves funding correctly ══
     order-settlement._platformFundedDiscountCents is what production actually calls;
     the engine cases above prove the maths, this proves the plumbing. */
  head('9 · order → platform-funded slice');
  const OS = require(path.join(ROOT, 'functions', 'order-settlement.js'));
  const slice = OS._internal && OS._internal._platformFundedDiscountCents;
  if (typeof slice !== 'function') {
    ck('order-settlement exposes the resolver for testing', false, 'not exported');
  } else {
    ck('no discount block (order placed before this shipped) → 0 — FORWARD-ONLY',
       slice({}) === 0);
    ck('an empty discount block → 0', slice({ discount: {} }) === 0);
    ck('loyalty alone is platform-funded',
       slice({ discount: { loyaltyCents: 5000 } }) === 5000);
    ck('a platform-funded promo counts',
       slice({ discount: { promoCents: 4000, promoFundedBy: 'platform' } }) === 4000);
    ck('a SELLER-funded promo does NOT count (the seller absorbs it)',
       slice({ discount: { promoCents: 4000, promoFundedBy: 'seller' } }) === 0);
    ck('loyalty is still platform-funded even beside a seller-funded promo',
       slice({ discount: { loyaltyCents: 5000, promoCents: 4000, promoFundedBy: 'seller' } }) === 5000);
    ck('both platform-funded sum together',
       slice({ discount: { loyaltyCents: 5000, promoCents: 4000, promoFundedBy: 'platform' } }) === 9000);
    ck('a MISSING funder does not default to seller (no silent money move)',
       slice({ discount: { promoCents: 4000 } }) === 4000);
    ck('a malformed funder does not default to seller',
       slice({ discount: { promoCents: 4000, promoFundedBy: 'nonsense' } }) === 4000);
    ck('negative or junk amounts cannot manufacture a credit',
       slice({ discount: { loyaltyCents: -9999, promoCents: 'abc' } }) === 0);
  }

  console.log('\n' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
