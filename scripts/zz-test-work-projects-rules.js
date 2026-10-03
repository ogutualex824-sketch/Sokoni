/* WP — Work/Job Engine records (sokoni-b2 WE1 workDispatch). Emulator-backed, against a rules FILE.
   Run: node scripts/build-firestore-rules.js
        RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
          firebase emulators:exec --only firestore --project demo-work-projects "node scripts/zz-test-work-projects-rules.js"
   Baseline f259c0b5 has no workProjects block: every read row must DENY there (default deny), so WP-R1/R2/R5 FAIL on the
   baseline and the write rows pass — the block opens party reads only, never a write. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({ projectId: 'demo-work-projects',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nWP work projects   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'workProjects/wp1'), { parties: ['prov', 'cust'], providerUid: 'prov', customerUid: 'cust', status: 'active', totalCents: 500000 });
    await setDoc(doc(f, 'workProjects/wpNoParties'), { providerUid: 'prov', status: 'draft' });   /* no parties field */
  });
  const prov = env.authenticatedContext('prov').firestore(), cust = env.authenticatedContext('cust').firestore();
  const str = env.authenticatedContext('str').firestore(), anon = env.unauthenticatedContext().firestore();
  const admin = env.authenticatedContext('adm', { admin: true }).firestore();
  await allows('WP-R1', 'the provider party reads the project', getDoc(doc(prov, 'workProjects/wp1')));
  await allows('WP-R2', 'the customer party reads the project', getDoc(doc(cust, 'workProjects/wp1')));
  await denies('WP-R3', 'a stranger cannot read it', getDoc(doc(str, 'workProjects/wp1')));
  await denies('WP-R4', 'anonymous cannot read it', getDoc(doc(anon, 'workProjects/wp1')));
  await allows('WP-R5', 'admin reads it', getDoc(doc(admin, 'workProjects/wp1')));
  await denies('WP-R6', 'a record with NO parties denies (no expression error opening it)', getDoc(doc(prov, 'workProjects/wpNoParties')));
  await allows('WP-Q1', 'a party lists by array-contains on parties', getDocs(query(collection(cust, 'workProjects'), where('parties', 'array-contains', 'cust'))));
  await denies('WP-Q2', 'an unconstrained list is refused', getDocs(collection(cust, 'workProjects')));
  await denies('WP-W1', 'the customer cannot mark the project completed', updateDoc(doc(cust, 'workProjects/wp1'), { status: 'completed' }));
  await denies('WP-W2', 'the provider cannot change the total', updateDoc(doc(prov, 'workProjects/wp1'), { totalCents: 9e9 }));
  await denies('WP-W3', 'the provider cannot approve its own change request', updateDoc(doc(prov, 'workProjects/wp1'), { 'changeRequests': [{ crId: 'c1', status: 'approved', decidedBy: 'prov' }] }));
  await denies('WP-W4', 'a client cannot create a project', setDoc(doc(cust, 'workProjects/wpX'), { parties: ['cust'], status: 'active' }));
  await denies('WP-W5', 'admin client writes are refused too (workDispatch only)', updateDoc(doc(admin, 'workProjects/wp1'), { status: 'archived' }));
  await denies('WP-W6', 'a party cannot delete it', deleteDoc(doc(cust, 'workProjects/wp1')));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
