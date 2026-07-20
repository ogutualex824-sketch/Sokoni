/* workspaceMemberships Firestore rules — emulator-backed.

   Run:  firebase emulators:exec --only firestore "node scripts/test-workspace-rules.js"

   The collection previously had NO rule, so it defaulted to deny and the
   workforce client's onSnapshot failed permission-denied with the error
   swallowed — an empty business switcher rather than a reported fault.

   These assert the rule allows exactly the client's real query and nothing
   wider. The enumeration case matters most: a query WITHOUT the uid filter
   must be rejected outright, because that is what stops one person listing
   another organisation's staff. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 70) + ']' : ''));
  ok ? pass++ : fail++;
};
const check = async (label, p) => {
  try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); }
};

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-rules-test',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  const { doc, setDoc, getDoc, getDocs, query, collection, where, deleteDoc, updateDoc } =
    require('firebase/firestore');

  /* Seed past the rules — two people, two businesses. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'workspaceMemberships', 'm_alice_biz1'),
      { uid: 'alice', businessId: 'biz1', status: 'active', role: 'cashier', permissions: ['pos'] });
    await setDoc(doc(db, 'workspaceMemberships', 'm_bob_biz2'),
      { uid: 'bob', businessId: 'biz2', status: 'active', role: 'manager', permissions: ['pos', 'reports'] });
  });

  const alice = env.authenticatedContext('alice').firestore();
  const anon  = env.unauthenticatedContext().firestore();

  console.log('\n── The client query must work ──');
  await check('member reads own membership by query (the real client query)',
    assertSucceeds(getDocs(query(collection(alice, 'workspaceMemberships'),
      where('uid', '==', 'alice'), where('status', '==', 'active')))));
  await check('member reads own membership doc directly',
    assertSucceeds(getDoc(doc(alice, 'workspaceMemberships', 'm_alice_biz1'))));

  console.log('\n── Least privilege ──');
  await check('cross-organisation read denied',
    assertFails(getDoc(doc(alice, 'workspaceMemberships', 'm_bob_biz2'))));
  await check('non-member cannot query another persons memberships',
    assertFails(getDocs(query(collection(alice, 'workspaceMemberships'),
      where('uid', '==', 'bob')))));
  await check('ENUMERATION denied — unfiltered list of all memberships',
    assertFails(getDocs(collection(alice, 'workspaceMemberships'))));
  await check('enumeration by businessId denied',
    assertFails(getDocs(query(collection(alice, 'workspaceMemberships'),
      where('businessId', '==', 'biz2')))));
  await check('unauthenticated read denied',
    assertFails(getDoc(doc(anon, 'workspaceMemberships', 'm_alice_biz1'))));
  await check('unauthenticated query denied',
    assertFails(getDocs(query(collection(anon, 'workspaceMemberships'),
      where('uid', '==', 'alice')))));

  console.log('\n── No privilege elevation ──');
  await check('member cannot grant themselves a permission',
    assertFails(updateDoc(doc(alice, 'workspaceMemberships', 'm_alice_biz1'),
      { permissions: ['pos', 'finance', 'users'] })));
  await check('member cannot promote their own role',
    assertFails(updateDoc(doc(alice, 'workspaceMemberships', 'm_alice_biz1'), { role: 'owner' })));
  await check('member cannot forge a membership in another business',
    assertFails(setDoc(doc(alice, 'workspaceMemberships', 'forged'),
      { uid: 'alice', businessId: 'biz2', status: 'active', permissions: ['finance'] })));
  await check('member cannot delete their own membership record',
    assertFails(deleteDoc(doc(alice, 'workspaceMemberships', 'm_alice_biz1'))));

  await env.cleanup();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error: ' + e.message); process.exit(1); });
