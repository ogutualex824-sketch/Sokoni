/* ============================================================================
   SOKONI commercial entitlements — partner plans + paid promotion (2026-10-01)
   ----------------------------------------------------------------------------
   ONE authoritative configuration. Every page and the payment authority read THIS module; prices are
   never typed anywhere else. Launch prices: owner decision 2026-10-01 (proposed SOKONI launch prices,
   not market claims).

   SEPARATE COMMERCIAL DOMAINS (never one bucket, never overwriting each other):
     marketplace  → subscriptions/{uid}               (existing; NOT touched here)
     partner      → entitlements/{ownerId}__partner  (one per owner + product domain)
     promotion    → promotionCampaigns/{intentRef}   (campaign/order semantics — NOT a subscription)
   So a merchant can hold a marketplace plan + a partner plan + several campaigns at once.

   PAYMENT: createPaymentIntent purposes 'partner_subscription' and 'promotion_purchase' (wired by the payment
   authority, sokoni-70's lane) call priceFor() to compute the amount SERVER-SIDE and checkEligibility() before
   minting; the verified webhook calls fulfilPartnerSubscription(tx, intent) / fulfilPromotion(tx, intent).
   Both handlers: ALL reads before writes, idempotent on intent.ref (commercialFulfilments/{ref} create-once),
   never trust browser price/plan/status. Enterprise is not self-serve (refused).

   A PLAN NEVER BUYS TRUST: the "Registration reviewed by SOKONI" marker, listing approval and licence status
   are decided by reviews, never by payment. Promotion ranks a listing; it never vouches for it, and an
   unapproved / withdrawn listing is never served (the directory lists approved listings only).
   ============================================================================ */
'use strict';

const DAY = 86400000;
const PARTNER_PLANS = Object.freeze({
  starter: { planId: 'starter', name: 'Partner Starter', priceKES: 2500, periodDays: 30, selfServe: true,
    capabilities: ['partner_profile', 'directory_listing', 'basic_discovery'], limits: { maxProducts: 20, maxTeam: 2 } },
  growth: { planId: 'growth', name: 'Partner Growth', priceKES: 5000, periodDays: 30, selfServe: true,
    capabilities: ['partner_profile', 'directory_listing', 'basic_discovery', 'enhanced_profile', 'extra_placements', 'analytics'], limits: { maxProducts: 50, maxTeam: 5 } },
  pro: { planId: 'pro', name: 'Partner Pro', priceKES: 10000, periodDays: 30, selfServe: true,
    capabilities: ['partner_profile', 'directory_listing', 'basic_discovery', 'enhanced_profile', 'extra_placements', 'analytics', 'premium_placement', 'rich_media', 'advanced_analytics'], limits: { maxProducts: 100, maxTeam: 15 } },
  enterprise: { planId: 'enterprise', name: 'Partner Enterprise', priceKES: 25000, priceNote: 'from KES 25,000/month — custom', periodDays: 30, selfServe: false,
    capabilities: [], limits: null },   /* negotiated: granted only by an admin-recorded contract, never by checkout */
});
/* Without an active paid plan a partner keeps the free base (the approved listing stays listed). */
const BASE = Object.freeze({ planId: null, name: 'Free listing', capabilities: ['partner_profile', 'directory_listing'], limits: { maxProducts: 10, maxTeam: 1 } });

const PROMOTION_PRODUCTS = Object.freeze({
  listing_boost_day: { productId: 'listing_boost_day', name: 'Listing Boost', priceKES: 300, perDay: true, minDays: 1, maxDays: 30, placement: 'banking_hub_category' },
  listing_boost_7d: { productId: 'listing_boost_7d', name: 'Listing Boost — 7 days', priceKES: 1500, days: 7, placement: 'banking_hub_category' },
  category_featured_7d: { productId: 'category_featured_7d', name: 'Category Featured — 7 days', priceKES: 5000, days: 7, placement: 'banking_hub_featured' },
  homepage_spotlight_7d: { productId: 'homepage_spotlight_7d', name: 'Homepage Spotlight — 7 days', priceKES: 12000, days: 7, placement: 'homepage_spotlight' },
});
/* Hard caps per placement so exposure is never unlimited. */
const PLACEMENT_CAPS = Object.freeze({ banking_hub_category: 30, banking_hub_featured: 6, homepage_spotlight: 3 });

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
class CommercialError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/* ── pricing (pure) ──────────────────────────────────────────────────────────────────────────── */
function priceFor(purpose, data) {
  const d = data || {};
  if (purpose === 'partner_subscription') {
    const plan = PARTNER_PLANS[d.planId];
    if (!plan) throw new CommercialError('invalid-argument', 'Unknown plan.');
    if (!plan.selfServe) throw new CommercialError('failed-precondition', 'Partner Enterprise is arranged with SOKONI directly.');
    return { amountKES: plan.priceKES, amountCents: plan.priceKES * 100, currency: 'KES', description: plan.name + ' — 30 days', meta: { domain: 'partner', planId: plan.planId } };
  }
  if (purpose === 'promotion_purchase') {
    const p = PROMOTION_PRODUCTS[d.productId];
    if (!p) throw new CommercialError('invalid-argument', 'Unknown promotion.');
    let days = p.days;
    if (p.perDay) {
      days = Number(d.days);
      if (!Number.isInteger(days) || days < p.minDays || days > p.maxDays) throw new CommercialError('invalid-argument', 'Choose ' + p.minDays + '–' + p.maxDays + ' days.');
    }
    const amountKES = p.perDay ? p.priceKES * days : p.priceKES;
    return { amountKES, amountCents: amountKES * 100, currency: 'KES', description: p.name + (p.perDay ? ' × ' + days + ' days' : ''), meta: { domain: 'promotion', productId: p.productId, days, placement: p.placement } };
  }
  throw new CommercialError('invalid-argument', 'Not a commercial purpose.');
}

/* ── eligibility (reads; called before an intent is minted) ──────────────────────────────────── */
async function checkEligibility(db, purpose, data, uid) {
  if (!uid) throw new CommercialError('unauthenticated', 'Sign in.');
  const prov = await db.collection('financialProviders').doc(uid).get();
  if (!prov.exists || prov.data().listingStatus !== 'approved') throw new CommercialError('failed-precondition', 'Only an approved partner listing can buy partner plans or promotion.');
  if (purpose === 'promotion_purchase') {
    const target = data && data.targetId != null ? String(data.targetId) : uid;
    if (target !== uid) throw new CommercialError('permission-denied', 'You can only promote your own listing.');
  }
  return { ok: true };
}

/* ── fulfilment (verified webhook; open transaction; reads first; idempotent on intent.ref) ──── */
function intentFields(intent) {
  const i = intent || {};
  const ref = String(i.ref || '');
  if (!ID_RE.test(ref)) throw new CommercialError('invalid-argument', 'Bad intent ref.');
  const uid = String(i.uid || i.ownerId || '');
  if (!ID_RE.test(uid)) throw new CommercialError('invalid-argument', 'Bad intent owner.');
  return { ref, uid, meta: i.meta || {}, amountKES: Number(i.amountKES ?? (i.amountCents != null ? i.amountCents / 100 : i.amount)) };
}
async function fulfilPartnerSubscription(tx, intent, { db, now = Date.now(), FieldValue, Timestamp }) {
  const { ref, uid, meta, amountKES } = intentFields(intent);
  const plan = PARTNER_PLANS[meta.planId];
  const receiptRef = db.collection('commercialFulfilments').doc(ref);
  const entRef = db.collection('entitlements').doc(uid + '__partner');
  const [receipt, ent] = await Promise.all([tx.get(receiptRef), tx.get(entRef)]);
  if (receipt.exists) return { already: true };
  /* the intent must match the authoritative price at fulfilment time, else hold for review */
  const expected = plan && plan.selfServe ? plan.priceKES : null;
  if (expected == null || amountKES !== expected) {
    tx.create(receiptRef, { domain: 'partner', ownerId: uid, intentRef: ref, outcome: 'review', reason: expected == null ? 'unknown_plan' : 'amount_mismatch', amountKES, expectedKES: expected, at: FieldValue.serverTimestamp() });
    return { review: true };
  }
  const cur = ent.exists ? ent.data() : null;
  const curEnd = cur && cur.expiresAt && typeof cur.expiresAt.toMillis === 'function' ? cur.expiresAt.toMillis() : 0;
  const samePlanActive = cur && cur.planId === plan.planId && curEnd > now;
  const start = samePlanActive ? curEnd : now;                 /* renewal extends; a plan change starts now */
  const end = start + plan.periodDays * DAY;
  tx.set(entRef, {
    ownerId: uid, domain: 'partner', subjectType: 'financial_partner', subjectId: uid,
    planId: plan.planId, planName: plan.name, capabilities: plan.capabilities, limits: plan.limits,
    status: 'active', provider: 'intasend', lastPaymentRef: ref,
    startedAt: cur && samePlanActive ? cur.startedAt : Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(end), renewedAt: samePlanActive ? Timestamp.fromMillis(now) : null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  tx.create(receiptRef, { domain: 'partner', ownerId: uid, intentRef: ref, outcome: 'fulfilled', planId: plan.planId, amountKES, periodStart: Timestamp.fromMillis(start), periodEnd: Timestamp.fromMillis(end), at: FieldValue.serverTimestamp() });
  return { fulfilled: true, planId: plan.planId, expiresAt: end };
}
async function fulfilPromotion(tx, intent, { db, now = Date.now(), FieldValue, Timestamp }) {
  const { ref, uid, meta, amountKES } = intentFields(intent);
  const receiptRef = db.collection('commercialFulfilments').doc(ref);
  const campRef = db.collection('promotionCampaigns').doc(ref);
  const provRef = db.collection('financialProviders').doc(uid);
  const [receipt, camp, prov] = await Promise.all([tx.get(receiptRef), tx.get(campRef), tx.get(provRef)]);
  if (receipt.exists || camp.exists) return { already: true };
  let price;
  try { price = priceFor('promotion_purchase', { productId: meta.productId, days: meta.days }); } catch (_) { price = null; }
  const listingOk = prov.exists && prov.data().listingStatus === 'approved';
  const status = !price || price.amountKES !== amountKES ? 'review' : (listingOk ? 'active' : 'review');
  const reason = !price ? 'unknown_product' : (price.amountKES !== amountKES ? 'amount_mismatch' : (listingOk ? null : 'listing_not_approved'));
  const days = price ? price.meta.days : 0;
  tx.create(campRef, {
    campaignId: ref, ownerId: uid, targetType: 'financial_listing', targetId: uid,
    productId: meta.productId || null, placement: price ? price.meta.placement : null,
    startAt: Timestamp.fromMillis(now), endAt: Timestamp.fromMillis(now + days * DAY),
    budget: amountKES, amountKES, paymentIntentId: ref, status, reviewReason: reason,
    approvedAt: status === 'active' ? FieldValue.serverTimestamp() : null, createdAt: FieldValue.serverTimestamp(),
  });
  tx.create(receiptRef, { domain: 'promotion', ownerId: uid, intentRef: ref, outcome: status === 'active' ? 'fulfilled' : 'review', reason, amountKES, at: FieldValue.serverTimestamp() });
  return { fulfilled: status === 'active', review: status !== 'active', reason };
}

/* ── reading an entitlement (expiry computed at read; unknown plan → base, never "everything") ─ */
function effectivePlan(entDoc, now = Date.now()) {
  const e = entDoc || null;
  const end = e && e.expiresAt && typeof e.expiresAt.toMillis === 'function' ? e.expiresAt.toMillis() : (e && typeof e.expiresAt === 'number' ? e.expiresAt : 0);
  if (!e || e.status !== 'active' || end <= now) return { ...BASE, active: false, expiresAt: end || null };
  if (e.planId === 'enterprise' && e.contract === true && e.limits) return { planId: 'enterprise', name: 'Partner Enterprise', capabilities: e.capabilities || [], limits: e.limits, active: true, expiresAt: end };
  const plan = PARTNER_PLANS[e.planId];
  if (!plan || !plan.selfServe) return { ...BASE, active: false, expiresAt: end, unknownPlan: true };
  return { planId: plan.planId, name: plan.name, capabilities: plan.capabilities, limits: plan.limits, active: true, expiresAt: end };
}
const can = (eff, capability) => !!eff && Array.isArray(eff.capabilities) && eff.capabilities.includes(capability);
function catalogue() {
  return {
    plans: Object.values(PARTNER_PLANS).map((p) => ({ planId: p.planId, name: p.name, priceKES: p.priceKES, priceNote: p.priceNote || null, periodDays: p.periodDays, selfServe: p.selfServe, capabilities: p.capabilities, limits: p.limits })),
    base: { name: BASE.name, capabilities: BASE.capabilities, limits: BASE.limits },
    promotions: Object.values(PROMOTION_PRODUCTS).map((p) => ({ productId: p.productId, name: p.name, priceKES: p.priceKES, perDay: !!p.perDay, minDays: p.minDays || null, maxDays: p.maxDays || null, days: p.days || null, placement: p.placement })),
    placementCaps: PLACEMENT_CAPS,
  };
}

module.exports = { PARTNER_PLANS, PROMOTION_PRODUCTS, PLACEMENT_CAPS, BASE, CommercialError, priceFor, checkEligibility, fulfilPartnerSubscription, fulfilPromotion, effectivePlan, can, catalogue };
