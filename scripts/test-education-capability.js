/* test-education-capability.js — EDUCATION E2: the ONE Education capability answer (educationWorkspace) for learner /
 * teacher / institution / enterprise, composed from server records only. Harness = test-business-workspace.js. */
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

const EW = require(Path.join(FN, 'education-workspace.js'));
(async () => {
  say('\nEducation capability answer (educationWorkspace)\n');
  const edu = (type, extra) => Object.assign(biz('education'), type === undefined ? {} : { education: { type } }, extra || {});
  await seed('teach1', edu('teacher'));
  await seed('inst1', edu('institution'));
  await seed('teachPend', Object.assign({ status: 'pending' }, edu('teacher')));
  await db.doc('users/adult').set({ ageVerified: true });
  await db.doc('users/kid').set({});
  await db.doc('learnerProfiles/kid').set({ ownerUid: 'kid', displayName: 'K' });
  await db.doc('educationEnterprises/acme').set({ ownerUid: 'acme', status: 'active', approved: true, companyName: 'Acme Ltd' });
  await db.doc('educationEnterprises/gone').set({ ownerUid: 'gone', status: 'inactive', approved: false });
  await db.doc('applications/APPX').set({ uid: 'kid', category: 'school', status: 'pending', projectionStatus: 'blocked_incomplete', missing: ['Registration / accreditation number'], educationType: 'institution' });
  await db.doc('applications/APPY').set({ uid: 'kid', category: 'plumbing', status: 'pending' });
  await db.doc('applications/APPZ').set({ uid: 'someoneElse', category: 'tutor', status: 'pending' });
  const A = {};
  for (const u of ['kid', 'adult', 'teach1', 'inst1', 'teachPend', 'acme', 'gone']) A[u] = await EW._internal.educationWorkspaceFor(db, u);
  const dash = (a) => a.dashboards.map((d) => d.actor + ':' + d.state).join(',');

  ck('X-1 every account is a learner: the learner dashboard is always offered', Object.values(A).every((a) => a.dashboards.some((d) => d.actor === 'learner' && d.state === 'AVAILABLE')));
  ck('X-2 an UNVERIFIED learner: live classes / tutoring / messages LOCKED (AGE_OR_GUARDIAN_REQUIRED); profile + courses AVAILABLE',
    A.kid.learner.access.interactive === false && ['liveClasses', 'tutoring', 'messages'].every((k) => A.kid.learner.modules[k].state === 'LOCKED' && A.kid.learner.modules[k].reason === 'AGE_OR_GUARDIAN_REQUIRED')
      && A.kid.learner.modules.profile.state === 'AVAILABLE' && A.kid.learner.modules.courses.state === 'AVAILABLE', A.kid.learner.modules);
  ck('X-2b Certificates is AVAILABLE to every learner (courseLessons myCertificates / verify are built)', A.kid.learner.modules.certificates.state === 'AVAILABLE' && A.adult.learner.modules.certificates.state === 'AVAILABLE');
  ck('X-3 a VERIFIED adult: those modules are not LOCKED (unbuilt ones stay NOT_IMPLEMENTED — never faked)', ['liveClasses', 'tutoring', 'messages'].every((k) => A.adult.learner.modules[k].state === 'NOT_IMPLEMENTED'), A.adult.learner.modules);
  ck('X-4 a TEACHER: the teacher dashboard on provider-dashboard, educationType teacher, ONLY teacher modules', dash(A.teach1).includes('teacher:AVAILABLE') && A.teach1.provider.educationType === 'teacher'
    && Object.keys(A.teach1.provider.modules).sort().join() === 'eduClasses,eduCourses,eduLearners,eduLessons', A.teach1.provider);
  ck('X-5 an INSTITUTION: the institution dashboard; never teacher-only lessons / learners', dash(A.inst1).includes('institution:AVAILABLE') && !('eduLessons' in A.inst1.provider.modules) && 'eduTimetable' in A.inst1.provider.modules, A.inst1.provider);
  ck('X-6 a PENDING teacher gets NO teacher dashboard', !dash(A.teachPend).includes('teacher') && A.teachPend.provider === null || (A.teachPend.provider && A.teachPend.provider.state !== 'AVAILABLE' && !dash(A.teachPend).includes('teacher')), [dash(A.teachPend), A.teachPend.provider]);
  const entDash = A.acme.dashboards.find((d) => d.actor === 'enterprise') || {};
  ck('X-7 an ENTERPRISE buyer: its OWN shell (education-enterprise.html — never provider-dashboard), NO provider workspace, no provider modules; employees / training AVAILABLE, the rest NOT_IMPLEMENTED',
    A.acme.enterprise.state === 'ACTIVE' && A.acme.provider === null && dash(A.acme) === 'learner:AVAILABLE,enterprise:AVAILABLE' && entDash.route === 'education-enterprise.html'
      && A.acme.enterprise.modules.employees.state === 'AVAILABLE' && A.acme.enterprise.modules.training.state === 'AVAILABLE' && A.acme.enterprise.modules.payments.state === 'NOT_IMPLEMENTED'
    && !Object.keys(A.acme.enterprise.modules).some((k) => /^edu|storefront|earnings|services/.test(k)), [dash(A.acme), A.acme.provider]);
  ck('X-8 a suspended enterprise is LOCKED and NOT routed', A.gone.enterprise.state === 'SUSPENDED' && Object.values(A.gone.enterprise.modules).every((m) => m.state === 'LOCKED')
    && (A.gone.dashboards.find((d) => d.actor === 'enterprise') || {}).route === null);
  ck('X-9 the caller sees ONLY their own EDUCATION applications, with what is missing (a plumbing app and another user\'s tutor app are not listed)',
    A.kid.applications.length === 1 && A.kid.applications[0].id === 'APPX' && A.kid.applications[0].missing.length === 1, A.kid.applications);
  ck('X-10 a plain learner has no provider and no enterprise section (null, not invented)', A.kid.provider === null && A.kid.enterprise === null);
  ck('X-11 the callable has NO uid parameter (answers for the caller only)', !/req\.data[\s\S]{0,40}uid/.test(require('fs').readFileSync(Path.join(FN, 'education-workspace.js'), 'utf8')));
  const src = require('fs').readFileSync(Path.join(FN, 'education-workspace.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('X-13 (static) education-workspace.js performs no writes', !/\.(set|update|add|create|delete)\s*\(/.test(src));
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
