/* test-education-enterprise.js — EDUCATION E2 enterprise training: Enterprise → training ASSIGNMENT → learner, by consent
 * (single-use invite redeemed by the employee), never by account lookup or ownership. REAL education-enterprise.js on the
 * transactional fake (harness: test-business-workspace.js). */
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
const AF = require('./lib/approval-fixture'); AF.stubAdminAuth(stub); AF.autoApproveOnWrite(db); /* shell gate: approvedAt fixtures carry their admin decision */
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

const ENT = require(Path.join(FN, 'education-enterprise.js'));
const call = async (uid, data) => { try { return await ENT.educationEnterprise.run({ auth: uid ? { uid, token: {} } : null, data }); } catch (e) { return { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; } };
const all = async (c) => { const q = await db.collection(c).get(); const o = {}; q.docs.forEach((d) => { o[d.id] = d.data(); }); return o; };
(async () => {
  say('\nEducation enterprise training — consent-based assignments\n');
  await db.doc('educationEnterprises/acme').set({ status: 'active', approved: true, companyName: 'Acme Ltd', staffSeats: 40 });
  await db.doc('educationEnterprises/beta').set({ status: 'active', approved: true, companyName: 'Beta Ltd' });
  await db.doc('educationEnterprises/gone').set({ status: 'inactive', approved: false, companyName: 'Gone Ltd' });
  await db.doc('learnerProfiles/emp1').set({ ownerUid: 'emp1', displayName: 'Achieng', goals: 'secret goals', interests: ['music'] });
  await db.doc('users/emp1').set({ ageVerified: true, phone: '+254700000000' });
  await db.doc('guardianLinks/emp2__g1').set({ learnerUid: 'emp2', guardianUid: 'g1', status: 'active' });

  let r = await call('stranger', { op: 'inviteCreate', label: 'x' });
  ck('N-1 a plain account cannot create company invites', r.reason === 'NOT_A_VERIFIED_COMPANY' && !Object.keys(await all('trainingInvites')).length, r);
  r = await call('gone', { op: 'inviteCreate' });
  ck('N-2 a suspended company cannot create invites', r.reason === 'NOT_A_VERIFIED_COMPANY', r);
  r = await call('acme', { op: 'inviteCreate', label: 'Achieng <script>' });
  const code = r.code;
  ck('N-3 a verified company mints a single-use 10-character invite (its own label, sanitised)', /^[A-Z2-9]{10}$/.test(code || '') && (await all('trainingInvites'))[code].label === 'Achieng script' && (await all('trainingInvites'))[code].enterpriseUid === 'acme', r);
  r = await call('acme', { op: 'joinCompany', code });
  ck('N-4 a company cannot enrol itself with its own code', r.reason === 'SELF_ASSIGN' && !Object.keys(await all('trainingAssignments')).length, r);
  r = await call('emp1', { op: 'joinCompany', code: code.toLowerCase() });
  const A = await all('trainingAssignments');
  ck('N-5 the EMPLOYEE redeems the code from their own account → an active assignment (consent, not lookup)', r.ok === true && r.companyName === 'Acme Ltd' && A['acme__emp1'] && A['acme__emp1'].status === 'active' && A['acme__emp1'].learnerUid === 'emp1', [r, A]);
  r = await call('emp3', { op: 'joinCompany', code });
  ck('N-6 a used code cannot be replayed by someone else', r.reason === 'CODE_USED', r);
  r = await call('acme', { op: 'assignments' });
  ck('N-7 the company sees ONLY the display name + its own label — no profile, goals, interests, age, guardian or contact',
    r.assignments.length === 1 && r.assignments[0].displayName === 'Achieng' && !/secret goals|music|ageVerified|254700|guardian/.test(JSON.stringify(r)), r);
  r = await call('beta', { op: 'assignments' });
  ck('N-8 another company sees none of Acme\'s assignments', r.assignments.length === 0, r);
  r = await call('beta', { op: 'assignmentEnd', assignmentId: 'acme__emp1' });
  ck('N-9 another company cannot end Acme\'s assignment', r.reason === 'ASSIGNMENT_UNKNOWN' && (await all('trainingAssignments'))['acme__emp1'].status === 'active', r);
  r = await call('emp1', { op: 'myCompanies' });
  ck('N-10 the learner sees the companies they train with', r.companies.length === 1 && r.companies[0].companyName === 'Acme Ltd', r);
  r = await call('emp9', { op: 'leaveCompany', assignmentId: 'acme__emp1' });
  ck('N-11 nobody else can end the learner\'s assignment on their behalf', r.reason === 'ASSIGNMENT_UNKNOWN', r);
  r = await call('emp1', { op: 'leaveCompany', assignmentId: 'acme__emp1' });
  const after = (await all('trainingAssignments'))['acme__emp1'];
  ck('N-12 the learner can leave; the record survives as ended (audited); their account is untouched',
    r.ok === true && after.status === 'ended' && after.endedBy === 'learner' && JSON.stringify((await all('users')).emp1) === JSON.stringify({ ageVerified: true, phone: '+254700000000' })
      && Object.values(await all('educationAudit')).some((x) => x.action === 'training_assignment_left'), after);
  /* expiry, revoke, suspended company */
  await db.doc('trainingInvites/OLDCODE234').set({ enterpriseUid: 'acme', status: 'open', expiresAtMs: Date.now() - 1 });
  r = await call('emp1', { op: 'joinCompany', code: 'OLDCODE234' });
  ck('N-13 an expired invite assigns nobody', r.reason === 'CODE_EXPIRED', r);
  const c2 = (await call('acme', { op: 'inviteCreate' })).code;
  r = await call('beta', { op: 'inviteRevoke', code: c2 });
  ck('N-14 another company cannot revoke Acme\'s invite', r.reason === 'INVITE_UNKNOWN', r);
  r = await call('acme', { op: 'inviteRevoke', code: c2 });
  const r2 = await call('emp4', { op: 'joinCompany', code: c2 });
  ck('N-15 a revoked invite cannot be redeemed', r.ok === true && r2.reason === 'CODE_USED', r2);
  await db.doc('trainingInvites/GONECODE23').set({ enterpriseUid: 'gone', status: 'open', expiresAtMs: Date.now() + 1e6 });
  r = await call('emp1', { op: 'joinCompany', code: 'GONECODE23' });
  ck('N-16 an invite from a company that is no longer active assigns nobody', r.reason === 'COMPANY_NOT_ACTIVE', r);
  r = await call('acme', { op: 'overview' });
  ck('N-17 the company overview counts come from its own records', r.ok === true && r.company.companyName === 'Acme Ltd' && r.counts.activeLearners === 0 && r.counts.openInvites === 0, r);
  const src = require('fs').readFileSync(Path.join(FN, 'education-enterprise.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('N-18 (static) the company never looks a user up (no users / phone / email query) and never writes outside its own collections + audit',
    !/collection\('users'\)/.test(src) && !/where\('(phone|email|phoneNumber)'/.test(src) && !/collection\('(learnerProfiles|providers|wallets|guardianLinks)'\)\.doc\([^)]*\)\.(set|update)/.test(src));
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
