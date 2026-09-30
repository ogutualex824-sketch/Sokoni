'use strict';
/**
 * SOKONI Loyalty Dispatcher — consolidates 40 onCall CFs into 1 Cloud Run service.
 * Clients call loyaltyDispatch({op: 'functionName', ...data}) instead of individual CFs.
 *
 * Handler registry is populated at require() time by loyalty.js and loyalty-enterprise.js
 * via the exports._h pattern: each module stores its handler functions in exports._h.
 *
 * Cloud Run reduction: 40 onCall → 1 dispatcher (2 scheduled stay individual).
 *
 * ── SECURITY (2026-09-29): AN ALLOW-LIST, NOT A ROUTER ──────────────────────────────────────────────────────
 * This dispatcher used to route ANY registered op to its handler. Several handlers were written as SERVER
 * internals and trust their payload completely:
 *   · awardLoyaltyPoints — auth only; caller-supplied customerUid / amountKES / merchantId / orderId → any
 *     signed-in user could credit unlimited points to any account;
 *   · awardCashback, loyaltyCheckoutOrchestrate, enterLuckyDraw, trackReferral, getVisitFrequencyReward,
 *     issueGiftCard, joinLoyaltyNetwork — NO auth check at all;
 *   · the enterprise "customer" reads take `uid` from the payload, so anyone could read anyone's account.
 * Every op now has a POLICY, and an op without one is refused. Nothing here changes what a handler does for a
 * legitimate caller — it decides WHO may reach it and pins the identity it acts on:
 *   customer — signed in; any `uid` in the payload is REPLACED by the caller's own uid; phone/loyaltyId probes
 *              are stripped, so an account can only be read or used by its owner;
 *   merchant — signed in, and `merchantId` must be the caller's own id or a shop the caller owns / manages
 *              (the canonical shop-employees authority, corroborated against the shop document); the merchant
 *              ID typed into loyalty-merchant.html is therefore checked, never believed;
 *   admin    — platform admin claim;
 *   internal — NOT callable from a client at all. Points, cashback and gift value are only ever created by
 *              SOKONI's own servers from a verified sale or order.
 * The refusal names no valid op list (the old error enumerated every op, including the dangerous ones).
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');

const LOYALTY_HMAC = defineSecret('LOYALTY_HMAC_SECRET');
const REGION       = 'us-central1';

// Load both modules to populate their handler registries
const loyalty    = require('./loyalty');
const enterprise = require('./loyalty-enterprise');

// Merge all onCall handlers — enterprise handlers override loyalty if names collide (shouldn't happen)
const _H = Object.assign({}, loyalty._h, enterprise._h);

/* THE POLICY. An op missing from this table is refused, so a handler added later is closed until someone decides
   who may call it. */
const POLICY = Object.freeze({
  /* the customer's own account */
  createLoyaltyAccount: 'customer', getLoyaltyAccount: 'customer', getLoyaltyCard: 'customer',
  getLoyaltyHistory: 'customer', getLoyaltyTiers: 'customer', getAvailableRewards: 'customer',
  redeemLoyaltyReward: 'customer', loyaltyPreflightCheck: 'customer', getMembershipBenefits: 'customer',
  getPersonalizedOffers: 'customer', redeemGiftCard: 'customer', getLoyaltyReceipt: 'customer',
  /* the merchant's own programme */
  configureLoyaltyProgram: 'merchant', getMerchantLoyaltyConfig: 'merchant', getActiveCampaigns: 'merchant',
  getMerchantLoyaltyDashboard: 'merchant', createLoyaltyReward: 'merchant', createLoyaltyCampaign: 'merchant',
  getLoyaltyInsights: 'merchant', issueGiftCard: 'merchant', listGiftCards: 'merchant',
  joinLoyaltyNetwork: 'merchant', getLoyaltyNetworkStatus: 'merchant', lookupLoyaltyCustomer: 'merchant',
  /* platform administration */
  adminAdjustPoints: 'admin', adminAdjustLoyaltyPoints: 'admin', voidLoyaltyTransaction: 'admin',
  getLoyaltyFraudDashboard: 'admin',
  /* SERVER-INTERNAL — value is created only from a verified sale / order, never by a client call */
  awardLoyaltyPoints: 'internal', redeemLoyaltyPoints: 'internal', confirmLoyaltyRedemption: 'internal',
  syncOfflineLoyaltyTransactions: 'internal', linkPhysicalCard: 'internal', loyaltyCheckoutOrchestrate: 'internal',
  awardCashback: 'internal', enterLuckyDraw: 'internal', trackReferral: 'internal',
  getCrossMerchantPoints: 'internal', getVisitFrequencyReward: 'internal',
  getLoyaltyLeaderboard: 'internal',          /* no client calls it; a leaderboard exposes other members — closed until reviewed */
});
const MERCHANT_ROLES = ['owner', 'admin', 'manager'];

function isAdminToken(t) {
  t = t || {};
  return t.admin === true || t.superAdmin === true || t.role === 'admin' || t.role === 'superAdmin';
}

/* A merchantId the caller may act for: their own id, or a shop they own / manage (or any, for an admin). */
async function assertMerchantScope(req) {
  const uid = req.auth.uid, mid = req.data && req.data.merchantId != null ? String(req.data.merchantId) : '';
  if (isAdminToken(req.auth.token)) return;
  if (!mid) throw new HttpsError('invalid-argument', 'merchantId is required.');
  if (mid === uid) return;
  if (mid.includes('/') || mid.length > 128) throw new HttpsError('permission-denied', 'Not your programme.');
  let access = null;
  try { access = await require('./shop-employees').resolveShopAccess(uid, mid); } catch (_) { access = null; }
  if (!access || MERCHANT_ROLES.indexOf(access.role) === -1) {
    throw new HttpsError('permission-denied', 'You can only manage your own shop\'s loyalty programme.');
  }
}

/* A phone shown to a merchant keeps only its last three digits. */
function maskPhones(v) {
  if (Array.isArray(v)) return v.map(maskPhones);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  Object.keys(v).forEach((k) => {
    const x = v[k];
    if (/phone/i.test(k) && typeof x === 'string' && x.replace(/\D/g, '').length >= 6) {
      out[k] = '••••' + x.replace(/\D/g, '').slice(-3);
    } else out[k] = maskPhones(x);
  });
  return out;
}

async function guard(op, req) {
  const policy = POLICY[op];
  if (!policy || policy === 'internal') {
    throw new HttpsError('permission-denied', 'This loyalty operation is not available.');
  }
  if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (policy === 'admin' && !isAdminToken(req.auth.token)) throw new HttpsError('permission-denied', 'Admin access required.');
  if (policy === 'merchant') await assertMerchantScope(req);
  if (policy === 'customer') {
    /* the account acted on is the CALLER's — never one named in the payload */
    const d = Object.assign({}, req.data || {});
    d.uid = req.auth.uid;
    delete d.customerUid; delete d.loyaltyId; delete d.qrPayload;
    if (op !== 'createLoyaltyAccount') delete d.phone;     /* creating one's own account may carry one's own phone */
    return Object.assign({}, req, { data: d });
  }
  return req;
}

// Dispatcher options: widest superset needed by any loyalty handler
const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  secrets:         [LOYALTY_HMAC],
  timeoutSeconds:  120,
  memory:          '512MiB',
  /* Pinned to the LIVE service (maxScale 80, read 2026-10-01). The CLI does not carry
     maxInstances over from the running service and ignores firebase.json codebase keys,
     so an unset value here would silently change the live ceiling on deploy. */
  maxInstances:    80,
};

/**
 * loyaltyDispatch — single entry-point for the loyalty operations a client may call.
 * req.data = { op: 'operationName', ...operationPayload }
 */
exports.loyaltyDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') throw new HttpsError('invalid-argument', '"op" field is required.');
  const handler = Object.prototype.hasOwnProperty.call(_H, op) ? _H[op] : null;
  if (!handler) throw new HttpsError('not-found', 'Unknown loyalty operation.');
  const guarded = await guard(op, req);
  const out = await handler(guarded);
  return op === 'lookupLoyaltyCustomer' ? maskPhones(out) : out;
});

/* Internals, exported for certification. */
exports._policy = { POLICY, guard, maskPhones, assertMerchantScope };
