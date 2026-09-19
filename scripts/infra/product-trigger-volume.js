#!/usr/bin/env node
/* Post-P0-7C measurement: did the catalogue-sync fix collapse the product
 * UPDATE trigger stream? READ ONLY — Cloud Monitoring reads plus one Firestore
 * aggregation count.
 *
 * P0-7C shipped to hosting at 2026-09-19T11:55:02.957Z (commit 1b62d15).
 * Anything measured BEFORE that instant is pre-fix and must not be mixed in.
 *
 * Usage:
 *   GTOK=$(gcloud auth print-access-token) node scripts/infra/product-trigger-volume.js
 *   GTOK=... node scripts/infra/product-trigger-volume.js 7      # window in days
 */
'use strict';

const https = require('https');
const PROJECT = 'sokoni-aeb26';
const TOKEN = process.env.GTOK;
if (!TOKEN) { console.error('set GTOK=$(gcloud auth print-access-token)'); process.exit(1); }

const DEPLOY_ISO = '2026-09-19T11:55:02.957Z';
const DEPLOY_MS = Date.parse(DEPLOY_ISO);

/* MEASURED pre-fix, 30 days to 2026-09-19 (P0-7 audit). Per-trigger totals. */
const BASELINE_30D = {
  oninventoryupdated: 46300,
  emailonproductstatuschange: 46296,
  indexproductupdate: 45978,
  onproductpricechanged: 45543,
};
const UPDATE_TRIGGERS = Object.keys(BASELINE_30D);
const CREATE_TRIGGERS = ['indexproductcreate', 'onmarketplaceproductcreated'];

const days = Number(process.argv[2]) || null;

function get(host, path) {
  return new Promise((res, rej) => {
    https.get({ host, path, headers: { Authorization: 'Bearer ' + TOKEN } }, (r) => {
      let b = ''; r.on('data', (d) => { b += d; });
      r.on('end', () => { try { res({ s: r.statusCode, j: JSON.parse(b) }); }
        catch (e) { res({ s: r.statusCode, raw: b.slice(0, 300) }); } });
    }).on('error', rej);
  });
}

const sum = (j) => (j.timeSeries || []).reduce((a, s) =>
  a + (s.points || []).reduce((b, p) =>
    b + Number((p.value && (p.value.int64Value ?? p.value.doubleValue)) || 0), 0), 0);

async function count(svc, startMs, endMs) {
  const secs = Math.max(60, Math.round((endMs - startMs) / 1000));
  const p = new URLSearchParams({
    'interval.startTime': new Date(startMs).toISOString(),
    'interval.endTime': new Date(endMs).toISOString(),
    'aggregation.alignmentPeriod': secs + 's',
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    filter: `metric.type="run.googleapis.com/request_count" AND resource.label.service_name="${svc}"`,
    pageSize: '100',
  });
  const r = await get('monitoring.googleapis.com', `/v3/projects/${PROJECT}/timeSeries?${p}`);
  if (r.s !== 200) return { err: `HTTP ${r.s}` };
  if (!(r.j.timeSeries || []).length) return { n: null };  /* no series != zero */
  return { n: sum(r.j) };
}

(async () => {
  const now = Date.now();
  const start = days ? now - days * 86400000 : DEPLOY_MS;
  const hours = (now - start) / 3600000;

  console.log('PRODUCT TRIGGER VOLUME — post-P0-7C measurement');
  console.log('='.repeat(78));
  console.log(`  P0-7C deployed : ${DEPLOY_ISO}  (commit 1b62d15)`);
  console.log(`  window start   : ${new Date(start).toISOString()}${days ? ` (${days}d)` : ' (since deploy)'}`);
  console.log(`  window end     : ${new Date(now).toISOString()}`);
  console.log(`  window length  : ${hours.toFixed(1)}h`);

  if (hours < 48) {
    console.log('\n  *** TOO EARLY TO CONCLUDE ***');
    console.log('  The pre-fix baseline is a 30-day total. A window under ~48h is noise:');
    console.log('  the sync fires on LOGIN, so volume follows seller sessions, not a clock.');
    console.log('  Numbers below are provisional and must not be quoted as the reduction.');
  }

  console.log('\n-- UPDATE triggers (the amplified four)');
  console.log('   trigger                        observed   baseline/30d   implied/30d   change');
  let anyNull = false;
  for (const t of UPDATE_TRIGGERS) {
    const r = await count(t, start, now);
    if (r.err) { console.log(`   ${t.padEnd(30)} QUERY FAILED ${r.err}`); anyNull = true; continue; }
    if (r.n === null) { console.log(`   ${t.padEnd(30)}  NO SERIES  (not zero — no data returned)`); anyNull = true; continue; }
    const implied = hours > 0 ? (r.n / hours) * 24 * 30 : 0;
    const base = BASELINE_30D[t];
    const pct = base ? ((1 - implied / base) * 100) : 0;
    console.log(`   ${t.padEnd(30)} ${String(r.n).padStart(8)} ${String(base).padStart(14)} ` +
      `${implied.toFixed(0).padStart(13)}   ${pct > 0 ? '-' : '+'}${Math.abs(pct).toFixed(1)}%`);
  }

  console.log('\n-- CREATE triggers (baseline 5 each in 30d — genuine product creates)');
  for (const t of CREATE_TRIGGERS) {
    const r = await count(t, start, now);
    console.log(`   ${t.padEnd(30)} ${r.err ? 'QUERY FAILED' : (r.n === null ? 'NO SERIES' : String(r.n).padStart(8))}`);
  }

  /* product count, for reads-per-product context */
  const body = JSON.stringify({ structuredAggregationQuery: {
    structuredQuery: { from: [{ collectionId: 'products' }] },
    aggregations: [{ count: {}, alias: 'n' }] } });
  const r = await new Promise((res, rej) => {
    const q = https.request({ host: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents:runAggregationQuery`,
      method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (s) => { let b = ''; s.on('data', (d) => { b += d; });
      s.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } }); });
    q.on('error', rej); q.write(body); q.end();
  });
  const n = r && r[0] && r[0].result && r[0].result.aggregateFields
    && r[0].result.aggregateFields.n && r[0].result.aggregateFields.n.integerValue;
  console.log(`\n-- products in collection: ${n ?? 'UNKNOWN'}   (was 108 at P0-7B)`);

  console.log('\nHOW TO READ THIS');
  console.log('='.repeat(78));
  console.log('  Confirms P0-7B : implied/30d collapses far below baseline on ALL FOUR.');
  console.log('                   The client catalogue sync WAS the writer.');
  console.log('  Refutes P0-7B  : volume holds near baseline. Another writer exists and');
  console.log('                   the P0-7B classification-B finding is wrong — reopen it.');
  console.log('  Inconclusive   : window too short, NO SERIES, or the four disagree.');
  if (anyNull) console.log('\n  NOTE: a NO SERIES row is NOT zero invocations. Do not read it as success.');
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
