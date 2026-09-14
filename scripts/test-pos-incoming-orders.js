#!/usr/bin/env node
/* POS incoming-order popup — the invitation, never the decision.
 *
 * The concurrency itself is proved against a real Firestore by
 * scripts/test-order-claim-race.js. THIS suite guards the property that suite
 * cannot see: that the popup never becomes the authority.
 *
 * A UI that wrote `claimedBy` itself would pass a race test run against the
 * server function and still be wrong in production, because the browser would be
 * deciding who gets the order.
 *
 *   node scripts/test-pos-incoming-orders.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT  = path.join(__dirname, '..');
const read  = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const P   = strip(read('pos.js'));
const SRV = strip(read('functions', 'order-claim.js'));
/* Only the popup module, so "never writes the order" is scoped to it. */
const INC = (P.split('const incoming = {')[1] || '').split('const manualPay = {')[0];

/* ══ A. Broadcast ══════════════════════════════════════════════════════════ */
console.log('\nA. Broadcast to eligible stations\n');
{
  ck('scoped to THIS shop', /'sellerUid', '==', uid/.test(P));
  ck('only UNCLAIMED orders are offered', /'claimedBy', '==', null/.test(P));
  ck('a claimed order leaves the query on every station',
     /chg\.type === 'removed'/.test(P));
  ck('orders STACK — a supermarket is not a single-file queue',
     /incoming-order-stack/.test(P) && /appendChild\(card\)/.test(P));
  ck('only one listener is ever opened', /if \(incoming\._unsub\) return;/.test(P));
  ck('a stop\\(\\) exists to release it', /stop\(\)/.test(INC));
}

/* ══ B. The popup is NOT the authority ═════════════════════════════════════ */
console.log('\nB. The server decides, not the screen\n');
{
  ck('taking an order calls the claimOrder function', /'claimOrder'/.test(P));
  ck('the popup NEVER writes the order document',
     !/(updateDoc|setDoc|runTransaction)\(/.test(INC));
  ck('  ...and never sets claimedBy itself', !/claimedBy\s*[:=]\s*[^n]/.test(INC));
  ck('the server resolves the race in a transaction',
     /runTransaction\(async \(txn\)/.test(SRV));
  ck('  negative control: detector WOULD see a client write',
     /(updateDoc|setDoc)\(/.test('await setDoc(ref, { claimedBy: uid });'));
}

/* ══ C. Losing is normal ═══════════════════════════════════════════════════ */
console.log('\nC. A loss is an outcome, not an error\n');
{
  ck('the loser is told it was already taken',
     /Already taken by another employee/.test(P));
  ck('  ...and is NOT shown a failure', !/failed to claim|error claiming/i.test(P));
  ck('the card is dismissed afterwards', /setTimeout\(\(\) => incoming\._dismiss/.test(P));
  ck('the server returns a loss as data, not an exception',
     /return res;/.test(SRV) && !/throw new HttpsError\('aborted'/.test(SRV));
  ck('double-tap is guarded per order', /incoming\._busy\[orderId\]/.test(P));
}

/* ══ D. Orthogonal to payment ══════════════════════════════════════════════ */
console.log('\nD. Payment method does not gate claiming\n');
{
  ck('the popup does not branch on payment method to allow/deny',
     !/paymentMethod[\s\S]{0,140}?return;/.test(INC));
  ck('the server claim never inspects paymentMethod', !/paymentMethod/.test(SRV));
  ck('claiming writes ONLY claim fields — no status/payment/inventory',
     !/txn\.update\(ref, \{[\s\S]{0,300}?(status|paymentStatus|inventoryApplied):/.test(SRV));
}

/* ══ E. Resilience + audit ═════════════════════════════════════════════════ */
console.log('\nE. Resilience and audit\n');
{
  ck('boot is guarded — a listener failure cannot blank the shell',
     /try \{ incoming\.start\(\); \} catch \(_\) \{\}/.test(P));
  ck('listener errors are caught, not thrown', /\[incoming\] listener:/.test(P));
  ck('device id is sent for the audit trail', /sokoni_device_id/.test(P));
  ck('the server records who claimed and in what role',
     /claimedByRole: auth\.as/.test(SRV) && /claimedBy:\s+String\(uid\)/.test(SRV));
  ck('exported on the SPos namespace', /manualPay, incoming,/.test(P));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
