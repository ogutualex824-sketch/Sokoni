/* ============================================================================
   FITNESS MEMBERSHIP OFFER DEFAULTS — the ONE place SOKONI's starting prices live (owner 2026-10-03)
   ----------------------------------------------------------------------------
   Owner decision: these are DEFAULTS a gym's offer editor is pre-filled with ("Defaults gyms can edit"). Each gym
   publishes its own membership offers in its provider services (owner, earlier the same day); the member always pays
   the price on the gym's PUBLISHED offer, which fitnessCreateMembership snapshots into providerMemberships at creation
   and the fitness_membership payment purpose charges. Nothing here is ever charged directly.

   Positioning (owner brief): a moderate Nairobi-mainstream catalogue — monthly ≈ the established KES 5,000–7,000 band,
   longer commitments discounted. NOT a claim about what any particular gym charges.

   Money in integer CENTS (the platform convention). periodUnit/periodCount use membership-settlement's units:
   'day' | 'week' are ONE payout slice (held until the first check-in, then paid; never used → at expiry);
   'month' pays one slice per month after the first check-in.
   ============================================================================ */
'use strict';

const OFFER_DEFAULTS = Object.freeze([
  Object.freeze({ key: 'daily',    label: 'Daily Pass', priceCents:     50000, periodUnit: 'day',   periodCount: 1 }),
  Object.freeze({ key: 'weekly',   label: 'Weekly Pass', priceCents:   150000, periodUnit: 'week',  periodCount: 1 }),
  Object.freeze({ key: 'monthly',  label: 'Monthly',    priceCents:    500000, periodUnit: 'month', periodCount: 1 }),
  Object.freeze({ key: 'quarter',  label: '3 Months',   priceCents:   1400000, periodUnit: 'month', periodCount: 3 }),
  Object.freeze({ key: 'half',     label: '6 Months',   priceCents:   2600000, periodUnit: 'month', periodCount: 6 }),
  Object.freeze({ key: 'annual',   label: 'Annual',     priceCents:   4800000, periodUnit: 'month', periodCount: 12 }),
]);

/* Transparent saving for multi-month offers, against the same offer list's Monthly price (computed, never typed). */
function withSavings(list) {
  const src = Array.isArray(list) ? list : OFFER_DEFAULTS;
  const monthly = src.find((o) => o.periodUnit === 'month' && o.periodCount === 1);
  return src.map((o) => {
    if (!monthly || o.periodUnit !== 'month' || o.periodCount <= 1) return Object.assign({}, o, { effectiveMonthlyCents: null, savingPct: null });
    const eff = Math.round(o.priceCents / o.periodCount);
    const saving = Math.round((1 - eff / monthly.priceCents) * 100);
    return Object.assign({}, o, { effectiveMonthlyCents: eff, savingPct: saving > 0 ? saving : 0 });
  });
}

function defaultFor(key) { return OFFER_DEFAULTS.find((o) => o.key === key) || null; }

module.exports = { OFFER_DEFAULTS, withSavings, defaultFor };
