/* ============================================================================
   SOKONI Integration Probe Executors — functions/integration-probe-executors.js
   ============================================================================
   The per-provider half of RC-3. integration-probes.js owns the SEMANTICS —
   which stages exist, what counts as evidence, what may not be claimed. This
   file owns the mechanics of actually touching a provider.

   THE CONTRACT AN EXECUTOR MUST HONOUR
   -------------------------------------
   Resolve { connected, accepted, detail, evidence } or throw.

     • `accepted: true` means the provider TOOK the request. It never means the
       thing arrived. An executor cannot report delivery — it does not know, and
       runProbe() ignores any attempt to claim it.
     • `detail` is for a human. It must never interpolate configuration: a
       failure message that echoes a key turns an admin console into a
       credential viewer.
     • A throw means "could not reach / provider refused" and becomes
       connected:false, accepted:false — a FAILED rail, which is a different
       state from a rail with no credentials.

   THE CREDENTIAL BOUNDARY — WHY SOME PROBES ARE NOT IMPLEMENTED HERE
   -------------------------------------------------------------------
   adminGetIntegrationStatus deliberately binds NO secret: it lists secret names
   and holds nothing. That property is worth keeping, and it has a consequence —
   a probe that must authenticate to a provider needs that provider's credential
   in the function's environment, which the status endpoint does not have.

   So a credential-requiring probe cannot be smuggled in here. It needs a probe
   function that binds exactly those provider secrets, which is a deployment
   change, and deployment is frozen. Those integrations therefore return
   `requiresSecretBinding` and resolve to health `unknown` with a stated reason.

   That is the honest state. The alternative — pretending a probe ran, or
   binding the entire estate's secrets into one endpoint to avoid saying so —
   is how a console ends up showing green for a channel nobody receives on.

   WHAT AN EXECUTOR MAY NOT DO
   ----------------------------
   Charge money, message a real customer, write to a business collection, or use
   a live customer address. The payment rails are probed by READ if at all,
   never by creating a charge — and IntaSend exposes no read-only health
   endpoint, so it has no executor rather than a fabricated one.
   ============================================================================ */
'use strict';

/* Raised by an executor that cannot run without provider credentials this
   function does not hold. Distinguished from a provider failure by its code. */
function needsBinding (secrets) {
  const e = new Error('This probe requires ' + secrets.join(', ') +
                      ' to be bound to the probe function; deployment is frozen.');
  e.code = 'requires_secret_binding';
  return e;
}

const EXECUTORS = {
  /* ── Credential-free: the service account IS the credential ──────────── */

  'firestore': async () => {
    const admin = require('firebase-admin');
    await admin.firestore().collection('_probe').limit(1).get();
    return { connected: true, accepted: true, evidence: 'service_account',
             detail: 'Read query executed as the service account.' };
  },

  'cloud-storage': async () => {
    const admin = require('firebase-admin');
    await admin.storage().bucket().getMetadata();
    return { connected: true, accepted: true, evidence: 'service_account',
             detail: 'Bucket metadata read.' };
  },

  /* redis-service already owns the connection and exposes an admin INFO read.
     `isFallback()` is the honest signal: the layer degrades to an in-process
     cache when Redis is unreachable, and a probe that ignored that would report
     the fallback as a healthy Redis. */
  'memorystore-redis': async () => {
    const redis = require('./redis-service');
    if (typeof redis.isFallback === 'function' && redis.isFallback()) {
      const e = new Error('Redis layer is running in fallback mode; the instance was not reached.');
      throw e;
    }
    if (typeof redis.adminInfo !== 'function') {
      const e = new Error('redis-service exposes no adminInfo()'); throw e;
    }
    const info = await redis.adminInfo();
    return { connected: true, accepted: !!info,
             detail: 'Redis INFO read; layer is not in fallback.' };
  },

  /* ── Credential-requiring: declared, deliberately not faked ──────────── */

  'sendgrid':       async () => { throw needsBinding(['SENDGRID_API_KEY']); },
  'africastalking': async () => { throw needsBinding(['AFRICASTALKING_API_KEY', 'AFRICASTALKING_USERNAME']); },
  'typesense':      async () => { throw needsBinding(['TYPESENSE_ADMIN_KEY']); },
  'algolia':        async () => { throw needsBinding(['ALGOLIA_ADMIN_KEY']); },
  'anthropic':      async () => { throw needsBinding(['ANTHROPIC_API_KEY']); },
  'etims':          async () => { throw needsBinding(['ETIMS_MASTER_KEY', 'ETIMS_PLATFORM_SECRET']); },
  'smtp-fallback':  async () => { throw needsBinding(['MAIL_HOST', 'MAIL_USER', 'MAIL_PASS']); },

  /* ── Payments: no safe read-only probe exists ────────────────────────── */

  'intasend-collections': async () => {
    const e = new Error('IntaSend exposes no read-only health endpoint SOKONI polls, and a probe ' +
                        'must not create a charge. Judge this rail by payment outcomes.');
    e.code = 'no_safe_probe';
    throw e;
  },

  'intasend-payouts': async () => {
    const e = new Error('Probing a payout would move money. No read-only probe is defined.');
    e.code = 'no_safe_probe';
    throw e;
  },

  /* intasend-webhook is INBOUND ONLY — there is nothing to call. Its evidence
     is a correlated inbound POST, which arrives through recordProbeEvent(). */
};

/* Which integrations have a probe that can actually RUN today, as opposed to one
   that exists but refuses. This is what a management surface must key a "test"
   control on: offering a test for a probe that cannot run gives an operator a
   button wired to nothing, and for IntaSend it would promise a provider test
   that deliberately does not exist because probing would move money. */
const REFUSES_BY_DESIGN = {
  'intasend-collections': 'no_safe_probe',
  'intasend-payouts':     'no_safe_probe',
  'sendgrid':             'requires_secret_binding',
  'africastalking':       'requires_secret_binding',
  'typesense':            'requires_secret_binding',
  'algolia':              'requires_secret_binding',
  'anthropic':            'requires_secret_binding',
  'etims':                'requires_secret_binding',
  'smtp-fallback':        'requires_secret_binding',
};

/**
 * probeAvailability(id) -> 'runnable' | 'no_safe_probe' | 'requires_secret_binding' | 'none'
 *
 * 'runnable' means the probe would actually contact the provider if invoked now.
 */
function probeAvailability (integrationId) {
  if (!EXECUTORS[integrationId]) return 'none';
  return REFUSES_BY_DESIGN[integrationId] || 'runnable';
}

/**
 * executorFor(integrationId) -> function | undefined
 *
 * Undefined is a legitimate answer: runProbe() reports health `unknown` with
 * "no probe is defined", rather than a failure.
 */
function executorFor (integrationId) {
  return EXECUTORS[integrationId];
}

/* Codes that mean "this probe did not run", as opposed to "the provider is
   broken". The caller uses this to avoid reporting an unrun probe as failed. */
const NOT_RUN_CODES = ['requires_secret_binding', 'no_safe_probe'];

module.exports = { EXECUTORS, executorFor, probeAvailability, REFUSES_BY_DESIGN,
  NOT_RUN_CODES, _internal: { needsBinding } };
