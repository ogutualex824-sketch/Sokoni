/* test-healthcare-public-projection.js — what the public may learn about a healthcare provider (CHANGELOG 224,
 * Healthcare security slice 4). Fake Firestore + the REAL functions/healthcare-hub.js.
 *
 * PROVES
 *   - getHealthProvider returns ONLY the public whitelist — for a logged-out caller, a patient, the provider
 *     themselves, an admin and a malicious provider alike — never the licence number, phone, street address,
 *     reviewer, review notes, timestamps or internal counters
 *   - getHealthProviders and searchHealthProviders return the SAME whitelist (one projection, not three)
 *   - an unapproved (pending) provider is not found; malformed ids (empty, path, object, over-long, number) are
 *     refused before Firestore
 *   - the projection claims only what the server knows, never a council verification (ADR-014: the canonical directory card)
 *   - a LEGACY healthProviders record without canonical approval is not found, listed or searchable
 *
 *   node scripts/test-healthcare-public-projection.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-healthcare-projection';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const FN = Path.join(Path.resolve(__dirname, '..'), 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
const HC = require(Path.join(FN, 'healthcare-hub.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const run = (cf) => (req) => (cf.run || cf)(req);
const req = (uid, data, claims) => ({ auth: uid ? { uid, token: Object.assign({}, claims || {}) } : null, data: data === undefined ? {} : data, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }

const PRIVATE = { licenseNumber: 'KMPDC-A1234', phone: '0722111222', address: '14 Private Lane, Karen', reviewedBy: 'adm1', reviewNotes: 'licence copy on file',
  email: 'dr@x.co', uid: 'docB', totalAppointments: 12, completedAppointments: 9, createdAt: 1, updatedAt: 2, internalNote: 'x', idNumber: '12345678' };
/* ADR-014 (owner 2026-10-04): ONE public shape — the canonical healthcare directory card (healthcare-directory.publicCard) */
const WHITELIST = ['providerId', 'name', 'category', 'categoryLabel', 'description', 'city', 'area', 'rating', 'reviewCount', 'acceptsBookings'];
const leak = (o) => Object.keys(o).filter((k) => !WHITELIST.includes(k));
const secretIn = (o) => /KMPDC-A1234|0722111222|Private Lane|licence copy|12345678|dr@x\.co/.test(JSON.stringify(o));

(async () => {
  /* the canonical provider an AdminOS approval projects (ADR-014), with private fields that must never leak */
  await db.doc('providers/docB').set(Object.assign({ uid: 'docB', providerId: 'docB', name: 'Dr Wanjiru', businessName: 'Dr Wanjiru', description: 'Child health', city: 'Nairobi', area: 'Kilimani',
    status: 'active', healthcare: { category: 'clinician', source: 'application' } }, PRIVATE));
  await db.doc('providers/docP').set({ uid: 'docP', name: 'Dr Pending', status: 'pending', licenseNumber: 'KMPDC-P', healthcare: { category: 'clinician', source: 'application' } });
  await db.doc('providers/docU').set({ uid: 'docU', name: 'Unclassified Clinic', status: 'active', healthcare: { category: null, source: 'application' } });
  /* DIRECTION 2: a LEGACY healthProviders record — active there — with NO canonical approval */
  await db.doc('healthProviders/docL').set({ providerId: 'docL', name: 'Dr Legacy', specialization: 'pediatrics', status: 'active', city: 'Nairobi' });

  say('\n── getHealthProvider — one public projection for every caller ──');
  const callers = { 'logged out': [null, {}], 'a patient': ['pat1', {}], 'the provider themselves': ['docB', {}], 'an admin': ['adm1', { admin: true }], 'a malicious provider': ['docX', { role: 4 }] };
  for (const [label, [uid, claims]] of Object.entries(callers)) {
    const r = await run(HC.getHealthProvider)(req(uid, { providerId: 'docB' }, claims));
    ck(`${label}: only whitelisted fields`, leak(r).length === 0, leak(r));
    ck(`${label}: no licence number / phone / address / reviewer / notes / id number anywhere`, !secretIn(r));
  }
  const one = await run(HC.getHealthProvider)(req(null, { providerId: 'docB' }));
  ck('the public fields that ARE intended are present (canonical card: name, healthcare category + label, description, city, area)', one.name === 'Dr Wanjiru' && one.category === 'clinician' && !!one.categoryLabel && one.description === 'Child health' && one.city === 'Nairobi' && one.area === 'Kilimani', one);
  ck('the card claims no verification it does not hold — no council (KMPDC/PPB) or "verified" field; rating only from the review authority (none yet → null)', one.verified === undefined && one.kmpdcVerified === undefined && one.rating === null && one.reviewCount === 0, one);
  ck('the whitelist the code exports is exactly the documented one', JSON.stringify(HC.PUBLIC_PROVIDER_FIELDS) === JSON.stringify(WHITELIST), HC.PUBLIC_PROVIDER_FIELDS);

  say('\n── list + search use the same projection ──');
  const list = await run(HC.getHealthProviders)(req(null, {}));
  ck('getHealthProviders: only whitelisted fields, no secrets', list.providers.length === 1 && list.providers.every((p) => leak(p).length === 0 && !secretIn(p)));
  ck('…and only approved providers', !list.providers.some((p) => p.providerId === 'docP'));
  const s = await run(HC.searchHealthProviders)(req(null, { query: 'wanjiru' }));
  ck('searchHealthProviders: only whitelisted fields, no secrets', s.results.length === 1 && s.results.every((p) => leak(p).length === 0 && !secretIn(p)));

  say('\n── refusals ──');
  ck('an unapproved (pending) provider is not found', await code(run(HC.getHealthProvider)(req(null, { providerId: 'docP' }))) === 'not-found');
  ck('LEGACY: an active healthProviders record WITHOUT canonical approval is not found (the old activation path is dead)', await code(run(HC.getHealthProvider)(req(null, { providerId: 'docL' }))) === 'not-found');
  ck('LEGACY: …nor listed, nor searchable', !(await run(HC.getHealthProviders)(req(null, {}))).providers.some((p) => p.providerId === 'docL') && (await run(HC.searchHealthProviders)(req(null, { query: 'legacy' }))).results.length === 0);
  ck('an approved but UNCLASSIFIED clinic is not yet discoverable (classification → evaluator → discoverable)', await code(run(HC.getHealthProvider)(req(null, { providerId: 'docU' }))) === 'not-found');
  ck('a retired registry write path answers plainly and writes nothing (registerHealthProvider / rateHealthProvider)',
    await code(run(HC.registerHealthProvider)(req('docZ', { name: 'X', specialization: 'pediatrics', licenseNumber: 'L' }))) === 'failed-precondition'
    && await code(run(HC.rateHealthProvider)(req('pat1', { appointmentId: 'a1', rating: 5 }))) === 'failed-precondition'
    && !(await db.doc('healthProviders/docZ').get()).exists);
  ck('an unknown provider is not found', await code(run(HC.getHealthProvider)(req(null, { providerId: 'nobody' }))) === 'not-found');
  for (const [label, v] of [['empty', ''], ['a path', 'healthProviders/docB'], ['a traversal', '../docB'], ['an object', { id: 'docB' }], ['a number', 42], ['over-long', 'x'.repeat(300)], ['missing', undefined]]) {
    ck(`malformed providerId (${label}) refused before Firestore`, await code(run(HC.getHealthProvider)(req(null, { providerId: v }))) === 'invalid-argument');
  }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
