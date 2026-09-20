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

  console.log(`  elapsed since deploy : ${((now - DEPLOY_MS) / 3600000).toFixed(1)}h`);

  console.log('\n' + '='.repeat(78));
  console.log('MEASUREMENT — what request_count shows. No interpretation in this section.');
  console.log('='.repeat(78));

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

  /* ---- daily baseline ---------------------------------------------------
     The 30-day total is a POOR comparator for this workload: the sync fires on
     LOGIN, so volume arrives in bursts. The pre-fix record contains full 24h
     periods with ZERO invocations weeks before any fix existed. Comparing a
     short post-deploy window against the 30-day aggregate therefore reads a
     normal quiet period as a reduction. Print the day-by-day structure so that
     mistake is visible rather than available. Measurement only — no threshold
     is applied and no number of days is prescribed. */
  console.log('\n-- DAILY BASELINE (24h buckets working back from the deploy)');
  console.log('   window (UTC)                                  invocations');
  const DAILY_SVC = UPDATE_TRIGGERS[0];
  for (let d = 1; d <= 8; d++) {
    const b = DEPLOY_MS - (d - 1) * 86400000;
    const a = DEPLOY_MS - d * 86400000;
    const r = await count(DAILY_SVC, a, b);
    const lbl = `${new Date(a).toISOString().slice(0, 16)} -> ${new Date(b).toISOString().slice(5, 16)}`;
    console.log(`   ${lbl.padEnd(42)} ${r.err ? 'QUERY FAILED' : (r.n === null ? 'NO SERIES' : String(r.n).padStart(8))}`);
  }
  console.log(`   (service: ${DAILY_SVC} — representative of the four)`);

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

  console.log('\n' + '='.repeat(78));
  console.log('INTERPRETATION — for the reviewer. This tool does not decide.');
  console.log('='.repeat(78));
  console.log('  Confirms P0-7B : implied/30d collapses far below baseline on ALL FOUR.');
  console.log('                   The client catalogue sync WAS the writer.');
  console.log('  Refutes P0-7B  : volume holds near baseline. Another writer exists and');
  console.log('                   the P0-7B classification-B finding is wrong — reopen it.');
  console.log('  Inconclusive   : NO SERIES rows, the four triggers disagree, or the');
  console.log('                   post-deploy window is indistinguishable from a quiet');
  console.log('                   day in the DAILY BASELINE above.');
  console.log('');
  console.log('  This tool reports measurement only. It does NOT declare the fix');
  console.log('  confirmed or failed, and it applies no elapsed-time threshold — the');
  console.log('  sync fires on LOGIN, so volume tracks seller sessions, not the clock.');
  console.log('  Evidence accumulates across repeated observations; a single reading is');
  console.log('  not causal proof in either direction.');
  if (anyNull) {
    console.log('\n  NOT SUFFICIENT FOR A CAUSAL CONCLUSION: one or more triggers returned');
    console.log('  NO SERIES. That is absence of data, NOT zero invocations, and must');
    console.log('  never be read as a reduction.');
  }
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
