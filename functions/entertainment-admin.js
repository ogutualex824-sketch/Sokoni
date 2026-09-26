'use strict';
/**
 * AdminOS › Entertainment — listing moderation and the category / commercial-policy matrix.
 * ============================================================================================
 * Merged into adminOsDispatch (admin-os-dispatch.js). AdminOS is the ONLY Entertainment control
 * plane: nothing here is exposed to admin.html or a standalone page. Every handler re-checks the
 * admin claim itself; every write is audited to adminAudit with who / what / target / before /
 * after / reason / createdAt (the fields the AdminOS Audit Center reads).
 *
 *   entAdminMatrix            read — the Entertainment registry resolved, plus the commercial
 *                             policy matrix (rates from their owning authorities, never copied)
 *   entAdminListings          read — venue / artist profiles awaiting or under moderation
 *   entAdminSetListingStatus  write — approve (active) / reject / suspend / restore a venue or
 *                             artist profile. Clients cannot change `status` (firestore.rules);
 *                             this is the one place it changes. A reason is required for every
 *                             decision except approval.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const AC = require('./admin-claim');
const REG = require('./shared/entertainment-registry');
const POLICY = require('./shared/commercial-policy');

const _db = () => getFirestore();
const fail = (code, msg) => { throw new HttpsError(code, msg); };
function _admin(req) { if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.'); if (!AC.isAdmin(req)) fail('permission-denied', 'Admin only.'); return req.auth.uid; }
const _row = (d) => { const x = d.data(); const o = { id: d.id }; for (const [k, v] of Object.entries(x)) o[k] = (v && typeof v.toMillis === 'function') ? v.toMillis() : v; return o; };

/* Collections this surface moderates, and the statuses a decision may set. */
const LISTINGS = Object.freeze({ venue: 'entVenues', artist: 'entArtists' });
const DECISIONS = Object.freeze({
  approve: 'active', reject: 'rejected', suspend: 'suspended', restore: 'active',
});
/* Which current states each decision may act on — a rejected profile is not silently revived by
   "approve"; it is restored deliberately. */
const FROM = Object.freeze({
  approve: ['pending'], reject: ['pending'], suspend: ['active', 'approved'], restore: ['suspended', 'rejected'],
});

const _adminH = {};

_adminH.entAdminMatrix = async (req) => {
  _admin(req);
  return {
    categories: REG.CATEGORIES,
    orphans: REG.orphans(),
    performerTypes: REG.PERFORMER_TYPES,
    venueTypes: REG.VENUE_TYPES,
    commercialPolicies: POLICY.matrix(),
  };
};

_adminH.entAdminListings = async (req) => {
  _admin(req);
  const kind = String((req.data || {}).kind || 'venue');
  const status = String((req.data || {}).status || 'pending');
  const col = LISTINGS[kind];
  if (!col) fail('invalid-argument', 'kind must be venue or artist.');
  if (!['pending', 'active', 'approved', 'suspended', 'rejected'].includes(status)) fail('invalid-argument', 'Unknown status.');
  const snap = await _db().collection(col).where('status', '==', status).limit(200).get();
  return { kind, status, listings: snap.docs.map(_row) };
};

_adminH.entAdminSetListingStatus = async (req) => {
  const actor = _admin(req);
  const d = req.data || {};
  const col = LISTINGS[String(d.kind || '')];
  if (!col) fail('invalid-argument', 'kind must be venue or artist.');
  const id = String(d.id || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('invalid-argument', 'Invalid id.');
  const decision = String(d.decision || '');
  const to = DECISIONS[decision];
  if (!to) fail('invalid-argument', 'decision must be approve, reject, suspend or restore.');
  const reason = String(d.reason || '').trim().slice(0, 500);
  if (decision !== 'approve' && reason.length < 5) fail('invalid-argument', 'A reason is required.');
  const ref = _db().collection(col).doc(id);
  let from = null;
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) fail('not-found', 'Listing not found.');
    from = String(s.data().status || 'pending');
    if (!FROM[decision].includes(from)) fail('failed-precondition', `Cannot ${decision} a listing that is ${from}.`);
    txn.update(ref, {
      status: to, moderatedBy: actor, moderatedAt: FieldValue.serverTimestamp(),
      moderationReason: reason || null, updatedAt: FieldValue.serverTimestamp(),
    });
  });
  await _db().collection('adminAudit').add({
    action: `ent_listing_${decision}`, performedBy: actor, module: 'entertainment-admin',
    target: { collection: col, id }, before: { status: from }, after: { status: to }, reason: reason || null,
    createdAt: FieldValue.serverTimestamp(),
  }).catch((e) => logger.error('[entAdmin] audit write failed', { id, err: e.message }));
  return { ok: true, id, from, to };
};

module.exports = { _adminH, LISTINGS, DECISIONS, FROM };
