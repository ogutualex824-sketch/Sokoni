#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   THE CACHE COUNTER CAN NEVER GO BACKWARDS
   ══════════════════════════════════════════════════════════════════════════════
   On 2026-08-28 production went from v564 to v563. The bump derived its floor
   from a hand-maintained constant (LAST_SHIPPED_V = 562) and a committed
   version.json reading v560, computed max(560,562)+1 = v563, and shipped a
   counter LOWER than the live one.

   The script's own comment claimed this class of error is "caught by the
   predeploy gate before deployment". It was not — and it could not be, because a
   constant cannot know what is live. It had already been raised twice before for
   the same reason (115->530, 556->561). A third raise alone would just schedule
   the fourth.

   Why the constant goes stale, measured: version.json is written at deploy time
   and never committed back. Across all 272 commits touching it the maximum is
   v563, while v564 had shipped. Git undercounts by construction.

   So the floor now includes THE DEPLOYED COUNTER, and this suite drives the REAL
   script — not a reimplementation of its arithmetic — against a local server
   returning chosen values. A guard that is only ever checked by reading its
   source is not a tested guard.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SW = path.join(ROOT, 'service-worker.js');
const BUMP = path.join(ROOT, 'scripts', 'deploy', 'bump-sw-version.js');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n        [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '\n        [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

const counterOf = (s) => { const m = /-v(\d+)\s*$/.exec(s || ''); return m ? Number(m[1]) : null; };
const swCounter = () => {
  const m = /const CACHE_VERSION\s*=\s*["']([^"']+)["']/.exec(fs.readFileSync(SW, 'utf8'));
  return m ? counterOf(m[1]) : null;
};

/* Serve a chosen version.json so the real script's real network path executes. */
function serveVersion(counter) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cacheVersion: 'sokoni-20260101000000-v' + counter }));
    });
    s.listen(0, () => resolve({ server: s, url: 'http://localhost:' + s.address().port + '/version.json' }));
  });
}

/* Run the REAL bump with the live URL pointed wherever we choose.

   ASYNC spawn, deliberately. The first version of this rig used spawnSync, which
   BLOCKS THE PARENT EVENT LOOP — so the local version server, living in this same
   process, could never accept the child's connection. Every case reported
   "production unreachable", the script fell back to the floor, and three
   assertions passed only because the floor happened to exceed the live value they
   were testing against. The guard was fine; the rig was measuring nothing.

   The service worker is restored after every run, so the suite never leaves a
   bump behind. */
function runBump(url, scriptPath) {
  const backup = fs.readFileSync(SW, 'utf8');
  const env = Object.assign({}, process.env);
  if (url) env.SOKONI_LIVE_VERSION_URL = url; else delete env.SOKONI_LIVE_VERSION_URL;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath || BUMP], { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => {
      const computed = swCounter();
      fs.writeFileSync(SW, backup, 'utf8');
      resolve({ status, out, computed });
    });
  });
}

(async () => {
  console.log('\n  CACHE VERSION FLOOR — the counter is monotonic against LIVE');
  console.log('  ' + '='.repeat(72));

  const committed = swCounter();
  const floorSrc = fs.readFileSync(BUMP, 'utf8');
  const FLOOR = Number((/LAST_SHIPPED_V\s*=\s*(\d+)/.exec(floorSrc) || [])[1]);

  head('0 - the fixtures are real');
  ck('CONTROL service-worker.js carries a parseable counter', committed !== null, 'committed v' + committed);
  ck('CONTROL the bump script was located', fs.existsSync(BUMP));
  ck('the floor is at least the highest counter known to have shipped', FLOOR >= 564,
     'LAST_SHIPPED_V = ' + FLOOR + '; v564 shipped from 55d4b40 and v563 is currently live');

  head('1 - the computed counter is STRICTLY greater than live, at every value');
  for (const liveN of [100, 563, 564, 565, 900, 9999]) {
    const { server, url } = await serveVersion(liveN);
    try {
      const r = await runBump(url);
      ck('live v' + liveN + ' -> computed v' + r.computed,
         r.status === 0 && r.computed !== null && r.computed > liveN,
         'strictly greater: ' + (r.computed > liveN) + '  (exit ' + r.status + ')');
    } finally { server.close(); }
  }

  head('2 - the exact regression that shipped cannot recur');
  {
    /* The real numbers: committed v560, floor was 562, live v564 -> it produced v563. */
    const { server, url } = await serveVersion(564);
    try {
      const r = await runBump(url);
      ck('with live v564, the counter is NOT v563', r.computed !== 563, 'computed v' + r.computed);
      ck('...and is above the historical maximum too', r.computed > 564,
         'v564 shipped but was never committed, so git alone would have missed it');
    } finally { server.close(); }
  }

  head('3 - an unreachable production is BLOCKED, not silently trusted');
  {
    const r = await runBump('http://127.0.0.1:1/version.json'); /* nothing listens on port 1 */
    ck('the bump still succeeds so an offline deploy is not bricked', r.status === 0, 'exit ' + r.status);
    ck('...but it SAYS the live check did not run', /LIVE COUNTER CHECK DID NOT RUN/.test(r.out),
       'silence here would be indistinguishable from a passing check');
    ck('...and falls back to the floor, not to the committed value',
       r.computed !== null && r.computed > FLOOR - 1 && r.computed > committed,
       'computed v' + r.computed + ' vs floor ' + FLOOR + ', committed v' + committed);
  }

  head('4 - CONTROL: this suite can DETECT a broken implementation');
  {
    /* Sabotage: a copy that ignores the live counter exactly as the old code did.
       If the suite cannot fail against this, section 1 proves nothing. */
    const sab = path.join(ROOT, 'scripts', 'deploy', '_sabotage-bump.js');
    const broken = floorSrc
      .replace(/const nextN = Math\.max\(prevN, LAST_SHIPPED_V, live \? live\.n : 0\) \+ 1;/,
               'const nextN = Math.max(prevN, 562) + 1;')
      .replace(/if \(live && nextN <= live\.n\) \{/, 'if (false) {');
    fs.writeFileSync(sab, broken, 'utf8');
    try {
      const changed = broken !== floorSrc;
      ck('CONTROL the sabotage actually altered the script', changed,
         'an unchanged copy would make the control vacuous');
      const { server, url } = await serveVersion(564);
      try {
        const r = await runBump(url, sab);
        ck('CONTROL the OLD behaviour reproduces the regression', r.computed === 563,
           'sabotaged copy computed v' + r.computed + ' against live v564 — exactly what shipped');
        ck('CONTROL section 1 would therefore have FAILED on the old code', !(r.computed > 564),
           'so the assertions above are load-bearing, not tautological');
      } finally { server.close(); }
    } finally { fs.existsSync(sab) && fs.unlinkSync(sab); }
  }

  head('what this suite does NOT prove');
  un('the counter is monotonic across the whole deploy HISTORY',
     'git undercounts by construction — version.json is written at deploy time and never committed back');
  un('a concurrent deploy from another tree cannot interleave',
     'two deploys racing could both read the same live counter; the cooldown guard reduces but does not eliminate it');

  console.log('\n  ' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('  ' + '='.repeat(72) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
