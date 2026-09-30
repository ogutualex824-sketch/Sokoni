#!/usr/bin/env node
/* ============================================================================
   scripts/test-integration-disagreement.js
   ============================================================================
   Proves the six ratified disagreement states, and proves the resolver does not
   silently flatten them into a generic UNKNOWN / ACTIVE / FAILED.

   WHY THIS IS A GATE OF ITS OWN
   ------------------------------
   Before this slice the resolver carried ONE `notRunReason`, and a probe's
   reason overwrote the declaration. So a rail declared `requires_secret_binding`
   whose probe then SUCCEEDED reported exactly like a healthy `runnable` rail —
   the successful probe's null reason erased the declaration. Two of the six
   combinations were therefore unreachable by construction: the stale
   declaration, and the money-rail tripwire.

   The test that matters is not "each state has a label". It is that states
   which look identical through health alone are distinguishable through the
   comparison — and that the two dangerous ones are OBSERVABLE without an
   operator scrolling 52 rows.

   No emulator: this is resolver logic over an injected store. No migration, no
   deployment, no console change, no integrationProbeLatest access.
   ============================================================================ */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const status   = require(path.join(ROOT, 'functions/integration-status.js'));
const evidence = require(path.join(ROOT, 'functions/integration-evidence.js'));
const probes   = require(path.join(ROOT, 'functions/integration-probes.js'));
const execs    = require(path.join(ROOT, 'functions/integration-probe-executors.js'));
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));

let pass = 0, fail = 0;
const T = async (name, fn) => {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const sec = (s) => console.log('\n' + s + '\n' + '-'.repeat(s.length));

/* Rails whose DECLARATION is each of the three probeable kinds. Taken from the
   executor table rather than named here, so the fixtures cannot drift from the
   declarations they are supposed to exercise. */
const NO_SAFE   = Object.keys(execs.REFUSES_BY_DESIGN).find((k) => execs.REFUSES_BY_DESIGN[k] === 'no_safe_probe');
const NEEDS_BIND = Object.keys(execs.REFUSES_BY_DESIGN).find((k) => execs.REFUSES_BY_DESIGN[k] === 'requires_secret_binding');
const RUNNABLE  = registry.INTEGRATIONS.find((e) => execs.probeAvailability(e.id) === 'runnable').id;

/* A VALID evidence record — validate() must accept every fixture, or the test
   would be asserting against records the store would refuse anyway. */
function observation (id, over) {
  const sup = probes.supportFor(id);
  return evidence.buildRecord(Object.assign({
    id,
    health: 'connected',
    healthKind: 'measurable',
    stages: { configured: true, connected: true, accepted: true, delivered: null, received: null },
    support: {
      connected: sup.connected ? 'supported' : 'not-supported',
      accepted:  sup.accepted  ? 'supported' : 'not-supported',
      delivered: sup.delivered ? 'supported' : 'not-supported',
      received:  sup.received  ? 'supported' : 'not-supported',
    },
    evidence: 'provider_api',
    detail: null, correlationId: null,
    checkedAt: new Date().toISOString(),
    notRunReason: null,
  }, over || {}), {});
}

/* A probe that RAN and REFUSED: a reason, and no runtime stage true. */
function refusal (id, code) {
  return observation(id, {
    health: 'unknown', evidence: 'none', notRunReason: code,
    stages: { configured: true, connected: null, accepted: null, delivered: null, received: null },
  });
}

async function resolve (records) {
  const store = evidence.memoryStore(records || {});
  return await status.resolveIntegrationStatus({ listSecretNames: async () => [], evidenceStore: store });
}
const rec = (res, id) => res.integrations.find((i) => i.id === id);

(async function main () {

sec('0 · THE FIXTURES ARE VALID RECORDS, NOT SHAPES THE STORE WOULD REFUSE');

await T('every fixture passes validate() — otherwise the matrix is tested on fiction', () => {
  [observation(RUNNABLE), observation(NEEDS_BIND), observation(NO_SAFE),
   refusal(RUNNABLE, 'requires_secret_binding')].forEach((r) => {
    const v = evidence.validate(r);
    ok(v.ok, r.integrationId + ': ' + v.errors.join('; '));
  });
});

await T('the three declaration kinds are taken from the executor table, not named here', () => {
  eq(execs.probeAvailability(NO_SAFE), 'no_safe_probe', NO_SAFE + ': ');
  eq(execs.probeAvailability(NEEDS_BIND), 'requires_secret_binding', NEEDS_BIND + ': ');
  eq(execs.probeAvailability(RUNNABLE), 'runnable', RUNNABLE + ': ');
  console.log('        no_safe=' + NO_SAFE + ' · needs_binding=' + NEEDS_BIND + ' · runnable=' + RUNNABLE);
});

sec('1 · THE SIX RATIFIED STATES, ONE AT A TIME');

await T('no_safe_probe + no observation  ->  expected-refusal', async () => {
  const r = rec(await resolve({}), NO_SAFE);
  eq(r.evidenceDisagreement.state, 'expected-refusal', '');
  eq(r.evidenceDisagreement.severity, 'ok', '');
  eq(r.probedAt, null, '');
});

await T('no_safe_probe + ANY observation  ->  safety-tripwire', async () => {
  const r = rec(await resolve({ [NO_SAFE]: observation(NO_SAFE) }), NO_SAFE);
  eq(r.evidenceDisagreement.state, 'safety-tripwire', '');
  eq(r.evidenceDisagreement.severity, 'tripwire', '');
});

await T('requires_secret_binding + no successful observation  ->  declared-current', async () => {
  const r = rec(await resolve({}), NEEDS_BIND);
  eq(r.evidenceDisagreement.state, 'declared-current', '');
  eq(r.evidenceDisagreement.severity, 'ok', '');
});

await T('requires_secret_binding + a successful observation  ->  stale-declaration', async () => {
  const r = rec(await resolve({ [NEEDS_BIND]: observation(NEEDS_BIND) }), NEEDS_BIND);
  eq(r.evidenceDisagreement.state, 'stale-declaration', '');
  eq(r.evidenceDisagreement.severity, 'action', '');
});

await T('runnable + observed requires_secret_binding  ->  binding-regression', async () => {
  const r = rec(await resolve({ [RUNNABLE]: refusal(RUNNABLE, 'requires_secret_binding') }), RUNNABLE);
  eq(r.evidenceDisagreement.state, 'binding-regression', '');
  eq(r.evidenceDisagreement.severity, 'action', '');
});

await T('runnable + a successful observation  ->  verified-evidence', async () => {
  const r = rec(await resolve({ [RUNNABLE]: observation(RUNNABLE) }), RUNNABLE);
  eq(r.evidenceDisagreement.state, 'verified-evidence', '');
  eq(r.evidenceDisagreement.severity, 'ok', '');
});

sec('2 · THEY ARE NOT FLATTENED — the states health CANNOT tell apart');

await T('stale-declaration and verified-evidence are IDENTICAL through health', async () => {
  /* This is the whole point. Both rails were reached, both report the same
     health and the same evidence. Through the pre-slice resolver they were
     indistinguishable, because the successful probe's null reason erased the
     declaration. Only the comparison separates them. */
  const res = await resolve({
    [NEEDS_BIND]: observation(NEEDS_BIND),
    [RUNNABLE]:   observation(RUNNABLE),
  });
  const a = rec(res, NEEDS_BIND), b = rec(res, RUNNABLE);

  eq(a.health, b.health, 'control: health must be the same for the flattening to be real — ');
  eq(a.evidence, b.evidence, 'control: evidence must be the same — ');
  eq(a.notRunReason, b.notRunReason, 'control: the single legacy field is the same for both — ');

  ok(a.evidenceDisagreement.state !== b.evidenceDisagreement.state,
    'two materially different situations collapsed into one state');
  eq(a.evidenceDisagreement.state, 'stale-declaration', '');
  eq(b.evidenceDisagreement.state, 'verified-evidence', '');
  console.log('        both health=' + a.health + ' evidence=' + a.evidence +
              ' notRunReason=' + JSON.stringify(a.notRunReason) +
              '  ->  ' + a.evidenceDisagreement.state + ' vs ' + b.evidenceDisagreement.state);
});

await T('declaration and observation are separate FIELDS, not one overwritten by the other', async () => {
  const r = rec(await resolve({ [NEEDS_BIND]: observation(NEEDS_BIND) }), NEEDS_BIND);
  eq(r.declaredProbeState, 'requires_secret_binding', 'the declaration must survive a successful probe: ');
  eq(r.observedNotRunReason, null, 'and the observation must report its own truth: ');
  /* The legacy single field still behaves exactly as the console expects. */
  eq(r.notRunReason, null, 'the console contract is unchanged: ');
});

await T('all six states are DISTINCT — none is an alias of another', async () => {
  const seen = {};
  const cases = [
    [{}, NO_SAFE], [{ [NO_SAFE]: observation(NO_SAFE) }, NO_SAFE],
    [{}, NEEDS_BIND], [{ [NEEDS_BIND]: observation(NEEDS_BIND) }, NEEDS_BIND],
    [{ [RUNNABLE]: refusal(RUNNABLE, 'requires_secret_binding') }, RUNNABLE],
    [{ [RUNNABLE]: observation(RUNNABLE) }, RUNNABLE],
  ];
  for (const [store, id] of cases) {
    const d = rec(await resolve(store), id).evidenceDisagreement;
    ok(d, id + ' produced no state');
    ok(!seen[d.state], 'state ' + d.state + ' was produced by two different combinations');
    seen[d.state] = true;
  }
  eq(Object.keys(seen).length, 6, 'six combinations must yield six states: ');
});

sec('3 · THE TWO DANGEROUS STATES ARE OBSERVABLE, NOT MERELY LABELLED');

await T('GUARD — a safety tripwire is HOISTED to the response, not buried in row 37', async () => {
  /* A per-record field an operator must go looking for is a field nobody finds.
     A probe that ran against a money rail has to surface without anyone
     scrolling 52 rows. */
  const res = await resolve({ [NO_SAFE]: observation(NO_SAFE) });
  eq(res.disagreements.length, 1, 'the tripwire must appear in the hoisted list: ');
  const d = res.disagreements[0];
  eq(d.id, NO_SAFE, '');
  eq(d.state, 'safety-tripwire', '');
  eq(d.severity, 'tripwire', 'it must be the highest severity, not lumped with the actionables: ');
  ok(/moves money/.test(d.note), 'the note must say WHY it matters: ' + d.note);
  ok(d.probedAt, 'and when the probe that should not have happened ran');
});

await T('GUARD — a stale declaration is hoisted too, at action severity', async () => {
  const res = await resolve({ [NEEDS_BIND]: observation(NEEDS_BIND) });
  eq(res.disagreements.length, 1, '');
  eq(res.disagreements[0].state, 'stale-declaration', '');
  eq(res.disagreements[0].severity, 'action', '');
  eq(res.disagreements[0].declared, 'requires_secret_binding', 'it must name what is now wrong: ');
  eq(res.disagreements[0].observed, 'successful-probe', 'and what contradicted it: ');
});

await T('GUARD — a binding regression is hoisted', async () => {
  const res = await resolve({ [RUNNABLE]: refusal(RUNNABLE, 'requires_secret_binding') });
  eq(res.disagreements.length, 1, '');
  eq(res.disagreements[0].state, 'binding-regression', '');
  eq(res.disagreements[0].observed, 'requires_secret_binding', '');
});

await T('INVERTING CONTROL — a quiet system hoists NOTHING', async () => {
  /* Without this, the three guards above would pass against a resolver that
     hoists every record. An empty array has to be reachable. */
  const quiet = await resolve({});
  eq(quiet.disagreements.length, 0, 'no evidence at all must produce no actionable disagreement: ');
  const healthy = await resolve({ [RUNNABLE]: observation(RUNNABLE) });
  eq(healthy.disagreements.length, 0, 'a verified rail is not a disagreement: ');
  /* ...but the ok states still exist ON the records. */
  eq(rec(healthy, RUNNABLE).evidenceDisagreement.state, 'verified-evidence', '');
  eq(rec(quiet, NO_SAFE).evidenceDisagreement.state, 'expected-refusal', '');
});

await T('the ok states are deliberately NOT hoisted', async () => {
  const res = await resolve({});
  const okStates = res.integrations.filter((i) =>
    i.evidenceDisagreement && i.evidenceDisagreement.severity === 'ok');
  eq(okStates.length, 9, 'the 2 no_safe_probe + 7 requires_secret_binding rails: ');
  eq(res.disagreements.length, 0, 'yet none is in the queue of things to do: ');
});

sec('4 · WHAT IS OUTSIDE THE MATRIX RETURNS null, AND THAT IS STATED');

await T('a runnable rail nobody has probed has NO state — the matrix has no such row', async () => {
  const r = rec(await resolve({}), RUNNABLE);
  eq(r.evidenceDisagreement, null,
    'inventing a seventh state would be exactly the unratified taxonomy this model refuses: ');
  eq(r.declaredProbeState, 'runnable', 'the declaration is still reported: ');
});

await T('a rail with no executor has no state either', async () => {
  const none = registry.INTEGRATIONS.find((e) => execs.probeAvailability(e.id) === 'none');
  const r = rec(await resolve({}), none.id);
  eq(r.evidenceDisagreement, null, none.id + ': ');
  eq(r.declaredProbeState, 'none', '');
});

await T('the baseline census — with no evidence, exactly 2 + 7 states and 52 nulls', async () => {
  const res = await resolve({});
  const m = {};
  res.integrations.forEach((i) => {
    const k = i.evidenceDisagreement ? i.evidenceDisagreement.state : '(null)';
    m[k] = (m[k] || 0) + 1;
  });
  eq(m['expected-refusal'], 2, '');
  eq(m['declared-current'], 7, '');
  eq(m['(null)'], 52, '3 runnable unobserved + 49 with no executor: ');
  eq(res.integrations.length, 61, '');
  console.log('        ' + JSON.stringify(m));
});

sec('5 · NOTHING ELSE MOVED');

await T('the console contract — notRunReason — is byte-identical to before this slice', async () => {
  /* REFUSED BY DESIGN is rendered from notRunReason at sokoni-integrations.js:398.
     The nine declared refusals must still produce it, unchanged. */
  const res = await resolve({});
  eq(res.integrations.filter((i) => i.notRunReason).length, 9, '');
  Object.keys(execs.REFUSES_BY_DESIGN).forEach((id) => {
    eq(rec(res, id).notRunReason, execs.REFUSES_BY_DESIGN[id], id + ': ');
  });
});

await T('60 technical entries, 2 operational, neither touched', async () => {
  const res = await resolve({});
  eq(res.integrations.length, 61, '');
  eq(registry.OPERATIONAL_DEPENDENCIES.length, 2, '');
  const ids = new Set(res.integrations.map((i) => i.id));
  registry.OPERATIONAL_DEPENDENCIES.forEach((d) =>
    ok(!ids.has(d.id), d.id + ' entered the technical resolver'));
});

console.log('\n' + '='.repeat(66));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(66));
console.log('\n  PROVEN    all six ratified disagreement states, each from a VALID evidence');
console.log('            record; that the six are distinct; that stale-declaration and');
console.log('            verified-evidence are identical through health, evidence and the');
console.log('            legacy notRunReason and are separated only by the comparison; and');
console.log('            that the tripwire, stale declaration and binding regression are');
console.log('            HOISTED into the response rather than buried on a row.');
console.log('  SCOPE     resolver logic over an injected store. No emulator, no migration,');
console.log('            no deployment, no console change, no integrationProbeLatest access.');
console.log('  NOT DONE  the console is NOT taught to render these — that is the next slice,');
console.log('            and it is held until these states are mechanically demonstrated.\n');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  SUITE CRASHED — a crash is not a pass\n', e); process.exit(1); });
