/* ================================================================
   SOKONI — Subscription period arithmetic (the ONE copy)
   ----------------------------------------------------------------
   Until 2026-09-30 six writers each carried their own "how long is a period":
   index.js `_subPeriodEnd`, sub-billing `_periodEnd`, sub-engine `_periodEnd`,
   entitlement-adapters `_periodEnd`, payment-reconciliation `_periodEnd` (all
   calendar months) and subscription-pay-methods `PERIOD_DAYS` (30 / 365 DAYS).
   Two grace-day tables lived inline in sub-engine and disagreed on the default
   (3 vs 5). A merchant's entitlement length therefore depended on which writer
   happened to activate them.

   A subscription is sold "/month" and "/year" (sub-billing PLANS, plans.html), so a
   period is a CALENDAR month or year from its start — what five of the six writers
   already did. Every writer now calls this file; none holds a number of its own.
   ================================================================ */
'use strict';

const CYCLES = Object.freeze(['monthly', 'annual']);

/* 'annual' → annual; anything else → monthly. Writers that must FAIL CLOSED on an
   unknown cycle call assertCycle() first (activateSubscription, entitlement-adapters);
   the renewal engine normalises upstream. This function itself never throws, so a
   legacy document with a missing cycle renews for a month rather than crashing a sweep. */
function normaliseCycle(cycle) {
  return cycle === 'annual' ? 'annual' : 'monthly';
}

function assertCycle(cycle) {
  if (CYCLES.indexOf(cycle) === -1) {
    const e = new Error(`Subscription billing cycle "${cycle}" is not monthly|annual; the period cannot be determined.`);
    e.code = 'billing_cycle_missing';
    throw e;
  }
  return cycle;
}

/* Period end: the same calendar day one month / twelve months on (JS setMonth
   semantics — 31 Jan + 1 month = 3 Mar in a non-leap year, as before). */
function periodEnd(start, cycle) {
  const r = new Date(start);
  r.setMonth(r.getMonth() + (normaliseCycle(cycle) === 'annual' ? 12 : 1));
  return r;
}

/* Grace period after a period ends, by tier. sub-engine carried two tables — the
   renewal path (default 3) and the proration path (default 5); the renewal table wins
   because it is the one that governs every automatic renewal. */
const GRACE_DAYS = Object.freeze({ enterprise: 14, pro: 7, basic: 5 });
function graceDays(tier) {
  const t = String(tier || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(GRACE_DAYS, t) ? GRACE_DAYS[t] : 3;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

module.exports = { CYCLES, normaliseCycle, assertCycle, periodEnd, graceDays, addDays, GRACE_DAYS };
