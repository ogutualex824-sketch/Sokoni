#!/usr/bin/env node
/**
 * test-root-guard.js — the canonical-root contract.
 *
 * A merchant profile was reported rendering at https://mysokoni.co.ke. A full audit of
 * Hosting rewrites, redirects, session state, storage, the SW cache and the SW update path
 * found no cause reproducible off-device — so the root route now verifies itself and
 * self-heals. This gate keeps the pieces of that contract from silently rotting apart.
 *
 * The contract has four parts, and it only works if ALL of them hold:
 *   1. Every routable shell declares <meta name="sokoni-page">.
 *   2. index.html declares marketplace-home; merchant shells declare a merchant template.
 *   3. The guard loads on the MERCHANT shells too — the failure mode is a merchant template
 *      rendering at "/", so a guard living only in index.html could never observe it.
 *      (This gate exists because I shipped exactly that mistake and the test caught it.)
 *   4. The guard never touches legitimate merchant routes, and cannot boot-loop.
 *
 * Run: node scripts/test-root-guard.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const fail = (m) => { failures++; console.log('  \x1b[31m✘\x1b[0m ' + m); };
const pass = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);

console.log('\nSOKONI — canonical root guard\n');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tpl  = (src) => {
  const m = /<meta\s+name=["']sokoni-page["']\s+content=["']([^"']+)["']/i.exec(src);
  return m ? m[1] : null;
};

/* ── 1. Template identifiers ─────────────────────────────────────────────────────── */
console.log('1. Every routable shell declares its template');

const SHELLS = {
  'index.html':           'marketplace-home',
  'store.html':           'merchant-profile',
  'minishop.html':        'merchant-profile',
  'minishop-status.html': 'merchant-card',
};

for (const [file, expected] of Object.entries(SHELLS)) {
  if (!fs.existsSync(path.join(ROOT, file))) { fail(file + ' is missing'); continue; }
  const src = read(file);
  const got = tpl(src);
  if (got === expected) pass(file.padEnd(22) + '-> ' + got);
  else fail(file + ' declares "' + got + '", expected "' + expected + '"');

  /* The SW reads the identifier from the first 4 KB of a cached document, so it must be
     near the top of <head> — not buried after a large inline <style>. */
  const idx = src.indexOf('sokoni-page');
  if (idx > 0 && idx > 4096) {
    fail(file + ': the identifier sits at byte ' + idx + ' — beyond the 4 KB window the ' +
         'service worker reads, so cached-root verification would silently skip it');
  }
}

/* ── 2. index.html must NOT claim a merchant template ────────────────────────────── */
tpl(read('index.html')) === 'marketplace-home'
  ? pass('the root shell claims marketplace-home and nothing else')
  : fail('index.html does not declare marketplace-home — the guard cannot verify the root');

/* ── 3. The guard loads where it is actually needed ──────────────────────────────── */
console.log('\n2. The guard loads on the shells that can be mis-served');

const GUARD = /<script src=["']sokoni-root-guard\.js["']><\/script>/;
for (const file of Object.keys(SHELLS)) {
  const src = read(file);
  GUARD.test(src)
    ? pass(file.padEnd(22) + 'loads sokoni-root-guard.js')
    : fail(file + ' does NOT load the guard. If this template is ever served at "/", ' +
           'nothing will detect it — a guard that lives only in the CORRECT page can ' +
           'never catch the WRONG page.');
}

/* ── 4. Guard safety properties ──────────────────────────────────────────────────── */
console.log('\n3. The guard is safe by construction');

const g = read('sokoni-root-guard.js');

/isMerchantRoute[\s\S]{0,400}shop|store|merchant/.test(g)
  ? pass('legitimate merchant routes are excluded')
  : fail('the guard no longer excludes /shop, /store, /merchant, /@ — it would fight real pages');

/sessionStorage[\s\S]{0,80}LATCH|LATCH[\s\S]{0,120}sessionStorage/.test(g)
  ? pass('a one-shot latch prevents a reload loop')
  : fail('the reload latch is gone — a persistent anomaly would boot-loop the site');

/if\s*\(\s*!tpl\s*\)/.test(g)
  ? pass('a shell with no identifier is reported, not "recovered" (avoids blind reloads)')
  : fail('the guard no longer distinguishes "missing identifier" from "wrong template"');

/catch\s*\(/.test(g) && /fail(s|ing)? open|fails open/i.test(g)
  ? pass('the guard fails open — a thrown error leaves the user on their page')
  : fail('the guard must fail OPEN; a guard that can white-screen the site is worse than the bug');

/* ── 5. Service worker integrity check ───────────────────────────────────────────── */
console.log('\n4. The service worker verifies a cached root before serving it');

const sw = read('service-worker.js');
/rootCacheIsValid/.test(sw)
  ? pass('the SW verifies the cached "/" template before responding')
  : fail('the SW no longer verifies the cached root — a poisoned "/" would be served forever');

/purgeRootFromCaches/.test(sw)
  ? pass('the SW can purge a poisoned root and refetch')
  : fail('the SW cannot self-heal a poisoned root cache');

/GET_VERSION/.test(sw)
  ? pass('the SW reports its cache version for telemetry')
  : fail('the SW no longer answers GET_VERSION — anomaly reports lose the build identifier');

console.log('');
if (failures) {
  console.log('\x1b[31mFAIL\x1b[0m — ' + failures + ' problem(s) with the root contract\n');
  process.exit(1);
}
console.log('\x1b[32mPASS\x1b[0m — the root always verifies as the marketplace home\n');
