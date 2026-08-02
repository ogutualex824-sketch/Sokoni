'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

function _requireAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new Error('admin required');
}
function _requireSuperAdmin(req) {
  if (!req.auth?.token?.superAdmin) throw new Error('superAdmin required');
}


// Handler registry — consumed by admin-os-dispatch.js
exports._h = {};

/* ─────────────────────────────────────────────────────────────────────────
   Platform Overview
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetPlatformOverview = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetPlatformOverview = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const { Timestamp } = require('firebase-admin/firestore');

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = Timestamp.fromDate(todayStart);

  /* Use Firestore count() aggregation — no documents fetched, O(1) reads */
  const [totalUsersSnap, totalSellersSnap, newTodaySnap, activeOrdersSnap,
         openTicketsSnap, pendingReportsSnap, bannedUsersSnap] = await Promise.all([
    db.collection('users').count().get(),
    db.collection('users').where('role', '==', 'seller').count().get(),
    db.collection('users').where('createdAt', '>=', todayTs).count().get(),
    db.collection('orders').where('status', '==', 'pending').count().get(),
    db.collection('supportTickets').where('status', '==', 'open').count().get(),
    db.collection('reports').where('status', '==', 'pending').count().get(),
    db.collection('users').where('status', '==', 'banned').count().get(),
  ]);

  return {
    totalUsers:     totalUsersSnap.data().count,
    totalSellers:   totalSellersSnap.data().count,
    newUsersToday:  newTodaySnap.data().count,
    activeOrders:   activeOrdersSnap.data().count,
    openTickets:    openTicketsSnap.data().count,
    pendingReports: pendingReportsSnap.data().count,
    bannedUsers:    bannedUsersSnap.data().count,
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   User Management
──────────────────────────────────────────────────────────────────────────── */
exports.adminSearchUsers = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminSearchUsers = async (req) => {
  _requireAdmin(req);
  const { query, role, status, limit: lim } = req.data;

  const db = getFirestore();
  let q = db.collection('users');
  if (status) q = q.where('status', '==', status);
  q = q.limit(Math.min(lim || 100, 300));

  const snap = await q.get();
  let users = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // In-memory filters — no composite indexes needed
  if (query) {
    const ql = query.toLowerCase();
    users = users.filter(u =>
      (u.email || '').toLowerCase().includes(ql) ||
      (u.displayName || '').toLowerCase().includes(ql) ||
      (u.phone || '').includes(query) ||
      u.id === query
    );
  }
  if (role) users = users.filter(u => u.role === role || (u.roles || []).includes(role));

  return {
    users: users.slice(0, lim || 50).map(u => ({
      id: u.id,
      displayName: u.displayName || '',
      email: u.email || '',
      phone: u.phone || '',
      role: u.role || 'buyer',
      status: u.status || 'active',
      verified: u.verified || false,
      createdAt: u.createdAt,
    })),
  };
});

exports.adminGetUser = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetUser = async (req) => {
  _requireAdmin(req);
  const { uid } = req.data;
  if (!uid) throw new Error('uid required');

  const db = getFirestore();
  const auth = getAuth();

  const [userSnap, authUser, reportsSnap, ordersSnap, walletSnap, subSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    auth.getUser(uid).catch(() => null),
    db.collection('reports').where('entityId', '==', uid).limit(10).get(),
    db.collection('orders').where('buyerId', '==', uid).limit(10).get(),
    db.collection('wallets').doc(uid).get(),
    db.collection('subscriptions').where('uid', '==', uid).limit(5).get(),
  ]);

  if (!userSnap.exists) throw new Error('User not found');
  const u = userSnap.data();

  return {
    profile: { id: uid, ...u },
    authRecord: authUser ? {
      email: authUser.email,
      emailVerified: authUser.emailVerified,
      disabled: authUser.disabled,
      lastSignIn: authUser.metadata.lastSignInTime,
      creationTime: authUser.metadata.creationTime,
      providerData: authUser.providerData.map(p => p.providerId),
    } : null,
    wallet: walletSnap.exists ? walletSnap.data() : null,
    reportCount: reportsSnap.size,
    orderCount: ordersSnap.size,
    activeSubscriptions: subSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  };
});

exports.adminUpdateUserRole = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminUpdateUserRole = async (req) => {
  _requireSuperAdmin(req);
  const { uid, role, additionalClaims } = req.data;
  if (!uid || !role) throw new Error('uid, role required');

  const validRoles = ['buyer', 'seller', 'provider', 'driver', 'admin', 'moderator', 'superAdmin'];
  if (!validRoles.includes(role)) throw new Error(`Invalid role. Must be one of: ${validRoles.join(', ')}`);

  const auth = getAuth();
  const db = getFirestore();

  // Only allow safe, non-privilege supplementary claims to prevent escalation
  // via the additionalClaims spread (e.g. { superAdmin: true } injection)
  const SAFE_ADDITIONAL_KEYS = new Set(['department', 'location', 'merchantId', 'posId', 'branchId', 'teamId']);
  const sanitizedAdditional = additionalClaims
    ? Object.fromEntries(
        Object.entries(additionalClaims).filter(([k]) => SAFE_ADDITIONAL_KEYS.has(k))
      )
    : {};

  const claims = { [role]: true, ...sanitizedAdditional };
  // Prevent superAdmin escalation except by existing superAdmin
  if (role === 'superAdmin' && !req.auth?.token?.superAdmin) throw new Error('Cannot assign superAdmin');

  await auth.setCustomUserClaims(uid, claims);
  await db.collection('users').doc(uid).update({
    role,
    customClaims: claims,
    roleUpdatedAt: FieldValue.serverTimestamp(),
    roleUpdatedBy: req.auth.uid,
  });
  await db.collection('adminAudit').add({
    action: 'role_updated',
    targetUid: uid,
    newRole: role,
    performedBy: req.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   Platform Settings
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetPlatformSettings = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetPlatformSettings = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const snap = await db.collection('platformSettings').get();

  // Seed defaults if collection is empty
  const settings = {};
  snap.docs.forEach(d => { settings[d.id] = d.data(); });

  if (!settings.general) {
    settings.general = {
      platformName: 'SOKONI',
      supportEmail: 'support@mysokoni.co.ke',
      supportPhone: '+254700000000',
      maintenanceMode: false,
      maintenanceMessage: 'SOKONI is currently undergoing maintenance. We will be back shortly.',
      termsVersion: '1.0',
    };
  }
  if (!settings.financial) {
    settings.financial = {
      defaultCommissionPct: 10,
      minWithdrawalAmountCents: 100000,
      maxOrderValueCents: 50000000,
      platformCurrencyCode: 'KES',
      vatRate: 16,
      whtRate: 5,
      payoutScheduleDays: 2,
    };
  }
  if (!settings.subscription) {
    settings.subscription = {
      defaultTrialDays: 14,
      gracePeriodDays: 3,
      maxTrialExtensions: 1,
    };
  }
  if (!settings.security) {
    settings.security = {
      sessionTimeoutMinutes: 60,
      maxLoginAttempts: 5,
      lockoutDurationMinutes: 30,
      requireEmailVerification: false,
      enforceStrongPasswords: true,
    };
  }

  return { settings };
});

exports.adminUpdatePlatformSettings = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminUpdatePlatformSettings = async (req) => {
  _requireSuperAdmin(req);
  const { category, updates } = req.data;
  if (!category || !updates || typeof updates !== 'object') throw new Error('category and updates required');

  const validCategories = ['general', 'financial', 'subscription', 'security', 'notifications', 'search', 'ai'];
  if (!validCategories.includes(category)) throw new Error(`category must be one of: ${validCategories.join(', ')}`);

  const db = getFirestore();
  await db.collection('platformSettings').doc(category).set({
    ...updates,
    updatedBy: req.auth.uid,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection('adminAudit').add({
    action: 'settings_updated',
    category,
    updatedFields: Object.keys(updates),
    performedBy: req.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   Feature Flags
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetFeatureFlags = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetFeatureFlags = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const snap = await db.collection('featureFlags').limit(200).get();

  // Seed built-in flags if empty
  const flags = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (!flags.length) {
    const defaults = [
      { key: 'ai_assistant_enabled',       enabled: true,  description: 'KASS AI chat assistant',              rolloutPct: 100 },
      { key: 'bank_payout_enabled',         enabled: true,  description: 'Bank transfer payout option',         rolloutPct: 100 },
      { key: 'referral_program_active',     enabled: false, description: 'Referral code rewards program',       rolloutPct: 0   },
      { key: 'review_gating_enabled',       enabled: true,  description: 'Require purchase before review',      rolloutPct: 100 },
      { key: 'subscription_trials_active',  enabled: true,  description: 'Free trial on new subscriptions',     rolloutPct: 100 },
      { key: 'wallet_cashout_enabled',      enabled: true,  description: 'Allow M-PESA wallet withdrawals',     rolloutPct: 100 },
      { key: 'pos_marketplace_sync',        enabled: true,  description: 'SmartPOS ↔ Marketplace inventory sync', rolloutPct: 100 },
      { key: 'etims_auto_invoice',          enabled: true,  description: 'Auto-generate eTIMS invoices on sale', rolloutPct: 100 },
      { key: 'logistics_heat_map',          enabled: true,  description: 'Driver heat map analytics',           rolloutPct: 100 },
      { key: 'social_login_github',         enabled: true,  description: 'GitHub OAuth login',                  rolloutPct: 100 },
      { key: 'social_login_facebook',       enabled: true,  description: 'Facebook OAuth login',                rolloutPct: 100 },
      { key: 'social_login_microsoft',      enabled: true,  description: 'Microsoft OAuth login',               rolloutPct: 100 },
      { key: 'social_login_apple',          enabled: true,  description: 'Apple Sign-In',                       rolloutPct: 100 },
      { key: 'whatsapp_notifications',      enabled: false, description: 'WhatsApp order notifications',        rolloutPct: 0   },
      { key: 'maintenance_mode',            enabled: false, description: 'Site-wide maintenance banner',        rolloutPct: 100 },
    ];
    return { flags: defaults, seeded: true };
  }

  return { flags };
});

exports.adminUpdateFeatureFlag = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminUpdateFeatureFlag = async (req) => {
  _requireSuperAdmin(req);
  const { key, enabled, rolloutPct, enabledForRoles, description } = req.data;
  if (!key) throw new Error('key required');

  const db = getFirestore();
  await db.collection('featureFlags').doc(key).set({
    key,
    enabled: enabled ?? true,
    rolloutPct: Math.min(Math.max(rolloutPct ?? 100, 0), 100),
    enabledForRoles: enabledForRoles || [],
    description: description || '',
    updatedBy: req.auth.uid,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   Support Tickets
──────────────────────────────────────────────────────────────────────────── */
exports.adminCreateSupportTicket = onCall({ region: 'us-central1', enforceAppCheck: true, maxInstances: 30 }, exports._h.adminCreateSupportTicket = async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new Error('auth/unauthenticated');
  const { category, subject, message, priority } = req.data;
  if (!subject || !message) throw new Error('subject, message required');

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const u = userSnap.data() || {};

  const ref = await db.collection('supportTickets').add({
    uid,
    email: u.email || '',
    displayName: u.displayName || '',
    category: category || 'general',
    subject: subject.slice(0, 200),
    message: message.slice(0, 2000),
    priority: priority || 'medium',
    status: 'open',
    assignedTo: null,
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { ticketId: ref.id };
});

exports.adminGetSupportTickets = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetSupportTickets = async (req) => {
  _requireAdmin(req);
  const { status, priority, category, limit: lim } = req.data;

  const db = getFirestore();
  let q = db.collection('supportTickets');
  if (status) q = q.where('status', '==', status);
  q = q.limit(Math.min(lim || 100, 300));

  const snap = await q.get();
  let tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // In-memory secondary filters
  if (priority) tickets = tickets.filter(t => t.priority === priority);
  if (category) tickets = tickets.filter(t => t.category === category);
  tickets.sort((a, b) => {
    const pMap = { urgent: 0, high: 1, medium: 2, low: 3 };
    return (pMap[a.priority] || 2) - (pMap[b.priority] || 2);
  });

  return { tickets };
});

exports.adminResolveSupportTicket = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminResolveSupportTicket = async (req) => {
  _requireAdmin(req);
  const { ticketId, resolution, status, assignedTo } = req.data;
  if (!ticketId) throw new Error('ticketId required');

  const db = getFirestore();
  const update = {
    status: status || 'resolved',
    resolution: (resolution || '').slice(0, 1000),
    resolvedBy: req.auth.uid,
    resolvedAt: FieldValue.serverTimestamp(),
  };
  if (assignedTo) update.assignedTo = assignedTo;

  await db.collection('supportTickets').doc(ticketId).update(update);
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   Categories
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetCategories = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetCategories = async (req) => {
  _requireAdmin(req);
  const { hubType } = req.data;
  const db = getFirestore();

  let q = db.collection('categories').limit(500);
  if (hubType) q = q.where('hubType', '==', hubType);

  const snap = await q.get();
  const categories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  categories.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return { categories };
});

exports.adminUpsertCategory = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminUpsertCategory = async (req) => {
  _requireAdmin(req);
  const { categoryId, name, hubType, parentId, description, icon, active } = req.data;
  if (!name || !hubType) throw new Error('name, hubType required');

  const db = getFirestore();
  const data = {
    name: name.slice(0, 100),
    hubType,
    parentId: parentId || null,
    description: (description || '').slice(0, 300),
    icon: icon || '',
    active: active !== false,
    updatedBy: req.auth.uid,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (categoryId) {
    await db.collection('categories').doc(categoryId).set(data, { merge: true });
    return { categoryId };
  }
  data.createdAt = FieldValue.serverTimestamp();
  data.createdBy = req.auth.uid;
  const ref = await db.collection('categories').add(data);
  return { categoryId: ref.id };
});

/* ─────────────────────────────────────────────────────────────────────────
   Executive Dashboard (extended KPIs)
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetExecutiveDashboard = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetExecutiveDashboard = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const { Timestamp } = require('firebase-admin/firestore');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayTs = Timestamp.fromDate(todayStart);

  /* count()-based aggregations — zero document fetches for counts.
     Only txToday fetches docs because revenue summation requires the amount field. */
  const [totalUsersCount, newUsersCount, ordersTodayCount, activeOrdersCount,
         txToday, openTicketsCount, openDisputesCount, activeSubsCount,
         pendingPayoutsCount, activeDeliveriesCount,
         serviceBookingsTodayCount, activeServiceBookingsCount,
         totalProvidersCount, activeProvidersCount, totalOrdersCount, totalBookingsCount, pendingPayoutsSnap] = await Promise.all([
    db.collection('users').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('users').where('createdAt', '>=', todayTs).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('orders').where('createdAt', '>=', todayTs).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('orders').where('status', 'in', ['pending', 'processing', 'confirmed']).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('payments').where('createdAt', '>=', todayTs).limit(1000).get().catch(() => ({ docs: [] })),   /* canonical payment record (`transactions` was empty); status COMPLETE filtered in memory */
    db.collection('supportTickets').where('status', '==', 'open').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('disputes').where('status', '==', 'open').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('subscriptions').where('status', 'in', ['active', 'trialing']).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('payoutRequests').where('status', '==', 'pending').count().get().catch(() => ({ data: () => ({ count: 0 }) })),   /* canonical payout source (matches super-admin queue) */
    db.collection('orders').where('deliveryStatus', 'in', ['in_transit', 'picking_up']).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    /* Service bookings live in providerBookings — NEVER inferred from `orders` (canonical rule).
       Added as NEW fields so the admin.html rendering (other agent's) is never broken. */
    db.collection('providerBookings').where('createdAt', '>=', todayTs).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('providerBookings').where('status', 'in', ['pending', 'confirmed', 'in_progress']).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    /* Canonical platform totals for the command-center overview. */
    db.collection('providers').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('providers').where('status', 'in', ['active', 'approved']).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('orders').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('providerBookings').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('payoutRequests').where('status', '==', 'pending').limit(200).get().catch(() => ({ docs: [] })),
  ]);

  const _paidToday      = (txToday.docs || []).filter(d => String(d.data().status || '').toUpperCase() === 'COMPLETE');
  const revenueToday    = _paidToday.reduce((s, d) => s + (d.data().amount || 0), 0);
  /* Commission is NOT on the raw payment record — it lives in commissionLedger (products) +
     providerPayouts (services). Kept best-effort here; the unified Finance endpoint (Phase 2)
     is the correct aggregation. */
  const commissionToday = _paidToday.reduce((s, d) => s + (d.data().platformFee || d.data().commission || 0), 0);

  return {
    totalUsers: totalUsersCount.data().count, newUsersToday: newUsersCount.data().count,
    ordersToday: ordersTodayCount.data().count, activeOrders: activeOrdersCount.data().count,
    revenueToday, commissionToday,
    openTickets: openTicketsCount.data().count, openDisputes: openDisputesCount.data().count,
    activeSubscriptions: activeSubsCount.data().count, pendingPayouts: pendingPayoutsCount.data().count,
    activeDeliveries: activeDeliveriesCount.data().count,
    /* Canonical service metrics (providerBookings) — new fields for the admin dashboard. */
    serviceBookingsToday: serviceBookingsTodayCount.data().count,
    activeServiceBookings: activeServiceBookingsCount.data().count,
    /* Command-center platform totals (all canonical sources). */
    totalProviders: totalProvidersCount.data().count,
    activeProviders: activeProvidersCount.data().count,
    totalOrders: totalOrdersCount.data().count,
    totalServiceBookings: totalBookingsCount.data().count,
    pendingPayoutAmount: (pendingPayoutsSnap.docs || []).reduce((s, d) => s + (d.data().amount || 0), 0),
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   Unified Finance (Priority 2 — Admin OS Phase 1 canonical sync)

   ONE endpoint that aggregates every finance stream from its CANONICAL source
   (docs/CANONICAL_COLLECTIONS.md → "Reporting rule: aggregate, don't pick one"):

     • payments            → money-in volume + gateway fees (amount − netAmount)
     • commissionLedger    → product/marketplace commission (sokoniCut)
     • providerPayouts     → service revenue (gross) + service commission (commission), settled
     • payoutRequests      → withdrawals: pending (liability in-flight) + paid/completed
     • wallets             → wallet balance = platform liability to users

   Platform revenue = product commission + service commission (NEVER `transactions`
   alone — that misses every service booking). Gateway fees are platform-absorbed
   (Option 1), so netMargin = totalCommission − gatewayFees.

   Index-safe: single-field `createdAt >=` range per collection, all bucketing done
   in memory (today / 7d / 30d). Reads are capped and the cap is reported, so a
   truncated total can never masquerade as complete. */
exports.adminGetFinance = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetFinance = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const { Timestamp } = require('firebase-admin/firestore');

  const DAY = 86400000;
  const now = Date.now();
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const startToday = t0.getTime();
  const start7 = now - 7 * DAY;
  const start30ms = now - 30 * DAY;
  const start30 = Timestamp.fromMillis(start30ms);

  const CAP_TX = 3000, CAP_WALLET = 2000, CAP_REQ = 1000;
  const [paysSnap, commSnap, settleSnap, reqSnap, walletsSnap, ordersSnap] = await Promise.all([
    db.collection('payments').where('createdAt', '>=', start30).limit(CAP_TX).get().catch(() => ({ docs: [] })),
    db.collection('commissionLedger').where('createdAt', '>=', start30).limit(CAP_TX).get().catch(() => ({ docs: [] })),
    db.collection('providerPayouts').where('createdAt', '>=', start30).limit(CAP_TX).get().catch(() => ({ docs: [] })),
    db.collection('payoutRequests').limit(CAP_REQ).get().catch(() => ({ docs: [] })),
    db.collection('wallets').limit(CAP_WALLET).get().catch(() => ({ docs: [] })),
    db.collection('orders').where('createdAt', '>=', start30).limit(CAP_TX).get().catch(() => ({ docs: [] })),   /* product GMV */
  ]);

  const round = (n) => Math.round((n || 0) * 100) / 100;
  const msOf = (c) => (c && c.toDate ? c.toDate().getTime() : (c && c._seconds ? c._seconds * 1000 : 0));
  const emptyBucket = () => ({
    paymentsVolume: 0, gatewayFees: 0,
    productCommission: 0, serviceRevenue: 0, serviceCommission: 0,
    totalCommission: 0, netMargin: 0,
    paymentsCount: 0, settlementsCount: 0,
  });
  const B = { today: emptyBucket(), last7d: emptyBucket(), last30d: emptyBucket() };
  /* apply `fn(bucket)` to every window this timestamp falls inside */
  const forWindows = (t, fn) => {
    if (t >= start30ms) fn(B.last30d);
    if (t >= start7)    fn(B.last7d);
    if (t >= startToday) fn(B.today);
  };

  for (const d of (paysSnap.docs || [])) {
    const x = d.data();
    if (String(x.status || '').toUpperCase() !== 'COMPLETE') continue;
    const amt = Number(x.amount != null ? x.amount : x.amountKES) || 0;
    const net = Number(x.netAmount != null ? x.netAmount : amt) || 0;
    const fee = Math.max(0, amt - net);
    forWindows(msOf(x.createdAt), (b) => { b.paymentsVolume += amt; b.gatewayFees += fee; b.paymentsCount++; });
  }
  for (const d of (commSnap.docs || [])) {
    const x = d.data();
    const cut = Number(x.sokoniCut != null ? x.sokoniCut : x.commission) || 0;
    forWindows(msOf(x.createdAt), (b) => { b.productCommission += cut; });
  }
  for (const d of (settleSnap.docs || [])) {
    const x = d.data();
    if (x.status !== 'settled') continue;   /* only credited settlements are realised revenue */
    const gross = Number(x.gross) || 0;
    const comm  = Number(x.commission) || 0;
    forWindows(msOf(x.createdAt), (b) => { b.serviceRevenue += gross; b.serviceCommission += comm; b.settlementsCount++; });
  }
  for (const k of Object.keys(B)) {
    const b = B[k];
    b.totalCommission = b.productCommission + b.serviceCommission;
    b.netMargin = b.totalCommission - b.gatewayFees;
    for (const f of ['paymentsVolume', 'gatewayFees', 'productCommission', 'serviceRevenue', 'serviceCommission', 'totalCommission', 'netMargin']) b[f] = round(b[f]);
  }

  /* Liability + payout ledger — point-in-time, not windowed. */
  let walletLiability = 0;
  for (const d of (walletsSnap.docs || [])) walletLiability += Number(d.data().balance) || 0;

  const PENDING = new Set(['pending', 'approved', 'processing']);   /* in-flight, still owed */
  const DONE = new Set(['paid', 'completed']);                      /* disbursed via B2C */
  let pendingAmt = 0, pendingCnt = 0, paidAmt = 0, paidCnt = 0;
  for (const d of (reqSnap.docs || [])) {
    const x = d.data(); const a = Number(x.amount) || 0; const s = String(x.status || '').toLowerCase();
    if (PENDING.has(s)) { pendingAmt += a; pendingCnt++; }
    else if (DONE.has(s)) { paidAmt += a; paidCnt++; }
  }

  /* Product GMV (30d) from `orders` — only realised (paid/completed/delivered). */
  const PAID_ORDER = new Set(['paid', 'completed', 'delivered', 'fulfilled']);
  let productGMV = 0, refunds = 0;
  for (const d of (ordersSnap.docs || [])) {
    const x = d.data(); const s = String(x.status || '').toLowerCase();
    const amt = Number(x.total != null ? x.total : x.amount) || 0;
    if (PAID_ORDER.has(s)) productGMV += amt;
    if (s === 'refunded' || x.refunded) refunds += Number(x.refundAmount != null ? x.refundAmount : amt) || 0;
  }

  /* ── SINGLE SOURCE OF TRUTH: the reconciliation summary every dashboard/report
     must consume (never re-compute its own totals). 30-day window + point-in-time
     liability. Net Platform Revenue = commission earned − gateway fees absorbed. */
  const b30 = B.last30d;
  const reconciliation = {
    window: '30d',
    grossRevenue:         round(productGMV + b30.serviceRevenue),   /* product GMV + service GMV */
    productRevenue:       round(productGMV),
    serviceRevenue:       round(b30.serviceRevenue),
    commission:           round(b30.totalCommission),
    productCommission:    round(b30.productCommission),
    serviceCommission:    round(b30.serviceCommission),
    gatewayFees:          round(b30.gatewayFees),
    refunds:              round(refunds),
    walletFloat:          round(walletLiability),
    pendingWithdrawals:   round(pendingAmt),
    completedWithdrawals: round(paidAmt),
    netPlatformRevenue:   round(b30.totalCommission - b30.gatewayFees - refunds),
  };

  return {
    reconciliation,   /* ← the canonical summary; UIs read THIS, not their own math */
    currency: 'KES',
    generatedAt: new Date().toISOString(),
    buckets: B,
    liability: {
      walletBalanceTotal: round(walletLiability),
      walletCount: (walletsSnap.docs || []).length,
      pendingPayoutAmount: round(pendingAmt), pendingPayoutCount: pendingCnt,
      completedPayoutAmount: round(paidAmt), completedPayoutCount: paidCnt,
    },
    /* Truncation honesty — a capped read must never read as a complete total. */
    capped: {
      payments: (paysSnap.docs || []).length >= CAP_TX,
      commissionLedger: (commSnap.docs || []).length >= CAP_TX,
      providerPayouts: (settleSnap.docs || []).length >= CAP_TX,
      payoutRequests: (reqSnap.docs || []).length >= CAP_REQ,
      wallets: (walletsSnap.docs || []).length >= CAP_WALLET,
      orders: (ordersSnap.docs || []).length >= CAP_TX,
    },
    sources: {
      revenue: 'commissionLedger.sokoniCut + providerPayouts.commission',
      productCommission: 'commissionLedger.sokoniCut',
      serviceCommission: 'providerPayouts.commission (settled)',
      serviceRevenue: 'providerPayouts.gross (settled)',
      gatewayFees: 'payments.amount − payments.netAmount (COMPLETE)',
      walletLiability: 'sum(wallets.balance)',
      payouts: 'payoutRequests (pending|approved|processing vs paid|completed)',
    },
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   Payments (M-Pesa pane)

   The admin Payments/M-Pesa pane previously read `payments` DIRECTLY from the
   browser (client Firestore). That read is gated by firestore.rules `isAdmin()`
   — which depends on the ID token carrying a fresh admin claim AND App Check
   passing AND `window.firebaseDB` being the authenticated app instance. When the
   super-admin session hasn't fully propagated the claim yet, that read returns
   permission-denied and the pane shows empty — even though 11 payments exist and
   the query is correct (verified server-side). Routing it through this callable
   (like adminGetBookings/adminGetExecutiveDashboard) validates the token ONCE,
   server-side (_requireAdmin), and reads with the admin SDK — no rules-timing,
   no App-Check-on-raw-read, no which-app ambiguity. Same reliability as the panes
   that already work. Canonical source unchanged: `payments`.
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetPayments = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetPayments = async (req) => {
  _requireAdmin(req);
  const { hub, limit: lim } = req.data || {};
  const db = getFirestore();
  /* single-field orderBy(createdAt) → built-in index, no composite needed. */
  const snap = await db.collection('payments').orderBy('createdAt', 'desc').limit(Math.min(lim || 200, 500)).get().catch(() => ({ docs: [] }));
  let rows = (snap.docs || []).map(d => {
    const x = d.data(); const meta = x.meta || {};
    return {
      id: d.id,
      amount: Number(x.amount != null ? x.amount : x.amountKES) || 0,
      status: x.status || '',
      phone: x.phone || meta.phone || '',
      mpesaCode: x.mpesaCode || x.mpesaReceipt || x.mpesaReceiptNumber || meta.mpesaCode || '',
      sellerName: x.sellerName || meta.sellerName || meta.providerName || '',
      sellerUid: meta.sellerId || meta.providerId || x.uid || '',
      hub: meta.hub || meta.category || meta.hubType || '',
      orderId: x.orderId || meta.orderId || x.ref || d.id,
      createdAtMs: x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().getTime() : null,
    };
  });
  if (hub) rows = rows.filter(r => r.hub === hub);
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const startTodayMs = startToday.getTime();
  return {
    payments: rows,
    count: rows.length,
    totalVolume: rows.reduce((s, r) => s + r.amount, 0),
    todayCount: rows.filter(r => r.createdAtMs && r.createdAtMs >= startTodayMs).length,
    sellerCount: new Set(rows.map(r => r.sellerUid).filter(Boolean)).size,
  };
});

/* ═══════════════════════════════════════════════════════════════════════════
   CANONICAL ADMIN READ CONTRACT — the single authenticated server API

   Every admin module reads through one of these callables (via adminOsDispatch),
   NEVER directly from client Firestore. Each one: _requireAdmin + App Check
   (enforced on the callable) → canonical collection → normalized JSON in a
   { source, count, items, generatedAt } envelope for the module's diagnostics.

   Index-safe by construction: a BOUNDED fetch + in-memory sort — never a bare
   orderBy() on a field some docs may lack (which silently drops them, the exact
   class of bug that made panes read empty). Caps are generous for the current
   scale and can move to keyset pagination when a collection outgrows them.
   ═══════════════════════════════════════════════════════════════════════════ */
const _iso = (v) => (v && v.toDate ? v.toDate().toISOString() : (v && v._seconds ? new Date(v._seconds * 1000).toISOString() : null));
const _ms  = (v) => (v && v.toDate ? v.toDate().getTime()  : (v && v._seconds ? v._seconds * 1000 : 0));
const _env = (source, items, extra) => Object.assign({ source, count: items.length, items, generatedAt: new Date().toISOString() }, extra || {});
/* Generic bounded fetch → id + raw data + createdAt ISO, newest first. For
   collections whose schema the UI consumes wholesale (disputes/reviews/etc.). */
async function _listCanonical(col, { limit: lim, cap = 1000 } = {}) {
  const db = getFirestore();
  const snap = await db.collection(col).limit(Math.min(lim || cap, 2000)).get().catch(() => ({ docs: [] }));
  const items = (snap.docs || []).map(d => { const x = d.data() || {}; return Object.assign({ id: d.id }, x, { createdAt: _iso(x.createdAt) || _iso(x.timestamp) || null, _ms: _ms(x.createdAt) || _ms(x.timestamp) }); });
  items.sort((a, b) => b._ms - a._ms);
  items.forEach(i => { delete i._ms; });
  return items;
}

exports.adminGetUsers = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetUsers = async (req) => {
  _requireAdmin(req);
  const { limit: lim, search } = req.data || {};
  const db = getFirestore();
  const snap = await db.collection('users').limit(Math.min(lim || 1000, 2000)).get().catch(() => ({ docs: [] }));
  let items = (snap.docs || []).map(d => { const x = d.data() || {}; return {
    uid: d.id, name: x.name || x.displayName || '', email: x.email || '', phone: x.phoneNumber || x.phone || '',
    roles: x.roles || [], role: x.role || '', status: x.status || '', disabled: !!x.disabled,
    createdAt: _iso(x.createdAt), _ms: _ms(x.createdAt) }; });
  items.sort((a, b) => b._ms - a._ms);
  if (search) { const q = String(search).toLowerCase(); items = items.filter(u => (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || String(u.phone || '').includes(q)); }
  items.forEach(u => { delete u._ms; });
  return _env('users', items);
});

exports.adminGetProviders = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetProviders = async (req) => {
  _requireAdmin(req);
  const { limit: lim, search } = req.data || {};
  const db = getFirestore();
  const snap = await db.collection('providers').limit(Math.min(lim || 1000, 2000)).get().catch(() => ({ docs: [] }));
  let items = (snap.docs || []).map(d => { const x = d.data() || {}; return {
    uid: d.id, name: x.name || x.businessName || '', email: x.email || '', category: x.category || '',
    location: x.location || '', status: x.status || '', verified: !!x.verified, available: !!x.available,
    rating: x.rating || 0, jobsCompleted: x.jobsCompleted || 0, acceptsBookings: !!x.acceptsBookings,
    createdAt: _iso(x.createdAt), updatedAt: _iso(x.updatedAt), _ms: _ms(x.createdAt) }; });
  items.sort((a, b) => b._ms - a._ms);
  if (search) { const q = String(search).toLowerCase(); items = items.filter(p => (p.name || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)); }
  const active = items.filter(p => ['active', 'approved'].includes(String(p.status).toLowerCase())).length;
  const verified = items.filter(p => p.verified).length;
  items.forEach(p => { delete p._ms; });
  return _env('providers', items, { active, verified, pending: items.length - active });
});

exports.adminGetServices = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetServices = async (req) => {
  _requireAdmin(req);
  const { limit: lim, providerId } = req.data || {};
  const db = getFirestore();
  let ref = db.collection('providerServices');
  if (providerId) ref = ref.where('providerId', '==', providerId);
  const snap = await ref.limit(Math.min(lim || 1000, 2000)).get().catch(() => ({ docs: [] }));
  const items = (snap.docs || []).map(d => { const x = d.data() || {}; return {
    id: d.id, name: x.name || x.title || '', price: Number(x.price) || 0, duration: x.duration || x.durationMinutes || null,
    category: x.category || '', providerId: x.providerId || x.uid || '', providerName: x.providerName || '',
    status: x.status || '', active: x.active !== false, createdAt: _iso(x.createdAt), _ms: _ms(x.createdAt) }; });
  items.sort((a, b) => b._ms - a._ms);
  items.forEach(i => { delete i._ms; });
  return _env('providerServices', items);
});

exports.adminGetWallets = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetWallets = async (req) => {
  _requireAdmin(req);
  const { limit: lim } = req.data || {};
  const db = getFirestore();
  const snap = await db.collection('wallets').limit(Math.min(lim || 1000, 2000)).get().catch(() => ({ docs: [] }));
  const items = (snap.docs || []).map(d => { const x = d.data() || {}; return {
    uid: d.id, balance: Number(x.balance) || 0, pendingPayout: Number(x.pendingPayout) || 0,
    currency: x.currency || 'KES', updatedAt: _iso(x.updatedAt), _bal: Number(x.balance) || 0 }; });
  items.sort((a, b) => b._bal - a._bal);
  const totalLiability = items.reduce((s, w) => s + w.balance, 0);
  items.forEach(w => { delete w._bal; });
  return _env('wallets', items, { totalLiability: Math.round(totalLiability * 100) / 100 });
});

exports.adminGetPayoutRequests = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetPayoutRequests = async (req) => {
  _requireAdmin(req);
  const { status, limit: lim } = req.data || {};
  const db = getFirestore();
  const snap = await db.collection('payoutRequests').limit(Math.min(lim || 500, 1000)).get().catch(() => ({ docs: [] }));
  let items = (snap.docs || []).map(d => { const x = d.data() || {}; return {
    id: d.id, amount: Number(x.amount) || 0, status: String(x.status || '').toLowerCase(),
    sellerUid: x.sellerUid || x.uid || '', sellerName: x.sellerName || x.name || '',
    phone: x.accountNumber || x.phone || '', reference: x.reference || x.ref || d.id,
    createdAt: _iso(x.createdAt), _ms: _ms(x.createdAt) }; });
  items.sort((a, b) => b._ms - a._ms);
  const byStatus = items.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const pendingSet = new Set(['pending', 'approved', 'processing']);
  const pendingAmount = items.filter(r => pendingSet.has(r.status)).reduce((s, r) => s + r.amount, 0);
  if (status) items = items.filter(r => r.status === String(status).toLowerCase());
  items.forEach(r => { delete r._ms; });
  return _env('payoutRequests', items, { byStatus, pendingAmount: Math.round(pendingAmount * 100) / 100 });
});

exports.adminGetAnalytics = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetAnalytics = async (req) => {
  _requireAdmin(req);
  const { limit: lim, providerId } = req.data || {};
  const db = getFirestore();
  let ref = db.collection('providerAnalytics');
  if (providerId) ref = ref.where('providerId', '==', providerId);
  const snap = await ref.limit(Math.min(lim || 1000, 2000)).get().catch(() => ({ docs: [] }));
  const items = (snap.docs || []).map(d => { const x = d.data() || {}; return {
    id: d.id, providerId: x.providerId || (d.id.split('_')[0]) || '', date: x.date || (d.id.split('_')[1]) || '',
    bookingsCompleted: x.bookingsCompleted || 0, grossCents: x.grossCents || 0, commissionCents: x.commissionCents || 0,
    netCents: x.netCents || 0 }; });
  const totals = items.reduce((t, r) => { t.bookingsCompleted += r.bookingsCompleted; t.grossCents += r.grossCents; t.commissionCents += r.commissionCents; t.netCents += r.netCents; return t; }, { bookingsCompleted: 0, grossCents: 0, commissionCents: 0, netCents: 0 });
  return _env('providerAnalytics', items, { totals });
});

exports.adminGetDisputes = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetDisputes = async (req) => {
  _requireAdmin(req);
  const items = await _listCanonical('disputes', req.data || {});
  return _env('disputes', items, { open: items.filter(d => String(d.status || '').toLowerCase() === 'open').length });
});

exports.adminGetReviews = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetReviews = async (req) => {
  _requireAdmin(req);
  const items = await _listCanonical('reviews', req.data || {});
  return _env('reviews', items, { flagged: items.filter(r => r.flagged || r.reported).length });
});

exports.adminGetNotifications = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetNotifications = async (req) => {
  _requireAdmin(req);
  const items = await _listCanonical('notifications', Object.assign({ cap: 200 }, req.data || {}));
  return _env('notifications', items);
});

exports.adminGetSupportTickets = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetSupportTickets = async (req) => {
  _requireAdmin(req);
  const items = await _listCanonical('supportTickets', req.data || {});
  return _env('supportTickets', items, { open: items.filter(t => String(t.status || '').toLowerCase() === 'open').length });
});

/* Contract aliases — same handler, canonical name the Command Center calls. */
exports._h.adminGetOverview = exports._h.adminGetExecutiveDashboard;
exports._h.adminGetReports  = exports._h.adminGetFinance;

/* ─────────────────────────────────────────────────────────────────────────
   Orders
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetOrders = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetOrders = async (req) => {
  _requireAdmin(req);
  const { status, hubType, limit: lim } = req.data;
  const db = getFirestore();
  let q = db.collection('orders').orderBy('createdAt', 'desc').limit(Math.min(lim || 50, 200));
  if (status) q = q.where('status', '==', status);
  const snap = await q.get();
  let orders = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null }));
  if (hubType) orders = orders.filter(o => o.hubType === hubType || o.type === hubType);
  return { orders };
});

exports.adminUpdateOrderStatus = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminUpdateOrderStatus = async (req) => {
  _requireAdmin(req);
  const { orderId, status, note } = req.data;
  if (!orderId || !status) throw new Error('orderId and status required');
  const db = getFirestore();
  await db.collection('orders').doc(orderId).update({ status, adminNote: note || null, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.auth.uid });
  await db.collection('adminAudit').add({ action: 'order_status_updated', orderId, status, performedBy: req.auth.uid, createdAt: FieldValue.serverTimestamp() });
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   Marketplace (Products)
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetProducts = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetProducts = async (req) => {
  _requireAdmin(req);
  const { status, query, limit: lim } = req.data;
  const db = getFirestore();
  let q = db.collection('products').orderBy('createdAt', 'desc').limit(Math.min(lim || 50, 200));
  if (status && status !== 'all') q = q.where('status', '==', status);
  const snap = await q.get();
  let items = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null }));
  if (query) { const ql = query.toLowerCase(); items = items.filter(p => (p.name||'').toLowerCase().includes(ql) || (p.sellerId||'') === query); }
  return { products: items };
});

exports.adminUpdateProductStatus = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminUpdateProductStatus = async (req) => {
  _requireAdmin(req);
  const { productId, status, featured, reason } = req.data;
  if (!productId || !status) throw new Error('productId and status required');
  const db = getFirestore();
  const upd = { status, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.auth.uid };
  if (featured !== undefined) upd.featured = featured;
  if (reason) upd.adminNote = reason;
  await db.collection('products').doc(productId).update(upd);
  await db.collection('adminAudit').add({ action: 'product_status_updated', productId, status, featured, performedBy: req.auth.uid, createdAt: FieldValue.serverTimestamp() });
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   Bookings
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetBookings = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetBookings = async (req) => {
  _requireAdmin(req);
  const { status, limit: lim } = req.data;
  const db = getFirestore();
  /* Service bookings are the canonical providerBookings collection (booking-service.js),
     NOT the venue `bookings` collection — the admin Bookings view was blind to every
     service booking (DJ, mechanic, etc.). Single-field query + in-memory sort avoids a
     status+createdAt composite index. Return shape unchanged ({ bookings: [...] }). */
  const cap = Math.min(lim || 50, 200);
  const q = status
    ? db.collection('providerBookings').where('status', '==', status).limit(cap)
    : db.collection('providerBookings').orderBy('createdAt', 'desc').limit(cap);
  const snap = await q.get().catch(() => ({ docs: [] }));
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null }));
  if (status) rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return { bookings: rows };
});

/* ─────────────────────────────────────────────────────────────────────────
   Delivery Operations
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetDeliveryStats = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetDeliveryStats = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const { Timestamp } = require('firebase-admin/firestore');
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const [inTransit, activeDrivers, completedToday] = await Promise.all([
    db.collection('orders').where('deliveryStatus', 'in', ['in_transit', 'picking_up']).limit(100).get().catch(() => ({ docs: [], size: 0 })),
    db.collection('drivers').where('onlineStatus', '==', 'online').limit(200).get().catch(() => ({ size: 0, docs: [] })),
    db.collection('orders').where('deliveryStatus', '==', 'delivered').where('deliveredAt', '>=', Timestamp.fromDate(todayStart)).get().catch(() => ({ size: 0 })),
  ]);
  return {
    activeDeliveries: inTransit.size,
    activeDrivers: activeDrivers.size,
    completedToday: completedToday.size,
    recentDeliveries: (inTransit.docs || []).slice(0, 20).map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null })),
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   Payouts
──────────────────────────────────────────────────────────────────────────── */
/* Dispatcher key namespaced aosGetPendingPayouts to avoid a cross-domain name
   clash with the global payouts CF. Caller: sokoni-aos.js _call('aosGetPendingPayouts'). */
exports.adminGetPendingPayouts = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.aosGetPendingPayouts = async (req) => {
  _requireAdmin(req);
  /* Canonical source is `payoutRequests` (what requestSellerPayout writes and
     super-admin.html reads). Was reading the stale `payouts` collection, so this admin
     view showed 0 while real withdrawals sat in payoutRequests. Single-field query
     (sort in memory) mirrors wallet.js adminGetPendingPayouts — no composite index. */
  const snap = await getFirestore().collection('payoutRequests').where('status', '==', 'pending').limit(100).get().catch(() => ({ docs: [] }));
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null }));
  rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return { payouts: rows };
});

exports.adminApprovePayouts = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminApprovePayouts = async (req) => {
  _requireSuperAdmin(req);
  const { payoutIds } = req.data;
  if (!Array.isArray(payoutIds) || !payoutIds.length) throw new Error('payoutIds array required');
  const db = getFirestore();
  const batch = db.batch();
  payoutIds.forEach(id => { batch.update(db.collection('payouts').doc(id), { status: 'approved', approvedBy: req.auth.uid, approvedAt: FieldValue.serverTimestamp() }); });
  await batch.commit();
  await db.collection('adminAudit').add({ action: 'payouts_approved', count: payoutIds.length, performedBy: req.auth.uid, createdAt: FieldValue.serverTimestamp() });
  return { success: true, count: payoutIds.length };
});

/* ─────────────────────────────────────────────────────────────────────────
   Disputes
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetDisputes = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetDisputes = async (req) => {
  _requireAdmin(req);
  const { status, limit: lim } = req.data;
  const db = getFirestore();
  let q = db.collection('disputes').orderBy('createdAt', 'desc').limit(Math.min(lim || 50, 200));
  if (status) q = q.where('status', '==', status);
  const snap = await q.get().catch(() => ({ docs: [] }));
  return { disputes: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null })) };
});

exports.adminResolveDispute = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.aosResolveDispute = async (req) => {
  _requireAdmin(req);
  const { disputeId, resolution, favorBuyer } = req.data;
  if (!disputeId || !resolution) throw new Error('disputeId and resolution required');
  const db = getFirestore();
  await db.collection('disputes').doc(disputeId).update({ status: 'resolved', resolution, favorBuyer: !!favorBuyer, resolvedBy: req.auth.uid, resolvedAt: FieldValue.serverTimestamp() });
  await db.collection('adminAudit').add({ action: 'dispute_resolved', disputeId, favorBuyer, performedBy: req.auth.uid, createdAt: FieldValue.serverTimestamp() });
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   Reviews
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetReviews = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetReviews = async (req) => {
  _requireAdmin(req);
  const { flagged, limit: lim } = req.data;
  const db = getFirestore();
  const q = flagged
    ? db.collection('reviews').where('flagged', '==', true).limit(Math.min(lim || 50, 200))
    : db.collection('reviews').orderBy('createdAt', 'desc').limit(Math.min(lim || 50, 200));
  const snap = await q.get().catch(() => ({ docs: [] }));
  return { reviews: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null })) };
});

exports.adminRemoveReview = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminRemoveReview = async (req) => {
  _requireAdmin(req);
  const { reviewId, reason } = req.data;
  if (!reviewId) throw new Error('reviewId required');
  const db = getFirestore();
  await db.collection('reviews').doc(reviewId).update({ status: 'removed', removedBy: req.auth.uid, removedReason: reason || '', removedAt: FieldValue.serverTimestamp() });
  await db.collection('adminAudit').add({ action: 'review_removed', reviewId, reason, performedBy: req.auth.uid, createdAt: FieldValue.serverTimestamp() });
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   Push Notifications
──────────────────────────────────────────────────────────────────────────── */
exports.adminSendPushNotification = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminSendPushNotification = async (req) => {
  _requireAdmin(req);
  const { title, body, targetRole, targetAll, data: extraData, imageUrl } = req.data;
  if (!title || !body) throw new Error('title and body required');
  const db = getFirestore();
  const doc = await db.collection('platformNotifications').add({
    title: title.slice(0, 100), body: body.slice(0, 500),
    targetRole: targetRole || null, targetAll: targetAll !== false,
    imageUrl: imageUrl || null, data: extraData || {},
    sentBy: req.auth.uid, status: 'queued', createdAt: FieldValue.serverTimestamp(),
  });
  await db.collection('adminAudit').add({ action: 'push_notification_sent', notificationId: doc.id, title, targetRole: targetRole || 'all', performedBy: req.auth.uid, createdAt: FieldValue.serverTimestamp() });
  return { success: true, notificationId: doc.id };
});

exports.adminGetRecentNotifications = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetRecentNotifications = async (req) => {
  _requireAdmin(req);
  const snap = await getFirestore().collection('platformNotifications').orderBy('createdAt', 'desc').limit(30).get().catch(() => ({ docs: [] }));
  return { notifications: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null })) };
});

/* ─────────────────────────────────────────────────────────────────────────
   Banners / Content
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetBanners = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetBanners = async (req) => {
  _requireAdmin(req);
  const snap = await getFirestore().collection('banners').orderBy('order').limit(50).get().catch(() => ({ docs: [] }));
  return { banners: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

exports.adminSaveBanner = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminSaveBanner = async (req) => {
  _requireAdmin(req);
  const { id, title, imageUrl, linkUrl, active, order: ord, hub, subtitle } = req.data;
  if (!title || !imageUrl) throw new Error('title and imageUrl required');
  const db = getFirestore();
  const data = { title: title.slice(0, 100), subtitle: (subtitle || '').slice(0, 200), imageUrl, linkUrl: linkUrl || '', active: active !== false, hub: hub || 'all', order: ord || 0, updatedBy: req.auth.uid, updatedAt: FieldValue.serverTimestamp() };
  if (id) { await db.collection('banners').doc(id).update(data); return { id }; }
  data.createdAt = FieldValue.serverTimestamp();
  const ref = await db.collection('banners').add(data);
  return { id: ref.id };
});

exports.adminDeleteBanner = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminDeleteBanner = async (req) => {
  _requireAdmin(req);
  const { id } = req.data;
  if (!id) throw new Error('id required');
  await getFirestore().collection('banners').doc(id).delete();
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   FAQs
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetFaqs = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetFaqs = async (req) => {
  _requireAdmin(req);
  const snap = await getFirestore().collection('faqs').orderBy('order').limit(200).get().catch(() => ({ docs: [] }));
  return { faqs: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

exports.adminUpsertFaq = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminUpsertFaq = async (req) => {
  _requireAdmin(req);
  const { id, question, answer, category, order: ord, active } = req.data;
  if (!question || !answer) throw new Error('question and answer required');
  const db = getFirestore();
  const data = { question: question.slice(0, 300), answer: answer.slice(0, 2000), category: category || 'general', order: ord || 0, active: active !== false, updatedBy: req.auth.uid, updatedAt: FieldValue.serverTimestamp() };
  if (id) { await db.collection('faqs').doc(id).update(data); return { id }; }
  data.createdAt = FieldValue.serverTimestamp();
  const ref = await db.collection('faqs').add(data);
  return { id: ref.id };
});

exports.adminDeleteFaq = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminDeleteFaq = async (req) => {
  _requireAdmin(req);
  const { id } = req.data;
  if (!id) throw new Error('id required');
  await getFirestore().collection('faqs').doc(id).delete();
  return { success: true };
});

/* ─────────────────────────────────────────────────────────────────────────
   Announcements
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetAnnouncements = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetAnnouncements = async (req) => {
  _requireAdmin(req);
  const snap = await getFirestore().collection('announcements').orderBy('createdAt', 'desc').limit(50).get().catch(() => ({ docs: [] }));
  return { announcements: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null })) };
});

exports.adminSaveAnnouncement = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminSaveAnnouncement = async (req) => {
  _requireAdmin(req);
  const { id, title, body, targetRole, active, urgent } = req.data;
  if (!title || !body) throw new Error('title and body required');
  const db = getFirestore();
  const data = { title: title.slice(0, 100), body: body.slice(0, 1000), targetRole: targetRole || 'all', active: active !== false, urgent: urgent || false, updatedBy: req.auth.uid, updatedAt: FieldValue.serverTimestamp() };
  if (id) { await db.collection('announcements').doc(id).update(data); return { id }; }
  data.createdAt = FieldValue.serverTimestamp();
  const ref = await db.collection('announcements').add(data);
  return { id: ref.id };
});

/* ─────────────────────────────────────────────────────────────────────────
   SmartPOS
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetPosDevices = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetPosDevices = async (req) => {
  _requireAdmin(req);
  const snap = await getFirestore().collection('posDevices').orderBy('lastSeen', 'desc').limit(100).get().catch(() => ({ docs: [] }));
  return { devices: snap.docs.map(d => ({ id: d.id, ...d.data(), lastSeen: d.data().lastSeen?.toDate?.()?.toISOString() || null })) };
});

/* ─────────────────────────────────────────────────────────────────────────
   AI Operations
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetAiStats = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetAiStats = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const usageSnap = await db.collection('aiUsage').orderBy('date', 'desc').limit(14).get().catch(() => ({ docs: [] }));
  const totalTokens = usageSnap.docs.reduce((s, d) => s + (d.data().totalTokens || 0), 0);
  return { usageByDay: usageSnap.docs.map(d => ({ date: d.id, ...d.data() })), totalTokens, estimatedCostUsd: Math.round(totalTokens * 0.00000025 * 100) / 100 };
});

/* ─────────────────────────────────────────────────────────────────────────
   Search Management
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetSearchStats = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetSearchStats = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const [trendingSnap, queueSnap] = await Promise.all([
    db.collection('searchInsights').orderBy('count', 'desc').limit(20).get().catch(() => ({ docs: [] })),
    db.collection('searchQueue').where('status', '==', 'pending').limit(1).get().catch(() => ({ size: 0 })),
  ]);
  return { trendingSearches: trendingSnap.docs.map(d => ({ term: d.id, ...d.data() })), pendingQueue: queueSnap.size };
});

/* ─────────────────────────────────────────────────────────────────────────
   Fraud Center
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetFraudAlerts = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetFraudAlerts = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const [riskSnap, chargebackSnap, dupSnap] = await Promise.all([
    db.collection('riskFlags').where('resolved', '==', false).orderBy('createdAt', 'desc').limit(30).get().catch(() => ({ docs: [] })),
    db.collection('transactions').where('status', '==', 'chargeback').orderBy('createdAt', 'desc').limit(20).get().catch(() => ({ docs: [] })),
    db.collection('users').where('isDuplicate', '==', true).limit(20).get().catch(() => ({ docs: [] })),
  ]);
  return {
    riskFlags: riskSnap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null })),
    chargebacks: chargebackSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    duplicateAccounts: dupSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   Audit Logs
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetAuditLogs = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetAuditLogs = async (req) => {
  _requireAdmin(req);
  const { action, limit: lim } = req.data;
  const db = getFirestore();
  let q = db.collection('adminAudit').orderBy('createdAt', 'desc').limit(Math.min(lim || 100, 500));
  if (action) q = q.where('action', '==', action);
  const snap = await q.get().catch(() => ({ docs: [] }));
  return { logs: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null })) };
});

/* ─────────────────────────────────────────────────────────────────────────
   Featured Shops — server-authoritative visibility (P4)

   WHY A DEDICATED COLLECTION. The pre-existing "featured shop" mechanism
   (sokoni-spotlight.js) queried `shopSettings where featuredOnHome==true`, but
   shopSettings is per-owner readable ONLY and holds live M-Pesa/Daraja secrets
   (darajaConsumerSecret, darajaPassKey). An anonymous homepage cannot read it,
   and it must never be widened. `users/{uid}` is likewise self/admin-only (PII).
   So featured state lives in `featuredShops/{merchantUid}` — a SECRETS-FREE
   projection: public-readable only while actively featured (enforced in rules),
   admin-writable only. This is infrastructure; no reader/UI is changed here. The
   catalogue-convergence step will repoint sokoni-spotlight.js at this collection.

   These handlers register in the `_h` registry only (no standalone onCall), so
   they add NO new deployed function — they ride the already-invokable
   adminOsDispatch. Call as adminOsDispatch({ op:'adminSetFeaturedShop', ... }).

   NB: KASS SHOP is featured through this identical path (adminSetFeaturedShop
   with its merchantUid) — never hardcoded, never special-cased.
──────────────────────────────────────────────────────────────────────────── */

/* Only these display fields are ever copied into the public projection. A strict
   allow-list guarantees no shopSettings secret (daraja*) can leak into a
   world-readable doc, regardless of what else the source docs carry. */
const _FEATURED_SAFE_FIELDS = ['shopName', 'logo', 'logoUrl', 'category',
  'categoryLabel', 'location', 'rating', 'totalSales', 'handle', 'shopHandle', 'storeUrl'];

function _buildShopProjection(userData, settingsData) {
  const src = Object.assign({}, userData || {}, settingsData || {});   // settings wins for display
  const out = {};
  for (const k of _FEATURED_SAFE_FIELDS) {
    if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  // Normalise the two logo spellings and business-name fallbacks into stable keys.
  out.shopName = out.shopName || src.businessName || src.name || 'SOKONI Shop';
  out.logo     = out.logo || out.logoUrl || src.photoURL || '';
  delete out.logoUrl;
  return out;
}

exports._h.adminSetFeaturedShop = async (req) => {
  _requireAdmin(req);
  const { merchantUid, featured = true, priority = 0, untilMs = null, reason = '' } = req.data || {};
  if (!merchantUid || typeof merchantUid !== 'string') {
    throw new HttpsError('invalid-argument', 'merchantUid is required');
  }
  const db = getFirestore();
  const { Timestamp } = require('firebase-admin/firestore');

  // Reuse existing records — confirm the merchant exists; never invent one.
  const userSnap = await db.collection('users').doc(merchantUid).get();
  if (!userSnap.exists) throw new HttpsError('not-found', 'No user record for that merchantUid');
  const settingsSnap = await db.collection('shopSettings').doc(merchantUid).get().catch(() => null);

  const projection = _buildShopProjection(userSnap.data(), settingsSnap && settingsSnap.exists ? settingsSnap.data() : null);
  const until = (untilMs && Number(untilMs) > 0) ? Timestamp.fromMillis(Number(untilMs)) : null;

  const doc = Object.assign({}, projection, {
    merchantUid,
    featuredOnHome: featured === true,
    featuredPriority: Number(priority) || 0,
    featuredUntil: until,
    featuredReason: String(reason || '').slice(0, 500),
    featuredBy: req.auth.uid,
    updatedAt: FieldValue.serverTimestamp(),
  });
  // Preserve the original featuredAt across re-features; set it on first feature.
  const existing = await db.collection('featuredShops').doc(merchantUid).get().catch(() => null);
  if (!existing || !existing.exists) doc.featuredAt = FieldValue.serverTimestamp();

  await db.collection('featuredShops').doc(merchantUid).set(doc, { merge: true });

  // Audit trail, consistent with adminGetAuditLogs (reads adminAudit).
  await db.collection('adminAudit').add({
    action: featured ? 'featured_shop_set' : 'featured_shop_cleared',
    merchantUid, priority: doc.featuredPriority, reason: doc.featuredReason,
    actor: req.auth.uid, createdAt: FieldValue.serverTimestamp(),
  }).catch(() => {});

  return { ok: true, merchantUid, featuredOnHome: doc.featuredOnHome, projection };
};

exports._h.adminListFeaturedShops = async (req) => {
  _requireAdmin(req);
  const { activeOnly = false, limit: lim } = req.data || {};
  const db = getFirestore();
  let q = db.collection('featuredShops');
  if (activeOnly) q = q.where('featuredOnHome', '==', true);
  q = q.orderBy('featuredPriority', 'desc').limit(Math.min(Number(lim) || 100, 500));
  const snap = await q.get().catch(() => ({ docs: [] }));
  return {
    shops: snap.docs.map((d) => {
      const x = d.data();
      return Object.assign({}, x, {
        featuredUntil: x.featuredUntil?.toDate?.()?.toISOString() || null,
        featuredAt: x.featuredAt?.toDate?.()?.toISOString() || null,
        updatedAt: x.updatedAt?.toDate?.()?.toISOString() || null,
      });
    }),
  };
};
