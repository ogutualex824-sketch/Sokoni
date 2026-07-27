# AGENTS.md — conventions for AI agents working on SOKONI

Multiple AI agents (Claude Code, Cursor, Copilot) work this repo in **parallel git
worktrees**. These rules prevent failures that have actually happened in production.
(Claude Code also loads the same rules from `CLAUDE.md`.)

## Deploying — read this first
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

## Evidence discipline
- Verify the actual execution path and check the live site before claiming something works.
- Never fabricate data to make a result look complete. "Fails convincingly" is its own bug.
