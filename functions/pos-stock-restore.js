/* ============================================================================
   POS STOCK RESTORE — the ONE server path that returns sold units to canonical stock (owner 2026-10-03, via sokoni-5b)
   ----------------------------------------------------------------------------
   Owner decision (b): "the server restores the exact quantities ONLY ON APPROVAL, exactly once (idempotent), recorded
   in the stock ledger, never on the request. A void must not recreate a consumed entitlement."

   Used by posProcessRefund (manager/owner authority = the approval act) and posVoidSale (a consumed 'void' approval
   bound to the sale). Both call it INSIDE their own transaction, after every read and before/with every write, so the
   restore commits atomically with the refund/void record — or not at all.

   PER LINE:
     • metered product (trackInventory !== false AND numeric stock): stock = before + qty, inventoryVersion +1,
       updatedAt, sold/totalUnitsSold/totalRevenue reversed — ONE update, the same contract every stock writer honours;
       plus a ledger row stockMovements/{opId}_{productId} via create() — {kind, before, after, delta, actorUid,
       reason, saleId, shopId} — so a replay of the same operation can never write a second row or a second restore.
     • unmetered product (absent/non-numeric stock, or trackInventory false): NOTHING is written to the product —
       an absent stock means UNMETERED (product persistence invariant), and incrementing it would invent a count.
       It is reported back as { restored:false, reason:'unmetered' }.
   It touches products and stockMovements only — never gift cards, loyalty, wallets, tickets or any other entitlement,
   so neither a refund's stock leg nor a void can recreate something the buyer already consumed.
   ============================================================================ */
'use strict';

const KINDS = Object.freeze({ refund: 'refund_restock', void: 'void_restock' });

/**
 * Validate requested lines against the ORIGINAL sale. Quantities come from the caller only as a request; the unit
 * price always comes from the sale. Throws a plain Error with a user-safe message on any mismatch.
 * @returns {Array<{productId:string, qty:number, unitPrice:number}>}
 */
function planLines(sale, requested) {
  const saleItems = Array.isArray(sale && sale.items) ? sale.items : [];
  const out = [];
  const seen = new Set();
  for (const r of requested || []) {
    const pid = String((r && r.productId) || '');
    if (!pid) throw new Error('Every line must name a product.');
    if (seen.has(pid)) throw new Error('Each product may appear once.');
    seen.add(pid);
    const orig = saleItems.find((i) => i && String(i.productId) === pid);
    if (!orig) throw new Error('Item ' + pid + ' not in original sale');
    const qty = Number(r.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Refund qty must be a positive whole number');
    if (qty > Number(orig.qty || 0)) throw new Error('Cannot refund more than sold');
    out.push({ productId: pid, qty, unitPrice: Number(orig.unitPrice || 0) });
  }
  if (!out.length) throw new Error('items required');
  return out;
}

/** Every line of the sale, in full (a void returns everything). */
function allLines(sale) {
  return (Array.isArray(sale && sale.items) ? sale.items : []).map((i) => ({
    productId: i && i.productId ? String(i.productId) : '', qty: Number((i && i.qty) || 1), unitPrice: Number((i && i.unitPrice) || 0),
  }));
}

/**
 * Write the restore inside the caller's transaction. Caller has ALREADY read prodSnaps (all reads first).
 * @param txn        Firestore transaction
 * @param ctx        { db, FieldValue, opId, kind:'refund'|'void', actorUid, reason, saleId, shopId }
 * @param lines      planned lines
 * @param prodRefs   product refs, index-aligned with lines
 * @param prodSnaps  product snapshots, index-aligned with lines
 */
function writeRestore(txn, ctx, lines, prodRefs, prodSnaps) {
  const { db, FieldValue, opId, kind, actorUid, reason, saleId, shopId } = ctx;
  if (!KINDS[kind]) throw new Error('unknown restore kind');
  const results = [];
  lines.forEach((l, i) => {
    const snap = prodSnaps[i];
    const p = (snap && snap.exists && snap.data()) || {};
    if (!snap || !snap.exists) { results.push({ productId: l.productId, qty: l.qty, restored: false, reason: 'missing' }); return; }
    if (p.trackInventory === false || typeof p.stock !== 'number' || !Number.isFinite(p.stock)) {
      results.push({ productId: l.productId, qty: l.qty, restored: false, reason: 'unmetered' });
      return;
    }
    const before = p.stock;
    const after = before + l.qty;
    const version = (Number(p.inventoryVersion) || 0) + 1;
    txn.update(prodRefs[i], {
      stock:            after,
      inventoryVersion: FieldValue.increment(1),
      updatedAt:        FieldValue.serverTimestamp(),
      sold:             FieldValue.increment(-l.qty),
      totalUnitsSold:   FieldValue.increment(-l.qty),
      totalRevenue:     FieldValue.increment(-(l.unitPrice * l.qty)),
      /* attribution read by the products trigger that mirrors every change into inventoryMovements */
      lastSaleOrderId:  String(saleId),
      lastStockSource:  KINDS[kind],
    });
    txn.create(db.collection('stockMovements').doc(String(opId) + '_' + l.productId), {
      id: String(opId) + '_' + l.productId,
      kind: KINDS[kind],
      productId: l.productId,
      productName: p.name || p.title || null,
      shopId: shopId || p.shopId || null,
      saleId: String(saleId),
      operationId: String(opId),
      delta: l.qty,
      before,
      after,
      inventoryVersion: version,
      actorUid: actorUid || null,
      reason: reason ? String(reason).slice(0, 500) : null,
      createdAt: FieldValue.serverTimestamp(),
    });
    results.push({ productId: l.productId, qty: l.qty, restored: true, before, after });
  });
  return results;
}

module.exports = { KINDS, planLines, allLines, writeRestore };
