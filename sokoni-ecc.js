/* ================================================================
   SOKONI ENTERPRISE CONTROL CENTER
   Engine  v1.0.0

   The operational brain behind ecc.html.
   Manages permissions, real-time listeners, alerts, incidents,
   system health, and the immutable audit trail.

   Sections:
     overview         — Executive KPIs and revenue
     live_ops         — Real-time orders, deliveries, events
     geo_command      — GIP fleet map and heat maps
     intelligence     — EIP forecasts and fraud alerts
     workflows        — WAP monitoring and approvals
     payments         — Payment health and reconciliation
     inventory        — Stock levels and warehouse
     smartpos         — POS device and transaction monitoring
     search           — Search health and analytics
     notifications    — Notification delivery health
     security         — Threat monitoring and fraud
     system_health    — All service health checks
     incidents        — Incident creation and resolution
     support          — Customer support queue
     audit            — Immutable audit trail

   Exposes: window.SokoniECC + ES default export
================================================================ */

import log   from './sokoni-intelligence-log.js';
import flags from './sokoni-feature-flags.js';

/* ── ECC Role Permissions ────────────────────────────────────── */
export const ECC_ROLES = Object.freeze({
  SUPER_ADMIN:      'super_admin',
  OPS_ADMIN:        'ops_admin',
  FINANCE_ADMIN:    'finance_admin',
  SUPPORT_ADMIN:    'support_admin',
  SECURITY_ADMIN:   'security_admin',
  MARKETPLACE_ADMIN:'marketplace_admin',
  INVENTORY_ADMIN:  'inventory_admin',
  LOGISTICS_ADMIN:  'logistics_admin',
  MERCHANT_ADMIN:   'merchant_admin',
  READ_ONLY:        'read_only',
});

const PERMISSIONS = {
  super_admin:       ['*'],
  ops_admin:         ['overview','live_ops','geo_command','workflows','system_health','incidents','audit'],
  finance_admin:     ['overview','payments','audit'],
  support_admin:     ['support','incidents','audit'],
  security_admin:    ['security','audit','incidents','system_health'],
  marketplace_admin: ['overview','live_ops','inventory','search','notifications'],
  inventory_admin:   ['inventory','overview'],
  logistics_admin:   ['live_ops','geo_command','overview'],
  merchant_admin:    ['smartpos','payments','overview'],
  read_only:         ['overview'],
};

/* ── Alert Severity ──────────────────────────────────────────── */
export const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
  INFO:     'info',
});

/* ── Incident Status ─────────────────────────────────────────── */
export const INCIDENT_STATUS = Object.freeze({
  OPEN:        'open',
  INVESTIGATING:'investigating',
  IDENTIFIED:  'identified',
  MONITORING:  'monitoring',
  RESOLVED:    'resolved',
  POSTMORTEM:  'postmortem',
});

/* ── Service Health Status ───────────────────────────────────── */
export const HEALTH = Object.freeze({
  OPERATIONAL:  'operational',
  DEGRADED:     'degraded',
  PARTIAL:      'partial_outage',
  OUTAGE:       'major_outage',
  MAINTENANCE:  'maintenance',
  UNKNOWN:      'unknown',
});

/* ── Alert threshold defaults ────────────────────────────────── */
const DEFAULT_THRESHOLDS = {
  payment_failure_rate:      0.05,   /* 5% failure rate → alert */
  order_failure_rate:        0.10,
  driver_offline_pct:        0.30,   /* 30% of drivers offline → alert */
  inventory_stockout_count:  10,     /* 10 stockouts → alert */
  workflow_failure_rate:     0.15,
  api_error_rate:            0.05,
  api_p95_latency_ms:     5_000,
  fraud_score_threshold:     0.80,
  login_failures_per_min:   20,
};

/* ── ECC Engine ──────────────────────────────────────────────── */
class ECCEngine {
  constructor() {
    this._db           = null;
    this._auth         = null;
    this._user         = null;
    this._role         = null;
    this._listeners    = [];           /* [{ id, unsub }] */
    this._alerts       = new Map();    /* alertId → alert */
    this._incidents    = new Map();    /* incidentId → incident */
    this._health       = new Map();    /* serviceId → health */
    this._metrics      = {};           /* cached dashboard metrics */
    this._thresholds   = { ...DEFAULT_THRESHOLDS };
    this._callbacks    = new Map();    /* event → fn[] */
    this._alertCount   = 0;
    this._ready        = false;
  }

  /* ── Init ────────────────────────────────────────────────── */

  async init(user) {
    this._user = user;
    this._role = user?.customClaims?.eccRole ?? user?.customClaims?.role ?? ECC_ROLES.READ_ONLY;

    this._db = await this._getDB();

    /* Load thresholds from Firestore */
    try {
      const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const snap = await getDoc(doc(this._db, 'eccConfig', 'thresholds'));
      if (snap.exists()) Object.assign(this._thresholds, snap.data());
    } catch (_) {}

    /* Subscribe to active alerts */
    this._subscribeAlerts();
    /* Subscribe to system health */
    this._subscribeHealth();
    /* Subscribe to active incidents */
    this._subscribeIncidents();

    this._ready = true;
    this._emit('ready', { role: this._role });
    return this;
  }

  /* ── Permission checking ─────────────────────────────────── */

  can(section) {
    if (!this._role) return false;
    const perms = PERMISSIONS[this._role] ?? [];
    return perms.includes('*') || perms.includes(section);
  }

  canAction(action) {
    if (this._role === ECC_ROLES.SUPER_ADMIN) return true;
    if (this._role === ECC_ROLES.READ_ONLY)   return false;
    const actionPerms = {
      create_incident:  ['super_admin','ops_admin','security_admin','support_admin'],
      resolve_incident: ['super_admin','ops_admin','security_admin'],
      cancel_workflow:  ['super_admin','ops_admin'],
      approve_workflow: ['super_admin','ops_admin','finance_admin'],
      void_payment:     ['super_admin','finance_admin'],
      ban_user:         ['super_admin','security_admin'],
      send_alert:       ['super_admin','ops_admin','security_admin'],
      export_data:      ['super_admin','finance_admin','ops_admin'],
    };
    return (actionPerms[action] ?? []).includes(this._role);
  }

  /* ── Listener management ─────────────────────────────────── */

  addListener(id, unsub) {
    /* Replace existing listener with same id */
    this.removeListener(id);
    this._listeners.push({ id, unsub });
    return this;
  }

  removeListener(id) {
    const idx = this._listeners.findIndex(l => l.id === id);
    if (idx !== -1) {
      try { this._listeners[idx].unsub(); } catch (_) {}
      this._listeners.splice(idx, 1);
    }
    return this;
  }

  clearSectionListeners(section) {
    const toRemove = this._listeners.filter(l => l.id.startsWith(section + ':'));
    toRemove.forEach(l => { try { l.unsub(); } catch (_) {} });
    this._listeners = this._listeners.filter(l => !l.id.startsWith(section + ':'));
    return this;
  }

  clearAllListeners() {
    this._listeners.forEach(l => { try { l.unsub(); } catch (_) {} });
    this._listeners = [];
    return this;
  }

  /* ── Dashboard metrics ───────────────────────────────────── */

  /**
   * Load executive KPI metrics.
   * Uses Firestore aggregate (count) queries to minimise reads.
   */
  async loadMetrics() {
    if (!this._db) return {};
    const { collection, query, where, getCountFromServer, getDocs, orderBy, limit } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    const today     = _startOfDay(new Date());
    const weekStart = _startOfDay(new Date(Date.now() - 7 * 86_400_000));
    const monthStart = _startOfDay(new Date(Date.now() - 30 * 86_400_000));

    /* Parallel fetch — minimise latency */
    const [
      ordersToday, ordersCompleted, ordersFailed, ordersPending,
      paymentsToday, paymentsFailed,
      activeDrivers, activeSellers, activeBuyers,
      workflowsRunning, workflowsFailed,
      incidentsOpen, alertsActive,
    ] = await Promise.allSettled([
      getCountFromServer(query(collection(this._db, 'orders'), where('createdAt', '>=', today.getTime()))),
      getCountFromServer(query(collection(this._db, 'orders'), where('status', '==', 'delivered'), where('createdAt', '>=', today.getTime()))),
      getCountFromServer(query(collection(this._db, 'orders'), where('status', '==', 'failed'), where('createdAt', '>=', today.getTime()))),
      getCountFromServer(query(collection(this._db, 'orders'), where('status', 'in', ['pending','confirmed','in_transit']))),
      getDocs(query(collection(this._db, 'paymentAuthorizations'), where('status', '==', 'captured'), where('createdAt', '>=', today.getTime()), limit(1000))),
      getCountFromServer(query(collection(this._db, 'paymentAuthorizations'), where('status', '==', 'failed'), where('createdAt', '>=', today.getTime()))),
      getCountFromServer(query(collection(this._db, 'driverLocations'), where('online', '==', true))),
      getCountFromServer(query(collection(this._db, 'users'), where('role', '==', 'seller'), where('active', '==', true))),
      getCountFromServer(query(collection(this._db, 'users'), where('lastSeenAt', '>=', today.getTime()))),
      getCountFromServer(query(collection(this._db, 'workflowInstances'), where('status', '==', 'running'))),
      getCountFromServer(query(collection(this._db, 'workflowInstances'), where('status', '==', 'failed'), where('metadata.startedAt', '>=', today.getTime()))),
      getCountFromServer(query(collection(this._db, 'eccIncidents'), where('status', '!=', 'resolved'))),
      getCountFromServer(query(collection(this._db, 'eccAlerts'), where('status', '==', 'active'))),
    ]);

    /* Sum revenue */
    const revenueToday = paymentsToday.status === 'fulfilled'
      ? paymentsToday.value.docs.reduce((s, d) => s + (d.data().amount ?? 0), 0) : 0;

    const metrics = {
      ordersToday:       _count(ordersToday),
      ordersCompleted:   _count(ordersCompleted),
      ordersFailed:      _count(ordersFailed),
      ordersPending:     _count(ordersPending),
      revenueToday:      revenueToday,
      paymentsFailed:    _count(paymentsFailed),
      activeDrivers:     _count(activeDrivers),
      activeSellers:     _count(activeSellers),
      activeBuyers:      _count(activeBuyers),
      workflowsRunning:  _count(workflowsRunning),
      workflowsFailed:   _count(workflowsFailed),
      incidentsOpen:     _count(incidentsOpen),
      alertsActive:      _count(alertsActive),
      loadedAt:          Date.now(),
    };

    this._metrics = metrics;
    this._emit('metrics_loaded', metrics);
    return metrics;
  }

  /* ── Real-time subscriptions ─────────────────────────────── */

  subscribeToSection(section, callback) {
    this.clearSectionListeners(section);

    if (!this._db) return;
    this._sectionSubscribers[section]?.(callback);
  }

  get _sectionSubscribers() {
    return {
      live_ops:   (cb) => this._subscribeOps(cb),
      security:   (cb) => this._subscribeSecurity(cb),
      payments:   (cb) => this._subscribePayments(cb),
      workflows:  (cb) => this._subscribeWorkflows(cb),
      incidents:  (cb) => this._subscribeIncidents(cb),
    };
  }

  async _subscribeOps(callback) {
    const { collection, query, where, orderBy, limit, onSnapshot } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const q = query(collection(this._db, 'orders'), orderBy('createdAt', 'desc'), limit(50));
    const unsub = onSnapshot(q, snap => {
      callback({ type: 'orders', docs: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    });
    this.addListener('live_ops:orders', unsub);
  }

  async _subscribeSecurity(callback) {
    const { collection, query, where, orderBy, limit, onSnapshot } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const q = query(
      collection(this._db, 'securityEvents'),
      where('ts', '>=', Date.now() - 3_600_000),
      orderBy('ts', 'desc'), limit(100)
    );
    const unsub = onSnapshot(q, snap => {
      callback({ type: 'security', docs: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    });
    this.addListener('security:events', unsub);
  }

  async _subscribePayments(callback) {
    const { collection, query, orderBy, limit, onSnapshot } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const q = query(collection(this._db, 'paymentAuthorizations'), orderBy('createdAt', 'desc'), limit(50));
    const unsub = onSnapshot(q, snap => {
      callback({ type: 'payments', docs: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    });
    this.addListener('payments:recent', unsub);
  }

  async _subscribeWorkflows(callback) {
    const { collection, query, where, orderBy, limit, onSnapshot } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const q = query(
      collection(this._db, 'workflowInstances'),
      where('status', 'in', ['running', 'waiting', 'failed']),
      orderBy('metadata.startedAt', 'desc'), limit(50)
    );
    const unsub = onSnapshot(q, snap => {
      callback({ type: 'workflows', docs: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    });
    this.addListener('workflows:active', unsub);
  }

  _subscribeAlerts() {
    if (!this._db) return;
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js').then(({ collection, query, where, orderBy, limit, onSnapshot }) => {
      const q = query(
        collection(this._db, 'eccAlerts'),
        where('status', '==', 'active'),
        orderBy('createdAt', 'desc'), limit(50)
      );
      const unsub = onSnapshot(q, snap => {
        this._alerts.clear();
        snap.docs.forEach(d => this._alerts.set(d.id, { id: d.id, ...d.data() }));
        this._alertCount = this._alerts.size;
        this._emit('alerts_updated', { alerts: Array.from(this._alerts.values()), count: this._alertCount });
      });
      this.addListener('global:alerts', unsub);
    });
  }

  _subscribeHealth() {
    if (!this._db) return;
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js').then(({ collection, onSnapshot }) => {
      const unsub = onSnapshot(collection(this._db, 'eccSystemHealth'), snap => {
        this._health.clear();
        snap.docs.forEach(d => this._health.set(d.id, { id: d.id, ...d.data() }));
        this._emit('health_updated', { health: Object.fromEntries(this._health) });
      });
      this.addListener('global:health', unsub);
    });
  }

  _subscribeIncidents(callback) {
    if (!this._db) return;
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js').then(({ collection, query, where, orderBy, limit, onSnapshot }) => {
      const q = query(
        collection(this._db, 'eccIncidents'),
        where('status', '!=', 'resolved'),
        orderBy('status'), orderBy('createdAt', 'desc'), limit(20)
      );
      const unsub = onSnapshot(q, snap => {
        const incidents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this._incidents.clear();
        incidents.forEach(i => this._incidents.set(i.id, i));
        this._emit('incidents_updated', { incidents });
        if (callback) callback({ type: 'incidents', docs: incidents });
      });
      this.addListener('global:incidents', unsub);
    });
  }

  /* ── Alert management ────────────────────────────────────── */

  async triggerAlert({ title, message, severity, category, data = {} }) {
    if (!this._db) return;
    const { collection, addDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const ref = await addDoc(collection(this._db, 'eccAlerts'), {
      title, message, severity, category,
      data: _stripPII(data),
      status:    'active',
      createdAt: Date.now(),
      createdBy: this._user?.uid ?? 'system',
      serverTs:  serverTimestamp(),
    });
    await this.audit('alert_triggered', { alertId: ref.id, title, severity });
    return ref.id;
  }

  async acknowledgeAlert(alertId, notes = '') {
    if (!this.canAction('send_alert')) throw new Error('Permission denied');
    const { doc, updateDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    await updateDoc(doc(this._db, 'eccAlerts', alertId), {
      status:       'acknowledged',
      acknowledgedBy: this._user?.uid,
      acknowledgedAt: Date.now(),
      notes,
      serverTs:     serverTimestamp(),
    });
    await this.audit('alert_acknowledged', { alertId, notes });
  }

  async resolveAlert(alertId, resolution = '') {
    const { doc, updateDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    await updateDoc(doc(this._db, 'eccAlerts', alertId), {
      status:      'resolved',
      resolvedBy:  this._user?.uid,
      resolvedAt:  Date.now(),
      resolution,
      serverTs:    serverTimestamp(),
    });
    await this.audit('alert_resolved', { alertId, resolution });
  }

  get alerts()      { return Array.from(this._alerts.values()); }
  get alertCount()  { return this._alertCount; }
  get criticalAlerts() { return this.alerts.filter(a => a.severity === SEVERITY.CRITICAL); }

  /* ── Incident management ─────────────────────────────────── */

  async createIncident({ title, description, severity, affectedServices = [], assignee = '' }) {
    if (!this.canAction('create_incident')) throw new Error('Permission denied');
    const { collection, addDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const incidentId = 'INC-' + Date.now().toString(36).toUpperCase();
    const ref = await addDoc(collection(this._db, 'eccIncidents'), {
      id:              incidentId,
      title, description, severity,
      affectedServices,
      assignee:        assignee || this._user?.uid,
      status:          INCIDENT_STATUS.OPEN,
      timeline:        [{ ts: Date.now(), event: 'created', by: this._user?.uid, note: 'Incident created' }],
      createdAt:       Date.now(),
      createdBy:       this._user?.uid,
      resolvedAt:      null,
      mttr:            null,
      serverTs:        serverTimestamp(),
    });
    await this.audit('incident_created', { incidentId, title, severity });
    this._emit('incident_created', { incidentId, title });
    return incidentId;
  }

  async updateIncident(incidentId, status, note = '') {
    if (!this.canAction('create_incident')) throw new Error('Permission denied');
    const { doc, updateDoc, arrayUnion, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const update = {
      status,
      timeline: arrayUnion({ ts: Date.now(), event: status, by: this._user?.uid, note }),
      serverTs: serverTimestamp(),
    };
    if (status === INCIDENT_STATUS.RESOLVED) {
      const incident = this._incidents.get(incidentId);
      update.resolvedAt = Date.now();
      update.mttr       = incident ? Date.now() - incident.createdAt : null;
    }
    await updateDoc(doc(this._db, 'eccIncidents', incidentId), update);
    await this.audit('incident_updated', { incidentId, status, note });
  }

  /* ── System health ───────────────────────────────────────── */

  getHealth(serviceId) {
    return this._health.get(serviceId) ?? { status: HEALTH.UNKNOWN, lastChecked: null };
  }

  getAllHealth() {
    return Object.fromEntries(this._health);
  }

  overallHealthStatus() {
    const statuses = Array.from(this._health.values()).map(h => h.status);
    if (statuses.includes(HEALTH.OUTAGE))     return HEALTH.OUTAGE;
    if (statuses.includes(HEALTH.PARTIAL))    return HEALTH.PARTIAL;
    if (statuses.includes(HEALTH.DEGRADED))   return HEALTH.DEGRADED;
    if (statuses.includes(HEALTH.MAINTENANCE)) return HEALTH.MAINTENANCE;
    if (statuses.length === 0)                return HEALTH.UNKNOWN;
    return HEALTH.OPERATIONAL;
  }

  /* ── Immutable audit trail ───────────────────────────────── */

  /**
   * Write to the immutable audit trail.
   * Uses server timestamps — cannot be forged by client.
   */
  async audit(action, details = {}, before = null, after = null) {
    if (!this._db) return;
    const { collection, addDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    try {
      await addDoc(collection(this._db, 'eccAuditLog'), {
        action,
        details:   _stripPII(details),
        before:    before  ? _stripPII(before)  : null,
        after:     after   ? _stripPII(after)   : null,
        actorUid:  this._user?.uid  ?? 'system',
        actorEmail:this._user?.email ?? 'system',
        actorRole: this._role ?? 'unknown',
        ip:        null,   /* set server-side in CF */
        sessionId: _getSessionId(),
        ts:        Date.now(),
        serverTs:  serverTimestamp(),
      });
    } catch (_) {}
  }

  /* ── Threshold management ────────────────────────────────── */

  async updateThreshold(key, value, reason = '') {
    if (!this.canAction('send_alert')) throw new Error('Permission denied');
    const before = { [key]: this._thresholds[key] };
    this._thresholds[key] = value;
    const { doc, setDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    await setDoc(doc(this._db, 'eccConfig', 'thresholds'), {
      [key]: value, updatedAt: Date.now(), updatedBy: this._user?.uid,
      serverTs: serverTimestamp(),
    }, { merge: true });
    await this.audit('threshold_updated', { key, value, reason }, before, { [key]: value });
  }

  /* ── Query helpers ───────────────────────────────────────── */

  async queryAuditLog({ action, actorUid, limitN = 100, since } = {}) {
    const { collection, query, where, orderBy, limit, getDocs } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const constraints = [orderBy('ts', 'desc'), limit(limitN)];
    if (action)   constraints.unshift(where('action',    '==', action));
    if (actorUid) constraints.unshift(where('actorUid',  '==', actorUid));
    if (since)    constraints.push(where('ts', '>=', since));
    const q = query(collection(this._db, 'eccAuditLog'), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async querySecurityEvents({ type, severity, limitN = 100 } = {}) {
    const { collection, query, where, orderBy, limit, getDocs } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const since = Date.now() - 86_400_000;
    const constraints = [where('ts', '>=', since), orderBy('ts', 'desc'), limit(limitN)];
    if (type)     constraints.unshift(where('eventType', '==', type));
    if (severity) constraints.unshift(where('severity',  '==', severity));
    const q = query(collection(this._db, 'securityEvents'), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  /* ── Event system ────────────────────────────────────────── */

  on(event, fn)  { const fns = this._callbacks.get(event) ?? []; fns.push(fn); this._callbacks.set(event, fns); return this; }
  off(event, fn) { this._callbacks.set(event, (this._callbacks.get(event) ?? []).filter(f => f !== fn)); return this; }
  _emit(event, data) { (this._callbacks.get(event) ?? []).forEach(fn => { try { fn(data); } catch (_) {} }); }

  /* ── Firestore ───────────────────────────────────────────── */

  async _getDB() {
    if (this._db) return this._db;
    const { getFirestore } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const { app }          = await import('./firebase.js');
    this._db = getFirestore(app);
    return this._db;
  }
}

/* ── Private helpers ─────────────────────────────────────────── */

function _startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function _count(result) {
  if (result.status !== 'fulfilled') return 0;
  const v = result.value;
  return typeof v?.data === 'function' ? v.data().count : (v?.size ?? 0);
}

const PII_FIELDS = new Set(['phone', 'email', 'password', 'pin', 'token', 'secret', 'name', 'idNumber']);
function _stripPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = PII_FIELDS.has(k) ? '[REDACTED]' : v;
  return out;
}

function _getSessionId() {
  try { return sessionStorage.getItem('_sk_sess') ?? 'unknown'; } catch (_) { return 'unknown'; }
}

/* ── Singleton ───────────────────────────────────────────────── */
const ecc = new ECCEngine();
export { ECCEngine, ECC_ROLES, SEVERITY, INCIDENT_STATUS, HEALTH };
export default ecc;

if (typeof window !== 'undefined') { window.SokoniECC = ecc; }
