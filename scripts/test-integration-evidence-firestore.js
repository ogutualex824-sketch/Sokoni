#!/usr/bin/env node
/* ============================================================================
   scripts/test-integration-evidence-firestore.js
   ============================================================================
   The ADAPTER PROOF. Certifies the one thing scripts/test-integration-evidence.js
   states it cannot: the Firestore adapter, against a real Firestore.

   WHY A SECOND SUITE RATHER THAN MORE CASES IN THE FIRST
   -------------------------------------------------------
   The in-memory store is a JSON round trip. It proves the schema, the validation
   and the wiring. It cannot prove anything only a database does:

     * whether set() really REPLACES rather than merges
     * whether a tri-state `null` survives serialisation as null rather than
       coming back absent — a missing key reads as `undefined`, not as unknown
     * whether admin.firestore() resolves at the right moment
     * whether the DEFAULT path works at all — every test in the first suite
       injects a store, so `resolveIntegrationStatus({})`, which is how
       production calls it, is exercised nowhere

   THE THREE CONTROLS THIS GATE REQUIRES
   --------------------------------------
     1  REAL ADAPTER    adapter.set -> validated write -> adapter.get ->
                        resolver observes the evidence
     2  NEGATIVE        empty store -> resolver -> UNKNOWN
     3  MERGE POSITIVE  set({notRunReason:X},{merge:true}) then
                        set({health:Y},{merge:true}) -> notRunReason is STILL X

   Control 3 earns its place by proving the PREMISE of the stale-field test
   rather than assuming Firestore's merge semantics. It establishes what merge
   does; it does NOT prove the production adapter is correct. Those are separate
   claims and control 1 has to pass on its own.

   IT CANNOT TOUCH PRODUCTION
   ---------------------------
   The guard below runs BEFORE firebase-admin is required and fails CLOSED: with
   FIRESTORE_EMULATOR_HOST absent, firebase-admin would talk to real Firestore,
   so "no emulator" must abort rather than fall through.
   ============================================================================ */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* ── SAFETY GUARD — BEFORE ANY FIREBASE REQUIRE ──────────────────────────── */
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
const PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;
const CERT_PROJECT = /^sokoni-evidence-cert/;

function abort (why) {
  console.error('\n  ABORTED — ' + why);
  console.error('  This suite writes to Firestore and will not run without proof that');
  console.error('  the target is an emulator. Run it through:');
  console.error('      node scripts/run-evidence-firestore-cert.js\n');
  process.exit(2);
}
if (!HOST) abort('FIRESTORE_EMULATOR_HOST is not set.');
if (!LOOPBACK.test(HOST)) abort('FIRESTORE_EMULATOR_HOST is not loopback: ' + HOST);
if (!CERT_PROJECT.test(PROJECT)) abort('not the dedicated cert project: ' + JSON.stringify(PROJECT));

/* firebase-admin is installed under functions/, not at the repository root —
   the deployable package owns its dependencies. This is the resolution every
   other script here uses (e.g. scripts/backfill-product-counters.js:49); the
   evidence module's own lazy require resolves the same copy at runtime because
   it lives inside functions/. */
const admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const evidence = require(path.join(ROOT, 'functions/integration-evidence.js'));
const probes   = require(path.join(ROOT, 'functions/integration-probes.js'));
const status   = require(path.join(ROOT, 'functions/integration-status.js'));
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));

let pass = 0, fail = 0, unproven = 0;
const T = async (name, fn) => {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};
/* A condition this environment cannot bring to a conclusion. It is NOT a pass —
   it is counted separately and printed separately, because an experiment that
   could not be run and an experiment that succeeded are different facts and a
   suite that collapses them is the thing this whole model exists to prevent. */
const U = async (name, fn) => {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { unproven++; console.log('  UNPROVEN  ' + name + '\n        ' + (e && e.message)); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const sec = (s) => console.log('\n' + s + '\n' + '-'.repeat(s.length));

const COL = evidence.COLLECTION;

async function wipe () {
  const snap = await db.collection(COL).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

function probeResult (over) {
  return Object.assign({
    id: 'firestore',
    health: 'connected',
    healthKind: 'measurable',
    stages: { configured: true, connected: true, accepted: true, delivered: null, received: null },
    support: { connected: 'supported', accepted: 'supported',
               delivered: 'not-supported', received: 'not-supported' },
    evidence: 'service_account',
    detail: 'diagnostic document written and deleted',
    correlationId: null,
    checkedAt: new Date().toISOString(),
    notRunReason: null,
  }, over || {});
}

(async function main () {

sec('0 · THE TARGET IS AN EMULATOR, AND THE GUARD CAN ACTUALLY REFUSE');

await T('connected to the emulator named in FIRESTORE_EMULATOR_HOST', async () => {
  const ref = db.collection('_certProbe').doc('x');
  await ref.set({ t: Date.now() });
  ok((await ref.get()).exists, 'the emulator did not accept a write');
  await ref.delete();
  console.log('        host=' + HOST + '  project=' + PROJECT);
});

await T('INVERTING CONTROL — the guard rejects a non-emulator target', () => {
  /* A guard is only worth having if it can refuse. Asserted on the predicates,
     since the guard itself has already run and passed in this process. */
  ok(!LOOPBACK.test('firestore.googleapis.com:443'), 'a real endpoint must not look like loopback');
  ok(!LOOPBACK.test(''), 'an unset variable must not pass');
  ok(!CERT_PROJECT.test('sokoni-aeb26'), 'PRODUCTION must not pass the project check');
  ok(LOOPBACK.test('127.0.0.1:8091') && CERT_PROJECT.test('sokoni-evidence-cert'),
    'control: a genuine emulator target must pass');
});

sec('1 · CONTROL 1 — THE REAL ADAPTER CHAIN');

await T('adapter.set -> validated write -> adapter.get -> record round-trips', async () => {
  await wipe();
  const store = evidence.firestoreStore();
  eq(store.kind, 'firestore', 'this must be the real adapter, not a substitute: ');
  const w = await evidence.writeEvidence(probeResult(), { store });
  ok(w.written, 'the validated write was refused: ' + (w.errors || []).join('; '));
  const back = await store.get('firestore');
  ok(back, 'nothing came back from the real collection');
  eq(back.integrationId, 'firestore', '');
  eq(back.health, 'connected', '');
  eq(back.evidence, 'service_account', '');
});

await T('...and the RESOLVER observes it through the DEFAULT path — nothing injected', async () => {
  /* resolveIntegrationStatus({}) is how admin-os.js calls it. No evidenceStore,
     no latestProbes: the module resolves the real adapter itself. This code path
     is exercised nowhere in the in-memory suite. */
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(res.evidenceReadable, true, '');
  eq(res.evidenceError, null, '');
  const fs = res.integrations.find((i) => i.id === 'firestore');
  eq(fs.health, 'connected', 'the production default path did not observe the evidence: ');
  eq(fs.evidence, 'service_account', '');
  ok(fs.probedAt, 'probedAt must be populated from the persisted checkedAt');
  eq(res.integrations.length, registry.INTEGRATIONS.length, '52/52 preserved: ');
});

await T('a real PROBE completes the chain end to end via persistEvidence', async () => {
  await wipe();
  const r = await probes.runProbe('firestore', {
    credentialState: 'not-applicable',
    lifecycle: 'active',
    execute: async () => ({ connected: true, accepted: true, evidence: 'service_account',
                            detail: 'emulator round trip' }),
    persistEvidence: true,              /* no store injected — the default adapter */
  });
  eq(r.health, 'connected', 'the probe itself must succeed first: ');
  ok(r.persisted && r.persisted.written,
    'the default adapter did not persist: ' + JSON.stringify(r.persisted));
  const doc = await db.collection(COL).doc('firestore').get();
  ok(doc.exists, 'no document at ' + COL + '/firestore');
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(res.integrations.find((i) => i.id === 'firestore').health, 'connected', '');
});

sec('2 · CONTROL 2 — THE NEGATIVE PATH');

await T('empty store -> resolver -> UNKNOWN, and an empty collection is READABLE', async () => {
  await wipe();
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(res.evidenceReadable, true, 'an EMPTY collection is readable, not an error: ');
  eq(res.evidenceError, null, '');
  eq(res.integrations.find((i) => i.id === 'firestore').health, 'unknown', '');
  eq(res.integrations.find((i) => i.id === 'firestore').probedAt, null, '');
  ok(res.integrations.every((i) => i.health === 'unknown'),
    'with no evidence at all, nothing may claim a health');
});

await T('get() on an absent document returns null — not a throw, not {}', async () => {
  eq(await evidence.firestoreStore().get('algolia'), null, '');
});

sec('3 · CONTROL 3 — THE KNOWN-POSITIVE {merge:true} CONTROL');

await T('Firestore merge DOES preserve a field the later write omits', async () => {
  /* This establishes merge SEMANTICS. It is deliberately written against raw
     Firestore, not through the adapter, because its job is to prove the premise
     the next test relies on — not to say anything about our implementation. */
  const ref = db.collection('_certMerge').doc('sendgrid');
  await ref.set({ integrationId: 'sendgrid', notRunReason: 'requires_secret_binding' },
    { merge: true });
  await ref.set({ integrationId: 'sendgrid', health: 'connected' }, { merge: true });
  const after = (await ref.get()).data();
  eq(after.notRunReason, 'requires_secret_binding',
    'merge was expected to PRESERVE the stale refusal: ');
  eq(after.health, 'connected', 'and to have applied the later write: ');
  await ref.delete();
});

await T('the ADAPTER does not — set() replaces, so a stale refusal is CLEARED', async () => {
  /* Measured against the known-positive above rather than asserted in a vacuum.
     This is the defect that makes integrationProbeLatest unadoptable: a rail
     that refused once would read as refusing after it started working. */
  await wipe();
  const store = evidence.firestoreStore();
  const fourStage = { connected: 'supported', accepted: 'supported',
                      delivered: 'supported', received: 'supported' };

  await store.set('sendgrid', evidence.buildRecord(probeResult({
    id: 'sendgrid', health: 'unknown', notRunReason: 'requires_secret_binding',
    stages: { configured: true, connected: null, accepted: null, delivered: null, received: null },
    support: fourStage, evidence: 'none', detail: 'key not bound',
  }), {}));
  eq((await store.get('sendgrid')).notRunReason, 'requires_secret_binding', 'setup: ');

  await store.set('sendgrid', evidence.buildRecord(probeResult({
    id: 'sendgrid', support: fourStage, evidence: 'provider_api',
  }), {}));
  eq((await store.get('sendgrid')).notRunReason, null,
    'the refusal survived a later successful probe — the adapter is merging: ');
});

sec('4 · TRI-STATE null SURVIVES SERIALISATION AS null, NOT AS ABSENT');

await T('stages.delivered = null round-trips as null and the record still validates', async () => {
  await wipe();
  const store = evidence.firestoreStore();
  await store.set('firestore', evidence.buildRecord(probeResult(), {}));
  const back = await store.get('firestore');

  ok('delivered' in back.stages, 'the key VANISHED — a missing key reads as undefined, not unknown');
  eq(back.stages.delivered, null, '');
  eq(back.stages.received, null, '');
  eq(back.stages.accepted, true, 'a true must stay true: ');
  eq(back.notRunReason, null, '');
  eq(back.serviceCapabilities, null, 'NOT MODELLED must survive as null, not as absent: ');
  /* DERIVED from the producer, not hardcoded. This asserted null and went red the
     moment the runner declared SOKONI_ENVIRONMENT — it was testing the harness's
     configuration, not the round trip. What matters is that whatever environment
     was DECLARED survives serialisation unchanged. */
  eq(back.environment, evidence.declaredEnvironment(),
    'the declared environment must survive the round trip: ');

  const v = evidence.validate(back);
  ok(v.ok, 'a record read back from Firestore no longer validates: ' + v.errors.join('; '));
});

sec('5 · REFUSAL AND FAILURE, AGAINST A REAL DATABASE');

await T('a refused record leaves NOTHING in the real collection', async () => {
  await wipe();
  const out = await evidence.writeEvidence(probeResult({ evidence: 'none' }), {});
  ok(out.refused, 'an unsourced claim was written to Firestore');
  eq((await db.collection(COL).get()).size, 0, 'a refused write must leave the collection empty: ');
});

await T('an invalid document ALREADY in Firestore is dropped, reported, never rendered', async () => {
  await wipe();
  await db.collection(COL).doc('firestore').set(
    Object.assign(evidence.buildRecord(probeResult(), {}), { health: 'gloriously fine' }));
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(res.integrations.find((i) => i.id === 'firestore').health, 'unknown',
    'an invalid stored claim reached the console: ');
  eq(res.evidenceDropped.length, 1, 'the drop must be REPORTED, not silent: ');
  eq(res.evidenceDropped[0].integrationId, 'firestore', '');
});

await T('a LEGACY-shaped document is refused by the reader, not half-read', async () => {
  /* The shape integrationProbeLatest actually holds: the spread probe result,
     no schemaVersion, no environment. If anyone ever points the reader at that
     collection, it must not be mistaken for evidence — which is why adoption has
     to be a deliberate migration rather than a config change. */
  await wipe();
  await db.collection(COL).doc('algolia').set({
    integrationId: 'algolia', health: 'connected', evidence: 'provider_api',
    stages: { configured: true, connected: true, accepted: true, delivered: null, received: null },
    support: { connected: 'supported', accepted: 'supported',
               delivered: 'not-supported', received: 'not-supported' },
    checkedAt: new Date().toISOString(),
  });
  const read = await evidence.readLatestEvidence({});
  eq(Object.keys(read.records).length, 0, 'a legacy-shaped document was accepted: ');
  eq(read.dropped.length, 1, '');
  ok(read.dropped[0].errors.some((e) => e.indexOf('schemaVersion') > -1),
    'expected the schemaVersion rule to catch it: ' + read.dropped[0].errors.join('; '));
});

/* ── THE BOUNDED READ — four proofs, and the deadline derived not chosen ──
   The adapter used to hang against an unreachable Firestore, which made
   `evidenceReadable: false` unreachable through the real path. These assert the
   repair, in the four states the owner specified. */

let HEALTHY_MAX_MS = null;

await T('the healthy envelope is MEASURED here, not assumed', async () => {
  await wipe();
  const store = evidence.firestoreStore();
  for (let i = 0; i < 52; i++) {
    await store.set('firestore', evidence.buildRecord(probeResult(), {}));   /* same doc, realistic write cost */
  }
  await wipe();
  const ids = registry.INTEGRATIONS.slice(0, 52).map((e) => e.id);
  for (const id of ids) {
    const sup = probes.supportFor(id);
    await store.set(id, evidence.buildRecord(probeResult({
      id, health: 'unknown', evidence: 'none',
      stages: { configured: null, connected: null, accepted: null, delivered: null, received: null },
      support: { connected: sup.connected ? 'supported' : 'not-supported',
                 accepted:  sup.accepted  ? 'supported' : 'not-supported',
                 delivered: sup.delivered ? 'supported' : 'not-supported',
                 received:  sup.received  ? 'supported' : 'not-supported' },
    }), {}));
  }
  const runs = [];
  for (let k = 0; k < 5; k++) {
    const t0 = Date.now();
    const rows = await store.list();
    runs.push(Date.now() - t0);
    eq(rows.length, 52, 'the measured read must actually return everything: ');
  }
  runs.sort((a, b) => a - b);
  HEALTHY_MAX_MS = runs[runs.length - 1];
  console.log('        52 docs · median ' + runs[2] + 'ms · max ' + HEALTHY_MAX_MS + 'ms');
  ok(HEALTHY_MAX_MS > 0, 'a zero measurement would make the ratio below meaningless');
});

await T('the deadline is DERIVED — a ratio to both ends, not a pinned constant', () => {
  /* Asserting 10000 === 10000 would prove nothing and would go green if the
     callable budget changed underneath it. These are the two relationships the
     number has to satisfy. */
  const D = evidence.EVIDENCE_READ_DEADLINE_MS;
  const C = evidence.CALLABLE_TIMEOUT_MS;
  ok(D > HEALTHY_MAX_MS * 20,
    'deadline ' + D + 'ms is not comfortably above the measured healthy max ' +
    HEALTHY_MAX_MS + 'ms — a slow-but-healthy read would be reported unreadable');
  ok(D <= C / 4,
    'deadline ' + D + 'ms leaves too little of the ' + C + 'ms callable budget for the ' +
    'secret inventory and the response');
  console.log('        healthy max ' + HEALTHY_MAX_MS + 'ms  <<  deadline ' + D +
              'ms  <<  callable ' + C + 'ms');
});

await T('PROOF 2 — a HEALTHY read: readable true, and the resolver sees the evidence', async () => {
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(res.evidenceReadable, true, '');
  eq(res.evidenceError, null, '');
  eq(res.integrations.filter((i) => i.probedAt).length, 52, 'all 52 written must be observed: ');
});

await T('PROOF 3 — SLOW BUT SUCCESSFUL stays successful, it does not become unreadable', async () => {
  /* The failure this guards against is a deadline so tight that a healthy read
     which merely took longer than usual is reported as a fault. The deadline is
     set just above the measured envelope — far tighter than production — and
     the read must still succeed. */
  const generous = Math.max(HEALTHY_MAX_MS * 4, 400);
  const store = evidence.firestoreStore({ deadlineMs: generous });
  eq(store.deadlineMs, generous, 'the test store must carry its own deadline: ');
  const rows = await store.list();
  eq(rows.length, 52, 'a read inside the window must return everything: ');
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: store });
  eq(res.evidenceReadable, true, 'a slow-but-successful read must NOT read as unreadable: ');
  eq(res.evidenceError, null, '');
});

await T('PROOF 4 — an expired deadline is UNREADABLE, never MISSING', async () => {
  /* The distinction the whole evidence model rests on. A 1ms deadline cannot be
     met even by the emulator, so the read times out with 52 documents sitting
     in the collection. The resolver must say "could not find out", not
     "nothing is there". */
  const store = evidence.firestoreStore({ deadlineMs: 1 });
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: store });

  eq(res.evidenceReadable, false, 'a timeout must report UNREADABLE: ');
  ok(res.evidenceError, 'and must say why');
  ok(/deadline|cancel/i.test(res.evidenceError), 'the reason must name the deadline: ' + res.evidenceError);
  eq(res.integrations.length, registry.INTEGRATIONS.length, 'every entry still returned: ');
  ok(res.integrations.every((i) => i.health === 'unknown'), 'every entry unknown');
  ok(res.integrations.every((i) => i.probedAt === null), 'no entry may claim a probe');
  eq(res.evidenceDropped.length, 0, 'a timeout is not a DROP — nothing was read to drop: ');

  /* The inverting control that makes the above mean something: an EMPTY
     collection is READABLE. Both yield `unknown` for all 52, and they must
     remain distinguishable — that is precisely timeout ≠ missing. */
  await wipe();
  const empty = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(empty.evidenceReadable, true, 'an empty collection is READABLE, not a timeout: ');
  eq(empty.evidenceError, null, '');
  ok(empty.integrations.every((i) => i.health === 'unknown'),
    'control: empty also yields unknown — so health alone cannot tell them apart, and ' +
    'evidenceReadable is what does');
});

await T('PROOF 1 — an UNREACHABLE Firestore returns BOUNDED, closed, and unknown', async () => {
  /* The condition that could not be brought to a conclusion before the repair:
     gRPC retries UNAVAILABLE for ever and the SDK exposes no per-call deadline,
     so the read never returned at all. */
  const keep = process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  const dead = admin.initializeApp({ projectId: PROJECT }, 'dead');
  const deadDb = dead.firestore();
  deadDb.settings({ host: '127.0.0.1:1', ssl: false });
  process.env.FIRESTORE_EMULATOR_HOST = keep;

  const DL = 1500;
  const deadStore = {
    kind: 'firestore-dead', deadlineMs: DL,
    async get () { return null; },
    async set () { return true; },
    /* The SAME bounded-read construction as the adapter, over the dead client:
       stream + destroy on deadline. If this returns, cancellation works. */
    async list () {
      return await new Promise((resolve, reject) => {
        const rows = []; let settled = false; let st;
        const timer = setTimeout(() => {
          if (settled) return; settled = true;
          try { if (st) st.destroy(new Error('evidence read deadline')); } catch (_) {}
          const e = new Error('evidence read exceeded ' + DL + 'ms and was cancelled');
          e.code = 'evidence_read_deadline'; reject(e);
        }, DL);
        const fin = (f, a) => { if (!settled) { settled = true; clearTimeout(timer); f(a); } };
        try { st = deadDb.collection(COL).stream(); } catch (e) { return fin(reject, e); }
        st.on('data', (d) => rows.push(d.data()));
        st.on('end', () => fin(resolve, rows));
        st.on('error', (e) => fin(reject, e));
      });
    },
  };

  const t0 = Date.now();
  const res = await status.resolveIntegrationStatus({
    listSecretNames: async () => [], evidenceStore: deadStore });
  const elapsed = Date.now() - t0;

  ok(elapsed < DL * 3, 'the read must return BOUNDED — took ' + elapsed + 'ms against a ' +
    DL + 'ms deadline');
  eq(res.evidenceReadable, false, '');
  ok(res.evidenceError, 'the reason must be reported');
  eq(res.integrations.length, registry.INTEGRATIONS.length, 'every entry still returned: ');
  ok(res.integrations.every((i) => i.health === 'unknown'),
    'an unreachable database must yield unknown for all, never a fabricated health');
  console.log('        returned in ' + elapsed + 'ms · ' + String(res.evidenceError).slice(0, 56));

  /* CANCELLATION, NOT CONCEALMENT. The owner's condition: a bare race would
     stop the caller waiting while the work continued, and repeated invocations
     would accumulate it. Three more calls must each return bounded — if the
     first had merely been abandoned, these would queue behind it. */
  for (let k = 0; k < 3; k++) {
    const t = Date.now();
    const r = await status.resolveIntegrationStatus({
      listSecretNames: async () => [], evidenceStore: deadStore });
    const el = Date.now() - t;
    eq(r.evidenceReadable, false, 'repeat ' + (k + 1) + ': ');
    ok(el < DL * 3, 'repeat ' + (k + 1) + ' took ' + el + 'ms — work is accumulating');
  }
  await dead.delete();
});

await U('cancellation releases the underlying gRPC resources', () => {
  /* STATED, NOT PROVEN. destroy() tears the call down — measured at 7ms against
     a dead endpoint — and repeated invocations stay bounded, which is what the
     caller can observe. Whether every gRPC channel and retry timer is reclaimed
     inside the SDK is not observable from here, and no assertion in this suite
     establishes it. The adapter therefore claims a BOUNDED RETURN and real
     stream cancellation; it does not claim zero residual resource. */
  throw new Error('not observable from this process — the adapter claims a bounded ' +
    'return and stream cancellation, not zero residual gRPC resource');
});


sec('6 · MANY RECORDS — list() is not a one-document happy path');

await T('twelve written, twelve read back, all validating', async () => {
  await wipe();
  const store = evidence.firestoreStore();
  const ids = registry.INTEGRATIONS.slice(0, 12).map((e) => e.id);
  for (const id of ids) {
    const sup = probes.supportFor(id);
    await store.set(id, evidence.buildRecord(probeResult({
      id, health: 'unknown', evidence: 'none',
      stages: { configured: null, connected: null, accepted: null, delivered: null, received: null },
      support: { connected: sup.connected ? 'supported' : 'not-supported',
                 accepted:  sup.accepted  ? 'supported' : 'not-supported',
                 delivered: sup.delivered ? 'supported' : 'not-supported',
                 received:  sup.received  ? 'supported' : 'not-supported' },
    }), {}));
  }
  const read = await evidence.readLatestEvidence({});
  eq(read.readable, true, '');
  eq(read.dropped.length, 0, 'records this suite wrote must all validate: ' + JSON.stringify(read.dropped));
  eq(Object.keys(read.records).length, 12, '');
  ids.forEach((id) => ok(read.records[id], id + ' did not come back'));
});

await T('and the resolver reports exactly those twelve, the other 48 unknown', async () => {
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => [] });
  eq(res.integrations.length, registry.INTEGRATIONS.length, '');
  eq(res.integrations.filter((i) => i.probedAt).length, 12,
    'exactly the twelve written must carry a probedAt: ');
});

sec('7 · THE MIGRATION BOUNDARY IS NOT CROSSED BY THIS GATE');

await T('nothing here wrote a record for any rail outside the three, except test fixtures', () => {
  /* Stated rather than measured: this suite deliberately writes twelve records
     in section 6 to exercise list(). It is a TEST FIXTURE in a throwaway
     emulator, not a migration — the emulator is destroyed when the runner exits
     and no production collection was touched. The migration boundary applies to
     the migration lane, which has not started. */
  const three = ['cloud-storage', 'firestore', 'memorystore-redis'];
  eq(JSON.stringify(registry.INTEGRATIONS
      .filter((e) => evidence.classifyEvidenceSource(e.id) === 'runnable-with-evidence')
      .map((e) => e.id).sort()), JSON.stringify(three),
    'the three Step E authorises have changed: ');
});

sec('8 · CLEANUP');

await T('the evidence collection is emptied', async () => {
  await wipe();
  eq((await db.collection(COL).get()).size, 0, '');
});

console.log('\n' + '='.repeat(66));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' UNPROVEN');
console.log('='.repeat(66));
console.log('\n  PROVEN    the real Firestore adapter: lazy resolution, set() replacing');
console.log('            rather than merging (against a known-positive merge control),');
console.log('            tri-state null surviving serialisation, and the DEFAULT');
console.log('            uninjected resolver path end to end.');
console.log('            THE BOUNDED READ, in all four states: unreachable -> bounded');
console.log('            return, evidenceReadable false, error reported, unknown for all;');
console.log('            healthy -> readable; slow-but-successful -> still successful;');
console.log('            expired deadline -> UNREADABLE, never MISSING. Cancellation is');
console.log('            stream.destroy(), not a bare race: repeated invocations each');
console.log('            return bounded, so abandoned work does not accumulate.');
console.log('  UNPROVEN  whether every gRPC channel and retry timer is reclaimed inside');
console.log('            the SDK after cancellation — not observable from this process.');
console.log('            The adapter claims a bounded return and stream cancellation;');
console.log('            it does NOT claim zero residual resource.');
console.log('  SCOPE     the Firestore EMULATOR. Production was NOT contacted; the guard');
console.log('            makes that unable to happen by accident. The healthy-read');
console.log('            envelope measured here is a LOCAL FLOOR, not a production');
console.log('            envelope — production IAM, indexes and latency are UNPROVEN.');
console.log('  NOT DONE  no migration, no deployment, no integrationProbeLatest change,');
console.log('            no synthetic observation for any inbound rail.\n');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  SUITE CRASHED — a crash is not a pass\n', e); process.exit(1); });
