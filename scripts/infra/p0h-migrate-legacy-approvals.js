#!/usr/bin/env node
'use strict';
/**
 * P0-H (owner 2026-10-03) — ONE-TIME reconciliation of legacy approvals into server decision records.
 *
 * An application approved before applicationDecisions existed is migrated ONLY when ALL hold:
 *   • it is approved (status workflow) and has NO applicationDecisions/{id} yet;
 *   • applicationDecide's immutable adminAudit row exists: action 'application_approve', applicationId = id,
 *     performedBy === application.decidedBy;
 *   • that decider is a legitimate administrator NOW (Auth custom claim admin / superAdmin);
 *   • the decider is not the applicant.
 * Anything else (self-decided, operator labels, no audit) is REPORTED for an admin to re-decide — never migrated.
 * The audit trail is evidence for this reconciliation only; it is never an ongoing authority.
 *
 *   node scripts/infra/p0h-migrate-legacy-approvals.js                      → DRY RUN (reads only; prints the plan)
 *   node scripts/infra/p0h-migrate-legacy-approvals.js --apply --expect=a,b  → writes, only if the plan equals --expect EXACTLY
 *
 * Writes use create() (fails if a record already exists — idempotent, never overwrites a real decision) plus one
 * adminAudit 'application_decision_migrated' row per record. No other document is touched.
 */
const path = require('path');
const admin = require(path.join(__dirname, '..', '..', 'functions', 'node_modules', 'firebase-admin'));
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const APPROVED = new Set(['approved', 'active', 'accepted', 'verified']);
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const EXPECT = ((args.find((a) => a.startsWith('--expect=')) || '').slice(9)).split(',').map((x) => x.trim()).filter(Boolean).sort();

(async () => {
  const apps = (await db.collection('applications').get()).docs.filter((d) => { const a = d.data(); return String(a.statusCanonical || '').toLowerCase() === 'approved' || APPROVED.has(String(a.status || '').toLowerCase()); });
  const auditByApp = {};
  for (const d of (await db.collection('adminAudit').where('action', '==', 'application_approve').get()).docs) { const x = d.data(); (auditByApp[String(x.applicationId || '')] = auditByApp[String(x.applicationId || '')] || []).push({ id: d.id, by: String(x.performedBy || '') }); }
  const adminCache = {};
  const isAdmin = async (uid) => { if (!uid || /[:/ ]/.test(uid)) return false; if (uid in adminCache) return adminCache[uid]; let ok = false; try { const c = (await admin.auth().getUser(uid)).customClaims || {}; ok = c.admin === true || c.superAdmin === true; } catch (_) { ok = false; } return (adminCache[uid] = ok); };

  const plan = [], reDecide = [], already = [];
  for (const d of apps) {
    const a = d.data(); const by = typeof a.decidedBy === 'string' ? a.decidedBy.trim() : '';
    if ((await db.collection('applicationDecisions').doc(d.id).get()).exists) { already.push(d.id); continue; }
    const aud = (auditByApp[d.id] || []).find((x) => x.by === by);
    const why = !by ? 'NO_DECIDER' : by === a.uid ? 'SELF_DECIDED' : !aud ? 'NO_MATCHING_AUDIT' : !(await isAdmin(by)) ? 'DECIDER_NOT_ADMIN' : null;
    if (why) { reDecide.push({ id: d.id, uid: a.uid || null, why }); continue; }
    plan.push({ id: d.id, uid: a.uid, decidedBy: by, decidedAt: a.decidedAt || null, auditId: aud.id });
  }
  const ids = plan.map((p) => p.id).sort();
  console.log(JSON.stringify({ project: PROJECT, mode: APPLY ? 'APPLY' : 'DRY-RUN', migrate: ids, reDecideByAdmin: reDecide, alreadyHaveRecord: already }, null, 2));
  if (!APPLY) { console.log('\nDRY RUN — nothing written.'); process.exit(0); }
  if (JSON.stringify(ids) !== JSON.stringify(EXPECT)) { console.error('\nREFUSED: the plan does not equal --expect exactly. Nothing written.'); process.exit(3); }

  let wrote = 0;
  for (const p of plan) {
    try {
      await db.collection('applicationDecisions').doc(p.id).create({
        applicationId: p.id, status: 'approved', decision: 'approve', decidedBy: p.decidedBy, applicantUid: p.uid,
        reason: null, decidedAt: p.decidedAt, migratedFrom: 'adminAudit', migratedAuditId: p.auditId, migration: 'P0-H-2026-10-03',
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await db.collection('adminAudit').add({ action: 'application_decision_migrated', applicationId: p.id, performedBy: 'P0-H-migration',
        evidenceAuditId: p.auditId, decidedBy: p.decidedBy, at: admin.firestore.FieldValue.serverTimestamp() });
      wrote++; console.log('migrated', p.id);
    } catch (e) { console.error('SKIPPED', p.id, e.code === 6 || /already exists/i.test(e.message) ? '(record already exists)' : e.message); }
  }
  console.log('\nRESULT: ' + wrote + ' of ' + plan.length + ' records written.');
  process.exit(wrote === plan.length ? 0 : 1);
})().catch((e) => { console.error('FAILED (no verdict):', e && e.message); process.exit(2); });
