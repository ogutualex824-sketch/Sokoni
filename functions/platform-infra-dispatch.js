'use strict';
/**
 * SOKONI Platform Infrastructure Dispatcher
 * 28 onCall CFs (obs 7 + rel 7 + webhook 7 + tq 5 + gateway 2) → 1 Cloud Run service.
 * Scheduled + onRequest exports remain individual in index.js.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const REGION = 'us-central1';

const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  timeoutSeconds:  120,
  memory:          '512MiB',
};

// Lazy-load modules to avoid cold-start penalty for unused subsystems
let _obs, _rel, _wh, _tq, _gw;
function _obsH()  { return _obs || (_obs = require('./observability-engine')._h); }
function _relH()  { return _rel || (_rel = require('./reliability-engine')._h); }
function _whH()   { return _wh  || (_wh  = require('./webhook-engine')._h); }
function _tqH()   { return _tq  || (_tq  = require('./task-queue')._h); }
function _gwH()   { return _gw  || (_gw  = require('./api-gateway')._h); }

// Route map: op → handler loader
const ROUTES = {
  // Observability
  obsIngestTelemetry:      () => _obsH().obsIngestTelemetry,
  obsGetErrorReport:       () => _obsH().obsGetErrorReport,
  obsGetPerformanceReport: () => _obsH().obsGetPerformanceReport,
  obsGetRealTimeMetrics:   () => _obsH().obsGetRealTimeMetrics,
  obsGetAuditLog:          () => _obsH().obsGetAuditLog,
  obsCreateAlert:          () => _obsH().obsCreateAlert,
  obsDistributedTrace:     () => _obsH().obsDistributedTrace,
  // Reliability
  relEnqueueTask:          () => _relH().relEnqueueTask,
  relGetDeadLetterQueue:   () => _relH().relGetDeadLetterQueue,
  relRetryDeadLetter:      () => _relH().relRetryDeadLetter,
  relPurgeDeadLetter:      () => _relH().relPurgeDeadLetter,
  relCircuitBreakerState:  () => _relH().relCircuitBreakerState,
  relHealthProbeAll:       () => _relH().relHealthProbeAll,
  relGetSystemMetrics:     () => _relH().relGetSystemMetrics,
  // Webhooks
  webhookRegister:         () => _whH().webhookRegister,
  webhookList:             () => _whH().webhookList,
  webhookDelete:           () => _whH().webhookDelete,
  webhookDeliver:          () => _whH().webhookDeliver,
  webhookGetDeliveries:    () => _whH().webhookGetDeliveries,
  webhookTestEndpoint:     () => _whH().webhookTestEndpoint,
  webhookGetStats:         () => _whH().webhookGetStats,
  // Task Queue
  tqEnqueue:               () => _tqH().tqEnqueue,
  tqGetStatus:             () => _tqH().tqGetStatus,
  tqCancelTask:            () => _tqH().tqCancelTask,
  tqGetQueueStats:         () => _tqH().tqGetQueueStats,
  tqBulkEnqueue:           () => _tqH().tqBulkEnqueue,
  // API Gateway admin
  gwGetMetrics:            () => _gwH().gwGetMetrics,
  gwManageRateLimit:       () => _gwH().gwManageRateLimit,
};

const VALID_OPS = Object.keys(ROUTES).sort().join(', ');

exports.platformInfraDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', `"op" field is required. Valid ops: ${VALID_OPS}`);
  }
  const loader = ROUTES[op];
  if (!loader) {
    throw new HttpsError('not-found', `Unknown op: "${op}". Valid ops: ${VALID_OPS}`);
  }
  const handler = loader();
  if (!handler) {
    throw new HttpsError('internal', `Handler for "${op}" is not available — check _h export in source module.`);
  }
  return handler(req);
});
