# Hosting deployment preflight — Seller Agreement re-acknowledgement surface (READ ONLY; deployment NOT authorized)

**Date:** 2026-09-29 · **Packet:** `docs/release-gates/hosting-preflight-reack.json` · **Scope:** a Hosting-only release carrying `agreement-acknowledge.html` + `sokoni-agreement-acknowledge.js` so that Kasindi can acknowledge the current agreement through the proven surface ([[KASINDI_REPAIR_PRECONDITIONS]]). Nothing was deployed; no Firestore record was read for Kasindi or written for anyone; the peer worktree holding the live line was not touched.

## 1 · Source / commit lineage — the decisive finding

| | Value |
|---|---|
| Live hosting (version.json, cache-busted) | commit **`ff9d762`**, branch `fix/track-hub-on-93c5783`, build 2026-09-29T19:00:35Z, cacheVersion `sokoni-20260929190033-v641`, dirtyWorkingTree false |
| Live Hosting release (API, read-only) | release `1790708874166000` at 19:07:54Z, version **`00cbd1b719fa3898`**, 862 files, FINALIZED, deployed by the owner's CLI |
| Capability line (`slice/c4-capability-consumer`, where the surface was built) | tip `b8cb9d8`; **NOT a descendant of `ff9d762`** (merge-base `3dcf572`). The rollback guard only aborts when HEAD is *behind* live; a diverged tree passes it and would **replace production with the c4 tree**. It is not a hosting release candidate. |
| **Hosting candidate** | new worktree **`C:/temp/sok-reack`**, branch **`slice/reack-surface-on-live`**, tip **`d108f6c`**, base **`ff9d762`** = live. Commits above live: `463936a` (cherry-pick of `fd21e9b`), `f4ed51a` (test assertion made lineage-honest), `d108f6c` (test-only harness libs). `git merge-base --is-ancestor ff9d762 d108f6c` → yes. |

## 2 · Exactly what Hosting would ship

`git diff --name-only ff9d762 d108f6c` = 8 paths. Against `firebase.json` hosting `ignore` (`scripts/**`, `docs/**`, `functions/**`, `**/*.md`, `firestore.rules*`), the shipped delta is **two files**:

| File | sha256 (candidate) | Byte-identical to capability line `fd21e9b` |
|---|---|---|
| `agreement-acknowledge.html` | `a474d0a6bfe687db…` | yes |
| `sokoni-agreement-acknowledge.js` | `352c3eab0071cd94…` | yes |

Not shipped: `CHANGELOG.md`, `docs/KASINDI_REPAIR_PRECONDITIONS.md`, four `scripts/**` files. Expected Hosting file count after release: 862 → **864** (plus regenerated `service-worker.js` / `version.json`, already counted). A Hosting deploy uploads the whole public tree; because the candidate is live + these two files, "whole tree" and "only the intended files" coincide — verified by diff, not assumed.

## 3 · Functions / rules isolation

- The preservation slice (`ab3a891`, `functions/application-lifecycle.js` + `firestore.rules`) is **not on the candidate line at all** (0 functions/rules paths in the diff). It cannot ship by accident.
- `firebase deploy --only hosting` runs the hosting predeploy chain only; the functions predeploy chain is not invoked; `functions/**` and `firestore.rules*` are in the hosting ignore list. The functions section of `firebase.json` is untouched by a hosting-only deploy.
- Served rules re-fetched read-only after the peer's P0 release: ruleset **`b87c94e4`** (20:43:02Z). The `applications` block is verbatim what `6c67a34d` served (`allow update: if isAdmin() || (isOwner() && claimsOwner() && noAdminFields())`). The surface's write is **permitted** in production (suite against the served text: own approved ✔, own pending ✔, stranger ✘, anonymous ✘).

## 4 · No data written, no decision triggered

- A Hosting deploy writes files to Hosting only. None of the ten hosting predeploy hooks loads `firebase-admin` (the scripts that do — canary-controller, gate, release-firestore-rules, rollback — are not hooks).
- The page writes nothing on load. It writes only when the **signed-in applicant** ticks and confirms, and only `agreementAccepted / agreementVersion / agreementAcceptedAt / agreementAcknowledgedSurface` to their own application (rules refuse others). No callable is invoked; no application status changes; the deployed `applicationLifecycle` trigger does not react to those fields (its guard is on `status` / `decidedBy`).
- Kasindi's record was not read or written by this preflight.

## 5 · Predeploy gates, run read-only on the candidate tree

| Hook | Result |
|---|---|
| `guard-no-rollback.js` | allow — `463936a` contains live `ff9d762` |
| `guard-deploy-cooldown.js` | allow — last deploy ≥ 120 s ago |
| `predeploy-syntax-gate.js` | pass — 1,788 JS files + 452 inline blocks parse (6 min 23 s) |
| `verify-commission-single-source.js` · `perf-guard.js` · `audit-base64-writes.js` · `gate-inventory.js` · `check-money-toast-safety.mjs` | all pass / exit 0 |
| `bump-sw-version.js` · `generate-version.js` | **deploy-time mutators, not run**: they rewrite `CACHE_VERSION` (v641 → v642) and `version.json` (commit = candidate tip). The tree must be committed and clean when the deploy runs so `dirtyWorkingTree` stays false. |

Suites on the candidate: unit **21 / 0**, Chromium **14 / 0** (harness libs carried over, test-only). CSP: the page's inline script (`'unsafe-inline'` allowed), the gstatic dynamic import (`script-src` allows `www.gstatic.com`) and `fetch('/seller-terms')` (`connect-src 'self'`) are all within the served policy. Live already serves every dependency: `/seller-terms` 200, `sokoni-merchant-application.js` 200 and exports the version `2026-09-07-lanes-mkt-ladder-pos-5pct`, `firebase.js`, `sokoni-legal.css`, `shared-header.js`, `sokoni-auth-state.js` 200. `/agreement-acknowledge` and the module are **404 today** — the post-deploy markers.

## 6 · Rollback target

Previous release **`1790702102972000`** (17:15:02Z), version **`a3552ac70cd81400`** (862 files, FINALIZED). Rollback = re-release that version (Hosting console, or the repo's `scripts/deploy/rollback.js`). Because the candidate is live + two additive files, rolling back removes only those two paths.

## 7 · Findings surfaced by the preflight (not blockers for the surface; recorded)

1. **Live intake never acknowledges for providers.** `hub-register.js` on the live line has **no** agreement handling (0 occurrences); only `sokoni-merchant-application.js` writes the fields. Every provider who registered through the live hub form is in Kasindi's "never acknowledged" state; this surface is currently the only acknowledgement path for them.
2. **Production applications rules lack the decision protections** the c4 line has: against the served text the applicant can write `decidedBy`, `status`, `agreementVerifiedAt/Version`, `priorDecisions`, and change frozen classification fields (9 of 15 assertions fail). Known rules-lineage divergence ([[project_rules_repo_served_divergence]]); a `hotfix/k13c-applications-rules` line exists. **Consequence for Kasindi's read gate G2:** prove the acknowledgement by **field diff** against the census snapshot — exactly the four fields changed, `decidedBy` still `"reindex"`, nothing else — not by the boolean alone.
3. The deployed `applicationDecide` still has no agreement gate; unchanged from the census; the manifest's vehicle remains the c4 handler run locally.

## 8 · The deploy, when authorized (not now)

From `C:/temp/sok-reack` at `d108f6c` with a clean tree, after re-reading `version.json` to confirm live is still `ff9d762` (if live has moved to a non-ancestor, re-port; if to a descendant, rebase the candidate), one deploy at a time:

```
firebase deploy --only hosting --project sokoni-aeb26 -m "reack surface d108f6c"
```

Post-deploy verification (cache-busted): `version.json` commit = `d108f6c`, cacheVersion `-v642`; `/agreement-acknowledge` 200 containing `data-ack-state="boot"`; `/sokoni-agreement-acknowledge.js` 200 containing `SokoniAgreementAck`; Hosting releases +1, file count 864; `/seller-terms` still 200; a spot check of an unrelated page unchanged. Then Kasindi acknowledges → read gate G2 (field diff) → named-admin decision manifest.

Related: [[KASINDI_REPAIR_CENSUS]] · [[KASINDI_REPAIR_PRECONDITIONS]] · [[DEPLOYMENT]]
