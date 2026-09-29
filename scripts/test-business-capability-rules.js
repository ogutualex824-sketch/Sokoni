/* test-business-capability-rules.js — the capability stamp and the category stamp on businesses/{id} are server-written
 * only (R1, capability convergence). Emulator-backed, against the BUILT ruleset (firestore.rules.build).
 *
 *   node scripts/run-rules-suite.js scripts/test-business-capability-rules.js
 *
 * PROVES
 *   self-stamp closed   an owner cannot CREATE businesses/{uid} carrying `capabilities` or `business`, nor UPDATE either
 *                       (whole object, dotted path, or a single state field) on an existing record
 *   admin raw write     an administrator's RAW client write to `capabilities` / `business` is refused — the audited
 *                       server paths are the only writers; an admin's raw edit of another field still works
 *   identity fields     the pre-existing protections still hold: uid cannot change; approved/approvedAt/verified stay
 *                       admin-only; a stranger cannot update at all
 *   permitted fields    an owner still creates a plain business and still edits name / phone / description
 *   single block        exactly ONE match block for businesses (duplicates OR, and would void this)
 *   COUNTERPROOF        with rules disabled (the server path) the very same stamp writes succeed
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
const STAMP = { version: 1, SERVICES: { state: 'approved', decidedBy: 'admin_1', decidedAt: '2026-09-03T22:55:02.000Z', applicationId: 'app_1', source: 'application_approval' } };
(async () => {
  const RULES = fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build'), 'utf8');
  console.log('\nsingle authoritative block');
  ck('exactly ONE match block for businesses/{…}', (RULES.match(/match \/businesses\/\{/g) || []).length === 1);
  ck('the block names both protected keys on create and on update', (RULES.match(/hasAny\(\['capabilities', 'business'\]\)/g) || []).length >= 3);
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-business-capability-rules',
    firestore: { rules: RULES, host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) },
  });
  await env.clearFirestore();
  const { doc, setDoc, updateDoc } = require('firebase/firestore');
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'businesses/own1'), { uid: 'own1', ownerId: 'own1', name: 'Stamped Co', status: 'active', capabilities: STAMP, business: { category: 'trades', source: 'application' } });
    await setDoc(doc(f, 'businesses/own2'), { uid: 'own2', ownerId: 'own2', name: 'Plain Co', status: 'active' });
  });
  const C = (uid, extra) => env.authenticatedContext(uid, Object.assign({ email_verified: true, deactivated: false }, extra || {})).firestore();
  const own1 = C('own1'), own2 = C('own2'), newbie = C('newbie'), stranger = C('stranger'), adm = C('admin1', { admin: true });

  console.log('\nself-stamp — an owner cannot create a stamped business');
  await check('CREATE businesses/{uid} with a well-formed capabilities stamp DENIED', assertFails(setDoc(doc(newbie, 'businesses/newbie'), { uid: 'newbie', ownerId: 'newbie', name: 'N', capabilities: STAMP })));
  await check('CREATE with a category stamp (business) DENIED', assertFails(setDoc(doc(newbie, 'businesses/newbie'), { uid: 'newbie', ownerId: 'newbie', name: 'N', business: { category: 'retail_store', source: 'application' } })));
  await check('CREATE with an EMPTY capabilities object DENIED (the key itself is server-only)', assertFails(setDoc(doc(newbie, 'businesses/newbie'), { uid: 'newbie', ownerId: 'newbie', name: 'N', capabilities: {} })));
  await check('POSITIVE CONTROL: CREATE a plain business (no stamp) ALLOWED', assertSucceeds(setDoc(doc(newbie, 'businesses/newbie'), { uid: 'newbie', ownerId: 'newbie', name: 'N', status: 'active' })));

  console.log('\nself-stamp — an owner cannot update either stamp');
  await check('owner UPDATE capabilities (whole object) on a plain business DENIED', assertFails(updateDoc(doc(own2, 'businesses/own2'), { capabilities: STAMP })));
  await check('owner UPDATE capabilities.PRODUCTS (dotted path) on a stamped business DENIED', assertFails(updateDoc(doc(own1, 'businesses/own1'), { 'capabilities.PRODUCTS': STAMP.SERVICES })));
  await check('owner UPDATE capabilities.SERVICES.state (a single field) DENIED', assertFails(updateDoc(doc(own1, 'businesses/own1'), { 'capabilities.SERVICES.state': 'revoked' })));
  await check('owner UPDATE business.category DENIED', assertFails(updateDoc(doc(own1, 'businesses/own1'), { 'business.category': 'salon' })));
  await check('owner UPDATE business (whole object) on a plain business DENIED', assertFails(updateDoc(doc(own2, 'businesses/own2'), { business: { category: 'salon', source: 'admin' } })));
  await check('POSITIVE CONTROL: owner edits name, phone and description ALLOWED', assertSucceeds(updateDoc(doc(own1, 'businesses/own1'), { name: 'Stamped Co Ltd', phone: '0700000000', description: 'd' })));

  console.log('\nadmin raw client writes — the audited server paths are the only writers');
  await check('ADMIN raw UPDATE capabilities DENIED', assertFails(updateDoc(doc(adm, 'businesses/own2'), { capabilities: STAMP })));
  await check('ADMIN raw UPDATE capabilities.SERVICES.state DENIED', assertFails(updateDoc(doc(adm, 'businesses/own1'), { 'capabilities.SERVICES.state': 'suspended' })));
  await check('ADMIN raw UPDATE business.category DENIED', assertFails(updateDoc(doc(adm, 'businesses/own1'), { 'business.category': 'hotel' })));
  await check('POSITIVE CONTROL: ADMIN raw edit of another field (adminNote) ALLOWED', assertSucceeds(updateDoc(doc(adm, 'businesses/own1'), { adminNote: 'checked' })));
  await check('POSITIVE CONTROL: ADMIN suspends a business (status) ALLOWED', assertSucceeds(updateDoc(doc(adm, 'businesses/own2'), { status: 'suspended', suspended: true })));

  console.log('\nidentity fields — pre-existing protections still hold');
  await check('owner cannot change uid', assertFails(updateDoc(doc(own2, 'businesses/own2'), { uid: 'someone' })));
  await check('owner cannot write approved / approvedAt / verified (noAdminFields)', assertFails(updateDoc(doc(own2, 'businesses/own2'), { approved: true, approvedAt: 'now', verified: true })));
  await check('a stranger cannot update another owner\'s business', assertFails(updateDoc(doc(stranger, 'businesses/own2'), { name: 'Hijacked' })));
  await check('a stranger cannot create a business as someone else (uid mismatch)', assertFails(setDoc(doc(stranger, 'businesses/victim'), { uid: 'victim', ownerId: 'victim', name: 'X' })));

  console.log('\nCOUNTERPROOF — rules disabled (the server path)');
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await check('server: CREATE a stamped business succeeds (so the denials above are the rules)', assertSucceeds(setDoc(doc(f, 'businesses/srv1'), { uid: 'srv1', ownerId: 'srv1', name: 'S', capabilities: STAMP })));
    await check('server: UPDATE capabilities.SERVICES.state succeeds', assertSucceeds(updateDoc(doc(f, 'businesses/srv1'), { 'capabilities.SERVICES.state': 'suspended' })));
    await check('server: UPDATE business.category succeeds', assertSucceeds(updateDoc(doc(f, 'businesses/srv1'), { business: { category: 'trades', source: 'admin' } })));
  });
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
