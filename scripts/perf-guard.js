/* SOKONI performance regression guard.
 *
 * Codifies the defects found during the POS startup incident so the same class
 * cannot be reintroduced silently:
 *
 *   - a full-store getAll() inside a loop      (O(M x P) amplification)
 *   - forEach(async …)                          (unbounded promise fan-out)
 *   - a precached POS startup script that is not network-first in the
 *     service worker                            (fix cannot reach the device)
 *
 * It is a RATCHET, not a gate on perfection. Known remaining instances are
 * recorded in a baseline; the build fails only when a count rises above it.
 * That keeps CI honest about existing debt while making new debt impossible to
 * add quietly — a guard that fails on day one gets disabled by day two.
 *
 *   node scripts/perf-guard.js            check against the baseline
 *   node scripts/perf-guard.js --update   re-record the baseline (review the diff!)
 *   node scripts/perf-guard.js --json     machine-readable output
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'perf-guard-baseline.json');
const UPDATE = process.argv.includes('--update');
const AS_JSON = process.argv.includes('--json');

const SKIP = /node_modules|[\\/]\.claude[\\/]|[\\/]\.git[\\/]|[\\/]scripts[\\/]|[\\/]functions[\\/]|[\\/]docs[\\/]|cf-complete-audit|cf-migration-plan/;

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

/* A getAll() is only a problem when it sits INSIDE an iteration — one per view
   render is normal and must not be flagged, or the guard cries wolf and gets
   ignored. Look back a short window for an enclosing loop construct. */
function findAmplification(text) {
  const lines = text.split('\n');
  const hits = [];
  const LOOP = /\b(for\s*\(|for\s+of\b|for\s+await\b|while\s*\(|\.forEach\s*\(|\.map\s*\(|\.flatMap\s*\()/;
  lines.forEach((ln, i) => {
    if (!/\.getAll\s*\(/.test(ln)) return;
    const back = lines.slice(Math.max(0, i - 12), i).join('\n');
    if (LOOP.test(back)) hits.push({ line: i + 1, code: ln.trim().slice(0, 100) });
  });
  return hits;
}

function findFanOut(text) {
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((ln, i) => {
    /* Only real code — a comment describing the anti-pattern is not the
       anti-pattern, and this file's own history proves that matters. */
    const stripped = ln.replace(/^\s*(\*|\/\/|\/\*).*$/, '');
    if (/\.forEach\s*\(\s*async\b/.test(stripped)) hits.push({ line: i + 1, code: ln.trim().slice(0, 100) });
  });
  return hits;
}

/* Any script the service worker precaches AND that runs on the POS startup
   path must be network-first, or a fix to it cannot reach a terminal that
   crashes during startup — the failure mode blocks its own repair. */
function findStaleDelivery() {
  const swPath = path.join(ROOT, 'service-worker.js');
  if (!fs.existsSync(swPath)) return [];
  const sw = fs.readFileSync(swPath, 'utf8');
  const fresh = (sw.match(/ALWAYS_FRESH\s*=\s*\[[\s\S]*?\]/) || [''])[0];
  const CRITICAL = ['pos-omni.js', 'pos-modules.js', 'pos-db.js', 'pos-sync.js', 'firebase.js', 'auth.js'];
  const precached = CRITICAL.filter((f) => new RegExp('"/' + f.replace('.', '\\.') + '"').test(sw));
  return precached.filter((f) => !fresh.includes(f)).map((f) => ({ file: f, reason: 'precached but not network-first' }));
}

const files = walk(ROOT);
const report = { amplification: {}, fanOut: {}, staleDelivery: [], totals: {} };

for (const f of files) {
  let t = '';
  try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const amp = findAmplification(t);
  const fan = findFanOut(t);
  if (amp.length) report.amplification[rel] = amp;
  if (fan.length) report.fanOut[rel] = fan;
}
report.staleDelivery = findStaleDelivery();

report.totals = {
  amplification: Object.values(report.amplification).reduce((s, a) => s + a.length, 0),
  fanOut:        Object.values(report.fanOut).reduce((s, a) => s + a.length, 0),
  staleDelivery: report.staleDelivery.length,
  filesScanned:  files.length,
};

if (UPDATE) {
  fs.writeFileSync(BASELINE, JSON.stringify({ totals: report.totals, recorded: 'manual' }, null, 2) + '\n');
  console.log('[perf-guard] baseline updated:', JSON.stringify(report.totals));
  return;
}

let baseline = null;
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).totals; } catch (_) {}

if (AS_JSON) { console.log(JSON.stringify({ report, baseline }, null, 2)); }

const fails = [];
if (baseline) {
  for (const k of ['amplification', 'fanOut', 'staleDelivery']) {
    if (report.totals[k] > baseline[k]) {
      fails.push(`${k}: ${report.totals[k]} > baseline ${baseline[k]}`);
    }
  }
}

if (!AS_JSON) {
  console.log('\n[perf-guard] scanned ' + report.totals.filesScanned + ' client files');
  console.log('  getAll() inside a loop      : ' + report.totals.amplification + (baseline ? '   (baseline ' + baseline.amplification + ')' : ''));
  console.log('  forEach(async …) fan-out    : ' + report.totals.fanOut + (baseline ? '   (baseline ' + baseline.fanOut + ')' : ''));
  console.log('  precached but not fresh     : ' + report.totals.staleDelivery + (baseline ? '   (baseline ' + baseline.staleDelivery + ')' : ''));

  if (report.staleDelivery.length) {
    console.log('\n  STALE DELIVERY RISK');
    report.staleDelivery.forEach((d) => console.log('    ' + d.file + ' — ' + d.reason));
  }
  if (fails.length) {
    console.log('\n  FAIL — a regression was introduced:');
    fails.forEach((f) => console.log('    ' + f));
    console.log('\n  A getAll() inside a loop is O(M x P): it re-reads the whole store per item.');
    console.log('  Read once before the loop and index by key. See commit 54b3e63.');
  } else if (baseline) {
    console.log('\n  PASS — no regression above baseline\n');
  } else {
    console.log('\n  no baseline recorded — run with --update to create one\n');
  }
}

process.exitCode = fails.length ? 1 : 0;
