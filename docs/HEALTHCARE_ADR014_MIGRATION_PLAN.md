# Healthcare ADR-014 — Migration Plan (deploy gate)

**Status:** PLAN — nothing migrated, nothing deployed. **Owner decision (2026-10-04, direct):** ship ADR-014 — an AdminOS approval projects the clinic into `providers/{uid}` through the application lifecycle; `approveHealthProvider` stays retired, so there is ONE activation path. **Owner condition:** existing `healthProviders` records need this plan before deploy.

Related: [[Healthcare]] · [[Authentication]] · [[Applications]] · `docs/RELEASE_ROADMAP.md`

## 1. What changes

| | Before (live lineage) | After ADR-014 (branch `5b/r2-lifecycle`) |
|---|---|---|
| Approval of a `health` application | lifecycle grants the role and **delegates** (writes nothing) | lifecycle projects `providers/{uid}` with `providers.healthcare {category, source}` |
| Activation of the clinic | `approveHealthProvider` (gated on a numeric role nothing mints) | the approval itself — `approveHealthProvider` returns `HEALTH_APPROVAL_MOVED` |
| Category | none at approval | `healthcare-category` decides; unmapped → `null` (UNCLASSIFIED), AdminOS `healthAdminClassify` fixes it |
| Writes to `healthProviders` | intake (`registerHealthProvider`) + counters | **zero from the lifecycle** |

## 2. Census (read-only) — run BEFORE any deploy

`node scripts/infra/health-adr014-census.js --project sokoni-aeb26` — read-only (no `--apply` exists), positive control printed, needs owner approval to read production.

| Class | Meaning | Disposition |
|---|---|---|
| `ALREADY_CANONICAL` | `providers/{uid}` already carries a healthcare stamp | nothing to do |
| `ACTIVE_DECIDED` | active + an approved `applicationDecisions` record | `applicationReconcile` per application (the K13-A path, attributed to the real decider) — the dry-run lists them |
| `ACTIVE_UNDECIDED` | active, no decision record | **not migrated automatically**; an admin re-decides in AdminOS (record-only authority, no legacy fallback) |
| `PENDING` | intake only | unchanged; registration is not approval — the clinic applies through the application flow |
| `OTHER_STATUS` | suspended / rejected / other | carried as-is; never activated |
| `NO_UID` | no account named | manual review |

### 2a. Census RESULT — production, 2026-10-04 (owner-approved one-time read; nothing written)

Command (from the `5b/r2-lifecycle` tree): `node scripts/infra/health-adr014-census.js --project sokoni-aeb26 --json`
Evidence: `docs/evidence/health-adr014-census-2026-10-04.json` (state classes and role/type/hub labels only — no personal data).

| Read | Result |
|---|---|
| `healthProviders` documents | **0** |
| `applications` with `role == 'health'` | **0** |
| applications whose role / type / hub look like healthcare (health, clinic, hospital, pharm, medic, doctor) | **none** |
| **Positive control** (same credentials): `providers` count / `applications` count | **11 / 13** — the reads work; the zeros are real |
| Reconcile dry-run proposals | **0** |

Application population by role|type|hub (labels only): provider|business|fashion 1 · provider|business|b2b 2 · driver|driver|delivery 3 · provider|voiceover|entertainment 1 · seller|business|- 1 · provider|Cleaning Company / Housekeeper|service 1 · provider|provider|service 2 · provider|business|home-services 2.

**Consequence:** there is NO production healthcare data to migrate — the ADR-014 risk is entirely in CODE: every reader of `healthProviders` (section 3) must be repointed to the canonical `providers/{uid}` before the lifecycle deploys, or the first approved clinic is invisible and cannot prescribe. Note: the census script's first draft treated "both reads ran" as its control; that was too weak (an empty-and-empty result proves nothing about the credentials) and was replaced by the populated-collection counts above before this result was accepted.

## 3. Live readers of `healthProviders` — repointed or kept

| Reader | Today | Plan |
|---|---|---|
| `healthcare-hub` `getHealthProviders`, `getHealthProvider`, `searchHealthProviders` | `healthProviders where status == active` | **REPOINT** to `providers where healthcare.source in [application, admin] and status == active`, same `_publicHealthProvider` whitelist. Needs a composite index — census the index first. |
| `healthcare-hub` consultation gate (`createPrescription` / records, ~L299) | requires `healthProviders/{uid}.status == active` | **REPOINT** to `providers/{uid}` (active + healthcare stamp) — otherwise a newly approved clinic cannot prescribe |
| `healthcare-hub` `updateAppointmentStatus` / `rateHealthProvider` counters | `t.update(healthProviders/{id})` | **REPOINT** to `providers/{uid}` (rating / counters) — `update()` on a missing `healthProviders` doc would throw for every new clinic |
| `registerHealthProvider` | writes `healthProviders` pending | **KEEP** as intake for now; retire in the healthcare release that owns the intake form |
| `sokoni-health.js` (browser) | reads/writes `healthProviders` directly | **KEEP read-only fallback** until the page moves to the callables; its writes are already refused by the HC-01 rules — verify on the served ruleset |
| `algolia-sync` / `algolia-indexer` (`healthProviders → sokoni_services`) | indexed | **KEEP** until the repointed directory is live; `providers` is already indexed. De-register `healthProviders` in the same release as the reader repoint, never before |
| `discovery-eligibility` / `discovery-cleanup` / `rider-eligibility` | name `healthProviders` in DEINDEXED / comments | no change |
| `firestore.rules` `healthProviders` block | HC-01 | no change in this release |

**Order (deploy gate):** census → owner reviews counts → repoint the healthcare-hub readers (new slice, tested) → deploy lifecycle + healthcare-hub together → reconcile `ACTIVE_DECIDED` one at a time with live verification → admin re-decides `ACTIVE_UNDECIDED` → only then de-register the `healthProviders` index triggers.

## 4. Dry-run

The census prints the exact `applicationReconcile` calls it would propose (`dryRun[]` in `--json`). Nothing runs from it; each reconcile is a separate, owner-authorised production write.

## 5. Risks

* **Deploying the lifecycle before the reader repoint** makes every newly approved clinic invisible in the healthcare directory and unable to prescribe — the repoint is a hard prerequisite, not a follow-up.
* `ACTIVE_UNDECIDED` clinics lose nothing on deploy (their `healthProviders` doc is untouched), but they are not in the canonical registry until re-decided.
* Unknown counts render `—`; an unreadable census is never "nothing to migrate".
