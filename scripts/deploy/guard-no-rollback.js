#!/usr/bin/env node
/**
 * guard-no-rollback.js — refuse a hosting deploy that would ROLL BACK production.
 *
 * WHY. This repo is worked by many parallel processes, each in its own git
 * worktree pinned to a different (often older) commit. Firebase hosting deploys
 * whatever files are in the worktree that runs the deploy — not the latest code.
 * So a deploy kicked from a stale worktree silently OVERWRITES live pages with an
 * older version (observed: the earnings page and the service-worker counter both
 * regressed this way). The user sees a page that "updated yesterday, rolled back
 * today."
 *
 * This guard runs as the FIRST hosting predeploy hook. It reads the version.json
 * already live in production and compares its commit to this worktree's HEAD:
 *   - HEAD == live commit          → redeploy of the same build, allowed.
 *   - HEAD is an ANCESTOR of live   → this tree is BEHIND live → ROLLBACK → abort.
 *   - otherwise (ahead / diverged / live commit unknown here) → allowed.
 *
 * Fail-open by design: if production is unreachable or version.json is missing,
 * the deploy proceeds — a network blip must never block a legitimate release.
 *
 * LIMITATION (honest): a worktree pinned to a commit from BEFORE this guard was
 * added does not carry this hook and so cannot be stopped by it. The durable cure
 * is operational — only deploy from the latest branch. This closes the common
 * case for every deploy that runs the current predeploy chain.
 */
'use strict';

const cp    = require('child_process');
const https = require('https');

const LIVE_VERSION_URL = 'https://mysokoni.co.ke/version.json';
const TIMEOUT_MS = 8000;

function git(args) {
  try { return cp.execSync('git ' + args, { encoding: 'utf8' }).trim(); }
  catch (e) { return ''; }
}

function fetchLiveVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      LIVE_VERSION_URL,
      { timeout: TIMEOUT_MS, headers: { 'Cache-Control': 'no-cache' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  const live = await fetchLiveVersion();

  if (!live || !live.commit || live.commit === 'unknown') {
    console.log('  [rollback-guard] live version.json unavailable — allowing deploy (fail-open).');
    return;
  }

  const head = git('rev-parse HEAD');
  if (!head) {
    console.log('  [rollback-guard] cannot resolve local HEAD — allowing deploy.');
    return;
  }

  if (head === live.commit) {
    console.log(`  [rollback-guard] tree is at the live commit (${head.slice(0, 7)}) — allowing redeploy.`);
    return;
  }

  /* `git merge-base --is-ancestor A B` exits 0 iff A is an ancestor of B.
     If the live commit is not in this worktree's object store the command errors,
     which we treat as "not behind" (fail-open) rather than blocking. */
  let headIsBehindLive = false;
  try {
    cp.execSync(`git merge-base --is-ancestor ${head} ${live.commit}`, { stdio: 'ignore' });
    headIsBehindLive = true;
  } catch (e) {
    headIsBehindLive = false;
  }

  if (headIsBehindLive) {
    console.error('');
    console.error('  ✖ [rollback-guard] REFUSING TO DEPLOY — this would roll back production.');
    console.error(`      This worktree HEAD : ${head.slice(0, 7)} (${git('rev-parse --abbrev-ref HEAD') || 'detached'})`);
    console.error(`      Already live       : ${live.commit.slice(0, 7)}  built ${live.buildTime || '?'}  (${live.cacheVersion || '?'})`);
    console.error('      Your tree is an ANCESTOR of what is live — older code.');
    console.error('      Fix: deploy from the latest branch (git pull / checkout the newest commit), then retry.');
    console.error('');
    process.exit(1);
  }

  /* ── DIVERGENCE ────────────────────────────────────────────────────────────
     "Not an ancestor of live" is not the same as "safe". A branch that forked
     before the live commit is neither behind nor ahead — it is DIVERGED, and
     deploying it reverts every file the live side advanced since the fork.
     Hosting publishes the working TREE, so that revert is total: it is not
     limited to the files this branch happens to have touched.

     This guard used to allow that case explicitly. It was caught on
     release/delivery-security, whose branch had forked 54 commits earlier: the
     guard printed "allowing deploy" for a tree that would have rolled back 110
     files including settlement-engine.js, settlement-executor.js and
     order-settlement.js. Being merely not-behind is the weaker claim; the
     question is whether live's commit is CONTAINED in this tree. */
  let liveIsContained = false;
  try {
    cp.execSync(`git merge-base --is-ancestor ${live.commit} ${head}`, { stdio: 'ignore' });
    liveIsContained = true;
  } catch (e) {
    /* Also reached when the live commit is not in this object store. Fetching is
       the caller's job; an unknown live commit is treated as diverged and
       reported as such below, rather than waved through. */
    liveIsContained = false;
  }

  if (!liveIsContained) {
    let ahead = '?', behind = '?';
    try {
      const counts = cp.execSync(`git rev-list --left-right --count ${live.commit}...${head}`,
        { encoding: 'utf8' }).trim().split(/\s+/);
      behind = counts[0]; ahead = counts[1];
    } catch (_) {}
    console.error('');
    console.error('  ✖ [rollback-guard] REFUSING TO DEPLOY — this tree has DIVERGED from production.');
    console.error(`      This worktree HEAD : ${head.slice(0, 7)} (${git('rev-parse --abbrev-ref HEAD') || 'detached'})`);
    console.error(`      Already live       : ${live.commit.slice(0, 7)}  built ${live.buildTime || '?'}`);
    console.error(`      Commits only on live: ${behind}   only here: ${ahead}`);
    console.error('      The live commit is NOT contained in this tree, so deploying would revert');
    console.error('      every file production advanced since the fork — hosting publishes the whole');
    console.error('      tree, not just the files you changed.');
    console.error('      Fix: merge or rebase onto the live branch, re-run the regression, then retry.');
    console.error('');
    process.exit(1);
  }

  console.log(`  [rollback-guard] local ${head.slice(0, 7)} contains live ${live.commit.slice(0, 7)} — allowing deploy.`);
})();
