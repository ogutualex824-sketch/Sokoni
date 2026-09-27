/* test-provider-identity-fields-rules.js — server-set identity attributes on providers/{uid} (CHANGELOG 227).
 * Emulator-backed, against the SERVED ruleset.
 *
 *   node scripts/run-rules-suite.js scripts/test-provider-identity-fields-rules.js
 *
 * PROVES
 *   - a provider cannot create or edit their own `healthcare` category (a clinic re-filing itself as a pharmacy)
 *   - nor the Legal authority's link fields (`provisionedBy`, `legalProviderId`, `legalVerification`) — setting
 *     provisionedBy:'legal-verification' on one's own record defeated the Legal identity-conflict guard
 *   - POSITIVE CONTROL: the owner still edits ordinary profile text; an admin can still write the fields
 *   - COUNTERPROOF: the same writes succeed with rules disabled
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
    projectId: 'sokoni-provider-identity-fields',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build'), 'utf8'), host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) },
  });
  await env.clearFirestore();
  const { doc, setDoc, updateDoc } = require('firebase/firestore');
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'providers/clinic1'), { uid: 'clinic1', name: 'Kilimani Clinic', status: 'active', healthcare: { category: 'facility', source: 'application' } });
  });
  const own = env.authenticatedContext('clinic1', { email_verified: true, deactivated: false }).firestore();
  const newbie = env.authenticatedContext('newbie', { email_verified: true, deactivated: false }).firestore();
  const adm = env.authenticatedContext('adm1', { admin: true, email_verified: true, deactivated: false }).firestore();

  console.log('\nproviders/{uid} — server-set identity attributes');
  await check('POSITIVE CONTROL: the owner edits ordinary profile text', assertSucceeds(updateDoc(doc(own, 'providers/clinic1'), { description: 'Family clinic' })));
  await check('the owner cannot re-file their healthcare category (clinic → pharmacy)', assertFails(updateDoc(doc(own, 'providers/clinic1'), { healthcare: { category: 'pharmacy', source: 'admin' } })));
  await check('the owner cannot set provisionedBy (defeats the Legal identity-conflict guard)', assertFails(updateDoc(doc(own, 'providers/clinic1'), { provisionedBy: 'legal-verification' })));
  await check('the owner cannot set legalProviderId', assertFails(updateDoc(doc(own, 'providers/clinic1'), { legalProviderId: 'clinic1' })));
  await check('the owner cannot set legalVerification', assertFails(updateDoc(doc(own, 'providers/clinic1'), { legalVerification: { bookable: true } })));
  await check('a new provider cannot CREATE their record with a healthcare category', assertFails(setDoc(doc(newbie, 'providers/newbie'), { uid: 'newbie', name: 'N', status: 'pending', healthcare: { category: 'pharmacy' } })));
  await check('…nor with provisionedBy', assertFails(setDoc(doc(newbie, 'providers/newbie'), { uid: 'newbie', name: 'N', status: 'pending', provisionedBy: 'legal-verification' })));
  await check('POSITIVE CONTROL: a new provider still creates a plain pending record', assertSucceeds(setDoc(doc(newbie, 'providers/newbie'), { uid: 'newbie', name: 'N', status: 'pending' })));
  await check('POSITIVE CONTROL: an admin can still write the category', assertSucceeds(updateDoc(doc(adm, 'providers/clinic1'), { healthcare: { category: 'facility', source: 'admin' } })));

  console.log('\nCOUNTERPROOF — rules disabled');
  await env.withSecurityRulesDisabled(async (c) => {
    await check('rules disabled: the category write succeeds (so the denial is the rules)', assertSucceeds(updateDoc(doc(c.firestore(), 'providers/clinic1'), { healthcare: { category: 'pharmacy' } })));
  });
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
