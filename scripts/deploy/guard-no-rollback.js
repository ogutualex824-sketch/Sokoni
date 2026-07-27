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

  console.log(`  [rollback-guard] local ${head.slice(0, 7)} is not behind live ${live.commit.slice(0, 7)} — allowing deploy.`);
})();
