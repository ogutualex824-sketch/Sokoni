/* ═══════════════════════════════════════════════════════════════════════════
   ROOT IDENTITY REGRESSION SUITE
   ═══════════════════════════════════════════════════════════════════════════

   Guards the P0 of 2026-07-19: https://mysokoni.co.ke/ rendered a Store Profile.
   URL stayed "/", but Business Hours and Store Policies were shown.

   Root cause was NOT a router bug and NOT a redirect. The service worker's
   root-cache guard, rootCacheIsValid(), returned TRUE when a cached document
   carried no <meta name="sokoni-page"> marker — it treated absence of evidence
   as evidence of validity. ministore.html carried no marker, so a store document
   could occupy the "/" cache slot and be served as the homepage on every reload.

   These tests encode the invariant that prevents recurrence:

     1. The root guard must FAIL CLOSED — an unidentified document is not the homepage.
     2. Every top-level page that can be cached must POSITIVELY identify itself.
     3. Exactly one page may claim the root template identity.

   Run: node scripts/test-root-identity.js          (exit 1 on any failure)
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  pass  ' + m); };
const bad = (m) => { fail++; console.log('  FAIL  ' + m); };

const sw   = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const marker = (html) => {
  const m = html.match(/<meta\s+name=["']sokoni-page["']\s+content=["']([^"']+)["']/i);
  return m ? m[1].trim() : null;
};

console.log('\nRoot identity — the homepage must always be the homepage\n');

/* ── 1. The guard must fail closed ──────────────────────────────────────── */
const guard = sw.slice(sw.indexOf('async function rootCacheIsValid'),
                       sw.indexOf('async function purgeRootFromCaches'));

if (!guard) bad('rootCacheIsValid() not found in service-worker.js');
else {
  /* The exact regression: `if (!m) return true`. Any spelling of it is a failure. */
  if (/if\s*\(\s*!\s*m\s*\)\s*return\s+true/.test(guard))
    bad('rootCacheIsValid trusts documents with NO sokoni-page marker — this is the P0');
  else ok('an unidentified cached document is NOT accepted as the root');

  if (/if\s*\(\s*!\s*m\s*\)\s*return\s+false/.test(guard))
    ok('missing marker explicitly evicts the cached root');
  else bad('no explicit `if (!m) return false` — the fail-closed path is not guaranteed');

  if (/catch[\s\S]*?return\s+true/.test(guard))
    bad('the catch block fails OPEN — a decode error can serve a wrong root');
  else ok('a decode error also evicts rather than serving an unverified root');

  if (/=== *ROOT_TEMPLATE/.test(guard))
    ok('the root is validated by positive identity match against ROOT_TEMPLATE');
  else bad('root validity is not compared against ROOT_TEMPLATE');
}

/* ── 2. ROOT_TEMPLATE resolves to exactly one page ──────────────────────── */
const rt = (sw.match(/const\s+ROOT_TEMPLATE\s*=\s*["']([^"']+)["']/) || [])[1];
if (!rt) bad('ROOT_TEMPLATE constant not found');
else {
  ok(`ROOT_TEMPLATE = "${rt}"`);
  const claimants = fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.html'))
    .filter(f => { try { return marker(read(f)) === rt; } catch (e) { return false; } });

  if (claimants.length === 1) ok(`exactly one page claims "${rt}": ${claimants[0]}`);
  else if (claimants.length === 0) bad(`NO page declares content="${rt}" — the root can never validate`);
  else bad(`${claimants.length} pages claim "${rt}": ${claimants.join(', ')} — the root is ambiguous`);

  if (marker(read('index.html')) === rt) ok('index.html is the page that claims the root identity');
  else bad('index.html does not declare the root template identity');
}

/* ── 3. Store/profile pages must positively identify themselves ─────────── */
/* These are the pages that can be navigated to directly and therefore cached.
   Any one of them lacking a marker can occupy the root slot — that is exactly
   how ministore.html caused the P0. */
const STOREFRONTS = ['ministore.html', 'store.html', 'minishop.html'];
STOREFRONTS.forEach(f => {
  if (!fs.existsSync(path.join(ROOT, f))) return;
  const id = marker(read(f));
  if (!id) bad(`${f} declares NO sokoni-page marker — it can masquerade as the homepage`);
  else if (id === rt) bad(`${f} claims the ROOT template identity "${rt}" — it would BE the homepage`);
  else ok(`${f} identifies as "${id}"`);
});

/* ── 4. No page other than index.html may claim the root ────────────────── */
const wrong = fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && f !== 'index.html')
  .filter(f => { try { return marker(read(f)) === rt; } catch (e) { return false; } });
if (wrong.length) bad(`these non-home pages claim the root identity: ${wrong.join(', ')}`);
else ok('no page other than index.html claims the root identity');

/* ── 5. The root purge path still exists ────────────────────────────────── */
if (/purgeRootFromCaches/.test(sw)) ok('purgeRootFromCaches() exists to evict a bad root');
else bad('purgeRootFromCaches() is missing — a bad root cannot be cleared');

console.log('\n' + (fail
  ? `Root identity FAILED — ${fail} failure(s), ${pass} passed\n`
  : `Root identity PASSED (${pass} checks) — "/" can only ever be the homepage\n`));
process.exit(fail ? 1 : 0);
