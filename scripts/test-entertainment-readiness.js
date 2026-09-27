/* test-entertainment-readiness.js — the Entertainment Hub whole-hub readiness sweep (2026-09-27).
 *
 * Covers the fixes that have no other home (the rest are in the event / creator / rules / refund suites):
 *   DISCOVERY   a suspended creator's films leave the public catalogue and return on reinstatement;
 *               catalog.get refuses a film whose creator is not ACTIVE
 *   VENUES      an owner cannot lift a suspension or set an arbitrary status through venueUpdate;
 *               AdminOS moderates the CANONICAL venues (kind booking_venue), audited, without writing
 *               the admin uid onto the public venue document
 *   RATINGS     one rating per viewer per listing, only from a viewer with access
 *   DECISIONS   applicationDecide writes the server decision record BEFORE the application; the reconcile
 *               path refuses a status with no matching record
 *   HUB PAGE    entertainment.html owns nothing: no mock performers / demo events / fake stories, no
 *               localStorage business data, no client money, no admin-page links, every route exists
 *
 *   node scripts/test-entertainment-readiness.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ent-readiness';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.now();
const F = makeFakeFirestore({ clock: () => NOW });
const db = F.db;
const say = console.log;
console.log = console.info = console.warn = console.debug = () => {};
const users = { cA: { uid: 'cA' }, v1: { uid: 'v1' }, own1: { uid: 'own1' }, adm: { uid: 'adm' } };
const authRec = (u) => ({ uid: u, providerData: [{ providerId: 'password' }], customClaims: {} });
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { require.cache[resolveIn(m)] = { id: m, filename: m, loaded: true, exports: exp }; };
const TS = Object.assign({}, F.Timestamp, { now: () => F.Timestamp.fromMillis(NOW) });
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: TS, FieldPath: F.FieldPath });
stub('firebase-admin/storage', { getStorage: () => ({ bucket: () => ({ file: () => ({ exists: async () => [false] }) }) }) });
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (u) => authRec(u) }) });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}),
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: TS, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => authRec(u) }), storage: () => ({ bucket: () => ({}) }) });

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const read = (f) => fs.readFileSync(Path.join(ROOT, f), 'utf8');

(async () => {
  /* ═══ DISCOVERY ═══ */
  say('\n── discovery: a suspended creator leaves the catalogue ──');
  const H = require(Path.join(FN, 'creator-hub.js'));
  H._internal._setClock(() => NOW);
  await db.doc('creators/cA').set({ uid: 'cA', state: 'ACTIVE', displayName: 'Kibera Films' });
  await db.doc('creators/cB').set({ uid: 'cB', state: 'ACTIVE', displayName: 'Other' });
  const film = (id, creatorUid, extra = {}) => db.doc('entertainmentListings/' + id).set({ creatorHub: true, creatorUid, title: 'Film ' + id, pubState: 'PUBLISHED', status: 'active', subcategory: 'feature_film', publishedAt: F.Timestamp.fromMillis(NOW - 1000), priceCents: 20000, currency: 'KES', ...extra });
  await film('fA1', 'cA'); await film('fA2', 'cA'); await film('fB1', 'cB');
  await db.doc('entertainmentListings/fAdraft').set({ creatorHub: true, creatorUid: 'cA', title: 'Draft', pubState: 'DRAFT', status: 'draft' });
  const list = async () => (await H._internal.OPS['catalog.list']({ ...who(null), data: {} })).films.map((f) => f.filmId || f.id).sort().join();
  ck('baseline: both creators\' published films are listed', (await list()) === 'fA1,fA2,fB1', await list());
  const sus = await H._adminH.creatorAdminSetState({ ...who('adm', { admin: true }), data: { uid: 'cA', to: 'SUSPENDED', reason: 'rights complaint' } });
  ck('suspension moves the creator\'s PUBLISHED films out of the public state (2 films)', sus.filmsVisibilityChanged === 2 && (await get('entertainmentListings/fA1')).status === 'creator_suspended', sus);
  ck('…the editorial state is untouched (still PUBLISHED); the draft is not touched', (await get('entertainmentListings/fA1')).pubState === 'PUBLISHED' && (await get('entertainmentListings/fAdraft')).status === 'draft');
  ck('catalog.list no longer lists them (platform search + rules key on status == active too)', (await list()) === 'fB1', await list());
  ck('catalog.get refuses the suspended creator\'s film', (await code(H._internal.OPS['catalog.get']({ ...who('v1'), data: { filmId: 'fA1' } }))) === 'not-found');
  ck('the audit records how many films changed', db._dump('adminAudit/').some((a) => a.action === 'creator_state' && (a.after || a.detail || a).filmsVisibilityChanged === 2) || db._dump('adminAudit/').some((a) => JSON.stringify(a).includes('"filmsVisibilityChanged":2')));
  const rst = await H._adminH.creatorAdminSetState({ ...who('adm', { admin: true }), data: { uid: 'cA', to: 'ACTIVE', reason: 'complaint withdrawn' } });
  ck('reinstatement restores exactly the published films', rst.filmsVisibilityChanged === 2 && (await list()) === 'fA1,fA2,fB1', await list());
  /* defence in depth: a film still 'active' whose creator is not ACTIVE (published before the sync) */
  await db.doc('creators/cB').set({ uid: 'cB', state: 'SUSPENDED' });
  ck('catalog.list filters a legacy active film of a non-ACTIVE creator', (await list()) === 'fA1,fA2', await list());

  /* ═══ VENUES ═══ */
  say('\n── venues: status is an AdminOS decision ──');
  const VB = require(Path.join(FN, 'venue-booking.js'));
  await db.doc('venues/v1').set({ ownerId: 'own1', name: 'Hall', status: 'suspended', suspendReason: 'noise complaints' });
  await db.doc('venues/v2').set({ ownerId: 'own1', name: 'Garden', status: 'active' });
  ck('an owner cannot lift their own suspension through venueUpdate', (await code(VB._h.venueUpdate({ ...who('own1'), data: { venueId: 'v1', status: 'active' } }))) === 'permission-denied' && (await get('venues/v1')).status === 'suspended');
  ck('an owner cannot set an arbitrary status (e.g. "verified")', (await code(VB._h.venueUpdate({ ...who('own1'), data: { venueId: 'v2', status: 'verified' } }))) === 'invalid-argument');
  ck('an owner may still pause and resume their own venue', !(await code(VB._h.venueUpdate({ ...who('own1'), data: { venueId: 'v2', status: 'inactive' } }))) && (await get('venues/v2')).status === 'inactive');
  ck('an owner still edits content fields', !(await code(VB._h.venueUpdate({ ...who('own1'), data: { venueId: 'v2', name: 'Garden B' } }))) && (await get('venues/v2')).name === 'Garden B');
  const EA = require(Path.join(FN, 'entertainment-admin.js'));
  ck('AdminOS lists the CANONICAL venues (kind booking_venue)', (await EA._adminH.entAdminListings({ ...who('adm', { admin: true }), data: { kind: 'booking_venue', status: 'suspended' } })).listings.some((l) => l.id === 'v1'));
  ck('a non-admin cannot moderate a venue', (await code(EA._adminH.entAdminSetListingStatus({ ...who('own1'), data: { kind: 'booking_venue', id: 'v1', decision: 'restore', reason: 'please restore me' } }))) === 'permission-denied');
  const mr = await EA._adminH.entAdminSetListingStatus({ ...who('adm', { admin: true }), data: { kind: 'booking_venue', id: 'v2', decision: 'suspend', reason: 'unsafe exits reported' } });
  const v2 = await get('venues/v2');
  ck('admin suspends a canonical venue → suspended, reason recorded, audited', mr.to === 'suspended' && v2.status === 'suspended' && v2.suspendReason === 'unsafe exits reported' && db._dump('adminAudit/').some((a) => a.action === 'ent_listing_suspend' && a.target.collection === 'venues'));
  ck('the moderator\'s uid is NOT written onto the (public) venue document', !('moderatedBy' in v2));

  /* ═══ RATINGS ═══ */
  say('\n── ratings: one per entitled viewer ──');
  const ENT = require(Path.join(FN, 'entertainment-hub.js'));
  await db.doc('creators/cB').set({ uid: 'cB', state: 'ACTIVE' });
  await db.doc('entertainmentListings/fB1').set({ creatorHub: true, creatorUid: 'cB', title: 'B', pubState: 'PUBLISHED', status: 'active', contentRating: 0, contentRatingCount: 0 });
  const rate = (uid, r) => ENT.rateEntertainmentContent.run({ ...who(uid), data: { listingId: 'fB1', rating: r } });
  ck('a viewer WITHOUT access cannot rate a film', (await code(rate('v1', 5))) === 'permission-denied' && (await get('entertainmentListings/fB1')).contentRatingCount === 0);
  await db.doc('contentAccess/v1_fB1').set({ uid: 'v1', filmId: 'fB1', status: 'ACTIVE' });
  ck('a viewer with access rates once', !(await code(rate('v1', 4))) && (await get('entertainmentListings/fB1')).contentRatingCount === 1);
  ck('…and cannot rate again (no unlimited ratings)', (await code(rate('v1', 5))) === 'already-exists' && (await get('entertainmentListings/fB1')).contentRatingCount === 1);
  ck('a fractional / out-of-range rating is refused', (await code(rate('v1', 4.5))) === 'invalid-argument' && (await code(rate('v1', 9))) === 'invalid-argument');

  /* ═══ DECISIONS (wiring) ═══ */
  say('\n── application decisions: server record ──');
  const AL = read('functions/application-lifecycle.js');
  const dIdx = AL.indexOf("await db.collection(DECISIONS).doc(String(applicationId)).set(");
  const aIdx = AL.indexOf('await ref.set({\n      status,', dIdx) >= 0 ? AL.indexOf('await ref.set({\n      status,', dIdx) : AL.indexOf('await ref.set({\r\n      status,', dIdx);
  ck('applicationDecide writes the decision record BEFORE the application (the trigger must find it)', dIdx > 0 && aIdx > dIdx);
  ck('the trigger passes the application id to decisionAuthority', /decisionAuthority\(after, appId\)/.test(AL));
  ck('reconcile (single + sweep) refuses a status with no matching record', (AL.match(/await decisionAuthority\(app, (snap|d)\.id\)/g) || []).length === 2);

  /* ═══ HUB PAGE ═══ */
  say('\n── entertainment.html: an entry point that owns nothing ──');
  const hub = read('entertainment.html');
  /* strip HTML and JS comments: only what RUNS or RENDERS is judged */
  const code_ = hub.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('no fictional performers / demo events / fake stories / static bundles remain', !/PERFORMERS|DEMO_EVENTS|_demoAllowed/.test(code_) && !/Live & Active Now|rate card|Book Bundle|SAVE 15|\bstor(y|ies)\b/i.test(code_));
  ck('no localStorage / sessionStorage business data', !/localStorage|sessionStorage/.test(code_));
  ck('no client money: no STK push, no payment SDK, no amounts sent', !/initiateSTKPush|SokoniPay|sokoni-pay\.js|createPaymentIntent|amount\s*:/.test(code_));
  ck('no legacy EntHub (client Firestore writes)', !/entertainment-hub\.js|EntHub|collection\(/.test(code_));
  ck('no admin-page links', !/(admin|superadmin|super-admin)\.html/.test(code_));
  ck('no success toast / "confirmed" claim anywhere', !/confirmed!|submitted!|toast\(/i.test(code_));
  const hrefs = [...new Set((code_.match(/href="\/([a-z0-9-]+\.html)/g) || []).map((m) => m.slice(7)))];
  const missing = hrefs.filter((f) => !fs.existsSync(Path.join(ROOT, f)));
  ck(`every routed page exists (${hrefs.length} targets)`, hrefs.length >= 12 && missing.length === 0, missing.join(','));
  ck('events come from the canonical listEvents; films from creatorDispatch catalog.list', /httpsCallable\(fns, 'listEvents'\)/.test(code_) && /op: 'catalog\.list'/.test(code_));
  ck('artists & services route to the provider marketplace; venues to the booking engine', /\/services\.html\?cat=entertainment/.test(code_) && /\/venue-booking\.html/.test(code_));
  ck('honest states: loading, empty and unavailable are all rendered', /Loading…/.test(code_) && /No upcoming events yet/.test(code_) && /unavailable right now/.test(code_));
  ck('self-updates (shared-header → sw-register) and carries the profile menu', /shared-header\.js/.test(hub) && !/data-no-header/.test(hub));
  ck('legacy ?cat= / ?event= / ?venue= links are routed to the canonical owner', /location\.replace\('\/services\.html\?cat='/.test(code_) && /location\.replace\('\/event-hub\.html\?event='/.test(code_) && /location\.replace\('\/venue-booking\.html\?venue='/.test(code_));
  ck('the retired organizer page redirects to Event Manager (no client ticket validation left)', /location\.replace\('\/event-manager\.html'\)/.test(read('ent-organizer.html')) && !/entertainment-hub\.js/.test(read('ent-organizer.html')));
  ck('services.html resolves the "entertainment" category', /"entertainment": \["dj","mc"/.test(read('services.html')));
  ck('the terms page now carries the shared profile menu', !/data-no-header/.test(read('entertainment-terms.html')));
  const vb = read('venue-booking.html').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  ck('venue-booking boots its own SDK + defines db (it threw on load)', /firebase-firestore-compat\.js/.test(vb) && /var db = firebase\.firestore\(_vbApp\);/.test(vb));
  ck('venue-booking wording follows the SERVER status and never implies a payment', /res\.data && res\.data\.status/.test(vb) && /does not collect payment/.test(vb) && !/Booking Confirmed!/.test(vb));
  const vm = read('venue-manager.html');
  ck('venue-manager saves through bookingDispatch (the standalone callables are not exported)', /_bd\('venueUpdate', payload\)/.test(vm) && /_bd\('venueCreate', payload\)/.test(vm) && !/cf\('venueUpdate'\)|cf\('venueCreate'\)/.test(vm));
  ck('venue-manager lists and deletes blocks where the booking core writes them', /collection\('venueBlockouts'\)\.where\('venueId', '==', _activeId\)/.test(vm) && /collection\('venueBlockouts'\)\.doc\(blockId\)\.delete\(\)/.test(vm));
  const em = read('event-manager.html');
  ck('organizer application no longer writes the rules-refused `role` key', !/type: 'event_organizer', role: 'event_organizer'/.test(em));
  ck('event-manager renders unknown money as "—", not KES 0', /_kesOrDash\(a\.platformFees\)/.test(em) && !/\(a\.platformFees\|\|0\)/.test(em));
  const eh = read('event-hub.html');
  ck('event-hub: signed-in button opens the profile (not login); organizer link keyed on the claim; ?view=tickets', /location\.href = 'profile\.html'/.test(eh) && /tok\.claims\.event_organizer === true/.test(eh) && /_ret\.get\('view'\) === 'tickets'/.test(eh));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
