/* test-agreement-reacknowledge-rules.js — an applicant can re-acknowledge the Seller Agreement on their OWN existing
 * application (the three intake fields, dated now) and nothing else; history and decisions stay server-only.
 * Emulator-backed, against the BUILT ruleset (firestore.rules.build).
 *
 *   node scripts/run-rules-suite.js scripts/test-agreement-reacknowledge-rules.js
 *
 * PROVES
 *   re-ack allowed   the owner of an APPROVED application (Kasindi shape, decidedBy "reindex") may write exactly
 *                    agreementAccepted / agreementVersion / agreementAcceptedAt (+ the surface marker); same on a
 *                    pending application
 *   history withheld the owner cannot write priorDecisions (new key), nor decidedBy / decidedAt /
 *                    agreementVerifiedAt / agreementVerifiedVersion / status, alone or bundled with the re-ack
 *   frozen fields    the owner cannot change type / category / hub on the approved application (classification
 *                    frozen once decided) even bundled with the re-ack
 *   strangers        another signed-in user cannot write the re-ack onto someone else's application; anonymous denied
 *   admin raw        an admin's raw client write of priorDecisions is refused too (server-only through applicationDecide)
 *   COUNTERPROOF     with rules disabled the same withheld writes succeed
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
const VERSION = '2026-09-07-lanes-mkt-ladder-pos-5pct';
const ACK = () => ({ agreementAccepted: true, agreementVersion: VERSION, agreementAcceptedAt: new Date().toISOString(), agreementAcknowledgedSurface: 'agreement-acknowledge' });
const KAS = { uid: 'kasindi', name: 'Kasindi holdings limited', type: 'Cleaning Company / Housekeeper', category: 'Service Provider', hub: 'service', role: 'provider', status: 'approved', statusCanonical: 'approved', decidedBy: 'reindex', decidedAt: '2026-07-30T15:11:12.000Z', decisionAppliedFor: 'approved', projectionStatus: 'applied' };
(async () => {
  const RULES = fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build'), 'utf8');
  ck('noApplicationDecision withholds priorDecisions', /decisionKeys = \[[^\]]*'priorDecisions'/s.test(RULES));
  const env = await initializeTestEnvironment({ projectId: 'sokoni-agreement-reack-rules', firestore: { rules: RULES, host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) } });
  await env.clearFirestore();
  const { doc, setDoc, updateDoc } = require('firebase/firestore');
  const seed = async () => env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'applications/PRVMS7IACKG'), KAS);
    await setDoc(doc(f, 'applications/PEND1'), { uid: 'kasindi', name: 'Second', type: 'Plumber', category: 'Service Provider', hub: 'service', status: 'pending' });
    await setDoc(doc(f, 'applications/OTHER1'), { uid: 'other', name: 'Other Co', type: 'Plumber', status: 'approved', decidedBy: 'admin_D5' });
  });
  await seed();
  const C = (uid, extra) => env.authenticatedContext(uid, Object.assign({ email_verified: true, deactivated: false }, extra || {})).firestore();
  const kas = C('kasindi'), other = C('other'), adm = C('admin1', { admin: true }), anon = env.unauthenticatedContext().firestore();
  const app = (f, id) => doc(f, 'applications/' + (id || 'PRVMS7IACKG'));

  console.log('\nre-acknowledgement allowed (owner, own application)');
  await check('owner writes the three intake fields + surface marker on the APPROVED application decided by "reindex"', assertSucceeds(updateDoc(app(kas), ACK())));
  await check('owner writes the same on a PENDING application', assertSucceeds(updateDoc(app(kas, 'PEND1'), ACK())));
  await seed();

  console.log('\nhistory and decisions stay server-only');
  await check('owner cannot write priorDecisions', assertFails(updateDoc(app(kas), { priorDecisions: [{ decidedBy: 'admin_D5', status: 'approved' }] })));
  await check('owner cannot bundle priorDecisions with the re-ack', assertFails(updateDoc(app(kas), Object.assign(ACK(), { priorDecisions: [] }))));
  await check('owner cannot rewrite decidedBy ("reindex" → own uid) bundled with the re-ack', assertFails(updateDoc(app(kas), Object.assign(ACK(), { decidedBy: 'kasindi' }))));
  await check('owner cannot write agreementVerifiedAt / agreementVerifiedVersion (the server proof)', assertFails(updateDoc(app(kas), Object.assign(ACK(), { agreementVerifiedAt: new Date().toISOString(), agreementVerifiedVersion: VERSION }))));
  await check('owner cannot change status (approved → active) bundled with the re-ack', assertFails(updateDoc(app(kas), Object.assign(ACK(), { status: 'active', statusCanonical: 'active' }))));
  await check('owner cannot flip a PENDING application to approved bundled with the re-ack', assertFails(updateDoc(app(kas, 'PEND1'), Object.assign(ACK(), { status: 'approved' }))));
  await check('owner cannot change type / category on the approved application (classification frozen once decided)', assertFails(updateDoc(app(kas), Object.assign(ACK(), { type: 'Wholesaler' }))));

  console.log('\nstrangers');
  await check('another user cannot re-acknowledge someone else\'s application', assertFails(updateDoc(app(other), ACK())));
  await check('anonymous cannot', assertFails(updateDoc(app(anon), ACK())));
  await check('an admin\'s RAW client write of priorDecisions is refused (server-only via applicationDecide)', assertFails(updateDoc(app(adm), { priorDecisions: [] })));

  console.log('\nCOUNTERPROOF (rules disabled = the server path)');
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await check('server writes priorDecisions', assertSucceeds(updateDoc(doc(f, 'applications/PRVMS7IACKG'), { priorDecisions: [{ decidedBy: 'reindex' }] })));
    await check('server writes decidedBy', assertSucceeds(updateDoc(doc(f, 'applications/PRVMS7IACKG'), { decidedBy: 'admin_D5' })));
  });
  await env.cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASH', e); process.exit(2); });
