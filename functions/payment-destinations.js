'use strict';
/**
 * SOKONI — MERCHANT PAYMENT DESTINATIONS
 * functions/payment-destinations.js
 *
 * Where a merchant's customers actually pay: their own M-PESA Till or PayBill.
 * Direct-to-merchant. SOKONI never custodies the sale proceeds; its 5% is a
 * receivable recorded against the sale (see commission-collection.js).
 *
 * ── WHY THIS IS A SEPARATE, CF-OWNED COLLECTION ──────────────────────────────
 * The obvious homes were both unusable, and for reasons worth stating so nobody
 * "simplifies" this back:
 *
 *   shops/{uid}          `allow read: if true` — WORLD-READABLE, and its client
 *                        update rule is a hasOnly() allowlist of presentation
 *                        fields that (correctly) excludes payment config.
 *   shopSettings/{uid}   `allow write: if isAuthed() && uid == sellerUid` — the
 *                        SELLER CAN WRITE IT. A merchant could set
 *                        status:'VERIFIED' on any number they liked and have
 *                        STK push route live customer money to it, with no test
 *                        ever performed. That is the same forgeable-claim shape
 *                        as the open users.merchantId defect.
 *
 * So: `paymentDestinations/{sellerUid}`, `allow write: if false`. Every field is
 * written by these callables through the Admin SDK. THE MERCHANT CANNOT DECLARE
 * THEIR OWN DESTINATION VERIFIED. That is the entire security model; if a future
 * change lets a client write this document, the verification means nothing.
 *
 * ── ATOMIC SWAP ─────────────────────────────────────────────────────────────
 * Changing a destination must never cost a merchant the one they already have.
 * A pending change lives in `pending`, is tested there, and only replaces
 * `activeDestination` on a server-confirmed successful test. A failed test
 * marks the ATTEMPT failed and leaves the live destination exactly as it was.
 *
 * ── PRODUCTION GATE ─────────────────────────────────────────────────────────
 * Configuring and verifying a destination is NOT authorisation to collect
 * through it. The provider must confirm a multi-merchant arrangement first.
 * `productionAuthorized` is false until then, and resolveActiveDestination()
 * refuses to hand a PartyB to the live STK path while it is. The current live
 * checkout rail remains the IntaSend collector; nothing here migrates it.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const COLL   = 'paymentDestinations';

const STATUS = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  PENDING_TEST:   'PENDING_TEST',
  TESTING:        'TESTING',
  VERIFIED:       'VERIFIED',
  FAILED:         'FAILED',
};

const TYPES = ['TILL', 'PAYBILL'];

function _db()  { return admin.firestore(); }
function _ts()  { return admin.firestore.FieldValue.serverTimestamp(); }

/* ── Validation ───────────────────────────────────────────────────────────
   A Till/PayBill is 5–7 digits. Rejecting here rather than at Safaricom means
   a typo is a form error, not a failed STK push against a stranger's shortcode. */
function _validNumber(n) {
  return /^\d{5,7}$/.test(String(n || '').trim());
}

/* Canonical identity: auth.uid -> users/{uid}.activeShopId -> shops/{shopId}.
   The Till is CONFIGURATION HANGING OFF AN IDENTITY, never an identity itself:
   changing Till A to Till B updates one field on one merchant, and must never
   look like a second merchant. */
async function _resolveScope(uid) {
  const db = _db();
  const userSnap = await db.collection('users').doc(String(uid)).get();
  const activeShopId = userSnap.exists ? (userSnap.data().activeShopId || null) : null;
  if (!activeShopId) {
    throw new HttpsError('failed-precondition',
      'No active shop on this account. A payment destination belongs to an approved shop.');
  }
  const shopSnap = await db.collection('shops').doc(String(activeShopId)).get();
  if (!shopSnap.exists) {
    throw new HttpsError('failed-precondition', 'Active shop not found.');
  }
  const shop = shopSnap.data();
  /* The shop must belong to the caller. `ownerId` is what every server-side
     ownership check reads; `sellerUid` states the same fact. Both are written by
     the approval projection and neither is client-writable. */
  if (shop.ownerId !== String(uid) && shop.sellerUid !== String(uid)) {
    throw new HttpsError('permission-denied', 'This shop does not belong to you.');
  }
  return { sellerUid: String(uid), shopId: String(activeShopId), shopName: shop.name || null };
}

function _publicView(d) {
  if (!d) {
    return { status: STATUS.NOT_CONFIGURED, activeDestination: null, pending: null, history: [] };
  }
  return {
    status:            d.status || STATUS.NOT_CONFIGURED,
    activeDestination: d.activeDestination || null,
    pending:           d.pending || null,
    lastVerifiedAt:    d.lastVerifiedAt || null,
    lastFailureReason: d.lastFailureReason || null,
    productionAuthorized: d.productionAuthorized === true,
    history:           Array.isArray(d.history) ? d.history.slice(0, 10) : [],
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   getPaymentDestination — the merchant's own view
   ══════════════════════════════════════════════════════════════════════════ */
exports.getPaymentDestination = onCall(
  { region: REGION, timeoutSeconds: 15, cors: true },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const scope = await _resolveScope(req.auth.uid);
    const snap = await _db().collection(COLL).doc(scope.sellerUid).get();
    return { ...scope, ...(_publicView(snap.exists ? snap.data() : null)) };
  }
);

/* ══════════════════════════════════════════════════════════════════════════
   savePaymentDestination — stage a destination for testing. NEVER activates.
   ══════════════════════════════════════════════════════════════════════════ */
exports.savePaymentDestination = onCall(
  { region: REGION, timeoutSeconds: 20, cors: true },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const scope = await _resolveScope(req.auth.uid);

    const destinationType   = String(req.data?.destinationType || '').toUpperCase().trim();
    const destinationNumber = String(req.data?.destinationNumber || '').trim();
    const accountName       = String(req.data?.accountName || '').trim().slice(0, 120);

    if (!TYPES.includes(destinationType)) {
      throw new HttpsError('invalid-argument', 'destinationType must be TILL or PAYBILL.');
    }
    if (!_validNumber(destinationNumber)) {
      throw new HttpsError('invalid-argument', 'Enter a valid M-PESA Till or PayBill number (5–7 digits).');
    }
    if (!accountName) {
      throw new HttpsError('invalid-argument', 'Business / account name is required.');
    }

    const ref  = _db().collection(COLL).doc(scope.sellerUid);
    const snap = await ref.get();
    const cur  = snap.exists ? snap.data() : null;
    const active = cur && cur.activeDestination ? cur.activeDestination : null;

    /* Re-staging the destination that is already live is a no-op, not a
       re-verification. Otherwise a merchant could knock their own live
       destination back into PENDING_TEST by pressing Save twice. */
    if (active
        && active.destinationType === destinationType
        && active.destinationNumber === destinationNumber) {
      return { ok: true, unchanged: true, ..._publicView(cur) };
    }

    const pending = {
      provider: 'MPESA',
      destinationType,
      destinationNumber,
      accountName,
      status: STATUS.PENDING_TEST,
      stagedAt: new Date().toISOString(),
      stagedBy: scope.sellerUid,
    };

    await ref.set({
      sellerUid: scope.sellerUid,
      shopId:    scope.shopId,
      /* ATOMIC SWAP, half one: the live destination is NOT touched. A merchant
         who starts a change and abandons it keeps collecting exactly as before.
         Only a server-confirmed successful test moves activeDestination. */
      pending,
      /* Top-level status reflects the OVERALL configuration: still VERIFIED
         while a live destination stands, even mid-change. */
      status: active ? STATUS.VERIFIED : STATUS.PENDING_TEST,
      productionAuthorized: cur ? cur.productionAuthorized === true : false,
      updatedAt: _ts(),
      ...(snap.exists ? {} : { createdAt: _ts() }),
    }, { merge: true });

    const fresh = await ref.get();
    return { ok: true, ..._publicView(fresh.data()) };
  }
);

/* ══════════════════════════════════════════════════════════════════════════
   markDestinationTesting / confirmDestinationVerified / markDestinationFailed
   — internal transitions, called by the STK test flow and its callback.
     Exported for the callback handler, NOT as callables: only server code may
     move a destination toward VERIFIED.
   ══════════════════════════════════════════════════════════════════════════ */
async function markTesting(sellerUid, checkoutId) {
  /* NESTED, not dotted. set({merge:true}) with a key like 'pending.testCheckoutId'
     stores a field whose NAME contains a dot — it does not write into the `pending`
     map. confirmVerified reads d.pending.testCheckoutId, which was therefore always
     undefined, so every test would have failed with checkout_id_mismatch. The bug was
     invisible while this function had no callers.

     A merged nested map still preserves the other pending.* fields written by
     savePaymentDestination, which is why merge is kept. */
  await _db().collection(COLL).doc(String(sellerUid)).set({
    pending: {
      status: STATUS.TESTING,
      testCheckoutId: String(checkoutId),
      testStartedAt: _ts(),
    },
    updatedAt: _ts(),
  }, { merge: true });
}

/**
 * The ONLY path to VERIFIED, and the atomic swap.
 *
 * Called from the payment callback after a genuine successful result. Runs in
 * a transaction so the swap — promote pending, retire the old destination into
 * history, clear pending — is one indivisible step. A merchant can never be left
 * with two active destinations or none.
 */
async function confirmVerified(sellerUid, checkoutId) {
  const db  = _db();
  const ref = db.collection(COLL).doc(String(sellerUid));

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return { swapped: false, reason: 'no_destination_doc' };
    const d = snap.data();
    const pending = d.pending;

    if (!pending) return { swapped: false, reason: 'no_pending_destination' };
    /* The callback must be for the test we started. Without this a merchant
       could verify destination B using the receipt of a test against A. */
    if (String(pending.testCheckoutId || '') !== String(checkoutId)) {
      return { swapped: false, reason: 'checkout_id_mismatch' };
    }

    const now = new Date().toISOString();
    const promoted = {
      provider: 'MPESA',
      destinationType:   pending.destinationType,
      destinationNumber: pending.destinationNumber,
      accountName:       pending.accountName,
      status:            STATUS.VERIFIED,
      verifiedAt:        now,
      verifiedByCheckoutId: String(checkoutId),
    };

    /* The retired destination is preserved, newest first and capped. Financial
       configuration history is audit evidence: "which number were we paying on
       the 3rd?" must be answerable. */
    const prior = d.activeDestination
      ? [{ ...d.activeDestination, retiredAt: now }, ...(Array.isArray(d.history) ? d.history : [])]
      : (Array.isArray(d.history) ? d.history : []);

    txn.set(ref, {
      activeDestination: promoted,
      history: prior.slice(0, 20),
      pending: admin.firestore.FieldValue.delete(),
      status: STATUS.VERIFIED,
      lastVerifiedAt: _ts(),
      lastFailureReason: null,
      updatedAt: _ts(),
    }, { merge: true });

    return { swapped: true, destination: promoted };
  });
}

/**
 * A failed test marks the ATTEMPT failed and nothing else. The live destination
 * — if there is one — keeps working. This is the other half of "a merchant must
 * never lose their collection destination merely because they tried to change
 * it".
 */
async function markFailed(sellerUid, reason) {
  const db  = _db();
  const ref = db.collection(COLL).doc(String(sellerUid));
  const snap = await ref.get();
  if (!snap.exists) return;
  const d = snap.data();
  const hasActive = !!d.activeDestination;

  await ref.set({
    'pending.status': STATUS.FAILED,
    'pending.failedAt': _ts(),
    lastFailureReason: String(reason || 'Test payment was not completed.').slice(0, 300),
    /* Overall status stays VERIFIED when a live destination stands. Reporting
       the whole configuration as FAILED because a CHANGE failed would be false,
       and would make a working merchant look broken. */
    status: hasActive ? STATUS.VERIFIED : STATUS.FAILED,
    updatedAt: _ts(),
  }, { merge: true });
}

/**
 * What the STK initiator must use as the destination shortcode — and the production gate.
 *
 * Returns null (never a fallback, never a platform default) when there is no
 * verified destination. A caller that receives null must refuse the payment: the
 * alternative is routing a customer's money to a number nobody verified, or to
 * SOKONI's own shortcode, either of which is a mis-collection.
 */
async function resolveActiveDestination(sellerUid) {
  const snap = await _db().collection(COLL).doc(String(sellerUid)).get();
  if (!snap.exists) return null;
  const d = snap.data();
  if (!d.activeDestination || d.activeDestination.status !== STATUS.VERIFIED) return null;
  if (d.productionAuthorized !== true) {
    /* Configured and verified, but Safaricom has not authorised multi-merchant
       collection for this platform. Returning the destination here would put
       live customer money through an unauthorised arrangement. */
    return { blocked: 'production_not_authorized', destination: d.activeDestination };
  }
  return { blocked: null, destination: d.activeDestination };
}

/* ══════════════════════════════════════════════════════════════════════════
   startPaymentDestinationTest — begin the ONE verification a destination gets.

   Mints a payment intent through the same registry every other purpose uses, so the
   amount is a server constant and the seller is resolved from users/{uid}.activeShopId
   with an ownership check. The caller sends NOTHING that affects either.

   The returned ref is what the merchant's device pushes against, and it is also the
   `checkoutId` markTesting records — so the webhook's confirmation can only promote
   the destination this test was started for. A merchant cannot verify destination B
   with the receipt of a test against A.
   ══════════════════════════════════════════════════════════════════════════ */
exports.startPaymentDestinationTest = onCall(
  { region: 'us-central1', enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = String(request.auth.uid);

    /* Resolved server-side, with the shop-ownership check. */
    const scope = await _resolveScope(uid);

    const snap = await _db().collection(COLL).doc(scope.sellerUid).get();
    const d = snap.exists ? (snap.data() || {}) : {};
    if (!d.pending) {
      throw new HttpsError('failed-precondition', 'There is no pending destination to verify.');
    }

    const { createPaymentIntent } = require('./payment-intents');
    const res = await createPaymentIntent.run({
      data: { purpose: 'destination_verification' },
      auth: request.auth,
      rawRequest: request.rawRequest || { headers: {} },
    });
    if (!res || !res.ref) throw new HttpsError('internal', 'Could not start the verification.');

    /* Bind the test to this ref BEFORE the merchant pays, so a confirmation that
       arrives for any other ref cannot promote this destination. */
    await markTesting(scope.sellerUid, res.ref);

    return { ref: res.ref, amount: res.amount, currency: res.currency || 'KES' };
  }
);

module.exports = {
  getPaymentDestination:       exports.getPaymentDestination,
  savePaymentDestination:      exports.savePaymentDestination,
  startPaymentDestinationTest: exports.startPaymentDestinationTest,
  markTesting,
  confirmVerified,
  markFailed,
  resolveActiveDestination,
  STATUS,
  TYPES,
  _resolveScope,
};
