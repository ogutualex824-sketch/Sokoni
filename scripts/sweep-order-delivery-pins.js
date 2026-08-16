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

   IT MIGRATES, IT DOES NOT JUST DELETE — and that is deliberate
   The first report found one order, `in_transit`, with a rider assigned, whose
   `deliveryPins/{orderId}` document did not exist and whose `deliveryPinIssued`
   flag was false. Deleting the field alone would have closed the exposure and
   simultaneously removed the BUYER's only copy of their PIN, mid-delivery, while
   the rider stood there asking for it. `track.html` keys the PIN box off
   `deliveryPinIssued`, so the buyer would have seen nothing at all.

   So `--apply` performs, per order, in this order:
     1. copy the plaintext into `deliveryPins/{orderId}` — server-side only, a
        collection with NO rule, therefore unreadable by every client
     2. set `deliveryPinIssued: true` so track.html knows to ask for it
     3. THEN delete `deliveryPin` from the order document
   Step 3 never runs unless steps 1–2 succeeded. Closing an exposure by breaking
   a live delivery is not a remediation.

   The value is moved between two server-side documents. It is never returned,
   logged, or printed.

   IT ALSO SWEEPS packageRequests.proofPin
   The writers stopped emitting it, but existing deliveries still carry it, and
   firestore.rules grants the assigned rider a read on packageRequests via
   `assignedDriverId`. Fixing the writers without sweeping the records would have
   left exactly the same exposure one collection over — which is the mistake this
   whole remediation exists to correct.

   COMPLETION IS UNAFFECTED
   `completeDeliveryWithPin` verifies against `deliveryPinHash` on the
   packageRequest, which this never touches, and `buyerConfirmDelivery` needs no
   PIN at all.

   SAFETY
   - report mode is the default; `--apply` is required to write
   - `--delete-only` skips the migration (use only when the value is known
     redundant — it will strand an in-flight buyer)
   - only ever removes the ONE field per document, via FieldValue.delete()
   - `--limit N` bounds a run; re-run until it reports zero
   - never prints a PIN value, only counts and states
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

/* firebase-admin lives under functions/, not at the repo root — the same path the
   other maintenance scripts use. */
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));

const APPLY = process.argv.includes('--apply');
/* Delete without migrating. Closes the exposure but strands an in-flight buyer,
   so it is opt-in rather than the default. */
const DELETE_ONLY = process.argv.includes('--delete-only');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 500) : 500;
})();

if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-aeb26' });
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

  let delivered = 0, active = 0, reachable = 0;
  const rows = [];
  snap.docs.forEach((d) => {
    const o = d.data();
    const s = String(o.status || o.timelineStage || '').toLowerCase();
    const done = (s === 'delivered' || s === 'completed');
    /* The exposure is only REACHABLE if a rider is actually named on the order —
       that is the exact clause firestore.rules grants the read on. A stale PIN on
       an order with no rider is untidy; one with a rider is readable right now. */
    const rider = o.assignedDriverUid || o.riderId || o.assignedRiderId || null;
    if (done) delivered++; else active++;
    if (rider && !done) reachable++;
    rows.push({ id: d.id, status: s || '(none)', rider: !!rider, done });
  });

  console.log('orders with a plaintext deliveryPin: ' + snap.size);
  console.log('  already delivered/completed:       ' + delivered);
  console.log('  still in flight:                   ' + active);
  console.log('  READABLE BY A RIDER RIGHT NOW:     ' + reachable + '   <- assignedDriverUid set AND not yet delivered');
  console.log('');
  console.log('  order                          status              rider assigned');
  console.log('  ' + '-'.repeat(62));
  rows.forEach((r) => {
    console.log('  ' + r.id.padEnd(30) + r.status.padEnd(20) + (r.rider ? 'YES' : 'no'));
  });
  console.log('');
  console.log('  (PIN values are never read into this process and never printed.)');
  console.log('');

  /* ── packageRequests.proofPin — the same exposure, one collection over ──── */
  const pkgIds = Array.from(new Set(snap.docs
    .map((d) => d.data().deliveryRef || d.data().packageRequestId)
    .filter(Boolean).map(String)));
  const pkgHits = [];
  for (const ref of pkgIds) {
    const p = await db.collection('packageRequests').doc(ref).get();
    if (!p.exists) continue;
    const v = p.data().proofPin;
    if (typeof v === 'string' && v.length) {
      pkgHits.push({ ref, hash: !!p.data().deliveryPinHash, status: String(p.data().status || '') });
    }
  }
  console.log('linked packageRequests carrying a plaintext proofPin: ' + pkgHits.length);
  pkgHits.forEach((p) => {
    console.log('  ' + p.ref.padEnd(30) + p.status.padEnd(20) + (p.hash ? 'hash present' : 'NO HASH'));
  });
  console.log('');

  if (!APPLY) {
    console.log('Report only. Nothing was written.');
    console.log('');
    console.log('--apply will, per order: copy the plaintext into deliveryPins/{orderId}');
    console.log('(no rule -> unreadable by every client), set deliveryPinIssued so the buyer');
    console.log('can still fetch it via getMyDeliveryPin, and only THEN delete the field from');
    console.log('the order. It also clears proofPin from the linked packageRequest.');
    console.log('');
    console.log('Completion is unaffected either way: completeDeliveryWithPin verifies against');
    console.log('deliveryPinHash, which this never touches.');
    return;
  }

  let done = 0, migrated = 0;
  for (const d of snap.docs) {
    const o = d.data();
    const pin = o.deliveryPin;

    if (!DELETE_ONLY && typeof pin === 'string' && pin.length) {
      /* Move it somewhere no client can read BEFORE removing the only copy. */
      await db.collection('deliveryPins').doc(d.id).set({
        orderId: d.id,
        deliveryRef: o.deliveryRef || o.packageRequestId || null,
        pin,
        buyerUid: o.buyerUid || o.userId || o.uid || o.customerUid || null,
        issuedAt: admin.firestore.FieldValue.serverTimestamp(),
        migratedFrom: 'orders.deliveryPin',
      }, { merge: true });
      await d.ref.update({ deliveryPinIssued: true });
      migrated++;
    }

    await d.ref.update({ deliveryPin: admin.firestore.FieldValue.delete() });
    done++;
    console.log('  ' + d.id + ' — ' + (DELETE_ONLY ? 'deleted' : 'migrated then deleted'));
  }

  for (const p of pkgHits) {
    await db.collection('packageRequests').doc(p.ref)
      .update({ proofPin: admin.firestore.FieldValue.delete() });
    console.log('  ' + p.ref + ' — proofPin cleared');
  }

  console.log('\nOrders cleared: ' + done + ' (of which migrated first: ' + migrated + ')');
  console.log('packageRequests cleared: ' + pkgHits.length);
  if (snap.size === LIMIT) console.log('Hit the limit — re-run until it reports zero.');
})().catch((e) => { console.error(e); process.exit(1); });
