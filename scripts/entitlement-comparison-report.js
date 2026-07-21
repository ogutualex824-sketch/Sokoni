/* Phase 2B — subscription engine dual-run comparison report.
 *
 * Reads entitlementComparison and computes the migration-gate statistics from
 * observed records only. It never writes, never enables a flag, and never
 * infers a result: if there are no records it says so rather than reporting a
 * vacuous 100% match.
 *
 * The gate deliberately FAILS on an empty or undersized sample. A 100% match
 * rate over 3 payments is not evidence, and a report that renders it as green
 * is worse than no report.
 *
 *   node scripts/entitlement-comparison-report.js [--min 100] [--json]
 *
 * Read-only. Requires `gcloud auth` (uses the Firestore REST API).
 */
'use strict';

const { execFileSync } = require('child_process');

const PROJECT = 'sokoni-aeb26';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const COL  = 'entitlementComparison';

const argv    = process.argv.slice(2);
const asJson  = argv.includes('--json');
const MIN_N   = (() => { const i = argv.indexOf('--min'); return i >= 0 ? Number(argv[i + 1]) || 100 : 100; })();

function token() {
  const env = { ...process.env };
  if (!env.CLOUDSDK_PYTHON && process.platform === 'win32') {
    env.CLOUDSDK_PYTHON = 'C:/Users/' + (process.env.USERNAME || '') +
      '/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';
  }
  return execFileSync(process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud',
    ['auth', 'print-access-token'],
    { encoding: 'utf8', env, timeout: 90000, shell: process.platform === 'win32' }).trim();
}

/* Firestore REST returns typed values; collapse to plain JS. */
function val(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return Number(v.doubleValue);
  if ('booleanValue'   in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue'      in v) return null;
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(val);
  if ('mapValue'       in v) {
    const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = val(x);
    return o;
  }
  return null;
}

const pct = (n, d) => (d ? ((n / d) * 100) : 0);
function stats(xs) {
  const a = xs.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return { n: 0, mean: null, median: null, p95: null, min: null, max: null };
  const sum = a.reduce((s, n) => s + n, 0);
  const at = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  return {
    n: a.length,
    mean:   Math.round(sum / a.length),
    median: at(0.50),
    p95:    at(0.95),
    min:    a[0],
    max:    a[a.length - 1],
  };
}

(async () => {
  const t = token();
  const H = { Authorization: 'Bearer ' + t, 'x-goog-user-project': PROJECT };

  /* Page through the whole collection — a partial read would understate
     mismatches, which is the one direction this report must never err in. */
  const docs = [];
  let pageToken = null;
  do {
    const url = `${BASE}/${COL}?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
    const res = await fetch(url, { headers: H });
    if (!res.ok) {
      console.error(`Firestore read failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      process.exitCode = 2; return;
    }
    const j = await res.json();
    (j.documents || []).forEach((d) => {
      const f = {};
      for (const [k, v] of Object.entries(d.fields || {})) f[k] = val(v);
      f._id = d.name.split('/').pop();
      docs.push(f);
    });
    pageToken = j.nextPageToken || null;
  } while (pageToken);

  const total      = docs.length;
  const by = (s) => docs.filter((d) => d.comparisonStatus === s).length;
  const matches    = by('match');
  const mismatches = by('mismatch');
  const engineErr  = by('engine_error');
  const legacyMiss = by('legacy_missing');
  const engineMiss = by('engine_missing');
  const bothAbsent = by('both_absent');
  const failed     = by('compare_failed');

  /* A shadow record that claims it granted something is a contract violation
     and must surface loudly rather than averaging away. */
  const notShadow  = docs.filter((d) => d.shadowOnly !== true).length;

  const engineMs   = stats(docs.map((d) => d.engineDurationMs));
  const legacyMs   = stats(docs.map((d) => d.legacyDurationMs));
  const compareMs  = stats(docs.map((d) => d.comparisonMs));

  const gates = [
    { name: `>= ${MIN_N} payments observed`, ok: total >= MIN_N,        detail: `${total}` },
    { name: '100% comparison match',         ok: total > 0 && matches === total, detail: `${matches}/${total} (${pct(matches, total).toFixed(2)}%)` },
    { name: '0 unexpected mismatches',       ok: mismatches === 0,      detail: `${mismatches}` },
    { name: '0 engine exceptions',           ok: engineErr === 0,       detail: `${engineErr}` },
    { name: '0 comparison failures',         ok: failed === 0,          detail: `${failed}` },
    { name: '0 missing legacy activations',  ok: legacyMiss === 0,      detail: `${legacyMiss}` },
    { name: 'every record shadow-only',      ok: notShadow === 0,       detail: `${notShadow} violations` },
  ];
  const passed = gates.every((g) => g.ok);

  const report = {
    collection: COL, total, minRequired: MIN_N,
    breakdown: { matches, mismatches, engineErr, legacyMiss, engineMiss, bothAbsent, failed, notShadow },
    matchPct: Number(pct(matches, total).toFixed(2)),
    durations: { engineMs, legacyMs, compareMs },
    gates, migrationGate: passed ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
  };

  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exitCode = passed ? 0 : 1; return; }

  console.log('\nSUBSCRIPTION ENGINE — DUAL-RUN COMPARISON REPORT');
  console.log('='.repeat(56));
  if (!total) {
    console.log('\n  NO COMPARISON RECORDS FOUND.');
    console.log('  Shadow mode records only when a subscription payment reaches');
    console.log('  COMPLETE through intasendWebhook. Either none has occurred yet,');
    console.log('  or the webhook build predates the shadow block.');
    console.log('\n  MIGRATION GATE: FAIL (no evidence)\n');
    process.exitCode = 1; return;
  }
  console.log(`\n  total comparisons : ${total}`);
  console.log(`  match             : ${matches}  (${pct(matches, total).toFixed(2)}%)`);
  console.log(`  mismatch          : ${mismatches}`);
  console.log(`  engine refusal    : ${engineErr}`);
  console.log(`  legacy missing    : ${legacyMiss}`);
  console.log(`  engine missing    : ${engineMiss}`);
  console.log(`  compare failed    : ${failed}`);
  console.log(`  NOT shadow-only   : ${notShadow}   <-- must be 0`);
  const row = (label, s) => console.log(
    `  ${label.padEnd(10)} n=${String(s.n).padEnd(5)} mean=${s.mean}  p50=${s.median}  p95=${s.p95}  min=${s.min}  max=${s.max}`);
  console.log('\n  durations (ms)');
  row('engine', engineMs); row('legacy', legacyMs); row('compare', compareMs);

  if (mismatches) {
    console.log('\n  MISMATCH DETAIL (first 10)');
    docs.filter((d) => d.comparisonStatus === 'mismatch').slice(0, 10).forEach((d) => {
      console.log(`    ${d._id}: ${(d.fieldDifferences || []).join(' | ')}`);
    });
  }

  console.log('\n  MIGRATION GATES');
  gates.forEach((g) => console.log(`    [${g.ok ? 'PASS' : 'FAIL'}] ${g.name.padEnd(30)} ${g.detail}`));
  console.log(`\n  MIGRATION GATE: ${report.migrationGate}`);
  console.log(passed
    ? '  -> Safe to recommend subscriptionEngine = true for ONE test merchant.\n'
    : '  -> Do NOT enable subscriptionEngine.\n');
  process.exitCode = passed ? 0 : 1; return;
})().catch((e) => { console.error('report failed:', e.message); process.exitCode = 2; });
