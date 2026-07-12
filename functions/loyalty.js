'use strict';
/**
 * SOKONI Universal Loyalty & Rewards Engine v2.0
 * Firebase Gen2 / Node.js 22 — Enterprise Edition
 *
 * Performance targets:
 *   Reward calculation  < 100 ms
 *   Checkout completion < 3 s (incl. payment)
 *   Push notification   < 2 s
 *   100,000+ customers Â· 10,000+ merchants Â· Millions of transactions
 *
 * Collections:
 *   loyaltyAccounts/{uid}         — one per customer (uid = Firebase Auth UID)
 *   loyaltyLedger/{entryId}       — immutable double-entry ledger
 *   loyaltyTransactions/{txId}    — v1 ledger (preserved for backward compat)
 *   loyaltyMerchantConfigs/{mid}  — per-merchant program rules
 *   loyaltyCampaigns/{cid}        — time-bounded bonus campaigns
 *   loyaltyRewards/{rid}          — redeemable reward catalog
 *   loyaltyRedemptions/{redId}    — redemption audit records
 *   loyaltyCards/{cardId}         — physical / NFC card registry
 *   loyaltyRules/default          — global platform defaults (v1 compat)
 *
 * DEPLOYMENT: set secret LOYALTY_HMAC_SECRET in Firebase Secret Manager
 *   firebase functions:secrets:set LOYALTY_HMAC_SECRET
 */

const { onCall, HttpsError }    = require('firebase-functions/v2/https');
const { onSchedule }            = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const admin                     = require('firebase-admin');
const _notifyEngine = require('./notify');   /* ONE push-token source */
const crypto                    = require('crypto');
const { defineSecret }          = require('firebase-functions/params');
const { logger }                = require('firebase-functions');

const LOYALTY_HMAC = defineSecret('LOYALTY_HMAC_SECRET');
const REGION = 'us-central1';
const OPT    = { region: REGION, enforceAppCheck: true };

// Handler registry — populated below; consumed by loyalty-dispatch.js dispatcher
exports._h = {};

// ── Firestore helpers ─────────────────────────────────────────────────────────

const _db   = () => getFirestore();
const _now  = () => FieldValue.serverTimestamp();
const _INC  = (n) => FieldValue.increment(n);
const _ARR  = (...v) => FieldValue.arrayUnion(...v);

function _san(v, max = 256) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.replace(/[<>"'`\\]/g, '').trim().slice(0, max);
}

function _safeInt(v) {
  const n = Math.floor(Number(v));
  return isNaN(n) ? 0 : Math.max(0, n);
}

function _requireAuth(ctx) {
  if (!ctx.auth) throw new HttpsError('unauthenticated', 'Login required');
  return ctx.auth;
}

function _requireAdmin(ctx) {
  const auth = _requireAuth(ctx);
  if (!auth.token?.admin && !auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin required');
  return auth;
}

function _requireMerchant(ctx) {
  const auth = _requireAuth(ctx);
  const t = auth.token || {};
  if (!t.admin && !t.superAdmin && !t.seller && t.role !== 'merchant')
    throw new HttpsError('permission-denied', 'Merchant or admin access required');
  return auth;
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

function _hmac16(secret, data) {
  return crypto.createHmac('sha256', secret).update(String(data)).digest('hex').slice(0, 16);
}

function _ledgerKey(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function _generateLoyaltyId() {
  const hex = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `SKN-${hex()}-${hex()}-${hex()}`;
}

function _generateCardNumber() {
  const rand = crypto.randomBytes(5).readUIntBE(0, 5).toString().padStart(10, '0').slice(0, 10);
  return `628400${rand}`;
}

// ── Tier Engine ───────────────────────────────────────────────────────────────

const TIERS = [
  { name: 'Bronze',   key: 'bronze',   min: 0,      max: 4999,   multiplier: 1.0, color: '#CD7F32', icon: '🥉' },
  { name: 'Silver',   key: 'silver',   min: 5000,   max: 19999,  multiplier: 1.5, color: '#C0C0C0', icon: '🥈' },
  { name: 'Gold',     key: 'gold',     min: 20000,  max: 49999,  multiplier: 2.0, color: '#FFD700', icon: '🥇' },
  { name: 'Platinum', key: 'platinum', min: 50000,  max: 99999,  multiplier: 3.0, color: '#E5E4E2', icon: '💎' },
  { name: 'Diamond',  key: 'diamond',  min: 100000, max: null,   multiplier: 5.0, color: '#B9F2FF', icon: '💠' },
];

function _tierFor(lifetimePoints) {
  const pts = _safeInt(lifetimePoints);
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (pts >= TIERS[i].min) return TIERS[i];
  }
  return TIERS[0];
}

function _nextTierInfo(lifetimePoints) {
  const current = _tierFor(lifetimePoints);
  const idx     = TIERS.findIndex(t => t.key === current.key);
  if (idx === TIERS.length - 1)
    return { maxed: true, tier: 'diamond', pointsNeeded: 0, nextTierName: 'Diamond' };
  const next = TIERS[idx + 1];
  return {
    maxed: false,
    tier: next.key, nextTierName: next.name, color: next.color,
    pointsNeeded: Math.max(0, next.min - _safeInt(lifetimePoints)),
  };
}

// ── Points Calculator ─────────────────────────────────────────────────────────

function _calcPoints(amountKES, config, tierKey, activeCampaigns = []) {
  if (amountKES < (config.minPurchaseKES || 0))
    return { basePoints: 0, tierBonus: 0, weekendBonus: 0, campaignBonus: 0, total: 0 };

  const rate     = config.pointsPerKES || 0.1;   // 1 pt per KES 10
  const tierDef  = TIERS.find(t => t.key === tierKey) || TIERS[0];
  const tierMult = (config.tierMultipliers || {})[tierKey] ?? tierDef.multiplier;
  const base     = Math.floor(amountKES * rate);
  const tierBonus = Math.floor(base * (tierMult - 1));

  const dow       = new Date().getDay();
  const isWeekend = dow === 0 || dow === 6;
  const weekendBonus = isWeekend && config.weekendBonus > 0
    ? Math.floor(base * config.weekendBonus / 100) : 0;

  let campaignBonus = 0;
  for (const c of activeCampaigns) {
    if (!c.active) continue;
    const bv = Number(c.bonusValue) || 0;
    if (c.bonusType === 'multiplier') campaignBonus += Math.floor(base * (bv - 1));
    else if (c.bonusType === 'fixed') campaignBonus += Math.floor(bv);
    else if (c.bonusType === 'percent') campaignBonus += Math.floor(amountKES * bv / 100);
  }

  return { basePoints: base, tierBonus, weekendBonus, campaignBonus, total: base + tierBonus + weekendBonus + campaignBonus };
}

// ── Default config ────────────────────────────────────────────────────────────

function _defaultConfig(merchantId) {
  return {
    merchantId: merchantId || 'sokoni', programName: 'SOKONI Rewards',
    pointsPerKES: 0.1, minPurchaseKES: 0,
    redemptionRate: 100,    // 100 pts = KES 1
    maxRedemptionPct: 50,   // max 50% of bill payable by points
    scope: 'merchant',
    tierMultipliers: { bronze: 1, silver: 1.5, gold: 2, platinum: 3, diamond: 5 },
    categoryMultipliers: {}, weekendBonus: 0,
    birthdayBonus: 500, welcomePoints: 125, referralPoints: 200,
    pointsExpiryMonths: 12, active: true,
  };
}

// ── Global platform rules (v1 compat) ────────────────────────────────────────

async function _getRules() {
  try {
    const snap = await _db().collection('loyaltyRules').doc('default').get();
    if (snap.exists) return snap.data();
  } catch (_) {}
  return { earnRate: 1, redemptionRate: 10, minRedemption: 500, maxBonusPoints: 1000, reviewBonus: 5, referralBonus: 50, profileBonus: 10 };
}

// ── FCM notification ──────────────────────────────────────────────────────────

async function _notify(uid, title, body, data = {}) {
  try {
    /* Token source is the notification engine — the ONE place that knows where a push
       token lives.

       This used to query a top-level collection('fcmTokens'). NOTHING in the codebase
       ever wrote that collection: the client writes users/{uid}.fcmToken, a FIELD on the
       user document. So this query always returned empty and every loyalty push silently
       reached nobody, for as long as this function has existed. */
    const tokens = await _notifyEngine.collectTokens(uid);
    if (!tokens.length) return;
    await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'normal' },
      apns: { payload: { aps: { sound: 'default' } } },
    }).catch(e => logger.warn('[loyalty] FCM error', e.message));
  } catch (e) {
    logger.warn('[loyalty] Notify failed', { uid, error: e.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 1 — createLoyaltyAccount
// Creates full enterprise account: profile + QR + barcode + welcome points.
// Called by POS at checkout or by customer in-app.
// ═════════════════════════════════════════════════════════════════════════════

exports.createLoyaltyAccount = onCall({ ...OPT, secrets: [LOYALTY_HMAC], timeoutSeconds: 30 }, exports._h.createLoyaltyAccount = async (req) => {
  const auth = _requireAuth(req);
  const { phone, name, email, birthdayMonth, birthdayDay, referredBy, merchantId } = req.data || {};

  if (!phone) throw new HttpsError('invalid-argument', 'phone is required');

  const db = _db();

  // One account per phone — best-effort guard (collection query cannot be atomic inside a
  // Firestore transaction; the UID doc check inside runTransaction below is the authoritative
  // idempotency guard for concurrent calls on the same UID).
  const phoneCheck = await db.collection('loyaltyAccounts')
    .where('phone', '==', _san(phone, 20)).limit(1).get();
  if (!phoneCheck.empty) throw new HttpsError('already-exists', 'An account already exists for this phone number');

  const mid         = _san(merchantId || 'sokoni', 64);
  const loyaltyId   = _generateLoyaltyId();
  const cardNumber  = _generateCardNumber();
  const secret      = LOYALTY_HMAC.value();
  const qrSig       = _hmac16(secret, `${loyaltyId}:${auth.uid}`);
  const qrPayload   = `sokoni_loyalty:${loyaltyId}:${qrSig}`;

  // Load merchant config for welcome points
  const cfgSnap     = await db.collection('loyaltyMerchantConfigs').doc(mid).get();
  const config      = cfgSnap.exists ? cfgSnap.data() : _defaultConfig(mid);
  const welcome     = config.welcomePoints || 125;
  const tierInfo    = _tierFor(welcome);

  const account = {
    uid: auth.uid, loyaltyId, cardNumber, qrPayload,
    phone: _san(phone, 20), name: _san(name || '', 128), email: _san(email || '', 128),
    birthdayMonth: Number(birthdayMonth) || null, birthdayDay: Number(birthdayDay) || null,
    // Points
    balance: welcome, lifetimePoints: welcome, totalEarned: welcome,
    totalRedeemed: 0, expiredPoints: 0,
    tier: tierInfo.key, tierName: tierInfo.name,
    // Meta
    linkedCards: [], status: 'active', fraudRiskScore: 0,
    lastMerchantId: mid, lastUpdated: _now(), joinedAt: _now(),
    birthdayRewardYear: null, referredBy: referredBy ? _san(referredBy, 64) : null,
  };

  // Pre-fetch referrer reference OUTSIDE the transaction — collection queries are not supported
  // inside Firestore transactions. The referrer doc is re-read inside the txn via txn.get() to
  // obtain a consistent balance snapshot before writing.
  let referrerRef = null;
  if (referredBy) {
    const refSnap = await db.collection('loyaltyAccounts')
      .where('loyaltyId', '==', _san(referredBy, 24)).limit(1).get();
    if (!refSnap.empty) referrerRef = refSnap.docs[0].ref;
  }

  let isReplay = false; let replayData = null;
  await db.runTransaction(async (txn) => {
    // Idempotency — atomic UID-account guard; FIRST read inside tx so every retry also checks.
    // Two concurrent createLoyaltyAccount calls for the same UID will both enter the transaction
    // but only one will commit; the second retry will see the document and short-circuit.
    const uidSnap = await txn.get(db.collection('loyaltyAccounts').doc(auth.uid));
    if (uidSnap.exists) { isReplay = true; replayData = uidSnap.data(); return; }

    // Re-read referrer inside the transaction to get a consistent balance snapshot for the write.
    let referrerSnap = null;
    if (referrerRef) referrerSnap = await txn.get(referrerRef);

    txn.set(db.collection('loyaltyAccounts').doc(auth.uid), account);

    // Welcome ledger entry
    const wKey = _ledgerKey(['welcome', auth.uid]);
    txn.set(db.collection('loyaltyLedger').doc(wKey), {
      uid: auth.uid, loyaltyId, type: 'welcome', merchantId: mid,
      points: welcome, bonusPoints: 0, amountKES: 0,
      balanceBefore: 0, balanceAfter: welcome,
      description: 'Welcome bonus', idempotencyKey: wKey, createdAt: _now(),
    });

    // Referral bonus to referrer
    if (referrerSnap && referrerSnap.exists) {
      const refBonus = config.referralPoints || 200;
      txn.update(referrerRef, { balance: _INC(refBonus), lifetimePoints: _INC(refBonus), totalEarned: _INC(refBonus), lastUpdated: _now() });
      const rKey = _ledgerKey(['referral', referrerSnap.id, auth.uid]);
      txn.set(db.collection('loyaltyLedger').doc(rKey), {
        uid: referrerSnap.id, type: 'referral', merchantId: mid,
        points: refBonus, bonusPoints: 0, amountKES: 0,
        balanceBefore: referrerSnap.data().balance || 0, balanceAfter: (referrerSnap.data().balance || 0) + refBonus,
        description: `Referral: ${_san(name || phone, 40)} joined`,
        idempotencyKey: rKey, createdAt: _now(),
      });
    }
  });

  if (isReplay) return { ...replayData, already_exists: true };
  _notify(auth.uid, 'Welcome to SOKONI Rewards! 🎉',
    `You earned ${welcome} welcome points. Show your QR code at any checkout.`,
    { type: 'loyalty_welcome', points: welcome }).catch(() => {});

  logger.info('[loyalty] Account created', { uid: auth.uid, loyaltyId });
  return { ...account, welcomePoints: welcome };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 2 — lookupLoyaltyCustomer
// POS: find customer by phone / QR / email / loyaltyId / cardNumber.
// Returns cashier-safe profile + active campaigns for checkout.
// ═════════════════════════════════════════════════════════════════════════════

exports.lookupLoyaltyCustomer = onCall({ ...OPT, secrets: [LOYALTY_HMAC], timeoutSeconds: 10 }, exports._h.lookupLoyaltyCustomer = async (req) => {
  _requireAuth(req);
  const { by, value, merchantId } = req.data || {};
  if (!by || !value) throw new HttpsError('invalid-argument', 'by and value required');

  const db   = _db();
  const safe = _san(value, 128);
  let doc;

  if (by === 'uid') {
    const s = await db.collection('loyaltyAccounts').doc(safe).get();
    doc = s.exists ? s : null;
  } else if (by === 'qr') {
    // Validate QR: "sokoni_loyalty:{loyaltyId}:{sig}"
    const parts = value.split(':');
    if (parts.length !== 3 || parts[0] !== 'sokoni_loyalty')
      throw new HttpsError('invalid-argument', 'Invalid QR code');
    const [, loyaltyId] = parts;
    const res = await db.collection('loyaltyAccounts').where('loyaltyId', '==', loyaltyId).limit(1).get();
    doc = res.docs[0] || null;
  } else {
    const field = { phone: 'phone', email: 'email', loyaltyId: 'loyaltyId', cardNumber: 'cardNumber' }[by];
    if (!field) throw new HttpsError('invalid-argument', `Unknown lookup type: ${by}`);
    const res = await db.collection('loyaltyAccounts').where(field, '==', safe).limit(1).get();
    doc = res.docs[0] || null;
  }

  if (!doc) throw new HttpsError('not-found', 'No loyalty account found');
  const data = doc.data ? doc.data() : doc;
  if (data.status === 'blocked') throw new HttpsError('permission-denied', 'Account suspended');

  // Active campaigns for this merchant
  let campaigns = [];
  if (merchantId) {
    const now   = admin.firestore.Timestamp.now();
    const today = new Date().getDay();
    const cSnap = await db.collection('loyaltyCampaigns')
      .where('merchantId', '==', _san(merchantId, 64))
      .where('active', '==', true)
      .where('startsAt', '<=', now)
      .limit(10).get();
    campaigns = cSnap.docs.map(d => d.data())
      .filter(c => !c.endsAt || c.endsAt.toMillis() >= now.toMillis())
      .filter(c => !c.daysOfWeek?.length || c.daysOfWeek.includes(today))
      .map(({ id, name, bonusType, bonusValue, description }) => ({ id, name, bonusType, bonusValue, description }));
  }

  const tierInfo = _tierFor(data.lifetimePoints || data.balance || 0);
  const next     = _nextTierInfo(data.lifetimePoints || 0);
  return {
    uid: data.uid, loyaltyId: data.loyaltyId,
    name: data.name, phone: data.phone,
    tier: tierInfo.key, tierName: tierInfo.name, tierColor: tierInfo.color, tierIcon: tierInfo.icon,
    balance: data.balance || 0, lifetimePoints: data.lifetimePoints || 0,
    nextTier: next, activeCampaigns: campaigns,
  };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 3 — awardLoyaltyPoints
// Post-checkout points award. Atomic. Idempotent per orderId.
// Called by POS after payment or triggered by order completion.
// ═════════════════════════════════════════════════════════════════════════════

exports.awardLoyaltyPoints = onCall({ ...OPT, timeoutSeconds: 30 }, exports._h.awardLoyaltyPoints = async (req) => {
  _requireAuth(req);
  const {
    customerUid, amountKES, orderId, paymentId,
    merchantId, branchId, terminalId, cashierId,
    category, campaignIds = [],
  } = req.data || {};

  if (!customerUid)            throw new HttpsError('invalid-argument', 'customerUid required');
  if (!amountKES || amountKES <= 0) throw new HttpsError('invalid-argument', 'amountKES must be positive');
  if (!orderId)                throw new HttpsError('invalid-argument', 'orderId required');
  if (!merchantId)             throw new HttpsError('invalid-argument', 'merchantId required');

  const db  = _db();
  const mid = _san(merchantId, 64);
  const idKey = _ledgerKey(['earn', customerUid, orderId, mid]);

  // Load config + campaigns in parallel (non-critical config reads; idempotency is enforced
  // atomically inside the transaction below — no outer pre-check needed).
  const [cfgSnap, ...cSnaps] = await Promise.all([
    db.collection('loyaltyMerchantConfigs').doc(mid).get(),
    ...campaignIds.slice(0, 5).map(id => db.collection('loyaltyCampaigns').doc(id).get()),
  ]);
  const config = cfgSnap.exists ? cfgSnap.data() : _defaultConfig(mid);

  const now   = Date.now();
  const activeCampaigns = cSnaps
    .filter(s => s.exists && s.data().active &&
      s.data().startsAt?.toMillis() <= now &&
      (!s.data().endsAt || s.data().endsAt.toMillis() >= now))
    .map(s => s.data());

  let result;
  let isReplay = false; let replayData = null;
  await db.runTransaction(async (txn) => {
    // Idempotency — FIRST read inside tx so every retry (including contended retries) also
    // checks. Two concurrent awardLoyaltyPoints calls for the same idKey will both enter the
    // transaction but only one will commit the ledger write; the second retry sees the doc.
    const idemSnap = await txn.get(db.collection('loyaltyLedger').doc(idKey));
    if (idemSnap.exists) { isReplay = true; replayData = idemSnap.data(); return; }

    const accRef  = db.collection('loyaltyAccounts').doc(customerUid);
    const accSnap = await txn.get(accRef);
    if (!accSnap.exists) throw new HttpsError('not-found', 'Loyalty account not found');
    const acc = accSnap.data();
    if (acc.status === 'blocked') throw new HttpsError('permission-denied', 'Account suspended');

    const tierKey = acc.tier || 'bronze';
    const pts     = _calcPoints(amountKES, config, tierKey, activeCampaigns);

    // Category multiplier
    if (category && config.categoryMultipliers?.[category]) {
      const catBonus = Math.floor(pts.basePoints * (config.categoryMultipliers[category] - 1));
      pts.campaignBonus += catBonus;
      pts.total += catBonus;
    }

    // Birthday bonus
    let birthdayBonus = 0;
    const d = new Date();
    if (acc.birthdayMonth === d.getMonth() + 1 &&
        Math.abs((acc.birthdayDay || 0) - d.getDate()) <= 7 &&
        acc.birthdayRewardYear !== d.getFullYear()) {
      birthdayBonus = config.birthdayBonus || 500;
      pts.total += birthdayBonus;
      txn.update(accRef, { birthdayRewardYear: d.getFullYear() });
    }

    if (pts.total === 0) {
      result = { pointsAwarded: 0, newBalance: acc.balance || 0, tier: tierKey, message: 'No points earned' };
      return;
    }

    const balBefore    = acc.balance || 0;
    const balAfter     = balBefore + pts.total;
    const lifeBefore   = acc.lifetimePoints || 0;
    const lifeAfter    = lifeBefore + pts.total;
    const newTierInfo  = _tierFor(lifeAfter);
    const tierChanged  = newTierInfo.key !== tierKey;

    const expiryMs  = (config.pointsExpiryMonths || 12) * 30 * 24 * 60 * 60 * 1000;
    const expiresAt = config.pointsExpiryMonths > 0
      ? admin.firestore.Timestamp.fromMillis(now + expiryMs) : null;

    txn.update(accRef, {
      balance: balAfter, lifetimePoints: lifeAfter, totalEarned: _INC(pts.total),
      tier: newTierInfo.key, tierName: newTierInfo.name,
      lastUpdated: _now(), lastMerchantId: mid,
      ...(tierChanged && { tierUpdatedAt: _now() }),
    });

    txn.set(db.collection('loyaltyLedger').doc(idKey), {
      uid: customerUid, loyaltyId: acc.loyaltyId || null, type: 'earn',
      merchantId: mid, branchId: _san(branchId || '', 64),
      terminalId: _san(terminalId || '', 64), cashierId: _san(cashierId || '', 64),
      orderId: _san(orderId, 128), paymentId: _san(paymentId || '', 128),
      points: pts.total, basePoints: pts.basePoints,
      tierBonus: pts.tierBonus, weekendBonus: pts.weekendBonus,
      campaignBonus: pts.campaignBonus, birthdayBonus,
      amountKES: Math.round(amountKES * 100) / 100,
      balanceBefore: balBefore, balanceAfter: balAfter,
      tierBefore: tierKey, tierAfter: newTierInfo.key,
      category: _san(category || '', 64),
      description: `Earned at ${config.programName || 'SOKONI'}`,
      expiresAt, expired: false, idempotencyKey: idKey, createdAt: _now(),
    });

    result = {
      pointsAwarded: pts.total, breakdown: pts, birthdayBonus,
      newBalance: balAfter, lifetimePoints: lifeAfter,
      tier: newTierInfo.key, tierName: newTierInfo.name,
      tierChanged, nextTier: _nextTierInfo(lifeAfter), expiresAt,
    };
  });

  if (isReplay) return { ...replayData, idempotent: true };

  _notify(customerUid, `+${result.pointsAwarded} Points Earned!`,
    `Balance: ${result.newBalance.toLocaleString()} pts${result.tierChanged ? ' Â· Tier upgraded!' : ''}`,
    { type: 'loyalty_earned', points: result.pointsAwarded, balance: result.newBalance }).catch(() => {});

  logger.info('[loyalty] Points awarded', { customerUid, orderId, pts: result.pointsAwarded });
  return result;
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 4 — redeemLoyaltyPoints (enhanced v2)
// Deducts points before payment. Returns cashback KES amount.
// Enforces merchant's max redemption cap.
// ═════════════════════════════════════════════════════════════════════════════

exports.redeemLoyaltyPoints = onCall({ ...OPT, timeoutSeconds: 30 }, exports._h.redeemLoyaltyPoints = async (req) => {
  const auth = _requireAuth(req);
  const { pointsToRedeem, orderId, merchantId, totalAmountKES } = req.data || {};

  if (!pointsToRedeem || pointsToRedeem <= 0) throw new HttpsError('invalid-argument', 'pointsToRedeem must be positive');
  if (!orderId)        throw new HttpsError('invalid-argument', 'orderId required');
  if (!merchantId)     throw new HttpsError('invalid-argument', 'merchantId required');
  if (!totalAmountKES) throw new HttpsError('invalid-argument', 'totalAmountKES required');

  const db    = _db();
  const mid   = _san(merchantId, 64);
  const idKey = _ledgerKey(['redeem', auth.uid, orderId, mid]);

  const cfgSnap = await db.collection('loyaltyMerchantConfigs').doc(mid).get();
  const config  = cfgSnap.exists ? cfgSnap.data() : _defaultConfig(mid);

  let result;
  let isReplay = false; let replayData = null;
  await db.runTransaction(async (txn) => {
    // Idempotency — FIRST read inside tx so every retry (including contended retries) also
    // checks. Two concurrent redeemLoyaltyPoints calls with the same idKey will both enter
    // the transaction but only one will commit; the second retry sees the existing ledger doc.
    const idemSnap = await txn.get(db.collection('loyaltyLedger').doc(idKey));
    if (idemSnap.exists) { isReplay = true; replayData = idemSnap.data(); return; }

    const accRef  = db.collection('loyaltyAccounts').doc(auth.uid);
    const accSnap = await txn.get(accRef);
    if (!accSnap.exists) throw new HttpsError('not-found', 'Loyalty account not found');
    const acc = accSnap.data();
    if (acc.status === 'blocked') throw new HttpsError('permission-denied', 'Account suspended');

    const available = acc.balance || 0;
    if (pointsToRedeem > available)
      throw new HttpsError('failed-precondition', `Insufficient points. Available: ${available}`);

    const rate        = config.redemptionRate || 100;    // 100 pts = KES 1
    const maxPct      = config.maxRedemptionPct || 50;
    const maxKES      = Math.floor(totalAmountKES * maxPct / 100);
    const wantedKES   = Math.floor(pointsToRedeem / rate);
    const approvedKES = Math.min(wantedKES, maxKES);
    const approvedPts = Math.ceil(approvedKES * rate);
    const balAfter    = available - approvedPts;

    txn.update(accRef, {
      balance: balAfter, totalRedeemed: _INC(approvedPts), lastUpdated: _now(),
    });
    txn.set(db.collection('loyaltyLedger').doc(idKey), {
      uid: auth.uid, type: 'redeem', merchantId: mid, orderId: _san(orderId, 128),
      points: -approvedPts, bonusPoints: 0,
      balanceBefore: available, balanceAfter: balAfter,
      amountKES: totalAmountKES, cashbackKES: approvedKES,
      description: `Redeemed ${approvedPts} pts = KES ${approvedKES}`,
      idempotencyKey: idKey, createdAt: _now(),
    });
    result = { pointsRedeemed: approvedPts, cashbackKES: approvedKES, newBalance: balAfter };
  });

  if (isReplay) return { ...replayData, idempotent: true };

  logger.info('[loyalty] Points redeemed', { uid: auth.uid, orderId, ...result });
  return result;
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 5 — confirmLoyaltyRedemption
// Confirms or cancels a pending redemption. Returns to v1 compatibility.
// ═════════════════════════════════════════════════════════════════════════════

exports.confirmLoyaltyRedemption = onCall({ ...OPT, timeoutSeconds: 20 }, exports._h.confirmLoyaltyRedemption = async (req) => {
  const auth = _requireAuth(req);
  const { orderId, confirm = true, merchantId } = req.data || {};
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId required');

  const db    = _db();
  const mid   = _san(merchantId || 'sokoni', 64);
  const idKey = _ledgerKey(['redeem', auth.uid, orderId, mid]);

  const entry = await db.collection('loyaltyLedger').doc(idKey).get();
  if (!entry.exists) {
    // v1 compat: check loyaltyTransactions
    const txId  = `${auth.uid}_${orderId}_redeem`;
    const txDoc = await db.collection('loyaltyTransactions').doc(txId).get();
    if (!txDoc.exists) throw new HttpsError('not-found', 'Redemption not found');
  }

  if (!confirm) {
    // Cancel: refund the points back to the account
    await db.runTransaction(async (txn) => {
      const accRef  = db.collection('loyaltyAccounts').doc(auth.uid);
      const accSnap = await txn.get(accRef);
      const ledger  = entry.exists ? entry.data() : null;
      if (!ledger) return;
      const pts = Math.abs(ledger.points || 0);
      txn.update(accRef, { balance: _INC(pts), totalRedeemed: _INC(-pts), lastUpdated: _now() });
      txn.update(entry.ref, { cancelled: true, cancelledAt: _now() });
    });
    return { confirmed: false, status: 'cancelled' };
  }

  if (entry.exists) await entry.ref.update({ confirmed: true, confirmedAt: _now() });
  return { confirmed: true, status: 'settled' };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 6 — getLoyaltyAccount (v1 compat + enterprise fields)
// Returns caller's loyalty account, creating one on first call.
// ═════════════════════════════════════════════════════════════════════════════

exports.getLoyaltyAccount = onCall(OPT, exports._h.getLoyaltyAccount = async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = req.auth.uid;
  const db  = _db();
  const ref = db.collection('loyaltyAccounts').doc(uid);
  const snap = await ref.get();

  let data;
  if (!snap.exists) {
    data = { uid, balance: 0, lifetimePoints: 0, totalEarned: 0, totalRedeemed: 0,
      tier: 'bronze', tierName: 'Bronze', lastUpdated: _now() };
    await ref.set(data, { merge: true });
  } else {
    data = snap.data();
  }

  const tierInfo = _tierFor(data.lifetimePoints || data.balance || 0);
  const next     = _nextTierInfo(data.lifetimePoints || 0);
  return {
    uid: data.uid, loyaltyId: data.loyaltyId || null, cardNumber: data.cardNumber || null,
    qrPayload: data.qrPayload || null,
    balance: _safeInt(data.balance), lifetimePoints: _safeInt(data.lifetimePoints),
    tier: tierInfo.key, tierName: tierInfo.name, tierColor: tierInfo.color, tierIcon: tierInfo.icon,
    tierMultiplier: tierInfo.multiplier,
    totalEarned: _safeInt(data.totalEarned), totalRedeemed: _safeInt(data.totalRedeemed),
    nextTier: next, lastUpdated: data.lastUpdated || null, joinedAt: data.joinedAt || null,
    status: data.status || 'active',
  };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 7 — getLoyaltyCard
// Returns all data needed to render the digital membership card.
// ═════════════════════════════════════════════════════════════════════════════

exports.getLoyaltyCard = onCall({ ...OPT, timeoutSeconds: 10 }, exports._h.getLoyaltyCard = async (req) => {
  const auth = _requireAuth(req);
  const snap = await _db().collection('loyaltyAccounts').doc(auth.uid).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No loyalty account. Create one first.');
  const d        = snap.data();
  const tierInfo = _tierFor(d.lifetimePoints || d.balance || 0);
  return {
    loyaltyId: d.loyaltyId || null, cardNumber: d.cardNumber || null,
    qrPayload: d.qrPayload || null,
    name: d.name || '', phone: d.phone || '',
    tier: tierInfo.key, tierName: tierInfo.name, tierColor: tierInfo.color, tierIcon: tierInfo.icon,
    balance: _safeInt(d.balance), lifetimePoints: _safeInt(d.lifetimePoints),
    nextTier: _nextTierInfo(d.lifetimePoints || 0),
    linkedCards: d.linkedCards || [], joinedAt: d.joinedAt, status: d.status,
  };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 8 — getLoyaltyHistory (enhanced + v1 compat)
// Paginated ledger — reads from loyaltyLedger (v2) + loyaltyTransactions (v1).
// ═════════════════════════════════════════════════════════════════════════════

exports.getLoyaltyHistory = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.getLoyaltyHistory = async (req) => {
  const auth = _requireAuth(req);
  const { limit: lim = 20, startAfter, type } = req.data || {};
  const db = _db();

  let q = db.collection('loyaltyLedger')
    .where('uid', '==', auth.uid)
    .orderBy('createdAt', 'desc')
    .limit(Math.min(_safeInt(lim) || 20, 50));
  if (type) q = q.where('type', '==', _san(type, 32));
  if (startAfter) {
    const cur = await db.collection('loyaltyLedger').doc(startAfter).get();
    if (cur.exists) q = q.startAfter(cur);
  }

  const snap    = await q.get();
  const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // First page: also pull v1 loyaltyTransactions for backward compat
  if (!startAfter && !type) {
    const v1Snap = await db.collection('loyaltyTransactions')
      .where('uid', '==', auth.uid).orderBy('createdAt', 'desc').limit(10).get();
    const v1 = v1Snap.docs.map(d => ({ id: d.id, ...d.data(), _source: 'v1' }));
    entries.push(...v1);
    entries.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  }

  return { entries: entries.slice(0, 50), hasMore: snap.size === Math.min(_safeInt(lim) || 20, 50), lastId: snap.docs.at(-1)?.id || null };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 9 — getLoyaltyTiers
// Public tier definitions + current merchant earn rates.
// ═════════════════════════════════════════════════════════════════════════════

exports.getLoyaltyTiers = onCall(OPT, exports._h.getLoyaltyTiers = async (req) => {
  const { merchantId } = req.data || {};
  let config = _defaultConfig(merchantId || 'sokoni');
  if (merchantId) {
    const snap = await _db().collection('loyaltyMerchantConfigs').doc(_san(merchantId, 64)).get();
    if (snap.exists) config = snap.data();
  }
  return {
    tiers: TIERS.map(t => ({
      ...t,
      multiplier: (config.tierMultipliers || {})[t.key] ?? t.multiplier,
      benefits: t.key === 'bronze' ? ['1x points on all purchases']
        : t.key === 'silver' ? ['1.5x points', 'Priority customer support']
        : t.key === 'gold'   ? ['2x points', 'Birthday bonus', 'Free delivery on orders > KES 500']
        : t.key === 'platinum' ? ['3x points', 'Exclusive discounts', 'VIP events', 'Double points days']
        : ['5x points', 'Dedicated account manager', 'First access to products', 'Premium benefits'],
    })),
    earnRate: config.pointsPerKES || 0.1,
    redemptionRate: config.redemptionRate || 100,
    programName: config.programName || 'SOKONI Rewards',
  };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 10 — adminAdjustPoints (v1 compat alias)
// ═════════════════════════════════════════════════════════════════════════════

exports.adminAdjustPoints = onCall({ ...OPT, timeoutSeconds: 30 }, exports._h.adminAdjustPoints = async (req) => {
  const auth = _requireAdmin(req);
  const { uid: targetUid, points, reason } = req.data || {};
  if (!targetUid) throw new HttpsError('invalid-argument', 'uid required');
  if (!points || points === 0) throw new HttpsError('invalid-argument', 'points must be non-zero integer');
  if (Math.abs(points) > 100000) throw new HttpsError('invalid-argument', 'Max Â±100,000 per adjustment');
  if (!reason) throw new HttpsError('invalid-argument', 'reason required');

  const db     = _db();
  const idKey  = _ledgerKey(['adjust', targetUid, String(Date.now()), auth.uid]);

  await db.runTransaction(async (txn) => {
    const accRef  = db.collection('loyaltyAccounts').doc(targetUid);
    const accSnap = await txn.get(accRef);
    const acc     = accSnap.exists ? accSnap.data() : { balance: 0, lifetimePoints: 0 };
    const after   = Math.max(0, (acc.balance || 0) + points);
    const life    = points > 0 ? (acc.lifetimePoints || 0) + points : (acc.lifetimePoints || 0);
    const tierInfo = _tierFor(life);
    txn.set(accRef, { uid: targetUid, balance: after, lifetimePoints: life, totalEarned: _INC(Math.max(0, points)),
      tier: tierInfo.key, tierName: tierInfo.name, lastUpdated: _now() }, { merge: true });
    txn.set(db.collection('loyaltyLedger').doc(idKey), {
      uid: targetUid, type: 'adjust', merchantId: 'sokoni',
      points, balanceBefore: acc.balance || 0, balanceAfter: after,
      description: `Admin: ${_san(reason, 256)}`,
      adjustedBy: auth.uid, adjustmentReason: _san(reason, 256),
      idempotencyKey: idKey, createdAt: _now(),
    });
  });

  logger.info('[loyalty] Admin adjustment', { targetUid, points, adminUid: auth.uid });
  return { success: true, newBalance: 0 };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 11 — getLoyaltyLeaderboard (v1 compat)
// Top 10 earners — fully anonymised.
// ═════════════════════════════════════════════════════════════════════════════

exports.getLoyaltyLeaderboard = onCall(OPT, exports._h.getLoyaltyLeaderboard = async () => {
  const snap = await _db().collection('loyaltyAccounts').orderBy('lifetimePoints', 'desc').limit(10).get();
  return {
    leaderboard: snap.docs.map((d, i) => ({
      rank: i + 1, displayName: `Member #${i + 1}`,
      tier: d.data().tierName || d.data().tier || 'Bronze',
      totalEarned: _safeInt(d.data().lifetimePoints || d.data().totalEarned),
    })),
  };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 12 — configureLoyaltyProgram
// Merchant sets their loyalty program rules.
// ═════════════════════════════════════════════════════════════════════════════

exports.configureLoyaltyProgram = onCall({ ...OPT, timeoutSeconds: 20 }, exports._h.configureLoyaltyProgram = async (req) => {
  const auth = _requireMerchant(req);
  const { merchantId, ...cfg } = req.data || {};
  const mid = _san(merchantId || auth.uid, 64);

  if (cfg.pointsPerKES != null && (cfg.pointsPerKES < 0 || cfg.pointsPerKES > 100))
    throw new HttpsError('invalid-argument', 'pointsPerKES must be 0–100');
  if (cfg.redemptionRate != null && cfg.redemptionRate < 1)
    throw new HttpsError('invalid-argument', 'redemptionRate must be >= 1');
  if (cfg.maxRedemptionPct != null && (cfg.maxRedemptionPct < 0 || cfg.maxRedemptionPct > 100))
    throw new HttpsError('invalid-argument', 'maxRedemptionPct must be 0–100');

  const safe = {
    merchantId: mid,
    programName:        _san(cfg.programName || 'SOKONI Rewards', 128),
    pointsPerKES:       Number(cfg.pointsPerKES)        || 0.1,
    minPurchaseKES:     Number(cfg.minPurchaseKES)      || 0,
    redemptionRate:     Number(cfg.redemptionRate)      || 100,
    maxRedemptionPct:   Number(cfg.maxRedemptionPct)    || 50,
    scope:              ['merchant','hub','platform'].includes(cfg.scope) ? cfg.scope : 'merchant',
    tierMultipliers:    cfg.tierMultipliers || { bronze: 1, silver: 1.5, gold: 2, platinum: 3, diamond: 5 },
    categoryMultipliers: cfg.categoryMultipliers || {},
    weekendBonus:       Number(cfg.weekendBonus)        || 0,
    birthdayBonus:      Number(cfg.birthdayBonus)       || 500,
    welcomePoints:      Number(cfg.welcomePoints)       || 125,
    referralPoints:     Number(cfg.referralPoints)      || 200,
    pointsExpiryMonths: Number(cfg.pointsExpiryMonths)  || 12,
    active:             cfg.active !== false,
    updatedAt: _now(), updatedBy: auth.uid,
  };

  await _db().collection('loyaltyMerchantConfigs').doc(mid).set(safe, { merge: true });
  return { merchantId: mid, saved: true };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 13 — getMerchantLoyaltyConfig
// POS fetches active merchant config before calculating checkout points.
// ═════════════════════════════════════════════════════════════════════════════

exports.getMerchantLoyaltyConfig = onCall({ ...OPT, timeoutSeconds: 10 }, exports._h.getMerchantLoyaltyConfig = async (req) => {
  _requireAuth(req);
  const { merchantId } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required');
  const snap = await _db().collection('loyaltyMerchantConfigs').doc(_san(merchantId, 64)).get();
  return snap.exists ? snap.data() : _defaultConfig(merchantId);
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 14 — createLoyaltyCampaign
// Merchant creates a time-bounded bonus campaign.
// ═════════════════════════════════════════════════════════════════════════════

exports.createLoyaltyCampaign = onCall({ ...OPT, timeoutSeconds: 20 }, exports._h.createLoyaltyCampaign = async (req) => {
  const auth = _requireMerchant(req);
  const { merchantId, name, description, bonusType, bonusValue, startsAt, endsAt, daysOfWeek } = req.data || {};
  if (!name) throw new HttpsError('invalid-argument', 'name required');
  if (!['multiplier','fixed','percent'].includes(bonusType))
    throw new HttpsError('invalid-argument', 'bonusType must be multiplier|fixed|percent');

  const mid = _san(merchantId || auth.uid, 64);
  const ref = _db().collection('loyaltyCampaigns').doc();
  await ref.set({
    id: ref.id, merchantId: mid, name: _san(name, 128),
    description: _san(description || '', 512),
    bonusType, bonusValue: Number(bonusValue) || 0,
    daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek.map(Number) : [],
    startsAt: startsAt ? admin.firestore.Timestamp.fromMillis(Number(startsAt)) : admin.firestore.Timestamp.now(),
    endsAt: endsAt ? admin.firestore.Timestamp.fromMillis(Number(endsAt)) : null,
    active: true, createdAt: _now(), createdBy: auth.uid,
  });
  return { campaignId: ref.id };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 15 — getActiveCampaigns
// POS fetches campaigns before checkout. Filters by day-of-week.
// ═════════════════════════════════════════════════════════════════════════════

exports.getActiveCampaigns = onCall({ ...OPT, timeoutSeconds: 10 }, exports._h.getActiveCampaigns = async (req) => {
  _requireAuth(req);
  const { merchantId } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required');

  const now   = admin.firestore.Timestamp.now();
  const today = new Date().getDay();
  const snap  = await _db().collection('loyaltyCampaigns')
    .where('merchantId', '==', _san(merchantId, 64))
    .where('active', '==', true)
    .where('startsAt', '<=', now)
    .limit(20).get();

  const campaigns = snap.docs.map(d => d.data())
    .filter(c => !c.endsAt || c.endsAt.toMillis() >= now.toMillis())
    .filter(c => !c.daysOfWeek?.length || c.daysOfWeek.includes(today));

  return { campaigns };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 16 — getMerchantLoyaltyDashboard
// Merchant analytics: members, points, redemptions, top customers.
// ═════════════════════════════════════════════════════════════════════════════

exports.getMerchantLoyaltyDashboard = onCall({ ...OPT, timeoutSeconds: 30, memory: '256MiB' }, exports._h.getMerchantLoyaltyDashboard = async (req) => {
  const auth = _requireMerchant(req);
  const { merchantId, days = 30 } = req.data || {};
  const mid    = _san(merchantId || auth.uid, 64);
  const db     = _db();
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - _safeInt(days) * 24 * 60 * 60 * 1000);

  const [totalSnap, newSnap, earnSnap, redeemSnap] = await Promise.all([
    db.collection('loyaltyAccounts').where('lastMerchantId', '==', mid).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('loyaltyAccounts').where('lastMerchantId', '==', mid).where('joinedAt', '>=', cutoff).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('loyaltyLedger').where('merchantId', '==', mid).where('type', '==', 'earn').where('createdAt', '>=', cutoff).limit(500).get().catch(() => ({ docs: [] })),
    db.collection('loyaltyLedger').where('merchantId', '==', mid).where('type', '==', 'redeem').where('createdAt', '>=', cutoff).limit(500).get().catch(() => ({ docs: [] })),
  ]);

  const earns   = earnSnap.docs.map(d => d.data());
  const redeems = redeemSnap.docs.map(d => d.data());
  const issued   = earns.reduce((s, d) => s + (d.points || 0), 0);
  const redeemed = redeems.reduce((s, d) => s + Math.abs(d.points || 0), 0);
  const revenue  = earns.reduce((s, d) => s + (d.amountKES || 0), 0);
  const cashback = redeems.reduce((s, d) => s + (d.cashbackKES || 0), 0);

  const topMap = {};
  for (const d of earns) { if (d.uid) topMap[d.uid] = (topMap[d.uid] || 0) + (d.points || 0); }
  const topCustomers = Object.entries(topMap).sort(([,a],[,b]) => b - a).slice(0, 5).map(([uid, pts]) => ({ uid, pointsEarned: pts }));

  return {
    period: days,
    totalMembers: totalSnap.data().count, newMembers: newSnap.data().count,
    pointsIssued: issued, pointsRedeemed: redeemed,
    redemptionRate: issued > 0 ? Math.round(redeemed / issued * 100) : 0,
    cashbackKES: cashback, revenueFromMembers: revenue, topCustomers,
  };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 17 — createLoyaltyReward
// Merchant adds a redeemable reward to their catalog.
// ═════════════════════════════════════════════════════════════════════════════

exports.createLoyaltyReward = onCall({ ...OPT, timeoutSeconds: 20 }, exports._h.createLoyaltyReward = async (req) => {
  const auth = _requireMerchant(req);
  const { merchantId, name, description, pointsCost, rewardType, value, stock, expiresAt, imageUrl } = req.data || {};
  if (!name) throw new HttpsError('invalid-argument', 'name required');
  if (!pointsCost || pointsCost < 1) throw new HttpsError('invalid-argument', 'pointsCost must be >= 1');
  const valid = ['discount','cashback','free_item','gift_card','voucher','free_delivery','vip_upgrade','scratch_card','lucky_draw'];
  if (!valid.includes(rewardType)) throw new HttpsError('invalid-argument', 'Invalid rewardType');

  const mid = _san(merchantId || auth.uid, 64);
  const ref = _db().collection('loyaltyRewards').doc();
  await ref.set({
    id: ref.id, merchantId: mid, name: _san(name, 128),
    description: _san(description || '', 512),
    pointsCost: Math.floor(pointsCost), rewardType, value: Number(value) || 0,
    stock: stock != null ? Math.floor(Number(stock)) : null,
    imageUrl: _san(imageUrl || '', 512),
    expiresAt: expiresAt ? admin.firestore.Timestamp.fromMillis(Number(expiresAt)) : null,
    totalRedeemed: 0, active: true, createdAt: _now(), createdBy: auth.uid,
  });
  return { rewardId: ref.id };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 18 — getAvailableRewards
// Customer/POS sees what can be redeemed.
// ═════════════════════════════════════════════════════════════════════════════

exports.getAvailableRewards = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.getAvailableRewards = async (req) => {
  const auth = _requireAuth(req);
  const { merchantId } = req.data || {};
  const db = _db();

  let q = db.collection('loyaltyRewards').where('active', '==', true);
  if (merchantId) q = q.where('merchantId', '==', _san(merchantId, 64));
  q = q.orderBy('pointsCost', 'asc').limit(50);

  const [rewardsSnap, accSnap] = await Promise.all([q.get(), db.collection('loyaltyAccounts').doc(auth.uid).get()]);
  const balance = accSnap.exists ? _safeInt(accSnap.data().balance) : 0;
  const now     = Date.now();

  const rewards = rewardsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => !r.expiresAt || r.expiresAt.toMillis() > now)
    .filter(r => r.stock == null || r.stock > 0)
    .map(r => ({ ...r, canAfford: balance >= r.pointsCost }));

  return { rewards, pointsBalance: balance };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 19 — redeemLoyaltyReward
// Customer redeems a specific catalog reward. Generates voucher code.
// ═════════════════════════════════════════════════════════════════════════════

exports.redeemLoyaltyReward = onCall({ ...OPT, timeoutSeconds: 30 }, exports._h.redeemLoyaltyReward = async (req) => {
  const auth = _requireAuth(req);
  const { rewardId } = req.data || {};
  if (!rewardId) throw new HttpsError('invalid-argument', 'rewardId required');

  const db = _db();
  let result;

  await db.runTransaction(async (txn) => {
    const [rSnap, aSnap] = await Promise.all([
      txn.get(db.collection('loyaltyRewards').doc(rewardId)),
      txn.get(db.collection('loyaltyAccounts').doc(auth.uid)),
    ]);
    if (!rSnap.exists) throw new HttpsError('not-found', 'Reward not found');
    if (!aSnap.exists) throw new HttpsError('not-found', 'Loyalty account not found');

    const r = rSnap.data(), acc = aSnap.data();
    if (!r.active) throw new HttpsError('failed-precondition', 'Reward no longer available');
    if (r.expiresAt && r.expiresAt.toMillis() < Date.now()) throw new HttpsError('failed-precondition', 'Reward expired');
    if (r.stock != null && r.stock <= 0) throw new HttpsError('failed-precondition', 'Reward out of stock');

    const bal = acc.balance || 0;
    if (bal < r.pointsCost) throw new HttpsError('failed-precondition', `Need ${r.pointsCost} pts, have ${bal}`);

    const balAfter    = bal - r.pointsCost;
    const voucherCode = crypto.randomBytes(4).toString('hex').toUpperCase();

    txn.update(aSnap.ref, { balance: balAfter, totalRedeemed: _INC(r.pointsCost), lastUpdated: _now() });
    txn.update(rSnap.ref, r.stock != null ? { stock: _INC(-1), totalRedeemed: _INC(1) } : { totalRedeemed: _INC(1) });

    const redRef = db.collection('loyaltyRedemptions').doc();
    txn.set(redRef, {
      uid: auth.uid, rewardId, rewardName: r.name, merchantId: r.merchantId,
      pointsSpent: r.pointsCost, voucherCode, rewardType: r.rewardType, value: r.value,
      balanceBefore: bal, balanceAfter: balAfter, status: 'active', redeemedAt: _now(),
    });

    result = { redemptionId: redRef.id, voucherCode, rewardName: r.name, rewardType: r.rewardType, value: r.value, newBalance: balAfter };
  });

  logger.info('[loyalty] Reward redeemed', { uid: auth.uid, rewardId });
  return result;
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 20 — linkPhysicalCard
// Links an NFC / barcode / QR physical card to a loyalty account.
// ═════════════════════════════════════════════════════════════════════════════

exports.linkPhysicalCard = onCall({ ...OPT, timeoutSeconds: 20 }, exports._h.linkPhysicalCard = async (req) => {
  const auth = _requireAuth(req);
  const { cardNumber, cardType } = req.data || {};
  if (!cardNumber) throw new HttpsError('invalid-argument', 'cardNumber required');

  const type   = ['barcode','nfc','qr','pvc'].includes(cardType) ? cardType : 'barcode';
  const db     = _db();
  const sanNum = _san(cardNumber, 64);

  await db.runTransaction(async (txn) => {
    const cardRef = db.collection('loyaltyCards').doc(sanNum);
    const accRef  = db.collection('loyaltyAccounts').doc(auth.uid);
    const [cSnap, aSnap] = await Promise.all([txn.get(cardRef), txn.get(accRef)]);

    if (cSnap.exists && cSnap.data().uid !== auth.uid)
      throw new HttpsError('already-exists', 'Card already linked to another account');
    if (!aSnap.exists) throw new HttpsError('not-found', 'Loyalty account not found');

    txn.set(cardRef, { cardNumber: sanNum, type, uid: auth.uid, loyaltyId: aSnap.data().loyaltyId, linkedAt: _now(), active: true }, { merge: true });
    txn.update(accRef, { linkedCards: _ARR(sanNum) });
  });

  return { cardNumber: sanNum, type, linked: true };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 21 — syncOfflineLoyaltyTransactions
// POS syncs buffered offline loyalty transactions.
// Security: merchant must be authenticated + App Check enforced.
// Each tx has a UUID for idempotency. Per-tx HMAC verifies offline integrity.
// ═════════════════════════════════════════════════════════════════════════════

exports.syncOfflineLoyaltyTransactions = onCall({ ...OPT, secrets: [LOYALTY_HMAC], timeoutSeconds: 60, memory: '256MiB' }, exports._h.syncOfflineLoyaltyTransactions = async (req) => {
  _requireMerchant(req);
  const { transactions = [], merchantId, terminalId } = req.data || {};
  if (!Array.isArray(transactions) || !transactions.length)
    throw new HttpsError('invalid-argument', 'transactions array required');
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required');
  if (transactions.length > 100) throw new HttpsError('invalid-argument', 'Max 100 transactions per sync batch');

  const db     = _db();
  const secret = LOYALTY_HMAC.value();
  const mid    = _san(merchantId, 64);
  const results = [];

  for (const tx of transactions) {
    const { txId, customerUid, amountKES, orderId, timestamp, sig } = tx;
    if (!txId || !customerUid || !amountKES || !orderId) {
      results.push({ txId, status: 'error', reason: 'Missing required fields' }); continue;
    }

    // Verify offline transaction signature
    const expected = _hmac16(secret, `${txId}|${customerUid}|${amountKES}|${orderId}|${timestamp || ''}`);
    if (!sig || !crypto.timingSafeEqual(Buffer.from(expected.padEnd(32, '0')), Buffer.from((sig.slice(0, 16)).padEnd(32, '0')))) {
      results.push({ txId, status: 'rejected', reason: 'Invalid signature' });
      logger.warn('[loyalty] Offline tx rejected — bad signature', { txId, mid });
      continue;
    }

    const idKey  = _ledgerKey(['offline', customerUid, txId, mid]);
    const exists = await db.collection('loyaltyLedger').doc(idKey).get();
    if (exists.exists) { results.push({ txId, status: 'duplicate', pointsAwarded: exists.data().points }); continue; }

    try {
      const cfgSnap = await db.collection('loyaltyMerchantConfigs').doc(mid).get();
      const config  = cfgSnap.exists ? cfgSnap.data() : _defaultConfig(mid);
      let awarded   = 0;

      await db.runTransaction(async (txn) => {
        // Idempotency — FIRST read inside tx. The outer exists-check above is a fast-path
        // optimisation only; two overlapping sync calls can both pass that check, so this
        // inner check is the authoritative atomic guard that prevents double-awarding.
        const idemSnap = await txn.get(db.collection('loyaltyLedger').doc(idKey));
        if (idemSnap.exists) { awarded = idemSnap.data().points || 0; return; }

        const accRef  = db.collection('loyaltyAccounts').doc(customerUid);
        const accSnap = await txn.get(accRef);
        if (!accSnap.exists) throw new Error('Account not found');
        const acc = accSnap.data();
        const pts = _calcPoints(Number(amountKES), config, acc.tier || 'bronze', []);
        if (pts.total === 0) return;
        awarded = pts.total;
        const balAfter  = (acc.balance || 0) + pts.total;
        const lifeAfter = (acc.lifetimePoints || 0) + pts.total;
        txn.update(accRef, { balance: balAfter, lifetimePoints: lifeAfter, totalEarned: _INC(pts.total), tier: _tierFor(lifeAfter).key, lastUpdated: _now(), lastMerchantId: mid });
        txn.set(db.collection('loyaltyLedger').doc(idKey), {
          uid: customerUid, type: 'earn', merchantId: mid, terminalId: _san(terminalId || '', 64),
          orderId: _san(orderId, 128), points: pts.total, basePoints: pts.basePoints,
          amountKES: Math.round(amountKES * 100) / 100,
          balanceBefore: acc.balance || 0, balanceAfter: balAfter,
          description: 'Offline sync', offlineTxId: _san(txId, 128), expired: false,
          idempotencyKey: idKey, createdAt: _now(),
        });
      });

      results.push({ txId, status: 'ok', pointsAwarded: awarded });
    } catch (e) {
      results.push({ txId, status: 'error', reason: e.message });
    }
  }

  return { results, synced: results.filter(r => r.status === 'ok').length, total: transactions.length };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 22 — adminAdjustLoyaltyPoints (enhanced with audit trail)
// Admin manual adjustment — named separately from v1 adminAdjustPoints.
// ═════════════════════════════════════════════════════════════════════════════

exports.adminAdjustLoyaltyPoints = onCall({ ...OPT, timeoutSeconds: 30 }, exports._h.adminAdjustLoyaltyPoints = async (req) => {
  const auth = _requireAdmin(req);
  const { customerUid, points, reason, merchantId } = req.data || {};
  if (!customerUid) throw new HttpsError('invalid-argument', 'customerUid required');
  if (!points || points === 0) throw new HttpsError('invalid-argument', 'points must be non-zero');
  if (Math.abs(points) > 100000) throw new HttpsError('invalid-argument', 'Max Â±100,000 per adjustment');
  if (!reason) throw new HttpsError('invalid-argument', 'reason required');

  return exports.adminAdjustPoints({ auth, data: { uid: customerUid, points, reason } });
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 23 — voidLoyaltyTransaction
// Admin voids a ledger entry and reverses points.
// Original entry marked voided — never deleted (immutable audit).
// ═════════════════════════════════════════════════════════════════════════════

exports.voidLoyaltyTransaction = onCall({ ...OPT, timeoutSeconds: 30 }, exports._h.voidLoyaltyTransaction = async (req) => {
  const auth = _requireAdmin(req);
  const { entryId, reason } = req.data || {};
  if (!entryId) throw new HttpsError('invalid-argument', 'entryId required');
  if (!reason)  throw new HttpsError('invalid-argument', 'reason required');

  const db = _db();
  await db.runTransaction(async (txn) => {
    const ref  = db.collection('loyaltyLedger').doc(entryId);
    const snap = await txn.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Ledger entry not found');
    const data = snap.data();
    if (data.voided) throw new HttpsError('already-exists', 'Already voided');
    if (['adjust','void'].includes(data.type)) throw new HttpsError('failed-precondition', 'Cannot void this type');

    const reversal = -(data.points || 0);
    const accRef   = db.collection('loyaltyAccounts').doc(data.uid);
    const accSnap  = await txn.get(accRef);
    const curBal   = accSnap.exists ? (accSnap.data().balance || 0) : 0;
    const balAfter = Math.max(0, curBal + reversal);

    if (accSnap.exists) txn.update(accRef, { balance: balAfter, lastUpdated: _now() });
    txn.update(ref, { voided: true, voidedAt: _now(), voidedBy: auth.uid, voidReason: _san(reason, 256) });

    const vKey = _ledgerKey(['void', entryId, auth.uid]);
    txn.set(db.collection('loyaltyLedger').doc(vKey), {
      uid: data.uid, type: 'void', merchantId: data.merchantId, originalEntryId: entryId,
      points: reversal, balanceBefore: curBal, balanceAfter: balAfter,
      description: `Void: ${_san(reason, 256)}`, voidedBy: auth.uid,
      idempotencyKey: vKey, createdAt: _now(),
    });
  });

  logger.info('[loyalty] Transaction voided', { entryId, adminUid: auth.uid });
  return { voided: true };
});


// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CF 24 — getLoyaltyInsights (AI-powered)
// Merchant gets Haiku-generated loyalty recommendations.
// ═════════════════════════════════════════════════════════════════════════════

exports.getLoyaltyInsights = onCall({ ...OPT, timeoutSeconds: 60, memory: '512MiB' }, exports._h.getLoyaltyInsights = async (req) => {
  const auth = _requireMerchant(req);
  const { merchantId, days = 30 } = req.data || {};
  const mid    = _san(merchantId || auth.uid, 64);
  const db     = _db();
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - _safeInt(days) * 24 * 60 * 60 * 1000);

  const [earnSnap, redeemSnap, membersSnap, cfgSnap] = await Promise.all([
    db.collection('loyaltyLedger').where('merchantId', '==', mid).where('type', '==', 'earn').where('createdAt', '>=', cutoff).limit(500).get(),
    db.collection('loyaltyLedger').where('merchantId', '==', mid).where('type', '==', 'redeem').where('createdAt', '>=', cutoff).limit(200).get(),
    db.collection('loyaltyAccounts').where('lastMerchantId', '==', mid).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    db.collection('loyaltyMerchantConfigs').doc(mid).get(),
  ]);

  const earns    = earnSnap.docs.map(d => d.data());
  const issued   = earns.reduce((s, d) => s + (d.points || 0), 0);
  const redeemed = redeemSnap.docs.reduce((s, d) => s + Math.abs(d.points || 0), 0);
  const revenue  = earns.reduce((s, d) => s + (d.amountKES || 0), 0);
  const members  = membersSnap.data().count;
  const config   = cfgSnap.exists ? cfgSnap.data() : _defaultConfig(mid);
  const rate     = issued > 0 ? (redeemed / issued * 100).toFixed(1) : 0;

  try {
    const { default: Anthropic } = require('@anthropic-ai/sdk');
    const ai = new Anthropic();
    const resp = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
      messages: [{ role: 'user', content: `You are a loyalty analytics consultant for a Kenyan merchant.
Program: ${config.programName}  Period: Last ${days} days  Members: ${members}
Revenue from loyalty members: KES ${revenue.toLocaleString()}  Points issued: ${issued.toLocaleString()}
Points redeemed: ${redeemed.toLocaleString()}  Redemption rate: ${rate}%
Earn: ${config.pointsPerKES} pts/KES  Redeem: ${config.redemptionRate} pts = KES 1

Provide 3-5 specific, actionable insights relevant to Kenya (M-Pesa culture, school fees seasons, payday cycles). Include one campaign idea.
Respond ONLY in JSON: {"insights":[{"title":"...","body":"...","action":"...","priority":"high|medium|low"}]}` }],
    });
    const match = (resp.content[0]?.text || '').match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { insights: parsed.insights || [], redemptionRate: rate, stats: { members, issued, redeemed, revenue } };
    }
  } catch (e) {
    logger.warn('[loyalty] AI insights error', { error: e.message });
  }

  // Rule-based fallback
  const insights = [];
  if (Number(rate) < 15) insights.push({ title: 'Low Redemption Rate', body: `Only ${rate}% redeemed. Lower the minimum or run a "Redeem This Month" SMS campaign.`, action: 'Create a 2Ã— cashback weekend campaign', priority: 'high' });
  if (Number(rate) > 60) insights.push({ title: 'High Redemption — Review Margins', body: 'Redemption rate exceeds 60%. Review reward cost vs. margin to ensure profitability.', action: 'Increase redemptionRate from current value', priority: 'medium' });
  insights.push({ title: 'Payday Surge Opportunity', body: 'Kenyan retail peaks on the 25th–5th (payday cycle). Double points on those dates.', action: 'Create a "Payday Bonus" campaign for days 25–5', priority: 'high' });
  if (!config.birthdayBonus) insights.push({ title: 'Enable Birthday Rewards', body: 'Birthday bonuses increase customer retention by 20-30%. Currently disabled.', action: 'Set birthdayBonus to 500 pts', priority: 'medium' });
  return { insights, redemptionRate: rate, stats: { members, issued, redeemed, revenue }, aiUnavailable: true };
});


// ═════════════════════════════════════════════════════════════════════════════
// Scheduled CF 25 — processExpiringPoints
// Expires earn entries past their expiresAt date. Runs daily at 2 AM EAT.
// ═════════════════════════════════════════════════════════════════════════════

exports.processExpiringPoints = onSchedule(
  { schedule: '0 2 * * *', timeZone: 'Africa/Nairobi', region: REGION, timeoutSeconds: 540 },
  async () => {
    const db  = _db();
    const now = admin.firestore.Timestamp.now();

    const snap = await db.collection('loyaltyLedger')
      .where('type', '==', 'earn')
      .where('expiresAt', '<=', now)
      .where('expired', '==', false)
      .limit(200).get();

    if (snap.empty) { logger.info('[loyalty] No expiring points'); return; }

    let expired = 0;
    for (const doc of snap.docs) {
      const entry = doc.data();
      if ((entry.points || 0) <= 0) { await doc.ref.update({ expired: true }); continue; }
      try {
        await db.runTransaction(async (txn) => {
          const accRef  = db.collection('loyaltyAccounts').doc(entry.uid);
          const accSnap = await txn.get(accRef);
          txn.update(doc.ref, { expired: true });
          if (!accSnap.exists) return;
          const acc      = accSnap.data();
          const toExpire = Math.min(entry.points || 0, acc.balance || 0);
          const after    = Math.max(0, (acc.balance || 0) - toExpire);
          txn.update(accRef, { balance: after, expiredPoints: _INC(toExpire), lastUpdated: _now() });
          const eKey = _ledgerKey(['expire', entry.uid, doc.id]);
          txn.set(db.collection('loyaltyLedger').doc(eKey), {
            uid: entry.uid, type: 'expire', merchantId: entry.merchantId,
            points: -toExpire, balanceBefore: acc.balance || 0, balanceAfter: after,
            originalEntryId: doc.id, description: 'Points expired', expired: true,
            idempotencyKey: eKey, createdAt: _now(),
          });
        });
        expired++;
      } catch (e) {
        logger.error('[loyalty] Expiry error', { uid: entry.uid, error: e.message });
      }
    }
    logger.info('[loyalty] Expiry done', { expired, total: snap.size });
  }
);


// ═════════════════════════════════════════════════════════════════════════════
// Scheduled CF 26 — processLoyaltyMilestones
// Awards birthday bonuses. Runs daily at 7 AM EAT.
// ═════════════════════════════════════════════════════════════════════════════

exports.processLoyaltyMilestones = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'Africa/Nairobi', region: REGION, timeoutSeconds: 300 },
  async () => {
    const db  = _db();
    const now = new Date();
    const year = now.getFullYear(), month = now.getMonth() + 1, day = now.getDate();

    const snap = await db.collection('loyaltyAccounts')
      .where('birthdayMonth', '==', month)
      .where('birthdayDay', '==', day)
      .where('status', '==', 'active')
      .limit(100).get();

    /* Deduplicate merchant IDs and batch-fetch all configs before the loop */
    const uniqueMerchantIds = [...new Set(snap.docs.map(d => d.data().lastMerchantId || 'sokoni'))];
    const cfgSnaps = await Promise.all(
      uniqueMerchantIds.map(mid => db.collection('loyaltyMerchantConfigs').doc(mid).get())
    );
    const cfgMap = {};
    for (let ci = 0; ci < uniqueMerchantIds.length; ci++) {
      cfgMap[uniqueMerchantIds[ci]] = cfgSnaps[ci].exists ? cfgSnaps[ci].data() : _defaultConfig(uniqueMerchantIds[ci]);
    }

    let awarded = 0;
    for (const doc of snap.docs) {
      const acc = doc.data();
      if (acc.birthdayRewardYear === year) continue;

      try {
        const config = cfgMap[acc.lastMerchantId || 'sokoni'] || _defaultConfig('sokoni');
        const bonus   = config.birthdayBonus || 500;
        const idKey   = _ledgerKey(['birthday', acc.uid, String(year)]);

        await db.runTransaction(async (txn) => {
          const accSnap = await txn.get(doc.ref);
          if (!accSnap.exists) return;
          const cur   = accSnap.data();
          const after = (cur.balance || 0) + bonus;
          txn.update(doc.ref, { balance: after, lifetimePoints: _INC(bonus), totalEarned: _INC(bonus), birthdayRewardYear: year, lastUpdated: _now() });
          txn.set(db.collection('loyaltyLedger').doc(idKey), {
            uid: acc.uid, type: 'birthday', merchantId: acc.lastMerchantId || 'sokoni',
            points: bonus, balanceBefore: cur.balance || 0, balanceAfter: after,
            description: `🎂 Happy Birthday! ${bonus} bonus points`, idempotencyKey: idKey, createdAt: _now(),
          });
        });

        _notify(acc.uid, '🎂 Happy Birthday!',
          `SOKONI Rewards wishes you a great day! You've earned ${bonus} birthday bonus points.`,
          { type: 'birthday_bonus', points: bonus }).catch(() => {});
        awarded++;
      } catch (e) {
        logger.error('[loyalty] Birthday error', { uid: acc.uid, error: e.message });
      }
    }
    logger.info('[loyalty] Birthday bonuses', { awarded });
  }
);
