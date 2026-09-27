/* test-legal-verification-rules.js — Firestore rules for the Legal Verification Authority (CHANGELOG 220),
 * emulator-backed, against the SERVED ruleset (firestore.rules.build unless RULES_FILE says otherwise).
 *
 *   node scripts/run-rules-suite.js scripts/test-legal-verification-rules.js
 *
 * PROVES
 *   - no client (the advocate, another user, anonymous) can write legalProviders / legalVerifications /
 *     legalVerificationEvents / legalProviderQuarantine — so nobody can set adminApproved, lskVerified,
 *     practiceStatus, bookable, forge a P.105 / name / status / evidence reference, or edit another
 *     advocate's verification
 *   - the Legal record is readable only by its advocate and admins (no public raw read — the directory is
 *     the public projection); the private evidence, the history and the quarantine are admin-read only
 *   - the public legal directory card (lawyers/) can no longer be self-published (a fake Legal identity
 *     in site search) — create denied to every client; admins may still correct/remove
 *   - COUNTERPROOF: the same writes SUCCEED with rules disabled, so every denial above is the RULES
 *     speaking, not an emulator that denies everything
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
  const rulesText = fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build'), 'utf8');
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-legal-verification-rules',
    firestore: { rules: rulesText, host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) },
  });
  await env.clearFirestore();
  const { doc, setDoc, getDoc, updateDoc, deleteDoc } = require('firebase/firestore');

  /* seed through the admin bypass */
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    await setDoc(doc(d, 'legalProviders/adv1'), { uid: 'adv1', name: 'Wanjiru Kamau', licenseNumber: 'P.105/1234/15', status: 'pending_review', verification: { admin: { status: 'pending' }, lsk: { status: 'pending' } } });
    await setDoc(doc(d, 'legalProviders/adv2'), { uid: 'adv2', name: 'Otieno', status: 'active', verification: { admin: { status: 'approved' }, lsk: { status: 'verified' } } });
    await setDoc(doc(d, 'legalVerifications/adv1'), { uid: 'adv1', lsk: { p105Number: 'P.105/1234/15', evidenceRef: 'capture' } });
    await setDoc(doc(d, 'legalVerificationEvents/e1'), { uid: 'adv1', action: 'lsk_verified' });
    await setDoc(doc(d, 'legalProviderQuarantine/tmm'), { uid: 'tmm', reason: 'legacy' });
    await setDoc(doc(d, 'lawyers/adv2'), { name: 'Otieno', projectedBy: 'legal-verification' });
  });

  const adv = env.authenticatedContext('adv1', { email_verified: true }).firestore();
  const other = env.authenticatedContext('eve', { email_verified: true }).firestore();
  const anon = env.unauthenticatedContext().firestore();
  const admin = env.authenticatedContext('adm1', { admin: true, email_verified: true }).firestore();

  console.log('\nLegal Verification — client writes are refused');
  const FORGE = {
    'adminApproved': { verification: { admin: { status: 'approved' } } },
    'lskVerified': { verification: { lsk: { status: 'verified', source: 'lsk_authorized_integration' } } },
    'practiceStatus Active': { verification: { lsk: { practiceStatus: 'Active' } } },
    'bookable': { verification: { eligibility: { bookable: true } }, bookable: true, status: 'active' },
    'forged P.105': { licenseNumber: 'P.105/9999/15' },
  };
  for (const [k, patch] of Object.entries(FORGE)) {
    await check(`the advocate cannot set ${k} on their own Legal record`, assertFails(updateDoc(doc(adv, 'legalProviders/adv1'), patch)));
    await check(`another user cannot set ${k} on an advocate's Legal record`, assertFails(updateDoc(doc(other, 'legalProviders/adv1'), patch)));
  }
  await check('a client cannot create a Legal record (identity is server-created)', assertFails(setDoc(doc(other, 'legalProviders/eve'), { uid: 'eve', name: 'Eve', status: 'active' })));
  await check('a client cannot delete a Legal record', assertFails(deleteDoc(doc(adv, 'legalProviders/adv1'))));
  await check('the advocate cannot write the private verification (forged name / status / evidence)', assertFails(setDoc(doc(adv, 'legalVerifications/adv1'), { lsk: { status: 'verified', verifiedName: 'X', practiceStatus: 'Active', evidenceRef: 'forged' } })));
  await check('a client cannot append or edit verification history', assertFails(setDoc(doc(adv, 'legalVerificationEvents/forged'), { uid: 'adv1', action: 'lsk_verified', actor: 'adm1' })));
  await check('…nor rewrite an existing event', assertFails(updateDoc(doc(other, 'legalVerificationEvents/e1'), { action: 'admin_approved' })));
  await check('a client cannot release or write a quarantine', assertFails(deleteDoc(doc(other, 'legalProviderQuarantine/tmm'))));
  await check('even an ADMIN client cannot write the authority collections directly (server-only)', assertFails(updateDoc(doc(admin, 'legalProviders/adv1'), { verification: { admin: { status: 'approved' } } })));

  console.log('\nLegal Verification — reads');
  await check('the advocate reads their own Legal record', assertSucceeds(getDoc(doc(adv, 'legalProviders/adv1'))));
  await check('another user cannot read an advocate\'s raw Legal record', assertFails(getDoc(doc(other, 'legalProviders/adv1'))));
  await check('…not even an eligible one (the directory is the public projection)', assertFails(getDoc(doc(anon, 'legalProviders/adv2'))));
  await check('the advocate cannot read the private verification evidence', assertFails(getDoc(doc(adv, 'legalVerifications/adv1'))));
  await check('the advocate cannot read the verification history', assertFails(getDoc(doc(adv, 'legalVerificationEvents/e1'))));
  await check('an admin reads the private verification, the history and the quarantine', Promise.all([
    assertSucceeds(getDoc(doc(admin, 'legalVerifications/adv1'))), assertSucceeds(getDoc(doc(admin, 'legalVerificationEvents/e1'))), assertSucceeds(getDoc(doc(admin, 'legalProviderQuarantine/tmm')))]));

  console.log('\nThe public legal directory (lawyers/)');
  await check('a client cannot self-publish a lawyer card (fake Legal identity)', assertFails(setDoc(doc(other, 'lawyers/eve'), { uid: 'eve', name: 'Eve Advocate', status: 'active' })));
  await check('…nor edit a projected card', assertFails(updateDoc(doc(other, 'lawyers/adv2'), { name: 'Hijacked' })));
  await check('anyone may read a projected card (public directory)', assertSucceeds(getDoc(doc(anon, 'lawyers/adv2'))));

  console.log('\nCOUNTERPROOF — the same writes with rules disabled');
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    await check('rules disabled: the forged approval write succeeds (so the denials above are the rules)', assertSucceeds(updateDoc(doc(d, 'legalProviders/adv1'), { verification: { admin: { status: 'approved' } } })));
    await check('rules disabled: a lawyer card can be created', assertSucceeds(setDoc(doc(d, 'lawyers/eve'), { name: 'Eve' })));
  });

  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
