'use strict';

const { onCall }     = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');

if (!getApps().length) initializeApp();
const db = getFirestore();

const REGION = 'us-central1';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function _admin(req) {
  if (!req.auth || (!req.auth.token.admin && !req.auth.token.superAdmin)) {
    throw new Error('PERMISSION_DENIED: admin or superAdmin token required');
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_COMPONENTS = new Set([
  'hosting',
  'functions',
  'rules',
  'indexes',
  'serviceWorker',
  'config',
]);

const VALID_STATUSES = new Set([
  'initiated',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]);

const CONFIRM_TEXT     = 'CONFIRM ROLLBACK';
const SNAPSHOT_LIMIT   = 20;
const SNAPSHOT_MAX_AGE = 30; // days

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function _validateComponents(components) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('INVALID_ARGUMENT: components must be a non-empty array');
  }
  for (const c of components) {
    if (!VALID_COMPONENTS.has(c)) {
      throw new Error(
        `INVALID_ARGUMENT: unknown component "${c}". ` +
        `Valid: ${[...VALID_COMPONENTS].join(', ')}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 1. rollbackGetSnapshots
// ---------------------------------------------------------------------------

exports.rollbackGetSnapshots = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    _admin(req);

    const snap = await db.collection('rollbackSnapshots')
      .orderBy('createdAt', 'desc')
      .limit(SNAPSHOT_LIMIT)
      .get();

    const snapshots = [];
    snap.forEach((doc) => snapshots.push({ snapshotId: doc.id, ...doc.data() }));
    return { snapshots };
  }
);

// ---------------------------------------------------------------------------
// 2. rollbackCreateSnapshot
// ---------------------------------------------------------------------------

exports.rollbackCreateSnapshot = onCall(
  { region: REGION, timeoutSeconds: 60 },
  async (req) => {
    _admin(req);

    const { label, components, notes } = req.data || {};

    if (!label || typeof label !== 'string' || !label.trim()) {
      throw new Error('INVALID_ARGUMENT: label is required');
    }
    _validateComponents(components);

    const ref = db.collection('rollbackSnapshots').doc();
    const snapshotId = ref.id;
    const now = Timestamp.now();

    await ref.set({
      snapshotId,
      label:      label.trim(),
      components,
      createdBy:  req.auth.uid,
      createdAt:  now,
      notes:      notes || '',
      status:     'available',
      metadata:   {},
    });

    return { success: true, snapshotId };
  }
);

// ---------------------------------------------------------------------------
// 3. rollbackTrigger
// ---------------------------------------------------------------------------

exports.rollbackTrigger = onCall(
  { region: REGION, timeoutSeconds: 120 },
  async (req) => {
    _admin(req);

    const { snapshotId, components, reason, confirmText } = req.data || {};

    // Anti-accident guard
    if (confirmText !== CONFIRM_TEXT) {
      throw new Error(
        `INVALID_ARGUMENT: confirmText must equal "${CONFIRM_TEXT}" exactly`
      );
    }

    if (!snapshotId) {
      throw new Error('INVALID_ARGUMENT: snapshotId is required');
    }

    _validateComponents(components);

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new Error('INVALID_ARGUMENT: reason is required');
    }

    // Verify snapshot exists and is available
    const snapshotDoc = await db.collection('rollbackSnapshots').doc(snapshotId).get();
    if (!snapshotDoc.exists) {
      throw new Error(`NOT_FOUND: snapshot "${snapshotId}" does not exist`);
    }
    if (snapshotDoc.data().status !== 'available') {
      throw new Error(
        `FAILED_PRECONDITION: snapshot "${snapshotId}" is not in "available" status`
      );
    }

    const now = Timestamp.now();
    const ref = db.collection('rollbackExecutions').doc();
    const executionId = ref.id;

    await ref.set({
      executionId,
      snapshotId,
      components,
      triggeredBy: req.auth.uid,
      triggeredAt: now,
      reason:      reason.trim(),
      status:      'initiated',
      auditLog: [
        { ts: now, event: 'initiated', by: req.auth.uid },
      ],
    });

    return {
      success: true,
      executionId,
      message:
        'Rollback record created. ' +
        'Perform the actual rollback via Firebase Console or gcloud CLI: ' +
        '`firebase hosting:rollback` / `firebase deploy --only functions` / ' +
        '`gcloud functions deploy ...`. ' +
        'Once complete, call rollbackUpdateStatus with status "completed".',
      instructions: {
        hosting:       'firebase hosting:rollback --site <SITE_ID>',
        functions:     'firebase deploy --only functions',
        rules:         'firebase deploy --only firestore:rules,storage',
        indexes:       'firebase deploy --only firestore:indexes',
        serviceWorker: 'Redeploy hosting after restoring /service-worker.js',
        config:        'Update sokoni-config.js and redeploy hosting',
      },
    };
  }
);

// ---------------------------------------------------------------------------
// 4. rollbackGetExecutions
// ---------------------------------------------------------------------------

exports.rollbackGetExecutions = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    _admin(req);

    const snap = await db.collection('rollbackExecutions')
      .orderBy('triggeredAt', 'desc')
      .limit(20)
      .get();

    const executions = [];
    snap.forEach((doc) => executions.push({ executionId: doc.id, ...doc.data() }));
    return { executions };
  }
);

// ---------------------------------------------------------------------------
// 5. rollbackUpdateStatus
// ---------------------------------------------------------------------------

exports.rollbackUpdateStatus = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (req) => {
    _admin(req);

    const { executionId, status, notes } = req.data || {};

    if (!executionId) {
      throw new Error('INVALID_ARGUMENT: executionId is required');
    }
    if (!VALID_STATUSES.has(status)) {
      throw new Error(
        `INVALID_ARGUMENT: status must be one of: ${[...VALID_STATUSES].join(', ')}`
      );
    }

    const ref  = db.collection('rollbackExecutions').doc(executionId);
    const doc  = await ref.get();
    if (!doc.exists) {
      throw new Error(`NOT_FOUND: execution "${executionId}" does not exist`);
    }

    const now        = Timestamp.now();
    const currentLog = doc.data().auditLog || [];

    await ref.update({
      status,
      updatedAt: now,
      auditLog: [
        ...currentLog,
        { ts: now, event: status, by: req.auth.uid, notes: notes || '' },
      ],
    });

    return { success: true, executionId, status };
  }
);

// ---------------------------------------------------------------------------
// 6. rollbackScheduledSnapshot — daily at 00:00 UTC
// ---------------------------------------------------------------------------

exports.rollbackScheduledSnapshot = onSchedule(
  { schedule: '0 0 * * *', region: REGION, timeoutSeconds: 60 },
  async () => {
    const now  = Timestamp.now();
    const date = now.toDate().toISOString().split('T')[0]; // YYYY-MM-DD

    // Create daily snapshot record
    const ref = db.collection('rollbackSnapshots').doc();
    await ref.set({
      snapshotId: ref.id,
      label:      `Daily Auto-Snapshot — ${date}`,
      components: ['hosting', 'functions', 'rules', 'indexes', 'serviceWorker'],
      createdBy:  'system',
      createdAt:  now,
      notes:      'Automatically created by rollbackScheduledSnapshot',
      status:     'available',
      metadata:   { autoSnapshot: true },
    });

    console.info(`[rollbackScheduledSnapshot] Created daily snapshot for ${date}`);

    // Purge snapshots older than SNAPSHOT_MAX_AGE days
    const cutoff = Timestamp.fromDate(
      new Date(Date.now() - SNAPSHOT_MAX_AGE * 86_400_000)
    );

    const oldSnaps = await db.collection('rollbackSnapshots')
      .where('createdAt', '<', cutoff)
      .where('createdBy', '==', 'system') // only purge auto-snapshots
      .orderBy('createdAt', 'asc')
      .get();

    if (!oldSnaps.empty) {
      const batch = db.batch();
      oldSnaps.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      console.info(
        `[rollbackScheduledSnapshot] Purged ${oldSnaps.size} auto-snapshot(s) older than ${SNAPSHOT_MAX_AGE} days`
      );
    }
  }
);
