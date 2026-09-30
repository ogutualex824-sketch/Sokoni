'use strict';
/* ══════════════════════════════════════════════════════════════════════════════════════
   SOKONI — THE CANONICAL LOYALTY EVENT
   ══════════════════════════════════════════════════════════════════════════════════════
   One schema, one set of accounting semantics, one place that decides whether an event can
   be written at all.

   WHY THIS EXISTS. L4 measured the ledger and found it unable to support accounting: across
   13 writers the rate appeared on 1, the rate VERSION on 0, the source rail on 0. An event
   that records a points delta but not what valued it, or which rail produced it, cannot be
   explained afterwards — and an aggregate built on it renders a number that looks like a
   measurement and is not one.

   WHAT THIS DOES NOT DO.

     · It does not retrofit the 13 historical writers. L4 established that historical rate,
       version, rail, business and store provenance cannot be reconstructed. Manufacturing
       them would turn an honest gap into a false record. Historical events remain
       HISTORICALLY INCOMPLETE, and the aggregate says so rather than averaging over it.

     · It does not invent `businessId` or `shopId`. Production orders carry neither, so no
       authoritative value exists. They are absent, and absence is reported.

     · It does not decide the commercial rate. 10 vs 100 points per KES is a business
       decision; this module records WHICH rate was used, never which rate is right.

   FAIL CLOSED. A producer that cannot establish a required authority does not get to write a
   partial event with the missing parts blank — `buildEvent` throws. A blank field in an
   accounting record is indistinguishable from a measured value later, which is the defect
   this module exists to end.
   ══════════════════════════════════════════════════════════════════════════════════════ */

/* ── SOURCE RAIL ─────────────────────────────────────────────────────────────────────
   The rail is a fact about WHICH AUTHORITY produced the event, so it is a closed set chosen
   by the server. A caller never supplies it: a browser that could name its own rail could
   make an online self-award look like a till transaction, and rail-scoped totals would then
   describe nothing. */
const RAIL = Object.freeze({
  ONLINE: 'online',      /* awardLoyaltyPoints — bound to orders/{id}.sellerUid            */
  POS:    'pos',         /* the till: pos-zero-friction earn, pos-loyalty-redemption burn  */
  ADMIN:  'admin',       /* adminAdjustPoints — an operator correction                     */
  SYSTEM: 'system',      /* expiry sweeps and other unattended platform producers          */
});
const RAILS = Object.freeze(Object.values(RAIL));

/* ── ACCOUNTING SEMANTICS ────────────────────────────────────────────────────────────
   Every type the ledger writes, with what it MEANS to the books.

   `sign` is deliberately three-valued. Assuming a type is inherently positive or negative is
   how `void` and `adjust` get mis-added: a void of a redemption RETURNS points, a void of an
   earn REMOVES them, and an operator adjustment goes either way. For those the stored delta
   is the authority and the aggregate must read it rather than assume it.

     ISSUE    points created           REDEEM   points spent
     EXPIRE   points lapsed            REVERSE  a prior event undone
     ADJUST   an operator correction

   A type absent from this table is UNKNOWN: the aggregate counts it separately and refuses to
   fold it into a total, because silently treating an unrecognised type as zero is the same
   defect as treating a failed query as zero. */
const SEMANTICS = Object.freeze({
  earn:                   { klass: 'ISSUE',   sign: 'POSITIVE' },
  welcome:                { klass: 'ISSUE',   sign: 'POSITIVE' },
  referral:               { klass: 'ISSUE',   sign: 'POSITIVE' },
  birthday:               { klass: 'ISSUE',   sign: 'POSITIVE' },
  lucky_draw_win:         { klass: 'ISSUE',   sign: 'POSITIVE' },
  visit_frequency_reward: { klass: 'ISSUE',   sign: 'POSITIVE' },
  tier_upgrade:           { klass: 'ISSUE',   sign: 'POSITIVE' },
  redeem:                 { klass: 'REDEEM',  sign: 'NEGATIVE' },
  expire:                 { klass: 'EXPIRE',  sign: 'NEGATIVE' },
  void:                   { klass: 'REVERSE', sign: 'FROM_DELTA' },
  adjust:                 { klass: 'ADJUST',  sign: 'FROM_DELTA' },
});
const TYPES = Object.freeze(Object.keys(SEMANTICS));

/** The accounting class of a type, or null when the type is not recognised. */
function classOf(type) {
  const s = SEMANTICS[String(type)];
  return s ? s.klass : null;
}

/**
 * The signed points movement an event contributes to a balance.
 *
 * Returns `null` for an unrecognised type — the caller must then treat the event as
 * UNCLASSIFIED rather than as zero. Zero and "I do not know" are different answers and
 * collapsing them is the defect L4 named.
 */
function signedPoints(event) {
  const s = SEMANTICS[String(event && event.type)];
  if (!s) return null;
  const raw = Number(event.points);
  if (!Number.isFinite(raw)) return null;
  if (s.sign === 'POSITIVE') return Math.abs(raw);
  if (s.sign === 'NEGATIVE') return -Math.abs(raw);
  return raw;                       /* FROM_DELTA — the stored sign is the authority */
}

const REQUIRED = ['type', 'rail', 'customerUid', 'merchantId', 'points', 'idempotencyKey'];

/**
 * Build a canonical loyalty event, or throw.
 *
 * @param o.type            one of TYPES
 * @param o.rail            one of RAILS — supplied by the PRODUCER, never by a caller
 * @param o.customerUid     the account the points move on
 * @param o.merchantId      resolved server-side; never read from a request
 * @param o.points          magnitude; sign is applied by signedPoints() per semantics
 * @param o.idempotencyKey  the event identity
 * @param o.orderRef        originating order/sale, where the producer has one
 * @param o.valueKES        KES valuation, where one legitimately exists
 * @param o.rate            KES per point, from rewards-rate.normalizeRewardsRate
 * @param o.rateVersion     which configuration produced that rate
 * @param o.actor           the principal responsible
 * @param o.reversalOf      the event this one undoes
 * @param o.at              server timestamp
 */
function buildEvent(o) {
  const e = o || {};

  for (const k of REQUIRED) {
    const v = e[k];
    if (v === undefined || v === null || v === '') {
      throw new Error('loyalty event refused: ' + k + ' is required and was not established');
    }
  }
  if (!SEMANTICS[e.type]) {
    throw new Error('loyalty event refused: unknown type "' + e.type + '"');
  }
  if (RAILS.indexOf(e.rail) === -1) {
    throw new Error('loyalty event refused: rail "' + e.rail + '" is not a server-defined rail');
  }
  if (!Number.isFinite(Number(e.points))) {
    throw new Error('loyalty event refused: points is not a finite number');
  }

  /* A VALUATION MUST CARRY ITS RATE AND THAT RATE'S VERSION.
     A KES figure whose rate is unknown cannot be checked, re-derived or explained, and it is
     precisely the field L4 found on 7 of 13 writers with no way to interpret it. Either all
     three travel together or none does. */
  const hasValue = e.valueKES !== undefined && e.valueKES !== null;
  if (hasValue) {
    if (!Number.isFinite(Number(e.valueKES))) {
      throw new Error('loyalty event refused: valueKES is not a finite number');
    }
    if (!Number.isFinite(Number(e.rate)) || Number(e.rate) <= 0) {
      throw new Error('loyalty event refused: a KES valuation requires the rate that produced it');
    }
    if (!e.rateVersion) {
      throw new Error('loyalty event refused: a KES valuation requires its rate version');
    }
  }

  /* A reversal that does not name what it reverses cannot be reconciled. */
  if (classOf(e.type) === 'REVERSE' && !e.reversalOf) {
    throw new Error('loyalty event refused: a reversal must name the event it reverses');
  }

  const doc = {
    type:           String(e.type),
    klass:          classOf(e.type),
    rail:           String(e.rail),
    uid:            String(e.customerUid),
    merchantId:     String(e.merchantId),
    points:         Number(e.points),
    idempotencyKey: String(e.idempotencyKey),
    schemaVersion:  1,
    createdAt:      e.at || null,
  };

  /* OPTIONAL, AND ABSENT WHEN NOT ESTABLISHED — never defaulted to zero or to a placeholder.
     `businessId` and `shopId` appear nowhere: production orders carry neither, so no
     authoritative value exists, and inventing one would manufacture provenance. They stay
     unresolved until the Store/Business identity gate settles them. */
  if (hasValue) {
    doc.valueKES = Number(e.valueKES);
    doc.rate = Number(e.rate);
    doc.rateVersion = String(e.rateVersion);
  }
  if (e.orderRef) doc.orderRef = String(e.orderRef);
  if (e.actor) doc.actor = String(e.actor);
  if (e.reversalOf) doc.reversalOf = String(e.reversalOf);

  return doc;
}

module.exports = {
  RAIL, RAILS, TYPES, SEMANTICS,
  classOf, signedPoints, buildEvent,
};
