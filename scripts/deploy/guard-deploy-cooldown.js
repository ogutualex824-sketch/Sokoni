#!/usr/bin/env node
/**
 * guard-deploy-cooldown.js — serialize hosting deploys to stop service-worker thrash.
 *
 * WHY. This repo is deployed by many parallel agent worktrees. On 2026-07-27 five of
 * them deployed within minutes, bumping the service worker v131→v136 back-to-back.
 * That rapid churn left devices installing/activating workers on top of each other and
 * blanked pages mid-update ("most pages white/black"). The SERVER was never broken —
 * the damage was the CADENCE of deploys, not any one deploy.
 *
 * This runs FIRST in the hosting predeploy chain (before the SW version bump) and holds
 * a deploy if production was deployed less than COOLDOWN_MS ago. The live version.json
 * buildTime is the shared coordination point every worktree can see, so deploys space
 * out instead of stacking — one SW bump settles before the next begins.
 *
 * Fail-open: if production is unreachable or buildTime is missing/unparseable, the
 * deploy proceeds — a network blip must never block a release.
 *
 * LIMITATION (honest): two deploys that START within the same window both read the same
 * stale buildTime and both pass — this reduces rapid SUCCESSION, it is not a hard mutex.
 * And a worktree pinned to a commit before this hook does not run it. The durable fix
 * remains operational: a single deploy authority. This makes the common case safe.
 */
'use strict';

const https = require('https');

const COOLDOWN_MS = 120000; /* 2 minutes between hosting deploys */
const LIVE_VERSION_URL = 'https://mysokoni.co.ke/version.json';

function fetchLive() {
  return new Promise((resolve) => {
    const req = https.get(
      LIVE_VERSION_URL,
      { timeout: 8000, headers: { 'Cache-Control': 'no-cache' } },
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
  const live = await fetchLive();
  if (!live || !live.buildTime) {
    console.log('  [deploy-cooldown] live buildTime unavailable — allowing deploy (fail-open).');
    return;
  }
  const age = Date.now() - Date.parse(live.buildTime);
  if (Number.isNaN(age)) {
    console.log('  [deploy-cooldown] unparseable buildTime — allowing deploy.');
    return;
  }
  if (age < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - age) / 1000);
    console.error('');
    console.error('  ✖ [deploy-cooldown] HOLDING this hosting deploy.');
    console.error(`      Production was deployed ${Math.round(age / 1000)}s ago (${live.commitShort || '?'}, ${live.cacheVersion || '?'}).`);
    console.error('      Hosting deploys are serialized so the service worker does not thrash and blank');
    console.error(`      devices mid-update. Wait ~${wait}s and retry — or designate a single deploy authority.`);
    console.error('');
    process.exit(1);
  }
  console.log(`  [deploy-cooldown] last deploy ${Math.round(age / 1000)}s ago (≥ ${COOLDOWN_MS / 1000}s) — allowing deploy.`);
})();
