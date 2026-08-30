#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   B2 — FUNCTIONS LINEAGE GUARD
   ══════════════════════════════════════════════════════════════════════════════
   Hosting has guard-no-rollback, which compares this tree against version.json.
   Functions had no equivalent because nothing published which revision was live.
   B1 supplied that (functions/build-info.js, carried into each function's
   immutable source archive). This is the decision built on it.

   WHY SOKONI_FN_RELEASE IS MANDATORY
   firebase-tools does NOT pass the --only filter to predeploy hooks. Its
   getChildEnvironment gives exactly GCLOUD_PROJECT, PROJECT_DIR and RESOURCE_DIR
   (plus process.env). So a hook CANNOT see whether it is guarding one function or
   1,708. Guessing would be sampling, and a sample is telemetry, not an
   authorization. The operator therefore DECLARES the release set, and an
   undeclared set is refused on the same principle as absent provenance:
   an unanswered question is not permission.

       SOKONI_FN_RELEASE=obsDistributedTrace \
         firebase deploy --only functions:obsDistributedTrace

   PAIRED OPERATIONAL REQUIREMENT, stated because this guard cannot enforce it:
   the declaration and the --only filter must match. `SOKONI_FN_RELEASE=FULL`
   alongside `--only functions:one` is NOT a full release, and nothing here can
   see the discrepancy. Machine-enforced consistency needs a wrapper that is
   itself the caller (design B, deliberately deferred).

   THE DECISION TABLE (agreed contract)
     candidate contains live   -> ALLOW
     candidate == live         -> NOOP
     candidate older than live -> REFUSE
     diverged                  -> REFUSE
     live provenance absent    -> REFUSE
     candidate provenance bad  -> REFUSE
     archive unreadable        -> UNPROVEN in diagnostics, REFUSE as the decision

   UNPROVEN is preserved in the OUTPUT because "could not read" and "read, and it
   is wrong" are different production conditions worth telling apart. It is NOT
   preserved in the exit code: a deployment gate has two outcomes.

   BOOTSTRAP IS DELIBERATELY BLOCKED. 1,707 of 1,708 deployed functions carry no
   stamp, so FULL refuses. That is the intended result, not a defect to work
   around: it is the evidence that the provenance rollout is incomplete. The way
   out is stamping the baseline, never weakening this file.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, 'functions-provenance.js'));

const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const DEFAULT_REGION = 'us-central1';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function out (s) { console.log(s); }

function refuse (reason, detail) {
  out('');
  out('  x [functions-lineage] REFUSING TO DEPLOY');
  out('      ' + reason);
  if (detail) String(detail).split('\n').forEach((l) => out('      ' + l));
  out('');
  process.exit(1);
}

/* ── the release set. Declared, never inferred. ─────────────────────────────── */
function resolveReleaseSet () {
  const raw = (process.env.SOKONI_FN_RELEASE || '').trim();

  if (!raw) {
    refuse('SOKONI_FN_RELEASE is not set, so the release set is unknown.',
      'firebase-tools does not pass --only to predeploy hooks, so this guard cannot\n' +
      'discover what you are deploying. Declare it:\n' +
      '\n' +
      '  SOKONI_FN_RELEASE=fnA,fnB   firebase deploy --only functions:fnA,functions:fnB\n' +
      '  SOKONI_FN_RELEASE=FULL      firebase deploy --only functions\n' +
      '\n' +
      'Guessing would mean sampling, and a sample cannot authorize a release.');
  }

  if (raw.toUpperCase() === 'FULL') return { mode: 'FULL', names: null };

  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) refuse('SOKONI_FN_RELEASE is set but empty after parsing.', JSON.stringify(raw));
  const bad = names.filter((n) => !NAME_RE.test(n));
  if (bad.length) {
    refuse('SOKONI_FN_RELEASE contains malformed function names.',
      'rejected: ' + bad.join(', ') + '\nExpected a comma-separated list of function names, or FULL.');
  }
  return { mode: 'PARTIAL', names: names };
}

/* For FULL, the set is what is actually deployed — the functions a reconcile
   would replace. One list call, not a guess. */
function listDeployed () {
  const r = P._gcloud('functions list --project=' + PROJECT +
    ' --format="value(name.segment(5),name.segment(3))"', 300000);
  if (!r.ok) return null;
  const rows = r.text.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 2 && NAME_RE.test(p[0]))
    .map((p) => ({ name: p[0], region: p[1] }));
  return rows.length ? rows : null;
}

(function () {
  const set = resolveReleaseSet();

  /* The candidate side first: if this tree has no valid stamp, nothing else matters. */
  const cand = P.readCandidateStamp(ROOT);
  if (!cand.ok) {
    refuse('The CANDIDATE has no usable provenance.', cand.why +
      '\nRun scripts/generate-functions-build-info.js (it is functions.predeploy hook #1).');
  }
  const candidateSha = cand.stamp.commit;

  let members;
  if (set.mode === 'FULL') {
    const deployed = listDeployed();
    if (!deployed) {
      refuse('Could not enumerate deployed functions, so the FULL release set is unknown.',
        'An unknown release set is refused rather than approximated.');
    }
    members = deployed;
  } else {
    members = set.names.map((n) => ({ name: n, region: DEFAULT_REGION }));
  }

  out('');
  out('RELEASE SET');
  out('  mode: ' + set.mode);
  out('  functions: ' + members.length);
  if (set.mode === 'PARTIAL') members.forEach((m) => out('  ' + m.name + ' (' + m.region + ')'));
  out('');
  out('  candidate: ' + cand.stamp.commitShort + ' (' + cand.stamp.branch + ')' +
    (cand.stamp.dirtyWorkingTree ? '  DIRTY' : ''));
  out('');
  out('PROVENANCE');

  /* Fail fast. One refusing member refuses the release, so reading the remaining
     1,707 archives would change nothing and cost an hour. This is NOT sampling:
     the stop is a real finding about a real member, not an inference about the
     ones not read — and the report says exactly how many were examined. */
  let checked = 0, allowed = 0, noop = 0;
  for (const m of members) {
    checked++;
    const live = P.fetchDeployedStamp(m.name, m.region, PROJECT);

    if (!live.ok && live.absent) {
      out('  ' + m.name);
      out('    live: ABSENT — deployed before provenance existed');
      out('    verdict: REFUSE');
      out('');
      out('RESULT: REFUSE   (examined ' + checked + ' of ' + members.length + ')');
      refuse(set.mode === 'FULL'
        ? 'The production Functions baseline is not fully provenance-certified.'
        : 'A function in this release has no deployed provenance.',
        m.name + ' carries no build-info.js, so what it is running cannot be established.\n' +
        'Deploying over it could revert work with nothing able to detect that.\n' +
        'Fix: stamp the baseline by deploying these functions from a tree carrying\n' +
        'functions/build-info.js — never by relaxing this guard.');
    }

    if (!live.ok) {
      out('  ' + m.name);
      out('    live: UNPROVEN — ' + (live.why || 'archive unreadable'));
      out('    verdict: REFUSE   (UNPROVEN collapses to REFUSE at a deployment gate)');
      out('');
      out('RESULT: REFUSE   (examined ' + checked + ' of ' + members.length + ')');
      refuse('The deployed archive for ' + m.name + ' could not be read.',
        'Uncertainty is not permission. Retry; if it persists, investigate the\n' +
        'archive rather than bypassing the guard.');
    }

    const v = P.classify(live.stamp.commit, candidateSha, ROOT);
    out('  ' + m.name);
    out('    live: ' + live.stamp.commitShort + '   candidate: ' + cand.stamp.commitShort);
    out('    verdict: ' + v.verdict);
    if (v.verdict === 'REFUSE') {
      out('    ' + v.why);
      out('');
      out('RESULT: REFUSE   (examined ' + checked + ' of ' + members.length + ')');
      refuse('Deploying ' + m.name + ' would not move production forward.', v.why);
    }
    if (v.verdict === 'NOOP') noop++; else allowed++;
  }

  out('');
  const result = allowed === 0 ? 'NOOP' : 'ALLOW';
  out('RESULT: ' + result + '   (' + checked + ' checked, ' + allowed + ' advancing, ' + noop + ' already current)');
  out('');
  process.exit(0);
})();
