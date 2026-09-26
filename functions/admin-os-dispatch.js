'use strict';
/**
 * SOKONI Admin OS Dispatcher — consolidates 41 onCall CFs into 1 Cloud Run service.
 * Clients call adminOsDispatch({op: 'functionName', ...data}).
 *
 * Cloud Run reduction: 41 onCall → 1 dispatcher.
 * sokoni-aos.js routes admin-os ops through this dispatcher automatically
 * via its ADMIN_OS_OPS whitelist in the _call() helper.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const REGION = 'us-central1';
/* admin-os owns the 41 original ops; admin-commission-trace adds the read-only Merchant
   Subscription / commission traceability ops. Merged into ONE registry so the dispatcher's
   op lookup, its "valid ops" error text and its auth path stay unchanged — a second dispatcher
   would be a second admin surface to keep in step. The trace module writes nothing and guards
   every op with the same admin/superAdmin check. */
const adminOs = (() => {
  const base = require('./admin-os');
  const trace = require('./admin-commission-trace');
  /* Creator Hub controls (creatorAdmin* ops) — every handler guards itself
     with admin-claim, like the rest of this registry. */
  const creator = require('./creator-hub');
  /* Event ticket settlement controls (eventAdmin* ops) — same self-guarding convention. */
  const events = require('./event-settlement');
  /* Entertainment moderation + category/policy matrix (entAdmin* ops). */
  const ent = require('./entertainment-admin');
  return Object.assign({}, base, { _h: Object.assign({}, base._h, trace._h, creator._adminH, events._adminH, ent._adminH) });
})();

const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  maxInstances:    10,
  /* One warm instance: adminOsDispatch is the hub for every admin read, so a
     cold start (several seconds) was leaving the Overview widgets on skeletons
     ("takes long to load"). minInstances:1 keeps the common path hot. Deploy
     with --force (minInstances is a cost-bearing change). */
  minInstances:    1,
  timeoutSeconds:  60,
  memory:          '256MiB',
};

exports.adminOsDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', '"op" field is required. Valid ops: ' + Object.keys(adminOs._h).sort().join(', '));
  }
  const handler = adminOs._h[op];
  if (!handler) {
    throw new HttpsError('not-found', `Unknown admin-os operation: "${op}". Valid ops: ${Object.keys(adminOs._h).sort().join(', ')}`);
  }
  return handler(req);
});
