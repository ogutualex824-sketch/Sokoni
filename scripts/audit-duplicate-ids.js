#!/usr/bin/env node
/* ============================================================================
   Duplicate element ids — the mechanism behind the blank admin panels
   ============================================================================
   `document.getElementById(x)` returns the FIRST match and nothing else. So a
   duplicated id is never merely untidy HTML: it silently decides which of two
   elements every renderer, every listener and every nav switch will address,
   and the loser is unreachable forever.

   That is exactly what is wrong with admin.html. It carries two parallel
   layouts for the same data — a consolidated sub-tab layout (~L880–1300) and a
   pane-per-topic layout (~L2000–2200) — and five pane ids exist in both:

       adm-pane-orders · adm-pane-properties · adm-pane-rides
       adm-pane-settings · adm-pane-users

   showPane() resolves each to the first copy, so the second copy and everything
   inside it can never be displayed. Three stat strips collide the same way
   (deliveryStats, propStats, communityStats), and there the renderer writes into
   the FIRST element — which for properties sits in a different pane from the
   table it belongs to. The reachable Properties pane therefore shows stats with
   an empty table, while the table data is written into a pane nobody can open.

   No amount of adding loading/empty/error states fixes that: the element being
   rendered into is not the element on screen.

   Usage:  node scripts/audit-duplicate-ids.js [file...]
   Exit:   0 clean · 1 any duplicate id
   ========================================================================= */

'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* Flags must not be mistaken for filenames — `--update-baseline` was being
   scanned as a file, which found nothing and wrote an empty baseline that would
   have made every real duplicate look like a fresh regression. */
const argFiles = process.argv.slice(2).filter(a => !a.startsWith('--'));
const files = argFiles.length
  ? argFiles
  : ['admin.html', 'super-admin.html', 'moderation.html', 'trust-safety.html',
     'verification-admin.html', 'index.html'];

/* Ids inside a <template> may legitimately repeat once instantiated, and ids
   built from a variable are not literals we can see. Only static markup counts. */
const ID_ATTR = /<[a-zA-Z][^>]*?\bid\s*=\s*["']([A-Za-z0-9_:.-]+)["']/g;

let total = 0;
const perFile = {};

for (const rel of files) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) continue;
  const src = fs.readFileSync(fp, 'utf8');

  /* Strip <template> blocks and HTML comments — neither is live DOM. */
  const live = src
    .replace(/<template[\s\S]*?<\/template>/gi, m => '\n'.repeat((m.match(/\n/g) || []).length))
    .replace(/<!--[\s\S]*?-->/g, m => '\n'.repeat((m.match(/\n/g) || []).length));

  const seen = new Map();
  let m;
  ID_ATTR.lastIndex = 0;
  while ((m = ID_ATTR.exec(live))) {
    const id = m[1];
    const line = live.slice(0, m.index).split('\n').length;
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(line);
  }

  const dupes = [...seen.entries()].filter(([, ls]) => ls.length > 1);
  perFile[rel] = dupes.length;
  console.log(`\n${rel}`);
  console.log('─'.repeat(rel.length));
  if (!dupes.length) { console.log('  no duplicate ids'); continue; }

  for (const [id, ls] of dupes.sort((a, b) => b[1].length - a[1].length)) {
    /* Is the id actually addressed? An unused duplicate is dead markup; an
       addressed one is actively misrouting something. */
    const addressed = new RegExp(`getElementById\\(['"\`]${id}['"\`]\\)|querySelector\\([^)]*#${id}\\b`)
      .test(src);
    console.log(`  #${id}`.padEnd(30)
      + `${ls.length}× at lines ${ls.join(', ')}`.padEnd(34)
      + (addressed ? '  ADDRESSED — only the first is ever reached' : '  (not addressed)'));
    total++;
  }
}

console.log(`\n${total} duplicate id(s).`);

/* ── Ratchet, not a wall ────────────────────────────────────────────────────
   admin.html carries 112 of these today. Failing the build on that number would
   block every deploy until a multi-day cleanup lands, which is exactly how a
   gate ends up disabled and then ignored. So the current count is the BASELINE
   and this fails only when the count goes UP.

   The number may fall freely; it may never rise. Update the baseline downward
   as panes are de-duplicated — never upward to make a failure go away. */
const BASELINE_FILE = path.join(__dirname, 'duplicate-ids-baseline.json');
let baseline = {};
try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch (e) {}

if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(perFile, null, 2) + '\n');
  console.log('baseline written: ' + JSON.stringify(perFile));
  process.exit(0);
}

let regressed = false;
for (const [f, n] of Object.entries(perFile)) {
  const was = baseline[f];
  if (was === undefined) {
    if (n > 0) { console.log(`  REGRESSION: ${f} has ${n} duplicate id(s) and no baseline entry`); regressed = true; }
  } else if (n > was) {
    console.log(`  REGRESSION: ${f} went ${was} -> ${n} duplicate id(s)`);
    regressed = true;
  } else if (n < was) {
    console.log(`  improved: ${f} ${was} -> ${n}; run --update-baseline to lock it in`);
  }
}

if (regressed) {
  console.log('\ngetElementById returns the first match. Every later copy is unreachable —');
  console.log('and if a renderer targets one, it is writing into an element nobody sees.\n');
  process.exit(1);
}
console.log('no duplicate-id regression.\n');
process.exit(0);
