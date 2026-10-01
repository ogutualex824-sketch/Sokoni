#!/usr/bin/env node
/* env-parity-check.js — after a scoped functions deploy, prove each redeployed service kept the SAME
 * environment as before. READ-ONLY. Prints names and SHA-256 prefixes of values, NEVER a value.
 *
 *   node scripts/infra/env-parity-check.js <service>[=<baselineRevision>] ...
 *     e.g. availabledeliveries=availabledeliveries-00007-bac claimavailabledelivery=claimavailabledelivery-00009-gom
 *   With no baseline, the check compares the serving revision with the previous Ready revision.
 *   New services (no previous revision) are compared with a reference service's env (--ref=<service>).
 *
 * Exit 0 only when every service's env names AND value hashes equal its baseline, and secrets refer to the
 * same secret names. Why it exists: on 2026-09-30 a deploy without the dotenv file present dropped carried-over
 * variables and AT_ENV fell back to its 'sandbox' default (memory: project_payout_paid_status_guard).
 */
'use strict';
const cp = require('child_process');
const crypto = require('crypto');
const PROJECT = 'sokoni-aeb26', REGION = 'us-central1';
const env = Object.assign({}, process.env, { CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON || 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe' });
const gc = (args) => JSON.parse(cp.execFileSync('gcloud', args.concat(['--project', PROJECT, '--format=json']), { encoding: 'utf8', env, shell: true, maxBuffer: 32 * 1024 * 1024 }));
const h = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
function envOf(container) {
  const out = {};
  for (const e of (container && container.env) || []) {
    if (e.valueFrom && e.valueFrom.secretKeyRef) out[e.name] = 'secret:' + e.valueFrom.secretKeyRef.name;
    else out[e.name] = 'h:' + h(e.value == null ? '' : e.value);
  }
  return out;
}
function revisionEnv(rev) { return envOf(gc(['run', 'revisions', 'describe', rev, '--region', REGION]).spec.containers[0]); }
const args = process.argv.slice(2);
const refArg = (args.find((a) => a.startsWith('--ref=')) || '').slice(6);
let bad = 0;
for (const a of args.filter((x) => !x.startsWith('--'))) {
  const [svc, base] = a.split('=');
  let s;
  try { s = gc(['run', 'services', 'describe', svc, '--region', REGION]); }
  catch (e) { console.log('FAIL ' + svc + ': service not found or unreadable (not deployed yet?)'); bad++; continue; }
  const serving = (s.status.traffic || []).filter((t) => t.percent > 0).map((t) => t.revisionName);
  if (serving.length !== 1) { console.log('FAIL ' + svc + ': serving revisions ' + JSON.stringify(serving) + ' (expected exactly one)'); bad++; continue; }
  let baseRev = base;
  if (!baseRev && !refArg) {
    const revs = gc(['run', 'revisions', 'list', '--service', svc, '--region', REGION]).filter((r) => r.metadata.name !== serving[0])
      .sort((x, y) => String(y.metadata.creationTimestamp).localeCompare(String(x.metadata.creationTimestamp)));
    baseRev = revs[0] && revs[0].metadata.name;
  }
  const now = revisionEnv(serving[0]);
  let was;
  if (baseRev) was = revisionEnv(baseRev);
  else if (refArg) { const r = gc(['run', 'services', 'describe', refArg, '--region', REGION]); was = envOf(r.spec.template.spec.containers[0]); baseRev = 'ref:' + refArg; }
  else { console.log('FAIL ' + svc + ': no baseline (new service) — pass --ref=<service>'); bad++; continue; }
  /* Platform-managed variables differ per service; compare the user-defined set only. */
  const skip = new Set(['FUNCTION_TARGET', 'FUNCTION_SIGNATURE_TYPE', 'LOG_EXECUTION_ID', 'EVENTARC_CLOUD_EVENT_SOURCE']);
  const names = [...new Set(Object.keys(now).concat(Object.keys(was)))].filter((n) => !skip.has(n)).sort();
  const diff = names.filter((n) => now[n] !== was[n]);
  console.log((diff.length ? 'FAIL ' : 'OK   ') + svc + '  serving ' + serving[0] + '  vs ' + baseRev + '  (' + names.length + ' vars)');
  for (const n of diff) console.log('       ' + n + ': ' + (was[n] || 'ABSENT') + ' -> ' + (now[n] || 'ABSENT'));
  if (diff.length) bad++;
}
process.exit(bad ? 1 : 0);
