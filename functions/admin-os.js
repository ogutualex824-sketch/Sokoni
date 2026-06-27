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

/* ─────────────────────────────────────────────────────────────────────────
   Platform Overview
──────────────────────────────────────────────────────────────────────────── */
exports.adminGetPlatformOverview = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
  _requireAdmin(req);
  const db = getFirestore();

  const [users, sellers, activeOrders, openTickets, pendingReports, bannedUsers] = await Promise.all([
    db.collection('users').limit(10000).get(),
    db.collection('users').where('role', '==', 'seller').limit(5000).get(),
    db.collection('orders').where('status', '==', 'pending').limit(1000).get(),
    db.collection('supportTickets').where('status', '==', 'open').limit(500).get(),
    db.collection('reports').where('status', '==', 'pending').limit(500).get(),
    db.collection('users').where('status', '==', 'banned').limit(500).get(),
  ]);

  // New users today (in-memory)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime() / 1000;
  const newToday = users.docs.filter(d => (d.data().createdAt?.seconds || 0) >= todayTs).length;

  return {
    totalUsers:     users.size,
    totalSellers:   sellers.size,
    newUsersToday:  newToday,
    activeOrders:   activeOrders.size,
    openTickets:    openTickets.size,
    pendingReports: pendingReports.size,
    bannedUsers:    bannedUsers.size,
  };
});

/* ─────────────────────────────────────────────────────────────────────────
   User Management
──────────────────────────────────────────────────────────────────────────── */
exports.adminSearchUsers = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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

exports.adminGetUser = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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

exports.adminUpdateUserRole = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
  _requireSuperAdmin(req);
  const { uid, role, additionalClaims } = req.data;
  if (!uid || !role) throw new Error('uid, role required');

  const validRoles = ['buyer', 'seller', 'provider', 'driver', 'admin', 'moderator', 'superAdmin'];
  if (!validRoles.includes(role)) throw new Error(`Invalid role. Must be one of: ${validRoles.join(', ')}`);

  const auth = getAuth();
  const db = getFirestore();

  const claims = { [role]: true, ...(additionalClaims || {}) };
  // Prevent accidental superAdmin escalation except by existing superAdmin
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
exports.adminGetPlatformSettings = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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

exports.adminUpdatePlatformSettings = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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
exports.adminGetFeatureFlags = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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

exports.adminUpdateFeatureFlag = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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
exports.adminCreateSupportTicket = onCall({ region: 'us-central1', maxInstances: 30 }, async (req) => {
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

exports.adminGetSupportTickets = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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

exports.adminResolveSupportTicket = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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
exports.adminGetCategories = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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

exports.adminUpsertCategory = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
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
