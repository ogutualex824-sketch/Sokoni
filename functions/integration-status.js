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
  if (credentialState === 'configured') caps.push('test');       /* RC-3 wires the probe */
  if (entry.requiredSecrets.length) caps.push('view-credential-names');
  return caps;
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

  /* Latest probe result per integration id (RC-3). Absent until a probe has run;
     an absent probe leaves health 'unknown', never a failure. */
  const probes = o.latestProbes || {};

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
      capabilities: _capabilities(entry, credentialState),
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

module.exports = { resolveIntegrationStatus, _internal: { _capabilities, _defaultLister } };
