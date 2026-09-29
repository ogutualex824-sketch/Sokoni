/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — WARRANTY & RETURNS POLICY AUTHORITY
   functions/warranty-policy.js

   What a buyer may ask for after a delivery, for how long, and who pays to send the goods
   back. One module, so the seller's product settings, the buyer's options and the refund
   engine cannot disagree about the same purchase.

   ── THE PIN IS NOT A WAIVER ───────────────────────────────────────────────────
   The delivery PIN means "I received the physical goods". It does not mean "I permanently
   give up every claim about them". A buyer confirms receipt at the door, in a few seconds,
   often in the rain — treating that as consent to a defect they have not found yet would
   turn a delivery confirmation into a legal trap.

   So DELIVERED opens the warranty window; it never closes it. That is asserted here as a
   property (`pinIsNotAWaiver`) rather than left as an intention, because it is exactly the
   kind of rule that erodes the first time somebody optimises a state machine.

   ── THE WINDOW STARTS WHEN THE BUYER HAS THE GOODS ────────────────────────────
   Anchored to DELIVERY, not to purchase, and this is a deliberate departure from the
   obvious reading. A 7-day warranty measured from the order date gives the buyer of a
   parcel that took five days to arrive two days of protection, and gives a seller whose
   dispatch is slow a shorter liability than one who ships the same afternoon. Neither is
   what anybody means by "7 days".

   The anchor is configurable, because a seller may have a real reason to run it from
   purchase, and it is RECORDED on the pinned policy so a dispute can be settled by reading
   the order rather than by arguing about intent.

   ── THE POLICY IS PINNED TO THE PURCHASE ──────────────────────────────────────
   A seller who narrows their returns policy on Tuesday must not thereby narrow what they
   promised on Monday. `pinPolicy` freezes a snapshot onto the order, and every later
   question is answered from that snapshot rather than from whatever the product says now.

   ── A BUYER CANNOT ASK FOR WHAT WAS NEVER OFFERED ─────────────────────────────
   Every option the buyer sees comes from the pinned policy. The interface is generated
   from it rather than filtered by it: an option that is refused after being offered is a
   platform that looks broken, and an option that is offered but unenforced is worse.

   PURE. No Firestore, no network. The caller loads the order and persists the outcome.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

/* ── 1. THE VOCABULARY ──────────────────────────────────────────────────────── */

/** What a buyer can be given back. */
const REMEDY = {
  REFUND: 'refund',
  REPLACEMENT: 'replacement',
  REPAIR: 'repair',
  EXCHANGE: 'exchange',
  STORE_CREDIT: 'store_credit',
};

/**
 * Why they are asking, and — crucially — whose mistake it was.
 *
 * FAULT IS A PROPERTY OF THE REASON, not a judgement made later by whoever is reviewing.
 * It decides who pays to send the goods back, and leaving that to a case-by-case decision
 * is how a buyer ends up absorbing a seller's picking error because nobody wrote down
 * whose fault "wrong item" is.
 */
const FAULT = { SELLER: 'SELLER_FAULT', BUYER: 'BUYER_CHOICE', UNDETERMINED: 'UNDETERMINED' };

const REASON = {
  wrong_product:    { label: 'Wrong product',                  fault: FAULT.SELLER },
  damaged:          { label: 'Product damaged',                fault: FAULT.SELLER },
  defective:        { label: 'Product is defective',           fault: FAULT.SELLER },
  missing_item:     { label: 'Missing item',                   fault: FAULT.SELLER },
  not_as_described: { label: 'Different from description',     fault: FAULT.SELLER },
  wrong_variant:    { label: 'Wrong size / colour / model',    fault: FAULT.SELLER },
  incomplete_order: { label: 'Order is incomplete',            fault: FAULT.SELLER },
  changed_mind:     { label: 'Changed my mind',                fault: FAULT.BUYER },
  /* "Other" is genuinely unknown until somebody reads it. It is NOT quietly filed as the
     buyer's fault, because defaulting an unknown to the party with less power is how a
     policy becomes unfair without anybody deciding that it should be. */
  other:            { label: 'Other',                          fault: FAULT.UNDETERMINED },
};

/** A seller who has configured nothing has NOT thereby promised nothing, and has not
    promised everything either — there is simply no policy, and callers must say so. */
const NO_POLICY = null;

const DAY_MS = 86400000;

function refuse(reason, detail) { return { ok: false, reason, detail: detail || null }; }

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/* ── 2. THE SELLER'S SETTINGS ───────────────────────────────────────────────── */

/**
 * Validate and normalise what a seller saved on a product.
 *
 * Unknown remedies and reasons are DROPPED and reported, never kept: a policy carrying a
 * remedy no part of this platform can deliver is a promise to the buyer that nothing will
 * honour.
 */
function normalisePolicy(input) {
  if (!isPlainObject(input)) return refuse('NO_POLICY');

  const days = Number(input.durationDays);
  if (!Number.isFinite(days) || days < 0) return refuse('INVALID_DURATION', String(input.durationDays));
  if (days > 3650) return refuse('IMPLAUSIBLE_DURATION', days + ' days');

  const known = (list, table) => {
    const seen = [], dropped = [];
    (Array.isArray(list) ? list : []).forEach((x) => {
      const k = String(x || '').toLowerCase();
      if (table[k] || Object.values(REMEDY).indexOf(k) > -1) {
        if (seen.indexOf(k) === -1) seen.push(k);
      } else if (k) dropped.push(k);
    });
    return { seen, dropped };
  };

  const remedies = known(input.remedies, {});
  const reasons = known(input.reasons, REASON);

  if (!remedies.seen.length) {
    return refuse('NO_REMEDY_OFFERED',
      'a policy that offers nothing is not a policy — leave it unset instead');
  }
  if (!reasons.seen.length) {
    return refuse('NO_REASON_ACCEPTED',
      'a buyer with no permitted reason can never open a request');
  }

  const anchor = String(input.startsAt || 'delivery').toLowerCase();
  if (['delivery', 'purchase'].indexOf(anchor) === -1) {
    return refuse('UNKNOWN_WINDOW_ANCHOR', anchor);
  }

  return {
    ok: true,
    policy: {
      durationDays: Math.round(days),
      remedies: remedies.seen,
      reasons: reasons.seen,
      startsAt: anchor,
      /* Recorded so a seller can be told what was ignored rather than discovering it when
         a buyer cannot select something they were shown in a settings screen. */
      dropped: remedies.dropped.concat(reasons.dropped),
    },
  };
}

/* ── 3. PINNING IT TO THE PURCHASE ──────────────────────────────────────────── */

/**
 * Freeze the policy onto an order line.
 *
 * The snapshot carries a version and a timestamp so that "which policy applied to this
 * purchase?" is answered by the order, not reconstructed from a product a seller has since
 * edited. Reconstruction is not possible in any case — nothing keeps a product's edit
 * history — which is precisely why this is pinned rather than looked up.
 */
function pinPolicy(policy, at) {
  const n = normalisePolicy(policy);
  if (!n.ok) return n;
  return {
    ok: true,
    pinned: Object.assign({}, n.policy, {
      policyVersion: 'sokoni-warranty-v1',
      pinnedAt: at || new Date().toISOString(),
    }),
  };
}

/* ── 4. THE WINDOW ──────────────────────────────────────────────────────────── */

function parseTime(t) {
  if (!t) return null;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string') { const p = Date.parse(t); return Number.isFinite(p) ? p : null; }
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (t._seconds) return t._seconds * 1000;
  return null;
}

/**
 * Is the warranty window open, and until when?
 *
 * Returns a STATE rather than a boolean: "not yet" and "expired" are different facts and a
 * buyer acts differently on each. A screen that collapsed them into "unavailable" would
 * tell somebody waiting for a parcel that their protection had run out.
 */
function windowFor(input) {
  const { pinned, deliveredAt, purchasedAt, now } = input || {};
  if (!isPlainObject(pinned)) return { ok: false, state: 'NO_POLICY', reason: 'NO_POLICY' };

  const anchorAt = pinned.startsAt === 'purchase' ? parseTime(purchasedAt) : parseTime(deliveredAt);
  if (anchorAt == null) {
    /* NOT AN EXPIRY. The goods have not arrived, so the clock has not started — and telling
       a waiting buyer their window has closed would be both wrong and alarming. */
    return { ok: true, state: 'NOT_STARTED', open: false,
             reason: pinned.startsAt === 'purchase' ? 'NO_PURCHASE_DATE' : 'NOT_DELIVERED_YET',
             anchor: pinned.startsAt };
  }

  const ref = parseTime(now) != null ? parseTime(now) : Date.now();
  const expiresAt = anchorAt + pinned.durationDays * DAY_MS;
  const open = ref <= expiresAt;

  return {
    ok: true,
    state: open ? 'ACTIVE' : 'EXPIRED',
    open,
    anchor: pinned.startsAt,
    startedAt: new Date(anchorAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    /* Rounded UP: a window with four and a half hours left has "1 day" remaining, not 0.
       Rounding down would tell a buyer they had no time on the last day they did. */
    daysRemaining: open ? Math.ceil((expiresAt - ref) / DAY_MS) : 0,
  };
}

/* ── 5. WHAT THE BUYER MAY ASK FOR ──────────────────────────────────────────── */

/**
 * The options to render, generated FROM the pinned policy.
 *
 * The interface is built from this rather than filtered by it. An option that is shown and
 * then refused teaches a buyer the platform is unreliable; an option shown and honoured
 * when it was never offered teaches a seller the same thing.
 */
function optionsFor(pinned) {
  if (!isPlainObject(pinned)) return { ok: false, reason: 'NO_POLICY', reasons: [], remedies: [] };
  return {
    ok: true,
    reasons: pinned.reasons.map((k) => ({
      key: k,
      label: (REASON[k] && REASON[k].label) || k,
      fault: (REASON[k] && REASON[k].fault) || FAULT.UNDETERMINED,
    })),
    remedies: pinned.remedies.slice(),
    policyVersion: pinned.policyVersion || null,
  };
}

/* ── 6. VALIDATING A REQUEST ────────────────────────────────────────────────── */

/**
 * May this buyer open this request, right now, on this purchase?
 *
 * Order of checks matters: the window is decided before the reason, so a buyer whose
 * warranty has expired is told THAT rather than being walked through a form that was
 * always going to be refused.
 */
function validateRequest(input) {
  const { pinned, reason, remedies, deliveredAt, purchasedAt, now, delivered } = input || {};

  if (!isPlainObject(pinned)) {
    return refuse('NO_POLICY', 'this purchase carries no warranty policy');
  }

  /* THE GOODS MUST HAVE ARRIVED. A return of something not yet received is a cancellation,
     which is a different process with different money — conflating them would refund a
     buyer for goods a rider is still carrying. */
  if (delivered !== true) {
    return refuse('NOT_DELIVERED', 'a return applies to goods the buyer has; cancel instead');
  }

  const win = windowFor({ pinned, deliveredAt, purchasedAt, now });
  if (win.state === 'EXPIRED') {
    return refuse('WINDOW_EXPIRED', 'closed ' + win.expiresAt);
  }
  if (win.state !== 'ACTIVE') {
    return refuse('WINDOW_NOT_OPEN', win.reason || win.state);
  }

  const r = String(reason || '').toLowerCase();
  if (!REASON[r]) return refuse('UNKNOWN_REASON', String(reason || ''));
  if (pinned.reasons.indexOf(r) === -1) {
    return refuse('REASON_NOT_ACCEPTED_BY_THIS_SELLER', r);
  }

  const asked = Array.isArray(remedies) ? remedies.map((x) => String(x || '').toLowerCase()) : [];
  if (!asked.length) return refuse('NO_REMEDY_REQUESTED');
  const notOffered = asked.filter((x) => pinned.remedies.indexOf(x) === -1);
  if (notOffered.length) {
    /* Named, because a buyer told "that is not available" without being told WHICH will
       simply try again with the same selection. */
    return refuse('REMEDY_NOT_OFFERED_BY_THIS_SELLER', notOffered.join(', '));
  }

  const fault = REASON[r].fault;
  return {
    ok: true,
    reason: r,
    reasonLabel: REASON[r].label,
    remedies: asked,
    fault,
    returnDelivery: returnDeliveryLiability(fault),
    window: win,
    policyVersion: pinned.policyVersion || null,
  };
}

/* ── 7. WHO PAYS TO SEND IT BACK ────────────────────────────────────────────── */

/**
 * A buyer must not absorb the cost of a seller's fulfilment mistake.
 *
 * If the wrong item arrived, or a damaged one, or fewer than were ordered, the buyer did
 * nothing to cause the second delivery — and making them pay for it turns the seller's
 * error into the buyer's expense. A buyer who simply changed their mind is a different
 * case, and the two are distinguished here rather than argued about per request.
 *
 * UNDETERMINED is held rather than assigned: an unclassified reason with a cost attached
 * would be decided by whoever happened to look at it, and that is not a policy.
 */
function returnDeliveryLiability(fault) {
  if (fault === FAULT.SELLER) {
    return { payer: 'SELLER', settled: 'automatic',
             why: 'the buyer did not cause the second delivery' };
  }
  if (fault === FAULT.BUYER) {
    return { payer: 'BUYER', settled: 'automatic',
             why: 'the goods were as ordered' };
  }
  return { payer: null, settled: 'requires_review',
           why: 'fault is not established by the reason alone' };
}

/* ── 8. THE RULE THAT MUST NOT ERODE ────────────────────────────────────────── */

/**
 * Confirming receipt with a PIN opens the warranty window. It never closes it, shortens it,
 * or narrows what may be claimed.
 *
 * Stated as a function so it can be asserted, because "the PIN is not a waiver" is a
 * sentence that survives in a comment and dies in a refactor.
 */
function pinIsNotAWaiver(before, afterPinConfirmation) {
  const a = isPlainObject(before) ? before : null;
  const b = isPlainObject(afterPinConfirmation) ? afterPinConfirmation : null;
  if (!a || !b) return refuse('NO_POLICY');
  const same = a.durationDays === b.durationDays &&
               a.remedies.length === b.remedies.length &&
               a.remedies.every((x) => b.remedies.indexOf(x) > -1) &&
               a.reasons.length === b.reasons.length &&
               a.reasons.every((x) => b.reasons.indexOf(x) > -1);
  return same
    ? { ok: true, unchanged: true }
    : refuse('PIN_NARROWED_THE_POLICY',
        'confirming receipt of goods is not consent to a defect not yet found');
}

module.exports = {
  REMEDY, REASON, FAULT, NO_POLICY, DAY_MS,
  normalisePolicy, pinPolicy, windowFor, optionsFor, validateRequest,
  returnDeliveryLiability, pinIsNotAWaiver,
};
