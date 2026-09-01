# AdminOS Authority Core — Gate 1: Evidence & Dependency Closure (read-only)

- **Status:** EVIDENCE/SCOPE ONLY. No code, commit-to-main, push, or deploy. Deployed authority defects are **characterized, not repaired**. Finance/F9 out of scope.
- **Date:** 2026-09-01
- **Base:** canonical `origin/main` `340590d`. Deployed generation verified on `sokoni-aeb26` where noted.
- **Purpose:** produce an independently-reviewable scope for the authority-core convergence (claim writer · capabilities · audit · enforcement) — **not** an implementation.

## 0. Corrections to the prior record (evidence over assumption)
1. **`adminUpdateUserRole` is NOT a standalone deployed function** — `describe` returns *not found* on `sokoni-aeb26`, and it is **not re-exported in `index.js`**. Its handler is registered in the `_h` registry (`admin-os.js:131`, comment `:803-805`) and is reachable **via the deployed `adminOsDispatch`** (`index.js:9900`) as `adminOsDispatch({op:'adminUpdateUserRole'})`. ⇒ the claim-mint defect is **live-via-dispatch**, not a standalone deployment. (Prior "REAL LIVE BUG deployed" → refine: live via the dispatcher.)
2. **No shared client admin guard exists.** `sokoni-admin-guard.js` / `data-admin-guard` = **0 references**. Admin pages enforce with **inline** gates (`admin.html:2456-2462,5541,5622`; `admin-messages.html:615`; `admin-subscriptions.html:371`) or `sokoni-aos.js:22-30` (`admin-os.html`). Client gates are **cosmetic**; the real enforcement is the server callable guards + `firestore.rules`.
3. **`SokoniRoleAuthority` = 0 references.** The live business-role object is **`SokoniPermissions`** (`sokoni-permissions.js`), a client-side READ resolver that **never writes claims**. Separate surface; shares the `admin`/`superAdmin` vocabulary only.
4. **`setUserRole` is deployed** (`setuserrole-00009-sel`, 2026-08-22) and **co-sets `admin` with `superAdmin`** (deployed `super-admin.js:140-145`) — the canonical-correct writer, but it **overwrites** (drops non-role claims).

## 1. `adminPermissions` / `permsVersion` producers & consumers
**NET-NEW — 0 references** anywhere (functions/html/rules), confirmed independently. There are no current producers or consumers; both are design targets. Implication: introducing them is additive (no existing readers to break), but every authority check today is a **coarse boolean-claim** check (§4), so granular caps only take effect once callables read `adminPermissions` server-side (Q2).

## 2. Administrative-claim writers (mint/mutate) — 15 `setCustomUserClaims` sites
Admin-relevant writers (business-role/onboarding writers omitted here, listed in the census):

| Export | File:line | Claims | Preserve/Overwrite | Guard | Escalates? |
|---|---|---|---|---|---|
| `bootstrapAdminClaim` | index.js:205 | admin+superAdmin+role | **preserve** | allowlist + one-time self-lock | yes (once) |
| `grantAdminClaim` | index.js:253 | admin | **preserve** | inline superAdmin | yes (admin) |
| `revokeAdminClaim` | index.js:285 | −admin | preserve | inline superAdmin | no |
| `grantPlatformRole` | index.js:4632 | [role] | **preserve** (`...existing`) | inline; superAdmin for admin/superAdmin | yes (superAdmin-gated) |
| `revokePlatformRole` | index.js:4683 | −[role] | preserve | inline | no |
| `acceptPlatformInvite` | index.js:5055 | [invite.role]+platformEmployee | preserve | invite-token; role from invite doc | indirect |
| `removePlatformEmployee` | index.js:5104 | −platform roles | preserve | inline admin/superAdmin | no |
| **`setUserRole`** | super-admin.js:134 | admin,superAdmin,seller,driver,moderator,buyer (bool) | **OVERWRITE** (clears siblings) | `_requireSuperAdmin` | **yes** (admin+superAdmin correct) |
| **`adminUpdateUserRole`** | admin-os.js:151,155 | `{[role]:true, ...additional}` | **OVERWRITE** (no existing read) | `_requireSuperAdmin` +:153 | **yes — DEFECT** |
| `suspendUser` (2 impls) | super-admin.js:174 / security-incident-response.js:152 | disabled / suspended | preserve | superAdmin / admin | no |
| `unsuspendUser` | security-incident-response.js:235 | −suspended | preserve | admin | no |
| `betaReview` | beta-access.js:131 | betaStatus | preserve (Object.assign) | admin | no |
| `set-admin-claim.js` | functions/scripts/…:119 | next | **CLI script, not a callable** | operator-run | manual |

**Fragmentation:** ~8 admin-claim writers across `index.js`, `super-admin.js`, `admin-os.js`, `security-incident-response.js`, plus a CLI script — the fragmented-claim-writer problem ([[project_two_claim_writers_divergence]]).

## 3. Canonical claim-writer candidate (ADR Q1)
| Property | `setUserRole` | `grantPlatformRole` | `adminUpdateUserRole` |
|---|---|---|---|
| `admin` co-set with `superAdmin` | **YES** | no | **NO (defect)** |
| Preserves non-role claims (merchantId/posId/beta/suspended) | **NO (overwrites)** | **YES** | no |
| Clears stale sibling roles | **YES** | no | no |
| `permsVersion` | no | no | no |

**Evidence conclusion:** **no single existing writer is both preserving AND admin+superAdmin-correct.** `setUserRole` is the closest (correct claim shape + clears stale) but destroys non-role claims; `grantPlatformRole` preserves but never co-sets `admin` with `superAdmin`. So the canonical writer the ADR Q1 must elect has a **precise, evidence-derived spec**: read current claims → set the role flags (with `admin` implied by `superAdmin`) → clear stale role flags → **preserve** non-role claims (merchantId/posId/beta/suspended/platform*) → stamp `permsVersion`. **Which module hosts it, and whether it's `setUserRole` extended vs `grantPlatformRole` extended, is a POLICY decision (Q1), now fully specified by evidence.**

**`adminUpdateUserRole` defect (characterize only):** `admin-os.js:151` `const claims = { [role]: true, ...sanitizedAdditional }` → for `role==='superAdmin'` writes `{superAdmin:true}` with **no `admin:true`** and overwrites all existing claims; the `:153` guard only limits *who* may call it. Reachable **live via `adminOsDispatch`** (§0.1). Also allows `additionalClaims` injection (guarded for superAdmin). **Not repaired in this gate.**

## 4. Audit systems → `controlEvents` (ADR Q3)
`controlEvents` = **0 references** (net-new). Seven fragmented streams today (writer count / immutability):

| Collection | Writers | Reader(s) | Rules | Append-only? |
|---|---|---|---|---|
| `adminAudit` | 10 (admin-os.js) | `adminGetAuditLogs` (admin-os.js:784) | :4055 write:false | yes |
| `auditLog` | ~7 | — | :5313 write:false | yes |
| `auditLogs` | ~30 | rate-limit reads (index.js:3168/3869/4841) | :574 **client-creatable** (self-uid) | **NO** |
| `adminAuditLog` | ~6 (incl. `finos-automation.js:521`) | — | :4063 write:false | yes |
| `adminAuditLogs` | ~10 (algolia/search) | — | :4059 write:false | yes |
| `adminLog` | **no CF writers** | — | :1998 `create isAdmin; delete isSuperAdmin` | **NO (erasable)** |
| `securityAuditLog` | ~9 (security-*) | 5 readers | :3927 create:false CF-only immutable | **yes — strongest** |

**Strongest existing append-only trail = `securityAuditLog`** (CF-only + immutable + read back). A `controlEvents` convergence must **consume ~7 collections / ~60 write sites**, rewire the readers (`adminGetAuditLogs`, security readers, rate-limit reads) and **7 rules blocks**, and provide a replacement ingestion route for the **`auditLogs` client-create path** (:574) before removal. **NOTE (Q5):** these immutability facts are read from the **repo** `firestore.rules` (a proposal artifact) — the **SERVED** ruleset must be verified before relying on them.

## 5. Enforcement — correct vs weak
- **Server (real enforcement):** ~50 per-file `_requireAdmin`/`_requireSuperAdmin`/`assertAdmin`/`_isAdmin` helpers (fragmented — each file rolls its own), all reading `token.admin`/`token.superAdmin`. Admin callables enforce server-side. Rules helpers `isAdmin/isSuperAdmin/isModerator` (firestore.rules:9-20) read claims.
- **Client (cosmetic):** no shared admin guard (§0.2); inline gates per page or `sokoni-aos.js:22-30`.
- **Client-direct authority writes:** `securityPolicies` (`security-zero-trust-dashboard.html:540`) — **no rule → default-deny** (effectively dead). `verifications` status transitions are `isAdmin()`-only (firestore.rules:1812) — no direct client authority write.

## 6. Dependency closure (what must rewire before any removal)
- **Claim-writer convergence:** rewire callers of each writer (`index.js` re-exports; `admin-os.js` `_h`/`adminOsDispatch`; admin-console buttons), keep the `users` mirror (`role`/`roles`/`customClaims`) consistent for downstream readers incl. `SokoniPermissions` (sokoni-permissions.js:205-231), and preserve the `admin`+`superAdmin` co-set shape that ~50 `_require*` guards depend on.
- **Audit convergence:** consume 7 collections / ~60 write sites, rewire `adminGetAuditLogs` + security readers + rate-limit reads + 7 rules blocks, and replace the `auditLogs` client-create ingestion.

## 7. Boundaries that MUST NOT be touched
- **Business-role authority** (`SokoniPermissions`, sokoni-permissions.js) — separate client read-resolver; never merge into the admin claim writer.
- **Finance namespaces / F2–F9** (`financial-os.js`/`finos*`/`wallet.js`), **F3**, **F7**, **5% commission** — no overlap with claim writers/guards. **ONE contact point:** `finos-automation.js:521` writes the shared `adminAuditLog` — an audit convergence touching that collection pulls in a finance writer → **coordinate with the finance track or exclude `adminAuditLog`.**

## 8. The 5 ADR questions — evidence-answered vs policy-pending
- **Q1 (canonical claim-writer election):** evidence **fully specifies** the required writer behavior (§3); the **election of host/module remains a POLICY decision.**
- **Q2 (coarse `_requireAdmin` → granular `adminPermissions` capabilities):** `adminPermissions` net-new confirmed; current state coarse. **Design/policy-pending** (which capabilities, granularity, per-callable mapping).
- **Q3 (audit migration: dual-write vs hard cut):** dependency closure mapped (§4); **strategy is policy-pending**, informed by the ~60-site closure and the `auditLogs` client-create path.
- **Q4 (`adminLog` erasability):** **evidence-ANSWERED** — `adminLog` (rules :1998) is admin-writable + superAdmin-deletable (not append-only); already has a standalone proposal (`security/adminlog-append-only` `3c11065`). **Standalone rules fix, separate from this convergence.**
- **Q5 (served-ruleset authority):** **methodology requirement** — all rules facts above are from the repo proposal artifact; the SERVED ruleset must be independently verified before any audit-immutability claim is relied on.

## 9. Minimum-safe implementation scope (NOT implemented here)
A future, separately-authorized authority-core build, smallest coherent unit:
1. **One canonical claim writer** per the §3 evidence-spec (preserve non-role claims + co-set admin/superAdmin + clear stale roles + `permsVersion`); **retire/redirect** `adminUpdateUserRole`'s defective mint and the other writers to it via rewire (dependency-gated, §6). No new claim mechanism.
2. **`adminPermissions/{uid}`** net-new + server-side read in a *pilot* set of callables (not all 50 at once) — additive.
3. **`controlEvents`** net-new single append-only writer + **dual-write** during transition (Q3), consuming the streams incrementally; no legacy removal until readers rewired.
4. **No client-authority changes**, no business-role merge, no finance touch (except the flagged `adminAuditLog` coordination), and the `adminLog` erasability + served-ruleset verification handled as their **own** small tracks.
Explicitly OUT: capability-filtered nav, page consolidation, inline-gate removal (later gates); F2–F9; commission.

## 10. Falsifiable success condition + independent-review checklist
**Success condition (for the eventual build, not this gate):** every administrative claim mutation flows through the ONE canonical writer, which always co-sets `admin` with `superAdmin`, never drops non-role claims, stamps `permsVersion`, and emits a `controlEvents` entry; no callable mints claims independently; `adminUpdateUserRole`'s superAdmin-without-admin path no longer exists; and business-role authority + finance remain untouched — provable by: a claim-shape test (superAdmin ⇒ admin), a preserve test (merchantId survives a role change), a single-writer grep (0 other `setCustomUserClaims` on admin claims), and a `controlEvents`-emitted assertion.

**Independent-review checklist for THIS scope:** (a) confirm `adminPermissions`/`permsVersion`/`controlEvents` are truly net-new; (b) confirm `setUserRole` deployed co-sets admin/superAdmin and `adminUpdateUserRole`'s defect + live-via-dispatch reachability; (c) confirm the audit closure count (7 collections/~60 sites) and the two non-append-only collections; (d) confirm no shared client guard exists; (e) confirm the finance contact point (`finos-automation.js:521 → adminAuditLog`); (f) confirm the boundary set (business-role/finance/F3/F7/commission) is not on any claim-writer/guard path; (g) verify the SERVED ruleset for the immutability claims (Q5).

**Gate:** this evidence/scope → independent review (GO/NO-GO) → (if GO) a *separately-authorized* minimum-safe build gate. Nothing built, committed to main, pushed, or deployed.
