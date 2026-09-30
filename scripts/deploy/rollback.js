#!/usr/bin/env node
'use strict';
/* ============================================================================
   RETIRED 2026-10-01 — this script is disabled on purpose. It refuses to run.
   ----------------------------------------------------------------------------
   What it used to do, and why that is unsafe on this project:
     1. `git stash` — a REPO-WIDE stash in a repository several agents write concurrently,
        which can take or later pop another session's uncommitted work.
     2. check out an old tag and run a FULL `firebase deploy --only functions --force`.
        Production Cloud Functions are a union of several code lineages; a full deploy from
        any single tree deletes or regresses every function that tree does not match.
     3. deploy old Firestore rules wholesale.
   It had never been exercised (the canary workflow that calls it has no runs).

   Recovery now re-points traffic at artefacts that already exist, one surface at a time,
   dry-run by default:
     node scripts/deploy/recover.js hosting --list
     node scripts/deploy/recover.js hosting --to-version=<versionId> [--execute]
     node scripts/deploy/recover.js function --service=<svc> --status
     node scripts/deploy/recover.js function --service=<svc> --to-revision=<rev> [--execute --confirm=<svc>]
   Procedure: docs/BLUE_GREEN_RECOVERY.md.  The previous implementation is in git history.
   ============================================================================ */
console.error('scripts/deploy/rollback.js is RETIRED (unsafe full-functions redeploy + repo-wide git stash).');
console.error('Use scripts/deploy/recover.js — see docs/BLUE_GREEN_RECOVERY.md.');
process.exit(2);
