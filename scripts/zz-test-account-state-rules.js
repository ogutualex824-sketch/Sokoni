/* AS — one canonical suspension (owner via sokoni-2f, 2026-10-04; deliberate break #7). Emulator-backed, against a rules FILE:
     RULES_FILE=firestore.rules.hotfix-jobs  …  and  RULES_FILE=firestore.rules.build
   Baseline RULES_FILE=firestore.rules.served-f259c0b5: AS-1 / AS-2 / AS-3 / AS-6 must FAIL there (the live gap). */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, setDoc, updateDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.hotfix-jobs';
  const env = await initializeTestEnvironment({ projectId: 'demo-account-state',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nAS account state   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'users/sus'), { uid: 'sus', displayName: 'S', status: 'suspended', suspended: true, suspendReason: 'fraud', roles: ['buyer'] });
    await setDoc(doc(c.firestore(), 'users/act'), { uid: 'act', displayName: 'A', status: 'active', roles: ['buyer'] });
    await setDoc(doc(c.firestore(), 'users/rider1'), { uid: 'rider1', displayName: 'R', status: 'active', roles: ['buyer', 'rider'] });
  });
  const sus = env.authenticatedContext('sus').firestore(), act = env.authenticatedContext('act').firestore(), adm = env.authenticatedContext('adm', { admin: true }).firestore();
  const rider = env.authenticatedContext('rider1').firestore(), newu = env.authenticatedContext('newu').firestore(), newu2 = env.authenticatedContext('newu2').firestore();
  await denies('AS-1', 'a SUSPENDED owner sets its own status back to active (break #7)', updateDoc(doc(sus, 'users/sus'), { status: 'active' }));
  await denies('AS-2', 'an ordinary admin sets another user\'s status / suspended from the browser (server suspendUser only)', updateDoc(doc(adm, 'users/act'), { status: 'suspended' }));
  await denies('AS-3', 'an admin writes suspendReason / suspendedBy directly', updateDoc(doc(adm, 'users/sus'), { suspendReason: 'forged', suspendedBy: 'adm' }));
  await denies('AS-4', 'the owner forges a reinstatement record', updateDoc(doc(sus, 'users/sus'), { reinstatedAt: 1, reinstatedBy: 'sus' }));
  await denies('AS-5', 'create with status suspended / with suspension fields is refused', setDoc(doc(newu, 'users/newu'), { uid: 'newu', status: 'suspended' }));
  await denies('AS-6', 'an active owner fakes a role-update stamp', updateDoc(doc(act, 'users/act'), { roleUpdatedAt: 1, roleUpdatedBy: 'act' }));
  await allows('AS-P1', 'CONTROL: an active owner edits displayName', updateDoc(doc(act, 'users/act'), { displayName: 'Alice' }));
  await allows('AS-P2', 'CONTROL: driver.html shift write (driverProfile + updatedAt)', setDoc(doc(rider, 'users/rider1'), { driverProfile: { shiftStatus: 'online', lastShiftAt: 1 }, updatedAt: 1 }, { merge: true }));
  await allows('AS-P3', 'CONTROL: create with no status', setDoc(doc(newu2, 'users/newu2'), { uid: 'newu2', displayName: 'N' }));
  await allows('AS-P4', 'CONTROL: create with status active', setDoc(doc(env.authenticatedContext('newu3').firestore(), 'users/newu3'), { uid: 'newu3', status: 'active' }));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
