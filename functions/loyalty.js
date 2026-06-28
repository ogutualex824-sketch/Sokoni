/**
 * SOKONI Loyalty & Rewards Engine v1.0
 * ──────────────────────────────────────────────────────────────────────────────
 * Cloud Functions (Gen 2, Node 22, us-central1):
 *   getLoyaltyAccount         — read/initialise account for the calling user
 *   earnLoyaltyPoints         — credit points for purchases, reviews, referrals…
 *   redeemLoyaltyPoints       — lock points against an order (pending)
 *   confirmLoyaltyRedemption  — settle or cancel a pending redemption
 *   getLoyaltyHistory         — paginated transaction log for the calling user
 *   getLoyaltyTiers           — public tier definitions + earn rates
 *   adminAdjustPoints         — admin manual credit / deduction
 *   getLoyaltyLeaderboard     — top-10 earners (anonymised)
 *
 * Firestore collections (NO new composite indexes — all queries are
 * single-field where() or doc-ID lookups):
 *   loyaltyAccounts/{uid}          — per-user balance, tier, lifetime totals
 *   loyaltyTransactions/{txId}     — immutable ledger; uid field (single-field)
 *   loyaltyRules/default           — runtime-configurable earn/redeem rates
 *
 * Transaction doc-ID conventions (used for idempotency):
 *   earn    → {uid}_{orderId}_earn
 *   redeem  → {uid}_{orderId}_redeem
 *   adjust  → {uid}_adj_{Date.now()}_{random4}
 *   expire  → {uid}_{batchId}_expire
 *
 * Security hardening:
 *   - Auth required on all user-facing functions
 *   - Admin-only on adminAdjustPoints
 *   - All inputs sanitised and range-validated
 *   - No PII logged; uid is acceptable in logs, names/phone/email are not
 *   - No stack traces exposed to callers
 *   - Atomic Firestore transactions for all balance mutations
 *   - Idempotency guards on earn & redeem paths
 *
 * @module loyalty
 */

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

// ── Shared constants ──────────────────────────────────────────────────────────

const REGION = "us-central1";

/** Tier definitions — single source of truth. */
const TIERS = [
  { name: "Bronze",   min: 0,     max: 999,   multiplier: 1,   color: "#cd7f32", icon: "🥉" },
  { name: "Silver",   min: 1000,  max: 4999,  multiplier: 1.5, color: "#c0c0c0", icon: "🥈" },
  { name: "Gold",     min: 5000,  max: 19999, multiplier: 2,   color: "#ffd700", icon: "🥇" },
  { name: "Platinum", min: 20000, max: null,  multiplier: 3,   color: "#e5e4e2", icon: "💎" },
];

/** Fallback earn/redeem config — overridden by loyaltyRules/default when present. */
const DEFAULT_RULES = {
  earnRate:        1,    // 1 pt per KSh 10 (i.e. points = Math.floor(amount / 10))
  redemptionRate:  10,   // KSh 10 per 100 pts
  minRedemption:   500,  // pts
  maxBonusPoints:  1000, // cap on a single 'bonus' source earn
  reviewBonus:     5,
  referralBonus:   50,
  profileBonus:    10,
};

const VALID_EARN_SOURCES = new Set([
  "purchase",
  "review",
  "referral",
  "profile_complete",
  "bonus",
]);

// ── Internal helpers ──────────────────────────────────────────────────────────

/** @returns {FirebaseFirestore.Firestore} */
function _db() {
  return getFirestore();
}

/**
 * Throw HttpsError if the caller is not authenticated.
 * @param {object} ctx — onCall request context
 * @returns {string} uid
 */
function _requireAuth(ctx) {
  if (!ctx.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  return ctx.auth.uid;
}

/**
 * Throw HttpsError if the caller does not hold admin or superAdmin custom claim.
 * @param {object} ctx — onCall request context
 */
function _requireAdmin(ctx) {
  if (!ctx.auth?.token?.admin && !ctx.auth?.token?.superAdmin) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
}

/**
 * Strip HTML tags, trim, and truncate.
 * @param {*}      s
 * @param {number} max
 * @returns {string}
 */
function _san(s, max = 300) {
  if (s == null) return "";
  return String(s).replace(/<[^>]*>/g, "").trim().slice(0, max);
}

/**
 * Determine tier name from a point balance.
 * @param {number} balance
 * @returns {{ tier: string, multiplier: number, tierIndex: number }}
 */
function _tierFor(balance) {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (balance >= TIERS[i].min) {
      return { tier: TIERS[i].name, multiplier: TIERS[i].multiplier, tierIndex: i };
    }
  }
  return { tier: TIERS[0].name, multiplier: TIERS[0].multiplier, tierIndex: 0 };
}

/**
 * Derive next tier threshold and points-to-next from a balance.
 * @param {number} balance
 * @returns {{ nextTierThreshold: number|null, pointsToNextTier: number|null }}
 */
function _nextTier(balance) {
  const { tierIndex } = _tierFor(balance);
  if (tierIndex >= TIERS.length - 1) {
    return { nextTierThreshold: null, pointsToNextTier: null };
  }
  const next = TIERS[tierIndex + 1];
  return {
    nextTierThreshold: next.min,
    pointsToNextTier:  Math.max(0, next.min - balance),
  };
}

/**
 * Fetch (or fall back to defaults for) loyaltyRules/default.
 * @returns {Promise<object>}
 */
async function _getRules() {
  try {
    const snap = await _db().collection("loyaltyRules").doc("default").get();
    if (snap.exists) {
      return { ...DEFAULT_RULES, ...snap.data() };
    }
  } catch (_) {
    // Non-fatal — use hardcoded defaults
  }
  return { ...DEFAULT_RULES };
}

/**
 * Build a default loyalty account document.
 * @param {string} uid
 * @returns {object}
 */
function _defaultAccount(uid) {
  return {
    uid,
    balance:        0,
    tier:           "Bronze",
    totalEarned:    0,
    totalRedeemed:  0,
    lastUpdated:    FieldValue.serverTimestamp(),
  };
}

/**
 * Safe integer: converts to Number, floors, clamps to [0, Infinity].
 * @param {*} v
 * @returns {number}
 */
function _safeInt(v) {
  const n = Math.floor(Number(v));
  return isNaN(n) ? 0 : Math.max(0, n);
}

// ── Cloud Functions ───────────────────────────────────────────────────────────

// ─── 1. getLoyaltyAccount ────────────────────────────────────────────────────
/**
 * Returns the caller's loyalty account, creating a default doc on first call.
 *
 * Response:
 *   { balance, tier, tierMultiplier, totalEarned, totalRedeemed,
 *     nextTierThreshold, pointsToNextTier, lastUpdated }
 */
exports.getLoyaltyAccount = onCall(
  { region: REGION, cors: true },
  async (req) => {
    const uid = _requireAuth(req);
    const db  = _db();

    const ref  = db.collection("loyaltyAccounts").doc(uid);
    const snap = await ref.get();

    let data;
    if (!snap.exists) {
      // First-time initialisation — write default doc
      const defaults = _defaultAccount(uid);
      await ref.set(defaults, { merge: true });
      data = { ...defaults, balance: 0, totalEarned: 0, totalRedeemed: 0 };
    } else {
      data = snap.data();
    }

    const balance           = _safeInt(data.balance);
    const { tier, multiplier } = _tierFor(balance);
    const { nextTierThreshold, pointsToNextTier } = _nextTier(balance);

    return {
      balance,
      tier,
      tierMultiplier:     multiplier,
      totalEarned:        _safeInt(data.totalEarned),
      totalRedeemed:      _safeInt(data.totalRedeemed),
      nextTierThreshold,
      pointsToNextTier,
      lastUpdated:        data.lastUpdated ?? null,
    };
  }
);

// ─── 2. earnLoyaltyPoints ────────────────────────────────────────────────────
/**
 * Credits points to the caller's account.
 *
 * Input:
 *   { orderId: string, amount?: number, source: string, description?: string }
 *
 * Idempotency:
 *   Transaction doc-ID `{uid}_{orderId}_earn` is written once; subsequent
 *   calls with the same orderId return the original result without mutation.
 *
 * Response:
 *   { pointsEarned, newBalance, tier }
 */
exports.earnLoyaltyPoints = onCall(
  { region: REGION, cors: true },
  async (req) => {
    const uid = _requireAuth(req);
    const db  = _db();

    // ── Input validation ──────────────────────────────────────────────────────
    const orderId     = _san(req.data?.orderId, 128);
    const source      = _san(req.data?.source,  64);
    const description = _san(req.data?.description, 300);
    const rawAmount   = Number(req.data?.amount ?? 0);

    if (!orderId) {
      throw new HttpsError("invalid-argument", "orderId is required.");
    }
    if (!VALID_EARN_SOURCES.has(source)) {
      throw new HttpsError(
        "invalid-argument",
        `source must be one of: ${[...VALID_EARN_SOURCES].join(", ")}.`
      );
    }
    if (source === "purchase" && (isNaN(rawAmount) || rawAmount < 0)) {
      throw new HttpsError("invalid-argument", "amount must be a non-negative number for purchase source.");
    }

    // ── Fetch rules ───────────────────────────────────────────────────────────
    const rules = await _getRules();

    // ── Calculate points ──────────────────────────────────────────────────────
    let pointsEarned;
    switch (source) {
      case "purchase":
        pointsEarned = Math.floor(Math.max(0, rawAmount) / 10);
        break;
      case "review":
        pointsEarned = rules.reviewBonus;
        break;
      case "referral":
        pointsEarned = rules.referralBonus;
        break;
      case "profile_complete":
        pointsEarned = rules.profileBonus;
        break;
      case "bonus":
        // Caller-supplied amount, capped for safety
        pointsEarned = Math.min(Math.max(0, Math.floor(rawAmount)), rules.maxBonusPoints);
        break;
      default:
        throw new HttpsError("invalid-argument", "Unknown source.");
    }

    if (pointsEarned <= 0) {
      throw new HttpsError("invalid-argument", "No points would be earned.");
    }

    // ── Idempotency check via deterministic doc-ID ────────────────────────────
    const txId  = `${uid}_${orderId}_earn`;
    const txRef = db.collection("loyaltyTransactions").doc(txId);
    const accRef = db.collection("loyaltyAccounts").doc(uid);

    // Use a Firestore transaction so idempotency check + write are atomic
    const result = await db.runTransaction(async (tx) => {
      const [txSnap, accSnap] = await Promise.all([
        tx.get(txRef),
        tx.get(accRef),
      ]);

      // Already processed — return cached result
      if (txSnap.exists) {
        const prev      = txSnap.data();
        const accData   = accSnap.exists ? accSnap.data() : { balance: 0 };
        const balance   = _safeInt(accData.balance);
        const { tier }  = _tierFor(balance);
        return { pointsEarned: prev.points, newBalance: balance, tier, duplicate: true };
      }

      // Compute new balance
      const currentBalance = accSnap.exists ? _safeInt(accSnap.data().balance) : 0;
      const currentEarned  = accSnap.exists ? _safeInt(accSnap.data().totalEarned) : 0;
      const newBalance     = currentBalance + pointsEarned;
      const { tier }       = _tierFor(newBalance);

      // Write loyalty account update
      tx.set(
        accRef,
        {
          uid,
          balance:     newBalance,
          tier,
          totalEarned: currentEarned + pointsEarned,
          lastUpdated: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // Write immutable transaction record
      tx.set(txRef, {
        uid,
        type:        "earn",
        points:      pointsEarned,
        source,
        orderId,
        description: description || `Points earned via ${source}`,
        createdAt:   FieldValue.serverTimestamp(),
      });

      return { pointsEarned, newBalance, tier, duplicate: false };
    });

    // Strip internal flag before returning
    const { duplicate: _dup, ...response } = result; // eslint-disable-line no-unused-vars
    return response;
  }
);

// ─── 3. redeemLoyaltyPoints ──────────────────────────────────────────────────
/**
 * Locks points for redemption against a specific order.
 * Creates a pending redemption transaction; balance is deducted immediately.
 * Call confirmLoyaltyRedemption to settle or refund.
 *
 * Input:
 *   { points: number, orderId: string }
 *
 * Response:
 *   { discountAmount, pointsRedeemed, redemptionId, newBalance }
 */
exports.redeemLoyaltyPoints = onCall(
  { region: REGION, cors: true },
  async (req) => {
    const uid = _requireAuth(req);
    const db  = _db();

    // ── Input validation ──────────────────────────────────────────────────────
    const points  = Math.floor(Number(req.data?.points ?? 0));
    const orderId = _san(req.data?.orderId, 128);

    if (!orderId) {
      throw new HttpsError("invalid-argument", "orderId is required.");
    }
    if (!Number.isInteger(points) || points <= 0) {
      throw new HttpsError("invalid-argument", "points must be a positive integer.");
    }

    const rules = await _getRules();

    if (points < rules.minRedemption) {
      throw new HttpsError(
        "invalid-argument",
        `Minimum redemption is ${rules.minRedemption} points.`
      );
    }
    if (points % 100 !== 0) {
      throw new HttpsError(
        "invalid-argument",
        "Points must be a multiple of 100."
      );
    }

    const discountAmount = Math.floor(points / 100) * rules.redemptionRate;

    // ── Idempotency key ───────────────────────────────────────────────────────
    const redemptionId = `${uid}_${orderId}_redeem`;
    const txRef        = db.collection("loyaltyTransactions").doc(redemptionId);
    const accRef       = db.collection("loyaltyAccounts").doc(uid);

    const result = await db.runTransaction(async (tx) => {
      const [txSnap, accSnap] = await Promise.all([
        tx.get(txRef),
        tx.get(accRef),
      ]);

      // Idempotent — return existing redemption details
      if (txSnap.exists) {
        const prev    = txSnap.data();
        const balance = accSnap.exists ? _safeInt(accSnap.data().balance) : 0;
        return {
          discountAmount:  prev.discountAmount,
          pointsRedeemed:  prev.points,
          redemptionId,
          newBalance:      balance,
        };
      }

      // Validate sufficient balance
      if (!accSnap.exists) {
        throw new HttpsError("failed-precondition", "Loyalty account not found.");
      }
      const accData        = accSnap.data();
      const currentBalance = _safeInt(accData.balance);

      if (currentBalance < points) {
        throw new HttpsError(
          "failed-precondition",
          `Insufficient balance. You have ${currentBalance} points but need ${points}.`
        );
      }

      const newBalance     = currentBalance - points;
      const totalRedeemed  = _safeInt(accData.totalRedeemed) + points;
      const { tier }       = _tierFor(newBalance);

      // Deduct balance
      tx.set(
        accRef,
        {
          balance:       newBalance,
          tier,
          totalRedeemed,
          lastUpdated:   FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // Create pending redemption record
      tx.set(txRef, {
        uid,
        type:           "redeem",
        status:         "pending",
        points,
        discountAmount,
        orderId,
        description:    `${points} points redeemed for KSh ${discountAmount} discount`,
        createdAt:      FieldValue.serverTimestamp(),
      });

      return { discountAmount, pointsRedeemed: points, redemptionId, newBalance };
    });

    return result;
  }
);

// ─── 4. confirmLoyaltyRedemption ─────────────────────────────────────────────
/**
 * Settles or cancels a pending redemption.
 * On cancellation the deducted points are refunded atomically.
 *
 * Input:
 *   { redemptionId: string, status: 'confirmed' | 'cancelled' }
 *
 * Response:
 *   { success: true }
 */
exports.confirmLoyaltyRedemption = onCall(
  { region: REGION, cors: true },
  async (req) => {
    const uid = _requireAuth(req);
    const db  = _db();

    const redemptionId = _san(req.data?.redemptionId, 200);
    const newStatus    = _san(req.data?.status, 32);

    if (!redemptionId) {
      throw new HttpsError("invalid-argument", "redemptionId is required.");
    }
    if (newStatus !== "confirmed" && newStatus !== "cancelled") {
      throw new HttpsError("invalid-argument", "status must be 'confirmed' or 'cancelled'.");
    }

    const txRef  = db.collection("loyaltyTransactions").doc(redemptionId);
    const accRef = db.collection("loyaltyAccounts").doc(uid);

    await db.runTransaction(async (tx) => {
      const txSnap = await tx.get(txRef);

      if (!txSnap.exists) {
        throw new HttpsError("not-found", "Redemption not found.");
      }

      const txData = txSnap.data();

      // Ownership check — the redemption must belong to the calling user
      if (txData.uid !== uid) {
        throw new HttpsError("permission-denied", "Access denied.");
      }

      if (txData.status !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          `Redemption is already ${txData.status}.`
        );
      }

      // Update redemption status
      tx.update(txRef, {
        status:      newStatus,
        settledAt:   FieldValue.serverTimestamp(),
      });

      // Refund on cancellation
      if (newStatus === "cancelled") {
        const accSnap        = await tx.get(accRef);
        const currentBalance = accSnap.exists ? _safeInt(accSnap.data().balance) : 0;
        const currentRedeem  = accSnap.exists ? _safeInt(accSnap.data().totalRedeemed) : 0;
        const refundPoints   = _safeInt(txData.points);
        const newBalance     = currentBalance + refundPoints;
        const { tier }       = _tierFor(newBalance);

        tx.set(
          accRef,
          {
            balance:       newBalance,
            tier,
            totalRedeemed: Math.max(0, currentRedeem - refundPoints),
            lastUpdated:   FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    });

    return { success: true };
  }
);

// ─── 5. getLoyaltyHistory ────────────────────────────────────────────────────
/**
 * Returns a paginated transaction log for the calling user.
 *
 * Index note: `where('uid','==',uid)` is a single-field query that uses the
 * automatic single-field index; `.orderBy('createdAt')` on a DIFFERENT field
 * would need a composite index, so ordering is done in-process after fetch.
 *
 * Input:
 *   { page?: number, limit?: number }  (limit max 50, default 20)
 *
 * Response:
 *   { transactions: [...], page, totalFetched, hasMore }
 */
exports.getLoyaltyHistory = onCall(
  { region: REGION, cors: true },
  async (req) => {
    const uid = _requireAuth(req);
    const db  = _db();

    const page  = Math.max(1, Math.floor(Number(req.data?.page  ?? 1)));
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.data?.limit ?? 20))));

    // Single-field query only — no composite index needed
    const snap = await db
      .collection("loyaltyTransactions")
      .where("uid", "==", uid)
      .limit(200) // fetch a window, sort in-process
      .get();

    // Sort descending by createdAt in-process
    const all = snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id:          d.id,
          type:        data.type        ?? null,
          points:      data.points      ?? 0,
          source:      data.source      ?? null,
          orderId:     data.orderId     ?? null,
          description: data.description ?? null,
          status:      data.status      ?? null,
          createdAt:   data.createdAt   ?? null,
        };
      })
      .sort((a, b) => {
        const aMs = a.createdAt?.toMillis?.() ?? 0;
        const bMs = b.createdAt?.toMillis?.() ?? 0;
        return bMs - aMs;
      });

    const offset = (page - 1) * limit;
    const slice  = all.slice(offset, offset + limit);

    return {
      transactions: slice,
      page,
      totalFetched: all.length,
      hasMore:      offset + limit < all.length,
    };
  }
);

// ─── 6. getLoyaltyTiers ──────────────────────────────────────────────────────
/**
 * Public endpoint — no authentication required.
 * Returns tier definitions and current earn/redeem configuration.
 *
 * Response:
 *   { tiers: [...], earnRate, redemptionRate, minRedemption }
 */
exports.getLoyaltyTiers = onCall(
  { region: REGION, cors: true },
  async (_req) => {
    const rules = await _getRules();

    return {
      tiers: TIERS.map((t) => ({
        name:       t.name,
        min:        t.min,
        max:        t.max,
        multiplier: t.multiplier,
        color:      t.color,
        icon:       t.icon,
      })),
      earnRate:       rules.earnRate,
      redemptionRate: rules.redemptionRate,
      minRedemption:  rules.minRedemption,
    };
  }
);

// ─── 7. adminAdjustPoints ────────────────────────────────────────────────────
/**
 * Admin manual credit or deduction.
 * Balance is floored at 0 (no negative balances).
 *
 * Input:
 *   { uid: string, points: number, reason: string }
 *   points can be negative (deduction).
 *
 * Response:
 *   { success: true, newBalance }
 */
exports.adminAdjustPoints = onCall(
  { region: REGION, cors: true },
  async (req) => {
    _requireAdmin(req);
    const db = _db();

    const targetUid = _san(req.data?.uid,    128);
    const points    = Math.floor(Number(req.data?.points ?? 0));
    const reason    = _san(req.data?.reason, 500);

    if (!targetUid) {
      throw new HttpsError("invalid-argument", "uid is required.");
    }
    if (!Number.isInteger(points) || points === 0) {
      throw new HttpsError("invalid-argument", "points must be a non-zero integer.");
    }
    if (Math.abs(points) > 100000) {
      throw new HttpsError("invalid-argument", "Adjustment cannot exceed ±100,000 points.");
    }
    if (!reason) {
      throw new HttpsError("invalid-argument", "reason is required.");
    }

    const accRef = db.collection("loyaltyAccounts").doc(targetUid);

    // Generate a collision-resistant transaction ID for manual adjustments
    const txId  = `${targetUid}_adj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const txRef = db.collection("loyaltyTransactions").doc(txId);

    const newBalance = await db.runTransaction(async (tx) => {
      const accSnap = await tx.get(accRef);

      const currentBalance = accSnap.exists ? _safeInt(accSnap.data().balance) : 0;
      const currentEarned  = accSnap.exists ? _safeInt(accSnap.data().totalEarned) : 0;

      // Floor at 0 — loyalty balances cannot go negative
      const adjusted = Math.max(0, currentBalance + points);
      const { tier } = _tierFor(adjusted);

      // If it's a positive adjustment, reflect in totalEarned
      const earnedDelta = points > 0 ? points : 0;

      tx.set(
        accRef,
        {
          uid:         targetUid,
          balance:     adjusted,
          tier,
          totalEarned: currentEarned + earnedDelta,
          lastUpdated: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(txRef, {
        uid:         targetUid,
        type:        "adjust",
        points,
        source:      "admin",
        description: reason,
        adjustedBy:  req.auth.uid, // admin uid — safe to log
        createdAt:   FieldValue.serverTimestamp(),
      });

      return adjusted;
    });

    // Structured audit log (no PII)
    console.log(JSON.stringify({
      severity:    "NOTICE",
      message:     "Admin loyalty adjustment",
      audit:       true,
      adminUid:    req.auth.uid,
      targetUid,
      points,
      newBalance,
    }));

    return { success: true, newBalance };
  }
);

// ─── 8. getLoyaltyLeaderboard ────────────────────────────────────────────────
/**
 * Public endpoint — no authentication required.
 * Returns top-10 earners, fully anonymised (no real names or UIDs exposed).
 *
 * Query: single-field orderBy on totalEarned — no composite index needed.
 *
 * Response:
 *   { leaderboard: [{ rank, displayName, tier, totalEarned }] }
 */
exports.getLoyaltyLeaderboard = onCall(
  { region: REGION, cors: true },
  async (_req) => {
    const db = _db();

    const snap = await db
      .collection("loyaltyAccounts")
      .orderBy("totalEarned", "desc")
      .limit(10)
      .get();

    const leaderboard = snap.docs.map((d, i) => {
      const data = d.data();
      return {
        rank:        i + 1,
        displayName: `Member #${i + 1}`, // UID and real name deliberately withheld
        tier:        data.tier        ?? "Bronze",
        totalEarned: _safeInt(data.totalEarned),
      };
    });

    return { leaderboard };
  }
);
