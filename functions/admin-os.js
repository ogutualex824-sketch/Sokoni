'use strict';

const { onCall } = require('firebase-functions/v2/https');
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
         pendingPayoutsCount, activeDeliveriesCount] = await Promise.all([
    db.collection('users').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('users').where('createdAt', '>=', todayTs).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('orders').where('createdAt', '>=', todayTs).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('orders').where('status', 'in', ['pending', 'processing', 'confirmed']).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('transactions').where('createdAt', '>=', todayTs).where('status', '==', 'completed').limit(1000).get().catch(() => ({ docs: [] })),
    db.collection('supportTickets').where('status', '==', 'open').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('disputes').where('status', '==', 'open').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('subscriptions').where('status', 'in', ['active', 'trialing']).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('payouts').where('status', '==', 'pending').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('orders').where('deliveryStatus', 'in', ['in_transit', 'picking_up']).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
  ]);

  const revenueToday    = (txToday.docs || []).reduce((s, d) => s + (d.data().amount || 0), 0);
  const commissionToday = (txToday.docs || []).reduce((s, d) => s + (d.data().platformFee || d.data().commission || 0), 0);

  return {
    totalUsers: totalUsersCount.data().count, newUsersToday: newUsersCount.data().count,
    ordersToday: ordersTodayCount.data().count, activeOrders: activeOrdersCount.data().count,
    revenueToday, commissionToday,
    openTickets: openTicketsCount.data().count, openDisputes: openDisputesCount.data().count,
    activeSubscriptions: activeSubsCount.data().count, pendingPayouts: pendingPayoutsCount.data().count,
    activeDeliveries: activeDeliveriesCount.data().count,
  };
});

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
  let q = db.collection('bookings').orderBy('createdAt', 'desc').limit(Math.min(lim || 50, 200));
  if (status) q = q.where('status', '==', status);
  const snap = await q.get();
  return { bookings: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null })) };
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
exports.adminGetPendingPayouts = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminGetPendingPayouts = async (req) => {
  _requireAdmin(req);
  const snap = await getFirestore().collection('payouts').where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(100).get().catch(() => ({ docs: [] }));
  return { payouts: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null })) };
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

exports.adminResolveDispute = onCall({ region: 'us-central1', maxInstances: 10, enforceAppCheck: true }, exports._h.adminResolveDispute = async (req) => {
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
