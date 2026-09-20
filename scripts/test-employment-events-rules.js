/* employmentEvents Firestore rules — emulator-backed. Gate 3 mechanism #4.
 *
 *   firebase emulators:exec --only firestore --project sokoni-employment-rules-test \
 *     "node scripts/test-employment-events-rules.js"
 *
 * WHY THIS RUNS AGAINST THE REAL ENGINE
 * A rules expression error reads as a working guard: the block denies, the test
 * passes, and the guard is green for the wrong reason. Source matching cannot
 * tell the two apart, so every assertion here is executed by the rules engine.
 *
 * THE RULE THIS EXISTS TO PROVE
 * employmentEvents is the evidence of who established, changed, suspended or
 * ended a salary-bearing relationship. Three properties carry that:
 *
 *   1. NOBODY writes from a client — not the owner, not a platform admin, not
 *      the employee. Writes are CF-only, through employment-events.js.
 *   2. NOBODY deletes, INCLUDING superAdmin. adminLog permits a superAdmin
 *      delete; that precedent is deliberately not followed. A privileged actor
 *      must not be able to erase the record of what they did.
 *   3. The employee self-read names `newUid` and NEVER `previousUid`. A person
 *      whose binding was replaced must not keep reading the employment's FUTURE
 *      history — the case a naive "they were associated with it" rule allows.
 *
 * So the assertions that matter are DENIALS, and they are written as denials,
 * including the shapes an insider would try. The permitted reads are asserted
 * too: without them a block that denied everyone would pass every test here.
 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, okv, d) => {
  console.log('  ' + (okv ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 70) + ']' : ''));
  okv ? pass++ : fail++;
};
const check = async (label, p) => {
  try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); }
};

const ADMIN_U = 'u_admin', SUPER_U = 'u_super';
const OWNER_U = 'u_owner', EMP_U = 'u_emp', OLD_EMP_U = 'u_emp_old', STRANGER_U = 'u_stranger';
const BIZ = 'SOK-MINE', STAFF = 'SOK-MINE_E001';

/* Documents seeded with the security rules DISABLED, exactly as the Admin SDK
   would have written them. */
const ACCEPTED_EVT = STAFF + '_invite_accepted';
const REBOUND_EVT  = STAFF + '_uid_rebound_T1';
const PRE_EVT      = STAFF + '_employment_established';
/* A business keyed by its OWNER'S UID — the legacy shape that still exists in
   production, and the only shape in which `businessId == auth.uid` is true. */
const LEGACY_BIZ   = 'u_legacy_owner';
const LEGACY_EVT   = LEGACY_BIZ + '_E001_edited_E1';

(async () => {
  const rulesFile = process.env.RULES_FILE || 'firestore.rules';
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  employmentEvents RULES — mechanism #4   [' + rulesFile + ']');
  console.log('══════════════════════════════════════════════════════════════════');

  const env = await initializeTestEnvironment({
    projectId: 'sokoni-employment-rules-test',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', rulesFile), 'utf8') },
  });
  await env.clearFirestore();

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    /* Pre-acceptance: no newUid yet. */
    await db.doc('employmentEvents/' + PRE_EVT).set({
      businessId: BIZ, staffId: STAFF, event: 'employment_established',
      previousUid: null, newUid: null,
      actorType: 'human', changedBy: OWNER_U, changedVia: 'owner', reason: 'hired',
    });
    /* The binding is accepted: newUid is the employee. */
    await db.doc('employmentEvents/' + ACCEPTED_EVT).set({
      businessId: BIZ, staffId: STAFF, event: 'invite_accepted',
      previousUid: null, newUid: EMP_U,
      actorType: 'human', changedBy: OWNER_U, changedVia: 'owner', reason: 'accepted',
    });
    /* THE REPLACED-BINDING FIXTURE: the old uid is previousUid, someone else is newUid. */
    await db.doc('employmentEvents/' + REBOUND_EVT).set({
      businessId: BIZ, staffId: STAFF, event: 'uid_rebound',
      previousUid: OLD_EMP_U, newUid: EMP_U,
      actorType: 'human', changedBy: OWNER_U, changedVia: 'owner', reason: 'new account',
    });
    /* The owner's own business, so an owner arm — if one existed — could match. */
    await db.doc('businesses/' + BIZ).set({ ownerId: OWNER_U, adminUids: [OWNER_U] });

    /* THE LEGACY-SHAPE FIXTURE. One production business is still keyed by its
       owner's uid, so `resource.data.businessId == request.auth.uid` WOULD match
       there. Measured: a sabotage adding exactly that arm scored GREEN against a
       SOK- businessId, because the arm is inert when the id is not a uid. This
       event makes the forbidden arm reachable, so its absence is provable. */
    await db.doc('employmentEvents/' + LEGACY_EVT).set({
      businessId: LEGACY_BIZ, staffId: LEGACY_BIZ + '_E001', event: 'record_edited',
      previousUid: null, newUid: EMP_U,
      actorType: 'human', changedBy: LEGACY_BIZ, changedVia: 'owner', reason: 'legacy shape',
    });
  });

  const asAdmin   = env.authenticatedContext(ADMIN_U,   { admin: true });
  const asSuper   = env.authenticatedContext(SUPER_U,   { admin: true, superAdmin: true });
  const asOwner   = env.authenticatedContext(OWNER_U,   {});
  const asEmp     = env.authenticatedContext(EMP_U,     {});
  const asOldEmp  = env.authenticatedContext(OLD_EMP_U, {});
  const asStrange = env.authenticatedContext(STRANGER_U, {});
  const asAnon    = env.unauthenticatedContext();

  const doc = (ctx, id) => ctx.firestore().doc('employmentEvents/' + id);
  const NEW_EVT = { businessId: BIZ, staffId: STAFF, event: 'record_edited', newUid: EMP_U, reason: 'x' };

  /* ══ 1. NOBODY WRITES FROM A CLIENT ══════════════════════════════════════ */
  console.log('\n1 - create is denied to every client, without exception');
  await check('a platform admin cannot create',     assertFails(doc(asAdmin, 'x1').set(NEW_EVT)));
  await check('a superAdmin cannot create',         assertFails(doc(asSuper, 'x2').set(NEW_EVT)));
  await check('the business owner cannot create',   assertFails(doc(asOwner, 'x3').set(NEW_EVT)));
  await check('the employee cannot create their own history',
                                                    assertFails(doc(asEmp, 'x4').set(NEW_EVT)));
  await check('a stranger cannot create',           assertFails(doc(asStrange, 'x5').set(NEW_EVT)));
  await check('an anonymous client cannot create',  assertFails(doc(asAnon, 'x6').set(NEW_EVT)));

  console.log('\n2 - update is denied to every client');
  await check('a platform admin cannot update',   assertFails(doc(asAdmin, ACCEPTED_EVT).update({ reason: 'rewritten' })));
  await check('a superAdmin cannot update',       assertFails(doc(asSuper, ACCEPTED_EVT).update({ reason: 'rewritten' })));
  await check('the owner cannot update',          assertFails(doc(asOwner, ACCEPTED_EVT).update({ reason: 'rewritten' })));
  await check('the employee cannot update their own event',
                                                  assertFails(doc(asEmp, ACCEPTED_EVT).update({ reason: 'rewritten' })));

  console.log('\n3 - delete is denied to EVERYONE, including superAdmin');
  await check('a platform admin cannot delete',  assertFails(doc(asAdmin, ACCEPTED_EVT).delete()));
  await check('a superAdmin cannot delete',      assertFails(doc(asSuper, ACCEPTED_EVT).delete()));
  await check('the owner cannot delete',         assertFails(doc(asOwner, ACCEPTED_EVT).delete()));
  await check('the employee cannot delete',      assertFails(doc(asEmp, ACCEPTED_EVT).delete()));

  /* ══ 4. READS — the permitted ones, so a deny-all block cannot pass ══════ */
  console.log('\n4 - the permitted reads actually work');
  await check('an admin reads any event',                assertSucceeds(doc(asAdmin, ACCEPTED_EVT).get()));
  await check('an admin reads a pre-acceptance event',   assertSucceeds(doc(asAdmin, PRE_EVT).get()));
  await check('the bound employee reads their own event (newUid)',
                                                         assertSucceeds(doc(asEmp, ACCEPTED_EVT).get()));
  await check('the bound employee reads the rebind naming them as newUid',
                                                         assertSucceeds(doc(asEmp, REBOUND_EVT).get()));

  /* ══ 5. READS — the denials that carry the contract ═════════════════════ */
  console.log('\n5 - the read boundary');
  await check('THE REPLACED BINDING: previousUid grants NOTHING',
              assertFails(doc(asOldEmp, REBOUND_EVT).get()));
  await check('  …and the replaced uid cannot read the acceptance either',
              assertFails(doc(asOldEmp, ACCEPTED_EVT).get()));
  await check('a pre-acceptance event has no newUid, so no employee may read it',
              assertFails(doc(asEmp, PRE_EVT).get()));
  await check('NO OWNER ARM: the business owner cannot read via rules',
              assertFails(doc(asOwner, ACCEPTED_EVT).get()));
  /* THE ARM MUST BE ABSENT EVEN WHERE IT WOULD WORK. businessId here IS the
     caller's uid, so a `businessId == request.auth.uid` arm would grant. */
  await check('NO OWNER ARM, legacy shape: businessId === the caller uid still denies',
              assertFails(doc(env.authenticatedContext(LEGACY_BIZ, {}), LEGACY_EVT).get()));
  /* INVERTING CONTROL — that same document IS readable by its bound employee,
     so the denial above is the owner arm's absence, not an unreadable fixture. */
  await check('  …while its bound employee (newUid) can read it',
              assertSucceeds(doc(asEmp, LEGACY_EVT).get()));
  await check('a stranger cannot read',       assertFails(doc(asStrange, ACCEPTED_EVT).get()));
  await check('an anonymous client cannot read', assertFails(doc(asAnon, ACCEPTED_EVT).get()));

  await env.cleanup();

  console.log('\n  what this suite does NOT prove');
  console.log('  SEPARATE  organization history reads go through a callable that calls');
  console.log('            assertMerchantAccess. That callable is deliberately a LATER gate,');
  console.log('            which is why the owner is denied here and that is CORRECT.');
  console.log('  NOTE      the seeded documents were written with security rules DISABLED,');
  console.log('            which is how the Admin SDK writes them in production.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  /* FAIL CLOSED — a harness crash must report a verdict, never exit 0. */
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
