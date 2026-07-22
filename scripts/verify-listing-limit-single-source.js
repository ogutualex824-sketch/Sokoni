#!/usr/bin/env node
'use strict';
/**
 * LISTING-LIMIT SINGLE-SOURCE GUARD — fails the deploy if a second marketplace
 * seller listing allowance appears.
 *
 * Modelled on verify-commission-single-source.js, which already holds the same
 * line for commission rates. The failure it prevents is identical in shape: the
 * marketplace free tier granted 3 or 10 listings depending on which file was
 * asked, the dashboard and the pricing page disagreed, and every copy looked
 * authoritative on its own.
 *
 * functions/subscription-catalog.js is the only place a MARKETPLACE SELLER
 * listing allowance may be defined.
 *
 * WHAT IS DELIBERATELY NOT IN SCOPE
 * Other products have their own allowances and are not duplicates: AI Creative
 * Studio tiers, service-provider onboarding, the property and vehicle verticals,
 * SaaS plan tiers. Collapsing those into the marketplace catalogue would destroy
 * real product distinctions. An audit that treated them as drift was wrong, and
 * this guard encodes the distinction rather than repeating the mistake — every
 * one of them is allow-listed WITH THE REASON it is a different product.
 *
 * ON DETECTING DEAD TABLES
 * A second check reports plan tables whose identifier is barely referenced. It
 * is a WARNING and never fails the build, because it cannot prove deadness and
 * must not be described as if it can. MKT_PLANS in subscription-os.js — a table
 * that is genuinely dead — WOULD NOT be caught by it: the identifier is read
 * once, and what is actually dead is the property downstream of that read.
 * Proving that needs dataflow analysis this script does not attempt. It is
 * offered as a lead to investigate, not a verdict.
 *
 * Run: node scripts/verify-listing-limit-single-source.js
 */
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const CANON  = 'functions/subscription-catalog.js';

/* Field names a marketplace listing allowance has been written under. All four
   were found in the same codebase at the same time, which is how the drift
   stayed invisible: a search for two of them reported "only one catalogue". */
const LIMIT_FIELDS = ['listings', 'listingLimit', 'maxListings', 'maxProducts', 'listings_limit'];

/* Files permitted to declare a listing allowance, each with the reason it is not
   a duplicate of the marketplace catalogue. Adding to this list is a deliberate,
   reviewable act — which is the point. */
const ALLOWLIST = {
  [CANON]: 'THE single source of truth for marketplace seller listings',
  'scripts/verify-listing-limit-single-source.js': 'this guard',
  'scripts/verify-commission-single-source.js':    'sibling guard; matches on rate shapes',

  /* Different products. Not the marketplace seller plan. */
  'functions/provider-onboarding.js': 'service-PROVIDER onboarding tiers — a different product',
  'functions/sasos-core.js':          'SaaS plan tiers for the property and vehicle verticals',
  'functions/sub-billing.js':         'per-vertical billing (property, vehicle) — different products',
  'functions/subscription-core.js':   'resolution seam across subscription shapes, not a table',

  /* Known marketplace duplicates, retained here as a TODO with an expiry rather
     than silently passing. Each is scheduled for migration; the guard reports
     them every run so they cannot be forgotten. */
  'functions/subscription-os.js': 'KNOWN DEAD — MKT_PLANS has no consumer; delete pending',
  'sokoni-pay.js':                'KNOWN DUPLICATE — SokoniPay.PLANS; migration pending',
  'sokoni-subscriptions.js':      'KNOWN DUPLICATE — client PLANS table; migration pending',
  'subscriptions.html':           'KNOWN DUPLICATE — pricing page; migration pending',
  'functions/index.js':           'KNOWN DUPLICATE — agrees with canonical (10); migration pending',
};

/* Entries above that are duplicates awaiting migration rather than legitimately
   separate products. Reported loudly every run so the allowlist cannot quietly
   become a permanent excuse. */
const PENDING_MIGRATION = new Set([
  'functions/subscription-os.js', 'sokoni-pay.js', 'sokoni-subscriptions.js',
  'subscriptions.html', 'functions/index.js',
]);

const errors = [];
const pending = [];
const deadLeads = [];

function repoFiles() {
  return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(js|html)$/.test(f) && !f.startsWith('node_modules'))
    /* git lists files deleted from the working tree; reading one throws ENOENT
       and would take the guard down — which fails OPEN. Skip instead. */
    .filter(f => fs.existsSync(path.join(ROOT, f)));
}

/* Comments are stripped before matching. Five assertions in this codebase have
   previously passed or failed against comment text rather than code, including
   ones describing the very defect being searched for. */
function stripComments(src) {
  /* Newlines inside a block comment are PRESERVED. Deleting them collapses the
     line count, so every line number after the first block comment is reported
     wrong — this guard's first run pointed at launch-readiness.html:513 and
     sokoni-subscription.js:10, neither of which contained anything it matched.
     A guard that names the wrong line sends the reader to innocent code and
     gets dismissed as noise. */
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = repoFiles();

for (const rel of files) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const src = stripComments(raw);

  /* A listing allowance looks like `listings: 3` or `maxProducts: -1`. Demo and
     display data uses the same field name for a COUNT of listings a seller has,
     which is not an allowance — those appear inside object literals carrying a
     name/rating/id, so a line mentioning any of those is not a plan row. */
  const re = new RegExp('\\b(' + LIMIT_FIELDS.join('|') + ')\\s*:\\s*(-?\\d+)', 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    const text = src.split('\n')[line - 1] || '';
    /* Demo/display rows use the same field name for a COUNT of listings a host
       has. They are identified by rating/phone/verified/icon — NOT by carrying a
       `name`, which was the first version of this filter and which silently
       excluded every genuine plan row, `{ key:"free", name:"Free", listings:3 }`
       among them. A guard that hides the defect it exists to find is worse than
       no guard, because it reports PASS while doing it. */
    if (/\b(rating|phone|verified|icon)\s*:/.test(text)) continue;

    /* `listings: 0` inside `{ sellers:0, listings:0, bugs:0 }` is a metrics
       accumulator, not an allowance — launch-readiness.html tallies platform
       stats under the same field name. Excluded by VALUE rather than context: a
       plan granting zero listings is not a plan, so every legitimate allowance
       is non-zero and nothing real is lost.

       The first attempt required a plan marker in the preceding lines. It
       removed launch-readiness and also silently dropped sokoni-subscriptions.js
       and sokoni-subscription.js, whose rows sit under a `const PLANS = {`
       header carrying none of those keywords. Trading one false positive for two
       false negatives makes a guard that reports PASS while concealing the
       duplicates it exists to find. */
    if (Number(m[2]) === 0) continue;

    const hit = { file: rel, line, field: m[1], value: m[2] };
    if (ALLOWLIST[rel]) {
      if (PENDING_MIGRATION.has(rel)) pending.push(hit);
    } else {
      errors.push(hit);
    }
  }
}

/* Heuristic lead, never a failure. See the header: this cannot prove deadness. */
for (const rel of files.filter(f => f.endsWith('.js'))) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const decl = /\bconst\s+([A-Z][A-Z0-9_]{3,})\s*=\s*(?:Object\.freeze\()?\{/g;
  let d;
  while ((d = decl.exec(src)) !== null) {
    const name = d[1];
    const body = src.slice(d.index, d.index + 900);
    if (!LIMIT_FIELDS.some(f => new RegExp('\\b' + f + '\\s*:').test(body))) continue;
    const uses = (src.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length - 1;
    if (uses <= 1) deadLeads.push({ file: rel, name, uses });
  }
}

console.log('\nListing-limit single-source guard\n');
console.log('  source of truth : ' + CANON);
console.log('  files scanned   : ' + files.length);
console.log('  allow-listed    : ' + Object.keys(ALLOWLIST).length + ' (' +
            (Object.keys(ALLOWLIST).length - PENDING_MIGRATION.size) + ' separate products, ' +
            PENDING_MIGRATION.size + ' pending migration)\n');

if (pending.length) {
  console.log('  PENDING MIGRATION — allow-listed duplicates, not yet converged:');
  const byFile = {};
  pending.forEach(p => { (byFile[p.file] = byFile[p.file] || []).push(p.field + ':' + p.value); });
  Object.entries(byFile).forEach(([f, vals]) =>
    console.log('    ' + f.padEnd(34) + vals.slice(0, 6).join('  ') + (vals.length > 6 ? '  …' : '')));
  console.log('');
}

if (deadLeads.length) {
  console.log('  DEAD-TABLE LEADS (heuristic — investigate, does not fail the build):');
  deadLeads.forEach(l => console.log('    ' + l.file.padEnd(34) + l.name + '  — ' +
    (l.uses === 0 ? 'never referenced' : 'referenced once')));
  console.log('');
}

if (errors.length) {
  console.log('  FAIL — a marketplace listing allowance was declared outside the canonical catalogue:\n');
  errors.forEach(e => console.log('    ' + e.file + ':' + e.line + '   ' + e.field + ': ' + e.value));
  console.log('\n  Import functions/subscription-catalog.js instead, or add the file to');
  console.log('  ALLOWLIST with the reason it is a genuinely different product.\n');
  process.exit(1);
}

console.log('  PASS — no NEW marketplace listing allowance outside the canonical catalogue.');
if (pending.length) {
  console.log('  ' + Object.keys(pending.reduce((a, p) => (a[p.file] = 1, a), {})).length +
              ' known duplicate file(s) still pending migration — see above.');
}
console.log('');
