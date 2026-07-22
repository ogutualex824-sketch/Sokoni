#!/usr/bin/env node
'use strict';
/**
 * LISTING-LIMIT SINGLE-SOURCE GUARD — fails the deploy if a marketplace seller
 * listing allowance is declared outside the canonical catalogue.
 *
 * Modelled on verify-commission-single-source.js, which already holds this line
 * for commission rates and passes. The failure it prevents is the same shape:
 * the marketplace free tier granted 3 or 10 listings depending on which file was
 * asked, the dashboard and the pricing page disagreed, and every copy looked
 * authoritative on its own.
 *
 * functions/subscription-catalog.js is the only place a MARKETPLACE SELLER
 * listing allowance may be defined.
 *
 * CLASSIFICATION IS THE MECHANISM
 * Every file declaring an allowance must be classified. An UNCLASSIFIED
 * declaration fails, so a new table cannot appear without someone deciding, in
 * review, what kind of thing it is. That decision is recorded here as a
 * judgement with the evidence behind it — this script never infers it.
 * Distinguishing "enforced" from "merely displayed" requires dataflow analysis
 * across a callable boundary, and a guard that guessed would eventually
 * misclassify a table that moves money.
 *
 * WHY ADVERTISED_ONLY BLOCKS
 * A number shown to a merchant that the platform will not honour is a product
 * defect, not an accepted exception. universal-onboarding tells a merchant the
 * Free Trial includes 50 listings; canPublishProduct enforces 10. Two systems
 * disagreeing is a bug. Promising 50 and delivering 10 is a broken promise, and
 * it should be at least as loud.
 *
 * ON DETECTING DEAD TABLES
 * The dead-table check is a WARNING that never fails the build, because it
 * cannot prove deadness. MKT_PLANS in subscription-os.js — genuinely dead —
 * would NOT be caught by it: the identifier is read once, and what is dead is
 * the property downstream of that read. It offers leads, not verdicts.
 *
 * Run: node scripts/verify-listing-limit-single-source.js
 */
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
const CANON = 'functions/subscription-catalog.js';

/* Field names a marketplace listing allowance has been written under. All five
   coexisted, which is how the drift stayed invisible: a search for two of them
   reported "only one catalogue". */
const LIMIT_FIELDS = ['listings', 'listingLimit', 'maxListings', 'maxProducts', 'listings_limit'];

const CLASSIFICATION = {
  [CANON]: 'CANONICAL',
  'scripts/verify-listing-limit-single-source.js': 'TOOLING',
  'scripts/verify-commission-single-source.js':    'TOOLING',

  /* Separate commercial products. Collapsing these into the marketplace
     catalogue would destroy real distinctions — an earlier audit in this
     session counted them as drift and was wrong. */
  'functions/provider-onboarding.js': 'DIFFERENT_PRODUCT',
  'functions/sasos-core.js':          'DIFFERENT_PRODUCT',
  'functions/sub-billing.js':         'DIFFERENT_PRODUCT',
  'functions/subscription-core.js':   'DIFFERENT_PRODUCT',

  /* Verified 2026-07-22: onbGetPlans returns PLANS[role] straight to the client
     and nothing in the module reads limits.listings. onboardingDispatch is
     ACTIVE, so merchants see "Free Trial — 50 listings" while 10 is enforced. */
  'functions/universal-onboarding.js': 'ADVERTISED_ONLY',
  /* Verified 2026-07-22: the pricing page renders "3 active listings" for Free
     against a canonical 10. Customer-facing. */
  'subscriptions.html': 'ADVERTISED_ONLY',

  /* Verified 2026-07-22: MKT_PLANS is read into ent.mktPlan, which never enters
     the signed claims and is read by no caller. Dead, pending deletion. */
  'functions/subscription-os.js': 'DUPLICATE',
  'functions/index.js':           'DUPLICATE',
  'sokoni-pay.js':                'DUPLICATE',
  'sokoni-subscriptions.js':      'DUPLICATE',
  'sokoni-revenue.js':            'DUPLICATE',
  'sokoni-subscription.js':       'DUPLICATE',
};

const NON_BLOCKING = new Set(['CANONICAL', 'TOOLING', 'DIFFERENT_PRODUCT']);

const LEGEND = {
  CANONICAL:         'the source of truth',
  DIFFERENT_PRODUCT: 'separate commercial product — allowed',
  TOOLING:           'guards and generators — allowed',
  ADVERTISED_ONLY:   'shown to users, never enforced — a promise the platform will not honour',
  DUPLICATE:         'declares marketplace limits independently — migrate to the canonical catalogue',
  UNCLASSIFIED:      'NEW — classify it in CLASSIFICATION before it can pass',
};
const ORDER = ['CANONICAL', 'DIFFERENT_PRODUCT', 'TOOLING', 'ADVERTISED_ONLY', 'DUPLICATE', 'UNCLASSIFIED'];

function repoFiles() {
  return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(js|html)$/.test(f) && !f.startsWith('node_modules'))
    /* git lists files deleted from the working tree; reading one throws ENOENT
       and would take the guard down — failing OPEN. Skip instead. */
    .filter(f => fs.existsSync(path.join(ROOT, f)));
}

/* Newlines inside block comments are PRESERVED. Deleting them collapses the line
   count and every reported line number after the first comment is wrong — the
   first run of this guard pointed at two files that contained nothing it
   matched. A guard that names innocent code gets dismissed as noise. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = repoFiles();
const byClass = {};
const errors = [];
const deadLeads = [];

for (const rel of files) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const lines = src.split('\n');
  const re = new RegExp('\\b(' + LIMIT_FIELDS.join('|') + ')\\s*:\\s*(-?\\d+)', 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    const text = lines[line - 1] || '';

    /* Demo/display rows use the same field name for a COUNT of listings a host
       has. Identified by rating/phone/verified/icon — NOT by carrying a `name`,
       which was the first version of this filter and excluded every genuine plan
       row, `{ key:"free", name:"Free", listings:3 }` among them. It reported
       PASS while looking straight at the duplicate. */
    if (/\b(rating|phone|verified|icon)\s*:/.test(text)) continue;

    /* `listings: 0` inside `{ sellers:0, listings:0, bugs:0 }` is a metrics
       accumulator. Excluded by VALUE: a plan granting zero listings is not a
       plan, so no real allowance is lost. An earlier attempt used a keyword
       context window instead and silently dropped two real duplicates whose rows
       sit under a bare `const PLANS = {` — one false positive traded for two
       false negatives is the worse guard. */
    if (Number(m[2]) === 0) continue;

    const cls = CLASSIFICATION[rel] || 'UNCLASSIFIED';
    const hit = { file: rel, line, field: m[1], value: m[2], cls };
    (byClass[cls] = byClass[cls] || []).push(hit);
    if (!NON_BLOCKING.has(cls)) errors.push(hit);
  }
}

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
console.log('  classified      : ' + Object.keys(CLASSIFICATION).length + ' files\n');

for (const cls of ORDER) {
  const hits = byClass[cls];
  if (!hits || !hits.length) continue;
  console.log('  [' + (NON_BLOCKING.has(cls) ? 'ok  ' : 'FAIL') + '] ' + cls + ' — ' + LEGEND[cls]);
  const byFile = {};
  hits.forEach(h => { (byFile[h.file] = byFile[h.file] || []).push(h); });
  Object.entries(byFile).forEach(([f, hs]) => {
    const vals = hs.map(h => h.field + ':' + h.value);
    console.log('           ' + f.padEnd(36) + vals.slice(0, 5).join('  ') + (vals.length > 5 ? '  …' : ''));
    if (!NON_BLOCKING.has(cls)) console.log('           ' + ' '.repeat(36) + 'first at ' + f + ':' + hs[0].line);
  });
  console.log('');
}

if (deadLeads.length) {
  console.log('  DEAD-TABLE LEADS (heuristic — investigate; never fails the build):');
  deadLeads.forEach(l => console.log('    ' + l.file.padEnd(36) +
    l.name + '  — ' + (l.uses === 0 ? 'never referenced' : 'referenced once')));
  console.log('');
}

if (errors.length) {
  const files_ = [...new Set(errors.map(e => e.file))];
  console.log('  FAIL — ' + errors.length + ' declaration(s) across ' + files_.length + ' file(s) need migration.');
  console.log('  Import ' + CANON + ', or classify the file as DIFFERENT_PRODUCT');
  console.log('  with the evidence that it is one.\n');
  process.exit(1);
}

console.log('  PASS — every marketplace listing allowance resolves from the canonical catalogue.\n');
