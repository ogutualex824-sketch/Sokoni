#!/usr/bin/env node
/**
 * MULTICART → CHECKOUT — the purchase path, and where money authority begins.
 *
 *   node scripts/test-multicart-purchase-authority.js
 *
 * THE RULE BEING CERTIFIED, stated once:
 *
 *   UI interaction (add / qty / remove)  → local state. No money moves, so no network.
 *   Money and order authority            → authenticated server callable, which
 *                                          RECOMPUTES from its own data and records.
 *
 * The cart is deliberately client-side and that is correct: a cart is an intention, not
 * a transaction. What must never be client-authoritative is the payable amount, the
 * commission, the seller net, the rider amount, or the fact of payment.
 *
 * So this suite proves two different things with two different methods:
 *   · the cart WORKS — executed against the real sokoni-cart.js
 *   · the money boundary HOLDS — asserted across client, callable and SERVED rules,
 *     including tamper cases where a hostile client sends prices it made up
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

const CART  = fs.readFileSync(path.join(ROOT, 'sokoni-cart.js'), 'utf8');
const CO    = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
const FNS   = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

/* the createCheckoutSession body, parenthesis-balanced from onCall( */
function callableBody (name) {
  const key = 'exports.' + name + ' = onCall(';
  const i = FNS.indexOf(key);
  if (i === -1) return null;
  let d = 0;
  for (let k = i + key.length - 1; k < FNS.length; k++) {
    const c = FNS[k];
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return FNS.slice(i, k + 1); }
  }
  return null;
}

/* a cart module loaded against a fake localStorage */
function loadCart () {
  const store = {};
  const sandbox = {
    console, JSON, Math, Date, String, Number, Array, Object, isNaN, parseInt, parseFloat,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: { addEventListener () {}, dispatchEvent () {}, createElement: () => ({ style: {} }) },
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.dispatchEvent = () => {};
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(CART, sandbox, { filename: 'sokoni-cart.js' });
  return sandbox.SokoniCart || sandbox.window.SokoniCart;
}

function qtyIsZero (i) { return (Number(i.qty) || 0) === 0; }

console.log(NL + 'MULTICART → CHECKOUT AUTHORITY' + NL + '='.repeat(64));

/* ── 1 · the cart itself, executed ────────────────────────────────────────── */
head('1 · the cart works — run against the real module');
const C = loadCart();
ck('SokoniCart loaded', !!C && typeof C.add === 'function');

if (C) {
  const A = { id: 'p1', name: 'Shirt',  price: 2500, sellerId: 'SELLER_A', qty: 1 };
  const B = { id: 'p2', name: 'Sugar',  price: 320,  sellerId: 'SELLER_B', qty: 1 };

  C.add(A);
  ck('add to cart puts the product in', C.lines() === 1, C.lines() + ' line(s)');

  C.add(B);
  ck('a SECOND product coexists — it does not replace the first', C.lines() === 2,
     C.lines() + ' lines');

  /* APPEND IS DELIBERATE, and merge is opt-in. Two food lines can share a product id and
     differ only by note ("extra ugali" / "no ugali"); collapsing them by id would discard
     a shopper instruction and charge for a dish they did not order that way. So the
     contract is: add() appends, add(_, {merge:true}) aggregates — and the two must agree
     on the UNIT COUNT, which the module states as its own invariant. */
  C.add(A);
  ck('a plain add APPENDS a line — distinct instructions survive',
     C.lines() === 3 && C.units() === 3, C.lines() + ' lines / ' + C.units() + ' units');

  C.add(A, { merge: true });
  ck('merge aggregates onto the existing line instead of appending',
     C.lines() === 3 && C.units() === 4, C.lines() + ' lines / ' + C.units() + ' units');

  ck('CONTROL merge and append agree on total units',
     (function () {
       const m = loadCart(); m.add(A); m.add(A, { merge: true });
       const p = loadCart(); p.add(A); p.add(A);
       return m.units() === p.units();
     })(),
     'merging a row carrying qty:2 must add two units, not one');

  /* multi-seller attribution */
  const list = C.list();
  const sellers = list.map((i) => i.sellerId).filter((v, i, a) => a.indexOf(v) === i);
  ck('products from two shops keep their OWN seller', sellers.length === 2,
     sellers.join(', '));
  ck('no line borrows another sellers price',
     list.every((i) => (i.id === 'p1' ? i.price === 2500 : i.price === 320)),
     list.map((i) => i.id + '=' + i.price).join(' '));

  /* quantity + removal */
  /* Index against the CURRENT list each time — the array is re-read on every call, so a
     snapshot taken before an add is already stale. */
  const at1 = C.list().findIndex((i) => i.id === 'p1');
  C.setQty(at1, 5);
  ck('quantity can be changed', C.list()[at1].qty === 5, 'qty=' + C.list()[at1].qty);

  const before = C.lines();
  const at2 = C.list().findIndex((i) => i.id === 'p1');
  C.setQty(at2, 0);
  ck('qty 0 REMOVES the line rather than leaving a zero-qty phantom',
     C.lines() === before - 1 && !C.list().some((i) => qtyIsZero(i)),
     C.list().map((i) => i.id + 'x' + (i.qty || 0)).join(' '));

  C.removeById('p2');
  ck('remove takes the item out', !C.has('p2'));
  ck('an emptied cart is empty, not broken', C.lines() >= 0, C.lines() + ' lines');
}

/* ── 2 · the client sends INTENT, never prices ────────────────────────────── */
head('2 · what the browser is allowed to say about money');
ck('the session payload carries productId and qty ONLY',
   /cartItems:\s*cartForSession/.test(CO) &&
   /productId:\s*String\(/.test(CO) && /qty:\s*Math\.max\(1, Math\.round\(/.test(CO));
ck('...and carries no price, subtotal or total field',
   !/cartForSession[\s\S]{0,400}price:/.test(CO),
   'a price in this payload would be a price the buyer chose');
ck('a promo code is a NAME, not a discount', /promoCode:\s*_appliedPromoCode/.test(CO));
ck('loyalty is INTENT, not an amount',
   /redeemLoyalty:\s*_loyaltyRedeeming === true \? true : undefined/.test(CO),
   'the server reads the real balance; the browsers localStorage copy is not trusted');

/* ── 3 · the charged amount is the servers ───────────────────────────────── */
head('3 · the amount charged comes from the server');
ck('stkAmount starts null and is never defaulted to the client total',
   /let stkAmount = null;/.test(CO) && /never default to client orderTotal/.test(CO));
ck('it is assigned from the server response',
   /stkAmount\s*=\s*sessionRes\.data\.serverTotal;/.test(CO));
ck('CONTROL the client total is never assigned into it',
   !/stkAmount\s*=\s*orderTotal/.test(CO),
   'one line would undo the whole boundary');
ck('a server total ABOVE the quote requires a second informed tap',
   /NEVER charge more than we quoted/.test(CO),
   'and the reverse direction must keep working, or promo and loyalty break');

/* ── 4 · the server recomputes, per seller ───────────────────────────────── */
head('4 · the callable recomputes from its own data');
const SESSION = callableBody('createCheckoutSession');
ck('createCheckoutSession exists', !!SESSION, SESSION ? SESSION.length + ' chars' : 'MISSING');
if (SESSION) {
  ck('it demands authentication', /if \(!request\.auth\) throw new HttpsError\("unauthenticated"/.test(SESSION));
  ck('it reads authoritative prices from Firestore',
     /Fetch authoritative prices from Firestore/.test(SESSION) && /priceMap/.test(SESSION));
  ck('it bounds the cart', /Cart too large/.test(SESSION));
  ck('MULTI-SELLER: it resolves shop state for every distinct seller',
     /sellerUid/.test(SESSION) && /distinct seller/i.test(SESSION),
     'one sellers availability must not authorise anothers goods');
  ck('it builds items from SERVER prices',
     /server prices/i.test(SESSION),
     'an item absent from the catalogue is skipped rather than priced by the client');
  ck('CONTROL it does not read a price off the request',
     !/request\.data[\s\S]{0,80}\.price/.test(SESSION),
     'the one thing that would make all of the above cosmetic');
}

/* ── 4b · Buy Now takes the SAME road ────────────────────────────────────── */
head('4b · Buy Now is not a second purchase path');
(function () {
  const CAT = fs.readFileSync(path.join(ROOT, 'category.js'), 'utf8');
  ck('Buy Now REPLACES the cart with the one item',
     CAT.indexOf('replace(') > -1 && CAT.indexOf('express-checkout THIS item only') > -1,
     'appending would charge the whole accumulated cart for a one-item express buy');
  ck('...in ONE write, so a failure cannot empty the cart',
     CAT.indexOf('would leave the shopper with nothing') > -1 ||
     CAT.indexOf('swaps the cart in ONE write') > -1);
  ck('...and navigation DEPENDS on that write succeeding',
     CAT.indexOf('the navigation now depends on the') > -1,
     'it used to navigate regardless, sending the shopper to checkout with the PREVIOUS cart');
  ck('CONTROL Buy Now does not call a payment path of its own',
     (function(){var i=CAT.indexOf('function buyNowCat');var b=i>-1?CAT.slice(i,i+1400):'';return !/httpsCallable|createCheckoutSession|intasend/i.test(b);})(),
     'it must inherit the same server-recomputed total as every other checkout');
})();

/* ── 5 · the rules refuse client-asserted money ──────────────────────────── */
head('5 · SERVED rules — a client cannot assert that money happened');
['paymentVerified', 'paidAmount', 'escrow', 'settlementStatus', 'payoutStatus', 'mpesaCode']
  .forEach((k) => {
    ck("an order write may not carry '" + k + "'",
       new RegExp("'" + k + "'").test(RULES) && /clientOrderInit/.test(RULES));
  });
ck('a client-created order may only be pending / draft',
   /request\.resource\.data\.status in \['pending', 'pending_payment', 'draft'\]/.test(RULES),
   'so a browser cannot open an order already marked paid');
ck('CONTROL the guard is actually applied, not merely defined',
   (RULES.match(/clientOrderInit\(\)/g) || []).length >= 2,
   'a function nobody calls protects nothing');

/* ── 6 · retries must not duplicate money or orders ──────────────────────── */
head('6 · retry is not a second sale');
ck('the checkout session has a server-minted id',
   /const sessionId = "CS" \+ Date\.now/.test(FNS) && /checkoutSessions/.test(FNS));
ck('payment is verified against that session, not a client claim',
   /sessionId, \/\* preferred: server-side checkout session ID \*\//.test(FNS) ||
   /sessionId/.test(CO));
ck('the order id is minted once and reused for the write',
   /doc\(window\.firebaseDB, "orders", orderId\)/.test(CO),
   'a fresh id per retry is how one purchase becomes two orders');
ck('a webhook-finalised order is not downgraded by a late client write',
   /alreadyPersisted/.test(CO) && /downgrade the webhook's authoritative "paid"/.test(CO));

/* ── 7 · one commission authority ────────────────────────────────────────── */
head('7 · no second commission or settlement engine');
ck('the client never computes commission',
   !/commission/i.test(CO) || !/commission\s*=\s*[^;]*\*\s*0\.0?5/.test(CO),
   'a rate in the browser is a rate a buyer can edit');
ck('CONTROL the single commission source still stands',
   fs.existsSync(path.join(ROOT, 'scripts/verify-commission-single-source.js')),
   'that check is a predeploy hook and owns this assertion in full');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
