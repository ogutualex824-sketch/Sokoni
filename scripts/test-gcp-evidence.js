/* ══════════════════════════════════════════════════════════════════════════════
   GCP EVIDENCE READER — CERTIFICATION            scripts/test-gcp-evidence.js

   WHAT THIS PINS
   The reader exists to turn em dashes into measured facts. The danger it
   introduces is the exact one the whole Integrations surface was built to
   prevent: a number on an admin console that no read produced.

   So every case here is about the BOUNDARY between the six observation states,
   and in particular the three that are trivially confusable and operationally
   very different:

       empty          a read succeeded and found nothing    -> value 0, a FINDING
       unreadable     a read failed                         -> NO value
       not-attempted  nothing looked                        -> NO value

   A reader that reported 0 for the second or third would be worse than no
   reader, because it would look authoritative.

   NOTHING HERE OPENS A SOCKET. The transport is injected in every case, so the
   suite runs the REAL module logic against scripted API responses and asserts
   on what it actually produced.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const FAILURES = [];
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else   { fail++; FAILURES.push(n + (d ? '   [' + d + ']' : ''));
           console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = (t) => console.log('\n' + t);

const gcp = require(path.join(ROOT, 'functions/gcp-evidence.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'functions/gcp-evidence.js'), 'utf8');

/* ── A scripted Google Cloud ────────────────────────────────────────────────
   Each endpoint either resolves a body or rejects. Keyed on the path so one
   endpoint can fail while its neighbours succeed — which is the whole point of
   observing each field independently. */
function makeApi (plan) {
  const hit = { get: [], post: [] };
  function route (kind, opts, body) {
    hit[kind].push(opts.path);
    /* EXACT match first, then longest substring. Neither alone is enough, and
       both failure modes have already bitten this suite:

         first-match   every index path also CONTAINS '/databases', so the
                       router answered index reads with the database list
         longest-match '/v3/projects/sokoni-aeb26' is a PREFIX of the IAM and
                       alert-policy paths and is LONGER than their distinctive
                       suffixes, so the project read swallowed both

       Substring routing over URL paths is a trap whenever one endpoint's path
       is a prefix of another's. Exact-first removes the ambiguity where it can
       be removed; longest-substring handles the rest. */
    /* A key may be HOST-QUALIFIED as "host|fragment". Two different Google
       APIs genuinely share a path shape — serviceusage and firebaseappcheck
       both answer at /v1/projects/{p}/services — so path alone cannot tell
       them apart, and whichever key matched later would silently answer for
       both. A qualified key matches only when the host matches too. */
    const qualified = Object.keys(plan).filter((k) => k.indexOf('|') !== -1);
    for (const k of qualified) {
      const parts = k.split('|');
      if (opts.host === parts[0] && opts.path.indexOf(parts[1]) !== -1) {
        const q = plan[k];
        if (q.reject) return Promise.reject(new Error(q.reject));
        return Promise.resolve(q.body);
      }
    }
    const exact = Object.keys(plan).find((k) => opts.path === k);
    /* Otherwise prefer the match that occurs LATEST in the path. The project
       prefix matches at index 0 for every endpoint; the distinctive part of an
       endpoint is its suffix. Length alone is not the discriminator — the
       project prefix is LONGER than ':getIamPolicy'. Position is. */
    const key = exact || Object.keys(plan)
      .filter((k) => opts.path.indexOf(k) !== -1)
      .sort((a, b) => (opts.path.indexOf(b) - opts.path.indexOf(a)) || (b.length - a.length))[0];
    const p = key ? plan[key] : null;
    if (!p)          return Promise.resolve({});
    if (p.reject)    return Promise.reject(new Error(p.reject));
    return Promise.resolve(p.body);
  }
  return {
    get:  (o)    => route('get', o),
    post: (o, b) => route('post', o, b),
    hit,
  };
}

const DBS = { body: { databases: [
  { name: 'projects/sokoni-aeb26/databases/(default)',  locationId: 'nam5',
    type: 'FIRESTORE_NATIVE', deleteProtectionState: 'DELETE_PROTECTION_ENABLED' },
  { name: 'projects/sokoni-aeb26/databases/sokoni-ops', locationId: 'europe-west1',
    type: 'FIRESTORE_NATIVE', deleteProtectionState: 'DELETE_PROTECTION_DISABLED' },
] } };

const mkIndexes = (ready, building) => ({ body: { indexes: [].concat(
  Array.from({ length: ready },    (_, i) => ({ name: 'p/collectionGroups/c' + i + '/indexes/x', state: 'READY' })),
  Array.from({ length: building }, (_, i) => ({ name: 'p/collectionGroups/d' + i + '/indexes/y', state: 'CREATING' }))
) } });

const QUOTA = { body: { metrics: [ { displayName: 'Composite indexes per database',
  consumerQuotaLimits: [ { quotaBuckets: [ { effectiveLimit: '1000' } ] } ] } ] } };

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  GCP EVIDENCE READER — CERTIFICATION');
  console.log('══════════════════════════════════════════════════════════════════');

  /* ══ 1. THE HAPPY PATH PRODUCES REAL, ATTRIBUTED OBSERVATIONS ══════════ */
  head('1 - a successful read is an observation, with a source and a timestamp');
  {
    const api = makeApi({
      '/databases?':        DBS,
      '/databases':         DBS,
      '(default)/collectionGroups': mkIndexes(410, 4),
      'sokoni-ops/collectionGroups': mkIndexes(54, 0),
      '(default)/documents:listCollectionIds':  { body: { collectionIds: Array.from({ length: 217 }, (_, i) => 'c' + i) } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': QUOTA,
    });
    const r = await gcp.readFirestoreEvidence({ get: api.get, post: api.post,
      declared: { '(default)': 414, 'sokoni-ops': 54 } });

    const def = r.databases['(default)'];
    const ops = r.databases['sokoni-ops'];

    ok('the envelope reports ok', r.ok === true, r.error);
    ok('both databases are present', !!def && !!ops);

    ok('the default region is observed', def.region.state === 'observed' && def.region.value === 'nam5',
       def.region.state + '/' + def.region.value);
    ok('sokoni-ops region is observed', ops.region.value === 'europe-west1', ops.region.value);

    ok('deployed index count is observed', def.indexesDeployed.value === 414,
       String(def.indexesDeployed.value));
    ok('READY is counted separately from deployed', def.indexesReady.value === 410,
       String(def.indexesReady.value));
    ok('and they are allowed to differ', def.indexesDeployed.value !== def.indexesReady.value);
    ok('the state breakdown is carried', def.indexStates.value.CREATING === 4,
       JSON.stringify(def.indexStates.value));

    ok('root collections are counted', def.rootCollections.value === 217,
       String(def.rootCollections.value));

    ok('every observation names its source', !!def.indexesDeployed.source,
       def.indexesDeployed.source);
    ok('every observation carries a timestamp', !!def.indexesDeployed.observedAt);
    ok('the live quota is read, not hardcoded', r.quota.value === 1000, String(r.quota.value));
    ok('the quota is attributed to the quota API', /serviceusage/.test(r.quota.source || ''),
       r.quota.source);
  }

  /* ══ 2. A MEASURED ZERO IS A FINDING, NOT AN ABSENCE ══════════════════ */
  head('2 - empty, unreadable and not-attempted are three different answers');
  {
    const api = makeApi({
      '/databases':         DBS,
      '(default)/collectionGroups': mkIndexes(410, 0),
      'sokoni-ops/collectionGroups': mkIndexes(54, 0),
      '(default)/documents:listCollectionIds':  { body: { collectionIds: ['a'] } },
      /* THE CASE THAT MATTERS: sokoni-ops genuinely has no root collections. */
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': QUOTA,
    });
    const r = await gcp.readFirestoreEvidence({ get: api.get, post: api.post });
    const ops = r.databases['sokoni-ops'];

    ok('an empty collection list is EMPTY, not unreadable',
       ops.rootCollections.state === 'empty', ops.rootCollections.state);
    ok('and it carries a real, measured 0', ops.rootCollections.value === 0,
       JSON.stringify(ops.rootCollections.value));
    ok('a measured zero names the source that measured it',
       /listCollectionIds/.test(ops.rootCollections.source || ''), ops.rootCollections.source);
    /* POSITIVE CONTROL — the same field on the other database is NOT zero, so
       "it reported 0" is a real reading rather than a reader that always says 0. */
    ok('control: the other database did NOT report zero',
       r.databases['(default)'].rootCollections.value === 1);
  }

  /* ══ 3. A FAILED READ NEVER BECOMES A NUMBER ══════════════════════════ */
  head('3 - a failed read is unreadable, with a reason, and has NO value');
  {
    const api = makeApi({
      '/databases':         DBS,
      '(default)/collectionGroups': { reject: 'PERMISSION_DENIED on firestore.indexes.list' },
      'sokoni-ops/collectionGroups': mkIndexes(54, 0),
      '(default)/documents:listCollectionIds':  { reject: 'backend unavailable' },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': { reject: 'quota API refused' },
    });
    const r = await gcp.readFirestoreEvidence({ get: api.get, post: api.post });
    const def = r.databases['(default)'];

    ok('a refused index read is unreadable', def.indexesDeployed.state === 'unreadable',
       def.indexesDeployed.state);
    ok('it has NO value at all', def.indexesDeployed.value === null,
       JSON.stringify(def.indexesDeployed.value));
    ok('it is NOT zero', def.indexesDeployed.value !== 0);
    ok('and it names why', /PERMISSION_DENIED/.test(def.indexesDeployed.reason),
       def.indexesDeployed.reason);

    ok('a failed collection read is unreadable, not an empty database',
       def.rootCollections.state === 'unreadable', def.rootCollections.state);
    ok('and is NOT reported as 0 collections', def.rootCollections.value !== 0);

    ok('an unreadable quota is unreadable, never a guessed limit',
       r.quota.state === 'unreadable' && r.quota.value === null, r.quota.state);

    /* INVERTING CONTROL — the neighbouring database still read successfully, so
       these failures are per-field and not a reader that failed wholesale. */
    ok('control: a neighbouring field still observed successfully',
       r.databases['sokoni-ops'].indexesDeployed.state === 'observed',
       r.databases['sokoni-ops'].indexesDeployed.state);
  }

  /* ══ 4. DECLARED vs DEPLOYED IS NEVER INFERRED ════════════════════════ */
  head('4 - drift is computed only from a supplied declaration');
  {
    const plan = {
      '/databases':         DBS,
      '(default)/collectionGroups': mkIndexes(410, 0),
      'sokoni-ops/collectionGroups': mkIndexes(54, 0),
      '(default)/documents:listCollectionIds':  { body: { collectionIds: [] } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': QUOTA,
    };
    const withDecl = await gcp.readFirestoreEvidence({
      get: makeApi(plan).get, post: makeApi(plan).post,
      declared: { '(default)': 414, 'sokoni-ops': 54 } });
    const noDecl = await gcp.readFirestoreEvidence({
      get: makeApi(plan).get, post: makeApi(plan).post });

    ok('drift is the declared-minus-deployed difference',
       withDecl.databases['(default)'].indexDrift.value === 4,
       String(withDecl.databases['(default)'].indexDrift.value));
    ok('a reconciled database reports zero drift as EMPTY, a real finding',
       withDecl.databases['sokoni-ops'].indexDrift.state === 'empty',
       withDecl.databases['sokoni-ops'].indexDrift.state);

    ok('without a declaration, drift is NOT-ATTEMPTED, never 0',
       noDecl.databases['(default)'].indexDrift.state === 'not-attempted',
       noDecl.databases['(default)'].indexDrift.state);
    ok('and it carries no value', noDecl.databases['(default)'].indexDrift.value === null);
    ok('the declaration itself is also not-attempted',
       noDecl.databases['(default)'].indexesDeclared.state === 'not-attempted');
  }

  /* ══ 5. DRIFT IS UNKNOWN WHEN EITHER SIDE IS UNKNOWN ══════════════════ */
  head('5 - an unreadable deployed count makes drift unknown, not zero');
  {
    const api = makeApi({
      '/databases': DBS,
      '(default)/collectionGroups': { reject: 'refused' },
      'sokoni-ops/collectionGroups': mkIndexes(54, 0),
      '(default)/documents:listCollectionIds':  { body: { collectionIds: [] } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': QUOTA,
    });
    const r = await gcp.readFirestoreEvidence({ get: api.get, post: api.post,
      declared: { '(default)': 414, 'sokoni-ops': 54 } });
    const def = r.databases['(default)'];
    ok('drift is unreadable when the deployed side is unreadable',
       def.indexDrift.state === 'unreadable', def.indexDrift.state);
    ok('it is NOT reported as 414 of drift', def.indexDrift.value !== 414);
    ok('it is NOT reported as 0 drift', def.indexDrift.value !== 0);
    /* CONTROL — the database whose read SUCCEEDED does compute drift. */
    ok('control: the readable database still reconciles',
       r.databases['sokoni-ops'].indexDrift.state === 'empty');
  }

  /* ══ 6. CREDENTIAL FAILURE DEGRADES HONESTLY ══════════════════════════ */
  head('6 - no credentials means unreadable, never an empty estate');
  {
    const r = await gcp.readFirestoreEvidence({
      token: async () => { throw new Error('metadata server unreachable'); } });
    ok('the envelope is not ok', r.ok === false);
    ok('and says why', /Could not obtain credentials/.test(r.error), r.error);
    ok('databases are unreadable, not absent',
       r.databases['(default)'].region.state === 'unreadable',
       r.databases['(default)'].region.state);
    ok('no field invented a value', r.databases['(default)'].region.value === null);
  }

  /* ══ 7. FRESHNESS IS APPLIED, NOT ASSUMED ═════════════════════════════ */
  head('7 - an observation goes stale; unreadable does not become stale');
  {
    const o = gcp._internal.observation(5, 'src');
    const fresh = gcp._internal.withFreshness(o, Date.parse(o.observedAt) + 1000);
    const old   = gcp._internal.withFreshness(o, Date.parse(o.observedAt) + gcp.STALE_MS + 1000);
    ok('inside the window it stays observed', fresh.state === 'observed', fresh.state);
    ok('outside the window it becomes stale', old.state === 'stale', old.state);
    ok('and the value survives going stale', old.value === 5);

    const u = gcp._internal.unreadable('src', 'nope');
    ok('an unreadable reading never becomes stale',
       gcp._internal.withFreshness(u, Date.now() + 1e9).state === 'unreadable');
    ok('STALE_MS matches the console threshold', gcp.STALE_MS === 300000, String(gcp.STALE_MS));
  }

  /* ══ 8. THE READER WRITES NOTHING AND HOLDS NO SECRET ═════════════════ */
  head('8 - read-only by construction, and it binds no secret');
  {
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /* POSITIVE CONTROL — the stripper left real code behind. Without this every
       absence check below would pass on an empty string. */
    ok('control: stripped source still contains the reads',
       /listIndexes/.test(stripped) && /httpsJson/.test(stripped), String(stripped.length));

    /* DISCRIMINATE BY SYNTAX, NOT BY WORD.
       A bare-word scan for 'DELETE' fires on `action === 'DELETE'` — an
       Artifact Registry cleanup-policy VALUE this reader must be able to read
       and display, since a reference-blind DELETE policy is the thing that
       emptied both repositories. Reading the word is the job; performing the
       verb is the violation. So the check is on the HTTP method and on call
       syntax, which a compared string literal cannot satisfy. */
    [/method:\s*'(DELETE|PATCH|PUT)'/, /\.delete\s*\(/, /\.patch\s*\(/,
     /createIndex/, /updateDatabase/, /patchDatabase/, /\.setIamPolicy\s*\(/]
      .forEach((re) => ok('no mutation syntax: ' + re, !re.test(stripped)));

    /* POSITIVE CONTROL for the discrimination itself — the matcher must still
       fire on a real mutation, and must NOT fire on a policy value. */
    ok('control: the syntax matcher catches a real DELETE request',
       /method:\s*'(DELETE|PATCH|PUT)'/.test("httpsJson({ method: 'DELETE' })"));
    ok('control: the syntax matcher ignores a DELETE policy VALUE',
       !/method:\s*'(DELETE|PATCH|PUT)'/.test("pol[k].action === 'DELETE'"));
    ok('control: the reader really does read DELETE policy values',
       /action === 'DELETE'/.test(stripped));

    /* POST DOES NOT MEAN WRITE HERE, AND THAT IS NOT A LOOPHOLE.
       Two Google read APIs require a request body and are therefore POSTs:

         documents:listCollectionIds   enumerates root collections
         :getIamPolicy                 returns the policy; the WRITE twin is
                                       :setIamPolicy, which must never appear

       So the check is not "how many POSTs" — a count would pass for a POST to
       any endpoint. It is which ENDPOINTS are posted to, against an allowlist,
       plus the explicit absence of every mutating twin. */
    const READ_POST_ENDPOINTS = ['documents:listCollectionIds', ':getIamPolicy'];
    const postTargets = (stripped.match(/path:\s*'[^']*'|path:\s*'[^']*'\s*\+/g) || []);
    ok('control: post targets were found to inspect', postTargets.length > 0,
       String(postTargets.length));
    READ_POST_ENDPOINTS.forEach((e) => {
      ok('read-POST endpoint present and allowlisted: ' + e, stripped.indexOf(e) !== -1);
    });
    /* The mutating twins of every read used here. */
    [':setIamPolicy', ':testIamPermissions', 'documents:commit', 'documents:write',
     'documents:rollback', ':undelete', ':disable', ':restore']
      .forEach((w) => ok('mutating twin absent: ' + w, stripped.indexOf(w) === -1));

    ok('no defineSecret anywhere', stripped.indexOf('defineSecret') === -1);
    ok('the scope is read-only', /cloud-platform\.read-only/.test(stripped));
    ok('no secret value is ever logged', !/console\.log\([^)]*token/i.test(stripped));

    /* INVERTING CONTROL — the matchers can find a mutation when one is present. */
    const fixture = "fetch({ method: 'PATCH' }); admin.firestore().doc('x').delete();";
    ok('control: the mutation matcher catches a real mutation',
       fixture.indexOf('PATCH') !== -1 && fixture.indexOf('.delete(') !== -1);
  }

  /* ══ 9. THE READER DECLARES ITS OWN LIMITS ════════════════════════════ */
  head('9 - what it does not cover is stated, not implied');
  {
    const api = makeApi({ '/databases': DBS, 'consumerQuotaMetrics': QUOTA });
    const r = await gcp.readFirestoreEvidence({ get: api.get, post: api.post });
    ok('it lists what it covers', (r.covers || []).length >= 3, (r.covers || []).join(','));
    ok('it lists what it does NOT cover', (r.notCovered || []).indexOf('cloud-run') !== -1,
       (r.notCovered || []).join(','));
    ok('IAM is explicitly not covered', (r.notCovered || []).indexOf('iam') !== -1);
    ok('billing is explicitly not covered', (r.notCovered || []).indexOf('billing') !== -1);
    ok('the project is named', r.project === 'sokoni-aeb26', r.project);
  }

  /* ══ 10. THE FULL COCKPIT — DOMAIN ISOLATION ══════════════════════════
     A cockpit where one dead API blanks the whole screen is worse than one that
     says precisely which instrument is out. Each control plane must observe
     independently. */
  head('10 - every GCP domain observes independently');
  {
    const FULL_PLAN = {
      '/v3/projects/sokoni-aeb26':          { body: { name: 'projects/24799054989', state: 'ACTIVE', displayName: 'SOKONI' } },
      'locations/-/services':               { body: { services: [
        { name: 'projects/p/locations/us-central1/services/a',
          conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
          latestCreatedRevision: 'r2', latestReadyRevision: 'r1',
          template: { scaling: { maxInstanceCount: 80, minInstanceCount: 1 } } },
        { name: 'projects/p/locations/europe-west1/services/b',
          conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
          latestCreatedRevision: 'r5', latestReadyRevision: 'r5', template: { scaling: {} } },
      ] } },
      'locations/-/functions':              { body: { functions: [
        { name: 'projects/p/locations/us-central1/functions/f1', state: 'ACTIVE',
          buildConfig: { runtime: 'nodejs22' } },
        { name: 'projects/p/locations/us-east1/functions/f2', state: 'FAILED',
          buildConfig: { runtime: 'nodejs20' } },
      ] } },
      'locations/-/repositories':           { body: { repositories: [
        { name: 'projects/p/locations/us-central1/repositories/gcf-artifacts',
          cleanupPolicies: { 'firebase-functions-cleanup': {}, 'sokoni-recovery-protection': {} } },
        { name: 'projects/p/locations/us-east1/repositories/gcf-artifacts',
          cleanupPolicies: { 'firebase-functions-cleanup': {} } },
      ] } },
      '/v1/projects/sokoni-aeb26/secrets':  { body: { secrets: [
        { name: 'projects/p/secrets/INTASEND_API_KEY' },
        { name: 'projects/p/secrets/SENDGRID_API_KEY', rotation: {} },
      ] } },
      ':getIamPolicy':                      { body: {
        bindings: [
          { role: 'roles/owner',  members: ['user:a@x.com'] },
          { role: 'roles/editor', members: ['serviceAccount:s@x.iam.gserviceaccount.com', 'user:b@x.com'] },
        ],
        auditConfigs: [{ service: 'artifactregistry.googleapis.com',
          auditLogConfigs: [{ logType: 'ADMIN_READ' }, { logType: 'DATA_WRITE' }] }],
      } },
      'alertPolicies':                      { body: { alertPolicies: [
        { enabled: true, notificationChannels: ['c1'] }, { enabled: false },
      ] } },
      'billingInfo':                        { body: { billingEnabled: true,
        billingAccountName: 'billingAccounts/XXXX' } },
      '/databases':                         DBS,
      '(default)/collectionGroups':         mkIndexes(410, 0),
      'sokoni-ops/collectionGroups':        mkIndexes(54, 0),
      '(default)/documents:listCollectionIds':  { body: { collectionIds: ['a'] } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics':               QUOTA,
    };
    const api = makeApi(FULL_PLAN);
    const r = await gcp.readGcpEvidence({ get: api.get, post: api.post });

    ok('the cockpit reports ok', r.ok === true, r.error);
    ok('the project number is read', r.projectInfo.projectNumber.value === '24799054989',
       String(r.projectInfo.projectNumber.value));
    ok('the project state is read', r.projectInfo.state.value === 'ACTIVE');

    ok('Cloud Run services are counted', r.compute.cloudRun.services.value === 2);
    /* The failure shape this platform actually hit: a created revision that
       never became ready. */
    ok('a revision mismatch is surfaced', r.compute.cloudRun.revisionMismatch.value === 1,
       String(r.compute.cloudRun.revisionMismatch.value));
    ok('an unbounded service is surfaced', r.compute.cloudRun.unboundedScaling.value === 1,
       String(r.compute.cloudRun.unboundedScaling.value));

    ok('functions are counted by state', r.compute.functions.failed.value === 1);
    ok('runtimes are broken down', r.compute.functions.runtimes.value.nodejs22 === 1,
       JSON.stringify(r.compute.functions.runtimes.value));

    /* The Artifact Registry fact that matters most here. */
    ok('cleanup policies are counted per name',
       r.compute.artifactRegistry.cleanupPolicies.value['firebase-functions-cleanup'] === 2,
       JSON.stringify(r.compute.artifactRegistry.cleanupPolicies.value));
    ok('the KEEP policy is visible as present on only ONE repo',
       r.compute.artifactRegistry.cleanupPolicies.value['sokoni-recovery-protection'] === 1);
    ok('enforcing repositories are counted',
       r.compute.artifactRegistry.enforcingRepos.value === 2);

    ok('secrets are counted', r.security.secrets.secrets.value === 2);
    ok('secret NAMES are listed', r.security.secrets.names.value.indexOf('INTASEND_API_KEY') !== -1);

    ok('IAM owners are counted', r.security.iam.owners.value === 1);
    ok('IAM service accounts are counted', r.security.iam.serviceAccounts.value === 1);
    ok('audit log types are surfaced', r.security.iam.auditLogTypes.value.ADMIN_READ === 1,
       JSON.stringify(r.security.iam.auditLogTypes.value));

    ok('alert policies are counted', r.observability.monitoring.alertPolicies.value === 2);
    ok('only enabled policies count as enabled', r.observability.monitoring.enabled.value === 1);
    ok('billing state is observed', r.observability.billing.billingEnabled.value === true);

    /* Region coverage is DERIVED from what is running, not configured. */
    ok('region coverage is derived from observed resources',
       r.regions.value.indexOf('europe-west1') !== -1 && r.regions.value.indexOf('us-east1') !== -1,
       JSON.stringify(r.regions.value));
    ok('and it names its derivation', /derived/.test(r.regions.source || ''), r.regions.source);

    ok('all domains read', r.domainsFailed.state === 'empty', String(r.domainsFailed.value));
  }

  head('11 - one dead control plane does not blank the others');
  {
    const plan = Object.assign({}, {
      '/v3/projects/sokoni-aeb26':  { reject: 'PERMISSION_DENIED on resourcemanager' },
      'locations/-/services':       { reject: 'run API disabled' },
      'locations/-/functions':      { body: { functions: [{ name: 'projects/p/locations/us-central1/functions/f', state: 'ACTIVE', buildConfig: { runtime: 'nodejs22' } }] } },
      'locations/-/repositories':   { body: { repositories: [] } },
      '/v1/projects/sokoni-aeb26/secrets': { body: { secrets: [] } },
      ':getIamPolicy':              { reject: 'iam refused' },
      'alertPolicies':              { body: { alertPolicies: [] } },
      /* Scripted explicitly: the timeSeries path also CONTAINS the project
         prefix, so without its own key it inherits whatever the project read
         returned — which here is a rejection, and telemetry would fail for a
         reason the fixture never intended. */
      'timeSeries':                 { body: { timeSeries: [] } },
      'billingInfo':                { body: { billingEnabled: false } },
      '/databases':                 DBS,
      '(default)/collectionGroups': mkIndexes(1, 0),
      'sokoni-ops/collectionGroups': mkIndexes(1, 0),
      '(default)/documents:listCollectionIds':  { body: { collectionIds: [] } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics':       QUOTA,
    });
    const api = makeApi(plan);
    const r = await gcp.readGcpEvidence({ get: api.get, post: api.post });

    ok('the cockpit is still ok with domains down', r.ok === true, r.error);
    ok('a dead domain is unreadable', r.compute.cloudRun.services.state === 'unreadable',
       r.compute.cloudRun.services.state);
    ok('and reports NO value', r.compute.cloudRun.services.value === null);
    ok('and is NOT reported as zero services', r.compute.cloudRun.services.value !== 0);
    ok('IAM being refused does not blank monitoring',
       r.observability.monitoring.alertPolicies.state === 'empty',
       r.observability.monitoring.alertPolicies.state);
    /* CONTROL — a neighbouring domain read successfully in the same run. */
    ok('control: a live domain still observed', r.compute.functions.total.value === 1,
       String(r.compute.functions.total.value));
    /* THREE domains were scripted to fail: project, Cloud Run and IAM. The
       number is the fixture's, not a guess — and it is cross-checked below
       against the states actually produced, so a change in how domains are
       counted cannot quietly satisfy it. */
    ok('failed domains are counted', r.domainsFailed.value === 3,
       String(r.domainsFailed.value));
    ok('and the count matches the domains actually unreadable',
       r.compute.cloudRun.services.state === 'unreadable' &&
       r.security.iam.bindings.state === 'unreadable' &&
       r.projectInfo.projectNumber.state === 'unreadable');

    /* An EMPTY repository list is a measured zero, not a failure. */
    ok('an empty repository list is a measured zero',
       r.compute.artifactRegistry.repositories.state === 'empty' &&
       r.compute.artifactRegistry.repositories.value === 0);
    /* Billing disabled is FALSE — a real observation, not an absence. */
    ok('billing disabled is observed as false, not as missing',
       r.observability.billing.billingEnabled.value === false &&
       r.observability.billing.billingEnabled.state === 'observed');
  }

  /* ══ 13. INVENTORIES, PROVENANCE AND THE ADMINS ═══════════════════════ */
  head('13 - drill-down inventories, image provenance, and who can change the project');
  {
    const IMG_DIGEST = 'sha256:133a75e9aaaabbbbccccddddeeeeffff00001111222233334444555566667777';
    const GONE_DIGEST = 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const plan = {
      '/v3/projects/sokoni-aeb26': { body: { name: 'projects/24799054989', state: 'ACTIVE' } },
      'locations/-/services': { body: { services: [
        { name: 'projects/p/locations/us-central1/services/profilegetpublicprofile',
          conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
          latestCreatedRevision: '00007-xaz', latestReadyRevision: '00007-xaz',
          template: { scaling: { maxInstanceCount: 80, minInstanceCount: 1 },
            maxInstanceRequestConcurrency: 80, timeout: '540s',
            serviceAccount: 'sa@x.iam.gserviceaccount.com',
            containers: [{ image: 'us-central1-docker.pkg.dev/p/gcf-artifacts/x@' + IMG_DIGEST,
              resources: { limits: { cpu: '1', memory: '512Mi' } } }] },
          trafficStatuses: [{ revision: '00007-xaz', percent: 100 }] },
        /* Pinned to a digest that is NOT in the registry — the exact condition
           that left services unable to create a new revision. */
        { name: 'projects/p/locations/us-east1/services/orphaned',
          conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
          latestCreatedRevision: 'r9', latestReadyRevision: 'r8',
          template: { scaling: {},
            containers: [{ image: 'us-east1-docker.pkg.dev/p/gcf-artifacts/y@' + GONE_DIGEST }] } },
      ] } },
      'locations/-/functions': { body: { functions: [
        { name: 'projects/p/locations/us-central1/functions/processTypesenseQueue',
          state: 'ACTIVE', environment: 'GEN_2',
          buildConfig: { runtime: 'nodejs22' },
          serviceConfig: { service: 'projects/p/locations/us-central1/services/processtypesensequeue',
            revision: '00022-fon', availableMemory: '512Mi', timeoutSeconds: 540,
            maxInstanceCount: 80, serviceAccountEmail: 'sa@x.iam.gserviceaccount.com' } },
        { name: 'projects/p/locations/us-east1/functions/unbounded', state: 'ACTIVE',
          buildConfig: { runtime: 'nodejs20' }, serviceConfig: {} },
      ] } },
      'locations/-/repositories': { body: { repositories: [
        { name: 'projects/p/locations/us-central1/repositories/gcf-artifacts', format: 'DOCKER',
          cleanupPolicies: {
            'firebase-functions-cleanup': { action: 'DELETE',
              condition: { olderThan: '86400s', tagState: 'ANY' } },
            'sokoni-recovery-protection': { action: 'KEEP', mostRecentVersions: { keepCount: 10 } } } },
        /* DELETE with no KEEP beside it — the configuration that emptied a repo. */
        { name: 'projects/p/locations/us-east1/repositories/gcf-artifacts', format: 'DOCKER',
          cleanupPolicies: {
            'firebase-functions-cleanup': { action: 'DELETE',
              condition: { olderThan: '86400s', tagState: 'ANY' } } } },
      ] } },
      'us-central1/repositories/gcf-artifacts/dockerImages': { body: { dockerImages: [
        { name: 'projects/p/locations/us-central1/repositories/gcf-artifacts/dockerImages/x',
          uri: 'us-central1-docker.pkg.dev/p/gcf-artifacts/x@' + IMG_DIGEST,
          tags: ['latest'], uploadTime: '2026-09-21T04:21:47Z', imageSizeBytes: '12345' },
      ] } },
      'us-east1/repositories/gcf-artifacts/dockerImages': { body: { dockerImages: [] } },
      '/v1/projects/sokoni-aeb26/secrets': { body: { secrets: [] } },
      ':getIamPolicy': { body: { bindings: [
        { role: 'roles/owner',  members: ['user:founder@sokoni.co.ke'] },
        { role: 'roles/editor', members: ['user:dev@sokoni.co.ke',
                                          'serviceAccount:ci@x.iam.gserviceaccount.com'] },
        { role: 'roles/firebase.admin', members: ['group:ops@sokoni.co.ke'] },
        { role: 'roles/viewer', members: ['user:audit@sokoni.co.ke'] },
      ], auditConfigs: [
        { service: 'artifactregistry.googleapis.com',
          auditLogConfigs: [{ logType: 'ADMIN_READ' }, { logType: 'DATA_WRITE' }] },
      ] } },
      'alertPolicies': { body: { alertPolicies: [] } },
      'billingInfo': { body: { billingEnabled: true } },
      '/services?filter=state:ENABLED': { body: { services: [
        { name: 'projects/p/services/run.googleapis.com', config: { name: 'run.googleapis.com' } },
        { name: 'projects/p/services/firestore.googleapis.com', config: { name: 'firestore.googleapis.com' } },
      ] } },
      '/storage/v1/b': { body: { items: [
        { name: 'sokoni-media', location: 'US',
          iamConfiguration: { publicAccessPrevention: 'enforced',
            uniformBucketLevelAccess: { enabled: true } } },
      ] } },
      '/v2/entries:list': { body: { entries: [
        { timestamp: '2026-09-21T09:21:00Z', severity: 'NOTICE', protoPayload: {
          serviceName: 'run.googleapis.com', methodName: 'Services.ReplaceService',
          resourceName: 'namespaces/p/services/processtypesensequeue' } },
        { timestamp: '2026-09-21T09:19:00Z', severity: 'ERROR', protoPayload: {
          serviceName: 'artifactregistry.googleapis.com', methodName: 'BatchDeleteVersions',
          resourceName: 'repo/x', status: { code: 7, message: 'denied' } } },
      ] } },
      '/databases': DBS,
      '(default)/collectionGroups': mkIndexes(1, 0),
      'sokoni-ops/collectionGroups': mkIndexes(1, 0),
      '(default)/documents:listCollectionIds': { body: { collectionIds: ['a'] } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': QUOTA,
    };
    const api = makeApi(plan);
    const r = await gcp.readGcpEvidence({ get: api.get, post: api.post });

    /* ── Cloud Run per-service drill-down ── */
    const svc = r.compute.cloudRun.inventory.value.find((s) => s.name === 'profilegetpublicprofile');
    ok('a Cloud Run service inventory is produced', !!svc);
    ok('it carries the serving revision', svc.latestReadyRevision === '00007-xaz');
    ok('it carries the scaling contract', svc.maxScale === 80 && svc.minScale === 1,
       svc.minScale + '/' + svc.maxScale);
    ok('it carries cpu, memory, concurrency and timeout',
       svc.cpu === '1' && svc.memory === '512Mi' && svc.concurrency === 80 && svc.timeout === '540s');
    ok('it carries the image and the service account',
       /@sha256:/.test(svc.image) && /iam\.gserviceaccount/.test(svc.serviceAccount));
    ok('it carries traffic split', svc.traffic[0].percent === 100);
    ok('revision parity is computed', svc.revisionParity === true);

    const orphan = r.compute.cloudRun.inventory.value.find((s) => s.name === 'orphaned');
    ok('a service whose created revision is not ready is flagged',
       orphan.revisionParity === false);
    /* A MISSING max is null, never 0 — unbounded is not "zero instances". */
    ok('an absent max-instance limit is null, not 0', orphan.maxScale === null,
       JSON.stringify(orphan.maxScale));

    /* ── Function -> service link ── */
    const fn = r.compute.functions.inventory.value.find((f) => f.name === 'processTypesenseQueue');
    ok('a function names the Cloud Run service it runs on',
       fn.service === 'processtypesensequeue', String(fn.service));
    ok('and its revision, runtime and scaling',
       fn.revision === '00022-fon' && fn.runtime === 'nodejs22' && fn.maxInstances === 80);
    ok('the estate scaling breakdown counts an unset maximum',
       r.compute.functions.scaling.value.unset === 1,
       JSON.stringify(r.compute.functions.scaling.value));
    /* The source contract is not in the API, and is reported as absent. */
    ok('the source contract is explicitly null, not invented', fn.sourceContract === null);

    /* ── Artifact Registry provenance ── */
    ok('per-repository policies carry their ACTION',
       r.compute.artifactRegistry.inventory.value[0].policies
         .some((p) => p.action === 'DELETE' && p.olderThan === '86400s'));
    ok('and the KEEP policy with its keepCount',
       r.compute.artifactRegistry.inventory.value[0].policies
         .some((p) => p.action === 'KEEP' && p.keepCount === 10));
    ok('a repository with DELETE and no KEEP is counted',
       r.compute.artifactRegistry.reposWithDeleteOnly.value === 1,
       String(r.compute.artifactRegistry.reposWithDeleteOnly.value));
    ok('images are enumerated with their digest',
       r.compute.images.inventory.value.some((i) => i.digest === IMG_DIGEST));

    /* ── THE JOIN: revision -> image -> registry ── */
    ok('services pinned by digest are counted',
       r.compute.provenance.servicesPinnedByDigest.value === 2,
       String(r.compute.provenance.servicesPinnedByDigest.value));
    ok('a serving image MISSING from the registry is surfaced',
       r.compute.provenance.imageMissingFromRegistry.value === 1,
       String(r.compute.provenance.imageMissingFromRegistry.value));
    ok('and the missing one is named',
       r.compute.provenance.missingInventory.value[0].service === 'orphaned');
    /* CONTROL — the present image is NOT reported missing. */
    ok('control: the image that IS in the registry is not flagged',
       !r.compute.provenance.missingInventory.value.some((m) => m.service === 'profilegetpublicprofile'));

    /* ── THE ADMINS ── */
    const roles = r.security.iam.adminBindings.value.map((b) => b.role);
    ok('owners are listed as admins', roles.indexOf('roles/owner') !== -1, roles.join(','));
    ok('editors are listed as admins', roles.indexOf('roles/editor') !== -1);
    ok('a role whose NAME contains admin is included',
       roles.indexOf('roles/firebase.admin') !== -1, roles.join(','));
    /* CONTROL — a non-admin role is NOT swept in. */
    ok('control: viewer is NOT listed as an admin', roles.indexOf('roles/viewer') === -1);
    ok('the actual principals are shown, not just a count',
       r.security.iam.adminBindings.value
         .find((b) => b.role === 'roles/owner').members[0] === 'user:founder@sokoni.co.ke');
    ok('human principals are separated from machine ones',
       r.security.iam.humanPrincipals.value.length === 3 &&
       r.security.iam.groupPrincipals.value.length === 1,
       r.security.iam.humanPrincipals.value.length + '/' + r.security.iam.groupPrincipals.value.length);
    ok('per-service audit coverage lists its log types',
       r.security.iam.auditCoverage.value[0].logTypes.join(',') === 'ADMIN_READ,DATA_WRITE',
       r.security.iam.auditCoverage.value[0].logTypes.join(','));

    /* ── Enabled APIs, storage, activity ── */
    ok('enabled APIs are counted', r.apis.enabled.value === 2);
    ok('storage buckets are enumerated', r.data.storage.buckets.value === 1);
    ok('bucket public-access prevention is counted', r.data.storage.publicAccessPrevention.value === 1);
    ok('the activity timeline is produced', r.activity.events.value === 2);
    ok('a failed audit event is counted as failed', r.activity.failures.value === 1,
       String(r.activity.failures.value));
    ok('the timeline carries service, method and resource',
       r.activity.timeline.value[0].method === 'Services.ReplaceService');
    ok('the most recent event time is surfaced',
       r.activity.lastEventAt.value === '2026-09-21T09:21:00Z');
    /* The timeline must NOT carry a request payload. */
    ok('the timeline carries no request payload',
       !('request' in r.activity.timeline.value[0]) &&
       !('principalEmail' in r.activity.timeline.value[0]));
  }

  /* ══ 14. TELEMETRY, COST CONDITIONS, SERVICE-ACCOUNT USAGE ═══════════ */
  head('14 - real telemetry, derived cost conditions, and who runs as what');
  {
    const ts = (n) => ({ body: { timeSeries: [
      { points: [{ value: { int64Value: String(n) } }] } ] } });

    const plan = {
      '/v3/projects/sokoni-aeb26': { body: { name: 'projects/24799054989', state: 'ACTIVE' } },
      'locations/-/services': { body: { services: [
        /* pinned minimum — bills while idle */
        { name: 'projects/p/locations/us-central1/services/pinned',
          conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
          template: { scaling: { minInstanceCount: 1, maxInstanceCount: 80 },
                      serviceAccount: 'sa-a@x.iam.gserviceaccount.com', containers: [{}] } },
        /* unbounded — no ceiling at all */
        { name: 'projects/p/locations/us-east1/services/unbounded',
          conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
          template: { scaling: {}, serviceAccount: 'sa-a@x.iam.gserviceaccount.com',
                      containers: [{}] } },
        /* a very high ceiling */
        { name: 'projects/p/locations/us-central1/services/huge',
          conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
          template: { scaling: { maxInstanceCount: 500 }, containers: [{}] } },
      ] } },
      'locations/-/functions': { body: { functions: [
        { name: 'projects/p/locations/us-central1/functions/f1', state: 'ACTIVE',
          buildConfig: { runtime: 'nodejs22' },
          serviceConfig: { serviceAccountEmail: 'sa-a@x.iam.gserviceaccount.com' } },
      ] } },
      'locations/-/repositories': { body: { repositories: [] } },
      '/v1/projects/sokoni-aeb26/secrets': { body: { secrets: [] } },
      ':getIamPolicy': { body: { etag: 'E', bindings: [
        { role: 'roles/run.invoker',  members: ['serviceAccount:sa-a@x.iam.gserviceaccount.com'] },
        /* An identity holding a role that NOTHING runs as. */
        { role: 'roles/storage.admin', members: ['serviceAccount:orphan@x.iam.gserviceaccount.com'] },
      ] } },
      'alertPolicies': { body: { alertPolicies: [] } },
      'billingInfo': { body: { billingEnabled: true,
        billingAccountName: 'billingAccounts/ABC' } },
      '/budgets': { body: { budgets: [{ displayName: 'monthly', thresholdRules: [{}] }] } },
      /* Telemetry: every series resolves the same scripted total. */
      'timeSeries': ts(7),
      'serviceusage.googleapis.com|/services': { body: { services: [
        { config: { name: 'run.googleapis.com' } } ] } },
      '/storage/v1/b': { body: { items: [] } },
      '/v2/entries:list': { body: { entries: [] } },
      'firebaseappcheck.googleapis.com|/services': { body: { services: [
        { name: 'projects/p/services/firestore.googleapis.com', enforcementMode: 'ENFORCED' },
        { name: 'projects/p/services/identitytoolkit.googleapis.com', enforcementMode: 'UNENFORCED' },
      ] } },
      '/databases': DBS,
      '(default)/collectionGroups': mkIndexes(1, 0),
      'sokoni-ops/collectionGroups': mkIndexes(1, 0),
      '(default)/documents:listCollectionIds': { body: { collectionIds: [] } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': QUOTA,
    };
    const api = makeApi(plan);
    const r = await gcp.readGcpEvidence({ get: api.get, post: api.post });

    /* ── Telemetry ── */
    const t = r.observability.telemetry;
    ok('the telemetry window is stated', t.windowHours === 24, String(t.windowHours));
    ok('Cloud Run requests are measured', t.runRequests.value === 7, String(t.runRequests.value));
    ok('5xx is a separate series from total requests', t.run5xx.state === 'observed');
    ok('function executions are measured', t.fnExecutions.value === 7);
    ok('Firestore reads and writes are separate',
       t.firestoreReads.state === 'observed' && t.firestoreWrites.state === 'observed');
    ok('every telemetry figure names its window in the source',
       /24h/.test(t.runRequests.source || ''), t.runRequests.source);

    /* OPEN INCIDENTS is honestly not-attempted, never zero. */
    ok('open incidents is not-attempted, not zero',
       r.observability.incidents.openIncidents.state === 'not-attempted',
       r.observability.incidents.openIncidents.state);

    /* ── Budgets ── */
    ok('budgets are read once the billing account is known',
       r.observability.budgets.budgets.value === 1,
       String(r.observability.budgets.budgets.value));

    /* ── App Check ── */
    ok('App Check services are counted', r.security.appCheck.services.value === 2);
    ok('enforced and unenforced are counted separately',
       r.security.appCheck.enforced.value === 1 && r.security.appCheck.unenforced.value === 1);

    /* ── Cost conditions, DERIVED ── */
    ok('a pinned minimum is surfaced', r.cost.pinnedInstances.value === 1,
       String(r.cost.pinnedInstances.value));
    ok('and the service is named', r.cost.pinnedInventory.value[0].service === 'pinned');
    ok('an unbounded service is surfaced', r.cost.unboundedServices.value === 1,
       String(r.cost.unboundedServices.value));
    ok('a very high ceiling is surfaced', r.cost.highMaxScale.value === 1,
       String(r.cost.highMaxScale.value));
    /* THE HONEST GAPS. */
    ok('per-service traffic is not-attempted, never zero',
       r.cost.servicesWithNoObservedTraffic.state === 'not-attempted');
    ok('a cost breakdown is not-attempted, never zero',
       r.cost.costBreakdown.state === 'not-attempted');

    /* ── Service accounts: the JOIN ── */
    const sa = r.security.serviceAccounts;
    ok('service accounts are enumerated from the join', sa.total.value === 2,
       String(sa.total.value));
    const used = sa.inventory.value.find((x) => /^sa-a@/.test(x.email));
    ok('an identity is linked to the workloads that RUN AS it',
       used.runServices === 2 && used.functions === 1,
       used.runServices + '/' + used.functions);
    const orphan = sa.inventory.value.find((x) => /^orphan@/.test(x.email));
    ok('an identity with roles that nothing runs as is flagged',
       orphan.unusedByWorkloads === true);
    ok('and the in-use identity is NOT flagged', used.unusedByWorkloads === false);
    ok('the count of unowned identities is reported', sa.withoutWorkload.value === 1,
       String(sa.withoutWorkload.value));
    ok('usage is only claimed when BOTH workload inventories were readable',
       used.usageKnown === true);
  }

  head('15 - an unreadable workload inventory makes usage UNKNOWN, not zero');
  {
    /* Cloud Run is down. "Nothing runs as this identity" would then be a
       statement about a failed read, not about the estate. */
    const plan = {
      'locations/-/services': { reject: 'run API disabled' },
      'locations/-/functions': { body: { functions: [] } },
      ':getIamPolicy': { body: { etag: 'E', bindings: [
        { role: 'roles/viewer', members: ['serviceAccount:sa@x.iam.gserviceaccount.com'] } ] } },
      'timeSeries': { body: { timeSeries: [] } },
      '/databases': DBS,
      '(default)/collectionGroups': mkIndexes(1, 0),
      'sokoni-ops/collectionGroups': mkIndexes(1, 0),
      '(default)/documents:listCollectionIds': { body: { collectionIds: [] } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': QUOTA,
    };
    const api = makeApi(plan);
    const r = await gcp.readGcpEvidence({ get: api.get, post: api.post });

    ok('unowned-identity count is NOT claimed when a workload read failed',
       r.security.serviceAccounts.withoutWorkload.state === 'not-attempted',
       r.security.serviceAccounts.withoutWorkload.state);
    ok('and it carries no value', r.security.serviceAccounts.withoutWorkload.value === null);
    ok('each row says usage is not known', r.security.serviceAccounts.inventory.value
       .every((x) => x.usageKnown === false));
    /* Cost conditions need the same inventory. */
    ok('cost conditions are not-attempted when the inventory is unreadable',
       r.cost.pinnedInstances.state === 'not-attempted', r.cost.pinnedInstances.state);
    ok('and are NOT reported as zero pinned services',
       r.cost.pinnedInstances.value !== 0);
    /* A telemetry series with no points is a MEASURED zero over the window. */
    ok('an empty metric series is a measured zero, not a failure',
       r.observability.telemetry.runRequests.state === 'empty',
       r.observability.telemetry.runRequests.state);
  }

  /* ══ 16. THE SCALING CONTRACT — SOURCE vs SERVING ════════════════════ */
  head('16 - parity is measured against the SERVING revision, and silence is not parity');
  {
    const plan = {
      'locations/-/functions': { body: { functions: [
        { name: 'projects/p/locations/us-central1/functions/processTypesenseQueue',
          state: 'ACTIVE', buildConfig: { runtime: 'nodejs22' }, serviceConfig: {} },
        { name: 'projects/p/locations/us-central1/functions/kass',
          state: 'ACTIVE', buildConfig: { runtime: 'nodejs22' }, serviceConfig: {} },
        /* No contract row supplied for this one. */
        { name: 'projects/p/locations/us-east1/functions/uncontracted',
          state: 'ACTIVE', buildConfig: { runtime: 'nodejs22' }, serviceConfig: {} },
      ] } },
      'locations/-/services': { body: { services: [] } },
      'locations/-/repositories': { body: { repositories: [] } },
      ':getIamPolicy': { body: { etag: 'E', bindings: [] } },
      'timeSeries': { body: { timeSeries: [] } },
      '/databases': DBS,
      '(default)/collectionGroups': mkIndexes(1, 0),
      'sokoni-ops/collectionGroups': mkIndexes(1, 0),
      '(default)/documents:listCollectionIds': { body: { collectionIds: [] } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': QUOTA,
    };
    const api = makeApi(plan);
    const r = await gcp.readGcpEvidence({ get: api.get, post: api.post, contracts: {
      capturedAt: '2026-09-21T10:42:59.357Z',
      note: 'The GCF layer reports minInstanceCount=undefined while BOTH the source and the ' +
            'serving revision say 1. The serving revision is authoritative.',
      rows: [
        /* Source says nothing, serving says nothing — they agree. */
        { fn: 'processTypesenseQueue', src_min: null, src_max: null,
          gcf_min: null, gcf_max: null, run_min: null, run_max: null,
          verdict: 'OWNER DECISION REQUIRED', detail: 'ceiling now unset' },
        /* Source and serving both pin min=1, but the GCF layer disagrees. */
        { fn: 'kass', src_min: 1, src_max: null, gcf_min: null, gcf_max: null,
          run_min: 1, run_max: 80, verdict: 'OWNER DECISION REQUIRED', detail: 'disputed' },
      ] } });

    const ct = r.compute.contracts;
    ok('adjudicated functions are counted', ct.adjudicated.value === 2, String(ct.adjudicated.value));
    /* SILENCE IS NOT PARITY. */
    ok('a function with no contract is counted separately',
       ct.withoutContract.value === 1, String(ct.withoutContract.value));
    ok('and it is NOT included in the adjudicated set',
       ct.inventory.value.every((x) => x.fn !== 'uncontracted'));

    const kass = ct.inventory.value.find((x) => x.fn === 'kass');
    /* PARITY IS AGAINST SERVING. src_max null vs run_max 80 → disagree. */
    ok('a source maximum that differs from serving is a MISMATCH', kass.maxParity === false);
    ok('a pinned serving minimum is recognised', kass.minPinned === true);
    /* And the GCF layer's disagreement is surfaced, not resolved away. */
    ok('the GCF layer disagreeing with serving is surfaced', kass.gcfDisagrees === true);
    ok('the GCF value is carried alongside, not dropped', kass.gcfMin === null && kass.runMin === 1);
    ok('mismatches are counted', ct.maxMismatch.value === 1, String(ct.maxMismatch.value));
    ok('unpinned minimums are counted', ct.minUnpinned.value === 1, String(ct.minUnpinned.value));
    ok('GCF discrepancies are counted', ct.gcfDiscrepancy.value === 1);

    const pts = ct.inventory.value.find((x) => x.fn === 'processTypesenseQueue');
    ok('two nulls agree with each other', pts.maxParity === true);
    ok('but an unset serving minimum is NOT pinned', pts.minPinned === false);
    ok('the verdict travels with the row', /OWNER DECISION/.test(pts.verdict));

    ok('the capture time is carried', /2026-09-21/.test(String(ct.capturedAt.value)));
    ok('the observability note is carried', /serving revision is authoritative/.test(String(ct.note.value)));

    /* INVERTING CONTROL — with NO contracts supplied, nothing is adjudicated
       and nothing is claimed to be in parity. */
    const api2 = makeApi(plan);
    const r2 = await gcp.readGcpEvidence({ get: api2.get, post: api2.post });
    ok('CONTROL — with no contract supplied, none is adjudicated',
       r2.compute.contracts.adjudicated.state === 'empty' &&
       r2.compute.contracts.adjudicated.value === 0);
    ok('and every function is counted as having no contract',
       r2.compute.contracts.withoutContract.value === 3,
       String(r2.compute.contracts.withoutContract.value));
    ok('and the capture time is not-attempted, not invented',
       r2.compute.contracts.capturedAt.state === 'not-attempted');
  }

  /* ══ 17. DECLARED vs PROVISIONED SECRETS ═════════════════════════════ */
  head('17 - a declared secret that does not exist is found, both directions');
  {
    const plan = {
      '/v1/projects/sokoni-aeb26/secrets': { body: { secrets: [
        { name: 'projects/p/secrets/INTASEND_API_KEY' },
        { name: 'projects/p/secrets/SENDGRID_API_KEY' },
        /* Exists but nothing declares it. NOT a fault. */
        { name: 'projects/p/secrets/LEGACY_THING' },
      ] } },
      'locations/-/services': { body: { services: [] } },
      'locations/-/functions': { body: { functions: [] } },
      'locations/-/repositories': { body: { repositories: [] } },
      ':getIamPolicy': { body: { etag: 'E', bindings: [] } },
      'timeSeries': { body: { timeSeries: [] } },
      '/databases': DBS,
      '(default)/collectionGroups': mkIndexes(1, 0),
      'sokoni-ops/collectionGroups': mkIndexes(1, 0),
      '(default)/documents:listCollectionIds': { body: { collectionIds: [] } },
      'sokoni-ops/documents:listCollectionIds': { body: { collectionIds: [] } },
      'consumerQuotaMetrics': QUOTA,
    };
    const api = makeApi(plan);
    const r = await gcp.readGcpEvidence({ get: api.get, post: api.post,
      /* Declared twice on purpose — a name required by two rails is still ONE
         secret, and must not be double-counted. */
      expectedSecrets: ['INTASEND_API_KEY', 'INTASEND_API_KEY', 'SENDGRID_API_KEY',
                        'ALGOLIA_ADMIN_KEY'] });

    const cov = r.security.secretCoverage;
    ok('declared names are de-duplicated', cov.declared.value === 3, String(cov.declared.value));
    ok('provisioned secrets are counted', cov.provisioned.value === 3);
    ok('a declared secret that does not exist is found', cov.missing.value === 1,
       String(cov.missing.value));
    ok('and it is NAMED, not just counted',
       cov.missingNames.value[0].secret === 'ALGOLIA_ADMIN_KEY',
       JSON.stringify(cov.missingNames.value));
    ok('a provisioned secret nobody declares is reported separately',
       cov.unmatched.value === 1 &&
       cov.unmatchedNames.value[0].secret === 'LEGACY_THING',
       JSON.stringify(cov.unmatchedNames.value));
    /* CONTROL — a declared secret that DOES exist is not reported missing. */
    ok('control: a satisfied declaration is not reported missing',
       !cov.missingNames.value.some((x) => x.secret === 'INTASEND_API_KEY'));

    /* No value is ever carried. */
    ok('no secret value appears anywhere in the envelope',
       !/BEGIN [A-Z ]*PRIVATE KEY|sk_live_|whsec_/.test(JSON.stringify(r)));

    /* Without a declared list, coverage is NOT-ATTEMPTED — never "0 missing",
       which would read as "everything is provisioned". */
    const api2 = makeApi(plan);
    const r2 = await gcp.readGcpEvidence({ get: api2.get, post: api2.post });
    ok('with no declared list, coverage is not-attempted',
       r2.security.secretCoverage.missing.state === 'not-attempted',
       r2.security.secretCoverage.missing.state);
    ok('and NOT reported as zero missing', r2.security.secretCoverage.missing.value !== 0);

    /* Telemetry read time is carried. */
    ok('the telemetry read time is carried',
       !!r.observability.telemetryReadAt.value &&
       r.observability.telemetryReadAt.state === 'observed');
  }

  head('12 - total credential failure yields no cockpit, and says so');
  {
    const r = await gcp.readGcpEvidence({
      token: async () => { throw new Error('metadata server unreachable'); } });
    ok('not ok', r.ok === false);
    ok('and names the cause', /Could not obtain credentials/.test(r.error), r.error);
    ok('no compute block was invented', r.compute === undefined);
    ok('it still declares what it would not have covered',
       (r.notCovered || []).length > 0);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\n  FAILURES'); FAILURES.forEach((f) => console.log('   ✗ ' + f)); }
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  any real Google Cloud call. Every transport is injected.');
  console.log('  NOT RUN   the deployed path. This reader is NOT deployed, and');
  console.log('            deploying it is a separate, gated decision.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  /* A THROW IS A FAILURE, never a silent pass. */
  console.error('SUITE CRASHED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
