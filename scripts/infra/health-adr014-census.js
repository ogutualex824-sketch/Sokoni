#!/usr/bin/env node
/* health-adr014-census.js — READ-ONLY census + dry-run for the ADR-014 healthcare migration (owner deploy gate, 2026-10-04).
 *
 * Classifies every healthProviders/{id} document against the ADR-014 target (providers/{uid} carrying a healthcare stamp,
 * reached only through an AdminOS decision recorded in applicationDecisions). It WRITES NOTHING: there is no --apply.
 * The migration itself is a separate, owner-approved step built from this output.
 *
 *   node scripts/infra/health-adr014-census.js --project sokoni-aeb26 [--json]
 *
 * Needs explicit owner approval before it is run against production (it reads production data).
 *
 * Classes (each healthProviders doc lands in exactly one):
 *   ALREADY_CANONICAL   providers/{uid} exists with healthcare.source application|admin  → nothing to migrate
 *   ACTIVE_DECIDED      status active + an approved applicationDecisions record for this uid's health application
 *                       → project into providers/{uid} via applicationReconcile (the K13-A path; never a direct write)
 *   ACTIVE_UNDECIDED    status active, NO decision record → NOT migratable automatically; owner/admin re-decides in AdminOS
 *   PENDING             status pending (registerHealthProvider intake) → stays as intake; the applicant applies through
 *                       the application flow (registration is not approval)
 *   OTHER_STATUS        suspended / rejected / anything else → carried as-is, never activated
 *   NO_UID              the doc names no account → reported for manual review, never migrated
 * Positive control: the script prints the total doc counts it read; an empty census with a zero control is UNREADABLE,
 * not "nothing to migrate".
 */
'use strict';
const args = process.argv.slice(2);
const proj = (args[args.indexOf('--project') + 1] || '').trim();
const JSON_OUT = args.includes('--json');
if (!proj || args.indexOf('--project') < 0) { console.error('CANNOT RUN: --project <id> is required (production = sokoni-aeb26)'); process.exit(2); }
if (args.includes('--apply')) { console.error('REFUSED: this script is read-only; there is no --apply'); process.exit(2); }

const admin = require(require.resolve('firebase-admin', { paths: [require('path').join(__dirname, '..', '..', 'functions')] }));
admin.initializeApp({ projectId: proj });
const db = admin.firestore();

(async () => {
  const [hp, apps] = await Promise.all([
    db.collection('healthProviders').get(),
    db.collection('applications').where('role', '==', 'health').get(),
  ]);
  const appsByUid = {};
  apps.docs.forEach((d) => { const a = d.data() || {}; if (a.uid) (appsByUid[a.uid] = appsByUid[a.uid] || []).push(d.id); });

  const rows = [];
  for (const d of hp.docs) {
    const h = d.data() || {};
    const uid = typeof h.uid === 'string' && h.uid ? h.uid : null;
    const status = String(h.status || '').toLowerCase() || '(none)';
    let cls; let detail = {};
    if (!uid) cls = 'NO_UID';
    else {
      const p = await db.collection('providers').doc(uid).get();
      const pd = p.exists ? (p.data() || {}) : null;
      if (pd && pd.healthcare && ['application', 'admin'].includes(pd.healthcare.source)) cls = 'ALREADY_CANONICAL';
      else if (status === 'active') {
        let decided = null;
        for (const appId of appsByUid[uid] || []) {
          const r = await db.collection('applicationDecisions').doc(appId).get();
          if (r.exists && (r.data() || {}).status === 'approved') { decided = appId; break; }
        }
        cls = decided ? 'ACTIVE_DECIDED' : 'ACTIVE_UNDECIDED';
        detail = { applicationId: decided, applications: (appsByUid[uid] || []).length, providersDoc: !!pd };
      } else if (status === 'pending') cls = 'PENDING';
      else cls = 'OTHER_STATUS';
    }
    rows.push({ id: d.id, uid, status, cls, ...detail });
  }
  const counts = rows.reduce((a, r) => { a[r.cls] = (a[r.cls] || 0) + 1; return a; }, {});
  const out = { project: proj, read: { healthProviders: hp.size, healthApplications: apps.size }, counts, rows,
    dryRun: rows.filter((r) => r.cls === 'ACTIVE_DECIDED').map((r) => ({ action: 'applicationReconcile', applicationId: r.applicationId, uid: r.uid })) };
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); return; }
  console.log(`healthProviders read: ${hp.size} · health applications read: ${apps.size}  (positive control: both reads ran)`);
  Object.keys(counts).sort().forEach((k) => console.log('  ' + k.padEnd(18) + counts[k]));
  console.log(`DRY-RUN: ${out.dryRun.length} reconcile(s) would be proposed; ${counts.ACTIVE_UNDECIDED || 0} active record(s) need an AdminOS decision first. Nothing was written.`);
})().catch((e) => { console.error('UNREADABLE: ' + (e && e.message)); process.exit(2); });
