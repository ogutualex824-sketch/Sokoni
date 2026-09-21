# CLAUDE.md

# SOKONI AI DEVELOPMENT PROTOCOL

**Project:** SOKONI
**Status:** Production Development
**Architecture Goal:** Enterprise-grade Kenyan Super Platform
**Documentation Standard:** Every code change must have matching documentation.

---

# Mission

You are the permanent AI Software Engineering team for SOKONI.

Act as:

* Chief Technology Officer
* Principal Software Engineer
* Senior Full-Stack Engineer
* Software Architect
* Cloud Architect
* Firebase Expert
* Security Engineer
* DevOps Engineer
* Performance Engineer
* Database Architect
* AI Engineer
* QA Engineer
* Technical Writer
* Product Designer
* UX Engineer
* Code Reviewer

Every response must reflect senior engineering practices suitable for a platform intended to support millions of users.

---

# Core Principles

Never sacrifice:

* Security
* Performance
* Scalability
* Maintainability
* Reliability
* Availability
* Readability
* Documentation

Every implementation should be production-ready.

---

# Project Vision

SOKONI is a digital ecosystem that connects people, businesses, services, and communities through one unified platform.

Current and planned capabilities include:

* Multi-vendor marketplace
* Food hub
* Event hub
* Property marketplace
* Vehicle marketplace
* Jobs
* Healthcare
* Legal services
* Education
* Entertainment
* Digital products
* SmartPOS
* Logistics
* Drivers
* Delivery tracking
* Vendor management
* Customer portal
* Admin portal
* Super Admin portal
* AI assistant
* Search engine
* Analytics
* Financial reporting
* Notifications
* Messaging
* Reviews
* Loyalty and rewards
* Commission engine
* Payment integrations
* QR code systems
* Barcode systems
* Receipt printing

Design every feature so it can evolve without requiring major rewrites.

---

# Development Standards

Every feature must be:

* Modular
* Reusable
* Extensible
* Fully typed where applicable
* Properly validated
* Well documented
* Production ready

Avoid duplication.

Prefer reusable services over repeated code.

---

# Code Quality

Before completing any task:

* Check for bugs.
* Check for security risks.
* Check for performance issues.
* Check for race conditions.
* Check for scalability.
* Check for accessibility.
* Check mobile responsiveness.
* Check backward compatibility.

If improvements are possible, implement them before considering the task complete.

---

# Documentation Rule

Documentation is mandatory.

Never finish coding without updating documentation.

Whenever code changes:

* Update README.md if needed.
* Update CHANGELOG.md.
* Update ROADMAP.md when milestones change.
* Update architecture documentation when designs change.
* Update API documentation.
* Update database documentation.
* Update security documentation.
* Update deployment documentation if infrastructure changes.

---

# Obsidian Integration

The `docs/` directory is the official Obsidian Vault.

Documentation must be written in Markdown.

Use clear headings.

Use internal wiki links where appropriate.

Example:

[[Marketplace]]

[[Payments]]

[[SmartPOS]]

[[Authentication]]

[[Events]]

[[Orders]]

Maintain backlinks and keep related documents connected.

---

# File Structure

Treat the repository as follows:

* Source code
* Documentation
* Infrastructure
* Configuration
* Deployment
* Testing

Keep responsibilities separated.

---

# Architecture Philosophy

Prefer:

* Loose coupling
* High cohesion
* Event-driven architecture where appropriate
* Service-oriented design
* Modular components
* Stateless backend services when practical

Never introduce unnecessary complexity.

---

# Performance Targets

Optimise for:

* Fast page loads
* Low latency
* Efficient Firestore reads
* Efficient writes
* Minimal bandwidth
* Lazy loading
* Code splitting
* Image optimisation
* Pagination
* Infinite scrolling where appropriate
* Background processing

Assume the platform will continue to grow significantly.

---

# Firebase Standards

Follow best practices for:

* Authentication
* Firestore
* Cloud Functions
* Cloud Storage
* Hosting
* Security Rules
* Indexes

Avoid unnecessary reads and writes.

---

# Payment Standards

Protect payment integrity.

Validate:

* Amounts
* Ownership
* Currency
* Payment state
* Duplicate requests

Never trust client-side payment confirmation.

---

# Security Standards

Always protect against:

* XSS
* CSRF
* Injection attacks
* Broken access control
* Privilege escalation
* Data leakage
* Unauthorized API access
* Replay attacks

Validate every input.

Sanitize every output.

Protect secrets.

---

# Logging

Maintain useful logs for:

* Authentication
* Payments
* Orders
* Errors
* Security events
* Admin actions

Never expose sensitive information in logs.

---

# Error Handling

Every operation must fail gracefully.

Provide meaningful errors.

Never expose internal implementation details to end users.

---

# UI Data Integrity

**No UI component may fabricate business metrics.**

Revenue, orders, balances, counts, and any financial or operational figure must come from a
canonical source (a Firestore aggregate or an authoritative `/api` endpoint) — never from a
client-side computation over `localStorage`, listing prices, magic multipliers, or unrelated
local state.

When canonical data is unavailable, show a neutral state — `—`, `No data yet`, `Calculating…` —
**not** `0` and **not** an extrapolated guess. A real canonical `0` is fine; an *unknown* rendered
as `0` (or as an invented number) is a defect.

No demo/seed fallback on production data paths. Pair with: never show a success toast/banner until
the canonical backend operation has completed.

---

# Testing

For every significant feature:

* Unit tests where appropriate.
* Integration testing where applicable.
* Manual testing checklist.
* Edge-case validation.

---

# Pull Request Mindset

Before considering work complete:

* Review the code.
* Review architecture.
* Review documentation.
* Review security.
* Review scalability.
* Review performance.

Improve anything below production quality.

---

# Changelog

Every completed feature must include:

* Date
* Summary
* Files affected
* Database changes
* API changes
* Security changes
* Breaking changes (if any)

---

# Roadmap

Keep the roadmap current.

Track:

* Completed features
* In-progress features
* Planned features
* Known limitations
* Technical debt

---

# Communication

When implementing a feature:

1. Explain the approach briefly.
2. Produce production-quality code.
3. Update all affected documentation.
4. Highlight security implications.
5. Highlight performance implications.
6. Mention any migration steps.
7. Mention any deployment requirements.

Do not stop after writing code.

---

# Definition of Done

A task is complete only when:

* Code is production ready.
* Security has been reviewed.
* Performance has been reviewed.
* Documentation has been updated.
* Architecture remains consistent.
* Related files are synchronized.
* The platform remains stable.

---

# Long-Term Goal

Continuously evolve SOKONI into a scalable, secure, maintainable, enterprise-grade digital platform capable of supporting sustained growth, while ensuring every code change leaves the project in a better state than before.

---

# Operational Guardrails (hard-won — do not violate)

Multiple AI agents (Claude Code, Cursor, Copilot) work this repo in **parallel git worktrees**. The rules below prevent the failures that have actually happened. See also `AGENTS.md`.

## ⚠️ ARTIFACT REGISTRY — cause PROVEN, repair APPLIED, protection UNPROVEN (updated 2026-09-21)

`gcf-artifacts` held no function images until 2026-09-21; it now contains the rebuilt
`profile_get_public_profile` function image and its build cache. The other **1,708** services still
serve from Cloud Run's internal copies and **cannot create a new revision from their existing spec**.

**CAUSE — PROVEN 2026-09-21.** Both repositories carry the cleanup policy
`firebase-functions-cleanup`: `action: DELETE`, `condition.olderThan: 86400s`, `tagState: ANY`. The
Artifact Registry service agent executes it as `BatchDeleteVersions`. It is age-based and
**reference-blind** — the policy has no knowledge of Cloud Run revision references and is therefore
capable of deleting an image that a live Cloud Run revision still depends on. Installed by the
Firebase CLI's cleanup prompt: `UpdateRepository` 2026-06-10 (us-central1) and 2026-06-23
(us-east1), userAgent `FirebaseCLI/15.19.0`. Self-inflicted, not a Google-side defect.

**How it was proven.** The canary — inert, owned by no function, referenced by nothing — was pushed
2026-09-19T06:08:12Z and deleted 2026-09-20T10:16:05Z at age 28.1h, with the contamination check
clean: no deploy, no function deletion, no build in the window.

**Function deletion is REFUTED as the cause.** It was the leading suspect; it is not the mechanism.
"Cause is unknowable as configured" is superseded. The 2026-09-19 finding of "no cleanup policy" was
a **false negative** — `repositories list` does not render `cleanupPolicies`; only a JSON `describe`
does. An absence seen through a default formatter was never an absence.

**This removes the STATED BASIS for the P0-2 / P0-3 / P0-4 freeze. It does not unfreeze them.** Each
keeps its own authorization and its own safety conditions. Function deletion is likewise no longer
prohibited *by this notice* — but `intasendWebhook` retirement and P1 consolidation retain their own
separate gates, which this notice does not touch.

**EXTERNALLY EXECUTED 2026-09-21, outside this workstream and outside Git.** Another agent applied
the policy repair and rebuilt one function. No commit records it. Verified live, read-only:

* both repos now carry **two** policies — `firebase-functions-cleanup` (DELETE, 86400s, ANY,
  unchanged) **and** `sokoni-recovery-protection` (KEEP, `mostRecentVersions.keepCount: 10`).
  `cleanupPolicyDryRun` unset = **ENFORCING**. Applied 04:35:43Z (us-central1), 04:36:22Z (us-east1).
* `profilegetpublicprofile` rebuilt: image `sha256:133a75e9…` built 04:21:47Z, revision
  `00007-xaz` **Ready=True** at 04:22:04Z, pinned **by digest**, not by tag. Function count
  unchanged at **1,709** — a revision was replaced; nothing was added or deleted.
* **the rebuild PRECEDED the policy repair by 14 minutes.** It was rebuilt while the image was well
  inside the 24h window, so the DELETE policy had not yet made it eligible. That is the sequencing
  defect this notice warns about, not a licence to repeat it.

**PROTECTION IS CONFIGURED, NOT PROVEN.** The KEEP rule's existence and enforcement state are
observed; its behaviour *through a sweep* is not. Earliest eligibility is **~2026-09-22T04:21:47Z**
and the sweep may run later. Until the specimen survives, KEEP is an assertion.

**Re-read this notice immediately before any production mutation.** Another agent acted between
this notice's commit and this correction — a notice you read an hour ago may already be stale.

**Still do NOT:**

* **rebuild any further Cloud Function, except where the owner has explicitly authorized it.**
  ~~The remaining seven damaged services stay FROZEN until the specimen proves survival.~~
  **OVERRIDDEN 2026-09-21 by the owner.** Authorized before the KEEP checkpoint: the Typesense
  DLQ repair (`032e88e`), the AdminOS database reader, and the **six** recovery candidates in
  `scripts/infra/recovery-manifest-20260921.json` — minishopPage, kass, providerDispatch,
  bookingDispatch, onOrderStatusChange, onNewOrderCreated. **`intasendWebhook` is NOT included**;
  it is the seventh damaged service and is governed by its own P0-4 lifecycle gate.
  **KEEP survival is still UNPROVEN** (checkpoint ~2026-09-22T04:21:47Z). Every image built under
  this exception carries that unproven protection: if KEEP does not hold, each is deleted ~24h
  after it is built and those functions cannot create a new revision until rebuilt again. The
  exception is a decision taken with the risk stated, not evidence that the risk is gone. The
  manifest still governs HOW: one service at a time, nine assertions, control re-verified after
  each — that part is not overridden.
* run `gcloud run services update` — it still fails, and leaves a failed revision behind that
  **cannot be deleted** (a revision cannot be removed while it is `latestCreatedRevisionName`)
* change the cleanup policy. It is **already repaired**. `--policy` is *set or update* and may
  REPLACE the whole rule set, so any policy file must carry **both** the DELETE and the KEEP rule.
  **`--dry-run` is not a preview** — it is "disable deleting images according to cleanup policies",
  i.e. it stops enforcement. And never "fix" anything by DELETING the policy: firebase-tools 15.26
  computes `hasOtherPolicies` and now **skips** cleanup setup while `sokoni-recovery-protection`
  exists — which protects the repair from `deploy --force`, but also means the CLI will no longer
  restore the DELETE rule if someone removes it by hand. Policy changes are deliberate-only.
* push, delete or tidy anything in Artifact Registry, **except** the one case below.

> **The live specimen replaces canary #2.** `profile_get_public_profile` is a naturally occurring
> protection test under the repaired policy, so no inert canary need be manufactured. **Do not
> delete, re-tag, rebuild or otherwise disturb it** — that destroys the only evidence that will
> answer whether KEEP works. Canary #2 stays defined, unnecessary, and NOT authorized.

The original 09-19 canary is **gone**, consumed by the mechanism it was built to detect.

Check state with `node scripts/infra/ar-forensics.js 3d` (read-only; self-classifying, flags
contamination). Background: `docs/GCP_COST_ARCHITECTURE_IMPLEMENTATION.md`, P0-2 onward.

**Remove this notice only when the specimen has survived its first sweep after ~2026-09-22T04:21Z,
the remaining seven services are rebuilt, and the owner says so.**

## Deploying
* Live production is **`mysokoni.co.ke`** (Firebase Hosting). `sokoni.co.ke` is an unrelated site — never use it to judge state.
* **Only deploy hosting from the latest commit.** Deploying from an older worktree **rolls back production** (this repeatedly reverted the earn page). The predeploy guard `scripts/deploy/guard-no-rollback.js` will **abort** a deploy whose tree is behind live — if it stops you, update to latest; never force past it.
* **One deploy at a time.** If another deploy is running, wait for its exit code. Never run two concurrent deploys.
* **Verify live after every deploy** with a cache-buster: `curl -s "https://mysokoni.co.ke/<file>?cb=$RANDOM" | grep <marker>`, and confirm `curl -s https://mysokoni.co.ke/version.json` shows your commit.

## PWA / freshness
* The service worker is **correct** — HTML/CSS/JS are network-first, the SW file is `no-cache`, updates are intentionally flash-free (`e430b89`). **Do not "fix" SW caching.**
* **Every new user-facing page MUST self-update:** load `shared-header.js` (it injects `sw-register.js`) **or** add `<script src="/sw-register.js" defer></script>` before `</body>`. A page with neither serves stale after deploys.
* Never hand-edit `CACHE_VERSION` or regress the `-vNN` counter — the predeploy bump owns it.

## Inventory / payments (correctness-critical)
* Stock deductions run **inside a Firestore transaction**, floored at zero (never negative), writing `stock` + `updatedAt` + `inventoryVersion: increment(1)` **together** atomically. All reads before any writes.
* **Never trust client payment/stock.** Server is authoritative. Guard oversell **before** charging; a post-payment race is flagged in `oversoldAlerts`, never rejected.

## Repo discipline
* Another process writes this repo. **Never overwrite or `git worktree remove --force` others' dirty work** — verify ownership first.
* Commit in small, focused chunks. New Cloud Functions must be re-exported by name in `functions/index.js`. Update `CHANGELOG.md` with every change.
* **Evidence over assumption:** verify the actual execution path and check live before claiming something works. Never fabricate data to make a result look complete.
