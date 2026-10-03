/* ED — Education rules (sokoni-5b hunks, 2026-10-03): orphan `education` closed to clients; `educationEnterprises`
   server-written, owner/admin read. Emulator-backed, against a rules FILE.
   Run: node scripts/build-firestore-rules.js
        RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
          firebase emulators:exec --only firestore --project demo-education-rules "node scripts/zz-test-education-rules.js"
   Baseline: RULES_FILE=firestore.rules.served-f259c0b5 — ED-W1/W2/W3 must FAIL there (clients can write `education`). */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, getDoc, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({ projectId: 'demo-education-rules',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nED education   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'education/legacy1'), { uid: 'owner', name: 'Old', category: 'x', description: 'd', active: false });
    await setDoc(doc(c.firestore(), 'educationEnterprises/ent'), { uid: 'ent', name: 'Acme Training' });
  });
  const owner = env.authenticatedContext('owner').firestore(), other = env.authenticatedContext('other').firestore();
  const ent = env.authenticatedContext('ent').firestore(), admin = env.authenticatedContext('admin1', { admin: true }).firestore();
  const edu = { uid: 'other', name: 'Injected listing', category: 'tutoring', description: 'search spam' };
  await denies('ED-W1', 'signed-in user creates an education doc (search injection via ts_education triggers)', setDoc(doc(other, 'education/new1'), edu));
  await denies('ED-W2', 'owner updates own legacy education doc', updateDoc(doc(owner, 'education/legacy1'), { name: 'Changed' }));
  await denies('ED-W3', 'owner deletes own legacy education doc', deleteDoc(doc(owner, 'education/legacy1')));
  await allows('ED-R1', 'CONTROL: owner still reads own legacy doc (read unchanged)', getDoc(doc(owner, 'education/legacy1')));
  await allows('ED-R2', 'CONTROL: admin reads a legacy doc', getDoc(doc(admin, 'education/legacy1')));
  await allows('ED-E1', 'enterprise owner reads own record', getDoc(doc(ent, 'educationEnterprises/ent')));
  await denies('ED-E2', 'another user reads the enterprise record', getDoc(doc(other, 'educationEnterprises/ent')));
  await denies('ED-E3', 'owner creates own enterprise record (server-written only)', setDoc(doc(other, 'educationEnterprises/other'), { uid: 'other' }));
  await denies('ED-E4', 'owner updates own enterprise record', updateDoc(doc(ent, 'educationEnterprises/ent'), { name: 'Self-approved' }));
  await denies('ED-E5', 'owner deletes own enterprise record', deleteDoc(doc(ent, 'educationEnterprises/ent')));
  await allows('ED-E6', 'admin reads an enterprise record', getDoc(doc(admin, 'educationEnterprises/ent')));
  // learner profile + guardian links (written only by the educationLearner callable)
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'learnerProfiles/ent'), { uid: 'ent', grade: 7 });
    await setDoc(doc(f, 'guardianLinks/L1'), { learnerUid: 'ent', guardianUid: 'other', guardianPhone: 'x' });
    await setDoc(doc(f, 'guardianCodes/ABC123'), { learnerUid: 'ent' });
    await setDoc(doc(f, 'educationAudit/a1'), { action: 'link' });
  });
  await allows('ED-L1', 'learner reads own learnerProfile', getDoc(doc(ent, 'learnerProfiles/ent')));
  await denies('ED-L2', 'another user reads the learnerProfile', getDoc(doc(other, 'learnerProfiles/ent')));
  await denies('ED-L3', 'learner writes own learnerProfile (callable only)', setDoc(doc(ent, 'learnerProfiles/ent'), { grade: 12 }));
  await denies('ED-L4', 'the GUARDIAN reads the raw guardianLink (callable only; identity never exposed raw)', getDoc(doc(other, 'guardianLinks/L1')));
  await denies('ED-L5', 'the learner reads the raw guardianLink', getDoc(doc(ent, 'guardianLinks/L1')));
  await denies('ED-L6', 'a client forges a guardianLink', setDoc(doc(other, 'guardianLinks/L2'), { learnerUid: 'ent', guardianUid: 'other' }));
  await denies('ED-L7', 'a client reads a guardianCode (code harvesting)', getDoc(doc(other, 'guardianCodes/ABC123')));
  await denies('ED-L8', 'a client mints a guardianCode', setDoc(doc(other, 'guardianCodes/ZZZ999'), { learnerUid: 'ent' }));
  await denies('ED-L9', 'a client reads educationAudit', getDoc(doc(ent, 'educationAudit/a1')));
  await denies('ED-L10', 'a client writes educationAudit', setDoc(doc(ent, 'educationAudit/a2'), { action: 'x' }));
  await allows('ED-L11', 'admin reads guardianLinks / guardianCodes / educationAudit', Promise.all([getDoc(doc(admin, 'guardianLinks/L1')), getDoc(doc(admin, 'guardianCodes/ABC123')), getDoc(doc(admin, 'educationAudit/a1'))]));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
