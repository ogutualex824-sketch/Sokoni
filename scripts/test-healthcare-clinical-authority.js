/* test-healthcare-clinical-authority.js — medical records + prescriptions require a confirmed clinical relationship
 * (CHANGELOG 223, Healthcare security slice 3). Transactional fake Firestore (strict read order) + the REAL
 * functions/healthcare-hub.js. The relationship authority is the CANONICAL providerBookings. No network.
 *
 * PROVES — for createHealthRecord AND createPrescription
 *   allowed    ONLY: caller is the booking's provider · the patient is the booking's customer (derived) ·
 *              commissionHub 'healthcare' · status confirmed|completed · paymentStatus paid_held|settled ·
 *              the provider identity gate unchanged (healthProviders active)
 *   refused    arbitrary patientUid (ignored — the record lands on the booking's patient) · forged provider
 *              (another provider's booking) · forged / missing booking id · a non-healthcare booking ·
 *              pending / cancelled / declined / no-show · unpaid-but-confirmed · refunded · a provider
 *              booking themselves · an inactive / unregistered provider identity · no requestId
 *   replay     the same requestId returns the same record — one record, one audit row
 *   audit      one row per write: actor (from auth, never the request) · patient · provider · action · ref ·
 *              booking basis · time — and NO diagnosis / medicine content
 *   reads      getHealthRecords / getPrescriptions return only the caller's own (a provider or an admin passing
 *              patientUid gets their own, i.e. nothing)
 *   indexes    firestore.indexes.json carries exactly the two query shapes the code runs
 *
 *   node scripts/test-healthcare-clinical-authority.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-healthcare-clinical';
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
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
const HC = require(Path.join(FN, 'healthcare-hub.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const run = (cf) => (req) => (cf.run || cf)(req);
const req = (uid, data, claims) => ({ auth: uid ? { uid, token: Object.assign({}, claims || {}) } : null, data: data || {}, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } }
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ _id: d.id }, d.data()));
let n = 0; const rid = () => 'req_' + String(++n).padStart(6, '0');

const BK = (id, over) => db.doc('providerBookings/' + id).set(Object.assign({ providerId: 'docB', customerUid: 'pat1', commissionHub: 'healthcare', status: 'confirmed', paymentStatus: 'paid_held' }, over || {}));

(async () => {
  await db.doc('healthProviders/docB').set({ uid: 'docB', name: 'Dr B', status: 'active', specialization: 'pediatrics' });
  await db.doc('healthProviders/docX').set({ uid: 'docX', name: 'Dr X', status: 'active', specialization: 'dermatology' });
  await db.doc('healthProviders/docP').set({ uid: 'docP', name: 'Dr P', status: 'pending' });
  await BK('ok1'); await BK('ok2', { status: 'completed', paymentStatus: 'settled' });
  await BK('okP', { providerId: 'docP' });
  await BK('nonHealth', { commissionHub: 'provider' });
  await BK('pending', { status: 'pending', paymentStatus: 'pending' });
  await BK('unpaid', { status: 'confirmed', paymentStatus: 'pending' });
  await BK('cancelled', { status: 'cancelled', paymentStatus: 'refunded' });
  await BK('refunded', { status: 'completed', paymentStatus: 'refunded' });
  await BK('declined', { status: 'declined' });
  await BK('noshow', { status: 'no_show' });
  await BK('self', { customerUid: 'docB' });
  await BK('noHub', { commissionHub: null });

  for (const [label, cf, body] of [
    ['record', HC.createHealthRecord, (o) => Object.assign({ diagnosis: 'Acute otitis media', treatment: 'Amoxicillin', requestId: rid() }, o)],
    ['prescription', HC.createPrescription, (o) => Object.assign({ medications: [{ name: 'Amoxicillin', dosage: '250mg', frequency: 'tds', duration: '5d' }], requestId: rid() }, o)],
  ]) {
    say(`\n── ${label} ──`);
    const col = label === 'record' ? 'healthRecords' : 'healthPrescriptions';
    const before = (await all(col)).length; const aBefore = (await all('healthClinicalAudit')).length;
    const w = await run(cf)(req('docB', body({ bookingId: 'ok1', patientUid: 'pat2', actor: 'someone-else', auditRef: 'forged' })));
    const docs = await all(col); const made = docs.find((d) => d._id === (w.recordId || w.prescriptionId));
    ck(`${label}: the booking's provider writes for the booking's patient`, !!made && made.providerId === 'docB' && made.bookingId === 'ok1');
    ck(`${label}: arbitrary patientUid is IGNORED — it lands on the booking's patient (pat1), never pat2`, made && made.patientUid === 'pat1', made && made.patientUid);
    const audits = await all('healthClinicalAudit'); const au = audits[audits.length - 1];
    ck(`${label}: one audit row — actor from auth (not the request), patient, provider, action, ref, booking basis, time`, audits.length === aBefore + 1 && au.actor === 'docB' && au.patientUid === 'pat1' && au.providerId === 'docB' && au.action === (label === 'record' ? 'record_create' : 'prescription_create') && au.ref === col + '/' + made._id && au.basis === 'providerBookings/ok1' && au.atMs > 0, au);
    ck(`${label}: the audit carries NO clinical content`, !/otitis|amoxicillin|250mg/i.test(JSON.stringify(au)));
    const same = body({ bookingId: 'ok1' }); same.requestId = 'replay_0001';
    const r1 = await run(cf)(req('docB', same)); const r2 = await run(cf)(req('docB', same));
    ck(`${label}: a replayed request (same requestId) returns the same ${label} — one document, one more audit row only`, (r1.recordId || r1.prescriptionId) === (r2.recordId || r2.prescriptionId) && r2.idempotent === true && (await all(col)).length === before + 2 && (await all('healthClinicalAudit')).length === aBefore + 2);
    ck(`${label}: a completed + settled consultation qualifies too`, !!(await run(cf)(req('docB', body({ bookingId: 'ok2' })))));
    const REFUSE = {
      'forged provider (another provider\'s booking)': ['docX', { bookingId: 'ok1' }],
      'forged booking id': ['docB', { bookingId: 'nope' }],
      'missing booking id': ['docB', { bookingId: '' }],
      'a non-healthcare booking': ['docB', { bookingId: 'nonHealth' }],
      'a booking with no hub': ['docB', { bookingId: 'noHub' }],
      'a pending booking': ['docB', { bookingId: 'pending' }],
      'a confirmed but UNPAID booking': ['docB', { bookingId: 'unpaid' }],
      'a cancelled booking': ['docB', { bookingId: 'cancelled' }],
      'a refunded booking': ['docB', { bookingId: 'refunded' }],
      'a declined booking': ['docB', { bookingId: 'declined' }],
      'a no-show booking': ['docB', { bookingId: 'noshow' }],
      'the provider as their own patient': ['docB', { bookingId: 'self' }],
      'an unapproved provider identity (healthProviders pending)': ['docP', { bookingId: 'okP' }],
      'an unregistered provider': ['stranger', { bookingId: 'ok1' }],
      'the patient themselves': ['pat1', { bookingId: 'ok1' }],
    };
    const cBefore = (await all(col)).length; const aB2 = (await all('healthClinicalAudit')).length;
    for (const [k, [who, o]] of Object.entries(REFUSE)) {
      const c = await code(run(cf)(req(who, body(o))));
      ck(`${label}: refused — ${k}`, ['permission-denied', 'NO_CLINICAL_RELATIONSHIP', 'invalid-argument'].includes(c), c);
    }
    ck(`${label}: no refused attempt wrote a ${label} or an audit row`, (await all(col)).length === cBefore && (await all('healthClinicalAudit')).length === aB2);
    ck(`${label}: no requestId → refused (a retry could otherwise duplicate)`, await code(run(cf)(req('docB', Object.assign(body({ bookingId: 'ok1' }), { requestId: undefined })))) === 'invalid-argument');
    ck(`${label}: unauthenticated → refused`, await code(run(cf)(req(null, body({ bookingId: 'ok1' })))) === 'unauthenticated');
  }

  say('\n── reads ──');
  const own = await run(HC.getHealthRecords)(req('pat1', {}));
  ck('the patient reads their own records', own.records.length >= 3 && own.records.every((r) => r.patientUid === 'pat1'));
  ck('a provider passing patientUid reads nothing of the patient\'s (own only)', (await run(HC.getHealthRecords)(req('docB', { patientUid: 'pat1' }))).records.length === 0);
  ck('an admin passing patientUid reads nothing of the patient\'s (no unaudited admin clinical read)', (await run(HC.getHealthRecords)(req('adm1', { patientUid: 'pat1' }, { admin: true }))).records.length === 0);
  ck('another patient reads nothing of pat1\'s', (await run(HC.getHealthRecords)(req('pat2', {}))).records.length === 0);
  ck('prescriptions: own only', (await run(HC.getPrescriptions)(req('pat1', {}))).prescriptions.every((r) => r.patientUid === 'pat1') && (await run(HC.getPrescriptions)(req('docB', { patientUid: 'pat1' }))).prescriptions.length === 0);

  say('\n── indexes (verified against the real query shapes) ──');
  const SRC = fs.readFileSync(Path.join(FN, 'healthcare-hub.js'), 'utf8');
  ck('the code queries healthRecords / healthPrescriptions by patientUid == + orderBy createdAt desc', /collection\('healthRecords'\)\s*\.where\('patientUid', '==', targetUid\)\s*\.orderBy\('createdAt', 'desc'\)/.test(SRC) && /collection\('healthPrescriptions'\)\s*\.where\('patientUid', '==', uid\)\s*\.orderBy\('createdAt', 'desc'\)/.test(SRC));
  const IX = JSON.parse(fs.readFileSync(Path.join(ROOT, 'firestore.indexes.json'), 'utf8')).indexes;
  const has = (cg) => IX.filter((x) => x.collectionGroup === cg && JSON.stringify(x.fields) === JSON.stringify([{ fieldPath: 'patientUid', order: 'ASCENDING' }, { fieldPath: 'createdAt', order: 'DESCENDING' }])).length;
  ck('firestore.indexes.json has exactly one index for each of those shapes', has('healthRecords') === 1 && has('healthPrescriptions') === 1);
  ck('…and no speculative extra index on either collection', IX.filter((x) => ['healthRecords', 'healthPrescriptions', 'healthClinicalAudit'].includes(x.collectionGroup)).length === 2);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
