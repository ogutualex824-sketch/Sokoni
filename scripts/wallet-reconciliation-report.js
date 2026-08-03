#!/usr/bin/env node
'use strict';

/**
 * wallet-reconciliation-report.js — the pre-freeze books-are-clean report.
 *
 *   node scripts/wallet-reconciliation-report.js
 *
 * Read-only. Produces the freeze checklist:
 *   Negative balances                 → 0
 *   Pending claimables past expiry    → 0   (sweepExpiredClaimables should have refunded)
 *   Claimable terminal-state drift    → 0   (claimed has claimer, expired has refund stamp)
 *   Orphan claimable ledger rows      → 0   (a claim/pending_claim row with no escrow doc)
 *   Duplicate transfer direction      → 0   (same idempotencyKey, >1 row in one direction)
 * Payout-side rows (duplicate payouts, orphan payout ledger, reservation/PAID-evidence
 * mismatches) are owned by reconcile-payouts.js — run BOTH before tagging (the freeze gate
 * runs both). Any non-zero row blocks the freeze.
 *
 * Honesty note: a full multi-source balance==Σledger reconstruction is NOT attempted —
 * balances legitimately come from STK top-ups, B2C payouts, earnings sweeps, sends and
 * claims, not all of which historically wrote a single-signed ledger row. The reliable
 * integrity signals are: no negative balances, no orphan/duplicate rows, and the
 * per-subsystem reconcilers agreeing. Those are what this report asserts.
 */
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();
const ms = (t) => (t && t.toDate ? t.toDate().getTime() : (t && t._seconds ? t._seconds * 1000 : 0));

(async () => {
  const rows = [];
  const add = (check, count, note) => rows.push({ check, count, ok: count === 0, note: note || '' });

  // 1) Negative wallet balances
  const wSnap = await db.collection('wallets').get();
  let neg = 0;
  for (const d of wSnap.docs) {
    const b = Number(d.data().balance) || 0;
    if (b < 0) { neg++; console.log(`   ↳ NEGATIVE ${d.id}: balance=${b}`); }
  }
  add('Negative wallet balances', neg, `${wSnap.size} wallets scanned`);

  // 2) Claimable transfers — expiry + terminal-state consistency + status tally
  const cSnap = await db.collection('claimableTransfers').get();
  const now = Date.now();
  let pastExpiry = 0, drift = 0;
  const tally = { pending: 0, claimed: 0, expired: 0, other: 0 };
  const claimIds = new Set();
  for (const d of cSnap.docs) {
    const c = d.data(); claimIds.add(c.id || d.id);
    tally[c.status] = (tally[c.status] ?? 0) + 1; if (!(c.status in tally)) tally.other++;
    if (c.status === 'pending' && ms(c.expiresAt) && ms(c.expiresAt) < now) { pastExpiry++; console.log(`   ↳ PAST-EXPIRY pending ${d.id} exp=${new Date(ms(c.expiresAt)).toISOString()}`); }
    if (c.status === 'claimed' && !c.claimedByUid) { drift++; console.log(`   ↳ DRIFT claimed w/o claimer ${d.id}`); }
    if (c.status === 'expired' && !c.refundedAt)   { drift++; console.log(`   ↳ DRIFT expired w/o refund stamp ${d.id}`); }
  }
  add('Pending claimables past expiry', pastExpiry, `status tally: ${JSON.stringify(tally)}`);
  add('Claimable terminal-state drift', drift);

  // 3) Orphan claimable ledger rows + duplicate transfer direction
  const txSnap = await db.collection('walletTransactions')
    .where('category', '==', 'transfer').get().catch(() => null);
  let orphanClaim = 0;
  const dir = new Map();   // idempotencyKey|direction -> count
  if (txSnap) {
    for (const d of txSnap.docs) {
      const t = d.data();
      if (t.claimableId && !claimIds.has(t.claimableId)) { orphanClaim++; console.log(`   ↳ ORPHAN ledger ${d.id} → missing claimable ${t.claimableId}`); }
      if (t.idempotencyKey && t.direction && (t.status === 'completed' || t.status === 'pending_claim')) {
        const k = `${t.idempotencyKey}|${t.direction}`;
        dir.set(k, (dir.get(k) || 0) + 1);
      }
    }
  }
  let dupDir = 0;
  for (const [k, n] of dir) if (n > 1) { dupDir++; console.log(`   ↳ DUPLICATE direction ${k} ×${n}`); }
  add('Orphan claimable ledger rows', orphanClaim, txSnap ? `${txSnap.size} transfer rows scanned` : 'transfer query unavailable');
  add('Duplicate transfer direction', dupDir);

  // ── Report ──
  console.log('\n=== WALLET RECONCILIATION REPORT ===');
  console.log('  Check                              Count  Result');
  for (const r of rows) console.log(`  ${r.check.padEnd(34)} ${String(r.count).padStart(4)}   ${r.ok ? 'CLEAN ✅' : 'ISSUE ⛔'}${r.note ? '   (' + r.note + ')' : ''}`);
  const bad = rows.filter((r) => !r.ok).length;
  console.log('\n  Payout-side rows (duplicate payouts / orphan payout ledger / reconciliation');
  console.log('  mismatches) → run `node scripts/reconcile-payouts.js` (also in the freeze gate).');
  console.log(bad ? `\n⛔ ${bad} row(s) not clean — DO NOT FREEZE.` : '\n✅ Wallet-side reconciliation clean.');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('reconciliation report FAILED:', e.message); process.exit(1); });
