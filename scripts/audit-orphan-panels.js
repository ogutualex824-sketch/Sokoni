#!/usr/bin/env node
/* ============================================================================
   Orphan panel audit — a container that no code ever writes to
   ============================================================================
   admin.html reported a blank Applications panel. Firestore was not empty: four
   applications existed in production. The panel was blank because
   `<div id="bizAppsGrid">` is referenced exactly ONCE in the whole file — by the
   markup that creates it. Nothing renders into it, and `_subTabSwitch` only
   toggles `display`. So the tab shows an empty box: no spinner, no empty state,
   no error. Indistinguishable from "nobody has applied".

   That is a class of bug, not one instance, so this looks for all of them: an
   element that exists only as an empty container and is never addressed by
   getElementById / querySelector / innerHTML / a render call.

   Heuristic and deliberately conservative — it only reports elements whose id
   appears EXACTLY once in the file and whose markup is an empty container. A
   container populated by a framework, a template, or a data attribute would not
   be flagged, and neither would one written via a variable id.

   Usage:  node scripts/audit-orphan-panels.js [file...]
   Exit:   0 always — this is a report, not a gate.
   ========================================================================= */

'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['admin.html', 'super-admin.html', 'moderation.html', 'trust-safety.html'];

/* An empty container: <div id="x"></div>, <tbody id="x"></tbody>, etc. */
const EMPTY_EL = /<(div|tbody|ul|ol|section|span|p)\b([^>]*)\bid=["']([A-Za-z0-9_-]+)["']([^>]*)>\s*<\/\1>/g;

let total = 0;

for (const rel of files) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) { console.log(`\n${rel}: not found`); continue; }
  const src = fs.readFileSync(fp, 'utf8');

  const orphans = [];
  let m;
  EMPTY_EL.lastIndex = 0;
  while ((m = EMPTY_EL.exec(src))) {
    const id = m[3];
    /* Count every occurrence of the bare id anywhere in the file. One means the
       markup that declares it and nothing else. */
    const uses = (src.match(new RegExp('\\b' + id.replace(/[-]/g, '\\-') + '\\b', 'g')) || []).length;
    if (uses > 1) continue;
    const line = src.slice(0, m.index).split('\n').length;
    orphans.push({ id, line });
  }

  console.log(`\n${rel}`);
  console.log('─'.repeat(rel.length));
  if (!orphans.length) { console.log('  no orphan containers'); continue; }
  for (const o of orphans) {
    console.log(`  ${rel}:${o.line}  #${o.id}  — declared once, never written to`);
  }
  total += orphans.length;
}

console.log(`\n${total} orphan container(s).`);
console.log('An orphan renders as a blank area. Every one of them should either be');
console.log('populated or removed — a permanently empty box is a bug report waiting');
console.log('to happen, because it is indistinguishable from "no data".\n');
