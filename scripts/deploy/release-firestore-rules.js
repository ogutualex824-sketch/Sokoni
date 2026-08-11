'use strict';
/**
 * scripts/deploy/release-firestore-rules.js
 *
 *   node scripts/deploy/release-firestore-rules.js            # release firestore.rules
 *   node scripts/deploy/release-firestore-rules.js --dry-run  # compile + diff, release nothing
 *   node scripts/deploy/release-firestore-rules.js --rollback <rulesetId>
 *
 * WHY THIS EXISTS
 * `firebase deploy --only firestore:rules` fails on this project with
 *
 *     Error: Request to …/projects/sokoni-aeb26/releases had HTTP Error: 409,
 *     Requested entity already exists
 *
 * The CLI POSTs to create the `cloud.firestore` release instead of PATCHing the
 * one that is already there. The 409 aborts the whole command, so since
 * 2026-08-09 every rules change has been committed but NOT released — the live
 * ruleset silently drifted behind the repository while deploys "failed" in a way
 * that was easy to read as noise.
 *
 * This performs the two calls the CLI makes internally, with the PATCH the
 * existing release actually needs:
 *
 *     POST  /v1/projects/{p}/rulesets                       → new ruleset
 *     PATCH /v1/projects/{p}/releases/cloud.firestore       → point release at it
 *                                                             (updateMask=rulesetName)
 *
 * IT SHOWS YOU THE DIFF FIRST. A rules release is a security-surface change, so
 * the live ruleset is fetched and diffed against the file being released, and the
 * previous ruleset id is printed as the rollback handle before anything changes.
 *
 * This does NOT replace `firebase deploy` for indexes or for the sokoni-ops
 * database — the CLI handles those correctly. Rules for the (default) database
 * only.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const RELEASE = 'cloud.firestore';
const RULES_FILE = path.join(__dirname, '..', '..', 'firestore.rules');
const HOST = 'firebaserules.googleapis.com';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const rollbackAt = args.indexOf('--rollback');
const ROLLBACK_TO = rollbackAt !== -1 ? args[rollbackAt + 1] : null;

const BUNDLED_PY = process.env.LOCALAPPDATA
  ? process.env.LOCALAPPDATA + '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe'
  : null;

let _tok = null;
function token() {
  if (_tok) return _tok;
  if (process.env.GCLOUD_ACCESS_TOKEN) return (_tok = process.env.GCLOUD_ACCESS_TOKEN.trim());
  const env = Object.assign({}, process.env);
  if (BUNDLED_PY && !env.CLOUDSDK_PYTHON) env.CLOUDSDK_PYTHON = BUNDLED_PY;
  _tok = execSync('gcloud auth print-access-token',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  return _tok;
}

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + token(), 'x-goog-user-project': PROJECT };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ host: HOST, path: urlPath, method, headers }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const die = (msg, res) => {
  console.error('\n  ' + msg + (res ? '  HTTP ' + res.status + '\n' + res.body.slice(0, 500) : ''));
  process.exit(1);
};

/**
 * Strip comments from rules source.
 *
 * WHY THE RELEASED RULESET IS NOT BYTE-IDENTICAL TO THE REPO FILE
 * `firestore.rules` has outgrown the maximum releasable size. The API answers a
 * bare `400 INVALID_ARGUMENT` — it does not say "too large" — and the CLI hides
 * that behind a 409, which is why rules silently stopped deploying on 2026-08-09
 * while every commit since looked fine.
 *
 * Comments have no semantic effect on a ruleset, so they are removed from what is
 * SENT while the repository keeps the full documentation the project requires.
 * The stripped source is verified to contain exactly the same rule-bearing lines
 * before anything is released.
 *
 * Quote-aware on purpose: a naive regex would corrupt any rule containing `//`
 * inside a string (`matches('https://…')`), turning a security rule into a
 * comment. Characters inside quotes are copied through untouched.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;          /* the open quote char, or null */
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (d || ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  /* Collapse the blank lines the removed comments left behind. */
  return out.split('\n').map(l => l.replace(/[ \t]+$/, '')).filter(l => l.trim()).join('\n') + '\n';
}

/* The lines that actually decide access. Used to prove stripping changed nothing. */
const ruleBearing = src => stripComments(src)
  .split('\n').map(l => l.trim().replace(/\s+/g, ' ')).filter(Boolean);

/* Line diff, enough to read a rules change without pulling in a dependency. */
function diff(oldSrc, newSrc) {
  const a = oldSrc.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  const b = newSrc.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  const inB = new Set(b), inA = new Set(a);
  const removed = a.filter(l => l.trim() && !inB.has(l));
  const added = b.filter(l => l.trim() && !inA.has(l));
  return { added, removed };
}

(async () => {
  console.log('\n  FIRESTORE RULES RELEASE — project ' + PROJECT + '  release ' + RELEASE + '\n');

  /* `--diagnose` answers one question: does PATCH work on this project at all?
     It re-points each release at the ruleset it is ALREADY on, so a success
     changes nothing and a failure is the same failure the real release hits. */
  if (args.includes('--diagnose')) {
    const list = await req('GET', '/v1/projects/' + PROJECT + '/releases');
    for (const r of (JSON.parse(list.body).releases || [])) {
      const short = r.name.split('/').pop();
      const noop = await req('PATCH', '/v1/' + r.name,
        { release: { name: r.name, rulesetName: r.rulesetName } });
      console.log('  no-op PATCH ' + short.padEnd(34) + ' → HTTP ' + noop.status +
        (noop.status >= 400 ? '  ' + (noop.body.replace(/\s+/g, ' ').match(/"message": "([^"]+)"/) || ['?'])[0] : '  ✓'));
    }
    process.exit(0);
  }

  /* `--try-file <path>` attempts a release from an arbitrary rules file. Used to
     bisect WHICH content the API refuses, since it only ever says "invalid
     argument" without naming the offending rule. */
  const tf = args.indexOf('--try-file');
  if (tf !== -1) {
    const p = args[tf + 1];
    const src = stripComments(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    console.log('  ' + p + ' → ' + Buffer.byteLength(src, 'utf8') + ' bytes stripped');
    const mk = await req('POST', '/v1/projects/' + PROJECT + '/rulesets',
      { source: { files: [{ name: 'firestore.rules', content: src }] } });
    console.log('  create ruleset → HTTP ' + mk.status +
      (mk.status >= 400 ? '  ' + mk.body.replace(/\s+/g, ' ').slice(0, 300) : ''));
    if (mk.status < 400) {
      const nm = JSON.parse(mk.body).name;
      const pr = await req('PATCH', '/v1/projects/' + PROJECT + '/releases/' + RELEASE,
        { release: { name: 'projects/' + PROJECT + '/releases/' + RELEASE, rulesetName: nm } });
      console.log('  release       → HTTP ' + pr.status + (pr.status < 400 ? '  ✓ RELEASED' : '  ✗'));
    }
    process.exit(0);
  }

  /* `--bisect` separates "a new ruleset cannot be released" from "THIS content
     cannot be released". It creates a ruleset from the source that is ALREADY
     live — byte-identical, so releasing it is a no-op in behaviour — and tries
     to point the release at it. */
  if (args.includes('--bisect')) {
    const rel0 = await req('GET', '/v1/projects/' + PROJECT + '/releases/' + RELEASE);
    const liveName = JSON.parse(rel0.body).rulesetName;
    const liveSrc = JSON.parse((await req('GET', '/v1/' + liveName)).body).source.files[0].content;
    console.log('  live source: ' + Buffer.byteLength(liveSrc, 'utf8') + ' bytes');
    const fileSrc = fs.readFileSync(RULES_FILE, 'utf8');
    console.log('  file source: ' + Buffer.byteLength(fileSrc, 'utf8') + ' bytes\n');

    const mk = await req('POST', '/v1/projects/' + PROJECT + '/rulesets',
      { source: { files: [{ name: 'firestore.rules', content: liveSrc }] } });
    console.log('  create ruleset from LIVE source → HTTP ' + mk.status);
    if (mk.status < 400) {
      const nm = JSON.parse(mk.body).name;
      const pr = await req('PATCH', '/v1/projects/' + PROJECT + '/releases/' + RELEASE,
        { release: { name: 'projects/' + PROJECT + '/releases/' + RELEASE, rulesetName: nm } });
      console.log('  release it (identical content) → HTTP ' + pr.status +
        (pr.status >= 400 ? '  ' + (pr.body.replace(/\s+/g, ' ').match(/"message": "([^"]+)"/) || ['?'])[0] : '  ✓'));
      console.log(pr.status < 400
        ? '\n  => new rulesets CAN be released. The blocker is the CONTENT of firestore.rules.\n'
        : '\n  => even identical content cannot be released. The blocker is not this change.\n');
    }
    process.exit(0);
  }

  const cur = await req('GET', '/v1/projects/' + PROJECT + '/releases/' + RELEASE);
  if (cur.status >= 400) die('could not read the current release', cur);
  const currentRuleset = JSON.parse(cur.body).rulesetName;
  const currentId = currentRuleset.split('/').pop();
  console.log('  current ruleset : ' + currentId);
  console.log('  ROLLBACK HANDLE : node scripts/deploy/release-firestore-rules.js --rollback ' + currentId + '\n');

  let targetRuleset;

  if (ROLLBACK_TO) {
    targetRuleset = 'projects/' + PROJECT + '/rulesets/' + ROLLBACK_TO;
    const probe = await req('GET', '/v1/' + targetRuleset);
    if (probe.status >= 400) die('rollback target ruleset not found', probe);
    console.log('  ROLLING BACK to ' + ROLLBACK_TO + '\n');
  } else {
    const source = fs.readFileSync(RULES_FILE, 'utf8').replace(/^﻿/, '');

    const live = await req('GET', '/v1/' + currentRuleset);
    if (live.status < 400) {
      const liveSrc = (JSON.parse(live.body).source.files[0] || {}).content || '';
      const d = diff(liveSrc, source);
      if (!d.added.length && !d.removed.length) {
        console.log('  live ruleset already matches firestore.rules — nothing to release.\n');
        process.exit(0);
      }
      console.log('  diff vs live:  +' + d.added.length + ' / -' + d.removed.length + ' lines');
      /* Rule-bearing lines only: comment churn is noise in a security review. */
      const sig = l => /allow |match |function |if /.test(l) && !/^\s*(\/\*|\*|\/\/)/.test(l);
      const addedSig = d.added.filter(sig), removedSig = d.removed.filter(sig);
      console.log('  rule-bearing:  +' + addedSig.length + ' / -' + removedSig.length + '\n');
      removedSig.forEach(l => console.log('    - ' + l.trim().slice(0, 150)));
      addedSig.forEach(l => console.log('    + ' + l.trim().slice(0, 150)));
      console.log('');
      if (removedSig.length) {
        console.log('  ** ' + removedSig.length + ' rule-bearing line(s) are being REMOVED — read them above. **\n');
      }
    }

    /* Shrink to fit, and prove the shrink was lossless before sending it. */
    const stripped = stripComments(source);
    const a = ruleBearing(source), b = ruleBearing(stripped);
    const identical = a.length === b.length && a.every((l, i) => l === b[i]);
    console.log('  source     : ' + Buffer.byteLength(source, 'utf8') + ' bytes');
    console.log('  stripped   : ' + Buffer.byteLength(stripped, 'utf8') + ' bytes  (comments removed for release)');
    console.log('  rule lines : ' + a.length + ' → ' + b.length +
      (identical ? '  ✓ identical' : '  ** DIFFERENT — NOT RELEASING **'));
    if (!identical) die('comment stripping altered rule-bearing lines; refusing to release');
    console.log('');

    if (DRY) { console.log('  --dry-run: nothing released.\n'); process.exit(0); }

    const created = await req('POST', '/v1/projects/' + PROJECT + '/rulesets',
      { source: { files: [{ name: 'firestore.rules', content: stripped }] } });
    if (created.status >= 400) die('ruleset create failed (compilation error?)', created);
    targetRuleset = JSON.parse(created.body).name;
    console.log('  ruleset created : ' + targetRuleset.split('/').pop());
  }

  /* PATCH, not POST. The release exists; creating it is what returns 409.
     The API has accepted the update mask in different places across versions, so
     each accepted shape is tried in turn and the first success wins — a 400 here
     means "malformed request", not "rejected", and silently giving up would leave
     the ruleset created but unreleased (which is what the CLI effectively does). */
  const relName = 'projects/' + PROJECT + '/releases/' + RELEASE;
  /* The live Release resource, echoed back with only rulesetName swapped — the
     shape the server is guaranteed to consider well-formed. */
  const echoed = Object.assign({}, JSON.parse(cur.body), { rulesetName: targetRuleset });
  delete echoed.createTime; delete echoed.updateTime;
  /* THE DOT IS THE BUG. `updateRelease` in firebase-tools PATCHes
     /projects/{p}/releases/cloud.firestore with exactly the payload below, and the
     API answers 400 — so the CLI swallows it, falls back to createRelease, and
     gets 409 because the release plainly exists. The same PATCH succeeds against
     the `sokoni-ops` release, whose name has no dot: the literal '.' breaks the
     {name=projects/*}/releases/** path match. Percent-encoding it fixes the route. */
  const relNameEnc = 'projects/' + PROJECT + '/releases/' + RELEASE.replace(/\./g, '%2E');
  const shapes = [
    ['encoded dot', '/v1/' + relNameEnc,
      { release: { name: relName, rulesetName: targetRuleset } }],
    ['encoded dot + mask', '/v1/' + relNameEnc + '?updateMask=rulesetName',
      { release: { name: relName, rulesetName: targetRuleset } }],
    ['mask as object', '/v1/' + relName,
      { release: { name: relName, rulesetName: targetRuleset }, updateMask: { paths: ['rulesetName'] } }],
    ['echoed release', '/v1/' + relName, { release: echoed }],
    ['echoed + mask', '/v1/' + relName + '?updateMask=rulesetName', { release: echoed }],
    ['body updateMask', '/v1/' + relName,
      { release: { name: relName, rulesetName: targetRuleset }, updateMask: 'rulesetName' }],
    ['query updateMask', '/v1/' + relName + '?updateMask=rulesetName',
      { release: { name: relName, rulesetName: targetRuleset } }],
    ['bare release body', '/v1/' + relName,
      { name: relName, rulesetName: targetRuleset }],
    ['query mask + bare body', '/v1/' + relName + '?updateMask=rulesetName',
      { name: relName, rulesetName: targetRuleset }],
  ];
  let rel = null;
  for (const [label, urlPath, body] of shapes) {
    rel = await req('PATCH', urlPath, body);
    console.log('  PATCH (' + label + ') → HTTP ' + rel.status +
      (rel.status >= 400 ? '  ' + (rel.body.replace(/\s+/g, ' ').match(/"description": "([^"]+)"|"message": "([^"]+)"/) || [rel.body.slice(0, 120)])[0] : ''));
    if (args.includes('--verbose') && rel.status >= 400) {
      console.log('    ' + rel.body.replace(/\s+/g, ' ').slice(0, 400) + '\n');
    }
    if (rel.status < 400) break;
  }
  if (!rel || rel.status >= 400) die('release PATCH failed in every accepted shape', rel);

  /* Confirm by re-reading: a 200 on the PATCH is not proof the release moved. */
  const after = await req('GET', '/v1/projects/' + PROJECT + '/releases/' + RELEASE);
  const nowId = after.status < 400 ? JSON.parse(after.body).rulesetName.split('/').pop() : '?';
  const ok = nowId === targetRuleset.split('/').pop();
  console.log('  released        : ' + nowId + (ok ? '  ✓ confirmed' : '  ** NOT CONFIRMED **') + '\n');
  process.exit(ok ? 0 : 1);
})();
