#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   DEPLOY ROLLBACK GUARD — the refusal paths
   ══════════════════════════════════════════════════════════════════════════════
   The guard used to FAIL OPEN: any unreadable version.json ("network blip must
   never block a legitimate release") resolved to null and printed "allowing
   deploy". On 2026-08-29 version.json answered HTTP 500 while serving a CORRECT
   body — three consecutive requests, 200 again minutes later. Inside that window
   the guard would have waved through exactly the stale-tree deploy it exists to
   stop, and hosting publishes the whole tree.

   So "I could not establish the production pointer" now REFUSES. The blip argument
   is answered by RETRIES, not by permission.

   These are the paths that cannot be exercised against real production, so the
   guard takes a loopback-only SOKONI_LIVE_VERSION_URL and announces TEST MODE on
   every run that uses it. Section 0 proves that confinement — a guard that could be
   silently aimed at a fake pointer would be worse than the fail-open it replaces.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'deploy', 'guard-no-rollback.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n-- ' + t + ' --');

const HEADSHA = cp.execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();

/* A server whose answers are scripted per request, so a transient failure can be
   modelled as "fails twice, then succeeds" rather than "always fails". */
function serve(plan) {
  let i = 0;
  const srv = http.createServer((req, res) => {
    const step = plan[Math.min(i, plan.length - 1)]; i++;
    if (step.hangup) { req.socket.destroy(); return; }
    res.writeHead(step.status || 200, { 'Content-Type': 'application/json' });
    res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body));
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, port: srv.address().port, count: () => i })));
}

/* ASYNC, not spawnSync. spawnSync blocks this process's event loop — and this
   process is also the HTTP server the child is meant to call, so every request
   timed out at 8000ms and all seven refusal cases "passed" for the wrong reason:
   they refused because nothing answered, not because of the response under test.
   A harness that cannot serve the request it is testing proves nothing. */
function runGuard(url, cwd) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    if (url) env.SOKONI_LIVE_VERSION_URL = url;
    else delete env.SOKONI_LIVE_VERSION_URL;
    const ch = cp.spawn(process.execPath, [GUARD], { cwd: cwd || ROOT, env });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => ch.kill(), 120000);
    ch.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

const ok = (sha) => ({ status: 200, body: { commit: sha, commitShort: String(sha).slice(0, 7), buildTime: 'T', cacheVersion: 'v1' } });

(async () => {
  head('0 - the test override is CONFINED and LOUD');
  {
    const r = await runGuard('https://evil.example/version.json');
    ck('a non-loopback override is ignored', /IGNORING SOKONI_LIVE_VERSION_URL/.test(r.out));
    ck('...and the guard falls back to real production', /live commit|DIVERGED|REFUSING/.test(r.out), 'reached the real decision path');

    const s = await serve([ok(HEADSHA)]);
    const t = await runGuard('http://127.0.0.1:' + s.port + '/version.json');
    s.srv.close();
    ck('a loopback override IS honoured', t.code === 0, 'exit=' + t.code);
    ck('...and announces TEST MODE in capitals', /\*\*\* TEST MODE \*\*\*/.test(t.out));
    ck('...and says the run proves nothing about a real deploy', /proves NOTHING about a real deploy/.test(t.out));
  }

  head('1 - live KNOWN and contained -> allowed');
  {
    const s = await serve([ok(HEADSHA)]);
    const r = await runGuard('http://127.0.0.1:' + s.port + '/version.json');
    s.srv.close();
    ck('tree AT the live commit redeploys', r.code === 0, 'exit=' + r.code);

    const older = cp.execSync('git rev-parse HEAD~1', { cwd: ROOT, encoding: 'utf8' }).trim();
    const s2 = await serve([ok(older)]);
    const r2 = await runGuard('http://127.0.0.1:' + s2.port + '/version.json');
    s2.srv.close();
    ck('tree AHEAD of live deploys', r2.code === 0, 'exit=' + r2.code);
  }

  head('2 - live KNOWN and NOT contained -> refused');
  {
    /* A commit that exists here but does not contain HEAD: the P9 candidate, which
       forked before this tree's commit. Deploying over it would revert the fork. */
    let diverged = null;
    try { diverged = cp.execSync('git rev-parse candidate/p9-entry-reconciled', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) {}
    if (!diverged) { ck('SKIP diverged case — candidate branch not present', true, 'not a pass for the case'); }
    else {
      const s = await serve([ok(diverged)]);
      const r = await runGuard('http://127.0.0.1:' + s.port + '/version.json');
      s.srv.close();
      ck('a DIVERGED live commit refuses', r.code === 1, 'exit=' + r.code);
      ck('...and says the live commit is not contained', /NOT contained in this tree/.test(r.out));
    }
  }

  head('3 - live NOT KNOWN -> refused (this is the fix)');
  {
    const cases = [
      ['HTTP 500 with a correct body', [{ status: 500, body: { commit: HEADSHA } }], /HTTP 500/],
      ['HTTP 503', [{ status: 503, body: {} }], /HTTP 503/],
      ['body is not JSON', [{ status: 200, body: 'Internal Error' }], /not JSON/],
      ['no commit field', [{ status: 200, body: { buildTime: 'T' } }], /no usable commit/],
      ['commit is not a sha', [{ status: 200, body: { commit: 'unknown' } }], /no usable commit/],
      ['commit is a non-sha string', [{ status: 200, body: { commit: 'main' } }], /not a sha/],
      ['connection dropped', [{ hangup: true }], /request failed|REFUSING/],
    ];
    for (const [label, plan, why] of cases) {
      const s = await serve(plan);
      const r = await runGuard('http://127.0.0.1:' + s.port + '/version.json');
      s.srv.close();
      ck(label + ' -> REFUSES', r.code === 1, 'exit=' + r.code);
      ck('...and names why', why.test(r.out), (r.out.match(/Reason after[^\n]*/) || [''])[0].trim().slice(0, 70));
    }
    const s = await serve([{ status: 500, body: {} }]);
    const r = await runGuard('http://127.0.0.1:' + s.port + '/version.json');
    s.srv.close();
    ck('CONTROL the refusal never says "allowing deploy"', !/allowing deploy/.test(r.out),
       'the fail-open string must be gone from this path');
  }

  head('4 - a BLIP still does not block a release');
  {
    const s = await serve([{ status: 500, body: {} }, { status: 500, body: {} }, ok(HEADSHA)]);
    const r = await runGuard('http://127.0.0.1:' + s.port + '/version.json');
    const n = s.count(); s.srv.close();
    ck('two failures then success -> ALLOWED', r.code === 0, 'exit=' + r.code);
    ck('...because it retried rather than believing the first answer', n >= 3, n + ' requests made');
    ck('...and the retries were reported', /retry 1\/2/.test(r.out) && /retry 2\/2/.test(r.out));
  }

  console.log('\nwhat this suite does NOT prove');
  console.log('  UNPROVEN  behaviour against the real production endpoint under a real 500');
  console.log('  NOTE      a worktree pinned before this guard existed does not run it at all');
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED: ' + (e && e.stack)); process.exit(1); });
