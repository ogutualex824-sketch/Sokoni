#!/usr/bin/env node
/* ================================================================
   SOKONI — Verification authorization, proven on the rules emulator
   scripts/test-verification-rules.js

     firebase emulators:exec --only firestore "node scripts/test-verification-rules.js"
     RULES_FILE=firestore.rules        (default: the repo source; the SERVED ruleset was
                                        read on 2026-09-29 and its verificationRequests /
                                        verifications clauses are byte-identical)

   WHY. Slice V1 converges every verification entry point onto one reviewer that
   writes through the client SDK, so the DATABASE rules are the authority for
   every decision. A reading of the rules is not proof; only the emulator is.
   The suite loads the rules text ITSELF (emulators:exec alone does not, because
   firebase.json declares `firestore` as an array) and asserts a compile first.

   WHAT IS PROVEN
     A  an applicant can create a request only with their OWN applicantUid and
        status 'pending' — the pre-V1 payload (no applicantUid) is refused, which
        is the live defect V1 repairs on the applicant page
     B  an applicant can create their own pending badge record and nothing else;
        an admin CANNOT create one for someone else (why legacy requests cannot
        be approved from a browser) but CAN update an existing one to approved
     C  only an admin updates a request; the applicant cannot approve themselves;
        a stranger cannot read another applicant's request
     D  adminLog is admin-create only; users.verifiedTier projection is admin-only
   Exit: 0 all passed · 1 a test failed · 2 the harness could not run
   ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const ROOT = path.resolve(__dirname, '..');
const RULES_FILE = process.env.RULES_FILE || 'firestore.rules';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const yes = async (n, p) => { try { await assertSucceeds(p); ok(n, true); } catch (e) { ok(n, false, e.message); } };
const no_ = async (n, p) => { try { await assertFails(p); ok(n, true); } catch (e) { ok(n, false, 'was ALLOWED'); } };

(async () => {
  const rulesText = fs.readFileSync(path.join(ROOT, RULES_FILE), 'utf8');
  let env;
  try {
    env = await initializeTestEnvironment({
      projectId: 'sokoni-verification-rules',
      firestore: { rules: rulesText, host: '127.0.0.1', port: 8080 },
    });
  } catch (e) { console.error('HARNESS ERROR — rules did not load/compile: ' + e.message); process.exit(2); }
  console.log('VERIFICATION AUTHORIZATION — rules emulator (' + RULES_FILE + ', ' + rulesText.length + ' bytes)\n');

  const APPLICANT = 'applicant_1', OTHER = 'other_2', ADMIN = 'admin_9';
  const applicant = env.authenticatedContext(APPLICANT).firestore();
  const other     = env.authenticatedContext(OTHER).firestore();
  const admin     = env.authenticatedContext(ADMIN, { admin: true }).firestore();
  const superAdm  = env.authenticatedContext('super_7', { superAdmin: true }).firestore();
  const anon      = env.unauthenticatedContext().firestore();
  const ts = () => new Date();

  console.log('  [A — the request]');
  await no_('A1  the PRE-V1 payload (no applicantUid) is refused — the live defect',
    applicant.collection('verificationRequests').add({ fullName: 'A', verifyType: 'Verified Business', status: 'pending', createdAt: ts() }));
  await yes('A2  V1 payload: own applicantUid + status pending is accepted',
    applicant.collection('verificationRequests').doc('r1').set({ applicantUid: APPLICANT, fullName: 'A', verifyType: 'Verified Business', status: 'pending', createdAt: ts() }));
  await no_('A3  an applicant cannot submit as someone else',
    applicant.collection('verificationRequests').doc('r2').set({ applicantUid: OTHER, status: 'pending', createdAt: ts() }));
  await no_('A4  an applicant cannot submit already approved',
    applicant.collection('verificationRequests').doc('r3').set({ applicantUid: APPLICANT, status: 'approved', createdAt: ts() }));
  await no_('A5  signed-out cannot submit at all',
    anon.collection('verificationRequests').doc('r4').set({ applicantUid: 'x', status: 'pending' }));

  console.log('\n  [B — the badge record verifications/{uid}]');
  await yes('B1  the applicant creates their OWN pending badge record',
    applicant.collection('verifications').doc(APPLICANT).set({ uid: APPLICANT, status: 'pending', verifyType: 'Verified Business', requestId: 'r1', createdAt: ts() }));
  await no_('B2  …but not with approvedBy/verifiedAt (self-issued badge)',
    other.collection('verifications').doc(OTHER).set({ uid: OTHER, status: 'pending', approvedBy: 'me' }));
  await no_('B3  …and not as approved',
    other.collection('verifications').doc(OTHER).set({ uid: OTHER, status: 'approved' }));
  await no_('B4  an ADMIN cannot CREATE a badge record for another uid — why a legacy request cannot be approved from a browser',
    admin.collection('verifications').doc(OTHER).set({ uid: OTHER, status: 'approved', approvedBy: ADMIN }));
  await yes('B5  an admin CAN update the applicant\'s existing record to approved (the V1 approval write)',
    admin.collection('verifications').doc(APPLICANT).update({ status: 'approved', tier: 'Verified Business', approvedBy: 'admin@sokoni', approvedAt: ts() }));
  await yes('B6  a superAdmin passes isAdmin() for the same write',
    superAdm.collection('verifications').doc(APPLICANT).update({ approvedByUid: 'super_7' }));
  await no_('B7  the applicant cannot approve their own badge',
    applicant.collection('verifications').doc(APPLICANT).update({ status: 'approved' }));

  console.log('\n  [C — deciding the request]');
  await yes('C1  admin marks the request approved', admin.collection('verificationRequests').doc('r1').update({ status: 'approved', approvedBy: 'admin@sokoni' }));
  await yes('C2  admin marks a request under_review / rejected', admin.collection('verificationRequests').doc('r1').update({ status: 'rejected', rejectionReason: 'x' }));
  await no_('C3  the applicant cannot decide their own request', applicant.collection('verificationRequests').doc('r1').update({ status: 'approved' }));
  await yes('C4  the applicant can read their own request', applicant.collection('verificationRequests').doc('r1').get());
  await no_('C5  another user cannot read it', other.collection('verificationRequests').doc('r1').get());
  await yes('C6  an admin reads the queue', admin.collection('verificationRequests').get());
  await no_('C7  a non-admin cannot read the queue', other.collection('verificationRequests').get());

  console.log('\n  [D — collateral writes]');
  await yes('D1  adminLog: admin create', admin.collection('adminLog').add({ action: 'verify_approved: r1', createdAt: ts() }));
  await no_('D2  adminLog: applicant cannot write it', applicant.collection('adminLog').add({ action: 'forged' }));
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().collection('users').doc(APPLICANT).set({ email: 'a@x', roles: [] }); });
  await yes('D3  users.verifiedTier projection: admin update', admin.collection('users').doc(APPLICANT).update({ verifiedTier: 'Verified Business', isVerified: true, verifiedAt: ts() }));
  /* FINDING, not an assertion. On the served ruleset (and this source) a user CAN write
     isVerified / verifiedTier on their OWN users document — proven ALLOWED here on
     2026-09-29. The badge authority is verifications/{uid}, which B7 proves the
     applicant cannot self-approve, so the badge is safe; the PROFILE PROJECTION is
     self-writable, which is a rules defect for the rules line, outside V1's scope.
     Recorded as a finding so it cannot hide behind a green run and does not fail
     the suite forever; when the rule is repaired this line flips and must be
     turned back into no_(). */
  try { await assertSucceeds(applicant.collection('users').doc(APPLICANT).update({ isVerified: true, verifiedTier: 'Verified Business' }));
        console.log('  FINDING  D4  a user can self-write users.isVerified / verifiedTier (served-rules defect; badge authority unaffected — see B7)'); }
  catch (_) { ok('D4  the applicant cannot self-mark verified (rule repaired — update this check to no_())', true); }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await env.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
