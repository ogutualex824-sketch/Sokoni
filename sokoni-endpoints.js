/**
 * SOKONI Endpoint Registry
 * Single source of truth for all Cloud Function URLs.
 * Eliminates hardcoded URLs scattered across frontend files.
 *
 * Usage:
 *   const { fn } = window.SokoniEndpoints;
 *   fn('sendInvoiceEmail')    → 'https://us-central1-sokoni-aeb26.cloudfunctions.net/sendInvoiceEmail'
 */
(function (global) {
  'use strict';

  const PROJECT = 'sokoni-aeb26';
  const REGION  = 'us-central1';
  const BASE    = `https://${REGION}-${PROJECT}.cloudfunctions.net`;

  /* Callable function base (same host, same path format for v2 callables) */
  function fn(name) { return `${BASE}/${name}`; }

  /* Named exports for common endpoints — avoids string typos in call sites */
  const ENDPOINTS = {
    /* System */
    systemHealthCheck:        fn('systemHealthCheck'),
    recordMetric:             fn('recordMetric'),

    /* Email */
    sendInvoiceEmail:         fn('sendInvoiceEmail'),
    testEmailDelivery:        fn('testEmailDelivery'),
    resendEmail:              fn('resendEmail'),
    updateEmailPreferences:   fn('updateEmailPreferences'),

    /* Auth / Security */
    onLoginEvent:             fn('onLoginEvent'),

    /* Payments */
    darajaSTKCallback:        fn('darajaSTKCallback'),
    intasendWebhook:          fn('intasendWebhook'),
    initiateRefund:           fn('initiateRefund'),

    /* Search */
    typesenseCreateCollections: fn('typesenseCreateCollections'),
    typesenseBackfill:          fn('typesenseBackfill'),
    typesenseHealthCheck:       fn('typesenseHealthCheck'),

    /* Orders / Delivery */
    onOrderStatusChange:      fn('onOrderStatusChange'),
    onDeliveryStatusChange:   fn('onDeliveryStatusChange'),

    /* POS */
    posSendSMS:               fn('posSendSMS'),
    posCreateSession:         fn('posCreateSession'),

    /* Ops */
    getOpsStatus:             fn('getOpsStatus'),
    getPaymentAuditTrail:     fn('getPaymentAuditTrail'),

    /* AI */
    sokoniAIChat:             fn('sokoniAIChat'),
    sokoniAIModerate:         fn('sokoniAIModerate'),
  };

  const SokoniEndpoints = {
    fn,
    BASE,
    PROJECT,
    REGION,
    ...ENDPOINTS,
  };

  /* Export for module and browser environments */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SokoniEndpoints;
  } else {
    global.SokoniEndpoints = SokoniEndpoints;
  }
})(typeof window !== 'undefined' ? window : global);
