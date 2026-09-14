#!/usr/bin/env node
/* Single-Shop SETTLEMENT Invariant — all four layers.
 *
 *   A checkout transaction MUST contain products belonging to exactly one
 *   shop/seller. The seller set MUST be derived from authoritative product
 *   documents, never from a client-supplied shopId/sellerUid. No order document
 *   may be created before this invariant passes.
 *
 *   CHANGED 2026-08-27: the CART may now hold products from many shops. The
 *   cart-layer refusal was retired DELIBERATELY (see §A and
 *   docs/MULTISHOP_CHECKOUT_AUDIT.md); checkout partitions the basket by shop
 *   instead. The settlement invariant is unchanged and now rests wholly on the
 *   three server layers proved in §B and §C.
 *
 * WHY THE LAYERS ARE TESTED SEPARATELY
 * The cart check is UX and can be bypassed by any stale tab or crafted request.
 * The server check is the rule. Testing only the cart would prove the pleasant
 * half and none of the enforcement — so each layer is asserted on its own terms,
 * and the server assertions are written against the SHIPPED source.
 *
 *   node scripts/test-single-shop-checkout.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT = path.join(__dirname, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');   /* comments explain the rule */

/* ══ A. Cart layer — behavioural, driving the real module ═══════════════ */
console.log('\nA. Cart ACCEPTS multiple shops; checkout partitions them\n');
{
  global.window = global;
  global.localStorage = {
    _d: {}, getItem(k) { return this._d[k] || null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
  };
  const events = [];
  global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  global.dispatchEvent = (e) => events.push(e);

  const C = require(path.join(ROOT, 'sokoni-cart.js'));
  C.clear();

  ck('first item from KASS is accepted', C.add({ id: 'p1', sellerUid: 'KASS', price: 100 }) === true);
  ck('a SECOND product from KASS is accepted (bulk is the point)',
     C.add({ id: 'p2', sellerUid: 'KASS', price: 200 }) === true);
  ck('  ...and quantities from the same shop are fine',
     C.add({ id: 'p2', sellerUid: 'KASS', price: 200 }, { merge: true, times: 3 }) === true);

  /* ── CHANGED 2026-08-27 — the cart guard was RETIRED DELIBERATELY ─────────
     These four assertions used to require add() to REFUSE a cross-shop item.
     The cart now accepts a multi-shop basket and checkout partitions it; the
     settlement invariant moved wholly onto the three server layers, asserted in
     sections B and C below. See docs/MULTISHOP_CHECKOUT_AUDIT.md.

     They are rewritten rather than deleted, so this file records that the guard
     was removed by decision and shows what replaced it. A silently vanished test
     looks identical to one that was never written. */
  const before = C.list().length;
  ck('an item from ANOTHER shop is now ACCEPTED (multi-shop cart)',
     C.add({ id: 'p9', sellerUid: 'SHOPB', price: 50 }) === true);
  ck('  ...and the basket GREW rather than being replaced',
     C.list().length === before + 1, C.list().length + ' lines');
  ck('  ...the first shop\'s items all survive',
     C.list().filter((i) => (i.sellerUid || '') === 'KASS').length === before);
  ck('groupBySeller partitions the basket for checkout',
     C.groupBySeller().length === 2 &&
     C.groupBySeller().map((g) => g.sellerUid).join(',') === 'KASS,SHOPB',
     C.groupBySeller().map((g) => g.sellerUid).join(','));
  ck('removeBySeller clears ONE shop and keeps the rest',
     (function () {
       const n = C.removeBySeller('SHOPB');
       return n === 1 && C.list().every((i) => (i.sellerUid || '') !== 'SHOPB') && C.list().length === before;
     })());
  /* Re-add so the remaining assertions see the same basket they expect. */
  C.add({ id: 'p9', sellerUid: 'SHOPB', price: 50 });

  /* An item with no seller is UNKNOWN, not a violation — legacy and POS rows. */
  ck('an item with NO seller is still accepted (unknown ≠ violation)',
     C.add({ id: 'p4', price: 10 }) === true);

  /* Empty cart accepts anything — nothing to disagree with. */
  C.clear();
  ck('after clear(), a different shop is accepted',
     C.add({ id: 'p9', sellerUid: 'SHOPB', price: 50 }) === true);
  ck('sellerOf reads sellerUid or sellerId',
     C.sellerOf({ sellerUid: 'A' }) === 'A' && C.sellerOf({ sellerId: 'B' }) === 'B');
}

/* ══ B. Server layer — the authority ════════════════════════════════════ */
console.log('\nB. Server rejects mixed sellers, before any order exists\n');
{
  const P = strip(fs.readFileSync(path.join(ROOT, 'functions', 'payment-purposes.js'), 'utf8'));

  ck('the seller set is derived from PRODUCT documents',
     /collection\('products'\)/.test(P) && /lines\.map\(\(l\) => l\.sellerUid\)/.test(P));
  ck('more than one seller is rejected',
     /orderSellers\.length > 1\)\s*\n?\s*fail\('failed-precondition'/.test(P));
  ck('  ...with a message naming the cause',
     /Cart spans multiple sellers/.test(P));

  /* The gap closed on 2026-08-26. */
  ck('NO client fallback for the seller identity',
     !/orderSellers\[0\] \|\| String\(data\.sellerUid/.test(P));
  ck('  ...an unattributable cart is REJECTED, not filled in',
     /if \(!orderSellers\.length\)\s*\n?\s*fail\('failed-precondition'/.test(P));
  ck('  ...and sellerUid is taken only from the derived set',
     /const sellerUid = orderSellers\[0\];/.test(P));
  /* Negative control — the detector must see the old shape. */
  ck('  negative control: detector DOES flag the old fallback',
     /orderSellers\[0\] \|\| String\(data\.sellerUid/
       .test("const sellerUid = orderSellers[0] || String(data.sellerUid || '') || null;"));

  ck('this runs in createPaymentIntent pricing — before any order write',
     /priceFor/.test(P) && !/collection\('orders'\)/.test(P));
}

/* ══ C. Defence in depth — at the order writer ══════════════════════════ */
console.log('\nC. The order writer revalidates\n');
{
  const I = strip(fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8'));
  ck('_finalizeMarketplacePayment derives the line sellers',
     /_lineSellers = \[\.\.\.new Set\(/.test(I));
  ck('  ...and refuses to write an order spanning sellers',
     /_lineSellers\.length > 1\)[\s\S]{0,400}?throw new Error\(/.test(I));
  ck('  ...loudly, with the sellers named in the log',
     /REFUSED: order lines span sellers/.test(I));
  ck('lines with NO seller are not treated as a violation (POS/operator rows)',
     /\.filter\(Boolean\)/.test(I.slice(I.indexOf('_lineSellers'), I.indexOf('_lineSellers') + 300)));
}

/* ══ D. The contract exists and says the right thing ════════════════════ */
console.log('\nD. Contract\n');
{
  const Draw = fs.readFileSync(path.join(ROOT, 'docs', 'CHECKOUT_CONTRACT.md'), 'utf8');
  /* The invariant is a wrapped blockquote, so its sentences span lines with a
     leading "> " on each. Flatten before matching, or a correctly-worded
     contract reads as a missing clause. */
  const D = Draw.replace(/\n>\s?/g, ' ').replace(/\s+/g, ' ');
  ck('the invariant is stated verbatim', /exactly one shop\/seller/.test(D));
  ck('  ...requiring derivation from product documents',
     /derived from authoritative product documents, never from a client-supplied/.test(D));
  ck('  ...and forbidding an order before it passes',
     /No order document may be created before this invariant passes/.test(D));
  ck('missing sellerUid is defined as a rejection',
     /reject — never fall back|Missing `sellerUid` is a rejection/.test(D));
  ck('multiple products/quantities from one shop are explicitly allowed',
     /Multiple quantities and multiple distinct products from that same shop are permitted/.test(D));
  ck('it is SEPARATE from the commission contract',
     /Deliberately separate from \[\[COMMISSION_ENFORCEMENT_CONTRACT\]\]/.test(D));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
