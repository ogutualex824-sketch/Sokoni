#!/usr/bin/env node
/* ============================================================================
   Page action-binding audit — orphaned privileged controls
   ============================================================================
   Every invocation site in the markup must resolve to a real method. An
   orphaned binding on an admin console is a control that silently does nothing
   — indistinguishable from a working one until someone relies on it.

   BUILT-IN CONTROL (do not remove):
   The first version of this probe searched for the wrong global and reported
   "0 invocation sites" against 35 methods. A uniform zero is a broken probe,
   not a clean page, so zero sites is now a HARD ABORT (exit 2) rather than a
   pass. The page global is also detected rather than assumed.

   Usage: node scripts/audit-page-actions.js <page.html> [GlobalName]
   Exit: 0 clean · 1 orphaned bindings found · 2 probe invalid
   ========================================================================= */
'use strict';
const fs = require('fs');

const PAGE = process.argv[2];
if (!PAGE) { console.error('usage: node scripts/audit-page-actions.js <page.html> [GlobalName]'); process.exit(2); }
const src = fs.readFileSync(PAGE, 'utf8');

/* detect the page global (window.X = {) unless told explicitly */
const GLOBAL = process.argv[3] || (src.match(/window\.([A-Za-z_$][\w$]*)\s*=\s*\{/) || [])[1];
if (!GLOBAL) { console.error('PROBE INVALID — no page global detected; pass it explicitly'); process.exit(2); }

const calls = new Set();
let m;
/* A LITERAL regex, matched then filtered by GLOBAL. Building one from a string
   invites escaping bugs in the exact character classes this depends on. */
const re = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
while ((m = re.exec(src))) if (m[1] === GLOBAL) calls.add(m[2]);

/* CONTROL: a page with inline handlers cannot legitimately have zero sites. */
if (calls.size === 0) {
  console.error('PROBE INVALID — 0 invocation sites for global "' + GLOBAL + '".');
  console.error('A uniform zero means the probe is wrong, not that the page is clean. Aborting.');
  process.exit(2);
}

const mod = (src.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || []).join('\n');
const start = mod.indexOf('window.' + GLOBAL + ' = {');
const body = start >= 0 ? mod.slice(start) : mod;

/* object-literal members only; these keywords share the `name(...) {` shape */
const KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with']);
const defs = new Set();
const re2 = /^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
while ((m = re2.exec(body))) if (!KW.has(m[1])) defs.add(m[1]);

const orphans = [...calls].filter(c => !defs.has(c));

console.log('page             : ' + PAGE);
console.log('global           : ' + GLOBAL);
console.log('invocation sites : ' + calls.size);
console.log('methods defined  : ' + defs.size);
console.log('ORPHANED calls   : ' + (orphans.length ? orphans.join(', ') : 'none'));

const fns = [...new Set([...mod.matchAll(/httpsCallable\(\s*\w+\s*,\s*['"]([^'"]+)['"]/g)].map(x => x[1]))];
if (fns.length) console.log('callables used   : ' + fns.join(', '));
const writes = [...new Set([...mod.matchAll(/\b(updateDoc|setDoc|addDoc|deleteDoc)\s*\(\s*doc\(\s*\w+\s*,\s*['"]([^'"]+)['"]/g)].map(x => x[1] + ' -> ' + x[2]))];
if (writes.length) console.log('direct writes    : ' + writes.join(', '));

process.exit(orphans.length ? 1 : 0);
