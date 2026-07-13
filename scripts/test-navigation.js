#!/usr/bin/env node
/**
 * test-navigation.js — the Home button. Static analysis. Navigates nothing.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The Home button returned ERR_FAILED — "This site can't be reached" — on every tap.
 *
 * The service worker redirects `*.html` → clean URL at the SW level, because letting
 * fetch() follow Firebase's cleanUrls 301 internally hands the browser a REDIRECTED
 * response for a NAVIGATION request. Navigation requests have redirect mode "manual";
 * the spec forbids a service worker fulfilling one with a redirected response, and
 * Chrome rejects it as ERR_FAILED.
 *
 * The guard read:
 *
 *     if (ext === "html" && url.pathname !== "/index.html") { ...redirect... }
 *                          └─────────────────────────────┘
 *
 * index.html — the Home button's target — was the ONE path excluded from the fix, so
 * it fell straight through to the code path the fix existed to avoid.
 *
 * The exclusion was there because the naive strip is wrong for exactly this path:
 *   "/index.html".replace(/\.html$/, "") → "/index"   ✗ not the homepage
 * Rather than map it to "/", someone carved it out. Home broke; every other page worked.
 *
 * These checks make that specific mistake impossible to reintroduce.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const read = f => fs.readFileSync(path.resolve(f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const sw       = read('service-worker.js');
const swCode   = strip(sw);
const navEng   = strip(read('sokoni-nav-engine.js'));
const header   = strip(read('shared-header.js'));
const navActive= strip(read('nav-active.js'));

console.log('\nNavigation — the Home button\n');

/* ── 1. index.html must NOT be excluded from the SW redirect ───────────────── */
{
  !/pathname\s*!==\s*["']\/index\.html["']/.test(swCode)
    ? ok('index.html is NOT excluded from the service worker\'s .html redirect')
    : bad('index.html is excluded from the SW redirect — Home will return ERR_FAILED again');

  /* And it must map to "/", not to "/index". */
  /pathname\s*===\s*["']\/index\.html["'][\s\S]{0,60}["']\/["']/.test(swCode)
    ? ok('index.html maps to "/" — the canonical homepage (not "/index")')
    : bad('index.html does not map to "/" — a naive .html strip yields "/index", which is not the homepage');
}

/* ── 2. A navigation may NEVER receive a redirected response ───────────────── */
{
  /res\.redirected\s*&&\s*request\.mode\s*===\s*["']navigate["']/.test(swCode)
    ? ok('a redirected response is re-issued as a real redirect for navigations (closes the whole ERR_FAILED class)')
    : bad('a navigation could still receive a redirected response — Chrome rejects that as ERR_FAILED');
}

/* ── 3. The Home button and the logo must agree on the homepage ────────────── */
{
  /* The logo pointed at "/" while the Home button pointed at "index.html". Two
     buttons, one destination, two URLs — which is why the logo worked and Home
     didn't, and why the bug looked so arbitrary. */
  const navHome = /\{\s*i:\s*'🏠',\s*l:\s*'Home',\s*h:\s*'([^']+)'/.exec(navEng);
  navHome && navHome[1] === '/'
    ? ok('bottom-nav Home targets the canonical "/" (same as the header logo)')
    : bad(`bottom-nav Home targets "${navHome ? navHome[1] : '?'}" — must be "/" to match the logo`);

  const hdrHome = /icon:\s*'🏠',\s*label:\s*'Home',\s*href:\s*'([^']+)'/.exec(header);
  hdrHome && hdrHome[1] === '/'
    ? ok('header nav Home targets the canonical "/"')
    : bad(`header nav Home targets "${hdrHome ? hdrHome[1] : '?'}" — must be "/"`);

  /logo[\s\S]{0,40}href="\/"|href="\/"[^>]*sk-nav-logo/.test(header)
    ? ok('header logo targets "/" — Home and the logo now agree')
    : bad('header logo no longer targets "/" — Home and the logo disagree again');
}

/* ── 4. Canonicalising Home must not silently kill the active tab ──────────── */
{
  /* This is the regression that canonicalisation invites. _page resolves "/" to
     "index", so an href of "/" compares "/" against "index" and never matches. The
     tab simply stops lighting up — nothing throws, nothing logs, nobody notices. */
  /function _home\s*\([\s\S]{0,140}['"]index['"]/.test(navEng)
    ? ok('nav-engine normalises "/" and "index.html" to one token (active tab still highlights)')
    : bad('nav-engine does not normalise "/" — the Home tab would stop highlighting, silently');

  /href\s*===\s*['"]\/['"][\s\S]{0,40}index\.html/.test(navActive)
    ? ok('nav-active normalises "/" to index.html (active tab still highlights)')
    : bad('nav-active does not normalise "/" — the Home tab would stop highlighting, silently');
}

/* ── 5. The homepage must be precached, so Home works OFFLINE ──────────────── */
{
  /PRECACHE_PAGES\s*=\s*\[\s*["']\/["']/.test(swCode)
    ? ok('"/" is precached — Home works offline and inside the installed PWA')
    : bad('"/" is not precached — Home would fail offline');

  /* The SW-level redirect is synthesized, so it works with no network at all: the
     browser follows it to "/", which is served from cache. */
  /Response\.redirect\(/.test(swCode)
    ? ok('the Home redirect is synthesized by the SW — it resolves offline, with no network')
    : bad('the Home redirect requires the network — Home would fail offline');
}

/* ── 6. The cache version must be at or past the fix ───────────────────────────
   The Home fix landed in v50. Anything older means users are still being served the
   worker that returns ERR_FAILED.

   This asserts the VERSION NUMBER, not the version NAME. An earlier draft of this
   check required the string "home" in the version — which failed the moment someone
   legitimately bumped to "logo-png-v51", a strictly NEWER worker that carries the fix
   perfectly well. A guard that enforces a naming convention rather than a real property
   is a guard that cries wolf, and a guard that cries wolf gets disabled. */
{
  const FIX_LANDED_IN = 50;
  const v   = /CACHE_VERSION\s*=\s*["']([^"']+)["']/.exec(sw);
  const num = v && /v(\d+)\s*$/.exec(v[1]);

  if (!v || !num) {
    bad('CACHE_VERSION is missing or does not end in -vNN — cannot verify users get the fixed worker');
  } else if (Number(num[1]) >= FIX_LANDED_IN) {
    ok(`cache version is v${num[1]} (fix landed in v${FIX_LANDED_IN}) — users receive the corrected worker`);
  } else {
    bad(`CACHE_VERSION is v${num[1]}, older than v${FIX_LANDED_IN} — users would keep the broken worker and Home would stay broken`);
  }
}

console.log('');
if (fail) { console.error(`Navigation FAILED (${fail}) — Home may be broken\n`); process.exit(1); }
console.log(`Navigation PASSED (${pass} checks) — Home is canonical, offline-safe, and cannot regress\n`);
