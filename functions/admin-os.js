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

  return { tickets, items: tickets, count: tickets.length };
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
         totalProvidersCount, activeProvidersCount, totalOrdersCount, totalBookingsCount, pendingPayoutsSnap,
         activeUsersCount, merchantsCount, pendingVerifCount, pendingAppsCount, reviewsToModerateCount] = await Promise.all([
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
    /* P1 command-center additions — all canonical counts, catch→0 (never fabricate). */
    db.collection('users').where('status', '==', 'active').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('businesses').where('status', '==', 'active').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    /* OB-4 — the CANONICAL field on THIS collection is `status`. This queried
       `verificationStatus`, which is the field the MIRROR on providerProfiles/{uid}
       carries — not the one the writer of providerVerification sets. Both writers
       (providerSubmitVerification, adminDecideProviderVerification) write `status`,
       so this counter matched nothing and the queue read 0 however much work was
       waiting. A document with no `status` is still excluded, which is correct:
       unknown is not pending, and a queue must not be inflated by records whose
       state nobody has established. */
    db.collection('providerVerification').where('status', '==', 'pending_review').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('applications').where('status', '==', 'pending').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('reviews').where('status', '==', 'pending').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
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
    /* P1 command-center additions (canonical). */
    activeUsers: activeUsersCount.data().count,
    merchants: merchantsCount.data().count,
    pendingProviderVerification: pendingVerifCount.data().count,
    pendingMerchantApprovals: pendingAppsCount.data().count,
    reviewsAwaitingModeration: reviewsToModerateCount.data().count,
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   System Health (P2) — thin aggregation of REAL signals. Per-service status is
   ok | warn | issue | unknown. 'unknown' is honest (no fabricated green): services
   without a cheap server-side signal are reported as unknown, not healthy.
   Reads: systemHealth/latest (platform rollup), emailQueue/emailLogs, orders (payment
   liveness), payoutRequests (wallet failures). Read-only; no business logic.
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetSystemHealth = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetSystemHealth = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const { Timestamp } = require('firebase-admin/firestore');
  const dayAgo  = Timestamp.fromDate(new Date(Date.now() - 86400000));
  const hourAgo = Timestamp.fromDate(new Date(Date.now() - 3600000));
  const _c0 = () => ({ data: () => ({ count: 0 }) });

  const [latestSnap, emailQ, emailFails, paidOrders, payoutFails] = await Promise.all([
    db.collection('systemHealth').doc('latest').get().catch(() => null),
    db.collection('emailQueue').count().get().catch(_c0),
    db.collection('emailLogs').where('status', '==', 'failed').where('createdAt', '>=', hourAgo).count().get().catch(_c0),
    db.collection('orders').where('status', 'in', ['paid', 'completed', 'delivered']).where('createdAt', '>=', dayAgo).limit(1).get().catch(() => ({ empty: true })),
    db.collection('payoutRequests').where('status', 'in', ['failed', 'approval_failed']).where('createdAt', '>=', dayAgo).count().get().catch(_c0),
  ]);

  const L = latestSnap && latestSnap.exists ? latestSnap.data() : null;
  const eq = emailQ.data().count, ef = emailFails.data().count, pf = payoutFails.data().count;
  const paymentsAlive = !(paidOrders.empty);
  const s = (status, detail) => ({ status, detail: detail || null });

  const services = {
    cloudFunctions: L ? (L.firestoreOk ? s(L.overallStatus === 'critical' ? 'issue' : L.overallStatus === 'degraded' ? 'warn' : 'ok', 'async queue ' + (L.asyncQueueDepth != null ? L.asyncQueueDepth : '—') + (L.criticalAlertsUnacked > 0 ? ' · ' + L.criticalAlertsUnacked + ' critical alerts' : '')) : s('issue', 'Firestore probe failing')) : s('unknown', 'no snapshot'),
    payments:       s(paymentsAlive ? 'ok' : 'warn', paymentsAlive ? 'paid orders in last 24h' : 'no paid orders in 24h'),
    wallet:         s(pf > 0 ? 'warn' : 'ok', pf > 0 ? pf + ' payout failure(s) in 24h' : 'no recent payout failures'),
    email:          s(ef > 5 ? 'issue' : (ef > 0 || eq > 100) ? 'warn' : 'ok', ef + ' failures/hr · queue ' + eq),
    search:         s('unknown', 'detail in search-monitor'),
    sms:            s('unknown', 'no server signal'),
    notifications:  s('unknown', 'no server signal'),
    storage:        s('unknown', 'no server signal'),
    etims:          s('unknown', 'sandbox — not deployed'),
  };
  const ov = L && L.overallStatus;
  return {
    services,
    overall: ov === 'healthy' ? 'ok' : ov === 'degraded' ? 'warn' : ov === 'critical' ? 'issue' : 'unknown',
    checkedAt:  new Date().toISOString(),
    snapshotAt: (L && L.ts && L.ts.toDate) ? L.ts.toDate().toISOString() : null,
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   Merchant Pipeline (P2) — thin funnel aggregation over canonical collections.
   Applied → Pending Review → Verified → Published → Subscribed → Active. Every stage
   is a count()+catch→0. Lets operators spot bottlenecks. Read-only, no business logic.
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetMerchantPipeline = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetMerchantPipeline = async (req) => {
  _requireAdmin(req);
  const db = getFirestore();
  const _c0 = () => ({ data: () => ({ count: 0 }) });
  const [applied, pending, verified, published, subscribed, active] = await Promise.all([
    db.collection('applications').count().get().catch(_c0),
    db.collection('applications').where('status', '==', 'pending').count().get().catch(_c0),
    /* OB-4 — wrong on BOTH axes: the field (see the note in the overview counter) and
       the values. OB-3 established this state machine as pending_review /
       verified_on_file / rejected, and nothing anywhere writes 'verified' or
       'approved' to this collection. Those two are deliberately NOT kept as legacy
       fallbacks: 'verified' is precisely the ambiguous word OB-3 exists to avoid, and
       folding it in here would count an unknown standard as a known one. If such rows
       are ever found they need a decision, not an OR. */
    db.collection('providerVerification').where('status', '==', 'verified_on_file').count().get().catch(_c0),
    db.collection('providers').where('status', 'in', ['active', 'approved']).count().get().catch(_c0),
    db.collection('providerSubscriptions').where('status', 'in', ['active', 'trialing']).count().get().catch(_c0),
    db.collection('providers').where('status', '==', 'active').count().get().catch(_c0),
  ]);
  return {
    stages: [
      { key: 'applied',       label: 'Applied',        count: applied.data().count },
      { key: 'pendingReview', label: 'Pending Review', count: pending.data().count },
      /* 'Verified' alone reads as 'registration confirmed'. This stage counts document
         review only (verified_on_file) — see OB-3. The funnel renders `label`. */
      { key: 'verified',      label: 'Docs Verified',  count: verified.data().count },
      { key: 'published',     label: 'Published',      count: published.data().count },
      { key: 'subscribed',    label: 'Subscribed',     count: subscribed.data().count },
      { key: 'active',        label: 'Active',         count: active.data().count },
    ],
    generatedAt: new Date().toISOString(),
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
    reason: x.reason || x.note || '', method: x.method || 'M-Pesa',
    /* settlement evidence — lets the UI distinguish gateway-paid vs manual + show the journey */
    settlementMethod: x.settlementMethod || null,
    gatewayReference: x.gatewayReference || x.intasendRef || null,
    gatewayStatus: x.gatewayStatus || null,
    externalReference: x.externalReference || null,
    submittedAt: _iso(x.submittedAt), confirmedAt: _iso(x.confirmedAt), webhookReceivedAt: _iso(x.webhookReceivedAt),
    createdAt: _iso(x.createdAt), processedAt: _iso(x.processedAt) || _iso(x.paidAt) || null,
    timeline: (Array.isArray(x.statusHistory) ? x.statusHistory : []).slice(-8).map(h => ({ status: h.status || '', detail: (h.detail || '').slice(0, 100), at: _iso(h.at) })),
    _ms: _ms(x.createdAt) }; });
  items.sort((a, b) => b._ms - a._ms);
  const byStatus = items.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const pendingSet = new Set(['pending', 'approved', 'processing']);
  const pendingAmount = items.filter(r => pendingSet.has(r.status)).reduce((s, r) => s + r.amount, 0);
  if (status) items = items.filter(r => r.status === String(status).toLowerCase());
  items.forEach(r => { delete r._ms; });
  return _env('payoutRequests', items, { byStatus, pendingAmount: Math.round(pendingAmount * 100) / 100 });
});

/* Single-payout lifecycle inspector — the whole journey (request → gateway → webhook →
   settlement → timeline) in one call, so an operator never has to cross-reference
   Firestore + function logs + IntaSend + the webhook. Read-only. */
exports.adminGetPayout = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetPayout = async (req) => {
  _requireAdmin(req);
  const { id } = req.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id required');
  const db = getFirestore();
  const snap = await db.collection('payoutRequests').doc(String(id)).get();
  if (!snap.exists) return { found: false, id };
  const x = snap.data();
  const uid = x.sellerUid || x.uid || '';
  const [walletSnap, txSnap] = await Promise.all([
    uid ? db.collection('wallets').doc(uid).get().catch(() => null) : Promise.resolve(null),
    db.collection('walletTransactions').doc(`${uid}_${id}_payout`).get().catch(() => null),
  ]);
  const w  = walletSnap && walletSnap.exists ? walletSnap.data() : null;
  const tx = txSnap && txSnap.exists ? txSnap.data() : null;
  /* stage: -2 refunded, -1 failed/rejected, 1 pending … 5 paid. Drives the UI progress. */
  const STAGE = { pending: 1, approved: 2, approving: 3, sending: 3, retry_scheduled: 3, processing: 4, paid: 5, settled_manually: 5, completed: 5, failed: -1, rejected: -1, refunded: -2 };
  return {
    found: true,
    request:   { id, providerName: x.sellerName || x.name || '', sellerUid: uid, amount: Number(x.amount) || 0, phone: x.accountNumber || x.phone || '', method: x.method || 'mpesa', createdAt: _iso(x.createdAt) },
    status:    { current: String(x.status || ''), stage: STAGE[x.status] || 0, settlementMethod: x.settlementMethod || null, updatedAt: _iso(x.updatedAt) },
    gateway:   { name: x.gatewayName || 'IntaSend', reference: x.gatewayReference || x.intasendRef || null, gatewayStatus: x.gatewayStatus || null, submittedAt: _iso(x.submittedAt), confirmedAt: _iso(x.confirmedAt) },
    webhook:   { received: !!(x.webhookReceivedAt || x.lastWebhookState), lastState: x.lastWebhookState || null, receivedAt: _iso(x.webhookReceivedAt), events: (Array.isArray(x.webhookEvents) ? x.webhookEvents : []).map(e => ({ state: e.state, at: _iso(e.at) })) },
    settlement:{ walletDebited: !!tx, ledgerTxId: tx ? `${uid}_${id}_payout` : null, ledgerStatus: tx ? tx.status : null, settlementType: tx ? tx.settlementType : null, walletBalance: w ? Number(w.balance) || 0 : null, walletPending: w ? Number(w.pendingPayout) || 0 : null, externalReference: x.externalReference || null },
    errors:    { lastError: x.b2cError || null, retryCount: x.retryCount || 0, gatewayResponse: x.gatewayResponse || x.b2cResponse || null },
    timeline:  (Array.isArray(x.statusHistory) ? x.statusHistory : []).map(h => ({ status: h.status || '', detail: (h.detail || '').slice(0, 160), at: _iso(h.at) })),
  };
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

/* NOTE: the canonical adminGetDisputes / adminGetReviews live below (the filtered
   versions honouring status/flagged). The earlier `_env`-based duplicates were removed —
   they ignored the caller's filters and returned only `.items`, shadowed at runtime by
   the filtered versions. One op → one contract. */

exports.adminGetNotifications = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetNotifications = async (req) => {
  _requireAdmin(req);
  const items = await _listCanonical('notifications', Object.assign({ cap: 200 }, req.data || {}));
  return _env('notifications', items);
});

/* NOTE: canonical adminGetSupportTickets is the filtered version above (status/
   priority/category + priority sort, returns `.tickets`). This `_env` duplicate was
   removed — it WON at runtime (later registration) but returned `.items` while the UI
   reads `.tickets`, and it dropped the priority/category filters → empty Support pane. */

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

/* RETIRED: adminApprovePayouts wrote the deprecated `payouts` collection (no engine,
   no idempotency/reconciliation) — a no-op against the real `payoutRequests` queue.
   Admin OS now approves (single AND bulk) exclusively through the canonical, frozen
   wallet engine `adminProcessPayout` (wallet.js), one request at a time. One operation
   → one contract. See sokoni-aos.js _bulkApprovePayouts + scripts/test-admin-bulk-payout.js. */

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
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null }));
  return { disputes: rows, items: rows, count: rows.length };
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
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null }));
  return { reviews: rows, items: rows, count: rows.length };
});

/* RETIRED: adminRemoveReview — zero callers; duplicated review moderation. The one
   canonical review op is `reviews.adminModerateReview` (approve/reject/restore +
   summary recalc), which the Admin OS Reviews tab already calls. One op → one contract. */

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
/* ─────────────────────────────────────────────────────────────────────────
   Administrator → one user: email, SMS, in-app
   ─────────────────────────────────────────────────────────────────────────
   NOTHING HERE IS A NEW RAIL. Each channel reuses the transport this platform
   already runs:

     email  -> ./email-service   (send / sendOrQueue, SendGrid + queue fallback)
     sms    -> ./sokoni-at       (atSendSMSWithRetry, Africa's Talking)
     in-app -> notifications/{id} (targetUid/heading/sub/type; the user's own
                                   client already renders these and owns `read`)

   `adminSendPushNotification` could not be reused: it is BROADCAST — targetRole /
   targetAll, no targetUid — and writes platformNotifications. Sending one person a
   warning through it would notify everybody.

   WHY THE SERVER AND NOT THE BROWSER. firestore.rules lets an admin create a
   notification directly (`allow create: if isAdmin()`), so a console COULD write one.
   It must not: the send has to record who sent it, to whom, on which channel, and
   whether the provider accepted it — and a browser cannot be the witness to its own
   delivery. The audit row is written here, next to the send, or not at all.

   HISTORY LIVES IN adminAudit. It is admin-readable and `allow write: if false`, so
   no client can forge a message history. That also means no new collection and no
   rules change for this feature.

   THE TYPE FIELD IS NOT THE CATEGORY. `notifications.type` has a vocabulary the
   user's client switches on; inventing 'account_warning' there would render as an
   unknown type. Admin messages are written as type 'general' and carry the
   operational category in its own field.
──────────────────────────────────────────────────────────────────────────── */
const MESSAGE_CATEGORIES = Object.freeze({
  general:        'Message from SOKONI',
  account_warning:'Account warning',
  security_alert: 'Security alert',
  payment_notice: 'Payment notice',
  policy_notice:  'Policy notice',
  verification:   'Verification required',
  suspension:     'Account suspension notice',
  deletion:       'Account deletion notice',
  announcement:   'Announcement',
});
const MESSAGE_CHANNELS = Object.freeze(['email', 'sms', 'inapp']);
const SMS_MAX = 480;   /* three concatenated segments; the UI counts down to this */

exports.adminMessageUser = onCall(
  { region: 'us-central1', maxInstances: 10, enforceAppCheck: true,
    secrets: [...require('./email-service').EMAIL_SECRETS, ...require('./sokoni-at').secrets] },
  exports._h.adminMessageUser = async (req) => {
    _requireAdmin(req);
    const actor = req.auth && req.auth.uid;
    const { targetUid, channel, category, subject, body } = req.data || {};

    if (!targetUid) throw new HttpsError('invalid-argument', 'targetUid required');
    if (MESSAGE_CHANNELS.indexOf(channel) === -1) {
      throw new HttpsError('invalid-argument', 'channel must be email, sms or inapp');
    }
    const cat = MESSAGE_CATEGORIES[category] ? category : 'general';
    const text = String(body || '').trim();
    if (text.length < 2) throw new HttpsError('invalid-argument', 'A message is required.');
    if (channel === 'sms' && text.length > SMS_MAX) {
      throw new HttpsError('invalid-argument', 'That SMS is longer than ' + SMS_MAX + ' characters.');
    }

    const db = getFirestore();
    const snap = await db.collection('users').doc(targetUid).get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such account.');
    const u = snap.data() || {};

    /* THE ADDRESS MUST EXIST. A send that is certain to fail should be refused here,
       not attempted and reported as a provider error. */
    const email = u.email || null;
    const phone = u.phone || u.phoneNumber || null;
    if (channel === 'email' && !email) {
      throw new HttpsError('failed-precondition', 'This account has no email address on record.');
    }
    if (channel === 'sms' && !phone) {
      throw new HttpsError('failed-precondition', 'This account has no phone number on record.');
    }

    const heading = String(subject || '').trim() || MESSAGE_CATEGORIES[cat];
    const audit = {
      action:      'admin_message_sent',
      targetUid,
      channel,
      category:    cat,
      subject:     heading.slice(0, 140),
      bodyPreview: text.slice(0, 200),
      performedBy: actor,
      createdAt:   FieldValue.serverTimestamp(),
    };

    try {
      if (channel === 'inapp') {
        /* type stays inside the vocabulary the user's client understands. */
        const ref = await db.collection('notifications').add({
          targetUid,
          heading:  heading.slice(0, 140),
          sub:      text.slice(0, 1000),
          type:     'general',
          category: cat,
          fromAdmin: true,
          read:     false,
          createdAt: FieldValue.serverTimestamp(),
        });
        audit.notificationId = ref.id;
        audit.status = 'delivered';       /* an in-app write IS the delivery */
      } else if (channel === 'email') {
        const emailSvc = require('./email-service');
        /* sendOrQueue() defaults to QUEUEING and returns the queue document's id — a
           string, not a result object. The deployed processQueue worker performs the
           actual send, so the honest status here is `queued`, never `sent`. Claiming
           `sent` at this point is precisely the false-success this codebase keeps
           finding elsewhere. */
        const queueId = await emailSvc.sendOrQueue({
          to: email,
          subject: heading.slice(0, 140),
          text,
          html: '<p>' + text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
                            .replace(/\n/g, '<br>') + '</p>',
        });
        audit.status = 'queued';
        if (queueId) audit.providerRef = String(queueId);
      } else {
        const at = require('./sokoni-at');
        const r = await at.atSendSMSWithRetry(phone, text);
        audit.status = (r && r.ok === false) ? 'failed' : 'sent';
        if (r && r.messageId) audit.providerRef = String(r.messageId);
        if (r && r.error) audit.failureReason = String(r.error).slice(0, 200);
        audit.recipient = String(phone).slice(-4);   /* last four only — this row is PII-light */
      }
    } catch (e) {
      /* A provider failure is RECORDED, not swallowed: an operator needs to see that the
         attempt happened and why it did not land. */
      audit.status = 'failed';
      audit.failureReason = ((e && e.message) || String(e)).slice(0, 200);
      await db.collection('adminAudit').add(audit).catch(() => {});
      throw new HttpsError('unavailable', audit.failureReason);
    }

    await db.collection('adminAudit').add(audit);
    return { success: true, status: audit.status, channel, category: cat };
  });

/* History for ONE user. adminGetAuditLogs filters by action only, and combining a
   targetUid equality with orderBy('createdAt') would need a composite index — index
   deploys are their own risk here — so this queries on targetUid alone and sorts in
   memory. It is therefore a PAGE, then sorted, and the UI says so.

   In-app rows are joined to their notification so read state is real rather than
   assumed. There is no readAt field on that document, so the UI reports read/unread
   and never invents a time. */
exports.adminGetUserMessages = onCall(
  { region: 'us-central1', maxInstances: 10, enforceAppCheck: true },
  exports._h.adminGetUserMessages = async (req) => {
    _requireAdmin(req);
    const { targetUid, limit: lim } = req.data || {};
    if (!targetUid) throw new HttpsError('invalid-argument', 'targetUid required');
    const db = getFirestore();
    const snap = await db.collection('adminAudit')
      .where('targetUid', '==', targetUid)
      .limit(Math.min(lim || 50, 200)).get().catch(() => ({ docs: [] }));

    let rows = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r.action === 'admin_message_sent')
      .map(r => ({
        id: r.id, channel: r.channel, category: r.category, subject: r.subject,
        bodyPreview: r.bodyPreview, status: r.status || null,
        providerRef: r.providerRef || null, failureReason: r.failureReason || null,
        performedBy: r.performedBy || null, notificationId: r.notificationId || null,
        createdAt: r.createdAt?.toDate?.()?.toISOString() || null,
      }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    const inapp = rows.filter(r => r.notificationId).slice(0, 30);
    await Promise.all(inapp.map(async (r) => {
      const n = await db.collection('notifications').doc(r.notificationId).get().catch(() => null);
      r.read = n && n.exists ? (n.data().read === true) : null;   /* null = the notification is gone */
    }));

    return { messages: rows, capped: snap.docs.length >= Math.min(lim || 50, 200) };
  });

/* ─────────────────────────────────────────────────────────────────────────
   Account deletion, requested by an administrator
   ─────────────────────────────────────────────────────────────────────────
   THIS SCHEDULES; IT DOES NOT DELETE. The irreversible work belongs to the
   pipeline that already exists in account-manager.js:

     status:'pending_deletion' + deletionScheduledAt
         -> finaliseExpiredDeletions (scheduled, 23:00 UTC)
         -> redact -> anonymise -> retain statutory -> purge Storage
         -> auth.deleteUser(uid)          <- irreversible step, LAST

   That ordering is not incidental. An earlier version deleted the Auth account
   first; when the redaction write then failed, the retry hit user-not-found,
   skipped redaction, and left the account stuck in pending_deletion with full
   PII intact. So this handler writes exactly the two fields the self-service
   path writes and lets the same worker finish the job — one deletion mechanism,
   not a second one that would be free to disagree about what "deleted" means.

   WHY THE DATE IS COMPUTED HERE. firestore.rules allows an admin to update any
   users/{uid}, so a client could set `deletionScheduledAt` to a past date and
   have the next scheduled run hard-delete with no grace at all. The 30 days are
   therefore server-side and not a parameter.

   WHY NOT DELETE users/{uid} DIRECTLY. The rules permit it, but deleting that
   document is not account deletion: the Firebase Auth account survives, the
   person can still sign in, and the client re-creates a baseline document on
   next sign-in. It destroys the record while leaving the account live.

   The grace period is real: cancelAccountDeletion runs on sign-in, so the user
   cancels simply by signing in. That is a property of the existing pipeline and
   is surfaced in the admin UI rather than hidden.
──────────────────────────────────────────────────────────────────────────── */
const DELETION_GRACE_DAYS = 30;

exports.adminScheduleUserDeletion = onCall(
  { region: 'us-central1', maxInstances: 10, enforceAppCheck: true },
  exports._h.adminScheduleUserDeletion = async (req) => {
    _requireAdmin(req);
    const actor = req.auth && req.auth.uid;
    const { targetUid, reason } = req.data || {};

    if (!targetUid || typeof targetUid !== 'string') {
      throw new HttpsError('invalid-argument', 'targetUid required');
    }
    /* A reason is mandatory: this is an irreversible action taken on somebody
       else's account, and the audit row is worthless without one. */
    const why = String(reason || '').trim();
    if (why.length < 3) {
      throw new HttpsError('invalid-argument', 'A reason is required.');
    }
    if (targetUid === actor) {
      throw new HttpsError('failed-precondition',
        'You cannot schedule deletion of your own account from here.');
    }

    /* AN ADMIN MAY NOT DELETE ANOTHER ADMIN. Checked against CLAIMS, which are
       the authority, and against the profile role, because either one being
       admin is reason enough to refuse. A rename cannot get round it. */
    const auth = getAuth();
    let targetRecord = null;
    try { targetRecord = await auth.getUser(targetUid); }
    catch (e) {
      if (e && e.code === 'auth/user-not-found') {
        throw new HttpsError('not-found', 'No such account.');
      }
      throw e;
    }
    const claims = targetRecord.customClaims || {};
    const db = getFirestore();
    const snap = await db.collection('users').doc(targetUid).get();
    const profile = snap.exists ? snap.data() : {};
    if (claims.admin === true || claims.superAdmin === true ||
        profile.role === 'admin' || profile.role === 'superAdmin') {
      throw new HttpsError('failed-precondition',
        'This account is an administrator. Remove that role first.');
    }
    if (profile.status === 'pending_deletion') {
      throw new HttpsError('failed-precondition', 'Deletion is already scheduled.');
    }

    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + DELETION_GRACE_DAYS);

    /* The SAME fields scheduleAccountDeletion writes, so one worker finishes both. */
    await db.collection('users').doc(targetUid).set({
      deletionScheduledAt: scheduledAt,
      deletionReason:      why.slice(0, 100),
      deletionRequestedAt: FieldValue.serverTimestamp(),
      deletionRequestedBy: actor,          /* self-service leaves this absent */
      status:              'pending_deletion',
    }, { merge: true });

    await db.collection('adminAudit').add({
      action:      'user_deletion_scheduled',
      targetUid,
      reason:      why.slice(0, 100),
      scheduledAt,
      performedBy: actor,
      createdAt:   FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      scheduledAt: scheduledAt.toISOString(),
      graceDays: DELETION_GRACE_DAYS,
    };
  });

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

/* ═══════════════════════════════════════════════════════════════════════════
   MERCHANT ESTATE — sellers, shops, and the people who work in them

   Admin OS could see products, orders and users, but had no view of the
   REGISTRIES an approved merchant is actually projected onto. So the one screen
   an operator lives in could not answer the questions that matter after an
   approval:

     • which shops exist, and who owns each one;
     • which sellers are approved but have no shop (`projectSeller` never ran,
       or ran and failed) — an account authorised to sell with nowhere to sell
       from, which is invisible in every other view;
     • who has been given access to a shop, and in what role.

   These register in the `_h` registry ONLY — no standalone onCall — so they add
   no new Cloud Run service and ride the already-invokable adminOsDispatch.
   They do require adminOsDispatch itself to be REDEPLOYED before they resolve;
   until then the dispatcher answers 'not-found' listing the ops it does know.

   ── Employee rows are CORROBORATED, not merely read ────────────────────────
   firestore.rules permits any signed-in client to create a `shopEmployees`
   document, so the collection contains rows nobody vetted. `listShopEmployees`
   (functions/shop-employees.js) therefore corroborates every row three ways
   before showing it to a shop owner. An admin console that skipped that would
   display a forged row as though it were staff — and it is the console people
   trust most. The SAME contract is applied here, through the same module, and
   rows that fail it are REPORTED as disputed rather than silently dropped: an
   operator needs to see a forgery attempt, not be protected from knowing.
──────────────────────────────────────────────────────────────────────────── */

const _shopEmp = require('./shop-employees');

/* Owner of a shop, in the ONE vocabulary the projection writes. `ownerId` is
   what server-side ownership checks read; `sellerUid` states the same fact in
   the merchant vocabulary; `uid` is the legacy spelling on pre-projection
   documents. Never `shopId === uid` — that conflation is what the Store
   identity migration exists to remove. */
const _shopOwner = (x) => (x && (x.ownerId || x.sellerUid || x.uid)) || null;

exports._h.adminGetShops = async (req) => {
  _requireAdmin(req);
  const { limit: lim, search, status } = req.data || {};
  const db = getFirestore();
  const snap = await db.collection('shops').limit(Math.min(Number(lim) || 500, 2000)).get()
    .catch(() => ({ docs: [] }));

  let items = (snap.docs || []).map((d) => {
    const x = d.data() || {};
    const ownerId = _shopOwner(x);
    return {
      shopId: d.id,
      name: x.name || x.shopName || x.businessName || '',
      ownerId,
      /* An operator cannot act on a shop with no owner — it belongs to nobody,
         cannot be suspended through the seller, and cannot be reconciled. It is
         a finding, so it is stated rather than rendered as an empty cell. */
      ownerless: !ownerId,
      status: x.status || '',
      category: x.category || '',
      location: x.location || x.city || '',
      /* Provenance: 'application_approval' means projectSeller established it.
         Anything else predates the lifecycle or came from another writer. */
      source: x.source || null,
      applicationId: x.applicationId || null,
      createdAt: _iso(x.createdAt),
      activatedAt: _iso(x.activatedAt),
      updatedAt: _iso(x.updatedAt),
      _ms: _ms(x.createdAt) || _ms(x.activatedAt),
    };
  });

  if (status) items = items.filter((s) => String(s.status).toLowerCase() === String(status).toLowerCase());
  if (search) {
    const q = String(search).toLowerCase();
    items = items.filter((s) => (s.name || '').toLowerCase().includes(q)
      || s.shopId.toLowerCase().includes(q)
      || String(s.ownerId || '').toLowerCase().includes(q));
  }
  items.sort((a, b) => b._ms - a._ms);
  items.forEach((s) => { delete s._ms; });

  const active = items.filter((s) => String(s.status).toLowerCase() === 'active').length;
  const ownerless = items.filter((s) => s.ownerless).length;
  const fromApproval = items.filter((s) => s.source === 'application_approval').length;
  return _env('shops', items, { active, ownerless, fromApproval });
};

exports._h.adminGetSellers = async (req) => {
  _requireAdmin(req);
  const { limit: lim, search, status } = req.data || {};
  const db = getFirestore();

  /* Both registries in one read pair, because the question an operator asks is
     never "list sellers" — it is "which approved sellers have no live shop".
     Answering that from two screens invites the two screens to disagree. */
  const [sellerSnap, shopSnap] = await Promise.all([
    db.collection('sellers').limit(Math.min(Number(lim) || 500, 2000)).get().catch(() => ({ docs: [] })),
    db.collection('shops').limit(2000).get().catch(() => ({ docs: [] })),
  ]);

  const shopsById = new Map();
  const shopsByOwner = new Map();
  (shopSnap.docs || []).forEach((d) => {
    const x = d.data() || {};
    shopsById.set(d.id, { id: d.id, status: x.status || '', name: x.name || '' });
    const o = _shopOwner(x);
    if (o && !shopsByOwner.has(o)) shopsByOwner.set(o, { id: d.id, status: x.status || '', name: x.name || '' });
  });

  let items = (sellerSnap.docs || []).map((d) => {
    const x = d.data() || {};
    const declared = x.shopId ? shopsById.get(String(x.shopId)) : null;
    /* Fall back to ownership, never to `shopId = uid`: a seller whose declared
       shop does not exist is a DIFFERENT finding from one whose shop is simply
       recorded under another id, and collapsing them hides the first. */
    const owned = shopsByOwner.get(d.id) || null;
    const shop = declared || owned;
    return {
      uid: d.id,
      name: x.name || x.businessName || '',
      status: x.status || '',
      active: x.active !== false,
      declaredShopId: x.shopId || null,
      shopId: shop ? shop.id : null,
      shopName: shop ? shop.name : '',
      shopStatus: shop ? shop.status : '',
      /* THE state this screen exists to surface: authorised to sell, nowhere to
         sell from. Reconcile the application to repair it. */
      shopMissing: !shop,
      declaredShopMissing: !!(x.shopId && !declared),
      createdAt: _iso(x.createdAt),
      updatedAt: _iso(x.updatedAt),
      _ms: _ms(x.updatedAt) || _ms(x.createdAt),
    };
  });

  if (status) items = items.filter((s) => String(s.status).toLowerCase() === String(status).toLowerCase());
  if (search) {
    const q = String(search).toLowerCase();
    items = items.filter((s) => (s.name || '').toLowerCase().includes(q) || s.uid.toLowerCase().includes(q));
  }
  items.sort((a, b) => b._ms - a._ms);
  items.forEach((s) => { delete s._ms; });

  const active = items.filter((s) => s.active && String(s.status).toLowerCase() === 'active').length;
  const shopMissing = items.filter((s) => s.shopMissing).length;
  return _env('sellers', items, { active, shopMissing });
};

/* One shop, whole: the owner, the staff, and how much is actually in it. This
   is the "everything a shop and their employees" view. */
exports._h.adminGetShopDetail = async (req) => {
  _requireAdmin(req);
  const shopId = req.data && req.data.shopId ? String(req.data.shopId).slice(0, 200) : '';
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required');

  const db = getFirestore();
  const shopSnap = await db.collection('shops').doc(shopId).get();
  if (!shopSnap.exists) throw new HttpsError('not-found', 'No shop ' + shopId);
  const shop = shopSnap.data() || {};
  const ownerUid = _shopOwner(shop);

  const [empSnap, ownerSnap, sellerSnap] = await Promise.all([
    db.collection('shopEmployees').where('shopId', '==', shopId).limit(200).get().catch(() => ({ docs: [] })),
    ownerUid ? db.collection('users').doc(ownerUid).get().catch(() => null) : Promise.resolve(null),
    ownerUid ? db.collection('sellers').doc(ownerUid).get().catch(() => null) : Promise.resolve(null),
  ]);

  /* Same three-way corroboration listShopEmployees applies — canonical key,
     known role, and a shopOwnerId that matches THIS shop's owner. */
  const employees = [];
  const disputed = [];
  (empSnap.docs || []).forEach((d) => {
    const e = d.data() || {};
    const reasons = [];
    if (d.id !== _shopEmp.employeeDocId(shopId, e.uid)) reasons.push('not on the canonical key');
    if (!_shopEmp.SHOP_ROLES.includes(e.role)) reasons.push('unknown role "' + e.role + '"');
    if (!ownerUid || String(e.shopOwnerId || '') !== String(ownerUid)) reasons.push('shopOwnerId does not match the shop owner');
    const row = {
      id: d.id, uid: e.uid || null, email: e.email || null, name: e.name || null,
      role: e.role || null, active: e.active !== false, joinedAt: e.joinedAt || null,
    };
    if (reasons.length) disputed.push(Object.assign({}, row, { reasons }));
    else employees.push(row);
  });

  /* Counts. `products` ownership is enforced on `sellerUid` in firestore.rules,
     but `sellerId` and `shopId` are both queried elsewhere in this codebase, so
     all three are counted and REPORTED SEPARATELY. A single number here would
     be a guess about which field this shop's writers used; three numbers are
     evidence, and a disagreement between them is itself the finding. */
  const _count = async (col, field, value) => {
    if (!value) return null;
    try { return (await db.collection(col).where(field, '==', value).count().get()).data().count; }
    catch (_) { return null; }
  };
  const [pBySellerUid, pBySellerId, pByShopId, ordersBySellerId] = await Promise.all([
    _count('products', 'sellerUid', ownerUid),
    _count('products', 'sellerId', ownerUid),
    _count('products', 'shopId', shopId),
    _count('orders', 'sellerId', ownerUid),
  ]);

  const ownerData = ownerSnap && ownerSnap.exists ? ownerSnap.data() : null;
  return {
    ok: true,
    shop: {
      shopId,
      name: shop.name || shop.shopName || '',
      ownerId: ownerUid,
      ownerless: !ownerUid,
      status: shop.status || '',
      category: shop.category || '',
      location: shop.location || shop.city || '',
      phoneNumber: shop.phoneNumber || '',
      source: shop.source || null,
      applicationId: shop.applicationId || null,
      createdAt: _iso(shop.createdAt),
      activatedAt: _iso(shop.activatedAt),
      updatedAt: _iso(shop.updatedAt),
    },
    owner: ownerData ? {
      uid: ownerUid,
      name: ownerData.displayName || ownerData.name || '',
      email: ownerData.email || '',
      phone: ownerData.phone || ownerData.phoneNumber || '',
      roles: Array.isArray(ownerData.roles) ? ownerData.roles : [],
      /* The field merchant.html resolves first. If this disagrees with shopId,
         the merchant lands in a workspace that cannot tell which shop is theirs. */
      activeShopId: ownerData.activeShopId || null,
      activeShopMatches: String(ownerData.activeShopId || '') === shopId,
      sellerRegistered: !!(sellerSnap && sellerSnap.exists),
    } : null,
    employees,
    disputed,
    counts: {
      employees: employees.length,
      disputedEmployees: disputed.length,
      productsBySellerUid: pBySellerUid,
      productsBySellerId: pBySellerId,
      productsByShopId: pByShopId,
      ordersBySellerId: ordersBySellerId,
    },
  };
};

/* ═════════════════════════════════════════════════════════════════════════════
   OB-3 — PROVIDER VERIFICATION: THE DECISION STEP
   ═════════════════════════════════════════════════════════════════════════════
   `providerSubmitVerification` wrote providerVerification/{uid} with
   status:'pending_review' and NOTHING anywhere moved it. Documents could be
   submitted and never decided, so "verification" was a collection rather than a
   process: the only readers were the AdminOS counters, and the state was terminal
   in practice.

   WHAT THIS DECISION ACTUALLY MEANS — read before extending it.

   SOKONI has NO integration with any professional registry. There is no call to
   KMPDC, the Pharmacy and Poisons Board, the Nursing Council, a veterinary board,
   or any KYC vendor anywhere in this codebase. An administrator working this
   queue is looking at an uploaded image and deciding whether it is legible,
   plausible and matches the applicant.

   That establishes exactly one thing: THE DOCUMENTS ARE ON FILE AND A HUMAN
   LOOKED AT THEM. It does NOT establish that the registration is real, current,
   or belongs to this person. The vocabulary already distinguishes these —
   driverVerification uses `verified_on_file` for precisely this reason — and the
   distinction is the whole point:

       self-declared          licenseNumber / qualifications, typed by the applicant
       verified_on_file       a reviewer saw the documents          ← THE ONLY VERIFIED STATE
       verified_with_authority the issuing body confirmed it        ← NOT IMPLEMENTABLE TODAY

   `verified_with_authority` is deliberately NOT reachable from here and this
   handler REFUSES to write it. Adding it without an external evidence source
   would turn "an admin saw a PDF" into "this clinician is registered", which is
   the single most consequential lie this system could tell a patient. When an
   integration exists it gets its own writer, its own evidence fields, and its own
   gate — not a new string in this switch.

   SEPARATION OF POWERS. Verification does not activate, publish or make anyone
   bookable. Those live in providers/{uid}.status / searchable / acceptsBookings,
   written only by projectProvider() on an application decision (and closed to
   self-service by OB-1). This handler never touches them, and deliberately does
   NOT set the `verified` boolean either: a bare `verified:true` collapses
   on-file and authority-confirmed back into one claim, which is the distinction
   above being thrown away at the last step.
   ═════════════════════════════════════════════════════════════════════════════ */

const VERIFY_STATE = Object.freeze({
  PENDING:  'pending_review',
  ON_FILE:  'verified_on_file',
  REJECTED: 'rejected',
});

exports.adminDecideProviderVerification = onCall(
  { region: 'us-central1', maxInstances: 10, enforceAppCheck: true },
  exports._h.adminDecideProviderVerification = async (req) => {
    _requireAdmin(req);
    /* D1 — AN ADMIN CLAIM IS NOT VERIFICATION AUTHORITY.
       Every adminOsDispatch op shares one admin/superAdmin check, which made any admin an
       implicit identity reviewer. Identity and biometric review is narrower than admin
       user-management: it decides whether a person becomes officially real on the platform.
       The capability is explicit and its ABSENCE denies. */
    const _vAuth = require('./verification-authority');
    _vAuth.assertVerificationReviewer(req.auth?.token || {});

    const db = getFirestore();
    const actor = req.auth?.uid;
    const { uid, decision, reason } = req.data || {};

    if (!uid || typeof uid !== 'string') throw new Error('uid required');
    if (!['verify_documents', 'reject'].includes(decision)) {
      throw new Error('decision must be "verify_documents" or "reject"');
    }
    /* A reviewer may not decide their own submission, whatever claims they hold.
       An administrator is still an applicant when the subject is themselves. */
    if (uid === actor) throw new Error('You cannot decide your own verification.');

    const ref  = db.collection('providerVerification').doc(uid);
    const snap = await ref.get();
    /* Nothing to decide. Refusing here rather than creating a record keeps this
       handler a DECISION on submitted evidence, never a way to manufacture one. */
    if (!snap.exists) throw new Error('No verification submission exists for this provider.');
    const cur = snap.data() || {};

    const next = decision === 'verify_documents' ? VERIFY_STATE.ON_FILE : VERIFY_STATE.REJECTED;
    const why  = String(reason || '').slice(0, 500).replace(/[<>]/g, '');
    if (next === VERIFY_STATE.REJECTED && !why) {
      throw new Error('A rejection needs a reason the applicant can act on.');
    }

    /* IDEMPOTENT. Re-issuing the decision a record already carries changes
       nothing and writes no second audit entry, so a double-tapped button or a
       retry cannot manufacture a second review event. A DIFFERENT decision is a
       legitimate correction and is applied — and audited as the transition it is. */
    if (cur.status === next) {
      return { success: true, uid, status: next, idempotent: true };
    }

    /* D1 — TWO INDEPENDENT REVIEWERS on the assisted route.
       `applyReviewerDecision` is pure and owns the rules: it refuses a reviewer deciding their
       own submission, refuses one reviewer occupying BOTH seats (a different failure from
       self-approval, and one the existing `uid === actor` guard does not cover), preserves
       priorDecisions[], and leaves the record PENDING when only one seat is filled. A single
       reviewer cannot complete a two-review decision. */
    const _seat = _vAuth.applyReviewerDecision(cur, {
      actor, subjectUid: uid,
      decision: decision === 'verify_documents' ? 'approve' : 'reject',
      reason: why, claims: req.auth?.token || {},
    });
    if (!_seat.complete) {
      await ref.set({ ..._seat.patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      /* No log line: this file has no logging idiom, and introducing one here would widen the
         patch past its authorized surface. The seat state is in the record and in the return. */
      return { success: true, uid, status: _seat.patch.status,
               awaitingSecondReviewer: true,
               seatsFilled: _seat.seatsFilled, seatsRequired: _seat.seatsRequired };
    }

    await ref.set({
      ..._seat.patch,
      status:         next,
      reviewedBy:     actor,
      reviewedAt:     FieldValue.serverTimestamp(),
      reviewNotes:    why || null,
      previousStatus: cur.status || null,
      /* What the reviewer actually had in front of them, recorded with the
         decision so "verified" can never be read as broader than the evidence.
         The document URLs themselves are untouched — merge:true preserves them,
         and a decision must never destroy the evidence it was based on. */
      documentsReviewed: ['nationalIdUrl', 'businessRegUrl', 'licenceUrl', 'kraPinUrl', 'selfieUrl']
        .filter((k) => !!cur[k]),
      /* Says in the record itself what the state means, so a future reader of
         this document does not have to find this comment to know. */
      basis: next === VERIFY_STATE.ON_FILE
        ? 'admin-document-review: a reviewer inspected the uploaded documents. NOT confirmed with any issuing authority.'
        : 'admin-document-review: rejected on inspection.',
      updatedAt:      FieldValue.serverTimestamp(),
    }, { merge: true });

    /* Informational mirror onto the provider's own record, matching what
       providerSubmitVerification already writes. `verified` is NOT set — see the
       separation-of-powers note above. */
    await db.collection('providerProfiles').doc(uid)
      .set({ verificationStatus: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      .catch(() => {});

    await db.collection('adminAudit').add({
      action: 'provider_verification_' + (next === VERIFY_STATE.ON_FILE ? 'verified_on_file' : 'rejected'),
      targetUid: uid,
      fromStatus: cur.status || null,
      toStatus: next,
      reason: why || null,
      performedBy: actor,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { success: true, uid, status: next, previousStatus: cur.status || null };
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   INTEGRATION STATUS — authoritative credential configuration           (RC-1)
   ══════════════════════════════════════════════════════════════════════════════
   Reports, for all 35 registry entries, whether the credentials each integration
   requires are CONFIGURED. It reports nothing about whether a provider works.

   Why this exists: no deployed function read Secret Manager inventory, so the
   Integration Control Center had no signal and every integration read as
   unmanaged — while in fact every catalogue-declared secret is present.

   This handler holds no credential. It binds no secret (no `secrets: []`), and
   the module it calls lists secret NAMES only; the payload API is never touched.
   Admin-gated like every other operation here, and added as an `_h` handler so
   it dispatches through adminOsDispatch rather than standing up a new service.
   ══════════════════════════════════════════════════════════════════════════════ */
exports.adminGetIntegrationStatus = onCall(
  { region: 'us-central1', maxInstances: 10, enforceAppCheck: true },
  exports._h.adminGetIntegrationStatus = async (req) => {
    _requireAdmin(req);
    const { resolveIntegrationStatus } = require('./integration-status');
    const result = await resolveIntegrationStatus({});
    /* Logged as counts, never as an inventory: a log line naming which
       integrations lack credentials is a shopping list. */
    console.log('[adminGetIntegrationStatus] resolved', {
      actor: req.auth && req.auth.uid,
      integrations: result.integrations.length,
      counts: result.counts,
      inventoryReadable: result.inventoryReadable,
    });
    return result;
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   INTEGRATION PROBE — measure a provider, one integration at a time     (RC-3)
   ══════════════════════════════════════════════════════════════════════════════
   Runs the declared probe for ONE integration and records the result under
   integrationProbes/{correlationId}, so the status surface has a measured health
   instead of `unknown`.

   It builds on adminGetIntegrationStatus rather than re-deciding configuration:
   credentialState and lifecycle come from there, so there is exactly one answer
   to "is this configured" in the platform.

   A probe never charges money, never messages a real customer and never writes
   to a business collection. For rails that report delivery asynchronously it
   returns delivered/received as null and mints a correlation id; only the
   provider's own callback can turn those true.
   ══════════════════════════════════════════════════════════════════════════════ */
exports.adminRunIntegrationProbe = onCall(
  { region: 'us-central1', maxInstances: 10, enforceAppCheck: true },
  exports._h.adminRunIntegrationProbe = async (req) => {
    _requireAdmin(req);
    const { integrationId } = req.data || {};
    if (!integrationId) throw new HttpsError('invalid-argument', 'integrationId is required.');

    const registry = require('./integration-registry');
    const entry = registry.byId(integrationId);
    if (!entry) throw new HttpsError('not-found', 'Unknown integration: ' + integrationId);

    /* Configuration is RC-1's answer. Asking it here keeps one authority. */
    const { resolveIntegrationStatus } = require('./integration-status');
    const status = await resolveIntegrationStatus({});
    const record = status.integrations.find((i) => i.id === integrationId);

    const probes = require('./integration-probes');
    const executors = require('./integration-probe-executors');
    const result = await probes.runProbe(integrationId, {
      credentialState: record ? record.credentialState : 'unknown',
      lifecycle:       entry.status,
      execute:         executors.executorFor(integrationId),
    });

    /* Persisted so the status surface can report it, and so an async callback
       has something to correlate against. The document carries no credential. */
    if (result.correlationId) {
      await db().collection('integrationProbes').doc(result.correlationId).set({
        correlationId: result.correlationId,
        integrationId,
        stages:    result.stages,
        support:   result.support,
        health:    result.health,
        evidence:  result.evidence,
        startedBy: req.auth && req.auth.uid,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    await db().collection('integrationProbeLatest').doc(integrationId).set({
      integrationId, ...result, updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log('[adminRunIntegrationProbe] probed', {
      actor: req.auth && req.auth.uid, integrationId,
      health: result.health, evidence: result.evidence,
    });
    return result;
  }
);
