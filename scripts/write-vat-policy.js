#!/usr/bin/env node
'use strict';
/**
 * Write the two VAT policy documents from scripts/vat-policy-manifest.json — deliberately, never by default.
 *
 *   node scripts/write-vat-policy.js --dry-run                       prints what would be written; refuses nulls
 *   node scripts/write-vat-policy.js --apply --authorized-by "<owner>" writes revenueConfig/commission_vat + subscription_vat
 *   node scripts/write-vat-policy.js --read                          prints how the LIVE documents resolve (read-only)
 *
 * Refuses to write while any decision field is null, while applicability is not one of
 * taxable | zero_rated | exempt, or while a taxable policy lacks a boolean `inclusive`.
 * The loader (functions/commission-vat-policy.js) is used to prove the written shape resolves
 * before anything is sent — the same code the invoice paths run.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
const { loadVatPolicy } = require(path.join(ROOT, 'functions', 'commission-vat-policy'));

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply'), READ = ARGS.includes('--read');
const AUTH = ARGS.includes('--authorized-by') ? ARGS[ARGS.indexOf('--authorized-by') + 1] : null;
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
if (APPLY && !AUTH) { console.error('  --apply requires --authorized-by "<owner>"; refusing.'); process.exit(2); }
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'vat-policy-manifest.json'), 'utf8'));
const DOCS = Object.keys(manifest).filter((k) => /^revenueConfig\//.test(k));
const memDb = (docs) => ({ collection(c) { return { doc(id) { return { async get() { const d = docs[c + '/' + id]; return { exists: !!d, data: () => d }; } }; } }; } });

(async () => {
  if (READ) {
    for (const p of DOCS) {
      const [c, id] = p.split('/');
      const snap = await db.collection(c).doc(id).get();
      const resolved = await loadVatPolicy(db, p);
      console.log(`  ${p}: ${snap.exists ? 'EXISTS' : 'absent'} → resolves as ${resolved ? JSON.stringify({ applicability: resolved.applicability, inclusive: resolved.inclusive, decidedBy: resolved.decidedBy, reference: resolved.reference }) : 'null (invoices refuse / defer)'}`);
    }
    return;
  }
  const problems = [];
  const toWrite = {};
  for (const p of DOCS) {
    const m = manifest[p];
    const doc = { enabled: m.enabled === true, applicability: m.applicability, inclusive: m.inclusive, decidedBy: m.decidedBy, reference: m.reference,
                  effectiveFrom: m.effectiveFrom, decidedAt: new Date().toISOString(), writtenBy: AUTH || '(dry-run)', policyDoc: 'docs/VAT_POLICY_2026-09-30.md' };
    for (const f of ['applicability', 'decidedBy', 'reference']) if (doc[f] == null) problems.push(`${p}.${f} is null — owner/adviser decision missing`);
    if (['taxable', 'zero_rated', 'exempt'].indexOf(doc.applicability) === -1) problems.push(`${p}.applicability must be taxable | zero_rated | exempt`);
    if (doc.applicability === 'taxable' && typeof doc.inclusive !== 'boolean') problems.push(`${p}.inclusive must be a boolean for a taxable supply`);
    const resolved = await loadVatPolicy(memDb({ [p]: doc }), p);
    if (!resolved) problems.push(`${p}: the loader would resolve this document as UNSET — nothing would issue`);
    toWrite[p] = doc;
    console.log(`  ${p}: ${JSON.stringify({ applicability: doc.applicability, inclusive: doc.inclusive, decidedBy: doc.decidedBy, reference: doc.reference, effectiveFrom: doc.effectiveFrom })}`);
  }
  if (problems.length) {
    console.log('\n  REFUSED — unresolved decisions:\n    ' + problems.join('\n    '));
    console.log('\n  Until these are written, commission invoices refuse and subscription invoices defer (by design).');
    process.exit(1);
  }
  if (!APPLY) { console.log('\n  dry-run: both documents resolve; nothing written. Re-run with --apply --authorized-by "<owner>".'); return; }
  for (const [p, doc] of Object.entries(toWrite)) {
    const [c, id] = p.split('/');
    await db.collection(c).doc(id).set(doc, { merge: false });
    console.log(`  wrote ${p} (authorized by ${AUTH})`);
  }
})().catch((e) => { console.error('  FAILED', e.message); process.exit(1); });
