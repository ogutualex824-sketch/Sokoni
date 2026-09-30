/* ══════════════════════════════════════════════════════════════════════════════════════
   ONE ECONOMIC RULE — the normalisation boundary for SOKONI Rewards.
   ══════════════════════════════════════════════════════════════════════════════════════
                          loyaltyMerchantConfigs/{merchantId}
                                        │
                                normalizeRewardsRate()
                                        │
                                  KES per point
                                        │
                    ┌───────────┬───────┴────────┬────────────┐
                    ↓           ↓                ↓            ↓
              POS redemption  online       customer wallet   refund reversal

   WHY THIS EXISTS. What a point is worth was expressed three ways, in two different
   units, with a ten-fold disagreement in value:

       loyaltyPrograms/{mid}.points.pointValue   KES per point    0.5   client-written
       loyaltyMerchantConfigs/{mid}.redemptionRate  points per KES  100   server-written
       loyaltyRules/default.redemptionRate       points per KES    10

   `pointValue` and `redemptionRate` are RECIPROCALS of one another. That is the hazard this
   module exists for: copying 100 from one field into the other does not convert the rate,
   it inverts it — turning "100 points per shilling" into "100 shillings per point", a
   ten-thousand-fold error that reads like a plausible number in both places.

   THE CANONICAL DOCUMENT IS loyaltyMerchantConfigs, chosen for its authority posture and
   not for convenience:

       loyaltyPrograms          client-written, and has NO Firestore rule at all — so the
                                write is denied, the document cannot exist, and any
                                authority depending on it is inoperable in production
       loyaltyMerchantConfigs   written ONLY by a _requireMerchant-guarded callable through
                                the admin SDK; `allow read: if isAuthed()` with no write
                                clause, so clients can read it and never mutate it

   Making loyaltyPrograms writable would have made POS redemption work while preserving the
   split brain and opening a client-writable economic rule. The rate a merchant redeems at
   is not something a browser may set.

   THE SOKONI RATE: 10 points = KES 1  (100 points = KES 10).

   Everything below returns KES PER POINT, because that is the unit a caller needs to price
   a redemption, and because forcing one direction at the boundary is what stops the
   reciprocal confusion recurring downstream.
   ══════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const CANONICAL_COLLECTION = 'loyaltyMerchantConfigs';

/* THE PLATFORM RATE, in the canonical document's own unit: points per KES.
   Kept in that unit deliberately — a default expressed as 0.1 here would sit beside a
   stored field meaning 10 and invite exactly the inversion this module prevents. */
const DEFAULT_REDEMPTION_RATE = 10;      /* 10 points = KES 1 */

/* HOW MUCH OF ONE BILL POINTS MAY SETTLE.
   The two authorities disagreed — 50 on the customer side, 100 on the POS side — so this is
   a business rule being DECIDED, not inherited. 50 is taken as canonical because it is the
   value the canonical document already carries and already validates, and because it is the
   conservative reading: a ceiling can be raised by a merchant who wants to, whereas a
   platform that silently allowed whole bills to be paid in points would be discovering its
   liability after the fact. Merchants may still set their own. */
const DEFAULT_MAX_REDEMPTION_PCT = 50;

/* Earn side, in the canonical document's unit: points earned per KES spent. */
const DEFAULT_POINTS_PER_KES = 0.1;

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

/**
 * Normalise a rewards configuration into one economic meaning.
 *
 * @param cfg  the loyaltyMerchantConfigs document data, or null/undefined when absent
 * @returns {{
 *   pointValueKES: number,       KES per point — what ONE point is worth
 *   redemptionRate: number,      points per KES — the canonical document's own unit
 *   maxRedemptionPct: number,    ceiling on how much of a bill points may settle
 *   pointsPerKES: number,        earn side: points granted per KES spent
 *   source: 'config' | 'default' what the answer came from, never guessed at by the caller
 * }}
 *
 * An ABSENT config is not an error. Every merchant who has never opened the rewards
 * settings must still transact, at the platform rate — which is precisely why the defaults
 * live here and are stated once rather than repeated at each call site with a `|| 100`.
 */
function normalizeRewardsRate(cfg) {
  const has = !!(cfg && typeof cfg === 'object');

  /* points per KES. Validated the same way the writing callable validates it (>= 1), so a
     document that somehow holds a sub-1 value cannot silently produce an absurd point
     value — 0.5 points per KES would make each point worth two shillings. */
  const rawRate = has ? _num(cfg.redemptionRate) : NaN;
  const redemptionRate = (Number.isFinite(rawRate) && rawRate >= 1) ? rawRate : DEFAULT_REDEMPTION_RATE;

  const rawPct = has ? _num(cfg.maxRedemptionPct) : NaN;
  const maxRedemptionPct = (Number.isFinite(rawPct) && rawPct >= 0 && rawPct <= 100)
    ? rawPct : DEFAULT_MAX_REDEMPTION_PCT;

  const rawEarn = has ? _num(cfg.pointsPerKES) : NaN;
  const pointsPerKES = (Number.isFinite(rawEarn) && rawEarn >= 0) ? rawEarn : DEFAULT_POINTS_PER_KES;

  const fromConfig = (has && Number.isFinite(rawRate) && rawRate >= 1);

  /* THE VERSION OF THE RATE THAT WAS USED.
     An event that records a value but not the configuration that produced it cannot be
     explained later: re-deriving from today's config would make the past move whenever the
     present changes. The config has no version NUMBER and one is not invented — `updatedAt`
     identifies the exact write that produced this rate, which is what a version is for.
     A missing config is labelled `platform-default`, never a merchant version, because the
     platform rule is not a merchant's configuration. */
  let rateVersion = 'platform-default';
  if (fromConfig) {
    const u = cfg.updatedAt;
    const ms = u && typeof u.toMillis === 'function' ? u.toMillis()
             : (u instanceof Date ? u.getTime()
             : (typeof u === 'number' ? u : null));
    rateVersion = ms ? ('cfg:' + new Date(ms).toISOString()) : 'cfg:unversioned';
  }

  return {
    /* THE INVERSION HAPPENS EXACTLY ONCE, HERE. */
    pointValueKES: 1 / redemptionRate,
    redemptionRate,
    maxRedemptionPct,
    pointsPerKES,
    source: fromConfig ? 'config' : 'default',
    /* Carried onto every event this rate values. See loyalty-event.js. */
    rateVersion,
  };
}

/** The canonical document reference, so no caller spells the collection name itself. */
function configRef(db, merchantId) {
  return db.collection(CANONICAL_COLLECTION).doc(String(merchantId));
}

module.exports = {
  normalizeRewardsRate,
  configRef,
  CANONICAL_COLLECTION,
  DEFAULT_REDEMPTION_RATE,
  DEFAULT_MAX_REDEMPTION_PCT,
  DEFAULT_POINTS_PER_KES,
};
