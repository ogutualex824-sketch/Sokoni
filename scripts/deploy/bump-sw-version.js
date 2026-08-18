#!/usr/bin/env node
/**
 * SOKONI — Service Worker Version Bumper
 * Replaces the CACHE_VERSION string in service-worker.js with a date-based
 * build identifier: "sokoni-YYYYMMDDHHMMSS"
 *
 * Run from CI before the hosting deploy step:
 *   node scripts/deploy/bump-sw-version.js
 */

const fs   = require("fs");
const path = require("path");

const SW_FILE = path.resolve(__dirname, "../../service-worker.js");

if (!fs.existsSync(SW_FILE)) {
  console.error(`❌ service-worker.js not found at: ${SW_FILE}`);
  process.exit(1);
}

const now    = new Date();
const pad    = n => String(n).padStart(2, "0");
const stamp  = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
               `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
const content    = fs.readFileSync(SW_FILE, "utf8");
const versionRe  = /const CACHE_VERSION\s*=\s*["']sokoni-[^"']+["']/;
const match      = content.match(versionRe);

if (!match) {
  console.error("❌ Could not find CACHE_VERSION declaration in service-worker.js");
  process.exit(1);
}

const oldVer    = match[0].match(/["']([^"']+)["']/)[1];

/* The version must satisfy TWO contracts at once, and emitting only the
   timestamp broke the second one — blocking every hosting deploy:

     1. Unique per deploy, so each release gets a fresh cache.  -> the timestamp
     2. Ends in "-vNN", monotonically increasing.               -> the counter

   scripts/test-navigation.js asserts (2) and compares NN against the version a
   specific fix landed in, which is how the gate proves users actually receive a
   corrected worker rather than merely a different one. A bare timestamp is
   unique but not comparable, so that check could never pass and
   test-inventory --gate failed the whole deploy.

   Counter derivation: continue from the existing "-vNN" when present, else
   resume above the highest version already shipped so the sequence never goes
   backwards after the timestamp-only interlude.

   RAISED 115 -> 530 on 2026-08-18. `prevN` is read from the COMMITTED
   service-worker.js, but deploys have repeatedly been cut from dirty worktrees
   (live version.json carried "dirtyWorkingTree": true), so the bumps that shipped
   v523..v530 were never committed. The committed file still said v522. Restoring
   that worktree to its committed state for the cdfc8ab release therefore produced
   v523 — a counter that had already shipped seven versions earlier.

   Cache freshness never depended on it (the timestamp is the unique part, and it
   advanced), but contract 2 above says the counter is monotonic, and
   test-navigation.js compares NN to prove users received a corrected worker rather
   than merely a different one. A floor is what makes that true independently of
   whether anyone remembered to commit the bump — which is exactly what this
   constant was introduced for. Raise it again if production ever ships higher than
   this floor from an uncommitted tree. */
const LAST_SHIPPED_V = 530;
const prevN  = (/-v(\d+)\s*$/.exec(oldVer) || [])[1];
const nextN  = Math.max(Number(prevN) || 0, LAST_SHIPPED_V) + 1;
const newVer = `sokoni-${stamp}-v${nextN}`;
const updated   = content.replace(versionRe, `const CACHE_VERSION = "${newVer}"`);

fs.writeFileSync(SW_FILE, updated, "utf8");
console.log(`✅ SW version bumped: ${oldVer} → ${newVer}`);
