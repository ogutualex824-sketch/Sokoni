/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — THE ENTITLEMENT AUTHORITY
   ══════════════════════════════════════════════════════════════════════════════
   ONE continuous line from money to capability:

       subscription state → effective plan → entitlements → inventory

   This is NOT a new subscription engine. It composes the ones that exist:

     subscription-core.js      reads every subscription store, normalises it
     subscription-catalog.js   the canonical plan → allowance table
     product-limit.js          the enforcement point + the counter

   ── WHY IT EXISTS ───────────────────────────────────────────────────────────
   A paid KES 499 `ai_starter` merchant received the FREE allowance of 10 while
   their subscription still reported ACTIVE. Three separate mechanisms produced
   that, and each one alone was enough:

     1. `ai_*` was absent from the catalogue aliases, so a paid plan resolved to
        FREE. Fixed in subscription-catalog.js.
     2. `aiSubscriptions/{uid}` is a different collection from
        `subscriptions/{subId}`, so the limit-sync trigger never fired.
     3. resolveSubscription() with no role takes the FIRST source that hits, and
        the AI store is consulted LAST — so the SmartPOS free-trial document that
        business-bootstrap writes for every merchant SHADOWED the paid plan
        entirely.

   (3) is why fixing the alias alone would not have been enough, and it is the
   reason this module resolves by BEST ENTITLEMENT rather than by first hit.

   ── IT DOES NOT CHANGE resolveSubscription ──────────────────────────────────
   Seven modules call that function and rely on its first-hit semantics. Changing
   it to fix a fourth caller is how the next incident gets written. This module
   adds `resolveEffective()` alongside it and leaves the original alone.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const admin = require('firebase-admin');
const catalog = require('./subscription-catalog');
const core = require('./subscription-core');

const _db = () => admin.firestore();
const _now = () => admin.firestore.FieldValue.serverTimestamp();

/* Rank by what the merchant actually gets. Unlimited beats every finite number;
   otherwise the larger allowance wins, and features break a tie. A merchant
   holding both a free trial and a paid plan is entitled to the paid one. */
function _rank(ent) {
  if (!ent) return -1;
  const listing = ent.listingLimit === -1 ? Number.MAX_SAFE_INTEGER : (ent.listingLimit || 0);
  const feats = ent.features || {};
  const bonus = (feats.walletEnabled ? 1 : 0) + (feats.premiumAnalytics ? 1 : 0)
              + (feats.multiBranch ? 1 : 0) + (feats.prioritySupport ? 1 : 0);
  return listing * 10 + bonus;
}

/* Every store, not the first one that answers. */
async function _allSubscriptions(uid) {
  const out = [];
  try {
    const all = await core.resolveAll(uid);
    (all || []).forEach((c) => { if (c && c.found) out.push(c); });
  } catch (_) { /* fall through — an unreadable store must not blank the rest */ }
  return out;
}

/* A canonical subscription record carries the plan under `tier`; the legacy
   documents use `plan` or `planId`. Checked in that order because a normalised
   record is more trustworthy than the raw document it came from. */
function _planIdOf(sub) {
  const raw = sub && sub.raw ? sub.raw : {};
  return sub.tier || sub.plan || raw.plan || raw.planId || raw.tier || null;
}

/**
 * resolveEffective(uid) — the entitlement the merchant is actually owed.
 *
 * Considers EVERY subscription store and returns the best. Never throws: a
 * resolution failure yields the FREE entitlement, because an error must not hand
 * out more than is owed and must not take a shop offline either.
 */
async function resolveEffective(uid) {
  const free = catalog.entitlementFor({});
  if (!uid) return { ...free, uid: null, source: 'no-uid', considered: 0 };

  let subs = [];
  try { subs = await _allSubscriptions(uid); } catch (_) { subs = []; }
  if (!subs.length) return { ...free, uid: uid, source: 'no-subscription', considered: 0 };

  let best = null, bestSub = null;
  subs.forEach((sub) => {
    const ent = catalog.entitlementFor({ status: sub.status, plan: _planIdOf(sub) });
    if (!best || _rank(ent) > _rank(best)) { best = ent; bestSub = sub; }
  });

  const purchasedId = bestSub ? _planIdOf(bestSub) : null;
  return {
    ...best,
    uid: uid,
    /* Which record won, so a surprising allowance is a question with an answer
       rather than another investigation. */
    resolvedFrom: bestSub ? bestSub.source : null,
    resolvedPlanId: purchasedId,
    resolvedStatus: bestSub ? bestSub.status : null,
    considered: subs.length,
    /* WHAT WAS ACTUALLY BOUGHT, never silently replaced by what it maps to. */
    purchase: purchaseProvenance(purchasedId, best),
  };
}

/* ── DO NOT SILENTLY CONVERT A PURCHASE ────────────────────────────────────
   Mapping `ai_starter` onto the STARTER tier is what unblocks the merchant, and
   it is correct as an ENTITLEMENT decision. It is NOT a pricing decision: the AI
   catalogue sells ai_starter at KES 499 while the entitlement catalogue prices
   STARTER at KES 999. Granting the tier without recording that gap would quietly
   convert a 499 purchase into a 999 plan, and the discrepancy would surface later
   as a billing dispute with no trace of how it happened.

   So the purchase is carried alongside the entitlement, with the mismatch named.
   Nothing here changes a price — that is a commercial decision, not a code one. */
function purchaseProvenance(planId, ent) {
  if (!planId) return null;
  const id = String(planId);
  let sourceCatalogue = null;
  let pricePaidKES = null;

  try {
    const ai = require('./ai-subscriptions');
    if (ai.PLANS && ai.PLANS[id]) {
      sourceCatalogue = 'ai-subscriptions';
      pricePaidKES = Number(ai.PLANS[id].price);
    }
  } catch (_) { /* the AI catalogue is optional at resolve time */ }

  const tier = catalog.PLANS[ent.plan] || null;
  /* NOTE: the catalogue field is named priceKES but holds CENTS — 99900 is
     KES 999, matching sub-billing's seller_basic price:{monthly:99900}. */
  const tierPriceKES = tier ? tier.priceKES / 100 : null;

  return {
    planId: id,
    sourceCatalogue: sourceCatalogue,
    pricePaidKES: pricePaidKES,
    mappedTier: ent.plan,
    tierPriceKES: tierPriceKES,
    /* null when we cannot compare — never a confident `false`. */
    priceMatchesTier: (pricePaidKES == null || tierPriceKES == null)
      ? null : pricePaidKES === tierPriceKES,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   TRIAL LIFECYCLE — a trial is granted ONCE, and the ledger proves it
   ══════════════════════════════════════════════════════════════════════════════
   Before this, nothing recorded that a trial had been used: no trialUsed, no
   eligibility check anywhere in functions/. A second subscription document was a
   second free trial, indefinitely.

   `trialLedger/{uid}` is claimed with create(), so the claim is atomic and a
   concurrent double-tap cannot mint two trials. */
const TRIAL_LEDGER = 'trialLedger';

async function trialState(uid) {
  if (!uid) return { eligible: false, used: false, reason: 'no-uid' };
  const [ledgerSnap, ent] = await Promise.all([
    _db().collection(TRIAL_LEDGER).doc(uid).get().catch(() => null),
    resolveEffective(uid),
  ]);
  const used = !!(ledgerSnap && ledgerSnap.exists);
  const led = used ? (ledgerSnap.data() || {}) : {};
  const endsAt = led.trialEndsAt && led.trialEndsAt.toMillis ? led.trialEndsAt.toMillis() : null;
  const active = !!(endsAt && Date.now() < endsAt);

  /* A merchant already on a paid plan is not offered a trial — it would be a
     downgrade dressed as a gift. */
  const onPaid = ent.plan !== 'FREE' && ['ACTIVE', 'GRACE'].includes(ent.subscriptionStatus);

  return {
    uid: uid,
    used: used,
    active: active,
    trialStartedAt: led.trialStartedAt && led.trialStartedAt.toMillis ? led.trialStartedAt.toMillis() : null,
    trialEndsAt: endsAt,
    daysRemaining: active ? Math.ceil((endsAt - Date.now()) / 86400000) : 0,
    plan: led.plan || null,
    eligible: !used && !onPaid,
    reason: used ? 'trial-already-used' : (onPaid ? 'already-on-a-paid-plan' : null),
  };
}

/**
 * startTrial(uid, planId, days) — grants a trial exactly once, ever.
 * Returns { ok:false, reason } rather than throwing on an ordinary refusal.
 */
async function startTrial(uid, planId, days) {
  if (!uid) return { ok: false, reason: 'no-uid' };
  const plan = catalog.resolve(planId);
  const span = Number(days) > 0 ? Number(days) : 14;
  const state = await trialState(uid);
  if (!state.eligible) return { ok: false, reason: state.reason || 'not-eligible', state: state };

  const startedMs = Date.now();
  const endsMs = startedMs + span * 86400000;
  try {
    /* create(), not set() — a second call is a refusal, not an overwrite. */
    await _db().collection(TRIAL_LEDGER).doc(uid).create({
      uid: uid,
      plan: plan.id,
      requestedPlanId: String(planId || ''),
      trialDays: span,
      trialStartedAt: admin.firestore.Timestamp.fromMillis(startedMs),
      trialEndsAt: admin.firestore.Timestamp.fromMillis(endsMs),
      createdAt: _now(),
    });
  } catch (_) {
    return { ok: false, reason: 'trial-already-used' };
  }
  return { ok: true, plan: plan.id, trialStartedAt: startedMs, trialEndsAt: endsMs, trialDays: span };
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE ONE ENTITLEMENT CALL
   ══════════════════════════════════════════════════════════════════════════════
   Everything below derives from getMerchantEntitlement(). No consumer computes an
   allowance from a plan table of its own — that is how ten catalogues happened. */
async function getMerchantEntitlement(shopId) {
  const ent = await resolveEffective(shopId);
  const trial = await trialState(shopId).catch(() => ({ active: false, daysRemaining: 0 }));

  /* The counter is the enforcement point, and it can be stale or absent. An
     unreadable count is NOT zero — zero would silently grant a full allowance. */
  let used = null;
  try {
    const snap = await _db().collection('productCounters').doc(shopId).get();
    if (snap.exists && typeof snap.data().count === 'number') used = snap.data().count;
  } catch (_) { used = null; }

  const limit = ent.listingLimit;
  const unlimited = limit === -1;

  return {
    shopId: shopId,
    plan: ent.plan,
    label: ent.label,
    status: ent.subscriptionStatus,
    resolvedFrom: ent.resolvedFrom || null,
    resolvedPlanId: ent.resolvedPlanId || null,
    considered: ent.considered,
    /* Carried through to the UI so a merchant sees the plan they BOUGHT. */
    purchase: ent.purchase || null,
    trial: { active: !!trial.active, daysRemaining: trial.daysRemaining || 0,
             used: !!trial.used, eligible: !!trial.eligible },
    limits: {
      products: limit,
      productsUsed: used,
      /* null when the count could not be read — a UI must show "—", never 0. */
      productsRemaining: (unlimited ? -1 : (used === null ? null : Math.max(0, limit - used))),
      staffSeats: ent.staffSeats,
    },
    features: ent.features || {},
    catalogVersion: ent.catalogVersion,
  };
}

/* ── The capability questions every screen should ask ──────────────────────
   Each returns { allowed, reason, ... } — never a bare boolean, because a UI
   that cannot say WHY a merchant is blocked sends them to support. */
function _cap(ent, key, label) {
  const on = !!(ent.features || {})[key];
  return { allowed: on, reason: on ? null : 'plan-does-not-include:' + label, plan: ent.plan };
}

async function canCreateProduct(shopId) {
  const ent = await getMerchantEntitlement(shopId);
  const { products, productsUsed } = ent.limits;
  if (products === -1) return { allowed: true, reason: null, limit: -1, used: productsUsed, plan: ent.plan };
  /* An unreadable count fails CLOSED for creation but never hides existing
     inventory — the merchant is asked to retry, not downgraded. */
  if (productsUsed === null) {
    return { allowed: false, reason: 'count-unavailable', limit: products, used: null, plan: ent.plan };
  }
  const allowed = productsUsed < products;
  return {
    allowed: allowed,
    reason: allowed ? null : 'product-limit-reached',
    limit: products, used: productsUsed, plan: ent.plan,
    /* The way out, stated. Deleting frees capacity immediately — the counter
       decrements, so 49/50 can create again. Nothing is ever deleted for them. */
    remedy: allowed ? null : 'delete-or-archive-a-product, or upgrade',
  };
}

/* Inventory adjustments run against the SAME authority, so the two paths cannot
   disagree about what the merchant may do. */
async function canAddInventory(shopId) { return canCreateProduct(shopId); }

async function canUsePOS(shopId) { return _cap(await getMerchantEntitlement(shopId), 'walletEnabled', 'pos'); }
async function canUseOnlineSelling(shopId) { const e = await getMerchantEntitlement(shopId);
  return { allowed: true, reason: null, plan: e.plan }; /* online selling is on every tier, incl. FREE */ }
async function canUseDelivery(shopId) { const e = await getMerchantEntitlement(shopId);
  return { allowed: true, reason: null, plan: e.plan }; /* delivery is not plan-gated today */ }
async function canUseEmployees(shopId) {
  const e = await getMerchantEntitlement(shopId);
  const seats = e.limits.staffSeats;
  return { allowed: seats === -1 || seats > 1, reason: (seats === -1 || seats > 1) ? null : 'plan-includes-one-seat',
           seats: seats, plan: e.plan };
}
async function canUsePremiumMessaging(shopId) {
  return _cap(await getMerchantEntitlement(shopId), 'prioritySupport', 'premium-messaging');
}

module.exports = {
  resolveEffective, trialState, startTrial, getMerchantEntitlement,
  canCreateProduct, canAddInventory, canUsePOS, canUseOnlineSelling,
  canUseDelivery, canUseEmployees, canUsePremiumMessaging,
  TRIAL_LEDGER,
  _internal: { _rank, _planIdOf, _allSubscriptions },
};
