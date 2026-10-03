#!/usr/bin/env node
/**
 * migrate-invoices-canonical.js — converge the legacy `invoices` collection onto THE canonical model
 * (owner 2026-10-04: `invoices`, restructured, is the ONE invoice; payment truth only from verified payments).
 *
 *   node scripts/migrate-invoices-canonical.js            # DRY RUN (default): reads, classifies, prints the plan. Writes NOTHING.
 *   node scripts/migrate-invoices-canonical.js --apply    # writes — ONLY with the owner's explicit go for this run
 *
 * Per legacy document (three shapes shared one collection — docs/INVOICE_STORES_CENSUS.md):
 *   A merchant manual (shopId + clientName) → source 'manual'
 *   B commission bill (sellerUid + period) → source 'commission'
 *   C order invoice   (orderId)            → source 'order'
 *   anything else                          → classification 'unknown' (EXCLUDED from authoritative totals, flagged)
 * Canonical stamp: modelVersion 1, source, transactionRef, totalCents, paidCents 0, balanceCents = total,
 *   status mapped (draft→draft, sent|unpaid|issued→issued, void→void), issuedAt from sentAt.
 * A legacy "paid" was never a verified payment (merchant-entered or admin-recorded reference). It becomes:
 *   status 'issued', paymentStatus 'unverified', paymentClaim {status:'unverified', reference, source:'legacy_…'},
 *   and the original is PRESERVED under `legacy` {status, paidAt, paidBy, paymentRef}. Nothing is deleted.
 * Idempotent: a document already canonical (modelVersion) or already flagged unknown is skipped. Each --apply run
 * writes one audit record (migrationRuns/invoices-canonical-<runId>) with the counts.
 * The run is resumable and batched (400 writes per commit).
 */
'use strict';

const M = require('../functions/shared/invoice-model');

function planFor(id, d) {
  const x = d || {};
  if (x.modelVersion === M.MODEL_VERSION) return { action: 'skip', reason: 'already_canonical' };
  if (x.classification === 'unknown') return { action: 'skip', reason: 'already_flagged_unknown' };
  const cls = M.classifyLegacy(id, x);
  if (!cls) return { action: 'flag_unknown', patch: { classification: 'unknown', excludedFromTotals: true } };
  const totalCents = M.toCents(x.total);
  if (!Number.isInteger(totalCents) || totalCents < 0) return { action: 'flag_unknown', patch: { classification: 'unknown', excludedFromTotals: true, classificationReason: 'total_unreadable' } };
  const st = String(x.status || '').toLowerCase();
  const patch = { modelVersion: M.MODEL_VERSION, source: cls.source, transactionRef: cls.transactionRef || null,
    totalCents, paidCents: 0, balanceCents: totalCents, overpaidCents: 0, allocationCount: 0 };
  if (x.sentAt && !x.issuedAt) patch.issuedAt = x.sentAt;
  let kind;
  if (st === 'paid') {
    kind = 'legacy_paid_to_claim';
    patch.status = 'issued';
    patch.paymentStatus = 'unverified';
    patch.paymentClaim = { status: 'unverified', reference: x.paymentRef || null, method: x.paymentMethod || null,
      source: cls.source === 'commission' ? 'legacy_admin_recorded' : 'legacy_mark_paid', at: x.paidAt || null, by: x.paidBy || null };
    patch.legacy = { status: 'paid', paidAt: x.paidAt || null, paidBy: x.paidBy || null, paymentRef: x.paymentRef || null };
  } else if (st === 'void' || st === 'voided' || st === 'cancelled') { kind = 'void'; patch.status = 'void'; patch.paymentStatus = 'pending'; }
  else if (st === 'draft') { kind = 'draft'; patch.status = 'draft'; patch.paymentStatus = 'pending'; }
  else { kind = 'issued'; patch.status = 'issued'; patch.paymentStatus = 'pending'; if (st && st !== 'issued' && st !== 'sent') patch.legacy = { status: st }; }
  return { action: 'canonicalise', kind, source: cls.source, patch };
}

async function run(db, opts) {
  const o = opts || {};
  const apply = o.apply === true;
  const serverTs = o.serverTs || (() => new Date());
  const counts = { scanned: 0, skip: 0, canonicalise: 0, flag_unknown: 0, bySource: {}, byKind: {} };
  const samples = [];
  let last = null, batch = null, pending = 0;
  const commit = async () => { if (batch && pending) { await batch.commit(); } batch = apply ? db.batch() : null; pending = 0; };
  if (apply) batch = db.batch();
  for (;;) {
    let q = db.collection('invoices').orderBy('__name__').limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (!snap.docs.length) break;
    for (const d of snap.docs) {
      counts.scanned++;
      const p = planFor(d.id, d.data());
      counts[p.action]++;
      if (p.source) counts.bySource[p.source] = (counts.bySource[p.source] || 0) + 1;
      if (p.kind) counts.byKind[p.kind] = (counts.byKind[p.kind] || 0) + 1;
      if (p.action !== 'skip' && samples.length < 12) samples.push({ id: d.id, action: p.action, kind: p.kind || null, source: p.source || null });
      if (apply && p.patch) { batch.update(d.ref, Object.assign({}, p.patch, { migratedAt: serverTs(), migratedBy: 'migrate-invoices-canonical' })); pending++; if (pending >= 400) await commit(); }
    }
    last = snap.docs[snap.docs.length - 1];
  }
  if (apply) {
    await commit();
    const runId = (o.runId || new Date().toISOString().replace(/[:.]/g, '-'));
    await db.collection('migrationRuns').doc('invoices-canonical-' + runId).set({ migration: 'invoices-canonical', runId, counts, appliedAt: serverTs(), modelVersion: M.MODEL_VERSION });
  }
  return { apply, counts, samples };
}

module.exports = { planFor, run };

if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    const admin = require('firebase-admin');
    if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
    const db = admin.firestore();
    const r = await run(db, { apply, serverTs: () => admin.firestore.FieldValue.serverTimestamp() });
    console.log('\n  INVOICES → CANONICAL   mode ' + (apply ? 'APPLY' : 'DRY RUN (nothing written)'));
    console.log('  ' + JSON.stringify(r.counts));
    console.log('  samples (ids only):'); r.samples.forEach((s) => console.log('   ', s.id, s.action, s.kind || '', s.source || ''));
    if (!apply) console.log('\n  Re-run with --apply ONLY with the owner\'s explicit go.\n');
  })().catch((e) => { console.error('MIGRATION FAILED (no partial claim of success):', e.message); process.exit(1); });
}
