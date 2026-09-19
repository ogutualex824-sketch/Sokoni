/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — OFFER VIEW suite
   scripts/test-offer-view.js       node scripts/test-offer-view.js

   WHAT THIS IS GUARDING
   An offer is a COMMERCIAL CLAIM. A card that says "SAVE KES 651" is telling a customer
   they will be charged less, and they will act on it. So the assertions below are mostly
   about what the renderer REFUSES to say: no saving it had to guess at, no scarcity from an
   absent counter, no offer shown outside the hours it runs.

   EVERY ABSENCE IS PAIRED WITH AN INVERTING CONTROL. "No saving is shown" passes just as
   well when the renderer returned an empty string for an unrelated reason, so each such
   check sits beside a case that MUST produce the figure.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'sokoni-listing-types.js'));
require(path.join(ROOT, 'sokoni-promotion-model.js'));
const OV = require(path.join(ROOT, 'sokoni-offer-view.js'));

let pass = 0, fail = 0;
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
function section (t) { console.log('\n' + t); }

/* A Friday at 18:00 — inside the pizza offer's window. */
const FRI_18 = new Date('2026-10-02T18:00:00');
const TUE_11 = new Date('2026-09-29T11:00:00');

const PIZZA = {
  id: 'off1', name: 'Family Pizza Night', template: 'mealDeal', type: 'bundle',
  summary: '2 Pizzas + 2 Drinks + Side',
  bundlePrice: 2999, regularValue: 3650,
  items: [{ name: 'Large Chicken BBQ Pizza', qty: 1 }, { name: 'Garlic Bread', qty: 1 },
          { name: 'Soft Drink', qty: 4 }],
  schedule: { days: ['fri'], from: '17:00', to: '22:00' },
  stacking: 'exclusive', minSpend: 1000, perCustomerLimit: 1,
  locations: ['Westlands', 'Kilimani'], fulfilments: ['Delivery', 'Pickup', 'Dine-in'],
};
const LISTING = { id: 'L1', name: 'Family Pizza Night', price: 3650,
                  listingType: 'food', offers: [PIZZA] };

/* ── 1. NOTHING WITHOUT AN OFFER ────────────────────────────────────────────── */
section('No offer, no treatment');
{
  const plain = { id: 'L2', name: 'Kettle', price: 2500 };
  ok('offerOf returns null', OV.offerOf(plain) === null);
  ok('the card badge is empty', OV.cardBadgeHtml(plain) === '');
  ok('the card body is empty', OV.cardOfferHtml(plain) === '');
  ok('the detail panel is empty', OV.detailHtml(plain) === '');
  ok('no action is renamed', OV.actionLabel(plain) === null);
  /* THE INVERTING CONTROL. Without it, every assertion above passes for a renderer that
     returns '' unconditionally. */
  ok('control — a real offer DOES produce all of them',
     OV.offerOf(LISTING, FRI_18) !== null &&
     OV.cardBadgeHtml(LISTING, FRI_18) !== '' &&
     OV.cardOfferHtml(LISTING, FRI_18) !== '' &&
     OV.detailHtml(LISTING, { at: FRI_18 }) !== '');

  ok('a malformed offer is treated as no offer',
     OV.offerOf({ offers: [{ type: 'nonsense', name: 'x' }] }) === null);
  ok('a non-object offer does not throw',
     OV.offerOf({ offers: [null, 'nope', 7] }) === null);
}

/* ── 2. NOT SHOWN OUTSIDE ITS HOURS ─────────────────────────────────────────── */
section('Schedule');
{
  /* Printing "Fri 17:00–22:00" on a Tuesday is a promise the basket will refuse, and the
     customer only finds out at checkout. */
  ok('a Friday offer is not shown on Tuesday', OV.offerOf(LISTING, TUE_11) === null);
  ok('control — it IS shown on Friday evening', OV.offerOf(LISTING, FRI_18) !== null);
  ok('the card says when it runs',
     OV.cardOfferHtml(LISTING, FRI_18).indexOf('Fri · 17:00–22:00') > -1);
  ok('an unscheduled offer says nothing about days',
     OV.scheduleText({ type: 'fixed' }) === '');
  ok('seven days is not printed as a list',
     OV.scheduleText({ schedule: { days: ['mon','tue','wed','thu','fri','sat','sun'] } }) === '');

  /* Fails closed, as the promotion model does. */
  ok('a broken window is not shown at all',
     OV.offerOf({ offers: [{ type: 'fixed', amount: 100, schedule: { from: 'nonsense', to: '9' } }] },
                FRI_18) === null);
}

/* ── 3. THE SAVING IS DERIVED, NEVER GUESSED ────────────────────────────────── */
section('Saving');
{
  const s = OV.savingOf(PIZZA, LISTING);
  ok('bundle: was 3,650', s.was === 3650);
  ok('bundle: now 2,999', s.now === 2999);
  ok('bundle: saves 651', s.save === 651);

  ok('percentage off a priced listing',
     OV.savingOf({ type: 'percentage', percent: 20 }, { price: 1000 }).now === 800);
  ok('fixed off a priced listing',
     OV.savingOf({ type: 'fixed', amount: 500 }, { price: 3000 }).now === 2500);
  ok('a fixed discount never goes below zero',
     OV.savingOf({ type: 'fixed', amount: 5000 }, { price: 300 }).now === 0);

  /* NO PRICE, NO PERCENTAGE. A percentage of an unknown price is not a number, and
     inventing one would put a false figure on a card. */
  ok('a percentage with no listing price yields no figure',
     OV.savingOf({ type: 'percentage', percent: 20 }, {}) === null);
  ok('control — with a price it does', OV.savingOf({ type: 'percentage', percent: 20 },
     { price: 100 }) !== null);

  /* A BUNDLE WHOSE ITEMS CARRY NO PRICES has no honest "was". It still has a price. */
  const noWas = OV.savingOf({ type: 'bundle', bundlePrice: 999,
                              items: [{ name: 'A' }, { name: 'B' }] }, {});
  ok('a bundle with unpriced items shows a price but no saving',
     noWas.now === 999 && noWas.was === null && noWas.save === null);
  ok('control — priced items DO produce a saving',
     OV.savingOf({ type: 'bundle', bundlePrice: 900,
                   items: [{ price: 600, qty: 1 }, { price: 500, qty: 1 }] }, {}).save === 200);
  ok('one unpriced item invalidates the whole regular value',
     OV.savingOf({ type: 'bundle', bundlePrice: 900,
                   items: [{ price: 600 }, { name: 'mystery' }] }, {}).was === null);

  ok('free delivery takes nothing off the listing price',
     OV.savingOf({ type: 'freeDelivery' }, { price: 1000 }) === null);
  ok('a "saving" that is not one is not shown as one',
     OV.savingOf({ type: 'bundle', bundlePrice: 1000, regularValue: 900 }, {}).save === null);
}

/* ── 4. THE CARD ────────────────────────────────────────────────────────────── */
section('Card treatment');
{
  const badge = OV.cardBadgeHtml(LISTING, FRI_18);
  ok('the ribbon names the saving', badge.indexOf('SAVE KES 651') > -1);
  ok('it carries the template icon', badge.indexOf('🍕') > -1);

  const body = OV.cardOfferHtml(LISTING, FRI_18);
  ok('the new price is shown', body.indexOf('KES 2,999') > -1);

  /* THE CARD ALREADY PRINTS THE LISTING PRICE just above this block. Striking it through
     again put KES 3,650 on the card twice, two lines apart, reading as two competing prices
     rather than one price and one offer. */
  ok('the listing price is not struck through a second time',
     body.indexOf('KES 3,650') === -1);
  ok('control — an original the card is NOT showing IS struck through',
     OV.cardOfferHtml({ price: 9999, offers: [PIZZA] }, FRI_18)
       .indexOf('<s>KES 3,650</s>') > -1);
  ok('and the panel, which has no price above it, still shows both',
     OV.detailHtml(LISTING, { at: FRI_18 }).indexOf('KES 3,650') > -1);
  ok('the offer is named', body.indexOf('Family Pizza Night') > -1);

  /* THE CARD STAYS BROWSE-ONLY. An offer must not reintroduce the controls the card rule
     removed — the whole card is the tap target. */
  ok('no button is added to the card',
     badge.indexOf('<button') === -1 && body.indexOf('<button') === -1);
  ok('no cart or wishlist control is added',
     (badge + body).indexOf('data-action') === -1);

  /* A free-delivery offer has no saving to state, so it says what it IS. */
  ok('free delivery says so rather than showing an empty ribbon',
     OV.cardBadgeHtml({ offers: [{ type: 'freeDelivery' }] }).indexOf('FREE DELIVERY') > -1);

  ok('escapes a hostile offer name',
     OV.cardOfferHtml({ price: 100, offers: [{ type: 'fixed', amount: 10,
       name: '<img src=x onerror=alert(1)>' }] }).indexOf('<img') === -1);
}

/* ── 5. THE DETAIL PANEL ────────────────────────────────────────────────────── */
section('Detail panel');
{
  const d = OV.detailHtml(LISTING, { at: FRI_18 });
  ok('it names the offer', d.indexOf('Family Pizza Night') > -1);
  ok('it shows the price and the original',
     d.indexOf('KES 2,999') > -1 && d.indexOf('KES 3,650') > -1);
  ok('it states the saving', d.indexOf('Save KES 651') > -1);
  ok('it lists what is included', d.indexOf('4 × Soft Drink') > -1);
  ok('it states the minimum spend', d.indexOf('KES 1,000') > -1);
  ok('it states the locations', d.indexOf('Westlands, Kilimani') > -1);
  ok('it states the fulfilment options', d.indexOf('Delivery · Pickup · Dine-in') > -1);

  /* STACKING IS THE CUSTOMER'S BUSINESS — it is exactly the rule people discover at
     checkout and resent. */
  ok('it says the offer cannot be combined',
     d.indexOf('Cannot be combined with other offers') > -1);
  ok('control — a stackable offer says the opposite',
     OV.detailHtml({ offers: [{ type: 'fixed', amount: 100, stacking: 'stackable' }] })
       .indexOf('Can be combined with other offers') > -1);

  /* THE ADVISORY is what makes showing a price here safe: the server decides what is
     charged, and the customer is told the figure is confirmed at checkout. */
  ok('it says the price is confirmed at checkout',
     d.indexOf('confirmed at checkout') > -1);

  ok('a thin offer renders a short panel, not empty headings',
     OV.detailHtml({ offers: [{ type: 'freeDelivery', name: 'Free delivery' }] })
       .indexOf("What’s included") === -1);
  ok('control — a bundle DOES render that heading', d.indexOf("What’s included") > -1);
}

/* ── 6. SCARCITY IS NEVER IMPLIED BY SILENCE ────────────────────────────────── */
section('Remaining count');
{
  /* The platform's standing rule: an absent counter is UNMETERED, not exhausted. Rendering
     "Sold out" from a missing number stops a customer buying something that is available. */
  ok('no limit means no count', OV.remainingOf({ type: 'bundle' }, {}) === null);
  ok('a limit with no sold figure means no count',
     OV.remainingOf({ inventoryLimit: 100 }, {}) === null);
  ok('control — both present gives the real remainder',
     OV.remainingOf({ inventoryLimit: 100 }, { inventorySold: 77 }) === 23);
  ok('it never goes negative',
     OV.remainingOf({ inventoryLimit: 10 }, { inventorySold: 40 }) === 0);

  /* PIZZA itself declares no inventoryLimit, so a sold figure alone must stay silent — the
     limit is what makes a remainder meaningful. */
  ok('a sold figure with no declared limit says nothing',
     OV.detailHtml(LISTING, { at: FRI_18, usage: { inventorySold: 77 } })
       .indexOf('left') === -1);

  const capped = { offers: [Object.assign({}, PIZZA, { inventoryLimit: 100 })] };
  ok('control — with a limit, the panel shows how many are left',
     OV.detailHtml(capped, { at: FRI_18, usage: { inventorySold: 77 } }).indexOf('23 left') > -1);
  ok('control — with a declared limit, zero DOES read sold out',
     OV.detailHtml({ offers: [Object.assign({}, PIZZA, { inventoryLimit: 100 })] },
                   { at: FRI_18, usage: { inventorySold: 100 } }).indexOf('Sold out') > -1);
  ok('an unmetered offer never says sold out',
     OV.detailHtml(LISTING, { at: FRI_18 }).indexOf('Sold out') === -1);
}

/* ── 7. THE ACTION ──────────────────────────────────────────────────────────── */
section('Contextual action');
{
  /* A bundle is not an item, so it does not say "Buy Now" — but the verb still comes from
     the listing type. A restaurant orders; a hotel reserves. */
  ok('a food bundle orders the package', OV.actionLabel(LISTING, FRI_18) === 'Order Package');
  ok('a room bundle reserves it',
     OV.actionLabel({ listingType: 'room', offers: [PIZZA] }, FRI_18) === 'Reserve Package');
  ok('a product bundle adds it',
     OV.actionLabel({ listingType: 'product', offers: [PIZZA] }, FRI_18) === 'Add Package');

  /* A PERCENTAGE OFF DOES NOT CHANGE WHAT IS BEING BOUGHT, so it must not rename the
     action — that would be decoration presented as information. */
  ok('a discount does not rename the action',
     OV.actionLabel({ price: 100, offers: [{ type: 'percentage', percent: 10 }] }) === null);
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
