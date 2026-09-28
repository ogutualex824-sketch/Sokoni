/* test-business-category-rules.js — the canonical business category is server-written only (CHANGELOG 236, C1).
 * Emulator-backed, against the BUILT ruleset (firestore.rules.build). The SERVED ruleset (6c67a34d) differs and is not
 * what this proves — certification fetches it through the Rules REST API.
 *
 *   node scripts/run-rules-suite.js scripts/test-business-category-rules.js
 *
 * PROVES
 *   self-assignment   a provider cannot write providers.business on create or update (nor the lane inside it)
 *   admin raw write   an administrator's RAW client write to providers.business is refused — reclassification is the
 *                     audited callable only; an admin's raw edit of another field still works
 *   frozen decision   the applicant of an APPROVED application cannot change the fields its category and lane were
 *                     derived from (role, category, subcategory, hub, performerType…) — but can still fix a phone number
 *   pending editable  a PENDING application stays editable (the freeze starts at the decision)
 *   single block      exactly ONE match block for providers and for applications (duplicates OR, and would void this)
 *   POSITIVE CONTROL  known-ALLOWED writes on the SAME paths succeed (so the denials are the rules, not a broken ruleset)
 *   COUNTERPROOF      the denied writes succeed with rules disabled
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
  const RULES = fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build'), 'utf8');
  console.log('\nsingle authoritative blocks');
  ck('exactly ONE match block for providers/{…}', (RULES.match(/match \/providers\/\{/g) || []).length === 1);
  ck('exactly ONE match block for applications/{…}', (RULES.match(/match \/applications\/\{/g) || []).length === 1);

  const env = await initializeTestEnvironment({
    projectId: 'sokoni-business-category-rules',
    firestore: { rules: RULES, host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) },
  });
  await env.clearFirestore();
  const { doc, setDoc, updateDoc } = require('firebase/firestore');
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'providers/prov1'), { uid: 'prov1', status: 'active', name: 'Plumb Co', bio: 'old',
      business: { category: 'trades', lane: { hub: 'provider', entClass: null }, source: 'application' } });
    await setDoc(doc(f, 'applications/app_ok'), { uid: 'prov1', status: 'approved', role: 'provider', category: 'plumbing', phone: '0700000000' });
    await setDoc(doc(f, 'applications/app_pend'), { uid: 'prov2', status: 'pending', role: 'provider', category: 'plumbing', phone: '0700000001' });
  });
  const C = (uid, extra) => env.authenticatedContext(uid, Object.assign({ email_verified: true, deactivated: false }, extra || {})).firestore();
  const prov1 = C('prov1'); const prov2 = C('prov2'); const newbie = C('newbie'); const adm = C('admin1', { admin: true });

  console.log('\nproviders.business — nobody writes it from a client');
  await check('a provider re-filing itself (business.category = hotel) DENIED', assertFails(updateDoc(doc(prov1, 'providers/prov1'), { 'business.category': 'hotel' })));
  await check('a provider moving its own lane to entertainment DENIED', assertFails(updateDoc(doc(prov1, 'providers/prov1'), { 'business.lane': { hub: 'entertainment', entClass: 'ARTIST' } })));
  await check('a new provider record carrying a business category DENIED', assertFails(setDoc(doc(newbie, 'providers/newbie'), { uid: 'newbie', status: 'pending', name: 'N', business: { category: 'hotel' } })));
  await check('an ADMIN raw client write to business DENIED (the audited callable is the only path)', assertFails(updateDoc(doc(adm, 'providers/prov1'), { 'business.category': 'salon' })));
  await check('POSITIVE CONTROL: the provider still edits its own bio', assertSucceeds(updateDoc(doc(prov1, 'providers/prov1'), { bio: 'new bio' })));
  await check('POSITIVE CONTROL: a new provider record WITHOUT business is allowed', assertSucceeds(setDoc(doc(newbie, 'providers/newbie'), { uid: 'newbie', status: 'pending', name: 'N' })));
  await check('POSITIVE CONTROL: an admin raw edit of another field still works', assertSucceeds(updateDoc(doc(adm, 'providers/prov1'), { adminNote: 'checked' })));

  console.log('\napplications — the decided classification is frozen');
  for (const [k, v] of [['category', 'photographer'], ['hub', 'entertainment'], ['performerType', 'dj'], ['subcategory', 'DJ'], ['categories', ['dj']], ['type', 'provider'], ['businessType', 'hotel']]) {
    await check(`approved application: changing ${k} DENIED`, assertFails(updateDoc(doc(prov1, 'applications/app_ok'), { [k]: v })));
  }
  await check('POSITIVE CONTROL: the applicant still corrects the phone number on an approved application', assertSucceeds(updateDoc(doc(prov1, 'applications/app_ok'), { phone: '0711111111' })));
  await check('a PENDING application stays editable (category change allowed before the decision)', assertSucceeds(updateDoc(doc(prov2, 'applications/app_pend'), { category: 'cleaning' })));

  console.log('\nCOUNTERPROOF — rules disabled');
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await check('rules disabled: the self-assignment succeeds (so its denial is the rules)', assertSucceeds(updateDoc(doc(f, 'providers/prov1'), { 'business.category': 'hotel' })));
    await check('rules disabled: the approved-application edit succeeds', assertSucceeds(updateDoc(doc(f, 'applications/app_ok'), { hub: 'entertainment' })));
  });
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
