/* test-publication-gate-rules.js — a client cannot manufacture a public / approved record (CHANGELOG 242, approval gate).
 * Emulator-backed, against the BUILT ruleset (firestore.rules.build).
 *
 *   node scripts/run-rules-suite.js scripts/test-publication-gate-rules.js
 *
 * PROVES
 *   BnB    a listing is created PENDING only — status active / approved / published / verified / discoveryEligible /
 *          isPublic / bypassApproval / spotlight / a client reviewer are each refused; the host can never change status;
 *          an admin's RAW status write is refused (the decision is the audited callable); the public reads ACTIVE only,
 *          an unfiltered public query is refused and a status=='active' query is served; the host sees its own pending
 *   Food   only an APPROVED restaurant (providers active + business.category 'restaurant') publishes a menu; an
 *          unapproved account, and an approved non-restaurant, cannot; the public reads only an approved restaurant's menu
 *   Venue  a direct client create cannot arrive active; the owner cannot change status; the public reads active only
 *   single one match block each for bnbListings, foodMenus, venues
 *   POSITIVE CONTROLS on every path; COUNTERPROOF with rules disabled
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
  for (const c of ['bnbListings', 'foodMenus', 'venues']) ck(`exactly ONE match block for ${c}`, (RULES.match(new RegExp('match /' + c + '/\\{', 'g')) || []).length === 1);

  const env = await initializeTestEnvironment({ projectId: 'sokoni-publication-gate', firestore: { rules: RULES, host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) } });
  await env.clearFirestore();
  const { doc, setDoc, getDoc, getDocs, updateDoc, collection, query, where } = require('firebase/firestore');
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'bnbListings/PEND'), { id: 'PEND', name: 'Pending Cottage', type: 'cottage', location: 'Naivasha', price: 5000, phone: '0700', hostUid: 'host1', status: 'pending', createdAt: 1 });
    await setDoc(doc(f, 'bnbListings/LIVE'), { id: 'LIVE', name: 'Live Cottage', type: 'cottage', location: 'Naivasha', price: 5000, phone: '0700', hostUid: 'host2', status: 'active', createdAt: 2 });
    await setDoc(doc(f, 'bnbListings/REJ'), { id: 'REJ', name: 'Rejected', type: 'cottage', location: 'X', price: 1, phone: '0700', hostUid: 'host3', status: 'rejected', createdAt: 3 });
    await setDoc(doc(f, 'providers/resto1'), { uid: 'resto1', status: 'active', business: { category: 'restaurant', source: 'admin' } });
    await setDoc(doc(f, 'providers/resto0'), { uid: 'resto0', status: 'pending', business: { category: 'restaurant', source: 'application' } });
    await setDoc(doc(f, 'providers/plumb1'), { uid: 'plumb1', status: 'active', business: { category: 'trades', source: 'application' } });
    await setDoc(doc(f, 'foodMenus/resto1'), { items: [{ name: 'Pilau', price: 300 }] });
    await setDoc(doc(f, 'foodMenus/resto0'), { items: [{ name: 'Draft', price: 1 }] });
    await setDoc(doc(f, 'venues/VP'), { ownerId: 'vown', name: 'Pending Hall', status: 'pending' });
    await setDoc(doc(f, 'venues/VA'), { ownerId: 'vown', name: 'Live Hall', status: 'active' });
  });
  const C = (uid, extra) => env.authenticatedContext(uid, Object.assign({ email_verified: true, deactivated: false }, extra || {})).firestore();
  const host1 = C('host1'); const host9 = C('host9'); const adm = C('admin1', { admin: true }); const anon = env.unauthenticatedContext().firestore();
  const pub = C('buyer1');
  const base = (id, extra) => Object.assign({ id, name: 'New Stay', type: 'cottage', location: 'Diani', price: 7000, phone: '0711', hostUid: 'host9', uid: 'host9' }, extra || {});

  console.log('\nBnB — creation is not publication');
  await check('POSITIVE CONTROL: a host creates a PENDING listing', assertSucceeds(setDoc(doc(host9, 'bnbListings/N0'), base('N0', { status: 'pending' }))));
  await check('a listing with NO status is refused (it must be created pending)', assertFails(setDoc(doc(host9, 'bnbListings/N1'), base('N1'))));
  for (const [k, v] of [['status', 'active'], ['approved', true], ['published', true], ['verified', true], ['discoveryEligible', true], ['isPublic', true], ['bypassApproval', true], ['spotlight', true], ['featured', true], ['updatedBy', 'admin1']]) {
    const extra = k === 'status' ? { status: v } : { status: 'pending', [k]: v };
    await check(`S1–S4: create with ${k}=${JSON.stringify(v)} refused`, assertFails(setDoc(doc(host9, 'bnbListings/X_' + k), base('X_' + k, extra))));
  }
  await check('the host cannot move its own listing to active', assertFails(updateDoc(doc(host1, 'bnbListings/PEND'), { status: 'active' })));
  await check('POSITIVE CONTROL: the host edits its own listing\'s description', assertSucceeds(updateDoc(doc(host1, 'bnbListings/PEND'), { description: 'Updated' })));
  await check('an ADMIN raw status write is refused (the decision is the audited AdminOS callable)', assertFails(updateDoc(doc(adm, 'bnbListings/PEND'), { status: 'active' })));
  await check('POSITIVE CONTROL: an admin raw edit of another field works', assertSucceeds(updateDoc(doc(adm, 'bnbListings/PEND'), { price: 5500 })));

  console.log('\nBnB — the public sees ACTIVE only');
  await check('S9: the public cannot read a PENDING listing', assertFails(getDoc(doc(pub, 'bnbListings/PEND'))));
  await check('S8: the public cannot read a REJECTED listing', assertFails(getDoc(doc(anon, 'bnbListings/REJ'))));
  await check('POSITIVE CONTROL: the public reads an ACTIVE listing', assertSucceeds(getDoc(doc(anon, 'bnbListings/LIVE'))));
  await check('an unfiltered public query is refused (rules are not filters)', assertFails(getDocs(collection(pub, 'bnbListings'))));
  await check('POSITIVE CONTROL: the hub\'s status == active query is served', assertSucceeds(getDocs(query(collection(anon, 'bnbListings'), where('status', '==', 'active')))));
  await check('POSITIVE CONTROL: the host reads its own pending listing', assertSucceeds(getDoc(doc(host1, 'bnbListings/PEND'))));

  console.log('\nFood — a menu belongs to an APPROVED restaurant');
  await check('POSITIVE CONTROL: an approved restaurant publishes its menu', assertSucceeds(setDoc(doc(C('resto1'), 'foodMenus/resto1'), { items: [{ name: 'Chapati', price: 50 }] })));
  await check('an UNAPPROVED (pending) restaurant cannot publish a menu', assertFails(setDoc(doc(C('resto0'), 'foodMenus/resto0'), { items: [] })));
  await check('an approved NON-restaurant (a plumber) cannot publish a menu', assertFails(setDoc(doc(C('plumb1'), 'foodMenus/plumb1'), { items: [] })));
  await check('an account with no business at all cannot publish a menu', assertFails(setDoc(doc(C('nobody'), 'foodMenus/nobody'), { items: [] })));
  await check('POSITIVE CONTROL: the public reads an approved restaurant\'s menu', assertSucceeds(getDoc(doc(anon, 'foodMenus/resto1'))));
  await check('the public cannot read an unapproved restaurant\'s menu', assertFails(getDoc(doc(anon, 'foodMenus/resto0'))));

  console.log('\nVenues — never public before approval');
  await check('a direct client create cannot arrive active', assertFails(setDoc(doc(C('vown'), 'venues/VX'), { ownerId: 'vown', name: 'Sneaky', status: 'active' })));
  await check('POSITIVE CONTROL: a direct client create arrives pending', assertSucceeds(setDoc(doc(C('vown'), 'venues/VY'), { ownerId: 'vown', name: 'Honest', status: 'pending' })));
  await check('the owner cannot change status', assertFails(updateDoc(doc(C('vown'), 'venues/VP'), { status: 'active' })));
  await check('S9: the public cannot read a pending venue', assertFails(getDoc(doc(pub, 'venues/VP'))));
  await check('POSITIVE CONTROL: the public reads an active venue', assertSucceeds(getDoc(doc(pub, 'venues/VA'))));

  console.log('\nCOUNTERPROOF — rules disabled');
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await check('rules disabled: an active BnB create succeeds (so its denial is the rules)', assertSucceeds(setDoc(doc(f, 'bnbListings/CP'), base('CP', { status: 'active' }))));
    await check('rules disabled: an unapproved menu write succeeds', assertSucceeds(setDoc(doc(f, 'foodMenus/resto0'), { items: [] })));
  });
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
