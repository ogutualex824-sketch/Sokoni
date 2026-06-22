/* ================================================================
   SOKONI ENTERPRISE CONTROL CENTER — Cloud Functions
   v1.0.0

   eccHealthCheck     — scheduled every 5 min: writes eccSystemHealth
   eccAlertCheck      — Firestore trigger: fires alerts on threshold breach
   eccCreateIncident  — callable: create incident with audit trail
   eccResolveIncident — callable: resolve incident, calculate MTTR
   eccGetMetrics      — callable: aggregate dashboard KPIs server-side
   eccWriteAudit      — callable: write to immutable audit log (server timestamp)
   eccGetAuditLog     — callable: query audit log with RBAC
================================================================ */

const { onCall, HttpsError }     = require("firebase-functions/v2/https");
const { onSchedule }             = require("firebase-functions/v2/scheduler");
const { onDocumentCreated }      = require("firebase-functions/v2/firestore");
const admin                      = require("firebase-admin");

// admin.initializeApp() is called in index.js — do not call again
const db = () => admin.firestore();

/* ── ECC Roles ────────────────────────────────────────────────── */
const ECC_ROLES = new Set([
  'super_admin','ops_admin','finance_admin','support_admin',
  'security_admin','marketplace_admin','inventory_admin',
  'logistics_admin','merchant_admin','read_only',
]);

const ACTION_PERMS = {
  create_incident:  ['super_admin','ops_admin','security_admin','support_admin'],
  resolve_incident: ['super_admin','ops_admin','security_admin'],
  write_audit:      ['super_admin','ops_admin','finance_admin','security_admin','support_admin'],
  get_metrics:      ['super_admin','ops_admin','finance_admin','logistics_admin','marketplace_admin','inventory_admin','merchant_admin'],
  get_audit:        ['super_admin','ops_admin','finance_admin','security_admin'],
};

function _assertRole(auth, action) {
  if (!auth?.token) throw new HttpsError('unauthenticated', 'Sign in required');
  const role = auth.token.eccRole || auth.token.role || 'read_only';
  if (!ECC_ROLES.has(role)) throw new HttpsError('permission-denied', 'Not an ECC user');
  const allowed = ACTION_PERMS[action] || [];
  if (!allowed.includes(role) && role !== 'super_admin')
    throw new HttpsError('permission-denied', `Role '${role}' cannot perform '${action}'`);
  return role;
}

/* ── Service definitions for health checks ───────────────────── */
const SERVICES = [
  { id: 'firestore',  name: 'Firestore',         check: _checkFirestore },
  { id: 'auth',       name: 'Authentication',    check: _checkAuth },
  { id: 'payments',   name: 'Payments',          check: _checkPayments },
  { id: 'orders',     name: 'Order Pipeline',    check: _checkOrders },
  { id: 'deliveries', name: 'Delivery Engine',   check: _checkDeliveries },
  { id: 'wap',        name: 'WAP Engine',        check: _checkWAP },
  { id: 'search',     name: 'Search',            check: _checkSearch },
  { id: 'notifications',name:'Notifications',    check: _checkNotifications },
];

/* ── eccHealthCheck — every 30 minutes ───────────────────────── */
exports.eccHealthCheck = onSchedule(
  { schedule: 'every 30 minutes', maxInstances: 1, timeoutSeconds: 120 },
  async () => {
    const results = await Promise.allSettled(
      SERVICES.map(async svc => {
        const start = Date.now();
        try {
          const status = await svc.check();
          return { id: svc.id, name: svc.name, status, latencyMs: Date.now() - start, checkedAt: Date.now() };
        } catch (e) {
          return { id: svc.id, name: svc.name, status: 'major_outage', error: e.message, latencyMs: Date.now() - start, checkedAt: Date.now() };
        }
      })
    );

    const batch = db().batch();
    let outageCount = 0;

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const h = r.value;
      batch.set(db().collection('eccSystemHealth').doc(h.id), h, { merge: true });
      if (h.status === 'major_outage') outageCount++;
    }
    await batch.commit();

    // Auto-create incident on multi-service outage
    if (outageCount >= 2) {
      const existing = await db().collection('eccIncidents')
        .where('status', 'in', ['open', 'investigating'])
        .where('createdBy', '==', 'system_health_check')
        .limit(1).get();
      if (existing.empty) {
        const incId = 'INC-' + Date.now().toString(36).toUpperCase();
        await db().collection('eccIncidents').add({
          id: incId,
          title: `Multi-service outage: ${outageCount} services down`,
          severity: 'critical',
          status: 'open',
          affectedServices: results.filter(r => r.status === 'fulfilled' && r.value.status === 'major_outage').map(r => r.value.id),
          createdBy: 'system_health_check',
          createdAt: Date.now(),
          timeline: [{ ts: Date.now(), event: 'created', by: 'system', note: 'Auto-created by health check' }],
        });
      }
    }
  }
);

/* ── Health check implementations ────────────────────────────── */
async function _checkFirestore() {
  await db().collection('eccSystemHealth').limit(1).get();
  return 'operational';
}
async function _checkAuth() {
  await admin.auth().listUsers(1);
  return 'operational';
}
async function _checkPayments() {
  const snap = await db().collection('paymentAuthorizations')
    .where('status', '==', 'failed')
    .where('createdAt', '>=', Date.now() - 300000)
    .limit(50).get();
  if (snap.size > 20) return 'degraded';
  return 'operational';
}
async function _checkOrders() {
  const snap = await db().collection('orders')
    .where('status', '==', 'failed')
    .where('createdAt', '>=', Date.now() - 300000)
    .limit(20).get();
  if (snap.size > 10) return 'degraded';
  return 'operational';
}
async function _checkDeliveries() {
  await db().collection('deliveries').limit(1).get();
  return 'operational';
}
async function _checkWAP() {
  const snap = await db().collection('workflowInstances')
    .where('status', '==', 'failed')
    .where('metadata.startedAt', '>=', Date.now() - 300000)
    .limit(20).get();
  if (snap.size > 10) return 'degraded';
  return 'operational';
}
async function _checkSearch() {
  const snap = await db().collection('typesenseQueue').limit(1).get();
  return 'operational';
}
async function _checkNotifications() {
  const snap = await db().collection('notifications')
    .where('status', '==', 'failed')
    .where('createdAt', '>=', Date.now() - 300000)
    .limit(50).get();
  if (snap.size > 30) return 'degraded';
  return 'operational';
}

/* ── eccAlertCheck — triggered on new security events ────────── */
exports.eccAlertCheck = onDocumentCreated(
  { document: 'securityEvents/{eventId}', maxInstances: 20 },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    const sev = data.severity || 'medium';
    if (!['critical', 'high'].includes(sev)) return;

    await db().collection('eccAlerts').add({
      title:     `Security: ${data.eventType || 'Unknown event'}`,
      message:   data.details || `Severity: ${sev}`,
      severity:  sev,
      category:  'security',
      data:      { eventType: data.eventType, ip: data.ip },
      status:    'active',
      createdAt: Date.now(),
      createdBy: 'system',
    });
  }
);

/* ── eccGetMetrics — dashboard KPI aggregation ───────────────── */
exports.eccGetMetrics = onCall(
  { maxInstances: 50, timeoutSeconds: 30 },
  async (req) => {
    _assertRole(req.auth, 'get_metrics');
    const today = _startOfDay();

    const [
      ordersToday, ordersDone, ordersFail, ordersPending,
      driversOnline, activeSellers,
      wfRunning, wfFailed,
      paymentsToday, paymentsFail,
      incidentsOpen, alertsActive,
    ] = await Promise.allSettled([
      db().collection('orders').where('createdAt','>=',today).count().get(),
      db().collection('orders').where('status','==','delivered').where('createdAt','>=',today).count().get(),
      db().collection('orders').where('status','==','failed').where('createdAt','>=',today).count().get(),
      db().collection('orders').where('status','in',['pending','confirmed','in_transit']).count().get(),
      db().collection('driverLocations').where('online','==',true).count().get(),
      db().collection('users').where('role','==','seller').where('active','==',true).count().get(),
      db().collection('workflowInstances').where('status','==','running').count().get(),
      db().collection('workflowInstances').where('status','==','failed').where('metadata.startedAt','>=',today).count().get(),
      db().collection('paymentAuthorizations').where('status','==','captured').where('createdAt','>=',today).get(),
      db().collection('paymentAuthorizations').where('status','==','failed').where('createdAt','>=',today).count().get(),
      db().collection('eccIncidents').where('status','!=','resolved').count().get(),
      db().collection('eccAlerts').where('status','==','active').count().get(),
    ]);

    const c = r => r.status === 'fulfilled' ? (r.value?.data?.().count ?? r.value?.size ?? 0) : 0;
    const revenue = paymentsToday.status === 'fulfilled'
      ? paymentsToday.value.docs.reduce((s, d) => s + (d.data().amount || 0), 0) : 0;

    return {
      ordersToday:     c(ordersToday),
      ordersCompleted: c(ordersDone),
      ordersFailed:    c(ordersFail),
      ordersPending:   c(ordersPending),
      revenueToday:    revenue,
      paymentsFailed:  c(paymentsFail),
      driversOnline:   c(driversOnline),
      activeSellers:   c(activeSellers),
      wfRunning:       c(wfRunning),
      wfFailed:        c(wfFailed),
      incidentsOpen:   c(incidentsOpen),
      alertsActive:    c(alertsActive),
      generatedAt:     Date.now(),
    };
  }
);

/* ── eccCreateIncident ────────────────────────────────────────── */
exports.eccCreateIncident = onCall(
  { maxInstances: 20 },
  async (req) => {
    const role = _assertRole(req.auth, 'create_incident');
    const { title, description, severity, affectedServices = [] } = req.data;
    if (!title?.trim()) throw new HttpsError('invalid-argument', 'Title required');
    const incId = 'INC-' + Date.now().toString(36).toUpperCase();
    const ref = await db().collection('eccIncidents').add({
      id: incId, title: title.trim(), description: description || '',
      severity: severity || 'medium', affectedServices,
      status: 'open', assignee: req.auth.uid,
      timeline: [{ ts: Date.now(), event: 'created', by: req.auth.uid, note: 'Created via ECC' }],
      createdAt: Date.now(), createdBy: req.auth.uid,
    });
    await _writeAuditInternal(req.auth.uid, role, 'incident_created', { incId, title, severity });
    return { incidentId: incId, docId: ref.id };
  }
);

/* ── eccResolveIncident ───────────────────────────────────────── */
exports.eccResolveIncident = onCall(
  { maxInstances: 20 },
  async (req) => {
    const role = _assertRole(req.auth, 'resolve_incident');
    const { docId, resolution = '', postmortem = '' } = req.data;
    if (!docId) throw new HttpsError('invalid-argument', 'docId required');
    const ref  = db().collection('eccIncidents').doc(docId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Incident not found');
    const data = snap.data();
    const mttr = data.createdAt ? Date.now() - data.createdAt : null;
    await ref.update({
      status: 'resolved', resolvedAt: Date.now(), resolvedBy: req.auth.uid,
      resolution, postmortem, mttr,
      timeline: admin.firestore.FieldValue.arrayUnion({
        ts: Date.now(), event: 'resolved', by: req.auth.uid, note: resolution,
      }),
    });
    await _writeAuditInternal(req.auth.uid, role, 'incident_resolved', { docId, resolution, mttrMs: mttr });
    return { resolved: true, mttrMs: mttr };
  }
);

/* ── eccWriteAudit — immutable audit entry ────────────────────── */
exports.eccWriteAudit = onCall(
  { maxInstances: 50 },
  async (req) => {
    _assertRole(req.auth, 'write_audit');
    const { action, details = {}, before = null, after = null } = req.data;
    if (!action) throw new HttpsError('invalid-argument', 'action required');
    const role = req.auth.token.eccRole || req.auth.token.role || 'unknown';
    await _writeAuditInternal(req.auth.uid, role, action, details, before, after);
    return { written: true };
  }
);

/* ── eccGetAuditLog ───────────────────────────────────────────── */
exports.eccGetAuditLog = onCall(
  { maxInstances: 20, timeoutSeconds: 30 },
  async (req) => {
    _assertRole(req.auth, 'get_audit');
    const { action, actorUid, limitN = 100, sinceTs } = req.data || {};
    let q = db().collection('eccAuditLog').orderBy('ts', 'desc').limit(Math.min(limitN, 500));
    if (action)   q = q.where('action',   '==', action);
    if (actorUid) q = q.where('actorUid', '==', actorUid);
    if (sinceTs)  q = q.where('ts',       '>=', sinceTs);
    const snap = await q.get();
    return { entries: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  }
);

/* ── Internal helpers ─────────────────────────────────────────── */
async function _writeAuditInternal(uid, role, action, details = {}, before = null, after = null) {
  await db().collection('eccAuditLog').add({
    action, details: _stripPII(details),
    before: before ? _stripPII(before) : null,
    after:  after  ? _stripPII(after)  : null,
    actorUid:  uid,
    actorRole: role,
    ts:        Date.now(),
    serverTs:  admin.firestore.FieldValue.serverTimestamp(),
  });
}

const PII = new Set(['phone','email','password','pin','token','secret','name','idNumber']);
function _stripPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = PII.has(k) ? '[REDACTED]' : v;
  return out;
}

function _startOfDay() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
}
