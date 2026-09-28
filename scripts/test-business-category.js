/* test-business-category.js — the ONE canonical business category authority (CHANGELOG 236, convergence C1).
 * Transactional fake Firestore + the REAL functions/business-category.js, application-lifecycle.projectProvider,
 * provider-hub.js, business-category-admin.js and healthcare-admin.js. No network.
 *
 * PROVES
 *   registry     EVERY business id in hub-register.js and EVERY profession in provider-onboarding.js is mapped
 *                deliberately (or left null ON PURPOSE); Healthcare's categories are this registry's
 *   exact-only   an application gets a category only from an exact match; two answers, none, a role conflict, a
 *                hub name alone, or free text → UNCLASSIFIED — never a guess
 *   approval     projectProvider stamps providers.business {category, lane} at approval; the lane is what the
 *                EXISTING classifier decides (no price moves); a Healthcare category is one decision in two fields;
 *                an administrator's category survives a re-approval
 *   lane         the commission lookup reads the STAMPED lane — editing the application after approval cannot move
 *                it; legacy (unstamped) providers take the MOST RECENT decided application, not the first read
 *   adminos      only an admin classifies; a reason is required; Legal / Event organizer / Delivery belong to their
 *                own authorities; the Healthcare boundary holds both ways; an unapproved business is refused; the
 *                audit records it; the lane is NOT changed; healthAdminClassify keeps both fields in step
 *   eligibility  public eligibility is derived from server facts and refuses the unclassified
 *   chain        application → AdminOS decision → server category → persisted → workspace-ready → public eligibility,
 *                with no client-controlled step; an ambiguous one stops at UNCLASSIFIED
 *
 *   node scripts/test-business-category.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-business-category';
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
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ setCustomUserClaims: async () => {}, getUser: async (u) => ({ uid: u, customClaims: {} }) }) });

const BC = require(Path.join(FN, 'business-category.js'));
const HC = require(Path.join(FN, 'healthcare-category.js'));
const PH = require(Path.join(FN, 'provider-hub.js'));
const AL = require(Path.join(FN, 'application-lifecycle.js'))._internal;
const BA = require(Path.join(FN, 'business-category-admin.js'))._adminH;
const HA = require(Path.join(FN, 'healthcare-admin.js'))._adminH;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const ADMIN = { auth: { uid: 'admin1', token: { admin: true } } };
const USER = (uid) => ({ auth: { uid, token: {} } });

(async () => {
  say('\n── the registry covers every business type ──');
  const hubIds = [...fs.readFileSync(Path.join(ROOT, 'hub-register.js'), 'utf8').matchAll(/\{ id:'([a-z0-9-]+)',\s*label:'[^']+',\s*hub:'[a-z-]+'/g)].map((m) => m[1]);
  const missing = hubIds.filter((id) => !Object.prototype.hasOwnProperty.call(BC.FROM_BUSINESS_ID, id));
  ck(`every hub-register.js business id (${hubIds.length}) is mapped or deliberately null`, hubIds.length >= 100 && missing.length === 0, missing);
  const onb = fs.readFileSync(Path.join(FN, 'provider-onboarding.js'), 'utf8');
  const block = onb.slice(onb.indexOf('const SERVICE_CATEGORIES'), onb.indexOf('};', onb.indexOf('const SERVICE_CATEGORIES')));
  const profs = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => !/:$/.test(p));
  const groupNames = [...block.matchAll(/'([^']+)':\s*\[/g)].map((m) => m[1]);
  const pMissing = profs.filter((p) => !groupNames.includes(p)).filter((p) => !Object.prototype.hasOwnProperty.call(BC.FROM_PROFESSION, p.toLowerCase()));
  ck('every provider-onboarding.js profession is mapped', profs.length >= 60 && pMissing.length === 0, pMissing);
  ck('every mapped value is a real category', [...Object.values(BC.FROM_BUSINESS_ID), ...Object.values(BC.FROM_PROFESSION)].every((c) => c === null || BC.isCategory(c)));
  ck('the deliberately-unclassified ids are exactly: car-rental, forex, sacco, football-club, basketball, other',
    Object.keys(BC.FROM_BUSINESS_ID).filter((k) => BC.FROM_BUSINESS_ID[k] === null).sort().join() === 'basketball,car-rental,football-club,forex,other,sacco');
  ck('Healthcare\'s categories ARE this registry\'s (reference pattern, not a parallel list)', BC.HEALTHCARE.slice().sort().join() === HC.CATEGORIES.slice().sort().join()
    && Object.keys(HC.FROM_BUSINESS_ID).every((k) => BC.FROM_BUSINESS_ID[k] === HC.FROM_BUSINESS_ID[k]));

  say('\n── exact matches only ──');
  const c = (app, role) => BC.categoryFromApplication(app, role);
  ck('plumbing → trades; Plumber (profession) → trades', c({ category: 'plumbing' }, 'provider').category === 'trades' && c({ subcategory: 'Plumber' }, 'provider').category === 'trades');
  ck('hotel / bnb → hotel; it-support → it_services; salon → salon', c({ category: 'hotel' }, 'provider').category === 'hotel' && c({ category: 'bnb' }, 'provider').category === 'hotel' && c({ type: 'it-support' }, 'provider').category === 'it_services' && c({ category: 'salon' }, 'provider').category === 'salon');
  const amb = c({ category: 'plumbing', subcategory: 'Photographer' }, 'provider');
  ck('two different answers → UNCLASSIFIED (never picks one)', amb.category === null && /ambiguous/.test(amb.reason), amb);
  ck('"other" → UNCLASSIFIED', c({ category: 'other' }, 'provider').category === null);
  /* a hub name is a whole family, never a category — in the hub field OR written into a category/type field */
  const HUBS = ['entertainment', 'healthcare', 'food', 'beauty', 'tech', 'home-services', 'shopping', 'bnb-hub', 'legal-hub'];
  ck('a hub name alone → UNCLASSIFIED (hub field, category field, type field)', c({ hub: 'entertainment' }, 'provider').category === null
    && HUBS.every((h) => c({ category: h }, 'provider').category === null && c({ type: h }, 'provider').category === null),
    HUBS.filter((h) => c({ category: h }, 'provider').category !== null || c({ type: h }, 'provider').category !== null));
  ck('free text ("Clinic", "Service Provider") → UNCLASSIFIED', c({ category: 'Clinic' }, 'provider').category === null && c({ category: 'Service Provider' }, 'provider').category === null);
  ck('a Healthcare category without a health approval → UNCLASSIFIED (role conflict)', c({ category: 'pharmacy' }, 'provider').category === null && /role-conflict/.test(c({ category: 'pharmacy' }, 'provider').reason));
  ck('a health approval with a non-health answer → UNCLASSIFIED', c({ category: 'plumbing' }, 'health').category === null);
  ck('Legal / Event organizer / Driver roles → their own authorities\' categories', c({}, 'legal').category === 'lawyer' && c({}, 'event_organizer').category === 'event_organizer' && c({}, 'driver').category === 'delivery');
  ck('a seller with no specific type → retail store; a seller claiming a service type → UNCLASSIFIED', c({}, 'seller').category === 'retail_store' && c({ category: 'supermarket' }, 'seller').category === 'retail_store' && c({ category: 'plumbing', subcategory: 'Photographer' }, 'seller').category === null);

  say('\n── approval stamps the category and the lane ──');
  const approve = async (uid, app) => { await AL.projectProvider(db, Object.assign({ applicationId: 'app_' + uid, name: uid }, app), uid, true); return (await get('providers/' + uid)) || {}; };
  const plumb = await approve('plumb1', { role: 'provider', category: 'plumbing' });
  ck('a plumber: business.category = trades, lane = plan rate (provider)', plumb.business && plumb.business.category === 'trades' && plumb.business.lane.hub === 'provider' && plumb.business.source === 'application', plumb.business);
  const photo = await approve('photo1', { role: 'provider', category: 'photographer' });
  const photoLane = PH.classifyDecidedApplication({ role: 'provider', category: 'photographer' });
  ck('a photographer: artist_creator, and the lane is EXACTLY what the existing classifier decides (entertainment)', photo.business.category === 'artist_creator' && photo.business.lane.hub === 'entertainment' && JSON.stringify(photo.business.lane) === JSON.stringify(photoLane), { stamped: photo.business.lane, classifier: photoLane });
  const doc = await approve('doc1', { role: 'health', subcategory: 'Doctor' });
  ck('a doctor: healthcare.category = business.category = clinician, lane = healthcare', doc.healthcare.category === 'clinician' && doc.business.category === 'clinician' && doc.business.lane.hub === 'healthcare', { h: doc.healthcare.category, b: doc.business });
  const unk = await approve('unk1', { role: 'provider', category: 'plumbing', subcategory: 'Photographer' });
  ck('an ambiguous application is approved UNCLASSIFIED (business.category null) — no guessed dashboard, plan or price', unk.business.category === null && BC.categoryOf(unk) === null, unk.business);
  for (const [uid, app] of [['p_hotel', { category: 'hotel' }], ['p_it', { type: 'it-support' }], ['p_salon', { category: 'salon' }], ['p_clean', { category: 'cleaning' }], ['p_rest', { category: 'restaurant' }]]) {
    await approve(uid, Object.assign({ role: 'provider' }, app));
  }
  ck('hotel / IT / salon / cleaning / restaurant each persist their category', ['hotel', 'it_services', 'salon', 'cleaning', 'restaurant'].join() === (await Promise.all(['p_hotel', 'p_it', 'p_salon', 'p_clean', 'p_rest'].map(async (u) => BC.categoryOf(await get('providers/' + u))))).join());

  say('\n── the commercial lane is frozen at approval ──');
  await db.doc('applications/app_photo1').set({ uid: 'photo1', status: 'approved', role: 'provider', category: 'photographer', decidedAt: 1000 });
  await db.doc('applications/app_plumb1').set({ uid: 'plumb1', status: 'approved', role: 'provider', category: 'plumbing', decidedAt: 1000 });
  /* the attack C1 closes: an approved application edited to claim Entertainment (the rules now refuse this; here we
     prove the price no longer depends on it even if the document changed) */
  await db.doc('applications/app_plumb1').set({ hub: 'entertainment', performerType: 'dj' }, { merge: true });
  const lanePlumb = await PH.resolveProviderClassification(db, 'plumb1');
  ck('a plumber whose approved application was edited to "entertainment" is still priced at the plan rate', lanePlumb.hub === 'provider', lanePlumb);
  ck('commission arguments for the stamped lanes are unchanged', PH.commissionArgsForHub('provider').category === 'services' && PH.commissionArgsForHub('entertainment').category === 'entertainment_bookings' && PH.commissionArgsForHub('healthcare').category === 'healthcare');
  /* legacy (no stamp): the most recent decided application decides */
  await db.doc('providers/legacy1').set({ name: 'Legacy', status: 'active' });
  await db.doc('applications/l_old').set({ uid: 'legacy1', status: 'approved', role: 'provider', category: 'dj', decidedAt: 1000 });
  await db.doc('applications/l_new').set({ uid: 'legacy1', status: 'approved', role: 'provider', category: 'plumbing', decidedAt: 5000 });
  ck('legacy provider: the MOST RECENTLY decided application decides the lane (not the first read)', (await PH.resolveProviderClassification(db, 'legacy1')).hub === 'provider');
  await db.doc('applications/l_new').set({ decidedAt: 500 }, { merge: true });
  ck('…and reversing the decision order reverses it (the order is the input, not an accident)', (await PH.resolveProviderClassification(db, 'legacy1')).hub === 'entertainment');

  say('\n── AdminOS decides the unclassified ──');
  ck('a non-admin cannot list or classify', await codeOf(BA.bizAdminProviders(USER('unk1'))) === 'permission-denied' && await codeOf(BA.bizAdminClassify({ ...USER('unk1'), data: { uid: 'unk1', category: 'trades', reason: 'self' } })) === 'permission-denied');
  const q = await BA.bizAdminProviders({ ...ADMIN, data: { view: 'unclassified' } });
  ck('the unclassified queue lists the ambiguous business', q.providers.some((r) => r.uid === 'unk1') && !q.providers.some((r) => r.uid === 'plumb1'));
  ck('a reason is required', await codeOf(BA.bizAdminClassify({ ...ADMIN, data: { uid: 'unk1', category: 'trades', reason: '' } })) === 'invalid-argument');
  ck('an unknown category is refused', await codeOf(BA.bizAdminClassify({ ...ADMIN, data: { uid: 'unk1', category: 'wizard', reason: 'x y z' } })) === 'invalid-argument');
  ck('Legal / Event organizer / Delivery belong to their own authorities', (await Promise.all(['lawyer', 'event_organizer', 'delivery'].map((k) => codeOf(BA.bizAdminClassify({ ...ADMIN, data: { uid: 'unk1', category: k, reason: 'try it' } }))))).every((x) => x === 'OWNED_BY_AUTHORITY'));
  ck('a Healthcare category cannot be given to a non-health business', await codeOf(BA.bizAdminClassify({ ...ADMIN, data: { uid: 'plumb1', category: 'pharmacy', reason: 'turn it into a pharmacy' } })) === 'HEALTHCARE_BOUNDARY');
  ck('…and a health provider cannot be given a non-health category', await codeOf(BA.bizAdminClassify({ ...ADMIN, data: { uid: 'doc1', category: 'trades', reason: 'make it a plumber' } })) === 'HEALTHCARE_BOUNDARY');
  await db.doc('providers/pend1').set({ name: 'Pending', status: 'pending', business: { category: null, source: 'application' } });
  ck('an unapproved business cannot be classified (decide the application first)', await codeOf(BA.bizAdminClassify({ ...ADMIN, data: { uid: 'pend1', category: 'trades', reason: 'shortcut' } })) === 'NOT_APPROVED');
  const r = await BA.bizAdminClassify({ ...ADMIN, data: { uid: 'unk1', category: 'trades', reason: 'Plumbing company per documents' } });
  const unkAfter = await get('providers/unk1');
  const audit = (await db.collection('adminAudit').get()).docs.map((d) => d.data()).find((a) => a.action === 'business_classify' && a.targetUid === 'unk1');
  ck('an admin classifies it: category set, source admin, classifiedBy recorded', unkAfter.business.category === 'trades' && unkAfter.business.source === 'admin' && unkAfter.business.classifiedBy === 'admin1');
  /* the ambiguous application's LANE is whatever the existing classifier decided at approval (here: entertainment,
     from "Photographer") — C1 preserves pricing exactly and reports the category/lane mismatch for C6. */
  const unkLane = PH.classifyDecidedApplication({ role: 'provider', category: 'plumbing', subcategory: 'Photographer' }).hub;
  ck('…the audit log has who, before, after, why and the lane that stayed', audit && audit.performedBy === 'admin1' && audit.previous === null && audit.next === 'trades' && /documents/.test(audit.reason) && audit.laneUnchanged === unkLane, audit);
  ck('…and the commercial lane was NOT changed by the reclassification', unkAfter.business.lane.hub === unkLane && r.laneUnchanged === unkLane, { lane: unkAfter.business.lane, classifier: unkLane });
  await approve('unk1', { role: 'provider', category: 'plumbing', subcategory: 'Photographer' });
  ck('a re-approval never overwrites an administrator\'s category', BC.categoryOf(await get('providers/unk1')) === 'trades');
  await HA.healthAdminClassify({ ...ADMIN, data: { uid: 'doc1', category: 'telemedicine', reason: 'online only practice' } });
  const docAfter = await get('providers/doc1');
  ck('healthAdminClassify keeps the two fields ONE decision (healthcare = business = telemedicine)', docAfter.healthcare.category === 'telemedicine' && docAfter.business.category === 'telemedicine');
  await BA.bizAdminClassify({ ...ADMIN, data: { uid: 'doc1', category: 'facility', reason: 'opened premises' } });
  const doc2 = await get('providers/doc1');
  ck('bizAdminClassify on a health provider moves both fields together', doc2.healthcare.category === 'facility' && doc2.business.category === 'facility' && HC.categoryOf(doc2) === 'facility');

  say('\n── public eligibility, from server facts ──');
  ck('an approved, classified, active business is eligible', BC.publicEligibility(await get('providers/plumb1')).eligible === true);
  const e1 = BC.publicEligibility({ status: 'active', business: { category: null } });
  ck('an UNCLASSIFIED business is not publicly eligible', !e1.eligible && e1.reasons.includes('UNCLASSIFIED'));
  ck('suspended / pending / not-searchable are not eligible', !BC.publicEligibility({ status: 'suspended', business: { category: 'trades' } }).eligible && !BC.publicEligibility({ status: 'pending', business: { category: 'trades' } }).eligible && !BC.publicEligibility({ status: 'active', searchable: false, business: { category: 'trades' } }).eligible);
  ck('a provider\'s free-text category never makes it eligible — even when it spells a real key', !BC.publicEligibility({ status: 'active', category: 'Hotel' }).eligible
    && BC.categoryOf({ category: 'hotel', categories: ['trades'], categoryLabel: 'salon', subcategory: 'lawyer' }) === null
    && !BC.publicEligibility({ status: 'active', category: 'trades' }).eligible);

  say('\n── the chain, end to end ──');
  const chainApp = { role: 'provider', category: 'cleaning', name: 'Sparkle Cleaners' };
  const chained = await approve('chain1', chainApp);
  const ws = BC.categoryOf(chained);
  ck('application → approval → server category → persisted → public eligibility (no client step)', ws === 'cleaning' && BC.publicEligibility(chained).eligible === true && chained.business.source === 'application');
  const ambChain = await approve('chain2', { role: 'provider', category: 'cleaning', subcategory: 'DJ' });
  ck('an ambiguous application stops at UNCLASSIFIED → AdminOS decision required (not eligible, no category)', BC.categoryOf(ambChain) === null && !BC.publicEligibility(ambChain).eligible && (await BA.bizAdminProviders({ ...ADMIN, data: { view: 'unclassified' } })).providers.some((x) => x.uid === 'chain2'));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
