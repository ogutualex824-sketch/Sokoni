/* test-healthcare-category.js — the server records WHAT KIND of healthcare provider an account is (CHANGELOG 227).
 * Transactional fake Firestore + the REAL functions/application-lifecycle.js (applicationDecide → projectProvider),
 * functions/healthcare-category.js and functions/healthcare-admin.js. No network.
 *
 * PROVES
 *   mapping     exact matches only: hub-register ids (hospital/dental/optician/physio/mental-health/vet → facility,
 *               pharmacy, laboratory) and onboarding professions (Doctor, Nurse, … → clinician); ambiguous or unknown
 *               → null (UNCLASSIFIED); telemedicine / home_care are never guessed
 *   approval    an AdminOS approval of a `health` application stamps providers/{uid}.healthcare {category, source}
 *               from the application; an unknown application is stamped UNCLASSIFIED (null), never guessed; a
 *               non-health approval stamps nothing
 *   admin       healthAdminClassify: admin-claim only (non-admin / numeric role refused), category enum only,
 *               reason required, only an account already known as a health provider (never a plumber); writes the
 *               existing adminAudit trail (actor · previous · next · reason); a later re-approval never overwrites
 *               an admin classification; healthAdminProviders lists UNCLASSIFIED and by category
 *
 *   node scripts/test-healthcare-category.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-healthcare-category';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const FN = Path.join(Path.resolve(__dirname, '..'), 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const CLAIMS = {};
const AUTH = { getUser: async (u) => ({ uid: u, customClaims: CLAIMS[u] || {} }), setCustomUserClaims: async (u, c) => { CLAIMS[u] = c; } };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => AUTH });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => AUTH, storage: () => ({ bucket: () => ({}) }), messaging: () => ({ send: async () => ({}) }) });
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });
const HCAT = require(Path.join(FN, 'healthcare-category.js'));
const LC = require(Path.join(FN, 'application-lifecycle.js'));
const LA = require(Path.join(FN, 'legal-agreements.js'));
const HA = require(Path.join(FN, 'healthcare-admin.js'))._adminH;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const run = (cf) => (req) => (cf.run || cf)(req);
const req = (uid, data, claims) => ({ auth: uid ? { uid, token: Object.assign({}, claims || {}) } : null, data: data || {}, rawRequest: { headers: {} } });
const ADM = { admin: true };
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ _id: d.id }, d.data()));

async function approveHealth(uid, fields) {
  const appId = 'hc_' + uid;
  await db.doc('applications/' + appId).set(Object.assign({ uid, role: 'health', name: 'Provider ' + uid, status: 'pending', createdAt: 1 }, fields || {}));
  const need = (await LA.complianceFor(uid, 'health')).required;
  for (const a of need) await db.collection('legalAcceptances').doc(uid + '_' + a.agreementId).set({ userId: uid, agreementId: a.agreementId, version: a.version, accepted: true });
  return run(LC.applicationDecide)(req('adm1', { applicationId: appId, decision: 'approve', reason: 'checked' }, ADM));
}

(async () => {
  say('\n── mapping (exact matches only) ──');
  const M = [
    [{ category: 'hospital' }, 'facility'], [{ category: 'dental' }, 'facility'], [{ category: 'optician' }, 'facility'],
    [{ category: 'physiotherapy' }, 'facility'], [{ category: 'mental-health' }, 'facility'], [{ category: 'vet' }, 'facility'],
    [{ category: 'pharmacy' }, 'pharmacy'], [{ category: 'laboratory' }, 'laboratory'],
    [{ subcategory: 'Doctor' }, 'clinician'], [{ professionalType: 'Clinical Officer' }, 'clinician'], [{ subcategory: ' nurse ' }, 'clinician'],
    [{ category: 'pharmacy', subcategory: 'Doctor' }, null], [{ category: 'plumbing' }, null], [{}, null],
    [{ category: 'Pharmacy & Wellness Hub' }, null], [{ subcategory: 'Telemedicine' }, null], [{ category: 'home-care' }, null],
  ];
  for (const [app, want] of M) ck(`${JSON.stringify(app)} → ${want === null ? 'UNCLASSIFIED' : want}`, HCAT.categoryFromApplication(app) === want, HCAT.categoryFromApplication(app));

  say('\n── approval stamps the category on the canonical provider ──');
  const d1 = await approveHealth('ph1', { category: 'pharmacy' });
  const p1 = await get('providers/ph1');
  ck('an approved pharmacy application → providers/{uid}.healthcare {pharmacy, application}', d1.ok && p1 && p1.healthcare && p1.healthcare.category === 'pharmacy' && p1.healthcare.source === 'application', p1 && p1.healthcare);
  await approveHealth('cl1', { subcategory: 'Doctor' });
  ck('an approved Doctor → clinician', ((await get('providers/cl1')) || {}).healthcare.category === 'clinician');
  await approveHealth('un1', { category: 'Wellness' });
  const u1 = await get('providers/un1');
  ck('an application that maps to nothing is stamped UNCLASSIFIED (null) — never guessed', u1 && u1.healthcare && u1.healthcare.category === null && u1.healthcare.source === 'application', u1 && u1.healthcare);
  await db.doc('applications/pl1').set({ uid: 'pl1', role: 'provider', name: 'Pipes', category: 'Plumbing', status: 'pending', createdAt: 1, agreementAccepted: true });
  await run(LC.applicationDecide)(req('adm1', { applicationId: 'pl1', decision: 'approve', reason: 'ok' }, ADM));
  const pl = await get('providers/pl1');
  ck('a non-health approval stamps no healthcare record', pl && pl.healthcare === undefined, pl && pl.healthcare);

  say('\n── AdminOS classification ──');
  const C = (uid, data, claims) => code(HA.healthAdminClassify(req(uid, data, claims)));
  ck('a non-admin cannot classify', await C('un1', { uid: 'un1', category: 'telemedicine', reason: 'self' }) === 'permission-denied');
  ck('a numeric role 4 claim cannot classify', await C('imp', { uid: 'un1', category: 'telemedicine', reason: 'x y z' }, { role: 4 }) === 'permission-denied');
  ck('an unknown category is refused', await C('adm1', { uid: 'un1', category: 'hospital', reason: 'x y z' }, ADM) === 'invalid-argument');
  ck('a reason is required', await C('adm1', { uid: 'un1', category: 'telemedicine', reason: '' }, ADM) === 'invalid-argument');
  ck('a plumber can never be classified as a healthcare provider', await C('adm1', { uid: 'pl1', category: 'pharmacy', reason: 'x y z' }, ADM) === 'failed-precondition' && ((await get('providers/pl1')) || {}).healthcare === undefined);
  ck('an unknown account is refused', await C('adm1', { uid: 'nobody', category: 'pharmacy', reason: 'x y z' }, ADM) === 'not-found');
  const before = (await all('adminAudit')).length;
  const r = await HA.healthAdminClassify(req('adm1', { uid: 'un1', category: 'telemedicine', reason: 'Video-only practice, KMPDC checked' }, ADM));
  const u2 = await get('providers/un1');
  ck('an admin classifies an UNCLASSIFIED provider as telemedicine (only an admin can reach it)', r.category === 'telemedicine' && u2.healthcare.category === 'telemedicine' && u2.healthcare.source === 'admin' && u2.healthcare.classifiedBy === 'adm1');
  const au = (await all('adminAudit')).filter((a) => a.action === 'healthcare_classify');
  ck('…written to the existing adminAudit trail: actor, target, previous, next, reason', (await all('adminAudit')).length === before + 1 && au.some((a) => a.targetUid === 'un1' && a.performedBy === 'adm1' && a.previous === null && a.next === 'telemedicine' && /KMPDC/.test(a.reason)));
  await db.doc('applications/hc_un1').set({ status: 'pending', decidedBy: null, projectionStatus: null }, { merge: true });
  await run(LC.applicationDecide)(req('adm1', { applicationId: 'hc_un1', decision: 'approve', reason: 're-approve' }, ADM));
  ck('a later re-approval never overwrites the admin classification', ((await get('providers/un1')) || {}).healthcare.category === 'telemedicine');

  say('\n── AdminOS listing ──');
  await approveHealth('un2', { category: 'Spa' });
  const lst = await HA.healthAdminProviders(req('adm1', { view: 'unclassified' }, ADM));
  ck('the UNCLASSIFIED view lists the providers still needing a category', lst.providers.some((p) => p.uid === 'un2') && !lst.providers.some((p) => p.uid === 'un1' || p.uid === 'ph1'), lst.providers.map((p) => p.uid));
  const phs = await HA.healthAdminProviders(req('adm1', { view: 'pharmacy' }, ADM));
  ck('the by-category view lists pharmacies only', phs.providers.length === 1 && phs.providers[0].uid === 'ph1');
  ck('the listing never contains a plumber', !(await HA.healthAdminProviders(req('adm1', {}, ADM))).providers.some((p) => p.uid === 'pl1'));
  ck('a non-admin cannot list', await code(HA.healthAdminProviders(req('ph1', {}))) === 'permission-denied');

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
