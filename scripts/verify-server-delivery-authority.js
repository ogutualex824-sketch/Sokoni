#!/usr/bin/env node
/* The server prices delivery. The client does not.
 *
 * functions/index.js once accepted request.data.deliveryFee and clamped it to
 * 0..5000. A bounded lie is still a lie: inside that range the CLIENT decided
 * what delivery cost, and the only defence was that it could not be made
 * arbitrarily large. This gate keeps the clamp from coming back — the pattern is
 * easy to reintroduce because it looks like validation.
 */
'use strict';
const fs = require('fs'), path = require('path');

const SRC = path.join(__dirname, '..', 'functions', 'index.js');
const s = fs.readFileSync(SRC, 'utf8');
const fail = [];

/* 1. The clamp itself, in any spacing. */
if (/Math\.min\(\s*Math\.max\(\s*clientDelivery/.test(s.replace(/\s*\/\*[\s\S]*?\*\//g, ''))) {
  const legacyOk = /merchant has no deliveryConfig/.test(s);
  if (!legacyOk) fail.push('a client-supplied delivery fee is clamped and accepted as authoritative');
}

/* 2. The recompute must go through the shared engine, not a local formula. */
if (!/require\(['"]\.\/shared\/delivery-engine\.js['"]\)/.test(s)) {
  fail.push('server does not load the shared delivery engine');
}
if (!/calculateDelivery\(/.test(s)) fail.push('server never calls calculateDelivery()');

/* 3. A mismatch must REJECT, not absorb. Silently substituting the server figure
      charges a total the customer never agreed to. */
if (!/delivery_fee_mismatch/.test(s)) fail.push('no delivery_fee_mismatch audit record');
const seg = s.slice(s.indexOf('delivery_fee_mismatch'), s.indexOf('delivery_fee_mismatch') + 1600);
if (!/throw new HttpsError/.test(seg)) fail.push('a delivery fee mismatch does not reject the request');
if (!/serverDeliveryFee/.test(seg)) fail.push('the authoritative fee is not returned to the client');

/* 4. The audit record must carry every field needed to investigate. */
for (const f of ['merchantId', 'orderId', 'clientFee', 'serverFee', 'deliveryMode']) {
  if (!new RegExp(f + '\s*:').test(seg)) fail.push('audit record omits ' + f);
}

/* 5. Merchants with no config must be VISIBLE, not silently trusted. */
if (!/delivery_fee_unverified/.test(s)) {
  fail.push('unconfigured merchants are trusted without leaving a record');
}

if (fail.length) {
  console.error('FAIL server delivery authority');
  fail.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('PASS server is authoritative for delivery pricing');
