/* Automated acceptance suite for Availability Layer 5 — proves the SERVER checkout
   enforcement behavior deterministically, replacing the device-only checks.

   It exercises the EXACT module createCheckoutSession uses
   (functions/availability-enforce.js), so a pass here is a pass in production.
   Enforcement is never weakened to make a test pass — the assertions encode the
   required behavior and the module must satisfy them. */
'use strict';
const path = require('path');
const fs = require('fs');
const A = require(path.join(__dirname, '..', 'functions', 'availability-enforce.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* ── Wiring: createCheckoutSession must actually USE this module, or the proof above
      is moot. Catches a future refactor that bypasses the tested gate. ── */
const idx = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
ok(/require\(["']\.\/availability-enforce["']\)/.test(idx), 'createCheckoutSession requires availability-enforce');
ok(/_avail\.itemAvailability\(/.test(idx), 'checkout calls itemAvailability() to gate items');
ok(/_avail\.fulfillmentAllowed\(/.test(idx), 'checkout calls fulfillmentAllowed() to gate the channel');

const OPEN = {};                                   /* absent fields → fully open (migration-safe) */
const CLOSED = { acceptingOrders: false };
const ONLINE_OFF = { online: false };
const NO_DELIVERY = { delivery: false };
const NO_PICKUP = { pickup: false };
const liveProd = { status: 'active', isVisible: true, sellerUid: 'S1' };

/* ── Migration safety: an un-migrated shop (no fields) is open on every axis ── */
const nd = A.normalizeShop(OPEN);
ok(nd.acceptingOrders && nd.online && nd.delivery && nd.pickup, 'absent shop fields default OPEN (existing shops unaffected)');

/* ── 1. Shop closed → item unavailable; reopened → available ── */
ok(A.itemAvailability(liveProd, OPEN).available === true, 'open shop + live product → available');
ok(A.itemAvailability(liveProd, CLOSED).available === false, 'shop closed → item unavailable');
ok(A.itemAvailability(liveProd, CLOSED).reason === 'shop-closed', 'closed reason surfaced');
ok(A.itemAvailability(liveProd, OPEN).available === true, 'shop reopened → available again');

/* ── online:false → online purchase disabled ── */
ok(A.itemAvailability(liveProd, ONLINE_OFF).available === false, 'online OFF → item unavailable for online purchase');
ok(A.itemAvailability(liveProd, ONLINE_OFF).reason === 'online-off', 'online-off reason surfaced');

/* ── 2/3. Fulfillment channels enforced independently ── */
ok(A.fulfillmentAllowed('delivery', OPEN).ok === true, 'delivery allowed when on');
ok(A.fulfillmentAllowed('delivery', NO_DELIVERY).ok === false, 'Delivery OFF → delivery rejected');
ok(A.fulfillmentAllowed('pickup',   NO_DELIVERY).ok === true, '…and pickup STILL works when only delivery is off');
ok(A.fulfillmentAllowed('pickup',   NO_PICKUP).ok === false, 'Pickup OFF → pickup rejected');
ok(A.fulfillmentAllowed('delivery', NO_PICKUP).ok === true, '…and delivery STILL works when only pickup is off');
ok(A.fulfillmentAllowed('delivery', NO_DELIVERY).reason === 'delivery-off', 'delivery-off reason surfaced');
ok(A.fulfillmentAllowed('pickup',   NO_PICKUP).reason === 'pickup-off', 'pickup-off reason surfaced');
/* unknown fulfillment defaults to delivery (never silently allowed as a 3rd channel) */
ok(A.fulfillmentAllowed('weird', NO_DELIVERY).ok === false, 'unknown fulfillment treated as delivery (enforced)');

/* ── 4. Product paused (hidden) → unavailable; restored → available ── */
const paused = { status: 'active', isVisible: false, sellerUid: 'S1' };
ok(A.itemAvailability(paused, OPEN).available === false, 'paused (isVisible:false) → unavailable');
ok(A.itemAvailability(paused, OPEN).reason === 'hidden', 'hidden reason surfaced');
const archived = { status: 'archived', isVisible: true, sellerUid: 'S1' };
ok(A.itemAvailability(archived, OPEN).available === false, 'archived → unavailable');
ok(A.itemAvailability(archived, OPEN).reason === 'archived', 'archived reason surfaced');
const restored = { status: 'active', isVisible: true, sellerUid: 'S1' };
ok(A.itemAvailability(restored, OPEN).available === true, 'restored product → purchasable again');

/* ── 5. Isolation: the availability decision reads product/shop state but the pure
       module has NO writes — it cannot mutate status/isVisible/stock or other products.
       (Proven structurally: functions are pure; verified below by object identity.) ── */
const before = JSON.stringify(liveProd);
A.itemAvailability(liveProd, CLOSED);
A.fulfillmentAllowed('delivery', NO_DELIVERY);
ok(JSON.stringify(liveProd) === before, 'availability checks never mutate the product object');

/* ── 6. Creation-only invariant: the module gates a NEW checkout only. It exposes no
       concept of an existing order — there is no function here that could re-check or
       invalidate one. Enforced by contract: only itemAvailability + fulfillmentAllowed
       exist; both take a candidate product/shop, never an order. ── */
ok(Object.keys(A).sort().join(',') === 'fulfillmentAllowed,itemAvailability,normalizeShop',
   'module exposes ONLY creation-time gates (no existing-order path) — creation-only invariant');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
