'use strict';
/**
 * CRM — Customer Relationship Management Engine v1.0
 * Firebase Cloud Functions (Gen 2)
 *
 * Collections:
 *   crmLeads/{leadId}
 *   crmLeadActivities/{activityId}
 *   crmCustomerProfiles/{uid}
 *   crmSegments/{segmentId}
 *   crmSupportTickets/{ticketId}
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');
const { defineSecret }       = require('firebase-functions/params');

const ANTHROPIC_KEY = defineSecret('ANTHROPIC_API_KEY');

const db     = admin.firestore();
const F      = admin.firestore.FieldValue;
const REGION = 'us-central1';
const OPT    = { region: REGION, enforceAppCheck: true };

/* ── Constants ───────────────────────────────────────────────────────────── */
const LEAD_STATUSES     = ['new', 'contacted', 'qualified', 'converted', 'lost'];
const ACTIVITY_TYPES    = ['call', 'email', 'visit', 'whatsapp', 'demo'];
const LEAD_SOURCES      = ['walk_in', 'referral', 'social', 'event', 'online', 'cold_call'];
const TICKET_STATUSES   = ['open', 'in_progress', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const CHURN_WINDOW_DAYS = 90;   // days until churnRiskScore reaches 1.0
const CLV_LIFESPAN_MO   = 24;   // default predicted lifespan in months

/* ── Structured logger ───────────────────────────────────────────────────── */
function mkLogger(fn) {
  const id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)).toUpperCase();
  const base = { requestId: id, fn };
  return {
    id,
    info:  (msg, x = {}) => console.log(JSON.stringify({ severity: 'INFO',    message: msg, ...base, ...x })),
    warn:  (msg, x = {}) => console.warn(JSON.stringify({ severity: 'WARNING', message: msg, ...base, ...x })),
    error: (msg, x = {}) => console.error(JSON.stringify({ severity: 'ERROR',  message: msg, ...base, ...x })),
    audit: (msg, x = {}) => console.log(JSON.stringify({ severity: 'NOTICE',  message: msg, ...base, ...x, audit: true })),
  };
}

/* ── Auth helper ─────────────────────────────────────────────────────────── */
function requireAuth(ctx) {
  if (!ctx.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  return ctx.auth.uid;
}

/* ── Input sanitiser ─────────────────────────────────────────────────────── */
function sanitizeStr(v, max = 500) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function requireStr(v, field, max = 500) {
  const s = sanitizeStr(v, max);
  if (!s) throw new HttpsError('invalid-argument', `${field} is required.`);
  return s;
}

function optionalStr(v, max = 500) {
  if (v === undefined || v === null) return undefined;
  return sanitizeStr(v, max) || undefined;
}

function requireEnum(v, allowed, field) {
  if (!allowed.includes(v)) {
    throw new HttpsError('invalid-argument', `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return v;
}

function optionalEnum(v, allowed, field) {
  if (v === undefined || v === null) return undefined;
  return requireEnum(v, allowed, field);
}

function requirePositiveNum(v, field) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) throw new HttpsError('invalid-argument', `${field} must be a non-negative number.`);
  return n;
}

/* ── Merchant ownership guard ─────────────────────────────────────────────── */
async function assertMerchantOwner(uid, merchantId) {
  const snap = await db.collection('merchants').doc(merchantId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Merchant not found.');
  const data = snap.data();
  if (data.ownerId !== uid && data.adminUids && !data.adminUids.includes(uid)) {
    throw new HttpsError('permission-denied', 'Access denied.');
  }
}

/* ── Churn score helper ───────────────────────────────────────────────────── */
function computeChurnScore(lastOrderAt) {
  if (!lastOrderAt) return { score: 1, level: 'high' };
  const lastTs = lastOrderAt.toDate ? lastOrderAt.toDate() : new Date(lastOrderAt);
  const daysSince = (Date.now() - lastTs.getTime()) / 86_400_000;
  const score = Math.min(1, daysSince / CHURN_WINDOW_DAYS);
  const level = score < 0.3 ? 'low' : score < 0.7 ? 'medium' : 'high';
  return { score: parseFloat(score.toFixed(4)), level };
}

/* ── CLV calculator ───────────────────────────────────────────────────────── */
function computeCLV(totalSpend, orderCount, firstOrderAt) {
  if (!orderCount || orderCount === 0) return { clv: 0, avgOrderValue: 0, purchaseFrequency: 0, predictedLifespan: CLV_LIFESPAN_MO };
  const avgOrderValue = totalSpend / orderCount;
  const firstTs = firstOrderAt && firstOrderAt.toDate ? firstOrderAt.toDate() : new Date(firstOrderAt || Date.now());
  const monthsSinceFirst = Math.max(1, (Date.now() - firstTs.getTime()) / (30 * 86_400_000));
  const purchaseFrequency = orderCount / monthsSinceFirst;
  const clv = avgOrderValue * purchaseFrequency * CLV_LIFESPAN_MO;
  return {
    clv:               parseFloat(clv.toFixed(2)),
    avgOrderValue:     parseFloat(avgOrderValue.toFixed(2)),
    purchaseFrequency: parseFloat(purchaseFrequency.toFixed(4)),
    predictedLifespan: CLV_LIFESPAN_MO,
  };
}

/* ── Top categories extractor ─────────────────────────────────────────────── */
function extractTopCategories(orders, topN = 3) {
  const counts = {};
  for (const o of orders) {
    const items = o.items || [];
    for (const item of items) {
      const cat = item.category || item.categoryId || 'uncategorized';
      counts[cat] = (counts[cat] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([cat]) => cat);
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. createLead
═══════════════════════════════════════════════════════════════════════════ */
exports.createLead = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('createLead');
  const uid = requireAuth(req);

  const merchantId     = requireStr(req.data.merchantId, 'merchantId', 64);
  const name           = requireStr(req.data.name, 'name', 120);
  const phone          = optionalStr(req.data.phone, 20);
  const email          = optionalStr(req.data.email, 120);
  const source         = requireEnum(req.data.source || 'online', LEAD_SOURCES, 'source');
  const notes          = optionalStr(req.data.notes, 2000);
  const estimatedValue = req.data.estimatedValue ? requirePositiveNum(req.data.estimatedValue, 'estimatedValue') : 0;

  if (!phone && !email) throw new HttpsError('invalid-argument', 'At least one of phone or email is required.');

  await assertMerchantOwner(uid, merchantId);

  const payload = {
    merchantId,
    name,
    source,
    status:         'new',
    assignedTo:     uid,
    notes:          notes || '',
    estimatedValue,
    lastContactedAt: null,
    convertedAt:    null,
    createdAt:      F.serverTimestamp(),
    updatedAt:      F.serverTimestamp(),
  };
  if (phone) payload.phone = phone;
  if (email) payload.email = email;

  const ref = await db.collection('crmLeads').add(payload);
  log.audit('lead_created', { leadId: ref.id, merchantId, source });
  return { leadId: ref.id };
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. updateLead
═══════════════════════════════════════════════════════════════════════════ */
exports.updateLead = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('updateLead');
  const uid = requireAuth(req);

  const leadId = requireStr(req.data.leadId, 'leadId', 64);

  const snap = await db.collection('crmLeads').doc(leadId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
  const lead = snap.data();

  await assertMerchantOwner(uid, lead.merchantId);

  const updates = { updatedAt: F.serverTimestamp() };

  if (req.data.status !== undefined) {
    const newStatus = requireEnum(req.data.status, LEAD_STATUSES, 'status');
    updates.status = newStatus;
    if (newStatus === 'converted') updates.convertedAt = F.serverTimestamp();
  }
  if (req.data.assignedTo !== undefined) updates.assignedTo = requireStr(req.data.assignedTo, 'assignedTo', 64);
  if (req.data.notes !== undefined) updates.notes = sanitizeStr(req.data.notes, 2000);
  if (req.data.estimatedValue !== undefined) updates.estimatedValue = requirePositiveNum(req.data.estimatedValue, 'estimatedValue');

  await db.collection('crmLeads').doc(leadId).update(updates);

  // Auto-log status change as activity
  if (updates.status) {
    await db.collection('crmLeadActivities').add({
      leadId,
      merchantId:  lead.merchantId,
      type:        'call',
      outcome:     `Status changed to ${updates.status}`,
      notes:       req.data.notes ? sanitizeStr(req.data.notes, 2000) : '',
      staffId:     uid,
      durationMin: 0,
      createdAt:   F.serverTimestamp(),
    });
  }

  log.audit('lead_updated', { leadId, updates: Object.keys(updates) });
  return { success: true };
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. logLeadActivity
═══════════════════════════════════════════════════════════════════════════ */
exports.logLeadActivity = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('logLeadActivity');
  const uid = requireAuth(req);

  const leadId     = requireStr(req.data.leadId, 'leadId', 64);
  const merchantId = requireStr(req.data.merchantId, 'merchantId', 64);
  const type       = requireEnum(req.data.type || 'call', ACTIVITY_TYPES, 'type');
  const outcome    = optionalStr(req.data.outcome, 500) || '';
  const notes      = optionalStr(req.data.notes, 2000) || '';
  const durationMin = req.data.durationMin ? requirePositiveNum(req.data.durationMin, 'durationMin') : 0;

  await assertMerchantOwner(uid, merchantId);

  // Verify lead belongs to merchant
  const leadSnap = await db.collection('crmLeads').doc(leadId).get();
  if (!leadSnap.exists || leadSnap.data().merchantId !== merchantId) {
    throw new HttpsError('not-found', 'Lead not found for this merchant.');
  }

  const batch = db.batch();

  const actRef = db.collection('crmLeadActivities').doc();
  batch.set(actRef, {
    leadId,
    merchantId,
    type,
    outcome,
    notes,
    staffId:    uid,
    durationMin,
    createdAt:  F.serverTimestamp(),
  });

  batch.update(db.collection('crmLeads').doc(leadId), {
    lastContactedAt: F.serverTimestamp(),
    updatedAt:       F.serverTimestamp(),
  });

  await batch.commit();
  log.audit('lead_activity_logged', { leadId, activityId: actRef.id, type });
  return { activityId: actRef.id };
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. convertLead
═══════════════════════════════════════════════════════════════════════════ */
exports.convertLead = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('convertLead');
  const uid = requireAuth(req);

  const leadId = requireStr(req.data.leadId, 'leadId', 64);
  const notes  = optionalStr(req.data.notes, 2000) || '';

  const leadSnap = await db.collection('crmLeads').doc(leadId).get();
  if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found.');
  const lead = leadSnap.data();

  await assertMerchantOwner(uid, lead.merchantId);

  if (lead.status === 'converted') throw new HttpsError('failed-precondition', 'Lead is already converted.');

  const batch = db.batch();

  // Update lead status
  batch.update(db.collection('crmLeads').doc(leadId), {
    status:      'converted',
    convertedAt: F.serverTimestamp(),
    updatedAt:   F.serverTimestamp(),
    notes:       notes || lead.notes,
  });

  // Log conversion activity
  const actRef = db.collection('crmLeadActivities').doc();
  batch.set(actRef, {
    leadId,
    merchantId:  lead.merchantId,
    type:        'call',
    outcome:     'Lead converted to customer',
    notes,
    staffId:     uid,
    durationMin: 0,
    createdAt:   F.serverTimestamp(),
  });

  await batch.commit();

  // Attempt to enrich customer profile if uid found via phone lookup
  if (lead.phone) {
    try {
      const usersSnap = await db.collection('users')
        .where('phone', '==', lead.phone)
        .limit(1)
        .get();

      if (!usersSnap.empty) {
        const customerUid = usersSnap.docs[0].id;
        // Build/merge profile in background — don't await to keep response fast
        db.collection('crmCustomerProfiles').doc(customerUid).set({
          merchantId:  lead.merchantId,
          name:        lead.name,
          phone:       lead.phone || '',
          email:       lead.email || '',
          segment:     'converted_lead',
          updatedAt:   F.serverTimestamp(),
        }, { merge: true }).catch((e) => log.warn('profile_merge_failed', { err: e.message }));
      }
    } catch (e) {
      log.warn('user_lookup_failed', { err: e.message });
    }
  }

  log.audit('lead_converted', { leadId, merchantId: lead.merchantId });
  return { success: true, activityId: actRef.id };
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. getLeadBoard
═══════════════════════════════════════════════════════════════════════════ */
exports.getLeadBoard = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('getLeadBoard');
  const uid = requireAuth(req);

  const merchantId = requireStr(req.data.merchantId, 'merchantId', 64);
  const statusFilter = optionalEnum(req.data.status, LEAD_STATUSES, 'status');

  await assertMerchantOwner(uid, merchantId);

  let query = db.collection('crmLeads').where('merchantId', '==', merchantId);
  if (statusFilter) query = query.where('status', '==', statusFilter);

  const snap = await query.orderBy('createdAt', 'desc').limit(500).get();

  // Group by status
  const board = { new: [], contacted: [], qualified: [], converted: [], lost: [] };
  let totalValue    = 0;
  let convertedCount = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    const item = {
      id:             doc.id,
      name:           d.name,
      phone:          d.phone || '',
      email:          d.email || '',
      source:         d.source,
      status:         d.status,
      assignedTo:     d.assignedTo,
      estimatedValue: d.estimatedValue || 0,
      lastContactedAt: d.lastContactedAt || null,
      createdAt:      d.createdAt || null,
    };
    if (board[d.status]) board[d.status].push(item);
    totalValue += d.estimatedValue || 0;
    if (d.status === 'converted') convertedCount++;
  }

  const total = snap.size;
  const conversionRate = total > 0 ? parseFloat(((convertedCount / total) * 100).toFixed(1)) : 0;
  const avgDealValue   = total > 0 ? parseFloat((totalValue / total).toFixed(2)) : 0;

  log.info('lead_board_fetched', { merchantId, total });
  return {
    ...board,
    summary: { total, convertedCount, conversionRate, avgDealValue },
  };
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. buildCustomerProfile
═══════════════════════════════════════════════════════════════════════════ */
exports.buildCustomerProfile = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('buildCustomerProfile');
  const uid = requireAuth(req);

  const merchantId   = requireStr(req.data.merchantId, 'merchantId', 64);
  const customerUid  = requireStr(req.data.uid, 'uid', 64);

  await assertMerchantOwner(uid, merchantId);

  // Fetch orders for this customer+merchant
  const ordersSnap = await db.collection('orders')
    .where('merchantId', '==', merchantId)
    .where('uid', '==', customerUid)
    .orderBy('createdAt', 'asc')
    .limit(500)
    .get();

  const orders       = ordersSnap.docs.map((d) => d.data());
  const orderCount   = orders.length;
  const totalSpend   = orders.reduce((s, o) => s + (o.totalAmountCents || o.totalAmount || 0) / 100, 0);
  const firstOrderAt = orders[0]?.createdAt || null;
  const lastOrderAt  = orders[orderCount - 1]?.createdAt || null;
  const avgOrderValue = orderCount > 0 ? totalSpend / orderCount : 0;

  // Churn risk
  const { score: churnRiskScore, level: churnRiskLevel } = computeChurnScore(lastOrderAt);

  // Top categories
  const preferredCategories = extractTopCategories(orders);

  // Loyalty account
  let loyaltyPoints = 0;
  let loyaltyTier   = 'bronze';
  try {
    const loySnap = await db.collection('loyaltyAccounts')
      .where('uid', '==', customerUid)
      .where('merchantId', '==', merchantId)
      .limit(1).get();
    if (!loySnap.empty) {
      const loy = loySnap.docs[0].data();
      loyaltyPoints = loy.points || 0;
      loyaltyTier   = loy.tier || 'bronze';
    }
  } catch (_) { /* loyalty optional */ }

  // CLV
  const { clv } = computeCLV(totalSpend, orderCount, firstOrderAt);

  // Fetch user info
  let name = '', phone = '', email = '', segment = 'customer';
  try {
    const userSnap = await db.collection('users').doc(customerUid).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      name   = u.displayName || u.name || '';
      phone  = u.phone || u.phoneNumber || '';
      email  = u.email || '';
    }
  } catch (_) { /* best effort */ }

  // Determine segment
  if (clv > 50000)       segment = 'vip';
  else if (clv > 10000)  segment = 'high_value';
  else if (orderCount > 5) segment = 'regular';
  else if (orderCount === 1) segment = 'first_time';

  const profile = {
    uid:                 customerUid,
    merchantId,
    name,
    phone,
    email,
    segment,
    clv,
    firstOrderAt:        firstOrderAt || null,
    lastOrderAt:         lastOrderAt || null,
    orderCount,
    totalSpend:          parseFloat(totalSpend.toFixed(2)),
    avgOrderValue:       parseFloat(avgOrderValue.toFixed(2)),
    churnRiskScore,
    churnRiskLevel,
    tags:                [],
    preferredCategories,
    loyaltyPoints,
    loyaltyTier,
    updatedAt:           F.serverTimestamp(),
  };

  await db.collection('crmCustomerProfiles').doc(customerUid).set(profile, { merge: true });
  log.info('customer_profile_built', { customerUid, merchantId, segment, churnRiskLevel });
  return profile;
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. getCustomerProfile
═══════════════════════════════════════════════════════════════════════════ */
exports.getCustomerProfile = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('getCustomerProfile');
  const uid = requireAuth(req);

  const merchantId  = requireStr(req.data.merchantId, 'merchantId', 64);
  const customerUid = requireStr(req.data.uid, 'uid', 64);

  await assertMerchantOwner(uid, merchantId);

  const snap = await db.collection('crmCustomerProfiles').doc(customerUid).get();

  // If profile doesn't exist for this merchant, build it on-the-fly
  if (!snap.exists || snap.data().merchantId !== merchantId) {
    log.info('profile_not_found_building', { customerUid, merchantId });
    return exports.buildCustomerProfile.run({ data: { merchantId, uid: customerUid }, auth: { uid } });
  }

  return snap.data();
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. calculateCLV
═══════════════════════════════════════════════════════════════════════════ */
exports.calculateCLV = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('calculateCLV');
  const uid = requireAuth(req);

  const merchantId  = requireStr(req.data.merchantId, 'merchantId', 64);
  const customerUid = requireStr(req.data.uid, 'uid', 64);

  await assertMerchantOwner(uid, merchantId);

  const profileSnap = await db.collection('crmCustomerProfiles').doc(customerUid).get();
  if (!profileSnap.exists) throw new HttpsError('not-found', 'Customer profile not found. Build it first.');

  const p = profileSnap.data();
  if (p.merchantId !== merchantId) throw new HttpsError('permission-denied', 'Profile does not belong to this merchant.');

  const { clv, avgOrderValue, purchaseFrequency, predictedLifespan } = computeCLV(
    p.totalSpend || 0,
    p.orderCount || 0,
    p.firstOrderAt,
  );

  await db.collection('crmCustomerProfiles').doc(customerUid).update({
    clv,
    updatedAt: F.serverTimestamp(),
  });

  log.info('clv_calculated', { customerUid, clv });
  return {
    clv,
    avgOrderValue,
    purchaseFrequency,
    predictedLifespan,
    breakdown: {
      formula:   'avgOrderValue × purchaseFrequency × predictedLifespan',
      currency:  'KES',
      note:      `${predictedLifespan}-month predicted lifespan; ${purchaseFrequency.toFixed(2)} orders/month`,
    },
  };
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. getChurnRisk
═══════════════════════════════════════════════════════════════════════════ */
exports.getChurnRisk = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('getChurnRisk');
  const uid = requireAuth(req);

  const merchantId = requireStr(req.data.merchantId, 'merchantId', 64);
  const riskLevel  = optionalEnum(req.data.riskLevel, ['high', 'medium'], 'riskLevel');

  await assertMerchantOwner(uid, merchantId);

  let query = db.collection('crmCustomerProfiles').where('merchantId', '==', merchantId);
  if (riskLevel) query = query.where('churnRiskLevel', '==', riskLevel);

  const snap = await query.orderBy('churnRiskScore', 'desc').limit(50).get();

  const customers = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      uid:            doc.id,
      name:           d.name || '',
      phone:          d.phone || '',
      email:          d.email || '',
      churnRiskScore: d.churnRiskScore,
      churnRiskLevel: d.churnRiskLevel,
      lastOrderAt:    d.lastOrderAt || null,
      clv:            d.clv || 0,
      orderCount:     d.orderCount || 0,
    };
  });

  log.info('churn_risk_fetched', { merchantId, riskLevel, count: customers.length });
  return { customers, count: customers.length };
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. createSupportTicket
═══════════════════════════════════════════════════════════════════════════ */
exports.createSupportTicket = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('createSupportTicket');
  const uid = requireAuth(req);

  const merchantId  = requireStr(req.data.merchantId, 'merchantId', 64);
  const customerUid = requireStr(req.data.uid, 'uid', 64);
  const subject     = requireStr(req.data.subject, 'subject', 200);
  const description = requireStr(req.data.description, 'description', 5000);
  const priority    = requireEnum(req.data.priority || 'medium', TICKET_PRIORITIES, 'priority');
  const orderId     = optionalStr(req.data.orderId, 64);

  await assertMerchantOwner(uid, merchantId);

  const payload = {
    merchantId,
    uid:         customerUid,
    subject,
    description,
    priority,
    status:      'open',
    assignedTo:  null,
    createdAt:   F.serverTimestamp(),
    updatedAt:   F.serverTimestamp(),
    resolvedAt:  null,
  };
  if (orderId) payload.orderId = orderId;

  const ref = await db.collection('crmSupportTickets').add(payload);

  // Alert for urgent tickets
  if (priority === 'urgent') {
    await db.collection('adminAlerts').add({
      type:      'urgent_support_ticket',
      ticketId:  ref.id,
      merchantId,
      subject,
      createdAt: F.serverTimestamp(),
      read:      false,
    }).catch((e) => log.warn('admin_alert_failed', { err: e.message }));
  }

  log.audit('ticket_created', { ticketId: ref.id, merchantId, priority });
  return { ticketId: ref.id };
});

/* ═══════════════════════════════════════════════════════════════════════════
   11. updateSupportTicket
═══════════════════════════════════════════════════════════════════════════ */
exports.updateSupportTicket = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('updateSupportTicket');
  const uid = requireAuth(req);

  const ticketId = requireStr(req.data.ticketId, 'ticketId', 64);

  const snap = await db.collection('crmSupportTickets').doc(ticketId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Ticket not found.');
  const ticket = snap.data();

  await assertMerchantOwner(uid, ticket.merchantId);

  const updates = { updatedAt: F.serverTimestamp() };

  if (req.data.status !== undefined) {
    const newStatus = requireEnum(req.data.status, TICKET_STATUSES, 'status');
    // Guard invalid transitions
    if (ticket.status === 'closed' && newStatus !== 'closed') {
      throw new HttpsError('failed-precondition', 'Closed tickets cannot be reopened.');
    }
    updates.status = newStatus;
    if (newStatus === 'resolved' || newStatus === 'closed') {
      updates.resolvedAt = F.serverTimestamp();
    }
  }
  if (req.data.assignedTo !== undefined) updates.assignedTo = requireStr(req.data.assignedTo, 'assignedTo', 64);
  if (req.data.notes !== undefined) {
    // Append notes as a sub-update (stored in resolutionNotes)
    updates.resolutionNotes = sanitizeStr(req.data.notes, 5000);
  }

  await db.collection('crmSupportTickets').doc(ticketId).update(updates);
  log.audit('ticket_updated', { ticketId, updates: Object.keys(updates) });
  return { success: true };
});

/* ═══════════════════════════════════════════════════════════════════════════
   12. getCRMDashboard
═══════════════════════════════════════════════════════════════════════════ */
exports.getCRMDashboard = onCall({ ...OPT, secrets: [ANTHROPIC_KEY] }, async (req) => {
  const log = mkLogger('getCRMDashboard');
  const uid = requireAuth(req);

  const merchantId = requireStr(req.data.merchantId, 'merchantId', 64);
  await assertMerchantOwner(uid, merchantId);

  const now         = new Date();
  const startOfDay  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOf30d  = new Date(Date.now() - 30 * 86_400_000);

  // Parallel queries
  const [
    leadsSnap,
    ticketsSnap,
    churnHighSnap,
    topCLVSnap,
    newLeadsTodaySnap,
    leads30dSnap,
  ] = await Promise.all([
    db.collection('crmLeads').where('merchantId', '==', merchantId).get(),
    db.collection('crmSupportTickets').where('merchantId', '==', merchantId).where('status', 'in', ['open', 'in_progress']).get(),
    db.collection('crmCustomerProfiles').where('merchantId', '==', merchantId).where('churnRiskLevel', '==', 'high').get(),
    db.collection('crmCustomerProfiles').where('merchantId', '==', merchantId).orderBy('clv', 'desc').limit(5).get(),
    db.collection('crmLeads').where('merchantId', '==', merchantId).where('createdAt', '>=', startOfDay).get(),
    db.collection('crmLeads').where('merchantId', '==', merchantId).where('createdAt', '>=', startOf30d).get(),
  ]);

  // Lead pipeline counts by status
  const leadCounts = { new: 0, contacted: 0, qualified: 0, converted: 0, lost: 0 };
  for (const doc of leadsSnap.docs) {
    const s = doc.data().status;
    if (leadCounts[s] !== undefined) leadCounts[s]++;
  }

  // Ticket counts by priority
  const ticketByPriority = { low: 0, medium: 0, high: 0, urgent: 0 };
  for (const doc of ticketsSnap.docs) {
    const p = doc.data().priority;
    if (ticketByPriority[p] !== undefined) ticketByPriority[p]++;
  }

  // Conversion rate last 30d
  const leads30d       = leads30dSnap.size;
  const converted30d   = leads30dSnap.docs.filter((d) => d.data().status === 'converted').length;
  const conversionRate = leads30d > 0 ? parseFloat(((converted30d / leads30d) * 100).toFixed(1)) : 0;

  // Top 5 customers by CLV
  const topCustomers = topCLVSnap.docs.map((doc) => {
    const d = doc.data();
    return { uid: doc.id, name: d.name || '', clv: d.clv || 0, segment: d.segment, orderCount: d.orderCount || 0 };
  });

  log.info('crm_dashboard_fetched', { merchantId });
  return {
    leads: {
      pipeline:    leadCounts,
      total:       leadsSnap.size,
      newToday:    newLeadsTodaySnap.size,
      conversionRate,
    },
    tickets: {
      open:        ticketsSnap.size,
      byPriority:  ticketByPriority,
    },
    churnRisk: {
      highCount:   churnHighSnap.size,
    },
    topCustomers,
    conversionRate,
    newLeadsToday: newLeadsTodaySnap.size,
  };
});

/* ═══════════════════════════════════════════════════════════════════════════
   13. computeChurnRiskDaily  (Scheduled — 03:00 UTC / 06:00 EAT)
═══════════════════════════════════════════════════════════════════════════ */
exports.computeChurnRiskDaily = onSchedule(
  { schedule: '0 3 * * *', region: REGION, secrets: [ANTHROPIC_KEY] },
  async () => {
    const log = mkLogger('computeChurnRiskDaily');
    log.info('churn_recalc_started');

    let processed = 0;
    let lastDoc   = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let q = db.collection('crmCustomerProfiles').orderBy('__name__').limit(100);
      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;

      const batch = db.batch();
      for (const doc of snap.docs) {
        const d = doc.data();
        const { score, level } = computeChurnScore(d.lastOrderAt);
        batch.update(doc.ref, {
          churnRiskScore: score,
          churnRiskLevel: level,
          updatedAt:      F.serverTimestamp(),
        });
        processed++;
      }
      await batch.commit();

      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.size < 100) break;
    }

    log.audit('churn_recalc_complete', { processed });
  },
);
