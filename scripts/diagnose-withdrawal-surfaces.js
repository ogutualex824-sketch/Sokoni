#!/usr/bin/env node
/* THE REMAINING FOUR WITHDRAWAL SURFACES — production diagnosis.
 *
 * READ-ONLY. Cloud Monitoring + source. No Firestore writes, no payouts, no code changes.
 *
 * Same method that resolved requestWithdrawal, applied to the surfaces that have not been
 * diagnosed. That diagnosis mattered because it REFUTED the hypothesis being carried: the
 * anomaly was 401s against dead code, not the 100x unit contract everyone (me included) had
 * assumed. So these four get evidence before classification, not after.
 *
 * SIX DIMENSIONS, per surface:
 *   1. traffic            request_count, split by response code
 *   2. authenticated?     a 2xx means it got past auth; only 401/403 means it never did
 *   3. callers            searched across the DEPLOY FOOTPRINT — tracked AND untracked
 *                         files that ship, because untracked files deploy
 *   4. reachable?         is the call site behind an unconditional return, like
 *                         seller-wallet.html's retired path?
 *   5. writes             which collections the function touches
 *   6. domain             merchant payout / savings / admin / something else
 *
 * A surface is classified only where the evidence supports it. "No traffic in the window"
 * is not "unreachable", and this says so rather than rounding it up.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';
const ROOT = 'c:/Users/USER1/OneDrive/Desktop/SOKONI';
const DAYS = Number(process.argv[2] || 42);      /* Monitoring retains ~6 weeks */

const SURFACES = [
  { fn: 'requestPayout',           svc: 'requestpayout',           src: 'functions/finos.js' },
  { fn: 'initiateSellerPayout',    svc: 'initiatesellerpayout',    src: 'functions/index.js' },
  { fn: 'walletV2SavingsWithdraw', svc: 'walletv2savingswithdraw', src: null },
  { fn: 'finosRequestBankPayout',  svc: 'finosrequestbankpayout',  src: 'functions/finos-router.js' }
];
/* carried through as a control: a surface already diagnosed, and a busy one */
const CONTROLS = [
  { fn: 'requestSellerPayout', svc: 'requestsellerpayout' },
  { fn: 'onInventoryUpdated',  svc: 'oninventoryupdated' }
];

const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
  { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
const TOKEN = String(tk.stdout || '').trim();
if (!TOKEN) { console.log('  no access token'); process.exit(1); }

/* ── 1/2 · traffic by response code ────────────────────────────────────────── */
const end = new Date(), start = new Date(Date.now() - DAYS * 86400000);
function trafficByCode () {
  const params = [
    'filter=' + encodeURIComponent('metric.type="run.googleapis.com/request_count"'),
    'interval.startTime=' + encodeURIComponent(start.toISOString()),
    'interval.endTime=' + encodeURIComponent(end.toISOString()),
    'aggregation.alignmentPeriod=86400s',
    'aggregation.perSeriesAligner=ALIGN_SUM',
    'aggregation.crossSeriesReducer=REDUCE_SUM',
    'aggregation.groupByFields=' + encodeURIComponent('resource.label."service_name"'),
    'aggregation.groupByFields=' + encodeURIComponent('metric.label."response_code"'),
    'pageSize=2000'
  ].join('&');
  const table = {};
  let token = '', pages = 0;
  do {
    const url = 'https://monitoring.googleapis.com/v3/projects/' + PROJECT + '/timeSeries?' +
                params + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    const r = spawnSync('curl', ['-s', '-H', 'Authorization: Bearer ' + TOKEN,
      '-H', 'x-goog-user-project: ' + PROJECT, url],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 128 });
    const j = JSON.parse(Buffer.from(r.stdout).toString('utf8'));
    if (j.error) throw new Error(j.error.status + ': ' + j.error.message);
    (j.timeSeries || []).forEach((ts) => {
      const svc = ts.resource && ts.resource.labels && ts.resource.labels.service_name;
      const code = (ts.metric && ts.metric.labels && ts.metric.labels.response_code) || '?';
      if (!svc) return;
      const n = (ts.points || []).reduce((s, p) =>
        s + Number((p.value || {}).int64Value || (p.value || {}).doubleValue || 0), 0);
      table[svc] = table[svc] || {};
      table[svc][code] = (table[svc][code] || 0) + n;
    });
    token = j.nextPageToken || '';
  } while (token && ++pages < 40);
  return table;
}

/* ── 3 · callers across the DEPLOY FOOTPRINT ───────────────────────────────── */
function deployFootprint () {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  let h = cfg.hosting; if (Array.isArray(h)) h = h[0];
  const ignore = ((h && h.ignore) || []).map((g) => {
    let s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    s = s.replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
    return new RegExp('^' + s.replace(/\?/g, '[^/]') + '$');
  });
  const fnSrc = (cfg.functions &&
    (Array.isArray(cfg.functions) ? cfg.functions[0].source : cfg.functions.source)) || 'functions';
  const list = (cmd) => {
    try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); }
    catch (_) { return []; }
  };
  const all = list('git ls-files').concat(list('git ls-files --others --exclude-standard'));
  return Array.from(new Set(all)).filter((f) => {
    if (!/\.(js|html)$/.test(f)) return false;
    if (/(^|\/)node_modules\//.test(f)) return false;
    if (!fs.existsSync(path.join(ROOT, f))) return false;
    if (f === fnSrc || f.indexOf(fnSrc + '/') === 0) return true;
    return !ignore.some((re) => re.test(f));
  });
}

const NL = String.fromCharCode(10);
const FOOTPRINT = deployFootprint();

function callersOf (fnName) {
  const re = new RegExp('[\'"]' + fnName + '[\'"]');
  const hits = [];
  FOOTPRINT.forEach((f) => {
    if (f.indexOf('functions/') === 0) return;           /* server-side definition, not a caller */
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return; }
    src.split(NL).forEach((l, i) => {
      if (re.test(l)) hits.push({ file: f, line: i + 1, text: l.trim().slice(0, 96) });
    });
  });
  return hits;
}

/* ── 4 · is a caller behind an unconditional early return? ─────────────────── */
function reachability (hit) {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, hit.file), 'utf8'); } catch (_) { return 'unknown'; }
  const lines = src.split(NL);
  /* walk back to the enclosing function, looking for a bare `return;` before the call */
  for (let i = hit.line - 2; i >= 0 && i > hit.line - 80; i--) {
    const t = lines[i].trim();
    if (/^(async\s+)?function\s|=>\s*\{$/.test(t)) return 'reachable';
    if (/^return;\s*$/.test(t)) return 'UNREACHABLE (bare return above)';
    if (/no-unreachable/.test(t)) return 'UNREACHABLE (eslint no-unreachable)';
  }
  return 'reachable';
}

/* ── 5 · what does the function write? ─────────────────────────────────────── */
function writesOf (fnName, srcFile) {
  if (!srcFile) return null;
  let src;
  try { src = fs.readFileSync(path.join(ROOT, srcFile), 'utf8'); } catch (_) { return null; }
  const lines = src.split(NL);
  let startIdx = lines.findIndex((l) => new RegExp('exports\\.' + fnName + '\\s*=').test(l));
  if (startIdx < 0) return null;
  const body = lines.slice(startIdx, startIdx + 220).join(NL);
  const cols = new Set();
  (body.match(/collection\(['"]([A-Za-z_]+)['"]\)/g) || []).forEach((m) => {
    cols.add(m.replace(/collection\(['"]/, '').replace(/['"]\)/, ''));
  });
  const mutates = /\.set\(|\.update\(|\.add\(|\.create\(|FieldValue\.increment/.test(body);
  return { collections: Array.from(cols), mutates, definedAt: srcFile + ':' + (startIdx + 1) };
}

/* ── run ───────────────────────────────────────────────────────────────────── */
let traffic;
try { traffic = trafficByCode(); }
catch (e) { console.log('  MONITORING QUERY FAILED: ' + e.message); process.exit(1); }

const ctrlBusy = traffic.oninventoryupdated;
const ctrlTotal = ctrlBusy ? Object.values(ctrlBusy).reduce((a, b) => a + b, 0) : 0;

console.log('');
console.log('  WITHDRAWAL SURFACES — production diagnosis');
console.log('  window ' + DAYS + 'd (' + start.toISOString().slice(0, 10) + ' -> ' +
            end.toISOString().slice(0, 10) + ')   deploy footprint: ' + FOOTPRINT.length + ' files');
console.log('');
if (ctrlTotal === 0) {
  console.log('  CONTROL FAILED — the known-busy service reports nothing. Broken query, not');
  console.log('  a quiet platform. No conclusions drawn.');
  process.exit(1);
}
console.log('  control onInventoryUpdated: ' + ctrlTotal + ' requests -> metric is live');
console.log('  control requestSellerPayout: ' +
            JSON.stringify(traffic.requestsellerpayout || {}) + ' -> the known-live surface');
console.log('');

SURFACES.forEach((s) => {
  const codes = traffic[s.svc] || {};
  const total = Object.values(codes).reduce((a, b) => a + b, 0);
  const any2xx = Object.keys(codes).some((c) => /^2/.test(c));
  const hits = callersOf(s.fn);
  const w = writesOf(s.fn, s.src);

  console.log('  ' + '─'.repeat(68));
  console.log('  ' + s.fn);
  console.log('    1/2 traffic     ' + (total === 0
      ? 'NO time series in ' + DAYS + 'd — not invoked in this window'
      : JSON.stringify(codes) + (any2xx ? '   (reached auth: YES)' : '   (never past auth)')));
  console.log('    3   callers     ' + (hits.length === 0
      ? 'none in the deploy footprint'
      : hits.length + ' in shipped files'));
  hits.slice(0, 4).forEach((h) => {
    console.log('                    ' + h.file + ':' + h.line + '  [' + reachability(h) + ']');
    console.log('                      ' + h.text);
  });
  console.log('    5   writes      ' + (w
      ? (w.mutates ? 'MUTATES ' : 'read-only? ') + (w.collections.join(', ') || '(none seen)') +
        '   @ ' + w.definedAt
      : 'source not located in this tree'));
  console.log('');
});

console.log('  ' + '─'.repeat(68));
console.log('  NOT established by any of the above:');
console.log('    - that a surface with no traffic is unreachable. The window is ' + DAYS +
            ' days;');
console.log('      another lineage or a cached client can still call it.');
console.log('    - the DOMAIN of each surface (merchant payout / savings / admin). That is a');
console.log('      product question and is answered by reading the handler, not the metric.');
console.log('    - whether a caller with no traffic is dead or merely idle.');
console.log('  Classify retain/migrate/redirect/retire only where the evidence reaches.');
console.log('');
