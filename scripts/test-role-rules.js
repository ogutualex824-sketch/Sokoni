#!/usr/bin/env node
/* users.roles / users.activeRole authority — Firestore rules, emulator-backed  (Roles Phase 3)
 *
 *   firebase emulators:exec --only firestore "node scripts/test-role-rules.js"
 *   RULES_FILE=firestore.rules.phase3-candidate firebase emulators:exec --only firestore \
 *     "node scripts/test-role-rules.js"        # prove the DEPLOYABLE artifact, not just the source
 *
 * WHY THIS EXISTS
 * Phase 2 made approval the authority on roles — grantAccountRole writes users.roles
 * and users.activeRole through the Admin SDK. That was only half a control, because
 * the rules guarded the `role` STRING and never the `roles` ARRAY or `activeRole`:
 *
 *   profile.html  Settings → Linked hubs rebuilt the whole roles array from four
 *                 checkboxes and wrote it to the user's own document. Any signed-in
 *                 account could grant itself seller + provider + driver + agent, and
 *                 drop a server-granted role by unticking a box.
 *   profile.html  addRole() pushed ANY role key and toasted success regardless.
 *   driver.html   the shift toggle did the additive form, twice.
 *
 * An authority the client can overwrite is not an authority. These tests are where
 * that claim has to hold, because the rules are the only layer an attacker cannot
 * skip by not using our UI.
 *
 * Approval is read from the CUSTOM CLAIM, never from the user document — a claim is
 * signed into the ID token by the server and is the one role signal a client cannot
 * forge. Full audit: docs/ROLE_AUTHORITY_AUDIT.md
 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : ''));
  ok ? pass++ : fail++;
};
const denied = async (label, p) => {
  try { await assertFails(p); ck(label, true); }
  catch (e) { ck(label, false, 'ALLOWED — ' + e.message); }
};
const allowed = async (label, p) => {
  try { await assertSucceeds(p); ck(label, true); }
  catch (e) { ck(label, false, e.message); }
};
const head = (t) => console.log('\n── ' + t + ' ──');

const RULES_FILE = process.env.RULES_FILE || 'firestore.rules';

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-role-rules-test',
    firestore: {
      host: '127.0.0.1', port: 8080,
      rules: fs.readFileSync(path.join(__dirname, '..', RULES_FILE), 'utf8'),
    },
  });
  console.log('\nRules under test: ' + RULES_FILE);

  const UID = 'user_alpha';
  const OTHER = 'user_beta';

  /* Seed a user that the SERVER has approved as a seller. Written with rules
     disabled — this is what the Admin SDK does, and it is the state a client
     then tries to tamper with. */
  const seed = async (uid, data) => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('users').doc(uid).set(data);
    });
  };
  /* Default seed is the BASELINE account — roles ['buyer'] and nothing else. Tests
     that need a server-granted role to try to drop ask for it explicitly; seeding
     `seller` by default would make a "cannot add seller" assertion a no-op write
     that passes for the wrong reason. */
  const reset = async (roles) => {
    await env.clearFirestore();
    await seed(UID, {
      uid: UID, name: 'Alpha', email: 'a@example.com',
      roles: roles || ['buyer'], activeRole: 'buyer', accountStatus: 'active',
    });
  };

  /* A client whose ID token carries the seller claim — i.e. genuinely approved. */
  const approvedSeller = () => env.authenticatedContext(UID, { seller: true });
  /* A client with no role claims at all — the attacker case. */
  const plainUser = () => env.authenticatedContext(UID, {});
  const adminUser = () => env.authenticatedContext(UID, { admin: true });
  const docOf = (ctx, uid) => ctx.firestore().collection('users').doc(uid || UID);

  /* ══ 1 · a client cannot SELF-GRANT a role ══ */
  head('1 · a client cannot grant itself a role');
  await reset();
  await denied('cannot add "seller" to its own roles (profile.html addRole)',
    docOf(plainUser()).set({ roles: ['buyer', 'seller'] }, { merge: true }));
  await denied('cannot add "admin"',
    docOf(plainUser()).set({ roles: ['buyer', 'admin'] }, { merge: true }));
  await denied('cannot add "superAdmin"',
    docOf(plainUser()).set({ roles: ['buyer', 'superAdmin'] }, { merge: true }));
  await denied('cannot add "driver" (driver.html shift toggle)',
    docOf(plainUser()).update({ roles: ['buyer', 'seller', 'driver'] }));
  await denied('cannot write the four-checkbox self-grant (Settings → Linked hubs)',
    docOf(plainUser()).set({ roles: ['buyer', 'seller', 'provider', 'driver', 'agent'] }, { merge: true }));
  /* Even an APPROVED seller may not extend their own grant. A valid claim for one
     role is not authority over the array. */
  await reset(['buyer', 'seller']);
  await denied('an approved seller still cannot add a role it was not approved for',
    docOf(approvedSeller()).set({ roles: ['buyer', 'seller', 'provider'] }, { merge: true }));

  /* ══ 2 · a client cannot REMOVE or REPLACE roles ══ */
  head('2 · a client cannot remove or replace roles');
  await reset(['buyer', 'seller']);
  await denied('cannot drop a server-granted role (unticking a checkbox)',
    docOf(plainUser()).set({ roles: ['buyer'] }, { merge: true }));
  await denied('cannot replace the array wholesale',
    docOf(plainUser()).set({ roles: ['admin'] }, { merge: true }));
  await denied('cannot empty the array',
    docOf(plainUser()).set({ roles: [] }, { merge: true }));
  await denied('cannot reorder into a different set',
    docOf(plainUser()).update({ roles: ['seller', 'provider'] }));
  await denied('cannot delete the field',
    docOf(plainUser()).set({ roles: null }, { merge: true }));

  /* ══ 3 · activeRole must be SERVER-APPROVED ══ */
  head('3 · a client cannot select an activeRole it was not approved for');
  await reset();
  await denied('no claims → cannot select "seller"',
    docOf(plainUser()).set({ activeRole: 'seller' }, { merge: true }));
  await denied('no claims → cannot select "admin"',
    docOf(plainUser()).set({ activeRole: 'admin' }, { merge: true }));
  await denied('no claims → cannot select "rider"',
    docOf(plainUser()).set({ activeRole: 'rider' }, { merge: true }));
  /* THE DECISIVE CASE: the user DOCUMENT says they are a seller, but the TOKEN does
     not. The document is client-writable in principle, the token is not — so the
     document must not be what authorizes the switch. */
  await denied('a roles[] entry in the DOCUMENT does not authorize the switch — only the claim does',
    docOf(plainUser()).set({ activeRole: 'seller' }, { merge: true }));
  await denied('a forged claim-shaped FIELD does not authorize it either',
    docOf(plainUser()).set({ seller: true, activeRole: 'seller' }, { merge: true }));

  /* ══ 4 · an APPROVED role can be selected ══ */
  head('4 · an approved role IS selectable (the feature still works)');
  await reset();
  await allowed('an approved seller (claim present) may switch to "seller"',
    docOf(approvedSeller()).set({ activeRole: 'seller' }, { merge: true }));
  await reset();
  await allowed('anyone may return to "buyer" — the baseline every account holds',
    docOf(plainUser()).set({ activeRole: 'buyer' }, { merge: true }));
  await reset();
  await allowed('an approved rider may switch to "rider"',
    env.authenticatedContext(UID, { rider: true }).firestore()
      .collection('users').doc(UID).set({ activeRole: 'rider' }, { merge: true }));

  /* ══ 5 · server and admin provisioning still works ══ */
  head('5 · server and admin provisioning is unaffected');
  await reset();
  await allowed('the Admin SDK (rules bypassed) grants a role — grantAccountRole',
    env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('users').doc(UID)
        .set({ roles: ['buyer', 'seller', 'provider'], activeRole: 'provider' }, { merge: true });
    }));
  /* An UPDATE — `allow create` has never carried an isAdmin() branch, so an admin
     creating someone else's document from a client was always denied and still is. */
  await reset();
  await seed(OTHER, { uid: OTHER, name: 'Beta', roles: ['buyer'], accountStatus: 'active' });
  await allowed('an admin may set another account\'s roles',
    adminUser().firestore().collection('users').doc(OTHER)
      .set({ roles: ['buyer', 'seller'] }, { merge: true }));
  await reset();
  await allowed('an admin may set activeRole without holding that role\'s claim',
    adminUser().firestore().collection('users').doc(UID)
      .set({ activeRole: 'provider' }, { merge: true }));

  /* ══ 6 · legitimate everyday writes are NOT collateral damage ══ */
  head('6 · ordinary profile writes still work');
  await reset();
  await allowed('a user may edit their own name',
    docOf(plainUser()).set({ name: 'Alpha Updated' }, { merge: true }));
  await allowed('a user may write fcmToken / lastSeen',
    docOf(plainUser()).set({ fcmToken: 'tok-123', lastSeen: new Date().toISOString() }, { merge: true }));
  await allowed('a user may save their phone (the surviving half of Settings)',
    docOf(plainUser()).set({ phone: '+254700000000' }, { merge: true }));
  /* THE PROPERTY THAT KEEPS APPROVED RIDERS WORKING: arrayUnion of a role the user
     ALREADY holds produces an identical array, so it is absent from affectedKeys()
     and passes. Only a user who does NOT hold the role is denied. */
  await allowed('a no-op write of the SAME roles array is not a change',
    docOf(plainUser()).set({ roles: ['buyer'], name: 'Alpha' }, { merge: true }));
  await allowed('the driver shift mirror still lands once `roles` is not sent',
    docOf(plainUser()).set({
      isDriver: true, isRider: true,
      driverProfile: { shiftStatus: 'online' },
    }, { merge: true }));

  /* ══ 7 · account creation — every signup must keep working ══ */
  head('7 · signup baselines still create');
  await env.clearFirestore();
  await allowed('firebase.js / sokoni-user-bootstrap.js baseline ["buyer"]',
    env.authenticatedContext('newbie1', {}).firestore().collection('users').doc('newbie1')
      .set({ uid: 'newbie1', name: 'N', roles: ['buyer'], accountStatus: 'active' }));
  await allowed('auth.js baseline ["user"]',
    env.authenticatedContext('newbie2', {}).firestore().collection('users').doc('newbie2')
      .set({ uid: 'newbie2', name: 'N', roles: ['user'], accountStatus: 'active' }));
  await allowed('a create with no roles field at all',
    env.authenticatedContext('newbie3', {}).firestore().collection('users').doc('newbie3')
      .set({ uid: 'newbie3', name: 'N', accountStatus: 'active' }));
  /* Creation is where a self-grant would otherwise be free — the document does not
     exist yet, so there is no previous value to diff against. */
  await denied('a NEW account cannot create itself with "seller"',
    env.authenticatedContext('newbie4', {}).firestore().collection('users').doc('newbie4')
      .set({ uid: 'newbie4', name: 'N', roles: ['buyer', 'seller'] }));
  await denied('a NEW account cannot create itself with "admin"',
    env.authenticatedContext('newbie5', {}).firestore().collection('users').doc('newbie5')
      .set({ uid: 'newbie5', name: 'N', roles: ['admin'] }));
  await denied('a NEW account cannot create itself with an unapproved activeRole',
    env.authenticatedContext('newbie6', {}).firestore().collection('users').doc('newbie6')
      .set({ uid: 'newbie6', name: 'N', roles: ['buyer'], activeRole: 'seller' }));

  /* ══ 8 · cross-account isolation is unchanged ══ */
  head('8 · one account still cannot touch another');
  await reset();
  await seed(OTHER, { uid: OTHER, name: 'Beta', roles: ['buyer'], accountStatus: 'active' });
  await denied('a user cannot write another user\'s document',
    docOf(plainUser(), OTHER).set({ name: 'hacked' }, { merge: true }));
  await denied('...nor grant another user a role',
    docOf(plainUser(), OTHER).set({ roles: ['buyer', 'admin'] }, { merge: true }));
  await denied('...nor read it',
    docOf(plainUser(), OTHER).get());

  /* ══ 9 · the pre-existing guards were not weakened ══ */
  head('9 · existing privilege guards still hold');
  await reset();
  await denied('the `role` STRING is still blocked (pre-existing noSelfGrant)',
    docOf(plainUser()).set({ role: 'admin' }, { merge: true }));
  await denied('isAdmin is still blocked',
    docOf(plainUser()).set({ isAdmin: true }, { merge: true }));
  await denied('permissions is still blocked',
    docOf(plainUser()).set({ permissions: ['all'] }, { merge: true }));
  await denied('registeredAs.admin is still blocked',
    docOf(plainUser()).set({ registeredAs: { admin: true } }, { merge: true }));
  await denied('ageVerified is still blocked',
    docOf(plainUser()).set({ ageVerified: true }, { merge: true }));
  await denied('uid still cannot be reassigned',
    docOf(plainUser()).set({ uid: OTHER }, { merge: true }));

  await env.cleanup();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed   (rules: ' + RULES_FILE + ')');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
