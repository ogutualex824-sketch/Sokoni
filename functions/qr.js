/**
 * functions/qr.js — SOKONI QR Code Cloud Functions v1.0
 * Gen2 Callable Cloud Functions for secure QR token lifecycle.
 *
 * Exports:
 *   generateSecureQR  — creates HMAC-signed, time-limited QR tokens
 *   verifyQRCode      — validates and optionally one-time-uses a token
 *   getMyQRAssets     — returns seller handle, shop URL, card URL, products
 */

'use strict';

const { onCall }    = require('firebase-functions/v2/https');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const crypto        = require('crypto');

const QR_SECRET = defineSecret('QR_SIGNING_SECRET');

// ── Helpers ──────────────────────────────────────────────────────────────────

function _requireAuth(ctx) {
  if (!ctx.auth) {
    throw Object.assign(new Error('UNAUTHENTICATED: Sign in required.'), { code: 'unauthenticated' });
  }
}

function _hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function _tokenId() {
  return crypto.randomBytes(18).toString('base64url');
}

// ── CF 1: generateSecureQR ───────────────────────────────────────────────────
/**
 * Creates a signed, time-limited QR token for payments, event tickets, etc.
 * Input:  { type: string, id: string, expiresInMinutes?: number, oneTime?: boolean }
 * Output: { tokenId, qrUrl, expiresAt }
 */
exports.generateSecureQR = onCall(
  { cors: true, secrets: [QR_SECRET] },
  async (request) => {
    _requireAuth(request);

    const { type, id, expiresInMinutes = 60, oneTime = false } = request.data || {};

    if (!type || typeof type !== 'string') throw new Error('INVALID_ARGUMENT: type required.');
    if (!id   || typeof id   !== 'string') throw new Error('INVALID_ARGUMENT: id required.');
    if (type.length > 40 || id.length > 200) throw new Error('INVALID_ARGUMENT: fields too long.');

    const uid     = request.auth.uid;
    const exp     = Date.now() + expiresInMinutes * 60 * 1000;
    const sigData = `${type}:${id}:${uid}:${exp}`;
    const sig     = _hmac(sigData, QR_SECRET.value());
    const tokenId = _tokenId();

    const db  = getFirestore();
    const ref = db.collection('qrTokens').doc(tokenId);

    await ref.set({
      tokenId,
      type,
      id,
      uid,
      exp,
      sig,
      oneTime:    !!oneTime,
      used:       false,
      createdAt:  Timestamp.now(),
      expiresAt:  Timestamp.fromMillis(exp),
    });

    const qrUrl = `https://mysokoni.co.ke/verify?qr=${tokenId}`;

    return { tokenId, qrUrl, expiresAt: new Date(exp).toISOString() };
  }
);

// ── CF 2: verifyQRCode ───────────────────────────────────────────────────────
/**
 * Verifies a QR token. No auth required (e.g. kiosk scanner).
 * For one-time tokens, marks as used atomically.
 * Input:  { tokenId: string }
 * Output: { valid: boolean, type, id, uid, message }
 */
exports.verifyQRCode = onCall(
  { cors: true },
  async (request) => {
    const { tokenId } = request.data || {};

    if (!tokenId || typeof tokenId !== 'string' || tokenId.length > 100) {
      return { valid: false, message: 'Invalid token format.' };
    }

    const db  = getFirestore();
    const ref = db.collection('qrTokens').doc(tokenId);

    try {
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);

        if (!snap.exists) {
          return { valid: false, message: 'QR code not found.' };
        }

        const data = snap.data();

        // Expiry check
        if (Date.now() > data.exp) {
          return { valid: false, message: 'QR code has expired.' };
        }

        // One-time use check
        if (data.oneTime && data.used) {
          return { valid: false, message: 'QR code has already been used.' };
        }

        // Mark as used for one-time tokens
        if (data.oneTime) {
          tx.update(ref, { used: true, usedAt: Timestamp.now() });
        }

        return {
          valid:   true,
          type:    data.type,
          id:      data.id,
          uid:     data.uid,
          oneTime: data.oneTime,
          message: 'Valid',
        };
      });

      return result;
    } catch (err) {
      console.error('[verifyQRCode] Error:', err.message);
      return { valid: false, message: 'Verification failed. Please try again.' };
    }
  }
);

// ── CF 3: getMyQRAssets ──────────────────────────────────────────────────────
/**
 * Returns the seller's handle, URLs, and products needed to render QR Center.
 * Input:  {}
 * Output: { handle, shopUrl, cardUrl, products: [{id, name}] }
 */
exports.getMyQRAssets = onCall(
  { cors: true },
  async (request) => {
    _requireAuth(request);

    const uid = request.auth.uid;
    const db  = getFirestore();

    // Resolve handle: try shops/{uid} then minishopConfig/{uid}
    let handle = uid; // fallback
    try {
      const shopSnap = await db.collection('shops').doc(uid).get();
      if (shopSnap.exists) {
        handle = shopSnap.data().handle || shopSnap.data().shopId || uid;
      } else {
        const miniSnap = await db.collection('minishopConfig').doc(uid).get();
        if (miniSnap.exists) {
          handle = miniSnap.data().handle || uid;
        }
      }
    } catch (e) {
      console.warn('[getMyQRAssets] Handle lookup failed:', e.message);
    }

    // Fetch seller products (limit 30)
    let products = [];
    try {
      const prodSnap = await db.collection('products')
        .where('shopId', '==', uid)
        .where('status', '==', 'active')
        .limit(30)
        .get();
      products = prodSnap.docs.map(function(d) {
        return { id: d.id, name: d.data().name || d.id };
      });
    } catch (e) {
      console.warn('[getMyQRAssets] Products lookup failed:', e.message);
    }

    const base    = 'https://mysokoni.co.ke';
    const shopUrl = `${base}/shop/${handle}`;
    const cardUrl = `${base}/card/${handle}`;

    return { handle, shopUrl, cardUrl, products };
  }
);
