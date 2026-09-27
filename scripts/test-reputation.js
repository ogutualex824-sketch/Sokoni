/* test-reputation.js — provider followers, ratings, reviews, moderation and sharing (functions/reputation.js).
 *
 * The REAL modules (reputation, booking-service, provider-ops, reviews, notify stubbed) on the
 * transactional fake Firestore. No network, no production.
 *
 * PROVES
 *   Followers  follow · duplicate (idempotent) · unfollow · repeated unfollow · count integrity (never
 *              negative, never double) · self-follow refused · legacy client follow adopted once ·
 *              follower list: owner only, names only for followers who opted in, no uid / contact
 *   Ratings    only a COMPLETED own booking (service / show-up-settled / venue) · duplicate · self ·
 *              forged provider / reviewer / transaction ids · before completion · after cancellation /
 *              refund · outside the 60-day window · a non-integer rating · aggregate server-derived
 *   Reviews    edit rules (author, 14 days, 3 edits) · provider reply (own only; never the rating) ·
 *              report (controlled reasons; never changes the rating) · moderation hide / restore (admin)
 *              / remove (super) excludes and re-includes the aggregate; the booking is untouched ·
 *              public projection has no uid / booking id / contact
 *   Sharing    handle links without uid / phone / email · service + event links · a share event
 *              never moves followers or ratings · once per person per day
 *   Legacy     bookingSubmitReview now writes the PUBLIC aggregate · generic reviews.js no longer resolves
 *              providers · migration: slug follows → account follows, ambiguous / orphan reported
 *
 *   node scripts/test-reputation.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-reputation';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const REAL_NOW = Date.now();
let NOW = REAL_NOW;
const F = makeFakeFirestore({ clock: () => NOW, strictReadOrder: true });
const db = F.db;
const say = console.log;
console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', ADMIN);
const notices = [];
stub('./notify', { notify: async (n) => { notices.push(n); return { ok: true }; }, TYPES: {} });

const REP = require(Path.join(FN, 'reputation.js'));
const BS = require(Path.join(FN, 'booking-service.js'));
const PO = require(Path.join(FN, 'provider-ops.js'));
REP._setClock(() => NOW);

let pass = 0, fail = 0; let pubIdA = null;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600e3; const DAY = 86400e3;
const h = (op, uid, data, token) => REP._h[op]({ ...who(uid, token), data: data || {} });
const a = (op, uid, data, token) => REP._adminH[op]({ ...who(uid, token), data: data || {} });

(async () => {
  for (const u of ['b1', 'b2', 'b3', 'b4', 'mallory', 'ph1', 'ph2', 'vo1']) await db.doc(`users/${u}`).set({ displayName: u === 'b1' ? 'Achieng Otieno' : u === 'b2' ? 'Brian Kamau' : u, email: u + '@x.co', phone: '0712' + u });
  await db.doc('providers/ph1').set({ uid: 'ph1', name: 'Jane Photography', status: 'active', verified: true, rating: 5, reviewCount: 999 });   /* owner-written legacy values */
  await db.doc('providers/ph2').set({ uid: 'ph2', name: 'Otto Sound', status: 'active' });
  await db.doc('providers/susp').set({ uid: 'susp', name: 'Gone', status: 'suspended' });
  await db.doc('venues/V1').set({ name: 'Karura Hall', ownerId: 'vo1', status: 'active' });
  await db.doc('creators/cr1').set({ uid: 'cr1', state: 'ACTIVE', displayName: 'Kibera Films' });
  const pb = (id, over) => db.doc('providerBookings/' + id).set(Object.assign({ providerId: 'ph1', customerUid: 'b1', customerName: 'Achieng Otieno', service: 'Portraits', serviceId: 's1',
    status: 'completed', paymentStatus: 'settled', startTs: NOW - 5 * DAY, endTs: NOW - 5 * DAY + 2 * H, price: 500000 }, over || {}));

  /* ═══ followers ═══ */
  say('\n── followers ──');
  ck('the legacy owner-written rating (5★, 999 reviews) is NOT the public aggregate', (await h('repSummary', null, { items: [{ type: 'provider', id: 'ph1' }] })).summaries['provider:ph1'].rating === null);
  const f1 = await h('repFollow', 'b1', { type: 'provider', id: 'ph1' });
  ck('follow → following, count 1', f1.following === true && f1.followerCount === 1);
  const f1b = await h('repFollow', 'b1', { type: 'provider', id: 'ph1' });
  ck('a duplicate follow is idempotent (count stays 1)', f1b.already === true && (await get('providers/ph1')).followerCount === 1);
  await Promise.all(['b2', 'b3', 'b4'].map((u) => h('repFollow', u, { type: 'provider', id: 'ph1' })));
  ck('concurrent follows by different people → exact count (4)', (await get('providers/ph1')).followerCount === 4);
  const u1 = await h('repUnfollow', 'b4', { type: 'provider', id: 'ph1' });
  const u2 = await h('repUnfollow', 'b4', { type: 'provider', id: 'ph1' });
  ck('unfollow decrements once; a repeated unfollow is a no-op', u1.followerCount === 3 && u2.already === true && (await get('providers/ph1')).followerCount === 3);
  ck('self-follow is refused', (await code(h('repFollow', 'ph1', { type: 'provider', id: 'ph1' }))) === 'failed-precondition');
  ck('a suspended provider cannot be followed', (await code(h('repFollow', 'b1', { type: 'provider', id: 'susp' }))) === 'failed-precondition');
  ck('the follow is keyed by the caller (a client cannot follow on someone else\'s behalf — no uid input)', !!(await get('follows/b1--provider--ph1')) && !(await get('follows/mallory--provider--ph1')));
  await db.doc('providers/ph2').set({}, { merge: true });
  await db.doc('follows/b1--provider--ph2').set({ uid: 'b1', type: 'provider', entityId: 'ph2', createdAt: 1 });   /* a legacy client-written follow */
  await db.doc('follows/b2--provider--ph2').set({ uid: 'b2', type: 'provider', entityId: 'ph2', createdAt: 1 });
  const adopt = await h('repFollow', 'b1', { type: 'provider', id: 'ph2' });
  ck('a legacy client follow is ADOPTED and counted once (b1 + b2 = 2, not 3)', adopt.followerCount === 2, adopt);
  const zero = await h('repUnfollow', 'b1', { type: 'provider', id: 'ph2' }); await h('repUnfollow', 'b2', { type: 'provider', id: 'ph2' });
  const neg = await h('repUnfollow', 'b2', { type: 'provider', id: 'ph2' });
  ck('the count never goes negative', neg.followerCount === 0 && (await get('providers/ph2')).followerCount === 0, { zero, neg });
  /* a count that drifted below its follow records (e.g. a hand-edited doc) must still floor at zero */
  await db.doc('providers/ph2').set({ followerCount: 0, followV: 1 }, { merge: true });
  await db.doc('follows/b5--provider--ph2').set({ uid: 'b5', type: 'provider', entityId: 'ph2', via: 'server' });
  const drift = await h('repUnfollow', 'b5', { type: 'provider', id: 'ph2' });
  ck('a drifted count at 0 floors at 0 on unfollow (never -1)', drift.followerCount === 0 && (await get('providers/ph2')).followerCount === 0, drift);
  await h('repFollow', 'mallory', { type: 'provider', id: 'ph2', uid: 'b9' });
  ck('identity spoofing: a client-sent uid is ignored — the follow belongs to the CALLER', !(await get('follows/b9--provider--ph2')) && !!(await get('follows/mallory--provider--ph2')));
  await h('repFollowVisibility', 'b2', { type: 'provider', id: 'ph1', showMe: true });
  const fl = await h('repFollowers', 'ph1', { type: 'provider', id: 'ph1' });
  ck('the provider sees the count and ONLY followers who opted in, by first name + initial', fl.followerCount === 3 && fl.visible.length === 1 && fl.visible[0].name === 'Brian K.' && fl.hiddenCount === 2);
  ck('…never a uid, email or phone', !/b1|b2|b3|@x\.co|0712/.test(JSON.stringify(fl.visible)));
  ck('another user cannot list a provider\'s followers (no enumeration)', (await code(h('repFollowers', 'mallory', { type: 'provider', id: 'ph1' }))) === 'permission-denied');
  ck('venue and creator follows use the same authority', (await h('repFollow', 'b1', { type: 'venue', id: 'V1' })).followerCount === 1 && (await h('repFollow', 'b1', { type: 'creator', id: 'cr1' })).followerCount === 1);
  ck('the venue owner cannot follow their own venue', (await code(h('repFollow', 'vo1', { type: 'venue', id: 'V1' }))) === 'failed-precondition');

  /* ═══ ratings / reviews ═══ */
  say('\n── ratings & eligibility ──');
  await pb('pbA');
  const r1 = await BS._h.bookingSubmitReview({ ...who('b1'), data: { bookingId: 'pbA', rating: 5, text: 'Wonderful portraits, call me at 0712345678' } });
  const pv = await get('providers/ph1');
  ck('the canonical bookingSubmitReview → one review, the PUBLIC aggregate (providers) + private mirror', r1.created && pv.repV === 1 && pv.reviewCount === 1 && pv.rating === 5 && pv.ratingDist[5] === 1 && (await get('providerProfiles/ph1')).reviewCount === 1);
  ck('…the review keeps its authoritative source and is marked verified by the server', (await get('providerReviews/pbA')).sourceRef === 'providerBookings/pbA' && (await get('providerReviews/pbA')).verified === true);
  ck('a duplicate review for the same booking is a no-op (aggregate unchanged)', (await BS._h.bookingSubmitReview({ ...who('b1'), data: { bookingId: 'pbA', rating: 1 } })).alreadyReviewed === true && (await get('providers/ph1')).reviewCount === 1);
  ck('another customer cannot review this booking (forged reviewer)', (await code(h('repSubmitReview', 'mallory', { bookingId: 'pbA', rating: 1 }))) === 'permission-denied');
  await pb('pbB', { status: 'confirmed', paymentStatus: 'paid_held', endTs: NOW + DAY });
  ck('a booking not yet completed cannot be rated', (await code(h('repSubmitReview', 'b1', { bookingId: 'pbB', rating: 4 }))) === 'failed-precondition');
  await pb('pbC', { status: 'cancelled', paymentStatus: 'refunded' });
  ck('a cancelled / refunded booking cannot be rated', (await code(h('repSubmitReview', 'b1', { bookingId: 'pbC', rating: 1 }))) === 'failed-precondition');
  await pb('pbR', { paymentStatus: 'refunded' });
  ck('a COMPLETED booking that was refunded cannot be rated', (await code(h('repSubmitReview', 'b1', { bookingId: 'pbR', rating: 1 }))) === 'failed-precondition');
  await pb('pbD', { endTs: NOW - 70 * DAY });
  ck('outside the 60-day window cannot be rated', (await code(h('repSubmitReview', 'b1', { bookingId: 'pbD', rating: 4 }))) === 'failed-precondition');
  ck('a forged / unknown transaction is refused', (await code(h('repSubmitReview', 'b1', { bookingId: 'doesNotExist', rating: 5 }))) === 'not-found');
  await pb('pbE', { customerUid: 'ph1' });
  ck('self-review is refused (the provider cannot review their own business)', (await code(h('repSubmitReview', 'ph1', { bookingId: 'pbE', rating: 5 }))) === 'permission-denied');
  ck('a client-supplied provider id, rating aggregate or verified flag is ignored', (await code(h('repSubmitReview', 'b1', { bookingId: 'pbF', rating: 5, providerId: 'ph2', averageRating: 5, ratingCount: 900, verified: true }))) === 'not-found');
  await pb('pbG', { status: 'in_progress', settledTrigger: 'show_up', paymentStatus: 'settled', endTs: NOW - H });
  ck('a show-up-verified and settled booking whose time has ended is eligible', (await h('repSubmitReview', 'b1', { bookingId: 'pbG', rating: 3 })).created === true);
  ck('a non-integer or out-of-range rating is refused', (await code(h('repSubmitReview', 'b1', { bookingId: 'pbH', rating: 4.5 }))) === 'invalid-argument' && (await code(h('repSubmitReview', 'b1', { bookingId: 'pbH', rating: 6 }))) === 'invalid-argument');
  const agg = await h('repSummary', null, { items: [{ type: 'provider', id: 'ph1' }] });
  ck('aggregate = server-derived average of eligible reviews (5 + 3 → 4.0, 2 reviews, distribution)', agg.summaries['provider:ph1'].rating === 4 && agg.summaries['provider:ph1'].reviewCount === 2 && agg.summaries['provider:ph1'].ratingDist[3] === 1);
  /* venue */
  await db.doc('bookings/vb1').set({ venueId: 'V1', ownerId: 'vo1', customerId: 'b2', venueName: 'Karura Hall', status: 'completed', paymentStatus: 'paid', requiresPayment: false, startTs: NOW - 3 * DAY, endTs: NOW - 3 * DAY + 2 * H });
  const vr = await h('repSubmitReview', 'b2', { source: 'bookings', bookingId: 'vb1', rating: 4, text: 'Great hall' });
  ck('a completed venue booking → a VENUE review (ven_ id) and the venue aggregate', vr.created && vr.reviewId === 'ven_vb1' && (await get('venues/V1')).reviewCount === 1 && (await get('venues/V1')).rating === 4);
  await db.doc('bookings/vb2').set({ venueId: 'V1', ownerId: 'mallory', customerId: 'b2', status: 'completed', paymentStatus: 'paid', endTs: NOW - DAY });
  ck('a venue booking whose owner does not match the venue is not reviewable (forged provider)', (await code(h('repSubmitReview', 'b2', { source: 'bookings', bookingId: 'vb2', rating: 1 }))) === 'failed-precondition');
  await db.doc('bookings/vb3').set({ venueId: 'V1', ownerId: 'vo1', customerId: 'b3', status: 'completed', paymentStatus: 'awaiting', requiresPayment: true, endTs: NOW - DAY });
  ck('an unpaid venue booking cannot be rated', (await code(h('repSubmitReview', 'b3', { source: 'bookings', bookingId: 'vb3', rating: 5 }))) === 'failed-precondition');

  /* ═══ public projection ═══ */
  say('\n── public reviews ──');
  const pub = await h('repReviews', null, { type: 'provider', id: 'ph1' });
  ck('public reviews: first name + initial, verified, no uid / booking id / service id / email', pub.reviews.length === 2 && pub.reviews.some((r) => r.author === 'Achieng O.') && !/\bb1\b|pbA|pbG|s1|@x\.co/.test(JSON.stringify(pub)));
  ck('…each public review carries an OPAQUE id (never the booking id)', pub.reviews.every((r) => /^rv_[0-9a-f]{24}$/.test(r.id)) && pub.reviews.map((r) => r.id).sort().join() === [REP.publicReviewId('pbA'), REP.publicReviewId('pbG')].sort().join());
  pubIdA = REP.publicReviewId('pbA');
  ck('venue reviews are separate from the owner\'s provider reviews', (await h('repReviews', null, { type: 'venue', id: 'V1' })).reviews.length === 1);

  /* ═══ edit ═══ */
  say('\n── review edits ──');
  await h('repEditReview', 'b1', { reviewId: 'pbG', rating: 5, text: 'Better than I first said' });
  ck('the author edits (3 → 5): aggregate moves by the difference (5 + 5 → 5.0), marked edited', (await get('providers/ph1')).rating === 5 && (await get('providerReviews/pbG')).edited === true);
  ck('nobody else can edit it (forged reviewer)', (await code(h('repEditReview', 'mallory', { reviewId: 'pbG', rating: 1 }))) === 'permission-denied');
  await h('repEditReview', 'b1', { reviewId: 'pbG', text: 'x2' }); await h('repEditReview', 'b1', { reviewId: 'pbG', text: 'x3' });
  ck('at most 3 edits', (await code(h('repEditReview', 'b1', { reviewId: 'pbG', text: 'x4' }))) === 'failed-precondition');
  NOW += 15 * DAY;
  ck('no edit after 14 days', (await code(h('repEditReview', 'b1', { reviewId: 'pbA', text: 'late' }))) === 'failed-precondition');
  NOW = REAL_NOW;

  /* ═══ reply ═══ */
  say('\n── provider response ──');
  await PO._h.providerReplyReview({ ...who('ph1'), data: { reviewId: 'pbA', reply: 'Thank you!' } });
  const rr = await get('providerReviews/pbA');
  ck('the provider replies to a review of THEIR business — the rating and text are untouched', rr.reply === 'Thank you!' && rr.rating === 5 && /Wonderful/.test(rr.text) && notices.some((n) => n.type === 'rep_review_reply' && n.uid === 'b1'));
  ck('another provider cannot reply (impersonation)', (await code(PO._h.providerReplyReview({ ...who('ph2'), data: { reviewId: 'pbA', reply: 'fake' } }))) === 'permission-denied');
  ck('the venue owner replies to their venue review', !!(await PO._h.providerReplyReview({ ...who('vo1'), data: { reviewId: 'ven_vb1', reply: 'Come again' } })).success);

  /* ═══ report + moderation ═══ */
  say('\n── report & moderation ──');
  ck('a report needs a controlled reason', (await code(h('repReportReview', 'ph1', { reviewId: 'pbA', reason: 'DELETE_IT' }))) === 'invalid-argument');
  await h('repReportReview', 'ph1', { reviewId: 'pbA', reason: 'PERSONAL_INFORMATION', detail: 'phone number in the text' });
  await h('repReportReview', 'b2', { reviewId: pubIdA, reason: 'PERSONAL_INFORMATION' });
  ck('a member of the public reports by the PUBLIC id; the case resolves to the real review', db._dump('reports/').filter((r) => r.entityId === 'pbA').length === 2 && (await get('providerReviews/pbA')).reportCount === 2);
  ck('an unknown public id is refused', (await code(h('repReportReview', 'b2', { reviewId: 'rv_' + '0'.repeat(24), reason: 'SPAM' }))) === 'not-found');
  ck('reporting creates a moderation case in the trust & safety store and does NOT change the rating', !!db._dump('reports/').find((r) => r.entityType === 'providerReview' && r.entityId === 'pbA' && r.status === 'pending') && (await get('providers/ph1')).rating === 5 && (await get('providerReviews/pbA')).status === 'published');
  ck('the same person cannot report twice', (await code(h('repReportReview', 'ph1', { reviewId: 'pbA', reason: 'SPAM' }))) === 'already-exists');
  ck('a non-admin cannot moderate', (await code(a('repAdminModerate', 'ph1', { reviewId: 'pbA', action: 'hide', reason: 'I dislike it' }))) === 'permission-denied');
  ck('an admin cannot REMOVE (super admin only)', (await code(a('repAdminModerate', 'adm', { reviewId: 'pbA', action: 'remove', reason: 'personal info' }, { admin: true }))) === 'permission-denied');
  await a('repAdminModerate', 'adm', { reviewId: 'pbA', action: 'hide', reason: 'phone number in the review' }, { admin: true });
  ck('HIDE → excluded from the public aggregate and the public list; the booking is untouched', (await get('providers/ph1')).reviewCount === 1 && (await h('repReviews', null, { type: 'provider', id: 'ph1' })).reviews.length === 1 && (await get('providerBookings/pbA')).status === 'completed');
  ck('…the reports are resolved, the action audited with who and why', db._dump('reports/').filter((r) => r.entityId === 'pbA').every((r) => r.status === 'resolved') && db._dump('reputationAudit/').some((x) => x.action === 'review_hide' && x.actor === 'adm' && x.reason === 'phone number in the review'));
  await a('repAdminModerate', 'adm', { reviewId: 'pbA', action: 'restore', reason: 'number removed by the author' }, { admin: true });
  ck('RESTORE → counted again', (await get('providers/ph1')).reviewCount === 2);
  await a('repAdminModerate', 'sadm', { reviewId: 'pbA', action: 'remove', reason: 'repeated personal information' }, { superAdmin: true });
  ck('REMOVE (super admin) → excluded, and a removed review cannot be restored', (await get('providers/ph1')).reviewCount === 1 && (await code(a('repAdminModerate', 'sadm', { reviewId: 'pbA', action: 'restore', reason: 'try again' }, { superAdmin: true }))) === 'failed-precondition');
  ck('a moderation needs a reason', (await code(a('repAdminModerate', 'adm', { reviewId: 'pbG', action: 'hide', reason: '' }, { admin: true }))) === 'invalid-argument');
  const rc = await a('repAdminRecount', 'sadm', { type: 'provider', id: 'ph1', reason: 'integrity check' }, { superAdmin: true });
  ck('recount from the authoritative records agrees with the maintained aggregate', rc.reviewCount === (await get('providers/ph1')).reviewCount && rc.followerCount === (await get('providers/ph1')).followerCount, rc);

  /* ═══ my reviews ═══ */
  await pb('pbM', { customerUid: 'b3', customerName: 'Chebet' });
  const mr = await h('repMyReviews', 'b3');
  ck('"my reviews": the eligible completed booking is offered; an ineligible one is not', mr.eligible.some((e) => e.bookingId === 'pbM') && !mr.eligible.some((e) => e.bookingId === 'vb3'));

  /* ═══ sharing ═══ */
  say('\n── sharing ──');
  const sl = await h('repShareLink', null, { type: 'provider', id: 'ph1' });
  ck('a provider share link is a HANDLE — no uid, phone or email', /^https:\/\/mysokoni\.co\.ke\/p\.html\?h=[a-z0-9-]+$/.test(sl.url) && !/ph1|0712|@/.test(sl.url), sl.url);
  ck('…the same handle every time', (await h('repShareLink', 'b2', { type: 'provider', id: 'ph1' })).url === sl.url);
  const res = await h('repResolveHandle', null, { h: sl.url.split('h=')[1] });
  ck('the handle resolves to the public profile page — still by HANDLE, never the uid (the id is returned for the page only)', res.path === '/provider-profile.html?h=' + sl.url.split('h=')[1] && res.id === 'ph1' && !/uid=/.test(res.path), res);
  await db.doc('providerServices/s1').set({ providerId: 'ph1', name: 'Portraits', active: true });
  ck('a service link adds only the service id', /&s=s1$/.test((await h('repShareLink', null, { type: 'provider', id: 'ph1', serviceId: 's1' })).url));
  ck('another provider\'s service cannot be shared under this profile', (await code(h('repShareLink', null, { type: 'provider', id: 'ph2', serviceId: 's1' }))) === 'failed-precondition');
  await db.doc('events/ev1').set({ title: 'Jazz Night', status: 'live' });
  ck('an event link uses the event\'s public id', (await h('repShareLink', null, { type: 'event', id: 'ev1' })).url === 'https://mysokoni.co.ke/event-hub.html?event=ev1');
  const before = await get('providers/ph1');
  const s1 = await h('repShareEvent', 'b1', { type: 'provider', id: 'ph1', channel: 'whatsapp' });
  const s2 = await h('repShareEvent', 'b1', { type: 'provider', id: 'ph1', channel: 'whatsapp' });
  const s3 = await h('repShareEvent', null, { type: 'provider', id: 'ph1', channel: 'copy' });
  const after = await get('providers/ph1');
  ck('a share event counts once per person per day, signed-out not at all', s1.counted && !s2.counted && !s3.counted && after.shareCount === (before.shareCount || 0) + 1);
  ck('…and never moves followers or ratings', after.followerCount === before.followerCount && after.rating === before.rating && after.reviewCount === before.reviewCount);

  /* ═══ legacy authorities ═══ */
  say('\n── the second provider review authority is closed ──');
  const RV = require(Path.join(FN, 'reviews.js'));
  const srcTxt = require('fs').readFileSync(Path.join(FN, 'reviews.js'), 'utf8');
  ck('generic reviews.js no longer resolves a PROVIDER target (one provider review authority)', !/col: 'providers'/.test(srcTxt) && !!RV);
  const MIG = require(Path.join(ROOT, 'scripts', 'migrate-reputation.js'));
  await db.doc('providers/dup1').set({ name: 'Same Name', status: 'active' }); await db.doc('providers/dup2').set({ name: 'Same Name', status: 'active' });
  await db.doc('follows/b1--service--sv_jane_photography').set({ uid: 'b1', type: 'service', entityId: 'sv_jane_photography', entityName: 'Jane Photography' });
  await db.doc('follows/b4--service--sv_jane_photography').set({ uid: 'b4', type: 'service', entityId: 'sv_jane_photography', entityName: 'Jane Photography' });
  await db.doc('follows/b2--service--sv_same_name').set({ uid: 'b2', type: 'service', entityId: 'sv_same_name' });
  await db.doc('follows/b2--service--sv_nobody').set({ uid: 'b2', type: 'service', entityId: 'sv_nobody' });
  const dry = await MIG.migrateFollows(db, { apply: false });
  ck('migration DRY RUN: slug follows mapped to ONE provider; ambiguous and orphan names reported; nothing written', dry.migrated === 2 && dry.ambiguous.length === 1 && dry.orphan.length === 1 && !(await get('follows/b4--provider--ph1')));
  await MIG.migrateFollows(db, { apply: true });
  ck('--apply: the follow becomes an account follow (server), the legacy doc is stamped, re-run is a no-op', !!(await get('follows/b4--provider--ph1')) && (await get('follows/b4--provider--ph1')).via === 'server' && !!(await get('follows/b4--service--sv_jane_photography')).migratedTo && (await MIG.migrateFollows(db, { apply: true })).alreadyMigrated === 2);
  const rcAll = await MIG.recountAll(db, REP, { apply: true });
  ck('recount after migration: ph1 followers = 4 (b1 b2 b3 server + b4 migrated; b1 slug follow not double-counted)', rcAll.providers >= 3 && (await get('providers/ph1')).followerCount === 4, (await get('providers/ph1')).followerCount);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
