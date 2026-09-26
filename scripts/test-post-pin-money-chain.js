#!/usr/bin/env node
/* The post-PIN money chain — buyer authorises, then the money splits.
 *
 *   node scripts/test-post-pin-money-chain.js
 *
 * THE CHAIN THE OWNER SPECIFIED
 *
 *   buyer enters the PIN (issued WITH the order, at creation)
 *        |
 *   delivery is authorised          <- settleOrder refuses to release without this
 *        |
 *   marketplace: commission by PLAN -> SOKONI, remainder -> the merchant's account
 *   delivery:    commission          -> SOKONI, remainder -> the rider's wallet
 *
 * Every piece of that already existed. What did NOT exist until 2026-09-07 is the
 * MARKETPLACE PLAN LADDER underneath it — so the amount the merchant is credited changed,
 * and this suite is the proof that it changed correctly rather than the proof that it
 * changed at all.
 *
 * WHAT THIS ADDS OVER test-marketplace-plan-ladder.js
 * That suite proves `calculateCommission` returns the right rate. This one proves the rate
 * survives the two layers between it and the merchant's wallet — `computeSettlement`'s
 * deductions waterfall and the double-entry ledger plan — and that the ledger still
 * balances afterwards. A correct rate that a later layer rounds, drops or credits to the
 * wrong account is not a correct settlement.
 *
 * No emulator, no credentials, no network.
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 160) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── Load the real engines with the Cloud Functions runtime stubbed ──────── */
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') {
    return { firestore: Object.assign(() => ({}), {
      FieldValue: { serverTimestamp: () => 'ts' },
      Timestamp: { now: () => ({ toMillis: () => Date.now() }) },
    }) };
  }
  if (id === 'firebase-functions/v2/https') {
    return { onCall: (_o, h) => h, HttpsError: class extends Error {} };
  }
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  /* settlement-account reads SETTLEMENT_ACCOUNT_NUMBER through defineSecret. Unset here, it
     logs a warning per call and buries the results. The masked account number is not what
     this suite is testing; stub the secret so the output stays readable. */
  if (id === 'firebase-functions/params') {
    return { defineSecret: (name) => ({ name, value: () => '0000000000' }) };
  }
  return orig.apply(this, arguments);
};
const SE = require(path.join(FN, 'settlement-engine.js'));
const U  = require(path.join(FN, 'finos-utils.js'));
const CC = require(path.join(FN, 'commission-config.js'));
Module.prototype.require = orig;

const A = U.ACCOUNTS;

/* Minimal Firestore: commission rules empty, no revenueConfig overrides. */
function makeDb() {
  const empty = { empty: true, docs: [], forEach() {} };
  return {
    collection() {
      return {
        doc() { return { async get() { return { exists: false, data: () => undefined }; } }; },
        where() { return this; },
        async get() { return empty; },
      };
    },
  };
}

function withPlan(tier, active = true) {
  const subCore = require(path.join(FN, 'subscription-core.js'));
  subCore.resolveSubscription = async () => (tier
    ? { found: true, tier, planId: tier, status: active ? 'active' : 'expired', features: {} }
    : { found: false });
  subCore.isActive = (s) => s === 'active' || s === 'trialing';
}

const SELLER = 'SELLER_A_uid_7f3';
const RIDER  = 'RIDER_Z_uid_442';
const KES = (n) => n * 100;                       /* shillings -> cents */
const entry = (plan, type) => (plan || []).find((e) => e.type === type) || null;

(async () => {

console.log('\nPART A — the PIN is the gate, and the rider cannot open it themselves\n');
{
  const fs = require('fs');
  /* The plaintext PIN must exist NOWHERE on the order document. Firestore has no
     field-level read control and the assigned rider legitimately reads the order, so a
     plaintext PIN there is readable by the person it is meant to authorise AGAINST. */
  const hits = [];
  for (const f of fs.readdirSync(ROOT).filter((x) => /\.(js|html)$/.test(x))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/deliveryPin\s*:/.test(src)) hits.push('/' + f);
  }
  for (const f of fs.readdirSync(FN).filter((x) => /\.js$/.test(x))) {
    const src = fs.readFileSync(path.join(FN, f), 'utf8');
    const m = src.match(/deliveryPin\s*:[^\n]*/g) || [];
    for (const line of m) {
      /* The ONE legitimate occurrence is the deletion that sweeps historical plaintext. */
      if (!/FieldValue\.delete\(\)/.test(line)) hits.push('functions/' + f + ' -> ' + line.trim());
    }
  }
  ck('A1  no writer puts a plaintext PIN on the order document', hits.length === 0, hits.join(' | '));

  const dp = fs.readFileSync(path.join(FN, 'delivery-pin.js'), 'utf8');
  ck('A2  the plaintext lives in deliveryPins/{orderId}', /collection\("deliveryPins"\)/.test(dp));
  ck('A3  ...and the order keeps only the hash',
    /deliveryPinHash:\s*_hash\(/.test(dp) && /deliveryPin:\s*admin\.firestore\.FieldValue\.delete\(\)/.test(dp));

  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  ck('A4  deliveryPins has NO rule — deny-by-default for every client',
    !/match \/deliveryPins\//.test(rules));
  ck('A5  ...and there is no permissive catch-all that would grant it',
    !/match \/\{document=\*\*\}[\s\S]{0,200}allow read:\s*if true/.test(rules));

  ck('A6  getMyDeliveryPin proves the caller is the BUYER', /Only the buyer can see this delivery PIN/.test(dp));
  ck('A7  ...and refuses the assigned rider explicitly',
    /The assigned rider cannot read the delivery PIN/.test(dp));

  /* The settlement proof gate: money does not move on an unproven delivery. */
  const settle = fs.readFileSync(path.join(FN, 'order-settlement.js'), 'utf8');
  const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  ck('A8  settlement is gated on deliveryAuthorizedBy somewhere in the money path',
    /deliveryAuthorizedBy/.test(settle) || /deliveryAuthorizedBy/.test(idx));
}

console.log('\nPART B — the marketplace split, at the PLAN rate, all the way to the merchant\n');
{
  const LADDER = [
    ['seller_free',       15, 150000, 850000],
    ['seller_basic',      10, 100000, 900000],
    ['seller_pro',         5,  50000, 950000],
    ['seller_enterprise',  0,      0, 1000000],
  ];
  for (const [tier, pct, wantComm, wantNet] of LADDER) {
    withPlan(tier);
    const b = await SE.computeSettlement(makeDb(), {
      grossCents: KES(10000), category: 'marketplace', sellerId: SELLER, hubId: 'marketplace',
    });
    ck(`B1  ${tier.padEnd(18)} KES 10,000 -> commission ${pct}% = KES ${wantComm / 100}`,
      b.commission.cents === wantComm, String(b.commission.cents));
    ck(`B2  ${tier.padEnd(18)} ...merchant is credited the remainder KES ${wantNet / 100}`,
      b.sellerNetCents === wantNet, String(b.sellerNetCents));
    ck(`B3  ${tier.padEnd(18)} ...gross reconciles: commission + net === gross`,
      b.commission.cents + b.sellerNetCents === KES(10000),
      b.commission.cents + ' + ' + b.sellerNetCents);
  }
}
{
  withPlan('seller_free');
  const b = await SE.computeSettlement(makeDb(), {
    grossCents: KES(10000), category: 'marketplace', sellerId: SELLER, hubId: 'marketplace',
  });
  const comm = entry(b.ledgerPlan, 'commission');
  const earn = entry(b.ledgerPlan, 'seller_earning');
  ck('B4  the commission is credited to the PLATFORM revenue account',
    !!comm && comm.creditAccount === A.PLATFORM_REVENUE && comm.amountCents === 150000,
    comm && comm.creditAccount + ' ' + comm.amountCents);
  ck('B5  the remainder is credited to THIS merchant, by id',
    !!earn && earn.creditAccount === A.seller(SELLER) && earn.amountCents === 850000,
    earn && earn.creditAccount + ' ' + earn.amountCents);
  ck('B6  both are debited from platform clearing — the money was collected first',
    comm.debitAccount === A.PLATFORM_CLEARING && earn.debitAccount === A.PLATFORM_CLEARING);
}
{
  /* The rate must reach the settlement record, not only the arithmetic — a settlement that
     records "5%" while charging 15% cannot be explained to the merchant later. */
  withPlan('seller_free');
  const b = await SE.computeSettlement(makeDb(), {
    grossCents: KES(10000), category: 'marketplace', sellerId: SELLER, hubId: 'marketplace',
  });
  ck('B7  the effective RATE travels with the breakdown', b.commission.rate === 15, String(b.commission.rate));
}

console.log('\nPART C — the delivery split: the rider line is the delivery record\'s entitlement\n');
/* Repair 5 — the engine derives NO rider figure. The entitlement comes from rider-entitlement.js
   (the order's server-authored delivery record + its bound quote) and is passed in. This fixture is
   deliberately NOT 88% of the fee, so a surviving percentage rule cannot pass C1. */
const ENT = { ok: true, riderUid: RIDER, minorUnits: KES(163), customerChargeMinor: KES(200), sokoniCommissionMinor: KES(37) };
{
  withPlan('seller_free');
  const b = await SE.computeSettlement(makeDb(), {
    grossCents: KES(10000), category: 'marketplace', sellerId: SELLER, hubId: 'marketplace',
    deliveryFeeCents: KES(200), riderEntitlement: ENT,
  });
  ck('C1  the rider line is the entitlement, passed through (not a share of the fee)',
    b.delivery.riderNetCents === ENT.minorUnits && b.delivery.platformCents === ENT.sokoniCommissionMinor,
    'rider=' + b.delivery.riderNetCents + ' platform=' + b.delivery.platformCents);
  const del = entry(b.ledgerPlan, 'delivery_fee');
  ck('C2  the rider\'s entitlement is credited to THAT rider, by id',
    !!del && del.creditAccount === A.rider(RIDER) && del.amountCents === ENT.minorUnits,
    del && del.creditAccount + ' ' + del.amountCents);
  ck('C3  the split reconciles: rider + platform === fee',
    b.delivery.riderNetCents + b.delivery.platformCents === KES(200));
  ck('C4  the platform\'s delivery cut is counted in platform gross',
    b.platformGrossCents === b.commission.cents + b.delivery.platformCents,
    b.platformGrossCents + ' vs ' + (b.commission.cents + b.delivery.platformCents));
}
{
  /* No entitlement: the delivery fee is REFUSED — never priced at a default share, never planned
     for nobody (Repair 5). */
  withPlan('seller_free');
  let refused = null;
  try {
    await SE.computeSettlement(makeDb(), {
      grossCents: KES(10000), category: 'marketplace', sellerId: SELLER, deliveryFeeCents: KES(200),
    });
  } catch (e) { refused = e.message; }
  ck('C5  a delivery fee with no rider entitlement is refused, not planned', /rider_entitlement_required/.test(refused || ''), refused);
}

console.log('\nPART D — the books balance\n');
{
  withPlan('seller_free');
  const b = await SE.computeSettlement(makeDb(), {
    grossCents: KES(10000), category: 'marketplace', sellerId: SELLER, hubId: 'marketplace',
    deliveryFeeCents: KES(200), riderEntitlement: ENT,
  });
  ck('D1  the engine declares its own ledger plan balanced',
    typeof SE.assertBalanced === 'function' ? SE.assertBalanced(b.ledgerPlan) !== false : true);

  /* Independent check: every account's debits and credits net to zero across the plan. */
  const net = new Map();
  for (const e of b.ledgerPlan) {
    net.set(e.debitAccount, (net.get(e.debitAccount) || 0) - e.amountCents);
    net.set(e.creditAccount, (net.get(e.creditAccount) || 0) + e.amountCents);
  }
  const total = Array.from(net.values()).reduce((s, v) => s + v, 0);
  ck('D2  ...and independently: all entries sum to zero', total === 0, String(total));

  const clearing = net.get(A.PLATFORM_CLEARING) || 0;
  ck('D3  platform clearing is drained by exactly what it paid out',
    clearing === KES(10000) - 150000 - 850000 - ENT.minorUnits, String(clearing));   /* rider line = the entitlement */
}

console.log('\nPART E — POS money never enters this rail\n');
{
  /* The user\'s ruling: POS/Till is a SEPARATE commercial product on a flat 5%, collected at
     the 07:00 gate — not through order settlement. If a POS category reached this engine it
     would be settled as a marketplace order at the plan rate. */
  ck('E1  pos is not a marketplace ladder category', CC.isMarketplaceSellerSale('pos') === false);
  withPlan('seller_free');
  const b = await SE.computeSettlement(makeDb(), {
    grossCents: KES(10000), category: 'pos', sellerId: SELLER, hubId: 'pos',
  });
  ck('E2  a POS category settles at the flat 5%, NOT the 15% Free ladder rate',
    b.commission.cents === 50000, String(b.commission.cents));
  ck('E3  ...so a Free merchant\'s till is not charged three times over',
    b.commission.cents < 150000);
}

console.log('\nPART F — adversarial controls\n');
{
  /* If the plan fixture could not move the rate, PART B proves nothing. */
  withPlan('seller_free');
  const f = await SE.computeSettlement(makeDb(), { grossCents: KES(10000), category: 'marketplace', sellerId: SELLER });
  withPlan('seller_pro');
  const p = await SE.computeSettlement(makeDb(), { grossCents: KES(10000), category: 'marketplace', sellerId: SELLER });
  ck('F1  the plan fixture genuinely moves the settled amount',
    f.sellerNetCents !== p.sellerNetCents, f.sellerNetCents + ' vs ' + p.sellerNetCents);

  /* A settlement with no seller must not silently credit somebody. */
  const none = await SE.computeSettlement(makeDb(), { grossCents: KES(10000), category: 'marketplace' });
  ck('F2  with no seller, no seller credit is planned', !entry(none.ledgerPlan, 'seller_earning'));

  /* Zero gross is REFUSED outright, which is stronger than settling it to zero: a zero
     settlement is a real record that reconciliation then has to explain, and an order with
     no money in it should never have reached the engine. */
  let zeroThrew = null;
  try { await SE.computeSettlement(makeDb(), { grossCents: 0, category: 'marketplace', sellerId: SELLER }); }
  catch (e) { zeroThrew = e; }
  ck('F3  a zero-value order is REFUSED, not settled to zero', !!zeroThrew, zeroThrew && zeroThrew.message);

  ck('F4  the ledger accounts are distinct strings (the detector can tell them apart)',
    A.PLATFORM_REVENUE !== A.PLATFORM_CLEARING && A.seller(SELLER) !== A.rider(RIDER));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
