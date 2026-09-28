'use strict';
/**
 * kass-commission.js — what KASS may say about SOKONI's commission, read from the ONE authority.
 * ============================================================================================
 * KASS used to assert "SOKONI takes 12%; seller keeps 88%" from its system prompt — a number that no code has ever
 * charged (commission-config.js: "Nobody has ever been billed 12%"), and one its own knowledge corpus forbids
 * (kass-corpus.js: "Never invent fees, commissions, prices"). A prompt constant is a second commission table that
 * the single-source guard cannot see.
 *
 * This module holds NO rate. It maps the transaction types a customer asks about to the categories the canonical
 * authority prices (functions/commission-config.js, via its only permitted reader resolveRate(), plus the POS lane
 * constant it exports) and renders what that authority says. When the authority changes, KASS changes with it;
 * KASS can never claim a rate the application does not charge.
 *
 * The transaction types stay DISTINCT (owner rule): online sales, POS / Till / Quick Charge, event tickets, and each
 * booking lane are never flattened into one "marketplace rate".
 */
const CC = require('./commission-config');

/* Transaction type → authority category. Labels are what KASS says; `key` is what the authority prices. */
/* Only types whose charging path READS these categories are listed. Generic provider bookings (home services, other
   services, car rental booked through a provider) are priced by the provider's subscription plan in compatibility
   mode (provider-hub.commissionArgsForHub → subscriptionRole), NOT by RATES — so KASS states no rate for them and
   says it will check. They join this list when that path reads the schedule. */
const TYPES = [
  { id: 'online_products', label: 'Online product sales', key: 'marketplace' },
  { id: 'pos',             label: 'POS / Till / Quick Charge sales', pos: true },
  { id: 'food',            label: 'Food ordered online', key: 'food_delivery' },
  { id: 'digital',         label: 'Digital products', key: 'digital_products' },
  { id: 'event_tickets',   label: 'Event ticket sales', key: 'event_tickets' },
  { id: 'stays',           label: 'BnB / hotel bookings', key: 'hotel' },
  { id: 'healthcare',      label: 'Healthcare bookings', key: 'healthcare' },
  { id: 'healthcare_products', label: 'Healthcare product sales', key: 'healthcare_products' },
  { id: 'entertainment',   label: 'Entertainment bookings (artists, venues)', key: 'entertainment_bookings' },
  { id: 'legal',           label: 'Legal bookings', key: 'legal' },
  { id: 'education',       label: 'Education', key: 'education' },
  { id: 'vehicle_sales',   label: 'Car Hub vehicle sales', key: 'vehicles' },
];

function _fmtPct(p) { return (Math.round(p * 1000) / 1000) + '%'; }

/** Every rate KASS may state, straight from the authority. Pure; no I/O. */
function commissionFacts() {
  const rows = TYPES.map((t) => {
    if (t.pos) return { id: t.id, label: t.label, pct: Math.round(CC.POS_FLAT_RATE_FRACTION * 100000) / 1000, fixedKES: 0, source: 'commission-config.POS_FLAT_RATE_FRACTION' };
    if (t.key === 'marketplace' && typeof CC.resolveMarketplaceRate === 'function') {   /* the online-sale lane itself */
      const m = CC.resolveMarketplaceRate(null);
      return { id: t.id, label: t.label, pct: m.pct, fixedKES: 0, source: m.source || 'commission-config.resolveMarketplaceRate' };
    }
    const r = CC.resolveRate(t.key);
    if (!r || r.matched === false) return null;   /* never render a default-fallback as if it were this type's rate */
    return { id: t.id, label: t.label, pct: r.pct, fixedKES: r.fixedKES || 0, source: 'commission-config.resolveRate(' + t.key + ')' };
  }).filter(Boolean);
  return { rows, minimumKES: CC.MIN_COMMISSION_KES };
}

/** The prompt line KASS receives — generated per request, so it is never a copy that can drift. */
function commissionPromptLine() {
  const f = commissionFacts();
  const parts = f.rows.map((r) => r.label + ' ' + (r.fixedKES ? ('KES ' + r.fixedKES + (r.pct ? ' + ' + _fmtPct(r.pct) : '')) : _fmtPct(r.pct)));
  return 'Commission (from SOKONI\'s commission authority — quote ONLY these, never another figure; each is per sale, with a KES '
    + f.minimumKES + ' minimum): ' + parts.join('; ') + '. Long-term rent carries no commission (property management is a subscription). '
    + 'Other service bookings (home services, car rental, other services) are priced by the provider\'s plan — do not quote a rate for them. '
    + 'If asked about a sale type not listed, or about payout timing, say you will check rather than guessing.';
}

module.exports = { commissionFacts, commissionPromptLine, TYPES };
