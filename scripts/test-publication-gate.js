/* test-publication-gate.js — creation is not publication (CHANGELOG 242, approval gate).
 * Transactional fake Firestore + the REAL functions/venue-booking.js, entertainment-admin.js (the ONE AdminOS listing
 * authority), ent-availability.js, and the REAL search triggers (algolia-sync.js, typesense-sync.js) with only the
 * trigger factory and the queues stubbed. No network.
 *
 * PROVES (server side; the Firestore-rules half is test-publication-gate-rules.js)
 *   S1–S4  venueCreate ignores client approved / active / published / verified / discoveryEligible / status: every new
 *          venue is PENDING
 *   S5     a normal user cannot run the AdminOS decision, whatever uid / role / reviewer it claims
 *   S6     an admin cannot cross collections by manipulating kind / id; a decision needs the record's CURRENT state
 *   S7     the direct server call enforces the rule: venueUpdate cannot self-activate a pending or rejected venue
 *   S8     a rejected venue / listing stays non-public and non-bookable
 *   S9     a pending venue is not bookable
 *   S10    only the AdminOS decision makes a venue / BnB listing active — reviewer and time come from the server
 *   search a pending / rejected / suspended BnB listing is never indexed; approval indexes it; suspension removes it
 *   control an approved venue's owner can still pause and resume it (the gate is not deny-all)
 *
 *   node scripts/test-publication-gate.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-publication-gate';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) });
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });
/* search: the REAL trigger code, with the trigger factory returning the handler and the queues recording */
const QUEUE = [];
stub('firebase-functions/v2/firestore', { onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h, onDocumentDeleted: (_o, h) => h, onDocumentWritten: (_o, h) => h });
stub('./algolia-queue', { enqueue: async (j) => { QUEUE.push(Object.assign({ via: 'algolia' }, j)); } });
stub('./typesense-queue', { enqueue: async (j) => { QUEUE.push(Object.assign({ via: 'typesense' }, j)); }, PRIORITY: { HIGH: 1, NORMAL: 2, LOW: 3 } });

const VB = require(Path.join(FN, 'venue-booking.js'));
const EA = require(Path.join(FN, 'entertainment-admin.js'))._adminH;
const AV = require(Path.join(FN, 'ent-availability.js'));
const ALG = require(Path.join(FN, 'algolia-sync.js'));
const TS = require(Path.join(FN, 'typesense-sync.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token) => ({ auth: uid ? { uid, token: token || {} } : null, rawRequest: { headers: {} } });
const ADMIN = (uid) => who(uid || 'admin1', { admin: true });
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
/* the availability authority's own answer: { ok, code } — ok only for an ACTIVE venue */
const bookable = async (venueId) => { const c = await AV.loadCalendar('ven_' + venueId); return !!(c && c.bookable && c.bookable.ok === true); };
const bookCode = async (venueId) => { const c = await AV.loadCalendar('ven_' + venueId); return c && c.bookable && c.bookable.code; };

(async () => {
  say('\n── S1–S4, S7: venueCreate is creation, never publication ──');
  const forged = { name: 'Karura Hall', type: 'conference_hall', status: 'active', approved: true, active: true, published: true, verified: true,
    discoveryEligible: true, isPublic: true, bypassApproval: true, moderatedAt: 1, rating: 5, reviewCount: 99 };
  const v1 = await VB._h.venueCreate({ ...who('owner1'), data: forged });
  const vd = await get('venues/' + v1.venueId);
  ck('a venue created with status/approved/active/published/verified/discoveryEligible/bypassApproval is PENDING', vd.status === 'pending', vd.status);
  ck('…and none of the forged fields was stored', ['approved', 'active', 'published', 'verified', 'discoveryEligible', 'isPublic', 'bypassApproval', 'moderatedAt'].every((k) => !(k in vd)) && vd.rating === 0 && vd.reviewCount === 0);
  ck('S9: a PENDING venue is not bookable (the availability authority: NOT_APPROVED)', (await bookable(v1.venueId)) === false && (await bookCode(v1.venueId)) === 'NOT_APPROVED', await bookCode(v1.venueId));
  ck('S7: the owner cannot self-activate a pending venue through venueUpdate', await codeOf(VB._h.venueUpdate({ ...who('owner1'), data: { venueId: v1.venueId, status: 'active' } })) === 'APPROVAL_REQUIRED');
  ck('…nor a stranger', !!(await codeOf(VB._h.venueUpdate({ ...who('mallory'), data: { venueId: v1.venueId, status: 'active' } }))));
  ck('…and the venue is still pending', (await get('venues/' + v1.venueId)).status === 'pending');

  say('\n── S5: only an administrator decides ──');
  const s5 = await codeOf(EA.entAdminSetListingStatus({ ...who('owner1', { role: 'user' }), data: { kind: 'booking_venue', id: v1.venueId, decision: 'approve', performedBy: 'admin1', adminUid: 'admin1', role: 'admin' } }));
  ck('a normal user supplying another uid / role / reviewer cannot approve', s5 === 'permission-denied', s5);
  ck('…the venue is still pending', (await get('venues/' + v1.venueId)).status === 'pending');

  say('\n── S10: the AdminOS decision is the only path to public ──');
  await EA.entAdminSetListingStatus({ ...ADMIN('admin7'), data: { kind: 'booking_venue', id: v1.venueId, decision: 'approve', performedBy: 'someone-else', decidedAt: 1 } });
  const approved = await get('venues/' + v1.venueId);
  const audit = (await db.collection('adminAudit').get()).docs.map((d) => d.data()).find((a) => a.action === 'ent_listing_approve' && a.target.id === v1.venueId);
  ck('an administrator approves → active, and it becomes bookable', approved.status === 'active' && (await bookable(v1.venueId)) === true);
  ck('…the reviewer is the VERIFIED admin (not the client-supplied performedBy) and the time is the server\'s', audit && audit.performedBy === 'admin7' && audit.before.status === 'pending' && audit.after.status === 'active' && !('decidedAt' in approved), audit);
  ck('control: the owner of an APPROVED venue can pause and resume it',
    !(await codeOf(VB._h.venueUpdate({ ...who('owner1'), data: { venueId: v1.venueId, status: 'inactive' } }))) && !(await codeOf(VB._h.venueUpdate({ ...who('owner1'), data: { venueId: v1.venueId, status: 'active' } }))));

  say('\n── S8: rejected stays non-public ──');
  const v2 = await VB._h.venueCreate({ ...who('owner2'), data: { name: 'Riverside', type: 'conference_hall' } });
  await EA.entAdminSetListingStatus({ ...ADMIN(), data: { kind: 'booking_venue', id: v2.venueId, decision: 'reject', reason: 'Photos do not match the address' } });
  ck('a rejected venue is "rejected", not bookable', (await get('venues/' + v2.venueId)).status === 'rejected' && (await bookable(v2.venueId)) === false);
  ck('…and its owner cannot re-activate it', await codeOf(VB._h.venueUpdate({ ...who('owner2'), data: { venueId: v2.venueId, status: 'active' } })) === 'APPROVAL_REQUIRED');
  ck('…and "approve" cannot silently revive it (only a deliberate restore)', await codeOf(EA.entAdminSetListingStatus({ ...ADMIN(), data: { kind: 'booking_venue', id: v2.venueId, decision: 'approve' } })) === 'failed-precondition');

  say('\n── S6: no cross-collection / wrong-record decisions ──');
  await db.doc('bnbListings/L1').set({ id: 'L1', name: 'Garden Cottage', hostUid: 'host1', status: 'pending', price: 5000 });
  ck('approving a BnB listing id under the VENUE kind finds nothing (kind binds the collection)', await codeOf(EA.entAdminSetListingStatus({ ...ADMIN(), data: { kind: 'booking_venue', id: 'L1', decision: 'approve' } })) === 'not-found');
  ck('approving a venue id under the BnB kind finds nothing', await codeOf(EA.entAdminSetListingStatus({ ...ADMIN(), data: { kind: 'bnb', id: v1.venueId, decision: 'approve' } })) === 'not-found');
  ck('an unknown kind is refused', await codeOf(EA.entAdminSetListingStatus({ ...ADMIN(), data: { kind: 'users', id: 'owner1', decision: 'approve' } })) === 'invalid-argument');
  ck('a path-traversal id is refused', await codeOf(EA.entAdminSetListingStatus({ ...ADMIN(), data: { kind: 'bnb', id: '../venues/x', decision: 'approve' } })) === 'invalid-argument');
  ck('the BnB listing was not touched by any of these', (await get('bnbListings/L1')).status === 'pending');

  say('\n── BnB through the SAME authority ──');
  await EA.entAdminSetListingStatus({ ...ADMIN('admin8'), data: { kind: 'bnb', id: 'L1', decision: 'approve' } });
  const la = (await db.collection('adminAudit').get()).docs.map((d) => d.data()).find((a) => a.target && a.target.collection === 'bnbListings');
  ck('an administrator approves a BnB listing (kind bnb) → active, audited with the verified reviewer', (await get('bnbListings/L1')).status === 'active' && la && la.performedBy === 'admin8');
  await db.doc('bnbListings/L2').set({ id: 'L2', name: 'Shed', hostUid: 'host2', status: 'pending', price: 100 });
  await EA.entAdminSetListingStatus({ ...ADMIN(), data: { kind: 'bnb', id: 'L2', decision: 'reject', reason: 'Not a real property' } });
  ck('a rejected BnB listing is "rejected"', (await get('bnbListings/L2')).status === 'rejected');
  const pendList = await EA.entAdminListings({ ...ADMIN(), data: { kind: 'bnb', status: 'pending' } });
  ck('AdminOS lists BnB listings by status (the review queue)', Array.isArray(pendList.listings));

  say('\n── search: only APPROVED BnB listings are indexed ──');
  const ev = (data) => ({ data: { data: () => data }, params: { docId: 'L9' } });
  const upd = (b, a) => ({ data: { before: { data: () => b }, after: { data: () => a } }, params: { docId: 'L9' } });
  QUEUE.length = 0;
  await ALG.algoliaSync_bnbListings_create(ev({ name: 'X', status: 'pending' }));
  await TS[Object.keys(TS).find((k) => /bnbListings/.test(k) && /[Cc]reate/.test(k))](ev({ name: 'X', status: 'pending' }));
  ck('a PENDING listing is never indexed (Algolia + Typesense)', QUEUE.length === 0, QUEUE);
  await ALG.algoliaSync_bnbListings_create(ev({ name: 'X', status: 'rejected' }));
  ck('a REJECTED listing is never indexed', QUEUE.length === 0);
  await ALG.algoliaSync_bnbListings_update(upd({ name: 'X', status: 'pending' }, { name: 'X', status: 'active' }));
  ck('approval (pending → active) indexes it', QUEUE.some((j) => j.via === 'algolia' && j.operation !== 'delete'), QUEUE);
  QUEUE.length = 0;
  await ALG.algoliaSync_bnbListings_update(upd({ name: 'X', status: 'active' }, { name: 'X', status: 'suspended' }));
  ck('suspension (active → suspended) removes it from the index', QUEUE.some((j) => j.operation === 'delete'), QUEUE);

  say('\n── the ONE AdminOS authority, in the UI ──');
  const fsx = require('fs');
  const aos = fsx.readFileSync(Path.join(ROOT, 'sokoni-aos-entertainment.js'), 'utf8');
  ck('AdminOS › Entertainment offers the BnB review queue (kind bnb) through entAdminListings / entAdminSetListingStatus', /<option value="bnb"/.test(aos) && /entAdminSetListingStatus/.test(aos));
  const adm = fsx.readFileSync(Path.join(ROOT, 'admin.html'), 'utf8');
  const decide = (adm.match(/async function _decideProp\([\s\S]*?\r?\n\}/) || [''])[0];
  /* AdminOS is the ONLY admin workspace (test-entertainment-registry guards that admin.html carries no Entertainment
     control), so the legacy page's BnB decision is RETIRED — it writes nothing and points to AdminOS. */
  ck('the legacy admin.html BnB decision is retired: no raw status write, no client reviewer, no admin op, points to AdminOS, claims nothing',
    decide.length > 0 && !/updateBnbListingStatus\(|updateDoc\(|setDoc\(/.test(decide) && !/updatedBy/.test(decide.replace(/\/\*[\s\S]*?\*\//g, ''))
    && !/entAdmin|eventAdmin/.test(adm) && /AdminOS › Entertainment › BnB \/ stays/.test(decide) && /return null;/.test(decide));

  say('\n── legacy listings: the migration artifact (NOT run against production) ──');
  const MIG = require(Path.join(ROOT, 'scripts', 'migrate-bnb-listing-status.js'));
  await db.doc('bnbListings/OLD1').set({ id: 'OLD1', name: 'Legacy Cottage', hostUid: 'hostL' });   /* pre-gate shape: no status */
  await db.doc('bnbListings/OLD2').set({ id: 'OLD2', name: 'Legacy Loft', hostUid: 'hostL' });
  const beforeLive = (await get('bnbListings/L1')).status;
  const plan = await MIG.plan(db);
  ck('the dry run finds exactly the status-less (legacy) listings and writes nothing', plan.legacy.map((x) => x.id).sort().join() === 'OLD1,OLD2' && !('status' in (await get('bnbListings/OLD1'))), plan);
  ck('apply refuses without an operator', (await MIG.apply(db, '', F.FieldValue).then(() => 'applied', (e) => e.message)) !== 'applied');
  const mr = await MIG.apply(db, 'adminOp1', F.FieldValue);
  ck('apply sets legacy listings PENDING (review) — never active', mr.changed === 2 && (await get('bnbListings/OLD1')).status === 'pending' && (await get('bnbListings/OLD2')).status === 'pending', mr);
  ck('…never touches a listing that already has a status', (await get('bnbListings/L1')).status === beforeLive && (await get('bnbListings/L2')).status === 'rejected');
  ck('…records who ran it in adminAudit', (await db.collection('adminAudit').get()).docs.map((d) => d.data()).filter((x) => x.action === 'bnb_listing_legacy_status' && x.performedBy === 'adminOp1').length === 2);
  ck('…and re-running is a no-op', (await MIG.apply(db, 'adminOp1', F.FieldValue)).changed === 0);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
