#!/usr/bin/env node
/* ============================================================================
   SOKONI — the seller-side delivery surface        seller-delivery.html
   ============================================================================
   The last ambiguous delivery surface, resolved the same way the buyer side
   was: by tracing what the page actually reads.

   It reads `packageRequests` and nothing else. There is no
   collection('deliveries') and no DeliveryHub call anywhere in it — the word
   "deliveries" appears only in prose. So it IS the Marketplace delivery
   surface, seller side, and it is mounted on the canonical anchor rather than
   being dropped from the claimed surface.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(name + (detail ? '  — ' + detail : ''));
  return false;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* The page's comments discuss both collections at length. Strip both comment
   syntaxes before asserting, or the suite reads the prose rather than the code. */
function stripAll(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const raw = read('seller-delivery.html');
const code = stripAll(raw);
ok('CONTROL: the stripped page is readable', code.indexOf('_renderActive') !== -1);
ok('CONTROL: stripping removed prose', code.length < raw.length * 0.95);

/* ── 1. IT IS THE MARKETPLACE SURFACE ───────────────────────────────────── */
ok('every delivery query reads packageRequests',
  /collection\('packageRequests'\)/.test(code));
ok('…filtered by the SELLER', /where\('sellerUid',\s*'==',\s*_sellerUid\)/.test(code));
ok('the page reads NO Delivery Hub collection',
  !/collection\(['"]deliveries['"]\)/.test(code));
ok('…and calls no DeliveryHub helper', !/DeliveryHub\./.test(code));
/* CONTROL for those two absences: the detector CAN see a hub reader. */
ok('CONTROL: the detector finds a hub reader where one exists',
  /DeliveryHub\.listenDeliveryByRef/.test(stripAll(read('delivery-tracking.html'))),
  'the absence assertions above prove nothing');

/* ── 2. THE ANCHOR IS THE packageRequests DOCUMENT ID ───────────────────── */
ok('the slot carries d.id as the anchor',
  /data-connect-anchor="\$\{_esc\(d\.id\)\}"/.test(code));
ok('…which is the SAME id the card hands to the tracking page',
  /delivery-tracking\.html\?ref=\$\{_esc\(d\.id\)\}/.test(code));
ok('the mount passes the delivery anchor type', /anchorType:\s*'delivery'/.test(code));
ok('…and reaches the server through connectDispatch',
  code.indexOf("sokoniCallable('connectDispatch')") !== -1);
ok('the page loads the Connect module', raw.indexOf('sokoni-connect-call.js') !== -1);

/* ── 3. NO CLIENT LIFECYCLE MAPPING, NO NAMED COUNTERPARTY ──────────────── */
ok('the page never sends a relationshipState', code.indexOf('relationshipState') === -1);
ok('the page never calls shouldShow itself', code.indexOf('shouldShow') === -1);
ok('the page never calls callSurfaceFor itself', code.indexOf('callSurfaceFor') === -1);
ok('the page names no calleeUid', code.indexOf('calleeUid') === -1);
{
  /* The request must carry the anchor and nothing identifying a person. */
  const fn = code.slice(code.indexOf('function _mountDeliveryConnect'),
    code.indexOf('function _mountDeliveryConnect') + 1800);
  ok('CONTROL: the mount function was located', fn.indexOf('mountForAnchor') !== -1);
  ok('the mount passes no rider/buyer identity',
    !/assignedRiderId|riderId|buyerUid|sellerUid|assignedDriverUid/.test(fn), 'leaked an identity');
}

/* ── 4. ACTIVE ONLY, AND NO STALE ACTION ────────────────────────────────── */
ok('the mount runs from the ACTIVE list only',
  /#activeList \.sd-connect\[data-connect-anchor\]/.test(code));
ok('…and is called from _renderActive', /_mountDeliveryConnect\(\);/.test(code));
ok('a re-fired snapshot does not re-mount the same anchor',
  /_connectMounted\[anchorId\]/.test(code));
ok('a delivery that leaves the Active set releases its guard',
  /if \(!seen\[id\]\) delete _connectMounted\[id\]/.test(code));
ok('an empty action row collapses rather than showing a blank strip',
  /\.sd-connect:empty\{display:none\}/.test(code));

/* ── 5. THE ANCHOR CANNOT CROSS-AUTHORIZE — executed ────────────────────── */
{
  /* The same worst case as the buyer side, asserted from the SELLER's seat:
     one document in each collection under one id. */
  const DA = require(path.join(ROOT, 'functions', 'delivery-authority.js'));
  const SHARED = 'DEL-SELLERCOLLIDE';
  const pkg = { status: 'in_transit', buyerUid: 'buyer_B', sellerUid: 'seller_S',
    assignedDriverId: 'rider_P' };
  const hub = { status: 'in_transit', senderUid: 'sender_A', assignedRiderId: 'rider_H' };

  const actor = (doc, uid) => DA.resolveActor({ uid, delivery: doc, order: null });

  ok('the seller IS a party to their own packageRequests delivery',
    actor(pkg, 'seller_S') === 'seller');
  ok('…and so is the assigned rider', actor(pkg, 'rider_P') === 'rider');

  ok('a hub SENDER is not a party to the marketplace document under the same id',
    actor(pkg, 'sender_A') === null);
  ok('a hub RIDER is not a party to the marketplace document under the same id',
    actor(pkg, 'rider_H') === null);
  ok('the marketplace SELLER is not a party to the hub document under the same id',
    actor(hub, 'seller_S') === null);
  ok('CONTROL: the hub document does resolve its OWN rider',
    actor(hub, 'rider_H') === 'rider', 'the refusals above prove nothing');
  ok('SAFETY: a seller can never be bound to a hub courier by a shared id',
    actor(hub, 'seller_S') === null && actor(pkg, 'rider_H') === null);
}

/* ── 6. THE SERVER STILL REFUSES A DELIVERY WITH NO RIDER ───────────────── */
{
  const calls = stripAll(read('functions/connect-calls.js'));
  ok('the anchor refuses a delivery with no assigned rider',
    calls.indexOf('Delivery has no assigned rider yet') !== -1);
  ok('…which is why only the Active list is mounted',
    /where\('status',\s*'in',\s*\['driver_assigned'/.test(code));
  /* A surface that cannot ask must show nothing, not a broken control. */
  const mod = stripAll(read('sokoni-connect-call.js'));
  ok('a refused availability call clears the slot',
    /\.catch\(function \(\) \{[\s\S]{0,200}root\.innerHTML = ''/.test(mod));
}

console.log('');
console.log('  SOKONI seller-side delivery mount');
console.log('  ' + '-'.repeat(60));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
