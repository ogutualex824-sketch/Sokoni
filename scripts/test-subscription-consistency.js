#!/usr/bin/env node
'use strict';

/**
 * Subscription catalogue consistency.
 *
 * An audit on 2026-07-22 found TEN plan catalogues defining a listing
 * allowance, each internally consistent and mutually contradictory: the entry
 * tier granted 1, 3, 10, 20 or 50 depending on the file, under four field names
 * (`listings`, `maxListings`, `maxProducts`, `listings_limit`).
 *
 * Three symptoms that looked unrelated came from that one cause — the dashboard
 * showed 3 listings, the pricing page showed a different plan, and uploads
 * stopped at 3. Nothing was broken; the subsystems simply disagreed.
 *
 * This is a RATCHET, not an absolute. Demanding one catalogue today would fail
 * on the first run and be disabled by the second. It records the current count
 * and fails when an ELEVENTH appears — blocking the next duplicate at the
 * moment it is written, while the consolidation lands file by file. Tighten the
 * baseline as each legacy catalogue is retired.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'subscription-catalog-baseline.json');
const UPDATE = process.argv.includes('--update');

const CANONICAL = 'functions/subscription-catalog.js';

/* A plan catalogue is a file that assigns a numeric listing allowance to a
   named tier. Matching the value as well as the key avoids counting a consumer
   that merely reads `limits.listings` — a reader is not a catalogue, and
   conflating the two is how a count stops meaning anything. */
const ALLOWANCE = /\b(listings|listings_limit|maxListings|listingLimit|maxProducts|productLimit)\s*:\s*-?\d+/;

const SKIP = /node_modules|[\\/]\.claude[\\/]|[\\/]\.git[\\/]|[\\/]docs[\\/]|[\\/]archive[\\/]|cf-complete-audit|test-subscription-consistency|perf-guard/;

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

/* An allowance key alone is not a catalogue. `listings: 47` in a property file
   is a count of listings that exist, not a limit on how many may be created —
   counting those inflated the first run from 10 to 13 and would have baselined
   a number that meant nothing.

   A catalogue assigns an allowance to a NAMED TIER, so the match must sit near
   plan vocabulary. Checking a window around each match rather than the whole
   file avoids the opposite error: a file that merely mentions "plan" somewhere
   does not become a catalogue because of it. */
const TIER_WORDS = /\b(tier|plan|price|priceKES|commission|free|starter|basic|pro|growth|business|enterprise|premium)\b/i;

const catalogues = [];
for (const f of walk(ROOT)) {
  let t = '';
  try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  if (!ALLOWANCE.test(t)) continue;

  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const values = [];
  const re = /\b(listings|listings_limit|maxListings|listingLimit|maxProducts|productLimit)\s*:\s*(-?\d+)/g;
  let m;
  while ((m = re.exec(t))) {
    const window = t.slice(Math.max(0, m.index - 220), m.index + 220);
    if (TIER_WORDS.test(window)) values.push(m[1] + '=' + m[2]);
  }
  if (values.length) catalogues.push({ file: rel, sample: [...new Set(values)].slice(0, 4) });
}

/* Client-side catalogues are called out separately because they are a
   different severity. A browser file that encodes a business rule can never be
   authoritative — the device holding it is the party the limit applies to. */
const clientSide = catalogues.filter((c) => !c.file.startsWith('functions/'));

const totals = { catalogues: catalogues.length, clientSide: clientSide.length };

if (UPDATE) {
  fs.writeFileSync(BASELINE, JSON.stringify({ totals, recorded: 'manual' }, null, 2) + '\n');
  console.log('[subscription-consistency] baseline updated: ' + JSON.stringify(totals));
  process.exit(0);
}

let baseline = null;
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).totals; } catch (_) {}

console.log('\n[subscription-consistency]');
console.log('  canonical catalogue present : ' + (fs.existsSync(path.join(ROOT, CANONICAL)) ? 'yes' : 'NO'));
console.log('  plan catalogues found       : ' + totals.catalogues +
            (baseline ? '   (baseline ' + baseline.catalogues + ')' : ''));
console.log('  of which client-side        : ' + totals.clientSide +
            (baseline ? '   (baseline ' + baseline.clientSide + ')' : ''));
console.log('');
catalogues.forEach((c) => console.log('    ' + c.file.padEnd(44) + c.sample.join(' ')));

const fails = [];
if (!fs.existsSync(path.join(ROOT, CANONICAL))) {
  fails.push('canonical catalogue ' + CANONICAL + ' is missing');
}
if (baseline) {
  if (totals.catalogues > baseline.catalogues) {
    fails.push('an ELEVENTH plan catalogue appeared: ' + totals.catalogues + ' > ' + baseline.catalogues +
               '. Import ' + CANONICAL + ' instead of defining plan limits again.');
  }
  if (totals.clientSide > baseline.clientSide) {
    fails.push('a new CLIENT-SIDE plan catalogue appeared: ' + totals.clientSide + ' > ' + baseline.clientSide +
               '. The client renders entitlements; it must never define them.');
  }
}

if (fails.length) {
  console.log('\n  FAIL:');
  fails.forEach((f) => console.log('    ' + f));
  process.exit(1);
}

console.log('\n  PASS — no new plan catalogue. ' +
            (baseline && baseline.catalogues > 1
              ? 'Consolidation still owed: ' + baseline.catalogues + ' catalogues remain, target 1.'
              : ''));
