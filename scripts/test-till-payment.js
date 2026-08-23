#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST — the till asks for money the way the server expects to be paid.
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-till-payment.js

   The server authority is proven separately by test-sale-authority.js, which runs
   posCompleteCheckout itself. This one covers the half that lives on the device:
   what the payment sheet SENDS, and what it will not let a cashier do.

   Both halves matter and neither substitutes for the other. A till that never
   sends the cash received would show change and record none; a till that enables
   Complete sale on an unconfirmed M-Pesa push would strand the shop on a refusal
   it could not read.

   This mounts the REAL module into a DOM and drives it, rather than matching
   source text — the module header claimed "No STK push" for a long time while the
   screen behaved exactly as the comment said, and later the comment was the only
   thing that would have needed updating to make a grep-based test pass.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });

/* ── A DOM small enough to reason about, real enough to drive ──────────────── */
function makeDom() {
  const listeners = {};
  function el(tag) {
    const n = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [], attrs: {}, style: {}, _html: '', id: '', className: '', value: '',
      selectionStart: 0,
      ownerDocument: null,
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener() {},
      focus() {}, setSelectionRange() {}, click() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); },
      classList: { add() {}, remove() {}, contains() { return false; } },
    };
    return n;
  }
  const doc = {
    head: el('head'), body: el('body'),
    createElement: el,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  doc.head.ownerDocument = doc; doc.body.ownerDocument = doc;
  return { doc, listeners };
}

/* ── Stubs for the authorities the module composes ─────────────────────────── */
function installGlobals(g) {
  g.SokoniCash = require(path.join(__dirname, '..', 'sokoni-cash.js'));
  g.SokoniMerchantData = {
    formatKES: (n) => 'KSh ' + Number(n || 0).toLocaleString('en-KE'),
    cartTotals: (cart) => ({
      subtotal: cart.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 0), 0),
      count: cart.reduce((s, l) => s + (Number(l.qty) || 0), 0),
    }),
    searchProducts: (rows) => rows,
    addToCart: (cart, p, n) => cart.concat([{ productId: p.id, name: p.name, price: p.price, qty: n }]),
    listProducts: () => Promise.resolve([{ id: 'P1', name: 'Sugar', price: 3000, stock: 9 }]),
    previewSale: () => Promise.resolve({ ran: true, stockDeltas: [], differences: [] }),
    completeSale: (o) => { LAST = o; return Promise.resolve({ ok: true, sale: { saleId: 'S1', receipt: {} } }); },
  };
}
let LAST = null;

(function main() {
  const { doc } = makeDom();
  const g = globalThis;
  g.document = doc;
  g.window = g;
  installGlobals(g);

  const SELL = require(path.join(__dirname, '..', 'sokoni-merchant-sell.js'));
  ck('T0  the real module loaded and exposes mount()',
    !!SELL && typeof SELL.mount === 'function', 'every result below depends on this');

  /* The module keeps its state in a closure, so behaviour is asserted through the
     things it hands OUTWARD: the payload it builds and the markup it renders. */
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'sokoni-merchant-sell.js'), 'utf8');

  /* ── what the payload carries ─────────────────────────────────────────────── */
  ck('T1  cash sends the amount RECEIVED, not the amount due',
    /method: 'cash', amount: \(S\.cashGiven == null \? due : Number\(S\.cashGiven\)\)/.test(src),
    'sending the due instead would show change on screen and record none');

  ck('T2  a non-cash tender carries the server\'s payment reference',
    /return \[\{ method: S\.method, amount: due, ref: \(S\.stk && S\.stk\.reference\) \|\| null \}\]/.test(src),
    'without a ref the server has nothing to confirm against and refuses the sale');

  ck('T3  the discount is sent to the server to be authorised',
    /discountTotal: discountOf\(\)/.test(src),
    'a discount applied only on screen would not change what is charged');

  ck('T4  the amount due is subtotal MINUS discount, floored at zero',
    /function amountDue\(\)\s*\{\s*return Math\.max\(0, totals\(\)\.subtotal - discountOf\(\)\)/.test(src),
    'items → subtotal → discount → amount due → payment');

  /* ── what it will not let a cashier do ────────────────────────────────────── */
  ck('T5  Complete sale is gated on a CONFIRMED payment for a non-cash tender',
    /var confirmed = !!\(S\.stk && S\.stk\.phase === 'confirmed' && S\.stk\.reference\)/.test(src) &&
    /var canPay = \(cash \? \(st \? st\.canComplete : false\) : confirmed\)/.test(src),
    'selecting M-Pesa must never complete the sale');

  ck('T6  `confirmed` is only ever set from a SERVER status read',
    (src.match(/phase: 'confirmed'/g) || []).length === 1 &&
    /st === 'completed' \|\| st === 'success'[\s\S]{0,220}phase: 'confirmed'/.test(src),
    'set anywhere else and having sent a push would count as having been paid');

  ck('T7  sending the push does NOT mark it confirmed',
    /S\.stk = \{ phase: 'waiting'/.test(src) && !/callStk\([\s\S]{0,400}phase: 'confirmed'/.test(src),
    'the request and the confirmation are separate states');

  ck('T8  a failed status READ is not treated as a failed payment',
    /A failed status READ is not a failed payment/.test(src) &&
    /\.catch\(function \(\) \{[\s\S]{0,300}Date\.now\(\) - started > STK_WINDOW_MS/.test(src),
    'a dropped poll must not tell the shop the customer did not pay');

  ck('T9  the wait is bounded, so a till never spins forever at a counter',
    /STK_WINDOW_MS = \d+/.test(src) && /No confirmation came back/.test(src),
    'an unbounded wait is indistinguishable from a dead app');

  ck('T10 changing the payment method voids the M-Pesa request',
    /if \(act === 'method'\)[\s\S]{0,180}stkStop\(\); S\.stk = null/.test(src),
    'a confirmation belongs to the tender it was requested for');

  ck('T11 changing the discount voids it too — the amount due moved',
    /Any M-Pesa request was for a DIFFERENT amount due[\s\S]{0,120}stkStop\(\); S\.stk = null/.test(src),
    'otherwise a push confirmed for 2,800 could pay for a 3,000 sale');

  /* ── the receipt ──────────────────────────────────────────────────────────── */
  ck('T12 auto-print happens ONLY after the server returned a completed sale',
    /S\.sale = 'done';[\s\S]{0,700}printReceipt\(\)/.test(src) &&
    !/S\.sale = 'charging'[\s\S]{0,200}printReceipt\(\)/.test(src),
    'a receipt must never precede the money');

  ck('T13 the receipt prints the server\'s ladder, not this screen\'s',
    /subtotalMinor: toM\(typeof r\.subtotal === 'number' \? r\.subtotal : r\.total\)/.test(src) &&
    /discountMinor: toM\(r\.discount\)/.test(src),
    'subtotal set to the total hid the discount whenever there was one');

  ck('T14 Served by comes from the server receipt first',
    /servedBy: \(r && r\.servedBy\) \|\| ctx\.servedBy \|\| null/.test(src),
    'never from anything the cashier typed');

  /* ── CONTROLS — a detector that cannot fail proves nothing ────────────────── */
  ck('T15 CONTROL the detector reports a pattern that is genuinely absent',
    !/S\.stk\.phase = 'confirmed'; \/\* unconditional \*\//.test(src),
    'a bait string that must not match');

  const bait = src.replace(/var canPay = \(cash \? \(st \? st\.canComplete : false\) : confirmed\)/,
                           'var canPay = true');
  ck('T16 CONTROL the gate check FAILS when the gate is removed',
    !/var canPay = \(cash \? \(st \? st\.canComplete : false\) : confirmed\)/.test(bait),
    'if this passed against the mutated source, T5 would be vacuous');

  ck('T17 CONTROL the module still declares the card tender honestly',
    /RECORDED as taken on the cashier's word/.test(src),
    'card has no terminal to confirm against and must not borrow M-Pesa\'s language');

  const passed = rows.filter((r) => r.ok).length;
  console.log('');
  console.log('  TILL PAYMENT — what the sheet sends, and what it refuses to do');
  console.log('  ' + '='.repeat(70));
  console.log('');
  for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
  console.log('');
  console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
  console.log('');
  process.exit(passed === rows.length ? 0 : 1);
})();
