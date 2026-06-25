#!/usr/bin/env node
/**
 * SOKONI Canary Release Controller
 *
 * Monitors error rate and latency during canary rollout.
 * Automatically halts and rolls back if thresholds are exceeded.
 *
 * Usage:
 *   node canary-controller.js --stage=1   (1%)
 *   node canary-controller.js --stage=2   (5%)
 *   node canary-controller.js --stage=3   (10%)
 *   node canary-controller.js --stage=4   (25%)
 *   node canary-controller.js --stage=5   (50%)
 *   node canary-controller.js --stage=6   (100%)
 *
 * Exit 0 = healthy, proceed. Exit 1 = unhealthy, rollback.
 */
'use strict';

const https = require('https');

const STAGES = [null, 1, 5, 10, 25, 50, 100]; /* index = stage number */
const stage  = parseInt((process.argv.find(a => a.startsWith('--stage=')) || '--stage=1').split('=')[1], 10);
const pct    = STAGES[stage] || 1;

/* Health check config */
const HEALTH_URL    = process.env.HEALTH_URL || 'https://us-central1-sokoni-aeb26.cloudfunctions.net/systemHealthCheck';
const OBSERVE_MINS  = parseInt(process.env.OBSERVE_MINUTES || String(Math.max(2, stage * 2)), 10);
const POLL_INTERVAL = 30_000; /* poll every 30 seconds */

/* Thresholds — tighten at lower canary %, loosen at higher */
const THRESHOLDS = {
  maxErrorRate:    stage <= 2 ? 0.5  : stage <= 4 ? 1.0  : 2.0,  /* % */
  maxP95LatencyMs: stage <= 2 ? 800  : stage <= 4 ? 1200 : 2000,
  maxFirestoreMs:  stage <= 2 ? 200  : stage <= 4 ? 400  : 800,
  minHealthScore:  stage <= 2 ? 90   : stage <= 4 ? 80   : 70,
};

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end',  () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Health check timeout')); });
  });
}

async function sampleHealth() {
  try {
    const { status, body } = await fetch(HEALTH_URL);
    return { ok: status < 500, status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

async function run() {
  console.log(`\nSOKONI Canary Controller — Stage ${stage} (${pct}% traffic)`);
  console.log(`Observing for ${OBSERVE_MINS} minutes | Thresholds:`, THRESHOLDS);
  console.log('─'.repeat(60));

  const deadline   = Date.now() + OBSERVE_MINS * 60_000;
  const samples    = [];
  let   failures   = 0;
  const MAX_CONSEC = 3; /* consecutive failures before auto-rollback */

  while (Date.now() < deadline) {
    const sample = await sampleHealth();
    samples.push({ ts: Date.now(), ...sample });

    const healthScore = sample.body?.score ?? (sample.ok ? 80 : 0);
    const firestoreMs = sample.body?.checks?.firestore?.latencyMs ?? 0;
    const errorRate   = sample.body?.errorRate ?? 0;

    const violations = [];
    if (errorRate   > THRESHOLDS.maxErrorRate)    violations.push(`error rate ${errorRate}% > ${THRESHOLDS.maxErrorRate}%`);
    if (firestoreMs > THRESHOLDS.maxFirestoreMs)  violations.push(`Firestore ${firestoreMs}ms > ${THRESHOLDS.maxFirestoreMs}ms`);
    if (healthScore < THRESHOLDS.minHealthScore)  violations.push(`health score ${healthScore} < ${THRESHOLDS.minHealthScore}`);
    if (!sample.ok)                               violations.push(`health endpoint ${sample.status || 'unreachable'}`);

    const ts = new Date().toISOString().slice(11, 19);
    if (violations.length) {
      failures++;
      console.warn(`[${ts}] ⚠️  Violation (${failures}/${MAX_CONSEC}): ${violations.join(', ')}`);
      if (failures >= MAX_CONSEC) {
        console.error(`\n❌  AUTO-ROLLBACK TRIGGERED — ${failures} consecutive violations`);
        console.error('   Violations:', violations.join('; '));
        process.exit(1);
      }
    } else {
      failures = 0;
      console.log(`[${ts}] ✅  Healthy — score:${healthScore} firestore:${firestoreMs}ms errors:${errorRate}%`);
    }

    const remaining = Math.ceil((deadline - Date.now()) / 60_000);
    if (Date.now() < deadline) {
      process.stdout.write(`   ${remaining}min remaining...`);
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      process.stdout.write('\r');
    }
  }

  const successRate = (samples.filter(s => s.ok).length / samples.length * 100).toFixed(1);
  console.log(`\n✅  Stage ${stage} PASSED — ${successRate}% healthy samples over ${OBSERVE_MINS}min`);
  console.log(`   Proceeding to ${STAGES[stage + 1] || 100}% traffic\n`);
  process.exit(0);
}

run().catch(err => {
  console.error('Controller error:', err.message);
  process.exit(1);
});
