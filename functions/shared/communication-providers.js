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

/* ==========================================================================
   LIVENESS — a SECOND, ORTHOGONAL axis
   ==========================================================================
   Provisioning answers "have we been given credentials for this?". Liveness
   answers "did the last real attempt work?". They are different questions and a
   dashboard that merges them is a dashboard that lies: a provider can be fully
   configured and completely down.

   The three states below are exhaustive, and the third one is the important
   one. `unobserved` is NOT `unreachable` — we have not tried, which is not the
   same as having tried and failed — and it is NOT `reachable` either. It
   renders as a dash, never as a colour.
   ========================================================================== */
const LIVENESS_STATES = Object.freeze(['reachable', 'unreachable', 'stale', 'unobserved']);

const OBSERVATION_OUTCOMES = Object.freeze(['success', 'failure']);

/* A success from last week is not evidence about now. Past this window an
   observation stops being liveness and becomes history. */
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * recordObservation(previous, { outcome, at, failureClass }) -> observation
 *
 * PURE reducer. Keeps only what an operator needs: outcomes and timestamps.
 * It deliberately has nowhere to put a response body, a header or a token —
 * see the whitelist note on healthRowsFor.
 */
function recordObservation(previous, event) {
  const e = event || {};
  if (OBSERVATION_OUTCOMES.indexOf(e.outcome) === -1) {
    throw new Error('providers: outcome must be success or failure');
  }
  if (typeof e.at !== 'number' || !isFinite(e.at)) {
    throw new Error('providers: an observation needs a numeric timestamp');
  }
  const prev = previous || {};
  const success = e.outcome === 'success';
  return {
    lastOutcome: e.outcome,
    lastAt: e.at,
    lastSuccessAt: success ? e.at : (prev.lastSuccessAt || null),
    lastFailureAt: success ? (prev.lastFailureAt || null) : e.at,
    /* The failure CLASS is retained because it is a closed vocabulary from
       FAILURE_CLASSES; the provider's own error text is not, because it is
       free-form and regularly contains the request that caused it. */
    lastFailureClass: success
      ? (prev.lastFailureClass || null)
      : (FAILURE_CLASSES[e.failureClass] ? e.failureClass : 'transport'),
    consecutiveFailures: success ? 0 : ((prev.consecutiveFailures || 0) + 1),
    observations: (prev.observations || 0) + 1,
  };
}

/**
 * livenessFor(observation, { now, staleAfterMs }) -> { state, reason }
 *
 * No observation gives `unobserved`, never a guess in either direction.
 */
function livenessFor(observation, opts) {
  const o = opts || {};
  const obs = observation || null;
  if (!obs || !obs.observations) {
    return { state: 'unobserved', reason: 'never_attempted' };
  }
  if (typeof o.now !== 'number') {
    /* Without a clock we cannot say whether an observation is still current,
       and the safe answer is to admit it rather than assume it is fresh. */
    return { state: 'unobserved', reason: 'no_clock_supplied' };
  }
  const staleAfter = typeof o.staleAfterMs === 'number' ? o.staleAfterMs : DEFAULT_STALE_AFTER_MS;
  if (o.now - obs.lastAt > staleAfter) {
    return { state: 'stale', reason: 'last_attempt_too_old' };
  }
  return obs.lastOutcome === 'success'
    ? { state: 'reachable', reason: 'last_attempt_succeeded' }
    : { state: 'unreachable', reason: 'last_attempt_failed' };
}

/* The operator-facing row is built from THIS LIST and nothing else. It is a
   whitelist rather than a blocklist on purpose: a blocklist only removes the
   credential shapes someone thought of, and the next provider adapter will
   invent a new one. Nothing reaches an operator's screen unless it is named
   here, so a token cannot ride along inside an observation. */
const SAFE_ROW_FIELDS = Object.freeze([
  'provider', 'channel', 'role', 'describe',
  'provisioning', 'liveness', 'livenessReason',
  'lastSuccessAt', 'lastFailureAt', 'lastFailureClass', 'consecutiveFailures',
]);

/**
 * healthRowsFor({ configured, observations, now, staleAfterMs }) -> rows
 *
 * The operator-facing projection, across BOTH axes.
 *
 *   provisioning  configured | not_configured   — have we been given credentials
 *   liveness      reachable | unreachable | stale | unobserved — did it last work
 *
 * They are separate fields because they are separate facts. A configured
 * provider that has never been attempted shows `configured` + `unobserved`,
 * which is the truthful reading of the situation and is NOT green.
 *
 * Timestamps are exposed; payloads never are. There is no field here that can
 * carry a key, a token, a header or a fragment of one — not redacted, not
 * truncated, not length-hinted. A prefix or a length is still a disclosure.
 *
 * The legacy single-argument form (a bare `configured` map) is still accepted,
 * so existing callers keep working and keep getting `unobserved`.
 */
function healthRowsFor(input) {
  const i = input || {};
  const legacy = !(i && (i.configured || i.observations || typeof i.now === 'number'));
  const c = (legacy ? i : i.configured) || {};
  const obsMap = (legacy ? {} : i.observations) || {};

  return Object.keys(PROVIDERS).map((p) => {
    const live = livenessFor(obsMap[p], { now: i.now, staleAfterMs: i.staleAfterMs });
    const obs = obsMap[p] || {};
    const row = {
      provider: p,
      channel: PROVIDERS[p].channel,
      role: PROVIDERS[p].role,
      describe: PROVIDERS[p].describe,
      provisioning: c[p] === true ? 'configured' : 'not_configured',
      liveness: live.state,
      livenessReason: live.reason,
      /* null, not 0 — an unknown time is not the epoch. */
      lastSuccessAt: obs.lastSuccessAt || null,
      lastFailureAt: obs.lastFailureAt || null,
      lastFailureClass: obs.lastFailureClass || null,
      consecutiveFailures: obs.consecutiveFailures || 0,
      /* `state` is retained for the existing console, which reads it. */
      state: c[p] === true ? 'configured' : 'not_configured',
    };
    /* Built by whitelist: assemble, then keep only what is named. */
    const safe = { state: row.state };
    SAFE_ROW_FIELDS.forEach((f) => { safe[f] = row[f]; });
    return safe;
  });
}

module.exports = {
  ROLES,
  PROVIDERS,
  CHAINS,
  FAILURE_CLASSES,
  LIVENESS_STATES,
  OBSERVATION_OUTCOMES,
  DEFAULT_STALE_AFTER_MS,
  SAFE_ROW_FIELDS,
  mayFailOver,
  chainFor,
  nextProvider,
  recordObservation,
  livenessFor,
  healthRowsFor,
};
