/* Pre-flight sabotage: plant a real defect, confirm the suite CATCHES it,
   restore. A suite that stays green under sabotage is inert and certifies
   nothing. Runs strictly sequentially and always restores, so a mutation is
   never left behind for the next run to adopt. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE = path.join(ROOT, 'tests/certify-integrations-console.js');

const MUTATIONS = [
  /* `_count()` feeds the TAB PILLS and nothing else — see its four call sites in
     _tabs(). The stat tiles do not go through it; each carries its own inline
     ternary, which is what A1 covers and what S2 mutates.

     So A1 CANNOT detect this mutation, and the old expectation `/A1|Registered/`
     was pointing at a case that does not own this code path. The run was still
     reported as caught, but only as "something failed" — the weaker signal the
     `~` marker exists to flag. A5 is the case that actually owns the pills, and
     it fires with exactly the right message: `pill is em dash when unreadable —
     got "0"`.

     Pinned to A5 deliberately rather than widened to /A1|A5/. A loose pattern
     would let an unrelated A1 failure stand in for this guard and report a
     green catch while the pill coverage had silently gone. */
  { name: 'S1 unknown rendered as 0 instead of em dash',
    file: 'sokoni-integrations.js',
    from: "function _count(ok, n) { return ok ? String(n) : EM; }",
    to:   "function _count(ok, n) { return ok ? String(n) : '0'; }",
    expect: /A5 .*pill is em dash when unreadable/ },

  { name: 'S2 stat tiles fabricate 0 when the source is unreadable',
    file: 'sokoni-integrations.js',
    from: "      cell('ok', 'Healthy', t ? String(t.healthy) : EM,",
    to:   "      cell('ok', 'Healthy', t ? String(t.healthy) : '0',",
    expect: /A1 Healthy|A2 Healthy/ },

  { name: 'S3 the webhook signing secret is rendered',
    file: 'sokoni-integrations.js',
    from: "'<td class=\"sic-mono\">' + _esc(w.sellerId || EM) + '</td>' +",
    to:   "'<td class=\"sic-mono\">' + _esc(w.sellerId || EM) + _esc(w.secret || '') + '</td>' +",
    expect: /B1/ },

  { name: 'S4 escaping removed from rendered field values',
    file: 'sokoni-integrations.js',
    from: "  function _esc(v) {\n    return String(v == null ? '' : v).replace(/[&<>\"']/g, function (c) {",
    to:   "  function _esc(v) {\n    return String(v == null ? '' : v).replace(/[\\u0000]/g, function (c) {",
    expect: /C1/ },

  { name: 'S5 a Daraja rail reappears in the catalogue',
    file: 'sokoni-integration-catalogue.js',
    from: "  /* ── Indexes ──",
    to:   "  INTEGRATIONS.push({ id:'daraja-stk', name:'Daraja STK', vendor:'Safaricom', category:'payments', icon:'x', status:'live', direction:'outbound', summary:'s', health:{source:null,note:'n'} });\n\n  /* ── Indexes ──",
    expect: /D1/ },

  { name: 'S6 a service with no heartbeat is reported as healthy',
    file: 'sokoni-integrations.js',
    from: "    if (!h)               return { key: 'unknown', label: 'No heartbeat', hb: 0, h: {} };",
    to:   "    if (!h)               return { key: 'healthy', label: 'Healthy', hb: 0, h: {} };",
    expect: /A3/ },

  { name: 'S7 the Super Admin sidebar entry is removed',
    file: 'super-admin.html',
    from: '<button class="nav-item" data-section="integrations"',
    to:   '<button class="nav-item" data-section="integrations-REMOVED"',
    expect: /E2/ },

  { name: 'S8 the console gains a write path',
    file: 'sokoni-integrations.js',
    from: "  function load() {",
    to:   "  function _danger(){ return _db().collection('x').doc('y').set({a:1}); }\n  function load() {",
    expect: /E4/ },

  /* ── The GCP control plane ────────────────────────────────────────────
     This panel shows infrastructure figures a browser cannot obtain, which
     makes it the likeliest place on this console for a fabricated number to
     look authoritative. The two mutations below are the two ways that happens:
     a MEASURED zero stops being distinguishable from an unmeasured one, and
     the sentence explaining the difference is dropped. */

  { name: 'S9 a measured zero is badged as if nothing measured it',
    file: 'sokoni-integrations.js',
    from: "    empty:            { cls: 'healthy', label: 'Measured zero' },",
    to:   "    empty:            { cls: 'unknown', label: 'Not measured' },",
    expect: /D11 a measured zero is badged as measured/ },

  { name: 'S10 the panel stops explaining that the zero was measured',
    file: 'sokoni-integrations.js',
    from: "        ? '<p class=\"sic-note\"><strong>This zero was measured.</strong> The server enumerated ' +",
    to:   "        ? '<p class=\"sic-note\"><strong>Zero.</strong> The server enumerated ' +",
    expect: /D11 and the panel says the zero was measured/ },

  /* The cockpit's central claim: a control plane that could not be read stays
     visibly dark, rather than reading as a healthy zero next to live neighbours. */
  { name: 'S12 a dead control plane renders as 0 instead of an em dash',
    file: 'sokoni-integrations.js',
    from: "    if (o.state === 'observed' || o.state === 'empty' || o.state === 'stale') {",
    to:   "    if (o.state === 'unreadable') return '0';\n    if (o.state === 'observed' || o.state === 'empty' || o.state === 'stale') {",
    expect: /D13 a dead domain shows an em dash, not a zero|D11 an unreadable figure shows an em dash/ },

  { name: 'S13 the cockpit stops warning that an instrument is out',
    file: 'sokoni-integrations.js',
    from: "        ? '<p class=\"sic-note\"><strong>Part of this cockpit is dark.</strong> A control plane that ' +",
    to:   "        ? '<p class=\"sic-note\"><strong>All systems nominal.</strong> A control plane that ' +",
    expect: /D13 and the header warns part of the cockpit is dark/ },

  /* ── The drill-down evidence tables ──────────────────────────────────
     A table of real-looking rows reads as authority, which makes it the least
     noticeable place to put a fabricated figure. */

  { name: 'S14 a truncated inventory stops disclosing that it is truncated',
    file: 'sokoni-integrations.js',
    from: "    var cap = obs.truncated",
    to:   "    var cap = false",
    expect: /D14b the cap is disclosed/ },

  { name: 'S15 an empty inventory is rendered as a failed read',
    file: 'sokoni-integrations.js',
    from: "      return '<p class=\"sic-note\"><strong>Measured zero.</strong> The read returned no rows. ' +",
    to:   "      return '<p class=\"sic-note\"><strong>Unreadable.</strong> The read returned no rows. ' +",
    expect: /D13|D14/ },

  { name: 'S16 a missing table value is rendered as 0 instead of an em dash',
    file: 'sokoni-integrations.js',
    from: "          return '<td class=\"sic-mono\">' + (v === null || v === undefined || v === ''\n            ? EM : _esc(String(v))) + '</td>';",
    to:   "          return '<td class=\"sic-mono\">' + (v === null || v === undefined || v === ''\n            ? '0' : _esc(String(v))) + '</td>';",
    expect: /D14 an absent max-instance limit is an em dash, not 0/ },

  { name: 'S17 the admins panel starts computing a risk score',
    file: 'sokoni-integrations.js',
    from: "        '<p class=\"sic-note\">Who can actually change this project, as the <strong>real IAM ' +",
    to:   "        '<p class=\"sic-note\">Risk score: LOW. Who can change this project, as the <strong>real IAM ' +",
    /* Pinned to the RENDER-WIDE check, not to the sentence. This mutation ADDS
       a score beside the refusal rather than removing the refusal, so the
       sentence-presence assertion stays true — which is exactly why asserting a
       refusal only by its own wording is not enough. */
    expect: /D14d and no score is rendered anywhere on the panel/ },

  { name: 'S18 audit logging stops saying what is NOT logged',
    file: 'sokoni-integrations.js',
    from: "        '<p class=\"sic-note\">A service <strong>absent from this table has Admin Activity logging ' +",
    to:   "        '<p class=\"sic-note\">A service <strong>not shown is fully covered ' +",
    expect: /D14e an absent service is stated to be Admin Activity only/ },

  /* ── Telemetry, cost, the graph ──────────────────────────────────────
     Each of these renders a number next to an em dash, which is precisely
     where the two can quietly become the same thing. */

  { name: 'S19 telemetry stops stating the window it measured over',
    file: 'sokoni-integrations.js',
    from: "        '<p class=\"sic-note\">Every figure below is a real metric series over the last ' +",
    to:   "        '<p class=\"sic-note\">Every figure below is a real metric series. ' +",
    expect: /D15 the window is stated in the panel/ },

  { name: 'S20 cost conditions are presented as verdicts',
    file: 'sokoni-integrations.js',
    from: "        '<p class=\"sic-note\">These are <strong>conditions, not verdicts</strong>. A pinned minimum ' +",
    to:   "        '<p class=\"sic-note\">These services are MISCONFIGURED. A pinned minimum ' +",
    expect: /D16 the panel says these are conditions, not verdicts/ },

  { name: 'S21 the unmeasured cost fields stop being distinguished from zero',
    file: 'sokoni-integrations.js',
    from: "        '<p class=\"sic-note\">The last two are <strong>not measured</strong>, not zero. A cost ' +",
    to:   "        '<p class=\"sic-note\">The last two are zero. A cost ' +",
    expect: /D16 and the panel says they are not measured, not zero/ },

  { name: 'S22 a service account with an unreadable inventory is reported as running nothing',
    file: 'sokoni-integrations.js',
    from: "            return r.usageKnown ? (r.unusedByWorkloads ? 'YES' : 'no') : '—'; }],",
    to:   "            return r.unusedByWorkloads ? 'YES' : 'no'; }],",
    expect: /D17 an unknown-usage row renders an em dash, never "no"/ },

  { name: 'S23 a dead graph node is dropped instead of dimmed',
    file: 'sokoni-integrations.js',
    from: "      return '<g class=\"sg-n' + (dead ? ' dead' : '') + '\"' +",
    to:   "      if (dead) return '';\n      return '<g class=\"sg-n' + (dead ? ' dead' : '') + '\"' +",
    expect: /D19 a dead node is marked dead rather than omitted/ },

  { name: 'S24 the activity panel stops saying Data Access is not read',
    file: 'sokoni-integrations.js',
    from: "      '<p class=\"sic-note\"><strong>Admin Activity only.</strong> Data Access entries can carry ' +",
    to:   "      '<p class=\"sic-note\"><strong>Full coverage.</strong> Entries can carry ' +",
    expect: /D20 the panel states Data Access entries are NOT read/ },

  /* The "no source contract" figure renders in TWO places — the drill panel and
     the Compute summary — so no single edit can hide it. That is a robustness
     property of the design, not a coverage gap, and a vector that removes one
     copy is therefore a BAD VECTOR rather than a missing guard. Retargeted at
     something single-sourced and genuinely dangerous: a parity column that
     always reads "ok" would hide a real source-vs-serving disagreement. */
  { name: 'S25 the parity column always reports ok, hiding a real disagreement',
    file: 'sokoni-integrations.js',
    from: "          ['max parity', function (r) { return r.maxParity ? 'ok' : 'DISAGREE'; }],",
    to:   "          ['max parity', function (r) { return 'ok'; }],",
    expect: /D21 and the row cell itself says DISAGREE/ },

  { name: 'S26 the contract panel stops saying silence is not parity',
    file: 'sokoni-integrations.js',
    from: "        '<p class=\"sic-note\"><strong>A function with no supplied contract is not \"in parity.\"</strong> ' +",
    to:   "        '<p class=\"sic-note\"><strong>All other functions are in parity.</strong> ' +",
    expect: /D21 and the panel says they are NOT in parity/ },

  { name: 'S27 Secret Manager stops saying why it shows names only',
    file: 'sokoni-integrations.js',
    from: "        'This reader calls <span class=\"sic-mono\">secrets.list</span>, which returns metadata and ' +",
    to:   "        'This reader shows names. ' +",
    expect: /D22 it states the API used cannot return a payload/ },

  { name: 'S28 the database explorer stops declaring what it did not read',
    file: 'sokoni-integrations.js',
    from: "        '<p class=\"sic-note\">Document counts, the deployed ruleset and recent query or index ' +",
    to:   "        '<p class=\"sic-note\">Everything below is fully measured. Query or index ' +",
    expect: /D23 document counts, ruleset and query failures are listed as not read/ },

  { name: 'S29 an unset scaling limit renders as 0 on the function card',
    file: 'sokoni-integrations.js',
    from: "        (f.minInstances === null || f.minInstances === undefined\n          ? EM + ' <em>unset</em>' : _esc(String(f.minInstances))) + '</strong></div>' +",
    to:   "        (f.minInstances === null || f.minInstances === undefined\n          ? '0' : _esc(String(f.minInstances))) + '</strong></div>' +",
    expect: /D24 an unset limit says unset, not 0|D24 and no limit is rendered as a bare 0/ },

  { name: 'S30 an unchecked contract item renders as a tick',
    file: 'sokoni-integrations.js',
    from: "    if (passed === null || passed === undefined) {",
    to:   "    if (false) {",
    expect: /D24 an unchecked contract shows no tick/ },

  { name: 'S31 an identity with UNKNOWN usage is reported as running nothing',
    file: 'sokoni-integrations.js',
    from: "      (a.usageKnown\n        ? ((usedByRun.length || usedByFn.length)",
    to:   "      (true\n        ? ((usedByRun.length || usedByFn.length)",
    expect: /D25 an identity whose usage is unknown says UNKNOWN, not nothing/ },

  { name: 'S32 the function card borrows the estate-wide peak as its own',
    file: 'sokoni-integrations.js',
    from: "      '<p class=\"sic-note\">A 30-day instance peak for THIS function needs a per-function metric ' +",
    to:   "      '<p class=\"sic-note\">A 30-day instance peak is shown estate-wide. A per-function metric ' +",
    expect: /D24 a per-function peak is not borrowed from the estate figure/ },

  { name: 'S33 a missing secret is counted but not named',
    file: 'sokoni-integrations.js',
    from: "        _invTable((sec.secretCoverage || {}).missingNames, [\n          ['Missing secret', function (r) { return r.secret; }],\n        ]) +",
    to:   "",
    expect: /D22 and NAMED, not just counted/ },

  { name: 'S34 an unmatched secret is presented as a fault',
    file: 'sokoni-integrations.js',
    from: "        '<p class=\"sic-note\">An unmatched secret is <strong>not a fault</strong> and not something ' +",
    to:   "        '<p class=\"sic-note\">An unmatched secret is an ORPHAN and should be removed, not something ' +",
    expect: /D22 and explicitly called not a fault/ },

  { name: 'S11 an absent GCP reader is rendered as an empty estate',
    file: 'sokoni-integrations.js',
    from: "        '<p class=\"sic-note\"><strong>No infrastructure figure is shown, because none was ' +",
    to:   "        '<p class=\"sic-note\"><strong>All infrastructure nominal. ' +",
    expect: /D12 it states that no figure was obtained/ },
];

function runSuite() {
  try {
    execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

let inert = 0, caught = 0;
console.log('\nPRE-FLIGHT SABOTAGE \u2014 each mutation must be CAUGHT\n' + '='.repeat(60));

for (const m of MUTATIONS) {
  const p = path.join(ROOT, m.file);
  const original = fs.readFileSync(p, 'utf8');
  if (original.indexOf(m.from) === -1) {
    console.log('  ? ' + m.name + '  \u2014 ANCHOR NOT FOUND (mutation could not be planted)');
    inert++;
    continue;
  }
  fs.writeFileSync(p, original.replace(m.from, m.to), 'utf8');
  let r;
  try { r = runSuite(); } finally { fs.writeFileSync(p, original, 'utf8'); }

  if (r.code === 0) {
    console.log('  \u2717 ' + m.name + '  \u2014 SUITE STAYED GREEN (assertion is INERT)');
    inert++;
  } else if (m.expect.test(r.out)) {
    console.log('  \u2713 ' + m.name + '  \u2014 caught by the expected case');
    caught++;
  } else {
    console.log('  ~ ' + m.name + '  \u2014 suite failed, but NOT on the expected case');
    console.log('      ' + (r.out.split('\u2717')[1] || '').trim().slice(0, 120));
    caught++;
  }
}

console.log('='.repeat(60));
console.log('  caught: ' + caught + '   inert: ' + inert);

/* Restoration proof: the suite must be green again after every mutation is
   reverted. Otherwise a mutation was stranded. */
const after = runSuite();
console.log('  post-restore suite: ' + (after.code === 0 ? 'GREEN (nothing stranded)' : 'RED \u2014 A MUTATION WAS STRANDED'));
process.exit(inert === 0 && after.code === 0 ? 0 : 1);
