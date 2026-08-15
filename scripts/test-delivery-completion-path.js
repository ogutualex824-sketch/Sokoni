#!/usr/bin/env node
/* Rider delivery completion is a SERVER decision on BOTH surfaces  (Priority 4)
 *
 *   node scripts/test-delivery-completion-path.js
 *
 * WHY THIS EXISTS
 * f9b7951 closed the rider-self-certification hole on the packageRequest surface:
 * the rider compared a PIN their own client had fetched, then wrote
 * orders/{id}.status='delivered', which onOrderStatusChange pays them for.
 *
 * driver.html had a SECOND rider completion surface that was left behind —
 * `_ordDeliver`, reached from the order-based listener:
 *
 *   _startOrderDeliveryListener → SokoniDB.listenRiderActiveOrders
 *     (orders where assignedDriverUid == me and status in [.., in_transit])
 *   → _showOrderDelivery → _orderDelivActionBtns (status === 'in_transit')
 *   → "🎉 Mark as Delivered" → _ordDeliver
 *
 * It kept the original shape: a client-side compare against `ordSnap.proofPin`
 * (with `if (ordSnap?.proofPin)` meaning no PIN → no check) and then
 * riderDelivered() → transitionOrder() → a CLIENT write of status:'delivered'.
 *
 * firestore.rules already refused that write, so it was a FUNCTIONAL DEAD END, not
 * an open hole — the rider tapped the button and got permission-denied. A real
 * order (SKN0SWYXPD, in_transit, assignedDriverUid + deliveryRef) was sitting in
 * exactly that state when this was audited.
 *
 * These tests pin the conversion: the surface now calls the same authoritative
 * callable, and the client-trust shape cannot come back.
 *
 * SCOPE NOTE: `packageRequests.proofPin` is deliberately NOT removed here. It is
 * legacy and confusing — the rider can read it and it proves nothing, because the
 * server verifies `deliveryPinHash`, derived from a PIN only the BUYER holds — but
 * four consumers still reference it, so it is a separate remediation.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DRIVER = fs.readFileSync(path.join(ROOT, 'driver.html'), 'utf8');
const ORDERS = fs.readFileSync(path.join(ROOT, 'sokoni-orders.js'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 74) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

/* Isolate the function body so assertions cannot be satisfied by unrelated code
   elsewhere in a 200 KB page — the whole point is what THIS path does. */
const START = DRIVER.indexOf('window._ordDeliver = async function');
const BODY = START > -1 ? DRIVER.slice(START, DRIVER.indexOf('\nwindow.', START + 10)) : '';

(async () => {

  /* ══ 1 · the converted path ══ */
  head('1 · _ordDeliver goes through the authoritative callable');
  ck('_ordDeliver still exists', START > -1);
  ck('it obtains the order\'s deliveryRef', /deliveryRef/.test(BODY));
  ck('it calls completeDeliveryWithPin',
     /httpsCallable\('completeDeliveryWithPin'\)/.test(BODY));
  ck('...passing { deliveryRef, pin }', /\{\s*deliveryRef:\s*dRef,\s*pin:\s*otp\s*\}/.test(BODY));
  ck('it no longer calls riderDelivered', !/riderDelivered/.test(BODY));

  /* ══ 2 · the client-trust shape is gone ══ */
  head('2 · no client-side PIN authority remains');
  ck('no comparison against the order\'s plaintext proofPin',
     !/proofPin/.test(BODY.replace(/\/\*[\s\S]*?\*\//g, '')),
     'comment references are allowed; code references are not');
  ck('no `if (proofPin)` no-PIN-no-check bypass',
     !/if\s*\(\s*\w*\??\.?proofPin/.test(BODY));
  ck('no client write of status delivered',
     !/status:\s*['"]delivered['"]/.test(BODY.replace(/\/\*[\s\S]*?\*\//g, '')));
  ck('no deliveredAt stamp from this path',
     !/deliveredAt/.test(BODY.replace(/\/\*[\s\S]*?\*\//g, '')));
  /* The fallback that would undo all of it. */
  ck('NO "if the call fails, write it anyway" fallback',
     !/catch[\s\S]{0,400}(riderDelivered|transitionOrder|updateDoc)/.test(BODY));

  /* ══ 3 · failing safely ══ */
  head('3 · missing inputs fail safely and legibly');
  ck('a missing deliveryRef is refused before any call',
     /if\s*\(!dRef\)/.test(BODY) && BODY.indexOf('if (!dRef)') < BODY.indexOf('completeDeliveryWithPin'));
  ck('...with an explanation rather than a silent return',
     /No delivery record for this order/.test(BODY));
  ck('a malformed PIN is refused client-side (saves a round trip)',
     /\/\^\\d\{4,8\}\$\//.test(BODY));
  ck('...and the PIN check happens BEFORE the callable',
     BODY.indexOf('4,8') < BODY.indexOf('completeDeliveryWithPin'));
  ck('a missing callable is reported, not worked around',
     /Cannot reach the server/.test(BODY));

  /* ══ 4 · the server decides ══ */
  head('4 · the server\'s verdict is what the rider sees');
  ck('a non-ok response is treated as failure', /if\s*\(!_ok\)/.test(BODY));
  ck('the server error message is surfaced verbatim',
     /e\.message\s*\|\|\s*e\.code/.test(BODY) || /\(e && \(e\.message \|\| e\.code\)\)/.test(BODY));
  ck('a wrong PIN cannot produce a success toast',
     BODY.indexOf('Delivered!') > BODY.indexOf('if (!_ok)'));
  ck('an already-completed delivery is reported honestly',
     /alreadyDelivered/.test(BODY));
  ck('the local earnings mirror runs only after _ok',
     BODY.indexOf('drv.earnings') > BODY.indexOf('if (!_ok)'));

  /* ══ 5 · nothing else moved ══ */
  head('5 · the rest of the delivery surface is untouched');
  ck('buyerConfirmDelivery is still the buyer\'s fallback',
     /buyerConfirmDelivery/.test(fs.readFileSync(path.join(ROOT, 'functions', 'delivery-complete.js'), 'utf8')));
  ck('the packageRequest surface still uses the callable',
     (DRIVER.match(/httpsCallable\('completeDeliveryWithPin'\)/g) || []).length === 2,
     (DRIVER.match(/httpsCallable\('completeDeliveryWithPin'\)/g) || []).length + ' call sites');
  ['_ordAccept', '_ordPickedUp', '_ordInTransit'].forEach((f) => {
    ck(f + ' (en-route status, pays nobody) is unchanged', DRIVER.indexOf('window.' + f) > -1);
  });
  ck('riderInTransit still transitions through SokoniOrders',
     /SokoniOrders\.riderInTransit/.test(DRIVER));

  /* ══ 6 · legacy functions retained, but now uncalled ══ */
  head('6 · riderDelivered is retained and has no caller');
  ck('riderDelivered still exists (not deleted for cleanliness)',
     /riderDelivered\(orderId, driverUid, proofData\)/.test(ORDERS));
  ck('transitionOrder still exists (it serves every other status)',
     /async transitionOrder\(/.test(ORDERS));
  const callers = [];
  fs.readdirSync(ROOT).filter((f) => /\.(html|js)$/.test(f)).forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    /* definition lines in sokoni-orders.js are not calls */
    const hits = (src.match(/\.riderDelivered\s*\(/g) || []).length;
    if (hits) callers.push(f + '×' + hits);
  });
  ck('riderDelivered has NO remaining caller', callers.length === 0,
     callers.join(', ') || 'none');

  /* ══ 7 · the legacy plaintext PIN is deliberately still present ══ */
  head('7 · proofPin cleanup is explicitly OUT of scope here');
  ck('packageRequests.proofPin still written (separate remediation)',
     /proofPin/.test(fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8')));
  /* What matters is that it is not what AUTHORISES anything. */
  const DP = fs.readFileSync(path.join(ROOT, 'functions', 'delivery-complete.js'), 'utf8');
  ck('the server verifies deliveryPinHash, never proofPin',
     /deliveryPinHash/.test(DP) && !/d\.proofPin/.test(DP));
  ck('a missing hash is a rejection, not a pass-through',
     /if \(!d\.deliveryPinHash\)[\s\S]{0,200}HttpsError/.test(DP));
  /* Compare CODE positions, not raw file offsets: `deliveryPinHash` is discussed in
     the file header long before it is used, so an unstripped indexOf compares an
     assignment check against a comment and reports a hole that is not there. */
  const DP_CODE = DP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('assignment is checked BEFORE the PIN (no PIN oracle)',
     DP_CODE.indexOf('not assigned to you') < DP_CODE.indexOf('deliveryPinHash'),
     'assigned@' + DP_CODE.indexOf('not assigned to you') + ' hash@' + DP_CODE.indexOf('deliveryPinHash'));

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
