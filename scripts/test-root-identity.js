/* ═══════════════════════════════════════════════════════════════════════════
   ROOT IDENTITY REGRESSION SUITE
   ═══════════════════════════════════════════════════════════════════════════

   Guards the P0 of 2026-07-19: https://mysokoni.co.ke/ rendered a Store Profile.
   URL stayed "/", Business Hours and Store Policies rendered, and it survived
   every reload.

   Not a router bug and not a redirect. Two independent defects in the service
   worker's handling of the root cache key:

     READ  rootCacheIsValid() returned TRUE when a cached document carried no
           <meta name="sokoni-page"> marker — absence of evidence treated as
           evidence of validity. ministore.html carried no marker.

     WRITE the page handler cached a redirected response under the ORIGINAL
           request key whenever the final path differed:
               if (!isSelf) cache.put(request, res.clone());
           Navigations returned early via Response.redirect(), so a NON-navigate
           fetch of "/" that redirected elsewhere stored the redirect target's
           document under the "/" key.

   The invariant these tests encode: a document may occupy the root cache key
   only if it positively identifies as the root template — on read AND on write.

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
/* Slice a single function body by name, bounded by the next top-level function. */
function fnBody(name) {
  const start = sw.search(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  if (start < 0) return '';
  const rest  = sw.slice(start + 10);
  const next  = rest.search(/\n(async\s+)?function\s+[a-zA-Z_]/);
  return next < 0 ? sw.slice(start) : sw.slice(start, start + 10 + next);
}

console.log('\nRoot identity — READ side\n');

/* ── 1. The read guard must fail closed ─────────────────────────────────── */
const guard = fnBody('rootCacheIsValid');
if (!guard) bad('rootCacheIsValid() not found');
else {
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
  ok('ROOT_TEMPLATE = "' + rt + '"');
  const claimants = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))
    .filter(f => { try { return marker(read(f)) === rt; } catch (e) { return false; } });
  if (claimants.length === 1) ok('exactly one page claims "' + rt + '": ' + claimants[0]);
  else if (!claimants.length) bad('NO page declares content="' + rt + '" — the root can never validate');
  else bad(claimants.length + ' pages claim "' + rt + '": ' + claimants.join(', '));

  if (marker(read('index.html')) === rt) ok('index.html is the page that claims the root identity');
  else bad('index.html does not declare the root template identity');

  const wrong = fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && f !== 'index.html')
    .filter(f => { try { return marker(read(f)) === rt; } catch (e) { return false; } });
  if (wrong.length) bad('non-home pages claim the root identity: ' + wrong.join(', '));
  else ok('no page other than index.html claims the root identity');
}

/* ── 3. Storefront / merchant / profile pages must identify themselves ──── */
['ministore.html', 'store.html', 'minishop.html', 'minishop-status.html'].forEach(f => {
  if (!fs.existsSync(path.join(ROOT, f))) return;
  const id = marker(read(f));
  if (!id) bad(f + ' declares NO sokoni-page marker — it can masquerade as the homepage');
  else if (id === rt) bad(f + ' claims the ROOT identity "' + rt + '" — it would BE the homepage');
  else ok(f + ' identifies as "' + id + '"');
});

if (/purgeRootFromCaches/.test(sw)) ok('purgeRootFromCaches() exists to evict a bad root');
else bad('purgeRootFromCaches() is missing — a bad root cannot be cleared');

/* ═══════════════════════════════════════════════════════════════════════════
   WRITE side — only the homepage may POPULATE the root key.
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nRoot identity — WRITE side\n');

const put = fnBody('safeCachePut');
if (!put) bad('safeCachePut() does not exist — cache writes are unguarded');
else {
  ok('safeCachePut() exists as the sanctioned write path');
  if (/isRootKey\s*\(/.test(put)) ok('safeCachePut tests whether the key is the root');
  else bad('safeCachePut does not test for the root key');
  if (/rootCacheIsValid/.test(put)) ok('a root write is identity-checked before being stored');
  else bad('a root write is NOT identity-checked — a store page could populate "/"');
  if (/response\.redirected/.test(put)) ok('a redirected response landing off-root is rejected on write');
  else bad('redirected responses are not checked on write — the original poisoning path');
}

const rootKey = fnBody('isRootKey');
if (!rootKey) bad('isRootKey() missing');
else {
  const missing = ['"/"', 'index.html', '"/index"'].filter(s => !rootKey.includes(s));
  if (!missing.length) ok('isRootKey covers every spelling of the root (/, /index.html, /index)');
  else bad('isRootKey misses root spellings: ' + missing.join(', '));
}

/* Every write that can carry an HTML document must route through the guard.
   Comment lines are excluded — the module documents the defective code it replaced. */
const raw = [];
{
  const lines = sw.split('\n');
  /* safeCachePut's own cache.put IS the sanctioned sink — exclude its body. */
  const sinkStart = lines.findIndex(l => /async function safeCachePut/.test(l));
  const sinkEnd   = lines.findIndex((l, i) => i > sinkStart && /^\}/.test(l));
  let inBlock = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    /* Track /* … *\/ properly: the module documents the defective code it replaced,
       and that documentation must not be mistaken for a live write. */
    if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
    if (t.startsWith('*') || t.startsWith('//')) return;
    if (sinkStart >= 0 && i >= sinkStart && i <= sinkEnd) return;
    if (!/cache\.put\(\s*(request|"\/")/.test(t)) return;
    if (/safeCachePut/.test(t)) return;
    raw.push((i + 1) + ': ' + t.slice(0, 62));
  });
}
if (!raw.length) ok('no unguarded cache.put() of a request or the root key remains');
else raw.forEach(r => bad('unguarded root-capable write at ' + r));

['cacheFirst', 'networkFirst'].forEach(name => {
  const body = fnBody(name);
  if (!body) return;
  if (/safeCachePut/.test(body)) ok(name + '() writes through safeCachePut');
  else bad(name + '() writes to cache without the root guard');
});

console.log('\n' + (fail
  ? 'Root identity FAILED — ' + fail + ' failure(s), ' + pass + ' passed\n'
  : 'Root identity PASSED (' + pass + ' checks) — the root can only be read or written as the homepage\n'));
process.exit(fail ? 1 : 0);
