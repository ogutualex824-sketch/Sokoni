# AGENTS.md — conventions for AI agents working on SOKONI

Multiple AI agents (Claude Code, Cursor, Copilot) work this repo in **parallel git
worktrees**. These rules prevent failures that have actually happened in production.
(Claude Code also loads the same rules from `CLAUDE.md`.)

---

## ⚠️ EXPERIMENT IN PROGRESS — Artifact Registry forensics (since 2026-09-19)

`gcf-artifacts` lost every function image. Existing revisions still serve from Cloud Run's
internal copies, but **no service can create a new revision from its existing spec**. The
cause is not established. A controlled canary artifact is instrumenting it right now.

**While this notice stands, do NOT:**

* deploy any Cloud Function (`firebase deploy --only functions`, `gcloud functions deploy`)
* delete any Cloud Function — **function deletion is the leading suspect**
* run `gcloud run services update` — it fails, and it leaves behind a failed revision that
  **cannot be deleted** (a revision cannot be removed while it is `latestCreatedRevisionName`)
* push, delete or tidy anything in Artifact Registry
* delete `sokoni-ar-forensics-canary:20260919T060552Z` — it is the instrument, not litter

Any of these contaminates the experiment and makes the next artifact event unattributable.

Check state with `node scripts/infra/ar-forensics.js 1d` (read-only; self-classifying, and it
flags contamination). Background: `docs/GCP_COST_ARCHITECTURE_IMPLEMENTATION.md`, P0-2 onward.

**Remove this notice only when the artifact lifecycle is understood and the owner says so.**

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
