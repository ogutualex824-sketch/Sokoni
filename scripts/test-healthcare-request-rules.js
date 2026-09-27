/* test-healthcare-request-rules.js — Healthcare patient requests belong to the patient (CHANGELOG 221, Healthcare
 * security slice 1). Emulator-backed, against the SERVED ruleset (firestore.rules.build unless RULES_FILE says so).
 *
 *   node scripts/run-rules-suite.js scripts/test-healthcare-request-rules.js
 *
 * PROVES (for healthLabBookings · healthMedOrders · healthTelemedicine · healthHomeServices · healthEmergency)
 *   - the requester is the authenticated caller: a forged patient / requester uid is refused, and an
 *     unauthenticated emergency report (or one written as 'anonymous') is refused
 *   - a patient cannot nominate a recipient (arbitrary provider / pharmacy / facility uid) — nomination used to
 *     GRANT that account read + write on the patient's request
 *   - a provider / pharmacy named on a LEGACY document can no longer read or change it; nobody but an admin can
 *     reassign (write a new providerId / pharmacyId)
 *   - no cross-patient read or write; the patient may only cancel, never self-confirm / complete
 *   - POSITIVE CONTROLS: the patient still creates, reads and cancels their own request; an admin still reads
 *     and reassigns
 *   - COUNTERPROOF: the same forged writes succeed with rules disabled — every denial above is the rules
 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : '')); ok ? pass++ : fail++; };
const check = async (label, p) => { try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); } };

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!FS_HOST) { console.error('REFUSING: FIRESTORE_EMULATOR_HOST must be set (run via scripts/run-rules-suite.js)'); process.exit(2); }

const COLS = ['healthLabBookings', 'healthMedOrders', 'healthTelemedicine', 'healthHomeServices', 'healthEmergency'];

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-healthcare-request-rules',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build'), 'utf8'), host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) },
  });
  await env.clearFirestore();
  const { doc, setDoc, getDoc, updateDoc } = require('firebase/firestore');

  /* legacy documents: a patient request that NOMINATED a provider + pharmacy (the old model) */
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    for (const col of COLS) await setDoc(doc(d, col, 'legacy'), { uid: 'alice', providerId: 'prov1', pharmacyId: 'pharm1', symptoms: 'chest pain', phone: '0712', status: 'placed' });
  });

  const alice = env.authenticatedContext('alice', { email_verified: true }).firestore();
  const bob = env.authenticatedContext('bob', { email_verified: true }).firestore();
  const prov = env.authenticatedContext('prov1', { email_verified: true }).firestore();
  const pharm = env.authenticatedContext('pharm1', { email_verified: true }).firestore();
  const anon = env.unauthenticatedContext().firestore();
  const admin = env.authenticatedContext('adm1', { admin: true, email_verified: true }).firestore();

  for (const col of COLS) {
    console.log('\n' + col);
    await check(`${col}: the patient creates their OWN request (positive control)`, assertSucceeds(setDoc(doc(alice, col, 'own'), { uid: 'alice', service: 'x', phone: '0712', status: 'placed' })));
    await check(`${col}: the patient reads their own request`, assertSucceeds(getDoc(doc(alice, col, 'own'))));
    await check(`${col}: forged patient uid (a request filed as someone else) DENIED`, assertFails(setDoc(doc(bob, col, 'forged'), { uid: 'alice', service: 'x' })));
    await check(`${col}: forged requester uid 'anonymous' DENIED`, assertFails(setDoc(doc(alice, col, 'anon'), { uid: 'anonymous', service: 'x' })));
    await check(`${col}: unauthenticated request DENIED`, assertFails(setDoc(doc(anon, col, 'u'), { uid: 'anonymous', service: 'x' })));
    await check(`${col}: arbitrary provider uid nominated DENIED`, assertFails(setDoc(doc(alice, col, 'nomP'), { uid: 'alice', providerId: 'prov1', service: 'x' })));
    await check(`${col}: arbitrary pharmacy uid nominated DENIED`, assertFails(setDoc(doc(alice, col, 'nomF'), { uid: 'alice', pharmacyId: 'pharm1', service: 'x' })));
    await check(`${col}: arbitrary facility / assignee nominated DENIED`, assertFails(setDoc(doc(alice, col, 'nomA'), { uid: 'alice', facilityId: 'f1', assignedTo: 'prov1', service: 'x' })));
    await check(`${col}: cross-patient read DENIED`, assertFails(getDoc(doc(bob, col, 'own'))));
    await check(`${col}: cross-patient write (cross-user mutation) DENIED`, assertFails(updateDoc(doc(bob, col, 'own'), { phone: '0799' })));
    await check(`${col}: a provider named on a legacy request can no longer read it`, assertFails(getDoc(doc(prov, col, 'legacy'))));
    await check(`${col}: a pharmacy named on a legacy request can no longer read it`, assertFails(getDoc(doc(pharm, col, 'legacy'))));
    await check(`${col}: the named provider cannot reassign it (write a new providerId)`, assertFails(updateDoc(doc(prov, col, 'legacy'), { providerId: 'prov2' })));
    await check(`${col}: the patient cannot reassign or add a recipient either`, assertFails(updateDoc(doc(alice, col, 'own'), { providerId: 'prov2' })));
    await check(`${col}: the patient cannot change the owner uid`, assertFails(updateDoc(doc(alice, col, 'own'), { uid: 'bob' })));
    if (col !== 'healthEmergency') {
      await check(`${col}: the patient cannot self-confirm / complete`, assertFails(updateDoc(doc(alice, col, 'own'), { status: 'completed' })));
      await check(`${col}: the patient may cancel their own request (positive control)`, assertSucceeds(updateDoc(doc(alice, col, 'own'), { status: 'cancelled' })));
    } else {
      await check(`${col}: the requester cannot rewrite an emergency report (admin / dispatcher only)`, assertFails(updateDoc(doc(alice, col, 'own'), { status: 'resolved' })));
    }
    await check(`${col}: an admin reads it and may (re)assign it (positive control)`, Promise.all([assertSucceeds(getDoc(doc(admin, col, 'legacy'))), assertSucceeds(updateDoc(doc(admin, col, 'legacy'), { providerId: 'prov2' }))]));
  }

  console.log('\nCOUNTERPROOF — the same forged writes with rules disabled');
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    await check('rules disabled: a nominated-provider request is writable (so the denials above are the rules)', assertSucceeds(setDoc(doc(d, 'healthMedOrders', 'cp'), { uid: 'alice', pharmacyId: 'pharm1' })));
    await check('rules disabled: an anonymous emergency is writable', assertSucceeds(setDoc(doc(d, 'healthEmergency', 'cp'), { uid: 'anonymous' })));
  });

  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
