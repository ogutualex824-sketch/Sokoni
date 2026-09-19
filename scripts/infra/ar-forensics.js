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

/* ---- 4. the standing positive control ----------------------------------- */
section('4. POSITIVE CONTROL — the deploy path is known to work');
console.log('  initiateSTKPush deployed 2026-09-14 00:45 (Cloud Build 72739a70, SUCCESS),');
console.log('  revision initiatestkpush-00043-niq, Ready=True, serving.');
console.log('  source -> build -> image -> revision -> serving WORKS.');
console.log('  Any conclusion implying "SOKONI cannot deploy" contradicts this and is wrong.');
console.log('  The real failure is narrower: create a revision from an EXISTING spec,');
console.log('  without rebuilding, against an image that is no longer in the registry.');

console.log('\nDone. Nothing was modified.\n');
