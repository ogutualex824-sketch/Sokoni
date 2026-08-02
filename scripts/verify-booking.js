#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────────
   verify-booking.js — read-only three-layer evidence report for one booking.

   For the production QA gate (docs/BOOKING_HOLD_LIFECYCLE_QA.md): given a
   bookingId, prints the CUSTOMER-facing state, the SERVER state (booking +
   slot lock + event trail), and the FINANCIAL chain (payment intent, commission
   ledger, provider calendar) — the three layers that must AGREE.

   READ-ONLY. Only .get() calls; never writes. Uses ADC for project sokoni-aeb26.

     node scripts/verify-booking.js <bookingId>
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';
const path = require('path');
const admin = require(path.resolve('functions/node_modules/firebase-admin'));
try { admin.initializeApp({ projectId: 'sokoni-aeb26' }); } catch (_) { /* already */ }
const db = admin.firestore();

const bookingId = process.argv[2];
if (!bookingId) { console.error('usage: node scripts/verify-booking.js <bookingId>'); process.exit(2); }

const ms = (t) => (t && t.toMillis ? new Date(t.toMillis()).toISOString() : (t == null ? '—' : String(t)));
const line = (k, v) => console.log('  ' + k.padEnd(16) + (v == null ? '—' : v));

(async () => {
  console.log('\n══ BOOKING ' + bookingId + ' ══');

  /* ── Layer 2a: the booking record (source of truth) ── */
  const bSnap = await db.collection('providerBookings').doc(bookingId).get();
  if (!bSnap.exists) { console.log('  NOT FOUND in providerBookings'); process.exit(1); }
  const b = bSnap.data();

  console.log('\n▸ SERVER STATE');
  line('status', b.status);
  line('paymentStatus', b.paymentStatus);
  line('expiresAt', ms(b.expiresAt));
  line('cancelReason', b.cancelReason);
  line('cancelledBy', b.cancelledBy);
  line('date/time', `${b.date} ${b.startTime}–${b.endTime}`);
  line('priceCents', b.price);
  line('heldAmount', b.heldAmount);
  line('paymentRef', b.paymentRef);
  line('providerId', b.providerId);
  line('customerUid', b.customerUid);

  /* ── slot lock presence (held/booked ⇒ present; released/expired ⇒ absent) ── */
  const slotKey = b.slotKey || (b.date && b.startTs && b.endTs ? `${b.date}_${b.startTs}_${b.endTs}` : null);
  let lockState = 'no slotKey';
  if (slotKey) {
    const lk = await db.collection('providerAvailability').doc(b.providerId).collection('slotLocks').doc(String(slotKey)).get();
    lockState = lk.exists ? 'PRESENT (slot held)' : 'absent (slot free)';
  }
  line('slotLock', lockState);

  /* ── Layer 2b: the event trail ── */
  console.log('\n▸ EVENT TRAIL (bookingEvents)');
  const evSnap = await db.collection('bookingEvents').where('bookingId', '==', bookingId).get();
  const evs = evSnap.docs.map((d) => d.data()).sort((a, x) => (a.ts || 0) - (x.ts || 0));
  if (!evs.length) console.log('  (none)');
  evs.forEach((e) => console.log(
    '  ' + new Date(e.ts || 0).toISOString() + '  ' + String(e.type || '?').padEnd(18) +
    ' actor=' + (e.actor || '?') + '  ' + (e.previousStatus || '∅') + '→' + (e.newStatus || '∅') +
    (e.paymentRef ? '  ref=' + e.paymentRef : '')));

  /* ── Layer 3: financial chain ── */
  console.log('\n▸ FINANCIAL');
  if (b.paymentRef) {
    const pi = await db.collection('paymentIntents').doc(b.paymentRef).get();
    line('intent.status', pi.exists ? pi.data().status : 'no intent doc');
    const cl = await db.collection('commissionLedger').doc(b.paymentRef).get();
    if (cl.exists) {
      const c = cl.data();
      line('commissionPct', c.commissionPct);
      line('sokoniCut', c.sokoniCut);
      line('providerNet', c.providerNet);
      line('ledgerStatus', c.status);
    } else line('commissionLedger', 'none (expected until service completed)');
  } else {
    line('financial', 'no paymentRef (never paid — expected for held/released/expired)');
  }

  /* ── provider calendar (busy slot written on confirm) ── */
  const cal = await db.collection('providerCalendar').doc(bookingId).get();
  line('providerCalendar', cal.exists ? cal.data().status : 'absent (expected until confirmed)');

  /* ── consistency hint ── */
  console.log('\n▸ CONSISTENCY');
  const terminal = ['cancelled', 'declined', 'no_show', 'completed'].includes(b.status);
  const lockPresent = /PRESENT/.test(lockState);
  if (terminal && lockPresent) console.log('  ⚠ terminal booking but slot lock still PRESENT — investigate');
  else if (b.paymentStatus === 'paid_held' && !lockPresent) console.log('  ⚠ paid_held but slot lock absent — investigate');
  else console.log('  ✓ booking status and slot-lock presence are consistent');

  console.log('');
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
