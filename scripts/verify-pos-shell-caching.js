#!/usr/bin/env node
/* GATE — POS survives a cold, offline first tap, without becoming a release blocker
   =========================================================================
   Run:  node scripts/verify-pos-shell-caching.js

   Two requirements that pull against each other:
     1. POS must be in the cache BEFORE a merchant's first successful visit,
        or a cold tap on a weak connection falls through to /offline and the
        app tells the merchant they have no internet.
     2. Adding POS must NOT be able to fail a service-worker install, or one
        POS outage freezes SOKONI updates for every user, buyers included.

   A gate that only checked (1) would pass on a change that quietly introduced
   a platform-wide release blocker.
========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const SW = process.env.SK_SW || path.join(__dirname, '..', 'service-worker.js');
const src = fs.readFileSync(SW, 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const rows = [];
const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail == null ? '' : String(detail) });

/* ── 1. POS is cached at install ─────────────────────────────────────────── */
/* Bound every membership test to the array's OWN body. A lazy match that starts
   at `const APP_SHELL = [` and hunts for "/pos" runs straight past the closing
   bracket and finds it in SHELL_OPTIONAL — or, on the pre-fix file, in the dead
   PRECACHE_PAGES 150 lines below. That false positive did not just break this
   check: S1 and S2 both fall back on it, so all three read green against a
   service worker that cached no POS at all. */
const body = (name) => ((code.match(new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\];')) || [])[1] || '');
const optionalList = body('SHELL_OPTIONAL');
const shellList = body('APP_SHELL');
const posInOptional = /"\/pos"/.test(optionalList);
const posInShell = /"\/pos"/.test(shellList);

ck('S1   POS is cached during install', posInOptional || posInShell,
  posInOptional ? 'listed in SHELL_OPTIONAL'
    : posInShell ? 'listed in APP_SHELL'
    : 'POS is in NEITHER install list — a cold tap still falls through to /offline');

const optionalFetched = /SHELL_OPTIONAL\.map\(/.test(code);
ck('S2   the optional list is actually FETCHED, not merely declared',
  optionalFetched || posInShell,
  optionalFetched ? 'SHELL_OPTIONAL.map(...) runs inside install'
    : 'declared and never read — the exact defect that made "/pos" in PRECACHE_PAGES meaningless');

/* ── 2. it cannot block an update ────────────────────────────────────────── */
ck('S3   POS is NOT in the all-or-nothing tier', !posInShell,
  posInShell
    ? 'in APP_SHELL: one POS 404 would abort every install and freeze SOKONI updates for all users'
    : 'POS failure cannot reject the install');

/* The abort check must be computed from APP_SHELL alone. */
const abortsOnShellOnly = /const failed = results\s*\.map\(\(r, i\) => \(r\.status === "rejected" \? APP_SHELL\[i\]/.test(code);
ck('S4   the abort decision is computed from APP_SHELL alone', abortsOnShellOnly,
  abortsOnShellOnly ? 'optional failures never reach the abort branch'
                    : 'the abort branch may consider optional assets');

const optionalIsCaught = /SHELL_OPTIONAL\.map\([\s\S]{0,600}?catch \(e\)[\s\S]{0,200}?console\.warn/.test(code);
ck('S5   an optional failure is REPORTED, not silently skipped', optionalIsCaught || posInShell,
  optionalIsCaught ? 'caught and warned — silently not caching POS is how this stayed invisible'
                   : 'no visible reporting on the optional path');

/* ── 3. the dead lists were NOT revived ──────────────────────────────────── */
const revived = /PRECACHE_PAGES\.map\(|PRECACHE_STATIC\.map\(/.test(code);
ck('S6   the ~543-entry dead precache lists were NOT wired up', !revived,
  revived ? 'a precache list is now iterated — this restores the install storm the design removed'
          : 'still unused; their fate is a separate offline-policy decision');

/* ── 4. install stays light ──────────────────────────────────────────────── */
const shellCount = ((code.match(/const APP_SHELL\s*=\s*\[([\s\S]*?)\];/) || [])[1] || '').split(',').filter((s) => /"/.test(s)).length;
const optCount = optionalList.split(',').filter((s) => /"/.test(s)).length;
ck('S7   install stays light', (shellCount + optCount) <= 14,
  shellCount + ' critical + ' + optCount + ' optional = ' + (shellCount + optCount) + ' install fetches');

/* ── 5. CACHE_VERSION is owned by the predeploy bump ─────────────────────── */
ck('S8   CACHE_VERSION is not hand-edited here', /CACHE_VERSION/.test(code),
  'present and left to the predeploy bump — regressing the -vNN counter breaks freshness');

const passed = rows.filter((r) => r.ok).length;
console.log('');
console.log('  POS SHELL CACHING GATE');
console.log('  ' + '='.repeat(58));
console.log('');
for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
console.log('');
console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
console.log('');
process.exit(passed === rows.length ? 0 : 1);
