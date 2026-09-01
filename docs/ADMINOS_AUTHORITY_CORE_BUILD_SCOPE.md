# AdminOS Authority Core — Minimum-Safe Build Scope (design; for independent review)

- **Status:** BUILD-SCOPE ARTIFACT for independent review. **NOT authorization to implement.** No code, merge, or deploy. Deployed defects stay characterized, not repaired.
- **Date:** 2026-09-01
- **Base:** canonical `origin/main` `340590d`. Builds on Gate-1 evidence (`03e23f7`, `docs/ADMINOS_AUTHORITY_CORE_GATE1.md`).
- **Gate state:** C1 CLOSED (elected A). C2 CLOSED (served ruleset verified). C3 mandatory (carried below). Next: independent build-scope review → GO/NO-GO → *then* a separate implementation authorization.

## Closed inputs
- **C1 (canonical claim-writer election): `setUserRole`** (extend). Rationale: it already has correct role semantics (superAdmin⇒admin, clears stale) and is deployed (`setuserrole-00009-sel`); its only defect is the destructive claim overwrite — a **narrower, safer** change than turning the additive `grantPlatformRole` into a normalizing writer (blast radius 4 vs 2 callers does not outweigh the smaller semantic change).
- **C2 (served-ruleset): verified** — served ruleset `projects/sokoni-aeb26/rulesets/59af870d-72eb-4791-a3b6-2f4de7eb8ff7` (updated 2026-08-28). `adminLog` superAdmin-deletable; `securityAuditLog`/`adminAudit` immutable; `auditLogs` client-creatable-for-self — all confirmed in production. Repo `firestore.rules` ≠ served (repo is a proposal artifact).

## Canonical-writer specification (the ONLY behavioral change in this build)
Extend `setUserRole` (super-admin.js) so a single administrative claim mutation:
1. **Reads current claims** (`getAuth().getUser(uid).customClaims`) — no blind object replacement.
2. **Preserves all non-role claims** (`merchantId`, `posId`, `betaStatus`, `suspended`, `platform*`, etc.) — merge, don't overwrite.
3. **Establishes the role invariant** — `admin === (role==='admin' || role==='superAdmin')`, `superAdmin === (role==='superAdmin')`.
4. **Clears stale GOVERNED role flags only** — the finite set {admin, superAdmin, seller, driver, moderator, buyer} set false when not the elected role; **never** touches non-role keys.
5. **Stamps `permsVersion`** (net-new; monotonic).
6. **Emits a `controlEvents` entry** for the mutation (dual-write, below).
Keep the existing `_requireSuperAdmin` guard, rate-limit, and target-user-exists check. Continue mirroring `role` to `users`. **Guard unchanged; only the claim-shape logic changes** (destructive→merge).

## Minimum-safe build (additive, non-destructive)
1. **Canonical writer** — the `setUserRole` correction above. Deployable **named-only** (`functions:setUserRole`) — it is already a standalone deployed function (unlike `adminUpdateUserRole`, which is dispatch-only).
2. **`adminPermissions/{uid}`** — introduce the net-new structure + server-side read in a **pilot** set of callables. **C3 (mandatory): `adminPermissions` is SUBORDINATE — it grants NO admin/superAdmin authority by itself; boolean custom claims remain THE authority for the entire pilot.** A callable may consult `adminPermissions` for granular *capability* gating only *after* the coarse claim check passes. No callable treats `adminPermissions` as the source of admin identity.
3. **`controlEvents`** — net-new single append-only writer CF; **DUAL-WRITE** alongside the canonical mutation (Q3 dual-write, NOT a hard cut). No legacy audit collection is removed or rewired in this build.

## Explicitly OUT of this build (each separately gated)
- Q2 capability migration (converting the ~50 coarse `_requireAdmin` callables to granular caps) — pilot only, not the estate.
- Q3 audit hard-cut / consuming/removing the 7 legacy audit streams.
- **Removal/rewiring of ANY other claim writer** — `grantPlatformRole`, `adminUpdateUserRole`, `grantAdminClaim`, `bootstrapAdminClaim`, `acceptPlatformInvite`, etc. stay as-is. **`adminUpdateUserRole`'s superAdmin-without-admin defect remains characterized, NOT repaired** (its retirement/redirect is a later convergence gate). This build adds the correct canonical writer; it does not make any existing path worse.
- Client-side authority convergence (inline gates / no-shared-guard) — untouched.
- Finance/F2–F9, `SokoniPermissions` (business-role), F3/F7, `wallet.js`, 5% commission — untouched.
- The **`finos-automation.js:521 → adminAuditLog`** finance contact point — not touched (no audit consolidation here).
- `adminLog` erasability (served-confirmed) — its own standalone rules fix (`3c11065`), not this build.

## Falsifiable success condition
After the build, provable by test:
- **Preservation:** a role change on a user with `merchantId`/`posId` leaves those claims intact.
- **Role invariant:** electing `superAdmin` yields `admin:true` AND `superAdmin:true`.
- **Stale clear:** a prior `seller:true` is cleared when the user is set to `admin`.
- **Versioning:** `permsVersion` is stamped/incremented.
- **Single-writer (tested path):** the tested authority path performs 0 other `setCustomUserClaims`.
- **Audit:** a `controlEvents` entry is emitted for the mutation.
- **C3 (no second authority):** with `adminPermissions` populated but the boolean claim absent, the coarse admin check still **denies** — i.e. `adminPermissions` alone never authorizes admin.
- **Non-regression:** `_requireSuperAdmin`/rate-limit/target-exists behavior unchanged; guard still denies non-superAdmin callers.

## Independent build-scope review checklist
- (a) Confirm the canonical-writer spec eliminates the overwrite **without** touching non-role claims and **without** changing the guard.
- (b) Confirm the change is confined to `setUserRole` (+ the net-new `adminPermissions`/`controlEvents` additive code) — no other writer edited.
- (c) Confirm C3 is enforceable: `adminPermissions` cannot authorize admin on its own (the deny-test above).
- (d) Confirm `controlEvents` dual-write introduces **no** finance/audit coupling (does not write/consume `adminAuditLog` or any finance rail).
- (e) Confirm nothing in scope requires client-authority changes, writer removals, or the finance/business-role/F3/F7/wallet/commission surfaces.
- (f) Confirm deploy story is **named-only `setUserRole`** (+ the net-new functions), never a full deploy (lineage-regression hazard).
- (g) Confirm the success condition is falsifiable (a failing implementation would fail a listed test), not merely "the new fields can be written."

## Gate
This build scope → **independent build-scope review (GO/NO-GO)** → *then* a **separate implementation authorization**. This election + scope authorize nothing to be coded, merged, or deployed.
