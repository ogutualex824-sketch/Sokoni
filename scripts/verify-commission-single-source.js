#!/usr/bin/env node
'use strict';
/**
 * COMMISSION SINGLE-SOURCE GUARD — fails the deploy if a second commission table appears.
 *
 * The platform had NINE commission tables. They disagreed, and which one applied depended on
 * which payment rail the customer happened to use: a KES 10,000 legal consultation cost KES 500
 * on one rail and KES 1,200 on another. Nobody chose that — it was two stacks growing apart,
 * and it stayed invisible because every copy looked authoritative on its own.
 *
 * functions/commission-config.js is now the only place a commission rate may be defined.
 * This script enforces it. It is not a linter suggestion; it exits non-zero and stops a deploy.
 *
 * It checks:
 *   1. the deleted tables have not come back (HUB_COMMISSION_DEFAULTS, DEFAULT_COMMISSION_RATES,
 *      COMMISSION_RATES.completion / .platform)
 *   2. the generated client snapshot is in sync with the config
 *   3. no NEW hardcoded commission rate map has been introduced
 *   4. no caller resurrects a magic fallback (`|| 10`) on a commission lookup
 *
 * Known rate tables that are NOT commission-per-transaction (subscription plan pricing, SaaS
 * plan tiers, payroll bands, tax rates) are allow-listed below WITH A REASON. Adding to that
 * list is a deliberate, reviewable act — which is the point.
 *
 * Run: node scripts/verify-commission-single-source.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG = 'functions/commission-config.js';

/* Files permitted to contain rate-shaped constants, each with the reason it is not a
   duplicate of the commission table. */
const ALLOWLIST = {
  'functions/commission-config.js': 'THE single source of truth',
  'sokoni-commission-rates.js':     'generated from commission-config.js; verified in check 2',
  'scripts/verify-commission-single-source.js': 'this guard',
  'scripts/build-commission-snapshot.js':       'the generator',
  /* Different concepts that legitimately carry rates. Not commission-per-transaction. */
  'functions/subscription-core.js':    'subscription PLAN pricing (what a seller pays for a plan)',
  'functions/provider-onboarding.js':  'provider PLAN tiers',
  'functions/sasos-core.js':           'SaaS plan tiers',
  'functions/hr-payroll.js':           'Kenya PAYE/NHIF/NSSF statutory bands',
  'functions/finos-utils.js':          'TAX_CONFIG (VAT/WHT) — tax, not commission',
  'functions/shared/constants.js':     'VAT/WHT/DST tax constants',
};

const errors = [];
const warnings = [];

function repoFiles() {
  const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(f => /\.(js|html)$/.test(f) && !f.startsWith('node_modules'));
}

/* Blank out comments before scanning, preserving line numbers.
   Without this the guard flags its own documentation: the comments that explain WHY a table
   was removed necessarily name the table and quote its old rates. A guard that punishes you
   for documenting the bug you fixed is a guard people delete. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))   // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))  // line comments (not URLs)
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));   // HTML comments
}

const files = repoFiles();
const SRC = {};
for (const f of files) SRC[f] = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));

/* ── 1. the deleted tables must not return ─────────────────────────────────── */
const BANNED = [
  { re: /\bHUB_COMMISSION_DEFAULTS\b/,           what: 'HUB_COMMISSION_DEFAULTS (removed — use commission-config)' },
  { re: /\bDEFAULT_COMMISSION_RATES\b/,          what: 'DEFAULT_COMMISSION_RATES (removed — use commission-config)' },
  { re: /COMMISSION_RATES\s*[.?[]*\s*(completion|platform)\b/, what: 'COMMISSION_RATES.completion/.platform (removed — use SokoniCommission.pct)' },
  { re: /\bHUB_RATES\b/,                         what: 'HUB_RATES (a hand-copied mirror of the server table)' },
];
for (const f of files) {
  if (ALLOWLIST[f]) continue;
  const src = SRC[f];
  for (const b of BANNED) {
    if (b.re.test(src)) {
      const line = src.split('\n').findIndex(l => b.re.test(l)) + 1;
      errors.push(f + ':' + line + '  reintroduces ' + b.what);
    }
  }
}

/* ── 2. the generated client snapshot must match the config ────────────────── */
try {
  execSync('node scripts/build-commission-snapshot.js --check', { cwd: ROOT, stdio: 'pipe' });
} catch (e) {
  errors.push('sokoni-commission-rates.js is STALE — regenerate with '
    + 'node scripts/build-commission-snapshot.js');
}

/* ── 3. no NEW hardcoded commission rate map ───────────────────────────────── */
/* A map literal whose keys are hub/category names and whose values are bare numbers, sitting
   next to the word "commission". That is the shape every one of the nine tables had. */
const HUBWORDS = /(marketplace|healthcare|legal|property|vehicles|hospitality|entertainment|food_delivery|restaurant|classifieds)\s*:\s*\d/;
const NEAR_COMMISSION = /commission/i;
for (const f of files) {
  if (ALLOWLIST[f]) continue;
  const src = SRC[f];
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    if (!HUBWORDS.test(l)) return;
    /* look at a small window for the word "commission" / "rate" */
    const win = lines.slice(Math.max(0, i - 6), i + 3).join('\n');
    if (NEAR_COMMISSION.test(win) && !/verify-commission|commission-config|SokoniCommission/.test(win)) {
      errors.push(f + ':' + (i + 1) + '  looks like a NEW commission rate table: ' + l.trim().slice(0, 60));
    }
  });
}

/* ── 3b. bare-literal commission rates ─────────────────────────────────────────
   The nine tables were the easy half. Five MORE commission rates were hiding as bare literals
   inside hub purchase handlers — `const platformFeeRate = 0.03;` in the middle of event-hub's
   ticket flow — which is why no audit of the "commission tables" ever found them. A rate is a
   rate whether or not it lives in an object. */
/* A plausible commission rate is 1%–30%. Restricting the range keeps the guard off Math.random()
   seeds, score weightings, and percentile maths, which are full of harmless 0.5s and 0.25s. */
const RATE = '0\\.(?:0[1-9]|[12]\\d)\\b';
const BARE_RATE = new RegExp('\\b(?:platformFee(?:Rate)?|commission(?:Rate|Pct)?|takeRate|serviceFee)\\s*=\\s*' + RATE, 'i');
const BARE_MULT = new RegExp('\\*\\s*' + RATE + '[^\\n]{0,40}(?:commission|platform\\s*fee)', 'i');
const COMMISSION_MULT = new RegExp('(?:commission|platformFee)[^\\n]{0,40}\\*\\s*' + RATE, 'i');
for (const f of files) {
  if (ALLOWLIST[f]) continue;
  SRC[f].split('\n').forEach((l, i) => {
    if (/resolveRate|SokoniCommission|calculateCommission|COMMISSION_CONFIG/.test(l)) return;
    /* VAT/WHT/DST are taxes ON the commission, not commission rates. They have their own
       config (TAX_CONFIG) and must not be confused with a take rate. */
    if (/\bvat|\bwht|\bdst|\btax/i.test(l)) return;
    if (BARE_RATE.test(l) || BARE_MULT.test(l) || COMMISSION_MULT.test(l)) {
      errors.push(f + ':' + (i + 1) + '  hardcoded commission rate: ' + l.trim().slice(0, 62));
    }
  });
}

/* ── 4. magic fallbacks on a commission lookup ─────────────────────────────── */
for (const f of files) {
  if (ALLOWLIST[f]) continue;
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  src.split('\n').forEach((l, i) => {
    if (/SokoniCommission\.pct\([^)]*\)\s*\|\|\s*\d/.test(l)) {
      errors.push(f + ':' + (i + 1) + '  magic fallback on a commission lookup — pct() always '
        + 'returns a number; a `|| N` here reintroduces a competing rate');
    }
  });
}

/* ── report ────────────────────────────────────────────────────────────────── */
console.log('Commission single-source guard\n');
console.log('  source of truth : ' + CONFIG);
console.log('  files scanned   : ' + files.length);
console.log('  allow-listed    : ' + Object.keys(ALLOWLIST).length + ' (non-commission rate tables)');

if (warnings.length) {
  console.log('\n  WARNINGS');
  warnings.forEach(w => console.log('    ' + w));
}
if (errors.length) {
  console.log('\n  FAILURES — a commission rate is defined outside ' + CONFIG + ':\n');
  errors.forEach(e => console.log('    ' + e));
  console.log('\n  Every commission rate must come from ' + CONFIG + '.');
  console.log('  Server: finos-utils.calculateCommission(db, {...})');
  console.log('  Client: SokoniCommission.pct(category)');
  console.log('\n  ' + errors.length + ' failure(s). Deploy blocked.');
  process.exit(1);
}
console.log('\n  PASS — exactly one commission table, and every consumer reads it.');
