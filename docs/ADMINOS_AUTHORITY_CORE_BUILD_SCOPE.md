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

## Implementation contract (build-scope review conditions C1–C5)
These are binding contract terms; the implementation must not invent semantics for them.

- **C1 — Governed-role set is an EXPLICIT allowlist.** The writer normalizes **only** these six role keys: `{ admin, superAdmin, seller, driver, moderator, buyer }` — each set `true`/`false` per the elected role. **Every key NOT in this set is a NON-ROLE claim and is preserved byte-untouched via merge** (`merchantId`, `posId`, `betaStatus`, `betaAdmitted`, `suspended`, `platformEmployee`, `platformRole`, `provider`, `providerId`, and any future key). The writer **never deletes a key outside the governed set.** "Clear stale governed roles" = set the *unselected* governed keys to `false`; it is **not** license to delete arbitrary claims. Preservation is enforced by explicit tests (see success condition).
- **C2 — `permsVersion` semantics fixed before coding.** `permsVersion` is a **monotonic integer** naming the authority-claim SCHEMA version, defined by a single module constant `CURRENT_PERMS_VERSION` (initial value **1** for this schema). The canonical writer sets `permsVersion = max(existing, CURRENT_PERMS_VERSION)` on every mutation (idempotent, **never downgrades**) — **(C6, all four cases explicit):** absent → `CURRENT_PERMS_VERSION`; existing `< CURRENT` → `CURRENT_PERMS_VERSION`; existing `= CURRENT` → unchanged; **existing `> CURRENT` → preserve the existing higher value** (an older deployed writer must never downgrade a newer authority-schema marker). It is a schema marker (and a future token-invalidation signal), **not** a per-user counter incremented arbitrarily. No other value semantics are introduced during coding.
- **C3 — `controlEvents` failure behavior is FAIL-CLOSED on the audit record, not on the claim.** Because Firebase Auth custom claims and a Firestore `controlEvents` write cannot share one transaction, the order is: **(1) write the `controlEvents` intent record FIRST — its success is a PRECONDITION; if it fails, ABORT (no claim mutation).** **(2) mutate the claims.** **(3) best-effort finalize the event with the outcome.** ⇒ the state "**claims mutated but no `controlEvents` record exists**" is impossible; and a control-telemetry outage **blocks** the privileged mutation (fail-closed) rather than silently mutating authority unaudited. (If step 3's finalize fails, the intent record already proves the attempt; a reconciliation may set the outcome later.)
- **C7 — deterministic event identity / retry idempotency.** Because the intent is written before the (non-transactional) Auth mutation, the `controlEvents` doc id MUST be **deterministic** — derived from the mutation identity `{ targetUid, callerUid, elected role/claims, client-supplied requestId/idempotency key }` — so a retry writes the **same** doc (create-if-absent), never a second intent. Before mutating claims the writer checks whether that deterministic event is already **committed**; if so the operation is an **idempotent no-op** (no re-mutation). ⇒ a retry after `intent-written → claims-mutated → response-lost` **converges**: one event, a single effective mutation, no duplicate. (The claim write is itself idempotent — recomputing and setting the same claims is a no-op — but the deterministic-event guard additionally prevents a spurious second intent/outcome record and any re-processing.) Tests MUST cover the retry-after-successful-mutation-but-failed/unknown-finalize path.
- **C4 — Authorization boundary preserved EXACTLY.** The caller-authz surface (`_requireSuperAdmin` + rate-limit + target-user-exists) must be **byte/behavior-identical** pre/post. The implementation diff must show changes confined to the claim-shape/audit/version logic; a review diff + a deny-test (non-superAdmin still rejected identically) are required. The boundary must not be weakened, relaxed, or reordered.
- **C5 — "Single-writer" test is PATH-SCOPED.** The success criterion asserts the **tested canonical authority path performs 0 other `setCustomUserClaims`** — i.e. the elected path routes claim mutation through `setUserRole` alone. It does **NOT** assert that the ~8 historical writers have been removed; those remain deliberately in place and out of scope. The test proves the *new path's* single-writer discipline, not estate-wide convergence.

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

## Falsifiable success condition (maps to contract C1–C5)
After the build, provable by test:
- **[C1] Preservation:** a role change on a user carrying `merchantId`+`posId`+`betaStatus`+`suspended` leaves **every** non-role claim byte-intact; a **negative control** confirms the pre-fix (overwrite) body drops them.
- **[C1] Governed-set-only:** only the six governed keys `{admin,superAdmin,seller,driver,moderator,buyer}` change; no key outside that set is ever deleted (assert an injected non-governed key survives).
- **Role invariant:** electing `superAdmin` yields `admin:true` AND `superAdmin:true`.
- **Stale clear:** a prior `seller:true` is set `false` when the user is elected `admin` (cleared, not deleted).
- **[C2/C6] Versioning:** `permsVersion = max(existing, CURRENT_PERMS_VERSION)` — absent → CURRENT; lower → CURRENT; equal → unchanged; **existing higher (e.g. 2 vs CURRENT 1) → preserved, never downgraded**.
- **[C3] Audit fail-closed:** on success a `controlEvents` intent+outcome exists; and when the **intent write is forced to fail, the claim mutation does NOT occur** (claims-mutated-without-event is unreachable).
- **[C7] Retry idempotency:** a retry after a successful claim mutation but failed/unknown finalize yields **no duplicate `controlEvents`** and **no double mutation** — the deterministic event converges to a single committed record.
- **[C5] Single-writer (PATH-scoped):** the tested canonical path performs 0 other `setCustomUserClaims`; the test does **not** assert removal of the historical writers.
- **[C4] Guard preserved:** `_requireSuperAdmin`/rate-limit/target-exists byte/behavior-identical; a non-superAdmin caller is denied exactly as before.
- **[gate-C3] No second authority:** with `adminPermissions` populated but the boolean claim absent, the coarse admin check still **denies** — `adminPermissions` alone never authorizes admin.

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
