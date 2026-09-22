'use strict';
/**
 * SOKONI Communication Engine — the provider policy.
 * ============================================================================================
 * Providers are REPLACEABLE. SOKONI's communication identity, authorization, business context,
 * conversation history and audit trail are not.
 *
 *     application  ->  sendEmail(...)          never  sendSendGridEmail(...)
 *
 * This module holds the registry and, more importantly, the FAILOVER POLICY — the part that is
 * usually wrong.
 *
 * ── NOT EVERY FAILURE DESERVES A SECOND ATTEMPT ────────────────────────────────────────────
 * Blind failover is worse than no failover. If SendGrid rejects a recipient as invalid, trying
 * SMTP sends the same invalid recipient to a second provider: it fails again, and SOKONI has
 * now told two vendors' reputation systems that it mails bad addresses. If the recipient
 * UNSUBSCRIBED, failing over actively defeats the suppression and mails someone who asked not
 * to be mailed. If the API key is wrong, failing over hides a misconfiguration that will keep
 * costing until someone notices.
 *
 * So failure is CLASSIFIED, and only a transport-class failure is retried elsewhere:
 *
 *     transport      the provider could not be reached / 5xx / timeout   -> FAIL OVER
 *     auth           bad or missing credentials                          -> STOP, alert
 *     recipient      invalid address, hard bounce                        -> STOP
 *     suppressed     unsubscribed, complained, blocked                   -> STOP, and honour it
 *     content        rejected payload, template error                    -> STOP
 *     quota          rate limited / over plan                            -> FAIL OVER
 *
 * ── TRANSACTIONAL MAIL IS NOT A HUMAN MAILBOX ──────────────────────────────────────────────
 * `receipts@` and `support@` are different things and must not share a transport. Automated
 * mail wants deliverability engineering and a reputation SOKONI controls; a human mailbox wants
 * threads, search, delegation and someone's actual inbox. Mixing them means a bounced receipt
 * damages the reputation of the address your support team replies from.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────────────────────
 * No Firestore, no clock, no network, no require, no environment. Whether a provider is
 * CONFIGURED is an argument, never read here — a module that checks its own env cannot be
 * tested for the unconfigured case, and that is the case that matters.
 */

const ROLES = Object.freeze(['transactional', 'mailbox', 'bulk_sms', 'push', 'realtime', 'relay']);

/**
 * The registry. `configured` is DELIBERATELY ABSENT — it is supplied per call, because this
 * module must never claim a provider works. What is provisioned is a fact about deployment,
 * and deployment is not this file's business.
 */
const PROVIDERS = Object.freeze({
  sendgrid: Object.freeze({
    channel: 'email',
    role: 'transactional',
    describe: 'Order, receipt, verification and security mail. SOKONI-controlled reputation.',
  }),
  smtp: Object.freeze({
    channel: 'email',
    role: 'transactional',
    describe: 'SMTP/nodemailer fallback for transactional mail.',
  }),
  google_workspace: Object.freeze({
    channel: 'email',
    role: 'mailbox',
    /* NOT a failover target for transactional mail — a different job, see the header. */
    describe: 'Human mailboxes: support@, admin@, sales@, suppliers@, accounts@.',
  }),
  africas_talking: Object.freeze({
    channel: 'sms',
    role: 'bulk_sms',
    describe: 'OTP and urgent operational SMS. Costs money per message.',
  }),
  fcm: Object.freeze({
    channel: 'push',
    role: 'push',
    describe: 'Push to registered devices. The cheapest reachable channel.',
  }),
  webrtc: Object.freeze({
    channel: 'voice',
    role: 'realtime',
    describe: 'Peer-to-peer voice and video signalling.',
  }),
  turn: Object.freeze({
    channel: 'voice',
    role: 'relay',
    describe: 'Media relay for peers that cannot connect directly.',
  }),
});

/**
 * Failover CHAINS, in order of preference. A chain lists providers of the SAME ROLE only —
 * `google_workspace` is absent from the email chain on purpose, because a human mailbox is not
 * a transactional fallback.
 */
const CHAINS = Object.freeze({
  email: Object.freeze(['sendgrid', 'smtp']),
  sms: Object.freeze(['africas_talking']),
  push: Object.freeze(['fcm']),
  voice: Object.freeze(['webrtc', 'turn']),
});

/** Failure classes, and whether another provider should be tried. */
const FAILURE_CLASSES = Object.freeze({
  transport: Object.freeze({ failover: true, describe: 'unreachable, 5xx, timeout' }),
  quota: Object.freeze({ failover: true, describe: 'rate limited or over plan' }),
  auth: Object.freeze({ failover: false, describe: 'bad or missing credentials' }),
  recipient: Object.freeze({ failover: false, describe: 'invalid address or hard bounce' }),
  suppressed: Object.freeze({ failover: false, describe: 'unsubscribed, complained or blocked' }),
  content: Object.freeze({ failover: false, describe: 'rejected payload or template error' }),
});

/**
 * mayFailOver(failureClass) -> { failover, reason }
 *
 * FAILS CLOSED. An unrecognised failure does NOT fail over: trying a second provider on a
 * failure nobody has classified is how a suppression gets defeated by accident.
 */
function mayFailOver(failureClass) {
  const k = String(failureClass || '');
  const spec = Object.hasOwn(FAILURE_CLASSES, k) ? FAILURE_CLASSES[k] : null;
  if (!spec) return { failover: false, reason: 'unclassified_failure' };
  return {
    failover: spec.failover === true,
    reason: spec.failover ? 'transport_class_failure' : 'failure_is_not_transport',
  };
}

/**
 * chainFor({ channel, configured }) -> { chain, skipped, reason }
 *
 * `configured` is a map of provider -> true. A provider that is not configured is SKIPPED and
 * NAMED — never silently dropped, and never assumed present. A channel whose whole chain is
 * unconfigured returns an empty chain with `no_provider_configured`, which a caller must
 * surface rather than retry.
 */
function chainFor(input) {
  const i = input || {};
  const channel = String(i.channel || '');
  const configured = i.configured || {};
  if (!Object.hasOwn(CHAINS, channel)) {
    return { chain: [], skipped: [], reason: 'unknown_channel' };
  }
  const all = CHAINS[channel];
  const chain = all.filter((p) => configured[p] === true);
  const skipped = all.filter((p) => configured[p] !== true);
  return {
    chain,
    skipped,
    reason: chain.length ? 'chain_available' : 'no_provider_configured',
  };
}

/**
 * nextProvider({ channel, configured, current, failureClass }) -> { provider, reason }
 *
 * The whole failover decision in one place. Returns `provider: null` with a stated reason
 * whenever another attempt must NOT be made — which is most of the time, and is the point.
 */
function nextProvider(input) {
  const i = input || {};
  const decision = mayFailOver(i.failureClass);
  if (!decision.failover) return { provider: null, reason: decision.reason };

  const { chain } = chainFor({ channel: i.channel, configured: i.configured });
  if (!chain.length) return { provider: null, reason: 'no_provider_configured' };

  const current = String(i.current || '');
  const idx = chain.indexOf(current);
  if (idx === -1) {
    /* The failing provider is not in the configured chain — a stale or unknown provider name.
       Refused rather than restarted at the top, because restarting would re-send. */
    return { provider: null, reason: 'current_provider_not_in_chain' };
  }
  const next = chain[idx + 1];
  if (!next) return { provider: null, reason: 'chain_exhausted' };
  return { provider: next, reason: 'failover' };
}

/**
 * healthRowsFor(configured) -> [{ provider, channel, role, state, describe }]
 *
 * The operator-facing projection. `state` is `operational` or `not_configured` and NOTHING
 * ELSE — this module observes provisioning, not liveness. A provider that is configured may
 * still be failing, and rendering that as green would be the dashboard lying. Live health is a
 * measured thing and belongs to whatever records real attempts.
 */
function healthRowsFor(configured) {
  const c = configured || {};
  return Object.keys(PROVIDERS).map((p) => ({
    provider: p,
    channel: PROVIDERS[p].channel,
    role: PROVIDERS[p].role,
    state: c[p] === true ? 'configured' : 'not_configured',
    describe: PROVIDERS[p].describe,
  }));
}

module.exports = {
  ROLES,
  PROVIDERS,
  CHAINS,
  FAILURE_CLASSES,
  mayFailOver,
  chainFor,
  nextProvider,
  healthRowsFor,
};
