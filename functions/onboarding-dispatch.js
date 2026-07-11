'use strict';
/**
 * SOKONI Universal Enterprise Onboarding Engine — dispatcher.
 * 12 ops covering account init, drafts, role activation, switching, subscriptions.
 *
 * Client: firebase.functions().httpsCallable('onboardingDispatch')({ op, ...data })
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const _OPTS = {
  region:          'us-central1',
  enforceAppCheck: true,
  timeoutSeconds:  120,
  memory:          '512MiB',
};

let _mod;
function _h() { return _mod || (_mod = require('./universal-onboarding')._h); }

const ROUTES = [
  'onbGetAccount', 'onbSaveDraft', 'onbGetDraft',
  'onbActivateRole', 'onbSwitchRole', 'onbGetProfiles',
  'onbGetPlans', 'onbActivateSubscription', 'onbGetDashboard',
  'onbUpdateProfile', 'onbCheckHandle',
];

exports.onboardingDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', `"op" required. Valid: ${ROUTES.join(', ')}`);
  }
  if (!ROUTES.includes(op)) {
    throw new HttpsError('not-found', `Unknown op: "${op}".`);
  }
  const handler = _h()[op];
  if (!handler) throw new HttpsError('internal', `Handler for "${op}" missing.`);
  return handler(req);
});
