/* ================================================================
   SOKONI POS retail mirror — canonical, cross-device POS sales.

   THE GAP this closes: a live POS checkout writes only the local IndexedDB
   `transactions` twin + queues it to canonical `posTransactions` (client-writable),
   and decrements canonical `products.stock`. It NEVER writes `posRetailSales`, which
   is the collection OrderService's posProvider reads (`posRetailSales where
   merchantId==uid`). So POS sales were invisible to Merchant Analytics on any device
   that didn't ring them up.

   Fix WITHOUT double-deducting stock or double-charging: a Firestore trigger mirrors
   each `posTransactions/{id}` into an idempotent `posRetailSales/{id}` document with
   NO stock write and NO payment execution — the local sale remains the single stock
   authority (products.stock already decremented client-side). Because the queue flushes
   `posTransactions` on reconnect, offline sales mirror automatically when back online.

   Idempotent by construction: deterministic doc id (= txn id) + set({merge:true}); a
   replay is a no-op. Shape matches sokoni-order-service.js `_fromRetailSale`.
   ================================================================ */
'use strict';

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { mapTxnToRetail } = require('./pos-retail-mirror-map');

const db = getFirestore();
const REGION = 'us-central1';

exports.mirrorPosTransactionToRetail = onDocumentCreated(
  { document: 'posTransactions/{txnId}', region: REGION, memory: '128MiB', timeoutSeconds: 30, retry: false },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const t = snap.data() || {};
    const saleId = event.params.txnId;

    const mirror = mapTxnToRetail(t, saleId);
    if (!mirror.merchantId || !saleId) return;   /* need an owner to scope by */

    const ref = db.collection('posRetailSales').doc(String(saleId));
    /* Idempotent: if a mirror already exists, do nothing (never re-stamp createdAt). */
    const existing = await ref.get().catch(() => null);
    if (existing && existing.exists) return;

    mirror.createdAt = FieldValue.serverTimestamp();   /* the only non-pure field */
    await ref.set(mirror, { merge: true });
  }
);
