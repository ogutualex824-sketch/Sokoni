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
/* ── COLLECTION ROUTE ──────────────────────────────────────────────────────
   Where a customer's M-Pesa payment actually LANDS. This existed only as an
   assumption, and the two halves of the platform disagreed about it:

     settlement-engine.js:7,173 books every sale as
       "100% of every customer payment is collected into the Bravilex account first"
     darajaSTKPush (index.js:3089-3130) sends
       BusinessShortCode / PartyB = shopSettings/{sellerUid}.darajaShortCode
       i.e. straight to the SELLER's own shortcode.

   So the seller receives 100% while the ledger records a platform commission
   that was never collected — commission booked as revenue, settlement
   liabilities with no cash behind them, and reconciliation that cannot tie out
   against M-Pesa. Making the route EXPLICIT is what lets the ledger tell the
   truth about each payment instead of assuming one model.

   DIRECT_TO_SELLER — today's live behaviour. Funds land in the seller's own
     shortcode. Platform commission is NOT collected at the point of sale; it is
     a receivable. This remains the DEFAULT so that shipping this file changes
     no money movement whatsoever.

   CENTRAL_MOR — Merchant-of-Record. Funds land in the platform collection
     shortcode, the settlement engine deducts commission and pays the seller
     their net. This is the target model, and the one the settlement engine
     already assumes.

   INERT BY CONSTRUCTION: switching to CENTRAL_MOR requires BOTH an explicit
   admin config change AND a configured central shortcode. Absent either, the
   resolver reports DIRECT_TO_SELLER — it never silently redirects live funds.

   OPERATING CENTRAL_MOR IS A BUSINESS DECISION, NOT A DEPLOY. Collecting
   customer funds and remitting them to third-party merchants changes who holds
   the money and who invoices, with CBK/Safaricom/tax implications. Do not flip
   this flag before that review concludes. */
const ROUTE_DIRECT = 'DIRECT_TO_SELLER';
const ROUTE_CENTRAL = 'CENTRAL_MOR';

function _defaults() {
  return {
    /* Legacy commission-collection Paybill (deferred-invoice flow). Being
       superseded by the Merchant-of-Record model — kept until that migration
       completes (see docs/SETTLEMENT_MIGRATION_PHASE2.md). */
    commissionPaybill: '522522',
    commissionAccountFormat: 'SOK-{REF}',   // account/reference pattern shown at checkout
    currency: 'KES',
    /* Default = today's reality. Changing this is a business decision. */
    collectionRoute: ROUTE_DIRECT,
    /* Platform collection shortcode used ONLY in CENTRAL_MOR. Operational-public
       (customers see it when paying), so it belongs here rather than in a client
       literal. Empty until provisioned — and empty means CENTRAL_MOR cannot
       engage. A Paybill is required, not a Buy Goods Till: reference-based C2B
       reconciliation needs the account/reference field that Till lacks. */
    centralPaybill: '',
    /* Merchant-of-Record BANK account is intentionally NOT here — its number is
       Secret-Manager-only (settlement-account.js) and never client-exposed. */
  };
}

/* Server-side resolver — THE single place the collection route is decided.
   Fails closed: anything unset or unrecognised resolves to DIRECT_TO_SELLER,
   because that is what the money actually does today. Never client-exposed as a
   control; callers stamp the returned route onto the payment record so every
   transaction carries the route it was actually collected under. */
async function resolveCollectionRoute(db) {
  const cfg = await _load(db);
  const wanted = String(cfg.collectionRoute || ROUTE_DIRECT).toUpperCase();
  if (wanted !== ROUTE_CENTRAL) {
    return { route: ROUTE_DIRECT, shortCode: null, reason: 'configured' };
  }
  const shortCode = String(cfg.centralPaybill || '').trim();
  if (!shortCode) {
    /* Asked for central, but no shortcode provisioned. Refusing is the safe
       answer: proceeding would send funds somewhere unintended. */
    return {
      route: ROUTE_DIRECT, shortCode: null,
      reason: 'CENTRAL_MOR requested but centralPaybill is not configured — refusing to switch route',
    };
  }
  return { route: ROUTE_CENTRAL, shortCode, reason: 'configured' };
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
    const { commissionPaybill, commissionAccountFormat, currency,
            collectionRoute, centralPaybill } = req.data || {};
    const update = { updatedAt: _now(), updatedBy: req.auth.uid };
    if (commissionPaybill != null) {
      if (!/^\d{5,7}$/.test(String(commissionPaybill)))
        throw new HttpsError('invalid-argument', 'commissionPaybill must be a 5–7 digit shortcode');
      update.commissionPaybill = String(commissionPaybill);
    }
    if (commissionAccountFormat != null) update.commissionAccountFormat = String(commissionAccountFormat).slice(0, 40);
    if (currency != null) update.currency = String(currency).slice(0, 4).toUpperCase();

    if (centralPaybill != null) {
      const cp = String(centralPaybill).trim();
      if (cp && !/^\d{5,7}$/.test(cp))
        throw new HttpsError('invalid-argument', 'centralPaybill must be a 5–7 digit shortcode');
      update.centralPaybill = cp;
    }
    if (collectionRoute != null) {
      const r = String(collectionRoute).toUpperCase();
      if (r !== ROUTE_DIRECT && r !== ROUTE_CENTRAL)
        throw new HttpsError('invalid-argument', 'collectionRoute must be ' + ROUTE_DIRECT + ' or ' + ROUTE_CENTRAL);
      /* Refuse to arm CENTRAL_MOR without a shortcode to collect into — the
         resolver would fall back to DIRECT anyway, and a config that claims a
         route it cannot honour is exactly how the ledger drifted from reality
         in the first place. */
      if (r === ROUTE_CENTRAL) {
        const cur = await _load(_db());
        const effective = (update.centralPaybill != null ? update.centralPaybill : cur.centralPaybill) || '';
        if (!effective)
          throw new HttpsError('failed-precondition',
            'Set centralPaybill before switching collectionRoute to ' + ROUTE_CENTRAL + '.');
      }
      update.collectionRoute = r;
    }

    await _db().doc(CONFIG_PATH).set(update, { merge: true });
    await _db().collection('settlementConfigAudit').add({
      action: 'payment_config_update', fields: Object.keys(update), by: req.auth.uid, at: _now(),
    });
    return { ok: true };
  },
);

module.exports._defaults   = _defaults;
module.exports._publicView = _publicView;

/* Consumed server-side by the payment initiators (darajaSTKPush, QR, C2B) so the
   route is decided in ONE place and stamped onto every payment record. Exported
   as plain functions/constants — not callables — so no client can reach them. */
module.exports.resolveCollectionRoute = resolveCollectionRoute;
module.exports.ROUTE_DIRECT  = ROUTE_DIRECT;
module.exports.ROUTE_CENTRAL = ROUTE_CENTRAL;
