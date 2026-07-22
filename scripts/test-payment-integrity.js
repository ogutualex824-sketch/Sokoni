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

  /* This assertion used to require `status: _paid ? "paid" : "pending_payment"`,
     which permitted the client to write "paid" whenever it believed payment had
     succeeded. The implementation was then hardened past that: the client writes
     "pending_payment" unconditionally and never asserts payment state at all.

     The old assertion therefore failed BECAUSE the weakness it tolerated had
     been removed — a stale test reporting "DO NOT SHIP" against safer code.
     Left as it was, the pressure would have been to weaken checkout back until
     its own test suite was satisfied.

     Rewritten around the invariant that actually holds now, which is stronger
     and harder to satisfy by accident: the client never sets an authoritative
     payment state, in any branch. */
  const statusWrites = [...code.matchAll(/status:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  const clientAssertsPaid = statusWrites.filter((v) => /["']paid["']/.test(v));

  clientAssertsPaid.length === 0
    ? ok('the client never writes an authoritative "paid" status — in any branch')
    : bad('the client writes "paid" in ' + clientAssertsPaid.length + ' place(s): ' + clientAssertsPaid.join(' | '));

  /pending_payment/.test(code)
    ? ok('orders are created as "pending_payment" and must not be fulfilled until the server confirms')
    : bad('no pending_payment state — an unverified order is indistinguishable from a paid one');

  /* The server must be the only writer of payment state. If checkout ever gains
     a paymentVerified or paidAt write, the trust boundary has moved back to the
     client without anyone noticing. */
  !/paymentVerified:\s*true/.test(code) && !/paidAt:\s*[^n]/.test(code)
    ? ok('the client sets neither paymentVerified nor paidAt — only the Admin SDK callback does')
    : bad('the client writes paymentVerified or paidAt — payment authority has moved back to the client');
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

/* ── 7. No success claim outside a server-verified branch ────────────────────
   The customer may never read "Payment Confirmed" / "Order Placed" / "Card Approved"
   unless a server-side confirmation exists. Neutral states only until then:
   "Confirming payment…", "Awaiting payment confirmation", "Payment request sent". */
{
  const CLAIMS = /Payment Confirmed|Payment Successful|Payment Received|Card Approved|Order Placed/i;

  /* The ONLY places allowed to claim success are branches where a PROVIDER or the SERVER
     has confirmed the money moved. There are exactly three:
       onSuccess(receipt)     — the M-Pesa provider callback, carrying a real receipt
       verifyData.verified    — the server confirmed with the provider
       if(_paid){ … }         — the overlay branch, which only runs when one of the above did
     Anything else claiming success is a lie told to the customer. */
  const blocks = [
    /onSuccess\(receipt\)\s*\{[\s\S]{0,500}?\n\s{8}\}/.exec(checkout),
    /verifyData\.verified[\s\S]{0,800}?\n\s{6}\}/.exec(checkout),
    /if\(_paid\)\{[\s\S]{0,900}?\n\s{4}\}/.exec(checkout),
  ];
  const exempt = blocks.filter(Boolean).map(b => b[0]).join('\n');

  /* Scan the RAW file so reported line numbers are real, skipping comment lines —
     the fix's own explanatory comments quote the old strings verbatim. */
  const offenders = [];
  let inJs = false, inHtml = false;
  checkout.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (inJs)   { if (t.includes('*/'))  inJs = false;   return; }
    if (inHtml) { if (t.includes('-->')) inHtml = false; return; }
    if (t.startsWith('/*'))   { if (!t.includes('*/'))  inJs = true;   return; }
    if (t.startsWith('<!--')) { if (!t.includes('-->')) inHtml = true; return; }
    if (t.startsWith('*') || t.startsWith('//')) return;

    if (!CLAIMS.test(line)) return;
    if (exempt.includes(t)) return;                        /* inside a verified branch — fine */
    if (/label:\s*"Order Placed"/.test(line)) return;      /* fulfilment timeline label, not a payment claim */
    if (/hEl\.textContent|<h2 /.test(line)) return;        /* overlay heading — set conditionally on _paid */
    offenders.push(`L${i + 1}: ${t.slice(0, 90)}`);
  });

  offenders.length === 0
    ? ok('no "Payment Confirmed"/"Order Placed" claim outside a server-verified branch')
    : bad(`the customer is told payment succeeded without server verification:\n        ${offenders.join('\n        ')}`);

  /* The STK progress UI must not declare victory on the client-side COMPLETE event. */
  !/<h4>✅ Payment Confirmed<\/h4>/.test(checkout)
    ? ok('the STK progress step stays neutral until the server confirms')
    : bad('STK step 3 claims "Payment Confirmed" on a client-side event');
}

/* ── 8. Unverified orders promise nothing ────────────────────────────────────*/
{
  /It will not be dispatched until payment is verified/.test(checkout)
    ? ok('an unverified order tells the customer plainly it will not be dispatched')
    : bad('an unverified order does not warn the customer it will not ship');
}

/* ── 9. Nothing downstream may act on an UNPAID order ────────────────────────
   Fixing the checkout UI is only half of it. Two server triggers fired on order
   CREATE with no payment gate at all:

     onNewOrderCreated    pushed + SMSed + in-apped the seller "New Order! ... Confirm
                          it to begin processing" and incremented pendingOrders. That is
                          a FULFILMENT PROMPT. It is how a seller ends up shipping goods
                          against a payment that never happened.

     emailOnOrderCreated  emailed the customer an "order-confirmation". For an unpaid
                          order that email IS the false confirmation — the same lie the
                          checkout told on screen, now in the customer's inbox where it
                          looks even more official.

   Orders may EXIST before payment. They must not REACH anyone before payment. */
{
  const gated = (file, fn) => {
    const src = fs.readFileSync(path.resolve(file), 'utf8');
    const at  = src.indexOf(fn);
    if (at === -1) return null;
    const body = src.slice(at, at + 2500);
    return /status\s*!==\s*['"]paid['"][\s\S]{0,80}paymentVerified\s*!==\s*true[\s\S]{0,200}return/.test(body);
  };

  const checks = [
    ['functions/index.js',          'exports.onNewOrderCreated',   'the seller is not told to fulfil an unpaid order'],
    ['functions/email-triggers.js', 'exports.emailOnOrderCreated', 'the customer gets no confirmation email for an unpaid order'],
  ];

  checks.forEach(([file, fn, what]) => {
    const g = gated(file, fn);
    if (g === null)  bad(`${fn} not found in ${file} — the payment gate cannot be verified`);
    else if (g)      ok(what);
    else             bad(`${fn} has NO payment gate — it acts on orders that nobody has paid for`);
  });
}

console.log('');
if (fail) {
  console.error(`Payment integrity FAILED (${fail}) — DO NOT SHIP\n`);
  process.exit(1);
}
console.log(`Payment integrity PASSED (${pass} checks) — no payment taken\n`);
