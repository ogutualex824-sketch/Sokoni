/* ============================================================================
   SOKONI Integration Probes — functions/integration-probes.js          (RC-3)
   ============================================================================
   RC-1 answered "is the credential configured?". This answers "does the thing
   actually work?" — and, critically, refuses to answer further than the evidence
   goes.

   THE FIVE STAGES, AND WHY THEY ARE SEPARATE
   -------------------------------------------
       configured   the credential a rail needs exists            (RC-1)
       connected    the provider was reached at all
       accepted     the provider took the request
       delivered    the PROVIDER reported it delivered
       received     SOKONI received and correlated the callback

   An HTTP 200 proves `accepted`. It does not prove `delivered`, and it never
   proves `received`. Collapsing those is how a console ends up showing a green
   tick for a channel nobody is actually getting messages on.

   NOT EVERY RAIL CAN EVIDENCE EVERY STAGE
   ----------------------------------------
   Algolia has no notion of delivery. Firestore has no notion of acceptance
   separate from connection. IntaSend does not report "delivered" for a payment;
   it calls a webhook, which is `received`. So each integration DECLARES which
   stages it can evidence, and a stage it cannot evidence resolves to
   NOT-SUPPORTED — never to false, and never quietly to true.

   TRI-STATE VALUES ARE `true | false | null`, DELIBERATELY
   ---------------------------------------------------------
   `null` means unknown. It is used rather than a string like 'unknown' because
   every non-empty string is truthy in JavaScript: a consumer writing
   `if (r.delivered)` would read 'unknown' AS DELIVERED, which is the precise bug
   this module exists to prevent. `null` is falsy, so the careless check fails
   safe. There is a test asserting exactly that.

   WHAT A PROBE MAY NOT DO
   ------------------------
   Read, return or log a credential value. Charge money. Send to a real customer.
   Write to a business collection. Probes are diagnostics: they use dedicated
   probe addresses and sandbox operations, and their only persistent trace is a
   record under `integrationProbes/{correlationId}`.

   CORRELATION — WHY A PROBE OUTLIVES ITS REQUEST
   ------------------------------------------------
   For rails that report delivery asynchronously (SendGrid events, Africa's
   Talking delivery reports, IntaSend webhooks) the answer does not exist when
   the probe returns. The probe therefore mints a correlation id, records what it
   sent, and returns `delivered: null`. The provider's callback later calls
   recordProbeEvent() with that id, and only then does the stage become true.
   A callback that cannot be matched to an outstanding probe is REFUSED — it must
   not be able to satisfy a probe it did not originate from.
   ============================================================================ */
'use strict';

const registry = require('./integration-registry');

const STAGES = ['configured', 'connected', 'accepted', 'delivered', 'received'];

/* Evidence vocabulary — what actually established a stage. */
const EVIDENCE = {
  NONE:            'none',
  SECRET_PRESENCE: 'secret_presence',   /* RC-1: a credential exists. Nothing more. */
  SERVICE_ACCOUNT: 'service_account',   /* reached as the service account, no named key */
  PROVIDER_API:    'provider_api',      /* the provider answered us synchronously */
  PROVIDER_CALLBACK: 'provider_callback', /* the provider called US back, correlated */
};

/* ── STAGE SUPPORT ─────────────────────────────────────────────────────────
   Which stages each integration can EVIDENCE. Absent from this table means the
   integration has no probe at all: it still appears, with every runtime stage
   NOT-SUPPORTED and health `unknown`. That is an honest "we do not measure this
   yet" — never a failure, and never a green tick.

   `delivery` and `receipt` are separated on purpose:
     sendgrid        provider reports delivery via its event webhook  -> both
     africastalking  delivery report callback                          -> both
     fcm             accepts a message; per-device receipt is not generally
                     available to the sender                           -> accept only
     intasend-*      no "delivered"; the evidence is the webhook       -> receipt only
     algolia/typesense/redis/anthropic/firestore/storage
                     synchronous operations; delivery is meaningless   -> accept only
   ------------------------------------------------------------------------ */
const SUPPORT = {
  'intasend-collections': { connected: true, accepted: true, delivered: false, received: true,
    note: 'IntaSend reports payment state by webhook, not by a delivery receipt.' },
  'intasend-webhook':     { connected: false, accepted: false, delivered: false, received: true,
    note: 'Inbound only. The evidence that it works is a correlated inbound POST.' },
  /* Same shape as intasend-webhook, and for the same reason: there is nothing
     to call. Meta delivers to us, so the only evidence this rail works is a
     correlated inbound POST that passed signature verification. Declaring
     `connected` or `accepted` here would invite a probe that cannot exist. */
  'whatsapp-cloud-api':   { connected: false, accepted: false, delivered: false, received: true,
    note: 'Inbound only. Evidence is a signature-verified POST from Meta.' },
  'intasend-payouts':     { connected: true, accepted: true, delivered: false, received: true,
    note: 'A payout is accepted synchronously and settled asynchronously.' },
  'sendgrid':             { connected: true, accepted: true, delivered: true, received: true,
    note: 'SendGrid reports delivered/bounced/dropped through its event webhook.' },
  'smtp-fallback':        { connected: true, accepted: true, delivered: false, received: false,
    note: 'SMTP hands off to a relay; there is no delivery receipt to read.' },
  'africastalking':       { connected: true, accepted: true, delivered: true, received: true,
    note: 'Delivery reports arrive at smsDeliveryWebhook.' },
  'fcm':                  { connected: true, accepted: true, delivered: false, received: false,
    note: 'FCM accepts a message; per-device delivery receipt is not available to the sender.' },
  'algolia':              { connected: true, accepted: true, delivered: false, received: false },
  'typesense':            { connected: true, accepted: true, delivered: false, received: false },
  'memorystore-redis':    { connected: true, accepted: true, delivered: false, received: false },
  'anthropic':            { connected: true, accepted: true, delivered: false, received: false },
  'firestore':            { connected: true, accepted: true, delivered: false, received: false,
    note: 'Authenticates as the service account; connectivity IS the proof.' },
  'cloud-storage':        { connected: true, accepted: true, delivered: false, received: false },
  'etims':                { connected: true, accepted: true, delivered: false, received: false },
  'pos-webhooks':         { connected: false, accepted: true, delivered: true, received: true,
    note: 'Outbound to a merchant endpoint; the endpoint is the delivery evidence.' },
  'inventory-webhooks':   { connected: false, accepted: true, delivered: true, received: true },
};

/* A probe may only be run for an integration whose lifecycle permits it. A
   quarantined or frozen rail is NOT a failed rail: not probing it is the
   correct behaviour, and reporting it as failed would be a fabricated alarm. */
const NON_PROBEABLE_LIFECYCLES = ['quarantined', 'frozen'];

/* Executor error codes meaning THE PROBE DID NOT RUN, as opposed to the provider
   having failed. Owned here rather than imported so the semantics live with the
   stage model and not with the provider mechanics. */
const NOT_RUN_CODES = ['requires_secret_binding', 'no_safe_probe'];

function supportFor (id) {
  const s = SUPPORT[id];
  return {
    connected: !!(s && s.connected),
    accepted:  !!(s && s.accepted),
    delivered: !!(s && s.delivered),
    received:  !!(s && s.received),
    note:      (s && s.note) || null,
    hasProbe:  !!s,
  };
}

/* ── RESULT SHAPE ─────────────────────────────────────────────────────────── */
function emptyResult (id, extra) {
  return Object.assign({
    id,
    /* true | false | null. null is UNKNOWN and is deliberately falsy. */
    stages:  { configured: null, connected: null, accepted: null, delivered: null, received: null },
    /* 'supported' | 'not-supported' per runtime stage, so a consumer can tell
       "we cannot know" apart from "we do not know yet". */
    support: { connected: 'not-supported', accepted: 'not-supported',
               delivered: 'not-supported', received: 'not-supported' },
    health:  'unknown',
    healthKind: null,
    evidence: EVIDENCE.NONE,
    /* Explicitly null rather than absent. Persisted whole, an absent field lets
       a previous probe's refusal stand after a later probe that should have
       cleared it — the stale-field defect the legacy `{ merge: true }` write
       has today. */
    notRunReason: null,
    correlationId: null,
    detail:  null,
    checkedAt: new Date().toISOString(),
  }, extra || {});
}

/* ── HEALTH ───────────────────────────────────────────────────────────────
   Derived ONLY from what a probe established. It is never derived from whether
   a credential exists — that is `credentialState`, a different question, and
   conflating them is the RC-1 defect in a new costume.

     disabled   lifecycle says do not probe
     missing    required credentials absent, so a probe cannot be meaningful
     connected  the provider was reached and took the request
     degraded   reached, but an expected later stage did not hold
     failed     could not reach or the provider refused
     unknown    not measured
   ------------------------------------------------------------------------ */
function deriveHealth (r, opts) {
  const o = opts || {};
  if (o.lifecycle && NON_PROBEABLE_LIFECYCLES.indexOf(o.lifecycle) > -1) return 'disabled';
  if (o.credentialState === 'missing' || o.credentialState === 'partial') return 'missing';
  if (o.credentialState === 'unknown') return 'unknown';
  if (r.stages.connected === false || r.stages.accepted === false) return 'failed';
  /* A rail that accepted but whose SUPPORTED delivery stage came back false is
     degraded — reachable, not working. An unsupported or merely unknown stage
     must not drag it down. */
  if (r.support.delivered === 'supported' && r.stages.delivered === false) return 'degraded';
  if (r.support.received === 'supported' && r.stages.received === false) return 'degraded';
  if (r.stages.accepted === true || r.stages.connected === true) return 'connected';

  /* ── NOTHING WAS ESTABLISHED. WHICH "NOTHING"? ──────────────────────────
     Until now every unestablished integration collapsed into `unknown`, which
     conflated three materially different facts. The catalogue already drew the
     distinction in prose — "A legal obligation, not a polled service",
     "Edge state is read at Cloudflare, not here" — and healthKind makes it
     machine-readable.

     The two axes stay separate, and the order below is what keeps them so:
     everything ABOVE this point is what a probe ACTUALLY ESTABLISHED and wins
     outright. `healthKind` only decides how to describe the ABSENCE of an
     observation. An `elsewhere` rail that a probe genuinely reached still
     reports `connected`; it never becomes a success merely by being classified.

       not-applicable    health is not a meaningful concept for this capability
       observed-elsewhere a real signal exists, but authoritatively OUTSIDE this
                         console. NOT a success state — it says where to look.
       unknown           measurable here, simply not established yet

     `unknown` remains the default, deliberately. A kind that is absent,
     unrecognised, or 'measurable' all resolve to `unknown`, so a classification
     mistake understates certainty rather than silently claiming a capability
     cannot be measured. */
  if (o.healthKind === 'not-applicable') return 'not-applicable';
  if (o.healthKind === 'elsewhere')      return 'observed-elsewhere';
  return 'unknown';
}

/* ── CORRELATION ──────────────────────────────────────────────────────────── */
function mintCorrelationId (id, rand) {
  const r = rand || require('crypto').randomBytes(9).toString('hex');
  return 'probe_' + id + '_' + r;
}

/**
 * runProbe(integrationId, deps)
 *
 * `deps.execute` is the provider call, injected so this module never reaches a
 * network in a test and so each provider's client stays where it already lives.
 * It resolves { connected, accepted, detail } or throws.
 *
 * `deps.credentialState` and `deps.lifecycle` come from RC-1's status record —
 * this builds ON adminGetIntegrationStatus rather than re-deciding configuration.
 */
async function runProbe (integrationId, deps) {
  const d = deps || {};
  const result = await _runProbeCore(integrationId, d);

  /* ── THE MISSING JOINT (RC-4, Step B) ─────────────────────────────────────
     Until now a probe result existed only for the length of the request. It was
     written to `integrationProbeLatest` by admin-os.js — unvalidated, with
     `{ merge: true }` — and read back by nobody, so `resolveIntegrationStatus`
     was always called with an empty probe map and every integration stayed
     `unknown`. This is the producer's half of the connection.

     OPT-IN, DELIBERATELY. Persistence happens only when a caller supplies a
     store or asks for the default one. A probe is also run from suites and from
     the relationship census, and a module that reached Firestore merely because
     it was required would make those tests depend on a database — and would
     write evidence nobody asked to publish. */
  const wantsPersist = d.evidenceStore !== undefined || d.persistEvidence === true;
  if (wantsPersist) {
    const evidence = require('./integration-evidence');
    try {
      result.persisted = await evidence.writeEvidence(result, {
        store:       d.evidenceStore || undefined,
        recordedBy:  d.recordedBy || null,
        environment: d.environment,          /* undefined => declared, never inferred */
      });
    } catch (e) {
      /* A persistence failure must not turn a successful measurement into a
         failed probe. The observation stands; the fact that it could not be
         stored is reported alongside it, not substituted for it. */
      result.persisted = { written: false, refused: false,
        errors: [e && e.message ? String(e.message).slice(0, 200) : 'persist failed'], record: null };
    }
  }
  return result;
}

async function _runProbeCore (integrationId, deps) {
  const d = deps || {};
  const entry = registry.byId(integrationId);
  if (!entry) { const e = new Error('Unknown integration: ' + integrationId); e.code = 'unknown_integration'; throw e; }

  const sup = supportFor(integrationId);
  const result = emptyResult(integrationId, {
    healthKind: entry.healthKind || null,
    support: {
      connected: sup.connected ? 'supported' : 'not-supported',
      accepted:  sup.accepted  ? 'supported' : 'not-supported',
      delivered: sup.delivered ? 'supported' : 'not-supported',
      received:  sup.received  ? 'supported' : 'not-supported',
    },
    supportNote: sup.note,
  });

  /* configured is RC-1's answer, carried through — not recomputed here. */
  result.stages.configured =
    d.credentialState === 'configured' ? true
      : (d.credentialState === 'missing' || d.credentialState === 'partial') ? false
        : d.credentialState === 'not-applicable' ? true
          : null;

  /* Lifecycle veto. A frozen wallet is not a broken provider. */
  if (NON_PROBEABLE_LIFECYCLES.indexOf(entry.status) > -1) {
    result.health = 'disabled';
    result.detail = 'Lifecycle is ' + entry.status + '; no probe is run.';
    return result;
  }
  /* No credential, no meaningful probe — and this must stay distinguishable
     from a provider that was reached and refused. */
  if (d.credentialState === 'missing' || d.credentialState === 'partial') {
    result.health = 'missing';
    result.detail = 'Required credentials are not configured; provider not contacted.';
    return result;
  }
  if (!sup.hasProbe) {
    result.detail = 'No probe is defined for this integration yet.';
    /* Still classified, not blanket-unknown: a capability with no health concept
       says so even when no probe was ever written for it. */
    result.health = deriveHealth(result, { lifecycle: entry.status,
      credentialState: d.credentialState, healthKind: entry.healthKind });
    return result;
  }
  if (typeof d.execute !== 'function') {
    result.detail = 'No probe executor supplied.';
    return result;
  }

  try {
    const out = await d.execute({ integration: entry, correlationId: null }) || {};
    result.stages.connected = sup.connected ? (out.connected !== false) : null;
    result.stages.accepted  = sup.accepted  ? (out.accepted === true) : null;
    result.evidence = out.evidence || EVIDENCE.PROVIDER_API;
    result.detail   = out.detail ? String(out.detail).slice(0, 300) : null;

    /* ASYNCHRONOUS STAGES STAY NULL. The provider has not told us yet; a
       correlation id is minted so its callback can be matched later. Setting
       these from a synchronous 200 is the defect. */
    if (sup.delivered || sup.received) {
      result.correlationId = out.correlationId || mintCorrelationId(integrationId, d.rand);
    }
  } catch (e) {
    const code = e && e.code;
    /* A PROBE THAT COULD NOT RUN IS NOT A PROVIDER THAT FAILED.
       `requires_secret_binding` (the probe function does not hold that
       provider's credential) and `no_safe_probe` (probing would charge money or
       message a customer) mean nothing was measured. Recording those as false
       would put a red light on a rail nobody has tested — as misleading as a
       green one, and more likely to trigger a pointless key rotation. They stay
       null, and health stays `unknown`. */
    if (NOT_RUN_CODES.indexOf(code) > -1) {
      result.notRunReason = code;
      result.detail = e.message ? String(e.message).slice(0, 300) : code;
      result.health = deriveHealth(result, { lifecycle: entry.status,
        credentialState: d.credentialState, healthKind: entry.healthKind });
      return result;
    }
    result.stages.connected = sup.connected ? false : null;
    result.stages.accepted  = sup.accepted ? false : null;
    result.evidence = EVIDENCE.PROVIDER_API;
    /* The message is the provider's, truncated. A probe failure must never
       echo a credential, so nothing from the config is interpolated here. */
    result.detail = e && e.message ? String(e.message).slice(0, 300) : 'probe failed';
  }

  result.health = deriveHealth(result, { lifecycle: entry.status,
    credentialState: d.credentialState, healthKind: entry.healthKind });
  return result;
}

/**
 * recordProbeEvent(correlationId, event, store)
 *
 * Called by the inbound receivers (emailWebhook, smsDeliveryWebhook,
 * webhookIntasend) when a provider reports on something a probe sent.
 *
 * REFUSES an id that does not match an outstanding probe. A callback that can
 * satisfy a probe it did not originate from turns this whole mechanism into
 * decoration — anyone able to reach the webhook could mark a dead channel
 * healthy.
 */
async function recordProbeEvent (correlationId, event, store) {
  const ev = event || {};
  if (!correlationId || !/^probe_[a-z0-9-]+_[a-f0-9]{6,}$/.test(String(correlationId))) {
    return { matched: false, reason: 'malformed_correlation_id' };
  }
  const existing = store && typeof store.get === 'function' ? await store.get(correlationId) : null;
  if (!existing) return { matched: false, reason: 'no_outstanding_probe' };
  if (existing.integrationId && ev.integrationId && existing.integrationId !== ev.integrationId) {
    return { matched: false, reason: 'integration_mismatch' };
  }

  const stage = ev.stage === 'received' ? 'received' : 'delivered';
  const sup = supportFor(existing.integrationId);
  if (!sup[stage]) return { matched: false, reason: 'stage_not_supported' };

  const patch = {
    ['stages.' + stage]: ev.outcome === 'failed' ? false : true,
    evidence: EVIDENCE.PROVIDER_CALLBACK,
    eventAt: new Date().toISOString(),
  };
  if (store && typeof store.update === 'function') await store.update(correlationId, patch);
  return { matched: true, stage, outcome: patch['stages.' + stage], integrationId: existing.integrationId };
}

module.exports = {
  STAGES, EVIDENCE, SUPPORT, NON_PROBEABLE_LIFECYCLES, NOT_RUN_CODES,
  supportFor, runProbe, recordProbeEvent, deriveHealth, mintCorrelationId, emptyResult,
};
