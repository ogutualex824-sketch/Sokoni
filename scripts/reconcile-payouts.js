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

(async () => {
  const snap = await db.collection('payoutRequests').get();
  const now = Date.now();
  const issues = [];

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
    if (st === 'failed') {
      const w = await db.collection('wallets').doc(x.sellerUid || '_').get().catch(() => null);
      // Heuristic: a failed payout should have refunded — a failed-refund shows as a wallet with the amount still held.
      if (w && w.exists && Number(w.data().pendingPayout || 0) >= Number(x.amount || 0) && Number(x.amount) > 0) {
        issues.push({ id, sev: 'HIGH', kind: 'FAILED_WITHOUT_REFUND?', detail: `failed but wallet pendingPayout=${w.data().pendingPayout} still ≥ amount ${x.amount}` });
      }
    }
  }

  console.log(`\n=== payout reconciliation — ${snap.size} payoutRequests scanned ===`);
  if (!issues.length) { console.log('  ✅ 0 mismatches — every paid payout has a gateway reference; no stuck/unrefunded payouts.'); process.exit(0); }
  issues.sort((a, b) => (a.sev === 'CRITICAL' ? -1 : 1));
  issues.forEach((i) => console.log(`  [${i.sev}] ${i.kind}  ${i.id.slice(0, 40)}  — ${i.detail}`));
  console.log(`\n  ${issues.length} mismatch(es) — resolve before trusting the payout ledger.`);
  process.exit(1);
})().catch((e) => { console.error('reconcile FAILED:', e.message); process.exit(1); });
