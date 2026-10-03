/* test-p0-forged-approval.js — P0 2026-10-03: the business-workspace approval authority (approvalStateFor →
 * approval-remediation) accepts an approval ONLY with SERVER evidence (applicationDecisions record or applicationDecide's
 * adminAudit row, same decider). Both forge paths refused. Harness = test-business-workspace.js. */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-business-workspace';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
const AF = require('./lib/approval-fixture'); AF.stubAdminAuth(stub);  /* shell gate: approvedAt fixtures carry their admin decision */
const PLANS = {};
stub('./subscription-core', { resolveSubscription: async (uid) => (PLANS[uid] ? Object.assign({ found: true }, PLANS[uid]) : { found: false }) });

const BW = require(Path.join(FN, 'business-workspace.js'));
const BC = require(Path.join(FN, 'business-category.js'));
const S = BW.STATE;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const HE = class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } };
const seed = (uid, doc) => db.doc('providers/' + uid).set(Object.assign({ name: uid, status: 'active', approvedAt: 1 /* the producer (projectProvider) always stamps approvedAt; a status alone is client-writable */ }, doc));
const biz = (category) => ({ business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } });
const st = (w, m) => (w.modules[m] || {}).state;

const REM = require(Path.join(FN, 'shared', 'approval-remediation.js'));
const ST = REM.STATES || {};
const asState = async (uid) => (await BW.approvalStateFor(db, uid)).state;
(async () => {
  say('\nP0 forged approval — the workspace authority needs SERVER evidence   ' + (process.env.BASE ? 'BASE' : 'this tree') + '\n');
  const app = (uid, o) => db.doc('applications/' + uid + '-app').set(Object.assign({ applicationId: uid + '-app', uid, role: 'provider', status: 'approved', statusCanonical: 'approved', decidedBy: 'admin_1', decidedAt: '2026-10-01T00:00:00Z' }, o || {}));
  const prov = (uid, o) => db.doc('providers/' + uid).set(Object.assign({ name: uid, status: 'pending', business: { category: 'trades', source: 'application', lane: { hub: 'provider', entClass: null } } }, o || {}));

  /* F-1 THE ATTACK: an applicant writes status approved + a REAL admin as decidedBy on their own application */
  await prov('forger1'); await app('forger1');
  ck('F-1 THE ATTACK: status approved + decidedBy a REAL admin, NO server decision record → NOT a valid approval', (await asState('forger1')) !== ST.VALID, await asState('forger1'));
  /* F-2 control: the same application WITH applicationDecide's record */
  await prov('real1'); await app('real1'); await db.doc('applicationDecisions/real1-app').set({ status: 'approved', decidedBy: 'admin_1' });
  ck('F-2 CONTROL: with the applicationDecisions record (written only by applicationDecide) it IS valid', (await asState('real1')) === ST.VALID, await asState('real1'));
  /* F-3 legacy: decided before applicationDecisions existed, but applicationDecide's immutable audit row exists */
  await prov('legacy1'); await app('legacy1'); await db.collection('adminAudit').add({ action: 'application_approve', applicationId: 'legacy1-app', performedBy: 'admin_1' });
  ck('F-3 a LEGACY approval with applicationDecide\'s immutable adminAudit row stays valid (no lockout of real approvals)', (await asState('legacy1')) === ST.VALID, await asState('legacy1'));
  /* F-4 the audit row is by ANOTHER admin than the application names */
  await prov('swap1'); await app('swap1', { decidedBy: 'admin_2' }); await db.collection('adminAudit').add({ action: 'application_approve', applicationId: 'swap1-app', performedBy: 'admin_1' });
  ck('F-4 evidence by a DIFFERENT admin than the application names is not evidence', (await asState('swap1')) !== ST.VALID, await asState('swap1'));
  /* F-5 a record that says rejected while the application says approved */
  await prov('flip1'); await app('flip1'); await db.doc('applicationDecisions/flip1-app').set({ status: 'rejected', decidedBy: 'admin_1' });
  ck('F-5 a decision record that says REJECTED is not an approval, whatever the application says', (await asState('flip1')) !== ST.VALID, await asState('flip1'));
  /* F-6 other audit actions do not count */
  await prov('aud2'); await app('aud2'); await db.collection('adminAudit').add({ action: 'application_request_info', applicationId: 'aud2-app', performedBy: 'admin_1' });
  ck('F-6 an audit row for another action (request_info) is not approval evidence', (await asState('aud2')) !== ST.VALID, await asState('aud2'));
  /* F-7 PATH 2: a self-written providers.approvalDecision 'approve' (no application at all) */
  await prov('forger2', { approvalDecision: { decision: 'approve', source: 'admin_decision', decidedBy: 'x' } });
  const s7 = await asState('forger2');
  ck('F-7 PATH 2: a self-written providers.approvalDecision approve is NOT an approval (approval artefact → an admin re-decides)', s7 !== ST.VALID && s7 === ST.INVALID_LEGACY, s7);
  /* F-8 a 'refuse' still refuses */
  await prov('refused1', { approvalDecision: { decision: 'refuse', source: 'admin_decision', decidedBy: 'admin_1' } }); await app('refused1'); await db.doc('applicationDecisions/refused1-app').set({ status: 'approved', decidedBy: 'admin_1' });
  ck('F-8 CONTROL: a providers.approvalDecision refuse still REFUSES (a forged refusal only harms the forger)', (await asState('refused1')) === ST.REFUSED, await asState('refused1'));
  /* F-9 self-approval with a record naming the applicant */
  await prov('selfie'); await app('selfie', { decidedBy: 'selfie' }); await db.doc('applicationDecisions/selfie-app').set({ status: 'approved', decidedBy: 'selfie' });
  ck('F-9 CONTROL: self-decided is still never an approval', (await asState('selfie')) !== ST.VALID, await asState('selfie'));
  /* F-10 the whole workspace answer for the attacker: no provider workspace modules */
  const w = await BW.workspaceFor(db, 'forger1');
  ck('F-10 the forged applicant gets a HOLDING workspace answer, not the provider dashboard', w.state !== 'AVAILABLE' && (!w.modules || (w.modules.services || {}).state !== 'AVAILABLE'), [w.state, w.reason, w.modules && w.modules.services]);
  /* F-11 pure predicate: no isServerDecided supplied → fail closed */
  const pure = REM.deriveApprovalState({ uid: 'p', provider: { status: 'active' }, applications: [{ id: 'p-app', status: 'approved', decidedBy: 'admin_1', role: 'provider' }], isAdminAccount: () => true });
  ck('F-11 the pure derivation FAILS CLOSED when no server-evidence predicate is supplied', pure.state !== ST.VALID, pure.state);
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
