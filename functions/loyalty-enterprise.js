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
/* The canonical loyalty accounting authority. reconcileLoyaltyLedger consumes it rather than
   summing the ledger itself — see the header on that function. */
const ACC                    = require('./loyalty-accounting');
/* The canonical event semantics — classOf, so the dashboard never keeps a second vocabulary. */
const EV                     = require('./loyalty-event');

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
  /* One rate authority — see rewards-rate.js. Decided 2026-09-12: 10 points = KES 1. */
  const _rn              = require('./rewards-rate').normalizeRewardsRate(config);
  const redemptionRate   = _rn.redemptionRate;       // points per KES
  const maxRedemptionPct = _rn.maxRedemptionPct;
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
    /* Written straight through the transaction handle. The increments are
       inside the txn.set call rather than assembled into a variable first, so
       the guard protecting them is visible at the point of the write instead of
       a dozen lines away. */
    txn.set(accountRef, {
      balance:         newBalance,
      lifetimePoints:  newLifetime,
      cashbackBalance: newCashbackBalance,
      currentTier:     newTier.name,
      lastPurchaseAt:  now,
      ...(isFirstPurchase ? { firstPurchaseAt: now } : {}),
      totalPurchases:  F.increment(1),
      totalSpendKES:   F.increment(total),
    }, { merge: true });

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
  const redemptionRate   = require('./rewards-rate').normalizeRewardsRate(config).redemptionRate;
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
    /* ACCOUNTING-EXEMPT: the customer's ten most recent events, used as context for a
       personalised-offer prompt. A recency SAMPLE, never summed into a reported figure —
       orderBy desc + limit(10) is the intent, not a truncated total. */
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
/* ══════════════════════════════════════════════════════════════════════════════════════
   FRAUD DASHBOARD — repaired under LOYALTY-FRAUD-DASHBOARD-ACCOUNTING.

   WHAT IT USED TO DO
   ------------------
       .limit(500) … entries = snap.docs.map(d => d.data())
       totalPoints += e.pointsEarned   || 0;
       totalRedeem += e.pointsRedeemed || 0;
       redemptionRate = totalRedeem / totalPoints * 100

   Three defects in four lines. The window was capped at 500 rows and summed as a total. The
   fields are the loyalty-enterprise DIALECT: measured at each of the 14 ledger write objects,
   TEN carry `points` — the whole canonical loyalty.js rail and every POS redemption — while
   only three carry `pointsEarned` and one carries `pointsRedeemed`. So the reported
   totalPointsIssued omitted the canonical rail, and the reported redemptionRate was a ratio of
   two figures that both missed every POS redemption. A fraud dashboard blind to POS redemption
   is worse than none, and nothing in the output said the view was partial.

   WHAT IT DOES NOW
   ----------------
   1. EVERY ACCOUNTING FIGURE COMES FROM loyalty-accounting.aggregate. This function performs no
      summation of its own. UNAVAILABLE and INCOMPLETE are passed through with NO numeric
      section attached, so there is nothing to render as a zero.
   2. THE MERCHANT IS RESOLVED, NOT ACCEPTED. An unresolvable merchantId returns
      UNRESOLVED_MERCHANT rather than an empty scan — which would otherwise render as a
      confident "no fraud detected" for a merchant that does not exist.
   3. BEHAVIOURAL SIGNALS ARE NOT ACCOUNTING, AND SAY SO. They come from the SAME single pager
      (loyalty-accounting.scanLedger) rather than a second query, so scope, window, failure and
      truncation semantics cannot drift from the figures beside them.
   4. REDEMPTION MEANS THE CANONICAL `redeem` CLASS — which is written by loyalty.js (online)
      and by the POS redemption factory (pos). `checkout` is NOT counted as a redemption: it
      is the sole writer carrying pointsRedeemed and its semantics are unresolved, so counting
      it would establish an accounting meaning by guess. Its presence is reported as an explicit
      limitation naming LOYALTY-CHECKOUT-EVENT-SEMANTICS.
   5. NO RATE IS RECOMPUTED. Valuation comes from the events, each carrying the rate and
      rateVersion that valued it; today's configuration is never applied to a historical event.
   ══════════════════════════════════════════════════════════════════════════════════════ */

const _FRAUD_SCHEMA = 2;
const _fsan = (v, n) => String(v === undefined || v === null ? '' : v).replace(/[^\w.@:-]/g, '').slice(0, n);

/* Behavioural thresholds. Named, so a reader can see what "suspicious" means here. */
const _FRAUD_REDEMPTIONS_PER_DAY = 5;

exports.getLoyaltyFraudDashboard = onCall({ ...OPT, timeoutSeconds: 20 }, exports._h.getLoyaltyFraudDashboard = async (req) => {
  if (!req.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');

  const merchantId = _fsan(req.data && req.data.merchantId, 64);
  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId is required');

  const rawDays = Number(req.data && req.data.days);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 365) : 7;
  const since = new Date(Date.now() - days * 86400000);

  const scope = { merchantId, days, since: since.toISOString() };

  /* ── 1. the merchant must RESOLVE ─────────────────────────────────────────────────
     An unknown merchantId would otherwise scan nothing and report a clean sheet. Absence of
     a tenant is not absence of fraud. */
  let biz;
  try {
    biz = await db.collection('businesses').doc(merchantId).get();
  } catch (err) {
    return { schemaVersion: _FRAUD_SCHEMA, state: 'UNAVAILABLE', scope,
             reason: 'merchant lookup failed: ' + ((err && err.message) || String(err)) };
  }
  if (!biz.exists) {
    return { schemaVersion: _FRAUD_SCHEMA, state: 'UNRESOLVED_MERCHANT', scope,
             reason: 'no businesses/' + merchantId + ' — a scan of nothing is not a clean sheet' };
  }

  /* ── 2. THE ACCOUNTING AUTHORITY — the only source of figures ─────────────────── */
  const agg = await ACC.aggregate(db, { merchantId, since });
  if (agg.state !== 'OK') {
    /* No numeric section. Deliberately nothing to mistake for a measurement. */
    return {
      schemaVersion: _FRAUD_SCHEMA,
      state: agg.state,
      reason: agg.reason,
      scope,
      authority: 'loyalty-accounting.aggregate',
      eventsRead: agg.eventsRead,
      eventsScanned: agg.eventsScanned,
    };
  }

  /* ── 3. behavioural signals, from the SAME pager ──────────────────────────────────
     Not accounting. Counted per customer per day over canonical REDEEM events only. */
  const redemptionsByCustomerDay = {};
  const payRefSeen = new Set();
  const duplicatePaymentRefs = [];
  let checkoutEventsSeen = 0;

  const scan = await ACC.scanLedger(db, { merchantId, since }, (e) => {
    const type = String(e.type || '');

    if (EV.classOf(type) === 'REDEEM') {
      const at = e.createdAt && typeof e.createdAt.toDate === 'function' ? e.createdAt.toDate() : null;
      const day = at ? at.toISOString().slice(0, 10) : '(undated)';
      const key = _fsan(e.uid, 64) + '|' + day;
      redemptionsByCustomerDay[key] = (redemptionsByCustomerDay[key] || 0) + 1;
    }

    if (type === 'checkout') checkoutEventsSeen++;

    if (e.paymentRef) {
      const ref = String(e.paymentRef);
      if (payRefSeen.has(ref)) duplicatePaymentRefs.push({ uid: _fsan(e.uid, 64), paymentRef: _fsan(ref, 120) });
      payRefSeen.add(ref);
    }
  });

  if (scan.state !== 'OK') {
    /* The figures were established but the behavioural pass was not. Say which, rather than
       reporting an empty flag list that reads as "nothing suspicious". */
    return {
      schemaVersion: _FRAUD_SCHEMA,
      state: 'INCOMPLETE',
      reason: 'accounting established, behavioural scan ' + scan.state + ': ' + scan.reason,
      scope,
      authority: 'loyalty-accounting.aggregate',
    };
  }

  const flagged = [];
  for (const [key, count] of Object.entries(redemptionsByCustomerDay)) {
    if (count > _FRAUD_REDEMPTIONS_PER_DAY) {
      const [uid, day] = key.split('|');
      flagged.push({ uid, day, redemptions: count,
                     reason: 'more than ' + _FRAUD_REDEMPTIONS_PER_DAY + ' canonical redemptions in one day' });
    }
  }
  for (const d of duplicatePaymentRefs) flagged.push({ ...d, reason: 'duplicate paymentRef' });

  /* ── 4. limitations, stated rather than implied ───────────────────────────────── */
  const limitations = [];
  if (checkoutEventsSeen > 0) {
    limitations.push({
      blocker: 'LOYALTY-CHECKOUT-EVENT-SEMANTICS',
      events: checkoutEventsSeen,
      detail: 'checkout events are present in this window and are NOT counted as redemptions. ' +
              'checkout is the only writer carrying pointsRedeemed and its accounting semantics ' +
              'are undeclared; counting it would establish a meaning by guess. Redemption ' +
              'figures here cover the canonical redeem class only.',
    });
  }
  if (agg.unclassified.length) {
    limitations.push({
      blocker: 'LOYALTY-CHECKOUT-EVENT-SEMANTICS',
      detail: 'the window contains event types this platform does not classify; they are ' +
              'excluded from every total rather than counted as zero',
      types: agg.unclassified,
    });
  }
  if (agg.valuation.eventsUnvalued > 0) {
    limitations.push({
      detail: 'events written before the canonical schema carry no KES valuation. They are ' +
              'COUNTED as unvalued, never summed as zero, and no rate is applied to them ' +
              'retrospectively.',
      eventsUnvalued: agg.valuation.eventsUnvalued,
    });
  }
  if (agg.window.eventsUndated > 0) {
    limitations.push({
      detail: 'events that could not be placed in time were excluded from the window',
      eventsUndated: agg.window.eventsUndated,
    });
  }

  /* Issued is positive, redeemed is negative by canonical sign. A ratio is reported only when
     there is something to divide by — never 0 standing in for "no basis". */
  const issued = agg.byClass.ISSUE.points;
  const redeemed = Math.abs(agg.byClass.REDEEM.points);

  return {
    schemaVersion: _FRAUD_SCHEMA,
    state: 'OK',
    scope,
    authority: 'loyalty-accounting.aggregate',
    merchant: { merchantId, resolved: true },

    accounting: {
      eventsRead: agg.eventsRead,
      eventsScanned: agg.eventsScanned,
      window: agg.window,
      points: {
        issued,
        redeemed,
        expired:  Math.abs(agg.byClass.EXPIRE.points),
        reversed: agg.byClass.REVERSE.points,
        adjusted: agg.byClass.ADJUST.points,
        outstanding: agg.points.outstanding,
      },
      byType: agg.byType,
      byRail: agg.byRail,
      valuation: {
        valuedKES: agg.valuation.valuedKES,
        eventsValued: agg.valuation.eventsValued,
        eventsUnvalued: agg.valuation.eventsUnvalued,
        /* WHICH configuration valued each event. Never re-derived from today's rate. */
        rateVersions: agg.valuation.rateVersions,
      },
      unclassified: agg.unclassified,
      /* null, not 0, when there is no issuance to form a ratio against. */
      redemptionRatePct: issued > 0 ? parseFloat((redeemed / issued * 100).toFixed(1)) : null,
    },

    signals: {
      basis: 'canonical redeem class only (rails: online and pos); checkout excluded',
      flagged,
      suspiciousPatterns: [...new Set(flagged.map((f) => f.reason))],
    },

    limitations,
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
/* ══════════════════════════════════════════════════════════════════════════════════════
   CROSS-MERCHANT POINTS — repaired under LOYALTY-CROSS-MERCHANT-ACCOUNTING.

   IT HAD NO AUTHORIZATION AT ALL
   ------------------------------
       const { uid } = req.data;
       if (!uid) throw new HttpsError('invalid-argument', 'uid is required');

   That was the whole caller model. Any caller — including an unauthenticated one, App Check
   gates apps rather than users — could name any customer and read their loyalty balance, tier,
   lifetime points, and the full list of merchants they shop at with amounts. A customer
   privacy leak and a competitive-intelligence leak in the same response, reachable directly
   and through loyaltyDispatch. That is repaired here rather than left for a later gate: it is
   the same read path this gate had to touch, and the callable has no consumer to break.

   NOW: the caller must be the account holder, or a platform admin. A merchant is NOT a
   permitted caller — the response spans merchants by construction, so serving it to one
   merchant would hand them a customer's activity at their competitors. A merchant-scoped view
   of their OWN row is a different capability and needs its own gate; it is not invented here.

   THE ACCOUNTING WAS THE DIALECT DEFECT
   -------------------------------------
       byMerchant[e.merchantId].earned   += e.pointsEarned   || 0;
       byMerchant[e.merchantId].redeemed += e.pointsRedeemed || 0;
       byMerchant[e.merchantId].visits   += 1;

   over a .limit(50) window. Measured at each of the 14 ledger write objects, TEN carry
   `points` — the whole canonical loyalty.js rail and every POS redemption — and only three
   carry `pointsEarned`. So a merchant whose events come from the canonical rail read
   0 earned / 0 redeemed while `visits` counted correctly: the row looked ALIVE and said the
   money was zero. That is worse than an empty row, because it reads as a measurement.

   NOW: every figure comes from loyalty-accounting.aggregateGrouped, grouped on the
   SERVER-WRITTEN merchantId. The handler classifies nothing itself.

   A ROW IS NEVER FINANCIALLY POPULATED BY VISITS ALONE. Where a merchant's events are all
   unclassified — `checkout` is written but undeclared — the row carries NO points object at
   all and says accounting: 'UNESTABLISHED'. Zero and "not established" are different answers,
   and a visit count beside a zero is exactly how they get confused.
   ══════════════════════════════════════════════════════════════════════════════════════ */

const _XM_SCHEMA = 2;

exports.getCrossMerchantPoints = onCall({ ...OPT, timeoutSeconds: 15 }, exports._h.getCrossMerchantPoints = async (req) => {
  /* ── 1. AUTHORIZATION — there was none ──────────────────────────────────────── */
  const auth = req.auth;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const target = _fsan(req.data && req.data.uid, 128);
  if (!target) throw new HttpsError('invalid-argument', 'uid is required');

  const t = auth.token || {};
  const isAdmin = t.admin === true || t.superAdmin === true;
  if (!isAdmin && target !== auth.uid) {
    /* A merchant or seller claim lands here too, deliberately. */
    throw new HttpsError('permission-denied', 'That loyalty account is not yours.');
  }

  /* ── 2. the account ─────────────────────────────────────────────────────────── */
  let accSnap;
  try {
    accSnap = await db.collection('loyaltyAccounts').doc(target).get();
  } catch (err) {
    return { schemaVersion: _XM_SCHEMA, state: 'UNAVAILABLE', uid: target,
             reason: 'account read failed: ' + ((err && err.message) || String(err)) };
  }
  if (!accSnap.exists) throw new HttpsError('not-found', 'Loyalty account not found');
  const account = accSnap.data() || {};

  /* ── 3. THE ACCOUNTING AUTHORITY, grouped on the SERVER-WRITTEN merchantId ──────
     The grouping key comes off each event, never off the request: a caller-supplied
     merchantId cannot re-attribute, merge or redirect a row. */
  const grouped = await ACC.aggregateGrouped(db, { uid: target }, 'merchantId');

  if (grouped.state !== 'OK') {
    /* NO breakdown, and in particular NO visit counts. A visit count without its accounting
       is precisely how a merchant comes to look financially populated when nothing was
       established. */
    return {
      schemaVersion: _XM_SCHEMA,
      state: grouped.state,
      reason: grouped.reason,
      uid: target,
      authority: 'loyalty-accounting.aggregateGrouped',
      eventsRead: grouped.eventsRead,
      eventsScanned: grouped.eventsScanned,
    };
  }

  /* ── 4. one row per merchant ────────────────────────────────────────────────── */
  const merchantBreakdown = {};
  for (const mid of Object.keys(grouped.groups)) {
    const g = grouped.groups[mid];

    const row = {
      visits: g.eventsRead,
      unclassified: g.unclassified,
      valuation: {
        valuedKES: g.valuation.valuedKES,
        eventsValued: g.valuation.eventsValued,
        /* Counted, never summed as zero. */
        eventsUnvalued: g.valuation.eventsUnvalued,
        /* WHICH configuration valued each event. Never re-derived from today's rate. */
        rateVersions: g.valuation.rateVersions,
      },
    };

    if (g.classifiedEvents === 0) {
      /* Every event here is of a type this platform does not classify. There is no financial
         figure to report, and reporting zeros beside a live visit count would invent one. */
      row.accounting = 'UNESTABLISHED';
      row.reason = 'no classifiable events for this merchant; see LOYALTY-CHECKOUT-EVENT-SEMANTICS';
    } else {
      row.accounting = g.unclassified.length ? 'PARTIAL' : 'ESTABLISHED';
      row.points = {
        earned:   g.points.issued,
        redeemed: Math.abs(g.points.redeemed),
        expired:  Math.abs(g.points.expired),
        reversed: g.points.reversed,
        adjusted: g.points.adjusted,
        outstanding: g.points.outstanding,
      };
      row.byRail = g.byRail;
    }
    merchantBreakdown[mid] = row;
  }

  /* ── 5. the stored account fields — absence survives ────────────────────────── */
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  return {
    schemaVersion: _XM_SCHEMA,
    state: 'OK',
    uid: target,
    authority: 'loyalty-accounting.aggregateGrouped',
    eventsRead: grouped.eventsRead,
    eventsScanned: grouped.eventsScanned,
    /* Events carrying no merchantId. Reported, not folded into any merchant's row. */
    ungroupedEvents: grouped.ungrouped,

    /* STORED on the account document. Not derived here, and not reconciled here — drift
       between these and the canonical figures is reconcileLoyaltyLedger's subject. null means
       the field is ABSENT, which is not the same as a balance of zero. */
    account: {
      loyaltyId:       account.loyaltyId || null,
      storedBalance:   num(account.balance),
      cashbackBalance: num(account.cashbackBalance),
      lifetimePoints:  num(account.lifetimePoints),
      currentTier:     account.currentTier || null,
    },

    merchantBreakdown,
  };
});

// ---------------------------------------------------------------------------
// 14. reconcileLoyaltyLedger (scheduled: daily 0AM UTC = 3AM EAT)
// ---------------------------------------------------------------------------
/* ══════════════════════════════════════════════════════════════════════════════════════
   RECONCILIATION — repaired under LOYALTY-RECONCILIATION-INTEGRITY.

   WHAT THIS JOB USED TO DO, AND WHY IT HAD TO CHANGE
   --------------------------------------------------
   It is a DAILY SCHEDULED WRITER. It summed the ledger itself:

       .get().catch(() => null)                       // a failed query became null
       for (const entry of (ledger?.docs || []))      // …and null became an empty loop
       computedBalance += (d.pointsEarned || 0) - (d.pointsRedeemed || 0);

   Two independent paths produced computedBalance 0 against a real stored balance:

     · a FAILED query — swallowed, indistinguishable from an account with no events;
     · a SUCCESSFUL read of any account whose events carry `points`. Measured at each of the
       14 loyaltyLedger write objects: TEN carry `points` — the whole canonical loyalty.js
       rail and every POS redemption — while only three carry `pointsEarned` and one carries
       `pointsRedeemed`.

   Either path read as balance drift, and the job then WROTE a durable loyaltyReconciliation
   record and a high-severity adminAlerts row asserting the customer's balance was wrong. It
   did not display a wrong number; it recorded one, into the collections an investigator would
   later treat as evidence.

   WHAT IT DOES NOW
   ----------------
   1. THE COMPUTED SIDE IS NOT COMPUTED HERE. loyalty-accounting.aggregate is the one
      authority: it pages every event, derives signs from the full canonical vocabulary, and
      returns state UNAVAILABLE / INCOMPLETE with NO totals rather than a zero.
   2. THE STORED SIDE IS `balance`. Measured at the write: loyalty.js and loyalty-enterprise.js
      both write `balance` to loyaltyAccounts and neither writes `pointsBalance`.
   3. A COMPARISON IS EITHER ESTABLISHED OR IT IS NOT. Four things each stop it, and none of
      them produces a discrepancy, a record or an alert:
        · the aggregate is not OK (UNAVAILABLE / INCOMPLETE);
        · the ledger holds events this platform cannot classify — `checkout` is written but
          absent from the canonical vocabulary, and unclassified events are kept OUT of the
          aggregate's totals, so comparing against them would manufacture a drift;
        · the account carries no numeric `balance`;
        · the account document is missing.
      A record is written ONLY from a comparison that was successfully established.
   4. IDEMPOTENT PER PERIOD. The record and the alert are keyed on uid + the UTC period, so a
      re-run of the same day overwrites rather than accumulating. The old job used .doc() with
      a generated id, so every re-run minted fresh evidence of the same alleged drift.
   5. PROVENANCE TRAVELS WITH THE FIGURE. Each record carries the authority that produced it,
      the account field compared, how many events were read, the class breakdown and the
      unvalued count — enough to explain the number without re-deriving it.

   CASHBACK IS DELIBERATELY NOT RECONCILED. It was, against `cashbackEarned`, a field two of
   the fourteen writers produce. There is no canonical cashback authority — loyalty-accounting
   values POINTS and holds no cashback concept — and inventing one inside a scheduled writer is
   the second-authority defect this repair exists to remove. Recorded as
   LOYALTY-CASHBACK-NO-CANONICAL-AUTHORITY rather than approximated.
   ══════════════════════════════════════════════════════════════════════════════════════ */

/* Points are integers on every canonical writer; this tolerance exists for float noise only,
   NOT to suppress small real drifts. The old job used `> 1`, which hid a genuine one-point
   discrepancy. */
const _RECON_EPSILON = 1e-9;
const _RECON_SCHEMA  = 2;

/* A sweep processes a BATCH of accounts per run. Saturation is REPORTED (accountsDue vs the
   bound) rather than silently dropping the remainder. */
const _RECON_BATCH = 200;

function _reconPeriodKey(d) {
  /* UTC day. The schedule is 0 0 * * * UTC, so the period and the run agree. */
  return d.toISOString().slice(0, 10);
}

exports.reconcileLoyaltyLedger = onSchedule({ schedule: '0 0 * * *', region: REGION }, async () => {
  const runAt     = new Date();
  const periodKey = _reconPeriodKey(runAt);
  const since     = new Date(runAt.getTime() - 86400000);

  let accSnap;
  try {
    accSnap = await db.collection('loyaltyAccounts')
      .where('lastPurchaseAt', '>=', admin.firestore.Timestamp.fromDate(since))
      /* ACCOUNTING-EXEMPT: a sweep bound, not a reported figure. Saturation is reported
         below as accountsDue >= the bound; nothing here is summed into a total. */
      .limit(_RECON_BATCH)
      .get();
  } catch (err) {
    /* The account query itself failed. That is an UNAVAILABLE run, not a run that found
       nothing wrong — and it writes nothing at all. */
    console.error('[loyalty] reconcile UNAVAILABLE: account query failed', err);
    return;
  }

  const outcome = {
    period: periodKey,
    accountsDue: accSnap.size,
    batchSaturated: accSnap.size >= _RECON_BATCH,
    established: 0,
    clean: 0,
    discrepancies: 0,
    unresolvedNoBalance: 0,
    unresolvedUnclassified: 0,
    aggregateUnavailable: 0,
  };

  const reconcBatch = db.batch();
  const alertBatch  = db.batch();
  let batchWrites = 0;

  for (const accDoc of accSnap.docs) {
    const uid     = accDoc.id;
    const account = accDoc.data() || {};
    try {
      /* THE ONE AUTHORITY. Not a query written here. */
      const agg = await ACC.aggregate(db, { uid });

      if (!agg || agg.state !== 'OK') {
        /* No totals exist on a non-OK aggregate. There is deliberately nothing to compare,
           and therefore nothing to record. */
        outcome.aggregateUnavailable++;
        console.warn('[loyalty] reconcile: aggregate ' + ((agg && agg.state) || 'MISSING') +
                     ' for uid=' + uid + ' — no comparison established, nothing written',
                     { reason: (agg && agg.reason) || null });
        continue;
      }

      if (agg.unclassified && agg.unclassified.length) {
        /* Unclassified events are kept OUT of the aggregate's totals by design. Comparing a
           total that excludes them against a stored balance that includes them would invent
           a drift. See LOYALTY-CHECKOUT-EVENT-SEMANTICS. */
        outcome.unresolvedUnclassified++;
        console.warn('[loyalty] reconcile: uid=' + uid + ' has unclassified event types — ' +
                     'no comparison established, nothing written',
                     { types: agg.unclassified.map((u) => u.type) });
        continue;
      }

      /* THE ACCOUNT AUTHORITY IS `balance`. An absent field is UNRESOLVED, never zero. */
      const stored = account.balance;
      if (typeof stored !== 'number' || !Number.isFinite(stored)) {
        outcome.unresolvedNoBalance++;
        console.warn('[loyalty] reconcile: uid=' + uid + ' carries no numeric balance — ' +
                     'no comparison established, nothing written');
        continue;
      }

      const computed = agg.points.outstanding;
      if (typeof computed !== 'number' || !Number.isFinite(computed)) {
        outcome.aggregateUnavailable++;
        continue;
      }

      outcome.established++;
      const drift = Math.abs(computed - stored);
      if (drift <= _RECON_EPSILON) { outcome.clean++; continue; }

      /* ESTABLISHED and genuinely divergent. This is the only path that writes. */
      outcome.discrepancies++;
      batchWrites++;

      const key = _sha256('loyaltyReconciliation|' + uid + '|' + periodKey);
      reconcBatch.set(db.collection('loyaltyReconciliation').doc(key), {
        schemaVersion:   _RECON_SCHEMA,
        uid,
        period:          periodKey,
        /* provenance: what produced the figure, and against which field */
        authority:       'loyalty-accounting.aggregate',
        accountField:    'balance',
        aggregateState:  agg.state,
        eventsRead:      agg.eventsRead,
        byClass:         agg.byClass,
        eventsValued:    agg.valuation.eventsValued,
        eventsUnvalued:  agg.valuation.eventsUnvalued,
        /* the comparison */
        computedBalance: computed,
        storedBalance:   stored,
        balanceDrift:    drift,
        /* Cashback is NOT reconciled — no canonical authority exists for it. */
        cashbackReconciled: false,
        cashbackReason:  'no canonical cashback authority (LOYALTY-CASHBACK-NO-CANONICAL-AUTHORITY)',
        status:          'flagged',
        detectedAt:      F.serverTimestamp(),
      });

      alertBatch.set(db.collection('adminAlerts').doc(
        _sha256('loyaltyReconciliationAlert|' + uid + '|' + periodKey)), {
        type:         'loyalty_reconciliation_mismatch',
        uid,
        period:       periodKey,
        balanceDrift: drift,
        authority:    'loyalty-accounting.aggregate',
        eventsRead:   agg.eventsRead,
        severity:     'high',
        createdAt:    F.serverTimestamp(),
      });
    } catch (err) {
      /* An unexpected failure for ONE account is that account's outcome, not a discrepancy. */
      outcome.aggregateUnavailable++;
      console.error('[loyalty] reconcile uid=' + uid + ' failed — nothing written for it', err);
    }
  }

  if (batchWrites > 0) await Promise.all([reconcBatch.commit(), alertBatch.commit()]);

  /* The explicit outcome of the run. Every account is accounted for in exactly one bucket,
     so a run that established nothing cannot be read as a run that found nothing wrong. */
  console.log('[loyalty] reconcileLoyaltyLedger', outcome);
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
