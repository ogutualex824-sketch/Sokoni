#!/usr/bin/env node
/* Artifact Registry forensic capture — READ ONLY.
 *
 * Purpose: when the gcf-artifacts images disappear again, capture the full
 * audit record so the mechanism can be NAMED rather than inferred. Enabled by
 * P0-7 (auditConfigs: ADMIN_READ + DATA_WRITE on artifactregistry.googleapis.com).
 *
 * This script only reads. It shells out to gcloud with read verbs exclusively;
 * there is no code path here that can mutate anything.
 *
 * Usage:
 *   node scripts/infra/ar-forensics.js            # last 7 days
 *   node scripts/infra/ar-forensics.js 30d        # explicit freshness
 *
 * Background: docs/GCP_COST_ARCHITECTURE_IMPLEMENTATION.md, sections P0-2-INV and P0-7.
 */
'use strict';

const { execFileSync } = require('child_process');

const FRESHNESS = process.argv[2] || '7d';
const PROJECT = 'sokoni-aeb26';

/* Principals that are US doing audit work, not the culprit. The P0-7 slice
   itself generated 138 ListRepositories calls in one hour; future forensics
   must not mistake that noise for the deletion mechanism. */
const OURS = ['alexochieng3030@gmail.com'];

/* Writes AND deletes. A deletion can only follow a push, so both matter:
   the push tells us an image existed, the delete tells us who removed it. */
/* Method vocabulary confirmed empirically by the P0-7-OBS canary push, not
   guessed: Artifact Registry logs Docker pushes as `Docker-StartUpload` and
   `Docker-PutManifest`. `Manifest` must be in this list or a push is missed
   entirely — the first draft of this regex did miss it. Deletions are expected
   as Docker-Delete* / DeletePackage / DeleteVersion / DeleteTag. */
const WRITE_METHODS = 'Delete|Upload|Import|Push|Manifest|Create.*Version|Create.*Tag|Update.*Tag';

/* On Windows `gcloud` is a .cmd shim, and current Node refuses to spawn .cmd
   without a shell (EINVAL). Using shell:true would mangle the log filters,
   which contain spaces and quotes. So invoke the SDK's Python entry point
   directly — no shell, no quoting hazard. Override with SOKONI_GCLOUD_PY. */
const SDK = process.env.SOKONI_GCLOUD_SDK
  || 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk';
const WIN = process.platform === 'win32';
const BIN = WIN ? `${SDK}/platform/bundledpython/python.exe` : 'gcloud';
const PRE = WIN ? [`${SDK}/lib/gcloud.py`] : [];

function gcloud(args) {
  try {
    return execFileSync(BIN, [...PRE, ...args], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
    });
  } catch (e) {
    return `__ERROR__ ${(e.stderr || e.message || '').toString().slice(0, 400)}`;
  }
}

function readLog(filter, limit) {
  const out = gcloud(['logging', 'read', filter, `--limit=${limit}`,
    `--freshness=${FRESHNESS}`, `--project=${PROJECT}`, '--format=json']);
  if (out.startsWith('__ERROR__')) return { error: out.slice(10) };
  try { return { rows: JSON.parse(out) }; } catch (e) { return { error: 'unparseable: ' + out.slice(0, 200) }; }
}

function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`); }

section(`ARTIFACT REGISTRY FORENSICS — last ${FRESHNESS} — ${new Date().toISOString()}`);

/* ---- 1. current registry state ------------------------------------------ */
section('1. CURRENT REGISTRY STATE');
/* Read raw JSON, not a formatted value. gcloud's `value(updateTime)` renders in
   LOCAL time and `.date()` transforms re-render again — the same field printed
   05:55:28 and 08:55:28 in two different invocations during this investigation.
   Forensics correlates against UTC log timestamps, so take the raw RFC3339. */
const reposRaw = gcloud(['artifacts', 'repositories', 'list', `--project=${PROJECT}`, '--format=json']);
try {
  for (const r of JSON.parse(reposRaw.replace(/^[^[]*/, ''))) {
    console.log(`  ${r.name.split('/locations/')[1].split('/')[0].padEnd(12)}` +
      ` sizeBytes=${r.sizeBytes || 0}  updateTime=${r.updateTime}  (UTC, raw)`);
  }
} catch (e) { console.log('  ' + reposRaw.trim().slice(0, 300)); }

for (const loc of ['us-central1', 'us-east1']) {
  const imgs = gcloud(['artifacts', 'docker', 'images', 'list',
    `${loc}-docker.pkg.dev/${PROJECT}/gcf-artifacts`, '--format=value(name)']);
  /* Count from a value-only listing, filtering blanks. The human-readable
     listing prints a "Listing items under..." banner on stdout which WILL be
     miscounted as an image if piped naively — that mistake was made once. */
  const n = imgs.startsWith('__ERROR__') ? imgs : imgs.split('\n').filter((l) => l.trim()).length;
  console.log(`  ${loc}: ${n} image(s)`);
}

/* ---- 2. the write/delete events we are waiting for ---------------------- */
section('2. DATA_WRITE EVENTS (pushes and deletions) — THE TARGET');
const w = readLog(
  `protoPayload.serviceName="artifactregistry.googleapis.com" AND ` +
  `protoPayload.methodName=~"${WRITE_METHODS}"`, 50);

if (w.error) {
  console.log('  QUERY FAILED — this is not the same as "no events":\n  ' + w.error);
} else if (!w.rows.length) {
  console.log('  No write/delete events in this window.');
  console.log('  CAUTION: the registry currently holds 0 images. With nothing to');
  console.log('  delete, silence here is AMBIGUOUS — it cannot distinguish "the');
  console.log('  mechanism stopped" from "there was nothing left to remove".');
  console.log('  A deletion event can only follow a push. See the gap note in');
  console.log('  docs/GCP_COST_ARCHITECTURE_IMPLEMENTATION.md (P0-7-OBS).');
} else {
  for (const r of w.rows) {
    const p = r.protoPayload || {};
    const auth = p.authenticationInfo || {};
    const meta = p.requestMetadata || {};
    const st = p.status || {};
    const mine = OURS.includes(auth.principalEmail) ? '  <-- OUR OWN AUDIT ACTIVITY' : '';
    console.log([
      `  timestamp      : ${r.timestamp}`,
      `  methodName     : ${p.methodName}`,
      `  serviceName    : ${p.serviceName}`,
      `  principalEmail : ${auth.principalEmail || '(none — likely a Google-internal mechanism)'}${mine}`,
      `  principalSubject: ${auth.principalSubject || '-'}`,
      `  callerIp       : ${meta.callerIp || '-'}`,
      `  callerUA       : ${(meta.callerSuppliedUserAgent || '-').slice(0, 90)}`,
      `  resourceName   : ${p.resourceName || '-'}`,
      `  status         : code=${st.code === undefined ? 'OK' : st.code} ${st.message || ''}`,
      `  authorization  : ${JSON.stringify((p.authorizationInfo || []).map((a) => a.permission))}`,
      '  ' + '-'.repeat(68),
    ].join('\n'));
  }
}

/* ---- 3. correlation ------------------------------------------------------ */
section('3. CORRELATION — build / deploy / revision activity in the same window');
for (const [label, filter] of [
  ['Cloud Build', 'protoPayload.serviceName="cloudbuild.googleapis.com"'],
  ['Cloud Functions', 'protoPayload.serviceName="cloudfunctions.googleapis.com"'],
  ['Cloud Run', 'protoPayload.serviceName="run.googleapis.com" AND protoPayload.methodName=~"Create|Replace|Delete"'],
]) {
  const r = readLog(filter, 15);
  console.log(`\n-- ${label}:`);
  if (r.error) { console.log('   QUERY FAILED: ' + r.error); continue; }
  if (!r.rows.length) { console.log('   (no events)'); continue; }
  for (const e of r.rows) {
    const p = e.protoPayload || {};
    console.log(`   ${e.timestamp}  ${(p.methodName || '').split('.').pop().padEnd(22)}` +
      ` ${(p.authenticationInfo || {}).principalEmail || '(service)'}  ${(p.resourceName || '').split('/').pop()}`);
  }
}

/* ---- 3b. canary status and VERDICT -------------------------------------- */
section('3b. CANARY STATUS — the reference specimen');

/* Pushed 2026-09-19T06:08:12Z by P0-7-OBS-CANARY. Recorded so a SURVIVING
   original is distinguishable from a re-pushed replacement. */
const CANARY_MARK = 'sokoni-ar-forensics-canary';
const CANARY_TAG = '20260919T060552Z';
const CANARY_DIGEST = 'sha256:88f338d30f7c40853b2750f3a5c13dc0a57f167552e70dcdbb5d0fce6ce9cf81';

const canaryRaw = gcloud(['artifacts', 'docker', 'images', 'list',
  `us-central1-docker.pkg.dev/${PROJECT}/gcf-artifacts`, '--include-tags', '--format=json']);
let canaryPresent = null; /* null = UNKNOWN, never conflate with false */
let canaryNote = '';
try {
  const imgs = JSON.parse(canaryRaw.replace(/^[^[]*/, ''));
  const hit = imgs.find((i) => (i.package || '').includes(CANARY_MARK));
  canaryPresent = !!hit;
  if (hit) {
    const sameDigest = (hit.version || '') === CANARY_DIGEST;
    canaryNote = `  package=${hit.package.split('/').pop()} tags=${JSON.stringify(hit.tags)}\n` +
      `  digest=${hit.version}\n` +
      `  ORIGINAL SPECIMEN: ${sameDigest ? 'yes' : 'NO — digest differs from the one pushed'}\n` +
      `  expected tag: ${CANARY_TAG}`;
  } else {
    canaryNote = '  Canary NOT found in the repository.';
  }
} catch (e) {
  canaryNote = '  LOOKUP FAILED — this is not "absent":\n  ' + canaryRaw.trim().slice(0, 300);
}
console.log(canaryNote);

const del = readLog(
  `protoPayload.serviceName="artifactregistry.googleapis.com" AND ` +
  `protoPayload.methodName=~"Delete"`, 25);
const delRows = del.error ? null : del.rows;
console.log(`\n  deletion events in window: ${delRows === null ? 'QUERY FAILED — ' + del.error : delRows.length}`);
if (delRows && delRows.length) {
  for (const r of delRows) {
    const p = r.protoPayload || {};
    console.log(`   ${r.timestamp}  ${p.methodName}  ` +
      `${(p.authenticationInfo || {}).principalEmail || '(no principal — Google-internal)'}  ` +
      `${p.resourceName || ''}`);
  }
}

/* ---- 3bis. contamination check ------------------------------------------ */
section('3bis. CONTAMINATION CHECK — did anything else touch the environment?');

/* Several AI agents work this repo in parallel worktrees (CLAUDE.md). A deploy,
   a function deletion or an artifact push by another agent during the
   experiment would make the next artifact event ambiguous. Detect it rather
   than hope. */
let contaminated = null;
try {
  /* Override exists so the CONTAMINATED branch can be exercised against a
     deliberately-wrong baseline. A branch that has never run is a guess. */
  const base = require(process.env.SOKONI_AR_BASELINE || './ar-experiment-baseline.json');
  const checks = [];

  const nowBuild = gcloud(['builds', 'list', '--region=us-central1', '--limit=1',
    `--project=${PROJECT}`, '--format=value(id)']).trim();
  checks.push(['last Cloud Build', base.lastCloudBuildId, nowBuild]);

  const fnRaw = gcloud(['functions', 'list', `--project=${PROJECT}`, '--format=value(name)']);
  const nowFns = fnRaw.startsWith('__ERROR__') ? null
    : fnRaw.split('\n').filter((l) => l.trim()).length;
  checks.push(['deployed functions', String(base.deployedFunctionCount),
    nowFns === null ? 'LOOKUP FAILED' : String(nowFns)]);

  for (const [svc, rev] of Object.entries(base.pinnedServiceRevisions)) {
    const now = gcloud(['run', 'services', 'describe', svc, '--region=us-central1',
      `--project=${PROJECT}`, '--format=value(status.latestCreatedRevisionName)']).trim();
    if (now !== rev) checks.push([`revision ${svc}`, rev, now]);
  }

  const drift = checks.filter(([, a, b]) => a !== b);
  contaminated = drift.length > 0;
  for (const [what, was, now] of checks) {
    const flag = was === now ? 'ok  ' : 'DRIFT';
    console.log(`  [${flag}] ${what.padEnd(28)} baseline=${was}  now=${now}`);
  }
  if (contaminated) {
    console.log('\n  *** CONTAMINATED — the environment changed during the experiment. ***');
    console.log('  Another deploy, deletion or push has occurred. The next artifact');
    console.log('  event may not be attributable to the canary alone. Record what');
    console.log('  changed before interpreting any outcome below.');
  } else {
    console.log('\n  Clean — no deploy, deletion or revision change since the canary push.');
  }
} catch (e) {
  console.log('  CHECK FAILED (not "clean"): ' + e.message);
}

section('3c. VERDICT');

/* The reference interval is the 2026-09-14 -> 2026-09-15 window, ~21h. A
   surviving canary means nothing before then, and "OUTCOME 1" read at ten
   minutes old is not a result. Say so loudly rather than let it be quoted. */
const CANARY_PUSHED_AT = Date.parse('2026-09-19T06:08:12Z');
const ageH = (Date.now() - CANARY_PUSHED_AT) / 3600000;
console.log(`  canary age: ${ageH.toFixed(1)}h (reference interval ~21h)\n`);
if (ageH < 21 && canaryPresent) {
  console.log('  *** PREMATURE — the canary is younger than the reference interval. ***');
  console.log('  A surviving canary proves NOTHING yet. Re-run after ~24h.');
  console.log('  The outcome below is provisional and must not be quoted as a finding.\n');
}

/* Contamination outranks the outcome. A DRIFT result means the experiment no
   longer isolates the canary, so the outcome below is not attributable and must
   not be quoted as evidence for H1 or H2. Enforced here rather than left to
   whoever reads two sections and remembers to combine them. */
if (contaminated === null) {
  console.log('  INDETERMINATE — the contamination check itself failed.');
  console.log('  The experiment cannot be shown to be clean, so no outcome is readable.');
} else if (contaminated) {
  console.log('  CONTAMINATED — DO NOT INTERPRET THE CANARY RESULT.');
  console.log('  The environment changed during the experiment (see DRIFT above), so the');
  console.log('  canary no longer isolates the mechanism. This is NOT evidence for H1 or');
  console.log('  H2 either way. Establish what changed and why, then decide whether the');
  console.log('  experiment can continue or must be restarted with a fresh baseline.');
} else if (canaryPresent === null || delRows === null) {
  console.log('  INDETERMINATE — a query failed. Do not read this as any outcome.');
} else if (canaryPresent && !delRows.length) {
  console.log('  OUTCOME 1 — canary SURVIVES, no deletion events.');
  console.log('  The purge is NOT reproduced. This is a valid result, not a failure.');
  console.log('  It does NOT prove H2, and it does not prove H1. What it establishes is');
  console.log('  narrower and still useful: the mechanism is not a blanket Artifact');
  console.log('  Registry sweep that removes arbitrary artifacts. Attention should then');
  console.log('  move to function-OWNED and function-SHARED artifacts and to the function');
  console.log('  lifecycle itself, rather than to the repository.');
} else if (!canaryPresent && delRows.length) {
  console.log('  OUTCOME 2 — canary GONE and deletion events captured. BREAKTHROUGH.');
  console.log('  Inspect the principal/method/resource above; that names the actor.');
  console.log('');
  console.log('  But "who deleted it" is NOT the whole question. Two mechanisms look');
  console.log('  almost identical from outside:');
  console.log('    H1  a function deletion purges a SHARED artifact that other live');
  console.log('        functions still reference.');
  console.log('    H2  GCF cleans up artifacts per its own ownership/reference model,');
  console.log('        not treating Cloud Run revision references as durable artifact');
  console.log('        dependencies. No function deletion needed.');
  console.log('  The canary discriminates: it belongs to NO function, so H1 has no reason');
  console.log('  to touch it. Its removal by the same mechanism substantially WEAKENS the');
  console.log('  simple H1 explanation. That is not the same as proving H2 — establish the');
  console.log('  items below before naming a mechanism.');
  console.log('  Also establish, from section 3 above:');
  console.log('    - which lifecycle operation PRECEDED the deletion, and how long before');
  console.log('    - which artifact/version was considered ELIGIBLE, and on what basis');
  console.log('    - whether the principal is a user, a gcf robot, or absent (Google-internal)');
  console.log('  And reconcile against the counter-evidence: the 2026-07-11 deletion batch');
  console.log('  (30+ functions) moved NO repository updateTime. A bare');
  console.log('  "DeleteFunction -> purge" model does not explain that, so the real model');
  console.log('  likely needs a further condition (shared-reference state, or timing).');
} else if (!canaryPresent && !delRows.length) {
  console.log('  OUTCOME 3 — canary GONE but NO deletion event captured.');
  console.log('  Do NOT assume. Either the removal is not in the DATA_WRITE category,');
  console.log('  another mechanism is involved, or the repository-state reading is wrong.');
  console.log('  Investigate; do not conclude.');
} else {
  console.log('  MIXED — canary survives BUT deletion events exist (something else was');
  console.log('  removed). Inspect the events above before drawing any conclusion.');
}

/* ---- 4. the standing positive control ----------------------------------- */
section('4. POSITIVE CONTROL — the deploy path is known to work');
console.log('  initiateSTKPush deployed 2026-09-14 00:45 (Cloud Build 72739a70, SUCCESS),');
console.log('  revision initiatestkpush-00043-niq, Ready=True, serving.');
console.log('  source -> build -> image -> revision -> serving WORKS.');
console.log('  Any conclusion implying "SOKONI cannot deploy" contradicts this and is wrong.');
console.log('  The real failure is narrower: create a revision from an EXISTING spec,');
console.log('  without rebuilding, against an image that is no longer in the registry.');

console.log('\nDone. Nothing was modified.\n');
