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

/* A real-time listener over an ENTIRE collection streams and RETAINS every
   document in memory — the homepage-OOM class that crashed the mobile renderer
   on a large catalogue (fixed by bounding the subscription to limit(200),
   commit 552bca5). A listener over a bounded query (`limit`), an owner-scoped
   query (`where`), or a single doc (`doc`) is fine and MUST NOT be flagged —
   onSnapshot appears in 50+ files, almost all legitimately, and a guard that
   cries wolf gets disabled. So we flag ONLY the whole-collection form:
     modular:  onSnapshot(collection(...), cb)     — first arg a bare collection
     compat:   x.collection('Y').onSnapshot(cb)     — no where/limit/doc in the chain
   query(collection(...), limit(...)) and .collection(...).where(...).onSnapshot()
   do not match, by construction.

   DO NOT BROADEN THIS REGEX. This ratchet protects against the PROVEN homepage-OOM
   regression class (whole-collection realtime listeners) and nothing else. Category-
   scoped or otherwise-unbounded feed QUERIES are intentionally OUT OF SCOPE here —
   they will be addressed by feed-specific guards during the shared-feed convergence,
   informed by the real feed architecture. Widening this to "every onSnapshot without
   limit()" would flag the 50+ legitimate doc/owner-scoped listeners, cry wolf, and get
   the whole guard disabled — which is exactly the failure mode perf-guard warns about. */
function findUnboundedListeners(text) {
  const lines = text.split('\n');
  const hits = [];
  const MODULAR = /onSnapshot\s*\(\s*collection\s*\(/;              /* onSnapshot(collection(...)) */
  const COMPAT  = /\.collection\s*\([^)]*\)\s*\.onSnapshot\s*\(/;   /* .collection('Y').onSnapshot( */
  lines.forEach((ln, i) => {
    /* A comment describing the anti-pattern is not the anti-pattern. */
    if (/^\s*(\*|\/\/|\/\*)/.test(ln)) return;
    if (MODULAR.test(ln) || COMPAT.test(ln)) hits.push({ line: i + 1, code: ln.trim().slice(0, 100) });
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

/* ── Architecture-duplication ratchet (ADR-0001, ADR-0002) ────────────────
   The platform repeatedly grew a SECOND engine for a subsystem that already
   had one — eleven print engines, two receipt engines assigning the same
   global on the same page. These counts baseline the current (bad) state and
   fail the build only when it gets WORSE. That blocks the next duplicate at
   the point of the mistake without demanding the whole convergence land first
   — a gate that failed on today's reality would be disabled by tomorrow. */
function countGlobalAssigners(globalName) {
  const re = new RegExp('(window|global|root)\\.' + globalName + '\\s*=', '');
  return files.filter((f) => {
    if (!/\.js$/.test(f)) return false;
    try { return re.test(fs.readFileSync(f, 'utf8')); } catch (_) { return false; }
  }).length;
}

/* Max printer-module <script> tags on any single HTML page. NOTE: more than one
   is not per se a defect — the six on pos.html are complementary layers, proven
   by per-file API/consumer analysis. This counts them only to catch a NEW one
   arriving unreviewed. A name or an ESC/POS table never proves duplication. */
function maxPrinterEnginesPerPage() {
  const ENGINES = ['sokoni-universal-printer', 'sokoni-print-engine', 'sokoni-pos-print',
    'sokoni-pos-print-service', 'sokoni-printer-manager', 'sokoni-printer-drivers',
    'sokoni-printer-driver', 'pos-printer', 'sokoni-printer-providers'];
  let max = 0, worst = null;
  for (const f of files) {
    if (!/\.html$/.test(f)) continue;
    let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const n = ENGINES.filter((e) => new RegExp('src="' + e + '\\.js"').test(t)).length;
    if (n > max) { max = n; worst = path.relative(ROOT, f).replace(/\\/g, '/'); }
  }
  return { max, worst };
}

/* ── Startup cost on the POS page ────────────────────────────────────────
   Parser-blocking scripts were cut from 41 to 3 during the iPhone crash
   incident. This locks that in: a ratchet says "no worse than today's verified
   baseline", which survives contact with a real codebase in a way an idealised
   budget does not — a guard that fails on day one is disabled by day two.

   The regex matches the WHOLE tag. An earlier ad-hoc measurement used
   /<script[^>]*src=/ which truncates before the attributes that follow src, so
   `defer` was invisible and every count taken with it was wrong. That mistake
   produced three incorrect findings in one day; it is written down here so the
   next person does not repeat it. */
function countBlockingScripts(htmlPath) {
  let t = '';
  try { t = fs.readFileSync(htmlPath, 'utf8'); } catch (_) { return null; }
  const tags = [...t.matchAll(/<script\b[^>]*\bsrc=[^>]*>/gi)].map((m) => m[0]);
  const deferred = tags.filter((tag) => /\bdefer\b|\basync\b|type=["']module["']/.test(tag));
  return { total: tags.length, blocking: tags.length - deferred.length };
}

const files = walk(ROOT);
const report = { amplification: {}, fanOut: {}, unbounded: {}, staleDelivery: [], totals: {} };

for (const f of files) {
  let t = '';
  try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const amp = findAmplification(t);
  const fan = findFanOut(t);
  const unb = findUnboundedListeners(t);
  if (amp.length) report.amplification[rel] = amp;
  if (fan.length) report.fanOut[rel] = fan;
  if (unb.length) report.unbounded[rel] = unb;
}
report.staleDelivery = findStaleDelivery();

const printerPages = maxPrinterEnginesPerPage();
report.worstPrinterPage = printerPages.worst;

report.totals = {
  amplification: Object.values(report.amplification).reduce((s, a) => s + a.length, 0),
  fanOut:        Object.values(report.fanOut).reduce((s, a) => s + a.length, 0),
  /* Unbounded whole-collection real-time listeners (homepage-OOM class). Ratchet:
     existing ones are baselined; a NEW one fails the build. See findUnboundedListeners. */
  unboundedCollectionListeners: Object.values(report.unbounded).reduce((s, a) => s + a.length, 0),
  staleDelivery: report.staleDelivery.length,
  /* ADR-0002: receiptEngines baselines at 2 — a thermal byte builder and an
     on-screen receipt UI, complementary and both required. The metric blocks a
     THIRD owner; it is not driving the count to one. See the superseded note. */
  receiptEngines: countGlobalAssigners('SokoniReceiptEngine'),
  printerDriverGlobals: countGlobalAssigners('SokoniPrinterDrivers'),
  posBlockingScripts:  (countBlockingScripts(path.join(ROOT, 'pos.html')) || {}).blocking,
  posStartupScripts:   (countBlockingScripts(path.join(ROOT, 'pos.html')) || {}).total,
  /* ADR-0001: printerEnginesPerPage baselines at 6. A behavioural audit proved
     those six are a layered stack — transport, document library, fleet manager,
     orchestrator, encoder library, adapter — with zero true duplicates. The
     metric blocks a SEVENTH; it is not driving the count to one. */
  printerEnginesPerPage: printerPages.max,
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
const warnings = [];   /* WARN_ONLY metrics land here — reported, not fatal */
if (baseline) {
  /* Derive the ratcheted keys from the baseline rather than hardcoding them.
     A hardcoded list silently stopped enforcing the duplication metrics the
     moment they were added — the gate reported PASS on a seventh printer
     engine. Anything numeric in the baseline is now ratcheted by construction,
     so a future metric cannot be added and left unenforced. filesScanned is
     excluded: it grows as the repo grows and is context, not a budget. */
  const RATCHET_EXEMPT = new Set(['filesScanned']);
  /* Warn-only while the right threshold is still being learned. A metric moves
     out of this set once its baseline has held across a few releases; failing a
     build on a number nobody trusts yet just teaches people to ignore the gate. */
  const WARN_ONLY = new Set(['posStartupScripts']);
  for (const k of Object.keys(baseline)) {
    if (RATCHET_EXEMPT.has(k)) continue;
    if (typeof baseline[k] !== 'number' || typeof report.totals[k] !== 'number') continue;
    if (report.totals[k] > baseline[k]) {
      const msg = `${k}: ${report.totals[k]} > baseline ${baseline[k]}`;
      if (WARN_ONLY.has(k)) warnings.push(msg); else fails.push(msg);
    }
  }
}

if (!AS_JSON) {
  console.log('\n[perf-guard] scanned ' + report.totals.filesScanned + ' client files');
  console.log('  getAll() inside a loop      : ' + report.totals.amplification + (baseline ? '   (baseline ' + baseline.amplification + ')' : ''));
  console.log('  SokoniReceiptEngine owners  : ' + report.totals.receiptEngines + (baseline && baseline.receiptEngines != null ? '   (baseline ' + baseline.receiptEngines + ', complementary — blocks a 3rd)' : ''));
  console.log('  SokoniPrinterDrivers owners : ' + report.totals.printerDriverGlobals + (baseline && baseline.printerDriverGlobals != null ? '   (baseline ' + baseline.printerDriverGlobals + ', distinct shapes — see ADR-0001)' : ''));
  console.log('  pos.html blocking scripts   : ' + report.totals.posBlockingScripts + (baseline && baseline.posBlockingScripts != null ? '   (baseline ' + baseline.posBlockingScripts + ')' : ''));
  console.log('  pos.html total scripts      : ' + report.totals.posStartupScripts + (baseline && baseline.posStartupScripts != null ? '   (baseline ' + baseline.posStartupScripts + ', warn-only)' : ''));
  console.log('  printer engines on one page : ' + report.totals.printerEnginesPerPage + (baseline && baseline.printerEnginesPerPage != null ? '   (baseline ' + baseline.printerEnginesPerPage + ', layered — blocks a 7th)' : '') + (report.worstPrinterPage ? '  [' + report.worstPrinterPage + ']' : ''));
  console.log('  forEach(async …) fan-out    : ' + report.totals.fanOut + (baseline ? '   (baseline ' + baseline.fanOut + ')' : ''));
  console.log('  unbounded feed listeners    : ' + report.totals.unboundedCollectionListeners + (baseline && baseline.unboundedCollectionListeners != null ? '   (baseline ' + baseline.unboundedCollectionListeners + ', whole-collection onSnapshot — blocks a NEW one)' : ''));
  console.log('  precached but not fresh     : ' + report.totals.staleDelivery + (baseline ? '   (baseline ' + baseline.staleDelivery + ')' : ''));

  if (report.staleDelivery.length) {
    console.log('\n  STALE DELIVERY RISK');
    report.staleDelivery.forEach((d) => console.log('    ' + d.file + ' — ' + d.reason));
  }
  if (warnings.length) {
    console.log('\n  WARN (not failing yet — threshold still being learned):');
    warnings.forEach((w) => console.log('    ' + w));
  }
  if (fails.length) {
    console.log('\n  FAIL — a regression was introduced:');
    fails.forEach((f) => console.log('    ' + f));
    if (fails.some((f) => f.startsWith('amplification'))) {
      console.log('\n  A getAll() inside a loop is O(M x P): it re-reads the whole store per item.');
      console.log('  Read once before the loop and index by key. See commit 54b3e63.');
    }
    if (fails.some((f) => f.startsWith('unboundedCollectionListeners'))) {
      console.log('\n  A live onSnapshot over an ENTIRE collection streams and retains every document —');
      console.log('  the homepage-OOM class that crashed the mobile renderer (commit 552bca5). Bound the');
      console.log('  subscription with limit() (see sokoni-db.js, cap 200) or scope it with an owner');
      console.log('  where(...). Single-doc, owner-scoped, and limited listeners are fine and not flagged.');
    }
  } else if (baseline) {
    console.log('\n  PASS — no regression above baseline\n');
  } else {
    console.log('\n  no baseline recorded — run with --update to create one\n');
  }
}

process.exitCode = fails.length ? 1 : 0;
