#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   PAYMENT PROVIDER POLICY — IntaSend only
   scripts/test-payment-provider-policy.js

   SOKONI offers ONE payment provider. PayPal was retired 2026-09-22 because it
   was never wired: `sokoni-config.js` shipped `paypalEmail: ""`, so the
   checkout link was never built — yet the option was still selectable, showed
   "Redirecting to PayPal", opened nothing, and still recorded an order.

   And the link it WOULD have built was wrong:

       "https://www.paypal.me/" + user + "/" + orderTotal + "USD"

   `orderTotal` is in KES. A KES 5,000 order would have been presented to the
   customer as USD 5,000 — roughly 130x. That defect was one config field away
   from live, which is why the field is now absent rather than blank.

   WHAT THIS GUARD DOES NOT CLAIM
   `checkout.html` still contains the PayPal option. It is another agent's
   dirty file and was not edited. C4 records that as a KNOWN REMAINING
   SURFACE — deliberately visible rather than hidden, so a green run here can
   never be read as "PayPal is fully retired".

   Run:  node scripts/test-payment-provider-policy.js
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const has = (f) => fs.existsSync(path.join(ROOT, f));

let pass = 0, fail = 0;
const lines = [];
function ok (id, cond, msg) {
  if (cond) { pass++; lines.push('  PASS  ' + id + '  ' + msg); }
  else      { fail++; lines.push('  FAIL  ' + id + '  ' + msg); }
}

/* ── C1 · the arming switch is GONE, not blanked ─────────────────────────
   Absent is materially different from "". checkout.html reads the key with
   optional chaining, so both yield a null link — but only a present key
   invites someone to fill it in. */
const cfg = R('sokoni-config.js');
ok('C1', !/paypalEmail\s*:/.test(cfg),
   'sokoni-config.js no longer declares paypalEmail (the field that would arm it)');
ok('C1b', /IntaSend is the payment provider|RETIRED 2026-09-22/.test(cfg),
   'the config records WHY the key is absent, so it is not re-added as an oversight');

/* ── C2 · no owned surface OFFERS PayPal ─────────────────────────────────
   Marketing copy, structured data, legal disclosure and merchant settings.
   checkout.html is excluded and tracked separately in C4. */
[['index.html',            'structured data + footer badge'],
 ['seo.js',                'structured data + FAQ answers'],
 ['legal.html',            'terms + privacy processor list'],
 ['script.js',             'assistant reply'],
 ['minishop-admin.html',   'merchant payment-method settings'],
 ['sokoni-gateway.js',     'outbound host allow-list'],
 ['sokoni-webhook-engine.js', 'provider enum'],
].forEach(([f, what], i) => {
  if (!has(f)) { ok('C2.' + (i + 1), false, f + ' is missing — guard cannot run'); return; }
  ok('C2.' + (i + 1), !/paypal/i.test(R(f)), f + ' — no PayPal in ' + what);
});

/* ── C3 · IntaSend is still present ──────────────────────────────────────
   ALLOW CONTROL. A guard that merely asserts an absence would also pass if
   every payment provider had been deleted. */
ok('C3', /intasend/i.test(cfg), 'CONTROL — IntaSend IS still configured (not an empty-payments pass)');
ok('C3b', /intasendKey|intasendLive/.test(cfg), 'CONTROL — the IntaSend keys survive');

/* ── C4 · the surface NOT yet retired, stated openly ─────────────────────
   Reported, never silently exempted. When checkout.html is handed over, the
   remaining work is: remove the #payPaypal card, the paypalOverlay modal, the
   `type === "paypal"` branch and the ppLink builder. */
if (has('checkout.html')) {
  const co = R('checkout.html');
  const n  = (co.match(/paypal/gi) || []).length;
  const offers = /id="payPaypal"|selectPayment\('paypal'\)/.test(co);
  lines.push('  NOTE  C4  checkout.html still contains ' + n + ' PayPal reference(s)' +
    (offers ? ' and STILL OFFERS the option' : '') +
    ' — foreign dirty file, NOT edited. Retirement is INCOMPLETE until it is.');
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  PAYMENT PROVIDER POLICY — IntaSend only');
console.log('══════════════════════════════════════════════════════════════════');
lines.forEach((l) => console.log(l));
console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
console.log('  SCOPE: owned surfaces only. A green run does NOT mean PayPal is');
console.log('  fully retired — see C4.');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail === 0 ? 0 : 1);
