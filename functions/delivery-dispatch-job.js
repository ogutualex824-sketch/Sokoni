'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — DELIVERY DISPATCH JOB: LIFECYCLE, PINNING AND THE JOB-SCOPED CHANNEL
   functions/delivery-dispatch-job.js

       PACKAGING → READY_FOR_DISPATCH → RIDER_SEARCH → RIDER_ASSIGNED
                 → DISPATCHED → PICKED_UP → IN_TRANSIT → DELIVERED

   THREE PROPERTIES THIS MODULE EXISTS TO HOLD

   1. THE QUOTE IS PINNED AT DISPATCH.
      Once a rider has been offered a job at a stated earning, that figure is what the
      job pays. Re-deriving it later — from a changed fuel price, a re-measured route, a
      different vehicle — would silently restate what a rider agreed to do the work for,
      and they would find out at settlement. The pinned quote is copied onto the job and
      every later reader takes it from there.

   2. THE CHANNEL BELONGS TO THE JOB, NOT TO THE PEOPLE.
      A seller and a rider can talk because THIS delivery connects them. Not before it
      exists, not after someone else takes it, and never as general messaging between two
      accounts the platform introduced. Participation is recomputed from the job's current
      assignment on every post, so a rider who declined or was replaced stops being able
      to write the moment that is true — no revocation step to forget.

   3. THE CONVERSATION IS NOT DESTROYED WHEN THE UI CLOSES.
      The merchant's popup collapsing into "delivery in progress" is a VIEW change. The
      messages and transitions stay attached to the delivery record, because a dispute
      about what was agreed at pickup is exactly when someone needs them, and that is
      always after the panel has gone.

   PURE. No Firestore, no network. It decides; callers persist.
   ══════════════════════════════════════════════════════════════════════════════ */

const STATE = {
  PACKAGING: 'PACKAGING',
  READY_FOR_DISPATCH: 'READY_FOR_DISPATCH',
  RIDER_SEARCH: 'RIDER_SEARCH',
  RIDER_ASSIGNED: 'RIDER_ASSIGNED',
  DISPATCHED: 'DISPATCHED',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
};

/* Forward transitions only, plus the two terminal exits. A lifecycle that can move
   backwards can re-open a delivered job, and a job that can be re-delivered can be paid
   for twice. */
const ALLOWED = {
  [STATE.PACKAGING]: [STATE.READY_FOR_DISPATCH, STATE.CANCELLED],
  /* RIDER_ASSIGNED is reachable DIRECTLY from here, because that is what dispatching a
     packed order is: the merchant opens the board and picks somebody. Leaving it out
     made the normal path impossible — assignRider's own guard admits READY_FOR_DISPATCH
     and so does the access table, and this row was the only one of the three that
     disagreed, so every dispatch of a ready job refused with ILLEGAL_TRANSITION. It
     went unnoticed because the authority's own suite dispatched from RIDER_SEARCH.

     RIDER_SEARCH remains a real state, not a formality: it is where a job sits after a
     rider declines, waiting to be offered again. */
  [STATE.READY_FOR_DISPATCH]: [STATE.RIDER_SEARCH, STATE.RIDER_ASSIGNED, STATE.CANCELLED],
  /* RIDER_SEARCH may return to READY_FOR_DISPATCH: every candidate declining is a normal
     outcome, not a failure, and the seller must be able to try again. */
  [STATE.RIDER_SEARCH]: [STATE.RIDER_ASSIGNED, STATE.READY_FOR_DISPATCH, STATE.CANCELLED, STATE.FAILED],
  /* An assigned rider who cancels returns the job to the board rather than killing it. */
  [STATE.RIDER_ASSIGNED]: [STATE.DISPATCHED, STATE.RIDER_SEARCH, STATE.CANCELLED],
  [STATE.DISPATCHED]: [STATE.PICKED_UP, STATE.RIDER_SEARCH, STATE.CANCELLED, STATE.FAILED],
  [STATE.PICKED_UP]: [STATE.IN_TRANSIT, STATE.FAILED],
  /* After pickup the goods are with the rider. There is no path back to the board: the
     job can only complete or fail, and a failure is a real event with real goods. */
  [STATE.IN_TRANSIT]: [STATE.DELIVERED, STATE.FAILED],
  [STATE.DELIVERED]: [],
  [STATE.CANCELLED]: [],
  [STATE.FAILED]: [],
};

const TERMINAL = [STATE.DELIVERED, STATE.CANCELLED, STATE.FAILED];

/* States in which the seller and the assigned rider may talk. Before assignment there is
   nobody to talk to; after a terminal state the record is closed to new messages while
   remaining readable. */
const CHAT_OPEN = [STATE.RIDER_ASSIGNED, STATE.DISPATCHED, STATE.PICKED_UP, STATE.IN_TRANSIT];

/* Where the merchant's dispatch panel gives way to tracking. The popup does not close
   because the conversation ended — it closes because the job moved on. */
const PANEL = { DISPATCH: 'DISPATCH_PANEL', TRACKING: 'TRACKING_CARD', NONE: 'NONE' };

function refuse(reason, detail) { return { ok: false, reason, detail: detail || null }; }

/* ── 1. CREATING THE JOB — the quote is pinned here ────────────────────────── */
function createJob(input) {
  const { deliveryId, merchantUid, customerUid, quote, pickup, dropoff, packages, at } = input || {};
  if (!deliveryId) return refuse('NO_DELIVERY_ID');
  if (!merchantUid) return refuse('NO_MERCHANT');
  if (!quote || !Number.isFinite(Number(quote.riderGross)) ||
      !Number.isFinite(Number(quote.customerDeliveryFee))) {
    /* A job created without a priced quote would reach a rider with no earning to state,
       and the earning is the thing they are being asked to agree to. */
    return refuse('NO_PINNED_QUOTE');
  }
  if (!quote.pricingVersion) return refuse('QUOTE_HAS_NO_PRICING_VERSION');

  return {
    ok: true,
    job: {
      deliveryId: String(deliveryId),
      merchantUid: String(merchantUid),
      /* The buyer is a party to their own delivery. The access authority resolves the
         CUSTOMER role from this field, so a job created without it makes every buyer
         NOT_A_PARTY to the delivery they paid for. Null is legitimate — a counter
         collection has no buyer to track it. */
      customerUid: customerUid ? String(customerUid) : null,
      state: STATE.PACKAGING,
      /* PINNED. A copy, not a reference — a later edit to the source quote must not
         restate what this job pays. */
      pinnedQuote: {
        pricingVersion: quote.pricingVersion,
        riderGross: Math.round(Number(quote.riderGross)),
        customerDeliveryFee: Math.round(Number(quote.customerDeliveryFee)),
        sokoniCommission: Math.round(Number(quote.sokoniCommission)),
        sokoniSharePct: quote.sokoniSharePct != null ? Number(quote.sokoniSharePct) : null,
        vehicleType: quote.vehicleType || null,
        vehicleClass: quote.vehicleClass || null,
        distanceKm: quote.distanceKm != null ? Number(quote.distanceKm) : null,
        estimatedMinutes: quote.estimatedMinutes != null ? Number(quote.estimatedMinutes) : null,
        energyBasis: quote.energyBasis || null,
        pinnedAt: at || new Date().toISOString(),
      },
      pickup: pickup || null,
      dropoff: dropoff || null,
      packages: Array.isArray(packages) ? packages.length : Number(packages) || 1,
      assignedRiderUid: null,
      history: [{ state: STATE.PACKAGING, at: at || new Date().toISOString(), by: String(merchantUid) }],
    },
  };
}

/* ── 2. TRANSITIONS ───────────────────────────────────────────────────────── */
function transition(job, next, actor) {
  if (!job || !job.state) return refuse('NO_JOB');
  const from = job.state;
  const to = String(next || '').toUpperCase();
  if (!STATE[to]) return refuse('UNKNOWN_STATE', to);
  if (TERMINAL.indexOf(from) > -1) {
    return refuse('TERMINAL_STATE', from + ' cannot be left');
  }
  if ((ALLOWED[from] || []).indexOf(to) === -1) {
    return refuse('ILLEGAL_TRANSITION', from + ' -> ' + to);
  }
  /* A job cannot be ASSIGNED to nobody, nor dispatched to nobody. RIDER_ASSIGNED was
     reachable by transition alone, which meant a job could sit in the state that says
     a rider has it while no rider had it — and the job-scoped channel would open to a
     party that did not exist. assignRider() is the only legitimate way in. */
  if ((to === STATE.RIDER_ASSIGNED || to === STATE.DISPATCHED) && !job.assignedRiderUid) {
    return refuse('NO_ASSIGNED_RIDER');
  }
  const at = (actor && actor.at) || new Date().toISOString();
  return {
    ok: true,
    job: Object.assign({}, job, {
      state: to,
      history: (job.history || []).concat([{ state: to, at, by: (actor && actor.uid) || null }]),
    }),
  };
}

/* ── 3. ASSIGNMENT — the earning is never renegotiated ────────────────────── */
function assignRider(job, riderUid, offeredEarningKES, actor) {
  if (!job) return refuse('NO_JOB');
  if (!riderUid) return refuse('NO_RIDER');
  if ([STATE.RIDER_SEARCH, STATE.READY_FOR_DISPATCH].indexOf(job.state) === -1) {
    return refuse('NOT_SEARCHING', job.state);
  }
  /* The offer a rider sees must be the pinned figure. A dispatch that could offer a
     different number would make the quote advisory, and the rider's agreement would be
     to something the ledger never recorded. */
  if (offeredEarningKES != null &&
      Math.round(Number(offeredEarningKES)) !== job.pinnedQuote.riderGross) {
    return refuse('EARNING_RENEGOTIATED',
      offeredEarningKES + ' != pinned ' + job.pinnedQuote.riderGross);
  }
  const assigned = Object.assign({}, job, { assignedRiderUid: String(riderUid) });
  return transition(assigned, STATE.RIDER_ASSIGNED, actor);
}

/* ── 4. THE JOB-SCOPED CHANNEL ────────────────────────────────────────────── */
function canParticipate(job, uid) {
  if (!job || !uid) return { ok: false, reason: 'NO_JOB_OR_UID' };
  const u = String(uid);
  const isMerchant = u === String(job.merchantUid);
  const isRider = !!job.assignedRiderUid && u === String(job.assignedRiderUid);
  if (!isMerchant && !isRider) {
    /* Not a party to THIS delivery. Being a seller, or a rider, or having spoken on a
       previous job together, grants nothing here. */
    return { ok: false, reason: 'NOT_A_PARTY' };
  }
  return { ok: true, role: isMerchant ? 'merchant' : 'rider' };
}

function postMessage(job, uid, text) {
  const p = canParticipate(job, uid);
  if (!p.ok) return refuse(p.reason);
  if (CHAT_OPEN.indexOf(job.state) === -1) {
    /* Closed for WRITING, not for reading. */
    return refuse('CHANNEL_NOT_OPEN', job.state);
  }
  const body = String(text == null ? '' : text).trim();
  if (!body) return refuse('EMPTY_MESSAGE');
  if (body.length > 2000) return refuse('MESSAGE_TOO_LONG', body.length + ' chars');
  return {
    ok: true,
    message: {
      deliveryId: job.deliveryId,
      from: String(uid),
      role: p.role,
      text: body,
      at: new Date().toISOString(),
      /* DENORMALISED so a security rule can scope the read without loading the job —
         the same convention booking-events.js uses for providerId/customerUid. The
         alternative, a get() on the job per message, bills a read for every rule
         evaluation on a channel whose whole point is to be cheap and short. */
      participants: [String(job.merchantUid), job.assignedRiderUid ? String(job.assignedRiderUid) : null]
        .filter(Boolean),
    },
  };
}

/* Reading is broader than writing, and deliberately so: a closed job's conversation must
   remain available to its parties, because a dispute about what was agreed at pickup
   surfaces after the job has ended. */
function canRead(job, uid) {
  return canParticipate(job, uid);
}

/* ── 5. WHAT THE MERCHANT'S WORKSPACE SHOWS ───────────────────────────────── */
function merchantPanel(job) {
  if (!job) return { panel: PANEL.NONE };
  switch (job.state) {
    case STATE.PACKAGING:
    case STATE.READY_FOR_DISPATCH:
    case STATE.RIDER_SEARCH:
    case STATE.RIDER_ASSIGNED:
      return { panel: PANEL.DISPATCH, chatWritable: CHAT_OPEN.indexOf(job.state) > -1 };
    case STATE.DISPATCHED:
    case STATE.PICKED_UP:
    case STATE.IN_TRANSIT:
      /* The panel gives way to tracking. The conversation is still there — it is simply
         no longer occupying the workspace. */
      return { panel: PANEL.TRACKING, chatWritable: true, collapsedFromDispatch: true };
    default:
      return { panel: PANEL.NONE, chatWritable: false };
  }
}

module.exports = {
  createJob, transition, assignRider,
  canParticipate, canRead, postMessage, merchantPanel,
  STATE, ALLOWED, TERMINAL, CHAT_OPEN, PANEL,
};
