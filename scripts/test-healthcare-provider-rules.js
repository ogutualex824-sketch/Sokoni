/* HC-01 — healthProviders authorization, emulator-backed against the real rules file.

   Run:  firebase emulators:exec --only firestore "node scripts/test-healthcare-provider-rules.js"
   Against a different ruleset:  RULES_FILE=<path relative to repo root> ... (used by the
   counter-proof run, which points this same suite at the PRE-FIX rules and expects it to fail)

   WHY THIS EXISTS
   ---------------
   `firestore.rules` carried TWO `match /healthProviders/{providerId}` blocks, both directly
   under `match /databases/{database}/documents`. Firestore UNIONS duplicate match blocks, so
   the first block's

       allow write: if false;   // CF-only

   was VOID. The second block allowed

       allow create: if isAuthed() && request.resource.data.uid == request.auth.uid && noAdminFields();

   and `noAdminFields()` protects thirteen keys of which only `verified` is one that matters
   here — NOT `status`, NOT `licenseNumber`, NOT `specialization`, NOT `rating`. So any signed-in
   user could write `healthProviders/{their-own-uid}` carrying `status:'active'` and a
   self-asserted licence number, and the owner-update clause let a rejected applicant put
   themselves back to `active`.

   That mattered because `createHealthRecord` and `createPrescription`
   (functions/healthcare-hub.js) authorize on `healthProviders/{uid}.status === 'active'` and
   NOTHING else — no appointment, no consent, no relationship. The mint therefore reached
   clinical writes against an arbitrary `patientUid`.

   ADR-014 retires healthProviders as a provider identity (canonical identity is
   `providers/{uid}`) and makes every write server-side. The Cloud Functions use the Admin SDK,
   which bypasses rules entirely, so denying clients here costs no callable anything.

   WHAT THIS SUITE ASSERTS
     A. no client — anonymous, ordinary, owner, or admin — may create, update or delete
     B. the specific HC-01 vectors: mint-as-active, self-promote, un-reject, forge rating/licence
     C. the LEGITIMATE read paths still work (a guard that refuses everybody is not a fix):
        public directory, the search guard's query shape, and an applicant reading their OWN
        pending profile — the clause deliberately carried over from the removed block
     D. SCOPE: the neighbouring healthcare collections are untouched by this change
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

const DOC = (uid, status, extra) => Object.assign({
  providerId: uid, uid, name: 'Dr Test', specialization: 'general_practice',
  licenseNumber: 'KMPDC-000000', status, rating: 0, ratingCount: 0, isAvailable: true,
}, extra || {});

(async () => {
  const rulesFile = process.env.RULES_FILE || 'firestore.rules';
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-hc01-rules-test',
    firestore: {
      /* resolve, not join — RULES_FILE may be an absolute path (the counter-proof run
         points this suite at a reconstructed PRE-FIX ruleset outside the repo). */
      rules: fs.readFileSync(path.resolve(__dirname, '..', rulesFile), 'utf8'),
      /* 8080 matches every other rules suite here. Overridable because this repo is worked
         by parallel agents: when another emulator already holds 8080, this suite must run
         beside it on its own port, never clearFirestore() against someone else's data. */
      host: '127.0.0.1', port: Number(process.env.FIRESTORE_EMULATOR_PORT || 8080),
    },
  });
  console.log('\nRULES UNDER TEST: ' + rulesFile + '\n' + '='.repeat(64));
  await env.clearFirestore();

  const { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs } =
    require('firebase/firestore');

  const anon  = env.unauthenticatedContext().firestore();
  const alice = env.authenticatedContext('alice').firestore();
  const mallory = env.authenticatedContext('mallory').firestore();
  const admin = env.authenticatedContext('root', { admin: true }).firestore();

  /* Seed through the Admin path — this is what the Cloud Functions do, and it is the ONLY
     way a provider document may come into existence after this change. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'healthProviders', 'alice'),  DOC('alice', 'pending'));
    await setDoc(doc(d, 'healthProviders', 'active1'), DOC('active1', 'active', { name: 'Dr Live' }));
    await setDoc(doc(d, 'healthProviders', 'rejected1'), DOC('rejected1', 'rejected'));
    await setDoc(doc(d, 'healthAppointments', 'appt1'),
      { appointmentId: 'appt1', patientUid: 'alice', providerId: 'active1', status: 'pending' });
    await setDoc(doc(d, 'healthRecords', 'rec1'),
      { recordId: 'rec1', patientUid: 'alice', providerId: 'active1', diagnosis: 'x' });
    await setDoc(doc(d, 'healthPrescriptions', 'rx1'),
      { prescriptionId: 'rx1', patientUid: 'alice', providerId: 'active1' });
    await setDoc(doc(d, 'healthApptIdempotency', 'k1'), { appointmentId: 'appt1' });
  });

  /* ── A. THE HC-01 VECTOR — minting an active provider ───────────────────────── */
  console.log('\nA. HC-01 — can a client mint an ACTIVE healthcare provider?');
  await check('anonymous create DENIED',
    assertFails(setDoc(doc(anon, 'healthProviders', 'anon1'), DOC('anon1', 'active'))));
  await check('ordinary user creating healthProviders/{own uid} status:active DENIED  <- the vector',
    assertFails(setDoc(doc(mallory, 'healthProviders', 'mallory'), DOC('mallory', 'active'))));
  await check('...same but status:pending DENIED (no client create path at all)',
    assertFails(setDoc(doc(mallory, 'healthProviders', 'mallory'), DOC('mallory', 'pending'))));
  await check('...at an arbitrary doc id carrying uid:self DENIED',
    assertFails(setDoc(doc(mallory, 'healthProviders', 'HCP-9999'), DOC('mallory', 'active'))));
  await check('...with a forged licence + top rating DENIED',
    assertFails(setDoc(doc(mallory, 'healthProviders', 'mallory'),
      DOC('mallory', 'active', { licenseNumber: 'FORGED-1', rating: 5, ratingCount: 900 }))));

  /* ── B. STATUS PROMOTION on a document that already exists ──────────────────── */
  console.log('\nB. can an existing provider promote themselves, or undo a rejection?');
  await check('owner pending -> active DENIED  <- self-approval',
    assertFails(updateDoc(doc(alice, 'healthProviders', 'alice'), { status: 'active' })));
  await check('owner writes ONLY {status} (the sokoni-health.js updateProviderStatus shape) DENIED',
    assertFails(setDoc(doc(alice, 'healthProviders', 'alice'), { status: 'active' }, { merge: true })));
  const rejected = env.authenticatedContext('rejected1').firestore();
  await check('rejected user restoring themselves to active DENIED  <- reverses an admin decision',
    assertFails(updateDoc(doc(rejected, 'healthProviders', 'rejected1'), { status: 'active' })));
  await check('owner forging rating/ratingCount DENIED',
    assertFails(updateDoc(doc(alice, 'healthProviders', 'alice'), { rating: 5, ratingCount: 500 })));
  await check('owner rewriting licenseNumber DENIED',
    assertFails(updateDoc(doc(alice, 'healthProviders', 'alice'), { licenseNumber: 'FORGED-2' })));
  await check('stranger updating someone else DENIED',
    assertFails(updateDoc(doc(mallory, 'healthProviders', 'alice'), { status: 'active' })));
  await check('owner delete DENIED',
    assertFails(deleteDoc(doc(alice, 'healthProviders', 'alice'))));

  /* ── C. ADMIN via CLIENT — writes are server-only, admins act through callables ── */
  console.log('\nC. admin-claim CLIENT writes are denied too (approval is a callable, Admin SDK bypasses rules)');
  await check('admin client update DENIED',
    assertFails(updateDoc(doc(admin, 'healthProviders', 'alice'), { status: 'active' })));
  await check('admin client create DENIED',
    assertFails(setDoc(doc(admin, 'healthProviders', 'new1'), DOC('new1', 'active'))));
  await check('admin client delete DENIED',
    assertFails(deleteDoc(doc(admin, 'healthProviders', 'alice'))));

  /* ── D. THE LEGITIMATE PATHS MUST STILL WORK ────────────────────────────────── */
  /* RE-SEED FIRST. Against the FIXED rules nothing above mutates anything, so this is a
     no-op. Against a VULNERABLE ruleset the write cases above succeed — the admin-delete
     case removes alice's document outright — and every read below would then fail for a
     reason that has nothing to do with the read rule. Without this, the counter-proof run
     reports a failure it cannot attribute, which is exactly the "unidentified failure
     counted as a result" trap. Re-seeding makes each section independent. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'healthProviders', 'alice'),  DOC('alice', 'pending'));
    await setDoc(doc(d, 'healthProviders', 'active1'), DOC('active1', 'active', { name: 'Dr Live' }));
  });

  console.log('\nD. legitimate reads — a guard that refuses everybody is not a fix');
  await check('anonymous reads an ACTIVE provider (public directory)',
    assertSucceeds(getDoc(doc(anon, 'healthProviders', 'active1'))));
  await check("anonymous query where status=='active' (sokoni-firestore-search guard shape)",
    assertSucceeds(getDocs(query(collection(anon, 'healthProviders'), where('status', '==', 'active')))));
  await check('owner reads their OWN pending profile  <- clause carried over from the removed block',
    assertSucceeds(getDoc(doc(alice, 'healthProviders', 'alice'))));
  await check("owner query where uid==self (listenMyProviderProfile shape)",
    assertSucceeds(getDocs(query(collection(alice, 'healthProviders'), where('uid', '==', 'alice')))));
  await check('admin reads a PENDING provider (the review queue must see applicants)',
    assertSucceeds(getDoc(doc(admin, 'healthProviders', 'alice'))));
  await check('anonymous reading a PENDING provider DENIED (not public until active)',
    assertFails(getDoc(doc(anon, 'healthProviders', 'alice'))));
  await check('anonymous UNFILTERED collection query DENIED (no blanket directory dump)',
    assertFails(getDocs(query(collection(anon, 'healthProviders')))));

  /* ── E. SCOPE — nothing else in the healthcare track moved ──────────────────── */
  console.log('\nE. scope — the neighbouring healthcare rules are unchanged');
  await check('healthAppointments: participant reads',
    assertSucceeds(getDoc(doc(alice, 'healthAppointments', 'appt1'))));
  await check('healthAppointments: stranger DENIED',
    assertFails(getDoc(doc(mallory, 'healthAppointments', 'appt1'))));
  await check('healthAppointments: client write still DENIED',
    assertFails(updateDoc(doc(alice, 'healthAppointments', 'appt1'), { status: 'confirmed' })));
  await check('healthRecords: the patient reads their own',
    assertSucceeds(getDoc(doc(alice, 'healthRecords', 'rec1'))));
  await check('healthRecords: stranger DENIED',
    assertFails(getDoc(doc(mallory, 'healthRecords', 'rec1'))));
  await check('healthRecords: client write DENIED',
    assertFails(setDoc(doc(alice, 'healthRecords', 'rec2'), { patientUid: 'alice' })));
  await check('healthPrescriptions: the patient reads their own',
    assertSucceeds(getDoc(doc(alice, 'healthPrescriptions', 'rx1'))));
  await check('healthPrescriptions: stranger DENIED',
    assertFails(getDoc(doc(mallory, 'healthPrescriptions', 'rx1'))));
  await check('healthApptIdempotency: read DENIED',
    assertFails(getDoc(doc(alice, 'healthApptIdempotency', 'k1'))));
  await check('healthProviderAvailability: still has NO rule -> denied (ADR-014 keeps it dead)',
    assertFails(setDoc(doc(alice, 'healthProviderAvailability', 'alice'), { slots: [] })));
  /* CHANGELOG 221 — a patient request no longer NOMINATES its recipient (scripts/test-healthcare-request-rules.js). */
  await check('healthLabBookings: owner create STILL ALLOWED (no nominated recipient)',
    assertSucceeds(setDoc(doc(alice, 'healthLabBookings', 'lab1'),
      { uid: 'alice', service: 'FBC' })));
  await check('healthLabBookings: nominating a provider uid DENIED (CHANGELOG 221)',
    assertFails(setDoc(doc(alice, 'healthLabBookings', 'lab2'),
      { uid: 'alice', providerId: 'active1', service: 'FBC' })));

  await env.cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
