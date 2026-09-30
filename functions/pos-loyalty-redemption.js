/* ══════════════════════════════════════════════════════════════════════════════════════
   POS POINTS REDEMPTION — the server decides what points are worth, and when they burn.
   ══════════════════════════════════════════════════════════════════════════════════════
   WHAT WAS WRONG. pos-checkout.html computed a redemption value in the browser, subtracted
   it from the total it displayed, and then sent `discountTotal` WITHOUT it. The server's
   authoritative total carried no loyalty term at all, so the two figures disagreed by
   exactly the points value and posCompleteCheckout refused the sale with "Total mismatch".

   Points redemption at the till has therefore never worked. It failed CLOSED — it never
   undercharged, and the refusal fires at line 722, long before the points burn at line 967,
   so no customer ever lost points either. A dead feature rather than a money hole, which is
   the good version of this bug and the reason it can be repaired calmly.

   WHY THIS IS A NEW AUTHORITY AND NOT THE EXISTING ONE. `loyalty.js` already has a
   well-built `redeemLoyaltyPoints`: atomic, idempotent through `loyaltyLedger`, a real
   balance check, a server-owned rate. It cannot be used here, and the reason is identity,
   not collections:

       redeemLoyaltyPoints  ->  loyaltyAccounts/{auth.uid}.balance
       the POS              ->  posCustomers/{sellerId}_{phone}.loyaltyPoints

   At a till the authenticated principal is the CASHIER. Calling that callable from POS
   would read, and debit, the cashier's own balance and approve a discount against it. The
   POS customer is keyed by seller and phone and carries no uid, so no mapping exists to
   translate between them — and inventing one is an identity decision this module has no
   standing to make. Two authorities, each sound over its own subject; convergence is a
   separate piece of work with a migration attached.

   ── THE TWO RULES THIS FILE EXISTS TO ENFORCE ────────────────────────────────────────

   1. THE BROWSER NEVER SUPPLIES THE VALUE. It may ask to spend N points. What N is WORTH
      is read from `loyaltyPrograms/{merchantId}` on the server — the same document the
      earn side already uses, so a merchant cannot have one rate for giving and another for
      taking. A client-supplied KES figure is not merely distrusted here; it is never a
      parameter, so there is nothing to distrust.

   2. POINTS BURN WITH THE SALE OR NOT AT ALL. This module performs NO reads and NO writes
      of its own. `authorize()` is pure and consumes snapshots the sale transaction has
      already taken; `ledgerEntry()` returns a document for the caller to write inside that
      same transaction. So the burn is committed by the sale's own atomic commit: a sale
      that fails validation, fails payment, or loses a contention retry cannot leave points
      spent. That ordering is the whole design, not an implementation detail.

   Being read-free also means it cannot violate Firestore's reads-before-writes rule when
   dropped into an existing transaction — a module that quietly issued a read here would
   break every sale, including the ones with no points at all.
   ══════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

/* Where the liability is recorded. SEPARATE from the balance on purpose: the balance says
   what a customer can still spend, the ledger says what was spent and against which sale.
   A balance alone cannot be reconciled or reversed. */
const LEDGER = 'posLoyaltyLedger';

/* THE SOKONI RATE — 100 points = KES 10, i.e. 10 points = KES 1.
   Expressed here as KES per point, because that is the unit the programme document and the
   till engine both use.

       100 pts = KES 10        1,000 pts = KES 100        10,000 pts = KES 1,000

   Deliberately NOT inherited from pos-loyalty-engine.js, which defaults to 0.5 — five times
   this rate, and one corner of a three-way disagreement about what a point is worth:

       pos-loyalty-engine.js:91  pointValue 0.5       ->  100 pts = KES 50   5x too generous
       loyalty.js:167            redemptionRate 100   ->  100 pts = KES 1    10x too mean
       loyalty.js:184            redemptionRate 10    ->  100 pts = KES 10   the SOKONI rate

   A default is not cosmetic: it is what every merchant who never opens the loyalty settings
   actually redeems at. At 0.5 an unconfigured shop hands over fifty shillings for a hundred
   points the platform prices at ten.

   loyalty.js is the CUSTOMER-account authority over a different document
   (loyaltyMerchantConfigs) and a different subject, and is out of this slice's scope — its
   internal 100-vs-10 disagreement is reported, not silently corrected here.

   Points are a REDEMPTION VALUE against a purchase, never cash a customer may withdraw,
   which is why this lives beside the redemption authority and not in a wallet. */
const DEFAULT_POINT_VALUE = 0.1;
/* A ceiling on how much of one sale points may settle. Absent an explicit merchant setting
   the whole sale may be paid in points — that is the existing engine's behaviour and this
   module does not silently tighten a commercial term it was not asked to change. */
const DEFAULT_MAX_PCT = 100;
/* Matches pos-loyalty-engine.js's own default, so the till and the authority refuse the
   same small redemptions rather than disagreeing about the total. */
const DEFAULT_MIN_REDEEM = 50;

const REASON = {
  NO_CUSTOMER:   'points-require-an-identified-customer',
  NO_PROGRAM:    'no-loyalty-programme-for-this-merchant',
  NOT_POSITIVE:  'points-requested-must-be-a-positive-whole-number',
  INSUFFICIENT:  'insufficient-points',
  NO_VALUE:      'this-programme-gives-points-no-cash-value',
  NOTHING_TO_PAY:'nothing-left-to-redeem-against',
  BELOW_MINIMUM: 'below-the-minimum-redemption-for-this-programme',
};

function _int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : NaN;
}
function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * Decide what a redemption is worth and whether it may proceed. PURE — no reads, no writes,
 * no clock, no randomness. Every input is a snapshot the sale transaction already holds.
 *
 * @param custSnap          the posCustomers doc snapshot (already read by the sale)
 * @param progSnap          the CANONICAL loyaltyMerchantConfigs/{merchantId} snapshot
 * @param pointsRequested   what the CLIENT asked to spend — a count, never a KES figure
 * @param redeemableBaseKES the sale amount points may be applied against, server-computed
 *
 * `progSnap` was loyaltyPrograms/{merchantId}, and that document is CLIENT-WRITTEN with no
 * Firestore rule at all — so the write is denied, the document cannot exist, and this
 * authority refused every redemption in production while passing every test that seeded it.
 * It now reads the canonical config, which is written only by a _requireMerchant-guarded
 * callable through the admin SDK and is read-only to clients.
 *
 * An ABSENT config is no longer a refusal. A merchant who has never opened the rewards
 * settings redeems at the platform rate, because refusing them was the operability bug.
 *
 * @returns { ok, approvedPoints, approvedKES, balanceBefore, balanceAfter, pointValue, reason }
 *
 * `ok:false` with approvedPoints 0 means "do not redeem" — the caller prices the sale with
 * no loyalty term. It is NOT an error for a sale that asked for nothing: requesting zero
 * points is the ordinary case and returns a clean zero result, so the no-points path stays
 * behaviourally identical to what it was before this module existed.
 */
function authorize({ custSnap, progSnap, pointsRequested, redeemableBaseKES }) {
  const none = (reason) => ({
    ok: false, approvedPoints: 0, approvedKES: 0,
    balanceBefore: null, balanceAfter: null, pointValue: null, rateVersion: null,
    reason: reason || null,
  });

  const req = _int(pointsRequested);
  /* Asking for nothing is not a failure, and must not be reported as one. */
  if (!pointsRequested || req === 0) return none(null);
  if (!Number.isFinite(req) || req < 0) return none(REASON.NOT_POSITIVE);

  if (!custSnap || !custSnap.exists) return none(REASON.NO_CUSTOMER);

  const base = Number(redeemableBaseKES);
  if (!Number.isFinite(base) || base <= 0) return none(REASON.NOTHING_TO_PAY);

  const cust = custSnap.data() || {};

  /* THE RATE COMES THROUGH THE NORMALISATION BOUNDARY, AND ONLY THROUGH IT.
     The canonical document stores `redemptionRate` in POINTS PER KES; everything here
     prices in KES PER POINT. Those are reciprocals, so reading the field directly would
     invert the rate rather than convert it — 10 points per shilling silently becoming ten
     shillings per point. normalizeRewardsRate performs that inversion exactly once, for
     every consumer, which is the entire reason it exists.

     An absent config yields the platform rate rather than a refusal. */
  const _rates = require('./rewards-rate');
  const norm = _rates.normalizeRewardsRate(progSnap && progSnap.exists ? progSnap.data() : null);
  const rate = norm.pointValueKES;
  if (!(rate > 0)) return none(REASON.NO_VALUE);
  const points = (progSnap && progSnap.exists && progSnap.data() && progSnap.data().points) || {};

  const balanceBefore = _int(cust.loyaltyPoints) || 0;
  if (req > balanceBefore) return none(REASON.INSUFFICIENT);

  /* THE SAME FLOOR THE TILL APPLIES. pos-loyalty-engine.js refuses to redeem below
     `minRedeem` (default 50), and a server that ignored it would approve a redemption the
     client would never offer — the two would then disagree about the total and the
     mismatch guard would refuse the sale. Read from the same programme document, so the
     floor cannot drift between the screen and the authority. */
  const minRedeem = Number(points.minRedeem);
  const floor = Number.isFinite(minRedeem) && minRedeem > 0 ? minRedeem : DEFAULT_MIN_REDEEM;
  if (req < floor) return none(REASON.BELOW_MINIMUM);

  /* How much of THIS sale points are allowed to settle. */
  /* THE CEILING IS CANONICAL TOO. This read `points.maxRedemptionPct` off the POS-only
     document and fell back to 100 — the whole bill payable in points — while the customer
     authority capped at 50. That is a business rule, and two authorities holding different
     answers to "how much of a bill may points settle" is the same split brain as the rate.
     It now comes through the same boundary, from the same document. */
  const maxPct = norm.maxRedemptionPct;
  const capKES = _round2(base * maxPct / 100);

  /* Value the request, then clamp it to what the sale can absorb. Points beyond the cap are
     NOT spent — a customer must never burn points that bought nothing. The approved point
     count is recomputed from the approved cash so the two always agree exactly, and it is
     floored rather than rounded up so the customer is never charged an extra point for a
     fraction of a shilling. */
  const wantedKES   = _round2(req * rate);
  const approvedKES = _round2(Math.min(wantedKES, capKES));
  if (!(approvedKES > 0)) return none(REASON.NOTHING_TO_PAY);

  const approvedPoints = Math.min(req, Math.floor(_round2(approvedKES / rate)));
  if (!(approvedPoints > 0)) return none(REASON.NOTHING_TO_PAY);

  /* Re-value the FINAL point count, so the cash figure can never exceed what those points
     are worth even when the cap forced a reduction. */
  const finalKES = _round2(Math.min(approvedKES, _round2(approvedPoints * rate)));

  return {
    ok: true,
    approvedPoints,
    approvedKES: finalKES,
    balanceBefore,
    balanceAfter: balanceBefore - approvedPoints,
    pointValue: rate,
    /* The configuration that produced `rate`. Carried out with it so the event can record
       WHICH rate valued the burn, rather than leaving a later reader to re-derive it from
       whatever the configuration says by then. */
    rateVersion: norm.rateVersion,
    reason: null,
  };
}

/**
 * The liability document for an authorised redemption. Returned, never written — the caller
 * writes it inside the sale's own transaction so the burn and the sale commit together.
 *
 * Keyed on the sale's idempotency key, so a replayed sale cannot spend points twice: the
 * document id is the same and the write is an overwrite of an identical record rather than
 * a second deduction.
 */
function ledgerEntry({ idempotencyKey, merchantId, customerId, saleId, authorized, at }) {
  const _EV = require('./loyalty-event');
  return {
    id: String(idempotencyKey),
    doc: {
      type: 'redeem',
      /* ── CANONICAL ACCOUNTING FIELDS (L5) ──────────────────────────────────
         This event already carried its rate — it was the only one of thirteen that did.
         It gains the rail, the accounting class and the rate VERSION, so the valuation can
         be explained later without re-deriving it from whatever the configuration says then.
         The rail is the PRODUCER's fact: this factory is only ever called from the till. */
      rail:        _EV.RAIL.POS,
      klass:       _EV.classOf('redeem'),
      /* NO FALLBACK. A missing version means the authority did not establish one, and the
         event is then counted as unvalued rather than labelled with a rule it did not use. */
      rateVersion: authorized.rateVersion,
      schemaVersion: 1,
      merchantId: merchantId ? String(merchantId) : null,
      customerId: customerId ? String(customerId) : null,
      saleId: saleId ? String(saleId) : null,
      points: -Math.abs(authorized.approvedPoints),
      valueKES: authorized.approvedKES,
      pointValue: authorized.pointValue,
      balanceBefore: authorized.balanceBefore,
      balanceAfter: authorized.balanceAfter,
      idempotencyKey: String(idempotencyKey),
      createdAt: at || null,
    },
  };
}

module.exports = {
  authorize,
  ledgerEntry,
  LEDGER,
  REASON,
  DEFAULT_POINT_VALUE,
  DEFAULT_MAX_PCT,
  DEFAULT_MIN_REDEEM,
};
