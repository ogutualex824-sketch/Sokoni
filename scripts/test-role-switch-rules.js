/* Same-account role switching — RULES-LAYER proof. Emulator only.

   Run:  firebase emulators:exec --only firestore --project sokoni-role-switch-test \
           "node scripts/test-role-switch-rules.js"

   WHAT THIS PROVES, AND WHAT IT DOES NOT
   The intended model is ONE authenticated account whose activeRole selects a SURFACE and
   never manufactures authority:

       Buyer · Driver · Seller/Merchant · Admin · Super Admin

   `users/{uid}.activeRole` is the field the switcher writes, and firestore.rules
   `activeRoleApproved()` is what decides whether the write lands:

       || next.activeRole == 'buyer'
       || request.auth.token.get(next.activeRole, false) == true

   So the CLAIM decides, and 'buyer' is always permitted as the base role. This file pins
   that boundary.

   It proves the RULES layer only. It does NOT prove which surface a page renders, which
   controls it shows, or that a backend callable refuses a switched-but-unentitled caller.
   Those need real personas and stay UNPROVEN until Step 1 clears. A page that renders an
   admin console for a buyer would still be a defect this file cannot see.

   ── ON THE CLAIMS USED HERE ────────────────────────────────────────────────
   The emulator mints the claims. That is the FIXTURE, not a bypass: the rule under test is
   "the claim decides", so a test of it must be able to set claims. Nothing here touches
   production auth, and no result licenses any statement about a real account.

   ── CONTROLS ───────────────────────────────────────────────────────────────
   * A permitted switch must SUCCEED, or "everything denied" would score as a pass.
   * A denied switch must leave the stored activeRole BYTE-IDENTICAL.
   * Cross-user and unauthenticated writes must fail, proving ownership is enforced
     independently of the role logic.
*/
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};

const OWNER = 'switch-uid-1';
const OTHER = 'switch-uid-2';

/* claim sets — emulator fixtures, never production */
const CLAIMS = {
  buyer:      {},
  driver:     { driver: true },
  seller:     { seller: true },
  admin:      { admin: true },
  superAdmin: { superAdmin: true, admin: true },
  adminDriver:{ admin: true, driver: true },
};

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-role-switch-test',
    /* RULES_FILE lets this prove a CANDIDATE built on the served ruleset, which is the only
       thing a rules release may promote — the repo's firestore.rules would also carry another
       team's 39 unreleased lines (verify-rules-release-parity). */
    firestore: { rules: fs.readFileSync(process.env.RULES_FILE ||
                                        path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
  });

  const seed = async (activeRole) => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('users').doc(OWNER)
        .set({ name: 'Switcher', roles: ['buyer'], activeRole: activeRole });
      await ctx.firestore().collection('users').doc(OTHER)
        .set({ name: 'Other', roles: ['buyer'], activeRole: 'buyer' });
    });
  };

  const storedRole = async () => {
    let v;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s = await ctx.firestore().collection('users').doc(OWNER).get();
      v = (s.data() || {}).activeRole;
    });
    return v;
  };

  /* Attempt a switch and report outcome + whether the stored value moved. */
  async function attempt(claimName, target) {
    await seed('buyer');
    const before = await storedRole();
    const db = env.authenticatedContext(OWNER, CLAIMS[claimName]).firestore();
    let allowed = true, err = '';
    try {
      await db.collection('users').doc(OWNER).set({ activeRole: target }, { merge: true });
    } catch (e) { allowed = false; err = String(e.message || e); }
    const after = await storedRole();
    return { allowed, err, before, after, unchanged: before === after };
  }

  async function row(claimName, target, expectAllow) {
    const r = await attempt(claimName, target);
    const ok = r.allowed === expectAllow;
    const label = (claimName + ' -> ' + target).padEnd(30) +
                  (expectAllow ? 'expect ALLOW ' : 'expect DENY  ') +
                  'got ' + (r.allowed ? 'ALLOW' : 'DENY');
    ck(label, ok, ok ? '' : r.err);
    /* Integrity: a denied switch must not have moved the stored value. */
    if (!expectAllow) {
      ck('   └─ stored activeRole byte-identical after denial', r.unchanged,
         r.unchanged ? '' : r.before + ' -> ' + r.after);
    } else {
      ck('   └─ stored activeRole actually became ' + target, r.after === target,
         r.after === target ? '' : 'stored=' + r.after);
    }
  }

  console.log('\n  Same-account role switching — rules layer (emulator only)\n');
  console.log('  ── the matrix');

  await row('buyer', 'buyer', true);
  await row('buyer', 'driver', false);
  await row('buyer', 'admin', false);
  await row('buyer', 'superAdmin', false);

  await row('driver', 'driver', true);
  await row('driver', 'buyer', true);
  await row('driver', 'admin', false);
  await row('driver', 'superAdmin', false);

  await row('seller', 'seller', true);
  await row('seller', 'admin', false);

  await row('admin', 'admin', true);
  await row('admin', 'buyer', true);
  await row('admin', 'driver', false);
  await row('admin', 'superAdmin', false);

  await row('superAdmin', 'superAdmin', true);
  await row('superAdmin', 'admin', true);
  await row('superAdmin', 'buyer', true);

  await row('adminDriver', 'driver', true);
  await row('adminDriver', 'admin', true);

  console.log('\n  ── ownership controls (independent of role logic)');
  await seed('buyer');
  const asOwner = env.authenticatedContext(OTHER, CLAIMS.admin).firestore();
  try {
    await assertFails(asOwner.collection('users').doc(OWNER).set({ activeRole: 'admin' }, { merge: true }));
    ck('an admin cannot set ANOTHER user\'s activeRole', true);
  } catch (e) { ck('an admin cannot set ANOTHER user\'s activeRole', false, e.message); }
  ck('   └─ victim activeRole byte-identical', (await storedRole()) === 'buyer');

  const anon = env.unauthenticatedContext().firestore();
  try {
    await assertFails(anon.collection('users').doc(OWNER).set({ activeRole: 'admin' }, { merge: true }));
    ck('unauthenticated cannot set activeRole', true);
  } catch (e) { ck('unauthenticated cannot set activeRole', false, e.message); }

  /* ── the admin branch is SCOPED, not removed ──────────────────────────────
     Added after the before-proof. The admin console legitimately writes other users'
     records (measured: registeredAs.legal / registeredAs.healthcare / approved in
     admin.html), so the fix must keep that working while refusing privilege-bearing
     fields. A rule that blocked everything would pass the DENY rows and break the
     product, so the ALLOW row here is the control that keeps the fix honest. */
  console.log('\n  ── admin user-management: scoped, not removed');
  async function adminWrites(label, payload, expectAllow) {
    await seed('buyer');
    const db = env.authenticatedContext('admin-uid-9', CLAIMS.admin).firestore();
    let allowed = true, err = '';
    try { await db.collection('users').doc(OWNER).set(payload, { merge: true }); }
    catch (e) { allowed = false; err = String(e.message || e); }
    ck(label.padEnd(52) + (expectAllow ? 'expect ALLOW ' : 'expect DENY  ') +
       'got ' + (allowed ? 'ALLOW' : 'DENY'), allowed === expectAllow, allowed === expectAllow ? '' : err);
    return allowed;
  }

  await adminWrites('admin edits another user\'s ordinary field', { name: 'Renamed By Admin' }, true);
  await adminWrites('admin performs the real console write', { registeredAs: { legal: true }, approved: true }, true);
  await adminWrites('admin sets another user\'s role', { role: 'admin' }, false);
  await adminWrites('admin sets another user\'s permissions', { permissions: ['all'] }, false);
  await adminWrites('admin sets another user\'s kycStatus', { kycStatus: 'verified' }, false);
  await adminWrites('admin rewrites another user\'s roles array', { roles: ['admin'] }, false);
  await adminWrites('admin sets another user\'s registeredAs.admin', { registeredAs: { admin: true } }, false);

  console.log('\n  ── control: the harness can observe a real ALLOW');
  await seed('buyer');
  const sa = env.authenticatedContext(OWNER, CLAIMS.superAdmin).firestore();
  try {
    await assertSucceeds(sa.collection('users').doc(OWNER).set({ activeRole: 'superAdmin' }, { merge: true }));
    ck('superAdmin CAN set activeRole=superAdmin (not vacuously denying)', (await storedRole()) === 'superAdmin');
  } catch (e) { ck('superAdmin CAN set activeRole=superAdmin (not vacuously denying)', false, e.message); }

  await env.cleanup();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  console.log('  Rules layer only. Surface rendering and callable authorization for a switched');
  console.log('  principal remain UNPROVEN pending real personas.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
