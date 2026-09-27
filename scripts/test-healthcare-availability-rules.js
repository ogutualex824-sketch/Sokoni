/* test-healthcare-availability-rules.js — a Healthcare provider's availability is written only by the server
 * (CHANGELOG 234). Emulator-backed, against the SERVED ruleset.
 *
 *   node scripts/run-rules-suite.js scripts/test-healthcare-availability-rules.js
 *
 * PROVES
 *   - a Healthcare provider (providers/{uid}.healthcare present) cannot create or update its own
 *     providerAvailability doc, nor write an override (closure / special hours) — the callables are the only path
 *   - it still READS its own availability, and a patient can read it (the storefront needs it)
 *   - it cannot shed the attribute to get the write back (providers.healthcare is protected — CHANGELOG 227)
 *   - POSITIVE CONTROL: a non-Healthcare provider's direct writes are unchanged by this slice
 *   - a stranger never writes someone else's availability
 *   - COUNTERPROOF: the same Healthcare write succeeds with rules disabled (so the denials are the rules)
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
    projectId: 'sokoni-hc-availability-rules',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build'), 'utf8'), host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) },
  });
  await env.clearFirestore();
  const { doc, setDoc, getDoc, updateDoc, deleteDoc } = require('firebase/firestore');
  const cfg = { schedule: { monday: { closed: false, periods: [{ open: '08:00', close: '17:00' }] } }, appt: { durationMins: 30 } };
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'providers/doc1'), { uid: 'doc1', status: 'active', name: 'Dr One', healthcare: { category: 'clinician', source: 'admin' } });
    await setDoc(doc(f, 'providers/unc1'), { uid: 'unc1', status: 'active', name: 'Unclassified', healthcare: { category: null, source: 'application' } });
    await setDoc(doc(f, 'providers/photo1'), { uid: 'photo1', status: 'active', name: 'Photographer', category: 'photographer' });
    await setDoc(doc(f, 'providerAvailability/doc1'), cfg);
    await setDoc(doc(f, 'providerAvailability/photo1'), cfg);
  });
  const C = (uid) => env.authenticatedContext(uid, { email_verified: true, deactivated: false }).firestore();
  const doc1 = C('doc1'); const unc1 = C('unc1'); const photo1 = C('photo1'); const pt = C('patient1'); const mallory = C('mallory');

  console.log('\nHealthcare provider — the server is the only writer');
  await check('updating its own availability DENIED', assertFails(updateDoc(doc(doc1, 'providerAvailability/doc1'), { 'appt.durationMins': 5 })));
  await check('overwriting its own availability DENIED', assertFails(setDoc(doc(doc1, 'providerAvailability/doc1'), cfg)));
  await check('an unclassified health provider creating its availability DENIED', assertFails(setDoc(doc(unc1, 'providerAvailability/unc1'), cfg)));
  await check('writing a closure override DENIED', assertFails(setDoc(doc(doc1, 'providerAvailability/doc1/overrides/2099-01-01'), { date: '2099-01-01', closed: true })));
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'providerAvailability/doc1/overrides/2099-02-02'), { date: '2099-02-02', closed: true }); });
  await check('deleting a server-written override DENIED', assertFails(deleteDoc(doc(doc1, 'providerAvailability/doc1/overrides/2099-02-02'))));
  await check('shedding the healthcare attribute to regain the write DENIED', assertFails(updateDoc(doc(doc1, 'providers/doc1'), { healthcare: null })));

  console.log('\nreads stay open');
  await check('the provider reads its own availability', assertSucceeds(getDoc(doc(doc1, 'providerAvailability/doc1'))));
  await check('a patient reads it (the storefront needs it)', assertSucceeds(getDoc(doc(pt, 'providerAvailability/doc1'))));
  await check('a patient reads an override', assertSucceeds(getDoc(doc(pt, 'providerAvailability/doc1/overrides/2099-02-02'))));

  console.log('\nPOSITIVE CONTROL — non-Healthcare providers are unchanged by this slice');
  await check('a photographer still updates its own availability', assertSucceeds(updateDoc(doc(photo1, 'providerAvailability/photo1'), { 'appt.durationMins': 45 })));
  await check('…and writes its own override', assertSucceeds(setDoc(doc(photo1, 'providerAvailability/photo1/overrides/2099-01-01'), { date: '2099-01-01', closed: true })));
  await check('a stranger never writes someone else\'s availability', assertFails(updateDoc(doc(mallory, 'providerAvailability/photo1'), { 'appt.durationMins': 5 })));

  console.log('\nCOUNTERPROOF — rules disabled');
  await env.withSecurityRulesDisabled(async (c) => {
    await check('rules disabled: the Healthcare write succeeds (so the denials are the rules)', assertSucceeds(updateDoc(doc(c.firestore(), 'providerAvailability/doc1'), { 'appt.durationMins': 5 })));
  });
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
