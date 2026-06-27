/* ================================================================
   SOKONI Commission Engine — Rule Management CFs  v1.0
   4 Cloud Functions (all admin-only):
     createCommissionRule  — create any rule type
     updateCommissionRule  — edit existing rule
     deleteCommissionRule  — soft-delete (sets isActive=false)
     listCommissionRules   — paginated list with filters
     previewCommission     — live calculation preview (admin + seller)
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');

const REGION = 'us-central1';

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/* Valid rule types */
const RULE_TYPES = new Set(['percentage', 'fixed', 'percentage_plus_fixed', 'tiered', 'commission_holiday']);

/* Valid hub categories */
const CATEGORIES = new Set([
  'marketplace', 'services', 'food_delivery', 'bookings', 'events',
  'digital_products', 'property', 'vehicles', 'jobs', 'classifieds',
  'healthcare', 'education', 'legal', 'insurance', 'logistics',
  'financial_services', 'pharmacy', 'freelancers', 'hotels', 'hub',
  'subscriptions', 'advertising', 'all',
]);

function _validateRule(data) {
  const { type, category, rate, amountCents, tiers, minCommissionCents, maxCommissionCents,
          activeFrom, activeTo, entityId, entityType, description, isActive } = data;

  if (!type || !RULE_TYPES.has(type))
    throw new HttpsError('invalid-argument', `type must be one of: ${[...RULE_TYPES].join(', ')}`);

  if (!category || !CATEGORIES.has(category))
    throw new HttpsError('invalid-argument', `category must be one of: ${[...CATEGORIES].join(', ')}`);

  if (type === 'percentage' || type === 'percentage_plus_fixed') {
    if (typeof rate !== 'number' || rate < 0 || rate > 100)
      throw new HttpsError('invalid-argument', 'rate must be 0–100 for percentage rules');
  }
  if (type === 'fixed' || type === 'percentage_plus_fixed') {
    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents < 0)
      throw new HttpsError('invalid-argument', 'amountCents must be a non-negative integer');
  }
  if (type === 'tiered') {
    if (!Array.isArray(tiers) || tiers.length === 0)
      throw new HttpsError('invalid-argument', 'tiered rules require at least one tier');
    for (const t of tiers) {
      if (typeof t.rate !== 'number' || t.rate < 0 || t.rate > 100)
        throw new HttpsError('invalid-argument', 'each tier.rate must be 0–100');
    }
  }
  if (type === 'commission_holiday') {
    if (!activeFrom || !activeTo)
      throw new HttpsError('invalid-argument', 'commission_holiday requires activeFrom and activeTo');
  }
  if (entityId && !entityType)
    throw new HttpsError('invalid-argument', 'entityType required when entityId is set (seller|hub|buyer)');
  if (minCommissionCents != null && (!Number.isInteger(minCommissionCents) || minCommissionCents < 0))
    throw new HttpsError('invalid-argument', 'minCommissionCents must be a non-negative integer');
  if (maxCommissionCents != null && (!Number.isInteger(maxCommissionCents) || maxCommissionCents < 0))
    throw new HttpsError('invalid-argument', 'maxCommissionCents must be a non-negative integer');
  if (minCommissionCents != null && maxCommissionCents != null && minCommissionCents > maxCommissionCents)
    throw new HttpsError('invalid-argument', 'minCommissionCents must be <= maxCommissionCents');
}

function _buildRuleDoc(data, adminUid) {
  const {
    type, category, rate, amountCents, tiers,
    minCommissionCents, maxCommissionCents,
    activeFrom, activeTo,
    entityId, entityType,
    description, priority, isActive,
  } = data;

  const doc = {
    type,
    category,
    isActive:             isActive !== false,
    description:          description || '',
    priority:             typeof priority === 'number' ? priority : 0,
    entityId:             entityId  || null,
    entityType:           entityType || null,
    minCommissionCents:   minCommissionCents ?? null,
    maxCommissionCents:   maxCommissionCents ?? null,
    activeFrom:           activeFrom ? new Date(activeFrom) : null,
    activeTo:             activeTo   ? new Date(activeTo)   : null,
    createdBy:            adminUid,
    updatedBy:            adminUid,
    updatedAt:            _now(),
  };

  if (type === 'percentage')              { doc.rate = rate; }
  if (type === 'fixed')                   { doc.amountCents = amountCents; }
  if (type === 'percentage_plus_fixed')   { doc.rate = rate; doc.amountCents = amountCents; }
  if (type === 'tiered')                  { doc.tiers = tiers; }
  if (type === 'commission_holiday')      { doc.rate = 0; doc.amountCents = 0; }

  return doc;
}

/* ─────────────────────────────────────────────────────────────
   1. createCommissionRule
──────────────────────────────────────────────────────────────*/
exports.createCommissionRule = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    _assertAdmin(req);
    _validateRule(req.data);

    const db   = _db();
    const doc  = _buildRuleDoc(req.data, req.auth.uid);
    doc.createdAt = _now();

    const ref  = await db.collection('commissionRules').add(doc);

    await db.collection('finosAuditLog').add({
      action:    'commission_rule_created',
      ruleId:    ref.id,
      rule:      doc,
      adminUid:  req.auth.uid,
      createdAt: _now(),
    });

    logger.info('[commission] Rule created', { ruleId: ref.id, type: doc.type, category: doc.category });
    return { ruleId: ref.id, status: 'created' };
  }
);

/* ─────────────────────────────────────────────────────────────
   2. updateCommissionRule
──────────────────────────────────────────────────────────────*/
exports.updateCommissionRule = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    _assertAdmin(req);
    const { ruleId, ...rest } = req.data;
    if (!ruleId) throw new HttpsError('invalid-argument', 'ruleId required');

    _validateRule(rest);

    const db      = _db();
    const ref     = db.collection('commissionRules').doc(ruleId);
    const snap    = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Commission rule not found');

    const before  = snap.data();
    const updates = _buildRuleDoc(rest, req.auth.uid);
    delete updates.createdBy;   /* preserve original creator */
    delete updates.createdAt;

    await ref.update(updates);

    await db.collection('finosAuditLog').add({
      action:    'commission_rule_updated',
      ruleId,
      before,
      after:     updates,
      adminUid:  req.auth.uid,
      createdAt: _now(),
    });

    logger.info('[commission] Rule updated', { ruleId });
    return { ruleId, status: 'updated' };
  }
);

/* ─────────────────────────────────────────────────────────────
   3. deleteCommissionRule  (soft delete)
──────────────────────────────────────────────────────────────*/
exports.deleteCommissionRule = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    _assertAdmin(req);
    const { ruleId } = req.data;
    if (!ruleId) throw new HttpsError('invalid-argument', 'ruleId required');

    const db   = _db();
    const ref  = db.collection('commissionRules').doc(ruleId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Rule not found');

    await ref.update({ isActive: false, deletedAt: _now(), deletedBy: req.auth.uid, updatedAt: _now() });

    await db.collection('finosAuditLog').add({
      action:   'commission_rule_deleted',
      ruleId,
      adminUid: req.auth.uid,
      createdAt: _now(),
    });

    logger.info('[commission] Rule deactivated', { ruleId });
    return { ruleId, status: 'deleted' };
  }
);

/* ─────────────────────────────────────────────────────────────
   4. listCommissionRules
──────────────────────────────────────────────────────────────*/
exports.listCommissionRules = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    _assertAdmin(req);
    const { includeInactive, category, type, entityId } = req.data || {};

    const db = _db();
    let q    = db.collection('commissionRules');

    if (!includeInactive) q = q.where('isActive', '==', true);
    if (category)         q = q.where('category', '==', category);
    if (type)             q = q.where('type',     '==', type);
    if (entityId)         q = q.where('entityId', '==', entityId);

    const snap  = await q.orderBy('priority', 'desc').limit(200).get();
    const rules = snap.docs.map(d => ({
      id: d.id,
      ...d.data(),
      createdAt: d.data().createdAt?.toMillis?.() || null,
      updatedAt: d.data().updatedAt?.toMillis?.() || null,
      activeFrom: d.data().activeFrom?.toMillis?.() || null,
      activeTo:   d.data().activeTo?.toMillis?.()   || null,
    }));

    return { rules, total: rules.length };
  }
);

/* ─────────────────────────────────────────────────────────────
   5. previewCommission — live calc for admin + sellers
──────────────────────────────────────────────────────────────*/
exports.previewCommission = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');

    const { orderAmountKES, category, sellerId } = req.data;
    if (!orderAmountKES || !category)
      throw new HttpsError('invalid-argument', 'orderAmountKES and category required');
    if (typeof orderAmountKES !== 'number' || orderAmountKES <= 0)
      throw new HttpsError('invalid-argument', 'orderAmountKES must be a positive number');

    const U = require('./finos-utils');
    const db = _db();
    const orderAmountCents = Math.round(orderAmountKES * 100);

    const comm = await U.calculateCommission(db, {
      orderAmountCents,
      category,
      sellerId: sellerId || null,
    });

    const vat  = U.calculateVAT(comm.commissionCents, category);
    const wht  = U.calculateWHT(comm.sellerNetCents);

    return {
      orderAmountKES,
      category,
      effectiveRate:       comm.effectiveRate,
      commissionKES:       comm.commissionCents   / 100,
      sellerNetKES:        comm.sellerNetCents     / 100,
      vatKES:              vat.taxCents            / 100,
      vatRate:             vat.taxRate,
      vatExempt:           !!vat.isExempt,
      whtKES:              wht.whtCents            / 100,
      whtRate:             wht.whtRate,
      ruleId:              comm.ruleId,
      ruleSource:          comm.ruleSource,
      sellerReceivesKES:   (comm.sellerNetCents - wht.whtCents) / 100,
    };
  }
);
