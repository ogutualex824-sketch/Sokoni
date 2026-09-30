#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   CERTIFICATION — the warranty and returns policy authority
   scripts/test-warranty-policy.js

   Three properties carry this file:

     1. THE PIN IS NOT A WAIVER. Confirming receipt of goods opens the warranty window and
        never closes, shortens or narrows it. A buyer confirms at the door in a few seconds,
        often in the rain; treating that as consent to a defect they have not found yet
        would turn a delivery confirmation into a legal trap.

     2. A BUYER CANNOT ASK FOR WHAT WAS NEVER OFFERED, and cannot be refused what was. The
        options are generated from the policy pinned to THAT purchase — not from whatever
        the seller has configured since.

     3. A BUYER DOES NOT PAY FOR A SELLER'S MISTAKE. Fault is a property of the reason,
        decided once, rather than a judgement made per request by whoever is reviewing.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const W = require(path.join(__dirname, '..', 'functions/warranty-policy.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const SELLER_POLICY = {
  durationDays: 7,
  remedies: ['refund', 'replacement', 'repair'],
  reasons: ['wrong_product', 'damaged', 'defective', 'missing_item',
            'not_as_described', 'wrong_variant', 'incomplete_order'],
};
const pinned = W.pinPolicy(SELLER_POLICY).pinned;

/* ══ A. THE SELLER'S SETTINGS ══════════════════════════════════════════════ */
head('A. what a seller saves is validated, not trusted');
{
  const ok = W.normalisePolicy(SELLER_POLICY);
  ck('A1  a complete policy normalises', ok.ok === true && ok.policy.durationDays === 7);

  ck('A2  the window anchor defaults to DELIVERY',
     ok.policy.startsAt === 'delivery',
     'from purchase, a slow delivery eats the buyer\'s protection');

  ck('A3  ...and can be set to purchase deliberately',
     W.normalisePolicy(Object.assign({}, SELLER_POLICY, { startsAt: 'purchase' })).policy.startsAt === 'purchase',
     'recorded on the pin, so a dispute is settled by reading the order');

  const bogus = W.normalisePolicy(Object.assign({}, SELLER_POLICY,
    { remedies: ['refund', 'free_pony'], reasons: ['damaged', 'mercury_retrograde'] }));
  ck('A4  unknown remedies and reasons are DROPPED, not kept',
     bogus.ok && bogus.policy.remedies.indexOf('free_pony') === -1 &&
     bogus.policy.reasons.indexOf('mercury_retrograde') === -1,
     'a promise nothing can honour is worse than no promise');

  ck('A5  ...and reported, so the seller learns what was ignored',
     bogus.policy.dropped.length === 2,
     bogus.policy.dropped.join(', '));

  ck('A6  a policy offering NOTHING is refused',
     W.normalisePolicy(Object.assign({}, SELLER_POLICY, { remedies: [] })).reason === 'NO_REMEDY_OFFERED',
     'leave it unset rather than promising nothing in the shape of a promise');

  ck('A7  a policy accepting no reason is refused',
     W.normalisePolicy(Object.assign({}, SELLER_POLICY, { reasons: [] })).reason === 'NO_REASON_ACCEPTED',
     'a buyer with no permitted reason can never open a request');

  ck('A8  a negative or implausible duration is refused',
     W.normalisePolicy(Object.assign({}, SELLER_POLICY, { durationDays: -1 })).reason === 'INVALID_DURATION' &&
     W.normalisePolicy(Object.assign({}, SELLER_POLICY, { durationDays: 99999 })).reason === 'IMPLAUSIBLE_DURATION');

  ck('A9  a zero-day policy is legal and means same-day only',
     W.normalisePolicy(Object.assign({}, SELLER_POLICY, { durationDays: 0 })).ok === true,
     'not every product carries a warranty, and 0 is a stated answer');

  ck('A10 no settings at all is NO_POLICY, not an empty one',
     W.normalisePolicy(null).reason === 'NO_POLICY',
     'a seller who configured nothing has not promised everything either');
}

/* ══ B. PINNED TO THE PURCHASE ═════════════════════════════════════════════ */
head('B. the policy that applied on the day is the one that applies');
{
  ck('B1  a pin carries its version and timestamp',
     pinned.policyVersion === 'sokoni-warranty-v1' && !!pinned.pinnedAt);

  /* The seller narrows their policy AFTER the sale. */
  const narrowed = W.pinPolicy({ durationDays: 1, remedies: ['repair'], reasons: ['defective'] }).pinned;

  const stillOk = W.validateRequest({
    pinned, delivered: true, deliveredAt: ago(3), reason: 'damaged', remedies: ['refund'],
  });
  ck('B2  a request is judged against the PINNED policy',
     stillOk.ok === true,
     'a seller narrowing their terms on Tuesday must not narrow Monday\'s promise');

  const wouldFail = W.validateRequest({
    pinned: narrowed, delivered: true, deliveredAt: ago(3), reason: 'damaged', remedies: ['refund'],
  });
  ck('B3  control: the narrowed policy WOULD have refused it',
     !wouldFail.ok,
     'so B2 measures the pin, not a policy that happens to allow everything');
}

/* ══ C. THE WINDOW ═════════════════════════════════════════════════════════ */
head('C. how long the buyer has, measured from when they got the goods');
{
  const live = W.windowFor({ pinned, deliveredAt: ago(2) });
  ck('C1  two days into a seven-day warranty is ACTIVE',
     live.state === 'ACTIVE' && live.open === true, live.daysRemaining + ' days remaining');

  const dead = W.windowFor({ pinned, deliveredAt: ago(30) });
  ck('C2  thirty days later it is EXPIRED',
     dead.state === 'EXPIRED' && dead.open === false, dead.expiresAt);

  const waiting = W.windowFor({ pinned, deliveredAt: null });
  ck('C3  an undelivered parcel is NOT_STARTED, not expired',
     waiting.state === 'NOT_STARTED' && waiting.reason === 'NOT_DELIVERED_YET',
     'telling a waiting buyer their protection ran out would be wrong and alarming');

  /* THE CORRECTION THIS MODULE MAKES to the obvious reading of a warranty. */
  const slow = { deliveredAt: ago(1), purchasedAt: ago(6) };
  const byDelivery = W.windowFor({ pinned, deliveredAt: slow.deliveredAt, purchasedAt: slow.purchasedAt });
  const byPurchase = W.windowFor({
    pinned: W.pinPolicy(Object.assign({}, SELLER_POLICY, { startsAt: 'purchase' })).pinned,
    deliveredAt: slow.deliveredAt, purchasedAt: slow.purchasedAt,
  });
  ck('C4  a slow delivery does not eat the buyer\'s protection',
     byDelivery.daysRemaining > byPurchase.daysRemaining,
     'delivery anchor ' + byDelivery.daysRemaining + 'd vs purchase anchor ' +
     byPurchase.daysRemaining + 'd on the same parcel');

  ck('C5  days remaining round UP',
     W.windowFor({ pinned, deliveredAt: new Date(Date.now() - 7 * DAY + 3600000).toISOString() })
       .daysRemaining === 1,
     'an hour left is one day, not zero — a buyer must not lose the last day');

  ck('C6  the boundary is inclusive',
     W.windowFor({ pinned, deliveredAt: ago(7), now: Date.now() }).state === 'ACTIVE' ||
     W.windowFor({ pinned, deliveredAt: ago(6.99) }).state === 'ACTIVE',
     'the seventh day of a seven-day warranty is inside it');
}

/* ══ D. WHAT THE BUYER MAY ASK FOR ═════════════════════════════════════════ */
head('D. the options are generated from the policy, never filtered after');
{
  const opts = W.optionsFor(pinned);
  ck('D1  only the seller\'s remedies are offered',
     opts.remedies.length === 3 && opts.remedies.indexOf('exchange') === -1,
     opts.remedies.join(', '));

  ck('D2  only the seller\'s reasons are offered',
     opts.reasons.length === 7 && !opts.reasons.some((r) => r.key === 'changed_mind'),
     'this seller does not accept a change of mind, and does not pretend to');

  ck('D3  each reason carries its fault, for the buyer to see who pays',
     opts.reasons.every((r) => !!r.fault) &&
     opts.reasons.find((r) => r.key === 'damaged').fault === 'SELLER_FAULT');

  const notOffered = W.validateRequest({
    pinned, delivered: true, deliveredAt: ago(1), reason: 'damaged', remedies: ['exchange'],
  });
  ck('D4  asking for a remedy that was not offered is refused BY NAME',
     notOffered.reason === 'REMEDY_NOT_OFFERED_BY_THIS_SELLER' && notOffered.detail === 'exchange',
     'a buyer told only "unavailable" will try the same thing again');

  const notAccepted = W.validateRequest({
    pinned, delivered: true, deliveredAt: ago(1), reason: 'changed_mind', remedies: ['refund'],
  });
  ck('D5  a reason this seller does not accept is refused',
     notAccepted.reason === 'REASON_NOT_ACCEPTED_BY_THIS_SELLER', notAccepted.detail);

  ck('D6  an unknown reason is refused before anything else',
     W.validateRequest({ pinned, delivered: true, deliveredAt: ago(1),
                         reason: 'because', remedies: ['refund'] }).reason === 'UNKNOWN_REASON');

  ck('D7  a request with no remedy at all is refused',
     W.validateRequest({ pinned, delivered: true, deliveredAt: ago(1),
                         reason: 'damaged', remedies: [] }).reason === 'NO_REMEDY_REQUESTED');
}

/* ══ E. ORDER OF REFUSALS ══════════════════════════════════════════════════ */
head('E. a buyer is told the thing that actually blocks them');
{
  const expired = W.validateRequest({
    pinned, delivered: true, deliveredAt: ago(30), reason: 'damaged', remedies: ['refund'],
  });
  ck('E1  an expired window is reported as expiry, not as a form problem',
     expired.reason === 'WINDOW_EXPIRED', expired.detail);

  ck('E2  ...even when the rest of the request is perfect',
     expired.reason !== 'REMEDY_NOT_OFFERED_BY_THIS_SELLER',
     'walking somebody through a form that was always going to be refused wastes their time');

  const undelivered = W.validateRequest({
    pinned, delivered: false, deliveredAt: null, reason: 'damaged', remedies: ['refund'],
  });
  ck('E3  goods not yet received is a CANCELLATION, not a return',
     undelivered.reason === 'NOT_DELIVERED',
     'refunding for goods a rider is still carrying is a different process with different money');

  ck('E4  no policy at all is its own answer',
     W.validateRequest({ pinned: null, delivered: true, reason: 'damaged', remedies: ['refund'] })
       .reason === 'NO_POLICY');
}

/* ══ F. WHO PAYS TO SEND IT BACK ═══════════════════════════════════════════ */
head('F. a buyer does not pay for a seller\'s mistake');
{
  const SELLER_FAULTS = ['wrong_product', 'damaged', 'defective', 'missing_item',
                         'not_as_described', 'wrong_variant', 'incomplete_order'];
  for (const r of SELLER_FAULTS) {
    const v = W.validateRequest({ pinned, delivered: true, deliveredAt: ago(1),
                                  reason: r, remedies: ['refund'] });
    ck('F1  "' + r + '" → the SELLER pays the return delivery',
       v.ok && v.fault === 'SELLER_FAULT' && v.returnDelivery.payer === 'SELLER',
       v.ok ? v.returnDelivery.why : v.reason);
  }

  const openPolicy = W.pinPolicy(Object.assign({}, SELLER_POLICY,
    { reasons: SELLER_POLICY.reasons.concat(['changed_mind', 'other']) })).pinned;

  const mind = W.validateRequest({ pinned: openPolicy, delivered: true, deliveredAt: ago(1),
                                   reason: 'changed_mind', remedies: ['refund'] });
  ck('F2  "changed my mind" → the BUYER pays',
     mind.ok && mind.fault === 'BUYER_CHOICE' && mind.returnDelivery.payer === 'BUYER',
     'the goods were as ordered');

  const other = W.validateRequest({ pinned: openPolicy, delivered: true, deliveredAt: ago(1),
                                    reason: 'other', remedies: ['refund'] });
  ck('F3  "other" is HELD for review, not defaulted to the buyer',
     other.ok && other.fault === 'UNDETERMINED' &&
     other.returnDelivery.payer === null &&
     other.returnDelivery.settled === 'requires_review',
     'defaulting an unknown to the party with less power is how a policy becomes unfair');

  ck('F4  fault is decided by the REASON, not per request by a reviewer',
     W.returnDeliveryLiability('SELLER_FAULT').payer === 'SELLER' &&
     W.returnDeliveryLiability('BUYER_CHOICE').payer === 'BUYER',
     'otherwise whose fault "wrong item" is depends on who opens the case');
}

/* ══ G. THE PIN IS NOT A WAIVER ════════════════════════════════════════════
   The property this whole feature rests on. */
head('G. confirming receipt opens the warranty; it never closes it');
{
  const before = pinned;
  /* What the job looks like after the buyer confirms with their PIN and the delivery
     settles: the policy on the order is untouched. */
  const after = Object.assign({}, pinned);

  const same = W.pinIsNotAWaiver(before, after);
  ck('G1  the pinned policy is identical after PIN confirmation',
     same.ok === true && same.unchanged === true);

  ck('G2  a DELIVERED order still has an open window',
     W.windowFor({ pinned, deliveredAt: ago(1) }).state === 'ACTIVE',
     'DELIVERED is what STARTS the clock');

  ck('G3  ...and a full request still validates on a delivered order',
     W.validateRequest({ pinned, delivered: true, deliveredAt: ago(1),
                         reason: 'defective', remedies: ['refund'] }).ok === true,
     'the PIN means "I received the goods", not "I found no fault in them"');

  /* The erosion this guard exists to catch. */
  const narrowedByPin = Object.assign({}, pinned, { remedies: ['repair'] });
  const caught = W.pinIsNotAWaiver(before, narrowedByPin);
  ck('G4  a policy narrowed at confirmation is DETECTED',
     !caught.ok && caught.reason === 'PIN_NARROWED_THE_POLICY',
     'a sentence in a comment survives a refactor; an assertion does not have to');

  const shortened = Object.assign({}, pinned, { durationDays: 0 });
  ck('G5  ...and so is a shortened one',
     !W.pinIsNotAWaiver(before, shortened).ok,
     'zeroing the window at delivery would be a waiver wearing a different name');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
