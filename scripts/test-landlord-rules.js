/* landlordProperties Firestore rules — emulator-backed.

   Run:  firebase emulators:exec --only firestore "node scripts/test-landlord-rules.js"

   These rules carry the model decision, so they are where it has to be proven.
   The old shape put units and their rent/water history inside one array on
   landlordData/{uid}: recording a tenant's rent rewrote the whole building, and
   no individual entry could be queried, indexed, audited or protected.

   The cases that matter most are the ones an array could never express:

     * a landlord cannot publish their own building (status must start pending)
     * a landlord cannot edit a PAID ledger entry — money is reversed with a new
       adjustment or refund entry, never by rewriting history
     * one landlord cannot read or touch another's units or ledger
     * a tenant can read their own unit and ledger, and nothing else
     * ownerUid cannot be reassigned, which is what makes denormalising it onto
       units and ledger entries safe instead of a drift risk
*/
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

const P = 'landlordProperties';

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-landlord-rules-test',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  const { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs } =
    require('firebase/firestore');

  /* Seed past the rules: one building owned by landlordA, one unit with a
     tenant, one pending and one paid ledger entry. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, P, 'bldg1'), {
      ownerUid: 'landlordA', name: 'Riverside Court', address: '12 Ngong Rd',
      city: 'Nairobi', status: 'active', createdAt: 1, updatedAt: 1,
    });
    await setDoc(doc(db, P, 'bldg1', 'units', 'u1'), {
      ownerUid: 'landlordA', tenantUid: 'tenantT', number: 'A1',
      monthlyRent: 25000, occupancyStatus: 'occupied', createdAt: 1,
    });
    await setDoc(doc(db, P, 'bldg1', 'units', 'u1', 'ledger', 'l_pending'), {
      ownerUid: 'landlordA', tenantUid: 'tenantT', type: 'rent',
      period: '2026-08', amount: 25000, status: 'pending', createdAt: 1,
    });
    await setDoc(doc(db, P, 'bldg1', 'units', 'u1', 'ledger', 'l_paid'), {
      ownerUid: 'landlordA', tenantUid: 'tenantT', type: 'rent',
      period: '2026-07', amount: 25000, status: 'paid', paidAt: 2, createdAt: 1,
    });
  });

  const owner  = env.authenticatedContext('landlordA').firestore();
  const other  = env.authenticatedContext('landlordB').firestore();
  const tenant = env.authenticatedContext('tenantT').firestore();
  const admin  = env.authenticatedContext('adm', { admin: true }).firestore();
  const anon   = env.unauthenticatedContext().firestore();

  console.log('\nBuilding — creation and moderation');
  console.log('──────────────────────────────────');
  await check('a landlord may create their own building',
    assertSucceeds(setDoc(doc(owner, P, 'new1'),
      { ownerUid: 'landlordA', name: 'New Block', status: 'pending', createdAt: 3 })));
  await check('a landlord may NOT self-publish (status must start pending)',
    assertFails(setDoc(doc(owner, P, 'new2'),
      { ownerUid: 'landlordA', name: 'Sneaky', status: 'active', createdAt: 3 })));
  await check('a landlord may NOT create a building owned by someone else',
    assertFails(setDoc(doc(owner, P, 'new3'),
      { ownerUid: 'landlordB', name: 'Not Mine', status: 'pending', createdAt: 3 })));
  await check('a landlord may NOT approve their own building',
    assertFails(updateDoc(doc(owner, P, 'bldg1'), { status: 'active' })));
  await check('an admin MAY moderate',
    assertSucceeds(updateDoc(doc(admin, P, 'bldg1'), { status: 'active', updatedAt: 9 })));
  await check('a landlord MAY edit their own building details',
    assertSucceeds(updateDoc(doc(owner, P, 'bldg1'), { name: 'Riverside Courts', updatedAt: 9 })));
  await check('ownerUid cannot be reassigned by its owner',
    assertFails(updateDoc(doc(owner, P, 'bldg1'), { ownerUid: 'landlordB' })));
  await check('another landlord may NOT edit it',
    assertFails(updateDoc(doc(other, P, 'bldg1'), { name: 'Hijacked' })));
  await check('the building directory is public to read',
    assertSucceeds(getDoc(doc(anon, P, 'bldg1'))));

  console.log('\nUnits — private, unlike the building');
  console.log('────────────────────────────────────');
  await check('owner may read their unit',
    assertSucceeds(getDoc(doc(owner, P, 'bldg1', 'units', 'u1'))));
  await check('tenant may read their own unit',
    assertSucceeds(getDoc(doc(tenant, P, 'bldg1', 'units', 'u1'))));
  await check('another landlord may NOT read it',
    assertFails(getDoc(doc(other, P, 'bldg1', 'units', 'u1'))));
  await check('the public may NOT read who lives there',
    assertFails(getDoc(doc(anon, P, 'bldg1', 'units', 'u1'))));
  await check('owner may add a unit',
    assertSucceeds(setDoc(doc(owner, P, 'bldg1', 'units', 'u2'),
      { ownerUid: 'landlordA', number: 'A2', createdAt: 4 })));
  await check('another landlord may NOT add a unit to this building',
    assertFails(setDoc(doc(other, P, 'bldg1', 'units', 'u3'),
      { ownerUid: 'landlordB', number: 'A3', createdAt: 4 })));
  await check('a tenant may NOT change their own rent',
    assertFails(updateDoc(doc(tenant, P, 'bldg1', 'units', 'u1'), { monthlyRent: 1 })));

  console.log('\nLedger — a paid entry is history');
  console.log('────────────────────────────────');
  const L = [P, 'bldg1', 'units', 'u1', 'ledger'];
  await check('owner may raise a rent charge',
    assertSucceeds(setDoc(doc(owner, ...L, 'l_new'),
      { ownerUid: 'landlordA', type: 'rent', period: '2026-09', amount: 25000,
        status: 'pending', createdAt: 5 })));
  await check('owner may settle a PENDING entry',
    assertSucceeds(updateDoc(doc(owner, ...L, 'l_pending'),
      { status: 'paid', paidAt: 6, reference: 'MPESA123' })));
  await check('owner may NOT edit a PAID entry',
    assertFails(updateDoc(doc(owner, ...L, 'l_paid'), { amount: 1 })));
  await check('owner may NOT delete a ledger entry',
    assertFails(deleteDoc(doc(owner, ...L, 'l_paid'))));
  await check('an unknown ledger type is rejected',
    assertFails(setDoc(doc(owner, ...L, 'l_bad'),
      { ownerUid: 'landlordA', type: 'bribe', period: '2026-09', amount: 1,
        status: 'pending', createdAt: 5 })));
  await check('a non-numeric amount is rejected',
    assertFails(setDoc(doc(owner, ...L, 'l_bad2'),
      { ownerUid: 'landlordA', type: 'rent', period: '2026-09', amount: 'lots',
        status: 'pending', createdAt: 5 })));
  await check('every approved type is accepted',
    assertSucceeds(Promise.all(
      ['water', 'deposit', 'refund', 'adjustment', 'penalty', 'discount'].map((t, i) =>
        setDoc(doc(owner, ...L, 'l_t' + i),
          { ownerUid: 'landlordA', type: t, period: '2026-09', amount: 100,
            status: 'pending', createdAt: 5 })))));
  await check('tenant may read their own ledger',
    assertSucceeds(getDoc(doc(tenant, ...L, 'l_paid'))));
  await check('another landlord may NOT read this ledger',
    assertFails(getDoc(doc(other, ...L, 'l_paid'))));
  await check('tenant may NOT raise a charge against themselves',
    assertFails(setDoc(doc(tenant, ...L, 'l_evil'),
      { ownerUid: 'tenantT', type: 'discount', period: '2026-09', amount: -5000,
        status: 'paid', createdAt: 5 })));
  await check('admin may delete a ledger entry',
    assertSucceeds(deleteDoc(doc(admin, ...L, 'l_paid'))));

  console.log('\nAdmin moderation queue');
  console.log('──────────────────────');
  await check('admin may list buildings',
    assertSucceeds(getDocs(collection(admin, P))));

  await env.cleanup();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
