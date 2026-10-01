#!/usr/bin/env node
'use strict';
/* ============================================================================
   financialPartnerDispatch — the approved partner's workspace (banks, SACCOs, chamas, …)
   Real handler via .run on the in-memory Firestore fake.
     A  gate: signed out / not a partner / pending or suspended listing → refused; approved → served
     B  category drives the tools: SACCO gets Members; forex gets Rates and NO members
     C  member register: consent required, phone is the unique key (create()), import reports per row,
        officer cannot delete, manager can, erasure really deletes
     D  registration: partner can only reach 'under_review'; only an admin verifies; public profile
        shows 'verified' only after the admin verdict
     E  team: owner adds an officer by email; the officer works the SAME partner; officer cannot add team
     F  enquiries: signed-in user → only that partner sees it; consent required; pair limit holds
     G  isolation: partner B can never read or touch partner A's members / enquiries
     H  counts come from aggregates; a count that cannot be read is null (renders —), never 0
   node scripts/test-financial-partner-workspace.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); } };

const F = makeFakeFirestore();
const USERS = { 'officer@x.ke': 'staff1', 'mgr@x.ke': 'staff2', 'other@x.ke': 'staff3' };
const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: {
  apps: [1], initializeApp() {}, firestore: ff,
  auth: () => ({ getUserByEmail: async (e) => { if (!USERS[e]) { const x = new Error('no user'); x.code = 'auth/user-not-found'; throw x; } return { uid: USERS[e], email: e }; } }),
} };
const M = require(path.join(FN, 'financial-partner.js'));
let ip = 0;
async function call(uid, data, token = {}) {
  ip++;
  try { return { ok: true, v: await M.financialPartnerDispatch.run({ auth: uid ? { uid, token } : null, data, rawRequest: { headers: { 'x-forwarded-for': '10.0.0.' + (ip % 250) } } }) }; }
  catch (e) { return { ok: false, code: e.code, msg: e.message, det: e.details }; }
}
const keys = (pre) => [...F.db._store.keys()].filter((k) => k.startsWith(pre));

(async () => {
  console.log('financialPartnerDispatch — partner workspace\n');
  const prov = (uid, type, status) => F.db.collection('financialProviders').doc(uid).set({ name: uid.toUpperCase(), institutionType: type, listingStatus: status });
  await prov('saccoA', 'SACCO', 'approved');
  /* saccoA holds a paid Growth plan (5 staff); fxB stays on the free base */
  await F.db.collection('entitlements').doc('saccoA__partner').set({ status: 'active', planId: 'growth', expiresAt: F.Timestamp.fromMillis(Date.now() + 10 * 86400000) });
  await prov('fxB', 'FOREX', 'approved');
  await prov('pend', 'BANK', 'pending');
  await prov('susp', 'CHAMA', 'withdrawn');

  /* A */
  const a1 = await call(null, { op: 'getWorkspace' });
  const a2 = await call('nobody', { op: 'getWorkspace' });
  const a3 = await call('pend', { op: 'getWorkspace' });
  const a4 = await call('susp', { op: 'addMember', name: 'X', phone: '0712345678', consentAttested: true });
  ck('A1 signed out → unauthenticated; not a partner → NOT_A_PARTNER; pending/suspended → PARTNER_NOT_APPROVED',
    a1.code === 'unauthenticated' && a2.code === 'permission-denied' && a2.det.code === 'NOT_A_PARTNER'
    && a3.det && a3.det.code === 'PARTNER_NOT_APPROVED' && a4.det && a4.det.code === 'PARTNER_NOT_APPROVED', { a1, a2, a3, a4 });
  ck('A2 refused calls wrote nothing', keys('financialPartners/').length === 0);

  /* B */
  const b1 = await call('saccoA', { op: 'getWorkspace' });
  const b2 = await call('fxB', { op: 'getWorkspace' });
  ck('B1 SACCO workspace: Members module, SASRA regulator, owner role', b1.ok && b1.v.role === 'owner' && b1.v.config.modules.includes('members') && b1.v.config.memberLabel === 'Members' && b1.v.config.regulators[0] === 'SASRA', b1);
  ck('B2 forex workspace: Rates, NO members module', b2.ok && b2.v.config.productLabel === 'Rates' && !b2.v.config.modules.includes('members'), b2.v && b2.v.config);
  const b3 = await call('fxB', { op: 'addMember', name: 'X', phone: '0712345678', consentAttested: true });
  ck('B3 forex cannot keep a member register (failed-precondition)', !b3.ok && b3.code === 'failed-precondition', b3);
  const b4 = await call('fxB', { op: 'saveProduct', kind: 'rate', name: 'USD', currency: 'USD', buy: 128.5, sell: 131.2, status: 'published' });
  const b5 = await call('fxB', { op: 'saveProduct', kind: 'rate', name: 'EUR', currency: 'EUR', buy: 140 });
  ck('B4 forex rate saved with buy+sell; a rate missing sell is refused', b4.ok && !b5.ok && b5.code === 'invalid-argument', { b4, b5 });

  /* C */
  const c1 = await call('saccoA', { op: 'addMember', name: 'Wanjiru', phone: '0712345678' });
  ck('C1 no consent attestation → refused', !c1.ok && c1.code === 'invalid-argument');
  const c2 = await call('saccoA', { op: 'addMember', name: 'Wanjiru <b>K</b>', phone: '+254 712 345 678', memberNo: 'S-001', joinedOn: '2025-02-01', consentAttested: true });
  const c3 = await call('saccoA', { op: 'addMember', name: 'Someone else', phone: '0712345678', consentAttested: true });
  const mem = c2.ok ? (await F.db.collection('financialPartners').doc('saccoA').collection('members').doc(c2.v.id).get()).data() : null;
  ck('C2 member saved: phone normalised to 2547…, markup stripped, consent recorded', c2.ok && mem && mem.phone === '254712345678' && !/[<>]/.test(mem.name) && mem.consentAttested === true && mem.status === 'active', mem);
  ck('C3 same phone again → DUPLICATE_MEMBER (create(), no overwrite)', !c3.ok && c3.code === 'already-exists' && mem.name.startsWith('Wanjiru'), c3);
  const c4 = await call('saccoA', { op: 'importMembers', consentAttested: true, rows: [
    { name: 'Otieno', phone: '0722000001' }, { name: 'Dup', phone: '0712345678' }, { name: 'Bad', phone: '12345' }, { name: 'Akinyi', phone: '0111000002', memberNo: 'S-003' }] });
  ck('C4 import: 2 added, duplicate and bad phone reported per row', c4.ok && c4.v.added === 2 && c4.v.failed === 2 && /Already/.test(c4.v.results[1].reason) && /Kenyan phone/.test(c4.v.results[2].reason), c4);
  const c5 = await call('saccoA', { op: 'importMembers', consentAttested: true, rows: Array.from({ length: 201 }, () => ({})) });
  ck('C5 import over 200 rows refused', !c5.ok && c5.code === 'invalid-argument');
  const c6 = await call('saccoA', { op: 'listMembers' });
  const c7 = await call('saccoA', { op: 'listMembers', phone: '0722000001' });
  ck('C6 list returns 3 members; phone lookup finds exactly one', c6.ok && c6.v.rows.length === 3 && c7.ok && c7.v.rows.length === 1 && c7.v.rows[0].name === 'Otieno', { c6, c7 });

  /* E — team (needed for officer/manager checks) */
  const e0 = await call('saccoA', { op: 'addTeamMember', email: 'nobody@x.ke', role: 'officer' });
  const e1 = await call('saccoA', { op: 'addTeamMember', email: 'officer@x.ke', role: 'officer' });
  const e2 = await call('saccoA', { op: 'addTeamMember', email: 'mgr@x.ke', role: 'manager' });
  ck('E1 owner adds an officer and a manager; unknown email → NO_ACCOUNT', e1.ok && e2.ok && !e0.ok && e0.det.code === 'NO_ACCOUNT', { e0, e1, e2 });
  const e3 = await call('staff1', { op: 'getWorkspace' });
  ck('E2 the officer opens the SAME partner workspace as officer', e3.ok && e3.v.partnerUid === 'saccoA' && e3.v.role === 'officer', e3);
  const e4 = await call('staff1', { op: 'addTeamMember', email: 'other@x.ke', role: 'officer' });
  const e5 = await call('staff2', { op: 'submitRegistration', regulator: 'SASRA', registeredName: 'X', registrationNumber: '1' });
  ck('E3 officer cannot add team; manager cannot submit registration', !e4.ok && e4.code === 'permission-denied' && !e5.ok && e5.code === 'permission-denied', { e4, e5 });
  const e6 = await call('fxB', { op: 'addTeamMember', email: 'officer@x.ke', role: 'officer' });
  ck('E4 a staff member of one partner cannot be claimed by another', !e6.ok && e6.code === 'already-exists', e6);

  const cOff = await call('staff1', { op: 'deleteMember', id: c2.v.id });
  ck('C7 officer cannot delete a member', !cOff.ok && cOff.code === 'permission-denied', cOff);
  const cSusp = await call('staff1', { op: 'updateMember', id: c2.v.id, status: 'suspended' });
  ck('C8 officer can suspend a member', cSusp.ok && (await F.db.collection('financialPartners').doc('saccoA').collection('members').doc(c2.v.id).get()).data().status === 'suspended', cSusp);
  const cDel = await call('staff2', { op: 'deleteMember', id: c2.v.id });
  ck('C9 manager deletes (erasure): record gone, audit keeps only the id', cDel.ok && !(await F.db.collection('financialPartners').doc('saccoA').collection('members').doc(c2.v.id).get()).exists
    && keys('financialPartners/saccoA/audit/').map((k) => F.db._store.get(k).data).every((a) => !JSON.stringify(a).includes('2547')), cDel);

  /* D */
  const d1 = await call('saccoA', { op: 'submitRegistration', regulator: 'CBK', registeredName: 'A', registrationNumber: '1' });
  const d2 = await call('saccoA', { op: 'submitRegistration', regulator: 'SASRA', registeredName: 'Sacco A Ltd', registrationNumber: 'SASRA/DT/123', kraPin: 'p051234567z', validUntil: '2027-12-31', status: 'verified' });
  const reg = (await F.db.collection('financialPartners').doc('saccoA').get()).data().registration;
  ck('D1 wrong regulator for category refused; submission lands as under_review even if the client says verified', !d1.ok && d2.ok && reg.status === 'under_review' && reg.kraPin === 'P051234567Z', { d1, reg });
  const d3 = await call('saccoA', { op: 'publicProfile', partnerUid: 'saccoA' });
  ck('D2 public profile before review shows self_declared, not verified', d3.ok && d3.v.registration.status === 'self_declared', d3.v && d3.v.registration);
  const d4 = await call('saccoA', { op: 'adminReviewRegistration', partnerUid: 'saccoA', verdict: 'verified' });
  const d5 = await call('admin1', { op: 'adminListRegistrations' }, { admin: true });
  const d6 = await call('admin1', { op: 'adminReviewRegistration', partnerUid: 'saccoA', verdict: 'verified' }, { admin: true });
  const d7 = await call('anyone', { op: 'publicProfile', partnerUid: 'saccoA' });
  ck('D3 partner cannot self-verify; admin lists the queue and reviews; the PUBLIC profile still says self_declared (a paperwork review is not a licence confirmation)', !d4.ok && d4.code === 'permission-denied' && d5.ok && d5.v.rows.length === 1 && d6.ok && (await F.db.collection('financialPartners').doc('saccoA').get()).data().registration.status === 'verified' && d7.ok && d7.v.registration.status === 'self_declared' && !('registrationNumber' in d7.v.registration) && keys('adminActions/').length === 1, { d4, d5, d6, d7: d7.v && d7.v.registration });
  const d8 = await call('admin1', { op: 'adminReviewRegistration', partnerUid: 'saccoA', verdict: 'rejected', note: 'x' }, { admin: true });
  ck('D4 a second review of a decided registration is refused', !d8.ok && d8.code === 'failed-precondition', d8);
  const d9 = await call('anyone', { op: 'publicProfile', partnerUid: 'pend' });
  ck('D5 public profile of a non-approved listing → not-found', !d9.ok && d9.code === 'not-found');

  /* F */
  const f0 = await call(null, { op: 'submitEnquiry', partnerUid: 'saccoA', name: 'B', phone: '0733000000', topic: 'Loan', message: 'Hi', consent: true });
  const f1 = await call('buyer1', { op: 'submitEnquiry', partnerUid: 'saccoA', name: 'B', phone: '0733000000', topic: 'Loan', message: 'Hi' });
  const f2 = await call('buyer1', { op: 'submitEnquiry', partnerUid: 'saccoA', name: 'B', phone: '0733000000', topic: 'Loan', message: 'Hi', consent: true });
  const f3 = await call('buyer1', { op: 'submitEnquiry', partnerUid: 'pend', name: 'B', phone: '0733000000', topic: 'Loan', message: 'Hi', consent: true });
  ck('F1 enquiry: signed out refused, no consent refused, valid accepted, non-approved partner not-found', !f0.ok && !f1.ok && f2.ok && !f3.ok && f3.code === 'not-found', { f0, f1, f2, f3 });
  await call('buyer1', { op: 'submitEnquiry', partnerUid: 'saccoA', name: 'B', phone: '0733000000', topic: 'L', message: 'Hi', consent: true });
  await call('buyer1', { op: 'submitEnquiry', partnerUid: 'saccoA', name: 'B', phone: '0733000000', topic: 'L', message: 'Hi', consent: true });
  const f4 = await call('buyer1', { op: 'submitEnquiry', partnerUid: 'saccoA', name: 'B', phone: '0733000000', topic: 'L', message: 'Hi', consent: true });
  ck('F2 the 4th enquiry to the same partner in a day is rate-limited', !f4.ok && f4.code === 'resource-exhausted', f4);
  const f5 = await call('staff1', { op: 'listEnquiries' });
  ck('F3 the partner\'s officer sees the 3 enquiries', f5.ok && f5.v.rows.length === 3, f5);

  /* G */
  const g1 = await call('fxB', { op: 'listEnquiries' });
  const g2 = await call('fxB', { op: 'updateEnquiry', id: f2.v.id, status: 'closed' });
  const g3 = await call('fxB', { op: 'updateMember', id: c4.v && 'p_x', status: 'exited' });
  ck('G1 another partner sees none of them and cannot close one (not-found)', g1.ok && g1.v.rows.length === 0 && !g2.ok && g2.code === 'not-found', { g1, g2 });
  ck('G2 another partner cannot touch a member id it does not hold', !g3.ok, g3);

  /* P — public profile edits write sokoni-27's listing through ITS validator, EDITABLE_KEYS only */
  const FPL = require(path.join(FN, 'financial-partner-listing.js'));
  await F.db.collection('financialProviders').doc('saccoA').set({ uid: 'saccoA', name: 'SACCOA', institutionType: 'SACCO', services: ['SAVINGS'], description: 'old', website: 'https://old.example.ke/', licenceVerified: false, verifiedBy: 'sokoni_admin_review', listingStatus: 'approved', applicationId: 'saccoA--financial_partner' });
  const p1 = await call('saccoA', { op: 'updateProfile', description: 'We serve <b>teachers</b>', services: ['savings', 'LOANS', 'NOT_A_SERVICE'], county: 'nairobi', businessPhone: '0712 000 111', businessEmail: 'Info@SaccoA.co.ke', branches: ['Kisumu'], hours: 'Mon–Fri 8–5', name: 'HIJACK', institutionType: 'BANK', listingStatus: 'approved', licenceVerified: true });
  const L = (await F.db.collection('financialProviders').doc('saccoA').get()).data();
  ck('P1 listing updated through validateDescriptive: services normalised, county canonical, phone E.164, markup stripped',
    p1.ok && JSON.stringify(L.services) === '["SAVINGS","LOANS"]' && L.county === 'Nairobi' && L.businessPhone === '+254712000111' && L.businessEmail === 'info@saccoa.co.ke' && !/[<>]/.test(L.description), { p1, L });
  ck('P2 identity untouched (name, type, licenceVerified); cleared website removed; keys ⊆ PUBLIC_KEYS',
    L.name === 'SACCOA' && L.institutionType === 'SACCO' && L.licenceVerified === false && L.website === undefined && Object.keys(L).every((k) => FPL.PUBLIC_KEYS.includes(k)), L);
  const ws = (await F.db.collection('financialPartners').doc('saccoA').get()).data();
  ck('P3 branches/hours kept on the workspace doc, not on the listing', ws.profile.branches[0] === 'Kisumu' && ws.profile.hours && L.branches === undefined && L.hours === undefined, ws.profile);
  const p2 = await call('saccoA', { op: 'updateProfile', services: ['SAVINGS'], website: 'http://insecure.example.ke' });
  const p3 = await call('saccoA', { op: 'updateProfile', services: ['NOPE'] });
  ck('P4 an invalid optional field is refused by name (never silently dropped); no valid service refused', !p2.ok && /Website/.test(p2.msg) && !p3.ok && p3.code === 'invalid-argument', { p2, p3 });
  const p4 = await call('staff1', { op: 'updateProfile', services: ['SAVINGS'] });
  ck('P5 an officer cannot edit the public profile', !p4.ok && p4.code === 'permission-denied', p4);
  await F.db.collection('financialProviders').doc('advX').set({ name: 'ADVX', institutionType: 'FINANCIAL_ADVISER', listingStatus: 'approved' });
  await F.db.collection('financialProviders').doc('othY').set({ name: 'OTHY', institutionType: 'other', listingStatus: 'approved' });
  await F.db.collection('financialProviders').doc('badZ').set({ name: 'BADZ', institutionType: 'casino', listingStatus: 'approved' });
  const q1 = await call('advX', { op: 'getWorkspace' }), q2 = await call('othY', { op: 'getWorkspace' }), q3 = await call('badZ', { op: 'getWorkspace' });
  ck('P6 every INSTITUTION_TYPES value has a sidebar; an unknown type is refused, not guessed',
    FPL.INSTITUTION_TYPES.every((t) => M._test.CATEGORIES[t]) && q1.ok && q1.v.category === 'FINANCIAL_ADVISER' && q2.ok && q2.v.category === 'OTHER' && !q3.ok && q3.det.code === 'UNKNOWN_CATEGORY', { q1: q1.v && q1.v.category, q2: q2.v && q2.v.category, q3 });
  await F.db.collection('financialProviders').doc('saccoA').update({ listingStatus: 'withdrawn' });
  const p5 = await call('saccoA', { op: 'getWorkspace' });
  await F.db.collection('financialProviders').doc('saccoA').update({ listingStatus: 'approved' });
  ck('P7 a withdrawn listing closes the workspace (PARTNER_NOT_APPROVED, status reported)', !p5.ok && p5.det.code === 'PARTNER_NOT_APPROVED' && p5.det.listingStatus === 'withdrawn', p5);

  /* R — Banking Hub directory + promotion (no money; admin decides; promotion ranks, never vouches) */
  await F.db.collection('financialProviders').doc('bankQ').set({ name: 'Q Bank', institutionType: 'BANK', listingStatus: 'approved', services: ['LOANS'], licenceVerified: false });
  await F.db.collection('financialProviders').doc('bankW').set({ name: 'W Bank (withdrawn)', institutionType: 'BANK', listingStatus: 'withdrawn' });
  const r1 = await call(null, { op: 'publicDirectory', types: ['bank', 'SACCO'] });
  const names = r1.ok ? r1.v.rows.map((x) => x.name) : [];
  ck('R1 directory (signed out OK): approved BANK + SACCO only, withdrawn/pending hidden, every row "Listed by SOKONI"',
    r1.ok && names.includes('Q Bank') && names.includes('SACCOA') && !names.some((n) => /withdrawn/.test(n)) && !names.includes('PEND') && r1.v.rows.every((x) => x.label === 'Listed by SOKONI' && !('licenceVerified' in x)), r1);
  const r2 = await call(null, { op: 'publicDirectory', types: [] });
  ck('R2 directory needs 1–10 known types', !r2.ok && r2.code === 'invalid-argument');
  const r3 = await call('saccoA', { op: 'requestPromotion', placement: 'banking_hub_category', message: 'New savings product' });
  const r4 = await call('staff1', { op: 'requestPromotion', placement: 'banking_hub_category' });
  const r5 = await call('saccoA', { op: 'requestPromotion', placement: 'homepage_takeover' });
  ck('R3 owner requests a promotion (pending, no money); officer cannot; unknown placement refused', r3.ok && r3.v.status === 'pending' && !r4.ok && r4.code === 'permission-denied' && !r5.ok, { r3, r4, r5 });
  const r6 = await call('saccoA', { op: 'adminDecidePromotion', id: r3.v.id, verdict: 'granted', days: 30 });
  const r7 = await call('admin1', { op: 'adminDecidePromotion', id: r3.v.id, verdict: 'granted', days: 365 }, { admin: true });
  const r8 = await call('admin1', { op: 'adminDecidePromotion', id: r3.v.id, verdict: 'granted', days: 14 }, { admin: true });
  const r9 = await call('admin1', { op: 'adminDecidePromotion', id: r3.v.id, verdict: 'granted', days: 14 }, { admin: true });
  ck('R4 a partner cannot grant itself; >90 days refused; admin grants once (second grant refused)', !r6.ok && r6.code === 'permission-denied' && !r7.ok && r8.ok && r8.v.promotionId && !r9.ok && r9.code === 'failed-precondition', { r6, r7, r8, r9 });
  const promoDoc = (await F.db.collection('financialPromotions').doc(r8.v.promotionId).get()).data();
  const r10 = await call(null, { op: 'publicDirectory', types: ['BANK', 'SACCO'] });
  const L2 = (await F.db.collection('financialProviders').doc('saccoA').get()).data();
  ck('R5 granted promotion: paid:false, dated; listing shown FIRST and marked promoted; listingStatus/licenceVerified untouched',
    promoDoc.paid === false && promoDoc.status === 'active' && r10.v.rows[0].partnerUid === 'saccoA' && r10.v.rows[0].promoted === true && r10.v.rows[0].label === 'Listed by SOKONI' && L2.listingStatus === 'approved' && L2.licenceVerified === false, { first: r10.v.rows[0], promoDoc });
  const r11 = await call('saccoA', { op: 'listMyPromotions' });
  ck('R6 partner sees its request (granted) and its live promotion', r11.ok && r11.v.requests[0].status === 'granted' && r11.v.promotions.length === 1, r11.v);

  /* H */
  const h1 = await call('saccoA', { op: 'getWorkspace' });
  ck('H1 counts are aggregates: 2 members, 2 active (one deleted), 3 new enquiries', h1.ok && h1.v.counts.members === 2 && h1.v.counts.activeMembers === 2 && h1.v.counts.newEnquiries === 3, h1.v && h1.v.counts);
  ck('H2 forex has no member count (null → renders —, not 0)', b2.v.counts.members === null && b2.v.counts.activeMembers === null, b2.v.counts);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
