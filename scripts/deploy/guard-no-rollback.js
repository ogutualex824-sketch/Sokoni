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
 * THREE OUTCOMES, NOT TWO:
 *   - live KNOWN and contained in this tree  → allowed (same build, or ahead).
 *   - live KNOWN and not contained           → BEHIND or DIVERGED → refuse.
 *   - live NOT KNOWN                         → refuse.
 *
 * THE THIRD ONE USED TO BE "ALLOWED", AND THAT WAS THE BUG. Fail-open converted
 * "I could not establish the production pointer" into "you may overwrite
 * production" — the single inference a deploy guard must never make. Measured on
 * 2026-08-29: version.json answered HTTP 500 while serving a CORRECT body, three
 * consecutive requests, then 200 again minutes later. Inside that window this
 * guard would have waved through exactly the stale-tree deploy it exists to stop.
 *
 * A blip must still not block a legitimate release, so the read is RETRIED before
 * it is believed. What changed is the verdict after the retries are exhausted:
 * unknown is now a refusal, not permission.
 *
 * LIMITATION (honest): a worktree pinned to a commit from BEFORE this guard was
 * added does not carry this hook and so cannot be stopped by it. The durable cure
 * is operational — only deploy from the latest branch. This closes the common
 * case for every deploy that runs the current predeploy chain.
 */
'use strict';

const cp    = require('child_process');
const https = require('https');
const http  = require('http');

const LIVE_VERSION_URL_DEFAULT = 'https://mysokoni.co.ke/version.json';

/* TEST OVERRIDE, LOOPBACK ONLY. The refusal paths below are the whole point of this
   guard and they cannot be exercised against real production, so the suite needs to
   serve controlled responses. The override is confined to 127.0.0.1/localhost and
   announces itself on every run: pointed anywhere else it is ignored, and when it IS
   in effect the deploy log says so in capitals. A guard that could be silently aimed
   at a fake pointer would be worse than the fail-open it replaces. */
const _override = process.env.SOKONI_LIVE_VERSION_URL || '';
const _loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(_override);
if (_override && !_loopback) {
  console.error('  [rollback-guard] IGNORING SOKONI_LIVE_VERSION_URL — not a loopback address.');
}
const LIVE_VERSION_URL = _loopback ? _override : LIVE_VERSION_URL_DEFAULT;
if (_loopback) {
  console.error('  [rollback-guard] *** TEST MODE *** reading the live pointer from ' + LIVE_VERSION_URL);
  console.error('  [rollback-guard] *** this run proves NOTHING about a real deploy ***');
}
const TIMEOUT_MS = 8000;
const READ_ATTEMPTS = 3;      /* a blip must not block a release … */
const RETRY_MS = 1200;        /* … but an unanswered pointer must not permit one */

function git(args) {
  try { return cp.execSync('git ' + args, { encoding: 'utf8' }).trim(); }
  catch (e) { return ''; }
}

/* Returns { version } on success, or { why } naming precisely what could not be
   established. "null" is deliberately no longer a return value: the caller must be
   able to say WHY the pointer is unknown, because "unreachable", "500", "not JSON"
   and "no commit field" are different production conditions and a deploy log that
   cannot tell them apart is not evidence of anything. */
function readLiveVersionOnce() {
  return new Promise((resolve) => {
    const req = (LIVE_VERSION_URL.startsWith('http://') ? http : https).get(
      LIVE_VERSION_URL,
      { timeout: TIMEOUT_MS, headers: { 'Cache-Control': 'no-cache' } },
      (res) => {
        const status = res.statusCode;
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (status !== 200) return resolve({ why: 'HTTP ' + status });
          let j;
          try { j = JSON.parse(body); }
          catch (e) { return resolve({ why: 'body is not JSON (' + body.slice(0, 40).replace(/\s+/g, ' ') + ')' }); }
          if (!j || !j.commit || j.commit === 'unknown') return resolve({ why: 'no usable commit field' });
          if (!/^[0-9a-f]{7,40}$/.test(String(j.commit))) return resolve({ why: 'commit is not a sha: ' + String(j.commit).slice(0, 24) });
          return resolve({ version: j });
        });
      }
    );
    req.on('error', (e) => resolve({ why: 'request failed: ' + ((e && e.code) || e) }));
    req.on('timeout', () => { req.destroy(); resolve({ why: 'timed out after ' + TIMEOUT_MS + 'ms' }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Retry before believing a failure — a single blip must not block a release. */
async function fetchLiveVersion() {
  let last = null;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    last = await readLiveVersionOnce();
    if (last.version) return last;
    if (attempt < READ_ATTEMPTS) {
      console.log('  [rollback-guard] live version.json unreadable (' + last.why + ') — retry ' + attempt + '/' + (READ_ATTEMPTS - 1));
      await sleep(RETRY_MS * attempt);
    }
  }
  return last;
}

(async () => {
  const read = await fetchLiveVersion();

  if (!read || !read.version) {
    console.error('');
    console.error('  ✖ [rollback-guard] REFUSING TO DEPLOY — the production pointer could not be established.');
    console.error('      Reason after ' + READ_ATTEMPTS + ' attempts: ' + ((read && read.why) || 'unknown'));
    console.error('      ' + LIVE_VERSION_URL);
    console.error('');
    console.error('      This is NOT "probably fine". Without the live commit this guard cannot tell a');
    console.error('      legitimate release from a stale worktree overwriting production, and hosting');
    console.error('      publishes the whole tree. It used to allow the deploy here; that turned an');
    console.error('      unanswered question into permission.');
    console.error('');
    console.error('      Do: re-check ' + LIVE_VERSION_URL + ' returns HTTP 200 and try again.');
    console.error('      A 500 there is a production condition to investigate, not a step to skip.');
    console.error('');
    process.exit(1);
  }
  const live = read.version;

  /* THE LOCAL POINTER IS A POINTER TOO.
     git() swallows the error and returns '', so this is reached when the tree is not a
     git repository, git is unavailable, or the object store is unreadable — an exported
     or copied tree deployed without its .git directory is the realistic case.

     This used to print 'allowing deploy'. That is the same inference this guard exists
     to forbid, applied to the other side of the comparison: with no HEAD, neither the
     rollback test nor the divergence test below can run at all, and hosting publishes
     the whole tree regardless. An unknown LOCAL commit disqualifies a deploy exactly as
     an unknown LIVE one does. Also requires a real 40-hex sha, so a garbled answer
     cannot be mistaken for a resolved pointer. */
  const head = git('rev-parse HEAD');
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    console.error('');
    console.error('  ✖ [rollback-guard] REFUSING TO DEPLOY — the local commit could not be established.');
    console.error('      `git rev-parse HEAD` returned: ' + (head ? JSON.stringify(head) : '(nothing)'));
    console.error('      Reached when this is not a git worktree, git is unavailable, or the object');
    console.error('      store is unreadable — e.g. an exported tree deployed without its .git.');
    console.error('');
    console.error('      Without HEAD there is nothing to compare against live, so the rollback and');
    console.error('      divergence checks below cannot run — yet hosting would still publish the');
    console.error('      whole tree. Allowing the deploy here would turn an unanswered question into');
    console.error('      permission. Production is currently ' + String(live.commit).slice(0, 7) + '.');
    console.error('');
    console.error('      Do: deploy from a real git worktree (`git status` must succeed), then retry.');
    console.error('');
    process.exit(1);
  }

  if (head === live.commit) {
    console.log(`  [rollback-guard] tree is at the live commit (${head.slice(0, 7)}) — allowing redeploy.`);
    return;
  }

  /* `git merge-base --is-ancestor A B` exits 0 iff A is an ancestor of B.
     If the live commit is not in this worktree's object store the command errors and we
     record "not behind" — which is NOT a pass. It falls through to the DIVERGENCE check
     below, where a live commit that is not contained in this tree is refused. */
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
