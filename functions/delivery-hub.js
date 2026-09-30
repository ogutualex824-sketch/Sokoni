'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — DELIVERY HUB CALLABLES
   functions/delivery-hub.js

   The wiring between the six certified authorities and the clients that use them.

       rider-discovery      who is reasonably nearby        (bounded query)
       sokoni-dispatch      who can actually do this job    (matching)
       delivery-quote       what the job pays               (pricing)
       delivery-dispatch-job  lifecycle, pinning, channel
       rider-rating         ratings from completed jobs
       delivery-hub-access  who may do what

   THIS MODULE DECIDES NOTHING. Every callable does the same four things: load the job,
   ask the access boundary, delegate to the authority that owns the decision, persist the
   result. Where it is tempted to compute — an earning, an eligibility, a distance — it
   calls instead. That is the whole point of having spent six modules establishing who
   owns what.

   THE ONE QUERY RULE, ENFORCED HERE

   listRiders issues a BOUNDED query built from rider-discovery's bounds and limit. It
   never reads the riders collection unbounded, and it never hands the client a list to
   filter. A merchant's browser receives eligible riders only — which is what keeps a
   dispatch panel cheap on a phone.
   ══════════════════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

/* The key that makes a six-digit code non-brute-forceable from its stored hash. The SAME
   secret delivery-pin.js already uses, so the platform has one delivery-PIN key rather
   than two that can drift apart. There is NO fallback constant: a missing secret must make
   verification impossible, never make it pass. */
const SOKONI_HMAC_KEY = defineSecret('SOKONI_HMAC_KEY');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const ACCESS = require('./delivery-hub-access');
const DISCOVERY = require('./rider-discovery');
const MATCH = require('./sokoni-dispatch');
const MARKET = require('./rider-marketplace');
const JOB = require('./delivery-dispatch-job');
const RATING = require('./rider-rating');
const QUOTE = require('./delivery-quote');
const ECON = require('./delivery-economics');
const HANDOFF = require('./delivery-handoff');
const DSETTLE = require('./delivery-settlement');
const BW = require('./business-wallet');
const TENANT = require('./tenant-identity');

const REGION = 'us-central1';
const C_JOBS = 'deliveryJobs';
const C_RIDERS = 'rideDrivers';
const C_MESSAGES = 'deliveryDispatchMessages';
const C_RATINGS = 'riderRatings';
const C_ORDERS = 'orders';
const C_SHOPS = 'shops';
const C_SYSCONFIG = 'sysConfig';
/* Deny-by-default: this collection has NO security rule, so no client reads it. The
   plaintext codes cannot live on the job — both parties to a handoff can read that
   document, and a code the verifier can read verifies nothing. */
const C_HANDOFF_PINS = 'deliveryHandoffPins';
const C_DELIVERY_SETTLEMENTS = 'deliverySettlements';

const db = () => getFirestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();

function fail(code, msg) { throw new HttpsError(code, msg); }
function uidOf(req) {
  if (!req || !req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in to continue.');
  return String(req.auth.uid);
}

async function loadJob(deliveryId) {
  const id = String(deliveryId || '').trim();
  if (!id) fail('invalid-argument', 'deliveryId is required.');
  const snap = await db().collection(C_JOBS).doc(id).get();
  if (!snap.exists) fail('not-found', 'That delivery does not exist.');
  return Object.assign({ deliveryId: id }, snap.data());
}

/* One place turns an authority's refusal into a client error, so a refusal reason cannot
   be lost on the way out or turned into a silent success by a caller that forgot to look. */
function enforce(decision, code) {
  if (!decision || decision.ok !== true) {
    fail(code || 'permission-denied', (decision && decision.reason) || 'refused');
  }
  return decision;
}

/* ── 1. THE RIDER BOARD ────────────────────────────────────────────────────
   Bounded discovery -> bounded query -> matching -> projection. Expansion happens
   SERVER-SIDE across rounds, so the client asks once and never learns about riders the
   matching authority rejected. */
exports.deliveryHubListRiders = onCall(
  { region: REGION, timeoutSeconds: 30, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const job = await loadJob(request.data && request.data.deliveryId);
    enforce(ACCESS.can(job, uid, ACCESS.OP.LIST_RIDERS));

    const shop = job.pickup && Number.isFinite(Number(job.pickup.lat))
      ? { lat: Number(job.pickup.lat), lng: Number(job.pickup.lng) }
      : null;
    if (!shop) fail('failed-precondition', 'This delivery has no pickup location.');

    const deliveryForMatch = {
      pickupLat: shop.lat, pickupLng: shop.lng,
      weightKg: Number(job.weightKg) || 1,
      parcelSize: job.sizeClass || 'medium',
      vehicleType: (job.pinnedQuote && job.pinnedQuote.vehicleType) || 'moto',
    };

    let round = 0, collected = null, roundsTried = [];
    /* Bounded rounds. The ceiling lives in the discovery authority, and asking past it is
       refused there rather than guarded by a counter here. */
    for (;;) {
      const plan = DISCOVERY.planRound(shop, round);
      if (!plan.ok) break;                       /* RADIUS_CEILING_REACHED */
      roundsTried.push(plan.radiusKm);

      /* THE BOUNDED QUERY. The box and the limit both come from the authority; neither is
         re-derived here, and the limit is not optional. */
      const b = plan.bounds;
      const snap = await db().collection(C_RIDERS)
        .where('lat', '>=', b.minLat).where('lat', '<=', b.maxLat)
        .limit(b.limit)
        .get();

      /* The latitude range is what Firestore can index on; longitude and the circle are
         trimmed here, which is why the query limit is larger than the card cap. */
      const candidates = snap.docs
        .map((d) => Object.assign({ id: d.id, uid: d.id }, d.data()))
        .filter((r) => Number(r.lng) >= b.minLng && Number(r.lng) <= b.maxLng);

      /* MATCHING decides eligibility — vehicle, capacity, workload, approval. */
      const ranked = MATCH.rankRiders(candidates, deliveryForMatch);
      const byId = {};
      candidates.forEach((c) => { byId[c.id] = c; });
      const eligible = ranked
        .map((s) => Object.assign({}, byId[s.riderId] || {}, { _scored: s }))
        .filter((r) => r.id);

      collected = DISCOVERY.collect({ shop, radiusKm: plan.radiusKm, eligible, round });
      if (!collected.ok) fail('internal', collected.reason);
      if (collected.count > 0 || !collected.shouldExpand) break;
      round = collected.nextRound;
    }

    if (!collected) return { ok: true, riders: [], count: 0, exhausted: true, roundsTried };

    const cards = MARKET.cards({
      ranked: collected.riders.map((r) => Object.assign({}, r._scored, { distKm: r.distanceFromShopKm })),
      riders: collected.riders,
      quote: job.pinnedQuote,
      job: { weightKg: deliveryForMatch.weightKg, recommendedVehicle: deliveryForMatch.vehicleType },
    });
    if (!cards.ok) fail('failed-precondition', cards.reason);

    const order = String((request.data && request.data.sort) || 'best');
    return {
      ok: true,
      radiusKm: collected.radiusKm,
      roundsTried,
      truncated: collected.truncated,
      exhausted: collected.exhausted === true,
      quotePinned: cards.quotePinned,
      riders: MARKET.sortCards(cards.cards, order),
      count: cards.count,
    };
  }
);

/* ── 2. DISPATCH ───────────────────────────────────────────────────────── */
exports.deliveryHubDispatch = onCall(
  { region: REGION, timeoutSeconds: 30, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const job = await loadJob(request.data && request.data.deliveryId);
    enforce(ACCESS.can(job, uid, ACCESS.OP.DISPATCH));

    const riderUid = String((request.data && request.data.riderUid) || '').trim();
    if (!riderUid) fail('invalid-argument', 'Choose a rider, or use auto-assign.');

    /* The earning is NEVER taken from the request. It is the pinned figure, and passing it
       through assignRider makes any attempt to send a different one a refusal rather than
       an unnoticed override. */
    const assigned = JOB.assignRider(job, riderUid, job.pinnedQuote && job.pinnedQuote.riderGross,
                                     { uid, at: new Date().toISOString() });
    enforce(assigned, 'failed-precondition');

    await db().collection(C_JOBS).doc(job.deliveryId).set({
      state: assigned.job.state,
      assignedRiderUid: assigned.job.assignedRiderUid,
      history: assigned.job.history,
      updatedAt: now(),
    }, { merge: true });

    return { ok: true, state: assigned.job.state, assignedRiderUid: riderUid,
             riderEarningKES: job.pinnedQuote.riderGross };
  }
);

/* ── 3. THE RIDER ANSWERS ──────────────────────────────────────────────── */
exports.deliveryHubRespond = onCall(
  /* THE SECRET IS DECLARED HERE because THIS is where the handoff codes are minted. It was
     declared on the two callables that READ and VERIFY them and missed on the one that
     creates them — so in production every rider acceptance would have refused with
     NO_SIGNING_KEY. Certification caught it as a suite that could no longer accept a job.
     A v2 function reaches a secret only if it names it, however correct the code is. */
  { region: REGION, timeoutSeconds: 20, cors: true, secrets: [SOKONI_HMAC_KEY] },
  async (request) => {
    const uid = uidOf(request);
    const job = await loadJob(request.data && request.data.deliveryId);
    enforce(ACCESS.can(job, uid, ACCESS.OP.RIDER_RESPOND));

    const accept = (request.data && request.data.accept) === true;
    const next = accept ? JOB.STATE.DISPATCHED : JOB.STATE.RIDER_SEARCH;
    const moved = JOB.transition(job, next, { uid, at: new Date().toISOString() });
    enforce(moved, 'failed-precondition');

    const patch = { state: moved.job.state, history: moved.job.history, updatedAt: now() };
    /* A decline releases the job back to the board AND clears the assignment, so the
       declining rider stops being a party to it immediately. */
    if (!accept) patch.assignedRiderUid = null;

    if (accept) {
      /* THE TWO CODES ARE MINTED HERE, at the one moment both parties are known and fixed.
         Re-offering the job to a different rider changes the binding, so the old codes stop
         verifying and the next acceptance mints fresh ones — no revocation step to forget.

         The HASHES go on the job, which its parties may read; the PLAINTEXT goes to a
         collection with no rule at all, and reaches each party only through a callable that
         proves who they are. */
      const key = secretKey();
      const dep = HANDOFF.issue({ job: assignedJob(job, uid), purpose: HANDOFF.PURPOSE.DEPARTURE, key });
      const rec = job.customerUid
        ? HANDOFF.issue({ job: assignedJob(job, uid), purpose: HANDOFF.PURPOSE.RECEIPT, key })
        : { ok: false, reason: 'NO_BUYER' };
      enforce(dep, 'failed-precondition');

      patch.departurePinHash = dep.hash;
      patch.handoffAttempts = { DEPARTURE: 0, RECEIPT: 0 };
      if (rec.ok) patch.receiptPinHash = rec.hash;

      await db().collection(C_HANDOFF_PINS).doc(job.deliveryId).set({
        deliveryId: job.deliveryId,
        /* Who each code belongs to, so the reader below never has to guess. */
        departurePin: dep.pin, departureFor: uid,
        receiptPin: rec.ok ? rec.pin : null, receiptFor: rec.ok ? String(job.customerUid) : null,
        mintedAt: now(),
      }, { merge: true });
    }

    await db().collection(C_JOBS).doc(job.deliveryId).set(patch, { merge: true });
    return { ok: true, state: moved.job.state, accepted: accept };
  }
);

/* ── 4. THE JOB-SCOPED CHANNEL ─────────────────────────────────────────── */
exports.deliveryHubMessage = onCall(
  { region: REGION, timeoutSeconds: 20, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const job = await loadJob(request.data && request.data.deliveryId);
    enforce(ACCESS.can(job, uid, ACCESS.OP.POST_MESSAGE));

    const built = JOB.postMessage(job, uid, request.data && request.data.text);
    enforce(built, 'failed-precondition');

    const ref = await db().collection(C_MESSAGES).add(
      Object.assign({}, built.message, { createdAt: now() }));
    return { ok: true, messageId: ref.id };
  }
);

/* ── 5. LIFECYCLE ──────────────────────────────────────────────────────── */
const ADVANCE_OP = {
  [JOB.STATE.PICKED_UP]: ACCESS.OP.ADVANCE_PICKUP,
  [JOB.STATE.IN_TRANSIT]: ACCESS.OP.ADVANCE_TRANSIT,
  [JOB.STATE.DELIVERED]: ACCESS.OP.ADVANCE_DELIVERED,
  [JOB.STATE.CANCELLED]: ACCESS.OP.CANCEL,
};

exports.deliveryHubAdvance = onCall(
  { region: REGION, timeoutSeconds: 20, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const deliveryId = String((request.data && request.data.deliveryId) || '').trim();
    const to = String((request.data && request.data.to) || '').toUpperCase();
    if (!deliveryId) fail('invalid-argument', 'deliveryId is required.');

    const op = ADVANCE_OP[to];
    /* An unmapped target is refused rather than falling through to a generic permission —
       a state nobody wrote a rule for must not inherit one. */
    if (!op) fail('invalid-argument', 'Unsupported transition: ' + to);

    const ref = db().collection(C_JOBS).doc(deliveryId);

    /* READ, CHECK AND WRITE IN ONE TRANSACTION. This was a plain get, then a decision, then
       a merge — the read-modify-write hole that advanceOrder in notify.js already names and
       closes for order status. Certification caught it here as two concurrent DELIVERED
       calls that BOTH succeeded: two history entries for one event, and two settlement
       attempts on a delivery that happened once. The money survived that because settlement
       has its own transactional guard, but a lifecycle that can move twice is one whose
       history cannot be trusted to reconstruct what occurred.

       Firestore serialises the conflicting writes: one commits, the rest retry, re-read the
       advanced state, and fall out at the transition table as an ordinary refusal. */
    const outcome = await db().runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return { ok: false, code: 'not-found', reason: 'That delivery does not exist.' };
      const job = Object.assign({ deliveryId }, snap.data());

      const allowed = ACCESS.can(job, uid, op);
      if (!allowed.ok) return { ok: false, code: 'permission-denied', reason: allowed.reason };

      /* THE PHYSICAL EVIDENCE GATE. The transition table says which moves are legal; this
         says which of them need a witness. A rider may not mark goods picked up that the
         shop never authorised leaving, and may not mark a delivery delivered that the buyer
         never confirmed receiving — which is the whole reason the money is safe to release. */
      const evidence = HANDOFF.evidenceFor(job, to);
      if (!evidence.ok) {
        return { ok: false, code: 'failed-precondition',
                 reason: evidence.reason + (evidence.detail ? ' — ' + evidence.detail : '') };
      }

      const moved = JOB.transition(job, to, { uid, at: new Date().toISOString() });
      if (!moved.ok) {
        return { ok: false, code: 'failed-precondition',
                 reason: moved.reason + (moved.detail ? ' — ' + moved.detail : '') };
      }

      t.set(ref, { state: moved.job.state, history: moved.job.history, updatedAt: now() },
            { merge: true });
      return { ok: true, job: Object.assign({}, job, moved.job) };
    });

    if (!outcome.ok) fail(outcome.code, outcome.reason);
    const moved = { job: outcome.job };

    /* DELIVERED RELEASES THE MONEY, and only DELIVERED. Best-effort by design: a
       settlement hiccup must not roll back a delivery that physically happened, and the
       settlement is idempotent, so the next attempt finishes it rather than duplicating
       it. The outcome travels back so a caller learns it was held rather than assuming
       it was paid. */
    let settlement = null;
    if (moved.job.state === JOB.STATE.DELIVERED) {
      settlement = await settleDelivery(moved.job)
        .catch((e) => ({ ok: false, reason: 'SETTLEMENT_ERROR', detail: String(e && e.message || e) }));
    }
    return { ok: true, state: moved.job.state, settlement };
  }
);

/* ── 5b. THE PHYSICAL HANDOFFS ─────────────────────────────────────────────
   Two moments, two codes, one direction each: the RIDER shows their code at the counter
   and the SHOP enters it; the BUYER reads their code at the door and the RIDER enters it
   (or the buyer confirms in their own app). Each proves the person was physically there,
   which a button pressed by one party alone cannot. */

function secretKey() {
  try { return SOKONI_HMAC_KEY.value() || null; } catch (_) { return null; }
}

/* The job as it is about to become — assignRider has not been persisted when the codes
   are minted, and binding them to a null rider would bind them to nobody. */
function assignedJob(job, riderUid) {
  return Object.assign({}, job, { assignedRiderUid: String(riderUid) });
}

/**
 * The plaintext code, to the ONE party it belongs to.
 *
 * The verifier of a code may never read it: a shop that could read the departure code
 * could release goods to anyone, and a rider that could read the receipt code could close
 * a delivery from the end of the street. That is why this refuses by ROLE and not merely
 * by party — being on the job is not enough.
 */
exports.deliveryHubMyHandoffPin = onCall(
  { region: REGION, timeoutSeconds: 15, cors: true, secrets: [SOKONI_HMAC_KEY] },
  async (request) => {
    const uid = uidOf(request);
    const job = await loadJob(request.data && request.data.deliveryId);
    enforce(ACCESS.can(job, uid, ACCESS.OP.VIEW_JOB));

    const purpose = String((request.data && request.data.purpose) || '').toUpperCase();
    if (!HANDOFF.PURPOSE[purpose]) fail('invalid-argument', 'Unknown handoff purpose.');

    /* WHO HOLDS WHICH CODE — the inverse of who verifies it. */
    const holder = purpose === HANDOFF.PURPOSE.DEPARTURE
      ? job.assignedRiderUid          /* the rider shows it at the counter */
      : job.customerUid;              /* the buyer reads it at the door   */
    if (!holder || String(holder) !== uid) {
      fail('permission-denied', 'That code is not yours to read.');
    }

    const snap = await db().collection(C_HANDOFF_PINS).doc(job.deliveryId).get();
    if (!snap.exists) fail('not-found', 'No handoff code has been issued for this delivery.');
    const d = snap.data() || {};
    const pin = purpose === HANDOFF.PURPOSE.DEPARTURE ? d.departurePin : d.receiptPin;
    if (!pin) fail('not-found', 'No handoff code has been issued for this delivery.');

    return { ok: true, purpose, pin: String(pin) };
  }
);

/**
 * Confirm that a handoff physically happened.
 *
 * This records EVIDENCE and nothing else. It does not advance the lifecycle and it does
 * not move money — the rider still calls advance, the lifecycle authority still has to
 * accept the transition, and settlement still reads its amounts from the pinned quote.
 * That separation is what stops a compromised UI turning a PIN interaction into a wallet
 * transfer.
 */
exports.deliveryHubConfirmHandoff = onCall(
  { region: REGION, timeoutSeconds: 20, cors: true, secrets: [SOKONI_HMAC_KEY] },
  async (request) => {
    const uid = uidOf(request);
    const deliveryId = String((request.data && request.data.deliveryId) || '').trim();
    const purpose = String((request.data && request.data.purpose) || '').toUpperCase();
    const pin = (request.data && request.data.pin) || '';
    if (!deliveryId) fail('invalid-argument', 'deliveryId is required.');

    const key = secretKey();
    if (!key) fail('failed-precondition', 'NO_SIGNING_KEY');

    const ref = db().collection(C_JOBS).doc(deliveryId);

    /* THE ATTEMPT COUNTER AND THE CONFIRMATION ARE ONE TRANSACTION. Counting outside it
       would let a caller race the budget: five simultaneous guesses each reading zero
       attempts is five free tries, and at six digits that is the difference between a
       bounded and an unbounded search. */
    const outcome = await db().runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return { ok: false, code: 'not-found', reason: 'NO_JOB' };
      const job = Object.assign({ deliveryId }, snap.data());

      const v = HANDOFF.verify({ job, purpose, uid, pin, key, at: new Date().toISOString() });
      if (!v.ok) {
        if (v.countsAsAttempt) {
          const attempts = Object.assign({}, job.handoffAttempts || {});
          attempts[purpose] = Number(attempts[purpose] || 0) + 1;
          t.set(ref, { handoffAttempts: attempts, updatedAt: now() }, { merge: true });
        }
        return { ok: false, code: 'permission-denied', reason: v.reason, detail: v.detail };
      }

      const patch = { updatedAt: now() };
      patch[v.field] = v.confirmation.at;
      patch[v.field + 'By'] = v.confirmation.by;
      /* A successful confirmation clears that purpose's budget: the code was right, so the
         earlier failures were a person mistyping rather than an attacker. */
      const attempts = Object.assign({}, job.handoffAttempts || {});
      attempts[purpose] = 0;
      patch.handoffAttempts = attempts;
      t.set(ref, patch, { merge: true });

      return { ok: true, purpose: v.purpose, role: v.role, at: v.confirmation.at };
    });

    if (!outcome.ok) fail(outcome.code, outcome.reason + (outcome.detail ? ' — ' + outcome.detail : ''));
    return outcome;
  }
);

/* ── 5c. SETTLEMENT ────────────────────────────────────────────────────────
   Applied here, decided in delivery-settlement.js. The split is the point: this function
   knows how to move money and nothing about whether it should. */

/** The rider's BUSINESS, resolved from their uid — never from anything a caller sent. */
async function riderDestination(riderUid) {
  const r = await TENANT.resolveMerchantIdForOwner(String(riderUid), db()).catch(() => null);
  if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'no-business-for-owner' };
  return { ok: true, businessId: r.merchantId };
}

async function settleDelivery(job) {
  const dest = job.assignedRiderUid ? await riderDestination(job.assignedRiderUid)
                                    : { ok: false, reason: 'no-rider' };
  const planned = DSETTLE.plan({ job, riderDestination: dest });
  if (!planned.ok) {
    /* HELD, NOT LOST, and recorded as such. A rider whose business identity does not exist
       yet has earned this money; the delivery record says so and the settlement can be
       completed once the gap is closed. Silently skipping it is how an unpaid rider
       becomes a support ticket nobody can answer. */
    await db().collection(C_JOBS).doc(job.deliveryId).set({
      deliverySettlementHold: { reason: planned.reason, detail: planned.detail || null,
                                missing: planned.missing || null, at: now() },
    }, { merge: true }).catch(() => {});
    return { ok: false, reason: planned.reason, detail: planned.detail || null,
             missing: planned.missing || null };
  }

  const m = planned.movements[0];
  const walletRef = db().collection(BW.WALLETS).doc(m.businessId);
  const entryRef = db().collection(BW.ENTRIES).doc(BW.entryDocId(m.businessId, BW.assertRef(m.ref)));
  const jobRef = db().collection(C_JOBS).doc(job.deliveryId);
  const recRef = db().collection(C_DELIVERY_SETTLEMENTS).doc(job.deliveryId);

  const applied = await db().runTransaction(async (t) => {
    /* ALL READS BEFORE ANY WRITE — Firestore requires it, and a transaction that reads
       after writing throws at commit rather than at the line that did it. */
    const [wSnap, eSnap, jSnap] = await Promise.all([t.get(walletRef), t.get(entryRef), t.get(jobRef)]);

    /* TWO IDEMPOTENCY GUARDS, checked in the same transaction as the write. The entry id
       is deterministic, so a replay through any entry point — this one, or the wallet
       module's own — lands on the same document and credits once. */
    if (eSnap.exists) return { ok: true, credited: false, reason: 'ALREADY_CREDITED' };
    if (jSnap.exists && (jSnap.data() || {}).deliverySettledAt) {
      return { ok: true, credited: false, reason: 'ALREADY_SETTLED' };
    }

    const before = Number((wSnap.exists ? wSnap.data().balanceMinor : 0) || 0);
    const debtBefore = Number((wSnap.exists ? wSnap.data().recoveryDebtMinor : 0) || 0);
    /* The SAME ratified policy every other lane runs: an outstanding reversal debt is paid
       down first, and only the remainder becomes spendable. */
    const move = BW.planMove(+1, {
      amountMinor: m.amountMinor, recovery: true,
      balanceBeforeMinor: before, recoveryDebtBeforeMinor: debtBefore,
    });

    t.set(walletRef, {
      businessId: m.businessId,
      balanceMinor: move.balanceAfterMinor,
      recoveryDebtMinor: move.recoveryDebtAfterMinor,
      currency: 'KES',
      updatedAt: now(),
    }, { merge: true });

    t.set(entryRef, {
      businessId: m.businessId,
      ref: m.ref,
      direction: 'credit',
      amountMinor: m.amountMinor,
      balanceAfterMinor: move.balanceAfterMinor,
      appliedToDebtMinor: move.appliedToDebtMinor,
      reason: m.kind,
      source: 'delivery',
      deliveryId: job.deliveryId,
      orderId: job.orderId || null,
      beneficiaryUid: m.beneficiaryUid,
      createdAt: now(),
    });

    t.set(recRef, Object.assign(DSETTLE.record(planned, new Date().toISOString()), {
      balanceAfterMinor: move.balanceAfterMinor, createdAt: now(),
    }));

    t.set(jobRef, {
      deliverySettledAt: new Date().toISOString(),
      deliverySettlementHold: FieldValueDelete(),
      updatedAt: now(),
    }, { merge: true });

    return { ok: true, credited: true, amountMinor: m.amountMinor,
             businessId: m.businessId, balanceAfterMinor: move.balanceAfterMinor };
  });

  return applied;
}

function FieldValueDelete() { return admin.firestore.FieldValue.delete(); }

/* ── 6. RATING ─────────────────────────────────────────────────────────── */
exports.deliveryHubRate = onCall(
  { region: REGION, timeoutSeconds: 30, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const job = await loadJob(request.data && request.data.deliveryId);
    enforce(ACCESS.can(job, uid, ACCESS.OP.RATE_RIDER));

    const existingSnap = await db().collection(C_RATINGS)
      .where('deliveryId', '==', job.deliveryId).get();
    const existing = existingSnap.docs.map((d) => d.data());

    const built = RATING.submit({
      job, raterUid: uid,
      stars: request.data && request.data.stars,
      comment: request.data && request.data.comment,
      existing,
    });
    enforce(built, 'failed-precondition');

    /* The derived id is what makes a retry converge instead of adding a second vote. */
    await db().collection(C_RATINGS).doc(built.ratingId)
      .set(Object.assign({}, built.rating, { createdAt: now() }));

    /* The aggregate is RECOMPUTED from the verified rows, never incremented. */
    const allSnap = await db().collection(C_RATINGS)
      .where('riderUid', '==', built.rating.riderUid).get();
    const agg = RATING.recompute(allSnap.docs.map((d) => d.data()));

    await db().collection(C_RIDERS).doc(built.rating.riderUid).set({
      rating: agg.rating,
      rated: agg.rated,
      ratedDeliveryCount: agg.ratedDeliveryCount,
      ratingUpdatedAt: now(),
    }, { merge: true });

    return { ok: true, rating: agg.rating, ratedDeliveryCount: agg.ratedDeliveryCount };
  }
);

/* ── 0. WHERE A DELIVERY JOB COMES FROM ────────────────────────────────────
   The first link, and until now the missing one: every other callable in this file
   assumed a job that nothing created, and delivery-quote.js — the authority that decides
   what a delivery pays — was required by no module at all.

   ONE ACT CREATES ONE JOB: a merchant marking their own order ready. The order supplies
   the geography and the parcel, sysConfig/deliveryEconomics supplies the operating
   economics, sysConfig/fuelPrices supplies the live EPRA price, and the quote authority
   turns those into the figure that is PINNED onto the job. After this point the number
   cannot move: a rider agrees to it, a buyer pays it, and the ledger records it.

   IT REFUSES RATHER THAN GUESSES. Every economic input is operator-configured and every
   gap comes back by name — NO_ROAD_DISTANCE_FACTOR, NO_ELECTRICITY_TARIFF,
   NO_VEHICLE_PROFILE. A delivery priced from an assumed maintenance rate is
   indistinguishable from one priced from a real rate, and the difference only appears in
   what a rider takes home.

   IT DOES NOT TOUCH THE LEGACY RAIL. packageRequests and its `deliveryFee * 0.8` still
   exist and are still written by the merchant-ready path; retiring that rail is a
   separate convergence decision, and quietly folding the two together would hide which
   of them paid a rider. */
exports.deliveryHubCreateJob = onCall(
  { region: REGION, timeoutSeconds: 30, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const orderId = String((request.data && request.data.orderId) || '').trim();
    if (!orderId) fail('invalid-argument', 'orderId is required.');

    const orderSnap = await db().collection(C_ORDERS).doc(orderId).get();
    if (!orderSnap.exists) fail('not-found', 'That order does not exist.');
    const order = orderSnap.data() || {};

    /* OWNERSHIP FROM THE ORDER, NEVER FROM THE REQUEST. The seller on the document is
       the only seller who may raise its delivery; a sellerId in the payload would let any
       signed-in account mint a job against somebody else's shop. */
    const sellerUid = String(order.sellerUid || order.sellerId || order.merchantUid || '');
    if (!sellerUid) fail('failed-precondition', 'ORDER_HAS_NO_SELLER');
    if (sellerUid !== uid) fail('permission-denied', 'This order is not yours to dispatch.');

    if (String(order.fulfillmentType || order.deliveryMethod || 'delivery') === 'pickup') {
      fail('failed-precondition', 'PICKUP_HAS_NO_DELIVERY');
    }

    /* THE SAME IDENTIFIER THE REST OF THE PLATFORM ALREADY USES. checkout.html writes
       deliveryRef onto the order and My Orders, admin and the merchant panel all route on
       it, so the Hub job is the same delivery those surfaces mean rather than a second
       one that drifts from them. */
    const deliveryId = String(order.deliveryRef || ('DEL' + orderId));

    const existing = await db().collection(C_JOBS).doc(deliveryId).get();
    if (existing.exists) {
      /* Idempotent by design: marking an order ready twice, or a retry after a network
         failure, must not re-price a delivery a rider may already have accepted. */
      const e = existing.data() || {};
      return { ok: true, created: false, deliveryId, state: e.state,
               pinnedQuote: e.pinnedQuote || null };
    }

    const [shopSnap, cfgSnap, fuelSnap] = await Promise.all([
      db().collection(C_SHOPS).doc(sellerUid).get().catch(() => null),
      db().collection(C_SYSCONFIG).doc('deliveryEconomics').get().catch(() => null),
      db().collection(C_SYSCONFIG).doc('fuelPrices').get().catch(() => null),
    ]);

    const shop = (shopSnap && shopSnap.exists) ? (shopSnap.data() || {}) : {};
    const config = (cfgSnap && cfgSnap.exists) ? (cfgSnap.data() || null) : null;
    const fuel = (fuelSnap && fuelSnap.exists) ? (fuelSnap.data() || null) : null;

    /* GEOGRAPHY IS THE ORDER'S AND THE SHOP'S, never the caller's. A pickup point sent
       in the request would let a shop shorten its own deliveries and be paid for a route
       nobody rides. */
    const pickup = coordsOf(shop.geo) || coordsOf(order.pickupCoords);
    const dropoff = coordsOf(order.deliveryCoords) || coordsOf(order.dropoffCoords);

    /* The vehicle CLASS the parcel needs. Taken from the order when it records one and
       from configuration otherwise — the request may not choose it, because the class
       decides the operating economics and therefore the price. Which individual RIDER
       can take the job is the matching authority's decision at dispatch, not this one. */
    const vehicleType = String(
      order.requiredVehicleType || order.vehicleType ||
      (config && config.route && config.route.defaultVehicleType) || '').toLowerCase();

    const assembled = ECON.inputsFor({
      config, fuel, vehicleType,
      pickup,
      shop: { city: shop.city || shop.town || null },
      destination: dropoff,
      order: {
        packageCount: Array.isArray(order.items) ? order.items.length : Number(order.packageCount) || 1,
        weightKg: Number(order.weightKg) || 0,
        sizeClass: order.sizeClass || 'standard',
        fragile: order.fragile === true,
        specialHandling: order.specialHandling === true,
        zone: order.zone || null,
      },
      /* A measured route wins when one was recorded; nothing measures one today. */
      measuredDistanceKm: Number(order.routeDistanceKm) || null,
      measuredSource: order.routeDistanceSource || null,
    });
    if (!assembled.ok) {
      /* Named, so an operator reads WHICH input is missing rather than 'pricing failed'. */
      fail('failed-precondition', assembled.reason +
           (assembled.detail ? ' — ' + assembled.detail : ''));
    }
    /* Not reached via inputsFor: pickup has no place in the economics resolver, but a
       route was still computed from it. Checked here so the refusal names the real gap. */
    if (!pickup) fail('failed-precondition', 'NO_PICKUP_COORDINATES');

    const priced = QUOTE.quote(Object.assign({}, assembled.input, {
      job: Object.assign({}, assembled.input.job),
    }));
    if (!priced.ok) fail('failed-precondition', priced.reason + (priced.detail ? ' — ' + priced.detail : ''));

    const built = JOB.createJob({
      deliveryId,
      merchantUid: sellerUid,
      /* The buyer, so they are a party to their own delivery. */
      customerUid: order.buyerUid || order.uid || order.customerUid || null,
      quote: priced.quote,
      pickup: Object.assign({ name: shop.name || order.sellerName || 'Shop',
                              area: shop.area || shop.location || null }, pickup || {}),
      dropoff: Object.assign({ area: order.deliveryArea || order.deliveryAddress || null }, dropoff || {}),
      packages: assembled.input.job.packageCount,
      at: new Date().toISOString(),
    });
    enforce(built, 'failed-precondition');

    /* RAISING A DELIVERY IS DECLARING IT READY. createJob opens a job at PACKAGING,
       which is correct as the authority's starting point, but nothing could move it
       on: deliveryHubAdvance maps only pickup, transit, delivered and cancel. A job
       left at PACKAGING can never satisfy LIST_RIDERS or DISPATCH, so the merchant's
       board would have been permanently empty — the same silent dead end as a denied
       listener, reached from the other side.

       The transition is taken through the authority rather than by writing the state,
       so it is checked against the same table every other move is, and both states
       appear in the history a dispute would be settled from. */
    const ready = JOB.transition(built.job, JOB.STATE.READY_FOR_DISPATCH,
                                 { uid, at: new Date().toISOString() });
    enforce(ready, 'failed-precondition');

    const doc = Object.assign({}, ready.job, {
      orderId,
      /* HOW THE PRICE WAS REACHED, kept with the job. When a rider asks why they were
         paid this, the answer is a record rather than 'the algorithm decided'. */
      quoteBasis: {
        route: assembled.routeBasis,
        requiresPolicyReview: priced.quote.guards && priced.quote.guards.configured === false,
        pricedAt: new Date().toISOString(),
      },
      weightKg: Number(order.weightKg) || 0,
      paymentVerified: String(order.paymentStatus || '').toLowerCase() === 'paid',
      createdAt: now(),
    });

    try {
      /* create(), not set(): two concurrent 'mark ready' taps must not both price the
         same delivery, and the loser must lose loudly rather than overwrite a job a
         rider may already be looking at. */
      await db().collection(C_JOBS).doc(deliveryId).create(doc);
    } catch (e) {
      if (e && e.code === 6) {                       /* ALREADY_EXISTS */
        const again = await db().collection(C_JOBS).doc(deliveryId).get();
        const a = again.exists ? (again.data() || {}) : {};
        return { ok: true, created: false, deliveryId, state: a.state,
                 pinnedQuote: a.pinnedQuote || null };
      }
      throw e;
    }

    return {
      ok: true, created: true, deliveryId,
      state: ready.job.state,
      pinnedQuote: ready.job.pinnedQuote,
      requiresPolicyReview: doc.quoteBasis.requiresPolicyReview === true,
    };
  }
);

/* A place, as the three tracking surfaces may see it: where it is and roughly what it is
   called. Never the buyer's full street address — the map pin is what a merchant needs to
   watch a delivery, and the doorstep detail belongs to the rider carrying the parcel and
   to the order itself, not to a tracking card. */
function publicPlace(p) {
  if (!p) return null;
  const c = coordsOf(p);
  const out = { name: p.name || null, area: p.area || null };
  if (c) { out.lat = c.lat; out.lng = c.lng; }
  return out;
}

/* Coordinates or nothing. A half-populated pair is not a location, and letting one
   through would price a delivery against the prime meridian. */
function coordsOf(c) {
  if (!c) return null;
  const lat = Number(c.lat), lng = Number(c.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
/* ── 6b. WHERE THE RIDER IS ────────────────────────────────────────────────
   The rider's movement updates THE SAME delivery job the merchant and the buyer already
   read, rather than a second tracking system beside it. Two position stores would
   disagree the first time one missed an update, and whoever was holding the stale one
   would act on it — which on a delivery means a customer told their parcel is somewhere
   it is not.

   WRITES ARE THROTTLED, and that is a cost decision rather than a privacy one: a phone
   emitting GPS every second would rewrite this document 3,600 times an hour, and every
   merchant and buyer watching it would pay for each of those reads. A ping that is too
   soon or has not moved is ACCEPTED and not stored — reported back honestly as
   stored:false, because a client told its ping failed will simply send it again. */
const PING_MIN_INTERVAL_MS = 15000;   /* engineering, not policy: read/write cost */
const PING_MIN_MOVE_M = 50;           /* below consumer GPS jitter, so noise is not a move */

exports.deliveryHubRiderLocation = onCall(
  { region: REGION, timeoutSeconds: 15, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const job = await loadJob(request.data && request.data.deliveryId);
    enforce(ACCESS.can(job, uid, ACCESS.OP.UPDATE_LOCATION));

    const at = coordsOf(request.data);
    if (!at) fail('invalid-argument', 'A position needs a valid lat and lng.');

    const prev = job.currentLocation || null;
    const nowMs = Date.now();
    if (prev && prev.atMs) {
      const since = nowMs - Number(prev.atMs);
      const moved = ECON.straightLineKm(prev, at) * 1000;
      if (since < PING_MIN_INTERVAL_MS && moved < PING_MIN_MOVE_M) {
        return { ok: true, stored: false, reason: 'THROTTLED',
                 sinceMs: since, movedM: Math.round(moved) };
      }
    }

    /* Only the position and its time. Speed, heading and battery are not asked for and
       not stored: a delivery needs to know where the parcel is, and everything else a
       phone can report is a detail about a person rather than about the job. */
    const currentLocation = {
      lat: at.lat, lng: at.lng,
      accuracyM: Number.isFinite(Number(request.data.accuracyM))
        ? Math.round(Number(request.data.accuracyM)) : null,
      at: new Date(nowMs).toISOString(),
      atMs: nowMs,
    };

    await db().collection(C_JOBS).doc(job.deliveryId)
      .set({ currentLocation, updatedAt: now() }, { merge: true });

    return { ok: true, stored: true, at: currentLocation.at };
  }
);
/* ── 7. ONE TRACKING VIEW, THREE AUDIENCES ─────────────────────────────────
   Merchant, rider and buyer all read the SAME job state. Three independent tracking
   systems would disagree the first time one of them missed an update, and the party
   reading the stale one would act on it. */
exports.deliveryHubTracking = onCall(
  { region: REGION, timeoutSeconds: 20, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const job = await loadJob(request.data && request.data.deliveryId);
    enforce(ACCESS.can(job, uid, ACCESS.OP.VIEW_JOB));

    const role = ACCESS.roleOf(job, uid);
    const panel = JOB.merchantPanel(job);

    let rider = null;
    if (job.assignedRiderUid) {
      const rSnap = await db().collection(C_RIDERS).doc(job.assignedRiderUid).get();
      const r = rSnap.exists ? rSnap.data() : {};
      /* The same merchant-safe projection as the board: a tracking card is not a reason
         to hand out a phone number the dispatch channel exists to avoid needing. */
      rider = {
        displayName: r.displayName || r.name || 'SOKONI Rider',
        vehicleType: r.vehicleType || null,
        numberPlate: r.numberPlate || r.plate || null,
        rating: r.rated ? r.rating : null,
        rated: r.rated === true,
        ratedDeliveryCount: Number(r.ratedDeliveryCount || 0),
      };
    }

    /* THE THREE PINS, and they are not financial figures — a buyer being shown where
       their parcel is does not tell them what the rider earns. The projection that
       matters is the QUOTE below, and it is unchanged.

       currentLocation is present only while the job is live: the access authority stops
       accepting positions at DELIVERED, and continuing to serve the last one afterwards
       would leave a rider's final position readable indefinitely. */
    const live = ['DISPATCHED', 'PICKED_UP', 'IN_TRANSIT'].indexOf(job.state) > -1;

    return {
      ok: true,
      deliveryId: job.deliveryId,
      state: job.state,
      history: job.history || [],
      pickup: publicPlace(job.pickup),
      dropoff: publicPlace(job.dropoff),
      currentLocation: live && job.currentLocation ? {
        lat: job.currentLocation.lat, lng: job.currentLocation.lng,
        at: job.currentLocation.at || null,
        accuracyM: job.currentLocation.accuracyM != null ? job.currentLocation.accuracyM : null,
      } : null,
      role,
      panel: panel.panel,
      chatWritable: panel.chatWritable === true && ACCESS.can(job, uid, ACCESS.OP.POST_MESSAGE).ok,
      rider,
      /* The buyer sees what they are paying; the rider sees what they earn. Both come
         from the same pinned quote, so they cannot disagree. */
      quote: role === ACCESS.ROLE.CUSTOMER
        ? { customerDeliveryFee: job.pinnedQuote && job.pinnedQuote.customerDeliveryFee }
        : job.pinnedQuote || null,
      permitted: ACCESS.permitted(job, uid),
    };
  }
);

module.exports.C_JOBS = C_JOBS;
module.exports.C_MESSAGES = C_MESSAGES;
module.exports.C_RATINGS = C_RATINGS;
