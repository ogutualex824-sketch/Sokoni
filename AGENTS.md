# AGENTS.md — conventions for AI agents working on SOKONI

Multiple AI agents (Claude Code, Cursor, Copilot) work this repo in **parallel git
worktrees**. These rules prevent failures that have actually happened in production.
(Claude Code also loads the same rules from `CLAUDE.md`.)

---

## ⚠️ ARTIFACT REGISTRY — cause PROVEN, repair APPLIED, protection UNPROVEN (updated 2026-09-21)

`gcf-artifacts` held no function images until 2026-09-21; it now contains the rebuilt
`profile_get_public_profile` function image and its build cache. The other **1,708** services
still serve from Cloud Run's internal copies and **cannot create a new revision from their
existing spec**.

**CAUSE — PROVEN 2026-09-21.** Both repositories carry the cleanup policy
`firebase-functions-cleanup`: `action: DELETE`, `condition.olderThan: 86400s`,
`tagState: ANY`. The Artifact Registry service agent executes it as `BatchDeleteVersions`.
It is age-based and **reference-blind** — the policy has no knowledge of Cloud Run revision
references and is therefore capable of deleting an image that a live Cloud Run revision
still depends on. Installed by the Firebase CLI's cleanup prompt: `UpdateRepository`
2026-06-10 (us-central1) and 2026-06-23 (us-east1), userAgent `FirebaseCLI/15.19.0`.
Self-inflicted, not a Google-side defect.

**How it was proven.** The canary — inert, owned by no function, referenced by nothing —
was pushed 2026-09-19T06:08:12Z and deleted 2026-09-20T10:16:05Z at age 28.1h, with the
contamination check clean: no deploy, no function deletion, no build in the window.

**Function deletion is REFUTED as the cause.** It was the leading suspect; it is not the
mechanism. "Cause is unknowable as configured" is superseded. The 2026-09-19 finding of
"no cleanup policy" was a **false negative** — `repositories list` does not render
`cleanupPolicies`; only a JSON `describe` does. An absence seen through a default formatter
was never an absence.

**This removes the STATED BASIS for the P0-2 / P0-3 / P0-4 freeze. It does not unfreeze
them.** Each keeps its own authorization and its own safety conditions. Function deletion is
likewise no longer prohibited *by this notice* — but `intasendWebhook` retirement and P1
consolidation retain their own separate gates, which this notice does not touch.

**EXTERNALLY EXECUTED 2026-09-21, outside this workstream and outside Git.** Another agent
applied the policy repair and rebuilt one function. No commit records it. Verified live,
read-only:

* both repos now carry **two** policies — `firebase-functions-cleanup` (DELETE, 86400s, ANY,
  unchanged) **and** `sokoni-recovery-protection` (KEEP, `mostRecentVersions.keepCount: 10`).
  `cleanupPolicyDryRun` unset = **ENFORCING**. Applied 04:35:43Z / 04:36:22Z.
* `profilegetpublicprofile` rebuilt: image `sha256:133a75e9…` built 04:21:47Z, revision
  `00007-xaz` **Ready=True** at 04:22:04Z, pinned **by digest**, not by tag. Function count
  unchanged at **1,709** — a revision was replaced; nothing was added or deleted.
* **the rebuild PRECEDED the policy repair by 14 minutes.** It was rebuilt while the image was
  well inside the 24h window, so the DELETE policy had not yet made it eligible. That is the
  sequencing defect this notice warns about, not a licence to repeat it.

**PROTECTION IS CONFIGURED, NOT PROVEN.** The KEEP rule's existence and enforcement state are
observed; its behaviour *through a sweep* is not. Earliest eligibility is
**~2026-09-22T04:21:47Z** and the sweep may run later. Until the specimen survives, KEEP is an
assertion.

**Re-read this notice immediately before any production mutation.** Another agent acted between
this notice's commit and this correction — a notice you read an hour ago may already be stale.

**Still do NOT:**

* **rebuild any further Cloud Function.** The remaining **seven** damaged services stay FROZEN
  until the specimen proves survival. Do not rebuild in order to test the KEEP rule — the
  specimen already exists, and a second rebuild adds risk without adding evidence.
* run `gcloud run services update` — it still fails, and leaves behind a failed revision
  that **cannot be deleted** (a revision cannot be removed while it is
  `latestCreatedRevisionName`)
* change the cleanup policy. It is **already repaired**. `--policy` is *set or update* and may
  REPLACE the whole rule set, so any policy file must carry **both** the DELETE and the KEEP
  rule. **`--dry-run` is not a preview** — it is "disable deleting images according to cleanup
  policies", i.e. it stops enforcement. And never "fix" anything by DELETING the policy:
  firebase-tools 15.26 computes `hasOtherPolicies` and now **skips** cleanup setup while
  `sokoni-recovery-protection` exists — which protects the repair from `deploy --force`, but
  also means the CLI will no longer restore the DELETE rule if someone removes it by hand.
  Policy changes are deliberate-only.
* push, delete or tidy anything in Artifact Registry, **except** the one case below.

> **The live specimen replaces canary #2.** `profile_get_public_profile` is a naturally
> occurring protection test under the repaired policy, so no inert canary need be
> manufactured. **Do not delete, re-tag, rebuild or otherwise disturb it** — that destroys the
> only evidence that will answer whether KEEP works. Canary #2 stays defined, unnecessary, and
> NOT authorized.

The original 09-19 canary is **gone**, consumed by the mechanism it was built to detect.

Check state with `node scripts/infra/ar-forensics.js 3d` (read-only; self-classifying, and
it flags contamination). Background: `docs/GCP_COST_ARCHITECTURE_IMPLEMENTATION.md`, P0-2
onward.

**Remove this notice only when the specimen has survived its first sweep after
~2026-09-22T04:21Z, the remaining seven services are rebuilt, and the owner says so.**

---

## Deploying — read this first

> ### ⛔ NOTICE (2026-09-05) — Functions deploys are intentionally blocked on this branch
>
> `functions.predeploy` now begins with a **Git-tree require-closure gate**
> (`scripts/gate-functions-require-closure.js`). The current branch **fails it**, because four
> local dependencies are not present in the deploy tree:
> `order-claim`, `manual-till-orders`, `commission-invoice`, `pos-mpesa-refs`.
>
> **This is deliberate fail-closed behaviour, not a deployment outage.** `functions/index.js`
> has required these since `fa5082b`; three are committed on no ref anywhere. They are present
> on disk only as untracked working files, which is **not** deployable provenance — a deploy
> uses a checkout, not your disk.
>
> `order-claim` is the only currently **unowned** provenance blocker — see
> `docs/ESCALATION_ORDER_CLAIM_PROVENANCE.md`. Per-file dispositions for all four are in
> `docs/UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS.md`.
>
> **Do not introduce a bypass for convenience.** Do not remove or reorder the gate, do not
> commit a guessed implementation, and do not commit a module merely because a copy exists in
> another worktree. Check status any time with:
> `node scripts/gate-functions-require-closure.js`

- Live production is **`mysokoni.co.ke`** (Firebase Hosting). `sokoni.co.ke` is an
  **unrelated site** — never use it to judge whether a change shipped.
- **Only deploy hosting from the latest commit.** Firebase deploys the files in *your*
  worktree, not `HEAD`. Deploying from an older worktree **rolls back production** — this
  is what repeatedly reverted the earn page to an old version.
- A predeploy guard (`scripts/deploy/guard-no-rollback.js`) runs first and **aborts the
  deploy if your tree is behind live.** If it stops you, update to latest and retry — do
  **not** force past it.
- **One deploy at a time.** If another deploy is running, wait for its exit code. Never run
  two concurrent deploys. Prefer a single designated deploy-authority session.
- **Verify live after every deploy:**
  `curl -s "https://mysokoni.co.ke/<file>?cb=$RANDOM" | grep <marker>` and
  `curl -s https://mysokoni.co.ke/version.json` (shows the live commit + cacheVersion).

## PWA / page freshness
- The service worker is **correct** — HTML/CSS/JS are network-first, the SW file is
  `no-cache`, and updates are intentionally **flash-free** (`e430b89`). **Do not "fix" SW
  caching.**
- **Every new user-facing page MUST self-update.** Either load `shared-header.js` (it
  auto-injects `sw-register.js`) or add `<script src="/sw-register.js" defer></script>`
  before `</body>`. A page with neither serves stale after the next deploy.
- Never hand-edit `CACHE_VERSION` or regress the `-vNN` counter — the predeploy bump owns it.

## Inventory / payments (correctness-critical)
- Stock deductions run **inside a Firestore transaction**, floored at zero (never negative),
  writing `stock` + `updatedAt` + `inventoryVersion: increment(1)` **together** in one
  atomic update. All reads must precede all writes.
- **Never trust client payment or stock.** The server is authoritative. Guard oversell
  **before** charging; if a race slips through after payment, flag `oversoldAlerts` — never
  reject a paid order.

## Repo discipline
- Another process writes this repo concurrently. **Never overwrite or
  `git worktree remove --force` another agent's dirty work** — verify ownership first.
- Commit in small, focused chunks with clear messages.
- New Cloud Functions must be re-exported by name in `functions/index.js`.
- Update `CHANGELOG.md` with every change.
- **`hr-payroll.html` is entirely CRLF; the rest of the repo is LF.** Every line you add
  to it therefore shows up in `git diff --check` as *"trailing whitespace"* — that is the
  CR being counted, **not an actual trailing space**. Verified 2026-09-20: 1663 CRLF /
  1663 LF, and the already-committed `0cf035f` added 8 lines to it, all CR-terminated.
  **Do not normalize it opportunistically** — converting the file produces a 1,663-line
  diff that has nothing to do with whatever HR change you were making, and buries it.
  Preserve the file's existing endings and treat that `--check` output as expected.
- **Never rename a field with a blanket string replace.** `.where('status','==','active')`
  appeared on `hrStaff` *and* on `hrTraining`; renaming the employment axis by pattern hit
  both and would have made every training invisible. Match on the owning collection, or
  edit the traced list of sites one at a time.
- **`employmentStatus` names TWO UNRELATED models. Same word, different contract.**

  ```
  hrStaff.employmentStatus              pending | active | terminated          (ADR-035 §5)
  workspaceMemberships.employmentStatus probation | confirmed | suspended |
                                        on_leave | transferred | resigned  |
                                        terminated | archived | active
  ```

  The second is `org-engine.js`'s `orgUpdateEmploymentStatus`, **live-exported** from
  `functions/index.js`, over `workspaceMemberships/{uid}_{businessId}`, with its own
  terminal states and its own `orgAuditLog`. Measured 2026-09-20: it touches `hrStaff`,
  `employmentEvents` and `employmentUidClaims` **zero** times, and the two production
  membership documents carry `employmentStatus: undefined` — the handler has never run.

  It is **deliberately unconverged** (ADR-017/ADR-020, and the workforce-authority ADRs).
  **Shared terminology does not establish semantic equivalence: do not unify these two on
  the strength of a field name**, and do not "fix" one by copying the other's vocabulary.
  A rename or a lifecycle change on either must name the owning collection explicitly —
  the same discipline as the `hrStaff` / `hrTraining` `status` collision above.

- **A patch-generation script must fail closed BEFORE its single write.** Assert every anchor
  matches exactly once, then `writeFileSync` once at the end — so a missed anchor leaves the
  target untouched instead of half-patched. Demonstrated repeatedly on 2026-09-20: the shell
  ate backslash escapes in a `node -e` heredoc three times (`\n` became a literal newline,
  `\d` became `d`, backticks were command-substituted), and each time the guard meant nothing
  was written. **When escaping makes the generated patch ambiguous, stop generating it and use
  the Edit tool directly** — that is faster than debugging the quoting and cannot corrupt the
  target. Applies equally to `firestore.rules`, where a mangled backtick silently emptied
  three comment fragments while leaving the rule expressions intact.

## Evidence discipline
- Verify the actual execution path and check the live site before claiming something works.
- Never fabricate data to make a result look complete. "Fails convincingly" is its own bug.
