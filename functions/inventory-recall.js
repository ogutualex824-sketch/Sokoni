/* ═══════════════════════════════════════════════════════════════════
   SOKONI INVENTORY V2 — Recall Management System
   Handles product batch recalls: locates stock, halts sales,
   notifies affected parties, generates regulatory reports.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall }            = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const CF_OPTS = { region: 'us-central1', memory: '512MiB', timeoutSeconds: 180 };

/* ── Initiate a Recall ───────────────────────────────────────────── */
exports.inventoryInitiateRecall = onCall(CF_OPTS, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { tenantId, batchId, productId, reason, affectedSkus = [], replaceWith, regulatoryRef } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;

  const batch = db.batch();

  /* 1. Create recall record */
  const recallRef = db.collection(`tenants/${resolvedTenant}/inventory_recalls`).doc();
  const recallData = {
    id           : recallRef.id,
    batchId      : batchId || null,
    productId    : productId || null,
    affectedSkus : affectedSkus,
    reason,
    regulatoryRef: regulatoryRef || null,
    replaceWith  : replaceWith || null,
    status       : 'active',
    initiatedBy  : req.auth.uid,
    affectedQty  : 0,
    locatedQty   : 0,
    retrievedQty : 0,
    createdAt    : admin.firestore.FieldValue.serverTimestamp(),
  };
  batch.set(recallRef, recallData);

  /* 2. Locate affected inventory */
  let totalAffected = 0;
  const targetIds = productId ? [productId] : affectedSkus;

  for (const pid of targetIds) {
    const levelsSnap = await db.collection(`tenants/${resolvedTenant}/inventory_levels`)
      .where('productId', '==', pid).get();

    for (const lvlDoc of levelsSnap.docs) {
      const lvl = lvlDoc.data();
      const affected = lvl.available || 0;
      if (affected <= 0) continue;
      totalAffected += affected;

      /* Lock stock: move available → recalled */
      batch.update(lvlDoc.ref, {
        available    : 0,
        recalled     : admin.firestore.FieldValue.increment(affected),
        recallId     : recallRef.id,
        recallLockedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      /* Record movement */
      const mvRef = db.collection(`tenants/${resolvedTenant}/inventory_movements`).doc();
      batch.set(mvRef, {
        productId  : pid,
        warehouseId: lvl.warehouseId,
        type       : 'recall_lock',
        qty        : -affected,
        reason     : `Recall: ${reason}`,
        recallId   : recallRef.id,
        userId     : req.auth.uid,
        ts         : admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  /* Update locatedQty */
  batch.update(recallRef, { locatedQty: totalAffected, affectedQty: totalAffected });

  /* 3. Create critical alert */
  const alertRef = db.collection(`tenants/${resolvedTenant}/inventory_alerts`).doc();
  batch.set(alertRef, {
    type     : 'recall_initiated',
    severity : 'CRITICAL',
    title    : `RECALL INITIATED: ${reason}`,
    body     : `${totalAffected} units locked across ${targetIds.length} product(s). Recall ID: ${recallRef.id}`,
    recallId : recallRef.id,
    resolved : false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();

  return {
    recallId    : recallRef.id,
    status      : 'active',
    locatedQty  : totalAffected,
    affectedSkus: targetIds,
    message     : `Recall initiated. ${totalAffected} units locked and awaiting retrieval.`,
  };
});

/* ── Get Recalls ─────────────────────────────────────────────────── */
exports.inventoryGetRecalls = onCall(CF_OPTS, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { tenantId, status, limit = 20 } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;

  let q = db.collection(`tenants/${resolvedTenant}/inventory_recalls`)
    .orderBy('createdAt', 'desc').limit(limit);
  if (status) q = q.where('status', '==', status);

  const snap = await q.get();
  return { recalls: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/* ── Update Recall Status ────────────────────────────────────────── */
exports.inventoryUpdateRecallStatus = onCall(CF_OPTS, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { recallId, status, retrievedQty, notes } = req.data;

  const snap = await db.collectionGroup('inventory_recalls')
    .where(admin.firestore.FieldPath.documentId(), '==', recallId).limit(1).get();
  if (snap.empty) throw new Error('Recall not found');
  const recallRef = snap.docs[0].ref;
  const recall    = snap.docs[0].data();
  const tenantId  = recallRef.path.split('/')[1];

  const update = { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (retrievedQty !== undefined) update.retrievedQty = retrievedQty;
  if (notes)                      update.notes = notes;
  if (status === 'resolved')      update.resolvedAt = admin.firestore.FieldValue.serverTimestamp();

  /* If resolved, release any remaining locked stock (for destruction/replacement) */
  if (status === 'resolved') {
    const lockedLevels = await db.collectionGroup('inventory_levels')
      .where('recallId', '==', recallId).limit(100).get();
    const batch = db.batch();
    lockedLevels.docs.forEach(d => {
      batch.update(d.ref, { recalled: 0, recallId: admin.firestore.FieldValue.delete() });
    });
    batch.update(recallRef, update);
    await batch.commit();
  } else {
    await recallRef.update(update);
  }

  return { recallId, status };
});

/* ── Generate Recall Report ──────────────────────────────────────── */
exports.inventoryRecallReport = onCall(CF_OPTS, async req => {
  if (!req.auth) throw new Error('Unauthenticated');
  const { recallId, tenantId } = req.data;
  const resolvedTenant = tenantId || req.auth.uid;

  const [recallDoc, movementsSnap, alertsSnap] = await Promise.all([
    db.collection(`tenants/${resolvedTenant}/inventory_recalls`).doc(recallId).get(),
    db.collection(`tenants/${resolvedTenant}/inventory_movements`)
      .where('recallId', '==', recallId).get(),
    db.collection(`tenants/${resolvedTenant}/inventory_alerts`)
      .where('recallId', '==', recallId).get(),
  ]);

  if (!recallDoc.exists) throw new Error('Recall not found');
  const recall    = recallDoc.data();
  const movements = movementsSnap.docs.map(d => d.data());

  return {
    report: {
      recallId,
      status       : recall.status,
      reason       : recall.reason,
      regulatoryRef: recall.regulatoryRef,
      initiatedAt  : recall.createdAt,
      resolvedAt   : recall.resolvedAt,
      affectedQty  : recall.affectedQty,
      locatedQty   : recall.locatedQty,
      retrievedQty : recall.retrievedQty,
      recovery     : recall.affectedQty ? Math.round((recall.retrievedQty || 0) / recall.affectedQty * 100) : 0,
      movements    : movements.length,
      timeline     : movements.map(m => ({ type: m.type, qty: m.qty, warehouse: m.warehouseId, ts: m.ts })),
      alerts       : alertsSnap.size,
    },
    generatedAt: new Date().toISOString(),
  };
});

/* ── Auto-notify on recall created ──────────────────────────────── */
exports.inventoryRecallOnCreated = onDocumentCreated(
  { document: 'tenants/{tenantId}/inventory_recalls/{recallId}', ...CF_OPTS },
  async event => {
    const recall = event.data?.data();
    if (!recall) return;
    const { tenantId } = event.params;
    console.log(`[Recall] New recall ${event.params.recallId} for tenant ${tenantId}. Reason: ${recall.reason}`);
    /* Webhook dispatch would go here — handled by inventory-webhooks.js */
  }
);
