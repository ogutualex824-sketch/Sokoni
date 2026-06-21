/* ================================================================
   SOKONI WORKFLOW AUTOMATION PLATFORM
   Cloud Functions  v1.0.0

   Four Cloud Functions that power durable WAP execution:

   wapTriggerWorkflow  — Create and start a new workflow instance
   wapAdvanceWorkflow  — Advance instance on state change (Firestore trigger)
   wapApproveStep      — Approve or reject an approval step
   wapScheduledResume  — Resume delay-type steps on schedule

   Architecture:
   Client → wapTriggerWorkflow → Firestore create → wapAdvanceWorkflow
                                                         ↓
                                               Execute steps sequentially
                                                         ↓
                                               Write state → loops until done

================================================================ */

"use strict";

const { onCall, HttpsError }          = require("firebase-functions/v2/https");
const { onDocumentUpdated }           = require("firebase-functions/v2/firestore");
const { onSchedule }                  = require("firebase-functions/v2/scheduler");
const admin                           = require("firebase-admin");

const db = admin.firestore();

const COLL = {
  DEFS:      "workflowDefinitions",
  INSTANCES: "workflowInstances",
  APPROVALS: "workflowApprovals",
  SCHEDULE:  "workflowSchedule",
};

/* ── WORKFLOW_STATUS mirrors browser constants ─────────────────── */
const WS = {
  PENDING:       "pending",
  RUNNING:       "running",
  WAITING:       "waiting",
  PAUSED:        "paused",
  COMPLETED:     "completed",
  FAILED:        "failed",
  CANCELLED:     "cancelled",
  COMPENSATING:  "compensating",
  COMPENSATED:   "compensated",
};

/* ================================================================
   wapTriggerWorkflow
   Called by client code to create and start a new workflow.
================================================================ */
exports.wapTriggerWorkflow = onCall({ maxInstances: 100 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  const { definitionId, variables = {}, module: mod } = req.data;
  if (!definitionId) throw new HttpsError("invalid-argument", "definitionId is required");

  /* Load definition from Firestore */
  const defSnap = await db.collection(COLL.DEFS).doc(definitionId).get();
  if (!defSnap.exists) throw new HttpsError("not-found", `Workflow definition '${definitionId}' not found`);
  const def = defSnap.data();

  if (!def.enabled && def.enabled !== undefined) {
    throw new HttpsError("failed-precondition", `Workflow '${definitionId}' is disabled`);
  }

  const instanceId = _genId();
  const instance = {
    id:                instanceId,
    definitionId,
    definitionVersion: def.version ?? "1.0",
    status:            WS.RUNNING,
    steps:             {},
    completedSteps:    [],
    failedSteps:       [],
    skippedSteps:      [],
    variables:         { ...variables },
    history:           [],
    metadata: {
      uid,
      module:        mod ?? def.module ?? "unknown",
      startedAt:     Date.now(),
      completedAt:   null,
      duration:      null,
      lastUpdatedAt: Date.now(),
      lastEvent:     "created",
      totalSteps:    (def.steps ?? []).length,
    },
    error: null,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection(COLL.INSTANCES).doc(instanceId).set(instance);

  console.info(`[WAP] Started workflow '${definitionId}' → ${instanceId}`);
  return { instanceId, status: WS.RUNNING };
});

/* ================================================================
   wapAdvanceWorkflow
   Triggered when a workflow instance document is UPDATED.
   Picks up the next ready step(s) and executes them.
   Loops until workflow reaches a terminal or waiting state.
================================================================ */
exports.wapAdvanceWorkflow = onDocumentUpdated(
  { document: `${COLL.INSTANCES}/{instanceId}`, maxInstances: 50 },
  async (event) => {
    const { instanceId } = event.params;
    const after  = event.data.after.data();
    const before = event.data.before.data();

    /* Only advance on meaningful transitions */
    if (after.status === before.status && after.metadata?.lastEvent === before.metadata?.lastEvent) return;
    if ([WS.COMPLETED, WS.FAILED, WS.CANCELLED, WS.PAUSED,
         WS.WAITING, WS.COMPENSATED].includes(after.status)) return;

    const defSnap = await db.collection(COLL.DEFS).doc(after.definitionId).get();
    if (!defSnap.exists) {
      console.error(`[WAP] Definition '${after.definitionId}' not found for instance ${instanceId}`);
      return;
    }
    const def = defSnap.data();

    /* Use Firestore transaction to safely advance state */
    await db.runTransaction(async (txn) => {
      const ref  = db.collection(COLL.INSTANCES).doc(instanceId);
      const snap = await txn.get(ref);
      if (!snap.exists) return;
      const inst = { id: snap.id, ...snap.data() };

      if ([WS.COMPLETED, WS.FAILED, WS.CANCELLED, WS.PAUSED, WS.WAITING].includes(inst.status)) return;

      const readySteps = _findReadySteps(def.steps ?? [], inst);
      if (!readySteps.length) {
        /* No more ready steps — check if workflow is done */
        const allSteps = (def.steps ?? []).map(s => s.id);
        const done = allSteps.every(id =>
          inst.completedSteps.includes(id) ||
          inst.skippedSteps.includes(id)   ||
          inst.failedSteps.includes(id)
        );
        if (done) {
          const hasFailed     = inst.failedSteps.length > 0;
          inst.status         = hasFailed ? WS.FAILED : WS.COMPLETED;
          inst.metadata.completedAt = Date.now();
          inst.metadata.duration    = inst.metadata.completedAt - inst.metadata.startedAt;
          inst.metadata.lastEvent   = hasFailed ? "completed_with_failures" : "completed";
          txn.set(ref, { ...inst, serverTs: admin.firestore.FieldValue.serverTimestamp() });
          console.info(`[WAP] ${instanceId} → ${inst.status} in ${inst.metadata.duration}ms`);
        }
        return;
      }

      /* Mark first ready step as running (loop fires again per step) */
      const stepDef = readySteps[0];
      inst.steps[stepDef.id] = { status: "running", startedAt: Date.now(), retryCount: 0 };
      inst.metadata.lastEvent = "step_running:" + stepDef.id;
      inst.metadata.lastUpdatedAt = Date.now();
      txn.set(ref, { ...inst, serverTs: admin.firestore.FieldValue.serverTimestamp() });
    });

    /* Fetch fresh instance and execute the running step */
    const freshSnap = await db.collection(COLL.INSTANCES).doc(instanceId).get();
    if (!freshSnap.exists) return;
    const inst = { id: freshSnap.id, ...freshSnap.data() };

    /* Find the step we just marked running */
    const runningStepId = Object.entries(inst.steps)
      .find(([, s]) => s.status === "running")?.[0];
    if (!runningStepId) return;

    const stepDef = (defSnap.data().steps ?? []).find(s => s.id === runningStepId);
    if (!stepDef) return;

    try {
      const output = await _executeServerStep(stepDef, inst);

      /* Step completed */
      const update = {
        [`steps.${runningStepId}.status`]:      "completed",
        [`steps.${runningStepId}.completedAt`]: Date.now(),
        [`steps.${runningStepId}.output`]:      output ?? null,
        [`steps.${runningStepId}.duration`]:    Date.now() - inst.steps[runningStepId].startedAt,
        completedSteps:                          admin.firestore.FieldValue.arrayUnion(runningStepId),
        history:                                 admin.firestore.FieldValue.arrayUnion({
          stepId: runningStepId, status: "completed", ts: Date.now(), output: output ?? null,
        }),
        "metadata.lastEvent":                   "step_completed:" + runningStepId,
        "metadata.lastUpdatedAt":               Date.now(),
        serverTs:                               admin.firestore.FieldValue.serverTimestamp(),
      };

      /* Output variables keyed by step ID */
      if (output && typeof output === "object") {
        Object.entries(output).forEach(([k, v]) => {
          update[`variables.${runningStepId}.${k}`] = v;
        });
      }

      await db.collection(COLL.INSTANCES).doc(instanceId).update(update);

    } catch (err) {
      console.error(`[WAP] Step '${runningStepId}' failed in ${instanceId}:`, err.message);

      const retryCount  = (inst.steps[runningStepId]?.retryCount ?? 0) + 1;
      const maxRetries  = stepDef.retries ?? 0;

      if (retryCount <= maxRetries) {
        /* Schedule retry */
        const backoffMs = Math.min((stepDef.retryDelay ?? 2_000) * 2 ** (retryCount - 1), 30_000);
        await db.collection(COLL.INSTANCES).doc(instanceId).update({
          [`steps.${runningStepId}.status`]:      "pending",   /* reset to pending for retry */
          [`steps.${runningStepId}.retryCount`]:  retryCount,
          [`steps.${runningStepId}.lastError`]:   err.message,
          "metadata.lastEvent":                   `step_retry:${runningStepId}:${retryCount}`,
          "metadata.lastUpdatedAt":               Date.now(),
          serverTs: admin.firestore.FieldValue.serverTimestamp(),
        });
        /* Trigger re-advance after backoff via scheduled task (simplified: immediate re-trigger) */
        setTimeout(async () => {
          await db.collection(COLL.INSTANCES).doc(instanceId).update({
            "metadata.lastEvent":     `step_retry_trigger:${runningStepId}`,
            "metadata.lastUpdatedAt": Date.now(),
            serverTs: admin.firestore.FieldValue.serverTimestamp(),
          });
        }, backoffMs);
        return;
      }

      /* Permanent failure */
      const onFailure = stepDef.onFailure ?? "fail";
      const baseUpdate = {
        [`steps.${runningStepId}.status`]:     "failed",
        [`steps.${runningStepId}.failedAt`]:   Date.now(),
        [`steps.${runningStepId}.error`]:      err.message,
        failedSteps:                            admin.firestore.FieldValue.arrayUnion(runningStepId),
        history:                               admin.firestore.FieldValue.arrayUnion({
          stepId: runningStepId, status: "failed", ts: Date.now(), error: err.message,
        }),
        "metadata.lastEvent":                  "step_failed:" + runningStepId,
        "metadata.lastUpdatedAt":              Date.now(),
        serverTs: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (onFailure === "fail") {
        baseUpdate.status = WS.FAILED;
        baseUpdate.error  = `Step '${stepDef.name}' failed: ${err.message}`;
        baseUpdate["metadata.completedAt"] = Date.now();
      } else if (onFailure === "continue") {
        /* Treat as completed so next steps can run */
        baseUpdate.completedSteps = admin.firestore.FieldValue.arrayUnion(runningStepId);
        delete baseUpdate.failedSteps;
      } else if (onFailure === "compensate") {
        baseUpdate.status = WS.COMPENSATING;
      }

      await db.collection(COLL.INSTANCES).doc(instanceId).update(baseUpdate);

      if (onFailure === "compensate") {
        await _compensate(instanceId, inst, defSnap.data());
      }
    }
  }
);

/* ================================================================
   wapApproveStep
   Callable: approve or reject an approval step in a workflow.
================================================================ */
exports.wapApproveStep = onCall({ maxInstances: 50 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  const { approvalId, decision, reason = "" } = req.data;
  if (!approvalId) throw new HttpsError("invalid-argument", "approvalId is required");
  if (!["approved", "rejected"].includes(decision)) {
    throw new HttpsError("invalid-argument", "decision must be 'approved' or 'rejected'");
  }

  const approvalRef  = db.collection(COLL.APPROVALS).doc(approvalId);
  const approvalSnap = await approvalRef.get();
  if (!approvalSnap.exists) throw new HttpsError("not-found", `Approval '${approvalId}' not found`);

  const approval = approvalSnap.data();
  if (approval.status !== "pending") {
    throw new HttpsError("failed-precondition", `Approval is already '${approval.status}'`);
  }

  /* Deadline check */
  if (approval.deadline && Date.now() > approval.deadline) {
    throw new HttpsError("deadline-exceeded", "Approval deadline has passed");
  }

  /* Write approval decision */
  await approvalRef.update({
    status:      decision,
    decidedBy:   uid,
    decidedAt:   Date.now(),
    reason,
    serverTs:    admin.firestore.FieldValue.serverTimestamp(),
  });

  /* Update workflow instance */
  const instanceRef = db.collection(COLL.INSTANCES).doc(approval.instanceId);
  const stepId      = approval.stepId;
  const stepStatus  = decision === "approved" ? "completed" : "failed";

  const update = {
    [`steps.${stepId}.status`]:           stepStatus,
    [`steps.${stepId}.completedAt`]:      Date.now(),
    [`steps.${stepId}.approvalDecision`]: decision,
    [`steps.${stepId}.decidedBy`]:        uid,
    status:                              WS.RUNNING,
    history:                             admin.firestore.FieldValue.arrayUnion({
      stepId, status: stepStatus, ts: Date.now(), actor: uid,
      approvalDecision: decision, reason,
    }),
    "metadata.lastEvent":    `approval_${decision}:${stepId}`,
    "metadata.lastUpdatedAt": Date.now(),
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (decision === "approved") {
    update.completedSteps = admin.firestore.FieldValue.arrayUnion(stepId);
  } else {
    update.failedSteps = admin.firestore.FieldValue.arrayUnion(stepId);
    update.status      = WS.FAILED;
    update.error       = `Rejected at '${stepId}': ${reason}`;
  }

  await instanceRef.update(update);

  console.info(`[WAP] Approval ${approvalId} → ${decision} by ${uid}`);
  return { success: true, decision, instanceId: approval.instanceId };
});

/* ================================================================
   wapScheduledResume
   Every 5 minutes: find delay-type steps whose timer has expired
   and advance those workflows.
================================================================ */
exports.wapScheduledResume = onSchedule("every 5 minutes", async () => {
  const now   = Date.now();
  const snap  = await db.collection(COLL.SCHEDULE)
    .where("status", "==", "pending")
    .where("executeAt", "<=", now)
    .limit(50)
    .get();

  if (snap.empty) return;

  const batch = db.batch();
  const toAdvance = [];

  snap.docs.forEach(d => {
    const sched = d.data();
    batch.update(d.ref, { status: "processing" });
    toAdvance.push(sched);
  });

  await batch.commit();

  for (const sched of toAdvance) {
    try {
      const instRef  = db.collection(COLL.INSTANCES).doc(sched.instanceId);
      const instSnap = await instRef.get();
      if (!instSnap.exists) continue;

      await instRef.update({
        [`steps.${sched.stepId}.status`]:      "completed",
        [`steps.${sched.stepId}.completedAt`]: now,
        completedSteps: admin.firestore.FieldValue.arrayUnion(sched.stepId),
        status: WS.RUNNING,
        history: admin.firestore.FieldValue.arrayUnion({ stepId: sched.stepId, status: "completed", ts: now, reason: "delay expired" }),
        "metadata.lastEvent":     `delay_expired:${sched.stepId}`,
        "metadata.lastUpdatedAt": now,
        serverTs: admin.firestore.FieldValue.serverTimestamp(),
      });

      /* Mark schedule doc done */
      await db.collection(COLL.SCHEDULE).doc(`${sched.instanceId}_${sched.stepId}`).update({ status: "done" });
      console.info(`[WAP] Resumed delayed step '${sched.stepId}' in ${sched.instanceId}`);

    } catch (e) {
      console.error(`[WAP] Failed to resume ${sched.instanceId}/${sched.stepId}:`, e.message);
      await db.collection(COLL.SCHEDULE).doc(`${sched.instanceId}_${sched.stepId}`).update({ status: "pending" });
    }
  }
});

/* ================================================================
   wapGetInstance
   Callable: read a workflow instance with definition metadata.
================================================================ */
exports.wapGetInstance = onCall({ maxInstances: 50 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  const { instanceId } = req.data;
  if (!instanceId) throw new HttpsError("invalid-argument", "instanceId required");

  const snap = await db.collection(COLL.INSTANCES).doc(instanceId).get();
  if (!snap.exists) throw new HttpsError("not-found", `Instance '${instanceId}' not found`);

  const inst    = { id: snap.id, ...snap.data() };
  const defSnap = await db.collection(COLL.DEFS).doc(inst.definitionId).get();

  return {
    instance:   inst,
    definition: defSnap.exists ? defSnap.data() : null,
  };
});

/* ================================================================
   wapGetPendingApprovals
   Callable: list approval steps waiting for a specific user.
================================================================ */
exports.wapGetPendingApprovals = onCall({ maxInstances: 20 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  const snap = await db.collection(COLL.APPROVALS)
    .where("status",    "==", "pending")
    .where("assignees", "array-contains-any", [uid, `role:admin`])
    .orderBy("requestedAt", "desc")
    .limit(50)
    .get();

  return { approvals: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/* ================================================================
   wapSaveDefinition
   Callable (admin): save or update a workflow definition.
================================================================ */
exports.wapSaveDefinition = onCall({ maxInstances: 10 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  /* Admin check */
  const userRecord = await admin.auth().getUser(uid).catch(() => null);
  const isAdmin    = userRecord?.customClaims?.role === "admin" || userRecord?.customClaims?.superAdmin;
  if (!isAdmin) throw new HttpsError("permission-denied", "Admin role required to save workflow definitions");

  const { definition } = req.data;
  if (!definition?.id || !definition?.name || !Array.isArray(definition?.steps)) {
    throw new HttpsError("invalid-argument", "definition.id, .name and .steps are required");
  }

  await db.collection(COLL.DEFS).doc(definition.id).set({
    ...definition,
    updatedAt:  Date.now(),
    updatedBy:  uid,
    serverTs:   admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { saved: true, definitionId: definition.id };
});

/* ================================================================
   Private helpers
================================================================ */

function _findReadySteps(steps, instance) {
  return steps.filter(s => {
    if (instance.completedSteps.includes(s.id)) return false;
    if (instance.skippedSteps.includes(s.id))   return false;
    if (instance.failedSteps.includes(s.id))    return false;
    const st = instance.steps?.[s.id];
    if (st?.status === "running") return false;
    if (st?.status === "waiting") return false;
    const deps = s.after ?? [];
    return deps.every(d => instance.completedSteps.includes(d) || instance.skippedSteps.includes(d));
  });
}

/**
 * Execute a step server-side.
 * Server-side handlers cover: commission calc, inventory ops, notifications queue,
 * analytics writes. Payment auth/capture should be done from trusted CF context only.
 */
async function _executeServerStep(stepDef, instance) {
  const type    = stepDef.type ?? "task";
  const handler = stepDef.handler ?? "";
  const input   = _interpolate(stepDef.input ?? {}, instance.variables);

  switch (type) {
    case "notification":
      return _svcNotification(input, instance);

    case "approval":
      await _createApproval(stepDef, input, instance);
      return null;  /* step completion handled by wapApproveStep CF */

    case "delay":
      await _scheduleDelay(stepDef, input, instance);
      return null;

    case "webhook":
      return _callWebhook(stepDef, input);

    case "task":
    default:
      return _dispatchHandler(handler, input, instance);
  }
}

async function _dispatchHandler(handler, input, instance) {
  const ctx = { instanceId: instance.id, definitionId: instance.definitionId, variables: instance.variables };

  switch (handler) {
    case "inventory.reserve":   return _svcInventoryReserve(input, instance);
    case "inventory.release":   return _svcInventoryRelease(input, instance);
    case "payment.authorize":   return _svcPaymentAuthorize(input, instance);
    case "payment.capture":     return _svcPaymentCapture(input, instance);
    case "payment.void":        return _svcPaymentVoid(input, instance);
    case "payment.refund":      return _svcPaymentRefund(input, instance);
    case "commission.calculate": return _svcCommission(input, instance);
    case "seller.schedulePayout": return _svcSchedulePayout(input, instance);
    case "driver.assign":       return _svcDriverAssign(input, instance);
    case "driver.release":      return _svcDriverRelease(input, instance);
    case "order.updateStatus":  return _svcOrderStatus(input, instance);
    case "invoice.generate":    return _svcInvoice(input, instance);
    case "loyalty.award":       return _svcLoyalty(input, instance);
    case "analytics.record":    return _svcAnalytics(input, instance);
    case "ticket.generate":     return _svcTicketGenerate(input, instance);
    case "rental.reserve":      return _svcRentalReserve(input, instance);
    case "rental.release":      return _svcRentalRelease(input, instance);
    case "seller.activate":     return _svcSellerActivate(input, instance);
    default:
      console.warn(`[WAP] Unknown handler '${handler}' — skipping`);
      return { skipped: true, handler };
  }
}

/* ── Service implementations (server-side, trusted) ──────────── */

async function _svcInventoryReserve({ orderId, items }, inst) {
  const results = [];
  await db.runTransaction(async (txn) => {
    for (const item of (items ?? [])) {
      const ref  = db.collection("products").doc(item.productId);
      const snap = await txn.get(ref);
      if (!snap.exists) throw new Error(`Product ${item.productId} not found`);
      const stock = snap.data().stock ?? 0;
      if (stock < item.qty) throw new Error(`Insufficient stock for ${item.productId}`);
      txn.update(ref, { stock: admin.firestore.FieldValue.increment(-item.qty), [`reservations.${orderId}`]: item.qty });
      results.push({ productId: item.productId, reserved: item.qty });
    }
  });
  return { reserved: true, items: results, orderId };
}

async function _svcInventoryRelease({ orderId, items }, inst) {
  const batch = db.batch();
  for (const item of (items ?? [])) {
    batch.update(db.collection("products").doc(item.productId), {
      [`reservations.${orderId}`]: admin.firestore.FieldValue.delete(),
    });
  }
  await batch.commit();
  return { released: true };
}

async function _svcPaymentAuthorize({ orderId, amount, paymentMethod, phone, uid }, inst) {
  if (!amount || Number(amount) <= 0) throw new Error("Invalid payment amount");
  const authRef = "AUTH-" + Date.now().toString(36).toUpperCase();
  await db.collection("paymentAuthorizations").doc(authRef).set({
    orderId, amount: Number(amount), paymentMethod, phone, uid,
    status: "authorized", createdAt: Date.now(), wf: inst.id,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { authorized: true, authRef };
}

async function _svcPaymentCapture({ authRef, amount, orderId }, inst) {
  if (!authRef) throw new Error("authRef is required");
  await db.collection("paymentAuthorizations").doc(authRef).update({
    status: "captured", capturedAt: Date.now(), serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { captured: true, capturedAt: Date.now() };
}

async function _svcPaymentVoid({ authRef }, inst) {
  if (!authRef) return { voided: true, skipped: true };
  await db.collection("paymentAuthorizations").doc(authRef).update({
    status: "voided", voidedAt: Date.now(), serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { voided: true };
}

async function _svcPaymentRefund({ orderId, amount, reason, uid }, inst) {
  const ref = await db.collection("refunds").add({
    orderId, amount: Number(amount), reason, uid,
    status: "processing", createdAt: Date.now(),
    serverTs: admin.firestore.FieldValue.serverTimestamp(), wf: inst.id,
  });
  return { refunded: true, refundId: ref.id };
}

async function _svcCommission({ orderId, total, category, sellerUid }, inst) {
  const rates      = { food: 0.15, delivery: 0.12, marketplace: 0.08, services: 0.10, default: 0.08 };
  const pct        = rates[category] ?? rates.default;
  const commission = Math.round(Number(total) * pct * 100) / 100;
  const sellerNet  = Math.round((Number(total) - commission) * 100) / 100;
  await db.collection("commissions").add({
    orderId, sellerUid, total: Number(total), pct, commission, sellerNet,
    status: "pending", createdAt: Date.now(),
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { commission, sellerNet, pct };
}

async function _svcSchedulePayout({ sellerUid, orderId, amount }, inst) {
  const scheduleAt = Date.now() + 86_400_000;
  const ref = await db.collection("payoutQueue").add({
    sellerUid, orderId, amount: Number(amount), scheduleAt,
    status: "scheduled", createdAt: Date.now(), wf: inst.id,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { scheduled: true, payoutId: ref.id, scheduleAt };
}

async function _svcDriverAssign({ pickup, deliveryType, orderId }, inst) {
  const snap = await db.collection("driverLocations")
    .where("online", "==", true).where("available", "==", true).limit(20).get();
  if (snap.empty) throw new Error("No available drivers");
  const drivers = snap.docs.map(d => ({ ...d.data(), uid: d.id }))
    .filter(d => d.lat && d.lng)
    .map(d => ({ ...d, dist: _haversineKm(pickup.lat, pickup.lng, d.lat, d.lng) }))
    .sort((a, b) => a.dist - b.dist);
  if (!drivers.length) throw new Error("No drivers with GPS position");
  const nearest = drivers[0];
  await db.collection("driverLocations").doc(nearest.uid).update({
    available: false, assignedOrderId: orderId, assignedAt: Date.now(),
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { assigned: true, driverUid: nearest.uid, estimatedDistKm: Math.round(nearest.dist * 10) / 10 };
}

async function _svcDriverRelease({ driverUid }, inst) {
  if (!driverUid) return { released: true };
  await db.collection("driverLocations").doc(driverUid).update({
    available: true, assignedOrderId: null,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { released: true };
}

async function _svcOrderStatus({ orderId, status, metadata }, inst) {
  await db.collection("orders").doc(orderId).set(
    { status, [`${status}At`]: Date.now(), ...(metadata ?? {}), serverTs: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  return { updated: true, status };
}

async function _svcInvoice({ orderId, uid, sellerUid, items, total, commission }, inst) {
  const ref = await db.collection("invoices").add({
    orderId, uid, sellerUid, items: items ?? [], total, commission,
    status: "issued", issuedAt: Date.now(),
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { generated: true, invoiceId: ref.id };
}

async function _svcLoyalty({ uid, orderId, amount }, inst) {
  if (!uid) return { awarded: 0 };
  const points = Math.floor(Number(amount) * 0.01);
  if (points <= 0) return { awarded: 0 };
  await db.collection("loyaltyAccounts").doc(uid).set({
    points: admin.firestore.FieldValue.increment(points),
    lastAwardedAt: Date.now(), serverTs: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { awarded: points };
}

async function _svcAnalytics({ event, module: mod, data }, inst) {
  await db.collection("analyticsEvents").add({
    event, module: mod, data: data ?? {}, ts: Date.now(), wf: inst.id,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { recorded: true };
}

async function _svcTicketGenerate({ eventId, orderId, uid, qty, tierName }, inst) {
  const tickets = [];
  for (let i = 0; i < (qty ?? 1); i++) {
    const code = _genTicketCode();
    const ref  = await db.collection("eventTickets").add({
      eventId, orderId, uid, tierName, code, seq: i + 1,
      status: "valid", issuedAt: Date.now(), wf: inst.id,
      serverTs: admin.firestore.FieldValue.serverTimestamp(),
    });
    tickets.push({ ticketId: ref.id, code });
  }
  return { generated: true, tickets, count: tickets.length };
}

async function _svcRentalReserve({ assetId, uid, startDate, endDate }, inst) {
  await db.runTransaction(async (txn) => {
    const ref  = db.collection("rentalAssets").doc(assetId);
    const snap = await txn.get(ref);
    if (!snap.exists) throw new Error(`Asset ${assetId} not found`);
    if (snap.data().status !== "available") throw new Error(`Asset ${assetId} not available`);
    txn.update(ref, { status: "reserved", reservedBy: uid, reservedFrom: startDate, reservedTo: endDate });
  });
  return { reserved: true, assetId };
}

async function _svcRentalRelease({ assetId }, inst) {
  await db.collection("rentalAssets").doc(assetId).update({
    status: "available", reservedBy: null, serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { released: true };
}

async function _svcSellerActivate({ uid, sellerUid, businessName }, inst) {
  await db.collection("users").doc(sellerUid ?? uid).set({
    role: "seller", verifiedAt: Date.now(), businessName,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { activated: true };
}

async function _svcNotification({ to, template, data, channels }, inst) {
  const ref = await db.collection("notificationQueue").add({
    to, template, data: data ?? {},
    channels: channels ?? ["push", "inapp"],
    status: "queued", queuedAt: Date.now(), wf: inst.id,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { sent: true, notificationId: ref.id };
}

async function _createApproval(stepDef, input, inst) {
  const approvalId = `${inst.id}_${stepDef.id}`;
  await db.collection(COLL.APPROVALS).doc(approvalId).set({
    id:          approvalId,
    instanceId:  inst.id,
    stepId:      stepDef.id,
    stepName:    stepDef.name,
    requestedAt: Date.now(),
    requestedBy: inst.metadata?.uid ?? null,
    deadline:    stepDef.approvalDeadline ? Date.now() + stepDef.approvalDeadline : null,
    assignees:   input.approvers ?? stepDef.approvers ?? [],
    message:     input.message ?? stepDef.approvalMessage ?? `Please approve: ${stepDef.name}`,
    payload:     input,
    status:      "pending",
    serverTs:    admin.firestore.FieldValue.serverTimestamp(),
  });
  /* Set workflow to waiting */
  await db.collection(COLL.INSTANCES).doc(inst.id).update({
    [`steps.${stepDef.id}.status`]:      "waiting",
    [`steps.${stepDef.id}.approvalId`]:  approvalId,
    [`steps.${stepDef.id}.startedAt`]:   Date.now(),
    status: WS.WAITING,
    "metadata.waitingFor":    { type: "approval", approvalId, stepId: stepDef.id },
    "metadata.lastEvent":     "approval_requested:" + stepDef.id,
    "metadata.lastUpdatedAt": Date.now(),
    history: admin.firestore.FieldValue.arrayUnion({ stepId: stepDef.id, status: "waiting", ts: Date.now(), approvalId }),
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function _scheduleDelay(stepDef, input, inst) {
  const durationMs = _parseDuration(input.duration ?? stepDef.duration ?? "0s");
  const resumeAt   = Date.now() + durationMs;
  await db.collection(COLL.SCHEDULE).doc(`${inst.id}_${stepDef.id}`).set({
    instanceId: inst.id, stepId: stepDef.id,
    executeAt: resumeAt, status: "pending", createdAt: Date.now(),
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection(COLL.INSTANCES).doc(inst.id).update({
    status: WS.WAITING,
    [`steps.${stepDef.id}.status`]:   "waiting",
    [`steps.${stepDef.id}.resumeAt`]: resumeAt,
    "metadata.waitingFor":    { type: "delay", stepId: stepDef.id, resumeAt },
    "metadata.lastEvent":     "delay_scheduled:" + stepDef.id,
    "metadata.lastUpdatedAt": Date.now(),
    history: admin.firestore.FieldValue.arrayUnion({ stepId: stepDef.id, status: "waiting", ts: Date.now(), resumeAt }),
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function _callWebhook(stepDef, input) {
  const https   = require("https");
  const url     = stepDef.url ?? input.url;
  const body    = JSON.stringify(input);
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end",  () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (_) { resolve({ ok: true }); }
        } else {
          reject(new Error(`Webhook ${stepDef.id} returned ${res.statusCode}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(stepDef.timeout ?? 30_000, () => { req.destroy(); reject(new Error("Webhook timeout")); });
    req.write(body);
    req.end();
  });
}

async function _compensate(instanceId, inst, def) {
  const toCompensate = [...(inst.completedSteps ?? [])].reverse();
  const historyEntries = [];

  for (const stepId of toCompensate) {
    const stepDef = (def.steps ?? []).find(s => s.id === stepId);
    if (!stepDef?.compensation) continue;
    const input = _interpolate(stepDef.input ?? {}, inst.variables);
    try {
      await _dispatchHandler(stepDef.compensation, { ...input, _stepOutput: inst.variables?.[stepId] }, inst);
      historyEntries.push({ stepId, status: "compensated", ts: Date.now() });
    } catch (e) {
      historyEntries.push({ stepId, status: "compensation_failed", ts: Date.now(), error: e.message });
    }
  }

  await db.collection(COLL.INSTANCES).doc(instanceId).update({
    status: WS.COMPENSATED,
    "metadata.compensatedAt": Date.now(),
    "metadata.lastEvent":     "compensated",
    "metadata.lastUpdatedAt": Date.now(),
    history: admin.firestore.FieldValue.arrayUnion(...historyEntries),
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function _interpolate(template, variables) {
  if (typeof template === "string") {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const val = path.trim().split(".").reduce((o, k) => o?.[k], variables);
      return val === undefined ? "" : String(val);
    });
  }
  if (Array.isArray(template)) return template.map(v => _interpolate(v, variables));
  if (template && typeof template === "object") {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = _interpolate(v, variables);
    return out;
  }
  return template;
}

function _parseDuration(s) {
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const m = String(s).match(/^(\d+\.?\d*)(ms|s|m|h|d)$/i);
  if (!m) return 0;
  return parseFloat(m[1]) * (units[m[2].toLowerCase()] ?? 1000);
}

function _haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dL = (lat2 - lat1) * Math.PI / 180, dl = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function _genId() {
  return "WF-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function _genTicketCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let code = "";
  for (let i = 0; i < 12; i++) { if (i && i % 4 === 0) code += "-"; code += c[Math.floor(Math.random() * c.length)]; }
  return code;
}
