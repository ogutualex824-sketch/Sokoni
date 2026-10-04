#!/usr/bin/env node
/* test-healthcare-adr014-e2e.js — the ADR-014 clinic lifecycle ACROSS the real modules (owner 2026-10-04).
 *
 *   Application → AdminOS approval (applicationDecide) → canonical providers/{uid} → healthcare classification
 *   (healthAdminClassify) → discoverable: directory · profile · search · index · consultation/prescription · rating;
 *   suspension removes it everywhere; reinstatement restores it.
 *   HEALTHCARE EXCEPTION: an unmapped clinic IS approved (category later); a non-health business with an unresolved
 *   category is still REFUSED at approval.
 *   DIRECTION 2: a LEGACY healthProviders record (active there) with no canonical approval is dead on every path.
 *
 * Transactional fake Firestore + the REAL application-lifecycle, healthcare-hub, healthcare-directory, healthcare-admin,
 * reputation, discovery-eligibility and legal-agreements. No network.   node scripts/test-healthcare-adr014-e2e.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-healthcare-adr014-e2e';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs'), Path = require('path');
const ROOT = Path.resolve(__dirname, '..'), FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const CLAIMS = { adm1: { admin: true } };
const AUTH = { getUser: async (u) => ({ uid: u, customClaims: CLAIMS[u] || {} }), setCustomUserClaims: async (u, c) => { CLAIMS[u] = c; } };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => AUTH });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => AUTH, storage: () => ({ bucket: () => ({}) }), messaging: () => ({ send: async () => ({}) }) });
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const LC = require(Path.join(FN, 'application-lifecycle.js'));
const HC = require(Path.join(FN, 'healthcare-hub.js'));
const HD = require(Path.join(FN, 'healthcare-directory.js'));
const HA = require(Path.join(FN, 'healthcare-admin.js'))._adminH;
const REP = require(Path.join(FN, 'reputation.js'))._h;
const DE = require(Path.join(FN, 'discovery-eligibility.js'));
const LA = require(Path.join(FN, 'legal-agreements.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const run = (cf) => (req) => (cf.run || cf)(req);
const req = (uid, data, claims) => ({ auth: uid ? { uid, token: Object.assign({}, claims || {}) } : null, data: data || {}, rawRequest: { headers: {} } });
const ADM = { admin: true };
async function code(p) { try { await p; return null; } catch (e) { return (e.details && (e.details.code || e.details.reason)) || e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const decide = (appId, decision) => run(LC.applicationDecide)(req('adm1', { applicationId: appId, decision, reason: 'KMPDC licence checked' }, ADM));
let rx = 0; const rid = () => 'req_' + String(++rx).padStart(6, '0');
/* a regression must show as a FAIL row, never a crash (a crash proves nothing) */
const safe = async (p) => { try { return await p; } catch (e) { return { err: (e.details && (e.details.code || e.details.reason)) || e.code || e.message }; } };

/* the five public / clinical paths, asked the same question */
async function paths(uid, name, bookingId) {
  const profile = await code(run(HC.getHealthProvider)(req(null, { providerId: uid }))) === null;
  const listedHub = (await run(HC.getHealthProviders)(req(null, {}))).providers.some((p) => p.providerId === uid);
  const listedDir = (await HD.listDirectory(db, {})).some((p) => p.providerId === uid);
  const listed = listedHub && listedDir;
  const listedAny = listedHub || listedDir;
  const searched = (await run(HC.searchHealthProviders)(req(null, { query: name }))).results.some((p) => p.providerId === uid);
  const indexed = !!(await DE.prepareForIndex(db, 'providers', uid, (await get('providers/' + uid)) || {}, {}));
  let clinical = false;
  if (bookingId) { try { await run(HC.createPrescription)(req(uid, { bookingId, medications: [{ name: 'Paracetamol', dosage: '500mg', frequency: 'tds', duration: '3d' }], requestId: rid() })); clinical = true; } catch (_) { clinical = false; } }
  return { profile, listed, listedAny, searched, indexed, clinical };
}

(async () => {
  const PAST = Date.now() - 2 * 3600 * 1000;
  async function accept(uid) { for (const a of (await LA.complianceFor(uid, 'health')).required) await db.collection('legalAcceptances').doc(uid + '_' + a.agreementId).set({ userId: uid, agreementId: a.agreementId, version: a.version, accepted: true }); }
  const booking = (id, providerId) => db.doc('providerBookings/' + id).set({ providerId, customerUid: 'pat1', commissionHub: 'healthcare', status: 'completed', paymentStatus: 'settled', endTs: PAST, completedAt: PAST, service: 'Consultation' });

  /* ── 1 · approval: the healthcare exception ── */
  say('\n── 1 · approve: the healthcare category exception ──');
  await db.doc('applications/hc_A').set({ uid: 'clinicA', role: 'health', name: 'Westlands Family Clinic', category: 'clinic', city: 'Nairobi', status: 'pending', createdAt: 1 });
  await accept('clinicA');
  const dA = await safe(decide('hc_A', 'approve'));
  const pA = await get('providers/clinicA');
  ck('1a an UNMAPPED clinic ("clinic") IS approved — a missing SOKONI category never rejects a healthcare approval', !!dA && dA.ok === true, dA);
  ck('1b …and the approval creates the canonical providers/{uid} (active, healthcare.source application, category UNCLASSIFIED)',
    !!pA && pA.status === 'active' && pA.healthcare && pA.healthcare.source === 'application' && pA.healthcare.category === null, pA && { status: pA.status, healthcare: pA.healthcare });
  ck('1c …and writes NOTHING to the retired healthProviders registry', !(await get('healthProviders/clinicA')));
  await db.doc('applications/biz_X').set({ uid: 'bizX', role: 'provider', requestedRole: 'provider', name: 'Vague Co', category: 'Service Provider', status: 'pending', createdAt: 1, agreementAccepted: true, agreementVersion: 'test' });
  ck('1d CONTROL: a non-healthcare business whose category is unresolved is still REFUSED at approval (CATEGORY_UNRESOLVED)', await code(decide('biz_X', 'approve')) === 'CATEGORY_UNRESOLVED' && !(await get('providers/bizX')));

  /* ── 2 · before classification: not discoverable, but may act clinically ── */
  say('\n── 2 · approved, not yet classified ──');
  await booking('bkA', 'clinicA');
  const p2 = await paths('clinicA', 'westlands', 'bkA');
  ck('2a not discoverable before classification (profile / directory / search / index all refuse)', !p2.profile && !p2.listed && !p2.searched && !p2.indexed, p2);
  ck('2b …but the approved clinic CAN prescribe for its paid, completed consultation (classification gates discovery only)', p2.clinical === true, p2);

  /* ── 3 · classification → discoverable everywhere ── */
  say('\n── 3 · AdminOS classifies the clinic ──');
  const cr = await safe(HA.healthAdminClassify(req('adm1', { uid: 'clinicA', category: 'clinician', reason: 'General outpatient clinic, KMPDC checked' }, ADM)));
  const p3 = await paths('clinicA', 'westlands', 'bkA');
  ck('3a classification makes the canonical clinic discoverable: profile loads, directory lists it, search finds it, the index admits it',
    !!cr && p3.profile && p3.listed && p3.searched && p3.indexed, p3);
  const card = await safe(run(HC.getHealthProvider)(req(null, { providerId: 'clinicA' })));
  ck('3b the profile is the canonical directory card (category clinician; no private field)', !card.err && card.category === 'clinician' && Object.keys(card).every((k) => HD.PUBLIC_FIELDS.includes(k)), card);
  ck('3c the prescription check finds the classified clinic', p3.clinical === true);

  /* ── 4 · rating attaches to the canonical provider ── */
  say('\n── 4 · rating ──');
  const rv = await safe(REP.repSubmitReview(req('pat1', { bookingId: 'bkA', rating: 5, text: 'Very thorough' })));
  const pR = (await get('providers/clinicA')) || {};
  const card2 = await safe(run(HC.getHealthProvider)(req(null, { providerId: 'clinicA' })));
  ck('4a a verified review of the consultation aggregates onto the CANONICAL providers/{uid} (the ONE review authority)', !!rv && rv.created === true && pR.reviewCount === 1 && pR.rating === 5 && !!pR.repV, rv);
  ck('4b …and the public card shows it; nothing touched healthProviders', card2.rating === 5 && card2.reviewCount === 1 && !(await get('healthProviders/clinicA')), card2);
  ck('4c the retired healthAppointments rating path writes nothing', await code(run(HC.rateHealthProvider)(req('pat1', { appointmentId: 'x', rating: 4 }))) === 'HEALTH_RATING_MOVED');

  /* ── 5 · suspension → gone everywhere; reinstatement → back ── */
  say('\n── 5 · suspend / reinstate ──');
  await safe(decide('hc_A', 'suspend'));
  const p5 = await paths('clinicA', 'westlands', 'bkA');
  ck('5a SUSPENDED: profile, directory, search, index AND prescriptions all refuse', !p5.profile && !p5.listed && !p5.searched && !p5.indexed && !p5.clinical, p5);
  await safe(decide('hc_A', 'approve'));
  const p6 = await paths('clinicA', 'westlands', 'bkA');
  ck('5b REINSTATED: everything is restored — and the admin classification survived', p6.profile && p6.listed && p6.searched && p6.indexed && p6.clinical && ((await get('providers/clinicA')) || { healthcare: {} }).healthcare.category === 'clinician', p6);

  /* ── 6 · DIRECTION 2: a legacy healthProviders record is dead on every path ── */
  say('\n── 6 · legacy healthProviders record, no canonical approval ──');
  await db.doc('healthProviders/legacyL').set({ providerId: 'legacyL', uid: 'legacyL', name: 'Legacy Medical Centre', specialization: 'pediatrics', status: 'active', city: 'Nairobi', rating: 4.9 });
  await booking('bkL', 'legacyL');
  const pL = await paths('legacyL', 'legacy', 'bkL');
  ck('6a LEGACY: not on the profile, directory, search, index, and cannot prescribe (the old activation path is dead)', !pL.profile && !pL.listedAny && !pL.searched && !pL.indexed && !pL.clinical, pL);
  ck('6b LEGACY: the search index refuses the legacy collection itself', !(await DE.prepareForIndex(db, 'healthProviders', 'legacyL', await get('healthProviders/legacyL'), {})));
  await REP.repSubmitReview(req('pat1', { bookingId: 'bkL', rating: 5 })).catch(() => null);
  const pLr = await paths('legacyL', 'legacy', null);
  ck('6c LEGACY: even a rating cannot make it active or discoverable', !pLr.profile && !pLr.listedAny && !pLr.searched && !pLr.indexed && !HD.canOperate(await get('providers/legacyL')), pLr);

  /* ── 6d · the clinical identity is exactly an approved, unsuspended HEALTHCARE canonical record ── */
  await db.doc('providers/plumbN').set({ uid: 'plumbN', name: 'Plumber N', status: 'active', business: { category: 'trades', source: 'application' } });
  await db.doc('providers/flagS').set({ uid: 'flagS', name: 'Dr Flagged', status: 'active', suspended: true, healthcare: { category: 'clinician', source: 'application' } });
  await db.doc('providers/selfH').set({ uid: 'selfH', name: 'Dr Self', status: 'active', healthcare: { category: 'clinician', source: 'owner' } });
  await booking('bkN', 'plumbN'); await booking('bkS', 'flagS'); await booking('bkH', 'selfH');
  const pn = await paths('plumbN', 'plumber', 'bkN'), ps = await paths('flagS', 'flagged', 'bkS'), ph = await paths('selfH', 'self', 'bkH');
  ck('6d an active NON-healthcare provider cannot prescribe (no server healthcare record)', !pn.clinical, pn);
  ck('6e an active record carrying suspended:true cannot prescribe, and is not discoverable', !ps.clinical && !ps.profile && !ps.listedAny, ps);
  ck('6f a self-declared healthcare record (source owner, not application/admin) cannot prescribe', !ph.clinical, ph);

  /* ── 7 · no consumer keeps a healthProviders dependency ── */
  say('\n── 7 · static: every consumer reads the canonical record ──');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const hub = strip(fs.readFileSync(Path.join(FN, 'healthcare-hub.js'), 'utf8'));
  ck('7a healthcare-hub has NO healthProviders read or write', !/healthProviders/.test(hub));
  const search = strip(fs.readFileSync(Path.join(ROOT, 'sokoni-firestore-search.js'), 'utf8'));
  ck('7b the browser search scans no healthProviders collection', !/col:\s*'healthProviders'/.test(search));
  const bf = fs.readFileSync(Path.join(FN, 'scripts', 'algolia-backfill.js'), 'utf8');
  ck('7c the operator backfill never indexes a collection the discovery gate DEINDEXES (healthProviders included)', !/col:\s*'healthProviders'/.test(strip(bf)) && /DEINDEXED\.includes\(entry\.col\)/.test(bf));
  ck('7d no page loads the legacy client module sokoni-health.js', !fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).some((f) => /sokoni-health\.js/.test(fs.readFileSync(Path.join(ROOT, f), 'utf8'))));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
