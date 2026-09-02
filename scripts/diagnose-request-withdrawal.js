#!/usr/bin/env node
/* WHY DID requestWithdrawal RUN TWICE AND WRITE NOTHING?
 *
 * READ-ONLY. Cloud Monitoring only. No Firestore, no writes, no payouts.
 *
 * THE ANOMALY
 * 30-day window: `requestwithdrawal` served 2 requests. Its collection, `withdrawals`, holds
 * ZERO production rows — while `requestSellerPayout` served 3 and `payoutRequests` holds 7.
 * So it is invoked and writes nothing. That is not dead code; it is a live surface that
 * fails, and retiring it would delete the only evidence a caller exists.
 *
 * THE HYPOTHESIS TO TEST, NOT ASSUME
 * `requestWithdrawal` takes `amountCents` and rejects anything under 10000 (KES 100).
 * `requestSellerPayout` takes `amount` in SHILLINGS with the same KES 100 floor. A UI that
 * sends shillings into the cents parameter would send 100 for a KES 100 withdrawal and be
 * rejected as below minimum — a 100x unit divergence surfacing as a merchant-facing failure.
 *
 * If that is what happened, the callable answered HTTP 400 (invalid-argument). A 401/403
 * would mean auth or App Check instead; a 500 would mean it got further and broke; a 200
 * would mean it SUCCEEDED and the write went somewhere else entirely — which would be a
 * different and more alarming story.
 *
 * The response code distinguishes these. Nothing else in the evidence so far does.
 *
 *   node scripts/diagnose-request-withdrawal.js [days]
 */
'use strict';
const { spawnSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';
const DAYS = Number(process.argv[2] || 30);

/* the withdrawal surfaces, plus a KNOWN-BUSY control so a zero can be read as a real zero */
const WATCH = {
  requestwithdrawal:     'requestWithdrawal      (amountCents, writes `withdrawals`)',
  requestsellerpayout:   'requestSellerPayout    (amount KES, writes `payoutRequests`)',
  oninventoryupdated:    'CONTROL — a service known to be busy'
};

const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
  { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
const TOKEN = String(tk.stdout || '').trim();
if (!TOKEN) { console.log('  no access token'); process.exit(1); }

const end = new Date();
const start = new Date(end.getTime() - DAYS * 86400000);

function series (groupBy) {
  const params = [
    'filter=' + encodeURIComponent('metric.type="run.googleapis.com/request_count"'),
    'interval.startTime=' + encodeURIComponent(start.toISOString()),
    'interval.endTime=' + encodeURIComponent(end.toISOString()),
    'aggregation.alignmentPeriod=86400s',
    'aggregation.perSeriesAligner=ALIGN_SUM',
    'aggregation.crossSeriesReducer=REDUCE_SUM',
    'pageSize=2000'
  ].concat(groupBy.map((g) => 'aggregation.groupByFields=' + encodeURIComponent(g))).join('&');

  const out = [];
  let token = '', pages = 0;
  do {
    const url = 'https://monitoring.googleapis.com/v3/projects/' + PROJECT + '/timeSeries?' +
                params + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    const r = spawnSync('curl', ['-s',
      '-H', 'Authorization: Bearer ' + TOKEN,
      '-H', 'x-goog-user-project: ' + PROJECT, url],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 128 });
    let j;
    try { j = JSON.parse(Buffer.from(r.stdout).toString('utf8')); }
    catch (_) { throw new Error('unparseable monitoring response'); }
    if (j.error) throw new Error(j.error.status + ': ' + j.error.message);
    (j.timeSeries || []).forEach((ts) => out.push(ts));
    token = j.nextPageToken || '';
  } while (token && ++pages < 40);
  return out;
}

const sum = (ts) => (ts.points || []).reduce((s, p) => {
  const v = p.value || {};
  return s + Number(v.int64Value || v.doubleValue || 0);
}, 0);

console.log('');
console.log('  requestWithdrawal — 2 invocations, 0 rows. What did they answer?');
console.log('  window: last ' + DAYS + ' days (' + start.toISOString().slice(0, 10) +
            ' -> ' + end.toISOString().slice(0, 10) + ')');
console.log('');

let byCode;
try {
  byCode = series(['resource.label."service_name"', 'metric.label."response_code"']);
} catch (e) {
  console.log('  QUERY FAILED: ' + e.message);
  process.exit(1);
}

const table = {};
byCode.forEach((ts) => {
  const svc = ts.resource && ts.resource.labels && ts.resource.labels.service_name;
  const code = (ts.metric && ts.metric.labels && ts.metric.labels.response_code) || '?';
  if (!svc) return;
  table[svc] = table[svc] || {};
  table[svc][code] = (table[svc][code] || 0) + sum(ts);
});

/* the control has to show traffic, or a zero elsewhere proves nothing */
const control = table.oninventoryupdated;
const controlTotal = control ? Object.values(control).reduce((a, b) => a + b, 0) : 0;
if (controlTotal === 0) {
  console.log('  CONTROL FAILED — the known-busy service reports no requests either.');
  console.log('  That is a broken query, not a quiet platform. No conclusion is drawn.');
  process.exit(1);
}
console.log('  control (oninventoryupdated): ' + controlTotal +
            ' requests -> the metric reports response codes');
console.log('');

Object.keys(WATCH).forEach((svc) => {
  if (svc === 'oninventoryupdated') return;
  console.log('  ' + WATCH[svc]);
  const row = table[svc];
  if (!row) { console.log('      no time series in this window'); console.log(''); return; }
  Object.keys(row).sort().forEach((code) => {
    const n = row[code];
    const meaning =
      /^2/.test(code) ? 'SUCCESS — the callable returned OK'
      : code === '400' ? 'invalid-argument — a validation reject, BEFORE any write'
      : code === '401' ? 'unauthenticated'
      : code === '403' ? 'permission-denied / App Check'
      : code === '404' ? 'not-found'
      : code === '429' ? 'resource-exhausted'
      : /^5/.test(code) ? 'server error — it got further and broke'
      : '';
    console.log('      HTTP ' + String(code).padEnd(5) + String(n).padStart(4) +
                '   ' + meaning);
  });
  console.log('');
});

console.log('  ' + '='.repeat(70));
const rw = table.requestwithdrawal || {};
const codes = Object.keys(rw);
const only400 = codes.length > 0 && codes.every((c) => c === '400');
const any2xx = codes.some((c) => /^2/.test(c));

if (only400) {
  console.log('  EVERY invocation was rejected 400 BEFORE writing.');
  console.log('  Consistent with the unit hypothesis: a UI sending SHILLINGS into the');
  console.log('  `amountCents` parameter is rejected as below the 10000-cent minimum.');
  console.log('  This is a LIVE merchant-facing withdrawal failure, not dead code.');
  console.log('');
  console.log('  NOT yet proven: that the caller sent shillings. A 400 is also returned for');
  console.log('  a missing method, a bad accountDetails shape, or a genuinely small request.');
  console.log('  Confirming the cause needs the request payload or the client code path.');
} else if (any2xx) {
  console.log('  At least one invocation SUCCEEDED (2xx) yet `withdrawals` holds no rows.');
  console.log('  That is a different and worse story than a rejection: the write went');
  console.log('  somewhere else, or was rolled back. Investigate before touching anything.');
} else if (codes.length && codes.every((c) => c === '401')) {
  console.log('  EVERY invocation was rejected 401 — UNAUTHENTICATED.');
  console.log('');
  console.log('  THIS REFUTES THE UNIT HYPOTHESIS. The calls never reached the amountCents');
  console.log('  validation, so the 100x divergence played no part in this anomaly. The');
  console.log('  100x divergence is still real in the code; it is simply not what happened');
  console.log('  here, and saying otherwise would have been a tidy story with no evidence.');
  console.log('');
  console.log('  What IS established: requestWithdrawal has had NO successful authenticated');
  console.log('  invocation in this window. Zero rows in `withdrawals` is fully explained by');
  console.log('  zero authenticated calls — no failing write needs to be posited.');
  console.log('');
  console.log('  Consistent with an unauthenticated scanner, a stale client that cannot');
  console.log('  obtain a token, or a UI path reached while signed out. NOT established:');
  console.log('  which. That needs the caller identity or the client path, not this metric.');
  console.log('');
  console.log('  Note requestSellerPayout ALSO shows a 401 alongside its successes, so an');
  console.log('  occasional unauthenticated hit is not unique to this surface.');
} else if (codes.length === 0) {
  console.log('  No response-code series for requestwithdrawal in this window.');
} else {
  console.log('  Mixed or non-400 responses: ' + JSON.stringify(rw));
  console.log('  The unit hypothesis does not explain these on its own.');
}
console.log('  ' + '='.repeat(70));
console.log('');
