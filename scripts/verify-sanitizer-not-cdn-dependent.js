#!/usr/bin/env node
/* GATE — HTML sanitisation must not depend on a third-party CDN
   =========================================================================
   Run:  node scripts/verify-sanitizer-not-cdn-dependent.js

   safeHTML() prefers DOMPurify and falls back to a regex the file itself calls
   "bypassable, best-effort only". That fallback is correct as a momentary
   bridge and WRONG as a steady state — so whatever loads DOMPurify must not be
   able to fail for reasons outside our control.

   Measured in a production runtime audit: cdnjs returned HTTP 503 for exactly
   this file. Nothing reported it; sanitisation silently degraded platform-wide.
========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEC = path.join(ROOT, 'security.js');
const src = fs.readFileSync(SEC, 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const rows = [];
const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail == null ? '' : String(detail) });

/* 1 — the loader must not reach off-origin. */
const cdnInLoader = /dp\.src\s*=\s*['"]https?:\/\//.test(code);
ck('C1   the DOMPurify loader does not fetch from a third-party origin', !cdnInLoader,
  cdnInLoader ? 'still assigns an absolute http(s) URL — a CDN outage degrades sanitisation'
              : 'served from our own origin');

const anyCdnRef = /cdnjs\.cloudflare\.com[^'"]*purify/i.test(code);
ck('C2   no cdnjs purify reference remains in the sanitisation path', !anyCdnRef,
  anyCdnRef ? 'a cdnjs purify URL is still present' : 'none');

/* 2 — the local copy must actually exist, and be the pinned version. */
const localMatch = code.match(/dp\.src\s*=\s*base\s*\+\s*['"]([^'"]+)['"]/);
const localRel = localMatch ? localMatch[1] : null;
const localAbs = localRel ? path.join(ROOT, localRel) : null;
const exists = !!(localAbs && fs.existsSync(localAbs));
ck('C3   the referenced local copy exists in the repository', exists,
  localRel ? localRel + (exists ? ' present' : ' MISSING — the script tag would 404') : 'no local src found');

const pinned = !!(localRel && /\d+\.\d+\.\d+/.test(localRel));
ck('C4   the version is PINNED in the filename', pinned,
  pinned ? localRel + ' — an upgrade is a deliberate commit, not whatever a CDN serves'
         : 'unpinned filename');

if (exists) {
  const lib = fs.readFileSync(localAbs, 'utf8');
  const declaredVer = (localRel.match(/(\d+\.\d+\.\d+)/) || [])[1];
  const inFile = declaredVer && lib.indexOf(declaredVer) !== -1;
  ck('C5   the file really is the version its name claims', !!inFile,
    declaredVer ? 'filename says ' + declaredVer + ', literal ' + (inFile ? 'found' : 'NOT found') + ' in the file'
                : 'no version in filename');

  let parses = false;
  try { new Function(lib); parses = true; } catch (_) {}
  ck('C6   the vendored library parses', parses, parses ? Math.round(lib.length / 1024) + 'KB' : 'SYNTAX ERROR');

  ck('C7   it is the real library, not a stub', /DOMPurify/.test(lib) && lib.length > 5000,
    /DOMPurify/.test(lib) ? 'defines DOMPurify, ' + lib.length + ' bytes' : 'no DOMPurify marker');
}

/* 3 — degradation must be audible. */
const loaderWarns = /dp\.onerror\s*=/.test(code) && /console\.error/.test(code);
ck('C8   a failed load is REPORTED, not silent', loaderWarns,
  loaderWarns ? 'onerror logs that sanitisation is degraded' : 'a failed load would be silent');

const fallbackWarns = /_warnedDegraded/.test(code);
ck('C9   using the regex fallback is REPORTED at least once per page', fallbackWarns,
  fallbackWarns ? 'warned once, not per call — silence is what hid this'
                : 'the bypassable path runs silently');

/* 4 — the fallback must still exist. Removing it would turn a degraded
       sanitiser into no sanitiser, which is worse. */
const keptFallback = /replace\(\/<script/.test(code);
ck('C10  the regex fallback is still present as a last resort', keptFallback,
  keptFallback ? 'degraded sanitisation beats none' : 'fallback removed — unsanitised output on failure');

const passed = rows.filter((r) => r.ok).length;
console.log('');
console.log('  SANITISER INDEPENDENCE GATE');
console.log('  ' + '='.repeat(58));
console.log('');
for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
console.log('');
console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
console.log('');
process.exit(passed === rows.length ? 0 : 1);
