#!/usr/bin/env node
/* ============================================================================
   scripts/test-integration-evidence-migration.js
   ============================================================================
   Certifies the Step E migration by RUNNING IT, against a real (emulator)
   Firestore, and then asserting what is in the store — not that three writes
   returned success.

   The success condition the owner set is content-level:

       3 intended observations persisted
     + 0 unintended observation records
     + the resolver reads those 3
     + the remaining entries retain their correct derived state
     + every technical entry still reconciles exactly

   and every existing distinction survives:

       declared ≠ observed ≠ unreadable ≠ missing ≠ refused ≠ inbound/no-observation

   Run through: node scripts/run-evidence-migration-cert.js
   ============================================================================ */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
const PROJECT = process.env.GCLOUD_PROJECT || '';
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(HOST)) {
  console.error('\n  ABORTED — not an emulator target: ' + JSON.stringify(HOST) + '\n');
  process.exit(2);
}
if (!/^sokoni-evidence-cert/.test(PROJECT)) {
  console.error('\n  ABORTED — not the cert project: ' + JSON.stringify(PROJECT) + '\n');
  process.exit(2);
}

const admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const evidence = require(path.join(ROOT, 'functions/integration-evidence.js'));
const status   = require(path.join(ROOT, 'functions/integration-status.js'));
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));
const execs    = require(path.join(ROOT, 'functions/integration-probe-executors.js'));
const probesMod = require(path.join(ROOT, 'functions/integration-probes.js'));

let pass = 0, fail = 0;
const T = async (name, fn) => {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const sec = (s) => console.log('\n' + s + '\n' + '-'.repeat(s.length));

const COL = evidence.COLLECTION;
const THREE = ['cloud-storage', 'firestore', 'memorystore-redis'];

async function wipe () {
  const s = await db.collection(COL).get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
}

(async function main () {

sec('1 · BEFORE — the store is empty and the catalogue reconciles');

await T('the evidence collection starts empty', async () => {
  await wipe();
  eq((await db.collection(COL).get()).size, 0, '');
});

await T('the catalogue reconciles, and the three are the runnable set', () => {
  eq(registry.INTEGRATIONS.length, 60, 'technical entries: ');
  eq(registry.OPERATIONAL_DEPENDENCIES.length, 2, '');
  const derived = registry.INTEGRATIONS
    .filter((e) => evidence.classifyEvidenceSource(e.id) === 'runnable-with-evidence')
    .map((e) => e.id).sort();
  eq(JSON.stringify(derived), JSON.stringify(THREE), '');
});

sec('2 · RUN THE MIGRATION — the real script, as an operator would');

let migrationOut = '';
await T('scripts/migrate-integration-evidence.js --apply --target=emulator exits 0', async () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts/migrate-integration-evidence.js'), '--apply', '--target=emulator'],
    { cwd: ROOT, encoding: 'utf8', env: process.env });
  migrationOut = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) throw new Error('exit ' + r.status + '\n' + migrationOut.slice(0, 1200));
  ok(/CONTENT VERIFIED/.test(migrationOut), 'the migration did not verify its own content');
});

await T('it declared the environment rather than inferring one', () => {
  ok(/environment\s+emulator/.test(migrationOut),
    'records must be labelled with the declared environment: ' +
    (migrationOut.match(/environment.*/) || [''])[0]);
});

sec('3 · CONTENT — what is actually in the store');

await T('EXACTLY 3 records, and exactly the three intended ids', async () => {
  const snap = await db.collection(COL).get();
  eq(snap.size, 3, 'record count: ');
  eq(JSON.stringify(snap.docs.map((d) => d.id).sort()), JSON.stringify(THREE), '');
});

await T('ZERO unintended records — nothing else was written', async () => {
  const snap = await db.collection(COL).get();
  const unintended = snap.docs.map((d) => d.id).filter((id) => THREE.indexOf(id) === -1);
  eq(unintended.length, 0, 'unintended: ' + unintended.join(', ') + ' — ');
});

await T('every record validates, is labelled `emulator`, and names its writer', async () => {
  const read = await evidence.readLatestEvidence({});
  eq(read.dropped.length, 0, 'a record the reader drops was not really migrated: ');
  THREE.forEach((id) => {
    const r = read.records[id];
    ok(r, id + ' is missing');
    eq(r.environment, 'emulator', id + ': an unlabelled record could be mistaken for production: ');
    ok(/migrate-integration-evidence/.test(r.recordedBy || ''), id + ': recordedBy must name the migration');
    ok(r.checkedAt, id + ': must carry when it was observed');
  });
});

await T('the OBSERVATION is real — firestore was genuinely reached and the stages say so', async () => {
  /* Of the three, only firestore is observable from an emulator: cloud-storage
     reads real bucket metadata and memorystore-redis needs a real Redis.

     THE HEALTH IS `unknown` HERE, AND THAT IS NOT A MIGRATION FAULT. RC-1 sets
     credentialState to `unknown` whenever the Secret Manager inventory cannot
     be read — which it cannot be from an emulator with no GCP credentials — and
     deriveHealth() then returns `unknown` before it looks at any stage. So the
     probe reached Firestore, recorded it, and the derived health was suppressed
     by a separate unreadable source.

     That is the model behaving correctly: an OBSERVATION and a DERIVED HEALTH
     are different things, and the observation survives even when the health
     cannot be computed. Asserting the stages rather than the health is what
     distinguishes "we reached it" from "we can grade it". */
  const read = await evidence.readLatestEvidence({});
  const fs = read.records['firestore'];
  eq(fs.stages.connected, true, 'the probe must record that it reached Firestore: ');
  eq(fs.stages.accepted, true, 'and that the request was taken: ');
  eq(fs.evidence, 'service_account', '');
  ok(/read query executed/i.test(fs.detail || ''), 'the detail must describe what was done: ' + fs.detail);
  eq(fs.health, 'unknown',
    'health is suppressed by the unreadable secret inventory in this environment: ');

  /* CONTROL — the suppression is the inventory, not the probe. Given a readable
     inventory, the identical stages derive `connected`. */
  const graded = probesMod.deriveHealth(
    { stages: fs.stages, support: fs.support },
    { lifecycle: 'live', credentialState: 'not-applicable', healthKind: 'measurable' });
  eq(graded, 'connected',
    'the same observation with a readable inventory must grade connected: ');

  const others = ['cloud-storage', 'memorystore-redis']
    .map((id) => id + '=' + read.records[id].health).join(' · ');
  console.log('        environment artefacts, labelled emulator: ' + others);
});

sec('4 · THE RESOLVER — it consumes the new observations, and nothing more');

await T('the resolver observes EXACTLY the three', async () => {
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(res.evidenceReadable, true, '');
  const observed = res.integrations.filter((i) => i.probedAt).map((i) => i.id).sort();
  eq(JSON.stringify(observed), JSON.stringify(THREE), '');
});

await T('every technical entry still reconciles exactly', async () => {
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(res.integrations.length, registry.INTEGRATIONS.length, '');
  eq(JSON.stringify(res.integrations.map((i) => i.id).sort()),
     JSON.stringify(registry.INTEGRATIONS.map((e) => e.id).sort()), '');
});

sec('5 · THE UNMIGRATED ENTRIES RETAIN THEIR DERIVED STATE — the distinctions survive');

await T('NEGATIVE CONTROL — an absent observation stays absent, it is not synthesised', async () => {
  /* The failure this guards against is a migration that fills the model: the rest
     entries must come out of this with exactly what they had before, which is
     nothing observed. */
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  const others = res.integrations.filter((i) => THREE.indexOf(i.id) === -1);
  eq(others.length, registry.INTEGRATIONS.length - 3, 'everything except the three: ');
  others.forEach((r) => {
    eq(r.probedAt, null, r.id + ': acquired a probedAt it never earned: ');
    eq(r.health, 'unknown', r.id + ': acquired a health from a migration it was not part of: ');
    eq(r.evidence, 'none', r.id + ': ');
    eq(r.stages, null, r.id + ': ');
  });
});

await T('DECLARED ≠ OBSERVED — the nine refusals still carry a declared reason, with no probe', async () => {
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  const refused = res.integrations.filter((i) => i.notRunReason);
  eq(refused.length, 9, '');
  refused.forEach((r) => {
    eq(r.probedAt, null, r.id + ': a declared refusal must not gain an observation: ');
    eq(execs.REFUSES_BY_DESIGN[r.id], r.notRunReason, r.id + ': ');
  });
  /* And the three observed rails carry no refusal — the two are not confused. */
  THREE.forEach((id) => eq(res.integrations.find((i) => i.id === id).notRunReason, null, id + ': '));
});

await T('INBOUND ≠ OBSERVED — the four inbound rails got no synthetic observation', async () => {
  const inbound = registry.INTEGRATIONS
    .filter((e) => evidence.classifyEvidenceSource(e.id) === 'inbound-awaiting-callback')
    .map((e) => e.id).sort();
  eq(JSON.stringify(inbound),
     JSON.stringify(['fcm', 'intasend-webhook', 'inventory-webhooks', 'pos-webhooks']), '');
  const read = await evidence.readLatestEvidence({});
  inbound.forEach((id) => eq(read.records[id], undefined,
    id + ': evidence can only arrive by correlated callback, never by migration: '));
});

await T('OPERATIONAL ≠ TECHNICAL — neither dependency gained a record', async () => {
  const read = await evidence.readLatestEvidence({});
  for (const d of registry.OPERATIONAL_DEPENDENCIES) {
    eq(read.records[d.id], undefined, d.id + ': ');
    const snap = await db.collection(COL).doc(d.id).get();
    eq(snap.exists, false, d.id + ': nothing may exist in the collection either: ');
  }
});

await T('UNREADABLE ≠ MISSING still holds WITH the migrated data present', async () => {
  /* Re-asserted after migration, because this is the distinction a filled store
     is most likely to blur: three records now exist, so a timeout must still
     report unreadable rather than returning a partial or empty view. */
  const slow = evidence.firestoreStore({ deadlineMs: 1 });
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: slow });
  eq(res.evidenceReadable, false, '');
  ok(res.integrations.every((i) => i.probedAt === null),
    'a timeout must not surface a partial view of the three migrated records');
  const good = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(good.evidenceReadable, true, 'control: the same store reads fine with the real deadline: ');
  eq(good.integrations.filter((i) => i.probedAt).length, 3, '');
});

sec('6 · THE PARTITION AND PARITY CONTROLS, RE-RUN AFTER MIGRATION');

await T('the absence partition is unchanged — migration adds evidence, not classes', () => {
  /* classifyEvidenceSource describes why a record COULD be absent, which is a
     property of the catalogue. Migrating observations must not move an entry
     between classes. */
  const m = {};
  registry.INTEGRATIONS.forEach((e) => {
    const c = evidence.classifyEvidenceSource(e.id);
    m[c] = (m[c] || 0) + 1;
  });
  eq(m['runnable-with-evidence'], 3, '');
  eq(m['inbound-awaiting-callback'], 4, '');
  eq(m['declared-refusal'], 9, '');
  eq(m['measurable-unwritten'], 26, '');
  eq(m['not-applicable'], 5, '');
  eq(m['observed-elsewhere'], 13, '');
  eq(Object.values(m).reduce((a, b) => a + b, 0), registry.INTEGRATIONS.length, 'partition total: ');
});

await T('the parity suite still passes with the store populated', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-integration-registry-parity.js')],
    { cwd: ROOT, encoding: 'utf8' });
  ok(r.status === 0, 'parity failed after migration:\n' + (r.stdout || '').slice(-600));
  ok(/26 passed, 0 failed/.test(r.stdout || ''), 'unexpected parity result');
});

sec('7 · RE-RUNNING THE MIGRATION IS NOT ADDITIVE');

await T('a second run leaves exactly 3 records, not 6', async () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts/migrate-integration-evidence.js'), '--apply', '--target=emulator'],
    { cwd: ROOT, encoding: 'utf8', env: process.env });
  eq(r.status, 0, 'second run exit: ');
  eq((await db.collection(COL).get()).size, 3, 'record count after a second run: ');
});

sec('8 · CLEANUP');

await T('the cert collection is emptied', async () => {
  await wipe();
  eq((await db.collection(COL).get()).size, 0, '');
});

console.log('\n' + '='.repeat(66));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(66));
console.log('\n  PROVEN    the migration writes exactly the three intended observations and');
console.log('            nothing else; the resolver consumes exactly those three; the other');
console.log('            rest keep their derived state with no synthesised observation; the');
console.log('            four inbound rails and both operational dependencies gain nothing;');
console.log('            declared/observed/unreadable/missing/refused stay distinct; the');
console.log('            partition and parity controls hold; re-running is not additive.');
console.log('  SCOPE     the Firestore EMULATOR. Only `firestore` is genuinely observable');
console.log('            here — cloud-storage reads real bucket metadata and');
console.log('            memorystore-redis needs a real Redis — so those two records are');
console.log('            ENVIRONMENT ARTEFACTS, and are labelled environment=emulator so');
console.log('            they cannot be mistaken for production observations.');
console.log('  NOT DONE  no production migration: the script REFUSES --target=production by');
console.log('            design. No deployment. integrationProbeLatest untouched.\n');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  SUITE CRASHED — a crash is not a pass\n', e); process.exit(1); });
