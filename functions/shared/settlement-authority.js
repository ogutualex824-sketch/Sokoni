'use strict';
/**
 * SETTLEMENT AUTHORITY — the ONE arithmetic every held-payment settlement uses (owner 2026-10-03).
 *
 * Each transaction supplies its own authoritative inputs; this module never reads a catalogue, a service, a quote or the
 * browser:
 *   heldAmountCents   — what SOKONI actually holds for this transaction (persisted at hold time from the VERIFIED payment)
 *   passThroughCents  — the part of the held money that is not commissionable (a booking fee; a refundable deposit)
 *   commissionSnapshot— captured at booking / acceptance: { commissionRate (pct), commissionRuleId, commissionBase, ... }
 *
 * Settlement base = held − pass-through. Never the current booking price, service price, provider-entered or edited quote
 * amount: if KES 10,000 is held and the provider later re-prices to 12,000, the base stays 10,000. Commission = the
 * snapshot's rate on that base — never today's rate. A transaction with no snapshot (created before snapshots existed)
 * is reported as such (needsLegacy) so the caller can price it once and RECORD that it did; nothing silent.
 *
 * Used by: provider bookings (marketing, education, services, milestones), rentals, and construction orders/projects —
 * each through its own completion authority (PIN / show-up / return PIN). There is no second settlement implementation.
 */
const _int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : NaN; };

/** Build the snapshot stamped on a transaction at booking/acceptance from a commission-engine result. */
function snapshotFrom(comm, extra) {
  const rate = Number(comm && comm.effectiveRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null;
  const e = extra || {};
  return {
    commissionRate: rate,
    /* an admin commissionRule's id when one applied; otherwise the CATALOGUE rule '<category>@<policyVersion>' — never the
       engine's placeholder 'default' (there is no default rule any more; b2 2026-10-04) */
    commissionRuleId: String((comm.ruleId && comm.ruleId !== 'default') ? comm.ruleId : ((comm.category || 'unknown') + '@' + (e.policyVersion || comm.engineVersion || 'unknown'))),
    commissionBase: e.commissionBase || 'service_price',
    category: comm.category || null,
    pricingSource: comm.pricingSource || null,
    policyVersion: e.policyVersion || null,
    capturedOnCents: Number.isFinite(_int(e.capturedOnCents)) ? _int(e.capturedOnCents) : null,
    commissionCentsAtCapture: Number.isFinite(_int(comm.commissionCents)) ? _int(comm.commissionCents) : null,
  };
}

function validSnapshot(s) {
  return !!(s && Number.isFinite(Number(s.commissionRate)) && Number(s.commissionRate) >= 0 && Number(s.commissionRate) <= 100 && s.commissionRuleId);
}

/**
 * settle({ heldAmountCents, passThroughCents, commissionSnapshot }) →
 *   { ok:true, baseCents, commissionCents, netCents, passThroughCents, settleCents, rate, source:'booking_snapshot' }
 *   { ok:true, needsLegacy:true, baseCents, passThroughCents }      — no snapshot: caller prices once and records it
 *   { ok:false, reason:'held_amount_unknown' | 'pass_through_exceeds_held' }
 */
function settle(t) {
  const held = _int(t && t.heldAmountCents);
  if (!Number.isFinite(held) || held <= 0) return { ok: false, reason: 'held_amount_unknown' };
  const pass = Math.max(0, Number.isFinite(_int(t.passThroughCents)) ? _int(t.passThroughCents) : 0);
  if (pass > held) return { ok: false, reason: 'pass_through_exceeds_held' };
  const base = held - pass;
  if (!validSnapshot(t.commissionSnapshot)) return { ok: true, needsLegacy: true, baseCents: base, passThroughCents: pass };
  const rate = Number(t.commissionSnapshot.commissionRate);
  const commission = Math.min(base, Math.round(base * rate / 100));
  const net = base - commission;
  return { ok: true, baseCents: base, commissionCents: commission, netCents: net, passThroughCents: pass, settleCents: net + pass,
    rate, ruleId: String(t.commissionSnapshot.commissionRuleId), source: 'booking_snapshot' };
}

module.exports = { settle, snapshotFrom, validSnapshot };
