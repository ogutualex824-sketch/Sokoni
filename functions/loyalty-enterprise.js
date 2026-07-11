'use strict';

/**
 * SOKONI Enterprise Loyalty Platform â€” Cloud Functions v2
 * 16 Cloud Functions covering checkout orchestration, cashback, gift cards,
 * lucky draws, referrals, AI personalization, fraud detection, network, and reconciliation.
 *
 * Collections used:
 *   loyaltyAccounts, loyaltyLedger, loyaltyCashbackLedger, loyaltyAccounting,
 *   loyaltyCheckouts, loyaltyCheckoutIdempotency, loyaltyGiftCards,
 *   loyaltyDraws, loyaltyDrawEntries, loyaltyReferrals, loyaltyNetwork,
 *   loyaltyReconciliation, loyaltyMerchantConfigs, merchants
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');
const crypto                 = require('crypto');
const { defineSecret }       = require('firebase-functions/params');

const db     = admin.firestore();
const F      = admin.firestore.FieldValue;
const REGION = 'us-central1';
const OPT    = { region: REGION, enforceAppCheck: true };

const LOYALTY_HMAC  = defineSecret('LOYALTY_HMAC_SECRET');
const ANTHROPIC_KEY = defineSecret('ANTHROPIC_API_KEY');

// Handler registry — populated below; consumed by loyalty-dispatch.js dispatcher
exports._h = {};

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------
const TIERS = [
  { name: 'diamond',  min: 100000, multiplier: 5.0, cashbackPct: 5.0 },
  { name: 'platinum', min: 50000,  multiplier: 3.0, cashbackPct: 3.0 },
  { name: 'gold',     min: 20000,  multiplier: 2.0, cashbackPct: 2.0 },
  { name: 'silver',   min: 5000,   multiplier: 1.5, cashbackPct: 1.0 },
  { name: 'bronze',   min: 0,      multiplier: 1.0, cashbackPct: 0.5 },
];

const TIER_BENEFITS = {
  diamond:  { prioritySupport: true,  freeDelivery: true,  birthdayGift: true,  doublePointDays: true,  vipPromotions: true,  earlyAccess: true,  exclusiveDiscounts: true,  maxCashbackPct: 5.0 },
  platinum: { prioritySupport: true,  freeDelivery: true,  birthdayGift: true,  doublePointDays: true,  vipPromotions: false, earlyAccess: true,  exclusiveDiscounts: true,  maxCashbackPct: 3.0 },
  gold:     { prioritySupport: false, freeDelivery: false, birthdayGift: true,  doublePointDays: true,  vipPromotions: false, earlyAccess: false, exclusiveDiscounts: true,  maxCashbackPct: 2.0 },
  silver:   { prioritySupport: false, freeDelivery: false, birthdayGift: false, doublePointDays: false, vipPromotions: false, earlyAccess: false, exclusiveDiscounts: false, maxCashbackPct: 1.0 },
  bronze:   { prioritySupport: false, freeDelivery: false, birthdayGift: false, doublePointDays: false, vipPromotions: false, earlyAccess: false, exclusiveDiscounts: false, maxCashbackPct: 0.5 },
};

const TIER_META = {
  diamond:  { icon: 'diamond',  color: '#00BFFF' },
  platinum: { icon: 'stars',    color: '#E5E4E2' },
  gold:     { icon: 'military_tech', color: '#FFD700' },
  silver:   { icon: 'workspace_premium', color: '#C0C0C0' },
  bronze:   { icon: 'emoji_events', color: '#CD7F32' },
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Returns the TIERS entry matching the given lifetime points. */
function _getTier(lifetimePoints) {
  for (const tier of TIERS) {
    if (lifetimePoints >= tier.min) return tier;
  }
  return TIERS[TIERS.length - 1]; // bronze fallback
}

/** Generates a 4Ã—4 alphanumeric gift card code, excluding ambiguous chars. */
function _giftCardCode() {
  const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no O,0,I,1,L
  const segment = () => {
    let s = '';
    while (s.length < 4) {
      const byte = crypto.randomBytes(1)[0];
      if (byte < 248) s += CHARS[byte % CHARS.length]; // rejection sampling for uniform distribution
    }
    return s;
  };
  return `${segment()}-${segment()}-${segment()}-${segment()}`;
}

/** Generates a loyalty account ID in SKN-XXXX-XXXX-XXXX format. */
function _loyaltyId() {
  const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const segment = () => {
    let s = '';
    while (s.length < 4) {
      const byte = crypto.randomBytes(1)[0];
      if (byte < 248) s += CHARS[byte % CHARS.length];
    }
    return s;
  };
  return `SKN-${segment()}-${segment()}-${segment()}`;
}

/** Returns true if current hour is within the merchant's happy-hour window. */
function _isHappyHour(config) {
  if (!config || !config.happyHour || !config.happyHour.enabled) return false;
  const hour = new Date().getUTCHours() + 3; // EAT = UTC+3
  const h = ((hour % 24) + 24) % 24;
  const { startHour, endHour } = config.happyHour;
  if (typeof startHour !== 'number' || typeof endHour !== 'number') return false;
  if (startHour <= endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour; // overnight happy hour
}

/** Returns true if today is Saturday (6) or Sunday (0). */
function _isWeekend() {
  return [0, 6].includes(new Date().getDay());
}

/** Returns true if today matches the account's birthday month/day. */
function _isBirthday(account) {
  if (!account || !account.birthdayMonth || !account.birthdayDay) return false;
  const now = new Date();
  return now.getMonth() + 1 === account.birthdayMonth && now.getDate() === account.birthdayDay;
}

/** Returns a hex SHA-256 hash of a string. */
function _sha256(data) {
  return crypto.createHash('sha256').update(String(data)).digest('hex');
}

/** Verifies an HMAC-SHA256 signature (16-char hex prefix) using timing-safe comparison. */
function _verifyHmac(secret, data, sig) {
  if (typeof sig !== 'string' || sig.length < 16) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(String(data))
    .digest('hex')
    .slice(0, 16);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Full points calculation engine.
 * Returns { basePoints, multiplier, bonusPoints, totalPoints, cashbackKES, cashbackPct, breakdown[] }
 */
function _calcPoints({ total, items = [], config = {}, account = {}, campaigns = [] }) {
  const breakdown = [];
  const tier = _getTier(account.lifetimePoints || 0);
  const baseRate = config.pointsPerKES || 0.1;

  // Base points from spend
  let basePoints = Math.floor(total * baseRate);
  breakdown.push({ label: 'Base points', points: basePoints, type: 'base' });

  // Tier multiplier
  let multiplier = tier.multiplier;
  breakdown.push({ label: `${tier.name} tier multiplier`, multiplier, type: 'tier' });

  // Bonus multipliers (stacked additively on top of tier, applied as extra percentage)
  let bonusMultiplier = 0;

  if (_isHappyHour(config)) {
    const hh = config.happyHour.bonus || 0.5;
    bonusMultiplier += hh;
    breakdown.push({ label: 'Happy hour bonus', extra: hh, type: 'happy_hour' });
  }

  if (_isWeekend()) {
    const wb = config.weekendBonus || 0.25;
    bonusMultiplier += wb;
    breakdown.push({ label: 'Weekend bonus', extra: wb, type: 'weekend' });
  }

  if (_isBirthday(account)) {
    const bb = config.birthdayMultiplier || 2.0;
    bonusMultiplier += bb;
    breakdown.push({ label: 'Birthday bonus', extra: bb, type: 'birthday' });
  }

  const effectiveMultiplier = multiplier + bonusMultiplier;
  let bonusPoints = 0;

  // First purchase bonus
  if (!account.firstPurchaseAt) {
    const fp = config.firstPurchaseBonus || 0;
    if (fp > 0) {
      bonusPoints += fp;
      breakdown.push({ label: 'First purchase bonus', points: fp, type: 'first_purchase' });
    }
  }

  // Category and brand multipliers per line item
  const categoryMult = config.categoryMultipliers || {};
  const brandMult    = config.brandMultipliers    || {};

  for (const item of items) {
    const itemTotal = (item.unitPrice || 0) * (item.qty || 1);
    const catBonus  = categoryMult[item.category];
    const brandBonus = brandMult[item.brand];

    if (catBonus && catBonus > 1) {
      const extra = Math.floor(itemTotal * baseRate * (catBonus - 1));
      bonusPoints += extra;
      breakdown.push({ label: `Category bonus (${item.category})`, points: extra, type: 'category' });
    }
    if (brandBonus && brandBonus > 1) {
      const extra = Math.floor(itemTotal * baseRate * (brandBonus - 1));
      bonusPoints += extra;
      breakdown.push({ label: `Brand bonus (${item.brand})`, points: extra, type: 'brand' });
    }
  }

  // Spend threshold bonus
  const st = config.spendThreshold;
  if (st && typeof st.minAmount === 'number' && total >= st.minAmount && st.bonusPoints > 0) {
    bonusPoints += st.bonusPoints;
    breakdown.push({ label: `Spend threshold (â‰¥ KES ${st.minAmount})`, points: st.bonusPoints, type: 'spend_threshold' });
  }

  // Active campaign bonuses
  const now = Date.now();
  const todayDay = new Date().getDay();
  for (const campaign of campaigns) {
    const starts = campaign.startsAt ? campaign.startsAt.toMillis?.() ?? campaign.startsAt : 0;
    const ends   = campaign.endsAt   ? campaign.endsAt.toMillis?.()   ?? campaign.endsAt   : Infinity;
    if (now < starts || now > ends) continue;
    if (campaign.dayOfWeek !== undefined && campaign.dayOfWeek !== todayDay) continue;
    if (campaign.minPurchase && total < campaign.minPurchase) continue;
    const cp = campaign.bonusPoints || 0;
    if (cp > 0) {
      bonusPoints += cp;
      breakdown.push({ label: `Campaign: ${campaign.name || campaign.id}`, points: cp, type: 'campaign' });
    }
    if (campaign.bonusMultiplier) {
      bonusMultiplier += campaign.bonusMultiplier;
      breakdown.push({ label: `Campaign multiplier: ${campaign.name || campaign.id}`, extra: campaign.bonusMultiplier, type: 'campaign_multiplier' });
    }
  }

  const computedBase = Math.floor(basePoints * effectiveMultiplier);
  const totalPoints  = Math.max(0, computedBase + bonusPoints);

  // Cashback calculation
  const cashbackPct = config.cashbackPct != null ? config.cashbackPct : tier.cashbackPct;
  const cashbackKES = parseFloat(((total * cashbackPct) / 100).toFixed(2));

  return { basePoints, multiplier: effectiveMultiplier, bonusPoints, totalPoints, cashbackKES, cashbackPct, breakdown };
}

/**
 * Writes a double-entry accounting record inside an existing Firestore transaction.
 */
function _postAccounting(txn, merchantId, orderId, type, amount, debit, credit) {
  const entryId  = _sha256(`accounting|${merchantId}|${orderId}|${type}|${debit}|${credit}`);
  const ref      = db.collection('loyaltyAccounting').doc(entryId);
  txn.set(ref, {
    merchantId,
    orderId,
    type,
    amount,
    debit,
    credit,
    createdAt: F.serverTimestamp(),
  }, { merge: true });
}

// ---------------------------------------------------------------------------
// 1. loyaltyCheckoutOrchestrate
// ---------------------------------------------------------------------------
exports.loyaltyCheckoutOrchestrate = onCall({
  ...OPT,
  secrets:        [LOYALTY_HMAC],
  timeoutSeconds: 30,
  memory:         '512MiB',
}, exports._h.loyaltyCheckoutOrchestrate = async (req) => {
  const {
    items = [], subtotal, taxAmount, total,
    paymentMethod, paymentRef, paymentVerified,
    uid: rawUid, phone, loyaltyId: rawLoyaltyId, qrPayload,
    merchantId, branchId, posId, cashierId,
    orderId: rawOrderId, redeemPoints: rawRedeem = 0,
    giftCardCode, couponCode, notes, isOffline, offlineSignature,
  } = req.data;

  // --- Input validation ---
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');
  if (!branchId)   throw new HttpsError('invalid-argument', 'branchId is required');
  if (!posId)      throw new HttpsError('invalid-argument', 'posId is required');
  if (!total || total <= 0) throw new HttpsError('invalid-argument', 'total must be > 0');

  const redeemPoints = Math.max(0, Math.floor(rawRedeem));
  const checkoutId   = rawOrderId || `co_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const errors       = [];

  // --- Resolve customer ---
  let uid           = rawUid || null;
  let accountData   = null;
  let isNewCustomer = false;

  // 1a. UID path
  if (uid) {
    const snap = await db.collection('loyaltyAccounts').doc(uid).get();
    if (snap.exists) accountData = snap.data();
  }

  // 1b. Phone lookup
  if (!accountData && phone) {
    const snap = await db.collection('loyaltyAccounts')
      .where('phone', '==', phone).limit(1).get();
    if (!snap.empty) {
      uid         = snap.docs[0].id;
      accountData = snap.docs[0].data();
    }
  }

  // 1c. LoyaltyId lookup
  if (!accountData && rawLoyaltyId) {
    const snap = await db.collection('loyaltyAccounts')
      .where('loyaltyId', '==', rawLoyaltyId).limit(1).get();
    if (!snap.empty) {
      uid         = snap.docs[0].id;
      accountData = snap.docs[0].data();
    }
  }

  // 1d. QR payload verification
  if (!accountData && qrPayload) {
    try {
      const parsed = JSON.parse(qrPayload);
      if (!_verifyHmac(LOYALTY_HMAC.value(), parsed.uid, parsed.sig)) {
        throw new HttpsError('unauthenticated', 'Invalid QR signature');
      }
      uid = parsed.uid;
      const snap = await db.collection('loyaltyAccounts').doc(uid).get();
      if (snap.exists) accountData = snap.data();
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      errors.push('QR payload verification failed');
    }
  }

  // 1e. Auto-create account if phone provided and no account found
  if (!accountData && phone) {
    isNewCustomer = true;
    const newLoyaltyId = _loyaltyId();
    uid = `loyalty_${_sha256(`${phone}_${Date.now()}`).slice(0, 16)}`;
    accountData = {
      uid,
      phone,
      loyaltyId:      newLoyaltyId,
      balance:        125, // welcome points
      lifetimePoints: 125,
      cashbackBalance: 0,
      currentTier:    'bronze',
      createdAt:      F.serverTimestamp(),
      firstPurchaseAt: null,
      lastPurchaseAt:  null,
      totalPurchases:  0,
      totalSpendKES:   0,
    };
    await db.collection('loyaltyAccounts').doc(uid).set(accountData, { merge: true });
  }

  if (!uid || !accountData) {
    throw new HttpsError('not-found', 'No loyalty account found. Provide uid, phone, loyaltyId, or qrPayload');
  }

  // --- Load config + campaigns in parallel ---
  const [configSnap, campaignsSnap] = await Promise.all([
    db.collection('loyaltyMerchantConfigs').doc(merchantId).get(),
    db.collection('loyaltyDraws')
      .where('merchantId', '==', merchantId)
      .where('status', '==', 'active')
      .get(),
  ]);
  const config    = configSnap.exists ? configSnap.data() : {};
  const activeCampaigns = [];
  // Fetch campaigns from sub-config if present
  const campaignsRef = db.collection('loyaltyMerchantConfigs')
    .doc(merchantId).collection('campaigns');
  const campSnap = await campaignsRef.where('active', '==', true).get();
  campSnap.forEach(d => activeCampaigns.push({ id: d.id, ...d.data() }));

  // --- Validate redemption ---
  const redemptionRate   = config.redemptionRate    || 100; // points per KES
  const maxRedemptionPct = config.maxRedemptionPct  || 50;
  if (redeemPoints > 0) {
    const currentBalance = accountData.balance || 0;
    if (currentBalance < redeemPoints) {
      throw new HttpsError('failed-precondition', 'Insufficient loyalty balance');
    }
    const maxAllowed = Math.floor((total * maxRedemptionPct) / 100 * redemptionRate);
    if (redeemPoints > maxAllowed) {
      throw new HttpsError('invalid-argument',
        `Cannot redeem more than ${maxRedemptionPct}% of purchase value`);
    }
  }

  // --- Validate gift card ---
  let giftCardDoc    = null;
  let giftCardId     = null;
  let giftCardDiscount = 0;
  if (giftCardCode) {
    const gcSnap = await db.collection('loyaltyGiftCards')
      .where('code', '==', giftCardCode).limit(1).get();
    if (!gcSnap.empty) {
      giftCardId  = gcSnap.docs[0].id;
      giftCardDoc = gcSnap.docs[0].data();
      const now = Date.now();
      if (giftCardDoc.usedAt) {
        errors.push('Gift card already used');
        giftCardDoc = null;
      } else if (giftCardDoc.expiresAt && giftCardDoc.expiresAt.toMillis() < now) {
        errors.push('Gift card expired');
        giftCardDoc = null;
      } else if (giftCardDoc.merchantId && giftCardDoc.merchantId !== merchantId) {
        errors.push('Gift card not valid for this merchant');
        giftCardDoc = null;
      } else if (giftCardDoc.minOrderValue && total < giftCardDoc.minOrderValue) {
        errors.push(`Minimum order KES ${giftCardDoc.minOrderValue} for this gift card`);
        giftCardDoc = null;
      } else {
        giftCardDiscount = giftCardDoc.valueType === 'percent'
          ? parseFloat(((total * giftCardDoc.value) / 100).toFixed(2))
          : (giftCardDoc.value || 0);
      }
    } else {
      errors.push('Gift card not found');
    }
  }

  // --- Calculate points ---
  const pointsResult   = _calcPoints({ total, items, config, account: accountData, campaigns: activeCampaigns });
  const redemptionDiscount = parseFloat((redeemPoints / redemptionRate).toFixed(2));

  // --- Firestore Transaction ---
  let txnResult = null;
  await db.runTransaction(async (txn) => {
    // Check idempotency
    const idemRef  = db.collection('loyaltyCheckoutIdempotency').doc(checkoutId);
    const idemSnap = await txn.get(idemRef);
    if (idemSnap.exists) {
      txnResult = idemSnap.data().cachedResult;
      return;
    }

    const accountRef  = db.collection('loyaltyAccounts').doc(uid);
    const accountSnap = await txn.get(accountRef);
    const current     = accountSnap.exists ? accountSnap.data() : accountData;

    const balanceBefore        = current.balance        || 0;
    const cashbackBefore       = current.cashbackBalance || 0;
    const lifetimeBefore       = current.lifetimePoints  || 0;
    const previousTier         = current.currentTier     || 'bronze';

    const newBalance        = balanceBefore - redeemPoints + pointsResult.totalPoints;
    const newLifetime       = lifetimeBefore + pointsResult.totalPoints;
    const newCashbackBalance = cashbackBefore + pointsResult.cashbackKES;
    const newTier           = _getTier(newLifetime);
    const tierUpgraded      = newTier.name !== previousTier &&
      TIERS.findIndex(t => t.name === newTier.name) < TIERS.findIndex(t => t.name === previousTier);

    const isFirstPurchase = !current.firstPurchaseAt;
    const now             = F.serverTimestamp();

    // Update loyalty account
    const accountUpdate = {
      balance:         newBalance,
      lifetimePoints:  newLifetime,
      cashbackBalance: newCashbackBalance,
      currentTier:     newTier.name,
      lastPurchaseAt:  now,
      totalPurchases:  F.increment(1),
      totalSpendKES:   F.increment(total),
    };
    if (isFirstPurchase) accountUpdate.firstPurchaseAt = now;
    txn.set(accountRef, accountUpdate, { merge: true });

    // Loyalty ledger
    const ledgerEntryId  = _sha256(`checkout|${uid}|${checkoutId}|${merchantId}`);
    const ledgerRef      = db.collection('loyaltyLedger').doc(ledgerEntryId);
    txn.set(ledgerRef, {
      uid,
      type:            'checkout',
      pointsEarned:    pointsResult.totalPoints,
      bonusPoints:     pointsResult.bonusPoints,
      pointsRedeemed:  redeemPoints,
      cashbackEarned:  pointsResult.cashbackKES,
      balanceBefore,
      balanceAfter:    newBalance,
      total,
      merchantId,
      branchId,
      posId,
      cashierId,
      paymentMethod,
      paymentRef:      paymentRef || null,
      items,
      breakdown:       pointsResult.breakdown,
      checkoutId,
      orderId:         rawOrderId || null,
      createdAt:       now,
    });

    // Cashback ledger
    const cbEntryId = _sha256(`cashback|${uid}|${checkoutId}`);
    txn.set(db.collection('loyaltyCashbackLedger').doc(cbEntryId), {
      uid,
      amount:          pointsResult.cashbackKES,
      type:            'earned',
      balanceBefore:   cashbackBefore,
      balanceAfter:    newCashbackBalance,
      orderId:         rawOrderId || null,
      merchantId,
      checkoutId,
      createdAt:       now,
    });

    // Double-entry accounting
    const pointsMonetaryValue = parseFloat((pointsResult.totalPoints / redemptionRate).toFixed(2));
    _postAccounting(txn, merchantId, checkoutId, 'checkout_earn', pointsMonetaryValue, 'rewards_expense', 'loyalty_liability');
    if (redeemPoints > 0) {
      _postAccounting(txn, merchantId, checkoutId, 'checkout_redeem', redemptionDiscount, 'loyalty_liability', 'revenue_discount');
    }

    // Tier upgrade ledger entry
    if (tierUpgraded) {
      const tierLedgerId = _sha256(`tier_upgrade|${uid}|${checkoutId}`);
      txn.set(db.collection('loyaltyLedger').doc(tierLedgerId), {
        uid,
        type:         'tier_upgrade',
        fromTier:     previousTier,
        toTier:       newTier.name,
        lifetimePoints: newLifetime,
        merchantId,
        checkoutId,
        createdAt:    now,
      });
    }

    // Mark gift card as used
    if (giftCardDoc && giftCardId) {
      txn.update(db.collection('loyaltyGiftCards').doc(giftCardId), {
        usedAt:      now,
        usedBy:      uid,
        usedAtOrder: checkoutId,
      });
    }

    // Next tier calculation
    const tierIdx     = TIERS.findIndex(t => t.name === newTier.name);
    const nextTierObj = tierIdx > 0 ? TIERS[tierIdx - 1] : null;
    const pointsToNextTier = nextTierObj ? nextTierObj.min - newLifetime : null;

    const result = {
      success:       true,
      checkoutId,
      loyaltyId:     current.loyaltyId || accountData.loyaltyId,
      loyalty: {
        pointsEarned:       pointsResult.totalPoints,
        bonusPoints:        pointsResult.bonusPoints,
        cashbackEarned:     pointsResult.cashbackKES,
        redemptionUsed:     redeemPoints,
        giftCardApplied:    giftCardDiscount,
        newBalance,
        cashbackBalance:    newCashbackBalance,
        tier:               newTier.name,
        tierUpgraded,
        previousTier:       tierUpgraded ? previousTier : null,
        pointsToNextTier,
        breakdown:          pointsResult.breakdown,
      },
      receipt: {
        checkoutId,
        merchantId,
        branchId,
        items,
        subtotal:    subtotal || total,
        taxAmount:   taxAmount || 0,
        total,
        discounts:   { points: redemptionDiscount, giftCard: giftCardDiscount },
        finalTotal:  parseFloat((total - redemptionDiscount - giftCardDiscount).toFixed(2)),
        paymentMethod,
        paymentRef:  paymentRef || null,
        loyaltySummary: {
          pointsEarned:   pointsResult.totalPoints,
          cashbackEarned: pointsResult.cashbackKES,
          newBalance,
          tier:           newTier.name,
        },
        timestamp: new Date().toISOString(),
      },
      isNewCustomer,
      errors,
    };

    // Write idempotency sentinel + checkout record
    txn.set(idemRef, { cachedResult: result, createdAt: now });
    txn.set(db.collection('loyaltyCheckouts').doc(checkoutId), {
      uid,
      merchantId,
      branchId,
      posId,
      cashierId,
      total,
      items,
      paymentMethod,
      paymentRef: paymentRef || null,
      pointsEarned: pointsResult.totalPoints,
      cashbackEarned: pointsResult.cashbackKES,
      redeemPoints,
      giftCardDiscount,
      newBalance,
      tier: newTier.name,
      isFirstPurchase,
      createdAt: now,
    });

    txnResult = result;
  });

  // --- Post-transaction async work (non-blocking) ---
  const postTxn = async () => {
    try {
      // FCM notification
      if (accountData.fcmToken) {
        await admin.messaging().send({
          token:        accountData.fcmToken,
          notification: {
            title: 'Points Earned!',
            body:  `You earned ${txnResult.loyalty.pointsEarned} points. Balance: ${txnResult.loyalty.newBalance}`,
          },
          data: { type: 'loyalty_checkout', checkoutId },
        }).catch(() => {});
      }
      // Tier upgrade notification
      if (txnResult.loyalty.tierUpgraded && accountData.fcmToken) {
        await admin.messaging().send({
          token:        accountData.fcmToken,
          notification: {
            title: 'Tier Upgrade!',
            body:  `Congratulations! You've reached ${txnResult.loyalty.tier} tier!`,
          },
          data: { type: 'tier_upgrade', tier: txnResult.loyalty.tier },
        }).catch(() => {});
      }
      // Referral check on first purchase
      if (isNewCustomer || !accountData.firstPurchaseAt) {
        const refSnap = await db.collection('loyaltyReferrals')
          .where('referredUid', '==', uid)
          .where('status', '==', 'pending')
          .limit(1).get();
        if (!refSnap.empty) {
          const refDoc = refSnap.docs[0];
          const referralBonus = config.referralBonus || 200;
          await db.runTransaction(async (t2) => {
            const rRef = db.collection('loyaltyAccounts').doc(refDoc.data().referrerId);
            t2.update(rRef, { balance: F.increment(referralBonus), lifetimePoints: F.increment(referralBonus) });
            t2.update(refDoc.ref, { status: 'first_purchase', completedAt: F.serverTimestamp() });
          });
        }
      }
    } catch (_e) {
      // Non-blocking; log only
      console.error('loyaltyCheckoutOrchestrate post-txn error', _e);
    }
  };
  postTxn(); // intentionally not awaited

  return txnResult;
});

// ---------------------------------------------------------------------------
// 2. loyaltyPreflightCheck
// ---------------------------------------------------------------------------
exports.loyaltyPreflightCheck = onCall({ ...OPT, timeoutSeconds: 10 }, exports._h.loyaltyPreflightCheck = async (req) => {
  const { uid, phone, loyaltyId: rawLoyaltyId, merchantId, total = 0, items = [], redeemPoints = 0 } = req.data;
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');

  let accountData = null;
  let accountUid  = uid || null;

  if (uid) {
    const s = await db.collection('loyaltyAccounts').doc(uid).get();
    if (s.exists) accountData = s.data();
  }
  if (!accountData && phone) {
    const s = await db.collection('loyaltyAccounts').where('phone', '==', phone).limit(1).get();
    if (!s.empty) { accountData = s.docs[0].data(); accountUid = s.docs[0].id; }
  }
  if (!accountData && rawLoyaltyId) {
    const s = await db.collection('loyaltyAccounts').where('loyaltyId', '==', rawLoyaltyId).limit(1).get();
    if (!s.empty) { accountData = s.docs[0].data(); accountUid = s.docs[0].id; }
  }

  const [configSnap, campSnap] = await Promise.all([
    db.collection('loyaltyMerchantConfigs').doc(merchantId).get(),
    db.collection('loyaltyMerchantConfigs').doc(merchantId).collection('campaigns')
      .where('active', '==', true).get(),
  ]);
  const config    = configSnap.exists ? configSnap.data() : {};
  const campaigns = campSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const account  = accountData || { lifetimePoints: 0, balance: 0, firstPurchaseAt: null };
  const estimate = _calcPoints({ total, items, config, account, campaigns });

  const tier             = _getTier(account.lifetimePoints || 0);
  const tierIdx          = TIERS.findIndex(t => t.name === tier.name);
  const nextTierObj      = tierIdx > 0 ? TIERS[tierIdx - 1] : null;
  const redemptionRate   = config.redemptionRate || 100;
  const redemptionValue  = redeemPoints > 0 ? parseFloat((redeemPoints / redemptionRate).toFixed(2)) : 0;

  return {
    found:            !!accountData,
    loyaltyId:        accountData?.loyaltyId || null,
    currentBalance:   account.balance || 0,
    tier:             tier.name,
    estimate:         { pointsEarned: estimate.totalPoints, cashbackKES: estimate.cashbackKES, breakdown: estimate.breakdown },
    redemptionValue,
    benefits:         TIER_BENEFITS[tier.name] || TIER_BENEFITS.bronze,
    pointsToNextTier: nextTierObj ? nextTierObj.min - (account.lifetimePoints || 0) : null,
  };
});

// ---------------------------------------------------------------------------
// 3. awardCashback
// ---------------------------------------------------------------------------
exports.awardCashback = onCall({ ...OPT, secrets: [LOYALTY_HMAC], timeoutSeconds: 15 }, exports._h.awardCashback = async (req) => {
  const { uid, amount, merchantId, orderId, type = 'earned' } = req.data;
  if (!uid)         throw new HttpsError('invalid-argument', 'uid is required');
  if (!amount || amount <= 0) throw new HttpsError('invalid-argument', 'amount must be > 0');
  if (!merchantId)  throw new HttpsError('invalid-argument', 'merchantId is required');
  if (!orderId)     throw new HttpsError('invalid-argument', 'orderId is required');

  const idemId  = _sha256(`awardCashback|${uid}|${orderId}`);
  const idemRef = db.collection('loyaltyCheckoutIdempotency').doc(idemId);

  await db.runTransaction(async (txn) => {
    const idemSnap = await txn.get(idemRef);
    if (idemSnap.exists) return;

    const accRef  = db.collection('loyaltyAccounts').doc(uid);
    const accSnap = await txn.get(accRef);
    const before  = accSnap.exists ? (accSnap.data().cashbackBalance || 0) : 0;

    txn.set(accRef, { cashbackBalance: F.increment(amount) }, { merge: true });

    const cbId = _sha256(`cashback_award|${uid}|${orderId}`);
    txn.set(db.collection('loyaltyCashbackLedger').doc(cbId), {
      uid, amount, type,
      balanceBefore: before,
      balanceAfter:  before + amount,
      orderId, merchantId,
      createdAt: F.serverTimestamp(),
    });
    txn.set(idemRef, { createdAt: F.serverTimestamp() });
  });

  return { success: true, uid, amount, type };
});

// ---------------------------------------------------------------------------
// 4. issueGiftCard
// ---------------------------------------------------------------------------
exports.issueGiftCard = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.issueGiftCard = async (req) => {
  const { merchantId, issuedTo, valueType = 'fixed', value, minOrderValue = 0, validDays = 30, maxUses = 1 } = req.data;
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');
  if (!value || value <= 0) throw new HttpsError('invalid-argument', 'value must be > 0');
  if (!['fixed', 'percent'].includes(valueType)) throw new HttpsError('invalid-argument', 'valueType must be fixed or percent');

  const code      = _giftCardCode();
  const expiresAt = new Date(Date.now() + validDays * 86400000);
  const cardRef   = db.collection('loyaltyGiftCards').doc();
  const cardId    = cardRef.id;

  await cardRef.set({
    merchantId,
    issuedTo:    issuedTo || null,
    code,
    valueType,
    value,
    minOrderValue,
    maxUses,
    usesRemaining: maxUses,
    expiresAt:   admin.firestore.Timestamp.fromDate(expiresAt),
    usedAt:      null,
    createdAt:   F.serverTimestamp(),
  });

  // Optional FCM
  if (issuedTo) {
    const accSnap = await db.collection('loyaltyAccounts').doc(issuedTo).get();
    if (accSnap.exists && accSnap.data().fcmToken) {
      admin.messaging().send({
        token:        accSnap.data().fcmToken,
        notification: { title: 'You have a gift card!', body: `Code: ${code} â€” Value: KES ${value}` },
        data:         { type: 'gift_card', code, cardId },
      }).catch(() => {});
    }
  }

  return { cardId, code, expiresAt: expiresAt.toISOString() };
});

// ---------------------------------------------------------------------------
// 5. redeemGiftCard
// ---------------------------------------------------------------------------
exports.redeemGiftCard = onCall({ ...OPT, secrets: [LOYALTY_HMAC], timeoutSeconds: 15 }, exports._h.redeemGiftCard = async (req) => {
  const { code, uid, merchantId, orderTotal = 0 } = req.data;
  if (!code)       throw new HttpsError('invalid-argument', 'code is required');
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');

  const snap = await db.collection('loyaltyGiftCards').where('code', '==', code).limit(1).get();
  if (snap.empty) return { valid: false, discount: 0, reason: 'Gift card not found' };

  const cardId  = snap.docs[0].id;
  const card    = snap.docs[0].data();
  const now     = Date.now();

  if (card.usedAt) return { valid: false, discount: 0, reason: 'Gift card already used' };
  if (card.expiresAt && card.expiresAt.toMillis() < now) return { valid: false, discount: 0, reason: 'Gift card expired' };
  if (card.merchantId && card.merchantId !== merchantId) return { valid: false, discount: 0, reason: 'Gift card not valid for this merchant' };
  if (card.minOrderValue && orderTotal < card.minOrderValue) {
    return { valid: false, discount: 0, reason: `Minimum order KES ${card.minOrderValue} required` };
  }

  const discount = card.valueType === 'percent'
    ? parseFloat(((orderTotal * card.value) / 100).toFixed(2))
    : (card.value || 0);

  return {
    valid:    true,
    discount: Math.min(discount, orderTotal),
    cardId,
    expiresAt: card.expiresAt ? card.expiresAt.toDate().toISOString() : null,
    valueType: card.valueType,
    value:     card.value,
  };
});

// ---------------------------------------------------------------------------
// 6. enterLuckyDraw
// ---------------------------------------------------------------------------
exports.enterLuckyDraw = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.enterLuckyDraw = async (req) => {
  const { uid, merchantId, orderId, purchaseAmount = 0 } = req.data;
  if (!uid)         throw new HttpsError('invalid-argument', 'uid is required');
  if (!merchantId)  throw new HttpsError('invalid-argument', 'merchantId is required');

  const now = admin.firestore.Timestamp.now();
  const drawsSnap = await db.collection('loyaltyDraws')
    .where('merchantId', '==', merchantId)
    .where('status', '==', 'active')
    .where('startsAt', '<=', now)
    .get();

  const entered = [];
  for (const drawDoc of drawsSnap.docs) {
    const draw = drawDoc.data();
    if (draw.endsAt && draw.endsAt.toMillis() < Date.now()) continue;
    if (draw.entryThreshold && purchaseAmount < draw.entryThreshold) continue;

    const entryRef = db.collection('loyaltyDrawEntries').doc(`${uid}_${drawDoc.id}`);
    await entryRef.set({
      uid,
      drawId:      drawDoc.id,
      merchantId,
      orderId:     orderId || null,
      entries:     F.increment(1),
      lastEntryAt: F.serverTimestamp(),
    }, { merge: true });

    const entrySnap = await entryRef.get();
    entered.push({
      drawId:   drawDoc.id,
      drawName: draw.name || drawDoc.id,
      entries:  entrySnap.data().entries || 1,
      prize:    draw.prize || null,
    });
  }

  return { entered };
});

// ---------------------------------------------------------------------------
// 7. runLuckyDraw (scheduled: daily 6AM UTC = 9AM EAT)
// ---------------------------------------------------------------------------
exports.runLuckyDraw = onSchedule({ schedule: '0 6 * * *', region: REGION }, async () => {
  const now  = admin.firestore.Timestamp.now();
  const snap = await db.collection('loyaltyDraws')
    .where('status', '==', 'active')
    .where('endsAt', '<=', now)
    .get();

  /* Fetch all draw entries in parallel instead of serially */
  const drawEntrySnaps = await Promise.all(
    snap.docs.map(d => db.collection('loyaltyDrawEntries').where('drawId', '==', d.id).get())
  );

  for (let di = 0; di < snap.docs.length; di++) {
    const drawDoc     = snap.docs[di];
    const entriesSnap = drawEntrySnaps[di];
    const draw = drawDoc.data();
    try {
      // Entries already fetched above
      if (entriesSnap.empty) {
        await drawDoc.ref.update({ status: 'drawn_no_entries', drawnAt: F.serverTimestamp() });
        continue;
      }

      // Build weighted pool
      const pool = [];
      for (const entry of entriesSnap.docs) {
        const data = entry.data();
        for (let i = 0; i < (data.entries || 1); i++) {
          pool.push(data.uid);
        }
      }
      const winnerIdx = crypto.randomInt(0, pool.length);
      const winnerUid = pool[winnerIdx];

      // Credit prize
      const prize = draw.prize || {};
      await db.runTransaction(async (txn) => {
        const accRef = db.collection('loyaltyAccounts').doc(winnerUid);
        if (prize.points) txn.update(accRef, { balance: F.increment(prize.points), lifetimePoints: F.increment(prize.points) });
        if (prize.cashback) txn.update(accRef, { cashbackBalance: F.increment(prize.cashback) });
        txn.update(drawDoc.ref, { status: 'drawn', winnerUid, drawnAt: F.serverTimestamp() });
        // Log to loyalty ledger
        const ledgerId = _sha256(`lucky_draw|${winnerUid}|${drawDoc.id}`);
        txn.set(db.collection('loyaltyLedger').doc(ledgerId), {
          uid: winnerUid,
          type: 'lucky_draw_win',
          drawId: drawDoc.id,
          prize,
          pointsEarned: prize.points || 0,
          cashbackEarned: prize.cashback || 0,
          createdAt: F.serverTimestamp(),
        });
      });

      // Notify winner
      const winnerSnap = await db.collection('loyaltyAccounts').doc(winnerUid).get();
      if (winnerSnap.exists && winnerSnap.data().fcmToken) {
        admin.messaging().send({
          token:        winnerSnap.data().fcmToken,
          notification: { title: 'You Won a Lucky Draw!', body: `Prize: ${JSON.stringify(prize)}` },
          data:         { type: 'lucky_draw_win', drawId: drawDoc.id },
        }).catch(() => {});
      }
    } catch (e) {
      console.error(`runLuckyDraw error for draw ${drawDoc.id}`, e);
    }
  }
});

// ---------------------------------------------------------------------------
// 8. trackReferral
// ---------------------------------------------------------------------------
exports.trackReferral = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.trackReferral = async (req) => {
  const { referrerId, referredPhone, referredUid } = req.data;
  if (!referrerId) throw new HttpsError('invalid-argument', 'referrerId is required');
  if (!referredPhone && !referredUid) throw new HttpsError('invalid-argument', 'referredPhone or referredUid required');

  // Check for existing referral
  let query = db.collection('loyaltyReferrals').where('referrerId', '==', referrerId);
  if (referredUid)   query = query.where('referredUid', '==', referredUid);
  else               query = query.where('referredPhone', '==', referredPhone);
  const existing = await query.limit(1).get();
  if (!existing.empty) return { success: false, reason: 'Referral already exists', referralId: existing.docs[0].id };

  const refRef = db.collection('loyaltyReferrals').doc();
  await refRef.set({
    referrerId,
    referredPhone: referredPhone || null,
    referredUid:   referredUid  || null,
    status:        'pending',
    createdAt:     F.serverTimestamp(),
  });

  return { success: true, referralId: refRef.id };
});

// ---------------------------------------------------------------------------
// 9. getPersonalizedOffers
// ---------------------------------------------------------------------------
exports.getPersonalizedOffers = onCall({
  ...OPT,
  secrets:        [ANTHROPIC_KEY],
  timeoutSeconds: 25,
  memory:         '512MiB',
}, exports._h.getPersonalizedOffers = async (req) => {
  const { uid, merchantId, limit = 5 } = req.data;
  if (!uid)        throw new HttpsError('invalid-argument', 'uid is required');
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');

  const [accSnap, ledgerSnap, configSnap, campSnap] = await Promise.all([
    db.collection('loyaltyAccounts').doc(uid).get(),
    db.collection('loyaltyLedger').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(10).get(),
    db.collection('loyaltyMerchantConfigs').doc(merchantId).get(),
    db.collection('loyaltyMerchantConfigs').doc(merchantId).collection('campaigns').where('active', '==', true).get(),
  ]);

  if (!accSnap.exists) throw new HttpsError('not-found', 'Loyalty account not found');
  const account   = accSnap.data();
  const config    = configSnap.exists ? configSnap.data() : {};
  const tier      = _getTier(account.lifetimePoints || 0);
  const tierIdx   = TIERS.findIndex(t => t.name === tier.name);
  const nextTier  = tierIdx > 0 ? TIERS[tierIdx - 1] : null;
  const nextTierGap = nextTier ? nextTier.min - (account.lifetimePoints || 0) : null;
  const history   = ledgerSnap.docs.map(d => d.data());

  // Rule-based fallback offers
  const ruleOffers = [];
  if (_isBirthday(account)) ruleOffers.push({ type: 'birthday', title: 'Happy Birthday!', description: 'Birthday double points today!', offer: '2x points', eligibility: 'today', priority: 10 });
  if (nextTierGap && nextTierGap < 2000) ruleOffers.push({ type: 'tier_upgrade', title: `${nextTier.name} is close!`, description: `Only ${nextTierGap} pts to ${nextTier.name}`, offer: 'Earn more points', eligibility: 'all', priority: 9 });
  if (account.cashbackBalance > 50) ruleOffers.push({ type: 'cashback', title: 'Redeem Your Cashback', description: `You have KES ${account.cashbackBalance} cashback available`, offer: 'Use cashback now', eligibility: 'balance > 50', priority: 8 });

  // AI personalization
  let offers         = [];
  let segments       = [];
  let personalization = 'rule_based';

  try {
    const apiKey = ANTHROPIC_KEY.value();
    const prompt = `You are a loyalty program AI for SOKONI, a Kenyan super-platform.
Customer profile:
- Tier: ${tier.name}, Balance: ${account.balance || 0} pts, Lifetime: ${account.lifetimePoints || 0} pts
- Cashback balance: KES ${account.cashbackBalance || 0}
- Total purchases: ${account.totalPurchases || 0}, Total spend: KES ${account.totalSpendKES || 0}
- Birthday: ${account.birthdayMonth ? `${account.birthdayDay}/${account.birthdayMonth}` : 'unknown'}
- Recent transactions: ${history.length} entries, last types: ${history.slice(0, 3).map(h => h.type).join(', ')}

Return JSON ONLY:
{
  "offers": [{ "type": string, "title": string, "description": string, "offer": string, "eligibility": string, "priority": number }],
  "segments": ["high_value"|"at_risk"|"new"|"frequent"|"dormant"]
}
Limit to ${Math.min(limit, 5)} offers. Focus on Kenya market, KES currency.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 512,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (response.ok) {
      const aiResp = await response.json();
      const text   = aiResp.content?.[0]?.text || '';
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (parsed.offers?.length) {
        offers         = parsed.offers.slice(0, limit);
        segments       = parsed.segments || [];
        personalization = 'ai';
      }
    }
  } catch (_e) {
    console.error('getPersonalizedOffers AI error', _e);
  }

  if (!offers.length) {
    offers   = ruleOffers.slice(0, limit);
    segments = account.totalPurchases === 0 ? ['new']
      : account.totalPurchases >= 10 ? ['frequent']
      : account.totalSpendKES > 50000 ? ['high_value']
      : ['bronze'];
  }

  return { offers, segments, nextTierGap, personalization };
});

// ---------------------------------------------------------------------------
// 10. getMembershipBenefits
// ---------------------------------------------------------------------------
exports.getMembershipBenefits = onCall({ region: REGION }, exports._h.getMembershipBenefits = async (req) => {
  const { uid, tier: rawTier } = req.data;

  let tierName = rawTier;
  let account  = null;

  if (uid) {
    const snap = await db.collection('loyaltyAccounts').doc(uid).get();
    if (snap.exists) {
      account  = snap.data();
      tierName = account.currentTier || _getTier(account.lifetimePoints || 0).name;
    }
  }

  tierName = tierName || 'bronze';
  const tierObj    = TIERS.find(t => t.name === tierName) || TIERS[TIERS.length - 1];
  const tierIdx    = TIERS.findIndex(t => t.name === tierName);
  const nextTier   = tierIdx > 0 ? TIERS[tierIdx - 1] : null;
  const lifetime   = account?.lifetimePoints || 0;
  const toNext     = nextTier ? nextTier.min - lifetime : null;
  const rangeSz    = nextTier ? nextTier.min - tierObj.min : 1;
  const progressPct = nextTier ? Math.min(100, Math.round(((lifetime - tierObj.min) / rangeSz) * 100)) : 100;

  return {
    tier:             tierName,
    benefits:         TIER_BENEFITS[tierName] || TIER_BENEFITS.bronze,
    pointsToNextTier: toNext,
    nextTier:         nextTier?.name || null,
    progressPct,
    tierIcon:         TIER_META[tierName]?.icon  || 'star',
    tierColor:        TIER_META[tierName]?.color || '#CD7F32',
  };
});

// ---------------------------------------------------------------------------
// 11. getLoyaltyFraudDashboard
// ---------------------------------------------------------------------------
exports.getLoyaltyFraudDashboard = onCall({ ...OPT, timeoutSeconds: 20 }, exports._h.getLoyaltyFraudDashboard = async (req) => {
  if (!req.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
  const { merchantId, days = 7 } = req.data;
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');

  const since = new Date(Date.now() - days * 86400000);
  const snap  = await db.collection('loyaltyLedger')
    .where('merchantId', '==', merchantId)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(since))
    .orderBy('createdAt', 'desc')
    .limit(500)
    .get();

  const entries = snap.docs.map(d => d.data());

  // Redemptions per customer per day
  const redemptionMap = {};
  const payRefSet     = new Set();
  const dupPayRefs    = [];
  let   totalPoints   = 0;
  let   totalRedeem   = 0;

  for (const e of entries) {
    totalPoints += e.pointsEarned || 0;
    totalRedeem += e.pointsRedeemed || 0;

    if (e.type === 'checkout' && e.pointsRedeemed > 0) {
      const day = e.createdAt?.toDate().toISOString().slice(0, 10) || 'unknown';
      const key = `${e.uid}_${day}`;
      redemptionMap[key] = (redemptionMap[key] || 0) + 1;
    }
    if (e.paymentRef) {
      if (payRefSet.has(e.paymentRef)) dupPayRefs.push({ uid: e.uid, paymentRef: e.paymentRef });
      payRefSet.add(e.paymentRef);
    }
  }

  const flaggedAccounts = [];
  for (const [key, count] of Object.entries(redemptionMap)) {
    if (count > 5) flaggedAccounts.push({ key, redemptionsPerDay: count, reason: 'High daily redemptions' });
  }
  for (const d of dupPayRefs) {
    flaggedAccounts.push({ ...d, reason: 'Duplicate paymentRef' });
  }

  const redemptionRate = totalPoints > 0 ? parseFloat((totalRedeem / totalPoints * 100).toFixed(1)) : 0;

  return {
    flaggedAccounts,
    suspiciousPatterns: flaggedAccounts.length > 0 ? ['high_redemption', 'duplicate_payref'].slice(0, flaggedAccounts.length) : [],
    stats: {
      totalTransactions: entries.length,
      totalPointsIssued: totalPoints,
      redemptionRate,
    },
  };
});

// ---------------------------------------------------------------------------
// 12. joinLoyaltyNetwork
// ---------------------------------------------------------------------------
exports.joinLoyaltyNetwork = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.joinLoyaltyNetwork = async (req) => {
  const { merchantId, networkId = 'sokoni_universal', sharePoints = false, earnMultiplier = 1.0 } = req.data;
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');

  // Verify merchant exists and is verified
  const merchantSnap = await db.collection('merchants').doc(merchantId).get();
  if (!merchantSnap.exists) throw new HttpsError('not-found', 'Merchant not found');
  const merchant = merchantSnap.data();
  if (!merchant.verified && !merchant.isVerified) {
    throw new HttpsError('failed-precondition', 'Merchant must be verified to join loyalty network');
  }

  await db.collection('loyaltyNetwork').doc(merchantId).set({
    merchantId,
    networkId,
    sharePoints,
    earnMultiplier: Math.max(0.5, Math.min(5.0, earnMultiplier)),
    joinedAt:       F.serverTimestamp(),
    updatedAt:      F.serverTimestamp(),
    status:         'active',
  }, { merge: true });

  return { success: true, merchantId, networkId, status: 'active' };
});

// ---------------------------------------------------------------------------
// 13. getCrossMerchantPoints
// ---------------------------------------------------------------------------
exports.getCrossMerchantPoints = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.getCrossMerchantPoints = async (req) => {
  const { uid } = req.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required');

  const [accSnap, ledgerSnap] = await Promise.all([
    db.collection('loyaltyAccounts').doc(uid).get(),
    db.collection('loyaltyLedger').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(50).get(),
  ]);

  if (!accSnap.exists) throw new HttpsError('not-found', 'Loyalty account not found');
  const account = accSnap.data();
  const entries = ledgerSnap.docs.map(d => d.data());

  // Group earnings by merchant
  const byMerchant = {};
  for (const e of entries) {
    if (!e.merchantId) continue;
    if (!byMerchant[e.merchantId]) byMerchant[e.merchantId] = { earned: 0, redeemed: 0, visits: 0 };
    byMerchant[e.merchantId].earned   += e.pointsEarned   || 0;
    byMerchant[e.merchantId].redeemed += e.pointsRedeemed || 0;
    byMerchant[e.merchantId].visits   += 1;
  }

  return {
    uid,
    loyaltyId:       account.loyaltyId,
    totalBalance:    account.balance        || 0,
    cashbackBalance: account.cashbackBalance || 0,
    lifetimePoints:  account.lifetimePoints  || 0,
    currentTier:     account.currentTier     || 'bronze',
    merchantBreakdown: byMerchant,
  };
});

// ---------------------------------------------------------------------------
// 14. reconcileLoyaltyLedger (scheduled: daily 0AM UTC = 3AM EAT)
// ---------------------------------------------------------------------------
exports.reconcileLoyaltyLedger = onSchedule({ schedule: '0 0 * * *', region: REGION }, async () => {
  const since    = new Date(Date.now() - 86400000);
  const accSnap  = await db.collection('loyaltyAccounts')
    .where('lastPurchaseAt', '>=', admin.firestore.Timestamp.fromDate(since))
    .limit(200)
    .get();

  let checked    = 0;
  let mismatches = 0;

  /* Batch all per-account ledger queries in parallel */
  const ledgerSnaps = await Promise.all(
    accSnap.docs.map(d => db.collection('loyaltyLedger').where('uid', '==', d.id).get().catch(() => null))
  );

  /* Collect mismatch writes into batches */
  const reconcBatch = db.batch();
  const alertBatch  = db.batch();
  let batchWrites = 0;

  for (let i = 0; i < accSnap.docs.length; i++) {
    const accDoc   = accSnap.docs[i];
    const uid      = accDoc.id;
    const account  = accDoc.data();
    const ledger   = ledgerSnaps[i];
    try {
      let computedBalance  = 0;
      let computedCashback = 0;

      for (const entry of (ledger?.docs || [])) {
        const d = entry.data();
        computedBalance  += (d.pointsEarned || 0) - (d.pointsRedeemed || 0);
        computedCashback += d.cashbackEarned || 0;
      }

      const balanceDrift  = Math.abs(computedBalance  - (account.balance        || 0));
      const cashbackDrift = Math.abs(computedCashback - (account.cashbackBalance || 0));

      if (balanceDrift > 1 || cashbackDrift > 0.01) {
        mismatches++;
        batchWrites++;
        reconcBatch.set(db.collection('loyaltyReconciliation').doc(), {
          uid,
          computedBalance,
          storedBalance:   account.balance        || 0,
          balanceDrift,
          computedCashback,
          storedCashback:  account.cashbackBalance || 0,
          cashbackDrift,
          detectedAt:      F.serverTimestamp(),
          status:          'flagged',
        });
        alertBatch.set(db.collection('adminAlerts').doc(), {
          type:      'loyalty_reconciliation_mismatch',
          uid,
          balanceDrift,
          cashbackDrift,
          severity:  'high',
          createdAt: F.serverTimestamp(),
        });
      }
      checked++;
    } catch (e) {
      console.error(`reconcileLoyaltyLedger uid=${uid}`, e);
    }
  }

  if (batchWrites > 0) await Promise.all([reconcBatch.commit(), alertBatch.commit()]);
  console.log(`reconcileLoyaltyLedger: checked=${checked}, mismatches=${mismatches}`);
});

// ---------------------------------------------------------------------------
// 15. getLoyaltyReceipt
// ---------------------------------------------------------------------------
exports.getLoyaltyReceipt = onCall({ region: REGION }, exports._h.getLoyaltyReceipt = async (req) => {
  const { checkoutId } = req.data;
  if (!checkoutId) throw new HttpsError('invalid-argument', 'checkoutId is required');

  const snap = await db.collection('loyaltyCheckouts').doc(checkoutId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Receipt not found');

  const checkout = snap.data();
  const isAdmin  = req.auth?.token?.admin === true;
  const isOwner  = req.auth?.uid && req.auth.uid === checkout.uid;

  if (!isAdmin && !isOwner) {
    throw new HttpsError('permission-denied', 'Access denied');
  }

  // Also fetch idempotency for full receipt
  const idemSnap = await db.collection('loyaltyCheckoutIdempotency').doc(checkoutId).get();
  const fullReceipt = idemSnap.exists ? idemSnap.data().cachedResult : null;

  return {
    checkoutId,
    receipt:  fullReceipt?.receipt   || checkout,
    loyalty:  fullReceipt?.loyalty   || null,
    checkout,
  };
});

// ---------------------------------------------------------------------------
// 16. getVisitFrequencyReward
// ---------------------------------------------------------------------------
exports.getVisitFrequencyReward = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.getVisitFrequencyReward = async (req) => {
  const { uid, merchantId } = req.data;
  if (!uid)        throw new HttpsError('invalid-argument', 'uid is required');
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');

  const [accSnap, configSnap] = await Promise.all([
    db.collection('loyaltyAccounts').doc(uid).get(),
    db.collection('loyaltyMerchantConfigs').doc(merchantId).get(),
  ]);

  if (!accSnap.exists) throw new HttpsError('not-found', 'Loyalty account not found');
  const account = accSnap.data();
  const config  = configSnap.exists ? configSnap.data() : {};

  const threshold      = config.visitFrequency?.threshold      || 5;
  const bonusPoints    = config.visitFrequency?.bonusPoints     || 100;
  const cooldownDays   = config.visitFrequency?.cooldownDays    || 30;

  const since30 = new Date(Date.now() - 30 * 86400000);
  const visitSnap = await db.collection('loyaltyLedger')
    .where('uid', '==', uid)
    .where('merchantId', '==', merchantId)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(since30))
    .get();

  const visitCount = visitSnap.size;
  if (visitCount < threshold) {
    return { rewarded: false, visitCount, threshold, pointsNeeded: threshold - visitCount };
  }

  // Check cooldown
  const lastRewardAt = account.lastVisitFrequencyRewardAt;
  const cooldownMs   = cooldownDays * 86400000;
  if (lastRewardAt && Date.now() - lastRewardAt.toMillis() < cooldownMs) {
    return { rewarded: false, visitCount, reason: 'Cooldown active', nextEligible: new Date(lastRewardAt.toMillis() + cooldownMs).toISOString() };
  }

  // Award bonus points
  const idemId = _sha256(`visit_freq|${uid}|${merchantId}|${Math.floor(Date.now() / cooldownMs)}`);
  const idemRef = db.collection('loyaltyCheckoutIdempotency').doc(`vf_${idemId}`);

  let alreadyAwarded = false;
  await db.runTransaction(async (txn) => {
    const idemSnap = await txn.get(idemRef);
    if (idemSnap.exists) { alreadyAwarded = true; return; }

    const accRef = db.collection('loyaltyAccounts').doc(uid);
    txn.update(accRef, {
      balance:                        F.increment(bonusPoints),
      lifetimePoints:                 F.increment(bonusPoints),
      lastVisitFrequencyRewardAt:     F.serverTimestamp(),
    });

    const ledgerId = _sha256(`visit_freq_ledger|${uid}|${merchantId}|${idemId}`);
    txn.set(db.collection('loyaltyLedger').doc(ledgerId), {
      uid,
      type:         'visit_frequency_reward',
      merchantId,
      visitCount,
      pointsEarned: bonusPoints,
      createdAt:    F.serverTimestamp(),
    });
    txn.set(idemRef, { createdAt: F.serverTimestamp() });
  });

  if (alreadyAwarded) {
    return { rewarded: false, visitCount, reason: 'Already awarded this period' };
  }

  return {
    rewarded:     true,
    visitCount,
    bonusPoints,
    threshold,
    message:      `Awarded ${bonusPoints} bonus points for ${visitCount} visits this month!`,
  };
});

// ---------------------------------------------------------------------------
// 17. listGiftCards — list gift cards issued by a merchant
// ---------------------------------------------------------------------------
exports.listGiftCards = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.listGiftCards = async (req) => {
  const { merchantId, limit: lim = 50, status } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');

  if (!req.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  // Fetch by merchantId; post-filter by status to avoid Firestore double-inequality
  const snap = await db.collection('loyaltyGiftCards')
    .where('merchantId', '==', merchantId)
    .orderBy('createdAt', 'desc')
    .limit(Math.min(lim, 100))
    .get();

  const now = new Date();
  let docs = snap.docs;
  if (status === 'active') {
    docs = docs.filter(d => {
      const c = d.data();
      const exp = c.expiresAt ? c.expiresAt.toDate() : null;
      return (c.usesRemaining || 0) > 0 && (!exp || exp > now);
    });
  } else if (status === 'used') {
    docs = docs.filter(d => (d.data().usesRemaining || 0) === 0);
  }

  const cards = docs.map(d => {
    const c = d.data();
    return {
      id:            d.id,
      code:          c.code,
      valueType:     c.valueType,
      value:         c.value,
      usesRemaining: c.usesRemaining,
      maxUses:       c.maxUses,
      issuedTo:      c.issuedTo || null,
      expiresAt:     c.expiresAt ? c.expiresAt.toDate().toISOString() : null,
      createdAt:     c.createdAt ? c.createdAt.toDate().toISOString() : null,
    };
  });

  return { cards, total: cards.length };
});

// ---------------------------------------------------------------------------
// 18. getLoyaltyNetworkStatus — get loyalty network membership for a merchant
// ---------------------------------------------------------------------------
exports.getLoyaltyNetworkStatus = onCall({ ...OPT, timeoutSeconds: 10 }, exports._h.getLoyaltyNetworkStatus = async (req) => {
  const { merchantId } = req.data || {};
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');

  const snap = await db.collection('loyaltyNetwork').doc(merchantId).get();
  if (!snap.exists) {
    return { joined: false, merchantId, networkId: null, status: 'not_joined' };
  }

  const d = snap.data();
  return {
    joined:         true,
    merchantId,
    networkId:      d.networkId      || 'sokoni_universal',
    sharePoints:    d.sharePoints    ?? false,
    earnMultiplier: d.earnMultiplier ?? 1.0,
    status:         d.status         || 'active',
    joinedAt:       d.joinedAt ? d.joinedAt.toDate().toISOString() : null,
  };
});
