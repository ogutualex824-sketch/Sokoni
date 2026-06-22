/* ================================================================
   SOKONI PLATFORM REGISTRY  v1.0.0  |  2026-06-21
   functions/platform-registry.js

   Persistent server-side service registry.
   Every SOKONI module (product, platform service, CF group)
   registers itself here so the platform knows what's running,
   what it depends on, what capabilities it exposes, and whether
   it's healthy.

   This solves the key gap: sokoni-service-mesh.js is in-memory
   client-side only. Cloud Functions, Firestore triggers, and
   scheduled CFs cannot read that registry — this one is the
   authoritative source of truth that spans all runtimes.

   Collections:
     platformServices/{serviceId}   — service metadata
     platformHealth/{serviceId}     — latest health report
     platformDependencies/{id}      — dependency declarations

   Service Capabilities Schema:
     Every service declares which platform capabilities it USES.
     This produces an auditable integration matrix.

   Exports:
     platformRegisterService   — onCall: self-registration
     platformGetRegistry       — onCall: list all services
     platformUpdateHealth      — onCall: report health status
     platformGetHealth         — onCall: aggregate health view
     platformDeregisterService — onCall: admin remove
     platformGetDependencies   — onCall: dependency graph
     platformHealthSweep       — scheduled: mark stale services
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { logger }             = require('firebase-functions');
const admin                  = require('firebase-admin');
const FieldValue             = admin.firestore.FieldValue;

const { assertAuth, assertAdmin, sanitize } = require('./shared/errors');

const db  = () => admin.firestore();
const san = (s, n = 200) => sanitize(s, n);

/* ── Well-known platform capability keys ─────────────────── */
const PLATFORM_CAPABILITIES = [
  'authentication', 'rbac', 'abac', 'subscriptions', 'entitlements',
  'billing', 'payments', 'escrow', 'ledger', 'commission', 'tax',
  'notifications', 'ai_platform', 'ai_credits', 'fraud_detection',
  'risk_engine', 'search', 'workflow_automation', 'storage', 'usage_metering',
  'analytics', 'audit_logs', 'monitoring', 'logging', 'feature_flags',
  'configuration', 'api_gateway', 'event_bus', 'queue_system',
  'secrets_management', 'device_trust', 'geo_intelligence', 'media',
];

const SERVICE_STATUSES = ['active', 'degraded', 'maintenance', 'deprecated', 'planned'];
const SERVICE_TYPES    = ['platform', 'product', 'integration', 'infrastructure', 'ai'];

/* ================================================================
   platformRegisterService
   Self-registration endpoint. Any service calls this on boot.
   Idempotent — calling again updates the registration.
================================================================ */
const platformRegisterService = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAuth(req);

    const serviceId = san(req.data.serviceId, 80);
    const name      = san(req.data.name, 120);
    const type      = san(req.data.type || 'product', 30);
    const version   = san(req.data.version || '1.0.0', 20);
    const description = san(req.data.description || '', 300);
    const ownerId   = req.auth.uid;

    /* Which platform capabilities does this service USE? */
    const uses = Array.isArray(req.data.uses)
      ? req.data.uses.filter(c => PLATFORM_CAPABILITIES.includes(c)).slice(0, 40)
      : [];

    /* What events does this service PUBLISH? */
    const publishesEvents = Array.isArray(req.data.publishesEvents)
      ? req.data.publishesEvents.map(e => san(e, 80)).slice(0, 50)
      : [];

    /* What events does this service SUBSCRIBE to? */
    const subscribesEvents = Array.isArray(req.data.subscribesEvents)
      ? req.data.subscribesEvents.map(e => san(e, 80)).slice(0, 50)
      : [];

    /* Which services does this service depend on? */
    const dependsOn = Array.isArray(req.data.dependsOn)
      ? req.data.dependsOn.map(d => san(d, 80)).slice(0, 20)
      : [];

    /* Page/path this service lives at */
    const url = san(req.data.url || '', 200);

    if (!serviceId || !name) throw new HttpsError('invalid-argument', 'serviceId and name required.');
    if (!SERVICE_TYPES.includes(type)) throw new HttpsError('invalid-argument', `Invalid type: ${type}`);

    const now    = Date.now();
    const svcRef = db().collection('platformServices').doc(serviceId);
    const batch  = db().batch();

    batch.set(svcRef, {
      serviceId, name, type, version, description, url,
      uses, publishesEvents, subscribesEvents, dependsOn,
      ownerId,
      status:        'active',
      registeredAt:  now,
      updatedAt:     FieldValue.serverTimestamp(),
    }, { merge: true });

    /* Write dependency edges */
    for (const dep of dependsOn) {
      batch.set(db().collection('platformDependencies').doc(`${serviceId}→${dep}`), {
        from: serviceId, to: dep, registeredAt: now,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    /* Initial health record */
    batch.set(db().collection('platformHealth').doc(serviceId), {
      serviceId, status: 'healthy', lastHeartbeat: now,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await batch.commit();
    logger.info(`[Platform] Service registered: ${serviceId} (${type}) by ${ownerId}`);
    return { success: true, serviceId };
  }
);

/* ================================================================
   platformGetRegistry
   Returns the full service catalog.
   Public (any authed user) — unauthenticated is blocked at rules.
================================================================ */
const platformGetRegistry = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAuth(req);

    const type     = san(req.data.type || '', 30);
    const status   = san(req.data.status || '', 30);
    const pageSize = Math.min(req.data.pageSize || 50, 200);
    const isAdmin  = req.auth.token?.admin || req.auth.token?.superAdmin;

    let q = db().collection('platformServices').orderBy('updatedAt', 'desc').limit(pageSize);
    if (type)   q = db().collection('platformServices').where('type', '==', type).orderBy('updatedAt','desc').limit(pageSize);
    if (status) q = db().collection('platformServices').where('status', '==', status).orderBy('updatedAt','desc').limit(pageSize);

    const snap = await q.get();
    const services = snap.docs.map(d => {
      const s = d.data();
      /* Non-admins see limited metadata */
      return isAdmin ? { id: d.id, ...s } : {
        serviceId: s.serviceId, name: s.name, type: s.type,
        version: s.version, status: s.status, url: s.url,
        description: s.description, uses: s.uses,
      };
    });

    return { services, total: services.length };
  }
);

/* ================================================================
   platformUpdateHealth
   Services call this periodically to report their health status.
   Also used by CI/CD pipelines and monitoring agents.
================================================================ */
const platformUpdateHealth = onCall(
  { region: 'us-central1', timeoutSeconds: 10, memory: '128MiB' },
  async (req) => {
    assertAuth(req);

    const serviceId  = san(req.data.serviceId, 80);
    const status     = san(req.data.status || 'healthy', 30);  /* healthy | degraded | unhealthy */
    const latencyMs  = Number(req.data.latencyMs || 0);
    const errorRate  = Number(req.data.errorRate || 0);
    const message    = san(req.data.message || '', 200);
    const metadata   = req.data.metadata || {};

    const validStatuses = ['healthy', 'degraded', 'unhealthy'];
    if (!validStatuses.includes(status)) throw new HttpsError('invalid-argument', `Invalid status: ${status}`);
    if (!serviceId) throw new HttpsError('invalid-argument', 'serviceId required.');

    const now    = Date.now();
    const batch  = db().batch();

    batch.set(db().collection('platformHealth').doc(serviceId), {
      serviceId, status, latencyMs, errorRate, message,
      metadata: typeof metadata === 'object' ? metadata : {},
      lastHeartbeat: now,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    /* Reflect degraded/unhealthy in service registry */
    if (status !== 'healthy') {
      batch.update(db().collection('platformServices').doc(serviceId), {
        status: status === 'unhealthy' ? 'degraded' : 'active',
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      batch.set(db().collection('platformServices').doc(serviceId), {
        status: 'active', updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    await batch.commit();
    return { success: true, recorded: now };
  }
);

/* ================================================================
   platformGetHealth
   Returns aggregated health view: all services with latest status.
   Admin sees full detail; auth users see status + service name.
================================================================ */
const platformGetHealth = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAuth(req);
    const isAdmin = req.auth.token?.admin || req.auth.token?.superAdmin;

    const [svcSnap, healthSnap] = await Promise.all([
      db().collection('platformServices').limit(200).get(),
      db().collection('platformHealth').limit(200).get(),
    ]);

    const healthById = {};
    healthSnap.docs.forEach(d => { healthById[d.id] = d.data(); });

    const now    = Date.now();
    let   total  = 0, healthy = 0, degraded = 0, stale = 0;

    const services = svcSnap.docs.map(d => {
      const svc    = d.data();
      const health = healthById[d.id] || {};
      const status = health.status || 'unknown';
      const hb     = health.lastHeartbeat || 0;
      const isStale = (now - hb) > 300000;  /* 5 min stale threshold */

      total++;
      if (isStale)         stale++;
      else if (status === 'healthy')  healthy++;
      else if (status !== 'unknown')  degraded++;

      const base = {
        serviceId: svc.serviceId, name: svc.name, type: svc.type,
        healthStatus: isStale ? 'stale' : status,
        lastHeartbeat: hb, stale: isStale,
      };

      return isAdmin ? {
        ...base,
        latencyMs: health.latencyMs || 0,
        errorRate: health.errorRate || 0,
        message:   health.message   || '',
        version:   svc.version,
        uses:      svc.uses,
        url:       svc.url,
      } : base;
    });

    return {
      services, total, healthy, degraded, stale,
      unhealthy: total - healthy - stale,
      overallStatus: degraded + stale > 0 ? 'degraded' : 'healthy',
    };
  }
);

/* ================================================================
   platformDeregisterService
   Admin-only. Removes a service from the registry.
================================================================ */
const platformDeregisterService = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const adminUid  = assertAdmin(req);
    const serviceId = san(req.data.serviceId, 80);
    const reason    = san(req.data.reason || '', 200);

    if (!serviceId) throw new HttpsError('invalid-argument', 'serviceId required.');

    const batch = db().batch();
    batch.update(db().collection('platformServices').doc(serviceId), {
      status: 'deprecated', deregisteredBy: adminUid, deregisterReason: reason,
      updatedAt: FieldValue.serverTimestamp(),
    });

    /* Audit */
    batch.set(db().collection('sasosAuditLog').doc(), {
      type: 'platform_service_deregistered', adminUid, serviceId, reason,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    await batch.commit();
    logger.info(`[Platform] Service deregistered: ${serviceId} by ${adminUid}`);
    return { success: true };
  }
);

/* ================================================================
   platformGetDependencies
   Returns the dependency graph for a service or the whole platform.
================================================================ */
const platformGetDependencies = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAuth(req);
    const serviceId = san(req.data.serviceId || '', 80);

    const snap = serviceId
      ? await db().collection('platformDependencies')
          .where('from', '==', serviceId).get()
      : await db().collection('platformDependencies').limit(500).get();

    return {
      edges: snap.docs.map(d => ({ from: d.data().from, to: d.data().to })),
      total: snap.docs.length,
    };
  }
);

/* ================================================================
   platformGetCapabilityMatrix
   Returns which services use which platform capabilities.
   Useful for auditing integration completeness.
================================================================ */
const platformGetCapabilityMatrix = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '256MiB' },
  async (req) => {
    assertAdmin(req);

    const snap = await db().collection('platformServices')
      .where('status', '!=', 'deprecated').limit(200).get();

    const matrix = {};
    const missingIntegrations = {};

    PLATFORM_CAPABILITIES.forEach(cap => { matrix[cap] = []; });

    snap.docs.forEach(d => {
      const svc = d.data();
      if (svc.type === 'product') {
        const missing = PLATFORM_CAPABILITIES.filter(cap =>
          !['configuration', 'secrets_management', 'backup', 'disaster_recovery'].includes(cap) &&
          !(svc.uses || []).includes(cap)
        );
        if (missing.length > 0) missingIntegrations[svc.serviceId] = missing;
      }
      (svc.uses || []).forEach(cap => {
        if (matrix[cap]) matrix[cap].push(svc.serviceId);
      });
    });

    return { matrix, missingIntegrations, totalServices: snap.docs.length };
  }
);

/* ================================================================
   platformHealthSweep  [Scheduled — every 1 hours]
   Marks services as 'stale' if no heartbeat in 5+ minutes.
================================================================ */
const platformHealthSweep = onSchedule(
  { schedule: 'every 1 hours', region: 'us-central1', memory: '128MiB', timeoutSeconds: 60 },
  async () => {
    const staleThreshold = Date.now() - 300000; /* 5 min */
    const snap = await db().collection('platformHealth')
      .where('lastHeartbeat', '<=', staleThreshold).limit(100).get();

    const batch = db().batch();
    snap.docs.forEach(d => {
      if (d.data().status === 'stale') return;
      batch.update(d.ref, { status: 'stale', updatedAt: FieldValue.serverTimestamp() });
    });

    if (!snap.empty) await batch.commit();
    logger.info(`[Platform] Health sweep: marked ${snap.docs.length} stale services`);
  }
);

/* ── Exports ─────────────────────────────────────────────── */
module.exports = {
  platformRegisterService,
  platformGetRegistry,
  platformUpdateHealth,
  platformGetHealth,
  platformDeregisterService,
  platformGetDependencies,
  platformGetCapabilityMatrix,
  platformHealthSweep,
  PLATFORM_CAPABILITIES,
};
