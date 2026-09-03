'use strict';
/* ============================================================
   SOKONI Till / QR payment layer — Cloud Functions (Q5)

   I/O ONLY. Every decision — token validity, Till payability, intent
   resolution state, till-sale pricing — is delegated to the pure core in
   ./sokoni-qr-authority.js, which is what scripts/test-sokoni-qr-payment.js
   certifies directly. This file reads Firestore, calls that core to decide,
   and writes the result.

   Reuses pos-qr.js's exact signing mechanism (crypto HMAC + timingSafeEqual,
   same QR_SIGNING_SECRET) — not its posPayments schema or completion path
   (docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md, D3). Financial intents are minted
   ONLY through the existing, unmodified createPaymentIntent callable via the
   payment-purposes.js registry's `pos_till_sale` entry — this file never
   writes paymentIntents/{ref} or payments/{ref} itself, never touches
   webhookIntasend, initiateSTKPush, commission or settlement logic.

   Status: BUILT, not yet on R1, not deployed. See
   docs/SOKONI_TILL_QR_IMPLEMENTATION.md for the full record, including what
   is deliberately deferred (the buyer-facing payment page/route — belongs
   with the webhook read-path fix named as D1, so a POS-till payment gets a
   real paid-state signal rather than inheriting the D1 gap).
============================================================ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

const QA = require('./sokoni-qr-authority');

const QR_SIGNING_SECRET = defineSecret('QR_SIGNING_SECRET');

const REGION = 'us-central1';
const OPT    = { region: REGION, enforceAppCheck: true, memory: '256MiB', secrets: [QR_SIGNING_SECRET] };
const OPT128 = { region: REGION, enforceAppCheck: true, memory: '128MiB', secrets: [QR_SIGNING_SECRET] };

const db  = () => admin.firestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();
const _san = (s, max = 120) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);

const _isAuthed = (auth) => !!(auth && auth.uid);
const _isSeller = (auth) => auth && (
  auth.token?.isSeller === true ||
  auth.token?.roles?.includes('seller') ||
  auth.token?.seller === true
);
const _isAdmin = (auth) => auth && (
  auth.token?.admin === true ||
  auth.token?.superAdmin === true
);

/** A plain, framework-independent error — so mintSokoniTillCore can be
    called from a non-onCall context (a Firestore trigger) without pulling
    in HttpsError semantics there. */
function _err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Raise a plain-core `_err`-shaped Error as the matching HttpsError. */
function _raise(e) {
  if (e instanceof HttpsError) throw e;
  throw new HttpsError(e.code || 'internal', e.message || 'Request failed.');
}

const QR_BASE = 'https://mysokoni.co.ke/pay/q/';

/* ═══════════════════════════════════════════════════════════
   mintSokoniTillCore — the identity-allocation transaction itself,
   extracted so it has exactly ONE implementation reachable from two
   places: this file's own onCall (self-service, below) and the merchant
   approval pipeline (functions/application-lifecycle.js's applyDecision,
   "Till Approval Automation" — a seller is never left to find a settings
   page and press Generate). No auth/ownership decision lives here — that
   is each caller's own job; this function only knows how to allocate an
   identity, transactionally, exactly once per (shopId, branchId).

   onExisting controls what happens when an ACTIVE Till already exists for
   this (shopId, branchId):
     'throw'  (default, matches the original onCall behaviour byte-for-byte)
              — a seller who double-taps "Generate" sees an explicit error.
     'return' — the EXISTING Till is returned, created:false, no write at
              all. This is what makes "approving/reprocessing the same
              merchant returns the existing Till rather than minting a
              second one" true — required for a Firestore trigger
              (applicationLifecycle) that can legitimately re-fire for the
              same approval.
   `source` is purely an audit field on the Till document (never read for
   any authorization decision) — 'self_service' vs 'application_approval'.
════════════════════════════════════════════════════════════ */
async function mintSokoniTillCore({ shopId, branchId, actorUid, onExisting = 'throw', source = 'self_service' }) {
  shopId = String(shopId || '').trim();
  if (!shopId) throw _err('invalid-argument', 'shopId is required.');
  branchId = _san(branchId || `${shopId}-main`, 80);
  if (!branchId) throw _err('invalid-argument', 'Invalid branchId.');
  if (!['throw', 'return'].includes(onExisting)) onExisting = 'throw';

  const shopSnap = await db().collection('shops').doc(shopId).get();
  if (!shopSnap.exists) throw _err('not-found', 'Shop not found.');
  const shop = shopSnap.data() || {};

  const tillsCol = db().collection('sokoniTills');
  const counterRef = db().collection('shopTillCounters').doc(shopId);

  let minted;
  try {
    minted = await db().runTransaction(async (tx) => {
      const activeQ = await tx.get(
        tillsCol.where('shopId', '==', shopId).where('branchId', '==', branchId).where('status', '==', 'ACTIVE')
      );
      const decision = QA.decideTillAllocation({ hasActiveTill: !activeQ.empty, onExisting });

      if (decision.action === 'return_existing') {
        const existing = activeQ.docs[0].data();
        return {
          sokoniTillId: existing.sokoniTillId, shopId: existing.shopId, branchId: existing.branchId,
          created: false,
        };
      }
      if (decision.action === 'throw_conflict') {
        throw _err('already-exists', 'This branch already has an active Till.');
      }

      const counterSnap = await tx.get(counterRef);
      const counterData = counterSnap.exists ? (counterSnap.data() || {}) : {};
      const shopCode = counterData.shopCode || QA.deriveShopCode(shop.storeName || shop.name, shopId);
      const seq = (Number(counterData.seq) || 0) + 1;
      const sokoniTillId = QA.formatTillId(shopCode, seq);
      const tillRef = tillsCol.doc(sokoniTillId);

      const tillDoc = {
        sokoniTillId, shopId, branchId,
        merchantUid: shopId,
        status: 'ACTIVE',
        currency: 'KES',
        qrVersion: 1,
        intasendCollectionAccount: null,
        createdAt: now(),
        createdBy: actorUid || shopId,
        source,
        sequenceNumber: seq,
        statusHistory: [{ status: 'ACTIVE', at: Date.now(), by: actorUid || shopId }],
      };

      tx.set(counterRef, { shopCode, seq }, { merge: true });
      tx.create(tillRef, tillDoc);

      return { sokoniTillId, shopId, branchId, created: true };
    });
  } catch (e) {
    if (e.code === 6 || /ALREADY_EXISTS/i.test(e.message || '')) {
      throw _err('already-exists', 'This Till id is already in use — please retry.');
    }
    throw e;
  }

  const secret = QR_SIGNING_SECRET.value();
  const token = QA.mintToken('till', minted.sokoniTillId, secret);

  logger.info('[sokoniTill] issued', {
    sokoniTillId: minted.sokoniTillId, shopId, branchId, created: minted.created, source,
  });

  return {
    sokoniTillId: minted.sokoniTillId,
    shopId, branchId,
    status: 'ACTIVE',
    currency: 'KES',
    token,
    qrUrl: QR_BASE + token,
    created: minted.created,
  };
}

/* ═══════════════════════════════════════════════════════════
   mintSokoniTill — issue a permanent Till identity (Q2/Q4).
   Immutable identity + status lifecycle; at most one ACTIVE Till per
   (shopId, branchId), enforced transactionally. Thin onCall wrapper
   around mintSokoniTillCore — auth/ownership only, byte-identical
   behaviour to before the refactor (onExisting defaults to 'throw').
════════════════════════════════════════════════════════════ */
exports.mintSokoniTill = onCall(OPT, async (request) => {
  const auth = request.auth;
  if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!_isSeller(auth) && !_isAdmin(auth)) throw new HttpsError('permission-denied', 'Seller account required.');

  const data = request.data || {};
  const shopId = String(data.shopId || auth.uid).trim();
  if (!_isAdmin(auth) && shopId !== auth.uid) {
    throw new HttpsError('permission-denied', 'You may only issue a Till for your own shop.');
  }

  try {
    return await mintSokoniTillCore({ shopId, branchId: data.branchId, actorUid: auth.uid });
  } catch (e) { _raise(e); }
});

/* ═══════════════════════════════════════════════════════════
   setSokoniTillStatus — status-only lifecycle transition (Q2 Q7).
   Never mutates identity fields; append-only statusHistory.
════════════════════════════════════════════════════════════ */
exports.setSokoniTillStatus = onCall(OPT128, async (request) => {
  const auth = request.auth;
  if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Sign in required.');

  const data = request.data || {};
  const sokoniTillId = String(data.sokoniTillId || '').trim();
  const status = String(data.status || '').trim();
  if (!sokoniTillId) throw new HttpsError('invalid-argument', 'sokoniTillId is required.');
  if (!['ACTIVE', 'DISABLED', 'RETIRED'].includes(status)) {
    throw new HttpsError('invalid-argument', 'status must be ACTIVE, DISABLED or RETIRED.');
  }

  const tillRef = db().collection('sokoniTills').doc(sokoniTillId);

  try {
    await db().runTransaction(async (tx) => {
      const tSnap = await tx.get(tillRef);
      if (!tSnap.exists) { const e = new Error('Till not found.'); e.code = 'not-found'; throw e; }
      const till = tSnap.data();

      if (!_isAdmin(auth) && String(auth.uid) !== String(till.merchantUid)) {
        const e = new Error('Not authorized for this Till.'); e.code = 'permission-denied'; throw e;
      }
      if (till.status === status) return; /* no-op, not an error */

      if (status === 'ACTIVE') {
        const activeQ = await tx.get(
          db().collection('sokoniTills')
            .where('shopId', '==', till.shopId)
            .where('branchId', '==', till.branchId)
            .where('status', '==', 'ACTIVE')
        );
        if (!activeQ.empty) {
          const e = new Error('This branch already has a different active Till.');
          e.code = 'already-exists';
          throw e;
        }
      }

      tx.update(tillRef, {
        status,
        statusHistory: admin.firestore.FieldValue.arrayUnion({ status, at: Date.now(), by: auth.uid }),
      });
    });
  } catch (e) { _raise(e); }

  logger.info('[sokoniTill] status change', { sokoniTillId, status, by: auth.uid });
  return { sokoniTillId, status };
});

/* ═══════════════════════════════════════════════════════════
   mintDynamicSokoniQR — mint a signed reference to an ALREADY-CREATED
   paymentIntents/{ref} (Q4, "intent minted before the QR exists"). Never
   creates a financial object itself.
════════════════════════════════════════════════════════════ */
exports.mintDynamicSokoniQR = onCall(OPT128, async (request) => {
  const auth = request.auth;
  if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Sign in required.');

  const ref = String((request.data || {}).ref || '').trim();
  if (!ref || !/^[A-Za-z0-9_-]{3,128}$/.test(ref)) {
    throw new HttpsError('invalid-argument', 'A valid payment reference is required.');
  }

  const iSnap = await db().collection('paymentIntents').doc(ref).get();
  if (!iSnap.exists) throw new HttpsError('not-found', 'Payment reference not found.');
  const intent = iSnap.data() || {};

  if (intent.purpose !== 'pos_till_sale') {
    throw new HttpsError('failed-precondition', 'Not a Till sale intent.');
  }
  const meta = intent.metadata || {};
  if (!_isAdmin(auth) && String(auth.uid) !== String(meta.merchantUid)) {
    throw new HttpsError('permission-denied', 'Not authorized for this sale.');
  }

  const expiresAtMs = intent.expiresAt?.toMillis ? intent.expiresAt.toMillis() : null;
  const decision = QA.classifyIntentResolution(
    { purpose: intent.purpose, status: intent.status, expiresAtMs }, Date.now()
  );
  if (!decision.ok) throw new HttpsError(decision.code, decision.reason);

  const secret = QR_SIGNING_SECRET.value();
  const token = QA.mintToken('intent', ref, secret);

  logger.info('[sokoniTill] dynamic QR minted', { ref, sokoniTillId: meta.sokoniTillId });

  return {
    ref, token, qrUrl: QR_BASE + token,
    amount: intent.amount, currency: intent.currency || 'KES',
    expiresAt: expiresAtMs,
  };
});

/* ═══════════════════════════════════════════════════════════
   resolveSokoniQR — the ONE server-side entry point a scanned QR reaches.
   Verifies the signed token, resolves what it points to, returns ONLY
   display-safe fields — never a trusted amount for the dynamic case beyond
   what the already-minted intent carries, never an amount at all for the
   permanent case (docs/SOKONI_TILL_QR_CONTRACT.md, Q4 Q7).
════════════════════════════════════════════════════════════ */
exports.resolveSokoniQR = onCall(OPT128, async (request) => {
  const auth = request.auth;
  if (!_isAuthed(auth)) throw new HttpsError('unauthenticated', 'Sign in required.');

  const token = String((request.data || {}).token || '').trim();
  const parsed = QA.verifyToken(token, QR_SIGNING_SECRET.value());
  if (!parsed) throw new HttpsError('invalid-argument', 'Invalid or forged payment reference.');

  if (parsed.type === 'till') {
    const tSnap = await db().collection('sokoniTills').doc(parsed.id).get();
    const till = tSnap.exists ? tSnap.data() : null;
    const decision = QA.checkTillPayable(till);
    if (!decision.ok) throw new HttpsError(decision.code, decision.reason);

    let shopName = 'SOKONI Merchant';
    try {
      const shopSnap = await db().collection('shops').doc(till.shopId).get();
      if (shopSnap.exists) {
        const s = shopSnap.data() || {};
        shopName = _san(s.storeName || s.name || shopName, 80) || shopName;
      }
    } catch (_) { /* display convenience only — never blocks resolution */ }

    return { type: 'till', sokoniTillId: till.sokoniTillId, shopName, currency: till.currency || 'KES' };
  }

  /* type === 'intent' */
  const iSnap = await db().collection('paymentIntents').doc(parsed.id).get();
  const intent = iSnap.exists ? (iSnap.data() || {}) : null;
  const expiresAtMs = intent && intent.expiresAt?.toMillis ? intent.expiresAt.toMillis() : null;
  const decision = QA.classifyIntentResolution(
    intent ? { purpose: intent.purpose, status: intent.status, expiresAtMs } : null, Date.now()
  );
  if (!decision.ok) throw new HttpsError(decision.code, decision.reason);

  const meta = intent.metadata || {};
  let shopName = 'SOKONI Merchant';
  try {
    const shopSnap = await db().collection('shops').doc(meta.shopId).get();
    if (shopSnap.exists) {
      const s = shopSnap.data() || {};
      shopName = _san(s.storeName || s.name || shopName, 80) || shopName;
    }
  } catch (_) { /* display convenience only */ }

  return {
    type: 'intent', ref: parsed.id,
    amount: intent.amount, currency: intent.currency || 'KES',
    shopName, expiresAt: expiresAtMs,
    /* Q8: 'created' (payable) or 'paid' (already done — the buyer's payment
       page polls this same callable for status, since it cannot read
       paymentIntents/{ref} directly: the cashier who created the dynamic
       intent owns it, not the buyer). decision.status is only present on an
       {ok:true} result — see classifyIntentResolution. */
    status: decision.status || 'created',
  };
});

/* Server-side entry point for other Cloud Functions (Till Approval
   Automation, functions/application-lifecycle.js) — never for client
   requests. Follows this codebase's own `_internal` convention (see
   functions/subscription-authority.js's materialiseEntitlements, called the
   same way from webhookIntasend). */
exports._internal = { mintSokoniTillCore };
