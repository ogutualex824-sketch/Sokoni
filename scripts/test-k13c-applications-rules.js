/* test-k13c-applications-rules.js — K13-C: an applicant never writes a decision on `applications`.
 *
 * Emulator-backed (Firestore emulator on a PRIVATE port via scripts/run-rules-suite.js); the ruleset under test is
 * process.env.RULES_FILE. No production.
 *
 *   node <creator>/scripts/run-rules-suite.js <this file> <k13c>/firestore.rules.build   # the candidate — must PASS
 *   node <creator>/scripts/run-rules-suite.js <this file> <served-6c67a34d.rules>          # COUNTERPROOF: the SERVED
 *                                                                                         ruleset — failures ARE K13-C
 * PROVES (the owner's K13-C acceptance boundary)
 *   R1/R9/R10 an applicant creates a pending application, edits it while pending, and withdraws it (positive controls)
 *   R2/R3     an applicant cannot CREATE with a decisive status or with decision metadata
 *   R4/R5     an applicant cannot UPDATE their pending application to a decisive status or write decision metadata
 *   R6/R7/R8  a DECIDED application cannot be edited, reopened (→ 'pending') or deleted by its applicant
 *   R11       the AdminOS path still decides (an admin-claim client write; the Admin SDK bypasses rules entirely)
 *   R12       K13b step 1: applicant writes status:'approved' on their own pending application → DENIED
 *             (step 2 — reconcile {all:true} projecting it — is refused independently by K13-A B1)
 *   R13       another user cannot read or edit someone's application (unchanged)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require(require.resolve('@firebase/rules-unit-testing', { paths: [process.cwd(), path.resolve(__dirname, '..')] }));

/* K13C_RULES (absolute) wins; the runner's RULES_FILE is relative to ITS repo root, not to the emulator's cwd. */
const RULES = process.env.K13C_RULES || process.env.RULES_FILE;
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!RULES || !HOST) { console.log('CRASH needs RULES_FILE and FIRESTORE_EMULATOR_HOST (run via run-rules-suite.js)'); process.exit(2); }
const [host, port] = HOST.split(':');

let pass = 0, fail = 0;
const ck = async (label, p, expectAllowed) => {
  let ok;
  try { await (expectAllowed ? assertSucceeds(p) : assertFails(p)); ok = true; } catch (e) { ok = false; }
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label); ok ? pass++ : fail++;
};

(async () => {
  const rulesText = fs.readFileSync(path.resolve(RULES), 'utf8');
  console.log('\nRULES: ' + path.basename(RULES) + ' (' + Buffer.byteLength(rulesText) + ' B)');
  const env = await initializeTestEnvironment({ projectId: 'demo-k13c', firestore: { rules: rulesText, host, port: Number(port) } });
  const seed = async (id, d) => env.withSecurityRulesDisabled(async (c) => { await c.firestore().doc('applications/' + id).set(d); });
  const u1 = env.authenticatedContext('u1', { deactivated: false }).firestore();
  const u2 = env.authenticatedContext('u2', { deactivated: false }).firestore();
  const adm = env.authenticatedContext('adm', { admin: true, deactivated: false }).firestore();
  const base = { uid: 'u1', type: 'provider', name: 'Applicant', phone: '0712000000' };

  console.log('\nA. create');
  await ck('R1  applicant creates a PENDING application (positive)', u1.doc('applications/r1').set(Object.assign({}, base, { status: 'pending' })), true);
  await ck('R2  applicant cannot create with status:"approved"', u1.doc('applications/r2').set(Object.assign({}, base, { status: 'approved' })), false);
  await ck('R3  applicant cannot create with decision metadata (decidedBy)', u1.doc('applications/r3').set(Object.assign({}, base, { status: 'pending', decidedBy: 'adm' })), false);

  console.log('\nB. update while pending');
  await seed('p1', Object.assign({}, base, { status: 'pending' }));
  await ck('R4  applicant cannot move a pending application to "approved"', u1.doc('applications/p1').update({ status: 'approved' }), false);
  await ck('R12 K13b step 1 — applicant writes status "APPROVED" (any case) → DENIED', u1.doc('applications/p1').update({ status: 'APPROVED' }), false);
  await ck('R5  applicant cannot write decision metadata on a pending application', u1.doc('applications/p1').update({ decidedBy: 'adm', statusCanonical: 'approved' }), false);
  await ck('R9  applicant edits their pending application (positive)', u1.doc('applications/p1').update({ phone: '0712999999' }), true);

  console.log('\nC. a decided application is frozen to its applicant');
  await seed('d1', Object.assign({}, base, { status: 'rejected', decidedBy: 'adm', reviewReason: 'incomplete' }));
  await ck('R6  applicant cannot EDIT a decided application', u1.doc('applications/d1').update({ phone: '0700000000' }), false);
  await ck('R7  applicant cannot REOPEN a decided application (→ pending)', u1.doc('applications/d1').update({ status: 'pending' }), false);
  await ck('R8  applicant cannot DELETE a decided application', u1.doc('applications/d1').delete(), false);
  await seed('p2', Object.assign({}, base, { status: 'pending' }));
  await ck('R10 applicant withdraws (deletes) a PENDING application (positive)', u1.doc('applications/p2').delete(), true);

  console.log('\nD. the AdminOS path and other users');
  await seed('p3', Object.assign({}, base, { status: 'pending' }));
  await ck('R11 an admin still decides (admin-claim write)', adm.doc('applications/p3').update({ status: 'approved', decidedBy: 'adm' }), true);
  await ck('R13 another user cannot read someone\'s application', u2.doc('applications/p3').get(), false);
  await ck('R13 another user cannot edit someone\'s application', u2.doc('applications/p1').update({ phone: '1' }), false);

  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
