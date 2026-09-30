# Blue/green release and recovery — per surface, without rebuilding

**Status (2026-10-01):**
- **Tooling:** built and verified read-only against production.
- **Hosting rollback:** not yet exercised. Needs a deploy window and owner approval.
- **Functions rollback by named revision:** has been exercised before. `webhookintasend` is pinned to 00068-del and `adminprocesspayout` to 00024-mih.

**Related:** [[ROLLBACK_MANIFEST]] · [[SECURITY_PRIVACY_GAP_CENSUS_2026-10-01]] · `CLAUDE.md` Operational Guardrails · `docs/GCP_COST_ARCHITECTURE_IMPLEMENTATION.md` (Artifact Registry)

## Principles

1. **Recover by re-pointing, never by rebuilding.** Hosting keeps every released version. Cloud Run keeps function revisions. Recovery routes traffic back to one of them.
2. **One surface at a time.** Hosting, a named function, rules and indexes each have their own recovery. There is no "full-stack rollback". Production functions are a union of lineages, so a full redeploy from any one tree regresses the rest. That is why `scripts/deploy/rollback.js` was retired.
3. **Dry-run first.** `scripts/deploy/recover.js` prints the plan and its preconditions. It changes nothing without `--execute`, and a function move also needs `--confirm=<service>`.

## Hosting

| Step | Command | Notes |
|---|---|---|
| **Blue** = what is live now | `node scripts/deploy/recover.js hosting --list` | The first row is live. Record its version id before any deploy. |
| **Green** = candidate on a preview channel | `firebase hosting:channel:deploy green-<commit> --expires 2d` | Run the release gates against the channel URL. The predeploy guards still apply. |
| Promote green | `firebase hosting:clone sokoni-aeb26:green-<commit> sokoni-aeb26:live`, or the normal guarded `firebase deploy --only hosting` from the certified tree | Verify with `curl -s "https://mysokoni.co.ke/version.json?cb=$RANDOM"`. |
| **Recover** to blue | `node scripts/deploy/recover.js hosting --to-version=<blue version id> --execute` | Re-releases the finalized blue version: no build, no upload. Refuses if the version is not FINALIZED or is already live. |

The release history has unlimited retention (1,564 releases as of 2026-09-30), so every earlier version can be re-released.

## Cloud Functions (gen2 on Cloud Run)

| Step | Command | Notes |
|---|---|---|
| Record blue | `node scripts/deploy/recover.js function --service=<svc> --status` | Write down the serving revision **name**. |
| Deploy green | `firebase deploy --only functions:<name>` (named, scoped, after the live-archive lineage diff) | A new immutable revision. Never a full `--only functions`. |
| **Recover** to blue | `node scripts/deploy/recover.js function --service=<svc> --to-revision=<blue> --execute --confirm=<svc>` | Uses `gcloud run services update-traffic --to-revisions=<rev>=100`, by **name**. |

The tool's preconditions:
- the revision exists;
- it is `Ready=True`;
- its image is pinned by digest;
- **the image still exists in Artifact Registry**.

Two constraints apply:
- **Image retention.** Artifact Registry keeps the 10 newest images per repository (KEEP policy), and a DELETE policy removes images older than 24 hours outside that set. A revision whose image is gone cannot scale up. The tool checks for this and refuses, so recovery is only possible to recent revisions.
  - Verified 2026-10-01, dry run: `webhookintasend-00064-lag` was refused because its image is gone. `00067-kog` passed every check.
- **No service updates.** Never run `gcloud run services update`. It fails and leaves an undeletable revision behind (CLAUDE.md).

## Rules and indexes

- **Rules:** re-release the previous ruleset by id. The served ruleset id is recorded in memory and the release notes, and `scripts/deploy/release-firestore-rules.js` does this.
- **Indexes:** adding an index is not reverted in an emergency, because extra indexes are harmless. Never run a `--force` index deploy from a file that has not been compared with the live set: 8 live indexes are missing from the repo.

## Drill (to certify recovery) — needs owner approval and a deploy window

1. Deploy a harmless hosting change to a preview channel, then promote it.
2. Run `recover.js hosting --to-version=<previous>`, execute it, and verify `version.json`.
3. Re-promote.
4. Run the same drill for one low-risk function, with a smoke call after each move.

Record the timings and outcomes in the release log. Until the drill runs, hosting recovery is **tooled but UNPROVEN**.
