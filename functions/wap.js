/* ================================================================
   SOKONI WORKFLOW AUTOMATION PLATFORM
   Cloud Functions  v1.1.0  — Production-Hardened

   Audit v1.1.0 fixes (June 2026):
     [CRIT] inventory.release now restores stock via transaction
     [CRIT] payment.authorize is idempotent (stable AUTH-{instanceId} key)
     [CRIT] payment.capture validates auth status before capturing
     [CRIT] commission.calculate uses orderId as doc ID (no duplicates)
     [CRIT] invoice.generate uses orderId as doc ID (no duplicates)
     [CRIT] loyalty.award uses loyaltyAwards/{uid}_{orderId} guard
     [CRIT] ticket.generate uses deterministic ${orderId}_tkt_${i} IDs
     [CRIT] seller.schedulePayout uses ${orderId}_payout as doc ID
     [CRIT] wapApproveStep uses Firestore transaction (atomic, no race)
     [CRIT] CF retry uses await-sleep instead of setTimeout (was silently dropped)
     [HIGH] wapScheduledResume resets stale 'processing' docs on start
     [HIGH] NEW: wapEscalateApprovals — expires overdue approvals every 15 min
     [HIGH] NEW: wapWatchdog — recovers stuck 'running' steps every 5 min
     [HIGH] NEW: wapDLQSweep — writes failed instances to workflowDLQ
     [HIGH] NEW: wapGetDLQ — callable: list DLQ items (admin only)
     [MED]  wapTriggerWorkflow — per-user rate limit (10 triggers/min)
     [MED]  RBAC check added to wapApproveStep (only assigned approvers)
================================================================ */

"use strict";

const { onCall, HttpsError }          = require("firebase-functions/v2/https");
const { onDocumentUpdated,
        onDocumentWritten }           = require("firebase-functions/v2/firestore");
const { onSchedule }                  = require("firebase-functions/v2/scheduler");
const admin                           = require("firebase-admin");

const { assertAuth, assertAdmin }     = require("./shared/errors");

const db = admin.firestore();

const COLL = {
  DEFS:      "workflowDefinitions",
  INSTANCES: "workflowInstances",
  APPROVALS: "workflowApprovals",
  SCHEDULE:  "workflowSchedule",
  DLQ:       "workflowDLQ",
  RATE:      "_wapRateLimits",
};

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
  const uid = assertAuth(req);

  /* Rate limit: 10 triggers per user per minute */
  await _checkRateLimit(uid);

  const { definitionId, variables = {}, module: mod } = req.data;
  if (!definitionId) throw new HttpsError("invalid-argument", "definitionId is required");

  /* Load definition from Firestore */
  const defSnap = await db.collection(COLL.DEFS).doc(definitionId).get();
  if (!defSnap.exists) throw new HttpsError("not-found", `Workflow definition '${definitionId}' not found`);
  const def = defSnap.data();

  if (!def.enabled && def.enabled !== undefined) {
    throw new HttpsError("failed-precondition", `Workflow '${definitionId}' is disabled`);
  }

  /* Snapshot the definition version at creation time */
  const instanceId = _genId();
  const instance = {
    id:                instanceId,
    definitionId,
    definitionVersion: def.version ?? "1.0",
    definitionSnapshot: def,   /* immutable snapshot so resume never uses a new version */
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

  console.info(`[WAP] Started workflow '${definitionId}' v${def.version ?? "1.0"} → ${instanceId}`);
  return { instanceId, status: WS.RUNNING };
});

/* ================================================================
   wapAdvanceWorkflow
   Triggered when a workflow instance document is UPDATED.
================================================================ */
exports.wapAdvanceWorkflow = onDocumentUpdated(
  { document: `${COLL.INSTANCES}/{instanceId}`, maxInstances: 50 },
  async (event) => {
    const { instanceId } = event.params;
    const after  = event.data.after.data();
    const before = event.data.before.data();

    /* Guard: skip terminal/waiting states and pure metadata-only updates */
    if (after.status === before.status && after.metadata?.lastEvent === before.metadata?.lastEvent) return;
    if ([WS.COMPLETED, WS.FAILED, WS.CANCELLED, WS.PAUSED,
         WS.WAITING, WS.COMPENSATED].includes(after.status)) return;

    /* Use the definition snapshot stored on instance (versioning fix) */
    const def = after.definitionSnapshot ?? null;
    let defData = def;
    if (!defData) {
      const defSnap = await db.collection(COLL.DEFS).doc(after.definitionId).get();
      if (!defSnap.exists) {
        console.error(`[WAP] Definition '${after.definitionId}' not found for ${instanceId}`);
        return;
      }
      defData = defSnap.data();
    }

    /* Transaction: atomically claim one ready step */
    await db.runTransaction(async (txn) => {
      const ref  = db.collection(COLL.INSTANCES).doc(instanceId);
      const snap = await txn.get(ref);
      if (!snap.exists) return;
      const inst = { id: snap.id, ...snap.data() };

      if ([WS.COMPLETED, WS.FAILED, WS.CANCELLED, WS.PAUSED, WS.WAITING].includes(inst.status)) return;

      const readySteps = _findReadySteps(defData.steps ?? [], inst);
      if (!readySteps.length) {
        const allSteps = (defData.steps ?? []).map(s => s.id);
        const done = allSteps.every(id =>
          inst.completedSteps.includes(id) ||
          inst.skippedSteps.includes(id)   ||
          inst.failedSteps.includes(id)
        );
        if (done) {
          const hasFailed           = inst.failedSteps.length > 0;
          inst.status               = hasFailed ? WS.FAILED : WS.COMPLETED;
          inst.metadata.completedAt = Date.now();
          inst.metadata.duration    = inst.metadata.completedAt - inst.metadata.startedAt;
          inst.metadata.lastEvent   = hasFailed ? "completed_with_failures" : "completed";
          txn.set(ref, { ...inst, serverTs: admin.firestore.FieldValue.serverTimestamp() });
          console.info(`[WAP] ${instanceId} → ${inst.status} in ${inst.metadata.duration}ms`);
        }
        return;
      }

      /* Claim first ready step atomically — prevents duplicate execution */
      const stepDef = readySteps[0];
      inst.steps[stepDef.id] = { status: "running", startedAt: Date.now(), retryCount: 0 };
      inst.metadata.lastEvent     = "step_running:" + stepDef.id;
      inst.metadata.lastUpdatedAt = Date.now();
      txn.set(ref, { ...inst, serverTs: admin.firestore.FieldValue.serverTimestamp() });
    });

    /* Fetch fresh state and execute the claimed step */
    const freshSnap = await db.collection(COLL.INSTANCES).doc(instanceId).get();
    if (!freshSnap.exists) return;
    const inst = { id: freshSnap.id, ...freshSnap.data() };

    const runningStepId = Object.entries(inst.steps)
      .find(([, s]) => s.status === "running")?.[0];
    if (!runningStepId) return;

    const stepDef = (defData.steps ?? []).find(s => s.id === runningStepId);
    if (!stepDef) return;

    try {
      const output = await _executeServerStep(stepDef, inst);

      const update = {
        [`steps.${runningStepId}.status`]:      "completed",
        [`steps.${runningStepId}.completedAt`]: Date.now(),
        [`steps.${runningStepId}.output`]:      output ?? null,
        [`steps.${runningStepId}.duration`]:    Date.now() - inst.steps[runningStepId].startedAt,
        completedSteps: admin.firestore.FieldValue.arrayUnion(runningStepId),
        history:        admin.firestore.FieldValue.arrayUnion({
          stepId: runningStepId, status: "completed", ts: Date.now(), output: output ?? null,
        }),
        "metadata.lastEvent":     "step_completed:" + runningStepId,
        "metadata.lastUpdatedAt": Date.now(),
        serverTs:                 admin.firestore.FieldValue.serverTimestamp(),
      };

      if (output && typeof output === "object") {
        Object.entries(output).forEach(([k, v]) => {
          update[`variables.${runningStepId}.${k}`] = v;
        });
      }

      await db.collection(COLL.INSTANCES).doc(instanceId).update(update);

    } catch (err) {
      console.error(`[WAP] Step '${runningStepId}' failed in ${instanceId}:`, err.message);

      const retryCount = (inst.steps[runningStepId]?.retryCount ?? 0) + 1;
      const maxRetries = stepDef.retries ?? 0;

      if (retryCount <= maxRetries) {
        const backoffMs = Math.min((stepDef.retryDelay ?? 2_000) * 2 ** (retryCount - 1), 30_000);

        /* Wait inline — valid within a CF execution (max timeout is 540s).
           Capped at 25s for safety; very long retries use the schedule collection. */
        if (backoffMs <= 25_000) {
          await new Promise(r => setTimeout(r, backoffMs));
          /* Reset step to pending; the doc-update triggers wapAdvanceWorkflow again */
          await db.collection(COLL.INSTANCES).doc(instanceId).update({
            [`steps.${runningStepId}.status`]:     "pending",
            [`steps.${runningStepId}.retryCount`]: retryCount,
            [`steps.${runningStepId}.lastError`]:  err.message,
            "metadata.lastEvent":                  `step_retry_ready:${runningStepId}:${retryCount}`,
            "metadata.lastUpdatedAt":              Date.now(),
            serverTs: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          /* Long retry: schedule via workflowSchedule collection */
          const retryAt     = Date.now() + backoffMs;
          const schedDocId  = `${instanceId}_${runningStepId}_retry_${retryCount}`;
          await db.collection(COLL.SCHEDULE).doc(schedDocId).set({
            instanceId, stepId: runningStepId, type: "retry",
            executeAt: retryAt, retryCount, status: "pending",
            createdAt: Date.now(), serverTs: admin.firestore.FieldValue.serverTimestamp(),
          });
          await db.collection(COLL.INSTANCES).doc(instanceId).update({
            [`steps.${runningStepId}.status`]:      "waiting",
            [`steps.${runningStepId}.retryCount`]:  retryCount,
            [`steps.${runningStepId}.lastError`]:   err.message,
            [`steps.${runningStepId}.nextRetryAt`]: retryAt,
            "metadata.lastEvent":                   `step_retry_scheduled:${runningStepId}:${retryCount}`,
            "metadata.lastUpdatedAt":               Date.now(),
            serverTs: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        return;
      }

      /* Permanent failure */
      const onFailure = stepDef.onFailure ?? "fail";
      const baseUpdate = {
        [`steps.${runningStepId}.status`]:   "failed",
        [`steps.${runningStepId}.failedAt`]: Date.now(),
        [`steps.${runningStepId}.error`]:    err.message,
        failedSteps: admin.firestore.FieldValue.arrayUnion(runningStepId),
        history:     admin.firestore.FieldValue.arrayUnion({
          stepId: runningStepId, status: "failed", ts: Date.now(), error: err.message,
        }),
        "metadata.lastEvent":     "step_failed:" + runningStepId,
        "metadata.lastUpdatedAt": Date.now(),
        serverTs: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (onFailure === "fail") {
        baseUpdate.status                    = WS.FAILED;
        baseUpdate.error                     = `Step '${stepDef.name}' failed: ${err.message}`;
        baseUpdate["metadata.completedAt"]   = Date.now();
      } else if (onFailure === "continue") {
        baseUpdate.completedSteps = admin.firestore.FieldValue.arrayUnion(runningStepId);
        delete baseUpdate.failedSteps;
      } else if (onFailure === "compensate") {
        baseUpdate.status = WS.COMPENSATING;
      }

      await db.collection(COLL.INSTANCES).doc(instanceId).update(baseUpdate);

      if (onFailure === "compensate") {
        const defForComp = inst.definitionSnapshot ?? defData;
        await _compensate(instanceId, inst, defForComp);
      }
    }
  }
);

/* ================================================================
   wapApproveStep
   Atomic approval decision — Firestore transaction prevents race conditions.
================================================================ */
exports.wapApproveStep = onCall({ maxInstances: 50 }, async (req) => {
  const uid = assertAuth(req);

  const { approvalId, decision, reason = "" } = req.data;
  if (!approvalId) throw new HttpsError("invalid-argument", "approvalId is required");
  if (!["approved", "rejected"].includes(decision)) {
    throw new HttpsError("invalid-argument", "decision must be 'approved' or 'rejected'");
  }

  const approvalRef = db.collection(COLL.APPROVALS).doc(approvalId);
  let approval;

  /* ATOMIC: check status + write decision in single transaction (no race) */
  try {
    await db.runTransaction(async (txn) => {
      const snap = await txn.get(approvalRef);
      if (!snap.exists) throw new HttpsError("not-found", `Approval '${approvalId}' not found`);
      approval = snap.data();

      if (approval.status !== "pending") {
        throw new HttpsError("failed-precondition", `Approval is already '${approval.status}'`);
      }
      if (approval.deadline && Date.now() > approval.deadline) {
        throw new HttpsError("deadline-exceeded", "Approval deadline has passed");
      }

      /* Authorization: must be an assigned approver or a platform admin */
      const assignees = approval.assignees ?? [];
      const isAssigned = assignees.some(a => a === uid || a === `role:admin`);
      if (!isAssigned) {
        const claims    = req.auth.token ?? {};
        const userRole  = claims.eccRole || claims.role || "";
        const adminRoles = ["admin", "super_admin", "ops_admin", "support_admin"];
        if (!adminRoles.includes(userRole)) {
          throw new HttpsError("permission-denied", "Not authorized to decide this approval");
        }
      }

      txn.update(approvalRef, {
        status:    decision,
        decidedBy: uid,
        decidedAt: Date.now(),
        reason,
        serverTs:  admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("internal", e.message);
  }

  /* Update workflow instance */
  const instanceRef = db.collection(COLL.INSTANCES).doc(approval.instanceId);
  const stepId      = approval.stepId;
  const stepStatus  = decision === "approved" ? "completed" : "failed";

  const update = {
    [`steps.${stepId}.status`]:           stepStatus,
    [`steps.${stepId}.completedAt`]:      Date.now(),
    [`steps.${stepId}.approvalDecision`]: decision,
    [`steps.${stepId}.decidedBy`]:        uid,
    status:  WS.RUNNING,
    history: admin.firestore.FieldValue.arrayUnion({
      stepId, status: stepStatus, ts: Date.now(), actor: uid,
      approvalDecision: decision, reason,
    }),
    "metadata.lastEvent":     `approval_${decision}:${stepId}`,
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
   Every 5 minutes: resume delay steps and long-backoff retries.
================================================================ */
exports.wapScheduledResume = onSchedule("every 5 minutes", async () => {
  const now = Date.now();

  /* 1. Reset stale 'processing' docs (left by crashed CF invocations > 10 min old) */
  const staleSnap = await db.collection(COLL.SCHEDULE)
    .where("status", "==", "processing")
    .where("createdAt", "<", now - 600_000)
    .limit(20).get();

  if (!staleSnap.empty) {
    const staleBatch = db.batch();
    staleSnap.docs.forEach(d => staleBatch.update(d.ref, { status: "pending" }));
    await staleBatch.commit();
    console.warn(`[WAP] Scheduler: reset ${staleSnap.size} stale processing docs`);
  }

  /* 2. Find due schedule items (delay + retry) */
  const snap = await db.collection(COLL.SCHEDULE)
    .where("status", "==", "pending")
    .where("executeAt", "<=", now)
    .limit(50).get();

  if (snap.empty) return;

  const batch     = db.batch();
  const toProcess = [];

  snap.docs.forEach(d => {
    batch.update(d.ref, { status: "processing" });
    toProcess.push({ ...d.data(), _docId: d.id });
  });
  await batch.commit();

  for (const sched of toProcess) {
    try {
      const instRef  = db.collection(COLL.INSTANCES).doc(sched.instanceId);
      const instSnap = await instRef.get();
      if (!instSnap.exists) {
        await db.collection(COLL.SCHEDULE).doc(sched._docId).update({ status: "done" });
        continue;
      }

      if (sched.type === "retry") {
        /* Retry: reset step to pending so wapAdvanceWorkflow picks it up */
        await instRef.update({
          [`steps.${sched.stepId}.status`]:   "pending",
          "metadata.lastEvent":     `step_retry_trigger:${sched.stepId}:${sched.retryCount}`,
          "metadata.lastUpdatedAt": now,
          serverTs: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        /* Delay: mark step completed, resume workflow */
        await instRef.update({
          [`steps.${sched.stepId}.status`]:      "completed",
          [`steps.${sched.stepId}.completedAt`]: now,
          completedSteps: admin.firestore.FieldValue.arrayUnion(sched.stepId),
          status:  WS.RUNNING,
          history: admin.firestore.FieldValue.arrayUnion({
            stepId: sched.stepId, status: "completed", ts: now, reason: "delay expired",
          }),
          "metadata.lastEvent":     `delay_expired:${sched.stepId}`,
          "metadata.lastUpdatedAt": now,
          serverTs: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      await db.collection(COLL.SCHEDULE).doc(sched._docId).update({ status: "done" });
      console.info(`[WAP] Scheduler: resumed ${sched.type ?? "delay"} '${sched.stepId}' in ${sched.instanceId}`);

    } catch (e) {
      console.error(`[WAP] Scheduler: failed to process ${sched.instanceId}/${sched.stepId}:`, e.message);
      await db.collection(COLL.SCHEDULE).doc(sched._docId).update({ status: "pending" });
    }
  }
});

/* ================================================================
   wapEscalateApprovals — NEW
   Every 15 minutes: expire overdue approvals and notify ops.
================================================================ */
exports.wapEscalateApprovals = onSchedule("every 15 minutes", async () => {
  const now = Date.now();

  const snap = await db.collection(COLL.APPROVALS)
    .where("status", "==", "pending")
    .where("deadline", "<", now)
    .limit(50).get();

  if (snap.empty) return;

  for (const d of snap.docs) {
    const approval = d.data();
    try {
      /* Atomically mark approval expired */
      await db.runTransaction(async (txn) => {
        const fresh = await txn.get(d.ref);
        if (!fresh.exists || fresh.data().status !== "pending") return;
        txn.update(d.ref, {
          status:    "expired",
          expiredAt: now,
          serverTs:  admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      /* Fail the workflow step */
      await db.collection(COLL.INSTANCES).doc(approval.instanceId).update({
        [`steps.${approval.stepId}.status`]:   "failed",
        [`steps.${approval.stepId}.failedAt`]: now,
        [`steps.${approval.stepId}.error`]:    "Approval deadline exceeded — auto-expired",
        failedSteps: admin.firestore.FieldValue.arrayUnion(approval.stepId),
        status:      WS.FAILED,
        error:       `Approval '${approval.stepId}' expired without decision`,
        history:     admin.firestore.FieldValue.arrayUnion({
          stepId: approval.stepId, status: "failed", ts: now,
          reason: "deadline_exceeded", approvalId: d.id,
        }),
        "metadata.lastEvent":     `approval_expired:${approval.stepId}`,
        "metadata.lastUpdatedAt": now,
        serverTs: admin.firestore.FieldValue.serverTimestamp(),
      });

      /* Queue escalation notification */
      await db.collection("notificationQueue").add({
        to:       "role:ops_admin",
        template: "approval_escalation",
        data:     {
          instanceId: approval.instanceId,
          stepId:     approval.stepId,
          approvalId: d.id,
          stepName:   approval.stepName,
        },
        channels: ["push", "email"],
        status:   "queued",
        queuedAt: now,
        wf:       approval.instanceId,
        serverTs: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.info(`[WAP] Escalated expired approval ${d.id} in ${approval.instanceId}`);
    } catch (e) {
      console.error(`[WAP] Failed to escalate approval ${d.id}:`, e.message);
    }
  }
});

/* ================================================================
   wapWatchdog — NEW
   Every 5 minutes: recover steps stuck in 'running' for > 10 min.
================================================================ */
exports.wapWatchdog = onSchedule("every 5 minutes", async () => {
  const staleThreshold = Date.now() - 600_000;  /* 10 minutes */

  const snap = await db.collection(COLL.INSTANCES)
    .where("status", "==", WS.RUNNING)
    .limit(100).get();

  let recovered = 0;
  for (const d of snap.docs) {
    const inst = d.data();
    const stuckEntries = Object.entries(inst.steps ?? {})
      .filter(([, s]) => s.status === "running" && s.startedAt < staleThreshold);
    if (!stuckEntries.length) continue;

    console.warn(`[WAP] Watchdog: ${d.id} has ${stuckEntries.length} stuck step(s)`);

    const update = {
      "metadata.lastEvent":     "watchdog_recovery",
      "metadata.lastUpdatedAt": Date.now(),
      serverTs: admin.firestore.FieldValue.serverTimestamp(),
    };
    for (const [stepId] of stuckEntries) {
      update[`steps.${stepId}.status`]               = "pending";
      update[`steps.${stepId}.watchdogRecoveredAt`]  = Date.now();
    }

    await d.ref.update(update);
    recovered++;
  }

  if (recovered) console.info(`[WAP] Watchdog: recovered ${recovered} instance(s)`);
});

/* ================================================================
   wapDLQSweep — NEW
   Triggered when an instance transitions to FAILED.
   Writes a sanitized record to workflowDLQ for ops recovery.
================================================================ */
exports.wapDLQSweep = onDocumentWritten(
  { document: `${COLL.INSTANCES}/{instanceId}`, maxInstances: 30 },
  async (event) => {
    const after  = event.data.after?.data();
    const before = event.data.before?.data();
    if (!after) return;
    if (after.status !== WS.FAILED) return;
    if (before?.status === WS.FAILED) return;  /* Already failed — don't duplicate */

    const { instanceId } = event.params;
    const failedStep     = after.failedSteps?.[after.failedSteps.length - 1];

    await db.collection(COLL.DLQ).doc(instanceId).set({
      instanceId,
      definitionId:      after.definitionId,
      definitionVersion: after.definitionVersion,
      module:            after.metadata?.module,
      error:             after.error,
      failedStep,
      failedStepError:   failedStep ? (after.steps?.[failedStep]?.error ?? null) : null,
      retryCount:        failedStep ? (after.steps?.[failedStep]?.retryCount ?? 0) : 0,
      startedAt:         after.metadata?.startedAt,
      failedAt:          Date.now(),
      resolvedAt:        null,
      resolvedBy:        null,
      resolution:        null,
      variables:         _sanitizeDLQ(after.variables ?? {}),
      serverTs:          admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: false });

    console.info(`[WAP DLQ] ${instanceId} written to DLQ (${after.error})`);
  }
);

/* ================================================================
   wapGetDLQ — NEW
   Callable (admin): list dead-letter queue items for ops recovery.
================================================================ */
exports.wapGetDLQ = onCall({ maxInstances: 20 }, async (req) => {
  const uid = assertAuth(req);

  const userRecord = await admin.auth().getUser(uid).catch(() => null);
  const claims     = userRecord?.customClaims ?? {};
  const isAdmin    = claims.role === "admin" || claims.superAdmin ||
                     ["super_admin","ops_admin","support_admin"].includes(claims.eccRole);
  if (!isAdmin) throw new HttpsError("permission-denied", "Admin role required");

  const { limitN = 50, onlyUnresolved = true } = req.data ?? {};
  let q = db.collection(COLL.DLQ)
    .orderBy("failedAt", "desc")
    .limit(Math.min(limitN, 100));
  if (onlyUnresolved) q = q.where("resolvedAt", "==", null);

  const snap = await q.get();
  return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/* ================================================================
   wapGetInstance — unchanged
================================================================ */
exports.wapGetInstance = onCall({ maxInstances: 50 }, async (req) => {
  const uid = assertAuth(req);

  const { instanceId } = req.data;
  if (!instanceId) throw new HttpsError("invalid-argument", "instanceId required");

  const snap = await db.collection(COLL.INSTANCES).doc(instanceId).get();
  if (!snap.exists) throw new HttpsError("not-found", `Instance '${instanceId}' not found`);

  const inst    = { id: snap.id, ...snap.data() };
  const defSnap = await db.collection(COLL.DEFS).doc(inst.definitionId).get();

  return {
    instance:   inst,
    definition: inst.definitionSnapshot ?? (defSnap.exists ? defSnap.data() : null),
  };
});

/* ================================================================
   wapGetPendingApprovals — unchanged
================================================================ */
exports.wapGetPendingApprovals = onCall({ maxInstances: 20 }, async (req) => {
  const uid = assertAuth(req);

  const snap = await db.collection(COLL.APPROVALS)
    .where("status",    "==", "pending")
    .where("assignees", "array-contains-any", [uid, `role:admin`])
    .orderBy("requestedAt", "desc")
    .limit(50).get();

  return { approvals: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/* ================================================================
   wapSaveDefinition — enhanced with version bump
================================================================ */
exports.wapSaveDefinition = onCall({ maxInstances: 10 }, async (req) => {
  const uid = assertAuth(req);

  const userRecord = await admin.auth().getUser(uid).catch(() => null);
  const claims     = userRecord?.customClaims ?? {};
  const isAdmin    = claims.role === "admin" || claims.superAdmin ||
                     ["super_admin","ops_admin"].includes(claims.eccRole);
  if (!isAdmin) throw new HttpsError("permission-denied", "Admin role required to save workflow definitions");

  const { definition } = req.data;
  if (!definition?.id || !definition?.name || !Array.isArray(definition?.steps)) {
    throw new HttpsError("invalid-argument", "definition.id, .name and .steps are required");
  }

  /* Preserve + increment version when updating an existing definition */
  const existing = await db.collection(COLL.DEFS).doc(definition.id).get();
  let version = definition.version ?? "1.0";
  if (existing.exists) {
    const [maj, min] = (existing.data().version ?? "1.0").split(".").map(Number);
    version = `${maj}.${(min ?? 0) + 1}`;
  }

  const payload = {
    ...definition,
    version,
    updatedAt:  Date.now(),
    updatedBy:  uid,
    serverTs:   admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection(COLL.DEFS).doc(definition.id).set(payload, { merge: true });

  /* Archive previous version for reproducibility */
  await db.collection(COLL.DEFS).doc(definition.id)
    .collection("versions").doc(version).set(payload);

  return { saved: true, definitionId: definition.id, version };
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
    return deps.every(d =>
      instance.completedSteps.includes(d) ||
      instance.skippedSteps.includes(d)
    );
  });
}

async function _executeServerStep(stepDef, instance) {
  const type    = stepDef.type ?? "task";
  const handler = stepDef.handler ?? "";
  const input   = _interpolate(stepDef.input ?? {}, instance.variables);

  switch (type) {
    case "notification":
      return _svcNotification(input, instance);
    case "approval":
      await _createApproval(stepDef, input, instance);
      return null;
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
  switch (handler) {
    case "inventory.reserve":    return _svcInventoryReserve(input, instance);
    case "inventory.release":    return _svcInventoryRelease(input, instance);
    case "payment.authorize":    return _svcPaymentAuthorize(input, instance);
    case "payment.capture":      return _svcPaymentCapture(input, instance);
    case "payment.void":         return _svcPaymentVoid(input, instance);
    case "payment.refund":       return _svcPaymentRefund(input, instance);
    case "commission.calculate": return _svcCommission(input, instance);
    case "seller.schedulePayout": return _svcSchedulePayout(input, instance);
    case "driver.assign":        return _svcDriverAssign(input, instance);
    case "driver.release":       return _svcDriverRelease(input, instance);
    case "order.updateStatus":   return _svcOrderStatus(input, instance);
    case "invoice.generate":     return _svcInvoice(input, instance);
    case "loyalty.award":        return _svcLoyalty(input, instance);
    case "analytics.record":     return _svcAnalytics(input, instance);
    case "ticket.generate":      return _svcTicketGenerate(input, instance);
    case "rental.reserve":       return _svcRentalReserve(input, instance);
    case "rental.release":       return _svcRentalRelease(input, instance);
    case "seller.activate":      return _svcSellerActivate(input, instance);
    default:
      console.warn(`[WAP] Unknown handler '${handler}' — skipping`);
      return { skipped: true, handler };
  }
}

/* ── Service implementations ─────────────────────────────────── */

async function _svcInventoryReserve({ orderId, items }, inst) {
  const results = [];
  await db.runTransaction(async (txn) => {
    for (const item of (items ?? [])) {
      const ref  = db.collection("products").doc(item.productId);
      const snap = await txn.get(ref);
      if (!snap.exists) throw new Error(`Product ${item.productId} not found`);

      /* Idempotency: if already reserved for this order, skip */
      if (snap.data().reservations?.[orderId]) {
        results.push({ productId: item.productId, reserved: item.qty, idempotent: true });
        continue;
      }
      const stock = snap.data().stock ?? 0;
      if (stock < item.qty) throw new Error(`Insufficient stock for ${item.productId} (need ${item.qty}, have ${stock})`);
      txn.update(ref, {
        stock: admin.firestore.FieldValue.increment(-item.qty),
        [`reservations.${orderId}`]: item.qty,
      });
      results.push({ productId: item.productId, reserved: item.qty });
    }
  });
  return { reserved: true, items: results, orderId };
}

/* FIXED: restores stock + uses transaction for idempotency */
async function _svcInventoryRelease({ orderId, items }, inst) {
  for (const item of (items ?? [])) {
    await db.runTransaction(async (txn) => {
      const ref  = db.collection("products").doc(item.productId);
      const snap = await txn.get(ref);
      if (!snap.exists) return;
      const reservedQty = snap.data().reservations?.[orderId];
      if (!reservedQty) return;  /* Already released — idempotent */
      txn.update(ref, {
        stock: admin.firestore.FieldValue.increment(reservedQty),
        [`reservations.${orderId}`]: admin.firestore.FieldValue.delete(),
      });
    });
  }
  return { released: true };
}

/* FIXED: idempotent — stable AUTH-{instanceId} key, transaction guard */
async function _svcPaymentAuthorize({ orderId, amount, paymentMethod, phone, uid }, inst) {
  if (!amount || Number(amount) <= 0) throw new HttpsError("invalid-argument", "Invalid payment amount");
  const authRef = `AUTH-${inst.id}`;  /* Stable, unique per workflow instance */

  await db.runTransaction(async (txn) => {
    const ref  = db.collection("paymentAuthorizations").doc(authRef);
    const snap = await txn.get(ref);
    if (snap.exists) {
      const d = snap.data();
      if (d.status === "authorized" || d.status === "captured") return;  /* Idempotent */
      if (d.status === "voided" || d.status === "failed") throw new Error(`Payment already ${d.status}`);
    }
    txn.set(ref, {
      orderId, amount: Number(amount), paymentMethod, phone, uid,
      status: "authorized", createdAt: Date.now(), wf: inst.id,
      serverTs: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return { authorized: true, authRef };
}

/* FIXED: validates auth status before capturing; idempotent */
async function _svcPaymentCapture({ authRef, amount, orderId }, inst) {
  if (!authRef) throw new Error("authRef is required");
  await db.runTransaction(async (txn) => {
    const ref  = db.collection("paymentAuthorizations").doc(authRef);
    const snap = await txn.get(ref);
    if (!snap.exists) throw new Error(`Authorization '${authRef}' not found`);
    const d = snap.data();
    if (d.status === "captured") return;  /* Idempotent */
    if (d.status !== "authorized") throw new Error(`Cannot capture payment in status '${d.status}'`);
    txn.update(ref, {
      status: "captured", capturedAt: Date.now(),
      serverTs: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return { captured: true, capturedAt: Date.now() };
}

async function _svcPaymentVoid({ authRef }, inst) {
  if (!authRef) return { voided: true, skipped: true };
  await db.runTransaction(async (txn) => {
    const ref  = db.collection("paymentAuthorizations").doc(authRef);
    const snap = await txn.get(ref);
    if (!snap.exists) return;
    if (snap.data().status === "voided") return;  /* Idempotent */
    txn.update(ref, { status: "voided", voidedAt: Date.now(), serverTs: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { voided: true };
}

async function _svcPaymentRefund({ orderId, amount, reason, uid }, inst) {
  /* Idempotent: use orderId as refund doc ID */
  const ref = db.collection("refunds").doc(`${orderId}_refund`);
  const existing = await ref.get();
  if (existing.exists) return { refunded: true, refundId: ref.id };
  await ref.set({
    orderId, amount: Number(amount), reason, uid,
    status: "processing", createdAt: Date.now(), wf: inst.id,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { refunded: true, refundId: ref.id };
}

/* FIXED: idempotent — orderId as doc ID */
async function _svcCommission({ orderId, total, category, sellerUid }, inst) {
  const rates      = { food: 0.15, delivery: 0.12, marketplace: 0.08, services: 0.10, default: 0.08 };
  const pct        = rates[category] ?? rates.default;
  const commission = Math.round(Number(total) * pct * 100) / 100;
  const sellerNet  = Math.round((Number(total) - commission) * 100) / 100;

  const ref = db.collection("commissions").doc(orderId);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists && snap.data().status !== "error") return;  /* Idempotent */
    txn.set(ref, {
      orderId, sellerUid, total: Number(total), pct, commission, sellerNet,
      status: "pending", createdAt: Date.now(), wf: inst.id,
      serverTs: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return { commission, sellerNet, pct };
}

/* FIXED: idempotent — ${orderId}_payout as doc ID */
async function _svcSchedulePayout({ sellerUid, orderId, amount }, inst) {
  const ref = db.collection("payoutQueue").doc(`${orderId}_payout`);
  const existing = await ref.get();
  if (existing.exists) return { scheduled: true, payoutId: ref.id, scheduleAt: existing.data().scheduleAt };

  const scheduleAt = Date.now() + 86_400_000;
  await ref.set({
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

/* FIXED: idempotent — orderId as doc ID */
async function _svcInvoice({ orderId, uid, sellerUid, items, total, commission }, inst) {
  const ref = db.collection("invoices").doc(orderId);
  const existing = await ref.get();
  if (existing.exists) return { generated: true, invoiceId: orderId };
  await ref.set({
    orderId, uid, sellerUid, items: items ?? [], total, commission,
    status: "issued", issuedAt: Date.now(), wf: inst.id,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { generated: true, invoiceId: orderId };
}

/* FIXED: idempotent — loyaltyAwards/{uid}_{orderId} guard + transaction */
async function _svcLoyalty({ uid, orderId, amount }, inst) {
  if (!uid) return { awarded: 0 };
  const points = Math.floor(Number(amount) * 0.01);
  if (points <= 0) return { awarded: 0 };

  const awardRef   = db.collection("loyaltyAwards").doc(`${uid}_${orderId}`);
  const accountRef = db.collection("loyaltyAccounts").doc(uid);
  let awarded = 0;

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(awardRef);
    if (snap.exists) { awarded = snap.data().points; return; }  /* Idempotent */
    txn.set(awardRef, { uid, orderId, points, awardedAt: Date.now(), wf: inst.id, serverTs: admin.firestore.FieldValue.serverTimestamp() });
    txn.set(accountRef, {
      points: admin.firestore.FieldValue.increment(points),
      lastAwardedAt: Date.now(), serverTs: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    awarded = points;
  });
  return { awarded };
}

async function _svcAnalytics({ event, module: mod, data }, inst) {
  await db.collection("analyticsEvents").add({
    event, module: mod, data: data ?? {}, ts: Date.now(), wf: inst.id,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { recorded: true };
}

/* FIXED: idempotent — deterministic ${orderId}_tkt_${i} doc IDs */
async function _svcTicketGenerate({ eventId, orderId, uid, qty, tierName }, inst) {
  const tickets = [];
  for (let i = 0; i < (qty ?? 1); i++) {
    const ticketId = `${orderId}_tkt_${i + 1}`;
    const ref      = db.collection("eventTickets").doc(ticketId);
    const existing = await ref.get();
    if (existing.exists) {
      tickets.push({ ticketId, code: existing.data().code });
      continue;
    }
    const code = _genTicketCode();
    await ref.set({
      eventId, orderId, uid, tierName, code, seq: i + 1,
      status: "valid", issuedAt: Date.now(), wf: inst.id,
      serverTs: admin.firestore.FieldValue.serverTimestamp(),
    });
    tickets.push({ ticketId, code });
  }
  return { generated: true, tickets, count: tickets.length };
}

async function _svcRentalReserve({ assetId, uid, startDate, endDate }, inst) {
  await db.runTransaction(async (txn) => {
    const ref  = db.collection("rentalAssets").doc(assetId);
    const snap = await txn.get(ref);
    if (!snap.exists) throw new Error(`Asset ${assetId} not found`);
    if (snap.data().status === "reserved" && snap.data().reservedBy === uid) return; /* Idempotent */
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
  /* Use instanceId+stepId for idempotency — prevents duplicate notifications on retry */
  const notifId = `${inst.id}_notif_${template}`;
  const ref     = db.collection("notificationQueue").doc(notifId);
  const existing = await ref.get();
  if (existing.exists) return { sent: true, notificationId: notifId };
  await ref.set({
    to, template, data: data ?? {},
    channels: channels ?? ["push", "inapp"],
    status: "queued", queuedAt: Date.now(), wf: inst.id,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { sent: true, notificationId: notifId };
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
  }, { merge: true });  /* merge: idempotent on re-execution */

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
    instanceId: inst.id, stepId: stepDef.id, type: "delay",
    executeAt: resumeAt, status: "pending", createdAt: Date.now(),
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
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
  if (!url) throw new Error("Webhook URL is required");
  const body    = JSON.stringify(input);
  const timeout = stepDef.timeout ?? 30_000;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (_) { resolve({ ok: true }); }
        } else {
          reject(new Error(`Webhook ${stepDef.id} returned ${res.statusCode}`));
        }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error(`Webhook '${stepDef.id}' timed out after ${timeout}ms`)); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function _compensate(instanceId, inst, def) {
  const toCompensate   = [...(inst.completedSteps ?? [])].reverse();
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
      console.error(`[WAP] Compensation of '${stepId}' failed:`, e.message);
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

/* Rate limiting — 10 workflow triggers per user per minute */
async function _checkRateLimit(uid) {
  const window = Math.floor(Date.now() / 60_000);
  const ref    = db.collection(COLL.RATE).doc(`${uid}_${window}`);
  const count  = await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const n    = (snap.data()?.count ?? 0) + 1;
    txn.set(ref, { count: n, uid, window, expireAt: (window + 2) * 60_000 });
    return n;
  });
  if (count > 10) throw new HttpsError("resource-exhausted", "Workflow rate limit exceeded (10/min). Please slow down.");
  /* Fire-and-forget cleanup of expired rate limit docs */
  db.collection(COLL.RATE).where("expireAt", "<", Date.now()).limit(10).get()
    .then(snap => { const b = db.batch(); snap.docs.forEach(d => b.delete(d.ref)); return b.commit(); })
    .catch(() => {});
}

/* PII fields to strip from DLQ variables */
const DLQ_PII = new Set(["phone","email","password","pin","token","secret","name","idNumber"]);
function _sanitizeDLQ(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars ?? {})) {
    out[k] = DLQ_PII.has(k) ? "[REDACTED]" : (v && typeof v === "object" ? "[object]" : v);
  }
  return out;
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
  const R = 6371, dL = (lat2-lat1)*Math.PI/180, dl = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function _genId() {
  return "WF-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2,7).toUpperCase();
}

function _genTicketCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let code = "";
  for (let i = 0; i < 12; i++) { if (i && i%4===0) code += "-"; code += c[Math.floor(Math.random()*c.length)]; }
  return code;
}
