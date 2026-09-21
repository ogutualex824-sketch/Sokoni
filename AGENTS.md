# AGENTS.md — conventions for AI agents working on SOKONI

Multiple AI agents (Claude Code, Cursor, Copilot) work this repo in **parallel git
worktrees**. These rules prevent failures that have actually happened in production.
(Claude Code also loads the same rules from `CLAUDE.md`.)

---

## ⚠️ ARTIFACT REGISTRY — cause PROVEN, repair NOT APPLIED (updated 2026-09-21)

`gcf-artifacts` holds no function images. Existing revisions still serve from Cloud Run's
internal copies, but **no service can create a new revision from its existing spec**.

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

**Still do NOT:**

* **deploy or rebuild any Cloud Function.** The reason is no longer contamination, it is
  **sequencing**: while this policy stands, a fresh image is deleted ~24–29h after it is
  built, so rebuilding first merely re-enters the race. **Policy repair precedes
  reconstruction.**
* run `gcloud run services update` — it still fails, and leaves behind a failed revision
  that **cannot be deleted** (a revision cannot be removed while it is
  `latestCreatedRevisionName`)
* change the cleanup policy without authorization. The repair is designed — a KEEP rule,
  `keepCount: 10`, under an id **other than** `firebase-functions-cleanup` — but not
  applied. Note that merely DELETING the policy is re-asserted at 1 day by the next
  `firebase deploy --only functions --force`, silently and without a prompt.
* push, delete or tidy anything in Artifact Registry, **except** the one case below.

> **Canary #2 — narrow exception.** A single inert replacement canary
> `sokoni-ar-forensics-canary:<UTC timestamp>`, pushed via
> `scripts/infra/ar-canary-push.js`, solely to certify that a repaired policy lets an
> artifact outlive the 24h threshold. It is attached to no service. **This defines what MAY
> be authorized — it is not standing permission**, and it covers that one artifact only: no
> function images, no deletions, no tidying.

The original canary is **gone**, consumed by the mechanism it was built to detect. It no
longer needs protecting.

Check state with `node scripts/infra/ar-forensics.js 3d` (read-only; self-classifying, and
it flags contamination). Background: `docs/GCP_COST_ARCHITECTURE_IMPLEMENTATION.md`, P0-2
onward.

**Remove this notice only when the cleanup policy is repaired, certified by canary #2, and
the owner says so.**

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
