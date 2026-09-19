/* ============================================================================
   RELEASE GATE — Artifact completeness
   scripts/release/artifact-completeness.js
   ============================================================================
   Fails when a COMMITTED page references a local asset that is not present in
   the same commit.

   WHY THIS GATE EXISTS
   --------------------
   Hosting publishes the repository tree. A page committed with a
   `<script src="x.js">` whose `x.js` is untracked works perfectly in the
   developer's working directory — the file is right there on disk — and 404s
   for every real user the moment it is deployed. Nothing in a test suite that
   runs against the working tree can see this: the defect is a property of the
   COMMIT, not of the files on disk.

   This is not hypothetical here. Parallel agents share one working tree, and a
   commit that sweeps in another agent's edited page while leaving their new,
   still-untracked module behind produces exactly this shape.

   WHAT IT CHECKS
   --------------
   Every `src=` / `href=` in every committed HTML file, resolved against the
   commit's own file list — never against the working directory, because the
   working directory is what hides the bug.

   Ignored on purpose: absolute URLs (http/https/protocol-relative), data: and
   blob: URIs, anchors, mailto/tel. Query strings and hashes are stripped before
   resolution, and a `/`-rooted path resolves from the repository root because
   that is what Firebase Hosting serves.

   READ-ONLY. It inspects git objects and mutates nothing.

   RUN
     node scripts/release/artifact-completeness.js [ref]     (default: HEAD)
   ========================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const REF = process.argv[2] || 'HEAD';

function git(args) {
  return execFileSync('git', args, {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/* The commit's own file list — the only authority. Never fs.existsSync(). */
const tracked = new Set(
  git(['ls-tree', '-r', REF, '--name-only']).split('\n').map((s) => s.trim()).filter(Boolean)
);

const htmlFiles = [...tracked].filter((f) => /\.html$/i.test(f));

/* `/__/firebase/...` and `/__/auth/...` are Firebase Hosting RESERVED URLs.
   Hosting synthesises them at request time; they are correctly absent from the
   repository and flagging them is a false positive that trains people to ignore
   this gate. */
const RESERVED = /^\/?__\//;

const SKIP = /^(https?:)?\/\/|^data:|^blob:|^mailto:|^tel:|^javascript:|^#|^\{\{|^\$\{/i;

/* src= or href= with a quoted value. */
const ATTR = /\b(?:src|href)\s*=\s*"([^"]*)"|\b(?:src|href)\s*=\s*'([^']*)'/gi;

const findings = [];
let refsChecked = 0;

/* ── Runtime loader edges ────────────────────────────────────────────
   `src=`/`href=` is not the whole reference universe. This project fetches
   modules at runtime through two named helpers:

     loadScript('sokoni-print-host-listener.js')
     lazyGlobal('PosPremiumScanner', 'sokoni-premium-scanner.js')

   Both fetch exactly as a <script src> would and 404 identically when the file
   is absent. Before this pass the gate reported 6 assets while three further
   dangling references sat in plain sight — proven, not inferred, by
   `prove-artifact-blindspot.js`.

   This is an ALLOW-LIST of loader names, not a hunt for filename-shaped
   strings. `const note = "foo.js"` fetches nothing, and reporting it would
   train people to ignore the gate. Adding a loader here means adding its
   controls to `test-artifact-gate.js` in the same commit. */
const LOADER = /\b(?:loadScript|lazyGlobal)\s*\(([^)]*)\)/g;
const ARGSTR = /(['"])([^'"]+)\1/g;

/* Comments cannot fetch anything, so a commented-out loader is not a defect.
   Only WHOLE-LINE `//` comments are removed: stripping mid-line `//` would eat
   the `//` in any `https://` URL and silently blank real references. A trailing
   comment on a line that also contains code is therefore still scanned — a
   known, deliberate limit, not an oversight. */
function stripComments(body) {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

/** Shared resolution for both passes. Returns true when the ref was in scope. */
function record(file, raw) {
  if (!raw || SKIP.test(raw) || RESERVED.test(raw)) return false;

  let clean = raw.split('#')[0].split('?')[0];
  if (!clean) return false;

  /* A browser percent-decodes before requesting, and Hosting serves the
     decoded name. `assets/Sokoni%20Logo.png` IS `assets/Sokoni Logo.png`, so
     comparing the encoded form against the file list invents a missing file
     for every asset whose name contains a space. */
  try { clean = decodeURIComponent(clean); } catch (e) { /* keep raw on bad escapes */ }

  /* Only local file references are in scope; a bare route with no extension
     is a cleanUrls path, resolved by Hosting rather than by a file name. */
  if (!/\.[a-z0-9]{2,5}$/i.test(clean)) return false;

  refsChecked++;

  const resolved = clean.startsWith('/')
    ? clean.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));

  if (!tracked.has(resolved)) {
    findings.push({ file, ref: raw, resolved, why: 'not present in ' + REF });
  }
  return true;
}

for (const file of htmlFiles) {
  let body;
  try { body = git(['show', `${REF}:${file}`]); }
  catch (e) { findings.push({ file, ref: '(unreadable)', why: 'could not read from ' + REF }); continue; }

  const scan = stripComments(body);

  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(scan)) !== null) {
    record(file, (m[1] != null ? m[1] : m[2] || '').trim());
  }

  LOADER.lastIndex = 0;
  while ((m = LOADER.exec(scan)) !== null) {
    /* The asset is whichever argument looks like a file — first for
       loadScript, second for lazyGlobal — so scan the argument list rather
       than assuming a position. */
    const args = m[1];
    let a;
    ARGSTR.lastIndex = 0;
    while ((a = ARGSTR.exec(args)) !== null) {
      if (/\.[a-z0-9]{2,5}$/i.test(a[2])) record(file, a[2].trim());
    }
  }
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(72));
console.log('  RELEASE GATE — ARTIFACT COMPLETENESS   (' + REF + ')');
console.log('='.repeat(72));
console.log('  html files in commit : ' + htmlFiles.length);
console.log('  local refs checked   : ' + refsChecked);
console.log('  dangling references  : ' + findings.length);

if (findings.length) {
  /* Group by missing asset: one absent file usually breaks several pages, and
     the operator needs the ASSET list, not a per-occurrence dump. */
  const byAsset = new Map();
  findings.forEach((f) => {
    const k = f.resolved || f.ref;
    if (!byAsset.has(k)) byAsset.set(k, []);
    byAsset.get(k).push(f.file);
  });
  console.log('\n  MISSING ASSETS');
  [...byAsset.entries()].sort().forEach(([asset, pages]) => {
    console.log('   ✗ ' + asset);
    pages.sort().forEach((p) => console.log('       referenced by ' + p));
  });
  console.log('\n  These pages are committed; the assets are not. Deployed, every');
  console.log('  reference above returns 404 for every user.');
}

console.log('='.repeat(72));
console.log(findings.length === 0 ? '  RESULT: COMPLETE\n' : '  RESULT: INCOMPLETE — DO NOT DEPLOY\n');
process.exit(findings.length === 0 ? 0 : 1);
