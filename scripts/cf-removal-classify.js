/* ══════════════════════════════════════════════════════════════════════════════
   CF REMOVAL CLASSIFICATION — SAFE_REMOVE / REVIEW_REQUIRED / KEEP
   ══════════════════════════════════════════════════════════════════════════════
   The hard invariant of the consolidation programme:

       removal candidate = unreferenced in source AND un-invoked in production

   Neither half is sufficient. Source analysis misses a cached PWA client still
   calling yesterday's name; the invocation census only sees its own window, so a
   quarterly function is indistinguishable from a dead one inside 30 days.

   Buckets:

     KEEP             referenced by a client or another server module, OR a
                      protected payment/subscription authority, OR in a module
                      that builds callable names at runtime
     REVIEW_REQUIRED  unreferenced and un-invoked, but the window cannot settle
                      it — a rare-by-design name, or a module carrying scheduled
                      work whose period may exceed the window
     SAFE_REMOVE      unreferenced, un-invoked, and nothing suggests the window
                      is too short to see it

   EVERY record carries the census coverage window. "0 invocations" without the
   window it was measured over is not evidence, and six months from now nobody
   should be able to read this file and assume it meant "never used".

   READ ONLY. Produces a review artefact. Deletes nothing, deploys nothing.

     node scripts/cf-removal-classify.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

/* ── PROTECTED AUTHORITIES ────────────────────────────────────────────────────
   Never removed, never dispatched, never merged by this programme. The point is
   not only that these NAMES survive: the single activation authority must too —

       webhook -> PAID -> onPaymentIntentPaid -> reconcilePaidIntent
                       -> subscription -> entitlement

   No dispatcher or factory may introduce a second subscription writer. Adding a
   name here is cheap; discovering one was needed after deletion is not. */
const PROTECTED = new Set([
  'createPaymentIntent', 'initiateSTKPush', 'intasendWebhook', 'webhookIntasend',
  'onPaymentIntentPaid', 'reconcileSubscriptionPayment', 'payIntentWithWallet',
  'subActivate', 'getMerchantEntitlements', 'subscriptionPaymentMethods',
  'onSubscriptionChangedSyncLimit', 'onAiSubscriptionChangedSyncLimit',
  'merchantIdentity', 'employeeSaleAuthorize', 'adminLinkMerchantAccounts',
]);

/* Product capabilities explicitly OUT of scope. Degraded is not dead: Algolia
   falls back to Firestore because the stored key is invalid, so its sync
   surface is an intentional capability awaiting a credential, not dead code.
   Retiring it is a product decision taken separately. */
const OUT_OF_SCOPE_PREFIX = ['algoliaSync', 'searchSync', 'ts_'];

/* Names that are rare BY DESIGN. A 30-day window cannot clear these. */
const RARE_BY_DESIGN = /(annual|yearly|quarter|monthly|month|eoy|yearend|tax|vat|etims|audit|reconcil|backfill|migrat|repair|seed|export|archive|purge|disaster|restore|rollback|bootstrap|onboard)/i;

const CENSUS_PATH = path.join(ROOT, 'docs/cf-invocation-census.json');
if (!fs.existsSync(CENSUS_PATH)) {
  console.error('\n  No census. Run: node scripts/cf-invocation-census.js\n');
  process.exit(2);
}
const census = JSON.parse(fs.readFileSync(CENSUS_PATH, 'utf8'));

/* Cloud Run service names are lowercased and underscore-free. */
const norm = (s) => String(s).toLowerCase().replace(/_/g, '-');
const invoked = {};
for (const [k, v] of Object.entries(census.counts || {})) invoked[norm(k)] = v;

/* ── deployed set ─────────────────────────────────────────────────────────── */
let deployed = null;
try {
  const raw = execFileSync('powershell', ['-NoProfile', '-Command',
    "$env:CLOUDSDK_PYTHON='bundled'; npx -y firebase-tools@latest functions:list --project sokoni-aeb26"],
    { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 300000 });
  const ESC = String.fromCharCode(27);
  const clean = raw.split(ESC).map((s, i) => (i === 0 ? s : s.replace(/^\[[0-9;]*m/, ''))).join('');
  const names = clean.split('\n').filter((l) => l.indexOf('│') > -1)
    .map((l) => (l.split('│')[1] || '').trim())
    .filter((s) => s && s !== 'Function');
  if (names.length) deployed = new Set(names);
} catch (_) { deployed = null; }

/* ── reachability, recomputed here so the artefact is self-contained ──────── */
function collect(dir, skipFunctions) {
  const out = [];
  (function walk(d) {
    let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const x of e) {
      if (x.name === 'node_modules' || x.name === '.git') continue;
      if (skipFunctions && x.name === 'functions') continue;
      const p = path.join(d, x.name);
      if (x.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html|mjs)$/.test(x.name)) continue;
      let s; try { s = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      out.push({ p: path.relative(ROOT, p).split(path.sep).join('/'), s });
    }
  })(dir);
  return out;
}
const clientFiles = collect(ROOT, true).filter((f) => !/^(docs|scripts)\//.test(f.p));
const serverFiles = collect(FN, false);
const DYNAMIC_RE = /httpsCallable\s*\(\s*[^'")]/;

/* ── THE POPULATION THAT COUNTS ───────────────────────────────────────────────
   The gate measures `Object.keys(require(index.js))`. A function defined in a
   module but never re-exported there is NOT deployed and does NOT count toward
   the 1692 — removing it reduces the budget by exactly zero.

   Classifying module-level definitions instead of exports was a real error in
   the first pass of this programme: it produced 59 confident "SAFE_REMOVE"
   candidates of which ZERO were exported. They are source hygiene, tracked
   separately, and must never be counted as progress toward 1480. */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'sokoni-aeb26' });
let EXPORTED;
try {
  EXPORTED = new Set(Object.keys(require(path.join(FN, 'index.js'))));
} catch (e) {
  console.error('\n  Cannot enumerate exports from functions/index.js: ' + e.message);
  console.error('  Without the export set this classification would measure the wrong population.\n');
  process.exit(2);
}

const files = fs.readdirSync(FN).filter((f) => /\.js$/.test(f));
const records = [];
const notExported = [];

for (const f of files) {
  const mod = f.replace(/\.js$/, '');
  let src; try { src = fs.readFileSync(path.join(FN, f), 'utf8'); } catch (_) { continue; }

  const all = [];
  const re = /^\s*(?:exports\.([A-Za-z0-9_]+)\s*=|const\s+([A-Za-z0-9_]+)\s*=)\s*onCall\s*\(/gm;
  let m;
  while ((m = re.exec(src))) all.push(m[1] || m[2]);
  if (!all.length) continue;

  const names = all.filter((n) => EXPORTED.has(n));
  all.filter((n) => !EXPORTED.has(n)).forEach((n) => notExported.push({ name: n, module: mod }));
  if (!names.length) continue;

  const dynamic = DYNAMIC_RE.test(src);
  const hasSchedule = /onSchedule\s*\(/.test(src);

  for (const n of names) {
    const word = new RegExp('\\b' + n + '\\b');
    const client = clientFiles.some((x) => word.test(x.s));
    const server = serverFiles.some((x) => x.p !== 'functions/' + f && word.test(x.s));
    const hits = invoked[norm(n)] || 0;
    const outOfScope = OUT_OF_SCOPE_PREFIX.some((p) => n.indexOf(p) === 0);

    let bucket, why;
    if (PROTECTED.has(n))            { bucket = 'KEEP'; why = 'protected payment/subscription authority'; }
    else if (outOfScope)             { bucket = 'KEEP'; why = 'out of programme scope (degraded != dead)'; }
    else if (dynamic)                { bucket = 'KEEP'; why = 'module builds callable names at runtime'; }
    else if (client || server)       { bucket = 'KEEP'; why = 'referenced by ' + [client && 'client', server && 'server'].filter(Boolean).join('+'); }
    else if (hits > 0)               { bucket = 'KEEP'; why = 'invoked ' + hits + 'x in window'; }
    else if (RARE_BY_DESIGN.test(n)) { bucket = 'REVIEW_REQUIRED'; why = 'rare by design — window cannot clear it'; }
    else if (hasSchedule)            { bucket = 'REVIEW_REQUIRED'; why = 'module carries scheduled work; period may exceed window'; }
    else                             { bucket = 'SAFE_REMOVE'; why = 'unreferenced in source AND un-invoked in window'; }

    records.push({
      name: n, module: mod, bucket, why,
      referencedByClient: client, referencedByServer: server,
      invocationsInWindow: hits,
      deployed: deployed ? deployed.has(n) : null,
      /* stamped on EVERY record, deliberately */
      coverageStart: census.coverage.startTime,
      coverageEnd: census.coverage.endTime,
      coverageDays: census.coverage.requestedDays,
    });
  }
}

const by = (b) => records.filter((r) => r.bucket === b);
const out = {
  generatedAt: census.generatedAt,
  invariant: 'removal candidate = unreferenced in source AND un-invoked in production',
  coverage: census.coverage,
  protectedAuthorities: [...PROTECTED],
  outOfScopePrefixes: OUT_OF_SCOPE_PREFIX,
  totals: {
    examinedExportedOnCall: records.length,
    KEEP: by('KEEP').length,
    REVIEW_REQUIRED: by('REVIEW_REQUIRED').length,
    SAFE_REMOVE: by('SAFE_REMOVE').length,
  },
  /* Defined in a module but never re-exported by index.js: not deployed, and
     worth ZERO toward the budget. Source hygiene, tracked so it is never
     mistaken for progress. */
  definedButNotExported: { count: notExported.length, items: notExported },
  records,
};
fs.writeFileSync(path.join(ROOT, 'docs/cf-removal-classification.json'), JSON.stringify(out, null, 2) + '\n');

console.log('\nCF REMOVAL CLASSIFICATION');
console.log('='.repeat(78));
console.log('  invariant : unreferenced in source AND un-invoked in production');
console.log('  window    : ' + census.coverage.startTime + '  ->  ' + census.coverage.endTime);
console.log('              (' + census.coverage.requestedDays + ' days — recorded on every record below)');
console.log('  deployed set : ' + (deployed ? deployed.size + ' functions' : 'UNAVAILABLE (orphan risk unknown)'));
console.log('');
console.log('  EXPORTED onCall examined  : ' + records.length + '   (only these count toward 1692)');
console.log('  defined but NOT exported  : ' + notExported.length + '   (worth ZERO toward the budget)');
console.log('  KEEP             : ' + out.totals.KEEP);
console.log('  REVIEW_REQUIRED  : ' + out.totals.REVIEW_REQUIRED);
console.log('  SAFE_REMOVE      : ' + out.totals.SAFE_REMOVE);
console.log('');

const modOf = {};
by('SAFE_REMOVE').forEach((r) => { (modOf[r.module] = modOf[r.module] || []).push(r.name); });
const ranked = Object.entries(modOf).sort((a, b) => b[1].length - a[1].length);
console.log('  SAFE_REMOVE by module (first slice candidates):');
ranked.slice(0, 14).forEach(([mod, list]) =>
  console.log('    ' + mod.padEnd(34) + String(list.length).padStart(4)));

console.log('');
console.log('  target reduction 212 — SAFE_REMOVE alone covers ' +
  Math.min(100, Math.round((out.totals.SAFE_REMOVE / 212) * 100)) + '% of it');
console.log('  written: docs/cf-removal-classification.json');
console.log('='.repeat(78) + '\n');
