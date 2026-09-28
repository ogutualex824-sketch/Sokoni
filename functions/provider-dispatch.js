'use strict';
/**
 * SOKONI Provider Dispatcher — 19 onCall ops → 1 Cloud Run service.
 * All provider onboarding, dashboard, and profile management ops route here.
 *
 * Client: firebase.functions().httpsCallable('providerDispatch')({ op, ...data })
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

/* providerRequestShop provisions a Till through the canonical mintSokoniTillCore, which mints
   a signed QR token with QR_SIGNING_SECRET. A v2 function may only read a secret it declares:
   without this, `QR_SIGNING_SECRET.value()` throws "Signing secret not configured" AT RUNTIME,
   AFTER the Till document has already been written — leaving a Till that exists while the
   caller is told provisioning failed. Declared here for exactly that one op; every other route
   ignores it. Same secret name as sokoni-till.js, and defineSecret is keyed by name, so this
   binds the same parameter rather than introducing a second one. */
const QR_SIGNING_SECRET = defineSecret('QR_SIGNING_SECRET');

const _OPTS = {
  region:          'us-central1',
  enforceAppCheck: true,
  timeoutSeconds:  120,
  memory:          '512MiB',
  minInstances:    1,     /* keep one warm — the provider dashboard's hot path (no cold start on load) */
  secrets:         [QR_SIGNING_SECRET],
};

let _mod;
/* Merge onboarding handlers (provider-onboarding) + post-onboarding dashboard /
   service-management handlers (provider-ops). Both feed this one Cloud Run service. */
function _h() {
  if (!_mod) {
    _mod = Object.assign({},
      require('./provider-onboarding')._h,
      require('./provider-ops')._h,
      require('./booking-service')._h,             /* Phase B: authoritative service create */
      require('./booking-availability-guard')._h,  /* read-only availability-vs-booking impact check */
      require('./booking-resolution')._h,          /* Slice 2: affected-booking resolution engine */
      /* Merchant identity on request — provisions the SAME shops/sellers/businesses
         projection merchant approval uses (provider-shop.js), never a healthcare variant. */
      { providerRequestShop: require('./provider-shop').providerRequestShop },
      /* CHANGELOG 233 — the category-aware Healthcare workspace (what the dashboard offers, server-decided). */
      require('./healthcare-workspace')._h,
      /* CHANGELOG 238 (C2a) — the ONE business workspace authority, for every category. */
      require('./business-workspace')._h,
      /* CHANGELOG 244 (C3a-2) — the ONE public provider directory (C1 category + eligibility, server-decided). */
      require('./provider-directory')._h);
  }
  return _mod;
}

const ROUTES = [
  'providerSaveDraft',
  'providerGetDraft',
  'providerSelectPlan',
  'providerActivateSubscription',
  'providerPublish',
  'providerGetProfile',
  'providerUpdateProfile',
  'providerDashboard',
  'providerGetHealth',
  'providerServiceMetrics',
  'providerGetCustomers',
  'providerSaveCustomerNote',
  'providerGetBookings',
  'providerUpdateAvailability',
  'providerUpdatePricing',
  'providerConnectPayment',
  'providerUpdateNotifications',
  'providerGenerateQR',
  'providerSubmitVerification',
  'providerGetPublicProfile',
  'providerSearchProviders',
  'providerDirectory',
  'providerRequestShop',
  'healthcareWorkspace',
  'businessWorkspace',
  'workspaceHome',
  'providerGetAnalytics',
  'providerGetPlans',
  // provider-ops — dashboard + service management (post-onboarding)
  'providerConfirmBooking',
  'providerDeclineBooking',
  'providerCompleteBooking',
  // D1 — booking lifecycle (docs/BOOKING_LIFECYCLE_CONTRACT.md v1.0)
  'providerStartBooking',
  'providerCancelBooking',
  'providerMarkNoShow',
  'providerRescheduleBooking',
  'providerContactCustomer',
  'providerSaveBookingNote',
  'providerGetEarnings',
  'providerRequestPayout',
  'providerGetReviews',
  'providerReplyReview',
  'providerSavePortfolio',
  'providerGetPortfolio',
  'providerAddService',
  'providerListServices',
  'providerRemoveService',
  'providerUpdateService',
  'providerToggleService',
  'providerDuplicateService',
  'providerUpdateServicePricing',
  'bookingPreviewPrice',
  // booking-service (Phase B) — authoritative service-appointment create
  'bookingCreateService',
  // booking-service (hold lifecycle) — proactive pre-payment hold release on abandon/fail
  'bookingReleaseHold',
  // booking-service (WS3) — authoritative customer review, gated on a completed booking
  'bookingSubmitReview',
  // booking-availability-guard — read-only impact pre-check before an availability change
  'providerCheckAvailabilityImpact',
  // booking-resolution (Slice 2 step 1) — raise affected bookings into ACTION_REQUIRED + queue read
  'providerRaiseAffectedBookings',
  'providerListAffectedBookings',
  // booking-resolution (Slice 2 step 2) — negotiation state machine (reschedule via canonical engine)
  'providerProposeReschedule',
  'customerRespondToProposal',
  'customerProposeTime',
  'providerRespondToCustomerProposal',
  'bookingGetTimeline',
  'customerListAffectedBookings',
  // booking-resolution (Slice 2 step 3) — canonical refund terminal (reuses _disburseHeldFunds)
  'customerRequestRefund',
];

const VALID_OPS = ROUTES.sort().join(', ');

exports.providerDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', `"op" field is required. Valid ops: ${VALID_OPS}`);
  }
  if (!ROUTES.includes(op)) {
    throw new HttpsError('not-found', `Unknown op: "${op}". Valid ops: ${VALID_OPS}`);
  }
  const handler = _h()[op];
  if (!handler) {
    throw new HttpsError('internal', `Handler for "${op}" not found in provider handler registry`);
  }
  return handler(req);
});
