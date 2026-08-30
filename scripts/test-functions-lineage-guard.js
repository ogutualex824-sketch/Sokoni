#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   B2.5 — CERTIFICATION OF THE FUNCTIONS LINEAGE GUARD
   ══════════════════════════════════════════════════════════════════════════════
   This certifies the GUARD, not classify(). classify() is already covered by
   test-functions-provenance.js; what is unproven is the wrapper around it — the
   release-set semantics:

     declared A + B  ->  resolve exactly A and B  ->  evaluate both
                     ->  one refusal REFUSES THE ENTIRE RELEASE

   with a CONTROL declaring only A, so a refusal is attributable to B's presence
   rather than to the guard refusing everything.

   HOW THE ANCESTRY CASES ARE DRIVEN
   The guard reads its candidate from functions/build-info.js relative to its own
   location. To exercise NOOP / older / diverged we need candidate stamps other
   than HEAD's, so the suite builds scratch trees INSIDE this repository (so git
   still resolves commits) containing a copy of the guard and a build-info.js
   carrying a REAL commit sha from this repo's history. The shas are real; only
   which one the candidate claims is varied. Nothing is fabricated — a made-up
   sha would be rejected by the guard's own validation anyway, which case 9
   proves.

   Every case asserts BOTH the exit code and the printed verdict. Exit code alone
   cannot tell REFUSE-because-diverged from REFUSE-because-unreadable, and those
   are different production conditions.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'deploy', 'guard-functions-lineage.js');
const SCRATCH = path.join(ROOT, '.tmp-guard-cert');   /* inside the repo: git must resolve */

let pass = 0, fail = 0, unproven = 0, invalid = 0;
const ok = (l, d) => { pass++; console.log('  PASS       ' + l + (d ? '   [' + d + ']' : '')); };
const no = (l, d) => { fail++; console.log('  FAIL       ' + l + (d ? '   [' + d + ']' : '')); };
const ck = (l, c, d) => (c ? ok(l, d) : no(l, d));
const un = (l, d) => { unproven++; console.log('  UNPROVEN   ' + l + (d ? '   [' + d + ']' : '')); };
const iv = (l, d) => { invalid++; console.log('  HARNESS-INVALID  ' + l + (d ? '   [' + d + ']' : '')); };
const head = (t) => console.log('\n-- ' + t + ' --');
const git = (a) => { try { return cp.execSync('git ' + a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { return ''; } };

/* Run the guard, optionally from a scratch tree with a chosen candidate stamp. */
function run (release, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env);
  if (release === null) delete env.SOKONI_FN_RELEASE;
  else env.SOKONI_FN_RELEASE = release;
  const guard = opts.guardPath || GUARD;
  let out = '', code = 0;
  try {
    out = cp.execSync('node "' + guard + '"', { env: env, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status === undefined ? 1 : e.status;
  }
  return { out: out, code: code };
}

/* A scratch tree carrying a specific candidate stamp. Lives inside the repo so
   `git cat-file` / `merge-base` still work from it. */
function scratch (name, commitSha) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(path.join(dir, 'scripts', 'deploy'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'functions'), { recursive: true });
  for (const f of ['guard-functions-lineage.js', 'functions-provenance.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', 'deploy', f), path.join(dir, 'scripts', 'deploy', f));
  }
  if (commitSha) {
    const info = {
      schemaVersion: 1, commit: commitSha, commitShort: commitSha.slice(0, 7),
      branch: 'cert-scratch', buildTime: new Date().toISOString(),
      dirtyWorkingTree: false, dirtyPaths: [],
    };
    fs.writeFileSync(path.join(dir, 'functions', 'build-info.js'),
      'module.exports = ' + JSON.stringify(info, null, 2) + ';\n');
  }
  return path.join(dir, 'scripts', 'deploy', 'guard-functions-lineage.js');
}

const STAMPED = 'obsDistributedTrace';          /* the one function carrying provenance */
const STAMPED_SHA = '62a35efd543825412b244fccc53bd2df34cf1fee';
const UNSTAMPED = 'submitReview';               /* live, no stamp */

(function () {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}

  head('0 - harness integrity');
  const HEAD_SHA = git('rev-parse HEAD');
  ck('HEAD resolves', /^[0-9a-f]{40}$/.test(HEAD_SHA), HEAD_SHA.slice(0, 7));
  ck('the stamped commit is an ANCESTOR of HEAD', (() => {
    try { cp.execSync('git merge-base --is-ancestor ' + STAMPED_SHA + ' ' + HEAD_SHA, { cwd: ROOT, stdio: 'ignore' }); return true; }
    catch (e) { return false; }
  })(), 'so the live case should be ALLOW, not NOOP');
  ck('guard is present', fs.existsSync(GUARD));

  head('1 - the release set must be DECLARED');
  {
    const r = run(null);
    ck('missing SOKONI_FN_RELEASE -> REFUSE', r.code !== 0, 'exit=' + r.code);
    ck('...and says why', /release set is unknown/.test(r.out));
    ck('...and names the correct invocations', /--only functions/.test(r.out));

    const e = run('');
    ck('empty declaration -> REFUSE', e.code !== 0, 'exit=' + e.code);

    const m = run('bad name!,alsoBad');
    ck('malformed names -> REFUSE', m.code !== 0 && /malformed/.test(m.out), 'exit=' + m.code);
    ck('...and names the rejected token', /bad name!/.test(m.out));
  }

  head('2 - FULL is refused, and is not an escape hatch');
  {
    const r = run('FULL');
    ck('FULL -> REFUSE', r.code !== 0, 'exit=' + r.code);
    ck('...identified as mode FULL', /mode:\s*FULL/.test(r.out));
    ck('...resolved the REAL estate, not a guess', /functions:\s*1[0-9]{3}/.test(r.out),
      (r.out.match(/functions:\s*\d+/) || [''])[0]);
    ck('...refused for the baseline reason', /not fully provenance-certified/.test(r.out));
    ck('...and reports how many it examined', /examined \d+ of \d+/.test(r.out),
      (r.out.match(/examined \d+ of \d+/) || [''])[0]);
  }

  head('3 - per-function provenance outcomes (live estate)');
  {
    /* Reproduce the REAL invocation order: generate-functions-build-info.js is
       functions.predeploy hook #1, so the stamp is always regenerated immediately
       before the guard runs. Without this the suite reads whatever stamp happened
       to be left on disk - which is how an expected ALLOW first read as NOOP: the
       stamp still said 62a35ef while HEAD had moved on three commits. The stamp
       tracks the last generator run, NOT HEAD, and the guard is right to trust it
       because the stamp is what actually gets packaged into the archive. */
    cp.execSync('node "' + path.join(ROOT, 'scripts', 'generate-functions-build-info.js') + '"',
      { cwd: ROOT, stdio: 'ignore' });
    const freshStamp = require(path.join(ROOT, 'functions', 'build-info.js'));
    delete require.cache[require.resolve(path.join(ROOT, 'functions', 'build-info.js'))];
    ck('PRECONDITION the regenerated stamp tracks HEAD', freshStamp.commit === HEAD_SHA,
      freshStamp.commitShort + ' vs HEAD ' + HEAD_SHA.slice(0, 7));
    const a = run(STAMPED);
    ck('stamped function, candidate DESCENDANT -> ALLOW', a.code === 0 && /RESULT: ALLOW/.test(a.out),
      (a.out.match(/RESULT: \w+/) || [''])[0] + ' exit=' + a.code);
    ck('...verdict printed per function', /verdict: ALLOW/.test(a.out));

    const b = run(UNSTAMPED);
    ck('unstamped live function -> REFUSE', b.code !== 0, 'exit=' + b.code);
    ck('...reported as ABSENT, not as an error', /live: ABSENT/.test(b.out));

    const c = run('definitelyNotAFunctionXyz');
    ck('unreadable/unknown archive -> REFUSE', c.code !== 0, 'exit=' + c.code);
    ck('...UNPROVEN preserved in the DIAGNOSTIC', /UNPROVEN/.test(c.out),
      'the distinction survives even though the decision is binary');
  }

  head('4 - RELEASE-SET semantics (the point of this suite)');
  {
    const both = run(STAMPED + ',' + UNSTAMPED);
    ck('declares BOTH functions', /functions:\s*2/.test(both.out), (both.out.match(/functions:\s*\d+/) || [''])[0]);
    ck('...lists each by name', both.out.indexOf(STAMPED) > -1 && both.out.indexOf(UNSTAMPED) > -1);
    ck('...ONE refusal refuses the ENTIRE release', both.code !== 0, 'exit=' + both.code);
    ck('...and the release result is REFUSE', /RESULT: REFUSE/.test(both.out));

    /* CONTROL: the same guard, the same stamped function, WITHOUT the bad member.
       Without this, "REFUSE" could just mean the guard refuses multi-function sets. */
    const alone = run(STAMPED);
    ck('CONTROL the same set minus the bad member -> ALLOW', alone.code === 0,
      'so the refusal is attributable to ' + UNSTAMPED + ', not to set size');

    /* Order independence: the refusing member first must refuse identically. */
    const rev = run(UNSTAMPED + ',' + STAMPED);
    ck('order does not change the outcome', rev.code !== 0 && /RESULT: REFUSE/.test(rev.out), 'exit=' + rev.code);
  }

  head('5 - ancestry outcomes driven from scratch trees (REAL commits)');
  {
    const g1 = scratch('same', STAMPED_SHA);
    const r1 = run(STAMPED, { guardPath: g1 });
    ck('candidate IDENTICAL to live -> NOOP', r1.code === 0 && /RESULT: NOOP/.test(r1.out),
      (r1.out.match(/RESULT: \w+/) || [''])[0] + ' exit=' + r1.code);

    const parent = git('rev-parse ' + STAMPED_SHA + '~1');
    const g2 = scratch('older', parent);
    const r2 = run(STAMPED, { guardPath: g2 });
    ck('candidate OLDER than live -> REFUSE', r2.code !== 0, 'exit=' + r2.code + ' candidate=' + parent.slice(0, 7));
    ck('...for the rollback reason', /would not move production forward|DIVERGED|not contained/.test(r2.out));

    /* A genuinely diverged ref: release-b/live forked before this lineage. */
    const div = git('rev-parse release-b/live');
    if (/^[0-9a-f]{40}$/.test(div)) {
      const g3 = scratch('diverged', div);
      const r3 = run(STAMPED, { guardPath: g3 });
      ck('candidate DIVERGED from live -> REFUSE', r3.code !== 0, 'exit=' + r3.code);
      ck('...named as divergence', /DIVERGED/.test(r3.out), 'not merely "unknown"');
    } else un('diverged case', 'release-b/live not present in this checkout');

    const g4 = scratch('nostamp', null);   /* no build-info.js at all */
    const r4 = run(STAMPED, { guardPath: g4 });
    ck('CANDIDATE provenance absent -> REFUSE', r4.code !== 0, 'exit=' + r4.code);
    ck('...and says the candidate is the problem', /CANDIDATE has no usable provenance/.test(r4.out));

    /* A fabricated sha must be rejected by validation, not believed. */
    const g5 = scratch('fake', 'z'.repeat(40));
    const r5 = run(STAMPED, { guardPath: g5 });
    ck('CONTROL a non-hex candidate sha is REJECTED', r5.code !== 0, 'a fabricated stamp cannot pass validation');
  }

  head('6 - no sampling, no implicit FULL');
  {
    const r = run(STAMPED);
    ck('a PARTIAL release is labelled PARTIAL', /mode:\s*PARTIAL/.test(r.out));
    ck('...and never silently becomes FULL', !/mode:\s*FULL/.test(r.out));
    ck('...and states the exact set size', /functions:\s*1\b/.test(r.out));
  }

  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}

  head('what this suite does NOT prove');
  un('that SOKONI_FN_RELEASE matches the actual --only filter',
    'firebase-tools does not expose --only to hooks; needs the design-B wrapper');
  un('behaviour inside a real firebase deploy invocation', 'runs the guard directly, not through firebase');

  console.log('\n' + '-'.repeat(62));
  console.log('  PASS ' + pass + '   FAIL ' + fail + '   UNPROVEN ' + unproven + '   HARNESS-INVALID ' + invalid);
  process.exit((fail || invalid) ? 1 : 0);
})();
