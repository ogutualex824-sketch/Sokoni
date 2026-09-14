'use strict';
/**
 * SOKONI AdminOS — Merchant Subscription & commission traceability.
 * ============================================================================================
 * A READ AND AUDIT surface. It creates no financial record, writes nothing, and holds no
 * aggregate of its own: every figure below is read from the collection that authored it, at
 * the moment it is asked for.
 *
 * ── WHY IT IS NOT A DASHBOARD LEDGER ───────────────────────────────────────────────────────
 * The obvious way to make an admin dashboard fast is to maintain a rollup document and update
 * it on every settlement. That is a SECOND financial ledger, and a second ledger is how a
 * platform ends up with two answers to "how much commission did we earn" — the one the
 * settlements hold and the one the dashboard shows. This module therefore aggregates on read,
 * from `settlements`, `merchantSubscriptions`, `entitlements` and the rest, and is allowed to
 * be slower for it.
 *
 * ── THE FOUR RAILS ARE NEVER ONE NUMBER ────────────────────────────────────────────────────
 *     SUBSCRIPTION   what a merchant pays SOKONI for a package
 *     MARKETPLACE    package-dependent commission on an order SOKONI brought them  16/12/8/4
 *     POS_TILL       flat 5% on a sale the merchant made themselves
 *     HEALTHCARE     flat 5% on a provider booking (ADR-015, independent)
 *
 * These are different products with different rates, different payers and different release
 * events. Summing them into one "commission" figure is the reporting equivalent of the ten
 * plan catalogues: every screen would be internally consistent and mutually contradictory.
 * Every record this module returns therefore carries an explicit `commissionType`, and it is
 * read from the record's own provenance — NEVER inferred from an amount or a rate, because
 * POS and Healthcare are both 5% and would be indistinguishable by value alone.
 *
 * ── TRACEABLE IS NOT EDITABLE ──────────────────────────────────────────────────────────────
 * There is deliberately no write path here, not even for an admin correction. A settled
 * commission rate is a historical fact: an admin who could change 8% to 4% on a past order
 * would erase the evidence that it settled at 8%. Corrections belong to the existing payout
 * and reversal lifecycle, which appends rather than overwrites.
 *
 * ── "REAL TIME" — WHAT IS AND IS NOT PROVIDED ──────────────────────────────────────────────
 * Every read here hits the authoritative collection directly, so a caller always sees current
 * state — there is no copy that can lag. What this canNOT provide is server-PUSHED updates:
 * adminOsDispatch is a callable, and a callable answers a question, it does not hold a
 * subscription open.
 *
 * Push would need one of two things, and both are out of scope here: a client `onSnapshot` on
 * `settlements` (which firestore.rules correctly restricts to admins, and rules may not change
 * in this gate), or a channel on the Realtime Control Plane (certified separately; not to be
 * reopened). The honest position is therefore: live-on-read, not live-push. A dashboard should
 * poll this surface rather than be told it is streaming.
 */

const { getFirestore } = require('firebase-admin/firestore');

const _db = () => getFirestore();

/* ── Authorization ─────────────────────────────────────────────────────────────────────────
   Financial aggregation across every merchant is an admin capability. A merchant may read
   their OWN settlements through the existing seller surfaces; this module never widens that.
   Throws the same shape admin-os.js throws, so the dispatcher's error handling is unchanged. */
function _requireAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new Error('admin required');
}

const COMMISSION_TYPES = Object.freeze(['MARKETPLACE', 'POS_TILL', 'HEALTHCARE']);
const MONEY_RAILS = Object.freeze(['SUBSCRIPTION', ...COMMISSION_TYPES]);

const _num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const _cap = (n) => Math.min(Math.max(1, Number(n) || 100), 500);
const _ms = (v) => {
  if (!v) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
};
/* Never return a payment secret, credential or raw gateway payload to a dashboard. */
const _safeRef = (v) => (v == null ? null : String(v).slice(0, 128));

/* ════════════════════════════════════════════════════════════════════════════════════════
   1. TRACE A MERCHANT SUBSCRIPTION PAYMENT
   merchant -> subscription -> payment -> paymentRef -> entitlement -> activation -> package
   ════════════════════════════════════════════════════════════════════════════════════════ */
exports._h = {};

exports._h.adminTraceMerchantSubscription = async (req) => {
  _requireAdmin(req);
  const db = _db();
  const uid = String(req.data?.merchantUid || '').trim();
  if (!uid) throw new Error('merchantUid is required');

  /* Canonical store first, then the legacy stores that still hold production rows — the same
     precedence subscription-core uses, so the admin view and the money path cannot disagree
     about which subscription is in force. */
  const [canonSnap, legacySnap, acctSnap] = await Promise.all([
    db.collection('merchantSubscriptions').doc(uid).get().catch(() => null),
    db.collection('subscriptions').where('uid', '==', uid).limit(10).get().catch(() => null),
    db.collection('accountSubscriptions').where('accountId', '==', uid).limit(10).get().catch(() => null),
  ]);

  const records = [];
  if (canonSnap && canonSnap.exists) {
    const d = canonSnap.data();
    records.push({
      store: 'merchantSubscriptions', authoritative: true, id: canonSnap.id,
      package: d.package || d.tier || null, legacyPlan: d.legacyPlan || null,
      status: d.status || null, priceCents: _num(d.price),
      activatedAt: _ms(d.activatedAt), expiresAt: _ms(d.expiresAt || d.currentPeriodEnd),
      paymentRef: _safeRef(d.paymentRef), source: d.source || null,
    });
  }
  (legacySnap ? legacySnap.docs : []).forEach((s) => {
    const d = s.data();
    records.push({
      store: 'subscriptions', authoritative: false, id: s.id,
      package: d.planId || d.plan || d.tier || null, status: d.status || d.subscriptionStatus || null,
      priceCents: _num(d.lastPaymentAmountCents), hubType: d.hubType || null,
      activatedAt: _ms(d.currentPeriodStart || d.activatedAt),
      expiresAt: _ms(d.expiresAt || d.currentPeriodEnd),
      paymentRef: _safeRef(d.paymentRef || d.lastPaymentRef),
    });
  });
  (acctSnap ? acctSnap.docs : []).forEach((s) => {
    const d = s.data();
    records.push({
      store: 'accountSubscriptions', authoritative: false, id: s.id,
      package: d.tier || null, role: d.role || null, status: d.status || null,
      priceCents: _num(d.price), expiresAt: _ms(d.currentPeriodEnd),
      paymentRef: _safeRef(d.paymentRef),
    });
  });

  /* Follow every payment reference to the money that authorised it. The entitlement ledger is
     the proof a payment was HONOURED exactly once; `subscriptionPaymentRefs` is the claim that
     stops one payment buying two periods. Both were invisible to AdminOS before this. */
  const refs = [...new Set(records.map((r) => r.paymentRef).filter(Boolean))];
  const chain = [];
  for (const ref of refs.slice(0, 20)) {
    const [pay, intent, ent, claim] = await Promise.all([
      db.collection('payments').doc(ref).get().catch(() => null),
      db.collection('paymentIntents').doc(ref).get().catch(() => null),
      db.collection('entitlements').doc(ref).get().catch(() => null),
      db.collection('subscriptionPaymentRefs').doc(ref).get().catch(() => null),
    ]);
    const p = pay && pay.exists ? pay.data() : null;
    const i = intent && intent.exists ? intent.data() : null;
    const e = ent && ent.exists ? ent.data() : null;
    chain.push({
      paymentRef: _safeRef(ref),
      payment: p ? { status: p.status || null, amountCents: _num(p.amountCents) || _num(p.amount) * 100,
        uid: p.uid || null, paidAt: _ms(p.updatedAt || p.createdAt) } : null,
      intent: i ? { purpose: i.purpose || null, amountCents: _num(i.amountCents),
        ownerUid: i.ownerUid || i.uid || null } : null,
      /* The honoured-exactly-once proof. Absent means the money arrived and nothing recorded
         granting anything for it — which is a finding, not a blank cell. */
      entitlement: e ? { status: e.status || null, purpose: e.purpose || null,
        activatedAt: _ms(e.activatedAt), expiresAt: _ms(e.expiresAt),
        source: e.source || null, ownerUid: e.ownerUid || null } : null,
      entitlementMissing: !e,
      replayClaim: claim && claim.exists ? { claimedAt: _ms(claim.data().claimedAt) } : null,
      /* Reversal is read from the payment's own terminal state, never assumed from absence. */
      reversed: !!(p && ['REFUNDED', 'REVERSED', 'CHARGEBACK', 'CANCELLED']
        .includes(String(p.status || '').toUpperCase())),
    });
  }

  return {
    merchantUid: uid,
    authoritativeStore: canonSnap && canonSnap.exists ? 'merchantSubscriptions' : (records[0] ? records[0].store : null),
    subscriptions: records,
    paymentChain: chain,
    /* Stated rather than implied: more than one store holding a subscription is the condition
       the convergence exists to end, and an admin should see it rather than infer it. */
    multiStore: records.length > 1,
  };
};

/* ════════════════════════════════════════════════════════════════════════════════════════
   2. TRACE A MARKETPLACE SETTLEMENT
   merchant -> package -> order -> gross -> rate -> commission -> rider -> net -> wallet
   ════════════════════════════════════════════════════════════════════════════════════════ */
exports._h.adminTraceMarketplaceSettlement = async (req) => {
  _requireAdmin(req);
  const db = _db();
  const orderId = String(req.data?.orderId || '').trim();
  if (!orderId) throw new Error('orderId is required');

  const sSnap = await db.collection('settlements').doc(orderId).get();
  if (!sSnap.exists) return { orderId, found: false };
  const s = sSnap.data();
  const sellerId = s.sellerId || s.sellerUid || null;

  const [wtSnap, orderSnap] = await Promise.all([
    sellerId ? db.collection('walletTransactions').doc(`${sellerId}_${orderId}_ordersettle`).get().catch(() => null) : null,
    db.collection('orders').doc(orderId).get().catch(() => null),
  ]);
  const wt = wtSnap && wtSnap.exists ? wtSnap.data() : null;
  const o = orderSnap && orderSnap.exists ? orderSnap.data() : null;

  const gross = _num(s.grossCents);
  const commission = _num(s.commissionCents);

  return {
    orderId, found: true,
    commissionType: 'MARKETPLACE',          /* explicit; never inferred from the rate */
    merchantUid: sellerId,
    /* The package in force AT SETTLEMENT, read from the settlement record if it carried one.
       Null is reported as null: reading today's package and presenting it as the historical
       one would be a fabricated fact, and the whole point of this surface is that a rate can
       be explained years later. */
    packageAtSettlement: s.package || s.plan || s.tier || null,
    gross: { cents: gross },
    commission: {
      cents: commission,
      /* Derived for display ONLY, and only from figures the settlement itself holds. */
      effectivePct: gross > 0 ? Math.round((commission / gross) * 10000) / 100 : null,
      rateRecorded: s.commissionRate != null ? s.commissionRate : null,
    },
    riderDeductionCents: _num(s.riderCents || s.deliveryCents || s.riderDeductionCents),
    sellerNetCents: _num(s.sellerNetCents),
    walletTransaction: wt ? {
      id: `${sellerId}_${orderId}_ordersettle`, creditedShillings: _num(wt.amount),
      appliedToDebt: _num(wt.appliedToDebt), grossCents: _num(wt.grossCents),
      commissionCents: _num(wt.commissionCents), netCents: _num(wt.netCents),
    } : null,
    /* THE INVARIANT, checked rather than asserted: the wallet must have been credited the NET,
       never the gross. A mismatch here is a money defect, and it should surface in the audit
       surface rather than wait for a reconciliation. */
    netCreditVerified: !!wt && _num(wt.netCents) === _num(s.sellerNetCents)
      && _num(wt.grossCents) !== _num(wt.amount) * 100,
    release: {
      deliveryProof: s.deliveryProof || null,       /* 'not_required' is a value, not a blank */
      settledAt: _ms(s.settledAt || s.createdAt),
      status: s.status || s.settlementStatus || null,
    },
    order: o ? { status: o.status || null, paymentRef: _safeRef(o.paymentRef || o.paymentId) } : null,
    reversal: s.reversedAt ? { reversedAt: _ms(s.reversedAt), reason: s.reversalReason || null } : null,
  };
};

/* ════════════════════════════════════════════════════════════════════════════════════════
   3. THE FOUR RAILS, SEPARATED — the SuperAdmin headline figures
   ════════════════════════════════════════════════════════════════════════════════════════ */
exports._h.adminCommissionByRail = async (req) => {
  _requireAdmin(req);
  const db = _db();
  const sinceMs = _ms(req.data?.since) || (Date.now() - 30 * 86400000);
  const limit = _cap(req.data?.limit);

  const out = {};
  MONEY_RAILS.forEach((r) => { out[r] = { count: 0, grossCents: 0, commissionCents: 0, source: null, note: null }; });

  /* MARKETPLACE — settlements carry gross, commission and net for every order. */
  try {
    const snap = await db.collection('settlements').limit(limit).get();
    snap.docs.forEach((d) => {
      const s = d.data();
      if (String(s.category || 'marketplace') !== 'marketplace') return;
      const at = _ms(s.settledAt || s.createdAt);
      if (at && at < sinceMs) return;
      out.MARKETPLACE.count += 1;
      out.MARKETPLACE.grossCents += _num(s.grossCents);
      out.MARKETPLACE.commissionCents += _num(s.commissionCents);
    });
    out.MARKETPLACE.source = 'settlements';
  } catch (e) { out.MARKETPLACE.note = 'unavailable: ' + (e.code || e.message); }

  /* POS_TILL — its own liability ledger, deliberately NOT settlements. Flat 5% on every
     package; if this ever tracks the marketplace ladder, that is a defect, not a feature. */
  try {
    const snap = await db.collection('posCommissionLiabilities').limit(limit).get();
    snap.docs.forEach((d) => {
      const s = d.data();
      const at = _ms(s.createdAt || s.saleAt);
      if (at && at < sinceMs) return;
      out.POS_TILL.count += 1;
      out.POS_TILL.grossCents += _num(s.grossCents || s.saleCents);
      out.POS_TILL.commissionCents += _num(s.commissionCents || s.amountCents);
    });
    out.POS_TILL.source = 'posCommissionLiabilities';
  } catch (e) { out.POS_TILL.note = 'unavailable: ' + (e.code || e.message); }

  /* HEALTHCARE — provider payouts carry the booking's own gross/commission/net. */
  try {
    const snap = await db.collection('providerPayouts').limit(limit).get();
    snap.docs.forEach((d) => {
      const s = d.data();
      const at = _ms(s.settledAt || s.createdAt);
      if (at && at < sinceMs) return;
      out.HEALTHCARE.count += 1;
      out.HEALTHCARE.grossCents += _num(s.gross);
      out.HEALTHCARE.commissionCents += _num(s.commission);
    });
    out.HEALTHCARE.source = 'providerPayouts';
  } catch (e) { out.HEALTHCARE.note = 'unavailable: ' + (e.code || e.message); }

  /* SUBSCRIPTION — what merchants paid SOKONI. NOT a commission, and kept on its own rail so
     a dashboard cannot add a subscription fee to a commission total. */
  try {
    const [canon, legacy] = await Promise.all([
      db.collection('merchantSubscriptions').limit(limit).get(),
      db.collection('subscriptions').limit(limit).get(),
    ]);
    const seen = new Set();
    canon.docs.forEach((d) => {
      const s = d.data(); seen.add(d.id);
      out.SUBSCRIPTION.count += 1;
      out.SUBSCRIPTION.grossCents += _num(s.price);
    });
    legacy.docs.forEach((d) => {
      if (seen.has(d.id)) return;              /* the same merchant, already counted */
      const s = d.data();
      out.SUBSCRIPTION.count += 1;
      out.SUBSCRIPTION.grossCents += _num(s.lastPaymentAmountCents);
    });
    out.SUBSCRIPTION.source = 'merchantSubscriptions + subscriptions';
  } catch (e) { out.SUBSCRIPTION.note = 'unavailable: ' + (e.code || e.message); }

  return {
    since: sinceMs, scannedLimitPerRail: limit,
    rails: out,
    /* Load-bearing: a caller must not sum these. They are different products with different
       payers, and a combined figure answers no question anybody actually has. */
    combinedTotalProvided: false,
    liveness: 'read-through',
    livenessNote: 'Every figure is read from its authoring collection at call time — there is '
                + 'no cached rollup that can lag. Server-PUSHED updates are not provided: this '
                + 'is a callable, and push would require either an admin client onSnapshot '
                + '(rules-gated) or an RTCP channel. Poll; do not present as streaming.',
  };
};

/* ════════════════════════════════════════════════════════════════════════════════════════
   4. FILTERED COMMISSION RECORDS — one explicit type per row
   ════════════════════════════════════════════════════════════════════════════════════════ */
exports._h.adminListCommissionRecords = async (req) => {
  _requireAdmin(req);
  const db = _db();
  const d = req.data || {};
  const type = String(d.commissionType || 'MARKETPLACE').toUpperCase();
  if (!COMMISSION_TYPES.includes(type)) {
    throw new Error(`commissionType must be one of ${COMMISSION_TYPES.join(', ')}`);
  }
  const limit = _cap(d.limit);
  const merchantUid = d.merchantUid ? String(d.merchantUid) : null;
  const sinceMs = _ms(d.since);
  const untilMs = _ms(d.until);

  const COLL = { MARKETPLACE: 'settlements', POS_TILL: 'posCommissionLiabilities', HEALTHCARE: 'providerPayouts' };
  const OWNER = { MARKETPLACE: ['sellerId', 'sellerUid'], POS_TILL: ['merchantUid', 'sellerUid'], HEALTHCARE: ['providerId'] };

  let rows = [];
  try {
    const snap = await db.collection(COLL[type]).limit(limit).get();
    rows = snap.docs.map((doc) => {
      const s = doc.data();
      const owner = OWNER[type].map((k) => s[k]).find(Boolean) || null;
      const at = _ms(s.settledAt || s.createdAt || s.saleAt);
      return {
        id: doc.id,
        commissionType: type,                 /* explicit on every row, always */
        merchantUid: owner,
        grossCents: _num(s.grossCents || s.saleCents || s.gross),
        commissionCents: _num(s.commissionCents || s.amountCents || s.commission),
        netCents: _num(s.sellerNetCents || s.net),
        status: s.status || s.settlementStatus || null,
        at,
        reference: _safeRef(s.paymentRef || s.orderId || s.bookingId || doc.id),
        packageAtRecord: s.package || s.plan || s.tier || null,
      };
    });
  } catch (e) {
    return { commissionType: type, records: [], note: 'unavailable: ' + (e.code || e.message) };
  }

  if (merchantUid) rows = rows.filter((r) => r.merchantUid === merchantUid);
  if (sinceMs) rows = rows.filter((r) => r.at == null || r.at >= sinceMs);
  if (untilMs) rows = rows.filter((r) => r.at == null || r.at <= untilMs);
  if (d.status) rows = rows.filter((r) => String(r.status) === String(d.status));
  if (d.package) rows = rows.filter((r) => String(r.packageAtRecord || '').toLowerCase() === String(d.package).toLowerCase());
  if (d.reference) rows = rows.filter((r) => r.reference === String(d.reference));

  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  return { commissionType: type, count: rows.length, records: rows, filters: {
    merchantUid: merchantUid || null, since: sinceMs || null, until: untilMs || null,
    status: d.status || null, package: d.package || null, reference: d.reference || null,
  } };
};

module.exports.COMMISSION_TYPES = COMMISSION_TYPES;
module.exports.MONEY_RAILS = MONEY_RAILS;
