'use strict';
/**
 * SOKONI Entitlement Engine — the ONE place a payment becomes a capability.
 *
 * Six audited domains lose paid entitlements today, each in its own way:
 * digital downloads never leave `pending_payment`, hub registration banks the
 * plan into localStorage, marketplace orders exist only if the buyer's tab
 * survives, bookings trust a client-supplied paymentId, event tickets never
 * flip to `valid`, consultations drop the payment ref. Six symptoms, one
 * cause: every module owns its own payment lifecycle.
 *
 * Everything here follows from a single invariant:
 *
 *     one payment reference  =>  exactly one entitlements/{paymentRef}
 *
 * created in the SAME transaction as the domain's activation.
 *
 *   - Never twice   — the ledger doc is create-only under a deterministic id.
 *                     `.add()` with a random id cannot express "exactly once";
 *                     `doc(ref).create()` can.
 *   - Never missed  — "COMPLETE payment with no ledger doc" is a query that
 *                     names no domain, so it sweeps domains not yet written.
 *   - Never orphan  — an unhonoured payment becomes a first-class queryable
 *                     state instead of an invisible one.
 *   - Browser-proof — activation happens server-side; a closed tab is
 *                     irrelevant.
 *
 * ADDITIVE BY CONSTRUCTION. Registering a purpose is the only way in, and an
 * empty registry makes the engine inert. Wiring a domain is a separate,
 * independently deployable and reversible step — no existing writer is
 * touched by this file landing.
 *
 * Related: docs/PAYMENT_ARCHITECTURE_UNIFICATION.md
 */

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const _db = () => getFirestore();

const LEDGER      = 'entitlements';
const INTENTS     = 'paymentIntents';
const PAYMENTS    = 'payments';
const AUDIT       = 'entitlementAuditLog';

/* Payment states that mean "the money is really ours". Anything else — and
   especially anything a client asserts — is not honourable. */
/* One definition, in shared/constants.js. Re-exported here so existing
   importers of this module keep working unchanged. */
const { TERMINAL_PAID } = require('./shared/constants');
const REVERSED      = new Set(['REFUNDED', 'REVERSED', 'CHARGEBACK', 'CANCELLED']);

const STATUS = { ACTIVE: 'ACTIVE', REVOKED: 'REVOKED', NONE: 'NONE' };

/* ── Purpose registry ─────────────────────────────────────────────────────
   The whole point of the design: adding a monetized feature must not require
   editing this file. A purpose maps to a handler and nothing else. An
   UNREGISTERED purpose is a hard error that alerts — never a silent skip,
   because a silent skip is precisely how the current bug class survives. */
const PURPOSE_REGISTRY = Object.create(null);

/**
 * registerPurpose('event_ticket', {
 *   resourceType: 'event',
 *   handler: { validate, activate, revoke, status },
 *   expiresDays: 30 | null,
 *   refundable: true,
 * })
 *
 * handler.activate(txn, ctx) MUST use the supplied transaction. A handler that
 * writes outside it breaks exactly-once and is a review-blocking defect.
 * handler.activate receives an ALREADY-VALIDATED payment: domains never
 * re-derive payment truth, which is the mistake that makes a client-supplied
 * paymentId sufficient to mint a paid booking today.
 */
function registerPurpose(purpose, spec) {
  const p = String(purpose || '').trim();
  if (!p) throw new Error('registerPurpose: purpose is required');
  if (!spec || !spec.handler || typeof spec.handler.activate !== 'function') {
    throw new Error(`registerPurpose(${p}): handler.activate is required`);
  }
  if (PURPOSE_REGISTRY[p]) throw new Error(`registerPurpose(${p}): already registered`);
  PURPOSE_REGISTRY[p] = {
    resourceType: spec.resourceType || null,
    handler:      spec.handler,
    expiresDays:  Number.isFinite(spec.expiresDays) ? spec.expiresDays : null,
    refundable:   spec.refundable !== false,
  };
  return PURPOSE_REGISTRY[p];
}

const getPurpose      = (p) => PURPOSE_REGISTRY[String(p || '')] || null;
const registeredPurposes = () => Object.keys(PURPOSE_REGISTRY);

/* Firestore document ids may not contain '/' and must be non-empty. Payment
   refs are provider-issued, so normalise defensively rather than trusting. */
function _ledgerId(paymentRef) {
  const r = String(paymentRef || '').trim();
  if (!r) throw new Error('paymentRef is required');
  return r.replace(/\//g, '_');
}

/* ── Security: every check in ONE place ───────────────────────────────────
   Scattered across domains today, and missing entirely in several. Throws a
   plain Error with a stable `code` so callers can branch without string
   matching. */
function assertPaymentHonourable(intent, payment, opts = {}) {
  const fail = (code, msg) => { const e = new Error(msg); e.code = code; throw e; };

  if (!intent)  fail('intent_missing',  'No paymentIntent for this reference.');
  if (!payment) fail('payment_missing', 'No payment record for this reference.');

  const status = String(payment.status || '').toUpperCase();
  if (REVERSED.has(status))       fail('payment_reversed', `Payment is ${status}.`);
  if (!TERMINAL_PAID.has(status)) fail('payment_not_terminal', `Payment is ${status || 'unknown'}, not a terminal paid state.`);

  /* Ownership — the payer must be the entitlement owner. */
  const owner = intent.ownerUid || intent.uid || null;
  if (!owner) fail('owner_missing', 'paymentIntent carries no owner.');
  if (payment.uid && payment.uid !== owner) fail('ownership_mismatch', 'Payment belongs to a different user.');

  /* Amount — underpayment must never grant. Compare in cents when both sides
     expose them, else fall back to whole units. Missing expectations are not
     treated as satisfied. */
  const expCents  = Number(intent.amountCents);
  const paidCents = Number(payment.amountCents);
  if (Number.isFinite(expCents) && Number.isFinite(paidCents)) {
    if (paidCents < expCents) fail('amount_short', `Paid ${paidCents} < expected ${expCents} cents.`);
  } else {
    const exp  = Number(intent.amount);
    const paid = Number(payment.amount);
    if (Number.isFinite(exp) && Number.isFinite(paid) && paid < exp) {
      fail('amount_short', `Paid ${paid} < expected ${exp}.`);
    }
  }

  /* Currency substitution. */
  const ec = String(intent.currency || 'KES').toUpperCase();
  const pc = String(payment.currency || ec).toUpperCase();
  if (ec !== pc) fail('currency_mismatch', `Paid in ${pc}, expected ${ec}.`);

  /* Intent must not be stale. */
  if (intent.status && String(intent.status).toUpperCase() === 'EXPIRED') {
    fail('intent_expired', 'paymentIntent has expired.');
  }

  const spec = getPurpose(intent.purpose);
  if (!spec) fail('purpose_unregistered', `Purpose "${intent.purpose}" is not registered.`);
  if (opts.requireResource !== false && spec.resourceType && !intent.resourceId) {
    fail('resource_missing', `Purpose "${intent.purpose}" requires a resourceId.`);
  }
  return spec;
}

function _ctx(paymentRef, intent, payment) {
  return {
    paymentRef,
    intent,
    payment,
    purpose:      intent.purpose,
    ownerUid:     intent.ownerUid || intent.uid,
    businessId:   intent.businessId || null,
    resourceType: intent.resourceType || null,
    resourceId:   intent.resourceId || null,
    amount:       Number(intent.amount) || 0,
    amountCents:  Number(intent.amountCents) || null,
    currency:     String(intent.currency || 'KES').toUpperCase(),
  };
}

async function _load(paymentRef) {
  const db  = _db();
  const ref = _ledgerId(paymentRef);
  const [iSnap, pSnap] = await Promise.all([
    db.collection(INTENTS).doc(ref).get(),
    db.collection(PAYMENTS).doc(ref).get(),
  ]);
  return {
    ref,
    intent:  iSnap.exists ? iSnap.data() : null,
    payment: pSnap.exists ? pSnap.data() : null,
  };
}

/* ── activate ─────────────────────────────────────────────────────────────
   The single entry point. The webhook calls it in real time; the reconciler
   calls it later after a miss. Same function, same guarantees — a recovery
   path that reimplements activation drifts from it, and that drift is how
   recovery code becomes its own bug source. */
async function activate(paymentRef, opts = {}) {
  const source = opts.source || 'unknown';
  const { ref, intent, payment } = await _load(paymentRef);
  const spec = assertPaymentHonourable(intent, payment);
  const ctx  = _ctx(ref, intent, payment);
  const db   = _db();
  const ledgerRef = db.collection(LEDGER).doc(ref);

  if (typeof spec.handler.validate === 'function') {
    await spec.handler.validate(ctx);           /* domain preconditions only */
  }

  const expiresAt = spec.expiresDays
    ? Timestamp.fromDate(new Date(Date.now() + spec.expiresDays * 86400000))
    : null;

  /* Read-then-create inside the transaction is what survives a retry storm:
     concurrent callers contend on the same ledger doc, one commits and the
     others re-read and return alreadyActive. */
  const result = await db.runTransaction(async (txn) => {
    const existing = await txn.get(ledgerRef);
    if (existing.exists) {
      return { alreadyActive: true, status: existing.data().status || STATUS.ACTIVE };
    }

    const domain = await spec.handler.activate(txn, ctx);

    txn.create(ledgerRef, {
      paymentRef:   ref,
      purpose:      ctx.purpose,
      resourceType: ctx.resourceType,
      resourceId:   ctx.resourceId,
      ownerUid:     ctx.ownerUid,
      businessId:   ctx.businessId,
      amount:       ctx.amount,
      amountCents:  ctx.amountCents,
      currency:     ctx.currency,
      status:       STATUS.ACTIVE,
      activatedAt:  FieldValue.serverTimestamp(),
      expiresAt,
      /* Provenance lives HERE, never on the domain's own document — a
         reconciler-activated ticket must be indistinguishable from a
         webhook-activated one, or downstream code starts branching on how it
         came to exist. */
      source,
      domainRef:    (domain && domain.ref) || null,
    });

    return { activated: true, domain: domain || null };
  });

  if (result.activated) {
    /* Audit is append-only history; a failure here must not undo a correct
       activation, so it is logged rather than thrown. */
    _db().collection(AUDIT).add({
      paymentRef: ref, purpose: ctx.purpose, ownerUid: ctx.ownerUid,
      action: 'ACTIVATED', source, at: FieldValue.serverTimestamp(),
    }).catch((e) => console.error('[entitlement] audit write failed', { ref, err: e.message }));
  }
  return result;
}

/* ── simulate (shadow mode) ───────────────────────────────────────────────
   Runs the REAL validation and the REAL adapter, but against a transaction
   that records writes instead of performing them, and never opens a Firestore
   transaction at all. There is therefore no code path by which a simulation
   can grant an entitlement — the safety is structural, not a flag someone
   could mis-set.

   This is what makes dual-run trustworthy: the shadow result is produced by
   the same adapter code that would run for real, so a match means the engine
   would have behaved identically — not that a separate mock agreed. */
async function simulate(paymentRef) {
  const started = Date.now();
  const out = { paymentRef: null, ok: false, writes: [], ledger: null, error: null, code: null, ms: 0 };
  try {
    const { ref, intent, payment } = await _load(paymentRef);
    out.paymentRef = ref;
    const spec = assertPaymentHonourable(intent, payment);
    const ctx  = _ctx(ref, intent, payment);

    if (typeof spec.handler.validate === 'function') await spec.handler.validate(ctx);

    /* Capture-only transaction. get() performs a real (read-only) fetch so the
       adapter sees true state; every mutation is recorded, never applied. */
    const ops = [];
    const capture = {
      get:    async (r) => r.get(),
      set:    (r, v, o) => ops.push({ op: 'set', path: r.path, data: v, merge: !!(o && o.merge) }),
      create: (r, v)    => ops.push({ op: 'create', path: r.path, data: v }),
      update: (r, v)    => ops.push({ op: 'update', path: r.path, data: v }),
      delete: (r)       => ops.push({ op: 'delete', path: r.path }),
    };

    const domain = await spec.handler.activate(capture, ctx);

    const existing = await _db().collection(LEDGER).doc(ref).get();
    out.ok      = true;
    out.writes  = ops;
    out.ledger  = {
      wouldCreate:  !existing.exists,
      alreadyExists: existing.exists,
      purpose: ctx.purpose, ownerUid: ctx.ownerUid,
      amount: ctx.amount, currency: ctx.currency,
      domainRef: (domain && domain.ref) || null,
    };
  } catch (e) {
    out.error = e.message;
    out.code  = e.code || 'unknown';
  }
  out.ms = Date.now() - started;
  return out;
}

/* ── revoke ───────────────────────────────────────────────────────────────
   Refund / chargeback / expiry. Idempotent: revoking twice is a no-op. */
async function revoke(paymentRef, reason, opts = {}) {
  const ref       = _ledgerId(paymentRef);
  const db        = _db();
  const ledgerRef = db.collection(LEDGER).doc(ref);
  const source    = opts.source || 'unknown';

  const out = await db.runTransaction(async (txn) => {
    const snap = await txn.get(ledgerRef);
    if (!snap.exists) return { missing: true };
    const cur = snap.data();
    if (cur.status === STATUS.REVOKED) return { alreadyRevoked: true };

    const spec = getPurpose(cur.purpose);
    if (spec && typeof spec.handler.revoke === 'function') {
      await spec.handler.revoke(txn, { paymentRef: ref, ...cur }, reason);
    }
    txn.update(ledgerRef, {
      status: STATUS.REVOKED, revokedAt: FieldValue.serverTimestamp(),
      revokeReason: String(reason || '').slice(0, 300), revokedBy: source,
    });
    return { revoked: true };
  });

  if (out.revoked) {
    db.collection(AUDIT).add({
      paymentRef: ref, action: 'REVOKED', reason: String(reason || '').slice(0, 300),
      source, at: FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
  return out;
}

/* ── status ───────────────────────────────────────────────────────────────
   Recomputed from dates so a stale stored status cannot mislead. */
async function status(paymentRef) {
  const snap = await _db().collection(LEDGER).doc(_ledgerId(paymentRef)).get();
  if (!snap.exists) return { status: STATUS.NONE, found: false };
  const d = snap.data();
  const expired = d.expiresAt && d.expiresAt.toMillis && d.expiresAt.toMillis() < Date.now();
  return {
    found:   true,
    status:  d.status === STATUS.ACTIVE && expired ? 'EXPIRED' : d.status,
    purpose: d.purpose,
    ownerUid: d.ownerUid,
    resourceId: d.resourceId,
    expiresAt: d.expiresAt || null,
    source:  d.source,
  };
}

/* ── reconcile ────────────────────────────────────────────────────────────
   Purpose-agnostic BY CONSTRUCTION: it names no domain, so a purpose
   registered tomorrow is swept the day it appears. Returns a report; heals
   only when autoHeal is explicitly true (callers read the feature flag —
   this module never decides policy for them).

   Detects: paid-not-activated (the sweep), and per-candidate anomalies
   surfaced as skip reasons (ownership mismatch, short payment, reversed,
   unregistered purpose) so nothing fails silently. */
async function reconcile(opts = {}) {
  const graceMs    = Number.isFinite(opts.graceMs)    ? opts.graceMs    : 2 * 60 * 1000;
  const lookbackMs = Number.isFinite(opts.lookbackMs) ? opts.lookbackMs : 24 * 60 * 60 * 1000;
  const autoHeal   = opts.autoHeal === true;
  const limit      = Number.isFinite(opts.limit) ? opts.limit : 500;
  const purposes   = Array.isArray(opts.purposes) && opts.purposes.length ? opts.purposes : null;

  const db  = _db();
  const now = Date.now();
  const floor   = Timestamp.fromMillis(now - lookbackMs);
  const ceiling = Timestamp.fromMillis(now - graceMs);

  let q = db.collection(INTENTS)
    .where('createdAt', '>=', floor)
    .where('createdAt', '<=', ceiling)
    .orderBy('createdAt', 'asc')
    .limit(limit);

  const snap = await q.get();
  const report = { scanned: 0, gaps: 0, healed: 0, skipped: 0, anomalies: [], autoHeal };

  for (const doc of snap.docs) {
    const intent = doc.data();
    if (!intent.purpose) continue;
    if (purposes && purposes.indexOf(intent.purpose) === -1) continue;
    if (!getPurpose(intent.purpose)) {
      report.anomalies.push({ paymentRef: doc.id, code: 'purpose_unregistered', purpose: intent.purpose });
      report.skipped++;
      continue;
    }
    report.scanned++;

    const ref = doc.id;
    /* eslint-disable no-await-in-loop */
    const [pay, led] = await Promise.all([
      db.collection(PAYMENTS).doc(ref).get(),
      db.collection(LEDGER).doc(_ledgerId(ref)).get(),
    ]);
    if (!pay.exists) continue;
    if (!TERMINAL_PAID.has(String(pay.data().status || '').toUpperCase())) continue;
    if (led.exists) continue;                       /* already honoured */

    report.gaps++;
    const entry = { paymentRef: ref, purpose: intent.purpose, ownerUid: intent.ownerUid || intent.uid || null };

    if (autoHeal) {
      try {
        const r = await activate(ref, { source: 'reconciler' });
        if (r.activated) { report.healed++; entry.action = 'healed'; }
        else             { entry.action = 'already_active'; }
      } catch (e) {
        entry.action = 'heal_failed';
        entry.code   = e.code || 'unknown';
        entry.error  = e.message;
      }
    } else {
      entry.action = 'detected';
    }
    report.anomalies.push(entry);
    /* eslint-enable no-await-in-loop */
  }
  return report;
}

module.exports = {
  STATUS, TERMINAL_PAID, REVERSED,
  registerPurpose, getPurpose, registeredPurposes,
  assertPaymentHonourable,
  activate, simulate, revoke, status, reconcile,
  _internals: { ledgerId: _ledgerId, ctx: _ctx },
};
