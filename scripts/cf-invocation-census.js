/* ══════════════════════════════════════════════════════════════════════════════
   CF INVOCATION CENSUS — what production actually CALLED, and over what window
   ══════════════════════════════════════════════════════════════════════════════
   Static analysis cannot justify deleting a live Cloud Function: a cached PWA
   client still calls yesterday's name. This supplies the second half of the
   removal invariant —

       removal candidate = unreferenced in source AND un-invoked in production

   Source: Cloud Monitoring `run.googleapis.com/request_count`, aggregated per
   Cloud Run service (2nd-gen functions ARE Cloud Run services). One aggregated
   query instead of reading hundreds of thousands of log lines.

   THE COVERAGE WINDOW IS RECORDED WITH THE RESULT, always. "0 invocations" is
   meaningless without the window it was measured over: a function used
   quarterly looks identical to a dead one inside 30 days. Every downstream
   decision carries this window so that nobody reading it later can mistake
   "not seen in 42 days" for "never used".

   READ ONLY. Deletes nothing, deploys nothing, writes one JSON census.

     node scripts/cf-invocation-census.js                 # default window
     node scripts/cf-invocation-census.js --days 42
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

const PROJECT = 'sokoni-aeb26';
const DAYS = (() => {
  const i = process.argv.indexOf('--days');
  return i > -1 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 30) : 30;
})();
const OUT = path.join(ROOT, 'docs/cf-invocation-census.json');

function token() {
  const ps = 'powershell';
  const args = ['-NoProfile', '-Command',
    "$env:CLOUDSDK_PYTHON='bundled'; gcloud auth print-access-token"];
  return execFileSync(ps, args, { encoding: 'utf8', maxBuffer: 1 << 20 }).trim();
}

function get(url, tok) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + tok } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ': ' + b.slice(0, 300)));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const tok = token();
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400000);

  /* Aggregate to ONE point per service over the whole window: we only need
     "was it called at all", not a time series. */
  const params = new URLSearchParams({
    filter: 'metric.type="run.googleapis.com/request_count"',
    'interval.startTime': start.toISOString(),
    'interval.endTime': end.toISOString(),
    'aggregation.alignmentPeriod': DAYS * 86400 + 's',
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    'aggregation.groupByFields': 'resource.label."service_name"',
    'view': 'FULL',
    'pageSize': '2000',
  });

  const counts = {};
  let pageToken = '';
  let pages = 0;
  do {
    const url = 'https://monitoring.googleapis.com/v3/projects/' + PROJECT +
      '/timeSeries?' + params.toString() + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const j = await get(url, tok);
    pages++;
    for (const ts of (j.timeSeries || [])) {
      const name = ((ts.resource || {}).labels || {}).service_name;
      if (!name) continue;
      let n = 0;
      for (const p of (ts.points || [])) {
        const v = p.value || {};
        n += Number(v.int64Value != null ? v.int64Value : (v.doubleValue || 0));
      }
      counts[name] = (counts[name] || 0) + n;
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken && pages < 40);

  const census = {
    project: PROJECT,
    metric: 'run.googleapis.com/request_count',
    /* THE WINDOW. Recorded so that a later reader cannot mistake a quiet window
       for a dead function. Any removal decision must cite these two fields. */
    coverage: {
      requestedDays: DAYS,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      note: 'Cloud Monitoring retention bounds this window. A function invoked ' +
            'less often than the window cannot be distinguished from an unused ' +
            'one by this census alone.',
    },
    generatedAt: end.toISOString(),
    servicesWithTraffic: Object.keys(counts).length,
    counts,
  };

  fs.writeFileSync(OUT, JSON.stringify(census, null, 2) + '\n');

  console.log('\nCF INVOCATION CENSUS');
  console.log('='.repeat(74));
  console.log('  window            : ' + start.toISOString() + '  ->  ' + end.toISOString());
  console.log('  requested days    : ' + DAYS);
  console.log('  pages fetched     : ' + pages);
  console.log('  services WITH traffic in window : ' + Object.keys(counts).length);
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log('\n  busiest:');
  top.forEach(([n, c]) => console.log('    ' + n.padEnd(44) + String(c).padStart(10)));
  console.log('\n  written: docs/cf-invocation-census.json');
  console.log('='.repeat(74) + '\n');
})().catch((e) => { console.error('\n  Census failed: ' + (e && e.message) + '\n'); process.exit(1); });
