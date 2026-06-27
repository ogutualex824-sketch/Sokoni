/**
 * SOKONI Referral Tracking CF v1.0
 * Trigger: when an order transitions to status "completed" or "delivered",
 *          credit KES 100 wallet bonus to the referrer (first-order-only).
 *
 * Firestore layout expected:
 *   users/{uid}.referredBy        — uid of the user who referred them
 *   users/{uid}.firstOrderDone    — bool; set true here to prevent double-credit
 *   wallets/{uid}.balance         — KES balance (number)
 *   wallets/{uid}.transactions[]  — ledger entries
 *
 * The trigger is wired in index.js as onDocumentUpdated("orders/{orderId}").
 */

"use strict";

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

const REFERRAL_BONUS_KES = 100;
const COMPLETED_STATUSES  = new Set(["completed", "delivered"]);

exports.processReferralOnOrderComplete = onDocumentUpdated(
  { document: "orders/{orderId}", region: "us-central1" },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    // Only fire when status transitions INTO a completed state
    if (COMPLETED_STATUSES.has(before.status)) return null;
    if (!COMPLETED_STATUSES.has(after.status))  return null;

    const buyerUid = after.buyerUid;
    if (!buyerUid) return null;

    const db = admin.firestore();

    // Check buyer user doc for referredBy and firstOrderDone
    const userRef = db.collection("users").doc(buyerUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return null;

    const userData = userDoc.data();
    if (userData.firstReferralOrderDone) return null; // already credited
    if (!userData.referredBy) return null;

    const referrerUid = userData.referredBy;
    if (referrerUid === buyerUid) return null; // no self-referral

    // Verify referrer exists
    const referrerRef = db.collection("users").doc(referrerUid);
    const referrerDoc = await referrerRef.get();
    if (!referrerDoc.exists) return null;

    const walletRef = db.collection("wallets").doc(referrerUid);

    // Atomic transaction: mark buyer + credit referrer wallet
    await db.runTransaction(async (tx) => {
      const walletDoc = await tx.get(walletRef);

      const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
      const newBalance     = currentBalance + REFERRAL_BONUS_KES;

      const txEntry = {
        id:          "ref_" + event.params.orderId,
        type:        "referral_reward",
        amount:      REFERRAL_BONUS_KES,
        currency:    "KES",
        description: `Referral bonus — ${userData.displayName || userData.name || "a friend"} completed their first order`,
        orderId:     event.params.orderId,
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
        status:      "completed",
      };

      if (walletDoc.exists) {
        tx.update(walletRef, {
          balance:      newBalance,
          transactions: admin.firestore.FieldValue.arrayUnion(txEntry),
          updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        tx.set(walletRef, {
          uid:          referrerUid,
          balance:      newBalance,
          currency:     "KES",
          transactions: [txEntry],
          createdAt:    admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Mark buyer so we don't double-credit
      tx.update(userRef, { firstReferralOrderDone: true });

      // Log referral event for analytics
      const refLogRef = db.collection("referralEvents").doc();
      tx.set(refLogRef, {
        referrerUid,
        buyerUid,
        orderId:   event.params.orderId,
        bonusKes:  REFERRAL_BONUS_KES,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    console.log(`[Referral] Credited KES ${REFERRAL_BONUS_KES} to ${referrerUid} for referring ${buyerUid}`);
    return null;
  }
);
