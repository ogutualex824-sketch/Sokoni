/* employmentInvites Firestore rules — emulator-backed. Gate 3 mechanism #3.
 *
 *   firebase emulators:exec --only firestore --project sokoni-employment-rules-test \
 *     "node scripts/test-employment-invites-rules.js"
 *
 * WHY THIS RUNS AGAINST THE REAL ENGINE
 * A rules expression error reads as a working guard: the block denies, the test
 * passes, and the guard is green for the wrong reason. Source matching cannot
 * tell the two apart.
 *
 * THE RULE THIS EXISTS TO PROVE
 * employmentInvites is FULLY CF-ONLY — reads included. `shopInvites` carries
 * `allow get: if true`, which is tolerable for a document holding an email and
 * a shop role; an employment invitation names a salary-bearing relationship and
 * carries the businessId, the staffId and the invited address.
 *
 * The token is a CALLABLE CAPABILITY, not a read key: the invitee never reads
 * this document. They present the token to acceptEmploymentInvite, which reads
 * it with the Admin SDK and checks their authenticated email against it.
 *
 * So EVERY client is denied EVERYTHING here — including the invitee holding a
 * valid token, the owner of the business, and a platform administrator. The
 * suite is written as denials because that is the whole contract; the
 * Admin-SDK path is asserted separately by the flow suite, which is what makes
 * "denied to everyone" a boundary rather than a broken collection.
 */
'use strict';
const { initializeTestEnvironment, assertFails } =
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

const ADMIN_U = 'u_admin', SUPER_U = 'u_super', OWNER_U = 'u_owner';
const INVITEE_U = 'u_invitee', STRANGER_U = 'u_stranger';
const BIZ = 'SOK-MINE', STAFF = 'SOK-MINE_E001';
const TOKEN = 'tok-1234-5678';
const EMAIL = 'jane@example.com';

(async () => {
  const rulesFile = process.env.RULES_FILE || 'firestore.rules';
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  employmentInvites RULES — mechanism #3   [' + rulesFile + ']');
  console.log('══════════════════════════════════════════════════════════════════');

  const env = await initializeTestEnvironment({
    projectId: 'sokoni-employment-rules-test',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', rulesFile), 'utf8') },
  });
  await env.clearFirestore();

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    /* Exactly as the Admin SDK writes it. */
    await db.doc('employmentInvites/' + TOKEN).set({
      token: TOKEN, businessId: BIZ, staffId: STAFF, email: EMAIL,
      status: 'pending', createdBy: OWNER_U,
      acceptedByUid: null, revokedByUid: null,
    });
    await db.doc('businesses/' + BIZ).set({ ownerId: OWNER_U, adminUids: [OWNER_U] });
  });

  /* The invitee's context carries the INVITED EMAIL, so if any rule arm ever
     matched on email this fixture would find it. */
  const asInvitee = env.authenticatedContext(INVITEE_U, { email: EMAIL, email_verified: true });
  const asOwner = env.authenticatedContext(OWNER_U, {});
  const asAdmin = env.authenticatedContext(ADMIN_U, { admin: true });
  const asSuper = env.authenticatedContext(SUPER_U, { admin: true, superAdmin: true });
  const asStranger = env.authenticatedContext(STRANGER_U, {});
  const asAnon = env.unauthenticatedContext();

  const doc = (ctx, id) => ctx.firestore().doc('employmentInvites/' + (id || TOKEN));
  const NEW = { token: 'forged', businessId: BIZ, staffId: STAFF, email: EMAIL, status: 'pending' };

  console.log('\n1 - READ is denied to everyone, holding a valid token included');
  await check('the INVITEE, with the invited email, cannot read it',
              assertFails(doc(asInvitee).get()));
  await check('the business owner cannot read it',        assertFails(doc(asOwner).get()));
  await check('a platform admin cannot read it',          assertFails(doc(asAdmin).get()));
  await check('a superAdmin cannot read it',              assertFails(doc(asSuper).get()));
  await check('a stranger cannot read it',                assertFails(doc(asStranger).get()));
  await check('an anonymous client cannot read it',       assertFails(doc(asAnon).get()));
  await check('and it cannot be reached by LISTING the collection',
              assertFails(asInvitee.firestore().collection('employmentInvites').get()));

  console.log('\n2 - CREATE is denied to everyone');
  await check('the owner cannot forge an invitation',   assertFails(doc(asOwner, 'f1').set(NEW)));
  await check('a platform admin cannot create',         assertFails(doc(asAdmin, 'f2').set(NEW)));
  await check('a superAdmin cannot create',             assertFails(doc(asSuper, 'f3').set(NEW)));
  await check('the invitee cannot create one for themselves',
                                                        assertFails(doc(asInvitee, 'f4').set(NEW)));
  await check('an anonymous client cannot create',      assertFails(doc(asAnon, 'f5').set(NEW)));

  console.log('\n3 - UPDATE is denied — nobody self-accepts by writing the document');
  await check('the INVITEE cannot mark it accepted',
              assertFails(doc(asInvitee).update({ status: 'accepted', acceptedByUid: INVITEE_U })));
  await check('the owner cannot mark it accepted',
              assertFails(doc(asOwner).update({ status: 'accepted' })));
  await check('the owner cannot revoke it by writing',
              assertFails(doc(asOwner).update({ status: 'revoked' })));
  await check('a platform admin cannot rewrite the invited email',
              assertFails(doc(asAdmin).update({ email: 'attacker@example.com' })));
  await check('a superAdmin cannot rewrite it',         assertFails(doc(asSuper).update({ status: 'accepted' })));

  console.log('\n4 - DELETE is denied to everyone, including superAdmin');
  await check('the owner cannot delete',                assertFails(doc(asOwner).delete()));
  await check('a platform admin cannot delete',         assertFails(doc(asAdmin).delete()));
  await check('a superAdmin cannot delete',             assertFails(doc(asSuper).delete()));
  await check('the invitee cannot delete',              assertFails(doc(asInvitee).delete()));

  console.log('\n5 - CONTROL — the fixture is real and the engine is reachable');
  {
    /* Without this, "everything is denied" could equally mean the document was
       never seeded or the emulator ignored the ruleset. A collection the same
       client CAN read proves both. */
    let seeded = false, readable = false;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s = await ctx.firestore().doc('employmentInvites/' + TOKEN).get();
      seeded = s.exists && s.data().email === EMAIL;
    });
    ck('the invitation document really exists with the invited email', seeded);
    try { await asOwner.firestore().doc('businesses/' + BIZ).get(); readable = true; } catch (_) {}
    ck('the SAME client can read a world-readable collection (businesses)', readable);
  }

  await env.cleanup();

  console.log('\n  what this suite does NOT prove');
  console.log('  SEPARATE  the Admin-SDK path. send / accept / revoke are certified in');
  console.log('            scripts/test-employment-invites.js — which is what makes');
  console.log('            "denied to every client" a BOUNDARY and not a dead collection.');
  console.log('  NOTE      the seeded document was written with security rules DISABLED,');
  console.log('            which is how employment-invites.js writes it in production.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
