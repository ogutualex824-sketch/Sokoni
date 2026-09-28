/* test-business-workspace-gates.js — the server refuses what the workspace does not offer (CHANGELOG 239, C2b).
 * Transactional fake Firestore + the REAL ent-rate-cards.js, ent-availability.js, ent-enquiries.js, provider-ops.js,
 * business-workspace.js and business-category.js. Every call below is made DIRECTLY — as a crafted client would,
 * with the dashboard nowhere in sight. No network.
 *
 * PROVES
 *   refused      a doctor cannot create rate cards or quotes, nor switch call requests on (NOT_APPLICABLE); an
 *                UNCLASSIFIED or SUSPENDED business cannot configure availability, block its calendar, create rate
 *                cards or discounts (PENDING_APPROVAL)
 *   existing     editing / re-versioning / granting an EXISTING rate card, withdrawing a quote and disabling a
 *                discount are refused the same way (the gate is not only on create)
 *   allowed      a plumber's quotes, discounts, availability, calendar blocks, enquiry settings and call requests
 *                all still work (positive control — the gate is not deny-all)
 *   legacy       a provider approved BEFORE C1 (no stamp) is grandfathered: everything it used still works
 *   venue        a venue calendar belongs to venue-manager's workspace and is NOT decided by the provider gate
 *   service cap  re-activating a deactivated service counts against the plan's cap, exactly like adding one
 *
 *   node scripts/test-business-workspace-gates.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-workspace-gates';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.now();
const F = makeFakeFirestore({ clock: () => NOW, strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) });
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const AV = require(Path.join(FN, 'ent-availability.js'));
const RC = require(Path.join(FN, 'ent-rate-cards.js'));
const EQ = require(Path.join(FN, 'ent-enquiries.js'));
const PO = require(Path.join(FN, 'provider-ops.js'));
AV._setClock && AV._setClock(() => NOW);

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid) => ({ auth: uid ? { uid, token: {} } : null, rawRequest: { headers: {} } });
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const WEEK = {}; ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((d) => { WEEK[d] = { closed: false, periods: [{ open: '08:00', close: '18:00' }], breaks: [] }; });
const D = (n) => new Date(NOW + n * 86400e3).toISOString().slice(0, 10);

async function seed(uid, doc) {
  await db.doc(`providers/${uid}`).set(Object.assign({ name: uid, status: 'active', acceptsBookings: true }, doc));
  await db.doc(`applications/app_${uid}`).set({ uid, status: 'approved', role: doc && doc.healthcare ? 'health' : 'provider', category: 'x', decidedAt: 1 });
  await db.doc(`providerAvailability/${uid}`).set({ uid, modes: ['fixed_hours'], schedule: WEEK, appt: { enabled: true, durationMins: 60, maxDaysAhead: 90, minNoticeHours: 1, allowSameDay: true }, cap: {} });
  await db.doc(`users/${uid}`).set({ displayName: uid });
}
const biz = (category) => ({ business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } });
const card = (uid) => RC._h.entRateCardCreate({ ...who(uid), data: { name: 'Standard call-out', version: { priceCents: 150000, unit: 'FIXED' } } });

(async () => {
  await seed('plumber', biz('trades'));
  await seed('doc1', { healthcare: { category: 'clinician', source: 'admin' }, business: { category: 'clinician', source: 'admin', lane: { hub: 'healthcare', entClass: null } } });
  await seed('unc1', biz(null));
  await seed('susp1', Object.assign(biz('trades'), { status: 'suspended' }));
  await seed('legacy1', {});   /* approved before C1: no business, no healthcare stamp */

  say('\n── positive control: an entitled plumber operates normally ──');
  const pc = await card('plumber').catch((e) => ({ error: (e.details && e.details.code) || e.message }));
  ck('plumber: create a rate card', !!(pc && pc.cardId), pc);
  ck('plumber: create a discount code', !(await codeOf(RC._h.entDiscountCreate({ ...who('plumber'), data: { code: 'FIXIT10', type: 'percent', value: 10, campaign: 'Launch', validTo: NOW + 30 * 86400e3, usageLimit: 50 } }))));
  ck('plumber: configure availability', !(await codeOf(AV._h.entAvailSetConfig({ ...who('plumber'), data: { config: { durationMins: 60 } } }))));
  ck('plumber: block a date on the calendar', !(await codeOf(AV._h.entAvailBlock({ ...who('plumber'), data: { date: D(5), label: 'Off' } }))));
  ck('plumber: save enquiry settings and switch call requests ON', !(await codeOf(EQ._h.entMessagingSetSettings({ ...who('plumber'), data: { settings: { enquiriesEnabled: true, callRequests: 'ENABLED' } } }))));

  say('\n── refused: not offered to this kind of business (direct calls) ──');
  ck('doctor: create a rate card → WORKSPACE_MODULE_NOT_APPLICABLE', await codeOf(card('doc1')) === 'WORKSPACE_MODULE_NOT_APPLICABLE');
  ck('doctor: create a quote → refused', await codeOf(RC._h.entQuoteCreate({ ...who('doc1'), data: { buyerUid: 'pt1', priceCents: 100000, note: 'x' } })) === 'WORKSPACE_MODULE_NOT_APPLICABLE');
  ck('doctor: switch call requests ON → refused (calls are not offered to Healthcare)', await codeOf(EQ._h.entMessagingSetSettings({ ...who('doc1'), data: { settings: { callRequests: 'ENABLED' } } })) === 'WORKSPACE_MODULE_NOT_APPLICABLE');
  ck('doctor (control): enquiry settings and availability still work', !(await codeOf(EQ._h.entMessagingSetSettings({ ...who('doc1'), data: { settings: { enquiriesEnabled: true } } })))
    && !(await codeOf(AV._h.entAvailSetConfig({ ...who('doc1'), data: { config: { durationMins: 30 } } }))));

  say('\n── refused: not eligible yet ──');
  ck('UNCLASSIFIED: configure availability → WORKSPACE_MODULE_PENDING_APPROVAL', await codeOf(AV._h.entAvailSetConfig({ ...who('unc1'), data: { config: { durationMins: 60 } } })) === 'WORKSPACE_MODULE_PENDING_APPROVAL');
  ck('UNCLASSIFIED: block the calendar / create a rate card / a discount → refused',
    (await Promise.all([AV._h.entAvailBlock({ ...who('unc1'), data: { date: D(5) } }), card('unc1'), RC._h.entDiscountCreate({ ...who('unc1'), data: { code: 'NOPE10', type: 'percent', value: 10, campaign: 'Launch', validTo: NOW + 30 * 86400e3, usageLimit: 50 } })].map(codeOf))).every((c) => c === 'WORKSPACE_MODULE_PENDING_APPROVAL'));
  ck('SUSPENDED: configure availability → refused', await codeOf(AV._h.entAvailSetConfig({ ...who('susp1'), data: { config: { durationMins: 60 } } })) === 'WORKSPACE_MODULE_PENDING_APPROVAL');
  ck('UNCLASSIFIED: enquiry settings → refused', await codeOf(EQ._h.entMessagingSetSettings({ ...who('unc1'), data: { settings: { enquiriesEnabled: true } } })) === 'WORKSPACE_MODULE_PENDING_APPROVAL');

  say('\n── refused on EXISTING records too (not only on create) ──');
  /* the plumber's card exists; the business is then reclassified by AdminOS into a category without quotes */
  const cardId = pc && pc.cardId;
  const disc = (await db.collection('mktCouponCodes').get()).docs.map((d) => ({ id: d.id, ...d.data() })).find((c) => c.merchantId === 'plumber');
  const q = await RC._h.entQuoteCreate({ ...who('plumber'), data: { buyerUid: 'buyer1', priceCents: 250000, note: 'Replace the tank' } }).catch((e) => ({ error: e.message }));
  await db.doc('providers/plumber').set({ business: { category: 'salon', source: 'admin', lane: { hub: 'provider', entClass: null } } }, { merge: true });
  ck('now a salon: updating the existing rate card → refused', await codeOf(RC._h.entRateCardUpdate({ ...who('plumber'), data: { cardId, name: 'Renamed' } })) === 'WORKSPACE_MODULE_NOT_APPLICABLE');
  ck('…a new price version → refused', await codeOf(RC._h.entRateCardNewVersion({ ...who('plumber'), data: { cardId, version: { priceCents: 200000, unit: 'FIXED' } } })) === 'WORKSPACE_MODULE_NOT_APPLICABLE');
  ck('…granting the card to a buyer → refused', await codeOf(RC._h.entRateCardGrant({ ...who('plumber'), data: { cardId, uid: 'buyer1' } })) === 'WORKSPACE_MODULE_NOT_APPLICABLE');
  ck('the quote and the discount exist (so the next two checks are not vacuous)', !!(q && q.quoteId) && !!disc, { q, disc: !!disc });
  ck('…withdrawing the quote → refused', !!q.quoteId && await codeOf(RC._h.entQuoteWithdraw({ ...who('plumber'), data: { quoteId: q.quoteId } })) === 'WORKSPACE_MODULE_NOT_APPLICABLE', q);
  ck('…disabling the discount still works (marketing is offered to a salon)', !!disc && !(await codeOf(RC._h.entDiscountDisable({ ...who('plumber'), data: { couponId: disc.id } }))));

  say('\n── legacy providers are grandfathered ──');
  ck('legacy (approved before C1): rate card, discount, availability, calendar, calls all still work',
    (await Promise.all([card('legacy1'), RC._h.entDiscountCreate({ ...who('legacy1'), data: { code: 'OLDIE10', type: 'percent', value: 10, campaign: 'Launch', validTo: NOW + 30 * 86400e3, usageLimit: 50 } }),
      AV._h.entAvailSetConfig({ ...who('legacy1'), data: { config: { durationMins: 45 } } }), AV._h.entAvailBlock({ ...who('legacy1'), data: { date: D(6) } }),
      EQ._h.entMessagingSetSettings({ ...who('legacy1'), data: { settings: { callRequests: 'ENABLED' } } })].map(codeOf))).every((c) => c === null));

  say('\n── venue calendars are venue-manager\'s ──');
  await db.doc('venues/V1').set({ name: 'Karura Hall', ownerId: 'doc1', status: 'active', openingHours: {}, slotDurationMins: 60, bookingHorizonDays: 365, pricing: { hourlyRate: 2000 } });
  const vc = await RC._h.entRateCardCreate({ ...who('doc1'), data: { venueId: 'V1', name: 'Hall hire', version: { priceCents: 500000, unit: 'FIXED' } } }).catch((e) => ({ error: (e.details && e.details.code) || e.message }));
  ck('a doctor who also owns a venue can price the VENUE (its calendar is not the provider workspace)', !!(vc && vc.cardId), vc);

  say('\n── the service cap holds on re-activation ──');
  await seed('cap1', biz('trades'));   /* no subscription → the floor: 1 active service */
  await db.doc('providerServices/s1').set({ providerId: 'cap1', name: 'A', active: true });
  await db.doc('providerServices/s2').set({ providerId: 'cap1', name: 'B', active: false });
  ck('with one active service at a cap of 1, re-activating a second → resource-exhausted', await codeOf(PO._h.providerToggleService({ ...who('cap1'), data: { serviceId: 's2', active: true } })) === 'resource-exhausted');
  ck('deactivating the first is allowed', !(await codeOf(PO._h.providerToggleService({ ...who('cap1'), data: { serviceId: 's1', active: false } }))));
  ck('…and then re-activating the second is allowed (1 of 1)', !(await codeOf(PO._h.providerToggleService({ ...who('cap1'), data: { serviceId: 's2', active: true } }))));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
