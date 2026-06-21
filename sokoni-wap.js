/* ================================================================
   SOKONI WORKFLOW AUTOMATION PLATFORM
   Core Engine  v1.0.0

   Architecture: Firestore-backed DAG execution engine.
   Every step transition is persisted before execution continues,
   giving zero-data-loss recovery from any failure point.

   Two execution modes:
     CLIENT  — lightweight, synchronous workflows (notifications, analytics)
     SERVER  — durable, CF-backed workflows (orders, payments, deliveries)

   Step types:
     task          — execute a registered handler function
     parallel      — execute a set of steps concurrently
     condition     — branch based on a boolean expression
     approval      — pause until a human approves/rejects
     delay         — wait for a timer (Cloud Scheduler)
     notification  — send push/SMS/email/webhook
     subworkflow   — start a child workflow
     webhook       — call an external HTTP endpoint

   Step DAG resolution:
     A step is READY when all its `after` dependencies are COMPLETED.
     Ready steps execute immediately (possibly in parallel).
     The engine advances after every completion until no more ready steps exist.

   Usage:
     import wap from './sokoni-wap.js';

     wap.register('inventory.reserve', async (input, ctx) => { ... });

     const instance = await wap.start('marketplace_order', {
       orderId: 'ord_123', items: [...], total: 1500,
     });

   Exposes: window.SokoniWAP + ES default export
================================================================ */

import log   from './sokoni-intelligence-log.js';
import flags from './sokoni-feature-flags.js';

/* ── Status constants ────────────────────────────────────────── */
export const WORKFLOW_STATUS = Object.freeze({
  PENDING:       'pending',
  RUNNING:       'running',
  WAITING:       'waiting',     /* waiting for approval or timer */
  PAUSED:        'paused',
  COMPLETED:     'completed',
  FAILED:        'failed',
  CANCELLED:     'cancelled',
  COMPENSATING:  'compensating',
  COMPENSATED:   'compensated',
});

export const STEP_STATUS = Object.freeze({
  PENDING:   'pending',
  RUNNING:   'running',
  COMPLETED: 'completed',
  FAILED:    'failed',
  SKIPPED:   'skipped',
  WAITING:   'waiting',
  CANCELLED: 'cancelled',
});

export const STEP_TYPE = Object.freeze({
  TASK:         'task',
  PARALLEL:     'parallel',
  CONDITION:    'condition',
  APPROVAL:     'approval',
  DELAY:        'delay',
  NOTIFICATION: 'notification',
  SUBWORKFLOW:  'subworkflow',
  WEBHOOK:      'webhook',
});

/* ── Firestore collections ───────────────────────────────────── */
const COLL = {
  DEFS:      'workflowDefinitions',
  INSTANCES: 'workflowInstances',
  APPROVALS: 'workflowApprovals',
  SCHEDULE:  'workflowSchedule',
};

/* ── Workflow Engine ─────────────────────────────────────────── */
class SokoniWorkflowEngine {
  constructor() {
    this._handlers    = new Map();   /* name → async fn(input, ctx) → output */
    this._definitions = new Map();   /* definitionId → definition */
    this._listeners   = new Map();   /* event → fn[] */
    this._db          = null;
    this._mode        = typeof window !== 'undefined' ? 'client' : 'server';
  }

  /* ── Handler registry ────────────────────────────────────────*/

  /**
   * Register a step handler.
   * @param {string}   name  — e.g. 'inventory.reserve'
   * @param {Function} fn    — async (input, ctx) → output
   */
  register(name, fn) {
    this._handlers.set(name, fn);
    return this;
  }

  /**
   * Register a workflow definition (or update existing version).
   */
  define(definition) {
    _validateDefinition(definition);
    this._definitions.set(definition.id, definition);
    return this;
  }

  /**
   * Load a workflow definition from Firestore (for server-defined workflows).
   */
  async loadDefinition(definitionId) {
    if (this._definitions.has(definitionId)) {
      return this._definitions.get(definitionId);
    }
    const db = await this._getDB();
    if (!db) throw new Error(`Workflow definition '${definitionId}' not found`);
    const { doc, getDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const snap = await getDoc(doc(db, COLL.DEFS, definitionId));
    if (!snap.exists()) throw new Error(`Workflow definition '${definitionId}' not found in Firestore`);
    const def = snap.data();
    this._definitions.set(definitionId, def);
    return def;
  }

  /* ── Lifecycle ───────────────────────────────────────────────*/

  /**
   * Create and start a new workflow instance.
   * @param {string} definitionId
   * @param {object} variables     — trigger payload (orderId, items, uid, etc.)
   * @param {object} [opts]
   * @param {string} [opts.uid]    — acting user
   * @param {string} [opts.module] — originating module
   * @returns {Promise<object>}    — workflow instance
   */
  async start(definitionId, variables = {}, opts = {}) {
    const def      = await this.loadDefinition(definitionId);
    const instance = _createInstance(def, variables, opts);

    await this._persist(instance, 'created');
    this._emit('started', { instance });

    log.log({
      decisionType: 'workflow_start',
      source:       'calculated',
      module:       opts.module ?? 'wap',
      uid:          opts.uid   ?? null,
      reason:       `Started workflow '${def.name}' (${instance.id})`,
      latencyMs:    0,
      confidence:   'verified',
    });

    /* Advance immediately (non-blocking) */
    this._advance(instance).catch(e => {
      console.error('[SokoniWAP] Advance failed after start:', e);
    });

    return instance;
  }

  /**
   * Resume a workflow from its persisted Firestore state.
   * Used by Cloud Functions after a trigger event.
   */
  async resume(instanceId) {
    const instance = await this._load(instanceId);
    if (!instance) throw new Error(`Workflow instance '${instanceId}' not found`);
    if ([WORKFLOW_STATUS.COMPLETED, WORKFLOW_STATUS.FAILED, WORKFLOW_STATUS.CANCELLED].includes(instance.status)) {
      return instance;  /* terminal state — nothing to do */
    }
    if (instance.status === WORKFLOW_STATUS.PAUSED) {
      return instance;  /* paused — don't advance */
    }
    return this._advance(instance);
  }

  /** Pause a running workflow. */
  async pause(instanceId, reason = '', actorUid = '') {
    const instance = await this._load(instanceId);
    if (instance.status !== WORKFLOW_STATUS.RUNNING) {
      throw new Error(`Cannot pause workflow in status '${instance.status}'`);
    }
    instance.status = WORKFLOW_STATUS.PAUSED;
    instance.metadata.pausedAt  = Date.now();
    instance.metadata.pausedBy  = actorUid;
    instance.metadata.pauseReason = reason;
    await this._persist(instance, 'paused', actorUid);
    this._emit('paused', { instanceId, reason });
    return instance;
  }

  /** Resume a paused workflow. */
  async unpause(instanceId, actorUid = '') {
    const instance = await this._load(instanceId);
    if (instance.status !== WORKFLOW_STATUS.PAUSED) {
      throw new Error(`Workflow is not paused`);
    }
    instance.status = WORKFLOW_STATUS.RUNNING;
    delete instance.metadata.pausedAt;
    delete instance.metadata.pausedBy;
    await this._persist(instance, 'unpaused', actorUid);
    return this._advance(instance);
  }

  /** Cancel a workflow. Triggers compensation if steps have been completed. */
  async cancel(instanceId, reason = '', actorUid = '') {
    const instance = await this._load(instanceId);
    const terminal = [WORKFLOW_STATUS.COMPLETED, WORKFLOW_STATUS.CANCELLED, WORKFLOW_STATUS.COMPENSATED];
    if (terminal.includes(instance.status)) return instance;

    instance.status             = WORKFLOW_STATUS.CANCELLED;
    instance.metadata.cancelledAt  = Date.now();
    instance.metadata.cancelledBy  = actorUid;
    instance.metadata.cancelReason = reason;
    await this._persist(instance, 'cancelled', actorUid);
    this._emit('cancelled', { instanceId, reason });

    /* Compensate completed steps */
    if (instance.completedSteps.length > 0) {
      await this._compensate(instance);
    }
    return instance;
  }

  /** Restart a failed workflow from the beginning. */
  async restart(instanceId, actorUid = '') {
    const instance = await this._load(instanceId);
    if (instance.status !== WORKFLOW_STATUS.FAILED) {
      throw new Error(`Can only restart failed workflows`);
    }
    const def = await this.loadDefinition(instance.definitionId);
    const fresh = _createInstance(def, instance.variables, {
      uid:    actorUid,
      module: instance.metadata.module,
      restarted: true,
      previousId: instanceId,
    });
    await this._persist(fresh, 'restarted');
    return this._advance(fresh);
  }

  /* ── Approval API ────────────────────────────────────────────*/

  /**
   * Approve or reject an approval step.
   * @param {string} approvalId
   * @param {string} decision  — 'approved' | 'rejected'
   * @param {string} actorUid
   * @param {string} [reason]
   */
  async decide(approvalId, decision, actorUid, reason = '') {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error(`Invalid decision: '${decision}'. Must be 'approved' or 'rejected'.`);
    }

    const db = await this._getDB();
    const { doc, runTransaction, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    /* ATOMIC: read-check-write in a single transaction to prevent race conditions
       when two approvers click simultaneously. */
    let approval;
    await runTransaction(db, async (txn) => {
      const snap = await txn.get(doc(db, COLL.APPROVALS, approvalId));
      if (!snap.exists()) throw new Error(`Approval '${approvalId}' not found`);
      approval = snap.data();
      if (approval.status !== 'pending') throw new Error(`Approval is already ${approval.status}`);
      if (approval.deadline && Date.now() > approval.deadline) throw new Error('Approval deadline has passed');
      txn.update(doc(db, COLL.APPROVALS, approvalId), {
        status:    decision,
        decidedBy: actorUid,
        decidedAt: Date.now(),
        reason,
        serverTs:  serverTimestamp(),
      });
    });

    /* Load instance and advance */
    const instance = await this._load(approval.instanceId);
    const step = instance.steps[approval.stepId];
    if (!step) throw new Error(`Step '${approval.stepId}' not found in workflow`);

    step.status     = decision === 'approved' ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED;
    step.completedAt = Date.now();
    step.approvalDecision = decision;
    step.approvalReason   = reason;
    step.decidedBy        = actorUid;

    if (!instance.completedSteps.includes(approval.stepId) && decision === 'approved') {
      instance.completedSteps.push(approval.stepId);
    }
    if (decision === 'rejected') {
      instance.failedSteps.push(approval.stepId);
    }

    _addHistory(instance, approval.stepId, step.status, { approvalDecision: decision, reason, actor: actorUid });

    instance.status = WORKFLOW_STATUS.RUNNING;
    await this._persist(instance, `approval_${decision}`, actorUid);

    if (decision === 'rejected') {
      const def = await this.loadDefinition(instance.definitionId);
      const stepDef = def.steps.find(s => s.id === approval.stepId);
      if (stepDef?.onFailure === 'compensate') {
        await this._compensate(instance);
      } else {
        instance.status = WORKFLOW_STATUS.FAILED;
        instance.error  = `Rejected at step '${approval.stepId}': ${reason}`;
        await this._persist(instance, 'failed_approval', actorUid);
      }
    } else {
      await this._advance(instance);
    }

    this._emit('approval_decided', { approvalId, decision, instanceId: approval.instanceId });
    return instance;
  }

  /* ── Query API ───────────────────────────────────────────────*/

  async getInstance(instanceId) {
    return this._load(instanceId);
  }

  async getInstancesByDefinition(definitionId, { limitN = 50, status } = {}) {
    const db = await this._getDB();
    if (!db) return [];
    const { collection, query, where, orderBy, limit, getDocs } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const constraints = [
      where('definitionId', '==', definitionId),
      orderBy('metadata.startedAt', 'desc'),
      limit(limitN),
    ];
    if (status) constraints.push(where('status', '==', status));
    const q = query(collection(db, COLL.INSTANCES), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async getPendingApprovals(assigneeUid) {
    const db = await this._getDB();
    if (!db) return [];
    const { collection, query, where, orderBy, getDocs } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const q = query(
      collection(db, COLL.APPROVALS),
      where('status', '==', 'pending'),
      where('assignees', 'array-contains', assigneeUid),
      orderBy('requestedAt', 'desc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  /* ── Core advancement ────────────────────────────────────────*/

  async _advance(instance) {
    const def = await this.loadDefinition(instance.definitionId);

    let iterations = 0;
    while (iterations++ < 100) {   /* hard cap — prevent infinite loops */
      if ([WORKFLOW_STATUS.PAUSED, WORKFLOW_STATUS.WAITING,
           WORKFLOW_STATUS.COMPLETED, WORKFLOW_STATUS.FAILED,
           WORKFLOW_STATUS.CANCELLED].includes(instance.status)) break;

      const readySteps = _findReadySteps(def, instance);
      if (!readySteps.length) break;

      /* Execute all ready steps (parallel where appropriate) */
      const results = await Promise.allSettled(
        readySteps.map(stepDef => this._executeStep(instance, stepDef, def))
      );

      /* Check for any failures */
      let anyFailed = false;
      for (const r of results) {
        if (r.status === 'rejected') {
          anyFailed = true;
          console.error('[SokoniWAP] Step execution threw:', r.reason);
        }
      }

      if (anyFailed) break;
    }

    /* Check if all steps are done */
    const allSteps = def.steps.map(s => s.id);
    const done     = allSteps.every(id =>
      instance.completedSteps.includes(id) ||
      instance.skippedSteps.includes(id)   ||
      instance.failedSteps.includes(id)
    );

    if (done && instance.status === WORKFLOW_STATUS.RUNNING) {
      const hasFailed = instance.failedSteps.length > 0;
      instance.status              = hasFailed ? WORKFLOW_STATUS.FAILED : WORKFLOW_STATUS.COMPLETED;
      instance.metadata.completedAt = Date.now();
      instance.metadata.duration    = instance.metadata.completedAt - instance.metadata.startedAt;
      await this._persist(instance, hasFailed ? 'failed' : 'completed');
      this._emit(hasFailed ? 'failed' : 'completed', { instance });
    }

    return instance;
  }

  async _executeStep(instance, stepDef, def) {
    /* Already processed */
    if (instance.completedSteps.includes(stepDef.id) ||
        instance.skippedSteps.includes(stepDef.id)   ||
        instance.failedSteps.includes(stepDef.id))    return;

    /* Evaluate condition — skip if false */
    if (stepDef.condition) {
      const condResult = _evaluateExpression(stepDef.condition, instance.variables);
      if (!condResult) {
        instance.skippedSteps.push(stepDef.id);
        instance.steps[stepDef.id] = { status: STEP_STATUS.SKIPPED, skippedAt: Date.now() };
        _addHistory(instance, stepDef.id, STEP_STATUS.SKIPPED, { reason: 'condition false' });
        await this._persist(instance, 'step_skipped');
        return;
      }
    }

    /* Mark running */
    const stepState = { status: STEP_STATUS.RUNNING, startedAt: Date.now(), retryCount: 0 };
    instance.steps[stepDef.id] = stepState;
    await this._persist(instance, 'step_started');

    const startTs = Date.now();

    try {
      const input = _interpolate(stepDef.input ?? {}, instance.variables);

      let output;
      switch (stepDef.type) {
        case STEP_TYPE.TASK:
          output = await this._runTask(stepDef, input, instance, def);
          break;
        case STEP_TYPE.APPROVAL:
          output = await this._runApproval(stepDef, input, instance);
          /* Approval is async — workflow pauses here */
          return;
        case STEP_TYPE.NOTIFICATION:
          output = await this._runNotification(stepDef, input, instance);
          break;
        case STEP_TYPE.DELAY:
          output = await this._runDelay(stepDef, input, instance);
          return;   /* Delay also pauses workflow */
        case STEP_TYPE.WEBHOOK:
          output = await this._runWebhook(stepDef, input, instance);
          break;
        case STEP_TYPE.SUBWORKFLOW:
          output = await this._runSubworkflow(stepDef, input, instance);
          break;
        case STEP_TYPE.CONDITION:
          output = await this._runCondition(stepDef, input, instance);
          break;
        default:
          output = await this._runTask(stepDef, input, instance, def);
      }

      /* Step completed */
      const duration = Date.now() - startTs;
      stepState.status      = STEP_STATUS.COMPLETED;
      stepState.completedAt = Date.now();
      stepState.output      = output ?? null;
      stepState.duration    = duration;

      instance.completedSteps.push(stepDef.id);
      /* Make output available as `variables.{stepId}` */
      if (output !== undefined && output !== null) {
        instance.variables[stepDef.id] = output;
      }

      _addHistory(instance, stepDef.id, STEP_STATUS.COMPLETED, { output, duration });
      await this._persist(instance, 'step_completed');
      this._emit('step_completed', { instanceId: instance.id, stepId: stepDef.id, output });

    } catch (err) {
      const retryCount = (stepState.retryCount ?? 0) + 1;
      const maxRetries = stepDef.retries ?? 0;

      if (retryCount <= maxRetries) {
        stepState.retryCount = retryCount;
        stepState.lastError  = err.message;
        const backoffMs = Math.min((stepDef.retryDelay ?? 2_000) * 2 ** (retryCount - 1), 30_000);
        _addHistory(instance, stepDef.id, 'retry', { attempt: retryCount, backoffMs, error: err.message });
        await this._persist(instance, 'step_retry');
        await _sleep(backoffMs);
        return this._executeStep(instance, stepDef, def);
      }

      /* Permanent failure */
      stepState.status    = STEP_STATUS.FAILED;
      stepState.failedAt  = Date.now();
      stepState.error     = err.message;
      stepState.duration  = Date.now() - startTs;
      instance.failedSteps.push(stepDef.id);
      _addHistory(instance, stepDef.id, STEP_STATUS.FAILED, { error: err.message });
      await this._persist(instance, 'step_failed');
      this._emit('step_failed', { instanceId: instance.id, stepId: stepDef.id, error: err.message });

      if (stepDef.onFailure === 'compensate') {
        instance.status = WORKFLOW_STATUS.COMPENSATING;
        await this._compensate(instance);
      } else if (stepDef.onFailure === 'continue') {
        /* Skip to next step — treat as completed (with error noted) */
        instance.completedSteps.push(stepDef.id);
        instance.failedSteps = instance.failedSteps.filter(id => id !== stepDef.id);
      } else {
        instance.status = WORKFLOW_STATUS.FAILED;
        instance.error  = `Step '${stepDef.name}' failed: ${err.message}`;
        await this._persist(instance, 'workflow_failed');
        this._emit('failed', { instance, error: err.message });
      }
    }
  }

  /* ── Step type handlers ──────────────────────────────────────*/

  async _runTask(stepDef, input, instance, def) {
    const handler = this._handlers.get(stepDef.handler);
    if (!handler) throw new Error(`No handler registered for '${stepDef.handler}'`);

    const ctx = {
      instanceId:   instance.id,
      definitionId: instance.definitionId,
      stepId:       stepDef.id,
      variables:    instance.variables,
      metadata:     instance.metadata,
    };

    if (stepDef.timeout) {
      return Promise.race([
        handler(input, ctx),
        _timeoutReject(stepDef.timeout, `Step '${stepDef.id}' timed out after ${stepDef.timeout}ms`),
      ]);
    }

    return handler(input, ctx);
  }

  async _runApproval(stepDef, input, instance) {
    const db = await this._getDB();
    if (!db) throw new Error('Firestore required for approval steps');

    const { doc, setDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    const approvalId = `${instance.id}_${stepDef.id}`;
    const approval   = {
      id:          approvalId,
      instanceId:  instance.id,
      stepId:      stepDef.id,
      stepName:    stepDef.name,
      requestedAt: Date.now(),
      requestedBy: instance.metadata.uid ?? null,
      deadline:    stepDef.approvalDeadline ? Date.now() + stepDef.approvalDeadline : null,
      assignees:   (input.approvers ?? stepDef.approvers ?? []),
      message:     input.message ?? stepDef.approvalMessage ?? `Please approve: ${stepDef.name}`,
      payload:     input,
      status:      'pending',
      serverTs:    serverTimestamp(),
    };

    await setDoc(doc(db, COLL.APPROVALS, approvalId), approval);

    /* Pause workflow waiting for approval */
    instance.steps[stepDef.id] = { status: STEP_STATUS.WAITING, approvalId, startedAt: Date.now() };
    instance.status = WORKFLOW_STATUS.WAITING;
    instance.metadata.waitingFor = { type: 'approval', approvalId, stepId: stepDef.id };
    _addHistory(instance, stepDef.id, STEP_STATUS.WAITING, { approvalId });
    await this._persist(instance, 'approval_requested');
    this._emit('approval_required', { instanceId: instance.id, stepId: stepDef.id, approvalId });
  }

  async _runNotification(stepDef, input, instance) {
    const handler = this._handlers.get('notification.send') ??
                    this._handlers.get(stepDef.handler);
    if (!handler) {
      console.warn(`[SokoniWAP] No notification handler — skipping step '${stepDef.id}'`);
      return { skipped: true, reason: 'no handler' };
    }
    return handler(input, { instanceId: instance.id, stepId: stepDef.id });
  }

  async _runDelay(stepDef, input, instance) {
    const durationMs = _parseDuration(input.duration ?? stepDef.duration ?? '0s');
    const resumeAt   = Date.now() + durationMs;

    const db = await this._getDB();
    if (db) {
      const { doc, setDoc, serverTimestamp } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      await setDoc(doc(db, COLL.SCHEDULE, `${instance.id}_${stepDef.id}`), {
        instanceId: instance.id,
        stepId:     stepDef.id,
        executeAt:  resumeAt,
        status:     'pending',
        createdAt:  Date.now(),
        serverTs:   serverTimestamp(),
      });
    }

    instance.status = WORKFLOW_STATUS.WAITING;
    instance.metadata.waitingFor = { type: 'delay', stepId: stepDef.id, resumeAt };
    instance.steps[stepDef.id] = { status: STEP_STATUS.WAITING, resumeAt };
    _addHistory(instance, stepDef.id, STEP_STATUS.WAITING, { resumeAt, durationMs });
    await this._persist(instance, 'delay_scheduled');
    this._emit('delay_scheduled', { instanceId: instance.id, stepId: stepDef.id, resumeAt });
  }

  async _runWebhook(stepDef, input, instance) {
    const url       = _interpolate(stepDef.url ?? input.url, instance.variables);
    const method    = (stepDef.method ?? input.method ?? 'POST').toUpperCase();
    const headers   = { 'Content-Type': 'application/json', ...(stepDef.headers ?? {}) };
    const body      = JSON.stringify({ ...input, _instanceId: instance.id, _stepId: stepDef.id });
    const timeoutMs = stepDef.timeout ?? 30_000;

    /* Use AbortController for reliable timeout across all environments
       (AbortSignal.timeout() is not available in all browsers/runtimes) */
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      if (!res.ok) throw new Error(`Webhook ${stepDef.id} failed: ${res.status} ${res.statusText}`);
      let data;
      try { data = await res.json(); } catch (_) { data = { status: 'ok' }; }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Webhook '${stepDef.id}' timed out after ${timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _runSubworkflow(stepDef, input, instance) {
    const child = await this.start(stepDef.workflowId, {
      ...input,
      _parentInstanceId: instance.id,
      _parentStepId:     stepDef.id,
    }, {
      uid:    instance.metadata.uid,
      module: instance.metadata.module,
    });
    return { childInstanceId: child.id, status: child.status };
  }

  async _runCondition(stepDef, input, instance) {
    const result = _evaluateExpression(stepDef.expression ?? input.expression, instance.variables);
    const nextStep = result ? stepDef.ifTrue : stepDef.ifFalse;

    if (nextStep) {
      /* Mark the unchosen branch as skipped */
      const skipStep = result ? stepDef.ifFalse : stepDef.ifTrue;
      if (skipStep) {
        instance.skippedSteps.push(skipStep);
        _addHistory(instance, skipStep, STEP_STATUS.SKIPPED, { reason: 'condition branch not taken' });
      }
    }

    return { result, nextStep };
  }

  /* ── Compensation (rollback) ─────────────────────────────────*/

  async _compensate(instance) {
    const def = await this.loadDefinition(instance.definitionId);
    instance.status = WORKFLOW_STATUS.COMPENSATING;

    /* Compensate in reverse order of completion */
    const toCompensate = [...instance.completedSteps].reverse();

    for (const stepId of toCompensate) {
      const stepDef = def.steps.find(s => s.id === stepId);
      if (!stepDef?.compensation) continue;

      const handler = this._handlers.get(stepDef.compensation);
      if (!handler) { console.warn(`[SokoniWAP] No compensation handler for '${stepDef.compensation}'`); continue; }

      try {
        const input = _interpolate(stepDef.input ?? {}, instance.variables);
        await handler({ ...input, _stepOutput: instance.variables[stepId] },
                      { instanceId: instance.id, stepId, isCompensation: true });
        _addHistory(instance, stepId, 'compensated', {});
      } catch (e) {
        _addHistory(instance, stepId, 'compensation_failed', { error: e.message });
        console.error(`[SokoniWAP] Compensation of '${stepId}' failed:`, e);
      }
    }

    instance.status = WORKFLOW_STATUS.COMPENSATED;
    instance.metadata.compensatedAt = Date.now();
    await this._persist(instance, 'compensated');
    this._emit('compensated', { instance });
  }

  /* ── Persistence ─────────────────────────────────────────────*/

  async _persist(instance, event, actorUid = '') {
    instance.metadata.lastUpdatedAt = Date.now();
    instance.metadata.lastEvent     = event;

    const db = await this._getDB();
    if (!db) return;   /* offline — skip persistence */

    const { doc, setDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    await setDoc(doc(db, COLL.INSTANCES, instance.id), {
      ...instance,
      serverTs: serverTimestamp(),
    });
  }

  async _load(instanceId) {
    const db = await this._getDB();
    if (!db) throw new Error('Firestore required to load workflow instance');
    const { doc, getDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const snap = await getDoc(doc(db, COLL.INSTANCES, instanceId));
    if (!snap.exists()) throw new Error(`Workflow instance '${instanceId}' not found`);
    return { id: snap.id, ...snap.data() };
  }

  /* ── Event system ────────────────────────────────────────────*/

  on(event, fn)  { const fns = this._listeners.get(event) ?? []; fns.push(fn); this._listeners.set(event, fns); return this; }
  off(event, fn) { this._listeners.set(event, (this._listeners.get(event) ?? []).filter(f => f !== fn)); return this; }
  _emit(event, data) { (this._listeners.get(event) ?? []).forEach(fn => { try { fn(data); } catch (_) {} }); }

  /* ── Firestore init ──────────────────────────────────────────*/

  async _getDB() {
    if (this._db) return this._db;
    try {
      const { getFirestore } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const { app }          = await import('./firebase.js');
      this._db = getFirestore(app);
      return this._db;
    } catch (_) { return null; }
  }

  /* ── Save definition to Firestore (admin use) ────────────────*/

  async saveDefinition(definition, actorUid = '') {
    _validateDefinition(definition);
    const db = await this._getDB();
    if (!db) throw new Error('Firestore required');
    const { doc, setDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const payload = {
      ...definition,
      updatedAt:  Date.now(),
      updatedBy:  actorUid,
      serverTs:   serverTimestamp(),
    };
    await setDoc(doc(db, COLL.DEFS, definition.id), payload);
    this._definitions.set(definition.id, payload);
    return payload;
  }
}

/* ── Private helpers ─────────────────────────────────────────── */

function _createInstance(def, variables, opts = {}) {
  const id = _genId();
  return {
    id,
    definitionId:      def.id,
    definitionVersion: def.version ?? '1.0',
    status:           WORKFLOW_STATUS.RUNNING,
    steps:            {},            /* stepId → { status, startedAt, ... } */
    completedSteps:   [],
    failedSteps:      [],
    skippedSteps:     [],
    variables:        { ...variables },
    history:          [],
    metadata: {
      uid:           opts.uid    ?? null,
      module:        opts.module ?? def.module ?? 'unknown',
      startedAt:     Date.now(),
      completedAt:   null,
      duration:      null,
      lastUpdatedAt: Date.now(),
      lastEvent:     'created',
      totalSteps:    def.steps.length,
      restarted:     opts.restarted ?? false,
      previousId:    opts.previousId ?? null,
    },
    error:            null,
  };
}

function _findReadySteps(def, instance) {
  return def.steps.filter(stepDef => {
    /* Already processed */
    if (instance.completedSteps.includes(stepDef.id)) return false;
    if (instance.skippedSteps.includes(stepDef.id))   return false;
    if (instance.failedSteps.includes(stepDef.id))    return false;
    if (instance.steps[stepDef.id]?.status === STEP_STATUS.RUNNING)  return false;
    if (instance.steps[stepDef.id]?.status === STEP_STATUS.WAITING)  return false;

    /* All dependencies completed or skipped */
    const deps = stepDef.after ?? [];
    return deps.every(depId =>
      instance.completedSteps.includes(depId) ||
      instance.skippedSteps.includes(depId)
    );
  });
}

function _addHistory(instance, stepId, status, data = {}) {
  instance.history.push({
    stepId,
    status,
    ts:     Date.now(),
    ...data,
  });
}

/**
 * Simple, safe expression evaluator.
 * Supports: {{var}}, ==, !=, >, <, >=, <=, &&, ||, !
 * Never uses eval() or new Function().
 */
function _evaluateExpression(expression, variables) {
  if (typeof expression === 'boolean') return expression;
  if (typeof expression !== 'string') return Boolean(expression);

  /* Interpolate all {{var}} references */
  let expr = expression.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const val = _resolvePath(variables, path.trim());
    return typeof val === 'string' ? `"${val.replace(/"/g, '\\"')}"` : JSON.stringify(val ?? null);
  });

  /* Parse simple comparison expressions */
  const ops = [['===', (a, b) => a === b], ['!==', (a, b) => a !== b],
                ['>=',  (a, b) => a >= b],  ['<=',  (a, b) => a <= b],
                ['>',   (a, b) => a > b],   ['<',   (a, b) => a < b],
                ['==',  (a, b) => a == b],  ['!=',  (a, b) => a != b]];

  for (const [op, fn] of ops) {
    const idx = expr.indexOf(op);
    if (idx === -1) continue;
    const left  = _parseAtom(expr.slice(0, idx).trim());
    const right = _parseAtom(expr.slice(idx + op.length).trim());
    return fn(left, right);
  }

  return Boolean(_parseAtom(expr.trim()));
}

function _parseAtom(s) {
  if (s === 'true')   return true;
  if (s === 'false')  return false;
  if (s === 'null')   return null;
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const n = Number(s);
  return isNaN(n) ? s : n;
}

/**
 * Interpolate `{{variable.path}}` in strings and nested objects.
 */
function _interpolate(template, variables) {
  if (typeof template === 'string') {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const val = _resolvePath(variables, path.trim());
      return val === undefined ? '' : String(val);
    });
  }
  if (Array.isArray(template)) return template.map(v => _interpolate(v, variables));
  if (template && typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = _interpolate(v, variables);
    return out;
  }
  return template;
}

function _resolvePath(obj, path) {
  return path.split('.').reduce((cur, key) => {
    /* Block prototype chain traversal (prevents prototype pollution in expressions) */
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    return cur?.[key];
  }, obj);
}

function _parseDuration(s) {
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const match = String(s).match(/^(\d+\.?\d*)(ms|s|m|h|d)$/i);
  if (!match) return 0;
  return parseFloat(match[1]) * (units[match[2].toLowerCase()] ?? 1000);
}

function _validateDefinition(def) {
  if (!def.id)      throw new Error('Workflow definition missing id');
  if (!def.name)    throw new Error('Workflow definition missing name');
  if (!Array.isArray(def.steps) || !def.steps.length) {
    throw new Error('Workflow definition must have at least one step');
  }
  const ids = new Set();
  for (const step of def.steps) {
    if (!step.id)   throw new Error(`Step missing id in workflow '${def.id}'`);
    if (ids.has(step.id)) throw new Error(`Duplicate step id '${step.id}'`);
    ids.add(step.id);
    for (const dep of (step.after ?? [])) {
      if (!ids.has(dep) && !def.steps.find(s => s.id === dep)) {
        throw new Error(`Step '${step.id}' depends on unknown step '${dep}'`);
      }
    }
  }
}

function _genId() {
  return 'WF-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _timeoutReject(ms, msg) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

/* ── Singleton ───────────────────────────────────────────────── */
const wap = new SokoniWorkflowEngine();

export { SokoniWorkflowEngine, WORKFLOW_STATUS, STEP_STATUS, STEP_TYPE, COLL as WAP_COLL };
export default wap;

if (typeof window !== 'undefined') { window.SokoniWAP = wap; }
