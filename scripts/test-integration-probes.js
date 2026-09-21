/* ══════════════════════════════════════════════════════════════════════════════
   INTEGRATION PROBES — provider health without inventing it            (RC-3)
   scripts/test-integration-probes.js

   RC-1 established whether a credential is configured. This establishes whether
   the provider actually works — and, far more importantly, refuses to claim more
   than the evidence supports.

   THE FIVE STAGES ARE SEPARATE BECAUSE COLLAPSING THEM IS THE DEFECT
   -------------------------------------------------------------------
       configured -> connected -> accepted -> delivered -> received

   An HTTP 200 proves `accepted`. It never proves `delivered`, and it cannot
   prove `received`. A console that treats a 200 as delivery shows a green tick
   for a channel nobody is getting messages on, which is worse than showing
   nothing at all.

   FOUR THINGS THAT ARE NOT FAILURES, AND MUST NOT LOOK LIKE ONE
   ---------------------------------------------------------------
     frozen / quarantined lifecycle   -> disabled   (not probed, by design)
     required credential absent       -> missing    (provider never contacted)
     probe needs a secret this
       function does not bind         -> unknown    (nothing was measured)
     no probe defined for the rail    -> unknown    (19 of 35 are here)

   Only a provider that was reached and refused, or could not be reached, is
   `failed`. Each of those five is asserted separately below, because the whole
   value of this surface is that they are distinguishable.

   WHY STAGE VALUES ARE true | false | null
   ------------------------------------------
   `null` is unknown, and it is falsy. A string like 'unknown' would be TRUTHY,
   so a consumer writing `if (r.stages.delivered)` would read unknown as
   delivered — the exact bug. Section 2 asserts that property directly.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);

const probes   = require(path.join(ROOT, 'functions/integration-probes.js'));
const execs    = require(path.join(ROOT, 'functions/integration-probe-executors.js'));
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));
const PROBE_SRC = fs.readFileSync(path.join(ROOT, 'functions/integration-probes.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const accepts = async () => ({ connected: true, accepted: true, detail: 'provider answered 200' });
const refuses = async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); };
const run = (id, over) => probes.runProbe(id, Object.assign(
  { credentialState: 'configured', execute: accepts }, over || {}));

/* recordProbeEvent must FAIL, not throw. A guard removed upstream turns a
   refusal into a TypeError, and a crash reads as an infrastructure problem
   rather than as 'this proved nothing'. */
const recordEvent = async (cid, ev, st) => {
  try { return await probes.recordProbeEvent(cid, ev, st); }
  catch (e) { return { matched: '<threw: ' + (e && e.message ? e.message.slice(0, 60) : 'error') + '>' }; }
};

/* A tiny in-memory store standing in for integrationProbes/{correlationId}. */
function store (seed) {
  const m = new Map(Object.entries(seed || {}));
  return { m,
    get: async (id) => m.get(id) || null,
    update: async (id, patch) => { m.set(id, Object.assign({}, m.get(id), patch)); } };
}

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  INTEGRATION PROBES — provider health (RC-3)');
  console.log('══════════════════════════════════════════════════════════════════');

  /* ── 1. THE STAGES ARE NOT THE SAME THING ───────────────────────────────── */
  head('1 - configured != connected != accepted != delivered != received');
  {
    const r = await run('sendgrid', { execute: accepts });
    ok('configured is carried from RC-1, not recomputed', r.stages.configured === true);
    ok('a provider that answered is CONNECTED', r.stages.connected === true);
    ok('and ACCEPTED', r.stages.accepted === true);
    /* THE CENTRAL ASSERTION. SendGrid supports delivery, the provider said 200,
       and delivered must still be unknown — only its event webhook can say. */
    ok('a 200 does NOT make it DELIVERED', r.stages.delivered === null,
       String(r.stages.delivered));
    ok('and does NOT make it RECEIVED', r.stages.received === null,
       String(r.stages.received));
    ok('health is connected, not "healthy/delivered"', r.health === 'connected', r.health);
    ok('a correlation id is minted for the asynchronous stages',
       /^probe_sendgrid_[a-f0-9]+$/.test(r.correlationId || ''), r.correlationId);
  }

  /* ── 2. UNKNOWN CANNOT BE MISTAKEN FOR TRUE ─────────────────────────────── */
  head('2 - unknown is falsy, by construction');
  {
    const r = await run('sendgrid');
    ok('null is the unknown value, not a string', r.stages.delivered === null);
    /* The careless consumer check must fail SAFE. A string 'unknown' would pass
       here and ship a green tick. */
    ok('`if (stages.delivered)` does NOT fire on unknown', !r.stages.delivered);
    ok('`if (stages.received)` does NOT fire on unknown', !r.stages.received);
    ok('control — it DOES fire once genuinely delivered',
       !!Object.assign({}, r.stages, { delivered: true }).delivered);
    const code = strip(PROBE_SRC);
    ok('no stage is ever assigned a truthy placeholder string',
       !/stages\.(delivered|received)\s*=\s*'/.test(code));
  }

  /* ── 3. AN UNSUPPORTED STAGE IS NOT-SUPPORTED, NEVER TRUE ───────────────── */
  head('3 - a rail is not asked to evidence what it cannot');
  {
    const alg = await run('algolia');
    ok('Algolia has no notion of delivery', alg.support.delivered === 'not-supported');
    ok('so its delivered stage is null, not false and not true',
       alg.stages.delivered === null, String(alg.stages.delivered));
    ok('and that does NOT drag its health down', alg.health === 'connected', alg.health);

    const fcm = probes.supportFor('fcm');
    ok('FCM accepts but cannot evidence per-device delivery',
       fcm.accepted === true && fcm.delivered === false);
    const isw = probes.supportFor('intasend-webhook');
    ok('an inbound-only rail supports receipt, not acceptance',
       isw.received === true && isw.accepted === false);

    /* INVERTING CONTROL — a rail that DOES support delivery must say so. */
    ok('INVERTING CONTROL — SendGrid declares delivery supported',
       probes.supportFor('sendgrid').delivered === true);
  }

  /* ── 4. FIVE NON-FAILURES, EACH DISTINGUISHABLE ─────────────────────────── */
  head('4 - disabled, missing, not-run, no-probe and failed are different states');
  {
    const frozen = await run('sokoni-wallet');
    ok('a FROZEN rail is disabled, not failed', frozen.health === 'disabled', frozen.health);
    ok('and was not contacted', frozen.stages.connected === null);
    const quar = await run('pos-card-terminal');
    ok('a QUARANTINED rail is disabled, not failed', quar.health === 'disabled', quar.health);

    /* TWO CODE PATHS, BOTH ASSERTED. runProbe() vetoes a non-probeable lifecycle
       and returns early, so the lifecycle branch inside deriveHealth() is never
       reached from there — a sabotage flipping that branch to 'failed' came back
       GREEN until this was added. deriveHealth is the function a future caller
       would reuse, so it is exercised directly. */
    const dh = (lifecycle, credentialState, stages) => probes.deriveHealth(
      { stages: Object.assign({ configured: true, connected: null, accepted: null,
                                delivered: null, received: null }, stages || {}),
        support: { connected: 'supported', accepted: 'supported',
                   delivered: 'not-supported', received: 'not-supported' } },
      { lifecycle, credentialState });
    ok('deriveHealth itself returns disabled for a frozen lifecycle',
       dh('frozen', 'configured') === 'disabled', dh('frozen', 'configured'));
    ok('and for a quarantined one',
       dh('quarantined', 'configured') === 'disabled', dh('quarantined', 'configured'));
    ok('control — deriveHealth CAN return failed, for a live rail that refused',
       dh('live', 'configured', { connected: false }) === 'failed',
       dh('live', 'configured', { connected: false }));
    ok('control — and connected for one that answered',
       dh('live', 'configured', { connected: true, accepted: true }) === 'connected');
    ok('deriveHealth returns missing for absent credentials, not failed',
       dh('live', 'missing') === 'missing', dh('live', 'missing'));

    const miss = await run('algolia', { credentialState: 'missing' });
    ok('MISSING credentials report missing, not failed', miss.health === 'missing', miss.health);
    ok('and the provider was never contacted', miss.stages.connected === null);
    const part = await run('algolia', { credentialState: 'partial' });
    ok('PARTIAL credentials also report missing, not failed', part.health === 'missing');

    const notRun = await probes.runProbe('sendgrid',
      { credentialState: 'configured', execute: execs.executorFor('sendgrid') });
    ok('a probe needing an unbound secret reports unknown, not failed',
       notRun.health === 'unknown', notRun.health);
    ok('with a named reason', notRun.notRunReason === 'requires_secret_binding',
       notRun.notRunReason);
    ok('and claims nothing about the provider', notRun.stages.connected === null);

    /* `cloudflare` was used here until the health-kind taxonomy landed; it is
       classified `elsewhere`, so it now correctly reports observed-elsewhere
       rather than unknown. A MEASURABLE rail with no probe is what demonstrates
       the unknown case. The invariant both share — never `failed` — is asserted
       for both. */
    const noProbe = await run('google-signin');
    ok('a MEASURABLE rail with no probe reports unknown, not failed',
       noProbe.health === 'unknown', noProbe.health);
    ok('and says so', /No probe is defined/i.test(noProbe.detail || ''), noProbe.detail);
    /* HostPinnacle DNS is the ELSEWHERE exemplar. It was 'cloudflare' until that
       entry was corrected: Cloudflare provides an asset CDN here, not DNS, so its
       kind is now 'measurable' and it can no longer demonstrate this case. The
       exemplar must be a rail whose authoritative signal genuinely lives at the
       provider — DNS is read from the HostPinnacle panel and public DNS. */
    const elsewhereNoProbe = await run('hostpinnacle-dns');
    ok('an ELSEWHERE rail with no probe reports observed-elsewhere, not failed',
       elsewhereNoProbe.health === 'observed-elsewhere', elsewhereNoProbe.health);
    ok('neither is ever reported as failed',
       noProbe.health !== 'failed' && elsewhereNoProbe.health !== 'failed');

    /* THE ONE THAT IS ACTUALLY A FAILURE. Without this the four above could be
       passing because nothing is ever reported failed. */
    const failed = await run('typesense', { execute: refuses });
    ok('INVERTING CONTROL — a refused provider IS failed', failed.health === 'failed',
       failed.health);
    ok('with connected false, not null', failed.stages.connected === false);
    ok('and the failure detail does not echo configuration',
       !/KEY|SECRET|TOKEN/i.test(failed.detail || ''), failed.detail);
  }

  /* ── 5. CORRELATION — A CALLBACK MUST BE THE PROBE'S OWN ────────────────── */
  head('5 - only the originating probe can be satisfied by a callback');
  {
    const r = await run('africastalking');
    const cid = r.correlationId;
    const s = store({ [cid]: { integrationId: 'africastalking' } });

    const good = await recordEvent(cid, { stage: 'delivered', outcome: 'delivered' }, s);
    ok('a correlated callback marks the stage delivered',
       good.matched === true && good.outcome === true, JSON.stringify(good));
    ok('and it is recorded against the probe', s.m.get(cid)['stages.delivered'] === true);
    ok('evidence becomes the provider CALLBACK, not the API',
       s.m.get(cid).evidence === 'provider_callback');

    /* THE ADVERSARIAL HALF. Anyone who can reach a public webhook must not be
       able to mark a dead channel healthy. */
    const wrong = await recordEvent('probe_africastalking_deadbeef99',
      { stage: 'delivered', outcome: 'delivered' }, s);
    ok('an UNKNOWN correlation id is refused', wrong.matched === false, wrong.reason);
    ok('with reason no_outstanding_probe', wrong.reason === 'no_outstanding_probe');

    const malformed = await recordEvent('not-a-probe-id', { stage: 'delivered' }, s);
    ok('a malformed correlation id is refused', malformed.matched === false, String(malformed.reason));
    /* The REASON matters: without the format guard this id still fails, but for
       the wrong reason. Asserting only 'refused' let that sabotage pass. */
    ok('and refused for MALFORMED FORMAT, not merely for being unknown',
       malformed.reason === 'malformed_correlation_id', String(malformed.reason));

    const crossed = await recordEvent(cid,
      { stage: 'delivered', outcome: 'delivered', integrationId: 'sendgrid' }, s);
    ok('a callback for a DIFFERENT integration is refused',
       crossed.matched === false && crossed.reason === 'integration_mismatch', crossed.reason);

    const unsupported = await recordEvent('probe_algolia_abc123def',
      { stage: 'delivered' }, store({ 'probe_algolia_abc123def': { integrationId: 'algolia' } }));
    ok('a delivery callback for a rail with no delivery stage is refused',
       unsupported.matched === false && unsupported.reason === 'stage_not_supported',
       unsupported.reason);

    const failedEvent = await recordEvent(cid,
      { stage: 'delivered', outcome: 'failed' }, store({ [cid]: { integrationId: 'africastalking' } }));
    ok('a FAILED delivery report records false, not true',
       failedEvent.outcome === false, String(failedEvent.outcome));
  }

  /* ── 6. NO CREDENTIAL MAY ESCAPE ────────────────────────────────────────── */
  head('6 - probes carry no secret');
  {
    /* NOT CREDENTIALS. AKIAIOSFODNN7EXAMPLE is AWS's own published documentation
       example; the sk_live_ string is invented. They are deliberately
       credential-SHAPED, because a control built from an innocuous string would
       prove nothing about a scanner looking for credential shapes. A secret scan
       will flag these lines; that is expected and has been adjudicated. Do not
       "fix" it by making the values harmless — that silently voids the checks. */
    const r = await run('sendgrid', {
      execute: async () => ({ connected: true, accepted: true,
        detail: 'auth ok with key AKIAIOSFODNN7EXAMPLE and token sk_live_51PlantedProbeValue' }) });
    const blob = JSON.stringify(r);
    /* The executor contract forbids echoing configuration; if one ever does, the
       detail is still truncated and this is the tripwire that catches it. */
    ok('CONTROL — the scan can see a planted value',
       /AKIAIOSFODNN7EXAMPLE/.test('x AKIAIOSFODNN7EXAMPLE y'));
    ok('a detail echoing a credential is visible to the check, not silently kept',
       /AKIA/.test(blob) === true, 'detail is provider-supplied and must be reviewed');

    const clean = await run('firestore', {
      credentialState: 'not-applicable',
      execute: async () => ({ connected: true, accepted: true, evidence: 'service_account',
                              detail: 'Read query executed as the service account.' }) });
    ok('a well-behaved probe result carries no value-like literal',
       !/"[A-Za-z0-9_\-]{28,}"/.test(JSON.stringify(clean)));

    const code = strip(PROBE_SRC);
    ok('the module never reads a secret value', !/accessSecretVersion|process\.env\.[A-Z_]*KEY/.test(code));
    ok('detail is length-capped so a leak cannot be unbounded', /slice\(0, 300\)/.test(code));

    const execCode = strip(fs.readFileSync(path.join(ROOT, 'functions/integration-probe-executors.js'), 'utf8'));
    ok('no executor interpolates configuration into its message',
       !/\$\{[^}]*(KEY|SECRET|TOKEN)[^}]*\}/i.test(execCode));
  }

  /* ── 7. COVERAGE AND SCOPE ──────────────────────────────────────────────── */
  head('7 - all 35 retain coverage; payments unchanged');
  {
    const results = [];
    for (const e of registry.INTEGRATIONS) {
      results.push(await probes.runProbe(e.id, {
        credentialState: 'configured', lifecycle: e.status, execute: execs.executorFor(e.id) }));
    }
    ok('every registry entry produces a probe record',
       results.length === registry.INTEGRATIONS.length,
       results.length + ' of ' + registry.INTEGRATIONS.length);
    ok('none of them is reported failed without being contacted',
       results.every(r => r.health !== 'failed' || r.stages.connected === false));
    /* DERIVED from the registry, not pinned. A literal list here would have to
       be edited every time a lifecycle changes, and would have been wrong today:
       cloud-functions and artifact-registry are also `frozen`, which is accurate
       — they are frozen by the Artifact Registry investigation. */
    const disabled = results.filter(r => r.health === 'disabled').map(r => r.id).sort();
    const expectDisabled = registry.INTEGRATIONS
      .filter(e => probes.NON_PROBEABLE_LIFECYCLES.indexOf(e.status) > -1)
      .map(e => e.id).sort();
    ok('exactly the non-probeable lifecycles are disabled',
       disabled.join(',') === expectDisabled.join(','), disabled.join(','));
    ok('control — that set is non-empty and matches the registry',
       expectDisabled.length === 4, expectDisabled.join(','));
    ok('no rail claims delivery anywhere in this sweep',
       results.every(r => r.stages.delivered !== true));

    /* Payments: IntaSend only, and no probe may transact. */
    const pay = registry.INTEGRATIONS.filter(e => e.category === 'payments');
    ok('payments is IntaSend plus the two disabled rails',
       pay.filter(e => e.status === 'live').every(e => e.vendor === 'IntaSend'));
    ok('no Daraja probe exists', !probes.SUPPORT.daraja && !execs.EXECUTORS.daraja);
    ok('no Daraja record is produced', !results.some(r => /daraja/i.test(r.id)));
    const isc = await probes.runProbe('intasend-collections',
      { credentialState: 'configured', execute: execs.executorFor('intasend-collections') });
    ok('the IntaSend probe refuses to transact', isc.notRunReason === 'no_safe_probe',
       isc.notRunReason);
    ok('and therefore reports unknown, not connected and not failed',
       isc.health === 'unknown', isc.health);
  }

  /* ── 8. AUTHORIZATION ───────────────────────────────────────────────────── */
  head('8 - the probe is admin-only');
  {
    process.env.GCLOUD_PROJECT = 'sokoni-aeb26';
    const adminOs = require(path.join(ROOT, 'functions/admin-os.js'));
    ok('adminRunIntegrationProbe is dispatchable',
       typeof (adminOs._h || {}).adminRunIntegrationProbe === 'function');
    const src = fs.readFileSync(path.join(ROOT, 'functions/admin-os.js'), 'utf8');
    const seg = src.slice(src.indexOf('exports.adminRunIntegrationProbe'));
    ok('it requires admin first', /_requireAdmin\(req\)/.test(seg.slice(0, 700)));
    ok('and enforces App Check', /enforceAppCheck: true/.test(seg.slice(0, 400)));
    ok('it reuses adminGetIntegrationStatus for configuration, not a second authority',
       /resolveIntegrationStatus/.test(seg.slice(0, 2200)));
    ok('it logs health and evidence, never a credential',
       /health: result\.health/.test(seg) && !/secret/i.test(seg.slice(0, 2600)));
  }

  /* ── 9. HEALTH KIND — THREE WAYS OF HAVING NO OBSERVATION ───────────────── */
  head('9 - unknown, observed-elsewhere and not-applicable are different facts');
  {
    const dh = (kind, stages) => probes.deriveHealth(
      { stages: Object.assign({ configured: true, connected: null, accepted: null,
                                delivered: null, received: null }, stages || {}),
        support: { connected: 'supported', accepted: 'supported',
                   delivered: 'not-supported', received: 'not-supported' } },
      { lifecycle: 'live', credentialState: 'configured', healthKind: kind });

    ok('measurable + nothing established -> unknown', dh('measurable') === 'unknown', dh('measurable'));
    ok('elsewhere -> observed-elsewhere', dh('elsewhere') === 'observed-elsewhere', dh('elsewhere'));
    ok('not-applicable -> not-applicable', dh('not-applicable') === 'not-applicable', dh('not-applicable'));

    /* THE TWO AXES STAY SEPARATE. A classification says where health CAN be
       established; it must never become the observation itself. */
    ok('an elsewhere rail a probe REACHED still reports connected',
       dh('elsewhere', { connected: true, accepted: true }) === 'connected',
       dh('elsewhere', { connected: true, accepted: true }));
    ok('and one that FAILED still reports failed',
       dh('elsewhere', { connected: false }) === 'failed');
    ok('observed-elsewhere is never a success state — it is not connected',
       dh('elsewhere') !== 'connected');

    /* An unrecognised or absent kind must understate, not overclaim. */
    ok('an absent kind falls back to unknown', dh(undefined) === 'unknown');
    ok('an unrecognised kind falls back to unknown', dh('bogus') === 'unknown');

    /* Lifecycle and credentials still outrank classification. */
    ok('a frozen rail is disabled regardless of kind',
       probes.deriveHealth({ stages: {}, support: {} },
         { lifecycle: 'frozen', credentialState: 'configured', healthKind: 'not-applicable' }) === 'disabled');
    ok('missing credentials outrank kind',
       probes.deriveHealth({ stages: {}, support: {} },
         { lifecycle: 'live', credentialState: 'missing', healthKind: 'elsewhere' }) === 'missing');

    /* THE GUARDRAIL: classification comes from the CATALOGUE, never from whether
       an executor exists. Deleting a probe must not silently reclassify an
       integration as unmeasurable — it must still be able to report `unknown`. */
    /* Live rails only: a quarantined or frozen lifecycle correctly outranks
       classification and reports `disabled`, which would make the assertion
       below test the wrong thing. */
    const measurableNoExec = registry.INTEGRATIONS
      .filter(e => e.healthKind === 'measurable' && !execs.executorFor(e.id) &&
                   probes.NON_PROBEABLE_LIFECYCLES.indexOf(e.status) === -1);
    ok('control — measurable integrations exist that have NO executor',
       measurableNoExec.length >= 5, measurableNoExec.length + ' of 35');
    for (const e of measurableNoExec.slice(0, 3)) {
      const r = await probes.runProbe(e.id, { credentialState: 'not-applicable',
        execute: execs.executorFor(e.id) });
      ok('no executor does NOT make ' + e.id + ' not-applicable',
         r.health === 'unknown', r.health);
    }
    ok('and every declared kind is carried onto the probe result',
       (await run('hostpinnacle-dns')).healthKind === 'elsewhere',
       (await run('hostpinnacle-dns')).healthKind);
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  any live provider call. Executors are injected here; the only');
  console.log('            executors that could run unbound are Firestore, Cloud Storage');
  console.log('            and Redis, and none is contacted by this suite.');
  console.log('  NOT RUN   7 credential-requiring probes report requires_secret_binding until');
  console.log('            a probe function binds those provider secrets — a deployment');
  console.log('            change, and deployment is frozen.');
  console.log('  SCOPE     no UI, no platformServices reconciliation, no orphan-secret work.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
