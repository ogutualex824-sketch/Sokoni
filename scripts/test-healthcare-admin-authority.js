/* test-healthcare-admin-authority.js — Healthcare admin authority is the canonical AdminOS model (CHANGELOG 222,
 * Healthcare security slice 2). Transactional fake Firestore + the REAL functions/healthcare-hub.js and
 * functions/application-lifecycle.js. No network, no production.
 *
 * PROVES
 *   retired     approveHealthProvider and getHealthDashboard refuse EVERY caller (real admin, numeric-role spoof,
 *               provider) and read / write nothing — AdminOS application review is the only approval
 *   numeric     a numeric `role: 4` claim (minted by nothing) grants nothing anywhere: not another provider's
 *               appointments, not another party's appointment, not another patient's records
 *   canonical   a real admin (admin-claim) reads another provider's appointments and updates an appointment
 *   forged      a forged admin identity (string "true", isAdmin:'yes', role 'Admin') is not an admin
 *   self        registerHealthProvider ignores injected status / verified / approved; a client-written
 *               "approved" health application grants nothing; an applicant cannot decide their own application
 *   preserved   a real AdminOS approval of a health application still lands the provider in providers/{uid}
 *   static      no getRole / numeric role gate remains in healthcare-hub.js
 *
 *   node scripts/test-healthcare-admin-authority.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-healthcare-admin-authority';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const CLAIMS = { spoof4: { role: 4 } };
const AUTH = { getUser: async (u) => ({ uid: u, customClaims: CLAIMS[u] || {} }), setCustomUserClaims: async (u, c) => { CLAIMS[u] = c; } };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => AUTH, storage: () => ({ bucket: () => ({}) }), messaging: () => ({ send: async () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => AUTH });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const HC = require(Path.join(FN, 'healthcare-hub.js'));
const LC = require(Path.join(FN, 'application-lifecycle.js'));
const LA = require(Path.join(FN, 'legal-agreements.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const run = (cf) => (req) => (cf.run || cf)(req);
const req = (uid, data, claims) => ({ auth: uid ? { uid, token: Object.assign({}, claims || {}) } : null, data: data || {}, rawRequest: { headers: {} } });
const ADM = { admin: true };
async function code(p) { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const snapshotOf = async () => JSON.stringify((await db.collection('healthProviders').get()).docs.map((d) => [d.id, d.data().status, d.data().reviewedBy || null]));

(async () => {
  const FUT = new Date(Date.now() + 3 * 86400000).toISOString();
  await db.doc('healthProviders/docA').set({ providerId: 'docA', uid: 'docA', name: 'Dr A', status: 'pending', specialization: 'general_practice' });
  await db.doc('healthProviders/docB').set({ providerId: 'docB', uid: 'docB', name: 'Dr B', status: 'active', specialization: 'pediatrics' });
  await db.doc('healthAppointments/apB').set({ appointmentId: 'apB', providerId: 'docB', patientUid: 'pat1', status: 'pending', dateTime: FUT, createdAt: 1 });
  await db.doc('healthRecords/r1').set({ recordId: 'r1', patientUid: 'pat1', providerId: 'docB', diagnosis: 'x', createdAt: 1 });

  say('\n── retired functions ──');
  const before = await snapshotOf();
  for (const [who, claims] of [['adm1', ADM], ['spoof4', { role: 4 }], ['docA', {}]]) {
    ck(`approveHealthProvider refuses ${who} (${JSON.stringify(claims)}) — AdminOS is the only approval`, await code(run(HC.approveHealthProvider)(req(who, { providerId: 'docA', action: 'approve', reason: 'x' }, claims))) === 'HEALTH_APPROVAL_MOVED');
    ck(`getHealthDashboard refuses ${who}`, await code(run(HC.getHealthDashboard)(req(who, {}, claims))) === 'HEALTH_DASHBOARD_MOVED');
  }
  ck('…unauthenticated: refused before anything', await code(run(HC.approveHealthProvider)(req(null, { providerId: 'docA', action: 'approve' }))) === 'unauthenticated');
  ck('…and nothing was written (docA still pending, no reviewer)', (await snapshotOf()) === before && (await get('healthProviders/docA')).status === 'pending');

  say('\n── the numeric role 4 claim grants nothing ──');
  const spoofAppts = await run(HC.getProviderAppointments)(req('spoof4', { providerId: 'docB' }, { role: 4 }));
  ck('numeric role 4 cannot read another provider\'s appointments', spoofAppts.appointments.length === 0, spoofAppts.appointments.length);
  ck('numeric role 4 cannot change an appointment it is not party to', await code(run(HC.updateAppointmentStatus)(req('spoof4', { appointmentId: 'apB', status: 'confirmed' }, { role: 4 }))) === 'permission-denied' && (await get('healthAppointments/apB')).status === 'pending');
  /* 'cancelled' is the one status a PARTY (the patient) may set — so it is the probe that shows the party check itself */
  ck('…not even cancel it (only a party or a real admin may) — numeric role 4 or a stranger', await code(run(HC.updateAppointmentStatus)(req('spoof4', { appointmentId: 'apB', status: 'cancelled' }, { role: 4 }))) === 'permission-denied' && await code(run(HC.updateAppointmentStatus)(req('stranger', { appointmentId: 'apB', status: 'cancelled' }))) === 'permission-denied' && (await get('healthAppointments/apB')).status === 'pending');
  const spoofRec = await run(HC.getHealthRecords)(req('spoof4', { patientUid: 'pat1' }, { role: 4 }));
  ck('numeric role 4 cannot read another patient\'s records', spoofRec.records.length === 0);

  say('\n── forged admin identities ──');
  for (const t of [{ admin: 'true' }, { isAdmin: 'yes' }, { role: 'Admin' }, { superAdmin: 1 }, { admin: false, role: 5 }]) {
    const r = await run(HC.getProviderAppointments)(req('forger', { providerId: 'docB' }, t));
    ck(`forged admin token ${JSON.stringify(t)} is not an admin (sees no other provider's appointments)`, r.appointments.length === 0);
  }

  say('\n── the canonical admin claim ──');
  const admAppts = await run(HC.getProviderAppointments)(req('adm1', { providerId: 'docB' }, ADM));
  ck('a real admin (admin-claim) reads another provider\'s appointments', admAppts.appointments.length === 1);
  ck('a real admin updates an appointment', (await run(HC.updateAppointmentStatus)(req('adm1', { appointmentId: 'apB', status: 'confirmed' }, ADM))) && (await get('healthAppointments/apB')).status === 'confirmed');
  const admRec = await run(HC.getHealthRecords)(req('adm1', { patientUid: 'pat1' }, ADM));
  ck('…but no admin reads a patient\'s clinical records through this path (decided in slice 3)', admRec.records.length === 0);

  say('\n── self-approval ──');
  await run(HC.registerHealthProvider)(req('docC', { name: 'Dr C', specialization: 'dermatology', licenseNumber: 'KMPDC-1', status: 'active', verified: true, approved: true, reviewedBy: 'adm1' }));
  const c = await get('healthProviders/docC');
  ck('registerHealthProvider ignores injected status / verified / approved / reviewedBy', c.status === 'pending' && c.verified === undefined && c.approved === undefined && c.reviewedBy === undefined, c.status);
  await db.doc('applications/hc_self').set({ uid: 'docD', role: 'health', name: 'Dr D', status: 'approved', decidedBy: 'adm1', createdAt: 1 });
  for (let i = 0; i < 4; i++) { const s = await db.doc('applications/hc_self').get(); await run(LC.applicationLifecycle)({ data: { before: null, after: s }, params: { appId: 'hc_self' } }); }
  const selfApp = await get('applications/hc_self');
  ck('a client-written "approved" health application grants nothing (no server decision record)', selfApp.projectionStatus === 'blocked_unauthorised_decision' && !(await get('providers/docD')), selfApp.projectionStatus);
  await db.doc('applications/hc_e').set({ uid: 'docE', role: 'health', name: 'Dr E', status: 'pending', createdAt: 1 });
  ck('the applicant cannot decide their own application', await code(run(LC.applicationDecide)(req('docE', { applicationId: 'hc_e', decision: 'approve', reason: 'me' }))) === 'permission-denied');
  ck('…nor with a numeric role 4 claim', await code(run(LC.applicationDecide)(req('docE', { applicationId: 'hc_e', decision: 'approve', reason: 'me' }, { role: 4 }))) === 'permission-denied');

  say('\n── preserved: AdminOS approval provisions providers/{uid} ──');
  const need = (await LA.complianceFor('docE', 'health')).required;
  for (const a of need) await db.collection('legalAcceptances').doc('docE_' + a.agreementId).set({ userId: 'docE', agreementId: a.agreementId, version: a.version, accepted: true });
  const d = await run(LC.applicationDecide)(req('adm1', { applicationId: 'hc_e', decision: 'approve', reason: 'KMPDC checked' }, ADM));
  const pE = await get('providers/docE');
  ck('a real AdminOS approval of a health application lands the provider in providers/{uid}', d.ok && pE && ['active', 'approved'].includes(pE.status), pE && pE.status);

  say('\n── static ──');
  const SRC = fs.readFileSync(Path.join(FN, 'healthcare-hub.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('no getRole / numeric role gate remains in healthcare-hub.js', !/getRole|role\s*[<>]=?\s*4|customClaims/.test(SRC));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
