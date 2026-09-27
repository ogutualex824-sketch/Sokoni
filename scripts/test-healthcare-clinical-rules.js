/* test-healthcare-clinical-rules.js — who can read medical records / prescriptions and the clinical audit
 * (CHANGELOG 223, Healthcare security slice 3). Emulator-backed, against the SERVED ruleset.
 *
 *   node scripts/run-rules-suite.js scripts/test-healthcare-clinical-rules.js
 *
 * PROVES
 *   - the patient reads their own record / prescription (positive control)
 *   - another patient, the treating provider, another provider, an anonymous caller and a platform ADMIN
 *     cannot read them directly (a rules-level read cannot be audited; admin is not clinical access)
 *   - nobody writes a record / prescription / audit row from a client (forged audit actor, client-created
 *     audit event), admins included — the server writes them
 *   - the clinical audit is admin-read only; the patient and provider cannot read it
 *   - COUNTERPROOF: the same reads/writes succeed with rules disabled
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

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-healthcare-clinical-rules',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build'), 'utf8'), host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) },
  });
  await env.clearFirestore();
  const { doc, setDoc, getDoc, updateDoc } = require('firebase/firestore');
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    await setDoc(doc(d, 'healthRecords/r1'), { patientUid: 'pat1', providerId: 'docB', diagnosis: 'x', bookingId: 'b1' });
    await setDoc(doc(d, 'healthPrescriptions/p1'), { patientUid: 'pat1', providerId: 'docB', medications: [] });
    await setDoc(doc(d, 'healthClinicalAudit/a1'), { actor: 'docB', patientUid: 'pat1', action: 'record_create' });
  });
  const C = (uid, claims) => env.authenticatedContext(uid, Object.assign({ email_verified: true }, claims || {})).firestore();
  const pat1 = C('pat1'), pat2 = C('pat2'), docB = C('docB'), docX = C('docX'), adm = C('adm1', { admin: true }), sup = C('sup1', { superAdmin: true });
  const anon = env.unauthenticatedContext().firestore();

  for (const [col, id] of [['healthRecords', 'r1'], ['healthPrescriptions', 'p1']]) {
    console.log('\n' + col);
    await check(`${col}: the patient reads their own (positive control)`, assertSucceeds(getDoc(doc(pat1, col, id))));
    await check(`${col}: cross-patient read DENIED`, assertFails(getDoc(doc(pat2, col, id))));
    await check(`${col}: the treating provider cannot read it directly`, assertFails(getDoc(doc(docB, col, id))));
    await check(`${col}: cross-provider read DENIED`, assertFails(getDoc(doc(docX, col, id))));
    await check(`${col}: anonymous read DENIED`, assertFails(getDoc(doc(anon, col, id))));
    await check(`${col}: a platform ADMIN cannot read clinical content directly (unauditable)`, assertFails(getDoc(doc(adm, col, id))));
    await check(`${col}: …nor a super admin`, assertFails(getDoc(doc(sup, col, id))));
    await check(`${col}: a provider cannot write one against an arbitrary patient`, assertFails(setDoc(doc(docB, col, 'forged'), { patientUid: 'pat2', providerId: 'docB' })));
    await check(`${col}: the patient cannot alter theirs`, assertFails(updateDoc(doc(pat1, col, id), { diagnosis: 'edited' })));
    await check(`${col}: an admin client cannot write one either (server only)`, assertFails(setDoc(doc(adm, col, 'adm'), { patientUid: 'pat1' })));
  }
  console.log('\nhealthClinicalAudit');
  await check('a client-created audit event (forged actor) DENIED', assertFails(setDoc(doc(docB, 'healthClinicalAudit/forged'), { actor: 'docX', patientUid: 'pat1', action: 'record_create' })));
  await check('rewriting an audit row DENIED — even for an admin client', assertFails(updateDoc(doc(adm, 'healthClinicalAudit/a1'), { actor: 'nobody' })));
  await check('the patient cannot read the audit', assertFails(getDoc(doc(pat1, 'healthClinicalAudit/a1'))));
  await check('the provider cannot read the audit', assertFails(getDoc(doc(docB, 'healthClinicalAudit/a1'))));
  await check('an admin reads the audit (content-free) — positive control', assertSucceeds(getDoc(doc(adm, 'healthClinicalAudit/a1'))));

  console.log('\nCOUNTERPROOF — rules disabled');
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    await check('rules disabled: a record is readable and a forged audit row writable (so the denials are the rules)', Promise.all([assertSucceeds(getDoc(doc(d, 'healthRecords/r1'))), assertSucceeds(setDoc(doc(d, 'healthClinicalAudit/cp'), { actor: 'x' }))]));
  });
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
