# ADR-014 — A healthcare provider is a provider; `healthProviders` is not an identity

**Date:** 2026-09-12 · **Status:** Accepted · decision only, implementation NOT authorized
**Evidence:** production COUNT-only census 2026-09-12 (`sokoni-aeb26`); served ruleset `77465364`

Related: [[ADR-001]] · [[ADR-006]] · [[ADR-008]] · [[ADR-009]] · [[ADR-013]] · [[ADR-015]] · [[Healthcare]] · [[Authentication]]

---

## Context

The Healthcare Hub accumulated **four** representations of one healthcare provider, none of which is
the platform's canonical provider identity:

| # | representation | written by | state |
|---|---|---|---|
| 1 | `healthProviders/{uid}` | `registerHealthProvider` — **no client invoker** | unreachable |
| 2 | `healthProviders/{HCP-…}` | `sokoni-health.js::saveProvider` | create **denied** (sends `verified`, which `noAdminFields()` protects) |
| 3 | `providers/{auto}` `category:'Healthcare Facility'` | `healthcare.html::submitProviderReg` | create **denied**, rejection swallowed, success banner shown anyway |
| 4 | `localStorage.sokoniMyPharmacy` | the same handler | **gates the provider dashboard** |

None of these is an authority. At the claim layer there is nothing to distinguish them: `ROLE_KEY`
maps `health → 'provider'` and `claimsFor()` sets only `claims.provider`. A grep for
`token.doctor|nurse|hospital|clinic|facility|healthcare` returns **zero matches**. A nurse, a
cardiologist and a 400-bed hospital receive the identical single claim.

Three defects follow from the split rather than from any one branch:

**HC-01 — the registry is self-mintable.** The served ruleset carries **two**
`match /healthProviders/{providerId}` blocks (`firestore.rules.build:3525` and `:4164`, both at
brace-depth 2 under the same parent, verified by parse). Firestore unions them, so the first block's
`allow write: if false` is void. The second permits owner create/update, and `noAdminFields()`
protects only `verified` — not `status`, `licenseNumber`, `specialization`, `rating` or
`ratingCount`. Any signed-in user can therefore write themselves an `active` provider with a forged
licence, and can reverse an administrator's rejection.

**HC-03 — provider status is the only gate on clinical writes.** `createHealthRecord` and
`createPrescription` authorize on `healthProviders/{uid}.status === 'active'` and nothing else — no
appointment, no consent, no relationship. `patientUid` is taken verbatim from the request.

**HC-23 — approval provisions nothing.** `application-lifecycle.js:613` declares
`DELEGATED_ROLES = { health: 'healthProviders', legal: 'legalProviders' }`. The matching branch at
`:800` pushes a receipt object and **performs no write**, and because it matches it also skips
`projectProvider()`. An approved healthcare applicant receives `claims.provider` and lands in **no
registry at all**. `healthcare-hub.js` is the only module that ever writes `healthProviders`, and it
is unreachable. `legal` carries the identical defect.

### What the production census established

Per [[ADR-008]] — measure before changing:

- `healthProviders` total **1**: `seed-provider-general-001`, `active`, `reviewedBy` set, created
  2026-07-24. Its `uid` equals its own doc id and matches **no `providers/{uid}` and no
  `users/{uid}`** — a synthetic fixture from `scripts/seed-health-provider.js`, not an account.
- Self-mint signature (`active` ∧ `reviewedBy == null`): **0**. HC-01 is **latent, never exploited**.
- `healthAppointments`, `healthRecords`, `healthPrescriptions`, `healthSlotLocks`,
  `healthApptIdempotency`: **0 each.** The HC-03 path has never been exercised.
- `healthLabBookings`, `healthMedOrders`, `healthTelemedicine`, `healthHomeServices`,
  `healthEmergency`, `healthReviews`, `healthProviderAvailability`: **0 each.**
- `applications` with `role:'health'`: **0.** No healthcare applicant has ever existed, so **HC-23
  has never fired** and nobody is stranded behind the broken intake.

**Therefore: no migration is required.** As with [[ADR-006]], the measurement is what makes the
decision cheap — zero documents, zero migration cost.

## Decision

**A healthcare practitioner or facility is a `providers/{uid}` record. `healthProviders` is retired
as an identity and as an authority.**

1. **Identity.** Remove `health` from `DELEGATED_ROLES` so an approved healthcare application runs
   `projectProvider()` like every other provider. Fix `legal` in the same change — it is the same two
   lines and the same defect.
2. **Approval authority.** `applicationDecide`, gated by `_requireAdmin` (boolean
   `token.admin` / `token.superAdmin`). `approveHealthProvider` is retired.
3. **Admin model.** The healthcare-specific numeric `role >= 4` gate is **retired, not reconciled.**
   It is the only place on the platform that uses it, no writer was found that mints a numeric
   `role` claim, and every Firestore rule and `_requireAdmin` already use the boolean claim. Per
   [[ADR-001]], authorization comes from claims — and from *one* claim vocabulary.
4. **Facilities.** A hospital or clinic is a `businesses` record with `orgDepartments`. Not a new
   entity.
5. **Staff.** A nurse or pharmacist is a `workspaceMemberships` row carrying the built-in `orgRoles`
   (`org-engine.js:1002-1003` already ships `nurse` and `pharmacist`). Not a new membership model.
6. **Profession is an attribute, never an authority.** "Doctor", "Nurse", "Clinical Officer" describe
   a practitioner; what they may *do* derives from membership plus verification.

### What this forbids

- **No second healthcare role vocabulary.** No `doctor`, `nurse`, `hospital` or `facility` claim.
- **No healthcare-specific approval path.** One decision function for every vertical.
- **No writing `healthProviders` as an identity**, and no rule block that ratifies it as one —
  including for `healthProviderAvailability`, which is dead precisely because it has no rule.
- **No repair of the delegation by giving it a writer.** That ratifies the second model.

## Consequences

- Healthcare inherits the admin queue, `orgAuditLog`, role-claim reconciliation and registry
  provisioning that already work for sellers and drivers. HC-16, HC-17 and HC-23 close as one change.
- `healthProviders` becomes either a retired collection or a **clinical-attribute extension keyed to
  `providers/{uid}`** — never an identity, never an authority. Which of the two is deferred to
  implementation.
- HC-01's remediation is a pure rules change with **zero data risk**, because there is no live
  provider to break. It is still required before intake opens: latent is not safe, only unexercised.
- The seed fixture must be removed before the directory is wired to canonical data; it is publicly
  readable (`status == 'active'`) and invisible today only because the hub reads no Firestore at all.

## Alternatives rejected

| alternative | why not |
|---|---|
| give the `DELEGATED_ROLES` branch a real writer | ratifies the second identity model, and rebuilds approval, audit and claim reconciliation inside `healthcare-hub.js` |
| keep both registries, synchronised | two writers, one truth — the failure this programme exists to prevent ([[ADR-009]]) |
| add `doctor` / `nurse` claims | authority by job title; a title is not a permission, and it cannot express "may act at this facility" |
| reconcile `role >= 4` with the boolean claim | preserves two admin vocabularies so a future reader must know both; one of them has no writer |
| fix HC-01 by widening `noAdminFields()` | recorded regression: a general `noAdminFields` change reopens the application self-approval vector |

## Addendum 2026-09-28 — the category-aware workspace (CHANGELOG 233)

A Healthcare provider's dashboard is decided on the server by `functions/healthcare-workspace.js` from two facts:

- the **category**: `providers/{uid}.healthcare`, set at approval or by an admin (CHANGELOG 227). This is who the
  practice is.
- the **live plan**: `capability-authority`. This is what the practice has paid for.

The category matrix is deliberately **not** a set of capability keys, because a category is identity and is not
purchasable.

| operation | clinician | facility | pharmacy | laboratory | telemedicine | home care | unclassified | server check |
|---|---|---|---|---|---|---|---|---|
| appointments | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | booking-service |
| **patients** (roster) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | own `providerBookings` only |
| POS/Till · products · inventory | — | ✓ | ✓ | ✓ | — | — | — | `providerRequestShop` (plus the plan, for the request only) |
| delivery | — | — | ✓ | — | — | — | — | wired later in the slice |
| staff | — | ✓ | ✓ | ✓ | — | ✓ | — | wired later in the slice |
| clinical records | ✓ | ✓ | — | ✓ | ✓ | ✓ | — | `_clinicalBasis` (paid clinical booking) |
| prescriptions | ✓ | ✓ | — | — | ✓ | — | — | `_clinicalBasis` (paid clinical booking) |
| Quick Charge · calls | blocked | blocked | blocked | blocked | blocked | blocked | blocked | not offered |

Rules that apply to every row:

- The roster is labelled **"Patients"** in every category (owner decision 2026-09-28).
- An existing Shop survives a lapsed plan. Its existence is read from `shops/{uid}` with `ownerId == uid`.
- Hiding a section is presentation. Each operation names its server check, and a section is listed only once its screen
  exists.

Related: [[ADR-015]] (payments), [[Healthcare]], [[SmartPOS]].
