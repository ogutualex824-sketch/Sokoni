#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   SWEEP — remove plaintext `deliveryPin` left on order documents
   ══════════════════════════════════════════════════════════════════════════════
   Run (REPORT ONLY, the default — touches nothing):
       node scripts/sweep-order-delivery-pins.js

   Run (APPLY — writes):
       node scripts/sweep-order-delivery-pins.js --apply

   WHY THIS EXISTS
   `deliveryPinOnAccept` used to write the plaintext PIN onto `orders/{orderId}`.
   firestore.rules grants the assigned rider a FULL-DOCUMENT read on orders, and
   Firestore cannot project fields on read, so every one of those orders exposed
   its PIN to the rider it was meant to defend against.

   The trigger no longer writes it, and deletes it from any order that passes
   through again. Orders already past `driver_accepted` never will. Those records
   still carry the plaintext, so the exposure persists for them until this runs.

   WHAT IT DOES NOT DO
   It does not re-issue PINs and it does not touch `deliveryPins`. An order whose
   PIN is removed here keeps a working completion path: `completeDeliveryWithPin`
   verifies against `deliveryPinHash` on the packageRequest, which is unaffected,
   and `buyerConfirmDelivery` needs no PIN at all. For orders already delivered
   the field is simply dead weight that happens to be sensitive.

   SAFETY
   - report mode is the default; `--apply` is required to write
   - only ever deletes the ONE field, via FieldValue.delete()
   - `--limit N` bounds a run; re-run until it reports zero
   - never prints a PIN value, only counts
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const admin = require('firebase-admin');

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 500) : 500;
})();

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

(async function () {
  console.log(APPLY ? 'MODE: APPLY (writes)' : 'MODE: REPORT ONLY (no writes)');
  console.log('limit: ' + LIMIT + '\n');

  /* Orders carrying the field at all. An inequality on a field only matches
     documents where it EXISTS, which is exactly the set we want. */
  const snap = await db.collection('orders')
    .orderBy('deliveryPin')
    .limit(LIMIT)
    .get();

  if (snap.empty) {
    console.log('No order documents carry a plaintext deliveryPin. Nothing to do.');
    return;
  }

  let delivered = 0, active = 0;
  snap.docs.forEach((d) => {
    const s = String(d.data().status || d.data().timelineStage || '').toLowerCase();
    if (s === 'delivered' || s === 'completed') delivered++; else active++;
  });

  console.log('orders with a plaintext deliveryPin: ' + snap.size);
  console.log('  already delivered/completed:       ' + delivered);
  console.log('  still in flight:                   ' + active + '   <- live exposure');
  console.log('');

  if (!APPLY) {
    console.log('Report only. Re-run with --apply to remove the field.');
    console.log('Completion is unaffected: completeDeliveryWithPin verifies against');
    console.log('deliveryPinHash on the packageRequest, which this never touches.');
    return;
  }

  let done = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    snap.docs.slice(i, i + 400).forEach((d) => {
      batch.update(d.ref, { deliveryPin: admin.firestore.FieldValue.delete() });
      done++;
    });
    await batch.commit();
    console.log('  committed ' + done + '/' + snap.size);
  }
  console.log('\nRemoved the field from ' + done + ' order(s).');
  if (snap.size === LIMIT) console.log('Hit the limit — re-run until it reports zero.');
})().catch((e) => { console.error(e); process.exit(1); });
