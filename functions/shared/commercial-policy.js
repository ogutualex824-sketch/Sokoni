'use strict';
/**
 * SOKONI — category-scoped commercial policy registry.
 * ============================================================================================
 * ONE question, answered in ONE place: "under which commercial policy is THIS transaction
 * priced?" — keyed by category / hubId / productType / transactionType.
 *
 * It holds NO RATES. Every policy points at the authority that already owns its rate:
 *
 *   commission-config.js        platform rate tables (RATES, POS lane, marketplace lane)
 *   shared/creator-commercial   the Creator Hub 30 / 70 royalty split (bps, net of provider fee)
 *
 * so there is still exactly one place each number lives. What this adds is the explicit
 * MAPPING, so that "Creator is 30 %, Events are 3 %, POS is 5 %, marketplace online is 15 %"
 * is a property the code states and a test can prove — not an accident of which alias a caller
 * happened to pass. There is deliberately NO global Entertainment rate: an Entertainment
 * sub-category resolves to its own policy or to nothing.
 *
 * Owner decision recorded 2026-09-26 (docs/CANONICAL_MONEY_VERSION_DECISIONS.md):
 *   Creator Hub 30 % SOKONI / 70 % creator (net of provider fee) · online marketplace 15 %
 *   · POS / Till 5 % · Quick Charge 5 % (a POS line) · Events 3 % per ticket
 *   · Streaming is a Creator content type under the Creator policy
 *   · every other hub keeps its own configured rate.
 *
 * Refund authority per policy names the canonical refund rail (financial-os fos* — refund
 * authority C on this branch, docs/REFUND_AUTHORITY_CONVERGENCE.md). No policy introduces a
 * parallel refund rail.
 */

const CC = require('../commission-config');
const CREATOR = require('./creator-commercial');

/* Basis vocabulary. */
const BASIS = Object.freeze({
  GROSS: 'GROSS',                              /* rate × amount charged */
  NET_OF_PROVIDER_FEE: 'NET_OF_PROVIDER_FEE',  /* rate × (amount − provider fee) */
});

/* ── The registry ───────────────────────────────────────────────────────────────────────
   rate: how to obtain the commission rate — never a literal. `resolve()` returns
   { pct, source } from the owning authority at call time, so a rate change is made in ONE
   place (its authority) and every policy that points there follows. */
const POLICIES = Object.freeze({
  creator_ppv: Object.freeze({
    commercialPolicyId: CREATOR.CREATOR_PPV.policyId,           /* creator_ppv_v1 */
    domain: 'entertainment', hubId: 'creator', transactionType: 'online_content_sale',
    basis: BASIS.NET_OF_PROVIDER_FEE,
    revenueSplit: { sokoniBps: CREATOR.CREATOR_PPV.sokoniCommissionBps, creatorPoolBps: CREATOR.CREATOR_PPV.creatorPoolBps },
    resolve: () => ({ pct: CREATOR.CREATOR_PPV.sokoniCommissionBps / 100, source: 'shared/creator-commercial.CREATOR_PPV' }),
    settlement: 'royalty_ledger_quarterly',
    refundAuthority: 'financial-os.fos* → creator-hub.onFilmRefundProcessed',
    paymentPurpose: 'film_access',
  }),
  event_ticket: Object.freeze({
    commercialPolicyId: 'event_ticket_v1',
    domain: 'entertainment', hubId: 'events', transactionType: 'ticket_sale',
    basis: BASIS.NET_OF_PROVIDER_FEE,
    resolve: () => { const r = CC.resolveRate('event_tickets'); return { pct: r.pct, source: 'commission-config.RATES.event_tickets' }; },
    settlement: 'held_until_event_end',
    refundAuthority: 'financial-os.fos* → event-settlement.onEventRefundProcessed',
    paymentPurpose: 'event_ticket',
  }),
  entertainment_ppv: Object.freeze({
    commercialPolicyId: 'entertainment_ppv_legacy',
    domain: 'entertainment', hubId: 'entertainment', transactionType: 'legacy_listing_sale',
    basis: BASIS.GROSS,
    resolve: () => { const r = CC.resolveRate('ppv'); return { pct: r.pct, source: 'commission-config.RATES.ppv' }; },
    settlement: 'none — no payment path (quarantined; new content goes through Creator Hub)',
    refundAuthority: 'n/a',
    paymentPurpose: null,
  }),
  marketplace_online: Object.freeze({
    commercialPolicyId: 'marketplace_flat_15',
    domain: 'marketplace', hubId: 'marketplace', transactionType: 'online_sale',
    basis: BASIS.GROSS,
    resolve: () => { const r = CC.resolveMarketplaceRate(null); return { pct: r.pct, source: r.source }; },
    settlement: 'marketplace',
    refundAuthority: 'merchant refund authority (not owned by this registry)',
    paymentPurpose: 'product_order',
  }),
  pos_till: Object.freeze({
    commercialPolicyId: 'pos_flat_5',
    domain: 'pos', hubId: 'pos', transactionType: 'pos_sale',
    basis: BASIS.GROSS,
    resolve: () => { const r = CC.resolvePosRate(null); return { pct: r.pct, source: r.source }; },
    settlement: 'pos',
    refundAuthority: 'merchant refund authority (not owned by this registry)',
    paymentPurpose: 'pos_till_sale',
  }),
  quick_charge: Object.freeze({
    /* A Quick Charge is a keyed-in line of a POS / Till sale (shared/pos-service-pricing.js,
       priceSource 'quick_charge'), so it is priced by the POS lane — the same 5 %. */
    commercialPolicyId: 'pos_flat_5',
    domain: 'pos', hubId: 'pos', transactionType: 'quick_charge',
    basis: BASIS.GROSS,
    resolve: () => { const r = CC.resolvePosRate(null); return { pct: r.pct, source: r.source }; },
    settlement: 'pos',
    refundAuthority: 'merchant refund authority (not owned by this registry)',
    paymentPurpose: 'pos_till_sale',
  }),
});

/* Entertainment sub-categories → policy key. A category that is not here has NO policy and
   `policyFor` refuses it: there is no global Entertainment fallback. */
const ENTERTAINMENT_POLICY_BY_CATEGORY = Object.freeze({
  creator: 'creator_ppv',
  streaming: 'creator_ppv',          /* owner 2026-09-26: Streaming is a Creator content type */
  events: 'event_ticket',
  entertainment_listing: 'entertainment_ppv',
});

/**
 * The policy for a transaction. Accepts { policyKey } or { domain:'entertainment', category }.
 * Throws `policy_unknown` rather than defaulting — an unpriced transaction must fail closed.
 */
function policyFor(q = {}) {
  let key = q.policyKey || null;
  if (!key && q.domain === 'entertainment') key = ENTERTAINMENT_POLICY_BY_CATEGORY[String(q.category || '')] || null;
  const p = key ? POLICIES[key] : null;
  if (!p) {
    const e = new Error(`No commercial policy for ${JSON.stringify(q)} — refusing to default.`);
    e.code = 'policy_unknown';
    throw e;
  }
  return { key, ...p, ...p.resolve() };
}

/** Commission in integer cents for an amount under a policy (pure; floors toward the payer). */
function commissionCents(policyKey, { grossCents, providerFeeCents = 0 }) {
  const p = policyFor({ policyKey });
  const g = Math.max(0, Math.round(Number(grossCents) || 0));
  const fee = Math.max(0, Math.round(Number(providerFeeCents) || 0));
  const base = p.basis === BASIS.NET_OF_PROVIDER_FEE ? Math.max(0, g - fee) : g;
  const bps = Math.round(p.pct * 100);
  return { base, commission: Math.floor((base * bps) / 10000), bps, policy: p.commercialPolicyId, source: p.source, basis: p.basis };
}

/** The whole matrix, resolved — for AdminOS and the certification suite. */
function matrix() {
  return Object.keys(POLICIES).map((k) => {
    const p = policyFor({ policyKey: k });
    return { key: k, commercialPolicyId: p.commercialPolicyId, domain: p.domain, hubId: p.hubId,
      transactionType: p.transactionType, pct: p.pct, source: p.source, basis: p.basis,
      settlement: p.settlement, refundAuthority: p.refundAuthority, paymentPurpose: p.paymentPurpose };
  });
}

module.exports = { BASIS, POLICIES, ENTERTAINMENT_POLICY_BY_CATEGORY, policyFor, commissionCents, matrix };
