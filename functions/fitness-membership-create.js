/* ============================================================================
   FITNESS MEMBERSHIP — CREATE (purchase start) from a gym's published offer (owner 2026-10-03; sokoni-e3; NOT deployed)
   ----------------------------------------------------------------------------
   Owner: "a gym publishes its membership offers IN ITS PROVIDER SERVICES" — a providerServices/{serviceId} record with
   serviceKind 'membership' (functions/shared/membership-offer.js). The server prices the purchase from THAT record.

   fitnessCreateMembership({ serviceId }) → { membershipId, reused, priceCents, periodCount, periodUnit, title }
     1. auth required
     2. providerServices/{serviceId} read SERVER-side → validateMembershipOffer must pass
     3. providers/{providerId}: status 'active'|'approved' (the bookingCreateService gate), not suspended, still selling
        (acceptsBookings !== false), and business-category.categoryOf(...) === 'fitness_studio' — the canonical
        category stamped at approval (gym / yoga-studio / martial-arts / dance-fitness / spinning). Free-text `category`
        on the service or the provider is provider-editable and NEVER trusted.
     4. buyer ≠ provider
     5. single-flight per (buyer, service): a claim doc `fitnessMembershipClaims/{sha256(buyer|service)}` is read and
        written in the SAME transaction as the membership create(). A live pending_payment membership < 30 min old is
        RETURNED (double tap, retry, refresh) instead of a second one being made.
     6. providerMemberships/{newId}.create() with EXACTLY the FINAL CONTRACT v2 create shape + serviceId + createdAt.

   SNAPSHOT (2f, verified 9d5ea2a): priceCents / periodCount / periodUnit / title are COPIED from the offer at creation
   and are IMMUTABLE on the membership. payment-purposes.fitness_membership prices from the membership doc and never
   re-reads the offer; a later edit of the offer never changes a membership already created (booking snapshot rule).

   startAt = SERVER time at creation (purchase time). The months run from here — not from payment, not from the first
   visit — unless the owner decides otherwise. A pending membership older than 30 min is abandoned (never activated
   without a verified webhook); the next attempt creates a fresh one with a fresh startAt.

   NEVER from the client: price, priceCents, periodCount, periodUnit, providerId, buyerUid, title, status, startAt.
   The only input is serviceId.
   ============================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');
const OFFER = require('./shared/membership-offer');

const COL = 'providerMemberships';
const CLAIMS = 'fitnessMembershipClaims';
const PENDING_REUSE_MS = 30 * 60 * 1000;
const SERVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIVE_PROVIDER_STATES = Object.freeze(['active', 'approved']);   /* booking-service.bookingCreateService */
const FITNESS_CATEGORY = 'fitness_studio';

/* Overridable ONLY by the suite (in-memory Firestore). */
const _hooks = { db: null, ts: null, now: null, tsFromDate: null, newId: null };
const _db = () => _hooks.db || admin.firestore();
const _ts = () => (_hooks.ts ? _hooks.ts() : admin.firestore.FieldValue.serverTimestamp());
const _now = () => (_hooks.now ? _hooks.now() : new Date());
const _tsFromDate = (d) => (_hooks.tsFromDate ? _hooks.tsFromDate(d) : admin.firestore.Timestamp.fromDate(d));
const _newId = () => (_hooks.newId ? _hooks.newId() : _db().collection(COL).doc().id);

const _claimId = (buyerUid, serviceId) => 'fmc_' + crypto.createHash('sha256').update(buyerUid + '|' + serviceId).digest('hex').slice(0, 40);

/** Pure: may this provider record sell a fitness membership? → null | { code, message } */
function providerRefusal(prov) {
  if (!prov) return { code: 'failed-precondition', message: 'This gym isn’t currently selling memberships.', reason: 'provider_missing' };
  if (!ACTIVE_PROVIDER_STATES.includes(String(prov.status || '')) || prov.suspended === true || prov.acceptsBookings === false) {
    return { code: 'failed-precondition', message: 'This gym isn’t currently selling memberships.', reason: 'provider_not_active' };
  }
  if (require('./business-category').categoryOf(prov) !== FITNESS_CATEGORY) {
    return { code: 'failed-precondition', message: 'Memberships can only be bought from a fitness business.', reason: 'not_fitness' };
  }
  return null;
}

async function createMembershipHandler(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const serviceId = String((req.data && req.data.serviceId) || '');
  if (!SERVICE_ID_RE.test(serviceId)) throw new HttpsError('invalid-argument', 'serviceId is required.');

  const svcSnap = await _db().collection('providerServices').doc(serviceId).get();
  if (!svcSnap.exists) throw new HttpsError('not-found', OFFER.REASONS.missing, { reason: 'missing' });
  const offer = OFFER.validateMembershipOffer(svcSnap.data());
  if (!offer.ok) throw new HttpsError('failed-precondition', offer.message, { reason: offer.reason });

  if (uid === offer.providerId) throw new HttpsError('failed-precondition', 'You cannot buy a membership at your own gym.', { reason: 'self_purchase' });
  const provSnap = await _db().collection('providers').doc(offer.providerId).get();
  const refusal = providerRefusal(provSnap.exists ? provSnap.data() : null);
  if (refusal) throw new HttpsError(refusal.code, refusal.message, { reason: refusal.reason });

  const now = _now();
  const claimRef = _db().collection(CLAIMS).doc(_claimId(uid, serviceId));
  let out = null;
  try {
    await _db().runTransaction(async (t) => {
      out = null;
      /* reads first */
      const cs = await t.get(claimRef);
      let prior = null;
      if (cs.exists && cs.data().membershipId) {
        const ps = await t.get(_db().collection(COL).doc(String(cs.data().membershipId)));
        if (ps.exists) prior = { id: ps.id, m: ps.data(), at: Number(cs.data().claimedAtMs) || 0 };
      }
      if (prior && prior.m.buyerUid === uid && prior.m.serviceId === serviceId && prior.m.status === 'pending_payment'
          && prior.m.paymentStatus === 'pending' && now.getTime() - prior.at < PENDING_REUSE_MS) {
        out = { membershipId: prior.id, reused: true, m: prior.m };
        return;
      }
      const membershipId = _newId();
      const doc = {
        providerId: offer.providerId, buyerUid: uid, priceCents: offer.priceCents, periodCount: offer.periodCount,
        periodUnit: offer.periodUnit, startAt: _tsFromDate(now), category: 'fitness', title: offer.title,
        paymentStatus: 'pending', status: 'pending_payment', serviceId, createdAt: _ts(),
      };
      t.create(_db().collection(COL).doc(membershipId), doc);
      const claim = { buyerUid: uid, serviceId, membershipId, claimedAtMs: now.getTime(), updatedAt: _ts() };
      if (cs.exists) t.set(claimRef, claim); else t.create(claimRef, claim);
      out = { membershipId, reused: false, m: doc };
    });
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('[fitness-membership] create failed', { serviceId, err: (e && e.message) || 'Error' });
    throw new HttpsError('unavailable', 'Could not start the membership. Please try again.');
  }
  logger.info('[fitness-membership] create', { membershipId: out.membershipId, serviceId, providerId: offer.providerId, reused: out.reused });
  return { membershipId: out.membershipId, reused: out.reused, priceCents: out.m.priceCents, periodCount: out.m.periodCount,
           periodUnit: out.m.periodUnit, title: out.m.title };
}

const fitnessCreateMembership = onCall({ region: 'us-central1', enforceAppCheck: true, maxInstances: 20 }, createMembershipHandler);

module.exports = {
  fitnessCreateMembership, providerRefusal, PENDING_REUSE_MS, COL, CLAIMS,
  _h: { createMembershipHandler },
  _test: { use: (h) => Object.assign(_hooks, h || {}), claimId: _claimId },
};
