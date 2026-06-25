#!/usr/bin/env node
/**
 * SOKONI Full-Stack Rollback
 *
 * Rolls back: Hosting + Cloud Functions + Firestore rules
 * in the correct reverse order to avoid mixed-version states.
 *
 * Usage:
 *   node scripts/deploy/rollback.js [--release=<firebase-release-id>]
 *   FIREBASE_TOKEN=xxx node scripts/deploy/rollback.js
 */
'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');

const PROJECT = process.env.FIREBASE_PROJECT || 'sokoni-aeb26';
const ROOT    = path.resolve(__dirname, '../..');

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  const result = spawnSync(cmd, { shell: true, cwd: ROOT, stdio: 'inherit', ...opts });
  if (result.status !== 0) throw new Error(`Command failed: ${cmd}`);
  return result;
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

async function rollback() {
  console.log('\n🔄  SOKONI FULL-STACK ROLLBACK');
  console.log('   Project:', PROJECT);
  console.log('   Time:   ', new Date().toISOString());
  console.log('─'.repeat(60));

  /* ── Step 1: Identify previous release ─────────────────────── */
  let releaseId = process.argv.find(a => a.startsWith('--release='))?.split('=')[1];

  if (!releaseId) {
    try {
      const releases = runCapture(
        `npx -y firebase-tools hosting:releases:list --project ${PROJECT} --limit 3 --json`
      );
      const parsed = JSON.parse(releases);
      const list   = parsed?.result?.releases || [];
      /* Skip current (index 0), take previous (index 1) */
      releaseId = list[1]?.name?.split('/').pop();
    } catch {
      console.warn('   Could not auto-detect previous release — using "previous"');
      releaseId = 'previous';
    }
  }

  console.log(`\n[1/4] Rolling back Hosting to release: ${releaseId}`);
  try {
    run(`npx -y firebase-tools hosting:rollback --version ${releaseId} --project ${PROJECT} --force`);
    console.log('   ✅  Hosting rolled back');
  } catch {
    console.error('   ❌  Hosting rollback failed — manual intervention needed');
  }

  /* ── Step 2: Roll back Cloud Functions via previous git tag ── */
  console.log('\n[2/4] Identifying previous release tag for Cloud Functions...');
  let prevTag;
  try {
    const tags = runCapture('git tag --sort=-version:refname | grep "^release-" | head -2');
    const tagList = tags.split('\n').filter(Boolean);
    prevTag = tagList[1]; /* [0] is current, [1] is previous */
    console.log(`   Previous tag: ${prevTag}`);
  } catch {
    console.warn('   No release tags found — skipping functions rollback');
  }

  if (prevTag) {
    console.log(`\n[3/4] Checking out ${prevTag} and redeploying Cloud Functions...`);
    try {
      run(`git stash`);
      run(`git checkout ${prevTag} -- functions/`);
      run(`npx -y firebase-tools deploy --only functions --project ${PROJECT} --force`, {
        env: { ...process.env, FIREBASE_TOKEN: process.env.FIREBASE_TOKEN },
      });
      run(`git checkout HEAD -- functions/`);
      run(`git stash pop || true`);
      console.log('   ✅  Cloud Functions rolled back');
    } catch (err) {
      console.error('   ❌  Functions rollback failed:', err.message);
      console.error('   Restoring working tree...');
      try { run(`git checkout HEAD -- functions/`); run(`git stash pop || true`); } catch {}
    }
  }

  /* ── Step 3: Roll back Firestore rules ────────────────────── */
  console.log('\n[4/4] Rolling back Firestore rules...');
  if (prevTag) {
    try {
      run(`git checkout ${prevTag} -- firestore.rules firestore.indexes.json`);
      run(`npx -y firebase-tools deploy --only firestore --project ${PROJECT}`, {
        env: { ...process.env, FIREBASE_TOKEN: process.env.FIREBASE_TOKEN },
      });
      run(`git checkout HEAD -- firestore.rules firestore.indexes.json`);
      console.log('   ✅  Firestore rules rolled back');
    } catch (err) {
      console.error('   ❌  Firestore rules rollback failed:', err.message);
      try { run(`git checkout HEAD -- firestore.rules firestore.indexes.json`); } catch {}
    }
  } else {
    console.warn('   ⚠️  No previous tag — skipping Firestore rules rollback');
  }

  /* ── Step 4: Post-rollback health check ───────────────────── */
  console.log('\n[Health Check] Verifying rollback...');
  await new Promise(r => setTimeout(r, 15_000));
  try {
    const status = runCapture(
      `curl -s -o /dev/null -w "%{http_code}" https://us-central1-${PROJECT}.cloudfunctions.net/systemHealthCheck`
    );
    if (status === '200' || status === '206') {
      console.log(`   ✅  Health check passed (HTTP ${status})`);
    } else {
      console.error(`   ❌  Health check returned HTTP ${status} — platform may be degraded`);
    }
  } catch {
    console.warn('   ⚠️  Health check skipped (curl not available)');
  }

  console.log('\n✅  ROLLBACK COMPLETE\n');
}

rollback().catch(err => {
  console.error('\n❌  ROLLBACK FAILED:', err.message);
  process.exit(1);
});
