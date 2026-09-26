'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI Creator Hub — film/media marketplace inside the Entertainment hub.

   ADOPTS, does not duplicate (docs/CREATOR_HUB_OWNERSHIP_MAP.md):
     catalogue     entertainmentListings (creatorHub:true docs)   — owner decision
     price/intent  payment-purposes `film_access` → createPaymentIntent
     collection    the existing IntaSend rail + webhookIntasend
     entitlement   entitlement-engine `film_access` adapter → contentEntitlements
     commission    shared/creator-commercial.js — Creator PPV 30 % SOKONI / 70 % pool
                   of NET (owner, 2026-09-26). NOT commission-config: Creator is its
                   own commercial vertical and must never move the marketplace rate.
     wallet        wallets/{uid}.balance — released quarterly, withdrawn through
                   the existing requestSellerPayout → payoutRequests → B2C
     refund        fosSubmitRefund / fosApproveRefund → onFilmRefundProcessed
     admin         adminOsDispatch (the `_adminH` map below is merged into it)

   NEW, because nothing canonical existed:
     creators/{uid}, creatorPrivate/{uid}         creator identity (+ private contact)
     creatorMedia/{filmId}                        private master location (server-only)
     royaltyAgreements/{filmId}/versions/{v}      versioned, lockable split
     royaltyParticipations/{uid}_{filmId}_v{v}    participant index
     contentEntitlements/{paymentRef}             per-purchase viewing right
     contentAccess/{uid}_{filmId}                 O(1) pointer to the live right
     royaltyAccruals/{acc_ref} + royaltyLedger    append-only earnings authority
     royaltyPeriods, royaltyStatements            quarterly settlement
     playbackSessions, playbackAudit, playbackRate
     creatorExceptions, creatorPayoutHolds, config/creatorHub

   Every money rule lives in shared/creator-royalty.js (pure, 82 assertions);
   every catalogue/playback rule in shared/creator-publishing.js. This file is
   I/O: it reads, calls the pure rule, and writes — reads before writes in
   every transaction, and every exactly-once claim is a create().
   ═══════════════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten }  = require('firebase-functions/v2/firestore');
const { logger }             = require('firebase-functions');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');

const R  = require('./shared/creator-royalty');
const P  = require('./shared/creator-publishing');
const PCAP = require('./shared/payment-capability');
const W  = require('./shared/creator-watermark');
const AC = require('./admin-claim');

const REGION  = 'us-central1';
const PURPOSE = 'film_access';
const _db = () => getFirestore();
const _bucket = () => require('firebase-admin/storage').getStorage().bucket();
const _now = () => Date.now();                       /* the ONE clock read; tests override via _setClock */
let _clock = _now;

const COL = Object.freeze({
  FILMS: 'entertainmentListings', CREATORS: 'creators', CREATOR_PRIVATE: 'creatorPrivate',
  MEDIA: 'creatorMedia', AGREEMENTS: 'royaltyAgreements', PARTICIPATIONS: 'royaltyParticipations',
  ENTITLEMENTS: 'contentEntitlements', ACCESS: 'contentAccess',
  ACCRUALS: 'royaltyAccruals', LEDGER: 'royaltyLedger', REVERSALS: 'royaltyReversals',
  PERIODS: 'royaltyPeriods', STATEMENTS: 'royaltyStatements', DISTRIBUTIONS: 'royaltyDistributions',
  SESSIONS: 'playbackSessions', AUDIT: 'playbackAudit', RATE: 'playbackRate',
  EXCEPTIONS: 'creatorExceptions', HOLDS: 'creatorPayoutHolds', CONFIG: 'config',
  VERIFICATIONS: 'creatorVerifications',
  PROGRESS: 'watchProgress', STATS: 'filmStats', VIEWERS: 'filmViewers',
  WALLETS: 'wallets', WALLET_TX: 'walletTransactions', ADMIN_AUDIT: 'adminAudit',
  PREVIEW_GRANTS: 'creatorPreviewGrants',
});

const fail = (code, msg) => { throw new HttpsError(code, msg); };
/* Pure-module errors carry a stable `code`; surface them as invalid-argument
   with the code in the message so the UI can branch without string matching. */
function _rule(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('failed-precondition', `${e.code || 'rule'}: ${e.message}`);
  }
}
function _uid(req) { if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.'); return req.auth.uid; }
function _admin(req) { _uid(req); if (!AC.isAdmin(req)) fail('permission-denied', 'Admin only.'); return req.auth.uid; }
function _superAdmin(req) { _uid(req); if (!AC.isSuperAdmin(req)) fail('permission-denied', 'Super admin only.'); return req.auth.uid; }
function _id(v, what) {
  const s = String(v || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) fail('invalid-argument', `${what} is invalid.`);
  return s;
}
const _ms = (ts) => (ts && typeof ts.toMillis === 'function') ? ts.toMillis() : (Number.isFinite(ts) ? ts : null);
const _hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
/* Hot-path counters (heartbeats, page views) go to one of STAT_SHARDS docs so a
   popular film never exceeds Firestore's ~1 write/s sustained per-document rate;
   analytics sums the shards. Per-session counters stay on the main doc. */
const STAT_SHARDS = 10;
const _statShard = (filmId, key) => _db().collection('filmStats').doc(filmId).collection('shards').doc(String(parseInt(_hash(key).slice(0, 6), 16) % STAT_SHARDS));

async function _adminAudit(action, actorUid, details) {
  await _db().collection(COL.ADMIN_AUDIT).add({
    action, actorUid, module: 'creator-hub', details, at: FieldValue.serverTimestamp(),
  }).catch((e) => logger.error('[creator] admin audit write failed', { action, err: e.message }));
}

async function _config() {
  const [s, hc, cap] = await Promise.all([
    _db().collection(COL.CONFIG).doc('creatorHub').get(),
    _db().collection(COL.CONFIG).doc('hostedCheckout').get(),
    _db().collection(COL.CONFIG).doc(PCAP.RECORD).get(),
  ]);
  const d = s.exists ? s.data() : {};
  const h = hc.exists ? hc.data() : {};
  const capRecord = cap.exists ? cap.data() : null;
  const proven = PCAP.provenHostedMethods(capRecord);
  const hostedSwitch = h.enabled === true && Array.isArray(h.purposes) && h.purposes.includes(PURPOSE);
  const hostedOn = hostedSwitch && proven.length > 0;
  return {
    purchasesEnabled: d.purchasesEnabled === true,
    /* What a buyer may be offered (§8). M-PESA by STK push is the platform's
       live collection rail. Every hosted-checkout method comes ONLY from
       config/intasendCapability entries a Super Admin recorded as
       LIVE_AND_PROVEN with evidence (shared/payment-capability). The old
       free-text config/creatorHub.checkoutMethods is no longer read: it could
       name a method with no evidence behind it. */
    checkoutMethods: [...new Set(['M-PESA', ...(hostedOn ? proven : [])])],
    hostedMethods: hostedOn ? proven : [],
    capability: PCAP.classify(capRecord),
    /* Guest (anonymous) checkout. OFF by default and BLOCKED on a platform
       decision: enabling Firebase Anonymous Auth lets anonymous tokens satisfy
       every isAuthed() rule and req.auth-only callable platform-wide
       (docs/CREATOR_HUB.md "Guest checkout"). */
    guestCheckoutEnabled: d.guestCheckoutEnabled === true,
    /* Hosted checkout (card, Google/Apple Pay, PesaLink… whatever the ACCOUNT
       has enabled) is a platform switch in config/hostedCheckout, opened for
       film_access only after the capability probe. */
    hostedCheckoutEnabled: hostedOn,
    hostedCheckoutSwitch: hostedSwitch,
  };
}

/* ── Projections — what leaves the server ─────────────────────────────────── */

function _publicFilm(id, f) {
  return {
    filmId: id, creatorUid: f.creatorUid, creatorName: f.creatorName || null,
    title: f.title, description: f.description || '', subcategory: f.subcategory,
    subcategoryLabel: P.SUBCATEGORIES[f.subcategory] || null,
    genre: f.genre || null, language: f.language || null, country: f.country || null,
    releaseDate: f.releaseDate || null, runtimeMinutes: f.runtimeMinutes || null,
    ageRating: f.ageRating || null, classification: f.classification || null,
    posterUrl: f.posterUrl || null, trailerUrl: f.trailerUrl || null, previewSeconds: P.normalizePreviewSeconds(f.previewSeconds),
    /* A preview is offered only with BOTH a valid length and a verified preview file. */
    previewAvailable: P.normalizePreviewSeconds(f.previewSeconds) > 0 && f.previewReady === true,
    priceCents: f.priceCents, currency: f.currency, accessType: f.accessType, rentalDays: f.rentalDays || null,
    availability: f.availability || { mode: 'worldwide', countries: [] },
    pubState: f.pubState, publishedAt: _ms(f.publishedAt),
  };
}
function _ownerFilm(id, f) {
  return { ..._publicFilm(id, f), mediaReady: !!f.mediaReady, agreementVersion: f.agreementVersion || null,
    ownershipStatus: f.ownershipStatus || 'UNLOCKED', reviewNote: f.reviewNote || null,
    createdAt: _ms(f.createdAt), updatedAt: _ms(f.updatedAt) };
}
/* PUBLIC by default: no contact, no private data. `withContact` only for the
   creator's own view, AdminOS and verification — never the public catalogue. */
function _publicCreator(uid, c, { withContact = false } = {}) {
  return { creatorId: uid, displayName: c.displayName, bio: c.bio || '', country: c.country || null,
    avatarUrl: c.avatarUrl || null, verification: c.verification || 'UNVERIFIED', state: c.state,
    ...(withContact ? { supportEmail: c.supportEmail || null } : {}) };
}

/* ═══ CREATOR IDENTITY ═══════════════════════════════════════════════════ */

async function creatorRegister(req) {
  const uid = _uid(req);
  const d = req.data || {};
  const displayName = String(d.displayName || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
  if (displayName.length < 2) fail('invalid-argument', 'Display name is required.');
  const country = String(d.country || '').toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) fail('invalid-argument', 'Country must be a 2-letter code.');
  const avatarUrl = d.avatarUrl ? String(d.avatarUrl) : null;
  if (avatarUrl && !P.isOwnedPublicAsset(avatarUrl, uid)) fail('invalid-argument', 'Profile image must be uploaded to your creator storage.');
  const supportEmail = d.supportEmail ? String(d.supportEmail).trim().slice(0, 120) : null;
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) fail('invalid-argument', 'Support email is invalid.');
  const profile = { displayName, bio: String(d.bio || '').slice(0, 2000), country: country || null, avatarUrl, supportEmail };
  const priv = { legalName: String(d.legalName || '').trim().slice(0, 120) || null, phone: String(d.phone || '').replace(/[^\d+]/g, '').slice(0, 16) || null };

  const ref = _db().collection(COL.CREATORS).doc(uid);
  const privRef = _db().collection(COL.CREATOR_PRIVATE).doc(uid);
  const out = await _db().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) {
      txn.create(ref, { creatorId: uid, ...profile, state: P.CREATOR_STATE.PENDING, verification: 'UNVERIFIED',
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      txn.set(privRef, { ...priv, updatedAt: FieldValue.serverTimestamp() });
      return { state: P.CREATOR_STATE.PENDING, created: true };
    }
    const cur = snap.data();
    if (cur.state === P.CREATOR_STATE.SUSPENDED) fail('permission-denied', 'This creator account is suspended.');
    const next = cur.state === P.CREATOR_STATE.REJECTED ? P.CREATOR_STATE.PENDING : cur.state;
    txn.update(ref, { ...profile, state: next, updatedAt: FieldValue.serverTimestamp() });
    txn.set(privRef, { ...priv, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { state: next, created: false };
  });
  return out;
}

async function creatorMe(req) {
  const uid = _uid(req);
  const [c, films] = await Promise.all([
    _db().collection(COL.CREATORS).doc(uid).get(),
    _db().collection(COL.FILMS).where('creatorUid', '==', uid).where('creatorHub', '==', true).limit(200).get(),
  ]);
  const v = await _db().collection(COL.VERIFICATIONS).doc(uid).get();
  return {
    creator: c.exists ? { ..._publicCreator(uid, c.data(), { withContact: true }), reviewNote: c.data().reviewNote || null } : null,
    verificationStatus: v.exists ? v.data().status : P.VERIFICATION_STATE.NOT_APPLIED,
    rightsAttestation: RIGHTS_ATTESTATION,
    films: films.docs.map((d) => _ownerFilm(d.id, d.data())),
  };
}

/* ═══ FILMS ══════════════════════════════════════════════════════════════ */

async function _loadOwnFilm(txnOrNull, uid, filmId, { allowAdmin = false, isAdmin = false } = {}) {
  const ref = _db().collection(COL.FILMS).doc(filmId);
  const snap = txnOrNull ? await txnOrNull.get(ref) : await ref.get();
  if (!snap.exists || snap.data().creatorHub !== true) fail('not-found', 'Film not found.');
  const f = snap.data();
  if (f.creatorUid !== uid && !(allowAdmin && isAdmin)) fail('permission-denied', 'Not your film.');
  return { ref, snap, film: f };
}

async function filmSaveDraft(req) {
  const uid = _uid(req);
  const d = { ...(req.data || {}) };
  const filmId = d.filmId ? _id(d.filmId, 'filmId') : null;
  delete d.filmId;
  const input = _rule(() => P.sanitizeFilmInput(d, { uid, partial: !!filmId }));

  const creatorRef = _db().collection(COL.CREATORS).doc(uid);
  return _db().runTransaction(async (txn) => {
    const cSnap = await txn.get(creatorRef);
    if (!cSnap.exists) fail('failed-precondition', 'Register as a creator first.');
    const creator = cSnap.data();
    if (![P.CREATOR_STATE.ACTIVE, P.CREATOR_STATE.PENDING].includes(creator.state)) fail('permission-denied', 'Creator account is not able to publish.');

    if (!filmId) {
      const ref = _db().collection(COL.FILMS).doc();
      const full = _rule(() => P.sanitizeFilmInput({ ...input }, { uid }));
      txn.create(ref, {
        ...full, creatorHub: true, filmId: ref.id, listingId: ref.id, creatorUid: uid, creatorName: creator.displayName,
        entType: 'creator_hub', category: 'creator', availability: full.availability || { mode: 'worldwide', countries: [] },
        pubState: P.FILM_STATE.DRAFT, status: 'draft', mediaReady: false, agreementVersion: null, ownershipStatus: 'UNLOCKED',
        price: full.priceCents / 100, thumbnailUrl: full.posterUrl || null,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      return { filmId: ref.id, pubState: P.FILM_STATE.DRAFT };
    }
    const { ref, film } = await _loadOwnFilm(txn, uid, filmId);
    if (![P.FILM_STATE.DRAFT, P.FILM_STATE.REJECTED].includes(film.pubState)) {
      fail('failed-precondition', `A ${film.pubState} film cannot be edited. Ask an admin to reopen it.`);
    }
    /* Re-validate the MERGED document so partial updates cannot assemble an
       invalid whole (e.g. rental without days). */
    const merged = {};
    for (const k of ['title', 'description', 'subcategory', 'genre', 'language', 'country', 'releaseDate', 'runtimeMinutes',
      'ageRating', 'classification', 'posterUrl', 'trailerUrl', 'previewSeconds', 'priceCents', 'currency', 'accessType',
      'rentalDays', 'availability']) {
      if (Object.prototype.hasOwnProperty.call(input, k)) merged[k] = input[k];
      else if (film[k] !== undefined && film[k] !== null) merged[k] = film[k];
    }
    const full = _rule(() => P.sanitizeFilmInput(merged, { uid }));
    txn.update(ref, {
      ...full, price: full.priceCents / 100, thumbnailUrl: full.posterUrl || null,
      pubState: P.FILM_STATE.DRAFT, status: 'draft', updatedAt: FieldValue.serverTimestamp(),
    });
    return { filmId, pubState: P.FILM_STATE.DRAFT };
  });
}

const MASTER_MAX_BYTES = 8 * 1024 * 1024 * 1024;   /* 8 GiB — mirrors storage.rules */
/* Create-only objects (storage.rules): each upload gets a fresh server-issued
   id, so an attached master is immutable and a draft can still take a new file. */
const _masterPath = (uid, filmId, uploadId) => `creator-masters/${uid}/${filmId}/${uploadId}`;

async function filmMediaUploadTarget(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const { film } = await _loadOwnFilm(null, uid, filmId);
  if (![P.FILM_STATE.DRAFT, P.FILM_STATE.REJECTED].includes(film.pubState)) fail('failed-precondition', 'Media can only change while the film is a draft.');
  const uploadId = crypto.randomBytes(12).toString('hex');
  await _db().collection(COL.FILMS).doc(filmId).update({ pendingUploadId: uploadId, updatedAt: FieldValue.serverTimestamp() });
  return { storagePath: _masterPath(uid, filmId, uploadId), uploadId, maxBytes: MASTER_MAX_BYTES, accept: 'video/*' };
}

/* The client uploads straight to Storage (rules: owner write, no client read).
   The server then VERIFIES the object before it counts: a flag the client
   sets is not evidence that a file exists. */
async function filmAttachMedia(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const { ref, film } = await _loadOwnFilm(null, uid, filmId);
  if (![P.FILM_STATE.DRAFT, P.FILM_STATE.REJECTED].includes(film.pubState)) fail('failed-precondition', 'Media can only change while the film is a draft.');
  if (!film.pendingUploadId) fail('failed-precondition', 'Request an upload target first.');
  const path = _masterPath(uid, filmId, film.pendingUploadId);
  const file = _bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) fail('failed-precondition', 'Upload the film file first.');
  const [meta] = await file.getMetadata();
  const size = Number(meta.size);
  if (!/^video\//.test(String(meta.contentType || ''))) fail('failed-precondition', 'The uploaded file is not a video.');
  if (!(size > 0 && size <= MASTER_MAX_BYTES)) fail('failed-precondition', 'The uploaded file size is out of range.');
  await _db().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (![P.FILM_STATE.DRAFT, P.FILM_STATE.REJECTED].includes(snap.data().pubState)) fail('failed-precondition', 'Film changed state; retry.');
    txn.set(_db().collection(COL.MEDIA).doc(filmId), {
      filmId, creatorUid: uid, storagePath: path, contentType: meta.contentType, sizeBytes: size,
      generation: String(meta.generation || ''), verifiedAt: FieldValue.serverTimestamp(),
    });
    txn.update(ref, { mediaReady: true, pendingUploadId: null, updatedAt: FieldValue.serverTimestamp() });
  });
  return { mediaReady: true, sizeBytes: size, contentType: meta.contentType };
}

/* ═══ PREVIEW RENDITION ══════════════════════════════════════════════════
   A preview is a SEPARATE file the creator uploads (the first N seconds of the
   film, or a cut of them). The master is never cut or signed for a
   non-entitled viewer, so the preview grant cannot leak the full film. Same
   create-only, no-client-read posture as the master (storage.rules). */
const PREVIEW_MAX_BYTES = 1024 * 1024 * 1024;   /* 1 GiB — mirrors storage.rules */
const _previewPath = (uid, filmId, uploadId) => `creator-previews/${uid}/${filmId}/${uploadId}`;

async function filmPreviewUploadTarget(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const { film } = await _loadOwnFilm(null, uid, filmId);
  if (![P.FILM_STATE.DRAFT, P.FILM_STATE.REJECTED].includes(film.pubState)) fail('failed-precondition', 'The preview can only change while the film is a draft.');
  const uploadId = crypto.randomBytes(12).toString('hex');
  await _db().collection(COL.FILMS).doc(filmId).update({ pendingPreviewUploadId: uploadId, updatedAt: FieldValue.serverTimestamp() });
  return { storagePath: _previewPath(uid, filmId, uploadId), uploadId, maxBytes: PREVIEW_MAX_BYTES, accept: 'video/*' };
}

async function filmAttachPreview(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const { ref, film } = await _loadOwnFilm(null, uid, filmId);
  if (![P.FILM_STATE.DRAFT, P.FILM_STATE.REJECTED].includes(film.pubState)) fail('failed-precondition', 'The preview can only change while the film is a draft.');
  if (!film.pendingPreviewUploadId) fail('failed-precondition', 'Request a preview upload target first.');
  const path = _previewPath(uid, filmId, film.pendingPreviewUploadId);
  const file = _bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) fail('failed-precondition', 'Upload the preview file first.');
  const [meta] = await file.getMetadata();
  const size = Number(meta.size);
  if (!/^video\//.test(String(meta.contentType || ''))) fail('failed-precondition', 'The uploaded preview is not a video.');
  if (!(size > 0 && size <= PREVIEW_MAX_BYTES)) fail('failed-precondition', 'The uploaded preview size is out of range.');
  await _db().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (![P.FILM_STATE.DRAFT, P.FILM_STATE.REJECTED].includes(snap.data().pubState)) fail('failed-precondition', 'Film changed state; retry.');
    txn.set(_db().collection(COL.MEDIA).doc(filmId), {
      previewStoragePath: path, previewContentType: meta.contentType, previewSizeBytes: size,
      previewGeneration: String(meta.generation || ''), previewVerifiedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    txn.update(ref, { previewReady: true, pendingPreviewUploadId: null, updatedAt: FieldValue.serverTimestamp() });
  });
  return { previewReady: true, sizeBytes: size, contentType: meta.contentType };
}

/* ═══ ROYALTY AGREEMENTS ═════════════════════════════════════════════════ */

async function _versions(filmId, txn) {
  const q = _db().collection(COL.AGREEMENTS).doc(filmId).collection('versions');
  const snap = txn ? await txn.get(q) : await q.get();
  return snap.docs.map((d) => ({ ...d.data(), _ref: d.ref }));
}

/* Participant consent is NOT required by current policy (owner decision pending —
   docs/CREATOR_HUB.md "DECISION_REQUIRED"). What IS required: the rights owner
   represents, per version, that they hold the authority to make this split.
   The exact text and its version are stored with the agreement. */
const RIGHTS_ATTESTATION = Object.freeze({
  version: 'rights-attestation-v1',
  text: 'I confirm that I hold the rights to this work and the authority to allocate its royalties as set out in this split, and that each listed participant is entitled to the share shown.',
});

async function agreementSaveDraft(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  if ((req.data || {}).rightsAttestation !== RIGHTS_ATTESTATION.version) {
    fail('failed-precondition', 'Confirm that you have the authority to set this royalty split (rights attestation).');
  }
  const v = R.validateAgreement((req.data || {}).participants);
  if (!v.ok) fail('invalid-argument', 'Royalty split invalid: ' + v.errors.join('; '));
  return _db().runTransaction(async (txn) => {
    const { film } = await _loadOwnFilm(txn, uid, filmId);
    if (film.pubState === P.FILM_STATE.SUSPENDED) fail('failed-precondition', 'Film is suspended.');
    const versions = await _versions(filmId, txn);
    const draft = versions.find((x) => x.status === R.AGREEMENT_STATUS.DRAFT);
    const maxV = versions.reduce((m, x) => Math.max(m, x.version), 0);
    const version = draft ? draft.version : maxV + 1;
    const ref = _db().collection(COL.AGREEMENTS).doc(filmId).collection('versions').doc(String(version));
    txn.set(ref, {
      filmId, version, status: R.AGREEMENT_STATUS.DRAFT, participants: v.participants, totalBps: v.totalBps,
      fullyAllocated: v.totalBps === R.BPS_TOTAL, proposedBy: uid, updatedAt: FieldValue.serverTimestamp(),
      rightsAttestation: { version: RIGHTS_ATTESTATION.version, text: RIGHTS_ATTESTATION.text, by: uid, atMs: _clock() },
      participantConsent: 'NOT_REQUIRED_BY_POLICY',
      ...(draft ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
    return { filmId, version, status: R.AGREEMENT_STATUS.DRAFT, totalBps: v.totalBps, fullyAllocated: v.totalBps === R.BPS_TOTAL };
  });
}

/* Lock inside a caller's transaction. Reads must already have happened —
   `versions` is passed in. Writes the participant index for dashboards. */
function _lockInTxn(txn, filmId, film, versions, version, actorUid) {
  const nowMs = _clock();
  const plan = _rule(() => R.planLock(versions, version, nowMs));
  const vref = _db().collection(COL.AGREEMENTS).doc(filmId).collection('versions');
  const draft = versions.find((x) => x.version === version);
  txn.update(vref.doc(String(version)), { ...plan.lock, lockedBy: actorUid, lockedAt: FieldValue.serverTimestamp() });
  if (plan.supersede) txn.update(vref.doc(String(plan.supersede.version)), { status: plan.supersede.status, effectiveUntil: plan.supersede.effectiveUntil });
  for (const p of draft.participants) {
    txn.set(_db().collection(COL.PARTICIPATIONS).doc(`${p.uid}_${filmId}_v${version}`), {
      uid: p.uid, filmId, title: film.title, creatorUid: film.creatorUid, version, participantId: p.participantId,
      participantType: p.participantType, bps: p.bps, effectiveFrom: plan.lock.effectiveFrom, effectiveUntil: null,
      status: 'ACTIVE', createdAt: FieldValue.serverTimestamp(),
    });
  }
  if (plan.supersede) {
    const prev = versions.find((x) => x.version === plan.supersede.version);
    for (const p of (prev && prev.participants) || []) {
      txn.set(_db().collection(COL.PARTICIPATIONS).doc(`${p.uid}_${filmId}_v${prev.version}`),
        { effectiveUntil: plan.supersede.effectiveUntil, status: 'ENDED' }, { merge: true });
    }
  }
  txn.update(_db().collection(COL.FILMS).doc(filmId), { agreementVersion: version, ownershipStatus: 'LOCKED', updatedAt: FieldValue.serverTimestamp() });
  return plan;
}

/* ═══ PUBLICATION ════════════════════════════════════════════════════════ */

async function filmSubmit(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  return _db().runTransaction(async (txn) => {
    const cSnap = await txn.get(_db().collection(COL.CREATORS).doc(uid));
    const { ref, film } = await _loadOwnFilm(txn, uid, filmId);
    const versions = await _versions(filmId, txn);
    _rule(() => P.assertFilmTransition('creator', film.pubState, P.FILM_STATE.SUBMITTED));
    const draft = versions.find((x) => x.status === R.AGREEMENT_STATUS.DRAFT);
    const locked = versions.find((x) => x.status === R.AGREEMENT_STATUS.LOCKED);
    const r = P.publishReadiness(film, {
      creatorState: cSnap.exists ? cSnap.data().state : null,
      lockedVersion: locked ? locked.version : null,
      draftAgreementOk: !!draft && R.validateAgreement(draft.participants, { requireFull: true }).ok,
      mediaReady: film.mediaReady === true,
    });
    if (!r.ready) fail('failed-precondition', 'Not ready to submit: ' + r.missing.join(', '));
    txn.update(ref, { pubState: P.FILM_STATE.SUBMITTED, status: 'draft', submittedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { filmId, pubState: P.FILM_STATE.SUBMITTED };
  });
}

async function filmReopen(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  return _db().runTransaction(async (txn) => {
    const { ref, film } = await _loadOwnFilm(txn, uid, filmId);
    _rule(() => P.assertFilmTransition('creator', film.pubState, P.FILM_STATE.DRAFT));
    txn.update(ref, { pubState: P.FILM_STATE.DRAFT, status: 'draft', updatedAt: FieldValue.serverTimestamp() });
    return { filmId, pubState: P.FILM_STATE.DRAFT };
  });
}

/* Creator publishes an APPROVED film. The agreement was locked at approval. */
async function filmPublish(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  return _db().runTransaction(async (txn) => {
    const cSnap = await txn.get(_db().collection(COL.CREATORS).doc(uid));
    const { ref, film } = await _loadOwnFilm(txn, uid, filmId);
    _rule(() => P.assertFilmTransition('creator', film.pubState, P.FILM_STATE.PUBLISHED));
    if (!cSnap.exists || cSnap.data().state !== P.CREATOR_STATE.ACTIVE) fail('permission-denied', 'Creator account is not active.');
    if (!film.agreementVersion || film.ownershipStatus !== 'LOCKED') fail('failed-precondition', 'Royalty agreement is not locked.');
    txn.update(ref, { pubState: P.FILM_STATE.PUBLISHED, status: 'active', publishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { filmId, pubState: P.FILM_STATE.PUBLISHED };
  });
}

/* ═══ CATALOGUE (public) ═════════════════════════════════════════════════ */

async function catalogList(req) {
  const d = req.data || {};
  const limit = Math.min(48, Math.max(1, Number(d.limit) || 24));
  let q = _db().collection(COL.FILMS).where('creatorHub', '==', true).where('status', '==', 'active');
  if (d.subcategory) {
    if (!Object.prototype.hasOwnProperty.call(P.SUBCATEGORIES, d.subcategory)) fail('invalid-argument', 'Unknown subcategory.');
    q = q.where('subcategory', '==', d.subcategory);
  }
  q = q.orderBy('publishedAt', 'desc').limit(limit);
  if (d.cursor) {
    const c = await _db().collection(COL.FILMS).doc(_id(d.cursor, 'cursor')).get();
    if (c.exists) q = q.startAfter(c);
  }
  const snap = await q.get();
  return {
    subcategories: P.SUBCATEGORIES,
    films: snap.docs.map((x) => _publicFilm(x.id, x.data())),
    nextCursor: snap.docs.length === limit ? snap.docs[snap.docs.length - 1].id : null,
  };
}

async function _viewerAccess(uid, filmId) {
  if (!uid) return null;
  const a = await _db().collection(COL.ACCESS).doc(`${uid}_${filmId}`).get();
  if (!a.exists) return null;
  const x = a.data();
  const expired = x.expiresAtMs != null && _clock() >= x.expiresAtMs;
  return { status: expired ? 'EXPIRED' : x.status, expiresAtMs: x.expiresAtMs || null, entitlementId: x.paymentRef };
}

async function catalogGet(req) {
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const snap = await _db().collection(COL.FILMS).doc(filmId).get();
  if (!snap.exists || snap.data().creatorHub !== true || snap.data().status !== 'active') fail('not-found', 'Film not found.');
  const f = snap.data();
  const uid = req.auth && req.auth.uid;
  const [cSnap, access, cfg, userSnap] = await Promise.all([
    _db().collection(COL.CREATORS).doc(f.creatorUid).get(),
    _viewerAccess(uid, filmId),
    _config(),
    uid ? _db().collection('users').doc(uid).get() : Promise.resolve(null),
  ]);
  const country = userSnap && userSnap.exists ? String(userSnap.data().country || userSnap.data().countryCode || '') : '';
  const avail = P.isAvailableIn(f.availability, country);
  _statShard(filmId, crypto.randomBytes(4).toString('hex')).set({ pageViews: FieldValue.increment(1) }, { merge: true }).catch(() => {});
  return {
    film: _publicFilm(filmId, f),
    creator: cSnap.exists && cSnap.data().state === P.CREATOR_STATE.ACTIVE ? _publicCreator(f.creatorUid, cSnap.data()) : null,
    viewer: uid ? { access, availability: avail, isCreator: f.creatorUid === uid } : null,
    checkout: {
      enabled: cfg.purchasesEnabled,
      /* §8: never promise a method the live account has not been verified for. */
      notice: 'Payment methods available at checkout',
      guestCheckout: cfg.guestCheckoutEnabled,
      hostedCheckout: cfg.hostedCheckoutEnabled,
      verifiedMethods: cfg.checkoutMethods,
      methods: [{ method: 'M-PESA', label: 'M-PESA', rail: 'stk' }]
        .concat(cfg.hostedMethods.map((m) => ({ method: m, label: PCAP.LABELS[m], rail: 'hosted_checkout' }))),
      currency: f.currency,
    },
  };
}

/* Public creator profile: ACTIVE creators only, published films only, public
   fields only (no private contact, no payout details, no earnings). */
async function catalogCreator(req) {
  const creatorId = _id((req.data || {}).creatorId, 'creatorId');
  const c = await _db().collection(COL.CREATORS).doc(creatorId).get();
  if (!c.exists || c.data().state !== P.CREATOR_STATE.ACTIVE) fail('not-found', 'Creator not found.');
  const films = await _db().collection(COL.FILMS).where('creatorUid', '==', creatorId).where('creatorHub', '==', true).where('status', '==', 'active').limit(100).get();
  return { creator: _publicCreator(creatorId, c.data()), films: films.docs.map((d) => _publicFilm(d.id, d.data())) };
}

/* ═══ PURCHASE — the `film_access` pricer (registered in payment-purposes) ═══ */

/**
 * Server-derived price for createPaymentIntent. Refuses rather than guesses:
 * purchases disabled, film not PUBLISHED, creator not ACTIVE, buyer is the
 * creator (a self-purchase would wash money through the royalty ledger),
 * already entitled, or not licensed in the buyer's declared country.
 */
async function priceFilmAccess(uid, data) {
  const filmId = _id((data || {}).filmId, 'filmId');
  const [cfg, fSnap, aSnap, uSnap] = await Promise.all([
    _config(),
    _db().collection(COL.FILMS).doc(filmId).get(),
    _db().collection(COL.ACCESS).doc(`${uid}_${filmId}`).get(),
    _db().collection('users').doc(uid).get(),
  ]);
  /* Kill switch, default OFF: purchases stay closed until the webhook's film
     branch is deployed — otherwise the old webhook would credit the payer. */
  if (!cfg.purchasesEnabled) fail('failed-precondition', 'Film purchases are not open yet.');
  /* The pricer receives only the verified uid; anonymity is read from the auth
     record (an anonymous user has no linked provider), never from the client. */
  const rec = await require('firebase-admin/auth').getAuth().getUser(uid).catch(() => null);
  const anonymous = !rec || !Array.isArray(rec.providerData) || rec.providerData.length === 0;
  if (anonymous && !cfg.guestCheckoutEnabled) fail('failed-precondition', 'Sign in to buy this film.');
  if (!fSnap.exists || fSnap.data().creatorHub !== true) fail('not-found', 'Film not found.');
  const f = fSnap.data();
  if (f.pubState !== P.FILM_STATE.PUBLISHED) fail('failed-precondition', 'This film is not on sale.');
  if (f.creatorUid === uid) fail('failed-precondition', 'You cannot buy your own film.');
  const cSnap = await _db().collection(COL.CREATORS).doc(f.creatorUid).get();
  if (!cSnap.exists || cSnap.data().state !== P.CREATOR_STATE.ACTIVE) fail('failed-precondition', 'This film is not on sale.');
  if (aSnap.exists) {
    const a = aSnap.data();
    if (a.status === 'ACTIVE' && (a.expiresAtMs == null || _clock() < a.expiresAtMs)) fail('already-exists', 'You already have access to this film.');
  }
  const country = uSnap.exists ? String(uSnap.data().country || uSnap.data().countryCode || '') : '';
  const avail = P.isAvailableIn(f.availability, country);
  if (!avail.available) fail('failed-precondition', avail.reason === 'country_unknown'
    ? 'Set your country in your profile — this film is licensed for specific countries.'
    : 'This film is not licensed in your country.');
  if (!P.SUPPORTED_CURRENCIES.includes(f.currency)) fail('failed-precondition', 'This film is priced in an unsupported currency.');
  if (!(Number.isSafeInteger(f.priceCents) && f.priceCents >= P.PRICE_MIN_CENTS && f.priceCents % 100 === 0)) fail('failed-precondition', 'This film has no payable price.');
  return {
    amountCents: f.priceCents,
    currency: f.currency,
    resourceType: 'film',
    resourceId: filmId,
    /* NO sellerUid on purpose: royalty money is not seller proceeds (§27). The
       webhook's film branch skips the seller credit for this purpose. */
    metadata: {
      type: PURPOSE, filmId, creatorUid: f.creatorUid, title: String(f.title || '').slice(0, 80),
      accessType: f.accessType, rentalDays: f.accessType === 'rental' ? f.rentalDays : null,
      priceCents: f.priceCents, currency: f.currency,
    },
  };
}

/* ═══ ENTITLEMENT ADAPTER (registered in entitlement-adapters) ═══════════ */

const filmAccessAdapter = {
  validate(ctx) {
    if (!ctx.resourceId) { const e = new Error('No filmId on the intent.'); e.code = 'resource_missing'; throw e; }
    const m = (ctx.intent && ctx.intent.metadata) || {};
    if (!['purchase', 'rental'].includes(m.accessType)) { const e = new Error('Intent carries no access type.'); e.code = 'metadata_invalid'; throw e; }
    if (m.accessType === 'rental' && !(Number.isSafeInteger(m.rentalDays) && m.rentalDays >= 1 && m.rentalDays <= 30)) {
      const e = new Error('Rental intent carries no rental window.'); e.code = 'metadata_invalid'; throw e;
    }
    return { ok: true };
  },
  /* Runs INSIDE the engine's transaction, after its ledger read and before any
     write — so this handler may only write. The engine's create() on
     entitlements/{paymentRef} is the exactly-once guarantee. */
  activate(txn, ctx) {
    const m = ctx.intent.metadata || {};
    const nowMs = _clock();
    const expiresAtMs = m.accessType === 'rental' ? nowMs + m.rentalDays * 86400000 : null;
    const filmId = String(ctx.resourceId);
    txn.set(_db().collection(COL.ENTITLEMENTS).doc(ctx.paymentRef), {
      entitlementId: ctx.paymentRef, buyerUid: ctx.ownerUid, contentId: filmId, paymentRef: ctx.paymentRef,
      orderId: ctx.paymentRef, purchasedAmountCents: ctx.amountCents || Math.round(ctx.amount * 100),
      currency: ctx.currency, entitlementType: m.accessType, rentalDays: m.rentalDays || null,
      acquiredAt: FieldValue.serverTimestamp(), expiresAt: expiresAtMs ? Timestamp.fromMillis(expiresAtMs) : null,
      expiresAtMs, status: 'ACTIVE', provider: 'intasend', providerRef: (ctx.payment && ctx.payment.checkoutId) || null,
    });
    txn.set(_db().collection(COL.ACCESS).doc(`${ctx.ownerUid}_${filmId}`), {
      buyerUid: ctx.ownerUid, contentId: filmId, paymentRef: ctx.paymentRef, status: 'ACTIVE', expiresAtMs,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ref: `${COL.ENTITLEMENTS}/${ctx.paymentRef}` };
  },
  async revoke(txn, led, reason) {
    const accessRef = _db().collection(COL.ACCESS).doc(`${led.ownerUid}_${led.resourceId}`);
    const a = await txn.get(accessRef);
    txn.set(_db().collection(COL.ENTITLEMENTS).doc(led.paymentRef), {
      status: 'REVOKED', revokedAt: FieldValue.serverTimestamp(), revokeReason: String(reason || '').slice(0, 200),
    }, { merge: true });
    /* Only clear the pointer if it still points at THIS purchase — a later
       re-purchase must not be revoked by an old refund. */
    if (a.exists && a.data().paymentRef === led.paymentRef) {
      txn.set(accessRef, { status: 'REVOKED', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    return { ref: `${COL.ENTITLEMENTS}/${led.paymentRef}` };
  },
  async status(ctx) {
    const s = await _db().collection(COL.ENTITLEMENTS).doc(ctx.paymentRef).get();
    return s.exists ? { status: s.data().status, expiresAtMs: s.data().expiresAtMs || null } : { status: 'NONE' };
  },
};

/* ═══ ROYALTY ACCRUAL ════════════════════════════════════════════════════ */

/**
 * The provider fee, from what IntaSend reported on the payment. Charges if
 * reported; else value − net_amount if both reported; else UNKNOWN — and an
 * unknown fee WITHHOLDS the accrual rather than assuming zero.
 */
function _providerFee(payment) {
  const rep = payment.providerReport || {};
  const toCents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : null; };
  const charges = rep.charges == null ? null : toCents(rep.charges);
  if (charges != null && charges >= 0) return { cents: charges, source: 'provider_charges' };
  const value = rep.value == null ? null : toCents(rep.value);
  const net = rep.netAmount == null ? null : toCents(rep.netAmount);
  if (value != null && net != null && value >= net) return { cents: value - net, source: 'provider_value_minus_net' };
  return { cents: null, source: 'unreported' };
}

async function _exception(ref, kind, detail) {
  await _db().collection(COL.EXCEPTIONS).doc(`${kind}_${ref}`).set({
    paymentRef: ref, kind, detail: String(detail || '').slice(0, 500), status: 'OPEN', updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true }).catch((e) => logger.error('[creator] exception write failed', { ref, err: e.message }));
}

/**
 * Recognise royalties for one paid film purchase — exactly once.
 * The claim is create() on royaltyAccruals/{acc_ref} in the SAME transaction
 * as every ledger row: a replayed webhook, a re-fired trigger or a concurrent
 * reconciler all contend on that one document and only one commits.
 */
async function accrueRoyalty(paymentRef, opts = {}) {
  const ref = String(paymentRef || '');
  const accRef = _db().collection(COL.ACCRUALS).doc(R.accrualId(ref));
  const [iSnap, pSnap] = await Promise.all([
    _db().collection('paymentIntents').doc(ref).get(),
    _db().collection('payments').doc(ref).get(),
  ]);
  if (!iSnap.exists || iSnap.data().purpose !== PURPOSE) return { skipped: 'not_film' };
  /* Claim first: an accrued OR refund-voided sale is final — no fee/pool work,
     no fresh exception. (The transaction below re-checks; this is the fast path.) */
  const pre = await accRef.get();
  if (pre.exists) return { alreadyAccrued: true, status: pre.data().status };
  const intent = iSnap.data();
  const payment = pSnap.exists ? pSnap.data() : null;
  const engine = require('./entitlement-engine');
  try { engine.assertPaymentHonourable(intent, payment); } catch (e) { return { refused: e.code || 'not_honourable' }; }

  /* Currency reconciliation (§9): what was bound to the intent must be what
     the provider reported settling. */
  const repCurrency = String((payment.providerReport || {}).currency || payment.currency || '').toUpperCase();
  if (repCurrency && repCurrency !== String(intent.currency || '').toUpperCase()) {
    await _exception(ref, 'currency_mismatch', `intent ${intent.currency} vs provider ${repCurrency}`);
    return { withheld: 'currency_mismatch' };
  }
  const fee = _providerFee(payment);
  if (fee.cents == null) {
    await _exception(ref, 'fee_unreported', 'provider did not report charges or net amount; accrual withheld');
    return { withheld: 'fee_unreported' };
  }
  const policy = require('./shared/creator-commercial').policyFor(intent);
  const grossCents = Number(intent.amountCents);
  const filmId = String(intent.resourceId);
  const recognisedAtMs = _ms(payment.webhookReceivedAt) || _ms(payment.updatedAt) || _clock();

  let pool;
  try { pool = R.computePool({ grossCents, providerFeeCents: fee.cents, taxCents: 0, policy }); }
  catch (e) { await _exception(ref, 'pool_invalid', `${e.code}: ${e.message}`); return { withheld: e.code }; }

  try {
    return await _db().runTransaction(async (txn) => {
      /* ── reads ── */
      const acc = await txn.get(accRef);
      if (acc.exists) return { alreadyAccrued: true, status: acc.data().status };
      const versions = await _versions(filmId, txn);
      const version = R.selectVersionAt(versions, recognisedAtMs);
      if (!version) { const e = new Error('no locked agreement governs this sale'); e.code = 'agreement_missing'; throw e; }
      let period = R.periodFor(recognisedAtMs);
      const perSnap = await txn.get(_db().collection(COL.PERIODS).doc(period.periodId));
      let late = false;
      if (perSnap.exists && perSnap.data().status !== R.PERIOD_STATUS.OPEN) {
        /* The sale's own quarter is already settled — recognise it now, in the
           current quarter, and say so. Never write into a frozen statement. */
        period = R.periodFor(_clock()); late = true;
        const cur = await txn.get(_db().collection(COL.PERIODS).doc(period.periodId));
        if (cur.exists && cur.data().status !== R.PERIOD_STATUS.OPEN) { const e = new Error('current period is not open'); e.code = 'period_closed'; throw e; }
      }
      const shares = R.allocate(pool.poolCents, version.participants);

      /* ── writes ── */
      const base = { paymentRef: ref, accrualId: accRef.id, filmId, creatorUid: (intent.metadata || {}).creatorUid || null,
        agreementVersion: version.version, currency: intent.currency, periodId: period.periodId, recognisedLate: late,
        grossCents, netCents: pool.netCents, deductions: { providerFeeCents: pool.providerFeeCents, commissionCents: pool.commissionCents, taxCents: pool.taxCents },
        poolCents: pool.poolCents, status: 'RECOGNISED', recognisedAtMs, createdAt: FieldValue.serverTimestamp() };
      txn.create(accRef, {
        ...base, status: 'ACCRUED', policyId: pool.policyId, commissionBps: pool.commissionBps, poolBps: pool.poolBps, feeSource: fee.source, refundedCents: 0,
        participantCount: shares.length, buyerUid: intent.ownerUid || intent.uid, source: opts.source || 'unknown',
      });
      const L = _db().collection(COL.LEDGER);
      for (const s of shares) {
        const entryId = R.earnEntryId(ref, version.version, s.participantId);
        txn.create(L.doc(entryId), { ...base, entryId, kind: R.ENTRY_KIND.EARN, bucket: R.BUCKET.PARTICIPANT_ROYALTY,
          participantId: s.participantId, participantType: s.participantType, uid: s.uid, bps: s.bps, amountCents: s.amountCents });
      }
      txn.create(L.doc(R.bucketEntryId(ref, R.BUCKET.PLATFORM_COMMISSION)), { ...base, entryId: R.bucketEntryId(ref, R.BUCKET.PLATFORM_COMMISSION),
        kind: R.ENTRY_KIND.EARN, bucket: R.BUCKET.PLATFORM_COMMISSION, uid: null, bps: pool.commissionBps, policyId: pool.policyId, amountCents: pool.commissionCents });
      txn.create(L.doc(R.bucketEntryId(ref, R.BUCKET.PROVIDER_FEE)), { ...base, entryId: R.bucketEntryId(ref, R.BUCKET.PROVIDER_FEE),
        kind: R.ENTRY_KIND.EARN, bucket: R.BUCKET.PROVIDER_FEE, uid: null, bps: null, amountCents: pool.providerFeeCents, feeSource: fee.source });
      return { accrued: true, periodId: period.periodId, poolCents: pool.poolCents, participants: shares.length, version: version.version };
    });
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return { alreadyAccrued: true };  /* lost the create() race */
    await _exception(ref, 'accrual_failed', `${e.code || ''} ${e.message}`);
    return { withheld: e.code || 'accrual_failed' };
  }
}

/* ═══ PAYMENT TRIGGER ════════════════════════════════════════════════════ */

const { TERMINAL_PAID } = require('./shared/constants');
function shouldProcess(before, after) {
  if (!after) return false;
  const was = TERMINAL_PAID.has(String((before && before.status) || '').toUpperCase());
  const is  = TERMINAL_PAID.has(String(after.status || '').toUpperCase());
  return is && !was;
}

async function processFilmPayment(paymentRef, opts = {}) {
  const ref = String(paymentRef || '').trim();
  if (!ref) return { skipped: 'no_ref' };
  const iSnap = await _db().collection('paymentIntents').doc(ref).get();
  if (!iSnap.exists) return { skipped: 'no_intent' };
  if (iSnap.data().purpose !== PURPOSE) return { skipped: 'other_purpose' };
  const engine = require('./entitlement-engine');
  require('./entitlement-adapters');
  let activation;
  try { activation = await engine.activate(ref, { source: opts.source || 'payment-trigger' }); }
  catch (e) {
    logger.warn('[creator] activation refused', { ref, code: e.code || null, err: e.message });
    return { refused: e.code || 'unknown' };
  }
  /* Access is granted whether or not the royalty accrual succeeds: the buyer
     paid. A withheld accrual is an OPEN exception in AdminOS, not a lost sale. */
  const royalty = await accrueRoyalty(ref, { source: opts.source || 'payment-trigger' });
  return { activation, royalty };
}

exports.creatorOnFilmPayment = onDocumentWritten(
  { document: 'payments/{paymentId}', region: REGION, timeoutSeconds: 120, memory: '256MiB' },
  async (event) => {
    if (!event.data || !event.data.after || !event.data.after.exists) return;
    const after = event.data.after.data();
    const before = event.data.before && event.data.before.exists ? event.data.before.data() : null;
    if (!shouldProcess(before, after)) return;
    await processFilmPayment(event.params.paymentId, { source: 'payment-trigger' })
      .catch((e) => logger.error('[creator] unexpected', { ref: event.params.paymentId, err: e.message }));
  },
);

/* ═══ REFUND HOOK (called by financial-os after a refund is PROCESSED) ═══ */

/**
 * @param {{payRef:string, refundId:string, amountCents:number, source?:string}} p
 * Never throws into the refund path — the money has already moved. Failures
 * become OPEN creatorExceptions for AdminOS to retry.
 */
async function onFilmRefundProcessed({ payRef, refundId, amountCents, source = 'refund' }) {
  const ref = String(payRef || '');
  try {
    const iSnap = await _db().collection('paymentIntents').doc(ref).get();
    if (!iSnap.exists || iSnap.data().purpose !== PURPOSE) return { skipped: 'not_film' };
    const intent = iSnap.data();
    const grossCents = Number(intent.amountCents);
    const refundCents = Math.round(Number(amountCents));
    if (!(Number.isSafeInteger(refundCents) && refundCents > 0)) throw Object.assign(new Error('refund amount invalid'), { code: 'amount_invalid' });

    const rid = _rule(() => { R.accrualId(refundId); return String(refundId); });
    const revRef = _db().collection(COL.REVERSALS).doc(rid);
    const accRef = _db().collection(COL.ACCRUALS).doc(R.accrualId(ref));
    const result = await _db().runTransaction(async (txn) => {
      /* ── reads ── */
      const done = await txn.get(revRef);
      if (done.exists) return { alreadyReversed: true };
      const acc = await txn.get(accRef);
      const nowMs = _clock();
      const period = R.periodFor(nowMs);
      const per = await txn.get(_db().collection(COL.PERIODS).doc(period.periodId));
      if (per.exists && per.data().status !== R.PERIOD_STATUS.OPEN) throw Object.assign(new Error('current period is not open'), { code: 'period_closed' });
      if (!acc.exists) {
        /* Nothing was recognised (withheld or not yet run). Tombstone the
           accrual so a later retry cannot recognise a refunded sale. */
        txn.create(accRef, { paymentRef: ref, status: 'VOID_REFUNDED', grossCents, refundedCents: refundCents, createdAt: FieldValue.serverTimestamp() });
        txn.create(revRef, { refundId: rid, paymentRef: ref, refundCents, lines: 0, note: 'no accrual existed', createdAt: FieldValue.serverTimestamp() });
        return { voided: true };
      }
      const a = acc.data();
      if (a.status === 'VOID_REFUNDED') throw Object.assign(new Error('already voided'), { code: 'already_void' });
      const earnQ = await txn.get(_db().collection(COL.LEDGER).where('accrualId', '==', accRef.id).where('kind', '==', R.ENTRY_KIND.EARN));
      const prior = a.reversedByEntry || {};
      const lines = earnQ.docs
        .filter((d) => d.data().bucket !== R.BUCKET.PROVIDER_FEE)       /* the provider fee is sunk, not returned */
        .map((d) => ({ entryId: d.id, amountCents: d.data().amountCents, alreadyReversedCents: Number(prior[d.id] || 0), row: d.data() }));
      const plan = R.planReversal({ grossCents: a.grossCents, lines, refundedBeforeCents: Number(a.refundedCents || 0), refundCents });

      /* ── writes ── */
      const L = _db().collection(COL.LEDGER);
      const nextPrior = { ...prior };
      for (const r of plan.reversals) {
        const row = lines.find((l) => l.entryId === r.entryId).row;
        const entryId = R.reversalEntryId(rid, r.entryId);
        txn.create(L.doc(entryId), {
          entryId, kind: R.ENTRY_KIND.REVERSAL, bucket: row.bucket, reversesEntryId: r.entryId, refundId: rid,
          paymentRef: ref, accrualId: accRef.id, filmId: row.filmId, creatorUid: row.creatorUid, agreementVersion: row.agreementVersion,
          participantId: row.participantId || null, participantType: row.participantType || null, uid: row.uid || null,
          amountCents: r.reverseCents, currency: row.currency, periodId: period.periodId, status: 'RECOGNISED',
          createdAt: FieldValue.serverTimestamp(),
        });
        nextPrior[r.entryId] = Number(prior[r.entryId] || 0) + r.reverseCents;
      }
      txn.update(accRef, {
        refundedCents: plan.cumulativeRefundCents, reversedByEntry: nextPrior,
        status: plan.fullyRefunded ? 'REVERSED' : 'PARTIALLY_REVERSED', updatedAt: FieldValue.serverTimestamp(),
      });
      txn.create(revRef, { refundId: rid, paymentRef: ref, refundCents, lines: plan.reversals.length, periodId: period.periodId,
        sunkProviderFeeCents: plan.fullyRefunded ? Number((a.deductions || {}).providerFeeCents || 0) : null, source,
        createdAt: FieldValue.serverTimestamp() });
      return { reversed: plan.reversals.length, fullyRefunded: plan.fullyRefunded };
    });

    /* §29: a full refund removes access. A partial refund is a price
       adjustment and keeps it (policy recorded in docs/CREATOR_HUB.md). */
    if (result.fullyRefunded || result.voided || refundCents >= grossCents) {
      const engine = require('./entitlement-engine');
      require('./entitlement-adapters');
      await engine.revoke(ref, `refund ${rid}`, { source });
    }
    return result;
  } catch (e) {
    logger.error('[creator] refund reversal failed', { payRef: ref, refundId, err: e.message });
    await _exception(ref, 'refund_reversal_failed', `${refundId}: ${e.code || ''} ${e.message}`);
    return { failed: true, code: e.code || 'unknown' };
  }
}

/* ═══ PLAYBACK ═══════════════════════════════════════════════════════════ */

function _clientNet(req) {
  const raw = req.rawRequest || {};
  const fwd = String((raw.headers && raw.headers['x-forwarded-for']) || raw.ip || '').split(',')[0].trim();
  const v4 = fwd.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return _hash(v4 ? v4[1] : fwd.split(':').slice(0, 4).join(':'));   /* /24 or /64 — coarse, not a person */
}

async function playbackAuthorize(req) {
  const uid = _uid(req);
  const d = req.data || {};
  const filmId = _id(d.filmId, 'filmId');
  const deviceHash = _hash('dev:' + String(d.deviceId || 'unknown').slice(0, 64));
  const netHash = _clientNet(req);
  const nowMs = _clock();
  const requestedSession = d.sessionId ? _id(d.sessionId, 'sessionId') : null;

  const filmRef = _db().collection(COL.FILMS).doc(filmId);
  const accessRef = _db().collection(COL.ACCESS).doc(`${uid}_${filmId}`);
  const rateRef = _db().collection(COL.RATE).doc(uid);

  const decision = await _db().runTransaction(async (txn) => {
    /* ── reads ── */
    const [fSnap, aSnap, rSnap] = [await txn.get(filmRef), await txn.get(accessRef), await txn.get(rateRef)];
    const sessQ = await txn.get(_db().collection(COL.SESSIONS).where('uid', '==', uid).where('ended', '==', false).limit(20));
    const film = fSnap.exists && fSnap.data().creatorHub === true ? { id: filmId, ...fSnap.data() } : null;
    let entitlement = null;
    if (aSnap.exists) {
      const eSnap = await txn.get(_db().collection(COL.ENTITLEMENTS).doc(aSnap.data().paymentRef));
      /* Entitlement truth comes from the per-purchase record, not the pointer. */
      if (eSnap.exists) {
        const e = eSnap.data();
        entitlement = { ownerUid: e.buyerUid, resourceId: e.contentId, status: e.status, expiresAtMs: e.expiresAtMs, id: eSnap.id };
      }
    }
    const rate = rSnap.exists ? rSnap.data() : { windowStartMs: nowMs, count: 0 };
    const inWindow = nowMs - Number(rate.windowStartMs || 0) < 3600000;
    const countLastHour = inWindow ? Number(rate.count || 0) : 0;
    const sessions = sessQ.docs.map((s) => ({ sessionId: s.id, lastSeenMs: s.data().lastSeenMs, ended: s.data().ended, deviceHash: s.data().deviceHash, netHash: s.data().netHash, filmId: s.data().filmId }));
    const dec = P.decidePlayback({ entitlement, film, viewerUid: uid, nowMs, activeSessions: sessions, authorizationsLastHour: countLastHour, sessionId: requestedSession });

    /* ── writes ── */
    const viewerMarkRef = _db().collection(COL.VIEWERS).doc(`${filmId}_${uid}`);
    const viewerMark = dec.allow && !requestedSession ? await txn.get(viewerMarkRef) : null;
    txn.set(rateRef, { windowStartMs: inWindow ? rate.windowStartMs : nowMs, count: countLastHour + 1, updatedAtMs: nowMs });
    if (!dec.allow) return { ...dec };
    let sessionId = requestedSession;
    const existing = requestedSession && sessions.find((s) => s.sessionId === requestedSession && s.filmId === filmId);
    if (!existing) {
      sessionId = crypto.randomBytes(12).toString('hex');
    }
    const seed = existing ? null : crypto.randomBytes(16).toString('hex');
    const sRef = _db().collection(COL.SESSIONS).doc(sessionId);
    if (existing) {
      txn.update(sRef, { lastSeenMs: nowMs, grants: FieldValue.increment(1), netHash });
    } else {
      txn.create(sRef, { uid, filmId, entitlementId: entitlement.id, deviceHash, netHash, seed, createdAtMs: nowMs,
        lastSeenMs: nowMs, ended: false, grants: 1, sessionCode: W.sessionCode(seed), watchedSec: 0, maxPositionSec: 0, completed: false });
      const first = viewerMark && !viewerMark.exists;
      if (first) txn.create(viewerMarkRef, { filmId, firstViewAtMs: nowMs });   /* marker holds NO viewer data beyond its id */
      txn.set(_db().collection(COL.STATS).doc(filmId), { filmId, views: FieldValue.increment(1), ...(first ? { uniqueViewers: FieldValue.increment(1) } : {}) }, { merge: true });
    }
    const risk = P.assessSessionRisk({ devices24h: sessions.map((s) => s.deviceHash).concat(deviceHash), networks1h: sessions.map((s) => s.netHash).concat(netHash) });
    return { ...dec, sessionId, isNew: !existing, entitlementId: entitlement.id, expiresAtMs: entitlement.expiresAtMs, risk };
  });

  _db().collection(COL.AUDIT).add({ uid, filmId, event: decision.allow ? 'authorize' : 'deny', reason: decision.reason,
    sessionId: decision.sessionId || null, deviceHash, netHash, risk: decision.risk || null, atMs: nowMs,
    at: FieldValue.serverTimestamp() }).catch(() => {});
  if (!decision.allow) fail('permission-denied', `Playback not authorised (${decision.reason}).`);

  /* Signed URL: short-lived, per-grant, never stored, never in HTML. */
  const mSnap = await _db().collection(COL.MEDIA).doc(filmId).get();
  if (!mSnap.exists) fail('failed-precondition', 'Film media is not available.');
  const expiresAtMs = nowMs + P.PLAYBACK.GRANT_TTL_MS;
  const [url] = await _bucket().file(mSnap.data().storagePath).getSignedUrl({
    version: 'v4', action: 'read', expires: expiresAtMs, responseDisposition: 'inline',
  });

  const sSnap = await _db().collection(COL.SESSIONS).doc(decision.sessionId).get();
  const [uRec, uDoc] = await Promise.all([
    require('firebase-admin/auth').getAuth().getUser(uid).catch(() => null),
    _db().collection('users').doc(uid).get(),
  ]);
  const watermark = W.buildPayload({
    displayName: (uDoc.exists && (uDoc.data().displayName || uDoc.data().name)) || (uRec && uRec.displayName) || null,
    email: uRec && uRec.email, phone: uRec && uRec.phoneNumber,
    entitlementId: decision.entitlementId, sessionSeed: sSnap.data().seed, issuedAtMs: sSnap.data().createdAtMs,
  });
  return {
    url, urlExpiresAtMs: expiresAtMs, sessionId: decision.sessionId, watermark,
    entitlementExpiresAtMs: decision.expiresAtMs || null, heartbeatMs: 30000,
    flagged: !!(decision.risk && decision.risk.suspicious),
  };
}

/* ═══ PREVIEW PLAYBACK ═══════════════════════════════════════════════════
   PREVIEW and ENTITLED are different grants. playback.preview never signs the
   master; playback.authorize never runs without an entitlement. The preview
   ledger (creatorPreviewGrants/{uid}_{filmId}) is written in the same
   transaction that decides, so two tabs or a reload cannot restart the
   allowance. P.decidePreview holds the rules. */
async function playbackPreview(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const nowMs = _clock();
  const filmRef = _db().collection(COL.FILMS).doc(filmId);
  const accessRef = _db().collection(COL.ACCESS).doc(`${uid}_${filmId}`);
  const grantRef = _db().collection(COL.PREVIEW_GRANTS).doc(`${uid}_${filmId}`);
  const mediaRef = _db().collection(COL.MEDIA).doc(filmId);
  const d = await _db().runTransaction(async (txn) => {
    const [fSnap, aSnap, gSnap, mSnap] = [await txn.get(filmRef), await txn.get(accessRef), await txn.get(grantRef), await txn.get(mediaRef)];
    const film = fSnap.exists && fSnap.data().creatorHub === true ? { id: filmId, ...fSnap.data() } : null;
    let entitled = false;
    if (aSnap.exists) {
      const eSnap = await txn.get(_db().collection(COL.ENTITLEMENTS).doc(aSnap.data().paymentRef));
      const e = eSnap.exists ? eSnap.data() : null;
      entitled = !!(e && e.buyerUid === uid && e.contentId === filmId && e.status === 'ACTIVE' && (e.expiresAtMs == null || nowMs < e.expiresAtMs));
    }
    const grant = gSnap.exists ? gSnap.data() : null;
    const dec = P.decidePreview({ film, viewerUid: uid, entitled, grant, nowMs });
    if (!dec.allow) return dec;
    const media = mSnap.exists ? mSnap.data() : {};
    if (!media.previewStoragePath) return { allow: false, reason: 'preview_unavailable' };
    txn.set(grantRef, { uid, filmId, limitSec: dec.limitSec, firstGrantAtMs: dec.firstGrantAtMs, consumedSec: dec.consumedSec,
      grants: FieldValue.increment(1), exhausted: false, lastGrantAtMs: nowMs }, { merge: true });
    return { ...dec, path: media.previewStoragePath, first: !grant };
  });
  _db().collection(COL.AUDIT).add({ uid, filmId, event: d.allow ? 'preview' : 'preview_deny', reason: d.reason, atMs: nowMs,
    at: FieldValue.serverTimestamp() }).catch(() => {});
  if (!d.allow) {
    if (d.reason === 'entitled') return { mode: 'ENTITLED' };
    fail('permission-denied', `Preview not available (${d.reason}).`);
  }
  if (d.first) _statShard(filmId, uid).set({ previewStarts: FieldValue.increment(1) }, { merge: true }).catch(() => {});
  const expiresAtMs = Math.min(d.windowEndsAtMs, nowMs + d.remainingSec * 1000 + P.PREVIEW.URL_SLACK_MS);
  const [url] = await _bucket().file(d.path).getSignedUrl({ version: 'v4', action: 'read', expires: expiresAtMs, responseDisposition: 'inline' });
  return { mode: 'PREVIEW', url, urlExpiresAtMs: expiresAtMs, limitSec: d.limitSec, resumeAtSec: d.consumedSec,
    remainingSec: d.remainingSec, windowEndsAtMs: d.windowEndsAtMs };
}

/* The viewer's position, folded into the ledger (monotonic, clamped). Reaching
   the limit exhausts the preview: a later playback.preview is refused. */
async function playbackPreviewProgress(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const grantRef = _db().collection(COL.PREVIEW_GRANTS).doc(`${uid}_${filmId}`);
  return _db().runTransaction(async (txn) => {
    const g = await txn.get(grantRef);
    if (!g.exists) fail('failed-precondition', 'No preview in progress.');
    const cur = g.data();
    const next = P.recordPreviewProgress(cur, cur.limitSec, (req.data || {}).positionSec);
    txn.update(grantRef, { consumedSec: next.consumedSec, exhausted: cur.exhausted === true || next.exhausted, lastSeenMs: _clock() });
    return { consumedSec: next.consumedSec, exhausted: cur.exhausted === true || next.exhausted, limitSec: cur.limitSec };
  });
}

async function playbackHeartbeat(req) {
  const uid = _uid(req);
  const sessionId = _id((req.data || {}).sessionId, 'sessionId');
  const sRef = _db().collection(COL.SESSIONS).doc(sessionId);
  const s = await sRef.get();
  if (!s.exists || s.data().uid !== uid) fail('permission-denied', 'Unknown session.');
  if (s.data().ended) return { ok: false, ended: true };
  const e = await _db().collection(COL.ENTITLEMENTS).doc(s.data().entitlementId).get();
  const nowMs = _clock();
  const ent = e.exists ? e.data() : null;
  const live = ent && ent.status === 'ACTIVE' && (ent.expiresAtMs == null || nowMs < ent.expiresAtMs);
  if (!live) {
    await sRef.update({ ended: true, endedReason: 'entitlement_' + (ent ? String(ent.status).toLowerCase() : 'missing'), lastSeenMs: nowMs });
    return { ok: false, revoked: true };
  }
  /* Progress + analytics. Watch time credits at most the real time elapsed since
     the last beat (capped at 2 beats), so a client cannot inflate it; position is
     clamped to the reported duration and to the film's runtime. */
  const d = req.data || {};
  const sd = s.data();
  const dur = Number.isFinite(Number(d.durationSec)) ? Math.max(0, Math.min(86400, Math.round(Number(d.durationSec)))) : null;
  const pos = Number.isFinite(Number(d.positionSec)) ? Math.max(0, Math.min(dur || 86400, Math.round(Number(d.positionSec)))) : null;
  const playing = d.playing === true;
  const elapsedSec = Math.max(0, Math.min(60, Math.round((nowMs - Number(sd.lastSeenMs || nowMs)) / 1000)));
  const credited = playing ? elapsedSec : 0;
  const completedNow = !sd.completed && pos != null && dur && pos >= dur * 0.9;
  const patch = { lastSeenMs: nowMs };
  if (pos != null) patch.maxPositionSec = Math.max(Number(sd.maxPositionSec || 0), pos);
  if (credited) patch.watchedSec = FieldValue.increment(credited);
  if (completedNow) patch.completed = true;
  await sRef.update(patch);
  if (pos != null) {
    await _db().collection(COL.PROGRESS).doc(`${uid}_${sd.filmId}`).set({ uid, filmId: sd.filmId, positionSec: pos, durationSec: dur,
      completed: !!(sd.completed || completedNow), updatedAtMs: nowMs }, { merge: true }).catch(() => {});
  }
  if (credited || completedNow) {
    await _statShard(sd.filmId, sessionId).set({
      ...(credited ? { watchSeconds: FieldValue.increment(credited) } : {}),
      ...(completedNow ? { completedViews: FieldValue.increment(1) } : {}) }, { merge: true }).catch(() => {});
  }
  return { ok: true };
}

async function playbackEnd(req) {
  const uid = _uid(req);
  const sessionId = _id((req.data || {}).sessionId, 'sessionId');
  const sRef = _db().collection(COL.SESSIONS).doc(sessionId);
  const s = await sRef.get();
  if (!s.exists || s.data().uid !== uid) return { ok: true };
  await sRef.update({ ended: true, endedReason: 'viewer', lastSeenMs: _clock() });
  return { ok: true };
}

const REPORTABLE = ['overlay_removed', 'overlay_hidden', 'devtools_open', 'visibility_hidden', 'pip_attempt', 'capture_api'];
async function playbackReport(req) {
  const uid = _uid(req);
  const d = req.data || {};
  const sessionId = _id(d.sessionId, 'sessionId');
  const event = String(d.event || '');
  if (!REPORTABLE.includes(event)) fail('invalid-argument', 'Unknown event.');
  const s = await _db().collection(COL.SESSIONS).doc(sessionId).get();
  if (!s.exists || s.data().uid !== uid) fail('permission-denied', 'Unknown session.');
  await _db().collection(COL.AUDIT).add({ uid, filmId: s.data().filmId, sessionId, event: 'client_' + event,
    atMs: _clock(), at: FieldValue.serverTimestamp() });
  return { ok: true };
}

/* ═══ ROYALTY DASHBOARDS ═════════════════════════════════════════════════ */

async function _periodStatuses(ids) {
  const out = {};
  const uniq = [...new Set(ids)].slice(0, 40);
  const snaps = await Promise.all(uniq.map((id) => _db().collection(COL.PERIODS).doc(id).get()));
  snaps.forEach((s, i) => { out[uniq[i]] = s.exists ? s.data().status : R.PERIOD_STATUS.OPEN; });
  return out;
}

async function royaltyMine(req) {
  const uid = _uid(req);
  const [parts, entries, stmts, wal, pays] = await Promise.all([
    _db().collection(COL.PARTICIPATIONS).where('uid', '==', uid).limit(200).get(),
    _db().collection(COL.LEDGER).where('uid', '==', uid).where('bucket', '==', R.BUCKET.PARTICIPANT_ROYALTY).orderBy('createdAt', 'desc').limit(1000).get(),
    _db().collection(COL.STATEMENTS).where('uid', '==', uid).orderBy('periodId', 'desc').limit(40).get(),
    _db().collection(COL.WALLETS).doc(uid).get(),
    _db().collection('payoutRequests').where('sellerUid', '==', uid).limit(100).get(),
  ]);
  const rows = entries.docs.map((d) => d.data());
  /* Available / Withdrawn come from the ONE canonical wallet and payout rail.
     Released royalties join wallets.balance (no parallel royalty wallet), so
     these are WALLET figures — they include any other SOKONI earnings, and the
     page says so. Unknown → null (rendered "—"). */
  const w = wal.exists ? wal.data() : null;
  const PAID = ['paid', 'settled_manually'];
  /* In flight: reserved and not yet confirmed either way. Ambiguous outcomes are
     counted SEPARATELY — they are neither withdrawn nor available. Failed,
     rejected and reversed payouts returned their funds and count as nothing. */
  const IN_FLIGHT = ['pending', 'scheduled', 'approving', 'approved', 'processing', 'approval_failed'];
  const UNKNOWN = ['outcome_unknown', 'retry_scheduled'];
  const payouts = pays.docs.map((d) => ({ id: d.id, ...d.data() }));
  const sumOf = (sts) => payouts.filter((p) => sts.includes(p.status)).reduce((a, p) => a + Number(p.amount || 0), 0);
  const wallet = {
    availableForWithdrawalKes: w && Number.isFinite(Number(w.balance)) ? Number(w.balance) : (w ? null : 0),
    reservedForPayoutKes: w && Number.isFinite(Number(w.pendingPayout)) ? Number(w.pendingPayout) : 0,
    withdrawnKes: sumOf(PAID),
    pendingWithdrawalKes: sumOf(IN_FLIGHT),
    beingConfirmedKes: sumOf(UNKNOWN),
    history: payouts.sort((a, b) => (_ms(b.createdAt) || 0) - (_ms(a.createdAt) || 0)).slice(0, 20)
      .map((p) => ({ id: p.id, amountKes: p.amount, status: p.status, method: p.method, createdAtMs: _ms(p.createdAt) })),
  };
  const statuses = await _periodStatuses(rows.map((r) => r.periodId));
  const statements = stmts.docs.map((d) => d.data());
  const summary = R.summarizeParticipant({ entries: rows, periodStatusById: statuses, statements });
  const cur = R.periodFor(_clock());
  /* Dashboard figures — each from ONE authority, defined in words below. */
  const totalEarnedCents = rows.reduce((a, e) => a + (e.kind === R.ENTRY_KIND.REVERSAL ? -Math.abs(e.amountCents) : e.amountCents), 0);
  const figures = {
    totalEarnedCents: rows.length === 1000 ? null : totalEarnedCents,           /* unknown when the ledger read was truncated */
    pendingCents: summary.accruedCents + summary.pendingSettlementCents,
    releasedCents: summary.releasedCents,
    availableForWithdrawalKes: wallet.availableForWithdrawalKes,
    withdrawnKes: wallet.withdrawnKes,
    pendingWithdrawalKes: wallet.pendingWithdrawalKes,
    beingConfirmedKes: wallet.beingConfirmedKes,
    definitions: {
      totalEarned: 'All royalties credited to you in the royalty ledger, minus refund reversals — every quarter, settled or not.',
      pending: 'Earned but not yet released: the open quarter plus quarters being calculated or approved. Not withdrawable.',
      released: 'Royalties a closed quarter released into your SOKONI wallet.',
      available: 'Your SOKONI wallet balance — released royalties plus any other SOKONI earnings — that you can withdraw now.',
      withdrawn: 'Payouts the provider confirmed, or an admin settled with evidence. Failed, rejected and unconfirmed payouts are not counted.',
      pendingWithdrawal: 'Payouts requested and reserved from your wallet, not yet confirmed.',
      beingConfirmed: 'Payouts whose provider outcome is unknown. Held — neither withdrawn nor available — until confirmed.',
    },
  };
  return {
    participations: parts.docs.map((d) => d.data()),
    summary, figures, currency: 'KES',
    /* Released royalties sit in the ONE canonical wallet; withdrawal and its
       history are the wallet's (requestSellerPayout), not a second balance. */
    withdrawal: { via: 'wallet', page: '/wallet.html', note: 'Released royalties are in your SOKONI wallet balance.' },
    wallet,
    nextSettlement: { periodId: cur.periodId, periodEndsAtMs: cur.endMs },
    statements: statements.map((s) => ({ periodId: s.periodId, earnedCents: s.earnedCents, reversedCents: s.reversedCents,
      netCents: s.netCents, carryInCents: s.carryInCents, releaseKes: s.releaseKes, carryOutCents: s.carryOutCents,
      released: !!s.released, held: !!s.held, films: s.films || [] })),
    ledgerTruncated: rows.length === 1000,
  };
}

async function royaltyFilm(req) {
  const uid = _uid(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const { film } = await _loadOwnFilm(null, uid, filmId, { allowAdmin: true, isAdmin: AC.isAdmin(req) });
  const [versions, accs, entries] = await Promise.all([
    _versions(filmId),
    _db().collection(COL.ACCRUALS).where('filmId', '==', filmId).limit(5000).get(),
    _db().collection(COL.LEDGER).where('filmId', '==', filmId).where('bucket', '==', R.BUCKET.PARTICIPANT_ROYALTY).limit(10000).get(),
  ]);
  const t = { grossCents: 0, providerFeeCents: 0, commissionCents: 0, poolCents: 0, refundedCents: 0, sales: 0 };
  for (const d of accs.docs) {
    const a = d.data(); if (a.status === 'VOID_REFUNDED') continue;
    t.sales++; t.grossCents += a.grossCents; t.poolCents += a.poolCents; t.refundedCents += Number(a.refundedCents || 0);
    t.providerFeeCents += a.deductions.providerFeeCents; t.commissionCents += a.deductions.commissionCents;
  }
  const rows = entries.docs.map((d) => d.data());
  const statuses = await _periodStatuses(rows.map((r) => r.periodId));
  const byP = {};
  for (const r of rows) {
    const k = `${r.agreementVersion}:${r.participantId}`;
    byP[k] = byP[k] || { version: r.agreementVersion, participantId: r.participantId, participantType: r.participantType, uid: r.uid, bps: r.bps, entries: [] };
    byP[k].entries.push(r);
  }
  const participants = Object.values(byP).map((p) => {
    const s = R.summarizeParticipant({ entries: p.entries, periodStatusById: statuses, statements: [] });
    return { version: p.version, participantId: p.participantId, participantType: p.participantType, bps: p.bps,
      accruedCents: s.accruedCents, pendingSettlementCents: s.pendingSettlementCents, reversedCents: s.reversedCents,
      settledCents: p.entries.filter((e) => [R.PERIOD_STATUS.PAYABLE, R.PERIOD_STATUS.CLOSED].includes(statuses[e.periodId]))
        .reduce((x, e) => x + (e.kind === R.ENTRY_KIND.REVERSAL ? -e.amountCents : e.amountCents), 0) };
  });
  return {
    film: _ownerFilm(filmId, film), totals: t, currency: 'KES',
    agreements: versions.map(({ _ref, ...v }) => v).sort((a, b) => b.version - a.version),
    participants, nextSettlement: (() => { const c = R.periodFor(_clock()); return { periodId: c.periodId, periodEndsAtMs: c.endMs }; })(),
    truncated: accs.size === 5000 || entries.size === 10000,
  };
}

/* ═══ ADMIN (merged into adminOsDispatch) ════════════════════════════════ */

const _adminH = {};

_adminH.creatorAdminList = async (req) => {
  _admin(req);
  const st = (req.data || {}).state;
  let q = _db().collection(COL.CREATORS);
  if (st) { if (!P.CREATOR_STATE[st]) fail('invalid-argument', 'Unknown state.'); q = q.where('state', '==', st); }
  const snap = await q.limit(200).get();
  return { creators: snap.docs.map((d) => ({ ..._publicCreator(d.id, d.data(), { withContact: true }), createdAt: _ms(d.data().createdAt), reviewNote: d.data().reviewNote || null })) };
};

_adminH.creatorAdminSetState = async (req) => {
  const actor = _admin(req);
  const d = req.data || {};
  const uid = _id(d.uid, 'uid');
  const to = String(d.to || '');
  if (uid === actor) fail('permission-denied', 'You cannot change the state of your own creator account.');
  const reason = String(d.reason || '').slice(0, 500);
  if ([P.CREATOR_STATE.SUSPENDED, P.CREATOR_STATE.REJECTED].includes(to) && reason.trim().length < 5) fail('invalid-argument', 'A reason is required.');
  const ref = _db().collection(COL.CREATORS).doc(uid);
  const out = await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) fail('not-found', 'Creator not found.');
    _rule(() => P.assertCreatorTransition(s.data().state, to));
    txn.update(ref, { state: to, reviewNote: reason || null, reviewedBy: actor, reviewedAt: FieldValue.serverTimestamp(),
      /* verification ('VERIFIED') is a projection of creatorVerifications — only a
         verification decision writes it, never an account-state change. */
      updatedAt: FieldValue.serverTimestamp() });
    return { from: s.data().state, to };
  });
  await _adminAudit('creator_state', actor, { uid, ...out, reason });
  return out;
};

_adminH.creatorAdminFilms = async (req) => {
  _admin(req);
  const st = (req.data || {}).pubState;
  let q = _db().collection(COL.FILMS).where('creatorHub', '==', true);
  if (st) { if (!P.FILM_STATE[st]) fail('invalid-argument', 'Unknown state.'); q = q.where('pubState', '==', st); }
  const snap = await q.limit(200).get();
  return { films: snap.docs.map((d) => _ownerFilm(d.id, d.data())) };
};

_adminH.creatorAdminFilmDetail = async (req) => {
  _admin(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const [f, m, versions, accs, ex] = await Promise.all([
    _db().collection(COL.FILMS).doc(filmId).get(),
    _db().collection(COL.MEDIA).doc(filmId).get(),
    _versions(filmId),
    _db().collection(COL.ACCRUALS).where('filmId', '==', filmId).limit(200).get(),
    _db().collection(COL.EXCEPTIONS).where('status', '==', 'OPEN').limit(200).get(),
  ]);
  if (!f.exists || f.data().creatorHub !== true) fail('not-found', 'Film not found.');
  return {
    film: _ownerFilm(filmId, f.data()),
    /* Location metadata only — never a URL. */
    media: m.exists ? { contentType: m.data().contentType, sizeBytes: m.data().sizeBytes, verifiedAt: _ms(m.data().verifiedAt) } : null,
    agreements: versions.map(({ _ref, ...v }) => v).sort((a, b) => b.version - a.version),
    accruals: accs.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: _ms(d.data().createdAt) })),
    openExceptions: ex.docs.map((d) => d.data()).filter((x) => accs.docs.some((a) => a.data().paymentRef === x.paymentRef)),
  };
};

_adminH.creatorAdminFilmTransition = async (req) => {
  const actor = _admin(req);
  const d = req.data || {};
  const filmId = _id(d.filmId, 'filmId');
  const to = String(d.to || '');
  const note = String(d.note || '').slice(0, 1000);
  if ([P.FILM_STATE.REJECTED, P.FILM_STATE.SUSPENDED].includes(to) && note.trim().length < 5) fail('invalid-argument', 'A note is required.');
  const ref = _db().collection(COL.FILMS).doc(filmId);
  const out = await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists || s.data().creatorHub !== true) fail('not-found', 'Film not found.');
    const film = s.data();
    const versions = await _versions(filmId, txn);
    const cSnap = await txn.get(_db().collection(COL.CREATORS).doc(film.creatorUid));
    _rule(() => P.assertFilmTransition('admin', film.pubState, to));
    let locked = null;
    if (to === P.FILM_STATE.APPROVED || to === P.FILM_STATE.PUBLISHED) {
      if (!cSnap.exists || cSnap.data().state !== P.CREATOR_STATE.ACTIVE) fail('failed-precondition', 'Approve the creator first.');
      if (!film.mediaReady) fail('failed-precondition', 'Film media is not verified.');
    }
    if (to === P.FILM_STATE.APPROVED && !versions.some((v) => v.status === R.AGREEMENT_STATUS.LOCKED)) {
      /* Approval locks v1 (the rights split the reviewer just approved). */
      const draft = versions.find((v) => v.status === R.AGREEMENT_STATUS.DRAFT);
      if (!draft) fail('failed-precondition', 'No royalty agreement to lock.');
      locked = _lockInTxn(txn, filmId, film, versions, draft.version, actor).lock.version;
    }
    if (to === P.FILM_STATE.PUBLISHED && !versions.some((v) => v.status === R.AGREEMENT_STATUS.LOCKED)) fail('failed-precondition', 'Royalty agreement is not locked.');
    const status = to === P.FILM_STATE.PUBLISHED ? 'active' : (to === P.FILM_STATE.SUSPENDED ? 'suspended' : 'draft');
    txn.update(ref, { pubState: to, status, reviewNote: note || null, reviewedBy: actor, reviewedAt: FieldValue.serverTimestamp(),
      ...(to === P.FILM_STATE.PUBLISHED ? { publishedAt: FieldValue.serverTimestamp() } : {}), updatedAt: FieldValue.serverTimestamp() });
    return { from: film.pubState, to, lockedVersion: locked };
  });
  await _adminAudit('film_transition', actor, { filmId, ...out, note });
  return out;
};

_adminH.creatorAdminLockAgreement = async (req) => {
  const actor = _admin(req);
  const filmId = _id((req.data || {}).filmId, 'filmId');
  const version = Number((req.data || {}).version);
  if (!Number.isSafeInteger(version) || version < 1) fail('invalid-argument', 'version is invalid.');
  const out = await _db().runTransaction(async (txn) => {
    const s = await txn.get(_db().collection(COL.FILMS).doc(filmId));
    if (!s.exists || s.data().creatorHub !== true) fail('not-found', 'Film not found.');
    const versions = await _versions(filmId, txn);
    return _lockInTxn(txn, filmId, s.data(), versions, version, actor);
  });
  await _adminAudit('agreement_lock', actor, { filmId, version, effectiveFrom: out.lock.effectiveFrom, superseded: out.supersede && out.supersede.version });
  return { locked: version, effectiveFrom: out.lock.effectiveFrom, superseded: out.supersede ? out.supersede.version : null };
};

_adminH.creatorAdminLedger = async (req) => {
  _admin(req);
  const d = req.data || {};
  let q = _db().collection(COL.LEDGER);
  if (d.filmId) q = q.where('filmId', '==', _id(d.filmId, 'filmId'));
  if (d.uid) q = q.where('uid', '==', _id(d.uid, 'uid'));
  if (d.periodId) q = q.where('periodId', '==', _rule(() => R.periodBounds(d.periodId).periodId));
  if (d.paymentRef) q = q.where('paymentRef', '==', String(d.paymentRef).slice(0, 120));
  const snap = await q.limit(Math.min(500, Number(d.limit) || 200)).get();
  return { entries: snap.docs.map((x) => ({ ...x.data(), createdAt: _ms(x.data().createdAt) })) };
};

_adminH.creatorAdminPeriods = async (req) => {
  _admin(req);
  const snap = await _db().collection(COL.PERIODS).orderBy('periodId', 'desc').limit(20).get();
  const cur = R.periodFor(_clock());
  return { current: cur, periods: snap.docs.map((d) => ({ ...d.data(), calculatedAt: _ms(d.data().calculatedAt), approvedAt: _ms(d.data().approvedAt), distributedAt: _ms(d.data().distributedAt) })) };
};

/* Calculate: freeze one statement per participant uid from the ledger + the
   previous period's carry. Recalculation overwrites CALCULATED statements
   until approval. */
_adminH.creatorAdminCalculatePeriod = async (req) => {
  const actor = _admin(req);
  const periodId = _rule(() => R.periodBounds((req.data || {}).periodId).periodId);
  const b = R.periodBounds(periodId);
  const nowMs = _clock();
  const pRef = _db().collection(COL.PERIODS).doc(periodId);
  const pSnap = await pRef.get();
  const from = pSnap.exists ? pSnap.data().status : R.PERIOD_STATUS.OPEN;
  _rule(() => R.assertPeriodTransition(from, R.PERIOD_STATUS.CALCULATED, { nowMs, endMs: b.endMs }));

  /* The carry chain needs the previous quarter settled first. */
  const prevId = R.prevPeriodId(periodId);
  const prev = await _db().collection(COL.PERIODS).doc(prevId).get();
  if (!prev.exists || ![R.PERIOD_STATUS.PAYABLE, R.PERIOD_STATUS.CLOSED].includes(prev.data().status)) {
    const prevEntries = await _db().collection(COL.LEDGER).where('periodId', '==', prevId).limit(1).get();
    if (!prevEntries.empty) fail('failed-precondition', `Settle ${prevId} before ${periodId}.`);
  }
  const [entSnap, prevStmts] = await Promise.all([
    _db().collection(COL.LEDGER).where('periodId', '==', periodId).where('bucket', '==', R.BUCKET.PARTICIPANT_ROYALTY).get(),
    _db().collection(COL.STATEMENTS).where('periodId', '==', prevId).get(),
  ]);
  const byUid = {};
  for (const d of entSnap.docs) { const e = d.data(); (byUid[e.uid] = byUid[e.uid] || []).push(e); }
  const carry = {};
  for (const d of prevStmts.docs) { const s = d.data(); if (Number(s.carryOutCents || 0) !== 0) carry[s.uid] = Number(s.carryOutCents); }
  const uids = [...new Set([...Object.keys(byUid), ...Object.keys(carry)])];

  const totals = { participants: 0, earnedCents: 0, reversedCents: 0, releaseKes: 0 };
  const batchSize = 200;
  for (let i = 0; i < uids.length; i += batchSize) {
    const batch = _db().batch();
    for (const uid of uids.slice(i, i + batchSize)) {
      const entries = byUid[uid] || [];
      const st = R.computeStatement(entries, carry[uid] || 0);
      const films = {};
      for (const e of entries) {
        films[e.filmId] = films[e.filmId] || { filmId: e.filmId, earnedCents: 0, reversedCents: 0 };
        if (e.kind === R.ENTRY_KIND.EARN) films[e.filmId].earnedCents += e.amountCents; else films[e.filmId].reversedCents += e.amountCents;
      }
      batch.set(_db().collection(COL.STATEMENTS).doc(R.statementId(periodId, uid)), {
        periodId, uid, ...st, films: Object.values(films), entryCount: entries.length,
        released: false, status: 'CALCULATED', calculatedAt: FieldValue.serverTimestamp(),
      });
      totals.participants++; totals.earnedCents += st.earnedCents; totals.reversedCents += st.reversedCents; totals.releaseKes += st.releaseKes;
    }
    await batch.commit();
  }
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(pRef);
    const cur = s.exists ? s.data().status : R.PERIOD_STATUS.OPEN;
    _rule(() => R.assertPeriodTransition(cur, R.PERIOD_STATUS.CALCULATED, { nowMs, endMs: b.endMs }));
    txn.set(pRef, { periodId, startMs: b.startMs, endMs: b.endMs, status: R.PERIOD_STATUS.CALCULATED,
      calculatedBy: actor, calculatedAt: FieldValue.serverTimestamp(), totals }, { merge: true });
  });
  await _adminAudit('royalty_period_calculate', actor, { periodId, totals });
  return { periodId, status: R.PERIOD_STATUS.CALCULATED, totals };
};

_adminH.creatorAdminApprovePeriod = async (req) => {
  const actor = _admin(req);
  const periodId = _rule(() => R.periodBounds((req.data || {}).periodId).periodId);
  const overrideReason = (req.data || {}).overrideReason || null;
  const pRef = _db().collection(COL.PERIODS).doc(periodId);
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(pRef);
    if (!s.exists) fail('failed-precondition', 'Calculate the period first.');
    _rule(() => R.assertPeriodTransition(s.data().status, R.PERIOD_STATUS.APPROVED, {
      calculatedBy: s.data().calculatedBy, actorUid: actor, superAdmin: AC.isSuperAdmin(req), overrideReason }));
    txn.update(pRef, { status: R.PERIOD_STATUS.APPROVED, approvedBy: actor, approvedAt: FieldValue.serverTimestamp(), approvalOverride: overrideReason });
  });
  await _adminAudit('royalty_period_approve', actor, { periodId, overrideReason });
  return { periodId, status: R.PERIOD_STATUS.APPROVED };
};

/**
 * DISTRIBUTE — release an APPROVED period into the canonical wallet.
 * Per statement, one transaction: create() walletTransactions/{uid}_{period}_royalty
 * (the exactly-once claim, same id convention as every other earnings credit),
 * increment wallets.balance by whole KES, mark the statement released.
 * Resumable: re-running skips released statements; a held participant is skipped.
 */
_adminH.creatorAdminDistribute = async (req) => {
  const actor = _admin(req);
  const periodId = _rule(() => R.periodBounds((req.data || {}).periodId).periodId);
  const pRef = _db().collection(COL.PERIODS).doc(periodId);
  const p = await pRef.get();
  if (!p.exists || ![R.PERIOD_STATUS.APPROVED, R.PERIOD_STATUS.PAYABLE].includes(p.data().status)) fail('failed-precondition', 'Only an APPROVED period can be distributed.');
  /* DUAL CONTROL: calculate → approve → distribute are three people's acts.
     Approve already refuses the calculator; distribute refuses the APPROVER, so
     one admin can never both authorise a quarter and release its money. A Super
     Admin may override only with a written reason, recorded in adminAudit. */
  const approvedBy = p.data().approvedBy || null;
  if (approvedBy && approvedBy === actor) {
    const overrideReason = String((req.data || {}).overrideReason || '').replace(/<[^>]*>/g, '').trim().slice(0, 500);
    if (!(AC.isSuperAdmin(req) && overrideReason.length >= 10)) {
      fail('permission-denied', 'The admin who approved this quarter cannot also release it — a second admin must distribute.');
    }
    await _adminAudit('royalty_distribute_override', actor, { periodId, approvedBy, overrideReason });
  }
  const stmts = await _db().collection(COL.STATEMENTS).where('periodId', '==', periodId).where('released', '==', false).limit(500).get();
  const res = { credited: 0, zero: 0, held: 0, already: 0, failed: 0, kes: 0 };
  for (const d of stmts.docs) {
    const s = d.data();
    try {
      const r = await _db().runTransaction(async (txn) => {
        const cur = await txn.get(d.ref);
        const hold = await txn.get(_db().collection(COL.HOLDS).doc(s.uid));
        const wtxRef = _db().collection(COL.WALLET_TX).doc(R.walletTxId(s.uid, periodId));
        const wtx = await txn.get(wtxRef);
        const c = cur.data();
        if (c.released) return 'already';
        if (hold.exists && hold.data().active === true) { txn.update(d.ref, { held: true, holdReason: hold.data().reason || null }); return 'held'; }
        if (c.releaseKes <= 0) {
          txn.update(d.ref, { released: true, releasedAt: FieldValue.serverTimestamp(), status: 'RELEASED', held: false });
          return 'zero';
        }
        if (wtx.exists) {
          /* Credited by an earlier run whose statement write was lost — reconcile, never re-credit. */
          txn.update(d.ref, { released: true, releasedAt: FieldValue.serverTimestamp(), status: 'RELEASED', walletTxId: wtxRef.id, held: false });
          return 'already';
        }
        txn.create(wtxRef, { uid: s.uid, type: 'royalty_release', amount: c.releaseKes, currency: 'KES', sourceType: 'creator_royalty',
          sourceId: periodId, periodId, statementId: d.id, createdAt: FieldValue.serverTimestamp() });
        txn.set(_db().collection(COL.WALLETS).doc(s.uid), { balance: FieldValue.increment(c.releaseKes), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        txn.update(d.ref, { released: true, releasedAt: FieldValue.serverTimestamp(), status: 'RELEASED', walletTxId: wtxRef.id, held: false, releasedBy: actor });
        return 'credited:' + c.releaseKes;
      });
      if (r.startsWith('credited:')) { res.credited++; res.kes += Number(r.split(':')[1]); } else res[r]++;
    } catch (e) {
      res.failed++;
      logger.error('[creator] distribution failed', { periodId, uid: s.uid, err: e.message });
    }
  }
  const remaining = await _db().collection(COL.STATEMENTS).where('periodId', '==', periodId).where('released', '==', false).limit(1).get();
  await _db().collection(COL.DISTRIBUTIONS).doc(`dist_${periodId}`).set({
    periodId, runs: FieldValue.arrayUnion({ by: actor, atMs: _clock(), ...res }), updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (res.failed === 0 && p.data().status === R.PERIOD_STATUS.APPROVED) {
    await pRef.update({ status: R.PERIOD_STATUS.PAYABLE, distributedBy: actor, distributedAt: FieldValue.serverTimestamp() });
  }
  await _adminAudit('royalty_distribute', actor, { periodId, ...res, unreleasedRemain: !remaining.empty });
  return { periodId, ...res, unreleasedRemain: !remaining.empty, moreToProcess: stmts.size === 500 };
};

_adminH.creatorAdminClosePeriod = async (req) => {
  const actor = _admin(req);
  const periodId = _rule(() => R.periodBounds((req.data || {}).periodId).periodId);
  const open = await _db().collection(COL.STATEMENTS).where('periodId', '==', periodId).where('released', '==', false).limit(1).get();
  if (!open.empty) fail('failed-precondition', 'Unreleased (held) statements remain.');
  const pRef = _db().collection(COL.PERIODS).doc(periodId);
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(pRef);
    if (!s.exists) fail('not-found', 'Unknown period.');
    _rule(() => R.assertPeriodTransition(s.data().status, R.PERIOD_STATUS.CLOSED, {}));
    txn.update(pRef, { status: R.PERIOD_STATUS.CLOSED, closedBy: actor, closedAt: FieldValue.serverTimestamp() });
  });
  await _adminAudit('royalty_period_close', actor, { periodId });
  return { periodId, status: R.PERIOD_STATUS.CLOSED };
};

_adminH.creatorAdminSetPayoutHold = async (req) => {
  const actor = _admin(req);
  const uid = _id((req.data || {}).uid, 'uid');
  const active = (req.data || {}).hold === true;
  const reason = String((req.data || {}).reason || '').slice(0, 500);
  if (active && reason.trim().length < 5) fail('invalid-argument', 'A reason is required.');
  await _db().collection(COL.HOLDS).doc(uid).set({ uid, active, reason: reason || null, by: actor, updatedAt: FieldValue.serverTimestamp() });
  await _adminAudit('royalty_payout_hold', actor, { uid, active, reason });
  return { uid, hold: active };
};

_adminH.creatorAdminStatements = async (req) => {
  _admin(req);
  const periodId = _rule(() => R.periodBounds((req.data || {}).periodId).periodId);
  const snap = await _db().collection(COL.STATEMENTS).where('periodId', '==', periodId).limit(500).get();
  return { statements: snap.docs.map((d) => d.data()) };
};

_adminH.creatorAdminSecurityEvents = async (req) => {
  _admin(req);
  const d = req.data || {};
  let q = _db().collection(COL.AUDIT);
  if (d.filmId) q = q.where('filmId', '==', _id(d.filmId, 'filmId'));
  if (d.uid) q = q.where('uid', '==', _id(d.uid, 'uid'));
  const snap = await q.orderBy('atMs', 'desc').limit(200).get();
  return { events: snap.docs.map((x) => x.data()) };
};

_adminH.creatorAdminExceptions = async (req) => {
  _admin(req);
  const snap = await _db().collection(COL.EXCEPTIONS).where('status', '==', 'OPEN').limit(200).get();
  return { exceptions: snap.docs.map((d) => ({ id: d.id, ...d.data(), updatedAt: _ms(d.data().updatedAt) })) };
};

_adminH.creatorAdminRetryAccrual = async (req) => {
  const actor = _admin(req);
  const ref = String((req.data || {}).paymentRef || '');
  _rule(() => R.accrualId(ref));
  const r = await accrueRoyalty(ref, { source: 'admin-retry:' + actor });
  if (r.accrued || r.alreadyAccrued) {
    for (const k of ['fee_unreported', 'accrual_failed', 'pool_invalid', 'currency_mismatch']) {
      await _db().collection(COL.EXCEPTIONS).doc(`${k}_${ref}`).set({ status: 'RESOLVED', resolvedBy: actor, resolvedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    }
  }
  await _adminAudit('royalty_retry_accrual', actor, { paymentRef: ref, result: r });
  return r;
};

/* Record the IntaSend-reported fee for a payment whose callback did not carry
   it (fee_unreported). Admin-attested, audited, and only while unaccrued. */
_adminH.creatorAdminAttestFee = async (req) => {
  const actor = _superAdmin(req);
  const d = req.data || {};
  const ref = String(d.paymentRef || '');
  _rule(() => R.accrualId(ref));
  const feeKes = Number(d.feeKes);
  if (!(Number.isFinite(feeKes) && feeKes >= 0 && Math.round(feeKes * 100) === feeKes * 100)) fail('invalid-argument', 'feeKes must be a non-negative amount with at most 2 decimals.');
  const evidence = String(d.evidence || '').slice(0, 300);
  if (evidence.trim().length < 5) fail('invalid-argument', 'Evidence (IntaSend dashboard reference) is required.');
  await _db().runTransaction(async (txn) => {
    const acc = await txn.get(_db().collection(COL.ACCRUALS).doc(R.accrualId(ref)));
    const pay = await txn.get(_db().collection('payments').doc(ref));
    if (acc.exists) fail('failed-precondition', 'Already accrued; fees are immutable after recognition.');
    if (!pay.exists) fail('not-found', 'Payment not found.');
    txn.update(pay.ref, { 'providerReport.charges': feeKes, 'providerReport.attestedBy': actor, 'providerReport.evidence': evidence });
  });
  await _adminAudit('royalty_attest_fee', actor, { paymentRef: ref, feeKes, evidence });
  return accrueRoyalty(ref, { source: 'admin-attest:' + actor });
};

_adminH.creatorAdminRevokeEntitlement = async (req) => {
  const actor = _admin(req);
  const ref = String((req.data || {}).paymentRef || '');
  const reason = String((req.data || {}).reason || '').slice(0, 300);
  if (reason.trim().length < 5) fail('invalid-argument', 'A reason is required.');
  const i = await _db().collection('paymentIntents').doc(ref).get();
  if (!i.exists || i.data().purpose !== PURPOSE) fail('not-found', 'Not a film purchase.');
  const engine = require('./entitlement-engine');
  require('./entitlement-adapters');
  const r = await engine.revoke(ref, 'admin: ' + reason, { source: 'admin:' + actor });
  await _adminAudit('film_entitlement_revoke', actor, { paymentRef: ref, reason, result: r });
  return r;
};

_adminH.creatorAdminConfig = async (req) => {
  const d = req.data || {};
  const ref = _db().collection(COL.CONFIG).doc('creatorHub');
  if (d.set) {
    const actor = _superAdmin(req);
    const patch = {};
    if (typeof d.set.purchasesEnabled === 'boolean') patch.purchasesEnabled = d.set.purchasesEnabled;
    if (typeof d.set.guestCheckoutEnabled === 'boolean') patch.guestCheckoutEnabled = d.set.guestCheckoutEnabled;
    if (typeof d.set.hostedCheckout === 'boolean') {
      if (d.set.hostedCheckout) {
        const cap = await _db().collection(COL.CONFIG).doc(PCAP.RECORD).get();
        if (!PCAP.provenHostedMethods(cap.exists ? cap.data() : null).length) {
          fail('failed-precondition', 'No IntaSend method is recorded LIVE_AND_PROVEN with evidence — record the capability first.');
        }
      }
      /* Only the film_access membership is Creator's to change; other purposes
         in config/hostedCheckout are left exactly as they are. */
      const hRef = _db().collection(COL.CONFIG).doc('hostedCheckout');
      await hRef.set(d.set.hostedCheckout
        ? { enabled: true, purposes: FieldValue.arrayUnion(PURPOSE), updatedAt: FieldValue.serverTimestamp(), updatedBy: actor }
        : { purposes: FieldValue.arrayRemove(PURPOSE), updatedAt: FieldValue.serverTimestamp(), updatedBy: actor }, { merge: true });
      await _adminAudit('creator_hosted_checkout', actor, { enabled: d.set.hostedCheckout });
      if (!Object.keys(patch).length) return _config();
    }
    if (Array.isArray(d.set.checkoutMethods)) {
      fail('failed-precondition', 'Checkout methods are no longer a list — record each method with evidence (Payment methods).');
    }
    if (!Object.keys(patch).length) fail('invalid-argument', 'Nothing to set.');
    await ref.set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await _adminAudit('creator_config', actor, { patch });
  } else _admin(req);
  return _config();
};



/* ═══ VIEWER DASHBOARD ═══════════════════════════════════════════════════
   Only the caller's own records — entitlements, progress, sessions. */
async function viewerLibrary(req) {
  const uid = _uid(req);
  const nowMs = _clock();
  const [ents, prog, sess] = await Promise.all([
    _db().collection(COL.ENTITLEMENTS).where('buyerUid', '==', uid).limit(200).get(),
    _db().collection(COL.PROGRESS).where('uid', '==', uid).limit(200).get(),
    _db().collection(COL.SESSIONS).where('uid', '==', uid).where('ended', '==', false).limit(20).get(),
  ]);
  const progress = Object.fromEntries(prog.docs.map((d) => [d.data().filmId, d.data()]));
  const filmIds = [...new Set(ents.docs.map((d) => d.data().contentId))].slice(0, 100);
  const films = {};
  await Promise.all(filmIds.map(async (id) => { const x = await _db().collection(COL.FILMS).doc(id).get(); if (x.exists) films[id] = x.data(); }));
  const purchases = ents.docs.map((d) => {
    const e = d.data();
    const expired = e.expiresAtMs != null && nowMs >= e.expiresAtMs;
    return { entitlementId: d.id, filmId: e.contentId, title: (films[e.contentId] || {}).title || null, posterUrl: (films[e.contentId] || {}).posterUrl || null,
      type: e.entitlementType, amountCents: e.purchasedAmountCents, currency: e.currency, acquiredAtMs: _ms(e.acquiredAt),
      expiresAtMs: e.expiresAtMs || null, status: e.status === 'ACTIVE' && expired ? 'EXPIRED' : e.status };
  }).sort((a, b) => (b.acquiredAtMs || 0) - (a.acquiredAtMs || 0));
  const myFilms = purchases.filter((p) => p.status === 'ACTIVE');
  return {
    myFilms: myFilms.map((p) => ({ ...p, progress: progress[p.filmId] ? { positionSec: progress[p.filmId].positionSec, durationSec: progress[p.filmId].durationSec, completed: !!progress[p.filmId].completed } : null })),
    continueWatching: myFilms.filter((p) => progress[p.filmId] && !progress[p.filmId].completed && progress[p.filmId].positionSec > 0)
      .sort((a, b) => progress[b.filmId].updatedAtMs - progress[a.filmId].updatedAtMs)
      .map((p) => ({ filmId: p.filmId, title: p.title, posterUrl: p.posterUrl, positionSec: progress[p.filmId].positionSec, durationSec: progress[p.filmId].durationSec })),
    purchases,
    /* devices: hashed identifiers only — never IPs */
    sessions: sess.docs.map((d) => ({ sessionId: d.id, filmId: d.data().filmId, title: (films[d.data().filmId] || {}).title || null, device: String(d.data().deviceHash || '').slice(0, 8),
      startedAtMs: d.data().createdAtMs, lastSeenMs: d.data().lastSeenMs, live: nowMs - d.data().lastSeenMs < P.PLAYBACK.SESSION_IDLE_MS })),
    account: { page: '/profile.html', recovery: '/login.html?mode=reset' },
  };
}

async function viewerEndSession(req) {
  const uid = _uid(req);
  const sessionId = _id((req.data || {}).sessionId, 'sessionId');
  const ref = _db().collection(COL.SESSIONS).doc(sessionId);
  const s = await ref.get();
  if (!s.exists || s.data().uid !== uid) fail('permission-denied', 'Unknown session.');   /* never another buyer's */
  await ref.update({ ended: true, endedReason: 'viewer_signed_out_device', lastSeenMs: _clock() });
  return { ok: true };
}

/* ═══ CREATOR ANALYTICS ══════════════════════════════════════════════════
   Aggregates for films the caller owns. No viewer identity ever leaves here:
   counts, sums and ratios only. */
/* Analytics windows. Money (purchases, revenue, royalty) is filtered by the
   sale's recognition time; view / preview / watch counters are cumulative
   counters with no timestamp per event, so they are ALL-TIME and labelled so. */
const ANALYTICS_PERIODS = Object.freeze({ '7d': 7, '30d': 30, '90d': 90, all: null });
async function creatorAnalytics(req) {
  const uid = _uid(req);
  const periodKey = Object.prototype.hasOwnProperty.call(ANALYTICS_PERIODS, (req.data || {}).period) ? req.data.period : 'all';
  const days = ANALYTICS_PERIODS[periodKey];
  const sinceMs = days == null ? null : _clock() - days * 86400000;
  const inWindow = (a) => sinceMs == null || (Number(a.recognisedAtMs) || _ms(a.createdAt) || 0) >= sinceMs;
  const filmsSnap = await _db().collection(COL.FILMS).where('creatorUid', '==', uid).where('creatorHub', '==', true).limit(200).get();
  const nowPeriod = R.periodFor(_clock());
  const perSnap = await _db().collection(COL.PERIODS).doc(nowPeriod.periodId).get();
  const rows = await Promise.all(filmsSnap.docs.map(async (fd) => {
    const [st, shards, accs] = await Promise.all([
      _db().collection(COL.STATS).doc(fd.id).get(),
      _db().collection(COL.STATS).doc(fd.id).collection('shards').get(),
      _db().collection(COL.ACCRUALS).where('filmId', '==', fd.id).limit(5000).get(),
    ]);
    const x = { ...(st.exists ? st.data() : {}) };
    for (const sh of shards.docs) for (const k of ['watchSeconds', 'completedViews', 'pageViews', 'previewStarts']) x[k] = Number(x[k] || 0) + Number(sh.data()[k] || 0);
    const t = { purchases: 0, grossCents: 0, providerFeeCents: 0, commissionCents: 0, poolCents: 0, refundedCents: 0, withheld: 0 };
    for (const a of accs.docs.map((d) => d.data())) {
      if (a.status === 'VOID_REFUNDED' || !inWindow(a)) continue;
      t.purchases++; t.grossCents += a.grossCents; t.poolCents += a.poolCents; t.refundedCents += Number(a.refundedCents || 0);
      t.providerFeeCents += a.deductions.providerFeeCents; t.commissionCents += a.deductions.commissionCents;
    }
    const views = Number(x.views || 0), pageViews = Number(x.pageViews || 0), watch = Number(x.watchSeconds || 0);
    return {
      filmId: fd.id, title: fd.data().title, pubState: fd.data().pubState,
      views, uniqueViewers: Number(x.uniqueViewers || 0), completedViews: Number(x.completedViews || 0),
      watchSeconds: watch, avgWatchSeconds: views ? Math.round(watch / views) : null,
      pageViews, previewStarts: Number(x.previewStarts || 0), purchases: t.purchases,
      /* purchases per film-page view; null (shown "—") when there are no page views yet */
      conversionBps: pageViews ? Math.round((t.purchases * 10000) / pageViews) : null,
      grossCents: t.grossCents, providerFeeCents: t.providerFeeCents, commissionCents: t.commissionCents, poolCents: t.poolCents, refundedCents: t.refundedCents,
    };
  }));
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  /* The creator's OWN royalty (their participant ledger rows), in the window. */
  const mineSnap = await _db().collection(COL.LEDGER).where('uid', '==', uid).where('bucket', '==', R.BUCKET.PARTICIPANT_ROYALTY).limit(5000).get();
  const royaltyEarnedCents = mineSnap.size === 5000 ? null : mineSnap.docs.map((d) => d.data())
    .filter((e) => sinceMs == null || (_ms(e.createdAt) || 0) >= sinceMs)
    .reduce((a, e) => a + (e.kind === R.ENTRY_KIND.REVERSAL ? -Math.abs(e.amountCents) : e.amountCents), 0);
  const topContent = rows.filter((r) => r.purchases > 0).sort((a, b) => b.grossCents - a.grossCents || b.purchases - a.purchases).slice(0, 5)
    .map((r) => ({ filmId: r.filmId, title: r.title, purchases: r.purchases, grossCents: r.grossCents }));
  return {
    period: periodKey, countersAreAllTime: true, royaltyEarnedCents, topContent,
    films: rows,
    totals: { views: sum('views'), uniqueViewersBySum: sum('uniqueViewers'), completedViews: sum('completedViews'), watchSeconds: sum('watchSeconds'),
      previewStarts: sum('previewStarts'), pageViews: sum('pageViews'),
      purchases: sum('purchases'), grossCents: sum('grossCents'), providerFeeCents: sum('providerFeeCents'), commissionCents: sum('commissionCents'), poolCents: sum('poolCents'),
      /* purchases per film-page view — null ("—") without page views; page views are all-time */
      conversionBps: sum('pageViews') ? Math.round((sum('purchases') * 10000) / sum('pageViews')) : null },
    settlement: { periodId: nowPeriod.periodId, status: perSnap.exists ? perSnap.data().status : 'OPEN', periodEndsAtMs: nowPeriod.endMs },
    policy: { sokoniCommissionBps: require('./shared/creator-commercial').CREATOR_PPV.sokoniCommissionBps, creatorPoolBps: require('./shared/creator-commercial').CREATOR_PPV.creatorPoolBps },
  };
}

/* ═══ CREATOR VERIFICATION ═══════════════════════════════════════════════
   One application per creator: creatorVerifications/{uid}, keyed by the
   AUTHENTICATED uid — so nobody can apply for someone else and a second active
   application cannot exist. Documents live in the existing private KYC storage
   (kyc-documents/{uid}/…, owner + admin read); the server records each object's
   hash at attach time so a swap after submission is visible to the reviewer.
   Every status change appends to creatorVerifications/{uid}/events. */

const _vRef = (uid) => _db().collection(COL.VERIFICATIONS).doc(uid);
function _vEvent(txn, uid, e) {
  txn.set(_vRef(uid).collection('events').doc(), { ...e, at: FieldValue.serverTimestamp(), atMs: _clock() });
}
function _vPublic(uid, v) {
  return {
    applicationId: v.applicationId, creatorId: uid, status: v.status, version: v.version || 0,
    legalName: v.legalName || '', displayName: v.displayName || '', creatorType: v.creatorType || null, bio: v.bio || '',
    country: v.country || '', identity: v.identity || null, portfolio: v.portfolio || [], links: v.links || [],
    ownershipStatement: v.ownershipStatement || '', ownershipAttested: v.ownershipAttested === true,
    contactEmail: v.contactEmail || '', contactPhone: v.contactPhone || '',
    documents: (v.documents || []).map((d) => ({ name: d.name, contentType: d.contentType, sizeBytes: d.sizeBytes, attachedAtMs: d.attachedAtMs })),
    submittedAtMs: _ms(v.submittedAt), reviewedAtMs: _ms(v.reviewedAt), decisionReason: v.decisionReason || null,
  };
}

async function verificationGet(req) {
  const uid = _uid(req);
  const [v, ev] = await Promise.all([
    _vRef(uid).get(),
    _vRef(uid).collection('events').orderBy('atMs', 'desc').limit(30).get(),
  ]);
  if (!v.exists) return { status: P.VERIFICATION_STATE.NOT_APPLIED, application: null, events: [] };
  return { status: v.data().status, application: _vPublic(uid, v.data()),
    /* the creator sees what happened and why — never which admin did it */
    events: ev.docs.map((d) => ({ from: d.data().from, to: d.data().to, reason: d.data().reason || null, by: d.data().role, atMs: d.data().atMs })) };
}

async function verificationSaveDraft(req) {
  const uid = _uid(req);
  const input = _rule(() => P.sanitizeVerificationInput(req.data || {}));
  return _db().runTransaction(async (txn) => {
    const c = await txn.get(_db().collection(COL.CREATORS).doc(uid));
    const v = await txn.get(_vRef(uid));
    if (!c.exists) fail('failed-precondition', 'Register as a creator first.');
    if (c.data().state === P.CREATOR_STATE.SUSPENDED) fail('permission-denied', 'This creator account is suspended.');
    const cur = v.exists ? v.data().status : P.VERIFICATION_STATE.NOT_APPLIED;
    const editable = [P.VERIFICATION_STATE.NOT_APPLIED, P.VERIFICATION_STATE.DRAFT, P.VERIFICATION_STATE.MORE_INFORMATION_REQUIRED, P.VERIFICATION_STATE.REJECTED];
    if (!editable.includes(cur)) fail('failed-precondition', `An application that is ${cur} cannot be edited.`);
    const next = cur === P.VERIFICATION_STATE.MORE_INFORMATION_REQUIRED ? cur : P.VERIFICATION_STATE.DRAFT;
    if (cur !== next) _rule(() => P.assertVerificationTransition('creator', cur, next));
    if (!v.exists) {
      txn.create(_vRef(uid), { ...input, applicationId: 'cva_' + uid, creatorId: uid, status: next, version: 0, documents: [],
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      _vEvent(txn, uid, { from: cur, to: next, role: 'creator', actor: uid });
    } else {
      txn.update(_vRef(uid), { ...input, status: next, updatedAt: FieldValue.serverTimestamp() });
      if (cur !== next) _vEvent(txn, uid, { from: cur, to: next, role: 'creator', actor: uid });
    }
    return { status: next };
  });
}

async function verificationAttachDocument(req) {
  const uid = _uid(req);
  const name = String((req.data || {}).fileName || '');
  if (!P.VERIFICATION_DOC_NAME.test(name)) fail('invalid-argument', 'Upload the document as kyc-documents/<you>/cv-<name>.pdf|jpg|png|webp first.');
  const path = `kyc-documents/${uid}/${name}`;              /* ONLY the caller's own prefix */
  const file = _bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) fail('failed-precondition', 'That document has not been uploaded.');
  const [meta] = await file.getMetadata();
  const type = String(meta.contentType || '');
  const size = Number(meta.size);
  if (!(/^image\/(jpeg|png|webp)$/.test(type) || type === 'application/pdf')) fail('failed-precondition', 'Documents must be PDF or an image.');
  if (!(size > 0 && size <= 20 * 1024 * 1024)) fail('failed-precondition', 'Documents must be under 20 MB.');
  return _db().runTransaction(async (txn) => {
    const v = await txn.get(_vRef(uid));
    if (!v.exists) fail('failed-precondition', 'Start your application first.');
    const st = v.data().status;
    if (![P.VERIFICATION_STATE.DRAFT, P.VERIFICATION_STATE.MORE_INFORMATION_REQUIRED].includes(st)) fail('failed-precondition', `Documents cannot change while the application is ${st}.`);
    const docs = (v.data().documents || []).filter((d) => d.name !== name);
    if (docs.length >= P.MAX_VERIFICATION_DOCS) fail('failed-precondition', `At most ${P.MAX_VERIFICATION_DOCS} documents.`);
    docs.push({ name, path, contentType: type, sizeBytes: size, md5Hash: meta.md5Hash || null, generation: String(meta.generation || ''), attachedAtMs: _clock() });
    txn.update(_vRef(uid), { documents: docs, updatedAt: FieldValue.serverTimestamp() });
    return { documents: docs.length };
  });
}

async function verificationSubmit(req) {
  const uid = _uid(req);
  return _db().runTransaction(async (txn) => {
    const c = await txn.get(_db().collection(COL.CREATORS).doc(uid));
    const v = await txn.get(_vRef(uid));
    if (!v.exists) fail('failed-precondition', 'Start your application first.');
    if (!c.exists || c.data().state === P.CREATOR_STATE.SUSPENDED) fail('permission-denied', 'Creator account unavailable.');
    const cur = v.data().status;
    _rule(() => P.assertVerificationTransition('creator', cur, P.VERIFICATION_STATE.SUBMITTED));
    const r = P.verificationReadiness(v.data());
    if (!r.ready) fail('failed-precondition', 'Not ready to submit: ' + r.missing.join(', '));
    const version = Number(v.data().version || 0) + 1;
    txn.update(_vRef(uid), { status: P.VERIFICATION_STATE.SUBMITTED, version, submittedAt: FieldValue.serverTimestamp(),
      submittedDocs: (v.data().documents || []).map((d) => ({ name: d.name, md5Hash: d.md5Hash, generation: d.generation })),
      updatedAt: FieldValue.serverTimestamp() });
    _vEvent(txn, uid, { from: cur, to: P.VERIFICATION_STATE.SUBMITTED, role: 'creator', actor: uid, version });
    return { status: P.VERIFICATION_STATE.SUBMITTED, version };
  });
}

/* REFUND REVIEW — the AdminOS surface over the EXISTING refund authority on this
   branch (financial-os.js: fosRefundQueue · fosApproveRefund · fosResolveRefund).
   Read-only here: approve / reject / resolve are those callables, whose own
   checks (admin; super admin + evidence to resolve) are the authority. No second
   refund lifecycle. Film refunds are flagged from the server-minted intent. */
_adminH.creatorAdminRefundCases = async (req) => {
  _admin(req);
  const d = req.data || {};
  const status = typeof d.status === 'string' && /^[a-z_]{3,30}$/.test(d.status) ? d.status : null;
  let q = _db().collection('fosRefundQueue');
  if (status) q = q.where('status', '==', status);
  const snap = await q.orderBy('createdAt', 'desc').limit(50).get();
  const cases = await Promise.all(snap.docs.map(async (doc) => {
    const r = doc.data();
    const [intent, hist] = await Promise.all([
      r.payRef ? _db().collection('paymentIntents').doc(String(r.payRef)).get().catch(() => null) : null,
      _db().collection('finosAudit').where('refundId', '==', doc.id).limit(20).get().catch(() => null),
    ]);
    const it = intent && intent.exists ? intent.data() : null;
    return {
      refundId: doc.id, payRef: r.payRef || null, fosTransactionId: r.fosTransactionId || null,
      filmPurchase: !!(it && it.purpose === 'film_access'), filmId: it && it.purpose === 'film_access' ? (it.resourceId || null) : null,
      amountKES: r.amountKES ?? null, reason: r.reason || null, refundType: r.refundType || null, status: r.status || null,
      buyerUid: r.buyerUid || null, requestedBy: r.requestedBy || null, approvedBy: r.approvedBy || null,
      providerRefundId: r.providerRefundId || null, outcomeUnknown: r.status === 'outcome_unknown',
      error: r.error || r.rejectReason || null, resolution: r.resolution || null,
      createdAtMs: _ms(r.createdAt), updatedAtMs: _ms(r.updatedAt),
      history: hist ? hist.docs.map((h) => { const x = h.data(); return { action: x.action, actorUid: x.actorUid || null, atMs: _ms(x.timestamp) }; })
        .sort((a, b) => (a.atMs || 0) - (b.atMs || 0)) : null,
    };
  }));
  return { cases, statuses: ['pending', 'approved', 'processing', 'provider_succeeded', 'outcome_unknown', 'processed', 'failed', 'rejected'] };
};

/* CREATOR OVERSIGHT — every figure read from its canonical collection. A bounded
   read that hit its cap returns null (rendered "—"), never a partial sum passed
   off as a total. Viewer identities are never returned — aggregates only. */
_adminH.creatorAdminOverview = async (req) => {
  _admin(req);
  const CAP = 5000;
  const [creators, verifs, films, accs, releases, parts] = await Promise.all([
    _db().collection(COL.CREATORS).limit(CAP).get(),
    _db().collection(COL.VERIFICATIONS).where('status', 'in', ['SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED']).limit(CAP).get(),
    _db().collection(COL.FILMS).where('creatorHub', '==', true).where('status', '==', 'active').limit(CAP).get(),
    _db().collection(COL.ACCRUALS).limit(CAP).get(),
    _db().collection(COL.WALLET_TX).where('type', '==', 'royalty_release').limit(CAP).get(),
    _db().collection(COL.PARTICIPATIONS).limit(1000).get(),
  ]);
  const capped = (snap, v) => (snap.size >= CAP ? null : v);
  const byState = {};
  creators.docs.forEach((c) => { const st = c.data().state || 'UNKNOWN'; byState[st] = (byState[st] || 0) + 1; });
  const m = { purchases: 0, grossCents: 0, providerFeeCents: 0, commissionCents: 0, poolCents: 0, refunds: 0, refundedCents: 0 };
  for (const d of accs.docs) {
    const a = d.data();
    if (a.status === 'VOID_REFUNDED') { m.refunds++; m.refundedCents += Number(a.refundedCents || 0); continue; }
    m.purchases++; m.grossCents += Number(a.grossCents || 0); m.poolCents += Number(a.poolCents || 0);
    m.providerFeeCents += Number((a.deductions || {}).providerFeeCents || 0); m.commissionCents += Number((a.deductions || {}).commissionCents || 0);
    if (Number(a.refundedCents || 0) > 0) { m.refunds++; m.refundedCents += Number(a.refundedCents); }
  }
  /* Payouts of royalty participants — WALLET payouts (a participant's wallet may
     also hold other earnings; labelled so in the UI). */
  const uids = [...new Set(parts.docs.map((p) => p.data().uid).filter(Boolean))].slice(0, 200);
  const pay = { withdrawnKes: 0, pendingKes: 0, outcomeUnknownKes: 0, outcomeUnknownCount: 0 };
  for (let i = 0; i < uids.length; i += 10) {
    const ps = await _db().collection('payoutRequests').where('sellerUid', 'in', uids.slice(i, i + 10)).limit(500).get();
    for (const p of ps.docs.map((x) => x.data())) {
      const amt = Number(p.amount || 0);
      if (['paid', 'settled_manually'].includes(p.status)) pay.withdrawnKes += amt;
      else if (['outcome_unknown', 'retry_scheduled'].includes(p.status)) { pay.outcomeUnknownKes += amt; pay.outcomeUnknownCount++; }
      else if (['pending', 'scheduled', 'approving', 'approved', 'processing', 'approval_failed'].includes(p.status)) pay.pendingKes += amt;
    }
  }
  const payTruncated = parts.size >= 1000 || new Set(parts.docs.map((p) => p.data().uid)).size > 200;
  return {
    creators: capped(creators, { total: creators.size, byState }),
    pendingVerification: capped(verifs, verifs.size),
    publishedFilms: capped(films, films.size),
    sales: capped(accs, { ...m, policy: 'creator_ppv_v1 — SOKONI 30% / creator pool 70% of NET' }),
    releasedRoyaltyKes: capped(releases, releases.docs.reduce((a, d) => a + Number(d.data().amount || 0), 0)),
    participantPayouts: payTruncated ? null : { ...pay, note: 'Wallet payouts of royalty participants — may include their other SOKONI earnings.' },
  };
};

/* IntaSend payment-method capability (platform record config/intasendCapability).
   Read: any admin. Write: Super Admin, one method at a time, with a note, and for
   LIVE_AND_PROVEN / UNSUPPORTED an evidence type + reference. Audited. This is
   the only writer of the record; initiateHostedCheckout and the Creator catalog
   only read it. */
_adminH.creatorAdminPaymentCapability = async (req) => {
  const d = req.data || {};
  const ref = _db().collection(COL.CONFIG).doc(PCAP.RECORD);
  if (d.set) {
    const actor = _superAdmin(req);
    const v = PCAP.validateEntry(d.set);
    if (!v.ok) fail('invalid-argument', v.error);
    const { method, ...entry } = v.entry;
    await ref.set({ methods: { [method]: { ...entry, recordedBy: actor, recordedAtMs: Date.now() } }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await _adminAudit('payment_capability', actor, { method, status: entry.status, evidence: entry.evidence || null });
  } else _admin(req);
  const snap = await ref.get();
  const cfg = await _config();
  return { methods: PCAP.classify(snap.exists ? snap.data() : null), statuses: Object.values(PCAP.STATUS), evidenceTypes: PCAP.EVIDENCE_TYPES,
    hostedCheckoutEnabled: cfg.hostedCheckoutEnabled, hostedCheckoutSwitch: cfg.hostedCheckoutSwitch };
};

_adminH.creatorAdminVerifications = async (req) => {
  _admin(req);
  const st = (req.data || {}).status;
  let q = _db().collection(COL.VERIFICATIONS);
  if (st) { if (!P.VERIFICATION_STATE[st]) fail('invalid-argument', 'Unknown status.'); q = q.where('status', '==', st); }
  const snap = await q.limit(200).get();
  return { applications: snap.docs.map((d) => ({ ..._vPublic(d.id, d.data()), creatorId: d.id })) };
};

_adminH.creatorAdminVerificationDetail = async (req) => {
  _admin(req);
  const uid = _id((req.data || {}).uid, 'uid');
  const [v, c, priv, ev] = await Promise.all([
    _vRef(uid).get(), _db().collection(COL.CREATORS).doc(uid).get(), _db().collection(COL.CREATOR_PRIVATE).doc(uid).get(),
    _vRef(uid).collection('events').orderBy('atMs', 'desc').limit(100).get(),
  ]);
  if (!v.exists) fail('not-found', 'No application.');
  const app = v.data();
  const submitted = Object.fromEntries((app.submittedDocs || []).map((d) => [d.name, d]));
  const documents = [];
  for (const d of app.documents || []) {
    const file = _bucket().file(d.path);
    let url = null, changedAfterSubmit = null, present = false;
    try {
      const [ok] = await file.exists(); present = ok;
      if (ok) {
        const [meta] = await file.getMetadata();
        const s0 = submitted[d.name];
        changedAfterSubmit = s0 ? (String(meta.generation || '') !== s0.generation || (meta.md5Hash || null) !== s0.md5Hash) : null;
        [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: _clock() + 5 * 60 * 1000 });
      }
    } catch (e) { logger.warn('[creator] verification doc inspect failed', { uid, name: d.name, err: e.message }); }
    documents.push({ name: d.name, contentType: d.contentType, sizeBytes: d.sizeBytes, present, changedAfterSubmit, url });
  }
  return {
    application: _vPublic(uid, app), creator: c.exists ? _publicCreator(uid, c.data(), { withContact: true }) : null,
    private: priv.exists ? { legalName: priv.data().legalName || null, phone: priv.data().phone || null } : null,
    documents,
    /* full audit: reviewer identity visible to admins */
    events: ev.docs.map((d) => ({ from: d.data().from, to: d.data().to, role: d.data().role, actor: d.data().actor, reason: d.data().reason || null, version: d.data().version || null, atMs: d.data().atMs })),
  };
};

_adminH.creatorAdminVerificationDecision = async (req) => {
  const actor = _admin(req);
  const d = req.data || {};
  const uid = _id(d.uid, 'uid');
  const action = P.VERIFICATION_ACTIONS[String(d.action || '')];
  if (!action) fail('invalid-argument', 'Unknown action.');
  /* An admin who is also a creator never reviews their own application. */
  if (uid === actor) fail('permission-denied', 'You cannot review your own verification application.');
  const reason = String(d.reason || '').trim().slice(0, 1000);
  if (action.reason && reason.length < 5) fail('invalid-argument', 'A reason is required.');
  const out = await _db().runTransaction(async (txn) => {
    const v = await txn.get(_vRef(uid));
    const c = await txn.get(_db().collection(COL.CREATORS).doc(uid));
    if (!v.exists) fail('not-found', 'No application.');
    const from = v.data().status;
    _rule(() => P.assertVerificationTransition('admin', from, action.to));
    txn.update(_vRef(uid), { status: action.to, reviewer: actor, reviewedAt: FieldValue.serverTimestamp(), decisionReason: reason || null, updatedAt: FieldValue.serverTimestamp() });
    _vEvent(txn, uid, { from, to: action.to, role: 'admin', actor, reason: reason || null, version: v.data().version || null });
    /* The ONE writer of the creators.verification projection. */
    if (c.exists) {
      const patch = { updatedAt: FieldValue.serverTimestamp() };
      if (action.to === P.VERIFICATION_STATE.APPROVED) {
        patch.verification = 'VERIFIED';
        if ([P.CREATOR_STATE.PENDING, P.CREATOR_STATE.SUSPENDED].includes(c.data().state)) patch.state = P.CREATOR_STATE.ACTIVE;
      } else if (action.to === P.VERIFICATION_STATE.SUSPENDED) {
        patch.verification = 'UNVERIFIED'; patch.state = P.CREATOR_STATE.SUSPENDED; patch.reviewNote = reason;
      } else if (from === P.VERIFICATION_STATE.APPROVED) {
        patch.verification = 'UNVERIFIED';
      }
      txn.update(c.ref, patch);
    }
    return { from, to: action.to };
  });
  await _adminAudit('creator_verification', actor, { uid, action: d.action, ...out, reason });
  return out;
};

/* ═══ DISPATCHER ═════════════════════════════════════════════════════════ */

const OPS = {
  'catalog.list': catalogList, 'catalog.get': catalogGet, 'catalog.creator': catalogCreator,
  'creator.register': creatorRegister, 'creator.me': creatorMe,
  'film.saveDraft': filmSaveDraft, 'film.mediaUploadTarget': filmMediaUploadTarget, 'film.attachMedia': filmAttachMedia,
  'film.previewUploadTarget': filmPreviewUploadTarget, 'film.attachPreview': filmAttachPreview,
  'film.submit': filmSubmit, 'film.reopen': filmReopen, 'film.publish': filmPublish,
  'agreement.saveDraft': agreementSaveDraft,
  'playback.authorize': playbackAuthorize, 'playback.heartbeat': playbackHeartbeat, 'playback.end': playbackEnd, 'playback.report': playbackReport,
  'playback.preview': playbackPreview, 'playback.previewProgress': playbackPreviewProgress,
  'royalty.mine': royaltyMine, 'royalty.film': royaltyFilm,
  'viewer.library': viewerLibrary, 'viewer.endSession': viewerEndSession, 'creator.analytics': creatorAnalytics,
  'verification.get': verificationGet, 'verification.saveDraft': verificationSaveDraft,
  'verification.attachDocument': verificationAttachDocument, 'verification.submit': verificationSubmit,
};

/* What an anonymous (guest) viewer may do: browse, watch what they paid for,
   see their own library. Nothing that creates identity, content or money. */
const ANON_OPS = new Set(['catalog.list', 'catalog.get', 'catalog.creator', 'playback.authorize', 'playback.heartbeat', 'playback.end', 'playback.report',
  'playback.preview', 'playback.previewProgress',
  'viewer.library', 'viewer.endSession']);

exports.creatorDispatch = onCall({ region: REGION, enforceAppCheck: true, maxInstances: 20, timeoutSeconds: 60, memory: '256MiB' }, async (req) => {
  const op = req.data && req.data.op;
  const h = typeof op === 'string' && Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
  if (!h) fail('not-found', 'Unknown creator operation.');
  const provider = req.auth && req.auth.token && req.auth.token.firebase && req.auth.token.firebase.sign_in_provider;
  if (provider === 'anonymous' && !ANON_OPS.has(op)) fail('permission-denied', 'Create your SOKONI account to do this.');
  return h(req);
});

exports._adminH = _adminH;
exports.RIGHTS_ATTESTATION = RIGHTS_ATTESTATION;
exports._internal = {
  OPS, COL, PURPOSE, priceFilmAccess, filmAccessAdapter, accrueRoyalty, processFilmPayment, onFilmRefundProcessed,
  shouldProcess, _providerFee, ANON_OPS, _setClock: (fn) => { _clock = fn || _now; },
};
exports.priceFilmAccess = priceFilmAccess;
exports.filmAccessAdapter = filmAccessAdapter;
exports.onFilmRefundProcessed = onFilmRefundProcessed;
