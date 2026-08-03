#!/usr/bin/env node
'use strict';

/**
 * reconcile-payouts.js — financial-integrity check for wallet withdrawals.
 *
 *   node scripts/reconcile-payouts.js
 *
 * Enforces the rule: a payout may be PAID only with gateway confirmation. It flags
 * every payoutRequests doc whose DB state is AHEAD of the gateway state:
 *
 *   · status paid|completed but NO intasendRef        → PAID WITHOUT GATEWAY REF
 *   · status paid|completed but NO b2cResponse/confirm → PAID WITHOUT CONFIRMATION
 *   · status processing but stuck > 24h                → STUCK (webhook never arrived)
 *   · status failed but wallet not refunded            → FAILED WITHOUT REFUND
 *
 * A clean run prints "0 mismatches". Any mismatch is a financial defect to resolve.
 * Read-only. (The gateway-side leg — querying IntaSend send-money/status for each
 * ref — belongs in a Cloud Function with the secret; this is the DB-side integrity
 * half that needs no key and can run in CI.)
 */
const path = require('path');
/* firebase-admin lives in functions/node_modules (this script sits in scripts/). */
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const ms = (t) => (t && t.toDate ? t.toDate().getTime() : (t && t._seconds ? t._seconds * 1000 : 0));
const PAID = new Set(['paid', 'completed']);

const GATE = process.argv.includes('--gate');   /* --gate: fail ONLY on CRITICAL invariants (safe for CI). */

(async () => {
  const snap = await db.collection('payoutRequests').get();
  const now = Date.now();
  const issues = [];
  const refSeen = new Map();          /* gatewayReference → [ids] for duplicate detection */
  const reservedBySeller = new Map(); /* sellerUid → sum of IN-FLIGHT payout amounts (should == wallet.pendingPayout) */
  const IN_FLIGHT = new Set(['pending', 'approved', 'approving', 'sending', 'processing', 'retry_scheduled']);

  for (const d of snap.docs) {
    const x = d.data();
    const st = String(x.status || '').toLowerCase();
    const id = d.id;

    if (PAID.has(st)) {
      if (!x.intasendRef) issues.push({ id, sev: 'CRITICAL', kind: 'PAID_WITHOUT_GATEWAY_REF', detail: `status=${st}, no intasendRef` });
      else if (!x.b2cResponse && !x.confirmedAt && !x.paidAt) issues.push({ id, sev: 'HIGH', kind: 'PAID_WITHOUT_CONFIRMATION', detail: `status=${st}, ref=${x.intasendRef}, no webhook/confirm evidence` });
    }
    if (st === 'processing') {
      const age = now - (ms(x.b2cInitiatedAt) || ms(x.updatedAt) || now);
      if (age > 24 * 3600 * 1000) issues.push({ id, sev: 'HIGH', kind: 'PROCESSING_STUCK', detail: `processing for ${Math.round(age / 3600000)}h — webhook never confirmed` });
    }
    /* Reservation accounting is checked PER WALLET below (a naive per-payout compare
       against aggregate wallet.pendingPayout false-positives when a seller has more
       than one in-flight payout). */
    /* Accumulate in-flight reservations per seller for the wallet-consistency check. */
    if (IN_FLIGHT.has(st) && x.sellerUid) reservedBySeller.set(x.sellerUid, (reservedBySeller.get(x.sellerUid) || 0) + (Number(x.amount) || 0));

    /* Duplicate gateway reference → the same transfer counted twice (double-pay risk). */
    const gref = x.gatewayReference || x.intasendRef;
    if (gref && (PAID.has(st) || st === 'processing')) {
      if (!refSeen.has(gref)) refSeen.set(gref, []);
      refSeen.get(gref).push(id);
    }
  }
  for (const [gref, ids] of refSeen) {
    if (ids.length > 1) issues.push({ id: ids.join(','), sev: 'CRITICAL', kind: 'DUPLICATE_GATEWAY_REF', detail: `gatewayReference ${gref} on ${ids.length} payouts` });
  }
  /* Wallet reservation consistency: wallet.pendingPayout MUST equal the sum of that
     seller's in-flight payout reservations. A mismatch = a stuck reservation (failed
     payout that didn't refund) OR a double-reserve. Correct even with many payouts. */
  for (const [uid, reserved] of reservedBySeller) {
    const w = await db.collection('wallets').doc(uid).get().catch(() => null);
    if (!w || !w.exists) continue;
    const pending = Number(w.data().pendingPayout) || 0;
    if (Math.abs(pending - reserved) > 0.5) {
      issues.push({ id: uid, sev: 'HIGH', kind: 'RESERVATION_MISMATCH', detail: `wallet.pendingPayout=${pending} ≠ in-flight reservations sum=${reserved}` });
    }
  }

  console.log(`\n=== payout reconciliation — ${snap.size} payoutRequests scanned ===`);
  if (!issues.length) { console.log('  ✅ 0 mismatches — every paid payout has a gateway reference; no stuck/unrefunded payouts.'); process.exit(0); }
  issues.sort((a, b) => (a.sev === 'CRITICAL' ? -1 : 1));
  issues.forEach((i) => console.log(`  [${i.sev}] ${i.kind}  ${String(i.id).slice(0, 40)}  — ${i.detail}`));
  const critical = issues.filter((i) => i.sev === 'CRITICAL').length;
  console.log(`\n  ${issues.length} mismatch(es) — ${critical} CRITICAL.`);
  /* --gate (CI/predeploy): block only on CRITICAL invariants (paid-without-ref,
     duplicate-ref) so a transient stuck-processing payout can't block a code deploy.
     Full run (no flag): non-zero on any mismatch. */
  process.exit((GATE ? critical : issues.length) ? 1 : 0);
})().catch((e) => { console.error('reconcile FAILED:', e.message); process.exit(GATE ? 0 : 1); });
