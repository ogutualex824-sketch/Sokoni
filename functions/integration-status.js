/* ============================================================================
   SOKONI Integration Status — functions/integration-status.js        (RC-1)
   ============================================================================
   Answers ONE question, for all 35 registry entries at once:

       is the credential this integration needs CONFIGURED?

   and nothing else. It does not judge whether a provider works. That is a
   separate concern with a separate source (RC-3), and inferring "healthy" from
   "a key exists" is the defect this surface already suffers from — 32 of 35
   catalogue entries have no health source, so every one of them would otherwise
   be rendered from configuration alone.

   WHY THE CONTROL CENTER COULD NOT SHOW THIS BEFORE
   -------------------------------------------------
   Nothing in the deployed backend read Secret Manager inventory, so the browser
   had no signal to render. The catalogue's `evidence.secrets` is documentation,
   not a check. Every key was in fact present — the surface simply could not say
   so, which reads to an operator as "missing".

   HOW PRESENCE IS ESTABLISHED WITHOUT TOUCHING A VALUE
   -----------------------------------------------------
   secretmanager.googleapis.com `secrets.list` returns secret NAMES and metadata.
   It does not return payloads — the payload lives behind
   `secrets.versions.access`, which this module NEVER calls and must never call.

   So this function holds no credential at any moment: it binds no secret, it
   declares no `secrets: []`, and nothing it returns or logs derives from a
   secret's contents. A status endpoint that bound every production secret in
   order to report on them would have the blast radius of the whole estate; this
   one has none.

     list names  -> compare against the registry's requiredSecrets -> booleans

   VOCABULARY — these six states are the contract
   -----------------------------------------------
     configured      every required credential is present
     partial         some present, some absent  (a real, distinct state)
     missing         a required credential is absent
     not-applicable  the integration needs no named secret — Firestore, FCM and
                     the rest authenticate as the service account. NOT a gap.
     disabled        the registry marks it quarantined or frozen
     unknown         the inventory could not be read

   `unknown` is deliberately NOT collapsed into `missing`. A credential that is
   absent and an inventory that could not be read are different facts, and
   reporting the second as the first is how an operator ends up re-creating a key
   that was already there.

   HEALTH COMES FROM A PROBE, OR IT IS `unknown`   (RC-3)
   -------------------------------------------------------
   Health is never derived from `credentialState`. A configured key says nothing
   about whether the provider answers, and conflating the two is the very defect
   this surface already suffers from.

   RC-3 supplies `latestProbes` — the most recent probe result per integration —
   and this module carries its health and its five-stage evidence through
   verbatim. With no probe supplied, which is the state until one has ever run,
   every record stays `unknown`. An absent probe is not a failure, and this
   module still measures nothing itself: it reports what
   functions/integration-probes.js established, or it says it does not know.
   ============================================================================ */
'use strict';

const registry = require('./integration-registry');

const SECRET_HOST = 'https://secretmanager.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/* Resolved lazily so requiring this module costs nothing and so a test can
   substitute a lister without any network or credential at all. */
let _authClient = null;
async function _defaultLister (projectId) {
  const { GoogleAuth } = require('google-auth-library');
  if (!_authClient) _authClient = await new GoogleAuth({ scopes: [SCOPE] }).getClient();
  const names = [];
  let pageToken;
  do {
    const url = SECRET_HOST + '/v1/projects/' + encodeURIComponent(projectId) +
                '/secrets?pageSize=200' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    /* LIST, never ACCESS. This URL returns names and metadata; it cannot return
       a payload. If this line is ever changed to :access, the suite fails. */
    const res = await _authClient.request({ url, method: 'GET' });
    (res.data.secrets || []).forEach((s) => {
      const n = String(s.name || '');
      names.push(n.slice(n.lastIndexOf('/') + 1));
    });
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return names;
}

function _projectId () {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'sokoni-aeb26';
}

/* What an operator may do with an integration from the Control Center. Actions
   name the INTEGRATION, never a credential: nothing here can read, write, rotate
   or reveal a secret, and no management action takes a secret as an argument. */
function _capabilities (entry, credentialState) {
  const caps = ['view'];
  if (entry.status === 'quarantined' || entry.status === 'frozen') return caps;
  /* A test is offered only when a probe would ACTUALLY RUN. Keying this on
     "credentials are configured" offered a test control for every configured
     rail — including IntaSend, whose probe refuses by design because probing
     would move money, and the seven whose probe cannot run until their provider
     secret is bound to the probe function. A control an operator can press that
     can never succeed is worse than no control: it reads as a capability the
     platform does not have. Found by rendering the page in a browser. */
  /* `not-applicable` is included deliberately: Firestore and Cloud Storage need
     no named secret and their probes are the ones that actually run. Requiring
     'configured' would have withheld the test control from precisely the three
     rails where it works. What must be excluded is `missing`/`partial`, where a
     probe cannot be meaningful. */
  const credOk = credentialState === 'configured' || credentialState === 'not-applicable';
  if (credOk && _probeRunnable(entry.id)) caps.push('test');
  if (entry.requiredSecrets.length) caps.push('view-credential-names');
  return caps;
}

/* Resolved lazily and defensively: the status surface must keep working even if
   the probe layer is unavailable, and in that case it simply offers no test. */
function _probeRunnable (id) {
  try { return require('./integration-probe-executors').probeAvailability(id) === 'runnable'; }
  catch (_) { return false; }
}

/* The declared reason a probe will not run, independent of any probe having run.
   Same defensive posture: if the evidence layer cannot be loaded, claim nothing
   rather than claim a refusal. */
function _staticNotRunReason (id) {
  try { return require('./integration-evidence').staticNotRunReason(id); }
  catch (_) { return null; }
}

/* What the EXECUTOR TABLE declares about this rail, present tense. */
function _declaredProbeState (id) {
  try { return require('./integration-probe-executors').probeAvailability(id); }
  catch (_) { return 'none'; }
}

/* ── DISAGREEMENT BETWEEN DECLARATION AND OBSERVATION ───────────────────────
   The ratified Step E matrix, computed rather than described.

   WHY THIS EXISTS. A declaration is present tense and carries no timestamp: it
   says what will happen if you press the button now. An observation is past
   tense and carries one: it says what happened last time. Rendering both
   through a single `notRunReason` made two of the six combinations invisible —
   a rail declared `requires_secret_binding` whose probe then SUCCEEDED reported
   exactly like a healthy `runnable` rail, because the successful probe's null
   reason overwrote the declaration. The stale declaration, and the money-rail
   tripwire, were unreachable by construction.

   The two sources are therefore kept apart and COMPARED. The comparison is what
   neither source can produce alone.

     declared                observed                  state
     ----------------------  ------------------------  --------------------
     no_safe_probe           nothing                   expected-refusal
     no_safe_probe           ANY observation           safety-tripwire
     requires_secret_binding no successful observation declared-current
     requires_secret_binding a successful observation  stale-declaration
     runnable                requires_secret_binding   binding-regression
     runnable                a successful observation  verified-evidence

   `safety-tripwire` keys on ANY observation, not on a successful one. The rails
   that declare `no_safe_probe` are IntaSend collections and payouts: probing
   them moves money. That a probe ran at all is the alarm; whether it succeeded
   is a detail.

   Combinations outside those six — a `runnable` rail nobody has probed, or a
   rail with no executor at all — return null. That is deliberate: the matrix is
   the ratified target, and inventing a seventh state here would be exactly the
   unratified taxonomy this model keeps refusing to grow. The suite asserts
   which combinations return null, so the gap is stated rather than latent. */
const DISAGREEMENT_SEVERITY = {
  'expected-refusal':   'ok',
  'declared-current':   'ok',
  'verified-evidence':  'ok',
  'stale-declaration':  'action',
  'binding-regression': 'action',
  'safety-tripwire':    'tripwire',
};

function _disagreement (declared, probe) {
  const observed = !!probe;
  const observedNotRun = probe ? (probe.notRunReason || null) : null;
  const s = (probe && probe.stages) || {};
  /* "Successful" means a stage actually came back true. A probe that ran and
     established nothing is not a success, and must not retire a declaration. */
  const succeeded = s.connected === true || s.accepted === true ||
                    s.delivered === true || s.received === true;

  let state = null;
  if (declared === 'no_safe_probe') {
    state = observed ? 'safety-tripwire' : 'expected-refusal';
  } else if (declared === 'requires_secret_binding') {
    state = succeeded ? 'stale-declaration' : 'declared-current';
  } else if (declared === 'runnable') {
    if (observedNotRun === 'requires_secret_binding') state = 'binding-regression';
    else if (succeeded) state = 'verified-evidence';
  }
  if (!state) return null;

  return {
    state,
    severity: DISAGREEMENT_SEVERITY[state],
    declared,
    observed: observed ? (observedNotRun || (succeeded ? 'successful-probe' : 'probe-without-result')) : null,
    note: {
      'expected-refusal':   'A probe exists and deliberately will not run. Nothing has run.',
      'declared-current':   'The declared reason still holds; no successful probe contradicts it.',
      'verified-evidence':  'The rail is declared runnable and a probe established it.',
      'stale-declaration':  'Declared as unable to run, but a probe SUCCEEDED — the declaration is out of date.',
      'binding-regression': 'Declared runnable, but a probe reported it cannot run — the binding regressed.',
      'safety-tripwire':    'A probe ran against a rail declared unsafe to probe. Investigate: probing this rail moves money.',
    }[state],
  };
}

/**
 * resolveIntegrationStatus({ listSecretNames })
 *
 * `listSecretNames` is injectable so the suite can execute this exact function
 * against a controlled inventory. Production passes nothing and gets the real
 * lister above.
 *
 * Returns one record per registry entry — always all 35, never a filtered
 * subset, because an integration omitted from the response is indistinguishable
 * in the console from one that does not exist.
 */
async function resolveIntegrationStatus (opts) {
  const o = opts || {};
  const checkedAt = new Date().toISOString();

  let present = null;
  let inventoryError = null;
  try {
    const lister = o.listSecretNames || _defaultLister;
    const names = await lister(_projectId());
    present = new Set(names);
  } catch (e) {
    /* FAIL CLOSED INTO `unknown`, NOT INTO `missing`. Reporting an unreadable
       inventory as an absent credential invites someone to re-create a key that
       is already there. The message is recorded; no secret name is invented. */
    inventoryError = e && e.message ? String(e.message).slice(0, 200) : 'inventory unavailable';
  }

  /* ── LATEST EVIDENCE PER INTEGRATION (RC-3 producer, RC-4 persistence) ────
     `latestProbes` stays injectable — the suite passes a controlled map, and an
     explicit map always wins. What changed in Step B is the DEFAULT. It used to
     be `{}`, unconditionally, which is why health was `unknown` for all 47: the
     probe layer produced results and no caller ever passed them back in.

     The default is now the persistent evidence store. Absent evidence still
     yields an empty map and leaves health `unknown` — reading a store that
     nothing has written yet changes nothing, which is exactly the property that
     makes this safe to land before any migration.

     An unreadable store is reported, never fabricated: `evidenceReadable` goes
     false and every record stays `unknown`, the same failure posture the secret
     inventory already takes. */
  let probes = o.latestProbes || null;
  let evidenceReadable = true;
  let evidenceError = null;
  let evidenceDropped = [];
  if (!probes) {
    try {
      const store = require('./integration-evidence');
      const read = await store.readLatestEvidence({ store: o.evidenceStore });
      probes = read.records;
      evidenceReadable = read.readable;
      evidenceError = read.error;
      evidenceDropped = read.dropped;
    } catch (e) {
      /* The evidence layer being unavailable must not take the credential
         surface down with it. RC-1's answer is independent and still correct. */
      probes = {};
      evidenceReadable = false;
      evidenceError = e && e.message ? String(e.message).slice(0, 200) : 'evidence unavailable';
    }
  }

  const integrations = registry.INTEGRATIONS.map((entry) => {
    const probe = probes[entry.id] || null;
    const required = entry.requiredSecrets || [];

    /* Per-credential presence. The NAME is returned — it is already in the
       committed catalogue and is not sensitive — and a boolean. Never a value,
       never a length, never a prefix, never a hash. */
    const credentials = required.map((name) => ({
      name,
      present: present ? present.has(name) : null,
    }));

    let credentialState;
    if (inventoryError)              credentialState = 'unknown';
    else if (!required.length)       credentialState = 'not-applicable';
    else if (credentials.every((c) => c.present))      credentialState = 'configured';
    else if (credentials.some((c) => c.present))       credentialState = 'partial';
    else                                               credentialState = 'missing';

    const disabled = entry.status === 'quarantined' || entry.status === 'frozen';

    return {
      id:         entry.id,
      name:       entry.name,
      vendor:     entry.vendor,
      category:   entry.category,
      lifecycle:  entry.status,
      direction:  entry.direction,
      credentials,
      credentialState: disabled ? 'disabled' : credentialState,

      /* ── HEALTH COMES FROM A PROBE, OR IT IS UNKNOWN (RC-3) ─────────────
         Never from credentialState. A configured key says nothing about
         whether the provider answers, and conflating the two is the RC-1
         defect wearing a different hat.

         `probes` is a map of the latest probe result per integration. With
         none supplied — which is the state until a probe has ever run — every
         record stays `unknown`, exactly as RC-1 left it. An absent probe is
         not a failure. */
      health:     probe ? probe.health : 'unknown',
      healthNote: probe
        ? (probe.detail || null)
        : 'No probe has run for this integration; provider health is not measured.',
      /* The five-stage evidence, carried verbatim from the probe. Stage values
         are true | false | null, where null is UNKNOWN and is deliberately
         falsy so `if (r.stages.delivered)` cannot read unknown as delivered. */
      stages:      probe ? probe.stages : null,
      stageSupport: probe ? probe.support : null,
      evidence:    probe ? probe.evidence : 'none',
      probedAt:    probe ? probe.checkedAt : null,

      /* ── WHY A PROBE DID NOT RUN (RC-4) ───────────────────────────────────
         This field was produced by integration-probes.js and DROPPED here, and
         the console keys REFUSED BY DESIGN on it — so the state was unreachable
         in production no matter how many probes ran. Carrying it is the third of
         the three defects Step A separated.

         It resolves in two ways, and the second is the one that matters. With a
         probe, the probe's own reason wins: it is what actually happened. With
         NO probe, the reason still exists, because "IntaSend refuses because
         probing would move money" and "SendGrid's key is not bound to the probe
         function" are static properties of the executor table, true before
         anything runs. A state derived only from the output of the thing that
         did not happen can never be reached; derived from the declaration, it
         is reachable for the nine rails that genuinely refuse.

         A rail with no executor written yet resolves to null — unmeasured, not
         refused. Calling that a refusal would claim a deliberate decision the
         platform has not made. */
      notRunReason: probe
        ? (probe.notRunReason || null)
        : _staticNotRunReason(entry.id),

      /* ── DECLARATION AND OBSERVATION, KEPT APART ────────────────────────
         `notRunReason` above stays exactly as it was, because the console
         renders REFUSED BY DESIGN from it and that contract is not this
         slice's to change. These two are additive, and they are what make the
         six disagreement states computable:

           declaredProbeState   present tense, from the executor table. True
                                before anything runs and never stale.
           observedNotRunReason past tense, from persisted evidence, with
                                `probedAt` as its timestamp. null when nothing
                                has been observed — which is NOT the same as a
                                probe that ran and had no reason to refuse.

         Collapsing them is what hid the stale declaration and the tripwire. */
      declaredProbeState:   _declaredProbeState(entry.id),
      observedNotRunReason: probe ? (probe.notRunReason || null) : null,
      evidenceDisagreement: _disagreement(_declaredProbeState(entry.id), probe),

      /* Declared by the evidence record, or unknown. Never inferred from the
         project id or from which host this happens to be running on. */
      environment: probe ? (probe.environment === undefined ? null : probe.environment) : null,

      /* UI affordances — view / test / view-credential-names. NOT business
         capabilities; see `serviceCapabilities` below. Unchanged by Step B. */
      capabilities: _capabilities(entry, credentialState),

      /* Business capabilities, a SEPARATE structure from `capabilities` above.
         `null` means NOT MODELLED — distinct from `[]`, which would mean
         modelled and empty. Step B defines the field; nothing populates it yet,
         so every record reads null and no consumer can mistake an unfilled
         model for an observed absence of capability. */
      serviceCapabilities: probe
        ? (probe.serviceCapabilities === undefined ? null : probe.serviceCapabilities)
        : null,

      checkedAt,
    };
  });

  const counts = integrations.reduce((m, i) => {
    m[i.credentialState] = (m[i.credentialState] || 0) + 1; return m;
  }, {});

  return {
    version:    registry.VERSION,
    checkedAt,
    categories: registry.CATEGORIES,
    integrations,
    counts,
    inventoryReadable: !inventoryError,
    inventoryError,
    /* Reported separately from the secret inventory, because they are different
       sources that fail independently and collapsing them would tell an operator
       to go and look in the wrong place. `evidenceDropped` names records that
       were persisted but no longer validate — they are withheld from the
       response, and a silent drop is indistinguishable from "never probed". */
    evidenceReadable,
    evidenceError,
    evidenceDropped,

    /* ── THE ACTIONABLE DISAGREEMENTS, HOISTED ──────────────────────────────
       A per-record field an operator has to go looking for is a field nobody
       finds. A safety tripwire on a money rail cannot depend on somebody
       scrolling 52 rows, so the states that need acting on are collected here:
       `safety-tripwire`, `stale-declaration`, `binding-regression`.

       The `ok` states — expected-refusal, declared-current, verified-evidence —
       are deliberately NOT hoisted. They are on their records, where they
       belong; putting them here too would make this list a second copy of the
       response rather than a queue of things to do. An empty array means no rail
       disagrees with its declaration, which is the normal, quiet state. */
    disagreements: integrations
      .filter((i) => i.evidenceDisagreement && i.evidenceDisagreement.severity !== 'ok')
      .map((i) => ({
        id: i.id, name: i.name,
        state:    i.evidenceDisagreement.state,
        severity: i.evidenceDisagreement.severity,
        declared: i.evidenceDisagreement.declared,
        observed: i.evidenceDisagreement.observed,
        note:     i.evidenceDisagreement.note,
        probedAt: i.probedAt,
      })),
    /* Orphans are reported as a COUNT only. Naming a configured secret that no
       integration claims would turn this response into a map of the estate's
       credentials for anyone who reaches it. The count is enough to tell an
       operator reconciliation is owed. */
    unclaimedSecretCount: present
      ? [...present].filter((n) => !registry.INTEGRATIONS.some(
          (e) => (e.requiredSecrets || []).indexOf(n) > -1)).length
      : null,
  };
}

module.exports = { resolveIntegrationStatus,
  _internal: { _capabilities, _defaultLister, _staticNotRunReason,
    _declaredProbeState, _disagreement, DISAGREEMENT_SEVERITY } };
