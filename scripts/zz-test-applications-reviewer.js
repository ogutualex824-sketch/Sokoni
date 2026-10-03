/* AR — application decision fields are server-written (sokoni-e3 finding 2026-10-03, verified on served f259c0b5).
   Run: node scripts/build-firestore-rules.js
        RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
          firebase emulators:exec --only firestore --project demo-app-reviewer "node scripts/zz-test-applications-reviewer.js"
   Also: RULES_FILE=firestore.rules.hotfix-jobs (the P0 served-based hotfix) must pass every row.
   Baseline f259c0b5: AR-1..AR-5, AR-9..AR-11, AR-14 must FAIL there (the served update rule only checks noAdminFields, which omits status /
   decidedBy / decidedAt / reviewedBy). */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, setDoc, updateDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({ projectId: 'demo-app-reviewer',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nAR application decision fields   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  const base = { uid: 'app1', name: 'Builder Ltd', category: 'contractor', hub: 'construction', status: 'pending' };
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'applications/a1'), base); });
  const me = env.authenticatedContext('app1').firestore(), admin = env.authenticatedContext('adm', { admin: true }).firestore();
  await denies('AR-1', 'applicant sets own status to approved', updateDoc(doc(me, 'applications/a1'), { status: 'approved' }));
  await denies('AR-2', 'applicant forges decidedBy / decidedAt', updateDoc(doc(me, 'applications/a1'), { decidedBy: 'adm', decidedAt: 1 }));
  await denies('AR-3', 'applicant forges reviewedBy / reviewedAt', updateDoc(doc(me, 'applications/a1'), { reviewedBy: 'adm', reviewedAt: 1 }));
  await denies('AR-4', 'applicant creates an application already approved', setDoc(doc(me, 'applications/a2'), Object.assign({}, base, { status: 'approved' })));
  await denies('AR-5', 'applicant creates with reviewedBy set', setDoc(doc(me, 'applications/a3'), Object.assign({}, base, { reviewedBy: 'adm' })));
  await allows('AR-6', 'CONTROL: applicant edits their description while pending', updateDoc(doc(me, 'applications/a1'), { description: 'Updated portfolio' }));
  await allows('AR-7', 'CONTROL: admin records the decision', updateDoc(doc(admin, 'applications/a1'), { status: 'approved', decidedBy: 'adm', reviewedBy: 'adm' }));
  await denies('AR-8', 'applicant edits after the decision', updateDoc(doc(me, 'applications/a1'), { description: 'sneaky' }));
  /* P0 rows (owner via sokoni-5b) — ALSO run against the served-based hotfix: RULES_FILE=firestore.rules.hotfix-jobs */
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'applications/p1'), Object.assign({}, base, { status: 'pending' })); });
  await denies('AR-9', 'applicant writes reviewStage', updateDoc(doc(me, 'applications/p1'), { reviewStage: 'final' }));
  await denies('AR-10', 'applicant writes posProvisioning / marketingApprovedCategories', updateDoc(doc(me, 'applications/p1'), { posProvisioning: { till: true }, marketingApprovedCategories: ['all'] }));
  await denies('AR-11', 'applicant creates with approvedAt', setDoc(doc(me, 'applications/p2'), Object.assign({}, base, { approvedAt: 1 })));
  await allows('AR-12', 'CONTROL: business-apply creates with status pending_review', setDoc(doc(me, 'applications/p3'), Object.assign({}, base, { status: 'pending_review' })));
  await allows('AR-13', 'CONTROL: complete-application withdraws an open application', updateDoc(doc(me, 'applications/p1'), { status: 'withdrawn' }));
  await denies('AR-14', 'applicant moves status to anything but withdrawn (e.g. info_requested → under_review)', updateDoc(doc(me, 'applications/p3'), { status: 'under_review' }));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
