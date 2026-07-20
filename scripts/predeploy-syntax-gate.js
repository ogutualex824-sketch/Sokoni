#!/usr/bin/env node
/* Predeploy gate — refuse to ship JavaScript that does not parse.
 *
 * WHY THIS EXISTS
 * A syntax error reached production: comment prose sat outside its comment
 * block, `node --check` caught it, and the deploy went ahead anyway because the
 * check ran as a separate shell command rather than as part of the guarded
 * chain. script.js failing to parse takes the entire homepage with it — no
 * products, no cart, no navigation.
 *
 * The lesson is not "be more careful with && chains". It is that a deploy must
 * be structurally incapable of proceeding after a failed check. Firebase runs
 * predeploy hooks and aborts on a non-zero exit, so the gate belongs here where
 * it cannot be forgotten or reordered.
 *
 * A hook already existed (verify-commission-single-source.js) and checked
 * something else entirely. This extends that array rather than replacing it.
 *
 * SCOPE
 * Root-level browser scripts and functions/*.js. Deliberately fast — a gate
 * that takes a minute gets bypassed, which defeats it. Inline <script> blocks
 * in HTML are not covered here; that needs an HTML parser and belongs in a
 * separate check rather than slowing this one down.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const failures = [];
let checked = 0;

function check(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    checked++;
  } catch (e) {
    const msg = String((e.stderr && e.stderr.toString()) || e.message)
      .split('\n').filter((l) => l.trim()).slice(0, 3).join('\n      ');
    failures.push({ file: path.relative(ROOT, file), msg });
  }
}

function sweep(dir, depth) {
  if (depth > 2) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    /* Temp/ holds scratch extracts that are never deployed. Gating on files
       hosting does not serve would block every deploy for no safety gain. */
    if (/^(node_modules|\.git|dist|build|\.firebase|\.claude|Temp|temp)$/.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { sweep(full, depth + 1); continue; }
    if (!e.name.endsWith('.js')) continue;
    /* ES modules and browser globals still parse under --check; only genuine
       syntax errors fail, which is exactly what this gate is for. */
    check(full);
  }
}

console.log('[predeploy] syntax gate — checking JavaScript…');
sweep(ROOT, 0);
sweep(path.join(ROOT, 'functions'), 1);

if (failures.length) {
  console.error('\n  DEPLOY BLOCKED — ' + failures.length + ' file(s) do not parse:\n');
  failures.forEach((f) => console.error('    ' + f.file + '\n      ' + f.msg + '\n'));
  console.error('  Fix the syntax and re-run. Nothing was deployed.\n');
  process.exit(1);
}

console.log('[predeploy] ' + checked + ' JavaScript files parse cleanly.');
process.exit(0);
