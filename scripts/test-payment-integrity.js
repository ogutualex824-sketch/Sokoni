#!/usr/bin/env node
/**
 * test-payment-integrity.js — the money path. Static analysis. TAKES NO PAYMENT.
 *
 * This exists because checkout.html shipped a function that told the customer
 *
 *     "✅ Payment Confirmed — KES X received. Order placed!"
 *
 * after waiting 1600ms on a setTimeout. It contacted no provider, called no Cloud
 * Function, and then wrote a real order to Firestore. Six payment methods
 * (Airtel Money, T-Kash, Equity EazzY, MTN MoMo, EcoCash, Chipper Cash) used it,
 * and none of them has any backend integration anywhere in functions/.
 *
 * The customer paid nothing, was told they had paid, and the seller shipped.
 *
 * These checks guard the rule that failure broke — CLAUDE.md, verbatim:
 *   "Never trust client-side payment confirmation."
 * It didn't merely trust the client. It invented the confirmation ON the client.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const checkout = fs.readFileSync(path.resolve('checkout.html'), 'utf8');

/* Strip comments so we test the CODE, not the prose describing the old bug.
   (Earlier guards in this repo passed by matching text inside the very comment
   that explained the bug was fixed — a test that greps its own documentation
   proves nothing.) */
const code = checkout
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '');

console.log('\nPayment integrity — the money path\n');

/* ── 1. No payment confirmation may be produced by a timer ───────────────── */
{
  /* Find every setTimeout body and check none of them claims payment success
     or creates an order. This is the exact shape of the shipped bug. */
  const timers = code.match(/setTimeout\s*\(\s*(?:\(\s*\)\s*=>|function\s*\([^)]*\)\s*)\{[\s\S]{0,400}?\}/g) || [];
  const guilty = timers.filter(t =>
    /Payment Confirmed|payment confirmed|saveAndRedirect\s*\(/.test(t)
  );
  guilty.length === 0
    ? ok('no setTimeout fabricates a payment confirmation or creates an order')
    : bad(`a timer confirms payment / places an order — the customer would be told they paid when they did not:\n        ${guilty[0].slice(0, 160).replace(/\n\s*/g, ' ')}…`);
}

/* ── 2. Unintegrated methods cannot be selected ──────────────────────────── */
{
  /^\s*$/.test('') && null;
  const listed = /UNINTEGRATED_PAYMENTS\s*=\s*\[([^\]]*)\]/.exec(code);
  if (!listed) {
    bad('UNINTEGRATED_PAYMENTS list is gone — nothing stops an unintegrated method being offered');
  } else {
    const methods = (listed[1].match(/"([a-z]+)"|'([a-z]+)'/g) || []).map(s => s.replace(/['"]/g, ''));
    methods.length >= 6
      ? ok(`${methods.length} payment methods with no backend are blocked (${methods.join(', ')})`)
      : bad(`only ${methods.length} methods blocked — a provider with no integration may be reachable`);

    /* The guard must run inside selectPayment and RETURN before anything is selected.
       Check the OPENING of the function — the refusal has to come before any
       assignment, so a window from the function start is exactly the right scope. */
    const at  = code.indexOf('function selectPayment');
    const top = at === -1 ? '' : code.slice(at, at + 600);
    /UNINTEGRATED_PAYMENTS\.includes\([\s\S]{0,300}?return;/.test(top)
      ? ok('selectPayment() refuses an unintegrated method and returns before selecting it')
      : bad('selectPayment() does not block unintegrated methods — the dead-end path is reachable again');

    /* The refusal must precede `selectedPayment = method`, or it selects then bails. */
    const assignAt = top.indexOf('selectedPayment = method');
    const guardAt  = top.indexOf('UNINTEGRATED_PAYMENTS.includes');
    (guardAt !== -1 && (assignAt === -1 || guardAt < assignAt))
      ? ok('the refusal runs BEFORE the method is assigned (never selected, never opened)')
      : bad('the method is assigned before the guard runs');
  }
}

/* ── 3. processMobileMoney must never place an order ─────────────────────── */
{
  const fn = /function processMobileMoney\s*\([\s\S]{0,900}?\n\}/.exec(code);
  if (!fn) {
    ok('processMobileMoney() no longer exists (removed entirely)');
  } else {
    !/saveAndRedirect\s*\(/.test(fn[0])
      ? ok('processMobileMoney() cannot create an order')
      : bad('processMobileMoney() still calls saveAndRedirect — it can place an unpaid order');

    !/Payment Confirmed/i.test(fn[0])
      ? ok('processMobileMoney() no longer claims the payment succeeded')
      : bad('processMobileMoney() still tells the customer their payment was confirmed');
  }
}

/* ── 4. The one REAL provider still confirms from the provider, not the UI ─ */
{
  /onSuccess\s*\(\s*receipt\s*\)/.test(code) && /onFailure\s*\(/.test(code)
    ? ok('M-Pesa still confirms from the provider callback (onSuccess/onFailure), not from the client')
    : bad('the M-Pesa provider callback is gone — payment confirmation may no longer be provider-driven');

  /* An order created on the M-Pesa path must use the SERVER-issued order id. */
  /saveAndRedirect\(\s*receipt\.mpesaCode[^\n]*_ordId/.test(code)
    ? ok('the M-Pesa order uses the server-issued orderId (no client-side order-ID forgery)')
    : bad('the M-Pesa path no longer passes the server orderId — client could forge an order id');
}

/* ── 5. An order is only "paid" when a PROVIDER said so ──────────────────────
   saveAndRedirect() used to hardcode status:"paid" for every method — card, PayPal,
   bank transfer, and six providers with no integration at all. The order status is
   what tells a seller it is safe to ship. It must reflect money, not optimism. */
{
  !/status:\s*["']paid["']\s*,/.test(code)
    ? ok('order status is never hardcoded to "paid" — it is derived from provider verification')
    : bad('order status is hardcoded "paid" — unpaid orders would be marked paid and sellers would ship them');

  /paymentVerified\s*===\s*true/.test(code)
    ? ok('only an explicit provider confirmation can mark an order paid (fails closed)')
    : bad('payment verification does not fail closed');

  /status:\s*_paid\s*\?\s*["']paid["']\s*:\s*["']pending_payment["']/.test(code)
    ? ok('unverified orders are written as "pending_payment" — DO NOT SHIP')
    : bad('unverified orders are not distinguishable from paid ones');
}

/* ── 6. No simulation path may exist in payment code ─────────────────────────
   Three separate fallbacks simulated success when config was missing or a script
   failed to load: _runDemoStkPush (fake STK, fake PIN prompt, fake confirmation),
   _cardFallback ("simulate approval then save order"), and the no-verification-URL
   branch. Each was one empty config value away from giving stock away in production. */
{
  const sims = [];
  const demoStk = /function _runDemoStkPush[\s\S]{0,700}?\n\}/.exec(code);
  if (demoStk && /saveAndRedirect\s*\(/.test(demoStk[0])) sims.push('_runDemoStkPush');

  const cardFb = /function _cardFallback[\s\S]{0,700}?\n\}/.exec(code);
  if (cardFb && /saveAndRedirect\s*\(/.test(cardFb[0])) sims.push('_cardFallback');

  sims.length === 0
    ? ok('no payment fallback simulates success — every fallback fails closed')
    : bad(`payment fallback(s) still place an order without taking money: ${sims.join(', ')}`);
}

console.log('');
if (fail) {
  console.error(`Payment integrity FAILED (${fail}) — DO NOT SHIP\n`);
  process.exit(1);
}
console.log(`Payment integrity PASSED (${pass} checks) — no payment taken\n`);
