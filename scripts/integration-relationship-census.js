/* ══════════════════════════════════════════════════════════════════════════════
   INTEGRATION RELATIONSHIP CENSUS                    scripts/integration-relationship-census.js

   WHAT THIS IS
   ------------
   The Step 1 gate. Before the Integrations Control Center is committed as a
   chunk, every catalogue entry must have a KNOWN relationship to each layer
   beneath it — or an EXPLICIT statement that the relationship does not exist.

     catalogue entry
         -> registry membership
         -> AdminOS reachability (route / detail target)
         -> probe definition
         -> probe executor
         -> backend authority
         -> Firestore collections
         -> external endpoint / provider
         -> evidence source
         -> status projection
         -> missing capability

   WHY IT IS A GATE AND NOT A REPORT
   ---------------------------------
   The failure this exists to prevent is a polished console asserting a route, a
   probe, a database or a provider relationship that was never established. A
   report can be skimmed; a gate cannot. Any entry this cannot fully answer is a
   FAILURE and the process exits non-zero.

   DERIVED, NEVER TRANSCRIBED
   --------------------------
   Every column is computed from the modules themselves. A hand-maintained
   census is a transcription surface that silently rots the moment an entry is
   added — which is exactly how the obsolete "23 of 35" probe figure survived
   past the catalogue growing to 47.

   REACHABILITY IS PROVEN BY RENDERING
   -----------------------------------
   AdminOS has no router: `SokoniAOS.navigate()` shows and hides panels, and the
   only URL handling is a boot-only hash deep link validated by /^[a-z]+$/.
   So an integration's "route" is `admin-os.html#integrations` plus an in-panel
   detail target. This census does not ASSERT that each entry is reachable — it
   mounts the real console, renders the catalogue tab, and collects the detail
   targets the rendered markup actually offers. An entry the grid does not emit
   is unreachable, and that is a finding.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const ARGS  = process.argv.slice(2);
const JSON_OUT = ARGS.indexOf('--json') !== -1;

/* ── Sources of truth ─────────────────────────────────────────────────────── */
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));
/* Governance is a SEPARATE authority from the catalogue: the catalogue is
   repository evidence, this is an organizational decision. Loaded here so the
   census can require every entry to resolve to a named owner and authority. */
const governance = require(path.join(ROOT, 'sokoni-integration-governance.js'));
const probes   = require(path.join(ROOT, 'functions/integration-probes.js'));
const execs    = require(path.join(ROOT, 'functions/integration-probe-executors.js'));
const { resolveIntegrationStatus } = require(path.join(ROOT, 'functions/integration-status.js'));

/* ── Findings ─────────────────────────────────────────────────────────────── */
const FAIL = [];
const WARN = [];
const fail = (m) => FAIL.push(m);
const warn = (m) => WARN.push(m);

/* ══ 1. Mount the real console and collect the detail targets it renders ═════
   A minimal DOM, deliberately not a browser: if the module reaches for
   something this does not provide, it throws and the census fails, which is the
   correct outcome for a path nothing has exercised. */
function renderCatalogue () {
  const byId = {};
  const head = { children: [], appendChild (el) { this.children.push(el); if (el.id) byId[el.id] = el; } };
  const doc  = {
    head,
    getElementById: (id) => byId[id] || null,
    createElement:  () => ({ id: '', textContent: '' }),
  };
  const sandbox = {
    window: {}, document: doc, console, setTimeout, URL, Date, Math, Object, JSON,
    /* No Firestore and no Functions. Every read fails, which is FINE: this
       census is about STRUCTURE, and a failed read must still render a card.
       If a read failure hid the grid, that would itself be the finding. */
    firebase: undefined,
  };
  sandbox.window.document = doc;
  vm.createContext(sandbox);
  for (const f of ['sokoni-integration-catalogue.js', 'sokoni-integrations.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  const el = { id: 'root', innerHTML: '' };
  byId.root = el;
  const api = sandbox.window.SokoniIntegrations;
  api.mount(el);
  return new Promise((r) => setTimeout(r, 0))
    .then(() => new Promise((r) => setTimeout(r, 0)))
    .then(() => {
      api.tab('catalogue');
      return {
        html: el.innerHTML,
        cat:  sandbox.window.SokoniIntegrationCatalogue,
      };
    });
}

/* ── The projection the console shows. A DERIVATION, not a stored state. ────
   It reads existing fields only and introduces no vocabulary of its own. */
function projectStatus (entry, hasProbe, hasExecutor) {
  const s = entry.status;
  if (s === 'quarantined' || s === 'retired') return 'DISABLED';
  if (s === 'frozen')                         return 'GATED';
  if (s === 'configured' || s === 'sandbox')  return 'CONFIGURED';
  /* live / inbound-only. Whether it reads as LIVE or merely ACTIVE depends on
     whether any live evidence path exists at all. */
  if (entry.health && entry.health.source) return 'LIVE (overlay)';
  if (hasExecutor)                         return 'LIVE (probeable)';
  if (hasProbe)                            return 'ACTIVE (stages declared)';
  return 'ACTIVE (no live evidence)';
}

(async function main () {
  const { html, cat } = await renderCatalogue();

  /* Detail targets the rendered grid ACTUALLY offers. */
  const reachable = new Set(
    [...html.matchAll(/selectCatalogue\('([^']+)'\)/g)].map((m) => m[1])
  );

  const regById = {};
  registry.INTEGRATIONS.forEach((e) => { regById[e.id] = e; });

  /* Backend authority: one record per integration, from the real resolver. */
  let statusById = {};
  let statusOk = true;
  try {
    const res = await resolveIntegrationStatus({ listSecretNames: async () => [] });
    (res.integrations || []).forEach((i) => { statusById[i.id] = i; });
  } catch (e) {
    statusOk = false;
    fail('the backend status resolver threw, so backend authority cannot be established: ' + e.message);
  }

  const rows = [];

  cat.integrations.forEach((e) => {
    const id  = e.id;
    const ev  = e.evidence || {};
    const reg = regById[id];
    const sup = probes.supportFor(id);
    const ex  = execs.executorFor(id);
    const st  = statusById[id];

    const row = {
      id,
      catalogue:    true,
      category:     e.category,
      lifecycle:    e.status,
      registry:     !!reg,
      reachable:    reachable.has(id),
      probeDef:     sup.hasProbe ? 'yes' : 'none',
      probeStages:  sup.hasProbe
        ? ['connected', 'accepted', 'delivered', 'received'].filter((k) => sup[k]).join('+') || 'none'
        : '—',
      executor:     ex ? 'yes' : 'none',
      executorNote: execs.REFUSES_BY_DESIGN[id] || '',
      backend:      st ? 'yes' : 'none',
      collections:  (ev.collections || []).join(' ') || 'none',
      endpoints:    (ev.endpoints || []).join(' ') || 'none',
      provider:     e.vendor,
      evidenceSrc:  (e.health && e.health.source) ? e.health.source
                    : (e.health && e.health.kind === 'elsewhere') ? 'elsewhere: ' + ((e.health.kindNote || '').slice(0, 40))
                    : (e.health && e.health.kind === 'not-applicable') ? 'n/a by nature'
                    : 'none',
      database:     e.database ? e.database.id : '—',
      projection:   projectStatus(e, sup.hasProbe, !!ex),
      missing:      [],
    };

    /* ── GOVERNANCE ──────────────────────────────────────────────────────
       Who is accountable, and who may approve a change. Resolved through the
       counterparty, so 47 entries inherit from 22 decisions rather than
       carrying 47 chances to drift. */
    const gov = governance.governanceFor(e, cat) || {};
    row.owner       = gov.owner || governance.UNASSIGNED;
    row.authority   = gov.authority || governance.UNASSIGNED;
    row.govInherited = gov.inherited !== false;

    const closedLifecycle = ['quarantined', 'frozen', 'retired'].indexOf(e.status) !== -1;

    if (!gov.owner || row.owner === governance.UNASSIGNED) {
      fail(id + ': no OWNER. Ownership is a governance decision and cannot be ' +
           'inferred — assign it in sokoni-integration-governance.js');
    }
    if (!gov.authority || row.authority === governance.UNASSIGNED) {
      fail(id + ': no AUTHORITY. Someone must be able to approve a change to this rail');
    }
    /* `NONE — RAIL CLOSED` is a DECIDED outcome, not a placeholder — but only
       for owner, and only where the rail really is closed. */
    if (row.owner === governance.RAIL_CLOSED && !closedLifecycle) {
      fail(id + ': owner is "' + governance.RAIL_CLOSED + '" but its lifecycle is "' +
           e.status + '". That value is only valid on a closed rail; an operating ' +
           'rail with nobody accountable is a gap, not a decision');
    }
    /* Closed is a lifecycle state, not an ownership exemption. */
    if (row.authority === governance.RAIL_CLOSED) {
      fail(id + ': authority is "' + governance.RAIL_CLOSED + '". A closed rail still ' +
           'needs someone who may decide to reopen it');
    }

    /* ── Required-field gate. Each must be answerable or explicitly none. ── */
    if (!reg) fail(id + ': in the catalogue but NOT in the server registry');
    if (!row.reachable) fail(id + ': the rendered catalogue offers no detail target — unreachable in AdminOS');
    if (statusOk && !st) fail(id + ': the backend resolver returns no record, so it has no backend authority');
    if (!e.health || !('source' in e.health)) fail(id + ': declares no health position');
    if (!e.vendor) fail(id + ': no provider named');

    /* ── Explicit missing capability ─────────────────────────────────────── */
    const probeable = probes.NON_PROBEABLE_LIFECYCLES.indexOf(e.status) === -1;
    if (probeable && !sup.hasProbe)      row.missing.push('no probe definition');
    if (probeable && sup.hasProbe && !ex) row.missing.push('probe defined, NO executor');
    if (probeable && ex && execs.REFUSES_BY_DESIGN[id]) {
      row.missing.push('executor refuses: ' + execs.REFUSES_BY_DESIGN[id]);
    }
    if (!(e.health && e.health.source) && probeable && !ex) row.missing.push('no live evidence path');
    if (e.database && !e.database.probe) row.missing.push('database declared without a probe collection');
    if (!row.missing.length) row.missing.push('—');

    rows.push(row);
  });

  /* ── Reverse direction: nothing may exist below without a catalogue entry ── */
  const catIds = new Set(cat.integrations.map((i) => i.id));
  registry.INTEGRATIONS.forEach((e) => {
    if (!catIds.has(e.id)) fail(e.id + ': in the server registry but NOT in the catalogue');
  });
  Object.keys(execs.EXECUTORS || {}).forEach((id) => {
    if (!catIds.has(id)) fail(id + ': has a probe EXECUTOR but no catalogue entry');
  });
  reachable.forEach((id) => {
    if (!catIds.has(id)) fail(id + ': rendered as a detail target but is not a catalogue entry');
  });

  /* ── GOVERNANCE, in both directions ──────────────────────────────────
     A counterparty with no decision is an unowned relationship. A decision for
     a counterparty nobody integrates with is a stale row that will quietly
     outlive the thing it governed. Neither list may drift past the other. */
  const counterparties = new Set(cat.integrations.map((i) => i.vendor));
  counterparties.forEach((v) => {
    if (!governance.counterparties[v]) {
      fail('counterparty "' + v + '" has no governance row — it is an unowned relationship');
    }
  });
  Object.keys(governance.counterparties).forEach((v) => {
    if (!counterparties.has(v)) {
      fail('governance row "' + v + '" matches no catalogue counterparty — a stale decision');
    }
  });
  /* An override is an EXCEPTION and must justify itself. */
  Object.keys(governance.overrides || {}).forEach((id) => {
    const o = governance.overrides[id];
    if (!catIds.has(id)) fail('override "' + id + '" is not a catalogue entry');
    if (!o.why) fail('override "' + id + '" states no reason — an exception must say why');
    if (!o.owner || !o.authority) fail('override "' + id + '" is missing owner or authority');
  });

  /* ── POSITIVE CONTROLS ────────────────────────────────────────────────────
     Every cross-check above is an ABSENCE check, and an absence check on an
     empty collection passes vacuously. These prove each source was actually
     loaded and non-trivial before any "nothing is missing" is believed. */
  if (cat.integrations.length < 40)        fail('control: the catalogue looks too small to be the real one');
  if (registry.INTEGRATIONS.length < 40)   fail('control: the registry looks too small to be the real one');
  if (reachable.size < 40)                 fail('control: too few detail targets rendered — the grid may not have rendered');
  if (Object.keys(execs.EXECUTORS).length < 5) fail('control: executors did not load');
  if (!/sic-ic/.test(html))                fail('control: the rendered markup contains no integration card');

  /* ── Output ───────────────────────────────────────────────────────────── */
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(),
      total: rows.length, rows, failures: FAIL, warnings: WARN }, null, 2) + '\n');
  } else {
    console.log('══════════════════════════════════════════════════════════════════');
    console.log('  INTEGRATION RELATIONSHIP CENSUS — Step 1 gate');
    console.log('══════════════════════════════════════════════════════════════════');
    console.log('  catalogue entries : ' + rows.length);
    console.log('  registry entries  : ' + registry.INTEGRATIONS.length);
    console.log('  reachable in UI   : ' + reachable.size);
    console.log('  probe executors   : ' + Object.keys(execs.EXECUTORS).length);
    console.log('');

    const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n).slice(0, n);
    console.log('  ' + pad('ID', 24) + pad('REG', 4) + pad('UI', 4) + pad('PROBE', 7) +
                pad('EXEC', 6) + pad('BE', 4) + pad('DB', 12) + pad('EVIDENCE', 22) + 'MISSING');
    console.log('  ' + '-'.repeat(118));
    rows.forEach((r) => {
      console.log('  ' + pad(r.id, 24) + pad(r.registry ? 'y' : 'NO', 4) +
        pad(r.reachable ? 'y' : 'NO', 4) + pad(r.probeDef === 'yes' ? 'yes' : '—', 7) +
        pad(r.executor === 'yes' ? 'yes' : '—', 6) + pad(r.backend === 'yes' ? 'y' : 'NO', 4) +
        pad(r.database, 12) + pad(r.evidenceSrc, 22) + r.missing.join('; '));
    });

    /* ── The real probe gap, derived ─────────────────────────────────────── */
    const probeable   = rows.filter((r) => probes.NON_PROBEABLE_LIFECYCLES.indexOf(r.lifecycle) === -1);
    const withExec    = probeable.filter((r) => r.executor === 'yes');
    const refusing    = withExec.filter((r) => r.executorNote);
    const runnable    = withExec.filter((r) => !r.executorNote);
    console.log('');
    console.log('  ── PROBE GAP, derived (this supersedes any "23 of 35" figure) ──');
    console.log('  probeable lifecycles      : ' + probeable.length + ' of ' + rows.length);
    console.log('  with an executor          : ' + withExec.length);
    console.log('    of which refuse by design: ' + refusing.length +
                '  (no safe probe, or needs a secret binding)');
    console.log('    actually runnable now    : ' + runnable.length +
                '  [' + runnable.map((r) => r.id).join(', ') + ']');
    console.log('  NO executor at all         : ' + (probeable.length - withExec.length));
    console.log('');
    console.log('  Non-probeable by lifecycle : ' +
                rows.filter((r) => probes.NON_PROBEABLE_LIFECYCLES.indexOf(r.lifecycle) !== -1)
                    .map((r) => r.id + '(' + r.lifecycle + ')').join(', '));

    /* ── Governance, summarised ──────────────────────────────────────── */
    const byOwner = {};
    rows.forEach((r) => { byOwner[r.owner] = (byOwner[r.owner] || 0) + 1; });
    console.log('');
    console.log('  ── GOVERNANCE (organizational decisions, NOT repository facts) ──');
    console.log('  counterparty decisions : ' + Object.keys(governance.counterparties).length);
    console.log('  entry overrides        : ' + Object.keys(governance.overrides || {}).length +
                '   (an override is an exception and must say why)');
    console.log('  entries inheriting     : ' + rows.filter((r) => r.govInherited).length +
                ' of ' + rows.length);
    console.log('');
    Object.keys(byOwner).sort().forEach((o) => {
      console.log('  ' + String(byOwner[o]).padStart(2) + '  owner: ' + o);
    });
    console.log('');
    console.log('  ' + governance.provenance);

    console.log('');
    if (WARN.length) { console.log('  WARNINGS'); WARN.forEach((w) => console.log('   ! ' + w)); console.log(''); }
    console.log('══════════════════════════════════════════════════════════════════');
    if (FAIL.length) {
      console.log('  CENSUS FAILED — ' + FAIL.length + ' unestablished relationship(s)');
      FAIL.forEach((f) => console.log('   ✗ ' + f));
    } else {
      console.log('  CENSUS PASSED — every entry has an established relationship');
      console.log('  at every layer, or an explicit statement that it has none.');
    }
    console.log('══════════════════════════════════════════════════════════════════');
  }

  process.exit(FAIL.length ? 1 : 0);
})().catch((e) => {
  /* A THROW IS A FAILURE, never a silent pass. */
  console.error('CENSUS CRASHED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
