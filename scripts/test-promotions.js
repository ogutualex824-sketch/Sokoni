#!/usr/bin/env node
/**
 * test-promotions.js
 *
 * Guards the two rules that stop a promotion engine becoming an ad network:
 *   1. Every placement has a HARD CAP, enforced server-side. Admins compete for a
 *      slot; they do not accumulate into one.
 *   2. Promotions can NEVER appear on money surfaces (checkout, payment, wallet,
 *      dispute, refund). A banner between a user and their money destroys trust.
 *
 * Both are product decisions. If someone later "just raises the cap a bit" or adds
 * checkout to the placement list, this fails the build — which is the point.
 */
'use strict';
const path = require('path');
const fs   = require('fs');
const { PLACEMENTS, FORBIDDEN_PLACEMENTS } = require(path.resolve('functions/promotions.js'));

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

console.log('\nPromotion engine — guardrails\n');

/* 1. Money surfaces are forbidden. */
for (const p of ['checkout', 'payment', 'wallet', 'dispute', 'refund']) {
  FORBIDDEN_PLACEMENTS.has(p)
    ? ok(`"${p}" is a forbidden placement`)
    : bad(`"${p}" is NOT forbidden — a promotion could be placed between a user and their money`);
  PLACEMENTS[p]
    ? bad(`"${p}" appears in PLACEMENTS — a money surface must never be a promotable slot`)
    : null;
}
if (!['checkout','payment','wallet','dispute','refund'].some(p => PLACEMENTS[p])) {
  ok('no money surface appears in PLACEMENTS');
}

/* 2. Every placement is capped, and the caps stay small. */
for (const [name, cfg] of Object.entries(PLACEMENTS)) {
  if (!Number.isInteger(cfg.max) || cfg.max < 1) {
    bad(`placement "${name}" has no valid cap — an uncapped slot is an ad network`);
  } else if (cfg.max > 6) {
    bad(`placement "${name}" allows ${cfg.max} promotions — that is a feed, not a slot`);
  }
}
if (Object.values(PLACEMENTS).every(c => Number.isInteger(c.max) && c.max >= 1 && c.max <= 6)) {
  ok(`all ${Object.keys(PLACEMENTS).length} placements are capped (1–6)`);
}

/* 3. The engine must not branch on campaign type — that is what makes a new
      campaign type DATA rather than a code change. */
/* Strip comments first. The doc comment in promotions.js literally says
   "there is no if (type === 'flash_sale') anywhere in here" — scanning raw source
   matched that sentence and failed on the very comment asserting the rule. A test
   that greps source must look at CODE, not prose. */
const stripComments = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')     /* block comments */
  .replace(/(^|[^:])\/\/.*$/gm, '$1');  /* line comments (leave http:// alone) */

const src = stripComments(fs.readFileSync(path.resolve('functions/promotions.js'), 'utf8'));
const branches = src.match(/(===|==)\s*['"](flash_sale|discount|referral|seasonal|sponsored)['"]/g);
branches
  ? bad(`engine branches on campaign type (${branches.join(', ')}) — a new type would need a code change`)
  : ok('engine never branches on campaign type — new campaign types are data, not code');

/* 4. The client renderer must escape admin-authored text. An admin account is
      exactly what an attacker wants; the renderer must not trust its input. */
const client = fs.readFileSync(path.resolve('sokoni-promotions.js'), 'utf8');
/_esc\(/.test(client) && /_safeUrl\(/.test(client)
  ? ok('client escapes promotion text and validates URLs')
  : bad('client does not escape/validate admin-authored content — XSS risk via a compromised admin');

/* 5. An empty slot must render nothing at all — no skeleton, no empty frame. */
/:empty\{display:none;?\}/.test(client.replace(/\s/g, ''))
  ? ok('empty promotion slots collapse to zero height (no empty frames)')
  : bad('empty slots do not collapse — pages would show hollow promotion frames');

console.log('');
if (fail) { console.error(`Promotion guardrails FAILED (${fail})\n`); process.exit(1); }
console.log(`Promotion guardrails PASSED (${pass} checks)\n`);
