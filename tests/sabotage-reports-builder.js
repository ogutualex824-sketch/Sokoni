/* Pre-flight sabotage for the Reports Builder certification.

   Plants a real defect, confirms the suite CATCHES it, restores. A suite that
   stays green under sabotage is inert and certifies nothing.

   The mutations are chosen to be the defects that actually matter here: plotting
   null as zero, hiding a real zero, inventing a baseline, confusing an outage
   with an empty range, and reporting a failed save as a success.

   Runs strictly sequentially and always restores in a `finally`, so a mutation
   is never stranded for the next run to adopt.

   RUN
     node tests/sabotage-reports-builder.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.resolve(__dirname, '..');
const SUITE = path.join(ROOT, 'tests/certify-reports-builder.js');

const MUTATIONS = [
  { name: 'S1 an unmeasured value is coerced to zero',
    file: 'sokoni-reports-builder.js',
    from: "  function _num(v) {\n    return (typeof v === 'number' && isFinite(v)) ? v : null;\n  }",
    to:   "  function _num(v) {\n    return (typeof v === 'number' && isFinite(v)) ? v : 0;\n  }",
    expect: /A2|A4b|A1/ },

  { name: 'S2 a null point joins the line instead of breaking it',
    file: 'sokoni-reports-builder.js',
    from: "      if (p.value == null) { if (cur.length) { runs.push(cur); cur = []; } return; }",
    to:   "      if (p.value == null) { cur.push({ x: x(i), y: y(0), p: p }); return; }",
    expect: /A1/ },

  { name: 'S3 a genuine measured zero is hidden as an em dash',
    file: 'sokoni-reports-builder.js',
    from: "  function _fmt(v, unit) {\n    if (v == null) return EM;",
    to:   "  function _fmt(v, unit) {\n    if (v == null || v === 0) return EM;",
    expect: /A3/ },

  { name: 'S4 a missing baseline is reported as a 0% change',
    file: 'sokoni-reports-builder.js',
    from: "    if (!cur.length || !prev.length) return null;",
    to:   "    if (!cur.length || !prev.length) return 0;",
    expect: /B1/ },

  { name: 'S5 an absent day is materialised as a zero row',
    file: 'sokoni-reports-builder.js',
    from: "          if (!snap.exists) return null;",
    to:   "          if (!snap.exists) return { id: d.id, _offset: d.offset, orders24h: 0 };",
    expect: /A4b|C2/ },

  { name: 'S6 a total read outage is reported as an empty range',
    file: 'sokoni-reports-builder.js',
    from: "      if (errs.length === results.length && results.length) {",
    to:   "      if (false) {",
    expect: /C1/ },

  { name: 'S7 a refused draft save reports success anyway',
    file: 'sokoni-reports-builder.js',
    /* Anchored on the CALL, not on the message: the message contains an em dash
       that the editor wrote as a real character, so an escape-sequence anchor
       silently misses and the mutation reads as "could not be planted". */
    from: "_flash(_writeDraft()",
    to:   "_flash(true || _writeDraft()",
    expect: /E3/ },

  { name: 'S8 the Publish button is enabled without a store behind it',
    file: 'sokoni-reports-builder.js',
    from: "'<button class=\"rb-btn\" disabled title=",
    to:   "'<button class=\"rb-btn\" title=",
    expect: /E2/ },

  { name: 'S9 a module with no canonical source is offered',
    file: 'sokoni-reports-builder.js',
    from: "  var MODULE_BY_TYPE = {};",
    to:   "  MODULES.push({ type: 'map', label: 'Map', icon: 'm', desc: 'x' });\n  var MODULE_BY_TYPE = {};",
    expect: /D3/ },

  { name: 'S10 a template references a metric nothing writes',
    file: 'sokoni-reports-builder.js',
    /* The previous form inserted `LABEL: { }`, which is a labelled block —
       valid JS that changes nothing. It read as an inert assertion when in fact
       the MUTATION was inert. Point a real template at a metric nothing writes. */
    from: "{ type: 'line',  metric: 'orders24h', span: 2 },",
    to:   "{ type: 'line',  metric: 'ghostMetric', span: 2 },",
    expect: /D2/ },

  { name: 'S11 the AdminOS sidebar entry is removed',
    file: 'admin-os.html',
    from: '<button class="nav-item" data-section="reports"',
    to:   '<button class="nav-item" data-section="reports-REMOVED"',
    expect: /F1/ },

  { name: 'S12 the builder gains a Firestore write path',
    file: 'sokoni-reports-builder.js',
    from: "  function load() {",
    to:   "  function _bad(){ return _db().collection('x').doc('y').set({a:1}); }\n  function load() {",
    expect: /E1/ },
];

function runSuite() {
  try {
    execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

let inert = 0, caught = 0, skipped = 0;
console.log('\nPRE-FLIGHT SABOTAGE — REPORTS BUILDER\n' + '='.repeat(64));

for (const m of MUTATIONS) {
  const p = path.join(ROOT, m.file);
  const original = fs.readFileSync(p, 'utf8');

  if (original.indexOf(m.from) === -1) {
    if (m.skipIfAnchorMissing) { console.log('  - ' + m.name + '  — skipped (anchor absent)'); skipped++; continue; }
    console.log('  ? ' + m.name + '  — ANCHOR NOT FOUND (could not be planted)');
    inert++;
    continue;
  }

  fs.writeFileSync(p, original.replace(m.from, m.to), 'utf8');
  let r;
  try { r = runSuite(); } finally { fs.writeFileSync(p, original, 'utf8'); }

  if (r.code === 0) {
    console.log('  ✗ ' + m.name + '  — SUITE STAYED GREEN (assertion is INERT)');
    inert++;
  } else if (m.expect.test(r.out)) {
    console.log('  ✓ ' + m.name + '  — caught by the expected case');
    caught++;
  } else {
    console.log('  ~ ' + m.name + '  — failed, but NOT on the expected case');
    console.log('      ' + (r.out.split('✗')[1] || '').trim().slice(0, 110));
    caught++;
  }
}

console.log('='.repeat(64));
console.log('  caught: ' + caught + '   inert: ' + inert + '   skipped: ' + skipped);

const after = runSuite();
console.log('  post-restore suite: ' +
  (after.code === 0 ? 'GREEN (nothing stranded)' : 'RED — A MUTATION WAS STRANDED'));
process.exit(inert === 0 && after.code === 0 ? 0 : 1);
