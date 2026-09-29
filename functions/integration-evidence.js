/* ============================================================================
   SOKONI Integration Evidence — functions/integration-evidence.js       (RC-4)
   ============================================================================
   Step B of the Evidence & Capability Model. This module owns ONE thing:

       the PERSISTENT record of what was actually observed about an integration

   RC-1 (integration-status.js) answers "is the credential configured?".
   RC-3 (integration-probes.js) answers "did the provider answer?" — but only for
   the few hundred milliseconds its result is in memory. This is the joint
   between them: the place a probe result goes so that the next status request
   can report it instead of `unknown`.

   WHY THIS MODULE EXISTS — THE MEASURED BREAK
   --------------------------------------------
   The Step A census established that health was `unknown` for all 47 entries not
   because probes fail, but because nothing connected the producer to the
   consumer. Step B's reading refines that in one material respect:

     a persistence collection DOES exist. admin-os.js writes
     `integrationProbeLatest/{integrationId}` after every probe. It has exactly
     ONE writer and ZERO readers — repository-wide, the only other mention is a
     CHANGELOG line. So the census's "nothing is persisted" was half right: the
     write happens; nothing ever reads it back, nothing validates it, and
     `resolveIntegrationStatus({})` is still called with an empty object.

   That legacy collection is deliberately NOT adopted here. It is written with
   `{ merge: true }` and no validation, so a field set by one probe survives a
   later probe that should have cleared it — `notRunReason` in particular would
   stick forever once written. Adopting it as-is would publish unvalidated,
   possibly stale evidence to the console. Migrating it is Step E's decision,
   with Step E's evidence; this module names it and leaves it alone.

   WHAT A RECORD MAY CLAIM
   ------------------------
   Everything here is written through validate(), which REFUSES rather than
   repairs. The rules are integrity rules, not shape rules — a record whose
   claims outrun its evidence is rejected:

     * a runtime stage cannot be `true` while `evidence` is `none`
     * a stage cannot be `true` for a stage the integration cannot evidence
     * health `connected` requires a stage that actually came back true
     * `notRunReason` must be one of the two codes that mean "did not run"

   A silently-coerced record is worse than a refused one: the console cannot tell
   a repaired claim from an observed one, and the whole point of this model is
   that it cannot flatter the evidence.

   ENVIRONMENT IS DECLARED, NEVER INFERRED
   ----------------------------------------
   `environment` is read from SOKONI_ENVIRONMENT, an explicit declaration, and is
   `null` when nothing declares it. It is NOT derived from the project id, the
   emulator host variables, or anything else that merely correlates with an
   environment. An inferred environment is a guess wearing a fact's clothing, and
   an operator reading "production" off a guess is exactly the failure this
   platform has already paid for elsewhere.

   SERVICE CAPABILITIES ARE A SEPARATE STRUCTURE, ON PURPOSE
   ----------------------------------------------------------
   `capabilities` ALREADY EXISTS on the status record and means UI AFFORDANCES —
   view / test / view-credential-names — and the console consumes it today.
   Business capabilities ("M-Pesa collections", "card checkout") live under
   `serviceCapabilities`. Reusing the existing name would silently redefine a
   field already in use, which is precisely the migration failure the slice brief
   guards against.

   `serviceCapabilities: null` means NOT MODELLED. An empty array would mean
   "modelled, and this integration has no capabilities" — a different fact. They
   are not collapsed, and nothing here populates them: Step B defines the
   structure, Step E fills it.
   ============================================================================ */
'use strict';

const registry = require('./integration-registry');
const probes   = require('./integration-probes');

/* The canonical collection. New, so that adopting it is a deliberate act and
   not an accident of an existing unvalidated write. */
const COLLECTION = 'integrationEvidence';

/* The legacy collection, named so it is not rediscovered as a surprise. NOT read
   by this module. Migration is Step E. */
const LEGACY_COLLECTION = 'integrationProbeLatest';

const SCHEMA_VERSION = 1;

const RUNTIME_STAGES = ['connected', 'accepted', 'delivered', 'received'];
const ALL_STAGES     = ['configured'].concat(RUNTIME_STAGES);

const EVIDENCE_VALUES = Object.keys(probes.EVIDENCE).map((k) => probes.EVIDENCE[k]);

/* The health vocabulary produced by deriveHealth(), enumerated rather than
   accepted open-ended: an unrecognised health string reaching the console maps
   through no chip and renders as nothing at all. */
const HEALTH_STATES = [
  'unknown', 'connected', 'degraded', 'failed', 'missing', 'disabled',
  'not-applicable', 'observed-elsewhere',
];

/* Environments SOKONI actually runs. `null` — undeclared — is a legitimate and
   distinct value, and is not a member of this list. */
const ENVIRONMENTS = ['production', 'staging', 'emulator'];

/* The states a single business capability may be in. Deliberately the evidence
   vocabulary, not a new taxonomy: observed / not observed / refused / unknown. */
const CAPABILITY_STATES = ['observed', 'unobserved', 'refused', 'not-applicable', 'unknown'];

/* ── ENVIRONMENT ───────────────────────────────────────────────────────────
   Declared or unknown. There is no third option and no fallback chain. */
function declaredEnvironment (env) {
  const raw = (env || process.env || {}).SOKONI_ENVIRONMENT;
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  return ENVIRONMENTS.indexOf(v) > -1 ? v : null;
}

/* ── NOT-RUN REASON WITHOUT A PROBE ────────────────────────────────────────
   The reason a probe will not run is a STATIC property of the executor table —
   IntaSend refuses because probing moves money, SendGrid refuses because the
   probe function does not hold its key. Neither fact requires a probe to have
   run, which is what makes REFUSED BY DESIGN reachable at all: a state derived
   only from the output of the thing that did not happen is unreachable by
   construction, and that is the defect Step A recorded as its third.

   'none' is NOT a not-run reason. An integration with no executor written yet is
   unmeasured, not refused, and calling that a refusal would claim a deliberate
   decision the platform has not actually made. */
function staticNotRunReason (integrationId) {
  let availability;
  try { availability = require('./integration-probe-executors').probeAvailability(integrationId); }
  catch (_) { return null; }   /* probe layer unavailable: claim nothing */
  return probes.NOT_RUN_CODES.indexOf(availability) > -1 ? availability : null;
}

/* ── TYPED ABSENCE ─────────────────────────────────────────────────────────
   WHY A MISSING RECORD IS NOT ONE FACT

   An integration with no evidence record can be in six materially different
   situations, and the whole return on keeping declaration and observation apart
   is that they stop rendering as one grey `unknown`:

     runnable-with-evidence      a probe runs; evidence can exist NOW
     inbound-awaiting-callback   no executor to call — evidence can arrive ONLY
                                 through a correlated inbound event
     declared-refusal            a probe exists and deliberately will not run
     measurable-unwritten        a probe COULD exist; none has been written
     not-applicable              health is not a meaningful concept here
     observed-elsewhere          a real signal exists, authoritatively elsewhere

   An architectural constraint, an unmeasured system, an inbound-only system and
   a genuine failure are four different reasons a record can be missing. Before
   this function the distinction lived only in prose, which means nothing would
   have gone red if the console ever collapsed them back.

   TOTAL AND MUTUALLY EXCLUSIVE BY CONSTRUCTION. One if/else chain, one return,
   no entry in two classes and none in none. The final branch is
   `measurable-unwritten` rather than a distinct "unclassified", deliberately: it
   agrees with deriveHealth(), which already resolves an absent or unrecognised
   healthKind to `unknown` — i.e. measurable-but-unestablished. A classification
   mistake therefore understates certainty rather than inventing a constraint,
   and the pinned partition counts in the suite catch it either way. */
const EVIDENCE_CLASSES = [
  'runnable-with-evidence',
  'inbound-awaiting-callback',
  'declared-refusal',
  'measurable-unwritten',
  'not-applicable',
  'observed-elsewhere',
];

function classifyEvidenceSource (integrationId) {
  const entry = registry.byId(integrationId);
  if (!entry) return null;          /* not a catalogue entry; not a class */

  let availability = 'none';
  try { availability = require('./integration-probe-executors').probeAvailability(integrationId); }
  catch (_) { /* probe layer unavailable: fall through on the declared kind */ }

  if (availability === 'runnable') return 'runnable-with-evidence';
  if (probes.NOT_RUN_CODES.indexOf(availability) > -1) return 'declared-refusal';

  /* No executor. A SUPPORT row means the rail nonetheless DECLARES stages it can
     evidence — which, with nothing to call, can only mean an inbound correlated
     event. intasend-webhook is the clearest case: there is no endpoint to probe,
     and its evidence is a POST arriving at recordProbeEvent(). */
  if (probes.SUPPORT[integrationId]) return 'inbound-awaiting-callback';

  if (entry.healthKind === 'not-applicable') return 'not-applicable';
  if (entry.healthKind === 'elsewhere')      return 'observed-elsewhere';
  return 'measurable-unwritten';
}

/* ── THE RECORD ────────────────────────────────────────────────────────────
   Built FROM a probe result, so the field names the resolver already reads —
   detail, support, checkedAt — are preserved verbatim and the record is a
   drop-in for the `latestProbes` shape. Nothing is renamed in transit; a rename
   between producer and consumer is how a field silently becomes undefined. */
function buildRecord (result, opts) {
  const o = opts || {};
  const r = result || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    integrationId: r.id || o.integrationId || null,

    /* Carried verbatim from the probe. */
    health:     r.health,
    healthKind: r.healthKind === undefined ? null : r.healthKind,
    stages:     r.stages,
    support:    r.support,
    evidence:   r.evidence,
    detail:     r.detail === undefined ? null : r.detail,
    correlationId: r.correlationId === undefined ? null : r.correlationId,
    checkedAt:  r.checkedAt,

    /* THE FIELD THE RESOLVER USED TO DROP. Explicitly null rather than absent,
       so a later write cannot leave a previous reason standing. */
    notRunReason: r.notRunReason === undefined ? null : r.notRunReason,

    /* Declared, never inferred. */
    environment: o.environment === undefined ? declaredEnvironment(o.env) : o.environment,

    /* null = NOT MODELLED. Step B does not populate these. */
    serviceCapabilities:
      o.serviceCapabilities === undefined ? null : o.serviceCapabilities,

    recordedAt: o.recordedAt || new Date().toISOString(),
    recordedBy: o.recordedBy || null,
  };
}

/* ── VALIDATION ────────────────────────────────────────────────────────────
   Returns { ok, errors }. REFUSES; never repairs. Every branch names the field,
   because a validation failure an operator cannot act on is a dead end. */
function validate (record) {
  const errors = [];
  const r = record || {};
  const push = (m) => errors.push(m);

  if (r.schemaVersion !== SCHEMA_VERSION) push('schemaVersion must be ' + SCHEMA_VERSION);

  if (!r.integrationId || !registry.byId(r.integrationId)) {
    push('integrationId is not a known registry entry: ' + String(r.integrationId));
  }

  if (HEALTH_STATES.indexOf(r.health) === -1) push('health is not a known state: ' + String(r.health));

  /* Stages: exactly the five keys, each strictly tri-state. A stage given as the
     STRING 'unknown' is refused — every non-empty string is truthy, so a
     consumer writing `if (stages.delivered)` would read it as delivered. */
  if (!r.stages || typeof r.stages !== 'object') push('stages is missing');
  else {
    ALL_STAGES.forEach((s) => {
      if (!(s in r.stages)) push('stages.' + s + ' is missing');
      else if (r.stages[s] !== true && r.stages[s] !== false && r.stages[s] !== null) {
        push('stages.' + s + ' must be true, false or null (got ' + JSON.stringify(r.stages[s]) + ')');
      }
    });
    Object.keys(r.stages).forEach((k) => {
      if (ALL_STAGES.indexOf(k) === -1) push('stages.' + k + ' is not a known stage');
    });
  }

  if (!r.support || typeof r.support !== 'object') push('support is missing');
  else {
    RUNTIME_STAGES.forEach((s) => {
      if (r.support[s] !== 'supported' && r.support[s] !== 'not-supported') {
        push('support.' + s + ' must be supported or not-supported');
      }
    });
  }

  if (EVIDENCE_VALUES.indexOf(r.evidence) === -1) push('evidence is not a known value: ' + String(r.evidence));

  if (r.notRunReason !== null && probes.NOT_RUN_CODES.indexOf(r.notRunReason) === -1) {
    push('notRunReason must be null or one of ' + probes.NOT_RUN_CODES.join('/'));
  }

  if (typeof r.checkedAt !== 'string' || isNaN(Date.parse(r.checkedAt))) {
    push('checkedAt must be an ISO timestamp');
  }

  if (r.environment !== null && ENVIRONMENTS.indexOf(r.environment) === -1) {
    push('environment must be null or one of ' + ENVIRONMENTS.join('/'));
  }

  if (r.serviceCapabilities !== null) {
    if (!Array.isArray(r.serviceCapabilities)) push('serviceCapabilities must be null or an array');
    else r.serviceCapabilities.forEach((c, i) => {
      const at = 'serviceCapabilities[' + i + ']';
      if (!c || typeof c !== 'object') { push(at + ' must be an object'); return; }
      if (!c.id) push(at + '.id is required');
      if (CAPABILITY_STATES.indexOf(c.state) === -1) push(at + '.state is not a known state: ' + String(c.state));
      if (c.state === 'observed' && !c.evidence) push(at + ' claims observed with no evidence');
    });
  }

  /* ── INTEGRITY: CLAIMS MUST NOT OUTRUN EVIDENCE ─────────────────────────
     Everything above is shape. These are the rules that make the record mean
     something. Each one describes a record that is well-formed and false. */
  if (r.stages && typeof r.stages === 'object') {
    const anyRuntimeTrue = RUNTIME_STAGES.some((s) => r.stages[s] === true);

    if (anyRuntimeTrue && r.evidence === probes.EVIDENCE.NONE) {
      push('a runtime stage is true but evidence is none — the claim has no source');
    }
    if (r.support && typeof r.support === 'object') {
      RUNTIME_STAGES.forEach((s) => {
        if (r.stages[s] === true && r.support[s] === 'not-supported') {
          push('stages.' + s + ' is true but this integration cannot evidence that stage');
        }
      });
    }
    if (r.health === 'connected' && !anyRuntimeTrue) {
      push('health is connected but no runtime stage came back true');
    }
    /* A probe that did not run cannot simultaneously have observed something.
       This is the rule that stops a refusal being laundered into a success. */
    if (r.notRunReason && anyRuntimeTrue) {
      push('notRunReason is set but a runtime stage is true — a probe that did not run observed nothing');
    }
  }

  return { ok: errors.length === 0, errors };
}

/* ── STORES ────────────────────────────────────────────────────────────────
   The store is an interface, not a database. Two implementations: the real
   Firestore one, resolved lazily so that requiring this module costs nothing and
   so the suite never reaches a network; and an in-memory one for tests.

   The collection is written by the Admin SDK, which bypasses security rules
   entirely, and is never read by a client. It therefore needs no rules entry:
   Firestore has no global catch-all, so an unlisted path is default-deny for
   every client. Adding a rule would widen access, not protect it. */
function memoryStore (seed) {
  const docs = Object.assign({}, seed || {});
  return {
    kind: 'memory',
    async get (id) { return docs[id] ? JSON.parse(JSON.stringify(docs[id])) : null; },
    async set (id, record) { docs[id] = JSON.parse(JSON.stringify(record)); return true; },
    async list () { return Object.keys(docs).map((k) => JSON.parse(JSON.stringify(docs[k]))); },
    _docs: docs,
  };
}

let _firestoreStore = null;
function firestoreStore () {
  if (_firestoreStore) return _firestoreStore;
  /* Required inside the function, not at module load: admin.firestore is a
     PROTOTYPE GETTER and resolving it at require-time binds before initializeApp. */
  const admin = require('firebase-admin');
  const col = () => admin.firestore().collection(COLLECTION);
  _firestoreStore = {
    kind: 'firestore',
    async get (id) { const s = await col().doc(id).get(); return s.exists ? s.data() : null; },
    /* set(), NOT set({merge:true}). A merge leaves a field from the previous
       probe standing when the current one should have cleared it — which is
       exactly how the legacy collection can report a stale notRunReason
       forever. The record is written whole or not at all. */
    async set (id, record) { await col().doc(id).set(record); return true; },
    async list () { const s = await col().get(); return s.docs.map((d) => d.data()); },
  };
  return _firestoreStore;
}

/* ── WRITE ─────────────────────────────────────────────────────────────────
   The only way evidence becomes persistent. Refuses an invalid record and
   returns the reasons; it does not throw, because a probe that produced a record
   this module will not accept is a reportable condition, not a crash. */
async function writeEvidence (result, opts) {
  const o = opts || {};
  const record = buildRecord(result, o);
  const v = validate(record);
  if (!v.ok) return { written: false, refused: true, errors: v.errors, record: null };

  const store = o.store || firestoreStore();
  await store.set(record.integrationId, record);
  return { written: true, refused: false, errors: [], record };
}

/* ── READ ──────────────────────────────────────────────────────────────────
   Returns the `latestProbes` shape the resolver already expects: a map keyed by
   integration id. A record that no longer validates is DROPPED and counted, not
   rendered — evidence that has since become invalid (a registry entry retired, a
   schema moved on) must not reach an operator as though it were observed.

   An unreadable store yields an EMPTY map and an error, never a fabricated one.
   Absent evidence leaves health `unknown`, exactly as today. */
async function readLatestEvidence (opts) {
  const o = opts || {};
  const out = { records: {}, readable: true, error: null, dropped: [] };
  let rows;
  try {
    const store = o.store || firestoreStore();
    rows = await store.list();
  } catch (e) {
    out.readable = false;
    out.error = e && e.message ? String(e.message).slice(0, 200) : 'evidence store unavailable';
    return out;
  }
  (rows || []).forEach((r) => {
    const v = validate(r);
    if (!v.ok) { out.dropped.push({ integrationId: r && r.integrationId, errors: v.errors }); return; }
    out.records[r.integrationId] = r;
  });
  return out;
}

module.exports = {
  COLLECTION, LEGACY_COLLECTION, SCHEMA_VERSION,
  HEALTH_STATES, ENVIRONMENTS, CAPABILITY_STATES, RUNTIME_STAGES, ALL_STAGES,
  EVIDENCE_CLASSES, classifyEvidenceSource,
  declaredEnvironment, staticNotRunReason,
  buildRecord, validate, writeEvidence, readLatestEvidence,
  memoryStore, firestoreStore,
};
