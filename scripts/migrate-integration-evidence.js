#!/usr/bin/env node
/* ============================================================================
   scripts/migrate-integration-evidence.js
   ============================================================================
   Step E. Persists observations for EXACTLY the three technical integrations
   whose probe can actually run, and for nothing else.

   THERE IS NOTHING TO MIGRATE *FROM*
   -----------------------------------
   `integrationProbeLatest` is untouched by decision and no evidence record
   exists, so this does not move data. It CREATES observations by running the
   declared probes and persisting what they establish. That is the only honest
   way to fill an evidence store: a migration that copied a declaration into an
   observation would manufacture exactly the fact the model exists to refuse.

   THE THREE, AND HOW THEY ARE CHOSEN
   -----------------------------------
   Derived from classifyEvidenceSource() === 'runnable-with-evidence', NOT
   hardcoded — so a catalogue change is reflected rather than silently ignored.
   The derived set is then ASSERTED against the three the owner authorised by
   name, so a catalogue change is *caught* rather than followed. Drift must stop
   the migration, not widen it.

   ENVIRONMENT IS RECORDED, AND THAT MATTERS MORE HERE THAN ANYWHERE
   ------------------------------------------------------------------
   Of the three, only `firestore` can be observed from an emulator. The
   `cloud-storage` probe reads real bucket metadata and `memorystore-redis`
   needs a real Redis, so against an emulator both FAIL — and a failure that is
   an artefact of where the migration ran is not a fact about the provider.
   Persisting it unlabelled would fabricate failure, which is the same defect as
   fabricating success wearing the opposite sign.

   So every record carries `environment`, declared via SOKONI_ENVIRONMENT and
   never inferred. A record written here is self-labelling, and a reader can
   tell an emulator artefact from a production observation without being told.

   WHAT IT WILL NOT DO
   --------------------
     * write for any of the other 49 technical entries
     * write for either operational dependency — the store refuses those anyway
     * synthesise an observation for the four inbound rails, whose evidence can
       only arrive by correlated callback
     * read, write or delete anything in integrationProbeLatest
     * change the catalogue

   Dry run by default. `--apply` persists. `--target` must name the environment
   explicitly, so nothing is ever written to a store nobody named.
   ============================================================================ */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const evidence = require(path.join(ROOT, 'functions/integration-evidence.js'));
const probes   = require(path.join(ROOT, 'functions/integration-probes.js'));
const execs    = require(path.join(ROOT, 'functions/integration-probe-executors.js'));
const status   = require(path.join(ROOT, 'functions/integration-status.js'));
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));

/* The three the owner authorised, by name. The derived set must equal this. */
const AUTHORISED = ['cloud-storage', 'firestore', 'memorystore-redis'];

const argv = process.argv.slice(2);
const APPLY = argv.indexOf('--apply') > -1;
const TARGET = (argv.find((a) => a.indexOf('--target=') === 0) || '').split('=')[1] || '';

function fail (why) { console.error('\n  REFUSED — ' + why + '\n'); process.exit(2); }

/* ── TARGET GUARD ──────────────────────────────────────────────────────────
   A migration that can be run without naming where it writes is one keystroke
   from writing to production. The target must be stated, and `production` needs
   its own explicit authorisation that this script does not grant itself. */
const EMU = process.env.FIRESTORE_EMULATOR_HOST || '';
if (APPLY) {
  if (!TARGET) fail('--apply needs --target=emulator or --target=production.');
  if (TARGET === 'emulator' && !EMU) fail('--target=emulator but FIRESTORE_EMULATOR_HOST is not set.');
  if (TARGET === 'production') {
    fail('production migration is NOT authorised by this script. It is a separate act ' +
         'requiring its own approval, and this guard exists so it cannot happen by momentum.');
  }
  if (TARGET !== 'emulator') fail('unknown --target: ' + TARGET);
}

/* ── THE ADMIN APP ─────────────────────────────────────────────────────────
   A standalone script gets no initialised app, and without one every probe
   fails with "The default Firebase app does not exist" — which is a runner
   fault dressed as three dead providers. That is exactly what the blanket-
   failure guard below caught on the first dry run, and this is the cause it
   was pointing at.

   Initialised HERE rather than at require time: admin.firestore is a prototype
   getter, and the probe executors resolve it when they run. */
function _ensureApp () {
  const admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
  if (!admin.apps.length) {
    const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) fail('no GCLOUD_PROJECT — refusing to guess which project to observe.');
    admin.initializeApp({ projectId });
  }
  return admin;
}

async function main () {
  _ensureApp();

  /* ── SELECTION, AND THE DRIFT CHECK ─────────────────────────────────────── */
  const derived = registry.INTEGRATIONS
    .filter((e) => evidence.classifyEvidenceSource(e.id) === 'runnable-with-evidence')
    .map((e) => e.id).sort();

  if (JSON.stringify(derived) !== JSON.stringify(AUTHORISED.slice().sort())) {
    fail('the runnable set has DRIFTED from what was authorised.\n' +
         '           authorised: ' + AUTHORISED.join(', ') + '\n' +
         '           derived:    ' + derived.join(', ') + '\n' +
         '           A catalogue change must be reviewed, not followed.');
  }

  const environment = evidence.declaredEnvironment();
  console.log('\n  target        ' + (APPLY ? TARGET : 'DRY RUN (no writes)'));
  console.log('  environment   ' + (environment === null ? 'UNDECLARED (records will say null)' : environment));
  console.log('  scope         ' + derived.join(', ') + '   (' + derived.length + ' of ' +
    registry.INTEGRATIONS.length + ' technical, ' + registry.OPERATIONAL_DEPENDENCIES.length +
    ' operational untouched)');
  console.log('  legacy        integrationProbeLatest is NOT read, written or deleted\n');

  /* Configuration comes from RC-1, so there is one answer to "is it configured". */
  const st = await status.resolveIntegrationStatus({});
  const store = APPLY ? evidence.firestoreStore() : evidence.memoryStore();

  /* ── THE BLANKET-FAILURE GUARD ──────────────────────────────────────────
     Found by running the dry run: with no Firestore, no GCS and no Redis
     reachable, all three probes returned `failed` and the content check passed
     — because it counted ids and ids were all it counted. Three `failed`
     records would have been persisted as though they were facts about three
     providers.

     Three INDEPENDENT rails failing at the same instant is overwhelmingly a
     statement about the runner, not about GCS, Firestore and Redis all being
     down together. So a total failure is treated as a runner fault and REFUSED,
     which is the same principle as `unknown` never collapsing into `missing`:
     an environment that cannot observe must not be recorded as an observation
     of failure.

     It is falsifiable rather than absolute — if they really are all down,
     --allow-total-failure records it deliberately. */
  const ALLOW_TOTAL_FAILURE = argv.indexOf('--allow-total-failure') > -1;

  /* OBSERVE FIRST, PERSIST SECOND. Persisting inside the loop would have
     written the first record before the guard below could see the third. */
  const observations = [];
  for (const id of derived) {
    const entry = registry.byId(id);
    const rec = st.integrations.find((i) => i.id === id);
    observations.push(await probes.runProbe(id, {
      credentialState: rec ? rec.credentialState : 'unknown',
      lifecycle: entry.status,
      execute: execs.executorFor(id),
      /* no evidenceStore — nothing is persisted yet */
    }));
  }

  const bad = ['failed', 'degraded'];
  const allFailed = observations.length > 0 && observations.every((r) => bad.indexOf(r.health) > -1);
  if (allFailed && !ALLOW_TOTAL_FAILURE) {
    console.log('  id                       health');
    observations.forEach((r) => console.log('  ' + r.id.padEnd(24) + ' ' + r.health +
      '   ' + String(r.detail || '').slice(0, 60)));
    fail('EVERY probe failed, so nothing was persisted.\n' +
         '           Three independent rails failing at the same instant is a statement about\n' +
         '           this runner, not about GCS, Firestore and Redis being down together.\n' +
         '           Recording it would turn an environment that CANNOT OBSERVE into an\n' +
         '           observation of failure.\n' +
         '           If they genuinely are all down, re-run with --allow-total-failure.');
  }

  const results = [];
  for (const result of observations) {
    const out = await evidence.writeEvidence(result, {
      store, environment, recordedBy: 'scripts/migrate-integration-evidence.js',
    });
    results.push({ id: result.id, health: result.health, evidence: result.evidence,
      detail: (result.detail || '').slice(0, 64),
      persisted: out.written, refused: out.refused, errors: out.errors || [] });
  }

  console.log('  id                       health        persisted  evidence');
  console.log('  ------------------------ ------------- ---------  --------');
  results.forEach((r) => console.log('  ' + r.id.padEnd(24) + ' ' + String(r.health).padEnd(13) + ' ' +
    (r.persisted ? 'yes' : (r.refused ? 'REFUSED' : 'no')).padEnd(10) + ' ' + r.evidence +
    (r.errors.length ? '\n      ' + r.errors.join('; ') : '')));

  /* ── CONTENT-LEVEL VERIFICATION ─────────────────────────────────────────
     "Three writes succeeded" is not the success condition. What is in the store
     afterwards, and what the resolver makes of it, is. */
  const back = await evidence.readLatestEvidence({ store });
  const written = Object.keys(back.records).sort();
  const unintended = written.filter((k) => derived.indexOf(k) === -1);

  console.log('\n  persisted ids     ' + (written.join(', ') || '(none)'));
  console.log('  unintended        ' + (unintended.length ? unintended.join(', ') : 'none'));
  console.log('  dropped on read   ' + back.dropped.length);

  const after = await status.resolveIntegrationStatus({ evidenceStore: store });
  const observed = after.integrations.filter((i) => i.probedAt).map((i) => i.id).sort();
  console.log('  resolver observes ' + (observed.join(', ') || '(none)'));
  console.log('  technical total   ' + after.integrations.length);

  const ok =
    written.length === derived.length &&
    unintended.length === 0 &&
    JSON.stringify(observed) === JSON.stringify(derived) &&
    after.integrations.length === registry.INTEGRATIONS.length &&
    back.dropped.length === 0;

  console.log('\n  ' + (ok ? 'CONTENT VERIFIED' : 'CONTENT MISMATCH — see above'));
  if (!APPLY) console.log('  DRY RUN — the store was in memory and nothing was persisted anywhere.');
  console.log('');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('\n  MIGRATION FAILED — a crash is not a partial success\n', e); process.exit(1); });
