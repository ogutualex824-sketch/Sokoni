'use strict';
/**
 * rider-entitlement.js — THE ONE authority for what a rider is owed for a delivery (Repair 5).
 *
 *     delivery record  ->  authoritative rider entitlement  ->  credit / refund / H2 execution
 *
 * The rider is owed the `riderEarning` of the delivery quote the SERVER issued and bound to this
 * order. That figure is derived from the trip (operating cost + the rider's time, see
 * delivery-quote-authority.quote) and was fixed before the rider accepted the job. It is NEVER a
 * percentage of anything: not 88% of a delivery fee (finos.js, finos-router.js,
 * settlement-engine.js), not the fee minus a hub commission (index.js onOrderStatusChange), not a
 * browser-computed `driverNet`, not an amount a queue entry or a caller states.
 *
 * INDEPENDENT OF THE BUYER. Nothing here reads a refund, a dispute, a return, an escrow state or the
 * order's `deliveryFee`. A seller-caused product failure can refund the buyer 100% while the rider
 * remains owed what they earned for a delivery they completed. Whether and how that entitlement is
 * PAID when a refund happens is H2's decision; WHAT it is is decided here, and nowhere else.
 *
 * WHY THE DELIVERY RECORD ALONE IS NOT ENOUGH. The served rules let any signed-in user CREATE a
 * `packageRequests` document (`allow create: if claimsOwner()`), with any fields, including a
 * self-consistent `deliveryQuote`, an `orderId` and a rider. Production holds five such browser
 * records (`DEL-…`, all carrying `uid`) beside the server's (`DEL<ref>`, none carrying `uid`), and
 * one order's `deliveryRef` points at a browser record. `assertSettleable` checks a quote's own
 * arithmetic and the policy — a forged quote that adds up passes it. So the entitlement is admitted
 * only when every link is server-authored:
 *
 *   1. the delivery record is SERVER-authored: `claimsOwner()` forces a client-created record to
 *      carry `uid == creator`, and no server writer sets `uid`. A record with `uid` is refused —
 *      including one squatted on the server's own id, which then pays NOBODY rather than the squatter;
 *   2. it names this order;
 *   3. its pinned quote is settleable (delivery-quote-authority.assertSettleable, with the
 *      renegotiation guard against the policy in force — the same contract dispatch.js applies);
 *   4. the pin is the SAME quote the server issued: `deliveryQuotes/{quoteId}` (no client rule —
 *      server-only) exists, is `consumed` by THIS order (single-use binding, RES-1), and its
 *      rider / charge / commission / version equal the pin's;
 *   5. the rider is the one the SERVER assigned (`assignedDriverId`, written only by the accept
 *      path), and no other rider field on the record or the order disagrees.
 *
 * Anything else REFUSES with a stated reason. Refusal pays nobody and hides nothing; it is never
 * a fallback percentage and never a silent zero.
 */
const dqa = require('./delivery-quote-authority');

const DELIVERIES = 'packageRequests';
const QUOTES = 'deliveryQuotes';

const REFUSAL = Object.freeze({
  NO_DELIVERY_RECORD:   'no_delivery_record',
  AMBIGUOUS:            'ambiguous_delivery_record',
  CLIENT_AUTHORED:      'delivery_record_client_authored',
  ORDER_MISMATCH:       'delivery_record_not_for_this_order',
  NO_RIDER:             'no_assigned_rider',
  RIDER_MISMATCH:       'rider_mismatch',
  POLICY_UNSET:         'pricing_policy_required',
  QUOTE_RECORD_MISSING: 'quote_record_missing',
  QUOTE_NOT_BOUND:      'quote_not_bound_to_this_order',
  QUOTE_DIVERGES:       'pinned_quote_diverges_from_issued_quote',
});

const _minor = (m) => (m && Number.isInteger(m.minorUnits) ? m.minorUnits : (Number.isInteger(m) ? m : null));
const _refuse = (reason, detail) => ({ ok: false, reason, detail: detail || null });

/**
 * Pure decision over one delivery record. No I/O.
 * @returns {{ok:true, riderUid, minorUnits, customerChargeMinor, sokoniCommissionMinor, quoteId,
 *            pricingVersion, deliveryId} | {ok:false, reason, detail}}
 */
function evaluate({ orderId, deliveryId, delivery, quoteRecord, policy, orderRiderUid }) {
  if (!delivery) return _refuse(REFUSAL.NO_DELIVERY_RECORD);
  if (delivery.uid != null) return _refuse(REFUSAL.CLIENT_AUTHORED, deliveryId);
  if (String(delivery.orderId || '') !== String(orderId || '') || !orderId) {
    return _refuse(REFUSAL.ORDER_MISMATCH, deliveryId);
  }
  if (!policy) return _refuse(REFUSAL.POLICY_UNSET);

  const pinned = delivery.deliveryQuote;
  let riderMinor;
  try {
    riderMinor = dqa.assertSettleable(pinned, null, { currentPolicy: policy }).minorUnits;
  } catch (e) {
    return _refuse((e && e.reason) || 'unsettleable_quote', e && e.detail);
  }

  if (!quoteRecord) return _refuse(REFUSAL.QUOTE_RECORD_MISSING, pinned.quoteId);
  if (quoteRecord.status !== 'consumed' || String(quoteRecord.orderId || '') !== String(orderId)) {
    return _refuse(REFUSAL.QUOTE_NOT_BOUND, pinned.quoteId);
  }
  const charge = _minor(pinned.customerCharge), commission = _minor(pinned.sokoniCommission);
  const diverged = [
    ['riderEarningMinor', riderMinor],
    ['customerChargeMinor', charge],
    ['sokoniCommissionMinor', commission],
  ].filter(([k, v]) => quoteRecord[k] !== v).map(([k]) => k);
  if (quoteRecord.pricingVersion !== pinned.pricingVersion) diverged.push('pricingVersion');
  if (diverged.length) return _refuse(REFUSAL.QUOTE_DIVERGES, diverged.join(','));

  const riderUid = delivery.assignedDriverId || null;
  if (!riderUid) return _refuse(REFUSAL.NO_RIDER);
  const others = [delivery.riderId, delivery.assignedDriverUid, delivery.assignedRiderId, orderRiderUid]
    .filter((v) => v != null && v !== '');
  if (others.some((v) => v !== riderUid)) return _refuse(REFUSAL.RIDER_MISMATCH, deliveryId);

  return {
    ok: true,
    riderUid,
    minorUnits: riderMinor,
    customerChargeMinor: charge,
    sokoniCommissionMinor: commission,
    quoteId: pinned.quoteId,
    pricingVersion: pinned.pricingVersion,
    deliveryId,
  };
}

/**
 * The entitlement for an order, read from Firestore. Exactly one server-authored delivery record
 * backed by the order's bound quote must qualify; none refuses, two or more refuses as ambiguous.
 * `opts.orderRiderUid` — the rider the caller's own record names (e.g. the order), cross-checked.
 * Reads only; writes nothing. `tx` (optional) performs the reads inside a transaction.
 */
async function forOrder(db, orderId, opts) {
  opts = opts || {};
  if (!orderId) return _refuse(REFUSAL.NO_DELIVERY_RECORD);
  const read = (q) => (opts.tx ? opts.tx.get(q) : q.get());
  const snap = await read(db.collection(DELIVERIES).where('orderId', '==', String(orderId)).limit(10));
  if (snap.empty) return _refuse(REFUSAL.NO_DELIVERY_RECORD);

  const policy = await dqa.loadPolicy(db);
  const results = [];
  for (const d of snap.docs) {
    const delivery = d.data() || {};
    const qid = delivery.deliveryQuote && delivery.deliveryQuote.quoteId;
    let quoteRecord = null;
    if (qid && delivery.uid == null) {
      const q = await read(db.collection(QUOTES).doc(String(qid)));
      quoteRecord = q.exists ? q.data() : null;
    }
    results.push(evaluate({ orderId, deliveryId: d.id, delivery, quoteRecord, policy,
      orderRiderUid: opts.orderRiderUid || null }));
  }
  const good = results.filter((r) => r.ok);
  if (good.length === 1) return good[0];
  if (good.length > 1) return _refuse(REFUSAL.AMBIGUOUS, good.map((r) => r.deliveryId).join(','));
  /* Report the server record's reason when there is one — a browser record's refusal is noise. */
  const serverSide = results.find((r) => r.reason !== REFUSAL.CLIENT_AUTHORED);
  return serverSide || results[0];
}

/** The ONE exactly-once key for a rider's delivery earning on an order, shared by every credit path. */
function creditKey(riderUid, orderId) { return `${riderUid}_${orderId}_delivery`; }

/** `wallets/{uid}.balance` is whole SHILLINGS (order-settlement.js floors the seller credit the same
 *  way). The exact entitlement is always recorded beside the credit, so a sub-shilling remainder is
 *  visible, never silently lost. */
function toWalletShillings(minorUnits) {
  const shillings = Math.floor(minorUnits / 100);
  return { shillings, remainderMinor: minorUnits - shillings * 100 };
}

/**
 * The ONE writer of a rider's delivery earning into `wallets/{uid}`. Resolves the entitlement and
 * credits it exactly once (creditKey), inside one transaction. Never throws for a refusal — it
 * returns it, so a caller's status write is never blocked by a rider-pay problem.
 *
 * `opts.claimRef` — a caller's own at-least-once marker (e.g. a driverEarningQueue doc). It is read
 * FIRST in the same transaction; `processed === true` makes the call a no-op, and it is marked
 * processed (with the outcome) atomically with the credit or the refusal.
 * @returns {{credited:boolean, replay?:boolean, alreadyProcessed?:boolean, shillings?:number, entitlement}}
 */
async function creditDeliveryEarning(db, orderId, opts) {
  opts = opts || {};
  const { FieldValue: FV } = require('firebase-admin/firestore');
  return db.runTransaction(async (tx) => {
    if (opts.claimRef) {
      const c = await tx.get(opts.claimRef);
      if (!c.exists || (c.data() || {}).processed === true) {
        return { credited: false, alreadyProcessed: true, entitlement: null };
      }
    }
    const ent = await forOrder(db, orderId, { tx, orderRiderUid: opts.orderRiderUid });
    let replay = false;
    let txnRef = null;
    if (ent.ok) {
      txnRef = db.collection('walletTransactions').doc(creditKey(ent.riderUid, orderId));
      replay = (await tx.get(txnRef)).exists;
    }
    /* ── all reads above, all writes below ── */
    const claim = (outcome) => {
      if (opts.claimRef) {
        tx.update(opts.claimRef, { processed: true, processedAt: FV.serverTimestamp(), outcome });
      }
    };
    if (!ent.ok) { claim('refused:' + ent.reason); return { credited: false, entitlement: ent }; }
    if (replay) { claim('already_paid'); return { credited: false, replay: true, entitlement: ent }; }

    const { shillings, remainderMinor } = toWalletShillings(ent.minorUnits);
    tx.set(db.collection('wallets').doc(ent.riderUid), {
      balance: FV.increment(shillings), updatedAt: FV.serverTimestamp(),
    }, { merge: true });
    tx.set(txnRef, {
      uid: ent.riderUid, userId: ent.riderUid,
      type: 'delivery_earning', amount: shillings, currency: 'KES',
      entitlementMinor: ent.minorUnits, unpaidRemainderMinor: remainderMinor,
      quoteId: ent.quoteId, pricingVersion: ent.pricingVersion, deliveryRef: ent.deliveryId,
      orderId: String(orderId), sourceType: 'delivery', sourceId: String(orderId),
      source: opts.source || 'delivery', status: 'completed',
      createdAt: FV.serverTimestamp(),
    });
    claim('credited');
    return { credited: true, entitlement: ent, shillings };
  });
}

module.exports = {
  REFUSAL, DELIVERIES, QUOTES,
  evaluate, forOrder, creditKey, toWalletShillings, creditDeliveryEarning,
};
