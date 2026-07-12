#!/usr/bin/env node
/**
 * index-capacity-report.js — Firestore composite-index capacity report.
 *
 * Reports LIVE usage from the Firestore Admin API (never from static files, which
 * drift). Prints usage, remaining slots, the collections consuming the most indexes,
 * and an operational-vs-product split.
 *
 *   node scripts/index-capacity-report.js
 *   node scripts/index-capacity-report.js --json     # machine-readable
 *
 * Exit code: 0 normally; 1 if any database crosses the CRITICAL threshold.
 *
 * NOTE ON THE LIMIT — this is the number that matters and it has been misreported:
 * the Firestore quota "Composite Indexes Per Database" is 1000, confirmed against
 * serviceusage.googleapis.com for this project. Earlier docs claimed a 200 hard cap
 * and drove an unnecessary migration policy. Thresholds below are % of the REAL limit.
 */
'use strict';
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const DATABASES = ['(default)', 'sokoni-ops'];
const LIMIT = 1000;                 // verified via serviceusage consumerQuotaMetrics
const WARN = 0.80, HIGH = 0.90, CRITICAL = 0.95;

/* Operational/internal collections — infrastructure, not product surface. */
const OPERATIONAL = [
  /^_sokoni/, /Queue$/i, /^webhookDeliveries$/, /^emailLogs$/, /Logs$/i,
  /^operationsReports$/, /^reportSchedules$/, /^trending$/, /Events$/i,
];

const isOperational = (c) => OPERATIONAL.some((re) => re.test(c));

function token() {
  const cfg = path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'configstore', 'firebase-tools.json');
  if (!fs.existsSync(cfg)) throw new Error('Not logged in — run: npx firebase-tools login');
  const rt = JSON.parse(fs.readFileSync(cfg, 'utf8')).tokens.refresh_token;
  const body = new URLSearchParams({
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    refresh_token: rt, grant_type: 'refresh_token',
  }).toString();
  const out = execSync(
    `curl -s -X POST -d "${body}" https://oauth2.googleapis.com/token`,
    { encoding: 'utf8' }
  );
  const at = JSON.parse(out).access_token;
  if (!at) throw new Error('Could not mint an access token');
  return at;
}

function listIndexes(at, db) {
  return new Promise((resolve, reject) => {
    const p = `/v1/projects/${PROJECT}/databases/${encodeURIComponent(db)}/collectionGroups/-/indexes`;
    https.get({ host: 'firestore.googleapis.com', path: p, headers: { Authorization: 'Bearer ' + at } }, (r) => {
      let b = ''; r.on('data', (d) => b += d);
      r.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.error) return reject(new Error(j.error.message));
          resolve(j.indexes || []);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const bar = (pct, w = 40) => {
  const n = Math.round(pct * w);
  return '[' + '#'.repeat(n) + '.'.repeat(w - n) + ']';
};

(async () => {
  const at = token();
  const report = { limit: LIMIT, generated: new Date().toISOString(), databases: {} };
  let critical = false;

  for (const db of DATABASES) {
    const ix = await listIndexes(at, db);
    const used = ix.length;
    const pct = used / LIMIT;

    const byCollection = {};
    let ops = 0, product = 0, notReady = 0;
    for (const i of ix) {
      const c = i.name.split('/collectionGroups/')[1].split('/')[0];
      byCollection[c] = (byCollection[c] || 0) + 1;
      if (isOperational(c)) ops++; else product++;
      if (i.state !== 'READY') notReady++;
    }

    const status = pct >= CRITICAL ? 'CRITICAL' : pct >= HIGH ? 'HIGH' : pct >= WARN ? 'WARN' : 'HEALTHY';
    if (status === 'CRITICAL') critical = true;

    report.databases[db] = {
      used, remaining: LIMIT - used, percentUsed: +(pct * 100).toFixed(1), status,
      notReady, operational: ops, product,
      topCollections: Object.entries(byCollection).sort((a, b) => b[1] - a[1]).slice(0, 10),
    };

    if (!process.argv.includes('--json')) {
      console.log(`\n=== ${db} ===`);
      console.log(`  ${bar(pct)}  ${used} / ${LIMIT}  (${(pct * 100).toFixed(1)}%)  ${status}`);
      console.log(`  remaining slots : ${LIMIT - used}`);
      console.log(`  building        : ${notReady}`);
      console.log(`  operational     : ${ops}`);
      console.log(`  product         : ${product}`);
      console.log('  top collections :');
      report.databases[db].topCollections.forEach(([c, n]) =>
        console.log(`      ${String(n).padStart(3)}  ${c}${isOperational(c) ? '  (operational)' : ''}`));
    }
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nThresholds (% of the REAL ${LIMIT}-index limit): WARN ${WARN * 100}% · HIGH ${HIGH * 100}% · CRITICAL ${CRITICAL * 100}%`);
    console.log('Note: the "200 hard cap" in older docs was incorrect. Verified limit is 1000.\n');
  }

  process.exit(critical ? 1 : 0);
})().catch((e) => { console.error('index-capacity-report failed:', e.message); process.exit(2); });
