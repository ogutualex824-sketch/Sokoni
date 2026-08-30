#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   B1.2 — FUNCTIONS PROVENANCE, TESTED AGAINST THE REAL DEPLOYMENT
   ══════════════════════════════════════════════════════════════════════════════
   The GCS archive lookup is NOT mocked. Sections 3 and 5 call gcloud against the
   live project and download the actual deployed source archives. That is the
   whole point: a mocked archive would prove the mock, and this mechanism's only
   interesting failure mode is what the real deployment does.

   WHAT THIS CANNOT PROVE YET, and says so rather than faking it: that the stamp
   survives INTO a deployed archive, and that same/different-release functions
   report their respective shas. No function has ever been deployed carrying
   build-info.js, so those need a real functions deploy — not authorized. They
   are reported UNPROVEN, not passed.

   Today every deployed archive lacks the stamp, which makes the live deployment
   a perfect fixture for the case that matters most: provenance ABSENT must be
   REFUSE, never "probably fine".

   RESULT CLASSES: PASS / FAIL / UNPROVEN / HARNESS-INVALID
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'scripts', 'deploy', 'functions-provenance.js'));
const PROJECT = 'sokoni-aeb26';
const STAMP = path.join(ROOT, 'functions', 'build-info.js');

let pass = 0, fail = 0, unproven = 0, invalid = 0;
const ok = (l, d) => { pass++; console.log('  PASS             ' + l + (d ? '   [' + d + ']' : '')); };
const no = (l, d) => { fail++; console.log('  FAIL             ' + l + (d ? '   [' + d + ']' : '')); };
const ck = (l, c, d) => (c ? ok(l, d) : no(l, d));
const un = (l, d) => { unproven++; console.log('  UNPROVEN         ' + l + (d ? '   [' + d + ']' : '')); };
const iv = (l, d) => { invalid++; console.log('  HARNESS-INVALID  ' + l + (d ? '   [' + d + ']' : '')); };
const head = (t) => console.log('\n-- ' + t + ' --');
const git = (a) => { try { return cp.execSync('git ' + a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { return ''; } };

/* Real commits from this repository, used for the lineage cases. Resolved rather
   than hardcoded short shas so the test fails loudly if the topology changes. */
const HEAD_SHA = git('rev-parse HEAD');
const PARENT_SHA = git('rev-parse HEAD~1');
const DIVERGED = git('rev-parse release-b/live');   /* merge carrying A2; forked before HEAD */

(async () => {
  head('0 - harness integrity');
  if (!/^[0-9a-f]{40}$/.test(HEAD_SHA)) { iv('cannot resolve HEAD', HEAD_SHA); }
  else ok('HEAD resolves', HEAD_SHA.slice(0, 7));
  ck('a diverged ref is available for section 4', /^[0-9a-f]{40}$/.test(DIVERGED), DIVERGED.slice(0, 7) || 'release-b/live missing');
  {
    /* the diverged ref must genuinely be diverged, or section 4 proves nothing */
    let contained = true;
    try { cp.execSync('git merge-base --is-ancestor ' + DIVERGED + ' ' + HEAD_SHA, { cwd: ROOT, stdio: 'ignore' }); }
    catch (e) { contained = false; }
    ck('...and it is genuinely NOT contained in HEAD', contained === false, 'contained=' + contained);
  }

  head('1 - the generator stamps the ACTUAL candidate commit');
  {
    const had = fs.existsSync(STAMP);
    cp.execSync('node "' + path.join(ROOT, 'scripts', 'generate-functions-build-info.js') + '"',
      { cwd: ROOT, stdio: 'ignore' });
    ck('build-info.js is produced', fs.existsSync(STAMP), had ? '(overwrote an existing stamp)' : '(new file)');
    const c = P.readCandidateStamp(ROOT);
    ck('...and it validates', c.ok, c.ok ? '' : c.why);
    ck('...carrying the real HEAD sha', c.ok && c.stamp.commit === HEAD_SHA, c.ok ? c.stamp.commitShort : '-');
    ck('...with schemaVersion 1', c.ok && c.stamp.schemaVersion === P.SCHEMA_VERSION);
    ck('...and a branch + buildTime', c.ok && !!c.stamp.branch && !!c.stamp.buildTime, c.ok ? c.stamp.branch : '-');
    ck('...dirty state is RECORDED, not hidden', c.ok && typeof c.stamp.dirtyWorkingTree === 'boolean',
      c.ok ? ('dirty=' + c.stamp.dirtyWorkingTree + ' paths=' + c.stamp.dirtyPaths.length) : '-');
    ck('CONTROL no secret-looking keys in the stamp', c.ok &&
      !Object.keys(c.stamp).some((k) => /key|token|secret|password/i.test(k)), c.ok ? Object.keys(c.stamp).join(',') : '-');
  }

  head('2 - a present-but-wrong stamp is REFUSED (worse than absent)');
  {
    ck('malformed sha rejected', !P.validateStamp({ schemaVersion: 1, commit: 'not-a-sha' }, 'x').ok);
    ck('short sha rejected', !P.validateStamp({ schemaVersion: 1, commit: 'abc1234' }, 'x').ok);
    ck('wrong schemaVersion rejected', !P.validateStamp({ schemaVersion: 99, commit: HEAD_SHA }, 'x').ok);
    ck('missing commit rejected', !P.validateStamp({ schemaVersion: 1 }, 'x').ok);
    ck('non-object rejected', !P.validateStamp(null, 'x').ok);
    ck('CONTROL a valid stamp is ACCEPTED', P.validateStamp({ schemaVersion: 1, commit: HEAD_SHA }, 'x').ok,
      'the validator can say yes');
  }

  head('3 - REAL deployed archives (no mocks) — provenance ABSENT must REFUSE');
  {
    const cases = [
      ['posCompleteCheckout', 'us-central1', 'v2 callable, most recent release'],
      ['algoliaSync_events_update', 'us-central1', 'DYNAMICALLY exported via Object.assign'],
      ['onMediaUploaded', 'us-east1', 'second region, separate bucket'],
    ];
    for (const [fn, region, note] of cases) {
      const r = P.fetchDeployedStamp(fn, region, PROJECT);
      if (r.ok) {
        ok(fn + ' (' + region + ') already carries a stamp', r.stamp.commitShort + ' — ' + note);
      } else if (r.absent) {
        ok(fn + ' (' + region + ') -> provenance ABSENT, reported as such', note);
        ck('...and it is NOT treated as safe', P.classify('', HEAD_SHA, ROOT).verdict === 'REFUSE',
          'empty live commit -> ' + P.classify('', HEAD_SHA, ROOT).verdict);
        ck('...archive identified for the record', /^gs:\/\/gcf-v2-sources-/.test(r.archive || ''), (r.archive || '').slice(0, 62));
      } else {
        no(fn + ' (' + region + ') lookup failed for an unexpected reason', r.why);
      }
    }
    /* CONTROL: the lookup must FAIL differently for a function that does not exist,
       otherwise "absent" might just mean the probe never reached anything. */
    const bogus = P.fetchDeployedStamp('definitelyNotAFunctionXyz', 'us-central1', PROJECT);
    ck('CONTROL a nonexistent function fails at DESCRIBE, not as "absent stamp"',
      !bogus.ok && !bogus.absent, (bogus.why || '').slice(0, 70));
  }

  head('3b - the B1.3 bootstrap function CARRIES provenance (live assertion)');
  {
    /* obsDistributedTrace was deployed on 2026-08-30 carrying build-info.js. This
       asserts the end-to-end chain against the real deployment rather than
       restating it in prose. If someone redeploys it from an unstamped tree, this
       goes red — which is the point. */
    const B13_SHA = '62a35efd543825412b244fccc53bd2df34cf1fee';
    const r = P.fetchDeployedStamp('obsDistributedTrace', 'us-central1', PROJECT);
    /* CONTRACT: 'archive cannot be resolved or read' is UNPROVEN, not FAIL. Only an
       ABSENT or WRONG stamp is a real failure. Conflating them once turned a network
       blip into five red assertions about a stamp that was actually present. */
    if (!r.ok && !r.absent) {
      un('obsDistributedTrace archive could not be READ', (r.why || '').slice(0, 80));
    } else {
    ck('the deployed archive CONTAINS a stamp', r.ok, r.ok ? r.stamp.commitShort : (r.why || '').slice(0, 70));
    ck('...readable through the production code path', r.ok && !!r.archive, r.ok ? r.archive.split('/').slice(-1)[0] : '-');
    ck('...carrying the exact B1.3 candidate sha', r.ok && r.stamp.commit === B13_SHA, r.ok ? r.stamp.commit.slice(0, 12) : '-');
    ck('...with schemaVersion 1', r.ok && r.stamp.schemaVersion === P.SCHEMA_VERSION);
    ck('PROVES a gitignored file IS packaged by firebase-tools', r.ok,
      'build-info.js is 404 on the remote yet present in the archive');
    if (r.ok) {
      const v = P.classify(r.stamp.commit, B13_SHA, ROOT);
      ck('...and the guard reads it as NOOP against the same commit', v.verdict === 'NOOP', v.verdict);
    }
    }
  }

  head('4 - lineage, not equality (real commits from this repo)');
  {
    const a = P.classify(PARENT_SHA, HEAD_SHA, ROOT);
    ck('live is an ANCESTOR of candidate -> ALLOW', a.verdict === 'ALLOW', a.verdict + ': ' + a.why);
    const b = P.classify(HEAD_SHA, HEAD_SHA, ROOT);
    ck('candidate identical to live -> NOOP', b.verdict === 'NOOP', b.verdict);
    const c = P.classify(DIVERGED, HEAD_SHA, ROOT);
    ck('DIVERGED live -> REFUSE', c.verdict === 'REFUSE', c.verdict + ': ' + c.why.slice(0, 60));
    ck('...for the DIVERGENCE reason, not "unknown commit"', /DIVERGED/.test(c.why), c.why.slice(0, 70));
    const d = P.classify('0000000000000000000000000000000000000000', HEAD_SHA, ROOT);
    ck('live commit unknown to the object store -> REFUSE', d.verdict === 'REFUSE', d.why.slice(0, 60));
    const e = P.classify(PARENT_SHA, 'not-a-sha', ROOT);
    ck('candidate provenance unusable -> REFUSE', e.verdict === 'REFUSE', e.why.slice(0, 50));
    /* THE case this exists for: a newer live payment fix must not be reverted by an
       older candidate merely because the shas differ. */
    const f = P.classify(HEAD_SHA, PARENT_SHA, ROOT);
    ck('candidate OLDER than live -> REFUSE (the rollback case)', f.verdict === 'REFUSE', f.verdict);
  }

  head('5 - per-function semantics support partial releases');
  {
    const one = P.describeDeployed('posCompleteCheckout', 'us-central1', PROJECT);
    const two = P.describeDeployed('submitReview', 'us-central1', PROJECT);
    ck('each function resolves its OWN archive', one.ok && two.ok && one.object !== two.object,
      one.ok && two.ok ? (one.object + ' vs ' + two.object) : 'describe failed');
    ck('...pinned to its own immutable generation', one.ok && two.ok && !!one.generation && one.generation !== two.generation,
      one.ok && two.ok ? (one.generation + ' vs ' + two.generation) : '-');
    ck('...so a partial release can be evaluated per function', one.ok && two.ok);
  }

  head('6 - the stamp is GENERATED, not committed');
  {
    /* The stamp must exist in the working tree for the deploy to package it, while
       being untracked so a stale committed sha can never be mistaken for the
       revision being released. Both halves matter; asserting only the ignore rule
       would pass just as well if the generator had stopped producing the file. */
    const ignored = (p) => { try { cp.execSync('git check-ignore -q "' + p + '"', { cwd: ROOT, stdio: 'ignore' }); return true; } catch (e) { return false; } };
    ck('functions/build-info.js is gitignored', ignored('functions/build-info.js'));
    ck('...yet PRESENT in the working tree for packaging', fs.existsSync(STAMP));
    const st = cp.execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    ck('...and absent from git status', !st.split(String.fromCharCode(10)).some(function (l) { return l.trim().slice(-25) === 'functions/build-info.js'.slice(-25) && l.indexOf('build-info.js') > -1; }),
      'exact-path match, not a substring');
    ck('...and untracked', (() => { try { cp.execSync('git ls-files --error-unmatch functions/build-info.js', { cwd: ROOT, stdio: 'ignore' }); return false; } catch (e) { return true; } })());
    ck('CONTROL the generator script itself is NOT ignored', !ignored('scripts/generate-functions-build-info.js'),
      'proves check-ignore discriminates');
    ck('CONTROL version.json IS tracked (the opposite choice, deliberately)',
      (() => { try { cp.execSync('git ls-files --error-unmatch version.json', { cwd: ROOT, stdio: 'ignore' }); return true; } catch (e) { return false; } })(),
      'tracking it is why every local deploy dirties the tree');
  }

  head('7 - the generator is WIRED into the functions predeploy chain (B1.4)');
  {
    /* Without this the stamp depends on someone remembering to run the generator,
       and another worktree could deploy Functions with no provenance at all —
       which the guard would then read as ABSENT and refuse forever. */
    const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    const fn = Array.isArray(fb.functions) ? fb.functions[0] : fb.functions;
    const ho = Array.isArray(fb.hosting) ? fb.hosting[0] : fb.hosting;
    ck('generator is in functions.predeploy', fn.predeploy.some((h) => /generate-functions-build-info/.test(h)));
    ck('...and runs FIRST', /generate-functions-build-info/.test(fn.predeploy[0]),
      'a failure then costs nothing, and the stamp reflects HEAD before any other hook runs');
    ck('...the original four gates all survive', ['predeploy-syntax-gate','verify-commission-single-source',
      'verify-delivery-engine-sync','predeploy-payout-gate'].every((h) => fn.predeploy.some((x) => x.indexOf(h) > -1)),
      fn.predeploy.length + ' hooks');
    ck('CONTROL hosting.predeploy is untouched', ho.predeploy.length === 11, String(ho.predeploy.length));
    ck('CONTROL functions.source unchanged', fn.source === 'functions', fn.source);
  }

  head('8 - the generator FAILS CLOSED when git cannot be resolved');
  {
    /* Run the real generator against a tree that is NOT a git repository. It must
       exit non-zero and write NO stamp — never emit a placeholder that the guard
       would later believe. Uses the real script, not a re-implementation. */
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-gen-'));
    try {
      fs.mkdirSync(path.join(tmp, 'scripts'));
      fs.mkdirSync(path.join(tmp, 'functions'));
      fs.copyFileSync(path.join(ROOT, 'scripts', 'generate-functions-build-info.js'),
        path.join(tmp, 'scripts', 'generate-functions-build-info.js'));
      let notRepo = true;
      try { cp.execSync('git rev-parse HEAD', { cwd: tmp, stdio: 'ignore' }); notRepo = false; } catch (e) {}
      ck('PRECONDITION the scratch tree is not a git repo', notRepo, tmp);
      let code = 0;
      try { cp.execSync('node "' + path.join(tmp, 'scripts', 'generate-functions-build-info.js') + '"', { cwd: tmp, stdio: 'pipe' }); }
      catch (e) { code = e.status || 1; }
      ck('generator exits NON-ZERO', code !== 0, 'exit=' + code);
      ck('...and writes NO stamp', !fs.existsSync(path.join(tmp, 'functions', 'build-info.js')),
        'a placeholder here would be believed by the guard later');
      /* CONTROL: the same script in a real repo DOES produce one — otherwise the
         above would pass even if the generator were simply broken. */
      ck('CONTROL the same generator succeeds in a real repo', fs.existsSync(STAMP), 'proves the refusal is conditional');
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  }

  head('what this suite does NOT prove');
  un('same-release functions report the SAME sha', 'B1.3 deployed ONE function; needs a multi-function deploy');
  un('a second release produces a DIFFERENT sha', 'needs another deploy');
  console.log('  SETTLED by B1.3 (see section 3b): the stamp reaches the deployed archive,');
  console.log('            reads back to the exact candidate sha, and a GITIGNORED file IS packaged.');
  console.log('  NOTE      B1.1 already proved same-release archives are byte-identical');
  console.log('            (md5 bxVei14Ow/3pqVZq5QlU6g== across 4 functions, 2 regions),');
  console.log('            so the stamp inside one is the stamp inside all of them.');

  console.log('\n' + '-'.repeat(62));
  console.log('  PASS ' + pass + '   FAIL ' + fail + '   UNPROVEN ' + unproven + '   HARNESS-INVALID ' + invalid);
  if (invalid) console.log('  HARNESS-INVALID present — results above are NOT evidence.');
  process.exit((fail || invalid) ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED: ' + (e && e.stack)); process.exit(1); });
