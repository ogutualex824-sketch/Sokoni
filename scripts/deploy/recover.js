#!/usr/bin/env node
'use strict';
/* ============================================================================
   SOKONI — per-surface recovery (blue/green) WITHOUT rebuilding anything
   ----------------------------------------------------------------------------
   Replaces scripts/deploy/rollback.js, which stashed the working tree (repo-wide, shared by
   several agents), checked out an old tag and ran a FULL `firebase deploy --only functions
   --force` — in a project whose functions are a union of several code lineages, that deletes
   or regresses live functions. Recovery here only re-points traffic at artefacts that already
   exist:

     HOSTING   a previous Hosting VERSION is re-released as live (release history keeps every
               version; no build, no upload).                          → REST releases.create
     FUNCTION  a named, Ready, previous Cloud Run REVISION receives 100% traffic, by NAME
               (never --to-latest; never `run services update`, which fails and leaves a
               revision that cannot be deleted).        → gcloud run services update-traffic

   DRY-RUN BY DEFAULT: it prints the plan and every precondition. Nothing changes unless
   --execute is given, and a function move additionally needs --confirm=<service>.

   Usage
     node scripts/deploy/recover.js hosting --list [--limit=10]
     node scripts/deploy/recover.js hosting --to-version=<versionId> [--execute]
     node scripts/deploy/recover.js function --service=<cloud-run-service> --status
     node scripts/deploy/recover.js function --service=<svc> --to-revision=<rev> [--execute --confirm=<svc>]

   Requires gcloud auth (CLOUDSDK_PYTHON may need gcloud's bundled python). Prints no tokens.
   Procedure and constraints: docs/BLUE_GREEN_RECOVERY.md
   ============================================================================ */
const { spawnSync } = require('child_process');
const https = require('https');

const PROJECT = process.env.FIREBASE_PROJECT || 'sokoni-aeb26';
const SITE = process.env.HOSTING_SITE || PROJECT;
const REGION = process.env.FUNCTIONS_REGION || 'us-central1';
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const surface = args[0];
const EXECUTE = flag('execute');

function gcloud(argv, { capture = true } = {}) {
  const bin = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
  const r = spawnSync(bin, argv, { encoding: 'utf8', shell: process.platform === 'win32', windowsVerbatimArguments: false, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (r.status !== 0) throw new Error('gcloud ' + argv.slice(0, 3).join(' ') + ' failed: ' + String(r.stderr || '').trim().slice(0, 300));
  return String(r.stdout || '').trim();
}
function token() { return gcloud(['auth', 'print-access-token']); }
function api(method, url, body) {
  const t = token();
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', 'x-goog-user-project': PROJECT } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => {
        let j = null; try { j = d ? JSON.parse(d) : {}; } catch (_) { j = { raw: d.slice(0, 300) }; }
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + JSON.stringify(j && j.error ? j.error : j).slice(0, 300)));
        resolve(j);
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const H = 'https://firebasehosting.googleapis.com/v1beta1/sites/' + SITE;

async function hosting() {
  if (flag('list')) {
    const limit = Number(opt('limit') || 10);
    const r = await api('GET', H + '/channels/live/releases?pageSize=' + limit);
    const rel = r.releases || [];
    console.log('Live releases (newest first) — site ' + SITE + ':');
    rel.forEach((x, i) => {
      const v = String((x.version && x.version.name) || '').split('/').pop();
      console.log(`  ${i === 0 ? 'LIVE ' : '     '}${x.releaseTime}  ${String(x.type).padEnd(9)} version=${v}  ${String(x.message || '').slice(0, 60)}`);
    });
    if (!rel.length) console.log('  (none returned)');
    return;
  }
  const to = opt('to-version');
  if (!to || !/^[A-Za-z0-9_-]{6,}$/.test(to)) throw new Error('hosting: give --list, or --to-version=<versionId> (from --list)');
  const cur = await api('GET', H + '/channels/live/releases?pageSize=1');
  const liveV = String(((cur.releases || [])[0] || {}).version ? cur.releases[0].version.name : '').split('/').pop();
  const ver = await api('GET', H + '/versions/' + to);
  console.log('PLAN — re-release an existing Hosting version as live (no build, no upload)');
  console.log('  site:            ' + SITE);
  console.log('  currently live:  ' + (liveV || '(unknown)'));
  console.log('  target version:  ' + to + '  status=' + ver.status + '  created=' + ver.createTime + '  files=' + (ver.fileCount || '?'));
  const pre = [
    ['target version exists and is FINALIZED', ver.status === 'FINALIZED'],
    ['target differs from what is live', to !== liveV],
  ];
  pre.forEach(([l, ok]) => console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + l));
  if (pre.some(([, ok]) => !ok)) { console.log('Refusing: a precondition failed.'); process.exitCode = 2; return; }
  if (!EXECUTE) { console.log('DRY RUN — add --execute to release it. Afterwards verify: curl -s "https://mysokoni.co.ke/version.json?cb=$RANDOM"'); return; }
  const r = await api('POST', H + '/channels/live/releases?versionName=' + encodeURIComponent('sites/' + SITE + '/versions/' + to), { message: 'recover.js: re-release version ' + to + ' (was ' + liveV + ')' });
  console.log('RELEASED: ' + r.name + ' at ' + r.releaseTime + '. Verify version.json now, then record it in the release log.');
}

async function fn() {
  const svc = opt('service');
  if (!svc || !/^[a-z0-9-]{1,63}$/.test(svc)) throw new Error('function: --service=<lowercase cloud run service name> is required');
  const d = JSON.parse(gcloud(['run', 'services', 'describe', svc, '--region', REGION, '--project', PROJECT, '--format=json']));
  const traffic = (d.status && d.status.traffic) || [];
  const revs = JSON.parse(gcloud(['run', 'revisions', 'list', '--service', svc, '--region', REGION, '--project', PROJECT, '--format=json', '--limit=15']));
  const ready = (r) => ((r.status && r.status.conditions) || []).some((c) => c.type === 'Ready' && c.status === 'True');
  if (flag('status') || !opt('to-revision')) {
    console.log('Service ' + svc + ' — traffic:');
    traffic.forEach((t) => console.log('  ' + (t.percent || 0) + '%  ' + (t.revisionName || '(latest)') + (t.latestRevision ? '  [follows latest]' : '')));
    console.log('Recent revisions:');
    revs.forEach((r) => console.log('  ' + r.metadata.name + '  ready=' + ready(r) + '  created=' + r.metadata.creationTimestamp + '  image=' + String((r.spec.containers || [{}])[0].image || '').split('@').pop().slice(0, 20)));
    return;
  }
  const to = opt('to-revision');
  const target = revs.find((r) => r.metadata.name === to);
  const serving = traffic.filter((t) => t.percent > 0).map((t) => t.revisionName);
  console.log('PLAN — route 100% of ' + svc + ' traffic to an EXISTING revision, by name');
  console.log('  now serving: ' + (serving.join(', ') || '(unknown)'));
  console.log('  target:      ' + to);
  const image = target ? String((target.spec.containers || [{}])[0].image || '') : '';
  const pre = [
    ['target revision exists (in the 15 most recent)', !!target],
    ['target revision is Ready=True', !!target && ready(target)],
    ['target image is pinned by digest (not a tag)', /@sha256:/.test(image)],
    ['target is not already serving 100%', !(serving.length === 1 && serving[0] === to)],
    ['target image still exists in Artifact Registry (not removed by cleanup)', (() => { if (!/@sha256:/.test(image)) return false; try { gcloud(['artifacts', 'docker', 'images', 'describe', image, '--project', PROJECT, '--format=value(image_summary.digest)']); return true; } catch (_) { return false; } })()],
  ];
  pre.forEach(([l, ok]) => console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + l));
  console.log('  NOTE: Artifact Registry keeps only the 10 most recent images per repo (KEEP policy); the image check above');
  console.log('        refuses a revision whose image is gone — it could not scale up.');
  if (pre.some(([, ok]) => !ok)) { console.log('Refusing: a precondition failed.'); process.exitCode = 2; return; }
  if (!EXECUTE || opt('confirm') !== svc) { console.log('DRY RUN — add --execute --confirm=' + svc + ' to move traffic.'); return; }
  gcloud(['run', 'services', 'update-traffic', svc, '--region', REGION, '--project', PROJECT, '--to-revisions=' + to + '=100'], { capture: false });
  console.log('MOVED. Verify: node scripts/deploy/recover.js function --service=' + svc + ' --status, then a smoke call.');
}

(async () => {
  if (surface === 'hosting') return hosting();
  if (surface === 'function') return fn();
  console.log('usage: recover.js hosting --list | hosting --to-version=<id> [--execute]\n       recover.js function --service=<svc> --status | --to-revision=<rev> [--execute --confirm=<svc>]');
  process.exitCode = 1;
})().catch((e) => { console.error('recover.js: ' + e.message); process.exitCode = 1; });
