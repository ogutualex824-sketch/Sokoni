/* ══════════════════════════════════════════════════════════════════════════════
   INTEGRATION STATUS — authoritative credential configuration       (RC-1)
   scripts/test-integration-status.js

   WHAT THIS PINS
   The Integration Control Center showed nothing useful for 35 integrations whose
   credentials were, in fact, all present. The cause was not a wrong key list or
   a vocabulary mismatch — both consoles load the catalogue and consume it
   correctly. It was that NO deployed function read Secret Manager inventory, so
   the browser had no configuration signal at all, and an integration with no
   signal reads to an operator as missing.

   resolveIntegrationStatus() supplies that signal. This suite EXECUTES it
   against a controlled inventory, so what is asserted is the record it actually
   produces.

   THE SECURITY PROPERTY IS THE POINT
   ----------------------------------
   Presence is established from secrets.LIST, which returns names and metadata
   and cannot return a payload. The function binds no secret, and nothing it
   returns or logs derives from a value. Section 4 plants credential-shaped
   values in the inventory and in the registry and proves none of them reaches
   the response — paired with a control proving the detector would catch one if
   it did, because a scan that cannot fail proves nothing.

   CONFIGURED IS NOT WORKING
   -------------------------
   Every record returns health 'unknown'. That is deliberate and is asserted:
   32 of 35 catalogue entries have no health source, so a surface that inferred
   health from configuration would paint 32 green lights it never measured.
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

const { resolveIntegrationStatus } = require(path.join(ROOT, 'functions/integration-status.js'));
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));
const STATUS_SRC = fs.readFileSync(path.join(ROOT, 'functions/integration-status.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ALL = [...new Set(registry.INTEGRATIONS.flatMap(e => e.requiredSecrets || []))];
const lister = (names) => async () => names;
/* A record that is absent must read as a FAILED assertion, not as a TypeError
   that kills the run before its summary. An integration missing from the
   response is the exact defect this suite exists to catch, so it cannot be
   allowed to crash the harness instead of failing it. */
const MISSING = { credentialState: '<no record>', health: '<no record>', healthNote: '',
                  capabilities: [], credentials: [], vendor: null, category: null };
const byId = (r, id) => r.integrations.find(i => i.id === id) || MISSING;

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  INTEGRATION STATUS — credential configuration (RC-1)');
  console.log('══════════════════════════════════════════════════════════════════');

  const full    = await resolveIntegrationStatus({ listSecretNames: lister(ALL) });
  const none    = await resolveIntegrationStatus({ listSecretNames: lister([]) });
  const partial = await resolveIntegrationStatus({
    listSecretNames: lister(ALL.filter(n => n !== 'INTASEND_PRIVATE_KEY')) });

  /* ── 1. EVERY INTEGRATION GETS A RECORD ─────────────────────────────────── */
  head('1 - all 35 integrations are reported, always');
  {
    ok('one record per registry entry',
       full.integrations.length === registry.INTEGRATIONS.length,
       full.integrations.length + ' of ' + registry.INTEGRATIONS.length);
    ok('and the count does not shrink when nothing is configured',
       none.integrations.length === registry.INTEGRATIONS.length,
       none.integrations.length);
    /* An omitted integration is indistinguishable in the console from one that
       does not exist — the failure mode this whole repair is about. */
    const ids = full.integrations.map(i => i.id).sort().join(',');
    ok('the set is exactly the registry, nothing filtered',
       ids === registry.INTEGRATIONS.map(e => e.id).sort().join(','));
    ok('every record carries category and lifecycle',
       full.integrations.every(i => i.category && i.lifecycle));
    ok('categories are supplied for grouping', full.categories.length === 8,
       full.categories.length);
  }

  /* ── 2. THE SIX-STATE VOCABULARY ────────────────────────────────────────── */
  head('2 - configured, partial, missing, not-applicable, disabled, unknown');
  {
    ok('a fully-credentialled integration is CONFIGURED',
       byId(full, 'intasend-collections').credentialState === 'configured',
       byId(full, 'intasend-collections').credentialState);
    ok('with nothing configured it is MISSING',
       byId(none, 'intasend-collections').credentialState === 'missing',
       byId(none, 'intasend-collections').credentialState);
    ok('one of two keys present is PARTIAL, not configured and not missing',
       byId(partial, 'intasend-collections').credentialState === 'partial',
       byId(partial, 'intasend-collections').credentialState);

    /* NOT-APPLICABLE IS NOT A GAP. Firestore authenticates as the service
       account; reporting it as "missing" would manufacture 19 false alarms. */
    ok('an integration needing no named secret is NOT-APPLICABLE',
       byId(full, 'firestore').credentialState === 'not-applicable',
       byId(full, 'firestore').credentialState);
    ok('and stays not-applicable even with an empty inventory',
       byId(none, 'firestore').credentialState === 'not-applicable');

    ok('a quarantined integration is DISABLED',
       byId(full, 'pos-card-terminal').credentialState === 'disabled',
       byId(full, 'pos-card-terminal').credentialState);
    ok('a frozen integration is DISABLED',
       byId(full, 'sokoni-wallet').credentialState === 'disabled',
       byId(full, 'sokoni-wallet').credentialState);

    /* UNKNOWN != MISSING. Reporting an unreadable inventory as an absent key
       invites someone to re-create a credential that is already there. */
    const err = await resolveIntegrationStatus({
      listSecretNames: async () => { throw new Error('permission denied on secretmanager'); } });
    ok('an unreadable inventory yields UNKNOWN, never missing',
       byId(err, 'intasend-collections').credentialState === 'unknown',
       byId(err, 'intasend-collections').credentialState);
    ok('and says so explicitly', err.inventoryReadable === false && !!err.inventoryError);
    ok('per-credential presence is null, not false, when unknown',
       byId(err, 'intasend-collections').credentials.every(c => c.present === null));
    ok('control — it still reports all 35 when the inventory fails',
       err.integrations.length === 35);
  }

  /* ── 3. CONFIGURED IS NOT WORKING ───────────────────────────────────────── */
  head('3 - no health is claimed that was not measured');
  {
    ok('every record reports health unknown',
       full.integrations.every(i => i.health === 'unknown'));
    ok('including the fully-configured ones',
       byId(full, 'intasend-collections').health === 'unknown',
       'configured != connected');
    ok('and says why, rather than leaving it to be guessed',
       /not measured/i.test(byId(full, 'sendgrid').healthNote));
    /* THE TRIPWIRE, restated for RC-3. RC-1 could assert health was a literal
       constant. Since RC-3 this module carries a PROBE's health through, so the
       literal is gone — but the invariant it protected is unchanged and is what
       is actually asserted here: health comes from a probe or it is 'unknown',
       and it is never computed from credentialState. */
    const code = strip(STATUS_SRC);
    ok('health comes from a probe, or is unknown',
       /health:\s*probe \? probe\.health : 'unknown'/.test(code));
    ok('health is never derived from credential state',
       !/health:[^\n]*credentialState/.test(code));
  }

  /* ── 4. NO SECRET VALUE CAN REACH THE BROWSER ───────────────────────────── */
  head('4 - names and booleans only');
  {
    /* NOT A CREDENTIAL. AKIAIOSFODNN7EXAMPLE is AWS's own published documentation
       example and `sk_live_51H8xKfAkPlantedValue` is invented. They are deliberately
       credential-SHAPED because a control made of an innocuous string would prove
       nothing about a scanner looking for credential shapes. A secret scan will flag
       this line; it has been adjudicated and is expected. Do not "fix" it by making
       the values harmless — that silently voids the assertion below. */
    const PLANT = 'AKIAIOSFODNN7EXAMPLE';
    const poisoned = await resolveIntegrationStatus({
      listSecretNames: lister(ALL.concat([PLANT, 'sk_live_51H8xKfAkPlantedValue'])) });
    const blob = JSON.stringify(poisoned);

    ok('a credential-shaped value in the inventory does NOT reach the response',
       blob.indexOf(PLANT) === -1 && blob.indexOf('sk_live_51H8xKfAkPlantedValue') === -1);
    /* CONTROL — the check above is worthless unless it can see such a string. */
    ok('CONTROL — the same check DOES find a planted value when present',
       JSON.stringify({ x: PLANT }).indexOf(PLANT) > -1);

    ok('unclaimed secrets are counted, never named',
       poisoned.unclaimedSecretCount === 2 && !/AKIA/.test(blob),
       'count=' + poisoned.unclaimedSecretCount);

    const c = byId(full, 'intasend-collections').credentials[0];
    ok('a credential record is exactly {name, present}',
       Object.keys(c).sort().join(',') === 'name,present', Object.keys(c).join(','));
    ok('present is a boolean, not a length or a prefix', typeof c.present === 'boolean');
    ok('no field in any record holds a value-like string',
       !/"[A-Za-z0-9_\-]{28,}"/.test(blob.replace(/"[A-Z_]{4,}"/g, '""')));

    const code = strip(STATUS_SRC);
    ok('the module never calls the payload API',
       !/accessSecretVersion|:access\b/.test(code));
    ok('it lists, and only lists', /\/secrets\?pageSize=/.test(code));
    ok('it binds no secret to itself', !/secrets:\s*\[/.test(code));
    const adminSrc = strip(fs.readFileSync(path.join(ROOT, 'functions/admin-os.js'), 'utf8'));
    const handler = adminSrc.slice(adminSrc.indexOf('adminGetIntegrationStatus'));
    ok('the callable logs counts, never an inventory',
       /counts: result\.counts/.test(handler) && !/integrations: result\.integrations[^.]/.test(handler));
  }

  /* ── 5. MANAGEMENT TARGETS THE INTEGRATION ──────────────────────────────── */
  head('5 - capabilities name integrations, never credentials');
  {
    const i = byId(full, 'sendgrid');
    ok('a configured integration is manageable', i.capabilities.indexOf('view') > -1);
    ok('and offers a provider test once credentials exist',
       i.capabilities.indexOf('test') > -1, i.capabilities.join(','));
    ok('an unconfigured one offers no test',
       byId(none, 'sendgrid').capabilities.indexOf('test') === -1,
       byId(none, 'sendgrid').capabilities.join(','));
    ok('a quarantined integration offers no test',
       byId(full, 'pos-card-terminal').capabilities.indexOf('test') === -1);
    ok('no capability implies reading or rotating a credential',
       full.integrations.every(x => x.capabilities.every(
         c => ['view', 'test', 'view-credential-names'].indexOf(c) > -1)));
  }

  /* ── 6. ADMIN-GATED, AND DARAJA STAYS OUT ───────────────────────────────── */
  head('6 - reachability and scope');
  {
    process.env.GCLOUD_PROJECT = 'sokoni-aeb26';
    const adminOs = require(path.join(ROOT, 'functions/admin-os.js'));
    ok('the operation is dispatchable by adminOsDispatch',
       typeof (adminOs._h || {}).adminGetIntegrationStatus === 'function');
    const adminSrc = fs.readFileSync(path.join(ROOT, 'functions/admin-os.js'), 'utf8');
    const seg = adminSrc.slice(adminSrc.indexOf('exports.adminGetIntegrationStatus'));
    ok('it requires admin before doing anything', /_requireAdmin\(req\)/.test(seg.slice(0, 900)));
    ok('and enforces App Check', /enforceAppCheck: true/.test(seg.slice(0, 400)));

    ok('no Daraja record is produced',
       !full.integrations.some(i => /daraja/i.test(i.id + ' ' + (i.vendor || ''))));
    ok('no Daraja credential is reported missing',
       !JSON.stringify(full.integrations.map(i => i.credentials)).match(/DARAJA/i));
    ok('control — payments IS reported, via IntaSend',
       full.integrations.filter(i => i.category === 'payments').length === 5 &&
       full.integrations.some(i => i.vendor === 'IntaSend' && i.credentialState === 'configured'));
  }

  console.log('\n  counts on a fully-configured inventory: ' + JSON.stringify(full.counts));
  console.log('\n  what this suite does NOT prove');
  console.log('  SCOPE     configuration only. No provider was contacted and nothing was');
  console.log('            delivered. "configured" never means "working" — RC-3 measures that.');
  console.log('  UNPROVEN  the live Secret Manager call; the lister is injected here.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
