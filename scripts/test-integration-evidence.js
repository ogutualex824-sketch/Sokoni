#!/usr/bin/env node
/* ============================================================================
   scripts/test-integration-evidence.js
   ============================================================================
   Certification for Step B of the Integration Evidence & Capability Model —
   the PERSISTENCE layer and the producer/consumer wiring.

   WHAT THIS SUITE IS FOR
   -----------------------
   Step A established that health was `unknown` for all 47 entries because the
   probe producer and the status consumer were never connected. Step B connects
   them. A suite for that work has to prove the connection carries evidence AND
   that it refuses to carry a claim the evidence does not support — a persistence
   layer that accepts everything is not a model, it is a pipe.

   EVERY REFUSAL HAS AN INVERTING CONTROL
   ---------------------------------------
   A negative-only suite passes against a store that refuses everything, which is
   exactly as broken as one that accepts everything. So each integrity rule is
   asserted twice: the valid record is ACCEPTED, and the one that differs only in
   the thing being tested is REFUSED. Neither assertion means anything alone.

   NOT PROVEN HERE — stated so it is not assumed
   ----------------------------------------------
   No Firestore is contacted. The store is the in-memory implementation
   throughout, so what is certified is the SCHEMA, the VALIDATION and the WIRING,
   not the behaviour of the Firestore adapter against a real database. The
   catalogue is NOT migrated and nothing populates serviceCapabilities; that is
   Step E. Nothing is deployed.
   ============================================================================ */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const evidence = require(path.join(ROOT, 'functions/integration-evidence.js'));
const probes   = require(path.join(ROOT, 'functions/integration-probes.js'));
const status   = require(path.join(ROOT, 'functions/integration-status.js'));
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));
const execs    = require(path.join(ROOT, 'functions/integration-probe-executors.js'));

let pass = 0, fail = 0;
/* Always async, always awaited. A synchronous helper that silently returns a
   pending promise is how a suite reports PASS for an assertion that has not run
   yet — a green light for work in flight. */
const T = async (name, fn) => {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const sec = (s) => console.log('\n' + s + '\n' + '-'.repeat(s.length));

/* A record that is valid in every respect. Every refusal test below is this
   object with ONE field changed, so a failure names the rule and nothing else. */
function goodRecord (over) {
  return Object.assign({
    schemaVersion: evidence.SCHEMA_VERSION,
    integrationId: 'firestore',
    health: 'connected',
    healthKind: 'measurable',
    stages: { configured: true, connected: true, accepted: true, delivered: null, received: null },
    support: { connected: 'supported', accepted: 'supported',
               delivered: 'not-supported', received: 'not-supported' },
    evidence: 'service_account',
    detail: null,
    correlationId: null,
    checkedAt: new Date().toISOString(),
    notRunReason: null,
    environment: null,
    serviceCapabilities: null,
    recordedAt: new Date().toISOString(),
    recordedBy: null,
  }, over || {});
}

/* Refusal + its inverting control, as one unit. The control is what stops this
   suite passing against a validator that rejects unconditionally. */
async function refuses (name, mutate, expectFragment) {
  await T('ACCEPTS the unmutated control — ' + name, () => {
    const v = evidence.validate(goodRecord());
    ok(v.ok, 'the control record must validate, else the refusal proves nothing: ' + v.errors.join('; '));
  });
  await T('REFUSES ' + name, () => {
    const v = evidence.validate(goodRecord(mutate));
    ok(!v.ok, 'expected refusal');
    ok(v.errors.some((e) => e.indexOf(expectFragment) > -1),
      'refused, but for the wrong reason: ' + v.errors.join('; '));
  });
}

(async function main () {

sec('1 · SCHEMA — shape is refused when it is wrong, accepted when it is right');

await refuses('a stage given as the string "unknown" (truthy, would read as delivered)',
  { stages: { configured: true, connected: true, accepted: true, delivered: 'unknown', received: null } },
  'must be true, false or null');
await refuses('a missing stage', { stages: { configured: true, connected: true, accepted: true, delivered: null } },
  'stages.received is missing');
await refuses('an unknown health state', { health: 'healthy' }, 'health is not a known state');
await refuses('an integrationId not in the registry', { integrationId: 'daraja' }, 'not a known registry entry');
await refuses('a support value that is neither supported nor not-supported',
  { support: { connected: 'maybe', accepted: 'supported', delivered: 'not-supported', received: 'not-supported' } },
  'support.connected must be');
await refuses('a non-ISO checkedAt', { checkedAt: 'yesterday' }, 'checkedAt must be an ISO timestamp');
await refuses('an environment that is not a declared SOKONI environment',
  { environment: 'prod' }, 'environment must be null or one of');
await refuses('a notRunReason that is not a not-run code',
  { notRunReason: 'provider_down' }, 'notRunReason must be null');

sec('2 · INTEGRITY — a claim may not outrun its evidence');

await refuses('a runtime stage true with evidence none',
  { evidence: 'none' }, 'the claim has no source');
await refuses('a stage true that the integration cannot evidence',
  { stages: { configured: true, connected: true, accepted: true, delivered: true, received: null } },
  'cannot evidence that stage');
await refuses('health connected with no runtime stage true',
  { stages: { configured: true, connected: null, accepted: null, delivered: null, received: null } },
  'no runtime stage came back true');
await refuses('a refusal laundered into an observation — notRunReason set AND a stage true',
  { notRunReason: 'no_safe_probe' }, 'a probe that did not run observed nothing');
await refuses('a capability claiming observed with no evidence',
  { serviceCapabilities: [{ id: 'mpesa', state: 'observed' }] }, 'claims observed with no evidence');
await refuses('a capability in an unknown state',
  { serviceCapabilities: [{ id: 'mpesa', state: 'working' }] }, 'state is not a known state');

await T('INVERTING CONTROL — a well-formed capability array IS accepted', () => {
  const v = evidence.validate(goodRecord({
    serviceCapabilities: [{ id: 'mpesa', label: 'M-Pesa', state: 'observed',
      evidence: 'provider_api', observedAt: new Date().toISOString(), notRunReason: null }],
  }));
  ok(v.ok, 'a valid capability must be accepted: ' + v.errors.join('; '));
});

await T('INVERTING CONTROL — serviceCapabilities null (NOT MODELLED) is accepted and is not []', () => {
  ok(evidence.validate(goodRecord({ serviceCapabilities: null })).ok, 'null must be accepted');
  ok(evidence.validate(goodRecord({ serviceCapabilities: [] })).ok, 'empty array must also be accepted');
  ok(null !== [], 'null and [] are distinct values and the model keeps them distinct');
});

sec('3 · PROOF 1 — a successful probe can actually become persisted evidence');

const store = evidence.memoryStore();

await T('a real probe run, persisted end to end, and readable back', async () => {
  const result = await probes.runProbe('firestore', {
    credentialState: 'not-applicable',
    lifecycle: 'active',
    execute: async () => ({ connected: true, accepted: true, evidence: 'service_account',
                            detail: 'probe wrote and deleted a diagnostic document' }),
    evidenceStore: store,
  });
  eq(result.health, 'connected', 'the probe itself must have succeeded first: ');
  ok(result.persisted, 'runProbe must report what happened to persistence');
  ok(result.persisted.written, 'the record was NOT written: ' + (result.persisted.errors || []).join('; '));

  const back = await store.get('firestore');
  ok(back, 'nothing is in the store');
  eq(back.health, 'connected', 'health did not survive persistence: ');
  eq(back.stages.accepted, true, 'stages did not survive: ');
  eq(back.evidence, 'service_account', 'evidence did not survive: ');
  ok(back.checkedAt, 'probedAt source (checkedAt) did not survive');
  eq(back.support.delivered, 'not-supported', 'stageSupport did not survive: ');
});

await T('and it reaches the RESOLVER — health is no longer unknown for that entry', async () => {
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [],
    evidenceStore: store,
  });
  const fs = res.integrations.find((i) => i.id === 'firestore');
  eq(fs.health, 'connected', 'the resolver did not pick up persisted evidence: ');
  eq(fs.evidence, 'service_account', '');
  ok(fs.probedAt, 'probedAt must be populated from the persisted checkedAt');
  eq(res.evidenceReadable, true, '');
});

await T('INVERTING CONTROL — with an EMPTY store the same entry is unknown again', async () => {
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [],
    evidenceStore: evidence.memoryStore(),
  });
  const fs = res.integrations.find((i) => i.id === 'firestore');
  eq(fs.health, 'unknown', 'an empty store must leave health unknown, not connected: ');
  eq(fs.probedAt, null, '');
});

await T('an INVALID record cannot be persisted — writeEvidence refuses it', async () => {
  const s = evidence.memoryStore();
  const out = await evidence.writeEvidence(
    { id: 'firestore', health: 'connected', evidence: 'none',
      stages: { configured: true, connected: true, accepted: true, delivered: null, received: null },
      support: { connected: 'supported', accepted: 'supported', delivered: 'not-supported', received: 'not-supported' },
      checkedAt: new Date().toISOString() },
    { store: s });
  ok(out.refused, 'an unsourced claim was accepted into persistence');
  eq(await s.get('firestore'), null, 'a refused record must leave NOTHING behind: ');
});

await T('a record that is persisted but stops validating is DROPPED, not rendered', async () => {
  const s = evidence.memoryStore({ firestore: goodRecord({ health: 'gloriously fine' }) });
  const read = await evidence.readLatestEvidence({ store: s });
  eq(Object.keys(read.records).length, 0, 'an invalid stored record must not be returned: ');
  eq(read.dropped.length, 1, '');
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [], evidenceStore: s });
  eq(res.integrations.find((i) => i.id === 'firestore').health, 'unknown',
    'a dropped record must leave the entry unknown, never its invalid claim: ');
  eq(res.evidenceDropped.length, 1, 'the drop must be REPORTED, not silent: ');
});

await T('an UNREADABLE store fails into unknown + an error, never into a fabricated health', async () => {
  const broken = { kind: 'broken', async list () { throw new Error('permission denied'); },
                   async get () { throw new Error('x'); }, async set () { throw new Error('x'); } };
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [], evidenceStore: broken });
  eq(res.evidenceReadable, false, '');
  ok(String(res.evidenceError).indexOf('permission denied') > -1, 'the reason must be reported');
  eq(res.integrations.length, registry.INTEGRATIONS.length, 'all entries still returned: ');
  ok(res.integrations.every((i) => i.health === 'unknown'), 'an unreadable store must yield unknown for all');
});

sec('4 · PROOF 2 — notRunReason survives even when NO probe result exists');

await T('the nine declared refusals carry a reason with an empty evidence store', async () => {
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: evidence.memoryStore() });
  const withReason = res.integrations.filter((i) => i.notRunReason);
  const declared = Object.keys(execs.REFUSES_BY_DESIGN);
  eq(withReason.length, declared.length,
    'expected one reason per declared refusal, with no probe having run: ');
  declared.forEach((id) => {
    const rec = res.integrations.find((i) => i.id === id);
    eq(rec.notRunReason, execs.REFUSES_BY_DESIGN[id], id + ': ');
  });
});

await T('INVERTING CONTROL — an integration with NO executor is unmeasured, NOT refused', () => {
  const noExec = registry.INTEGRATIONS.filter((e) => execs.probeAvailability(e.id) === 'none');
  ok(noExec.length > 0, 'the control needs at least one such entry to be meaningful');
  noExec.forEach((e) => eq(evidence.staticNotRunReason(e.id), null,
    e.id + ' has no probe written; that is unmeasured, not a refusal: '));
});

await T('INVERTING CONTROL — a runnable probe carries no reason', () => {
  const runnable = registry.INTEGRATIONS.filter((e) => execs.probeAvailability(e.id) === 'runnable');
  ok(runnable.length > 0, 'the control needs at least one runnable probe');
  runnable.forEach((e) => eq(evidence.staticNotRunReason(e.id), null, e.id + ': '));
});

await T('a PROBE reason overrides the static one — what happened beats what was declared', async () => {
  const s = evidence.memoryStore();
  const r = await probes.runProbe('sendgrid', {
    credentialState: 'configured', lifecycle: 'active',
    execute: async () => { const e = new Error('key not bound'); e.code = 'requires_secret_binding'; throw e; },
    evidenceStore: s,
  });
  eq(r.notRunReason, 'requires_secret_binding', '');
  ok(r.persisted.written, 'a not-run result is still evidence and must persist: ' + (r.persisted.errors || []).join('; '));
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [], evidenceStore: s });
  eq(res.integrations.find((i) => i.id === 'sendgrid').notRunReason, 'requires_secret_binding', '');
});

sec('5 · PROOF 3 — REFUSED BY DESIGN is therefore reachable');

await T('the field the console predicate reads was ABSENT before this commit', () => {
  /* sokoni-integrations.js:398 — `if (r && r.notRunReason) return _chipOf('refused', ...)`.
     The claim "REFUSED BY DESIGN was unreachable" is a claim about the PREVIOUS
     resolver, so it is checked against the previous resolver, not against a
     re-run of the new one with a different argument. */
  const prev = require('child_process')
    .execSync('git show HEAD:functions/integration-status.js', { cwd: ROOT, encoding: 'utf8' });
  ok(prev.indexOf('notRunReason') === -1,
    'HEAD\'s resolver already emitted notRunReason — the premise of this slice is wrong');
  ok(prev.indexOf('probe.evidence') > -1,
    'control: the fetched file must actually be the resolver, or the absence above proves nothing');
});

await T('and it fires WITHOUT a probe — which is what makes the state reachable', async () => {
  /* The point is not that nine records carry a reason. It is that they carry one
     having never been probed. A state derived only from the output of the thing
     that did not happen cannot be reached; derived from the declaration, it can. */
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: evidence.memoryStore() });
  const refused = res.integrations.filter((i) => i.notRunReason);
  eq(refused.length, 9, 'REFUSED BY DESIGN must be reachable for the nine declared refusals: ');
  refused.forEach((r) => {
    eq(r.probedAt, null, r.id + ' must carry its reason with NO probe behind it: ');
    eq(r.health, 'unknown', r.id + ': a refusal is not a health claim: ');
  });
});

sec('6 · PROOF 4 — the existing UI capabilities are unchanged');

await T('capabilities is byte-identical to the pre-Step-B derivation, for all 47', async () => {
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: evidence.memoryStore() });
  res.integrations.forEach((rec) => {
    const entry = registry.byId(rec.id);
    const expected = status._internal._capabilities(entry, rec.credentialState);
    eq(JSON.stringify(rec.capabilities), JSON.stringify(expected), rec.id + ': ');
  });
  ok(res.integrations.some((i) => i.capabilities.indexOf('view-credential-names') > -1),
    'control: at least one entry must carry view-credential-names, else the check is vacuous');
});

await T('serviceCapabilities is a DIFFERENT field and does not collide', async () => {
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: evidence.memoryStore() });
  res.integrations.forEach((rec) => {
    ok(Array.isArray(rec.capabilities), rec.id + ': capabilities must still be the UI affordance array');
    eq(rec.serviceCapabilities, null, rec.id + ': business capabilities are NOT MODELLED in Step B: ');
  });
});

sec('7 · PROOF 5 — the catalogue is still exactly 47/47, and nothing was migrated');

await T('47 registry entries, 47 records, no addition and no loss', async () => {
  eq(registry.INTEGRATIONS.length, 47, 'registry: ');
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: evidence.memoryStore() });
  eq(res.integrations.length, 47, 'resolved records: ');
  const ids = res.integrations.map((i) => i.id).sort();
  eq(new Set(ids).size, 47, 'ids must be unique: ');
  eq(JSON.stringify(ids), JSON.stringify(registry.INTEGRATIONS.map((e) => e.id).sort()),
    'the resolved id set must equal the registry id set exactly: ');
});

await T('nothing in Step B populates the store — a fresh resolve writes no evidence', async () => {
  const s = evidence.memoryStore();
  await status.resolveIntegrationStatus({ listSecretNames: async () => [], evidenceStore: s });
  eq(Object.keys(s._docs).length, 0, 'resolving must not write; migration is Step E: ');
});

await T('the legacy collection is named but NOT read', () => {
  eq(evidence.LEGACY_COLLECTION, 'integrationProbeLatest', '');
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/integration-evidence.js'), 'utf8');
  const reads = src.split('\n').filter((l) =>
    l.indexOf('LEGACY_COLLECTION') > -1 && /collection\(|\.get\(|list\(/.test(l));
  eq(reads.length, 0, 'the legacy collection must not be read in Step B: ' + reads.join(' | '));
});

sec('8 · PROOF 6 — no new status defaults everything into one bucket');

await T('with no evidence at all, the 47 do NOT collapse to a single state', async () => {
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: evidence.memoryStore() });
  const health = {}, reason = {};
  res.integrations.forEach((i) => {
    health[i.health] = (health[i.health] || 0) + 1;
    reason[i.notRunReason || '(none)'] = (reason[i.notRunReason || '(none)'] || 0) + 1;
  });
  console.log('        health:  ' + JSON.stringify(health));
  console.log('        reason:  ' + JSON.stringify(reason));

  /* Not "everything ACTIVE": nothing may claim health from an absent probe. */
  eq(health.connected || 0, 0, 'no entry may be connected with no evidence: ');
  eq(health.degraded  || 0, 0, '');
  eq(health.failed    || 0, 0, 'no entry may be failed with no evidence: ');
  /* Not "everything one bucket" either: the refusals are distinguished. */
  ok(Object.keys(reason).length > 1, 'notRunReason must partition the set, not flatten it');
  eq(reason['(none)'], 38, '');
});

await T('environment is null everywhere — declared, never inferred', async () => {
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: evidence.memoryStore() });
  ok(res.integrations.every((i) => i.environment === null),
    'nothing declares an environment, so nothing may report one');
});

await T('INVERTING CONTROL — a DECLARED environment does come through', async () => {
  eq(evidence.declaredEnvironment({ SOKONI_ENVIRONMENT: 'production' }), 'production', '');
  eq(evidence.declaredEnvironment({ SOKONI_ENVIRONMENT: 'PRODUCTION' }), 'production', 'case-insensitive: ');
  eq(evidence.declaredEnvironment({}), null, 'undeclared is null, not a guess: ');
  eq(evidence.declaredEnvironment({ SOKONI_ENVIRONMENT: 'prod' }), null, 'an unrecognised declaration is not coerced: ');
  eq(evidence.declaredEnvironment({ GCLOUD_PROJECT: 'sokoni-aeb26' }), null,
    'a project id must NOT be read as an environment: ');

  const s = evidence.memoryStore();
  await probes.runProbe('firestore', {
    credentialState: 'not-applicable', lifecycle: 'active',
    execute: async () => ({ connected: true, accepted: true, evidence: 'service_account' }),
    evidenceStore: s, environment: 'staging',
  });
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [], evidenceStore: s });
  eq(res.integrations.find((i) => i.id === 'firestore').environment, 'staging', '');
});

sec('9 · THE OLD CALL SHAPE IS UNCHANGED');

await T('an explicitly injected latestProbes map still wins over the store', async () => {
  const s = evidence.memoryStore({ firestore: goodRecord() });
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: s,
    latestProbes: {},                       /* explicit empty: caller says "none" */
  });
  eq(res.integrations.find((i) => i.id === 'firestore').health, 'unknown',
    'an explicit empty map must not be overridden by the store: ');
});

await T('runProbe without a store persists NOTHING and reports nothing', async () => {
  const r = await probes.runProbe('firestore', {
    credentialState: 'not-applicable', lifecycle: 'active',
    execute: async () => ({ connected: true, accepted: true, evidence: 'service_account' }),
  });
  eq(r.health, 'connected', 'the probe must still work: ');
  eq(r.persisted, undefined, 'no store, no persistence, and no claim that there was: ');
});

console.log('\n' + '='.repeat(66));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(66));
console.log('\n  SCOPE     schema, validation and wiring, against an in-memory store.');
console.log('  UNPROVEN  the Firestore adapter against a real database; no Firestore');
console.log('            was contacted. The 47 are NOT migrated and');
console.log('            serviceCapabilities is populated by nothing — that is Step E.');
console.log('  NOT DONE  no deployment, and functions/admin-os.js was not modified.\n');
process.exit(fail ? 1 : 0);
})();
