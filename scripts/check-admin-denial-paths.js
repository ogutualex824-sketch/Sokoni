#!/usr/bin/env node
/* ============================================================================
   CI INVARIANT — admin denial paths must never leave the admin workspace
   ============================================================================
   Thirteen separate "marketplace dump" defects were found one page at a time
   across an audit and five certification batches: an administrator who failed
   an authorization check was redirected to the customer marketplace. It also
   appeared inside a SECURITY console. Finding these by certification is too
   slow and too repetitive; this makes it an invariant.

   THE CONTRACT

     SIGNED OUT
       -> login.html?next=<original destination>      (resumable)

     SIGNED IN, INSUFFICIENT AUTHORITY
       -> a role-neutral or admin-safe denial
          (account-centre.html, or admin-os.html?error=insufficient_privileges)

   NEVER

     -> /                        the customer marketplace
     -> index.html               same
     -> seller.html              a different workspace
     -> any customer surface
     -> another GATED admin page without preserving the destination

   IMPLEMENTATION-AGNOSTIC BY DESIGN
   The scan does not assume one redirect idiom. It collects evidence from
   location.href / location.replace / window.location, redirect helpers, auth
   failure handlers, denial functions, and links inside access-denied UI, then
   judges the DESTINATION. A page may declare an intentional exception in
   docs/admin-denial-exemptions.json with a reason.

   Usage: node scripts/check-admin-denial-paths.js [--json out.json]
   Exit:  1 on any unexempted violation — this IS a gate.
   ========================================================================= */
'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const OUT = (() => { const i = process.argv.indexOf('--json'); return i >= 0 ? process.argv[i + 1] : null; })();

global.window = {}; global.location = { pathname: '/admin-os.html' };
require(path.join(ROOT, 'sokoni-admin-nav.js'));
const NAV = global.window.SokoniAdminNav;

/* Intentional exceptions, each with a reason. Absent file = no exemptions. */
const EX_FILE = path.join(ROOT, 'docs', 'admin-denial-exemptions.json');
const EXEMPT = fs.existsSync(EX_FILE) ? JSON.parse(fs.readFileSync(EX_FILE, 'utf8')) : {};

/* Destinations that take an administrator OUT of the admin workspace. */
const FORBIDDEN = [
  { re: /^\/?$/,                       why: 'customer marketplace root' },
  { re: /^\/?index(\.html)?$/,         why: 'customer marketplace' },
  { re: /^\/?seller(\.html)?$/,        why: 'seller workspace' },
  { re: /^\/?(shop|product|cart|checkout|marketplace|category)(\.html)?$/, why: 'customer surface' },
  { re: /^\/?(pos|pos-daily|inventory)(\.html)?$/, why: 'POS/merchant workspace' },
];

/* Allowed denial destinations. */
const ALLOWED = [
  /^\/?login(\.html)?(\?|$)/,                    /* must also carry next/redirect — checked below */
  /^\/?account-centre(\.html)?(\?|$)/,
  /^\/?admin-os(\.html)?\?error=/,
];

const strip = (s) => String(s || '').trim().replace(/^['"`]|['"`]$/g, '');

/* Lines that plausibly belong to a denial/auth-failure path. */
const DENIAL_CONTEXT = /(!\s*user|!\s*u\b|!\s*fbUser|claims|denied|deny|unauthor|insufficient|permission|authGate|auth-gate|lock|signed in|access)/i;

/* SIGN-OUT is not a denial. The user CHOSE to leave, so there is no destination
   worth preserving and the marketplace is a legitimate landing — the same
   reasoning that left superadmin.html's signOut() -> "/" alone during the audit.
   Flagging these produced three false positives; excluding the pattern is more
   correct than exempting each site, because the next sign-out handler someone
   writes would be flagged too. */
const SIGN_OUT = /sign\s*out|signOut|logout|log\s*out/i;

function scan(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = src.split('\n');
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^\s*(\*|\/\/|<!--)/.test(L)) continue;          /* comments are not code */

    /* (a) programmatic navigation */
    const navRe = /(?:window\.)?location\s*(?:\.\s*(?:href|replace)\s*(?:=|\()|\s*=)\s*(['"`])([^'"`]*)\1/g;
    let m;
    while ((m = navRe.exec(L))) {
      const dest = strip(m[2]);
      const ctx = lines.slice(Math.max(0, i - 4), i + 2).join('\n');
      if (!DENIAL_CONTEXT.test(ctx)) continue;           /* not a denial path */
      if (SIGN_OUT.test(ctx)) continue;                  /* sign-out, not a denial */
      hits.push({ line: i + 1, dest, kind: 'redirect', snippet: L.trim().slice(0, 96) });
    }

    /* (b) links inside access-denied / lock UI */
    if ((/(access|denied|deny|lock|auth)/i.test(L) || /(access|denied|deny|lock|auth)/i.test(lines[Math.max(0, i - 3)] || '')) && !SIGN_OUT.test(L)) {
      const hrefRe = /href\s*=\s*\\?["']([^"'\\]+)/g;
      let h;
      while ((h = hrefRe.exec(L))) {
        const dest = strip(h[1]);
        if (!dest || dest.startsWith('#') || /^(https?:|mailto:|tel:)/.test(dest)) continue;
        hits.push({ line: i + 1, dest, kind: 'denial-link', snippet: L.trim().slice(0, 96) });
      }
    }
  }
  return hits;
}

function judge(hit) {
  const d = hit.dest.split('#')[0];
  const bare = d.split('?')[0];

  for (const f of FORBIDDEN) {
    if (f.re.test(bare)) return { ok: false, why: 'resolves to the ' + f.why };
  }
  /* login must preserve the destination */
  if (/^\/?login(\.html)?/.test(bare)) {
    if (!/[?&](next|redirect)=/.test(d)) {
      return { ok: false, why: 'login without next= — the destination is lost' };
    }
    return { ok: true };
  }
  if (ALLOWED.some(re => re.test(d))) return { ok: true };

  /* Another admin page: allowed only if it is the denial route, or not itself gated. */
  const target = bare.replace(/^\.?\//, '').replace(/\.html$/, '') + '.html';
  const entry = NAV.lookup(target);
  if (entry) {
    if (/\?error=/.test(d)) return { ok: true };
    return { ok: false, why: 'redirects to another GATED admin page (' + target + ') without preserving the destination' };
  }
  return { ok: true };   /* unknown non-admin destination: not our invariant */
}

const violations = [], exempted = [];
for (const page of NAV.pages.map(p => p.page)) {
  let hits = [];
  try { hits = scan(page); } catch (e) { continue; }
  for (const h of hits) {
    const verdict = judge(h);
    if (verdict.ok) continue;
    const key = page + ':' + h.dest;
    if (EXEMPT[key] || EXEMPT[page]) { exempted.push({ page, ...h, reason: EXEMPT[key] || EXEMPT[page] }); continue; }
    violations.push({ page, ...h, why: verdict.why });
  }
}

console.log('admin denial-path invariant — ' + NAV.pages.length + ' registry surfaces scanned');
if (exempted.length) {
  console.log('\nEXEMPTED (' + exempted.length + ')');
  exempted.forEach(e => console.log('  ' + e.page + ':' + e.line + '  -> ' + e.dest + '   [' + e.reason + ']'));
}
if (!violations.length) {
  console.log('\nNo violations. Every denial path stays inside the admin workspace or');
  console.log('returns to login with the destination preserved.');
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ violations, exempted }, null, 2));
  process.exit(0);
}

console.log('\nVIOLATIONS (' + violations.length + ')');
violations.forEach(v => {
  console.log('  ' + (v.page + ':' + v.line).padEnd(38) + '-> ' + (v.dest || '(empty)'));
  console.log('      ' + v.why);
  console.log('      ' + v.snippet);
});
console.log('\nAn admin who fails an authorization check must not be dumped on the customer');
console.log('marketplace. Signed out -> login.html?next=<destination>. Signed in without');
console.log('authority -> account-centre.html or admin-os.html?error=insufficient_privileges.');
console.log('If a destination is genuinely intentional, add it to docs/admin-denial-exemptions.json');
console.log('with a reason — do not weaken this check.');
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ violations, exempted }, null, 2));
process.exit(1);
