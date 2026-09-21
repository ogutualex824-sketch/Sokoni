/* ══════════════════════════════════════════════════════════════════════════════
   GCP EVIDENCE READER — functions/gcp-evidence.js                          v1.0.0
   ══════════════════════════════════════════════════════════════════════════════
   The server-side reader behind the AdminOS GCP control plane. It answers, from
   the Google Cloud APIs themselves, the questions no browser can:

     • which Firestore databases exist, in which region, of which type
     • how many composite indexes each has, and how many are actually READY
     • how many ROOT COLLECTIONS each database contains
     • how close each database is to the live composite-index quota

   WHY THIS EXISTS
   ---------------
   The Integrations console renders an em dash for every one of those, because a
   client SDK cannot obtain them: it cannot enumerate collections, it cannot see
   index state, and it cannot read a database's region. An em dash is the honest
   answer from a browser. It is NOT the honest answer from a server, which can
   simply ask — and "not measured" where a measurement was available is its own
   kind of defect.

   THE ONE RULE
   ------------
   Every field is an OBSERVATION, never a bare value:

       { value, state, source, observedAt, reason }

   A read that fails produces state 'unreadable' and a reason. It never produces
   a zero. A read that succeeds and finds nothing produces state 'empty' with
   value 0 — a MEASURED zero, which is a real finding and must look different
   from an unmeasured one. Nothing in this module invents, estimates, defaults
   or carries forward a value.

   READ-ONLY BY CONSTRUCTION
   -------------------------
   Every call is a GET, or one of exactly two POSTs that Google requires for
   reads which take a request body:

     documents:listCollectionIds   enumerates root collections
     :getIamPolicy                 returns the policy. Its WRITE twin is
                                   :setIamPolicy, which appears nowhere here

   POST is not a write in either case. There is no create, update, patch or
   delete path in this file. Certification asserts the POST ENDPOINTS against an
   allowlist — not merely a count, which would pass for a POST to anything — and
   asserts the explicit absence of every mutating twin, with a positive control.

   IT BINDS NO SECRET
   ------------------
   Authentication is Application Default Credentials — the function's own
   service account, via the metadata server. No key is read, held or passed. The
   token is an access token minted for read-only scopes and is never logged,
   never returned and never persisted.

   DEPLOYMENT STATE
   ----------------
   Writing this module is authorized. DEPLOYING it is a separate decision that
   this file does not take and must not be read as having taken. Until it is
   deployed, the console's GCP panel renders 'not-attempted' with the reason
   that the reader is not deployed — which is accurate, and is different from
   both zero and failure.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const https = require('https');

const PROJECT   = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'sokoni-aeb26';
const DATABASES = ['(default)', 'sokoni-ops'];

/* How long an observation stays fresh. Mirrors the console's STALE_MS so the two
   never disagree about the same reading. If one moves, move the other in the
   same commit. */
const STALE_MS = 300000;

/* Read-only scope. `cloud-platform.read-only` cannot mutate anything even if a
   caller tried, so the blast radius is bounded by the token, not only by the
   code paths in this file. */
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only';

/* ── OBSERVATION STATES ───────────────────────────────────────────────────────
   Deliberately six, and deliberately not collapsible into one another.

     observed        a read succeeded and the value is real
     empty           a read succeeded and genuinely found nothing. value is 0.
                     A MEASURED zero — a finding, not an absence of one
     unreadable      a read failed. reason names it. There is NO value
     not-attempted   no read was made. Nothing is known
     not-applicable  the question does not apply to this subject
     stale           observed, but older than the freshness window
   ────────────────────────────────────────────────────────────────────────── */
const STATES = ['observed', 'empty', 'unreadable', 'not-attempted', 'not-applicable', 'stale'];

function observation (value, source) {
  const empty = value === 0 || value === null ||
                (Array.isArray(value) && value.length === 0);
  return {
    value,
    state: empty && value !== null ? 'empty' : (value === null ? 'not-attempted' : 'observed'),
    source: source || null,
    observedAt: new Date().toISOString(),
    reason: '',
  };
}

function unreadable (source, reason) {
  return { value: null, state: 'unreadable', source: source || null,
           observedAt: new Date().toISOString(),
           reason: String(reason || 'The read did not complete.') };
}

function notAttempted (reason) {
  return { value: null, state: 'not-attempted', source: null,
           observedAt: null, reason: String(reason || 'No read was attempted.') };
}

function notApplicable (reason) {
  return { value: null, state: 'not-applicable', source: null,
           observedAt: null, reason: String(reason || 'Does not apply.') };
}

/** An observation is stale when it is older than the window. Applied at READ
    time by the consumer, not baked in here — a reading does not become stale
    because it sat in a variable. */
function withFreshness (obs, now) {
  if (!obs || obs.state !== 'observed' || !obs.observedAt) return obs;
  const age = (now || Date.now()) - Date.parse(obs.observedAt);
  if (age > STALE_MS) return Object.assign({}, obs, { state: 'stale' });
  return obs;
}

/* ── TRANSPORT ──────────────────────────────────────────────────────────────
   Injectable in full. Certification drives this module against scripted
   responses; nothing in the test path opens a socket. */
function httpsJson (opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(b || '{}'); }
        catch (e) { return reject(new Error('Malformed response from ' + opts.host)); }
        /* A Google API error arrives with HTTP 200 in some paths and a body
           error in others. Both are failures and neither may be read as data. */
        if (j.error) return reject(new Error(j.error.message || 'API error'));
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        resolve(j);
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/** Application Default Credentials, via the metadata server. No key material. */
function adcToken () {
  return httpsJson({
    host: 'metadata.google.internal',
    path: '/computeMetadata/v1/instance/service-accounts/default/token?scopes=' +
          encodeURIComponent(SCOPE),
    headers: { 'Metadata-Flavor': 'Google' },
    method: 'GET',
  }).then((j) => {
    if (!j.access_token) throw new Error('The metadata server returned no access token.');
    return j.access_token;
  });
}

/* ── READERS ────────────────────────────────────────────────────────────────
   Each returns raw data or throws. Turning a throw into an observation is the
   caller's job, so a failure can never be silently smoothed into a value. */

function listDatabases (get) {
  return get({ host: 'firestore.googleapis.com',
               path: '/v1/projects/' + PROJECT + '/databases' })
    .then((j) => j.databases || []);
}

function listIndexes (get, db) {
  return get({ host: 'firestore.googleapis.com',
               path: '/v1/projects/' + PROJECT + '/databases/' +
                     encodeURIComponent(db) + '/collectionGroups/-/indexes' })
    .then((j) => j.indexes || []);
}

/** Root collection ids. This is the ONE thing a browser fundamentally cannot
    do, and the reason a client must render an em dash where this renders a
    number. An empty list here is a MEASURED zero. */
function listRootCollections (post, db) {
  return post({ host: 'firestore.googleapis.com',
                path: '/v1/projects/' + PROJECT + '/databases/' +
                      encodeURIComponent(db) + '/documents:listCollectionIds' },
              { pageSize: 500 })
    .then((j) => j.collectionIds || []);
}

/** The live composite-index quota. NEVER hardcoded: a hardcoded "200" was wrong
    for months here and drove index deletions and a migration that were never
    needed. If the quota cannot be read, that is 'unreadable', not a guess. */
function readIndexQuota (get) {
  return get({ host: 'serviceusage.googleapis.com',
               path: '/v1beta1/projects/' + PROJECT +
                     '/services/firestore.googleapis.com/consumerQuotaMetrics' })
    .then((j) => {
      for (const m of j.metrics || []) {
        if (!/composite index/i.test(m.displayName || '')) continue;
        for (const l of m.consumerQuotaLimits || []) {
          for (const b of l.quotaBuckets || []) {
            const v = Number(b.effectiveLimit);
            if (Number.isFinite(v) && v > 0) return v;
          }
        }
      }
      throw new Error('The quota API did not report a composite-index limit.');
    });
}

/* ── COMPOSITION ────────────────────────────────────────────────────────────── */

/** Everything known about one database. Each field observes independently, so a
    single failing read degrades ONE field rather than the whole subject. */
async function readDatabase (get, post, dbId, dbMeta) {
  const out = { id: dbId };

  if (dbMeta) {
    out.region = observation(dbMeta.locationId || null, 'firestore.databases.get');
    out.type   = observation(dbMeta.type || null, 'firestore.databases.get');
    /* Deletion protection and concurrency mode are real operational facts. */
    out.deleteProtection = observation(dbMeta.deleteProtectionState || null, 'firestore.databases.get');
  } else {
    const why = 'This database was not returned by databases.list.';
    out.region = unreadable('firestore.databases.list', why);
    out.type   = unreadable('firestore.databases.list', why);
    out.deleteProtection = unreadable('firestore.databases.list', why);
  }

  try {
    const ix = await listIndexes(get, dbId);
    const ready = ix.filter((i) => i.state === 'READY').length;
    const byState = {};
    ix.forEach((i) => { byState[i.state || 'UNKNOWN'] = (byState[i.state || 'UNKNOWN'] || 0) + 1; });
    out.indexesDeployed = observation(ix.length, 'firestore.indexes.list');
    out.indexesReady    = observation(ready, 'firestore.indexes.list');
    out.indexStates     = observation(byState, 'firestore.indexes.list');
  } catch (e) {
    out.indexesDeployed = unreadable('firestore.indexes.list', e.message);
    out.indexesReady    = unreadable('firestore.indexes.list', e.message);
    out.indexStates     = unreadable('firestore.indexes.list', e.message);
  }

  try {
    const cols = await listRootCollections(post, dbId);
    /* An empty list is a MEASURED zero and is reported as such. This is the
       field the console must never fabricate — "0 collections" is only true
       when something actually looked. */
    out.rootCollections = observation(cols.length, 'firestore.documents.listCollectionIds');
    out.rootCollectionIds = observation(cols.slice(0, 500), 'firestore.documents.listCollectionIds');
  } catch (e) {
    out.rootCollections   = unreadable('firestore.documents.listCollectionIds', e.message);
    out.rootCollectionIds = unreadable('firestore.documents.listCollectionIds', e.message);
  }

  return out;
}

/**
 * Read the Firestore portion of the GCP control plane.
 *
 * @param {object} deps
 *   deps.get      optional injected GET  (opts) => Promise<json>
 *   deps.post     optional injected POST (opts, body) => Promise<json>
 *   deps.token    optional injected token minter
 *   deps.declared optional { '(default)': 414, 'sokoni-ops': 54 } — repository
 *                 declarations, for the declared-vs-deployed reconciliation.
 *                 Supplied by the caller; this module does NOT read the repo,
 *                 because functions/ is the only directory a deploy uploads.
 */
async function readFirestoreEvidence (deps) {
  const d = deps || {};
  const envelope = {
    project: PROJECT,
    generatedAt: new Date().toISOString(),
    /* The reader states its own limits. A consumer must be able to tell what
       was not asked from what was asked and failed. */
    covers: ['firestore.databases', 'firestore.indexes', 'firestore.collections', 'firestore.quota'],
    notCovered: ['cloud-run', 'artifact-registry', 'iam', 'monitoring', 'billing',
                 'secret-manager', 'audit-logging'],
    databases: {},
    quota: notAttempted('Not read.'),
    ok: false,
    error: '',
  };

  let get = d.get, post = d.post;
  if (!get || !post) {
    let at;
    try {
      at = d.token ? await d.token() : await adcToken();
    } catch (e) {
      envelope.error = 'Could not obtain credentials: ' + e.message;
      DATABASES.forEach((id) => {
        envelope.databases[id] = { id, region: unreadable(null, envelope.error) };
      });
      return envelope;
    }
    const auth = { Authorization: 'Bearer ' + at };
    get  = (o)    => httpsJson(Object.assign({ method: 'GET',  headers: auth }, o));
    post = (o, b) => httpsJson(Object.assign({ method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth) }, o), b);
  }

  let metas = [];
  try {
    metas = await listDatabases(get);
  } catch (e) {
    envelope.error = 'databases.list failed: ' + e.message;
  }

  const metaFor = (id) => metas.find((m) =>
    String(m.name || '').split('/databases/')[1] === id) || null;

  for (const id of DATABASES) {
    envelope.databases[id] = await readDatabase(get, post, id, metaFor(id));
  }

  try {
    envelope.quota = observation(await readIndexQuota(get), 'serviceusage.quota');
  } catch (e) {
    envelope.quota = unreadable('serviceusage.quota', e.message);
  }

  /* ── DECLARED vs DEPLOYED ────────────────────────────────────────────────
     The reconciliation that matters operationally: an index declared in the
     repository but not built makes a query fail at runtime while the repo looks
     correct. Only computed when the caller SUPPLIED declarations — it is never
     inferred, and a missing declaration is 'not-attempted', not zero. */
  const declared = d.declared || null;
  for (const id of DATABASES) {
    const db = envelope.databases[id];
    if (!declared || typeof declared[id] !== 'number') {
      db.indexesDeclared = notAttempted('The caller supplied no repository declaration count.');
      db.indexDrift      = notAttempted('Cannot reconcile without a declared count.');
      continue;
    }
    db.indexesDeclared = observation(declared[id], 'caller-supplied repository declaration');
    if (db.indexesDeployed.state === 'observed' || db.indexesDeployed.state === 'empty') {
      db.indexDrift = observation(declared[id] - db.indexesDeployed.value, 'declared - deployed');
    } else {
      db.indexDrift = unreadable(null, 'The deployed count is unreadable, so drift is unknown.');
    }
  }

  envelope.ok = !envelope.error;
  return envelope;
}

/* ══ DOMAIN READERS ═══════════════════════════════════════════════════════════
   One per GCP control plane. Each is a LIST or GET that counts what it finds,
   and each is isolated: a domain that fails degrades ITS OWN fields and leaves
   every neighbour intact. A cockpit where one dead API blanks the whole screen
   is worse than one that says precisely which instrument is out.

   None of these reads a payload. Secret Manager in particular lists NAMES —
   `secrets.list` cannot return a value, and `secrets.versions.access`, which
   can, is never called from this file and must never be added to it.
   ═════════════════════════════════════════════════════════════════════════ */

/** Wrap a domain read so a failure becomes observations rather than an
    exception. `fields` maps a name to a function of the raw result. */
async function domain (label, fetch, fields) {
  let raw;
  try {
    raw = await fetch();
  } catch (e) {
    const out = { _ok: false, _error: e.message };
    Object.keys(fields).forEach((k) => { out[k] = unreadable(label, e.message); });
    return out;
  }
  const out = { _ok: true, _error: '' };
  Object.keys(fields).forEach((k) => {
    try {
      const v = fields[k](raw);
      /* A field function may return an OBSERVATION already — `inventory()` does,
         because it carries `total`, `cap` and `truncated` alongside the rows.
         Wrapping it again would bury the array one level down and silently
         change the contract every consumer reads. Pass it through. */
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) && typeof v.state === 'string')
        ? v : observation(v, label);
    } catch (e) { out[k] = unreadable(label, e.message); }
  });
  return out;
}

const readProject = (get) => domain('cloudresourcemanager.projects.get',
  () => get({ host: 'cloudresourcemanager.googleapis.com',
              path: '/v3/projects/' + PROJECT }),
  {
    projectNumber: (j) => (j.name || '').split('/')[1] || null,
    state:         (j) => j.state || null,
    displayName:   (j) => j.displayName || null,
    createTime:    (j) => j.createTime || null,
  });

/** Cloud Run services across ALL locations. `locations/-` is the wildcard.
    Revisions, traffic and scaling limits are Cloud Run concepts, which is why
    this is separate from Cloud Functions rather than folded into it. */
const readCloudRun = (get) => domain('run.services.list',
  () => get({ host: 'run.googleapis.com',
              path: '/v2/projects/' + PROJECT + '/locations/-/services?pageSize=1000' }),
  {
    services: (j) => (j.services || []).length,
    regions:  (j) => [...new Set((j.services || []).map(
      (s) => (String(s.name || '').split('/locations/')[1] || '').split('/')[0]).filter(Boolean))].sort(),
    ready: (j) => (j.services || []).filter((s) =>
      (s.conditions || []).some((c) => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED')).length,
    /* A service whose latest CREATED revision is not the latest READY one has a
       revision that failed to come up. That is the shape of the failure this
       platform has actually hit. */
    revisionMismatch: (j) => (j.services || []).filter((s) =>
      s.latestCreatedRevision && s.latestReadyRevision &&
      s.latestCreatedRevision !== s.latestReadyRevision).length,
    /* Scaling contract: a service with no explicit max is unbounded. */
    unboundedScaling: (j) => (j.services || []).filter((s) =>
      !(s.template && s.template.scaling && s.template.scaling.maxInstanceCount)).length,
    pinnedMinimum: (j) => (j.services || []).filter((s) =>
      s.template && s.template.scaling && s.template.scaling.minInstanceCount > 0).length,
    /* PER-SERVICE INVENTORY — the drill-down. Every field needed to answer
       "what is actually serving, under what scaling contract, from which
       image". The image DIGEST is what links a revision to Artifact Registry. */
    inventory: (j) => inventory((j.services || []).map((s) => {
      const t  = s.template || {};
      const sc = t.scaling || {};
      const c  = (t.containers || [])[0] || {};
      const res = (c.resources && c.resources.limits) || {};
      return {
        name:   String(s.name || '').split('/services/')[1] || null,
        region: (String(s.name || '').split('/locations/')[1] || '').split('/')[0] || null,
        ready:  (s.conditions || []).some((x) => x.type === 'Ready' && x.state === 'CONDITION_SUCCEEDED'),
        latestCreatedRevision: s.latestCreatedRevision || null,
        latestReadyRevision:   s.latestReadyRevision || null,
        /* The parity check that would have made the scaling event visible. */
        revisionParity: !s.latestCreatedRevision || !s.latestReadyRevision ||
                        s.latestCreatedRevision === s.latestReadyRevision,
        minScale: sc.minInstanceCount === undefined ? null : sc.minInstanceCount,
        maxScale: sc.maxInstanceCount === undefined ? null : sc.maxInstanceCount,
        concurrency: t.maxInstanceRequestConcurrency === undefined ? null : t.maxInstanceRequestConcurrency,
        timeout: t.timeout || null,
        cpu:     res.cpu || null,
        memory:  res.memory || null,
        image:   c.image || null,
        serviceAccount: t.serviceAccount || null,
        traffic: (s.trafficStatuses || []).map((x) => ({
          revision: x.revision || null, percent: x.percent === undefined ? null : x.percent })),
        createTime: s.createTime || null,
        updateTime: s.updateTime || null,
      };
    }), (j.services || []).length, 'run.services.list'),
  });

const readFunctions = (get) => domain('cloudfunctions.functions.list',
  () => get({ host: 'cloudfunctions.googleapis.com',
              path: '/v2/projects/' + PROJECT + '/locations/-/functions?pageSize=1000' }),
  {
    total:   (j) => (j.functions || []).length,
    active:  (j) => (j.functions || []).filter((f) => f.state === 'ACTIVE').length,
    failed:  (j) => (j.functions || []).filter((f) => f.state === 'FAILED').length,
    deploying: (j) => (j.functions || []).filter((f) => f.state === 'DEPLOYING').length,
    runtimes: (j) => {
      const m = {};
      (j.functions || []).forEach((f) => {
        const r = (f.buildConfig && f.buildConfig.runtime) || 'unknown';
        m[r] = (m[r] || 0) + 1;
      });
      return m;
    },
    regions: (j) => [...new Set((j.functions || []).map(
      (f) => (String(f.name || '').split('/locations/')[1] || '').split('/')[0]).filter(Boolean))].sort(),
    /* The scaling contract across the estate. A function with no explicit max
       is unbounded; one with a pinned minimum costs money while idle. Both are
       facts, not judgements. */
    scaling: (j) => {
      const m = { unset: 0 };
      (j.functions || []).forEach((f) => {
        const max = f.serviceConfig && f.serviceConfig.maxInstanceCount;
        if (max === undefined || max === null) m.unset++;
        else m['max=' + max] = (m['max=' + max] || 0) + 1;
      });
      return m;
    },
    pinnedMinimum: (j) => (j.functions || []).filter((f) =>
      f.serviceConfig && f.serviceConfig.minInstanceCount > 0).length,
    /* PER-FUNCTION INVENTORY — the drill-down, including the Cloud Run service
       each Gen2 function actually runs on. That link is what makes the
       function -> service -> revision -> image chain navigable. */
    inventory: (j) => inventory((j.functions || []).map((f) => {
      const sc = f.serviceConfig || {};
      const bc = f.buildConfig || {};
      const ev = f.eventTrigger || null;
      return {
        name:   String(f.name || '').split('/functions/')[1] || null,
        region: (String(f.name || '').split('/locations/')[1] || '').split('/')[0] || null,
        state:  f.state || null,
        runtime: bc.runtime || null,
        environment: f.environment || null,
        /* A Gen2 function IS a Cloud Run service. Naming it makes the
           relationship real rather than implied. */
        service: sc.service ? String(sc.service).split('/services/')[1] : null,
        revision: sc.revision || null,
        memory:  sc.availableMemory || null,
        cpu:     sc.availableCpu || null,
        timeout: sc.timeoutSeconds === undefined ? null : sc.timeoutSeconds,
        minInstances: sc.minInstanceCount === undefined ? null : sc.minInstanceCount,
        maxInstances: sc.maxInstanceCount === undefined ? null : sc.maxInstanceCount,
        concurrency:  sc.maxInstanceRequestConcurrency === undefined ? null : sc.maxInstanceRequestConcurrency,
        serviceAccount: sc.serviceAccountEmail || null,
        ingress: sc.ingressSettings || null,
        trigger: ev ? (ev.eventType || 'event') : (sc.uri ? 'https' : null),
        uri: sc.uri || null,
        updateTime: f.updateTime || null,
        /* Source contract vs serving state cannot be compared here — the source
           contract lives in the repository, not in the API. Named so the gap is
           visible rather than silently absent. */
        sourceContract: null,
      };
    }), (j.functions || []).length, 'cloudfunctions.functions.list'),
  });

/** Artifact Registry provenance. The cleanup policies are the operationally
    critical field here: a reference-blind DELETE policy emptied both
    repositories, and a KEEP policy was added alongside it. Whether BOTH are
    present is a fact an operator must be able to see without running a script. */
const readArtifactRegistry = (get) => domain('artifactregistry.repositories.list',
  () => get({ host: 'artifactregistry.googleapis.com',
              path: '/v1/projects/' + PROJECT + '/locations/-/repositories?pageSize=200' }),
  {
    repositories: (j) => (j.repositories || []).length,
    regions: (j) => [...new Set((j.repositories || []).map(
      (r) => (String(r.name || '').split('/locations/')[1] || '').split('/')[0]).filter(Boolean))].sort(),
    cleanupPolicies: (j) => {
      const m = {};
      (j.repositories || []).forEach((r) => {
        Object.keys(r.cleanupPolicies || {}).forEach((k) => { m[k] = (m[k] || 0) + 1; });
      });
      return m;
    },
    /* cleanupPolicyDryRun UNSET means the policies are ENFORCING. The field is
       named for disabling enforcement, not for previewing it — a distinction
       that has already cost this platform every function image once. */
    enforcingRepos: (j) => (j.repositories || []).filter((r) =>
      Object.keys(r.cleanupPolicies || {}).length && !r.cleanupPolicyDryRun).length,
    /* PER-REPOSITORY PROVENANCE. Each policy is shown with its ACTION and its
       condition, because "a cleanup policy exists" and "a reference-blind
       DELETE policy is enforcing" are very different facts. */
    inventory: (j) => inventory((j.repositories || []).map((r) => {
      const pol = r.cleanupPolicies || {};
      return {
        name:     String(r.name || '').split('/repositories/')[1] || null,
        location: (String(r.name || '').split('/locations/')[1] || '').split('/')[0] || null,
        format:   r.format || null,
        sizeBytes: r.sizeBytes === undefined ? null : Number(r.sizeBytes),
        /* UNSET means ENFORCING. The flag disables deletion; it is not a
           preview. That distinction has already cost this project every
           function image once. */
        enforcing: !r.cleanupPolicyDryRun,
        policies: Object.keys(pol).map((k) => ({
          id: k,
          action: (pol[k] && pol[k].action) || null,
          olderThan: (pol[k] && pol[k].condition && pol[k].condition.olderThan) || null,
          tagState:  (pol[k] && pol[k].condition && pol[k].condition.tagState) || null,
          keepCount: (pol[k] && pol[k].mostRecentVersions &&
                      pol[k].mostRecentVersions.keepCount) || null,
        })),
        createTime: r.createTime || null,
        updateTime: r.updateTime || null,
      };
    }), (j.repositories || []).length, 'artifactregistry.repositories.list'),
    /* A DELETE policy with no KEEP policy beside it is the configuration that
       emptied both repositories. Counted, not judged. */
    reposWithDeleteOnly: (j) => (j.repositories || []).filter((r) => {
      const pol = r.cleanupPolicies || {};
      const ks = Object.keys(pol);
      const hasDelete = ks.some((k) => pol[k] && pol[k].action === 'DELETE');
      const hasKeep   = ks.some((k) => pol[k] && pol[k].action === 'KEEP');
      return hasDelete && !hasKeep;
    }).length,
  });

/** Secret NAMES and version counts. Never a value. */
const readSecrets = (get) => domain('secretmanager.secrets.list',
  () => get({ host: 'secretmanager.googleapis.com',
              path: '/v1/projects/' + PROJECT + '/secrets?pageSize=500' }),
  {
    secrets: (j) => (j.secrets || []).length,
    names:   (j) => (j.secrets || []).map((s) => String(s.name || '').split('/secrets/')[1])
                      .filter(Boolean).sort(),
    withRotation: (j) => (j.secrets || []).filter((s) => !!s.rotation).length,
    withExpiry:   (j) => (j.secrets || []).filter((s) => !!s.expireTime).length,
  });

/** IAM bindings and audit configuration, from the project policy.
    getIamPolicy is a POST because it takes options — it is a READ. */
const readIam = (post) => domain('cloudresourcemanager.getIamPolicy',
  () => post({ host: 'cloudresourcemanager.googleapis.com',
               path: '/v3/projects/' + PROJECT + ':getIamPolicy' },
             { options: { requestedPolicyVersion: 3 } }),
  {
    bindings: (j) => (j.bindings || []).length,
    principals: (j) => [...new Set([].concat(
      ...(j.bindings || []).map((b) => b.members || [])))].length,
    serviceAccounts: (j) => [...new Set([].concat(
      ...(j.bindings || []).map((b) => b.members || [])))]
      .filter((m) => m.indexOf('serviceAccount:') === 0).length,
    owners:  (j) => ((j.bindings || []).find((b) => b.role === 'roles/owner')  || {}).members
                      ? ((j.bindings || []).find((b) => b.role === 'roles/owner') || {}).members.length : 0,
    editors: (j) => ((j.bindings || []).find((b) => b.role === 'roles/editor') || {}).members
                      ? ((j.bindings || []).find((b) => b.role === 'roles/editor') || {}).members.length : 0,
    /* Which audit categories are actually switched on. An absent auditConfigs
       block means Admin Activity only — it does NOT mean "everything". */
    auditServices: (j) => (j.auditConfigs || []).length,
    auditLogTypes: (j) => {
      const m = {};
      (j.auditConfigs || []).forEach((c) => {
        (c.auditLogConfigs || []).forEach((l) => { m[l.logType] = (m[l.logType] || 0) + 1; });
      });
      return m;
    },
    /* PER-SERVICE AUDIT COVERAGE. Which categories are on, per service. An
       absent entry means Admin Activity only — it does NOT mean everything. */
    auditCoverage: (j) => (j.auditConfigs || []).map((c) => ({
      service: c.service || null,
      logTypes: (c.auditLogConfigs || []).map((l) => l.logType).filter(Boolean).sort(),
      exemptedMembers: [].concat(...(c.auditLogConfigs || []).map((l) => l.exemptedMembers || [])).length,
    })),

    /* ── THE ADMINS ──────────────────────────────────────────────────
       Who can actually change this project. Rendered as the ACTUAL bindings —
       role and principal — because that is the evidence. No risk score is
       derived: a score is an opinion wearing the authority of a measurement.

       Principal identifiers are not secrets; they are exactly what an operator
       needs in order to act. They are still admin-gated by the callable. */
    adminBindings: (j) => {
      const ADMINISH = /(^roles\/owner$)|(^roles\/editor$)|admin|Admin/;
      return (j.bindings || [])
        .filter((b) => ADMINISH.test(b.role || ''))
        .map((b) => ({
          role: b.role || null,
          members: (b.members || []).slice(0, 50),
          memberCount: (b.members || []).length,
          conditional: !!b.condition,
        }))
        .sort((a, b) => (a.role || '').localeCompare(b.role || ''));
    },
    /* Every binding, capped, so the full picture is reachable. */
    bindingInventory: (j) => inventory((j.bindings || []).map((b) => ({
      role: b.role || null,
      memberCount: (b.members || []).length,
      members: (b.members || []).slice(0, 50),
      conditional: !!b.condition,
    })), (j.bindings || []).length, 'cloudresourcemanager.getIamPolicy'),
    /* Human principals, separated from machine ones. Different revocation
       paths, different offboarding risk. */
    humanPrincipals: (j) => [...new Set([].concat(
      ...(j.bindings || []).map((b) => b.members || [])))]
      .filter((m) => m.indexOf('user:') === 0).sort(),
    groupPrincipals: (j) => [...new Set([].concat(
      ...(j.bindings || []).map((b) => b.members || [])))]
      .filter((m) => m.indexOf('group:') === 0).sort(),
  });

const readMonitoring = (get) => domain('monitoring.alertPolicies.list',
  () => get({ host: 'monitoring.googleapis.com',
              path: '/v3/projects/' + PROJECT + '/alertPolicies?pageSize=500' }),
  {
    alertPolicies: (j) => (j.alertPolicies || []).length,
    enabled:       (j) => (j.alertPolicies || []).filter((p) => p.enabled === true ||
                            (p.enabled && p.enabled.value === true)).length,
    withNotification: (j) => (j.alertPolicies || []).filter((p) =>
      (p.notificationChannels || []).length).length,
  });

const readBilling = (get) => domain('cloudbilling.projects.getBillingInfo',
  () => get({ host: 'cloudbilling.googleapis.com',
              path: '/v1/projects/' + PROJECT + '/billingInfo' }),
  {
    billingEnabled: (j) => j.billingEnabled === true,
    billingAccount: (j) => j.billingAccountName || null,
  });

/* ── INVENTORY CAPS ──────────────────────────────────────────────────────────
   A control plane with 1,709 functions must not ship 1,709 objects to a
   browser. Inventories are capped, and the cap is REPORTED alongside the total
   so a truncated list is never mistaken for a complete one. */
const INV_CAP = 250;

function inventory (rows, total, source) {
  const o = observation(rows.slice(0, INV_CAP), source);
  o.total = total;
  o.truncated = total > INV_CAP;
  o.cap = INV_CAP;
  return o;
}

/** APIs actually ENABLED on the project. An API that is off explains a whole
    domain reading as unreadable, so this is diagnostic, not decorative. */
const readEnabledApis = (get) => domain('serviceusage.services.list',
  () => get({ host: 'serviceusage.googleapis.com',
              path: '/v1/projects/' + PROJECT + '/services?filter=state:ENABLED&pageSize=200' }),
  {
    enabled: (j) => (j.services || []).length,
    names:   (j) => (j.services || []).map((s) => (s.config && s.config.name) ||
                      String(s.name || '').split('/services/')[1]).filter(Boolean).sort(),
  });

const readStorage = (get) => domain('storage.buckets.list',
  () => get({ host: 'storage.googleapis.com',
              path: '/storage/v1/b?project=' + PROJECT + '&maxResults=200' }),
  {
    buckets: (j) => (j.items || []).length,
    names:   (j) => (j.items || []).map((b) => b.name).filter(Boolean).sort(),
    locations: (j) => [...new Set((j.items || []).map((b) => b.location).filter(Boolean))].sort(),
    publicAccessPrevention: (j) => (j.items || []).filter((b) =>
      b.iamConfiguration && b.iamConfiguration.publicAccessPrevention === 'enforced').length,
    uniformAccess: (j) => (j.items || []).filter((b) =>
      b.iamConfiguration && b.iamConfiguration.uniformBucketLevelAccess &&
      b.iamConfiguration.uniformBucketLevelAccess.enabled).length,
  });

/** Docker images in one repository — the provenance layer. A Cloud Run revision
    pins an image by DIGEST; this is the other end of that link. */
function readRepoImages (get, location, repo) {
  return get({ host: 'artifactregistry.googleapis.com',
               path: '/v1/projects/' + PROJECT + '/locations/' + location +
                     '/repositories/' + repo + '/dockerImages?pageSize=' + INV_CAP })
    .then((j) => j.dockerImages || []);
}

/** Recent admin-activity log entries — the evidence timeline.
    entries:list is a POST because it takes a filter body. It is a READ; the
    write twin is entries:write, which appears nowhere in this file. */
const readActivity = (post) => domain('logging.entries.list',
  () => post({ host: 'logging.googleapis.com', path: '/v2/entries:list' }, {
    resourceNames: ['projects/' + PROJECT],
    /* Admin Activity only. Data Access entries can carry request payloads, and
       this console must never surface those. */
    filter: 'logName="projects/' + PROJECT + '/logs/cloudaudit.googleapis.com%2Factivity"',
    orderBy: 'timestamp desc',
    pageSize: 100,
  }),
  {
    events: (j) => (j.entries || []).length,
    /* Shaped deliberately narrow. A raw audit entry carries principal email,
       request parameters and caller IP; only what an operator needs to locate
       the event is carried forward. */
    timeline: (j) => (j.entries || []).slice(0, INV_CAP).map((e) => ({
      at: e.timestamp || null,
      service: (e.protoPayload && e.protoPayload.serviceName) || null,
      method:  (e.protoPayload && e.protoPayload.methodName) || null,
      resource: (e.protoPayload && e.protoPayload.resourceName) || null,
      severity: e.severity || null,
      /* Whether the operation FAILED is the operationally interesting bit. */
      failed: !!(e.protoPayload && e.protoPayload.status && e.protoPayload.status.code),
    })),
    failures: (j) => (j.entries || []).filter((e) =>
      e.protoPayload && e.protoPayload.status && e.protoPayload.status.code).length,
    lastEventAt: (j) => ((j.entries || [])[0] || {}).timestamp || null,
  });

/* ── TELEMETRY ───────────────────────────────────────────────────────────────
   Real metric series, not a shrug. Each metric is asked for over a stated
   window and reduced to a total or a peak, so the number on screen has a
   window attached to it — "5xx: 12" is meaningless without "in the last 24h".

   A metric with no data points is a MEASURED ZERO over that window, which is a
   different fact from a failed read and is reported as such. */
const TELEMETRY_WINDOW_HOURS = 24;

function metricSeries (get, filter, aligner, reducer) {
  const end = new Date();
  const start = new Date(end.getTime() - TELEMETRY_WINDOW_HOURS * 3600 * 1000);
  const q = '/v3/projects/' + PROJECT + '/timeSeries' +
    '?filter=' + encodeURIComponent(filter) +
    '&interval.startTime=' + encodeURIComponent(start.toISOString()) +
    '&interval.endTime=' + encodeURIComponent(end.toISOString()) +
    '&aggregation.alignmentPeriod=3600s' +
    '&aggregation.perSeriesAligner=' + (aligner || 'ALIGN_SUM') +
    '&aggregation.crossSeriesReducer=' + (reducer || 'REDUCE_SUM');
  return get({ host: 'monitoring.googleapis.com', path: q })
    .then((j) => j.timeSeries || []);
}

/** Sum every point across every returned series. */
function sumPoints (series) {
  let total = 0;
  (series || []).forEach((s) => (s.points || []).forEach((p) => {
    const v = p.value || {};
    const n = v.int64Value !== undefined ? Number(v.int64Value)
            : v.doubleValue !== undefined ? Number(v.doubleValue) : 0;
    if (Number.isFinite(n)) total += n;
  }));
  return Math.round(total);
}

/** The highest single aligned point — a peak, not an average. */
function peakPoint (series) {
  let peak = 0;
  (series || []).forEach((s) => (s.points || []).forEach((p) => {
    const v = p.value || {};
    const n = v.int64Value !== undefined ? Number(v.int64Value)
            : v.doubleValue !== undefined ? Number(v.doubleValue) : 0;
    if (Number.isFinite(n) && n > peak) peak = n;
  }));
  return Math.round(peak);
}

/** Telemetry, per subject. Each series observes independently: one metric that
    is not enabled must not blank the rest of the panel. */
async function readTelemetry (get) {
  const out = { _ok: true, _error: '', windowHours: TELEMETRY_WINDOW_HOURS };
  const ask = async (key, filter, aligner, reduce) => {
    try {
      const s = await metricSeries(get, filter, aligner, 'REDUCE_SUM');
      out[key] = observation(reduce === 'peak' ? peakPoint(s) : sumPoints(s),
        'monitoring.timeSeries (' + TELEMETRY_WINDOW_HOURS + 'h)');
    } catch (e) {
      out[key] = unreadable('monitoring.timeSeries', e.message);
      out._error = e.message;
    }
  };

  await Promise.all([
    ask('runRequests',   'metric.type="run.googleapis.com/request_count"'),
    ask('run5xx',        'metric.type="run.googleapis.com/request_count" AND ' +
                         'metric.label.response_code_class="5xx"'),
    ask('runInstancePeak', 'metric.type="run.googleapis.com/container/instance_count"',
                         'ALIGN_MAX', 'peak'),
    ask('fnExecutions',  'metric.type="cloudfunctions.googleapis.com/function/execution_count"'),
    ask('fnErrors',      'metric.type="cloudfunctions.googleapis.com/function/execution_count" AND ' +
                         'metric.label.status!="ok"'),
    ask('firestoreReads',  'metric.type="firestore.googleapis.com/document/read_count"'),
    ask('firestoreWrites', 'metric.type="firestore.googleapis.com/document/write_count"'),
    ask('firestoreDeletes','metric.type="firestore.googleapis.com/document/delete_count"'),
  ]);

  /* If EVERY series failed, the domain is down rather than quiet. */
  const keys = Object.keys(out).filter((k) => k.charAt(0) !== '_' && k !== 'windowHours');
  out._ok = keys.some((k) => out[k] && out[k].state !== 'unreadable');
  return out;
}

/** Alert incidents that are currently OPEN. */
const readIncidents = (get) => domain('monitoring.alertPolicies.incidents',
  () => get({ host: 'monitoring.googleapis.com',
              path: '/v3/projects/' + PROJECT + '/alertPolicies?pageSize=500' }),
  {
    /* The incidents API is not exposed under the v3 REST surface this reader
       uses, so OPEN INCIDENTS is honestly not-attempted rather than zero. The
       field exists so its absence is visible. */
    openIncidents: () => null,
  });

/** Budgets need the billing ACCOUNT, not the project, so this is a two-step and
    is skipped entirely when billing could not be read. */
function readBudgets (get, billingAccountName) {
  if (!billingAccountName) {
    const why = 'The billing account was not readable, so budgets were not requested.';
    return Promise.resolve({ _ok: false, _error: why,
      budgets: notAttempted(why), budgetNames: notAttempted(why) });
  }
  return domain('billingbudgets.budgets.list',
    () => get({ host: 'billingbudgets.googleapis.com',
                path: '/v1/' + billingAccountName + '/budgets?pageSize=100' }),
    {
      budgets: (j) => (j.budgets || []).length,
      budgetNames: (j) => (j.budgets || []).map((b) => b.displayName).filter(Boolean).sort(),
      withThresholds: (j) => (j.budgets || []).filter((b) =>
        (b.thresholdRules || []).length).length,
    });
}

/** Firebase App Check enforcement, per service. */
const readAppCheck = (get) => domain('firebaseappcheck.services.list',
  () => get({ host: 'firebaseappcheck.googleapis.com',
              path: '/v1/projects/' + PROJECT + '/services' }),
  {
    services: (j) => (j.services || []).length,
    enforced: (j) => (j.services || []).filter((s) =>
      s.enforcementMode === 'ENFORCED').length,
    unenforced: (j) => (j.services || []).filter((s) =>
      s.enforcementMode && s.enforcementMode !== 'ENFORCED').length,
    inventory: (j) => inventory((j.services || []).map((s) => ({
      service: String(s.name || '').split('/services/')[1] || null,
      mode: s.enforcementMode || null,
    })), (j.services || []).length, 'firebaseappcheck.services.list'),
  });

/**
 * The whole GCP control plane, composed.
 *
 * Domain isolation is the design: each control plane observes independently, so
 * an operator can tell a dead instrument from a dead estate. `notCovered` names
 * what was never asked, so an absent panel is never mistaken for a healthy one.
 */
async function readGcpEvidence (deps) {
  const d = deps || {};
  let get = d.get, post = d.post;

  const envelope = {
    project: PROJECT,
    generatedAt: new Date().toISOString(),
    covers: ['firestore', 'cloud-storage', 'cloud-run', 'cloud-functions',
             'artifact-registry', 'image-provenance', 'secret-manager', 'iam',
             'admin-bindings', 'audit-config', 'audit-activity-log', 'monitoring',
             'billing', 'budgets', 'enabled-apis', 'telemetry', 'app-check',
             'service-account-usage', 'cost-conditions'],
    /* Named so their absence is visible rather than read as health. */
    notCovered: ['cost-breakdown', 'per-service-telemetry', 'open-incidents',
                 'data-access-log-entries', 'secret-version-detail', 'cloudflare'],
    ok: false, error: '',
  };

  if (!get || !post) {
    let at;
    try {
      at = d.token ? await d.token() : await adcToken();
    } catch (e) {
      envelope.error = 'Could not obtain credentials: ' + e.message;
      return envelope;
    }
    const auth = { Authorization: 'Bearer ' + at };
    get  = (o)    => httpsJson(Object.assign({ method: 'GET',  headers: auth }, o));
    post = (o, b) => httpsJson(Object.assign({ method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth) }, o), b);
  }

  const [proj, run, fns, ar, secrets, iam, mon, bill, apis, storage, activity, fs_] =
    await Promise.all([
      readProject(get), readCloudRun(get), readFunctions(get), readArtifactRegistry(get),
      readSecrets(get), readIam(post), readMonitoring(get), readBilling(get),
      readEnabledApis(get), readStorage(get), readActivity(post),
      readFirestoreEvidence({ get, post, declared: d.declared }),
    ]);

  envelope.projectInfo  = proj;
  envelope.apis         = apis;
  envelope.activity     = activity;
  envelope.compute      = { cloudRun: run, functions: fns, artifactRegistry: ar };
  envelope.data         = { firestore: fs_, storage: storage };
  envelope.observability = { monitoring: mon, billing: bill };
  envelope.security     = { iam: iam, secrets: secrets };

  /* ── IMAGE PROVENANCE ────────────────────────────────────────────────
     revision -> image digest -> repository. Fetched per repository, and only
     when the repository list was readable — asking for images in a repository
     we could not list would be guessing at its name. */
  if (ar._ok && ar.inventory && Array.isArray(ar.inventory.value)) {
    const repos = ar.inventory.value.filter((r) => r.name && r.location);
    const images = [];
    let imgError = '';
    for (const r of repos) {
      try {
        const got = await readRepoImages(get, r.location, r.name);
        got.forEach((im) => images.push({
          repo: r.name, location: r.location,
          name: String(im.name || '').split('/dockerImages/')[1] || null,
          /* The digest is the join key to a Cloud Run revision. */
          digest: (im.uri || '').split('@')[1] || null,
          tags: im.tags || [],
          uploadTime: im.uploadTime || null,
          buildTime: im.buildTime || null,
          sizeBytes: im.imageSizeBytes === undefined ? null : Number(im.imageSizeBytes),
        }));
      } catch (e) { imgError = e.message; }
    }
    envelope.compute.images = imgError && !images.length
      ? { _ok: false, _error: imgError,
          images: unreadable('artifactregistry.dockerImages.list', imgError),
          inventory: unreadable('artifactregistry.dockerImages.list', imgError) }
      : { _ok: true, _error: imgError,
          images: observation(images.length, 'artifactregistry.dockerImages.list'),
          inventory: inventory(images, images.length, 'artifactregistry.dockerImages.list') };
  } else {
    const why = 'The repository list was unreadable, so images were not requested.';
    envelope.compute.images = { _ok: false, _error: why,
      images: notAttempted(why), inventory: notAttempted(why) };
  }

  /* ── REVISION -> IMAGE JOIN ──────────────────────────────────────────
     The provenance link, computed from two observations rather than asserted.
     A serving image whose digest is NOT in the registry is precisely the
     condition that made 1,708 services unable to create a new revision. */
  const runInv = run._ok && run.inventory && Array.isArray(run.inventory.value)
    ? run.inventory.value : null;
  const imgInv = envelope.compute.images._ok && envelope.compute.images.inventory &&
    Array.isArray(envelope.compute.images.inventory.value)
    ? envelope.compute.images.inventory.value : null;

  if (runInv && imgInv) {
    const digests = new Set(imgInv.map((i) => i.digest).filter(Boolean));
    const pinned  = runInv.filter((s) => s.image && s.image.indexOf('@sha256:') !== -1);
    const missing = pinned.filter((s) => !digests.has(s.image.split('@')[1]));
    envelope.compute.provenance = {
      _ok: true, _error: '',
      servicesPinnedByDigest: observation(pinned.length, 'derived: run + artifactregistry'),
      servicesPinnedByTag:    observation(runInv.length - pinned.length, 'derived: run + artifactregistry'),
      imageMissingFromRegistry: observation(missing.length, 'derived: run + artifactregistry'),
      missingInventory: inventory(missing.map((s) => ({
        service: s.name, region: s.region, image: s.image,
        digest: (s.image || '').split('@')[1] || null,
      })), missing.length, 'derived: run + artifactregistry'),
    };
  } else {
    const why = 'Both the Cloud Run inventory and the image inventory are required, and at least one is unavailable.';
    envelope.compute.provenance = { _ok: false, _error: why,
      servicesPinnedByDigest: notAttempted(why),
      servicesPinnedByTag: notAttempted(why),
      imageMissingFromRegistry: notAttempted(why),
      missingInventory: notAttempted(why) };
  }

  /* Region coverage is DERIVED from what was actually observed serving, never
     from a configured list. A region nothing runs in is not coverage. */
  const regions = [];
  [run.regions, fns.regions, ar.regions].forEach((o) => {
    if (o && (o.state === 'observed' || o.state === 'empty') && Array.isArray(o.value)) {
      o.value.forEach((r) => { if (regions.indexOf(r) === -1) regions.push(r); });
    }
  });
  Object.keys(fs_.databases || {}).forEach((k) => {
    const rg = fs_.databases[k].region;
    if (rg && rg.state === 'observed' && rg.value && regions.indexOf(rg.value) === -1) {
      regions.push(rg.value);
    }
  });
  envelope.regions = regions.length
    ? observation(regions.sort(), 'derived from observed resources')
    : unreadable('derived from observed resources',
        'No control plane returned a region, so coverage is unknown.');

  /* ── THE SCALING CONTRACT ────────────────────────────────────────────
     SOURCE vs SERVING. What a function DECLARES in the repository and what is
     actually RUNNING are different statements, and the gap between them is the
     defect that removed a production ceiling during a rebuild.

     The source side cannot be read from a deployed function — `firebase deploy
     --only functions` uploads functions/ and nothing else — so the caller
     supplies it, exactly like the declared index counts. A function with no
     supplied row gets `not-attempted`, never "in parity".

     THE GCF LAYER IS NOT AUTHORITATIVE. It reports minInstanceCount=undefined
     for functions whose source AND serving revision both say 1. It is the
     representation that agrees with neither, which makes it an observability
     discrepancy rather than evidence. Parity is computed against the SERVING
     revision, and the GCF value is carried alongside so the disagreement stays
     visible instead of being quietly resolved. */
  const contracts = d.contracts || null;
  if (fns._ok && fns.inventory && Array.isArray(fns.inventory.value)) {
    const byFn = {};
    ((contracts && contracts.rows) || []).forEach((r) => { if (r.fn) byFn[r.fn] = r; });

    const rows = fns.inventory.value.map((f) => {
      const c = byFn[f.name];
      if (!c) {
        return { fn: f.name, region: f.region, hasContract: false,
                 reason: 'No source contract was supplied for this function.' };
      }
      /* Parity against SERVING, deliberately — see the note above. */
      const maxParity = c.src_max === c.run_max;
      const minPinned = typeof c.run_min === 'number' && c.run_min > 0;
      const gcfDisagrees = (c.gcf_min !== c.run_min) || (c.gcf_max !== c.run_max);
      return {
        fn: f.name, region: f.region, hasContract: true,
        srcMin: c.src_min, srcMax: c.src_max,
        runMin: c.run_min, runMax: c.run_max,
        gcfMin: c.gcf_min, gcfMax: c.gcf_max,
        maxParity, minPinned, gcfDisagrees,
        verdict: c.verdict || null,
        detail: c.detail || null,
      };
    }).filter((r) => r.hasContract);

    envelope.compute.contracts = {
      _ok: true, _error: '',
      capturedAt: contracts && contracts.capturedAt
        ? observation(contracts.capturedAt, 'caller-supplied adjudication')
        : notAttempted('No capture time was supplied with the contract.'),
      adjudicated: observation(rows.length, 'caller-supplied adjudication'),
      /* Functions with NO supplied contract are not "in parity" — nothing was
         compared. Counted separately so the silence is visible. */
      withoutContract: observation(
        fns.inventory.value.length - rows.length, 'derived: inventory minus contracts'),
      maxMismatch: observation(rows.filter((r) => !r.maxParity).length, 'derived: source vs serving'),
      minUnpinned: observation(rows.filter((r) => !r.minPinned).length, 'derived: serving'),
      gcfDiscrepancy: observation(rows.filter((r) => r.gcfDisagrees).length, 'derived: gcf vs serving'),
      note: contracts && contracts.note ? observation(contracts.note, 'caller-supplied adjudication')
                                        : notAttempted('No observability note was supplied.'),
      inventory: inventory(rows, rows.length, 'caller-supplied adjudication'),
    };
  } else {
    const why = 'The function inventory is unreadable, so no contract can be compared.';
    envelope.compute.contracts = { _ok: false, _error: why,
      capturedAt: notAttempted(why), adjudicated: notAttempted(why),
      withoutContract: notAttempted(why), maxMismatch: notAttempted(why),
      minUnpinned: notAttempted(why), gcfDiscrepancy: notAttempted(why),
      note: notAttempted(why), inventory: notAttempted(why) };
  }

  /* ── TELEMETRY, INCIDENTS, BUDGETS, APP CHECK ──────────────────────── */
  const [tele, inc, appcheck] = await Promise.all([
    readTelemetry(get), readIncidents(get), readAppCheck(get),
  ]);
  envelope.observability.telemetry = tele;
  envelope.observability.incidents = inc;
  envelope.security.appCheck = appcheck;

  const billingAccount = (bill._ok && bill.billingAccount &&
    bill.billingAccount.state === 'observed') ? bill.billingAccount.value : null;
  envelope.observability.budgets = await readBudgets(get, billingAccount);

  /* ── COST CONTROL ────────────────────────────────────────────────────
     DERIVED from the Cloud Run inventory already read, not from a cost API.
     These are the CONDITIONS that drive spend, stated as evidence tables:
     a pinned minimum bills while idle, an unbounded maximum has no ceiling.

     They are conditions, never verdicts. Whether a pinned minimum is correct
     depends on the service, and this reader does not know which. */
  if (runInv) {
    const pinned    = runInv.filter((s) => s.minScale > 0);
    const unbounded = runInv.filter((s) => s.maxScale === null || s.maxScale === undefined);
    const highMax   = runInv.filter((s) => typeof s.maxScale === 'number' && s.maxScale >= 100);
    envelope.cost = {
      _ok: true, _error: '',
      pinnedInstances: observation(pinned.length, 'derived: run inventory'),
      pinnedInventory: inventory(pinned.map((s) => ({
        service: s.name, region: s.region, minScale: s.minScale, maxScale: s.maxScale,
      })), pinned.length, 'derived: run inventory'),
      unboundedServices: observation(unbounded.length, 'derived: run inventory'),
      unboundedInventory: inventory(unbounded.map((s) => ({
        service: s.name, region: s.region, maxScale: null,
      })), unbounded.length, 'derived: run inventory'),
      highMaxScale: observation(highMax.length, 'derived: run inventory'),
      highMaxInventory: inventory(highMax.map((s) => ({
        service: s.name, region: s.region, maxScale: s.maxScale,
      })), highMax.length, 'derived: run inventory'),
      /* Per-service traffic needs a per-service metric read this reader does
         not make. Named so the gap is visible rather than silently absent. */
      servicesWithNoObservedTraffic: notAttempted(
        'Per-service traffic requires a per-service metric query, which this reader does not make.'),
      costBreakdown: notAttempted(
        'A cost breakdown requires the billing export dataset, which this reader does not read.'),
    };
  } else {
    const why = 'The Cloud Run inventory is unreadable, so no cost condition can be derived.';
    envelope.cost = { _ok: false, _error: why,
      pinnedInstances: notAttempted(why), pinnedInventory: notAttempted(why),
      unboundedServices: notAttempted(why), unboundedInventory: notAttempted(why),
      highMaxScale: notAttempted(why), highMaxInventory: notAttempted(why),
      servicesWithNoObservedTraffic: notAttempted(why), costBreakdown: notAttempted(why) };
  }

  /* ── SERVICE ACCOUNTS, AND WHAT USES THEM ────────────────────────────
     A JOIN across three observations: the IAM policy says which service
     accounts hold roles; the Cloud Run and Functions inventories say which
     workloads RUN AS them. "Who can do what" and "what actually uses this
     identity" are different questions, and only the join answers the second.

     A service account holding roles that NOTHING runs as is a real finding —
     it is an identity with access and no owner. It is reported as a condition,
     not scored. */
  const fnInv = fns._ok && fns.inventory && Array.isArray(fns.inventory.value)
    ? fns.inventory.value : null;
  const iamOk = iam._ok && iam.bindingInventory &&
    Array.isArray(iam.bindingInventory.value);

  if (iamOk) {
    const byAccount = {};
    const note = (email, field, value) => {
      if (!email) return;
      const k = String(email).replace(/^serviceAccount:/, '');
      byAccount[k] = byAccount[k] || { email: k, roles: [], runServices: [], functions: [] };
      if (value && byAccount[k][field].indexOf(value) === -1) byAccount[k][field].push(value);
    };

    iam.bindingInventory.value.forEach((b) => {
      (b.members || []).forEach((m) => {
        if (m.indexOf('serviceAccount:') !== 0) return;
        note(m, 'roles', b.role);
      });
    });
    (runInv || []).forEach((s) => { if (s.serviceAccount) note(s.serviceAccount, 'runServices', s.name); });
    (fnInv  || []).forEach((f) => { if (f.serviceAccount) note(f.serviceAccount, 'functions', f.name); });

    const rows = Object.keys(byAccount).sort().map((k) => {
      const a = byAccount[k];
      return {
        email: a.email,
        roles: a.roles.sort(),
        roleCount: a.roles.length,
        runServices: a.runServices.length,
        functions: a.functions.length,
        /* An identity with roles that nothing runs as. A condition, not a score. */
        unusedByWorkloads: a.roles.length > 0 && a.runServices.length === 0 && a.functions.length === 0,
        /* Only meaningful when BOTH workload inventories were readable. */
        usageKnown: !!(runInv && fnInv),
      };
    });

    envelope.security.serviceAccounts = {
      _ok: true, _error: '',
      total: observation(rows.length, 'derived: iam + run + functions'),
      withoutWorkload: (runInv && fnInv)
        ? observation(rows.filter((r) => r.unusedByWorkloads).length, 'derived: iam + run + functions')
        : notAttempted('Both workload inventories are required to tell an unused identity from an unread one.'),
      inventory: inventory(rows, rows.length, 'derived: iam + run + functions'),
    };
  } else {
    const why = 'The IAM policy is unreadable, so service-account usage cannot be joined.';
    envelope.security.serviceAccounts = { _ok: false, _error: why,
      total: notAttempted(why), withoutWorkload: notAttempted(why),
      inventory: notAttempted(why) };
  }

  /* ── DECLARED vs PROVISIONED SECRETS ─────────────────────────────────
     The registry says which secret NAMES each rail requires. Secret Manager
     says which exist. The join answers the question the Credentials tab can
     only ask: is a rail depending on a secret that is not there?

     Both directions matter. A DECLARED-but-absent secret is a rail that will
     fail when it runs. A PRESENT-but-undeclared secret is not a fault — it may
     belong to something outside this registry — so it is reported as unmatched
     rather than as an orphan to delete. Nothing here reads a value.

     Supplied by the caller, because the registry lives in functions/ and this
     reader should not reach across the module boundary to find it. */
  const expected = Array.isArray(d.expectedSecrets) ? d.expectedSecrets : null;
  const haveNames = (secrets._ok && secrets.names &&
    (secrets.names.state === 'observed' || secrets.names.state === 'empty'))
    ? (secrets.names.value || []) : null;

  if (expected && haveNames) {
    const have = new Set(haveNames);
    const want = [...new Set(expected)].sort();
    const missing = want.filter((n) => !have.has(n));
    const unmatched = haveNames.filter((n) => want.indexOf(n) === -1).sort();
    envelope.security.secretCoverage = {
      _ok: true, _error: '',
      declared: observation(want.length, 'derived: registry + secretmanager'),
      provisioned: observation(haveNames.length, 'derived: registry + secretmanager'),
      missing: observation(missing.length, 'derived: registry + secretmanager'),
      missingNames: inventory(missing.map((n) => ({ secret: n })), missing.length,
        'derived: registry + secretmanager'),
      unmatched: observation(unmatched.length, 'derived: registry + secretmanager'),
      unmatchedNames: inventory(unmatched.map((n) => ({ secret: n })), unmatched.length,
        'derived: registry + secretmanager'),
    };
  } else {
    const why = !expected
      ? 'The caller supplied no declared-secret list, so coverage cannot be computed.'
      : 'The Secret Manager inventory is unreadable, so coverage cannot be computed.';
    envelope.security.secretCoverage = { _ok: false, _error: why,
      declared: notAttempted(why), provisioned: notAttempted(why),
      missing: notAttempted(why), missingNames: notAttempted(why),
      unmatched: notAttempted(why), unmatchedNames: notAttempted(why) };
  }

  /* When telemetry was last read. A figure with no read time cannot be told
     apart from a figure left on screen since yesterday. */
  envelope.observability.telemetryReadAt = (tele && tele.runRequests && tele.runRequests.observedAt)
    ? observation(tele.runRequests.observedAt, 'monitoring.timeSeries')
    : notAttempted('No telemetry series was read, so there is no read time.');

  /* ── DEPLOYMENTS AND FAILURES, derived from the activity log ─────────
     "Recent deployments" is not a separate API — it is the Admin Activity log
     filtered by the methods that actually deploy something. Deriving it keeps
     one source of truth; inventing a second reader would let the two disagree.

     The window is whatever the log read covered, and it is reported, because a
     count of deployments with no window is not a measurement. */
  if (activity._ok && activity.timeline &&
      (activity.timeline.state === 'observed' || activity.timeline.state === 'empty')) {
    const events = activity.timeline.value || [];
    const DEPLOY = /ReplaceService|CreateService|UpdateService|CreateFunction|UpdateFunction|SetIamPolicy|CreateRevision/i;
    const deploys = events.filter((e) => DEPLOY.test(String(e.method || '')));
    const failures = events.filter((e) => e.failed);
    envelope.activity.deployments = observation(deploys.length, 'derived: admin activity log');
    envelope.activity.deploymentInventory = inventory(deploys.map((e) => ({
      at: e.at, service: e.service, method: e.method, resource: e.resource,
      outcome: e.failed ? 'FAILED' : 'ok',
    })), deploys.length, 'derived: admin activity log');
    envelope.activity.failureInventory = inventory(failures.map((e) => ({
      at: e.at, service: e.service, method: e.method, resource: e.resource,
    })), failures.length, 'derived: admin activity log');
    envelope.activity.oldestEventAt = observation(
      events.length ? (events[events.length - 1] || {}).at || null : null,
      'derived: admin activity log');
  } else {
    const why = 'The activity log is unreadable, so deployments cannot be derived from it.';
    envelope.activity.deployments = notAttempted(why);
    envelope.activity.deploymentInventory = notAttempted(why);
    envelope.activity.failureInventory = notAttempted(why);
    envelope.activity.oldestEventAt = notAttempted(why);
  }

  /* ── EVIDENCE AGE ────────────────────────────────────────────────────
     How old this whole reading is. Rendered so an operator can tell a cockpit
     that was refreshed a second ago from one left open since yesterday — the
     figures look identical otherwise, and one of them is a lie by staleness. */
  envelope.evidenceAgeMs = observation(0, 'this read');
  envelope.staleAfterMs = observation(STALE_MS, 'STALE_MS');

  /* The envelope is ok when SOMETHING was read. A partial cockpit is still a
     cockpit; the per-field states say which instruments are out. */
  const domains = [proj, run, fns, ar, secrets, iam, mon, bill, apis, storage,
                   activity, tele, appcheck];
  const live = domains.filter((x) => x._ok).length;
  envelope.domainsRead   = observation(live, 'domain readers');
  envelope.domainsFailed = observation(domains.length - live, 'domain readers');
  envelope.ok = live > 0;
  if (!envelope.ok) envelope.error = 'No GCP control plane could be read.';
  return envelope;
}

module.exports = {
  readFirestoreEvidence, readGcpEvidence,
  STALE_MS, STATES, PROJECT, DATABASES,
  _internal: { observation, unreadable, notAttempted, notApplicable,
               withFreshness, readDatabase, listDatabases, listIndexes,
               listRootCollections, readIndexQuota, domain,
               readProject, readCloudRun, readFunctions, readArtifactRegistry,
               readSecrets, readIam, readMonitoring, readBilling,
               readEnabledApis, readStorage, readActivity, readRepoImages, inventory,
               readTelemetry, readIncidents, readBudgets, readAppCheck,
               metricSeries, sumPoints, peakPoint,
               INV_CAP, TELEMETRY_WINDOW_HOURS },
};
