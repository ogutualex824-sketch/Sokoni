'use strict';
/**
 * SOKONI — what a Healthcare subscription says about Stories.
 * ============================================================================================
 * Stories is available on ALL THREE Healthcare tiers. Clinic, Hospital and Enterprise may all
 * publish; what differs between them is analytics depth and whether staff may publish on the
 * organisation's behalf. Enterprise-only Stories would be a NEW restriction — the platform
 * does not have one today — and it is not introduced here.
 *
 * ── THIS IS NOT AN AUTHORIZATION SYSTEM, AND MUST NOT BECOME ONE ───────────────────────────
 * Story authorization lives in exactly one place: firestore.rules.
 *
 *     match /stories/{storyId} {
 *       allow create: if isAuthed() && request.resource.data.uid == request.auth.uid && ...
 *
 * That rule is the authority. This module REPORTS capability so a dashboard can show the
 * right controls and a server caller can explain a tier difference. It grants nothing, denies
 * nothing, and is deliberately not wired into any write path — a second Stories authorization
 * system is explicitly out of scope, and a check that lives only here would be a limit in name
 * only: the client writes `stories` directly, so anything this module "enforced" could be
 * bypassed by writing to Firestore without asking it.
 *
 * ── WHY NO STORY CAPACITY LIMIT YET ────────────────────────────────────────────────────────
 * A tier-varying story ceiling is a real product requirement and is NOT implemented here,
 * because it cannot yet be implemented honestly:
 *
 *   1. It must be enforced server-side to mean anything. The proven in-repo pattern is
 *      product-limit.js + productCounters/{uid}.maxProducts, where the ceiling is written to a
 *      counter document and enforced IN FIRESTORE RULES, so it holds against a direct client
 *      write. A UI-only ceiling is not a limit.
 *   2. That requires a rules change, and Stories' rules cannot currently deploy: the compiled
 *      ruleset has ~596 bytes free of 256,000 and a dry run is rejected for committed HEAD
 *      too. Until the ruleset budget is resolved, production story reads are denied outright.
 *
 * Shipping a ceiling that only the dashboard respects would state a limit the platform does
 * not keep. `storyCapacityStatus()` therefore reports the state as UNAVAILABLE rather than
 * returning a number nothing enforces.
 */

const { capabilitiesFor } = require('./capability-authority');

/**
 * storiesFor(uid) -> what this account's Healthcare subscription permits around Stories.
 *
 * `canPublish` is true for every live Healthcare tier AND for an account with no subscription,
 * because the platform rule grants publishing to any authenticated user. Reporting false for
 * an unsubscribed account would describe a restriction that does not exist.
 */
async function storiesFor(uid) {
  const r = await capabilitiesFor(uid, { hub: 'healthcare' });
  const c = r.capabilities;
  return {
    tier: r.tier,
    status: r.status,
    /* Read from the capability authority — these three keys exist because this file reads
       them, which is the contract scripts/verify-capability-consumers.js enforces. */
    canPublish:        c.stories === true,
    advancedAnalytics: c.storiesAdvancedAnalytics === true,
    staffPublishing:   c.storiesStaffPublishing === true,
    /* The authority, stated so no caller mistakes this module for it. */
    authority: 'firestore.rules match /stories/{storyId}',
  };
}

/**
 * storyCapacityStatus() — deliberately not a number.
 *
 * See the header: a ceiling is only real when rules enforce it, and the Stories ruleset cannot
 * deploy today. Returning `limit: null` with an explicit blocker is the honest answer; a
 * dashboard should render "unlimited for now", never a cap it invented.
 */
function storyCapacityStatus() {
  return {
    enforced: false,
    limit: null,
    blockedBy: 'firestore-rules-not-authorised',
    detail: 'Tier story capacity requires a rules-enforced counter (see product-limit.js + '
          + 'productCounters). Firestore rules changes are not authorised in this gate, and '
          + 'the rules lineage on this branch is unreconciled, so no ceiling is claimed.',
  };
}

/**
 * merchantStoriesFor(uid) — the MERCHANT package's Stories position.
 *
 * Stories itself is available on every package; only the allowance and the advanced
 * capabilities vary. `allowancePerWeek` is 1 for FREE and NULL for the paid packages because
 * those numbers are undecided — null means "not yet decided", never "unlimited", and a caller
 * must render it as such rather than inventing a figure.
 *
 * `allowanceEnforced` is false everywhere: the counter that would make an allowance real is a
 * rules change, and this gate may not make one. Reporting a limit nothing enforces is how a
 * dashboard figure gets mistaken for a platform constraint.
 */
async function merchantStoriesFor(uid) {
  const r = await capabilitiesFor(uid, { hub: 'merchant' });
  const c = r.capabilities;
  return {
    package: r.tier,
    status: r.status,
    canPublish: c.stories === true,               /* true on all four packages */
    advancedAnalytics: c.storiesAdvancedAnalytics === true,
    staffPublishing: c.storiesStaffPublishing === true,
    allowancePerWeek: c.storyAllowancePerWeek,    /* 1 on FREE, null = undecided */
    allowanceEnforced: false,
    listingLimit: c.listingLimit,
    authority: 'firestore.rules match /stories/{storyId}',
  };
}

module.exports = { storiesFor, storyCapacityStatus, merchantStoriesFor };
