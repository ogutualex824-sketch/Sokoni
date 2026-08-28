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
/* Raised 556 → 561 on 2026-08-27, following this comment's own instruction.
   Production was serving `sokoni-20260826230128-v561` (commit 4771b1d, the
   merchant-pipeline PIN hotfix) from a tree whose bump was never committed back —
   exactly the situation described above. With the floor at 556 and the committed
   file at v560, the next bump computed max(560,556)+1 = v561 and would have
   RESHIPPED a counter already live under a different build.

   Caught by the predeploy gate before deployment, not after. */
/* Raised 562 → 564 on 2026-08-28, following this comment's own instruction — for
   the THIRD time, which is why the mechanism changes below rather than only the
   number.

   The regression: production was serving v564 (commit 55d4b40) while this
   lineage carried a floor of 562 and a committed version.json reading v560. The
   bump computed max(560, 562) + 1 = v563 and SHIPPED IT — a counter LOWER than
   the live one. The comment above claims this class of error is "caught by the
   predeploy gate before deployment". It was not, because a hand-maintained
   constant cannot know what is live.

   Why the floor keeps going stale, measured rather than assumed: version.json is
   written by generate-version.js AT DEPLOY TIME and never committed back. A scan
   of all 272 commits touching version.json finds a maximum of v563 — while v564
   had already shipped. Git structurally undercounts, so any floor derived from
   git is a lagging indicator by construction.

   The fix is to stop deriving the floor from memory and derive it from THE
   DEPLOYED SITE. LAST_SHIPPED_V remains as a lower bound for when the network is
   unavailable, but it is no longer the only guard. */
const LAST_SHIPPED_V = 564;
/* Overridable ONLY so the regression suite can drive the real code path against a
   local server returning a chosen counter. A guard that is only ever tested by
   reading its source is not a tested guard — this one has to be shown refusing. */
const LIVE_VERSION_URL = process.env.SOKONI_LIVE_VERSION_URL || "https://mysokoni.co.ke/version.json";

/* Read the counter production is actually serving. Returns null — never a guess —
   when it cannot be established, so the caller can say the check did not run
   rather than silently treating "unknown" as "fine". */
function fetchLiveCounter() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
            /* http for the local test server, https for production — chosen by the URL
         itself so the test drives the same code, not a parallel path. */
      const https = LIVE_VERSION_URL.startsWith("http://") ? require("http") : require("https");
      const req = https.get(
        LIVE_VERSION_URL + "?cb=" + Date.now(),
        { timeout: 8000, headers: { "cache-control": "no-cache" } },
        (res) => {
          if (res.statusCode !== 200) { res.resume(); return finish(null); }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d) => { body += d; if (body.length > 65536) req.destroy(); });
          res.on("end", () => {
            try {
              const cv = JSON.parse(body).cacheVersion || "";
              const m = /-v(\d+)\s*$/.exec(cv);
              finish(m ? { n: Number(m[1]), cacheVersion: cv } : null);
            } catch (_) { finish(null); }
          });
        }
      );
      req.on("error", () => finish(null));
      req.on("timeout", () => { req.destroy(); finish(null); });
    } catch (_) { finish(null); }
  });
}

(async () => {
  const prevN = Number((/-v(\d+)\s*$/.exec(oldVer) || [])[1]) || 0;
  const live = await fetchLiveCounter();

  if (live) {
    console.log(`   live production counter: v${live.n}  (${live.cacheVersion})`);
  } else {
    console.log("");
    console.log("   ⚠ LIVE COUNTER CHECK DID NOT RUN — production version.json was unreachable.");
    console.log("     Falling back to LAST_SHIPPED_V alone, which is a LAGGING indicator: it is");
    console.log("     exactly what let v563 ship after v564. If this deploy matters, re-run with");
    console.log("     network access rather than trusting the floor.");
    console.log("");
  }

  /* The deployed counter participates in the maximum, so a lower number cannot be
     computed in the first place. The assertion below is then a belt-and-braces
     check on that arithmetic, not the primary defence. */
  const nextN = Math.max(prevN, LAST_SHIPPED_V, live ? live.n : 0) + 1;
  const newVer = `sokoni-${stamp}-v${nextN}`;

  if (live && nextN <= live.n) {
    console.error("");
    console.error("  ✖ [sw-version] REFUSING TO BUMP — computed counter is not ahead of live.");
    console.error(`      computed : v${nextN}`);
    console.error(`      live      : v${live.n}  (${live.cacheVersion})`);
    console.error("      The counter is contractually MONOTONIC: a build that ships a counter at");
    console.error("      or below the live one breaks the ordering every downstream check relies");
    console.error("      on. Raise LAST_SHIPPED_V above the live counter and retry.");
    console.error("");
    process.exit(1);
  }

  const updated = content.replace(versionRe, `const CACHE_VERSION = "${newVer}"`);
  fs.writeFileSync(SW_FILE, updated, "utf8");
  console.log(`✅ SW version bumped: ${oldVer} → ${newVer}`);
  if (live) console.log(`   strictly ahead of live v${live.n} ✓`);
})().catch((e) => {
  console.error("❌ sw-version bump failed: " + ((e && e.stack) || e));
  process.exit(1);
});
