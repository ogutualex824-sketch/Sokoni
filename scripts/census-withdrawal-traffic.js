#!/usr/bin/env node
/* GEN2 TRAFFIC CENSUS — is a withdrawal callable actually being INVOKED?
 *
 * READ-ONLY. Cloud Monitoring only; no Firestore, no writes, no payouts.
 *
 * WHY ROW COUNTS ARE NOT ENOUGH
 * `withdrawals` holds zero production rows. That establishes nothing was successfully
 * WRITTEN through it — not that nothing CALLS it. A callable can be invoked and fail before
 * writing, which is exactly the state a migration must not silently break.
 *
 * WHY THE FIRST ATTEMPT AT THIS FAILED
 * A logging query filtered on `resource.type=cloud_function` returned a uniform 4-5 entries
 * for every surface, including one with zero callers — the signature of a filter matching
 * nothing and counting noise. All 1,711 functions in this project are GEN_2, i.e.
 * Cloud Run services, whose metric is `run.googleapis.com/request_count` keyed by a
 * LOWERCASED service_name. `cloud_function` never matched them.
 *
 * THE CONTROL IS BUILT IN
 * It does not query the six surfaces in isolation. It pulls request_count for EVERY service
 * and reports the busiest, so a zero for a withdrawal surface is read against services that
 * demonstrably do have traffic. A run where nothing has traffic is a broken probe, not an
 * idle platform, and it says so.
 *
 *   node scripts/census-withdrawal-traffic.js [days]
 */
'use strict';
const { spawnSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';
const DAYS = Number(process.argv[2] || 30);

const SURFACES = {
  requestsellerpayout:     'requestSellerPayout',
  requestwithdrawal:       'requestWithdrawal',
  requestpayout:           'requestPayout',
  walletv2savingswithdraw: 'walletV2SavingsWithdraw',
  finosrequestbankpayout:  'finosRequestBankPayout',
  initiatesellerpayout:    'initiateSellerPayout'
};

const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
  { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
const TOKEN = String(tk.stdout || '').trim();
if (!TOKEN) { console.log('  no access token'); process.exit(1); }

const end = new Date();
const start = new Date(end.getTime() - DAYS * 86400000);

const params = [
  'filter=' + encodeURIComponent('metric.type="run.googleapis.com/request_count"'),
  'interval.startTime=' + encodeURIComponent(start.toISOString()),
  'interval.endTime=' + encodeURIComponent(end.toISOString()),
  'aggregation.alignmentPeriod=86400s',
  'aggregation.perSeriesAligner=ALIGN_SUM',
  'aggregation.crossSeriesReducer=REDUCE_SUM',
  'aggregation.groupByFields=' + encodeURIComponent('resource.label."service_name"'),
  'pageSize=2000'
].join('&');

const totals = {};
let pageToken = '';
let pages = 0;
do {
  const url = 'https://monitoring.googleapis.com/v3/projects/' + PROJECT + '/timeSeries?' +
              params + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
  const r = spawnSync('curl', ['-s',
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'x-goog-user-project: ' + PROJECT,
    url], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 128 });
  let j;
  try { j = JSON.parse(Buffer.from(r.stdout).toString('utf8')); }
  catch (_) { console.log('  UNPARSEABLE response'); process.exit(1); }
  if (j.error) { console.log('  API ERROR ' + j.error.status + ': ' + j.error.message); process.exit(1); }
  (j.timeSeries || []).forEach((ts) => {
    const svc = ts.resource && ts.resource.labels && ts.resource.labels.service_name;
    if (!svc) return;
    const sum = (ts.points || []).reduce((s, p) => {
      const v = p.value || {};
      return s + Number(v.int64Value || v.doubleValue || 0);
    }, 0);
    totals[svc] = (totals[svc] || 0) + sum;
  });
  pageToken = j.nextPageToken || '';
  pages++;
} while (pageToken && pages < 40);

const entries = Object.keys(totals).map((k) => [k, totals[k]]).sort((a, b) => b[1] - a[1]);
const withTraffic = entries.filter((e) => e[1] > 0);

console.log('');
console.log('  window        last ' + DAYS + ' days   (' + start.toISOString().slice(0, 10) +
            ' → ' + end.toISOString().slice(0, 10) + ')');
console.log('  services seen ' + entries.length + '   with traffic ' + withTraffic.length +
            '   pages ' + pages);

/* the control: if NOTHING has traffic, the probe is broken, not the platform idle */
if (withTraffic.length === 0) {
  console.log('');
  console.log('  CONTROL FAILED — not one service reports any request in this window.');
  console.log('  That is a broken query, not an idle platform. No conclusion is drawn.');
  process.exit(1);
}

console.log('');
console.log('  busiest services (the control — these prove the metric reports traffic):');
withTraffic.slice(0, 5).forEach((e) => console.log('    ' + String(e[1]).padStart(9) + '  ' + e[0]));

console.log('');
console.log('  WITHDRAWAL SURFACES');
console.log('  ' + 'callable'.padEnd(26) + 'requests   verdict');
console.log('  ' + '-'.repeat(62));
Object.keys(SURFACES).forEach((svc) => {
  const seen = Object.prototype.hasOwnProperty.call(totals, svc);
  const n = totals[svc] || 0;
  const verdict = !seen ? 'NO SERIES — never invoked in window'
                : n > 0 ? 'TRAFFIC'
                : 'series present, ZERO requests';
  console.log('  ' + SURFACES[svc].padEnd(26) + String(n).padStart(8) + '   ' + verdict);
});

console.log('');
console.log('  A surface with zero requests here has not been invoked in the window.');
console.log('  It does NOT prove it is unreachable: a longer window, another region, or a');
console.log('  client released after this window could still call it. Retirement needs an');
console.log('  owner decision, not only this table.');
console.log('');
