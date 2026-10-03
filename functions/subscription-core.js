'use strict';
/**
 * SOKONI Subscription Core — the ONE canonical read + enforcement seam.
 *
 * The platform has five independently-written subscription stores (audited
 * 2026-07-12): accountSubscriptions (UEOE), providerSubscriptions (provider hub),
 * subscriptions/{autoId} (sub-engine/sub-billing), subscriptions/{uid} +
 * aiSubscriptions (subscription-os), and a users.subscription mirror. They use
 * conflicting keys, field names, timestamp types, and status vocabularies, so the
 * same account can hold several divergent records.
 *
 * This module does NOT rewrite or migrate those writers (they are live). It is a
 * READ + ENFORCE layer: it normalizes whatever any writer produced into ONE
 * canonical shape and gives every caller (dispatchers, role-ops modules, gates)
 * a single authoritative answer. This is the "one backend subscription platform"
 * for the part that matters — enforcement — without breaking a single writer.
 *
 * Pure library: import and call resolveSubscription()/assertWithinLimit()/… .
 * Also exposes read-only client ops on _h (served via subscriptionsDispatch).
 */

const { getFirestore } = require('firebase-admin/firestore');
const { HttpsError }   = require('firebase-functions/v2/https');

const _db = () => getFirestore();

/* Unified status vocabulary. */
const STATUS = { TRIALING: 'trialing', ACTIVE: 'active', GRACE: 'grace',
  PAST_DUE: 'past_due', EXPIRED: 'expired', CANCELLED: 'cancelled', NONE: 'none' };

/* Free-tier commission fallback per role (from the audited plan catalogues). */
const ROLE_DEFAULT_COMMISSION = {
  merchant: 0.20, provider: 0.20, rider: 0.25, driver: 0.25, courier: 0.25,
  property: 0.05, hotel: 0.05, restaurant: 0.08, healthcare: 0.03,
  employer: 0, buyer: 0,
};

/* ── Normalizers ──────────────────────────────────────────────────────────── */

/* Any timestamp form (Firestore Timestamp | ISO string | epoch ms | Date) → epoch ms | null. */
function _epoch(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;        // ms vs seconds
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  if (typeof v.toDate === 'function') return v.toDate().getTime();  // Firestore Timestamp
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  return null;
}

/* features may be an array of labels or a map of flags → always return a map. */
function _featureMap(f) {
  if (!f) return {};
  if (Array.isArray(f)) { const m = {}; f.forEach((k) => { m[String(k)] = true; }); return m; }
  return (typeof f === 'object') ? f : {};
}

/* billingCycle: 'annual' → 'yearly'. */
function _cycle(c) { return c === 'annual' ? 'yearly' : (c || 'monthly'); }

/* Build the canonical object from a raw doc + a source tag + adapter fields. */
function _canonical(source, uid, fields) {
  return {
    found: true, source, uid,
    accountId: fields.accountId || uid,
    role: fields.role || null, hubType: fields.hubType || null,
    product: fields.product || null,
    tier: fields.tier || null,
    status: fields.status || STATUS.ACTIVE,
    trial: !!fields.trial,
    billingCycle: _cycle(fields.billingCycle),
    priceCents: Number(fields.priceCents || 0),
    currency: fields.currency || 'KES',
    commissionRate: Number.isFinite(fields.commissionRate) ? fields.commissionRate : null,
    limits: fields.limits || {},
    features: _featureMap(fields.features),
    startAt: _epoch(fields.startAt),
    trialEndsAt: _epoch(fields.trialEndsAt),
    renewalAt: _epoch(fields.renewalAt),
    expiryAt: _epoch(fields.expiryAt),
    graceEndsAt: _epoch(fields.graceEndsAt),
    paymentMethod: fields.paymentMethod || null,
    raw: fields.raw || null,
  };
}

/* Recompute a live status from dates so stale stored statuses can't mislead. */
function computeStatus(c) {
  if (!c || !c.found) return STATUS.NONE;
  if (c.status === STATUS.CANCELLED) return STATUS.CANCELLED;
  const now = Date.now();
  if (c.trial && c.trialEndsAt && now < c.trialEndsAt) return STATUS.TRIALING;
  const end = c.expiryAt || c.renewalAt;
  if (end && now > end) {
    if (c.graceEndsAt && now <= c.graceEndsAt) return STATUS.GRACE;
    return STATUS.EXPIRED;
  }
  return STATUS.ACTIVE;
}

const NONE = { found: false, source: 'none', status: STATUS.NONE, tier: null,
  limits: {}, features: {}, commissionRate: null };

/* ── Source adapters (read one store, normalize) ──────────────────────────── */

async function _fromProvider(uid) {
  const s = await _db().collection('providerSubscriptions').doc(uid).get();
  if (!s.exists) return null;
  const d = s.data();
  return _canonical('provider', uid, {
    role: 'provider', tier: d.plan, status: d.status, trial: d.trialStatus === 'active',
    billingCycle: d.billingCycle, priceCents: d.price, commissionRate: Number(d.commissionRate),
    limits: d.limits, features: d.features, renewalAt: d.renewalDate, expiryAt: d.expiryDate,
    paymentMethod: d.paymentMethod, raw: d,
  });
}

async function _fromAccount(uid, role) {
  // Single-field equality (auto-indexed) + in-memory role filter → no composite index.
  const snap = await _db().collection('accountSubscriptions').where('accountId', '==', uid).limit(50).get();
  if (snap.empty) return null;
  const docs = snap.docs.map((x) => x.data())
    .filter((d) => !role || d.role === role)
    .sort((a, b) => (_epoch(b.createdAt) || 0) - (_epoch(a.createdAt) || 0));
  if (!docs.length) return null;
  const d = docs[0];
  return _canonical('account', uid, {
    accountId: d.accountId, role: d.role, product: d.product, tier: d.tier, status: d.status,
    trial: !!d.trial, billingCycle: d.billingCycle, priceCents: d.price, currency: d.currency,
    commissionRate: Number(d.commissionRate), limits: d.limits, features: d.features,
    trialEndsAt: d.trialEndsAt, renewalAt: d.renewalAt || d.currentPeriodEnd,
    expiryAt: d.currentPeriodEnd, paymentMethod: d.paymentMethod, raw: d,
  });
}

/* sub-engine / sub-billing: subscriptions/{autoId} queried by uid field, optional hubType. */
async function _fromBilling(uid, hubType) {
  // Single-field equality (auto-indexed) + in-memory hubType filter → no composite index.
  const snap = await _db().collection('subscriptions').where('uid', '==', uid).limit(50).get();
  if (snap.empty) return null;
  const docs = snap.docs.map((x) => x.data())
    .filter((d) => !hubType || d.hubType === hubType)
    .sort((a, b) => (_epoch(b.updatedAt) || 0) - (_epoch(a.updatedAt) || 0));
  if (!docs.length) return null;
  const d = docs[0];
  return _canonical('billing', uid, {
    hubType: d.hubType, tier: d.tier, product: d.planId, status: d.status,
    billingCycle: d.billingCycle, priceCents: d.priceMonthly, features: d.features,
    renewalAt: d.nextBillingDate || d.currentPeriodEnd, expiryAt: d.currentPeriodEnd,
    graceEndsAt: d.graceEnd, paymentMethod: d.billingPhone ? 'mpesa' : null, raw: d,
  });
}

/* subscription-os: subscriptions/{uid} (marketplace view) + aiSubscriptions/{uid}. */
async function _fromAi(uid) {
  const s = await _db().collection('aiSubscriptions').doc(uid).get();
  if (!s.exists) return null;
  const d = s.data();
  return _canonical('ai', uid, {
    product: 'ai', tier: d.plan, status: d.status, billingCycle: d.billing,
    renewalAt: d.currentPeriodEnd, expiryAt: d.currentPeriodEnd, paymentMethod: null, raw: d,
  });
}

/* ── Resolution ───────────────────────────────────────────────────────────── */

/* Priority of sources for a given role (most authoritative first). */
function _sourcesFor(role, hubType) {
  if (role === 'provider') return [(u) => _fromProvider(u), (u) => _fromAccount(u, 'provider')];
  if (role === 'ai' || hubType === 'ai') return [(u) => _fromAi(u)];
  if (role) return [(u) => _fromBilling(u, hubType || role), (u) => _fromAccount(u, role)];
  return [(u) => _fromBilling(u, hubType), (u) => _fromAccount(u, null), (u) => _fromProvider(u), (u) => _fromAi(u)];
}

/**
 * resolveSubscription(uid, { role, hubType }) → canonical subscription (status
 * recomputed from dates) or the NONE sentinel. Reads only the sources relevant
 * to the role, in priority order, returning the first hit.
 */
async function resolveSubscription(uid, opts = {}) {
  if (!uid) return { ...NONE };
  const { role, hubType } = opts;
  for (const read of _sourcesFor(role, hubType)) {
    try {
      const c = await read(uid);
      if (c && c.found) { c.status = computeStatus(c); return c; }
    } catch (_) { /* source unavailable → try next */ }
  }
  return { ...NONE, role: role || null };
}

/* All subscriptions across every store for a uid (unified billing view). */
async function resolveAll(uid) {
  if (!uid) return [];
  const results = await Promise.all([
    _fromProvider(uid).catch(() => null),
    _fromAccount(uid, null).catch(() => null),
    _fromBilling(uid, null).catch(() => null),
    _fromAi(uid).catch(() => null),
  ]);
  return results.filter(Boolean).map((c) => ({ ...c, status: computeStatus(c) }));
}

/**
 * reconcile(uid) — read-only diagnostic. Reports every subscription record found
 * across the five stores and whether they DIVERGE (the split-brain the audit
 * found: same account, different tier/status/commission in different stores).
 * This is the safe precursor to any write-unification: it identifies exactly
 * which accounts are affected without mutating anything.
 */
async function reconcile(uid) {
  const subs = await resolveAll(uid);
  // Group records that represent the same conceptual product (role/hubType/product).
  const key = (c) => c.role || c.hubType || c.product || c.source;
  const groups = {};
  for (const c of subs) (groups[key(c)] ||= []).push(c);

  const conflicts = [];
  for (const [k, recs] of Object.entries(groups)) {
    if (recs.length < 2) continue;
    const tiers = new Set(recs.map((r) => r.tier || 'none'));
    const stats = new Set(recs.map((r) => r.status));
    const comms = new Set(recs.map((r) => (r.commissionRate == null ? 'n/a' : r.commissionRate)));
    if (tiers.size > 1 || stats.size > 1 || comms.size > 1) {
      conflicts.push({
        product: k,
        sources: recs.map((r) => r.source),
        tiers: [...tiers], statuses: [...stats], commissionRates: [...comms],
      });
    }
  }
  return {
    uid, recordCount: subs.length,
    stores: subs.map((c) => ({ source: c.source, role: c.role, hubType: c.hubType,
      tier: c.tier, status: c.status, commissionRate: c.commissionRate })),
    diverges: conflicts.length > 0,
    conflicts,
  };
}

/* ── Enforcement API (the point of the whole module) ──────────────────────── */

function isActive(status) { return status === STATUS.ACTIVE || status === STATUS.TRIALING || status === STATUS.GRACE; }

async function getCommissionRate(uid, opts = {}) {
  const c = await resolveSubscription(uid, opts);
  if (c.found && Number.isFinite(c.commissionRate)) return c.commissionRate;
  const r = opts.role;
  return (r && ROLE_DEFAULT_COMMISSION[r] != null) ? ROLE_DEFAULT_COMMISSION[r] : 0.20;
}

async function getFeatures(uid, opts = {})  { return (await resolveSubscription(uid, opts)).features || {}; }
async function hasFeature(uid, opts, key)   { return !!(await getFeatures(uid, opts))[key]; }

/**
 * assertWithinLimit — throws resource-exhausted if adding one more would exceed
 * the plan's limit. limit -1 = unlimited; no subscription = free-tier limit arg.
 */
async function assertWithinLimit(uid, opts, limitKey, currentCount, freeDefault = 0) {
  const c = await resolveSubscription(uid, opts);
  const limit = c.found && c.limits && limitKey in c.limits ? Number(c.limits[limitKey]) : freeDefault;
  if (limit === -1) return { allowed: true, limit: -1, remaining: -1 };
  if (Number(currentCount) >= limit) {
    throw new HttpsError('resource-exhausted',
      `Your plan allows ${limit} ${limitKey}. Upgrade to add more.`);
  }
  return { allowed: true, limit, remaining: limit - Number(currentCount) - 1 };
}

/* ── Client ops (read-only) via subscriptionsDispatch ─────────────────────── */

const _h = {};

_h.getUnifiedSubscription = async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const c = await resolveSubscription(uid, { role: req.data?.role, hubType: req.data?.hubType });
  return { subscription: c, active: isActive(c.status) };
};

_h.listMySubscriptions = async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return { subscriptions: await resolveAll(uid) };
};

_h.checkFeature = async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const feature = String(req.data?.feature || '');
  const allowed = await hasFeature(uid, { role: req.data?.role, hubType: req.data?.hubType }, feature);
  return { feature, allowed };
};

/* Admin-only divergence diagnostic for a given account (support/reconciliation). */
_h.getSubscriptionDivergence = async (req) => {
  const t = req.auth?.token || {};
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  if (!t.admin && !t.superAdmin) throw new HttpsError('permission-denied', 'Admin only.');
  const uid = String(req.data?.uid || '').trim();
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');
  return reconcile(uid);
};

_h.checkLimit = async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const c = await resolveSubscription(uid, { role: req.data?.role, hubType: req.data?.hubType });
  const key = String(req.data?.limitKey || '');
  const count = Number(req.data?.count || 0);
  const limit = c.found && c.limits && key in c.limits ? Number(c.limits[key]) : 0;
  return { limitKey: key, limit, allowed: limit === -1 || count < limit,
    remaining: limit === -1 ? -1 : Math.max(0, limit - count) };
};

module.exports = {
  STATUS, computeStatus, resolveSubscription, resolveAll, reconcile,
  isActive, getCommissionRate, getFeatures, hasFeature, assertWithinLimit,
  _h,
};
