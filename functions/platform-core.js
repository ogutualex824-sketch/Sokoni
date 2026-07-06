/* ================================================================
   SOKONI Platform Core v1.0
   6 Cloud Functions extending platform.html with:
     Hub Registry        — all SOKONI business hubs, their config,
                           integration matrix and live status
     Feature Flags       — runtime toggles, no code deployment needed
     Cross-Hub Metrics   — aggregated revenue / orders / users per hub

   Works alongside the existing 4 platform modules:
     platform-registry.js  (service registry)
     platform-events.js    (event bus)
     platform-health.js    (health checks)
     platform-event-bus.js (pub/sub routing)
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger                  = require('firebase-functions/logger');
const admin                   = require('firebase-admin');

const REGION = 'us-central1';
const db     = () => admin.firestore();
const now    = () => admin.firestore.FieldValue.serverTimestamp();

/* ── Auth helpers ── */
const _auth  = (req) => { if (!req.auth) throw new HttpsError('unauthenticated', 'Login required'); return req.auth; };
const _admin = (req) => { const a = _auth(req); if (!req.auth.token?.admin && !req.auth.token?.superAdmin) throw new HttpsError('permission-denied', 'Admin required'); return a; };

/* ── Audit ── */
const _audit = async (action, uid, data) => { try { await db().collection('finosAudit').add({ action, actorUid: uid, ...data, timestamp: now() }); } catch (_) {} };

/* ════════════════════════════════════════════════════════════
   Hub registry seed — all current SOKONI business hubs.
   Stored in platformHubs/{hubId}. Seeded once on first read.
════════════════════════════════════════════════════════════ */
const DEFAULT_HUBS = [
  {
    hubId:'marketplace', name:'Marketplace', icon:'🛍️', status:'live',
    url:'/marketplace', adminUrl:'/admin-os', cfCount:62, description:'Multi-vendor marketplace for all product categories',
    config:{ commissionRate:5, settlementDays:3, escrowEnabled:false, kycRequired:false },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:true, analytics:true, trust_safety:true, subscriptions:true, logistics:true, etims:true },
  },
  {
    hubId:'food', name:'Food Hub', icon:'🍔', status:'live',
    url:'/food-hub', adminUrl:'/admin-os', cfCount:18, description:'Restaurant ordering, food delivery and kitchen management',
    config:{ commissionRate:12, settlementDays:1, escrowEnabled:false, kycRequired:false },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:true, analytics:true, trust_safety:true, subscriptions:true, logistics:true, etims:false },
  },
  {
    hubId:'events', name:'Event Hub', icon:'🎟️', status:'live',
    url:'/event-hub', adminUrl:'/event-manager', cfCount:19, description:'Event listing, ticketing, QR gate check-in and analytics',
    config:{ commissionRate:3, settlementDays:7, escrowEnabled:true, kycRequired:false },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:false, analytics:true, trust_safety:true, subscriptions:false, logistics:false, etims:false },
  },
  {
    hubId:'property', name:'Property', icon:'🏠', status:'live',
    url:'/property', adminUrl:'/admin-os', cfCount:14, description:'Property listings — sales, rentals, commercial',
    config:{ commissionRate:2, settlementDays:14, escrowEnabled:true, kycRequired:true },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:true, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:false },
  },
  {
    hubId:'vehicles', name:'Vehicles', icon:'🚗', status:'live',
    url:'/vehicles', adminUrl:'/admin-os', cfCount:10, description:'Vehicle listings — new, used, hire purchase, deposits',
    config:{ commissionRate:2, settlementDays:14, escrowEnabled:true, kycRequired:true },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:false, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:false },
  },
  {
    hubId:'healthcare', name:'Healthcare', icon:'🏥', status:'live',
    url:'/healthcare', adminUrl:'/admin-os', cfCount:12, description:'Doctor appointments, lab tests, teleconsultation',
    config:{ commissionRate:8, settlementDays:3, escrowEnabled:false, kycRequired:true },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:true, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:false },
  },
  {
    hubId:'legal', name:'Legal Services', icon:'⚖️', status:'live',
    url:'/legal', adminUrl:'/admin-os', cfCount:8, description:'Legal consultations, document drafting, contract review',
    config:{ commissionRate:10, settlementDays:7, escrowEnabled:true, kycRequired:true },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:false, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:false },
  },
  {
    hubId:'jobs', name:'Jobs', icon:'💼', status:'live',
    url:'/jobs', adminUrl:'/admin-os', cfCount:16, description:'Job listings, applications, employer tools',
    config:{ commissionRate:0, settlementDays:0, escrowEnabled:false, kycRequired:false },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:true, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:false },
  },
  {
    hubId:'hotel', name:'Hotels & BnB', icon:'🏨', status:'live',
    url:'/hotel', adminUrl:'/admin-os', cfCount:10, description:'Hotel and BnB booking, room management, check-in',
    config:{ commissionRate:8, settlementDays:3, escrowEnabled:true, kycRequired:false },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:false, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:false },
  },
  {
    hubId:'pharmacy', name:'Pharmacy', icon:'💊', status:'live',
    url:'/pharmacy', adminUrl:'/admin-os', cfCount:10, description:'Online pharmacy — prescription and OTC',
    config:{ commissionRate:5, settlementDays:2, escrowEnabled:false, kycRequired:false },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:false, analytics:true, trust_safety:true, subscriptions:true, logistics:true, etims:true },
  },
  {
    hubId:'drivers', name:'Drivers & Delivery', icon:'🛵', status:'live',
    url:'/rider-nav', adminUrl:'/fleet-monitor', cfCount:23, description:'Driver onboarding, GPS navigation, delivery tracking',
    config:{ commissionRate:15, settlementDays:1, escrowEnabled:false, kycRequired:true },
    integrations:{ financial:true, chat:true, notifications:true, search:false, ai:false, analytics:true, trust_safety:true, subscriptions:true, logistics:true, etims:false },
  },
  {
    hubId:'logistics', name:'Logistics', icon:'📦', status:'live',
    url:'/logistics', adminUrl:'/admin-os', cfCount:8, description:'Third-party logistics, bulk shipping, fulfilment',
    config:{ commissionRate:10, settlementDays:3, escrowEnabled:false, kycRequired:false },
    integrations:{ financial:true, chat:true, notifications:true, search:false, ai:false, analytics:true, trust_safety:true, subscriptions:true, logistics:true, etims:true },
  },
  {
    hubId:'freelancer', name:'Freelancers', icon:'💻', status:'live',
    url:'/freelancer', adminUrl:'/admin-os', cfCount:8, description:'Freelance services marketplace — design, dev, content',
    config:{ commissionRate:10, settlementDays:5, escrowEnabled:true, kycRequired:false },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:true, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:false },
  },
  {
    hubId:'education', name:'Education', icon:'🎓', status:'live',
    url:'/education', adminUrl:'/admin-os', cfCount:8, description:'Online courses, tutoring, certifications',
    config:{ commissionRate:8, settlementDays:7, escrowEnabled:false, kycRequired:false },
    integrations:{ financial:true, chat:true, notifications:true, search:true, ai:true, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:false },
  },
  {
    hubId:'entertainment', name:'Entertainment', icon:'🎬', status:'live',
    url:'/entertainment', adminUrl:'/admin-os', cfCount:8, description:'Digital content — music, video, gaming',
    config:{ commissionRate:15, settlementDays:7, escrowEnabled:false, kycRequired:false },
    integrations:{ financial:true, chat:false, notifications:true, search:true, ai:true, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:false },
  },
  {
    hubId:'digital_products', name:'Digital Products', icon:'🖥️', status:'live',
    url:'/digital-products', adminUrl:'/admin-os', cfCount:6, description:'Software, templates, ebooks, licenses',
    config:{ commissionRate:5, settlementDays:0, escrowEnabled:false, kycRequired:false },
    integrations:{ financial:true, chat:false, notifications:true, search:true, ai:false, analytics:true, trust_safety:true, subscriptions:false, logistics:false, etims:false },
  },
  {
    hubId:'smartpos', name:'SmartPOS', icon:'🖨️', status:'live',
    url:'/pos', adminUrl:'/pos-hq', cfCount:139, description:'In-store POS — retail, restaurants, inventory, receipts',
    config:{ commissionRate:1.5, settlementDays:1, escrowEnabled:false, kycRequired:false },
    integrations:{ financial:true, chat:false, notifications:true, search:false, ai:true, analytics:true, trust_safety:true, subscriptions:true, logistics:false, etims:true },
  },
  {
    hubId:'insurance', name:'Insurance', icon:'🛡️', status:'coming_soon',
    url:'/insurance', adminUrl:'/admin-os', cfCount:0, description:'Motor, health, property and life insurance',
    config:{ commissionRate:8, settlementDays:14, escrowEnabled:true, kycRequired:true },
    integrations:{ financial:false, chat:false, notifications:false, search:false, ai:false, analytics:false, trust_safety:false, subscriptions:false, logistics:false, etims:false },
  },
  {
    hubId:'financial_services', name:'Financial Services', icon:'🏦', status:'coming_soon',
    url:'/financial-services', adminUrl:'/admin-os', cfCount:0, description:'Loans, savings, SACCO integrations, investment',
    config:{ commissionRate:3, settlementDays:14, escrowEnabled:true, kycRequired:true },
    integrations:{ financial:false, chat:false, notifications:false, search:false, ai:false, analytics:false, trust_safety:false, subscriptions:false, logistics:false, etims:false },
  },
];

/* Default feature flags */
const DEFAULT_FLAGS = {
  ai_search:            { enabled:true,  category:'ai',           description:'AI-powered search results and autocomplete' },
  ai_assistant:         { enabled:true,  category:'ai',           description:'KASS AI customer and seller assistant' },
  ai_content_moderation:{ enabled:true,  category:'ai',           description:'AI moderation of listings and reviews' },
  b2b_wholesale:        { enabled:true,  category:'commerce',     description:'B2B wholesale ordering and bulk pricing' },
  etims_live:           { enabled:false, category:'compliance',   description:'Live KRA eTIMS invoice submission (requires real credentials)' },
  app_check:            { enabled:true,  category:'security',     description:'Firebase App Check enforcement on all endpoints' },
  driver_auto_dispatch: { enabled:true,  category:'logistics',    description:'Automatic driver dispatch on order placement' },
  social_login:         { enabled:true,  category:'auth',         description:'Google and Facebook social login' },
  subscription_trials:  { enabled:true,  category:'billing',      description:'Free trial periods on paid plans' },
  commission_holiday:   { enabled:false, category:'billing',      description:'Zero-commission promotional periods' },
  escrow_enabled:       { enabled:true,  category:'payments',     description:'Escrow holding for high-value transactions' },
  smart_recommendations:{ enabled:true,  category:'ai',           description:'Personalized product and service recommendations' },
  review_gating:        { enabled:true,  category:'quality',      description:'Only allow reviews from verified purchasers' },
  seller_analytics:     { enabled:true,  category:'analytics',    description:'Seller-facing analytics dashboard' },
  wholesale_portal:     { enabled:true,  category:'commerce',     description:'B2B wholesale buyer portal' },
  developer_portal:     { enabled:true,  category:'platform',     description:'External developer API access' },
  beta_features:        { enabled:false, category:'platform',     description:'Experimental features for beta testers' },
};

/* ════════════════════════════════════════════════════════════
   CF 1. pcGetHubRegistry
   Returns all registered SOKONI business hubs.
   Seeds platformHubs collection on first call.
════════════════════════════════════════════════════════════ */
exports.pcGetHubRegistry = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    _admin(req);
    const fsdb     = db();
    const colRef   = fsdb.collection('platformHubs');
    const { statusFilter } = req.data || {};

    /* Seed defaults if collection is empty */
    const count = await colRef.count().get();
    if (count.data().count === 0) {
      const batch = fsdb.batch();
      DEFAULT_HUBS.forEach(h => {
        batch.set(colRef.doc(h.hubId), { ...h, seededAt: now(), updatedAt: now() });
      });
      await batch.commit();
      logger.info('[platform-core] Seeded default hub registry', { count: DEFAULT_HUBS.length });
    }

    let q = colRef.orderBy('name');
    if (statusFilter) q = q.where('status', '==', statusFilter);
    const snap = await q.get();

    const hubs = snap.docs.map(d => ({ hubId: d.id, ...d.data() }));
    const liveCount    = hubs.filter(h => h.status === 'live').length;
    const comingCount  = hubs.filter(h => h.status === 'coming_soon').length;
    const totalCFs     = hubs.reduce((a, h) => a + (h.cfCount || 0), 0);

    return { hubs, summary: { total: hubs.length, live: liveCount, comingSoon: comingCount, totalCFs } };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 2. pcRegisterHub
   Admin registers a new business hub in the platform registry.
════════════════════════════════════════════════════════════ */
exports.pcRegisterHub = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    const auth = _admin(req);
    const { hubId, name, icon, description, url, adminUrl, status = 'coming_soon', config = {}, integrations = {} } = req.data || {};

    if (!hubId || !name) throw new HttpsError('invalid-argument', 'hubId and name required');
    if (!/^[a-z_]{2,40}$/.test(hubId)) throw new HttpsError('invalid-argument', 'hubId must be lowercase letters and underscores only');

    const existing = await db().collection('platformHubs').doc(hubId).get();
    if (existing.exists) throw new HttpsError('already-exists', `Hub "${hubId}" is already registered`);

    const hubDoc = {
      hubId, name, icon: icon || '📦', description: description || '',
      url: url || `/${hubId}`, adminUrl: adminUrl || '/admin-os',
      status, cfCount: 0,
      config: { commissionRate: config.commissionRate || 5, settlementDays: config.settlementDays || 3, escrowEnabled: config.escrowEnabled || false, kycRequired: config.kycRequired || false },
      integrations: { financial: false, chat: false, notifications: false, search: false, ai: false, analytics: false, trust_safety: false, subscriptions: false, logistics: false, etims: false, ...integrations },
      createdAt: now(), updatedAt: now(),
    };

    await db().collection('platformHubs').doc(hubId).set(hubDoc);

    await _audit('hub_registered', auth.uid, { hubId, name, status });
    logger.info('[platform-core] Hub registered', { hubId, name });

    return { hubId, name, status, message: `Hub "${name}" registered successfully` };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 3. pcUpdateHubConfig
   Admin updates hub configuration (commission, settlement,
   integrations, status).
════════════════════════════════════════════════════════════ */
exports.pcUpdateHubConfig = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    const auth = _admin(req);
    const { hubId, updates } = req.data || {};
    if (!hubId) throw new HttpsError('invalid-argument', 'hubId required');

    const hubRef  = db().collection('platformHubs').doc(hubId);
    const hubSnap = await hubRef.get();
    if (!hubSnap.exists) throw new HttpsError('not-found', `Hub "${hubId}" not found`);

    const allowedFields = ['name', 'icon', 'description', 'status', 'url', 'adminUrl', 'cfCount', 'config', 'integrations'];
    const sanitized = {};
    allowedFields.forEach(f => { if (updates[f] !== undefined) sanitized[f] = updates[f]; });
    sanitized.updatedAt = now();

    await hubRef.update(sanitized);

    await _audit('hub_config_updated', auth.uid, { hubId, fields: Object.keys(sanitized) });
    logger.info('[platform-core] Hub config updated', { hubId, fields: Object.keys(sanitized) });

    return { hubId, updated: Object.keys(sanitized), message: 'Configuration updated' };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 4. pcGetFeatureFlags
   Returns all feature flags.
   Seeds platformConfig/featureFlags on first call.
════════════════════════════════════════════════════════════ */
exports.pcGetFeatureFlags = onCall(
  { region: REGION, timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    _admin(req);
    const docRef  = db().collection('platformConfig').doc('featureFlags');
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      /* Seed defaults */
      const seeded = {};
      Object.entries(DEFAULT_FLAGS).forEach(([k, v]) => {
        seeded[k] = { ...v, updatedBy: 'system', updatedAt: Date.now() };
      });
      await docRef.set({ flags: seeded, seededAt: now() });
      return { flags: seeded };
    }

    return { flags: docSnap.data()?.flags || {} };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 5. pcSetFeatureFlag
   Admin enables or disables a feature flag.
════════════════════════════════════════════════════════════ */
exports.pcSetFeatureFlag = onCall(
  { region: REGION, timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const auth = _admin(req);
    const { key, enabled, description } = req.data || {};
    if (!key) throw new HttpsError('invalid-argument', 'key required');
    if (typeof enabled !== 'boolean') throw new HttpsError('invalid-argument', 'enabled must be boolean');

    const docRef = db().collection('platformConfig').doc('featureFlags');
    const update = {
      [`flags.${key}.enabled`]:    enabled,
      [`flags.${key}.updatedBy`]:  auth.uid,
      [`flags.${key}.updatedAt`]:  Date.now(),
    };
    if (description) update[`flags.${key}.description`] = description;

    await docRef.set(update, { merge: true });

    await _audit('feature_flag_updated', auth.uid, { key, enabled });
    logger.info('[platform-core] Feature flag updated', { key, enabled, uid: auth.uid });

    return { key, enabled, message: `Flag "${key}" ${enabled ? 'enabled' : 'disabled'}` };
  }
);

/* ════════════════════════════════════════════════════════════
   CF 6. pcGetCrossHubMetrics
   Aggregated revenue, transactions, and wallet stats per hub.
   Reads from finosHubCounters (lifetime) and finosSnapshots
   (period breakdown).
════════════════════════════════════════════════════════════ */
exports.pcGetCrossHubMetrics = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB' },
  async (req) => {
    _admin(req);
    const { periodDays = 30 } = req.data || {};
    const fsdb = db();

    /* Lifetime hub counters */
    const countersSnap = await fsdb.collection('finosHubCounters').get().catch(() => ({ empty: true, docs: [] }));

    const hubMetrics = {};
    countersSnap.docs?.forEach(d => {
      hubMetrics[d.id] = {
        hubId:          d.id,
        lifetimeRevKES: Math.round((d.data().totalRevenueCents || 0) / 100),
        lifetimeComKES: Math.round((d.data().totalCommissionCents || 0) / 100),
        lifetimeTx:     d.data().totalTransactions || 0,
      };
    });

    /* Period data from fosTransactions (last N days) */
    const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - periodDays * 86400000));
    const txSnap = await fsdb.collection('fosTransactions')
      .where('status', '==', 'COMPLETED')
      .where('createdAt', '>=', cutoff)
      .limit(2000)
      .get().catch(() => ({ empty: true, docs: [] }));

    const periodByHub = {};
    txSnap.docs?.forEach(d => {
      const tx = d.data();
      const h  = tx.hubType || 'unknown';
      if (!periodByHub[h]) periodByHub[h] = { revCents: 0, comCents: 0, txCount: 0 };
      periodByHub[h].revCents += tx.amountCents || 0;
      periodByHub[h].comCents += tx.commissionCents || 0;
      periodByHub[h].txCount++;
    });

    /* Merge lifetime + period data */
    const allHubIds = new Set([...Object.keys(hubMetrics), ...Object.keys(periodByHub)]);
    const rows = [...allHubIds].map(hubId => {
      const lifetime = hubMetrics[hubId] || {};
      const period   = periodByHub[hubId] || {};
      return {
        hubId,
        periodRevKES:  Math.round((period.revCents || 0) / 100),
        periodComKES:  Math.round((period.comCents || 0) / 100),
        periodTx:      period.txCount || 0,
        lifetimeRevKES: lifetime.lifetimeRevKES || 0,
        lifetimeTx:    lifetime.lifetimeTx || 0,
      };
    }).sort((a, b) => b.periodRevKES - a.periodRevKES);

    /* Platform totals */
    const totals = rows.reduce((acc, r) => ({
      periodRevKES:  acc.periodRevKES + r.periodRevKES,
      periodComKES:  acc.periodComKES + r.periodComKES,
      periodTx:      acc.periodTx + r.periodTx,
      lifetimeRevKES: acc.lifetimeRevKES + r.lifetimeRevKES,
    }), { periodRevKES:0, periodComKES:0, periodTx:0, lifetimeRevKES:0 });

    return { periodDays, rows, totals, generatedAt: new Date().toISOString() };
  }
);
