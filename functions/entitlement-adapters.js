'use strict';
/**
 * SOKONI Entitlement Adapters — thin domain bindings for the canonical engine.
 *
 * An adapter answers exactly one question: "given an already-validated
 * payment, what does this domain write?" It performs NO payment verification,
 * NO webhook handling and NO reconciliation — those live only in
 * entitlement-engine.js, and duplicating them here would rebuild the very
 * split-brain the engine exists to remove.
 *
 * Phase 2A migrates ONE domain: subscriptions. It is first because it is the
 * only domain whose canonical shape is already proven in production —
 * activateSubscription (functions/index.js) writes exactly 7 fields, and that
 * shape was verified field-by-field against the live KES 499 merchant incident.
 * The other five domains follow one release at a time.
 *
 * FEATURE-FLAGGED AND INERT. Registration alone changes nothing: the engine
 * only acts when a caller invokes activate(). Wiring the webhook to call it is
 * a separate step gated on `_systemConfig/entitlementEngine.subscriptionEngine`,
 * so disabling the flag restores the previous behaviour immediately without a
 * deploy.
 *
 * Related: docs/PAYMENT_ARCHITECTURE_UNIFICATION.md, functions/entitlement-engine.js
 */

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const engine = require('./entitlement-engine');

const _db = () => getFirestore();

const FLAG_DOC   = '_systemConfig/entitlementEngine';
/* PLAN_DAYS is a FIXED SPAN for the purpose registry and the healthcare adapter —
   it is NOT the subscription entitlement contract, and the comment that used to
   claim it "matches activateSubscription" has been false since A4 made that path
   derive its period from the purchased billing cycle.

   It is deliberately NOT removed: registerPurpose's `expiresDays` and the
   healthcare adapter's currentPeriodEnd/renewalAt still depend on it, and those
   are separate contracts that have not been adjudicated. Only the subscription
   adapter's dependency on it is gone (A4-F3E). */
const PLAN_DAYS  = 30;
const VALID_PLANS = new Set(['free', 'starter', 'pro', 'business']);

/* Calendar period, matching activateSubscription, the reconciliation backstop and
   sub-billing.js. Defined locally like the other three rather than imported: no
   module exports one, sub-billing.js is a Cloud Functions surface, and requiring
   index.js from here would be circular. scripts/test-entitlement-adapter-period.js
   asserts this agrees with all three on every boundary vector, so a divergence
   fails a suite instead of silently producing a different answer. Collapsing the
   four copies onto one shared module is a separate, still-unmade decision. */
function _periodEnd(start, cycle) {
  /* ONE period arithmetic for every subscription writer — subscription-period.js. */
  return require('./subscription-period').periodEnd(start, cycle);
}

/* ── Feature flags ────────────────────────────────────────────────────────
   One document, one boolean per domain, default OFF, and the read FAILS
   CLOSED. A config outage must never be the reason the platform starts
   granting entitlements down an unproven path. */
async function isEngineEnabled(domain) {
  try {
    const [col, doc] = FLAG_DOC.split('/');
    const snap = await _db().collection(col).doc(doc).get();
    return snap.exists && snap.data()[`${domain}Engine`] === true;
  } catch (_) {
    return false;
  }
}

/* ── Subscription adapter ─────────────────────────────────────────────────
   activate() writes the SAME 7 fields activateSubscription writes, so a
   subscription produced here is indistinguishable from a normally-activated
   one. Provenance belongs on the engine's ledger, never on this document —
   if it leaked onto the subscription, readers would start branching on how
   the entitlement came to exist. */
const subscription = {
  /* Domain preconditions only. Payment validity was already established by
     the engine and must not be re-derived here. */
  validate(ctx) {
    const plan = ctx.intent.planId || ctx.intent.plan || ctx.resourceId;
    if (!plan) { const e = new Error('Subscription intent carries no plan.'); e.code = 'plan_missing'; throw e; }
    if (!VALID_PLANS.has(String(plan))) {
      const e = new Error(`Unknown plan "${plan}".`); e.code = 'plan_invalid'; throw e;
    }
    if (!ctx.ownerUid) { const e = new Error('No owner uid.'); e.code = 'owner_missing'; throw e; }
    return { ok: true, plan: String(plan) };
  },

  /* MUST use the supplied transaction — writing outside it would break the
     engine's exactly-once guarantee. */
  activate(txn, ctx) {
    const plan      = String(ctx.intent.planId || ctx.intent.plan || ctx.resourceId);
    const uid       = ctx.ownerUid;
    const subRef    = _db().collection('subscriptions').doc(uid);

    /* ── ENTITLEMENT FOLLOWS THE PURCHASED CYCLE (A4-F3E) ───────────────────
       This wrote PLAN_DAYS — a flat thirty days — while ctx.intent, which
       carries billingCycle, was already in hand.

       This path is SHADOW-ONLY and stays that way. It is reached through
       webhookIntasend -> shadowCompareSubscription -> engine.simulate(), which
       passes a capture object whose set/create/update/delete are recorded and
       never applied; the engine's own ledger has no rows, so no real
       activation has ever run through here. Nothing below makes this
       authoritative.

       The repair is drift prevention, not damage repair. A shadow comparison
       that reports a spurious expiry mismatch trains readers to ignore it — one
       of the two comparisons in production is exactly that — and if a future
       caller ever routes a `subscription` intent into engine.activate(), this
       would become a live writer still carrying the defect A4 and F3-D removed
       from the other three.

       FAILS CLOSED. An unknown cycle throws, which engine.simulate() records as
       an engine_error on the comparison document rather than silently
       simulating a month. Consistent with activateSubscription, which also
       throws; webhookIntasend skips instead only because it must not fail a
       live payment. */
    const cycle = ctx.intent.billingCycle;
    if (cycle !== 'monthly' && cycle !== 'annual') {
      const e = new Error(`Subscription intent records no billing cycle ("${cycle}"), ` +
                          'so the entitlement period cannot be determined.');
      e.code = 'billing_cycle_missing';
      throw e;
    }
    const expiresAt = Timestamp.fromDate(_periodEnd(new Date(), cycle));

    /* set() rather than create(): a renewal is a NEW paymentRef, so the engine
       ledger already guarantees this runs once per payment. Overwriting the
       subscription doc is the correct renewal behaviour and matches the
       canonical path. */
    txn.set(subRef, {
      uid,
      plan,
      status:      'active',
      paymentRef:  ctx.paymentRef,
      activatedAt: FieldValue.serverTimestamp(),
      expiresAt,
      updatedAt:   FieldValue.serverTimestamp(),
    });

    return { ref: `subscriptions/${uid}`, plan, expiresAt };
  },

  /* Refund / chargeback. Downgrades rather than deleting: the merchant's
     history and paymentRef stay auditable, and getProviderPlan resolves a
     non-active status to the free tier by itself. */
  revoke(txn, led, reason) {
    if (!led.ownerUid) return { skipped: true };
    txn.set(_db().collection('subscriptions').doc(led.ownerUid), {
      status:       'cancelled',
      cancelledAt:  FieldValue.serverTimestamp(),
      cancelReason: String(reason || '').slice(0, 200),
      updatedAt:    FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ref: `subscriptions/${led.ownerUid}` };
  },

  async status(ctx) {
    const snap = await _db().collection('subscriptions').doc(ctx.ownerUid).get();
    if (!snap.exists) return { active: false };
    const d = snap.data();
    const exp = d.expiresAt && d.expiresAt.toMillis ? d.expiresAt.toMillis() : null;
    return {
      active:    d.status === 'active' && (!exp || exp > Date.now()),
      plan:      d.plan || null,
      expiresAt: d.expiresAt || null,
    };
  },
};

/* ── Shadow comparison ────────────────────────────────────────────────────
   Runs the engine in simulate mode beside the legacy activation and records
   what each WOULD write. Writes only to entitlementComparison — a collection
   that exists solely for certification and that no production reader consumes.

   Server timestamps are sentinels at write time, so comparison is on field
   NAMES plus the values that carry meaning (plan, status, paymentRef, uid).
   Comparing sentinel objects would produce noise, not signal.

   MUST NEVER THROW INTO THE CALLER. The webhook's job is to acknowledge a
   payment; a diagnostic that could 500 it would be strictly worse than having
   no diagnostic. Every failure is swallowed and recorded. */
const COMPARE_COL = 'entitlementComparison';
const SIGNIFICANT = ['uid', 'plan', 'status', 'paymentRef'];

function _diffSubscription(legacyDoc, engineWrite) {
  const differences = [];
  const engineData  = (engineWrite && engineWrite.data) || null;
  if (!legacyDoc && !engineData) return { differences, verdict: 'both_absent' };
  if (!legacyDoc)  return { differences: ['legacy_absent'],  verdict: 'legacy_missing' };
  if (!engineData) return { differences: ['engine_absent'],  verdict: 'engine_missing' };

  const lk = Object.keys(legacyDoc).sort();
  const ek = Object.keys(engineData).sort();
  if (JSON.stringify(lk) !== JSON.stringify(ek)) {
    differences.push(`fields: legacy=[${lk}] engine=[${ek}]`);
  }
  for (const f of SIGNIFICANT) {
    if (String(legacyDoc[f]) !== String(engineData[f])) {
      differences.push(`${f}: legacy=${legacyDoc[f]} engine=${engineData[f]}`);
    }
  }
  return { differences, verdict: differences.length ? 'mismatch' : 'match' };
}

async function shadowCompareSubscription(paymentRef, legacyMeta = {}) {
  try {
    const started = Date.now();
    const sim = await engine.simulate(paymentRef);

    const uid = legacyMeta.uid || (sim.ledger && sim.ledger.ownerUid) || null;
    let legacyDoc = null;
    if (uid) {
      const s = await _db().collection('subscriptions').doc(uid).get();
      legacyDoc = s.exists ? s.data() : null;
    }

    const engineWrite = (sim.writes || []).find((w) => /^subscriptions\//.test(w.path)) || null;
    const cmp = sim.ok
      ? _diffSubscription(legacyDoc, engineWrite)
      : { differences: [`engine_error:${sim.code}`], verdict: 'engine_error' };

    await _db().collection(COMPARE_COL).doc(String(paymentRef).replace(/\//g, '_')).set({
      paymentRef:        String(paymentRef),
      domain:            'subscription',
      legacyResult:      legacyDoc ? { present: true, plan: legacyDoc.plan || null, status: legacyDoc.status || null,
                                       paymentRef: legacyDoc.paymentRef || null } : { present: false },
      engineResult:      sim.ok ? { present: !!engineWrite, path: engineWrite && engineWrite.path,
                                    plan: engineWrite && engineWrite.data.plan,
                                    status: engineWrite && engineWrite.data.status,
                                    wouldCreateLedger: sim.ledger && sim.ledger.wouldCreate }
                                : { present: false, error: sim.error, code: sim.code },
      fieldDifferences:  cmp.differences,
      comparisonStatus:  cmp.verdict,
      engineDurationMs:  sim.ms,
      legacyDurationMs:  Number(legacyMeta.durationMs) || null,
      comparisonMs:      Date.now() - started,
      shadowOnly:        true,          /* nothing here granted an entitlement */
      at:                FieldValue.serverTimestamp(),
    }, { merge: true });

    return cmp.verdict;
  } catch (e) {
    /* Diagnostics must never destabilise the payment path. */
    console.error('[shadowCompare] non-fatal', { paymentRef, err: e && e.message });
    return 'compare_failed';
  }
}

/* ── Digital download adapter ─────────────────────────────────────────────
   digitalPurchases is created with status 'completed' for free products and
   'pending_payment' for paid ones (digital-hub.js:218). Nothing anywhere writes
   'completed' for a paid purchase, and downloadDigitalProduct refuses anything
   else (:255) — so every paid digital purchase has been permanently
   undeliverable. The state machine had a start and an exit but no transition.

   The transition belongs to the engine, not to a payment callback: access is
   granted because an entitlement was issued, never because a webhook fired.
   resourceId carries the purchaseId. */
const digitalDownload = {
  validate(ctx) {
    if (!ctx.resourceId) { const e = new Error('No purchaseId on the intent.'); e.code = 'resource_missing'; throw e; }
    return { ok: true };
  },

  activate(txn, ctx) {
    const ref = _db().collection('digitalPurchases').doc(String(ctx.resourceId));
    /* merge, not set: the purchase already holds licence key, download limits
       and seller split, and none of that may be overwritten by activation. */
    txn.set(ref, {
      status:      'completed',
      completedAt: FieldValue.serverTimestamp(),
      paymentRef:  ctx.paymentRef,
      updatedAt:   FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ref: `digitalPurchases/${ctx.resourceId}` };
  },

  /* Refund or chargeback withdraws the download. downloadsUsed is deliberately
     left intact — it is the record of what the buyer already took, and a refund
     does not un-download a file. */
  revoke(txn, led, reason) {
    if (!led.resourceId) return { skipped: true };
    txn.set(_db().collection('digitalPurchases').doc(String(led.resourceId)), {
      status:       'revoked',
      revokedAt:    FieldValue.serverTimestamp(),
      revokeReason: String(reason || '').slice(0, 200),
      updatedAt:    FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ref: `digitalPurchases/${led.resourceId}` };
  },

  async status(ctx) {
    const snap = await _db().collection('digitalPurchases').doc(String(ctx.resourceId)).get();
    if (!snap.exists) return { active: false };
    const d = snap.data();
    return {
      active: d.status === 'completed' && (d.downloadsUsed || 0) < (d.allowedDownloads || 0),
      downloadsUsed: d.downloadsUsed || 0,
      allowedDownloads: d.allowedDownloads || 0,
    };
  },
};

/* ── Healthcare subscription adapter ──────────────────────────────────────
   Turns a VERIFIED payment into an active Healthcare subscription. The engine has already
   established that the money is real, terminal, unreversed, sufficient and owned by this
   caller (assertPaymentHonourable) before this handler is reached — so the handler does no
   payment reasoning of its own. Re-deriving payment truth in a domain is exactly the mistake
   that makes a client-supplied paymentRef sufficient to mint a paid plan, which is the defect
   this adapter exists to close.

   Writes accountSubscriptions/{uid}_healthcare — a DETERMINISTIC id, not .add(). One account
   holds one Healthcare subscription; an auto-id would let a replay or a second purchase
   silently create a second active plan, and the resolver would then pick whichever sorted
   first. Exactly-once is the engine's ledger; a stable id is what makes the domain agree.

   The tier and its capacity come from the INTENT's server-minted metadata, never from the
   request that triggered activation. */
const healthcareSubscription = {
  validate(ctx) {
    const tier = (ctx.intent.metadata && ctx.intent.metadata.tier) || null;
    if (!tier) { const e = new Error('Intent carries no Healthcare tier.'); e.code = 'tier_missing'; throw e; }
    const plans = require('./healthcare-plans');
    if (!plans.isHealthcareTier(tier)) {
      const e = new Error(`"${tier}" is not a Healthcare plan.`); e.code = 'tier_invalid'; throw e;
    }
  },

  activate(txn, ctx) {
    const plans = require('./healthcare-plans');
    const meta  = ctx.intent.metadata || {};
    const plan  = plans.resolve(meta.tier);
    const uid   = ctx.ownerUid;
    const ref   = _db().collection('accountSubscriptions').doc(`${uid}_${plans.HUB}`);
    const now   = Date.now();

    /* MUST use the supplied transaction — a handler that writes outside it breaks
       exactly-once, and the engine's own contract calls that a review-blocking defect. */
    txn.set(ref, {
      subscriptionId: `${uid}_${plans.HUB}`,
      accountId:      uid,
      role:           plans.HUB,          /* what _sourcesFor('healthcare') filters on */
      product:        'healthcare_plans',
      tier:           plan.id,
      planLabel:      plan.label,
      billingCycle:   'monthly',
      price:          plan.priceCents,
      currency:       'KES',
      status:         'active',
      trial:          false,
      /* Capacity SNAPSHOT — what was bought. limits.services is the publishable-service
         ceiling provider-ops enforces; limits.doctors is practitioner seats. `listings` is
         deliberately absent: aliasing it for Healthcare is what made the cap evaluate to NaN
         and disappear. */
      limits:         { doctors: plan.limits.doctors, services: plan.limits.services },
      /* NO commissionRate. subscription-core.getCommissionRate reads that field, so writing
         one here would create a second rate authority disagreeing with ADR-015's 5%. */
      currentPeriodStart: Timestamp.fromDate(new Date(now)),
      currentPeriodEnd:   Timestamp.fromDate(new Date(now + PLAN_DAYS * 86400000)),
      renewalAt:          Timestamp.fromDate(new Date(now + PLAN_DAYS * 86400000)),
      paymentMethod:  'intasend',
      updatedAt:      FieldValue.serverTimestamp(),
      createdAt:      FieldValue.serverTimestamp(),
    }, { merge: true });

    return { ref: ref.path, tier: plan.id };
  },

  status(ctx) { return { tier: (ctx.intent.metadata || {}).tier || null }; },
};

/* ── Registration ─────────────────────────────────────────────────────────
   Adding a future paid feature should require exactly this — one entry, zero
   engine modification. Guarded so a double-require cannot throw. */
function registerAll() {
  if (!engine.getPurpose('subscription')) {
    engine.registerPurpose('subscription', {
      resourceType: null,          /* the plan rides on intent.planId */
      handler:      subscription,
      expiresDays:  PLAN_DAYS,
      refundable:   true,
    });
  }
  if (!engine.getPurpose('healthcare_subscription')) {
    engine.registerPurpose('healthcare_subscription', {
      resourceType: 'healthcareSubscription',
      handler:      healthcareSubscription,
      expiresDays:  PLAN_DAYS,
      refundable:   true,
    });
  }
  /* Creator Hub: a purchase or rental of one film. The rental window rides on
     the server-minted intent (metadata.rentalDays) and is applied by the
     adapter, so the engine-level expiry stays null. */
  if (!engine.getPurpose('film_access')) {
    engine.registerPurpose('film_access', {
      resourceType: 'film',
      handler:      require('./creator-hub').filmAccessAdapter,
      expiresDays:  null,
      refundable:   true,
    });
  }
  if (!engine.getPurpose('digital_download')) {
    engine.registerPurpose('digital_download', {
      resourceType: 'digitalPurchase',
      handler:      digitalDownload,
      expiresDays:  null,          /* a purchased file does not expire */
      refundable:   true,
    });
  }
  return engine.registeredPurposes();
}

registerAll();

module.exports = {
  registerAll, isEngineEnabled, subscription, digitalDownload, FLAG_DOC, PLAN_DAYS,
  shadowCompareSubscription, COMPARE_COL, _diffSubscription,
};
