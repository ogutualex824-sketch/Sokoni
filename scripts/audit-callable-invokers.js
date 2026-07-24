#!/usr/bin/env node
'use strict';

/**
 * audit-callable-invokers.js — can the browser actually REACH our callables?
 *
 *   node scripts/audit-callable-invokers.js                 critical set (fast)
 *   node scripts/audit-callable-invokers.js requestDataExport getBusinessConfig
 *   node scripts/audit-callable-invokers.js --all            every HTTP-reachable fn
 *   node scripts/audit-callable-invokers.js --probe          also send an unauth POST
 *   node scripts/audit-callable-invokers.js --refresh        re-pull the deployed list
 *   node scripts/audit-callable-invokers.js --json
 *
 * WHY THIS EXISTS
 * A Firebase callable is deployed, its source is correct, its trigger exists — and
 * it is still unreachable, because the underlying Cloud Run service is missing the
 * `roles/run.invoker` binding for `allUsers`. Nothing in the repository can show
 * this: the defect lives entirely in deployed IAM state. It was found on
 * requestDataExport / getDataExportStatus only by probing production, and the
 * GDPR/DPA export flow was 100% broken because of it.
 *
 * The security boundary for a callable is NOT IAM — it is `request.auth` plus App
 * Check, enforced inside the function. `allUsers` invoker is what lets the request
 * reach that check at all, and it is what every working callable here already has.
 * So a missing binding is a reachability defect, not a hardening measure.
 *
 * THREE TRAPS THIS ENCODES (each cost real time to find)
 *  1. Cloud Run service names are LOWERCASE. `requestDataExport` is not a service;
 *     `requestdataexport` is. Query the camelCase form and you audit nothing.
 *  2. `:getIamPolicy` returns an EMPTY POLICY for a resource that does not exist,
 *     not a 404. So a wrong name looks exactly like "no bindings" — a false
 *     negative that reads as evidence. This verifies the service EXISTS first.
 *  3. `services.list` is unusable here: it caps at 500 of ~1600 and its pagination
 *     returns HTTP 500. Every service is therefore fetched directly by name.
 *
 * Event- and schedule-triggered functions are SKIPPED, not failed: they are invoked
 * by Eventarc/Scheduler, never over public HTTP, so a missing invoker binding on
 * them is expected and correct (e.g. processDataExport).
 *
 * Read-only. It changes nothing; it prints the gcloud commands for what it finds.
 *
 * WHAT A CLEAN RUN DOES AND DOES NOT MEAN — read before trusting a green result.
 * This detects exactly ONE failure mode: the Cloud Run service behind an
 * HTTP-reachable function is missing the `roles/run.invoker` binding, so requests
 * are rejected before the function executes. A clean run means:
 *
 *     "No endpoint in the audited set exhibits this specific IAM misconfiguration."
 *
 * It does NOT mean "all callable functions are correctly configured." It says
 * nothing about whether the function's own authorization logic is right, whether
 * App Check is enforced, whether Firestore Rules behave as intended, or whether the
 * business logic works. Those need their own checks. Do not let a green table here
 * stand in for any of them.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const PROJECT = process.env.SOKONI_PROJECT || 'sokoni-aeb26';
const REGION  = process.env.SOKONI_REGION  || 'us-central1';
const ROOT    = path.resolve(__dirname, '..');
const CACHE   = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'sokoni-fnlist.json');

const argv     = process.argv.slice(2);
const AS_JSON  = argv.includes('--json');
const DO_ALL   = argv.includes('--all');
const DO_PROBE = argv.includes('--probe');
const REFRESH  = argv.includes('--refresh');
const NAMES    = argv.filter((a) => !a.startsWith('--'));

/* Release-critical callables. Not exhaustive — it is the set whose failure would
   stop money, sign-in, selling or a legal obligation. Use --all for everything. */
const CRITICAL = [
  'createCheckoutSession', 'verifyIntasendPayment', 'applyPromoCode',
  'requestDataExport', 'getDataExportStatus',
  'scheduleAccountDeletion', 'cancelAccountDeletion', 'revokeAllSessions',
  'bootstrapDevice', 'getBusinessConfig', 'getTypesenseSearchKey',
  'sokoniChat', 'bookAppointment',
];

/* ── auth ──────────────────────────────────────────────────────────────────
   Mirrors scripts/reconcile-indexes.js::token(). Duplicated deliberately: that
   script is a live deploy gate and is not worth destabilising for a shared
   helper. Consolidate when a third caller appears. */
function token() {
  const cfg = path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'configstore', 'firebase-tools.json');
  const rt  = JSON.parse(fs.readFileSync(cfg, 'utf8')).tokens.refresh_token;
  const body = new URLSearchParams({
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    refresh_token: rt, grant_type: 'refresh_token',
  }).toString();
  const at = JSON.parse(execSync(`curl -s -X POST -d "${body}" https://oauth2.googleapis.com/token`, { encoding: 'utf8' })).access_token;
  if (!at) throw new Error('could not mint access token — run: npx firebase-tools login');
  return at;
}

const runGet = (at, p) => new Promise((res) => {
  https.get({ host: 'run.googleapis.com', path: p, headers: { Authorization: 'Bearer ' + at } }, (r) => {
    let b = ''; r.on('data', (d) => b += d);
    r.on('end', () => { try { res({ status: r.statusCode, json: JSON.parse(b) }); } catch (_) { res({ status: r.statusCode, json: null }); } });
  }).on('error', () => res({ status: 0, json: null }));
});

/* Unauthenticated POST. 401 => the request REACHED the function and its own auth
   rejected it (healthy). 403 => rejected at the invocation layer, before the code. */
const probe = (name) => new Promise((res) => {
  const data = JSON.stringify({ data: {} });
  const req = https.request({
    host: `${REGION}-${PROJECT}.cloudfunctions.net`, path: `/${name}`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (r) => { r.resume(); res(r.statusCode); });
  req.on('error', () => res(0));
  req.write(data); req.end();
});

function inventory() {
  if (REFRESH || !fs.existsSync(CACHE)) {
    process.stderr.write('  pulling deployed function list…\n');
    execSync(`npx -y firebase-tools@latest functions:list --project ${PROJECT} --json > "${CACHE}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
  }
  const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  return j.result || j;
}

const kindOf = (f) =>
  f.callableTrigger ? 'callable'
  : f.httpsTrigger  ? 'https'
  : f.eventTrigger  ? 'event'
  : f.scheduleTrigger ? 'schedule' : 'other';

(async () => {
  const fns = inventory();
  const byId = new Map(fns.map((f) => [f.id, f]));

  let targets;
  if (NAMES.length)   targets = NAMES;
  else if (DO_ALL)    targets = fns.filter((f) => ['callable', 'https'].includes(kindOf(f))).map((f) => f.id);
  else                targets = CRITICAL;

  const at = token();

  async function auditOne(id) {
    const meta = byId.get(id);
    if (!meta) return { id, kind: '—', verdict: 'NOT-DEPLOYED' };

    const kind = kindOf(meta);
    if (!['callable', 'https'].includes(kind)) {
      /* Invoked by Eventarc/Scheduler, never public HTTP — a missing binding here
         is correct, not a defect. Reported so the difference is documented. */
      return { id, kind, verdict: 'SKIP', note: 'not HTTP-invoked' };
    }

    const svc  = id.toLowerCase();                      // TRAP 1
    const base = `/v2/projects/${PROJECT}/locations/${REGION}/services/${svc}`;

    /* Policy FIRST. If it names an invoker the service must exist, so the extra
       existence round-trip is only needed for the empty case — which is exactly
       the case TRAP 2 makes ambiguous (missing resource also yields an empty
       policy). Halves the API calls across a --all sweep without losing rigour. */
    const pol = await runGet(at, `${base}:getIamPolicy`);
    const members = (((pol.json || {}).bindings) || [])
      .filter((b) => b.role === 'roles/run.invoker')
      .flatMap((b) => b.members || []);

    if (!members.length) {                               // TRAP 2 — disambiguate
      const got = await runGet(at, base);
      if (got.status !== 200) {
        return { id, kind, verdict: 'NO-SERVICE', note: `GET service HTTP ${got.status}` };
      }
    }
    const open = members.includes('allUsers');

    let code = null;
    if (DO_PROBE) code = await probe(id);

    const verdict = open ? (DO_PROBE && code === 403 ? 'FAIL' : 'PASS') : 'FAIL';
    return { id, kind, invoker: members.join(',') || '(none)', probe: code, verdict };
  }

  /* Bounded worker pool — a --all sweep is ~1200 services and would take about a
     quarter of an hour issued serially. Order is preserved via the index. */
  const CONCURRENCY = Number(process.env.SOKONI_AUDIT_CONCURRENCY || 12);
  const rows = new Array(targets.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= targets.length) return;
      rows[i] = await auditOne(targets[i]);
      if (!AS_JSON && targets.length > 50 && i % 100 === 0 && i) process.stderr.write(`  …${i}/${targets.length}\n`);
    }
  }));

  if (AS_JSON) { console.log(JSON.stringify(rows, null, 2)); }
  else {
    console.log(`\nCallable invoker audit — ${PROJECT}/${REGION}\n`);
    console.log('  ' + 'FUNCTION'.padEnd(30) + 'KIND'.padEnd(10) + 'INVOKER'.padEnd(24) + (DO_PROBE ? 'PROBE'.padEnd(7) : '') + 'VERDICT');
    for (const r of rows) {
      console.log('  ' + String(r.id).padEnd(30) + String(r.kind).padEnd(10)
        + String(r.invoker || r.note || '—').slice(0, 22).padEnd(24)
        + (DO_PROBE ? String(r.probe ?? '—').padEnd(7) : '') + r.verdict);
    }
    const fails = rows.filter((r) => r.verdict === 'FAIL');
    console.log(`\n  ${rows.length} audited · ${fails.length} FAIL · `
      + `${rows.filter(r => r.verdict === 'SKIP').length} skipped (not HTTP-invoked)\n`);
    if (fails.length) {
      console.log('  Unreachable by the browser. Grant the same binding the working callables have');
      console.log('  (lowercase service names — the camelCase form silently targets nothing):\n');
      for (const f of fails) {
        console.log(`    gcloud run services add-iam-policy-binding ${f.id.toLowerCase()} \\`);
        console.log(`      --region=${REGION} --member=allUsers --role=roles/run.invoker --project=${PROJECT}`);
      }
      console.log('');
    }
  }

  process.exit(rows.some((r) => r.verdict === 'FAIL') ? 1 : 0);
})().catch((e) => { console.error('audit failed:', e.message); process.exit(2); });
