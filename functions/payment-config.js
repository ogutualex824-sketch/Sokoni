/* ================================================================
   SOKONI — Payment Configuration (centralized, backend-owned)
   functions/payment-config.js

   Single backend source for platform payment-collection identifiers
   (commission Paybill/Till, etc.) that were previously hardcoded across
   client HTML (legal-hub, provider, subscriptions, services, seller-revenue).

   SECURITY / EXPOSURE:
     • The SETTLEMENT bank account NUMBER stays in Secret Manager
       (settlement-account.js) and is NEVER exposed here.
     • Public collection Paybills (e.g. commission M-Pesa Paybill) are
       operational-public (customers must see them to pay) but must be
       CENTRALLY managed, not scattered as client literals. They live in the
       Firestore config doc settlementConfig/paymentAccounts and are served to
       the client via getCheckoutPaymentConfig() — which returns ONLY the
       fields checkout needs, nothing administrative.

   Defaults preserve current production values so centralizing changes nothing.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');

const REGION = 'us-central1';
const CONFIG_PATH = 'settlementConfig/paymentAccounts';

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }
function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/* Current production defaults (previously hardcoded client-side). Centralizing
   here preserves behaviour; admins can update without a client redeploy. */
function _defaults() {
  return {
    /* Legacy commission-collection Paybill (deferred-invoice flow). Being
       superseded by the Merchant-of-Record model — kept until that migration
       completes (see docs/SETTLEMENT_MIGRATION_PHASE2.md). */
    commissionPaybill: '522522',
    commissionAccountFormat: 'SOK-{REF}',   // account/reference pattern shown at checkout
    currency: 'KES',
    /* Merchant-of-Record collection account is intentionally NOT here — its
       number is Secret-Manager-only (settlement-account.js) and never client-exposed. */
  };
}

async function _load(db) {
  try {
    const snap = await db.doc(CONFIG_PATH).get();
    return snap.exists ? { ..._defaults(), ...(snap.data() || {}) } : _defaults();
  } catch (_) {
    return _defaults();
  }
}

/* Only the fields a checkout page legitimately needs. No admin/settlement data. */
function _publicView(cfg) {
  return {
    commissionPaybill: cfg.commissionPaybill,
    commissionAccountFormat: cfg.commissionAccountFormat,
    currency: cfg.currency,
  };
}

/* PUBLIC callable — checkout pages fetch collection info here instead of
   hardcoding it. Returns only checkout-necessary fields. */
exports._h = exports._h || {};   // handler registry consumed by settlementDispatch
exports.getCheckoutPaymentConfig = onCall(
  { region: REGION, enforceAppCheck: true },
  exports._h.getCheckoutPaymentConfig = async () => {
    const cfg = await _load(_db());
    return _publicView(cfg);
  },
);

/* Admin — read full config. */
exports.adminGetPaymentConfig = onCall(
  { region: REGION, enforceAppCheck: true },
  exports._h.adminGetPaymentConfig = async (req) => {
    _assertAdmin(req);
    return { config: await _load(_db()), configPath: CONFIG_PATH };
  },
);

/* Admin — update collection identifiers (audited, never destructive). */
exports.adminSetPaymentConfig = onCall(
  { region: REGION, enforceAppCheck: true },
  exports._h.adminSetPaymentConfig = async (req) => {
    _assertAdmin(req);
    const { commissionPaybill, commissionAccountFormat, currency } = req.data || {};
    const update = { updatedAt: _now(), updatedBy: req.auth.uid };
    if (commissionPaybill != null) {
      if (!/^\d{5,7}$/.test(String(commissionPaybill)))
        throw new HttpsError('invalid-argument', 'commissionPaybill must be a 5–7 digit shortcode');
      update.commissionPaybill = String(commissionPaybill);
    }
    if (commissionAccountFormat != null) update.commissionAccountFormat = String(commissionAccountFormat).slice(0, 40);
    if (currency != null) update.currency = String(currency).slice(0, 4).toUpperCase();

    await _db().doc(CONFIG_PATH).set(update, { merge: true });
    await _db().collection('settlementConfigAudit').add({
      action: 'payment_config_update', fields: Object.keys(update), by: req.auth.uid, at: _now(),
    });
    return { ok: true };
  },
);

module.exports._defaults   = _defaults;
module.exports._publicView = _publicView;
