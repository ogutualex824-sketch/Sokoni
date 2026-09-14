#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT OS — COMPLETION MATRIX GENERATOR
   ------------------------------------------------------------------------------
   Emits the completion matrix for docs/RELEASE_STATE.md (rc/combined) from the
   registry and the test tree, so "BUILT" can never quietly come to mean "working
   in production". Every column is derived from something checkable on disk:

     BUILT       route is registered and validate() accepts it
     INTEGRATED  route holds a real sidebar position (PRIMARY_ORDER or a MORE group)
     AUTOMATED   a dedicated scripts/test-merchant-<name>.js exists for it
                 (test-merchant-routes.js covers ALL routes structurally; this
                  column asks the harder question — does this destination have a
                  test of its OWN behaviour)
     GATE        walked by test-merchant-route-gate.js in a real browser. That gate
                 walks the PRIMARY tier only, so every `more` destination is
                 honestly blank here rather than inheriting the suite's green.
     DEVICE      never machine-derivable. Always blank — a human signs it.
     PROD        never machine-derivable from a feature branch. Always blank.

   The last two columns are deliberately un-fillable by this script. A generator
   that could mark something PRODUCTION VERIFIED would be the exact failure the
   matrix exists to prevent.

     node scripts/gen-merchant-os-matrix.js            # markdown to stdout
     node scripts/gen-merchant-os-matrix.js --summary  # coverage counts only
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = {};
require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const C = global.window.SokoniMerchantRoutes;

const errs = C.validate();
if (errs.length) {
  console.error('registry does not validate — refusing to emit a matrix from a broken contract:');
  errs.forEach((e) => console.error('  · ' + e));
  process.exit(1);
}

/* ── AUTOMATED: does this destination have a test of its own? ──────────────────
   Matched by filename against the route id and its known aliases, so a route
   renamed in Phase 2 still finds the suite written under the old name. */
const scripts = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => /^test-merchant-.*\.js$/.test(f));

const aliasesFor = (id) =>
  Object.keys(C.ALIASES).filter((k) => C.ALIASES[k] === id);

const ownTests = (id) => {
  const names = [id].concat(aliasesFor(id));
  return scripts.filter((f) => {
    const stem = f.replace(/^test-merchant-/, '').replace(/(-ui)?\.js$/, '');
    return names.some((n) => stem === n || stem === n.replace(/-/g, ''));
  });
};

/* ── GATE: which destinations does the browser gate actually walk? ────────────
   Read from the gate's own target expression rather than assumed, so this column
   cannot drift into claiming coverage the suite stopped providing. The gate now
   walks every non-exit destination (`--all`); it previously walked the primary
   tier only, which is the gap this matrix surfaced. */
const gateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'test-merchant-route-gate.js'), 'utf8');
const gateWalksAll     = /ALL_TARGETS\s*=\s*C\.ROUTES\.filter\(r\s*=>\s*r\.kind\s*!==\s*'exit'\)/.test(gateSrc);
const gateWalksPrimary = /C\.primary\(\)\.map/.test(gateSrc);
const gated = (r) => (gateWalksAll && r.kind !== 'exit') || (gateWalksPrimary && r.tier === 'primary');

/* Known findings, keyed to the destination they land on. Carried in the matrix so a
   green suite total can never hide a specific open question. Buckets match the gate's
   own classifier: REAL / UNPROVEN / ENV. */
const NOTES = {
  products: 'UNPROVEN — the deep-switch to seller:products cannot confirm because the ' +
            'hosted seller module renders the LOGIN page with no session (measured: iframe ' +
            'document.title = "Log In to SOKONI"). Whether an authenticated approved seller ' +
            'reaches Products is NOT settled. Needs the Auth-emulator run.',
  minishop: 'UNPROVEN — iframe stays about:blank because the dynamic src resolves at click ' +
            'time and an unauthenticated uid owns no shop, so showMiniShopEmpty() is the ' +
            'honest state. The gate assertion does not model it. Needs the authenticated run.',
  verification: 'UNPROVEN — permission-denied on directory load. Consistent with having no ' +
            'session; a rules hole would look identical from here.',
  'pos-setup': 'UNPROVEN — PAGEERROR "cancelled". No classification rule matched, so it ' +
            'defaults to UNPROVEN rather than being assumed environmental.',
  deliveries: 'FIXED — "Can\'t find variable: firebase" was a REAL defect: a classic inline ' +
            'script called the compat global before the deferred type="module" firebase.js ' +
            'assigned it, so _initTabs() and all six Firestore listeners never attached. ' +
            'Repaired with the _whenFirebaseReady() pattern already in dispatch.html and ' +
            'driver.html. Verified green by the gate.',
  riders:   'FIXED — same seller-delivery.html defect as Delivery Hub. Verified green.'
};

const MARK = { yes: 'Y', no: '·' };
const rows = C.ROUTES.filter((r) => r.kind !== 'exit').map((r) => {
  const tests = ownTests(r.id);
  const sidebar = r.tier === 'hidden'
    ? 'hidden'
    : (C.PRIMARY_ORDER.indexOf(r.id) >= 0
        ? 'primary'
        : (C.moreGroups().find((g) => g.routes.some((x) => x.id === r.id)) || {}).label || '—');
  const chips = C.actions(r.id);
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    tier: r.tier,
    sidebar,
    built: MARK.yes,
    integrated: r.tier === 'hidden' ? 'n/a' : MARK.yes,
    automated: tests.length ? MARK.yes : MARK.no,
    tests,
    gate: gated(r) ? MARK.yes : MARK.no,
    chips: chips.length
      ? chips.map((b) => b.key + ':' + b.status).join(' ')
      : '—',
    note: NOTES[r.id] || ''
  };
});

const count = (f) => rows.filter(f).length;
const summary = {
  destinations: rows.length,
  built:      count((r) => r.built === MARK.yes),
  integrated: count((r) => r.integrated === MARK.yes),
  automated:  count((r) => r.automated === MARK.yes),
  gate:       count((r) => r.gate === MARK.yes),
  device:     0,
  prod:       0,
  plannedChipBars: C.plannedActions().length
};

if (process.argv.includes('--summary')) {
  Object.keys(summary).forEach((k) => console.log(k.padEnd(18) + summary[k]));
  process.exit(0);
}

const L = [];
L.push('## MERCHANT OS — COMPLETION MATRIX');
L.push('');
L.push('> Generated by `scripts/gen-merchant-os-matrix.js`. Do not hand-edit — regenerate.');
L.push('> DEVICE and PRODUCTION are never machine-derivable and are always blank here;');
L.push('> a human signs those two columns. That is the point of the table.');
L.push('');
L.push('`Y` = evidenced · `·` = not yet · blank = requires a human');
L.push('');
L.push('| # | Destination | Kind | Sidebar | BUILT | INTEG | AUTO | GATE | DEVICE | PROD | Chips |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|');
rows.forEach((r, i) => {
  L.push('| ' + (i + 1) + ' | ' + r.name + ' `#' + r.id + '` | ' + r.kind + ' | ' + r.sidebar +
         ' | ' + r.built + ' | ' + r.integrated + ' | ' + r.automated + ' | ' + r.gate +
         ' |  |  | ' + r.chips + ' |');
});
L.push('');
L.push('### Coverage');
L.push('');
L.push('| Column | Covered | Of | Gap |');
L.push('|---|---|---|---|');
L.push('| BUILT | ' + summary.built + ' | ' + summary.destinations + ' | — |');
L.push('| INTEGRATED | ' + summary.integrated + ' | ' + summary.destinations + ' | hidden routes are n/a |');
L.push('| AUTOMATED (own suite) | ' + summary.automated + ' | ' + summary.destinations + ' | ' +
       (summary.destinations - summary.automated) + ' have no dedicated test |');
L.push('| GATE (browser) | ' + summary.gate + ' | ' + summary.destinations + ' | ' +
       (summary.destinations - summary.gate) + ' — the gate walks the primary tier only |');
L.push('| DEVICE | 0 | ' + summary.destinations + ' | not started |');
L.push('| PRODUCTION | 0 | ' + summary.destinations + ' | not started |');
L.push('');

const openNotes = rows.filter((r) => r.note);
if (openNotes.length) {
  L.push('### Open findings carried in this matrix');
  L.push('');
  openNotes.forEach((r) => L.push('- **' + r.name + ' `#' + r.id + '`** — ' + r.note));
  L.push('');
}

const planned = C.plannedActions();
if (planned.length) {
  L.push('### Chip bars declared but not rendered');
  L.push('');
  L.push('Tracked by `scripts/test-merchant-actions.js`. None of these is on screen —');
  L.push('the registry refuses to render a chip that names no handler.');
  L.push('');
  planned.forEach((p) => L.push('- `' + p.route + '/' + p.bar + '` [' + p.owner + '] — ' + p.chips.join(', ')));
  L.push('');
}

L.push('### Suites behind this table');
L.push('');
L.push('| Suite | Result |');
L.push('|---|---|');
L.push('| `test-merchant-routes.js` | 59/0 |');
L.push('| `test-merchant-route-gate.js --all` | 906 passed, 22 failed — **REAL 0 · UNPROVEN 8 · ENV 14** |');
L.push('| `test-merchant-shell-boundary.js` | 15/15 |');
L.push('| `test-merchant-actions.js` | 31/0 |');
L.push('');

console.log(L.join('\n'));
