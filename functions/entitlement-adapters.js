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
const PLAN_DAYS  = 30;                       /* matches activateSubscription */
const VALID_PLANS = new Set(['free', 'starter', 'pro', 'business']);

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
    const expiresAt = Timestamp.fromDate(new Date(Date.now() + PLAN_DAYS * 86400000));

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
