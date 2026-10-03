/* PA — P0-4 provider approval fields (owner 2026-10-03). Runs against BOTH the served-based hotfix and the combined build:
     RULES_FILE=firestore.rules.hotfix-jobs  …  and  RULES_FILE=firestore.rules.build
   Baseline RULES_FILE=firestore.rules.served-f259c0b5: the PA-U-* rows for approvalDecision / adminApproved / commissionRate /
   business / approvedAt / approvedBy and PA-X1 must FAIL there (the live hole). */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, setDoc, updateDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const LOCKED = {
  approvalDecision: { decision: 'approve', source: 'admin_decision' }, approvedBy: 'admin1', approvedAt: 1, adminApproved: true,
  commissionRate: 0, business: { category: 'it_services' }, education: { tier: 'verified' }, discovery: { boost: 99 }, _noIndex: false,
  marketingApprovedCategories: ['all'], marketingDeclinedCategories: [], status: 'active', verified: true, approved: true, suspended: false,
  /* sokoni-5b 7db4c76 */
  marketingStatus: 'approved', marketingCategories: ['all'], searchable: true, isPublic: true, acceptsBookings: true, providerId: 'other',
  verification: { level: 'verified' }, verificationStatus: 'verified', legalVerification: { ok: true }, provisionedBy: 'legal-verification',
  preDeactivationStatus: 'active', deactivated: false,
};
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.hotfix-jobs';
  const env = await initializeTestEnvironment({ projectId: 'demo-provider-approval',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nPA provider approval fields   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'providers/alice'), { uid: 'alice', name: 'Alice Welding', status: 'pending', approvalDecision: { decision: 'refuse', source: 'admin_decision' }, commissionRate: 5 });
  });
  const alice = env.authenticatedContext('alice').firestore(), admin = env.authenticatedContext('admin1', { admin: true }).firestore();
  for (const [k, v] of Object.entries(LOCKED)) {
    if (k === 'status') continue;   /* create keeps the onboarding allowance status:'pending' (PA-C0) */
    const u = 'n_' + k.replace(/[^a-z]/gi, '');
    await denies('PA-C-' + k, 'provider CREATES carrying ' + k, setDoc(doc(env.authenticatedContext(u).firestore(), 'providers/' + u), { uid: u, name: 'New', status: 'pending', [k]: v }));
  }
  await allows('PA-C0', 'CONTROL: onboarding create (uid self, status pending, profile fields only)', setDoc(doc(env.authenticatedContext('bob').firestore(), 'providers/bob'), { uid: 'bob', name: 'Bob', status: 'pending' }));
  for (const [k, v] of Object.entries(LOCKED)) {
    await denies('PA-U-' + k, 'provider UPDATES own ' + k, updateDoc(doc(alice, 'providers/alice'), { [k]: v }));
  }
  await denies('PA-X1', 'provider overwrites an admin REFUSAL with an approval', updateDoc(doc(alice, 'providers/alice'), { approvalDecision: { decision: 'approve', source: 'admin_decision' } }));
  await denies('PA-X2', 'provider sets its own commission rate to 0', updateDoc(doc(alice, 'providers/alice'), { commissionRate: 0 }));
  await denies('PA-X3', 'provider writes role (noAdminFields now applies to owner edits)', updateDoc(doc(alice, 'providers/alice'), { role: 'admin' }));
  await allows('PA-P1', 'CONTROL: provider edits bio / phone / services', updateDoc(doc(alice, 'providers/alice'), { bio: 'Gates & grilles', phone: '0722000000' }));
  await allows('PA-A1', 'CONTROL: admin records an approval decision', updateDoc(doc(admin, 'providers/alice'), { approvalDecision: { decision: 'approve', source: 'admin_decision' }, approvedBy: 'admin1' }));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
