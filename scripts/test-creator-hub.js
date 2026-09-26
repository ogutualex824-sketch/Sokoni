/* test-creator-hub.js — the Creator Hub server module, end to end, on an
 * in-memory Firestore with REAL transaction semantics (scripts/lib/fake-firestore-txn.js:
 * buffered commits, create() preconditions, optimistic retry).
 *
 * WHAT THESE PROVE (each grant paired with its refusal)
 *   Publishing   creator draft · cross-creator edit denied · forged fields refused ·
 *                approval required · admin approve locks v1 · suspended creator denied ·
 *                legacy self-publish of a Creator film refused
 *   Purchase     real createPaymentIntent → film_access pricer: server amount, KES,
 *                NO sellerUid · kill switch · own-film / licence / already-owned refused
 *   Settlement   PENDING grants nothing · COMPLETE → entitlement + pointer + ledger ·
 *                Σ participant rows == pool == gross − fee − 15% · replay → one allocation ·
 *                8 CONCURRENT accruals → one allocation · unreported fee WITHHELD (access
 *                still granted) · attested fee → accrued · foreign payer refused
 *   Access       paid allowed · unpaid / other-user / 3rd session / expired rental /
 *                refunded denied · watermark masked · heartbeat revocation
 *   Royalties    v2 lock governs later sales only · late sale → next quarter ·
 *                calculate-before-end refused · self-approve refused · distribute credits
 *                wallets.balance once (replay-safe) · hold skips · refund reversal
 *                (full, partial, replay, void-before-accrual)
 *   AdminOS      every creatorAdmin* op refuses a non-admin · config needs superAdmin
 *   Wiring       webhook film branch precedes commission+credit · credit guard · refund
 *                rail guards · purpose/adapter/dispatcher registration
 *
 * NO NETWORK: firebase-admin is replaced wholesale in the require cache and
 * FIRESTORE_EMULATOR_HOST points at a dead port as a tripwire.
 *
 *   node scripts/test-creator-hub.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-creator-test';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const Path = require('path');
const fs = require('fs');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');

let NOW = Date.UTC(2026, 7, 15, 9, 0, 0);          /* 15 Aug 2026 — Q3 */
const F = makeFakeFirestore({ clock: () => NOW });
const db = F.db;

/* ── storage + auth fakes ── */
const objects = new Map();   // path -> { contentType, size, generation }
const signed = [];
const bucket = { file: (p) => ({
  exists: async () => [objects.has(p)],
  getMetadata: async () => [{ ...objects.get(p) }],
  getSignedUrl: async (o) => { signed.push({ path: p, ...o }); return [`https://storage.googleapis.com/fake/${encodeURIComponent(p)}?X-Goog-Expires=${Math.round((o.expires - NOW) / 1000)}&sig=abc`]; },
}) };
const users = { v1: { uid: 'v1', email: 'viewer.one@gmail.com', phoneNumber: '+254712345678', displayName: 'Wanjiku Muthoni' } };

const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { require.cache[resolveIn(m)] = { id: m, filename: m, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/storage', { getStorage: () => ({ bucket: () => bucket }) });
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (u) => { if (!users[u]) throw new Error('no user'); return users[u]; } }) });
const adminNs = { apps: [{}], initializeApp: () => ({}), app: () => ({}),
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => users[u] }), storage: () => ({ bucket: () => bucket }) };
stub('firebase-admin', adminNs);

const H = require(Path.join(FN, 'creator-hub.js'));
H._internal._setClock(() => NOW);
const R = require(Path.join(FN, 'shared', 'creator-royalty.js'));
const engine = require(Path.join(FN, 'entitlement-engine.js'));
require(Path.join(FN, 'entitlement-adapters.js'));
const purposes = require(Path.join(FN, 'payment-purposes.js'));
let intents = null;
try { intents = require(Path.join(FN, 'payment-intents.js')); } catch (e) { console.log('  (payment-intents not loadable: ' + e.message.split('\n')[0] + ')'); }

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 100) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, claims = {}) => ({ auth: uid ? { uid, token: { ...claims } } : null, rawRequest: { headers: { 'x-forwarded-for': '41.90.1.23' } } });
const call = (op, uid, data = {}, claims) => H._internal.OPS[op]({ ...who(uid, claims), data: { op, ...data } });
const adm = (op, uid, data = {}, claims = { admin: true }) => H._adminH[op]({ ...who(uid, claims), data });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
async function msg(p) { try { await p; return ''; } catch (e) { return e.message; } }
const docs = (prefix) => db._dump(prefix);
const read = async (p) => (await db.doc(p).get()).data();

const POSTER = (uid) => `https://firebasestorage.googleapis.com/v0/b/x/o/creator-public%2F${uid}%2Fposter.jpg?alt=media`;
const PARTS = [
  { participantId: 'producer', participantType: 'producer', uid: 'cA', bps: 4000 },
  { participantId: 'actorA', participantType: 'actor', uid: 'uActA', bps: 2000 },
  { participantId: 'actorB', participantType: 'actor', uid: 'uActB', bps: 1500 },
  { participantId: 'director', participantType: 'director', uid: 'uDir', bps: 1000 },
  { participantId: 'publisher', participantType: 'publisher', uid: 'uPub', bps: 1500 },
];

/* Simulate what webhookIntasend writes on a COMPLETE callback (the claim txn). */
async function settle(ref, { status = 'COMPLETE', uid = 'v1', value, net, charges, currency = 'KES' } = {}) {
  const i = await read('paymentIntents/' + ref);
  await db.doc('payments/' + ref).set({ ref, status, uid, amount: i.amount, currency: 'KES', intentRef: ref, checkoutId: 'CHK' + ref,
    confirmedAmount: net != null ? net : i.amount, providerReport: { value: value ?? null, netAmount: net ?? null, charges: charges ?? null, currency },
    webhookReceivedAt: F.Timestamp.fromMillis(NOW), updatedAt: F.Timestamp.fromMillis(NOW) });
}
async function buy(buyer, filmId) {
  const r = await intents.createPaymentIntent.run({ ...who(buyer), data: { purpose: 'film_access', filmId, phone: '254712345678' } });
  return r.ref || r.intentRef || r.paymentRef;
}

(async () => {
  /* ═══ setup: creator, film, agreement ═══ */
  console.log('\n── publishing ──');
  ck('unauthenticated register refused', (await code(call('creator.register', null, { displayName: 'X' }))) === 'unauthenticated');
  const reg = await call('creator.register', 'cA', { displayName: 'Kibera Films', bio: 'Stories', country: 'KE', legalName: 'Kibera Films Ltd', phone: '+254700000001', supportEmail: 'help@kibera.film' });
  ck('creator registers as PENDING', reg.state === 'PENDING');
  ck('private contact stored apart from public profile', !(await read('creators/cA')).phone && (await read('creatorPrivate/cA')).phone === '+254700000001');
  const draft = await call('film.saveDraft', 'cA', { title: 'Nairobi Nights', subcategory: 'movies', priceCents: 50000, currency: 'KES', accessType: 'purchase', posterUrl: POSTER('cA'), runtimeMinutes: 96, ageRating: '16' });
  const FILM = draft.filmId;
  ck('PENDING creator may draft', draft.pubState === 'DRAFT');
  const fdoc = await read('entertainmentListings/' + FILM);
  ck('film lives in the canonical entertainmentListings catalogue', fdoc.creatorHub === true && fdoc.category === 'creator' && fdoc.status === 'draft');
  ck('film doc carries NO media URL', !('streamingUrl' in fdoc) && !('mediaPath' in fdoc));
  ck('forged creatorUid refused', /field_server_owned/.test(await msg(call('film.saveDraft', 'cA', { filmId: FILM, creatorUid: 'attacker' }))));
  ck('forged pubState refused', /field_server_owned/.test(await msg(call('film.saveDraft', 'cA', { filmId: FILM, pubState: 'PUBLISHED' }))));
  ck('unregistered user cannot edit a film', (await code(call('film.saveDraft', 'cEvil', { filmId: FILM, title: 'Mine now' }))) === 'failed-precondition');
  await call('creator.register', 'cEvil', { displayName: 'Other Studio' });
  await adm('creatorAdminSetState', 'adm1', { uid: 'cEvil', to: 'ACTIVE' });
  ck('cross-creator edit denied (registered, ACTIVE rival)', (await code(call('film.saveDraft', 'cEvil', { filmId: FILM, title: 'Mine now' }))) === 'permission-denied');
  ck('cross-creator media target denied', (await code(call('film.mediaUploadTarget', 'cEvil', { filmId: FILM }))) === 'permission-denied');
  ck('cross-creator submit denied', (await code(call('film.submit', 'cEvil', { filmId: FILM }))) === 'permission-denied');
  ck('USD price refused (no convert-and-settle)', /currency_unsupported/.test(await msg(call('film.saveDraft', 'cA', { filmId: FILM, currency: 'USD' }))));
  ck('attach before upload refused', /upload target/i.test(await msg(call('film.attachMedia', 'cA', { filmId: FILM }))));
  const tgt = await call('film.mediaUploadTarget', 'cA', { filmId: FILM });
  ck('upload target is under the creator\'s own private prefix', tgt.storagePath.startsWith(`creator-masters/cA/${FILM}/`));
  objects.set(tgt.storagePath, { contentType: 'application/pdf', size: 10, generation: 1 });
  ck('non-video master refused', /not a video/.test(await msg(call('film.attachMedia', 'cA', { filmId: FILM }))));
  objects.set(tgt.storagePath, { contentType: 'video/mp4', size: 1_500_000_000, generation: 2 });
  ck('verified master attaches', (await call('film.attachMedia', 'cA', { filmId: FILM })).mediaReady === true);
  ck('private media record written server-side', (await read('creatorMedia/' + FILM)).storagePath === tgt.storagePath);
  ck('split > 100% refused', /exceeds/.test(await msg(call('agreement.saveDraft', 'cA', { filmId: FILM, rightsAttestation: 'rights-attestation-v1', participants: [...PARTS, { participantId: 'x', participantType: 'other', uid: 'ux', bps: 1 }] }))));
  ck('negative share refused', /bps must be > 0/.test(await msg(call('agreement.saveDraft', 'cA', { filmId: FILM, rightsAttestation: 'rights-attestation-v1', participants: [{ participantId: 'a', participantType: 'creator', uid: 'cA', bps: -1 }] }))));
  ck('non-owner cannot set the split', (await code(call('agreement.saveDraft', 'cEvil', { filmId: FILM, rightsAttestation: 'rights-attestation-v1', participants: PARTS }))) === 'permission-denied');
  ck('split WITHOUT rights attestation refused', /rights attestation/.test(await msg(call('agreement.saveDraft', 'cA', { filmId: FILM, participants: PARTS }))));
  ck('five-party 100% split saved as draft v1', (await call('agreement.saveDraft', 'cA', { filmId: FILM, rightsAttestation: 'rights-attestation-v1', participants: PARTS })).version === 1);
  ck('submit refused while creator PENDING', /creator_not_active/.test(await msg(call('film.submit', 'cA', { filmId: FILM }))));
  ck('non-admin cannot approve a creator', (await code(adm('creatorAdminSetState', 'cA', { uid: 'cA', to: 'ACTIVE' }, {}))) === 'permission-denied');
  await adm('creatorAdminSetState', 'adm1', { uid: 'cA', to: 'ACTIVE' });
  ck('admin approves creator', (await read('creators/cA')).state === 'ACTIVE');
  ck('creator submits', (await call('film.submit', 'cA', { filmId: FILM })).pubState === 'SUBMITTED');
  ck('creator cannot publish a SUBMITTED film', /transition_refused/.test(await msg(call('film.publish', 'cA', { filmId: FILM }))));
  ck('creator cannot edit a SUBMITTED film', /cannot be edited/.test(await msg(call('film.saveDraft', 'cA', { filmId: FILM, title: 'sneaky' }))));
  await adm('creatorAdminFilmTransition', 'adm1', { filmId: FILM, to: 'UNDER_REVIEW' });
  const appr = await adm('creatorAdminFilmTransition', 'adm1', { filmId: FILM, to: 'APPROVED' });
  ck('approval locks royalty v1', appr.lockedVersion === 1 && (await read(`royaltyAgreements/${FILM}/versions/1`)).status === 'LOCKED');
  ck('participant index written for each rights holder', docs('royaltyParticipations/').length === 5);
  ck('APPROVED film is not public yet', (await read('entertainmentListings/' + FILM)).status === 'draft');
  const pub = await call('film.publish', 'cA', { filmId: FILM });
  ck('creator publishes approved film → active in catalogue', pub.pubState === 'PUBLISHED' && (await read('entertainmentListings/' + FILM)).status === 'active');
  const list = await call('catalog.list', null, {});
  ck('public catalogue lists it (no auth needed)', list.films.some((f) => f.filmId === FILM));
  ck('public projection carries no media location', !JSON.stringify(list).includes('creator-masters'));

  const ent = require(Path.join(FN, 'entertainment-hub.js'));
  ck('legacy self-publish of a Creator film refused', /through review/.test(await msg(ent.publishEntertainmentListing.run({ ...who('cA'), data: { listingId: FILM } }))));
  ck('legacy purchase of a Creator film refused', /film_access/.test(await msg(ent.purchaseEntertainment.run({ ...who('v1'), data: { listingId: FILM, idempotencyKey: 'k1' } }))));

  /* ═══ purchase ═══ */
  console.log('\n── purchase (real createPaymentIntent → film_access) ──');
  ck('createPaymentIntent loadable for an end-to-end quote', !!intents, intents ? '' : 'not loadable');
  ck('purchases closed by default (kill switch)', /not open yet/.test(await msg(purposes.priceFor('film_access', 'v1', { filmId: FILM }))));
  ck('non-superAdmin cannot open purchases', (await code(adm('creatorAdminConfig', 'adm1', { set: { purchasesEnabled: true } }))) === 'permission-denied');
  await adm('creatorAdminConfig', 'sa1', { set: { purchasesEnabled: true, checkoutMethods: ['M-PESA'] } }, { superAdmin: true });
  const q = await purposes.priceFor('film_access', 'v1', { filmId: FILM, amount: 1, priceCents: 1 });
  ck('server price = film price (client amount ignored)', q.amountCents === 50000 && q.amount === 500);
  ck('currency bound to KES', q.currency === 'KES');
  ck('intent metadata carries NO sellerUid (royalty ≠ seller proceeds)', !('sellerUid' in q.metadata) && q.metadata.type === 'film_access');
  ck('creator cannot buy own film', /own film/.test(await msg(purposes.priceFor('film_access', 'cA', { filmId: FILM }))));
  const g = await call('catalog.get', 'v1', { filmId: FILM });
  ck('film page says "Payment methods available at checkout"', g.checkout.notice === 'Payment methods available at checkout' && g.checkout.verifiedMethods.join() === 'M-PESA');
  const ref1 = await buy('v1', FILM);
  const intent1 = await read('paymentIntents/' + ref1);
  ck('intent minted server-side with purpose film_access', intent1.purpose === 'film_access' && intent1.resourceId === FILM && intent1.amountCents === 50000);

  /* ═══ settlement ═══ */
  console.log('\n── settlement: entitlement + royalty accrual ──');
  await settle(ref1, { status: 'PENDING' });
  const pend = await H._internal.processFilmPayment(ref1);
  ck('PENDING payment grants nothing', !!pend.refused && !(await read('contentEntitlements/' + ref1)));
  ck('royalty accrual on a PENDING payment refused (no credit without payment)', (await H._internal.accrueRoyalty(ref1)).refused === 'payment_not_terminal' && !docs('royaltyLedger/').some((r) => r.paymentRef === ref1));
  ck('playback denied before payment completes', /no_entitlement/.test(await msg(call('playback.authorize', 'v1', { filmId: FILM, deviceId: 'd1' }))));
  await settle(ref1, { value: 500, net: 485, charges: 15 });
  const done = await H._internal.processFilmPayment(ref1);
  ck('COMPLETE → activated', done.activation && done.activation.activated === true, JSON.stringify(done.royalty));
  const ce = await read('contentEntitlements/' + ref1);
  ck('contentEntitlements record: buyer, content, amount, currency, ACTIVE', ce.buyerUid === 'v1' && ce.contentId === FILM && ce.purchasedAmountCents === 50000 && ce.currency === 'KES' && ce.status === 'ACTIVE');
  ck('access pointer written', (await read(`contentAccess/v1_${FILM}`)).paymentRef === ref1);
  const rows = docs('royaltyLedger/').filter((r) => r.paymentRef === ref1);
  const part = rows.filter((r) => r.bucket === 'PARTICIPANT_ROYALTY');
  const net = 50000 - 1500;                      /* 485.00 */
  const commission = Math.floor(net * 3000 / 10000); /* 145.50 → SOKONI 30% of NET */
  const pool = net - commission;                  /* 339.50 → creators 70% */
  ck('pool = 70% of (gross − IntaSend fee): 339.50', done.royalty.poolCents === pool && pool === 33950, done.royalty.poolCents);
  ck('one EARN row per participant', part.length === 5);
  ck('Σ participant rows == pool exactly', part.reduce((s, r) => s + r.amountCents, 0) === pool);
  ck('producer 40% of pool (135.80)', part.find((r) => r.participantId === 'producer').amountCents === 13580);
  ck('commission booked in its OWN bucket', rows.find((r) => r.bucket === 'PLATFORM_COMMISSION').amountCents === commission && commission === 14550);
  const acc1 = await read('royaltyAccruals/acc_' + ref1);
  ck('accrual records the Creator policy, 3000/7000 bps, net basis', acc1.policyId === 'creator_ppv_v1' && acc1.commissionBps === 3000 && acc1.poolBps === 7000 && acc1.netCents === net);
  ck('commission + pool + fee == gross (no cent lost)', acc1.deductions.commissionCents + acc1.poolCents + acc1.deductions.providerFeeCents === 50000);
  ck('provider fee booked in its OWN bucket', rows.find((r) => r.bucket === 'PROVIDER_FEE').amountCents === 1500);
  ck('ledger rows carry version, period, basis', part.every((r) => r.agreementVersion === 1 && r.periodId === '2026-Q3' && r.grossCents === 50000 && r.poolCents === pool));
  ck('NO wallet was credited at sale time', docs('wallets/').length === 0);
  const again = await H._internal.processFilmPayment(ref1);
  ck('webhook replay → alreadyActive + alreadyAccrued', again.activation.alreadyActive === true && again.royalty.alreadyAccrued === true);
  ck('replay → still ONE allocation', docs('royaltyLedger/').filter((r) => r.paymentRef === ref1).length === 7);

  /* concurrency */
  users.v2 = { uid: 'v2', email: 'v2@x.co' };
  const ref2 = await buy('v2', FILM);
  await settle(ref2, { uid: 'v2', value: 500, net: 485 });
  await engine.activate(ref2, { source: 'test' });
  const racers = await Promise.all(Array.from({ length: 8 }, () => H._internal.accrueRoyalty(ref2, { source: 'race' })));
  ck('8 concurrent accruals → exactly one accrued', racers.filter((r) => r.accrued).length === 1, JSON.stringify(racers.map((r) => Object.keys(r)[0])));
  ck('8 concurrent accruals → 7 rows, not 56', docs('royaltyLedger/').filter((r) => r.paymentRef === ref2).length === 7);
  ck('fee from value − net_amount when charges absent', (await read('royaltyAccruals/acc_' + ref2)).feeSource === 'provider_value_minus_net');

  /* unreported fee → withheld, access still granted */
  users.v3 = { uid: 'v3', email: 'v3@x.co' };
  const ref3 = await buy('v3', FILM);
  await settle(ref3, { uid: 'v3' });
  const w = await H._internal.processFilmPayment(ref3);
  ck('unreported fee → accrual WITHHELD, never assumed 0', w.royalty.withheld === 'fee_unreported');
  ck('…but the buyer still gets access', (await read('contentEntitlements/' + ref3)).status === 'ACTIVE');
  ck('…and an OPEN exception is raised for AdminOS', (await read('creatorExceptions/fee_unreported_' + ref3)).status === 'OPEN');
  ck('fee attestation needs superAdmin', (await code(adm('creatorAdminAttestFee', 'adm1', { paymentRef: ref3, feeKes: 15, evidence: 'IntaSend txn 123' }))) === 'permission-denied');
  const att = await adm('creatorAdminAttestFee', 'sa1', { paymentRef: ref3, feeKes: 15, evidence: 'IntaSend txn 123' }, { superAdmin: true });
  ck('attested fee → accrued', att.accrued === true);
  ck('fee cannot be re-attested after recognition', /immutable/.test(await msg(adm('creatorAdminAttestFee', 'sa1', { paymentRef: ref3, feeKes: 0, evidence: 'change it' }, { superAdmin: true }))));

  /* foreign payer */
  users.v4 = { uid: 'v4', email: 'v4@x.co' };
  const ref4 = await buy('v4', FILM);
  await settle(ref4, { uid: 'attacker', value: 500, net: 485 });
  const forged = await H._internal.processFilmPayment(ref4);
  ck('payment by a different uid refused (no entitlement, no royalty)', forged.refused === 'ownership_mismatch' && !(await read('royaltyAccruals/acc_' + ref4)));
  ck('royalty credit without payment impossible: accrual needs an honourable payment', (await H._internal.accrueRoyalty('NOPAY123')).skipped === 'not_film');

  ck('already-owned film cannot be bought twice', /already have access/.test(await msg(purposes.priceFor('film_access', 'v1', { filmId: FILM }))));

  /* ═══ access ═══ */
  console.log('\n── playback & watermark ──');
  const a1 = await call('playback.authorize', 'v1', { filmId: FILM, deviceId: 'dev-1' });
  ck('paid viewer gets a short-lived signed URL', /X-Goog-Expires=600/.test(a1.url) && a1.urlExpiresAtMs === NOW + 600000);
  ck('signed URL is for the private master, v4, read-only', signed[signed.length - 1].version === 'v4' && signed[signed.length - 1].action === 'read' && signed[signed.length - 1].path === tgt.storagePath);
  const wm = JSON.stringify(a1.watermark);
  ck('watermark binds masked identity', a1.watermark.label === 'Wanjiku · v***e@g***.com', a1.watermark.label);
  ck('watermark binds session code + entitlement fragment', /^[A-Z2-9]{10}$/.test(a1.watermark.sessionCode) && a1.watermark.entitlementTag === 'E-' + ref1.slice(-6).toUpperCase());
  ck('watermark carries NO full email / phone / surname', !wm.includes('viewer.one@gmail.com') && !wm.includes('712345678') && !wm.includes('Muthoni'));
  ck('unpaid viewer denied', /no_entitlement/.test(await msg(call('playback.authorize', 'v9', { filmId: FILM, deviceId: 'x' }))));
  ck('unauthenticated playback denied', (await code(call('playback.authorize', null, { filmId: FILM }))) === 'unauthenticated');
  const a2 = await call('playback.authorize', 'v1', { filmId: FILM, deviceId: 'dev-2' });
  ck('second device allowed (limit 2)', !!a2.sessionId && a2.sessionId !== a1.sessionId);
  ck('third concurrent session denied', /too_many_sessions/.test(await msg(call('playback.authorize', 'v1', { filmId: FILM, deviceId: 'dev-3' }))));
  ck('renewing an existing session is allowed', !!(await call('playback.authorize', 'v1', { filmId: FILM, deviceId: 'dev-1', sessionId: a1.sessionId })).url);
  ck('another user cannot heartbeat my session', (await code(call('playback.heartbeat', 'v2', { sessionId: a1.sessionId }))) === 'permission-denied');
  ck('heartbeat keeps a live session', (await call('playback.heartbeat', 'v1', { sessionId: a1.sessionId })).ok === true);
  ck('unknown client report event refused', (await code(call('playback.report', 'v1', { sessionId: a1.sessionId, event: 'hack' }))) === 'invalid-argument');
  await call('playback.report', 'v1', { sessionId: a1.sessionId, event: 'overlay_removed' });
  ck('tamper report lands in the playback audit', docs('playbackAudit/').some((e) => e.event === 'client_overlay_removed'));
  await call('playback.end', 'v1', { sessionId: a1.sessionId });
  await call('playback.end', 'v1', { sessionId: a2.sessionId });

  /* rental expiry */
  await call('film.saveDraft', 'cA', { title: 'Rental Reel', subcategory: 'short_films', priceCents: 10000, currency: 'KES', accessType: 'rental', rentalDays: 2, posterUrl: POSTER('cA') }).then(async (d2) => {
    const R2 = d2.filmId;
    const t2 = await call('film.mediaUploadTarget', 'cA', { filmId: R2 });
    objects.set(t2.storagePath, { contentType: 'video/mp4', size: 1000, generation: 1 });
    await call('film.attachMedia', 'cA', { filmId: R2 });
    await call('agreement.saveDraft', 'cA', { filmId: R2, rightsAttestation: 'rights-attestation-v1', participants: [{ participantId: 'cA', participantType: 'creator', uid: 'cA', bps: 10000 }] });
    await call('film.submit', 'cA', { filmId: R2 });
    await adm('creatorAdminFilmTransition', 'adm1', { filmId: R2, to: 'UNDER_REVIEW' });
    await adm('creatorAdminFilmTransition', 'adm1', { filmId: R2, to: 'APPROVED' });
    await adm('creatorAdminFilmTransition', 'adm1', { filmId: R2, to: 'PUBLISHED' });
    const rr = await buy('v1', R2);
    await settle(rr, { value: 100, net: 97 });
    await H._internal.processFilmPayment(rr);
    ck('rental grants time-boxed access', (await read('contentEntitlements/' + rr)).expiresAtMs === NOW + 2 * 86400000);
    ck('rental playable inside window', !!(await call('playback.authorize', 'v1', { filmId: R2, deviceId: 'dev-9' })).url);
    const save = NOW; NOW += 2 * 86400000 + 1;
    ck('expired rental denied', /entitlement_expired/.test(await msg(call('playback.authorize', 'v1', { filmId: R2, deviceId: 'dev-9' }))));
    ck('expired rental may be rented again', (await purposes.priceFor('film_access', 'v1', { filmId: R2 })).amountCents === 10000);
    NOW = save;
  });

  /* ═══ suspension ═══ */
  console.log('\n── suspension ──');
  await adm('creatorAdminSetState', 'adm1', { uid: 'cA', to: 'SUSPENDED', reason: 'rights dispute' });
  ck('suspended creator cannot register/update', (await code(call('creator.register', 'cA', { displayName: 'Kibera Films' }))) === 'permission-denied');
  ck('suspended creator cannot draft', (await code(call('film.saveDraft', 'cA', { title: 'New', subcategory: 'movies', priceCents: 10000, currency: 'KES', accessType: 'purchase' }))) === 'permission-denied');
  users.v5 = { uid: 'v5', email: 'v5@x.co' };
  ck('suspended creator\'s film is not on sale', /not on sale/.test(await msg(purposes.priceFor('film_access', 'v5', { filmId: FILM }))));
  await adm('creatorAdminSetState', 'adm1', { uid: 'cA', to: 'ACTIVE' });
  await adm('creatorAdminFilmTransition', 'adm1', { filmId: FILM, to: 'SUSPENDED', note: 'takedown request' });
  ck('suspended film: entitled viewer denied', /film_unavailable/.test(await msg(call('playback.authorize', 'v1', { filmId: FILM, deviceId: 'dev-1' }))));
  ck('suspended film leaves the public catalogue', !(await call('catalog.list', null, {})).films.some((f) => f.filmId === FILM));
  await adm('creatorAdminFilmTransition', 'adm1', { filmId: FILM, to: 'PUBLISHED' });

  /* ═══ agreement v2 ═══ */
  console.log('\n── versioned agreement ──');
  const v2 = await call('agreement.saveDraft', 'cA', { filmId: FILM, rightsAttestation: 'rights-attestation-v1', participants: [{ participantId: 'producer', participantType: 'producer', uid: 'cA', bps: 6000 }, { participantId: 'actorA', participantType: 'actor', uid: 'uActA', bps: 4000 }] });
  ck('a new split is a NEW version (v2), v1 untouched', v2.version === 2 && (await read(`royaltyAgreements/${FILM}/versions/1`)).status === 'LOCKED');
  ck('a draft v2 governs nothing until locked', R.selectVersionAt((await db.collection(`royaltyAgreements/${FILM}/versions`).get()).docs.map((d) => d.data()), NOW).version === 1);
  ck('non-admin cannot lock', (await code(adm('creatorAdminLockAgreement', 'cA', { filmId: FILM, version: 2 }, {}))) === 'permission-denied');
  NOW += 60000;
  await adm('creatorAdminLockAgreement', 'adm1', { filmId: FILM, version: 2 });
  ck('v1 superseded, v2 locked', (await read(`royaltyAgreements/${FILM}/versions/1`)).status === 'SUPERSEDED' && (await read(`royaltyAgreements/${FILM}/versions/2`)).status === 'LOCKED');
  users.v6 = { uid: 'v6', email: 'v6@x.co' };
  const ref6 = await buy('v6', FILM);
  await settle(ref6, { uid: 'v6', value: 500, net: 485 });
  await H._internal.processFilmPayment(ref6);
  const r6 = docs('royaltyLedger/').filter((r) => r.paymentRef === ref6 && r.bucket === 'PARTICIPANT_ROYALTY');
  ck('later sale allocated under v2 (2 participants)', r6.length === 2 && r6.every((r) => r.agreementVersion === 2));
  ck('earlier v1 earnings unchanged (historical authority)', docs('royaltyLedger/').filter((r) => r.paymentRef === ref1 && r.bucket === 'PARTICIPANT_ROYALTY').every((r) => r.agreementVersion === 1));

  /* ═══ refunds ═══ */
  console.log('\n── refunds ──');
  const pre = docs('royaltyLedger/').filter((r) => r.paymentRef === ref2).length;
  const half = await H.onFilmRefundProcessed({ payRef: ref2, refundId: 'ref_' + ref2 + '_a', amountCents: 25000 });
  ck('partial refund → reversal rows, access KEPT', half.reversed > 0 && (await read('contentEntitlements/' + ref2)).status === 'ACTIVE');
  ck('historical EARN rows preserved (never deleted)', docs('royaltyLedger/').filter((r) => r.paymentRef === ref2 && r.kind === 'EARN').length === 7);
  const again2 = await H.onFilmRefundProcessed({ payRef: ref2, refundId: 'ref_' + ref2 + '_a', amountCents: 25000 });
  ck('refund replay → alreadyReversed, no new rows', again2.alreadyReversed === true && docs('royaltyLedger/').filter((r) => r.paymentRef === ref2).length === pre + half.reversed);
  const full = await H.onFilmRefundProcessed({ payRef: ref2, refundId: 'ref_' + ref2 + '_b', amountCents: 25000 });
  ck('remaining refund → full reversal, access REVOKED', full.fullyRefunded === true && (await read('contentEntitlements/' + ref2)).status === 'REVOKED');
  const earned2 = docs('royaltyLedger/').filter((r) => r.paymentRef === ref2 && r.kind === 'EARN' && r.bucket !== 'PROVIDER_FEE');
  const rev2 = docs('royaltyLedger/').filter((r) => r.paymentRef === ref2 && r.kind === 'REVERSAL');
  ck('Σ reversals == Σ recognised (fee excepted, sunk)', rev2.reduce((s, r) => s + r.amountCents, 0) === earned2.reduce((s, r) => s + r.amountCents, 0));
  ck('refunded viewer denied playback', /entitlement_revoked/.test(await msg(call('playback.authorize', 'v2', { filmId: FILM, deviceId: 'z' }))));
  ck('over-refund refused (recorded as exception, not applied)', (await H.onFilmRefundProcessed({ payRef: ref2, refundId: 'ref_' + ref2 + '_c', amountCents: 100 })).failed === true);
  users.v7 = { uid: 'v7', email: 'v7@x.co' };
  const ref7 = await buy('v7', FILM);
  await settle(ref7, { uid: 'v7' });                                  /* fee unreported → withheld */
  await H._internal.processFilmPayment(ref7);
  const v7 = await H.onFilmRefundProcessed({ payRef: ref7, refundId: 'ref_' + ref7, amountCents: 50000 });
  ck('refund before accrual → tombstone', v7.voided === true && (await read('royaltyAccruals/acc_' + ref7)).status === 'VOID_REFUNDED');
  ck('…a later accrual retry cannot recognise the refunded sale', (await H._internal.accrueRoyalty(ref7)).alreadyAccrued === true && !docs('royaltyLedger/').some((r) => r.paymentRef === ref7));
  ck('non-film refund is a no-op', (await H.onFilmRefundProcessed({ payRef: 'NOTFILM1', refundId: 'r1', amountCents: 100 })).skipped === 'not_film');

  /* ═══ quarterly settlement ═══ */
  console.log('\n── quarterly settlement & distribution ──');
  ck('cannot calculate Q3 before it ends', /period_not_ended/.test(await msg(adm('creatorAdminCalculatePeriod', 'adm1', { periodId: '2026-Q3' }))));
  NOW = Date.UTC(2026, 9, 2, 9, 0, 0);                          /* 2 Oct 2026 — Q4 */
  ck('non-admin cannot calculate', (await code(adm('creatorAdminCalculatePeriod', 'uActA', { periodId: '2026-Q3' }, {}))) === 'permission-denied');
  const calc = await adm('creatorAdminCalculatePeriod', 'adm1', { periodId: '2026-Q3' });
  ck('Q3 calculated', calc.status === 'CALCULATED' && calc.totals.participants >= 5, JSON.stringify(calc.totals));
  const stA = await read('royaltyStatements/2026-Q3_uActA');
  const ledA = docs('royaltyLedger/').filter((r) => r.uid === 'uActA' && r.periodId === '2026-Q3');
  const netA = ledA.reduce((s, r) => s + (r.kind === 'EARN' ? r.amountCents : -r.amountCents), 0);
  ck('statement net == ledger net for the participant', stA.netCents === netA, `${stA.netCents} vs ${netA}`);
  ck('release is whole KES, remainder carried', stA.releaseKes === Math.floor(netA / 100) && stA.carryOutCents === netA - stA.releaseKes * 100);

  /* a Q3 sale whose webhook lands after Q3 is calculated → recognised in Q4 */
  users.v8 = { uid: 'v8', email: 'v8@x.co' };
  const ref8 = await buy('v8', FILM);
  await settle(ref8, { uid: 'v8', value: 500, net: 485 });
  await db.doc('payments/' + ref8).update({ webhookReceivedAt: F.Timestamp.fromMillis(Date.UTC(2026, 8, 30, 12)) });
  const late = await H._internal.accrueRoyalty(ref8);
  ck('late sale for a calculated quarter → recognised in the open quarter', late.periodId === '2026-Q4');
  ck('…and flagged recognisedLate', (await read('royaltyAccruals/acc_' + ref8)).recognisedLate === true);

  ck('distribute before approval refused', /APPROVED/.test(await msg(adm('creatorAdminDistribute', 'adm1', { periodId: '2026-Q3' }))));
  ck('calculator cannot approve own calculation', /approver_not_distinct/.test(await msg(adm('creatorAdminApprovePeriod', 'adm1', { periodId: '2026-Q3' }))));
  await adm('creatorAdminApprovePeriod', 'adm2', { periodId: '2026-Q3' });
  ck('distinct admin approves', (await read('royaltyPeriods/2026-Q3')).status === 'APPROVED');
  const q3Before = JSON.stringify(await read('royaltyStatements/2026-Q3_uActA'));
  const r6rev = await H.onFilmRefundProcessed({ payRef: ref6, refundId: 'ref_' + ref6, amountCents: 10000 });
  const rev6 = docs('royaltyLedger/').filter((r) => r.paymentRef === ref6 && r.kind === 'REVERSAL');
  ck('Q3 sale refunded after Q3 calculated → reversal booked in open Q4', r6rev.reversed > 0 && rev6.length > 0 && rev6.every((r) => r.periodId === '2026-Q4'));
  ck('…and the frozen Q3 statement is untouched', JSON.stringify(await read('royaltyStatements/2026-Q3_uActA')) === q3Before);
  await adm('creatorAdminSetPayoutHold', 'adm1', { uid: 'uDir', hold: true, reason: 'contract dispute' });
  const d1 = await adm('creatorAdminDistribute', 'adm1', { periodId: '2026-Q3' });
  ck('distribution credits participants', d1.credited >= 4 && d1.held === 1, JSON.stringify(d1));
  ck('wallet balance == releaseKes (canonical wallets.balance, KES)', (await read('wallets/uActA')).balance === stA.releaseKes);
  ck('walletTransactions row uses the ${uid}_${period}_royalty id', (await read('walletTransactions/uActA_2026-Q3_royalty')).amount === stA.releaseKes);
  ck('held participant NOT credited', !(await read('wallets/uDir')) && (await read('royaltyStatements/2026-Q3_uDir')).held === true);
  ck('period PAYABLE after a clean run', (await read('royaltyPeriods/2026-Q3')).status === 'PAYABLE');
  const d2 = await adm('creatorAdminDistribute', 'adm1', { periodId: '2026-Q3' });
  ck('distribution replay credits NOTHING twice', d2.credited === 0 && (await read('wallets/uActA')).balance === stA.releaseKes);
  ck('close refused while a held statement is unreleased', /held/.test(await msg(adm('creatorAdminClosePeriod', 'adm1', { periodId: '2026-Q3' }))));
  await adm('creatorAdminSetPayoutHold', 'adm1', { uid: 'uDir', hold: false });
  const d3 = await adm('creatorAdminDistribute', 'adm1', { periodId: '2026-Q3' });
  ck('lifting the hold releases on the next run', d3.credited === 1 && (await read('wallets/uDir')).balance > 0);
  ck('period closes once everything is released', (await adm('creatorAdminClosePeriod', 'adm1', { periodId: '2026-Q3' })).status === 'CLOSED');
  /* concurrent distribution of the same statement */
  await db.doc('royaltyStatements/2026-Q3_uActB').update({ released: false });   /* simulate a lost statement write */
  const balB = (await read('wallets/uActB')).balance;
  await db.doc('royaltyPeriods/2026-Q3').update({ status: 'PAYABLE' });
  await Promise.all([adm('creatorAdminDistribute', 'adm1', { periodId: '2026-Q3' }), adm('creatorAdminDistribute', 'adm2', { periodId: '2026-Q3' })]);
  ck('lost statement write + 2 concurrent runs → reconciled, NOT re-credited', (await read('wallets/uActB')).balance === balB && (await read('royaltyStatements/2026-Q3_uActB')).released === true);

  const mine = await call('royalty.mine', 'uActA', {});
  ck('participant dashboard: released reflects the wallet credit', mine.summary.releasedCents === stA.releaseCents);
  ck('participant dashboard: Q4 late sale shows as accrued', mine.summary.accruedCents > 0);
  ck('participant dashboard: withdrawal is the existing wallet rail', mine.withdrawal.via === 'wallet');
  ck('participant cannot read another film\'s owner dashboard', (await code(call('royalty.film', 'uActA', { filmId: FILM }))) === 'permission-denied');
  const fd = await call('royalty.film', 'cA', { filmId: FILM });
  ck('owner dashboard: gross / fee / commission / pool totals', fd.totals.grossCents > 0 && fd.totals.commissionCents > 0 && fd.totals.poolCents > 0 && fd.totals.providerFeeCents > 0);

  /* ═══ viewer dashboard & creator analytics ═══ */
  console.log('\n── viewer dashboard & creator analytics ──');
  {
    const pv0 = await call('creator.analytics', 'cA', {});
    const a0 = pv0.films.find((x) => x.filmId === FILM);
    const s1 = await call('playback.authorize', 'v1', { filmId: FILM, deviceId: 'dash-dev' });
    NOW += 30000;
    await call('playback.heartbeat', 'v1', { sessionId: s1.sessionId, positionSec: 600, durationSec: 5760, playing: true });
    NOW += 5 * 60000;                              /* claims 5 minutes of play in one beat */
    await call('playback.heartbeat', 'v1', { sessionId: s1.sessionId, positionSec: 900, durationSec: 5760, playing: true });
    const sess = await read('playbackSessions/' + s1.sessionId);
    ck('watch time credits real elapsed time only (30s + capped 60s)', sess.watchedSec === 90, sess.watchedSec);
    NOW += 30000;
    await call('playback.heartbeat', 'v1', { sessionId: s1.sessionId, positionSec: 999999, durationSec: 5760, playing: false });
    ck('position clamped to the duration', (await read('watchProgress/v1_' + FILM)).positionSec === 5760);
    const lib = await call('viewer.library', 'v1', {});
    ck('My Films lists the owned film with progress', lib.myFilms.some((m) => m.filmId === FILM && m.progress && m.progress.durationSec === 5760));
    ck('completed film is NOT in Continue Watching', !lib.continueWatching.some((c) => c.filmId === FILM));
    ck('purchase history shows the expired rental as EXPIRED', lib.purchases.some((p) => p.type === 'rental' && p.status === 'EXPIRED'));
    ck('devices shown as short hashes — no IP / network data', lib.sessions.every((x) => x.device.length === 8 && !('netHash' in x)) && !JSON.stringify(lib.sessions).includes('41.90'));
    ck('account settings + password recovery reachable', !!lib.account.page && /reset/.test(lib.account.recovery));
    const lib2 = await call('viewer.library', 'v2', {});
    ck("another buyer's library holds none of v1's purchases", !lib2.purchases.some((p) => p.entitlementId === ref1));
    ck('refunded purchase is history only (REVOKED, not in My Films)', lib2.purchases.some((p) => p.entitlementId === ref2 && p.status === 'REVOKED') && !lib2.myFilms.some((m) => m.entitlementId === ref2));
    ck("cannot end another buyer's device session", (await code(call('viewer.endSession', 'v2', { sessionId: s1.sessionId }))) === 'permission-denied');
    ck('can end own device session', (await call('viewer.endSession', 'v1', { sessionId: s1.sessionId })).ok === true && (await read('playbackSessions/' + s1.sessionId)).ended === true);
    await call('catalog.get', null, { filmId: FILM });
    const an = await call('creator.analytics', 'cA', {});
    const a1 = an.films.find((x) => x.filmId === FILM);
    ck('analytics: views counted per new session', a1.views === (a0 ? a0.views : 0) + 1, JSON.stringify(a1).slice(0, 160));
    ck('analytics: repeat viewer is NOT a new unique viewer', a1.uniqueViewers === (a0 ? a0.uniqueViewers : 0));
    ck('analytics: completed view counted once', a1.completedViews === (a0 ? a0.completedViews : 0) + 1);
    ck('analytics: watch time summed from shards', a1.watchSeconds >= 90);
    ck('analytics: page views summed from shards (conversion input)', a1.pageViews >= 1 && a1.conversionBps !== undefined);
    ck('analytics: money columns from the ledger (commission = 30% basis)', a1.commissionCents > 0 && a1.poolCents > a1.commissionCents);
    ck('analytics: settlement status of the current quarter', an.settlement.periodId === '2026-Q4' && !!an.settlement.status);
    const blob = JSON.stringify(an);
    ck('analytics carry NO viewer identity (uid / email / phone)', !/\bv1\b|\bv2\b|viewer\.one|@gmail|712345678/.test(blob));
    const rival = await call('creator.analytics', 'cEvil', {});
    ck("cross-creator analytics impossible (rival sees only own films)", !rival.films.some((x) => x.filmId === FILM));
    ck('film stats hot counters are sharded (≤10 shard docs)', docs('filmStats/' + FILM + '/shards/').length >= 1 && docs('filmStats/' + FILM + '/shards/').length <= 10);
    ck('viewer marker holds no viewer data', Object.keys(docs('filmViewers/')[0] || {}).every((k) => ['path', 'filmId', 'firstViewAtMs'].includes(k)));
  }

  /* ═══ creator verification ═══ */
  console.log('\n── creator verification ──');
  {
    const V = (op, uid, data = {}) => call(op, uid, data);
    ck('no application → NOT_APPLIED', (await V('verification.get', 'cV')).status === 'NOT_APPLIED');
    ck('unregistered user cannot apply', (await code(V('verification.saveDraft', 'cV', { legalName: 'X' }))) === 'failed-precondition');
    await call('creator.register', 'cV', { displayName: 'Verity Films' });
    ck('forged status refused', /field_server_owned/.test(await msg(V('verification.saveDraft', 'cV', { status: 'APPROVED' }))));
    ck('forged verified flag refused', /field_server_owned/.test(await msg(V('verification.saveDraft', 'cV', { verified: true }))));
    ck('applying FOR another creator impossible (creatorId is server-owned)', /field_server_owned/.test(await msg(V('verification.saveDraft', 'cV', { creatorId: 'cA' }))));
    ck('FULL ID number refused (last 4 only)', /pii_refused/.test(await msg(V('verification.saveDraft', 'cV', { identity: { documentType: 'national_id', documentNumber: '12345678' } }))));
    ck('http portfolio link refused', /https links only/.test(await msg(V('verification.saveDraft', 'cV', { portfolio: ['http://x.example'] }))));
    const APP = { legalName: 'Verity Films Ltd', displayName: 'Verity Films', creatorType: 'company', country: 'KE', bio: 'Docs',
      identity: { documentType: 'company_registration', documentLast4: '7K2Q' }, portfolio: ['https://verity.example/reel'], links: ['https://x.com/verity'],
      ownershipStatement: 'We own all rights to the films we publish on SOKONI.', ownershipAttested: true, contactEmail: 'rights@verity.example' };
    ck('valid draft saved', (await V('verification.saveDraft', 'cV', APP)).status === 'DRAFT');
    const vdoc = await read('creatorVerifications/cV');
    ck('application keyed by the AUTHENTICATED uid', vdoc.creatorId === 'cV' && vdoc.applicationId === 'cva_cV');
    ck('only the last 4 of the ID number stored', vdoc.identity.documentLast4 === '7K2Q' && !JSON.stringify(vdoc).includes('12345678'));
    ck('submit without documents refused', /documents/.test(await msg(V('verification.submit', 'cV'))));
    ck('path traversal in document name refused', (await code(V('verification.attachDocument', 'cV', { fileName: '../cA/cv-id.pdf' }))) === 'invalid-argument');
    objects.set('kyc-documents/cOther/cv-id.pdf', { contentType: 'application/pdf', size: 1000, md5Hash: 'm0', generation: '1' });
    ck("another creator's document cannot be attached (own prefix only)", /not been uploaded/.test(await msg(V('verification.attachDocument', 'cV', { fileName: 'cv-id.pdf' }))));
    objects.set('kyc-documents/cV/cv-id.pdf', { contentType: 'text/html', size: 1000, md5Hash: 'm1', generation: '1' });
    ck('non-PDF/image document refused', /PDF or an image/.test(await msg(V('verification.attachDocument', 'cV', { fileName: 'cv-id.pdf' }))));
    objects.set('kyc-documents/cV/cv-id.pdf', { contentType: 'application/pdf', size: 5000, md5Hash: 'm1', generation: '1' });
    ck('own document attached', (await V('verification.attachDocument', 'cV', { fileName: 'cv-id.pdf' })).documents === 1);
    const sub = await V('verification.submit', 'cV');
    ck('submitted as version 1', sub.status === 'SUBMITTED' && sub.version === 1);
    ck('duplicate submission refused', /transition_refused/.test(await msg(V('verification.submit', 'cV'))));
    ck('cannot edit while SUBMITTED', /cannot be edited/.test(await msg(V('verification.saveDraft', 'cV', APP))));
    ck('non-admin cannot decide', (await code(adm('creatorAdminVerificationDecision', 'cV', { uid: 'cV', action: 'approve' }, {}))) === 'permission-denied');
    ck('cannot approve straight from SUBMITTED (review first)', /transition_refused/.test(await msg(adm('creatorAdminVerificationDecision', 'adm1', { uid: 'cV', action: 'approve' }))));
    await adm('creatorAdminVerificationDecision', 'adm1', { uid: 'cV', action: 'start_review' });
    ck('request-info needs a reason', (await code(adm('creatorAdminVerificationDecision', 'adm1', { uid: 'cV', action: 'request_info' }))) === 'invalid-argument');
    await adm('creatorAdminVerificationDecision', 'adm1', { uid: 'cV', action: 'request_info', reason: 'Upload a clearer certificate' });
    const g = await V('verification.get', 'cV');
    ck('creator sees MORE_INFORMATION_REQUIRED + the reason', g.status === 'MORE_INFORMATION_REQUIRED' && g.events.some((e) => e.reason === 'Upload a clearer certificate'));
    ck("creator's event view hides reviewer identity", !JSON.stringify(g.events).includes('adm1'));
    objects.set('kyc-documents/cV/cv-cert.pdf', { contentType: 'application/pdf', size: 7000, md5Hash: 'm2', generation: '1' });
    await V('verification.attachDocument', 'cV', { fileName: 'cv-cert.pdf' });
    ck('resubmitted as version 2', (await V('verification.submit', 'cV')).version === 2);
    await adm('creatorAdminVerificationDecision', 'adm1', { uid: 'cV', action: 'start_review' });
    objects.set('kyc-documents/cV/cv-id.pdf', { contentType: 'application/pdf', size: 5001, md5Hash: 'SWAPPED', generation: '2' });
    const det = await adm('creatorAdminVerificationDetail', 'adm1', { uid: 'cV' });
    ck('reviewer sees a document swapped AFTER submission', det.documents.find((x) => x.name === 'cv-id.pdf').changedAfterSubmit === true);
    ck('unchanged document not flagged', det.documents.find((x) => x.name === 'cv-cert.pdf').changedAfterSubmit === false);
    ck('reviewer gets short-lived signed links', det.documents.every((x) => /X-Goog-Expires=300/.test(x.url || '')));
    ck('admin audit history names actors', det.events.some((e) => e.actor === 'adm1' && e.to === 'MORE_INFORMATION_REQUIRED'));
    const before = await read('creators/cV');
    ck('not yet verified before approval', before.verification !== 'VERIFIED' && before.state === 'PENDING');
    await adm('creatorAdminVerificationDecision', 'adm2', { uid: 'cV', action: 'approve' });
    const after = await read('creators/cV');
    ck('approval → application APPROVED, projection VERIFIED, creator ACTIVE', (await read('creatorVerifications/cV')).status === 'APPROVED' && after.verification === 'VERIFIED' && after.state === 'ACTIVE');
    ck('decision records reviewer + time', (await read('creatorVerifications/cV')).reviewer === 'adm2');
    ck('suspend needs a reason', (await code(adm('creatorAdminVerificationDecision', 'adm1', { uid: 'cV', action: 'suspend' }))) === 'invalid-argument');
    await adm('creatorAdminVerificationDecision', 'adm1', { uid: 'cV', action: 'suspend', reason: 'identity dispute' });
    const sus = await read('creators/cV');
    ck('suspension → UNVERIFIED projection + creator SUSPENDED', sus.verification === 'UNVERIFIED' && sus.state === 'SUSPENDED');
    await adm('creatorAdminVerificationDecision', 'adm1', { uid: 'cV', action: 'reinstate', reason: 'dispute resolved' });
    ck('reinstate → VERIFIED + ACTIVE', (await read('creators/cV')).verification === 'VERIFIED' && (await read('creators/cV')).state === 'ACTIVE');
    await call('creator.register', 'cW', { displayName: 'Walk-in' });
    await adm('creatorAdminSetState', 'adm1', { uid: 'cW', to: 'ACTIVE' });
    ck('account approval alone does NOT mint the VERIFIED projection', (await read('creators/cW')).verification !== 'VERIFIED');
    ck('creator.me reports verification status', (await call('creator.me', 'cV')).verificationStatus === 'APPROVED');
    ck('one application per creator (no duplicate doc)', docs('creatorVerifications/').filter((x) => !x.path.includes('/events/') && x.creatorId === 'cV').length === 1);
  }

  /* ═══ AdminOS guard sweep ═══ */
  console.log('\n── AdminOS guards ──');
  let open = [];
  for (const op of Object.keys(H._adminH)) {
    const c = await code(H._adminH[op]({ ...who('rando', {}), data: { periodId: '2026-Q3', filmId: FILM, uid: 'cA', paymentRef: ref1, version: 1, to: 'ACTIVE', reason: 'xxxxx', note: 'xxxxx', feeKes: 1, evidence: 'xxxxx', hold: true } }));
    if (c !== 'permission-denied') open.push(op + ':' + c);
  }
  ck(`all ${Object.keys(H._adminH).length} creatorAdmin* ops refuse a non-admin`, open.length === 0, open.join(', '));
  open = [];
  for (const op of Object.keys(H._internal.OPS).filter((o) => !o.startsWith('catalog.'))) {
    const c = await code(H._internal.OPS[op]({ ...who(null), data: { filmId: FILM, sessionId: 'abc' } }));
    if (c !== 'unauthenticated') open.push(op + ':' + c);
  }
  ck('every non-catalogue op refuses an unauthenticated caller', open.length === 0, open.join(', '));
  ck('dispatcher rejects unknown op', (await code(H.creatorDispatch.run({ ...who('v1'), data: { op: '__proto__' } }))) === 'not-found');

  /* ═══ wiring (static) ═══ */
  console.log('\n── wiring ──');
  const idx = fs.readFileSync(Path.join(FN, 'index.js'), 'utf8');
  const wh = idx.slice(idx.indexOf('exports.webhookIntasend'));
  const iFilm = wh.indexOf('_fiSnap.data().purpose === "film_access"');
  ck('webhook film branch exists', iFilm > 0);
  ck('…and runs BEFORE the commissionLedger write', iFilm > 0 && iFilm < wh.indexOf('collection("commissionLedger").doc(apiRef)'));
  ck('…and BEFORE the seller wallet credit', iFilm > 0 && iFilm < wh.indexOf('_sellerId  ='));
  ck('credit branch also refuses film_access (defence in depth)', /else if \(_isFilmAccess\)/.test(wh));
  ck('providerReport written INSIDE the COMPLETE claim transaction', (() => { const c = wh.indexOf('let claimed = false'); const p = wh.indexOf('providerReport: {'); return p > c && p < wh.indexOf('claimed = true'); })());
  ck('index exports creatorDispatch + creatorOnFilmPayment', /exports\.creatorDispatch\s*=/.test(idx) && /exports\.creatorOnFilmPayment\s*=/.test(idx));
  const fos = fs.readFileSync(Path.join(FN, 'financial-os.js'), 'utf8');
  ck('refund rail: film payment → buyer = payer, no seller debit', /purpose === 'film_access'[\s\S]{0,200}buyerUid: pd\.uid, sellerUid: null/.test(fos));
  ck('refund rail: ONE settlement, fosTransactions read before update', (fos.match(/async function _settleRefund/g) || []).length === 1 && /const txSnap = refund\.fosTransactionId \? await txn\.get/.test(fos) && /if \(txSnap && txSnap\.exists\)/.test(fos));
  ck('refund rail: ONE royalty-reversal hook, after settlement, reached by both entry points', (fos.match(/onFilmRefundProcessed\(/g) || []).length === 1 && /return _executeRefund\(refundRef\.id/.test(fos) && /await _executeRefund\(refundId/.test(fos));
  ck('purpose registered', purposes.isRegistered('film_access'));
  ck('adapter registered with the engine', !!engine.getPurpose('film_access'));
  const disp = fs.readFileSync(Path.join(FN, 'admin-os-dispatch.js'), 'utf8');
  ck('creator admin ops merged into adminOsDispatch', /creator\._adminH/.test(disp));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASHED', e); process.exit(2); });
