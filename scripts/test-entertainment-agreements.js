/* test-entertainment-agreements.js — Entertainment agreements on the canonical legal authority
 * (legal-agreements.js legalAccept / complianceFor / assertLegalCompliance). Fake Firestore; no network.
 *
 * PROVES
 *   Catalogue   event_organizer: organizer agreement, ticketing & refund obligations, staff & cash
 *               handling, commission, settlement, data processing · creator: content, ownership,
 *               royalty, data · venue_owner: listing · every entertainment agreement links to a REAL
 *               anchor in entertainment-terms.html · key points state implemented rules (3 %, 30/70)
 *   Acceptance  signature required · organizers must accept the Professional Declaration · only the
 *               CURRENT version is accepted · the record carries version, uid, time, signature hash,
 *               server-captured user-agent
 *   Approval    an organizer application with the client boolean agreementAccepted:true but NO
 *               acceptances is REFUSED · with acceptances it is approved and the role granted
 *   Versioning  a new agreement version makes the organizer non-compliant again (approval refused)
 *               while the historical 1.0 acceptance record is kept (a new record per version)
 *   Creator     dark-launched: registration allowed while enforcement is off; with
 *               legalConfig/enforcement.creator ON it is refused without acceptances, allowed with them
 *   UI          no agreement checkbox is pre-selected; the organizer intake does not unlock on the
 *               "service unavailable" fallback; the intake no longer writes a hard-coded version
 *
 *   node scripts/test-entertainment-agreements.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ent-agreements';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const Path = require('path');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const claims = {};
const authApi = { getUser: async (u) => ({ uid: u, customClaims: claims[u] || {} }), setCustomUserClaims: async (u, c) => { claims[u] = c; } };
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi });
stub('./notify', { notify: async () => ({ ok: true }) });

const LA = require(Path.join(FN, 'legal-agreements.js'));
const AL = require(Path.join(FN, 'application-lifecycle.js'));
const CH = require(Path.join(FN, 'creator-hub.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 150) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: { 'user-agent': 'Chromium-test', 'x-forwarded-for': '41.90.1.23' } } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
async function msg(p) { try { await p; return null; } catch (e) { return e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const realNow = Date.now;
const skipCaches = (ms) => { const base = realNow(); Date.now = () => base + ms; };

async function acceptAll(uid, role, { declaration = true, signature = true } = {}) {
  const ag = await LA._h.legalGetAgreements({ ...who(uid), data: { role } });
  const all = [...ag.core, ...ag.roleSpecific];
  return LA._h.legalAccept({ ...who(uid), data: {
    role, acceptances: all.map((a) => ({ agreementId: a.id, version: a.version })),
    ...(signature ? { signature: { type: 'typed', name: 'Kamau Mwangi', confirmed: true } } : {}),
    ...(declaration ? { declaration: { accepted: true, version: LA.DECLARATION_VERSION } } : {}),
    meta: { device: 'test', browser: 'test', language: 'en' },
  } });
}

(async () => {
  /* ═══ catalogue ═══ */
  console.log('\n── catalogue ──');
  const page = fs.readFileSync(Path.join(ROOT, 'entertainment-terms.html'), 'utf8');
  const ids = (role) => (LA.ROLE_AGREEMENTS[role] || []).map((a) => a.id);
  ck('event_organizer: organizer, ticketing & refund, staff & cash, commission, settlement, data', ['event-organizer-agreement', 'event-ticketing-refund-obligations', 'event-staff-cash-handling', 'commission-agreement', 'payment-settlement-terms', 'data-processing-agreement'].every((x) => ids('event_organizer').includes(x)));
  ck('creator: content, ownership, royalty, data', ['creator-content-agreement', 'content-ownership-declaration', 'royalty-settlement-terms', 'data-processing-agreement'].every((x) => ids('creator').includes(x)));
  ck('venue_owner: listing agreement', ids('venue_owner').includes('venue-listing-agreement'));
  const ent = ['event_organizer', 'creator', 'venue_owner'].flatMap((r) => LA.ROLE_AGREEMENTS[r]).filter((a) => a.url);
  ck('every entertainment agreement links to a REAL anchor in entertainment-terms.html', ent.length === 9 && ent.every((a) => { const m = /entertainment-terms\.html#([a-z-]+)$/.exec(a.url); return m && page.includes(`id="${m[1]}"`); }), ent.filter((a) => { const m = /#([a-z-]+)$/.exec(a.url); return !m || !page.includes(`id="${m[1]}"`); }).map((a) => a.id));
  ck('key points state the implemented rates (events 3 %, creator 30 / 70)', JSON.stringify(LA.ROLE_AGREEMENTS.event_organizer).includes('3%') && JSON.stringify(LA.ROLE_AGREEMENTS.creator).includes('30%') && JSON.stringify(LA.ROLE_AGREEMENTS.creator).includes('70%'));
  ck('the terms page self-updates (sw-register) and says it is v1.0 pending legal review', /sw-register\.js/.test(page) && /subject to review by SOKONI's legal team/.test(page));

  /* ═══ acceptance ═══ */
  console.log('\n── acceptance ──');
  ck('organizer acceptance without a signature refused', (await code(acceptAll('org1', 'event_organizer', { signature: false }))) === 'invalid-argument');
  ck('organizer acceptance without the Professional Declaration refused', (await code(acceptAll('org1', 'event_organizer', { declaration: false }))) === 'failed-precondition');
  const stale = await code(LA._h.legalAccept({ ...who('org1'), data: { role: 'event_organizer', acceptances: [{ agreementId: 'event-organizer-agreement', version: '0.9' }], signature: { type: 'typed', name: 'Kamau Mwangi', confirmed: true }, declaration: { accepted: true } } }));
  ck('only the CURRENT version can be accepted', !!stale, stale);

  /* ═══ approval ═══ */
  console.log('\n── approval ──');
  const app = { uid: 'org1', type: 'event_organizer', role: 'event_organizer', name: 'Kamau Events', status: 'pending', agreementAccepted: true };
  await db.doc('applications/APP1').set(app);
  const adm = { ...who('adm', { admin: true }), data: { applicationId: 'APP1', decision: 'approve' } };
  const before = await msg(AL.applicationDecide.run(adm));
  ck('client boolean agreementAccepted:true but NO acceptances → approval REFUSED', /event organizer application cannot be approved/.test(before || ''), before);
  await acceptAll('org1', 'event_organizer');
  const rec = await get('legalAcceptances/org1_event-organizer-agreement_1.0');
  ck('acceptance record: version, uid, time, signature hash, server user-agent', rec && rec.version === '1.0' && rec.userId === 'org1' && rec.acceptedAt && rec.signatureHash && rec.userAgent === 'Chromium-test', rec && Object.keys(rec).slice(0, 8));
  const ok = await code(AL.applicationDecide.run(adm));
  ck('with acceptances → approved', ok === null, ok);
  ck('…and the organizer role granted', ((await get('users/org1')) || {}).roles && (await get('users/org1')).roles.includes('event_organizer'));

  /* ═══ versioning ═══ */
  console.log('\n── versioning ──');
  await db.doc('legalAgreements/event-ticketing-refund-obligations').set({ version: '1.1', name: 'Ticketing & Refund Obligations', status: 'active' });
  skipCaches(6 * 60 * 1000);
  const comp = await LA.complianceFor('org1', 'event_organizer');
  ck('a NEW version makes the organizer non-compliant (must re-accept)', comp.compliant === false && comp.missing.some((m) => m.agreementId === 'event-ticketing-refund-obligations' && m.reason === 'outdated'), comp.missing && comp.missing.map((m) => m.agreementId + ':' + m.reason));
  ck('the historical 1.0 acceptance is KEPT (a new record per version)', !!(await get('legalAcceptances/org1_event-ticketing-refund-obligations_1.0')));
  await db.doc('applications/APP2').set({ ...app, status: 'pending' });
  ck('approval refused again until the new version is accepted', /cannot be approved/.test(await msg(AL.applicationDecide.run({ ...adm, data: { applicationId: 'APP2', decision: 'approve' } })) || ''));
  await acceptAll('org1', 'event_organizer');
  ck('after re-accepting 1.1 → compliant; both records exist', (await LA.complianceFor('org1', 'event_organizer')).compliant && !!(await get('legalAcceptances/org1_event-ticketing-refund-obligations_1.1')) && !!(await get('legalAcceptances/org1_event-ticketing-refund-obligations_1.0')));
  Date.now = realNow;

  /* ═══ creator (dark-launched) ═══ */
  console.log('\n── creator ──');
  const reg = (uid) => CH._internal.OPS['creator.register']({ ...who(uid), data: { op: 'creator.register', displayName: 'Studio ' + uid } });
  ck('enforcement OFF → a new creator can register (existing rollout pattern)', (await code(reg('c1'))) === null);
  await db.doc('legalConfig/enforcement').set({ creator: true });
  skipCaches(2 * 60 * 1000);
  ck('enforcement ON → a new creator WITHOUT acceptances is refused', (await code(reg('c2'))) === 'failed-precondition');
  await acceptAll('c2', 'creator', { declaration: false });
  ck('…and allowed after accepting the creator agreements (no business declaration for creators)', (await code(reg('c2'))) === null);
  ck('an existing creator editing their profile is not re-gated', (await code(reg('c1'))) === null);
  Date.now = realNow;

  /* ═══ UI ═══ */
  console.log('\n── UI ──');
  const sign = fs.readFileSync(Path.join(ROOT, 'sokoni-legal-sign.js'), 'utf8');
  const gate = fs.readFileSync(Path.join(ROOT, 'sokoni-legal-gate.js'), 'utf8');
  /* `checked` may only RESTORE a choice the user already made this session (state starts false). */
  ck('no agreement checkbox is rendered pre-selected', !/type="checkbox"[^'>]*\schecked/.test(sign + gate) && /confirmed: false/.test(sign) && /declared: false/.test(sign));
  const em = fs.readFileSync(Path.join(ROOT, 'event-manager.html'), 'utf8');
  ck('organizer intake: "unavailable" never unlocks submission', /legalDone = ok === true && !\(res && res\.unavailable\)/.test(em));
  ck('organizer intake: no hard-coded agreement version / client boolean', !/organizer-v1-2026-09-26/.test(em) && !/agreementAccepted:\s*true/.test(em));
  ck('the legal components use the page\'s signed-in app (window.__sokoniFns)', /window\.__sokoniFns = fns/.test(em) && /window\.__sokoniFns \|\|/.test(gate));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { Date.now = realNow; console.error('CRASH', e && e.stack || e); process.exit(3); });
