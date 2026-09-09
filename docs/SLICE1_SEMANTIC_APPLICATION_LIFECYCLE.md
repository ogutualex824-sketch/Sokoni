# Slice 1 — semantic review: `functions/application-lifecycle.js`

**From:** `0928f3d` · **Read-only.** File not modified, nothing merged, nothing deployed.

```
production authority   c4013d1:functions/application-lifecycle.js   1451 lines / 1154 code
candidate              c6a1e68:functions/application-lifecycle.js   1216 lines /  932 code
```

`c4013d1` is the authority because Eventarc routes the lifecycle trigger to the service running
it — not because it is newest, and **not** `d6655bd` merely for being the largest lineage.

# ⚠️ REQUIRES_HUMAN_DECISION

The security axis is clean. The **behavioural** axis is not: the candidate is a divergent
lineage that drops three live production capabilities. This is not a refactor and cannot be
resolved as one.

---

## Security invariant — 🟢 fully preserved

The `c4013d1` self-approval fix survives intact:

| invariant | `c4013d1` | candidate |
|---|---|---|
| `decidedBy` derivation | `after.decidedBy` trimmed, then **authority-checked** | identical |
| trigger call | `applyDecision(appId, after, { decidedBy: authority.by })` | identical |
| `decisionAuthority` | present | present |
| `blocked_unauthorised_decision` | ×2 | ×2 |
| `blocked_no_uid` | ×1 | ×1 |
| `_requireAdmin(req)` | ×4 | ×4 |
| `enforceAppCheck: true` | ×3 | ×3 |

**Neither version restores `applyDecision(appId, after, {})`.** `decidedBy` is server-derived
via `authority.by` on the trigger path and `req.auth.uid` / `actor` on the callable paths — it
is never taken from client data unchecked. Classification: **PRESERVES**.

## Control-flow map

| path | entry | authorization | identity | → `applyDecision` |
|---|---|---|---|---|
| A | `applicationLifecycle` — Firestore trigger | `decisionAuthority` → refuse + `adminAlerts` | `authority.by` | guarded, both versions |
| B | `applicationDecide` — onCall | `_requireAdmin` + App Check | `actor` = `req.auth.uid` | guarded, both |
| C | `applicationReconcile` — onCall | `_requireAdmin` + App Check | `req.auth.uid` | guarded, both |
| D | `applicationList` — onCall | `_requireAdmin` + App Check | — | never calls it |
| E | `_internal` seam | — | — | `delete exports._internal` in `index.js:9921` |

Export surface identical: `applicationLifecycle`, `applicationDecide`, `applicationReconcile`,
`applicationList`, `_internal`.

---

## 🔴 The behavioural divergence — three live capabilities dropped

`applyDecision`'s role dispatch differs materially. All three production branches are **live
code**, called at `c4013d1` lines 1027, 1033 and 1042:

| role | `c4013d1` (production) | candidate | classification |
|---|---|---|---|
| `driver` | `projectDriver` | `projectDriver` | PRESERVES |
| **`rider`** | **`projectDriver`** — Phase-1 spelling, same projection | **absent** → falls through to `projectProvider` | 🔴 **BEHAVIOR_CHANGE** |
| **`legal`** | **`projectLegal`** → `legalProviders` *and* `lawyers` | **absent** | 🔴 **BEHAVIOR_CHANGE** |
| **`ROLE_PROFILES[role]`** | **`projectRoleProfile`** — Phase 2 canonical profiles | **absent** | 🔴 **BEHAVIOR_CHANGE** |
| `seller` | via `ROLE_PROFILES` | **`projectSeller`** — new | ADDITIVE / conflicting |
| `DELEGATED_ROLES[role]` | delegated | delegated | PRESERVES |
| fallback | `projectProvider` | `projectProvider` | PRESERVES |

Occurrence counts, `c4013d1` → candidate: `'rider'` **7 → 0**, `lawyers` **9 → 0**,
`legalProviders` **8 → 1**, `'legal'` **7 → 1**.

**Consequences if adopted as-is:**

* a **`rider`** application no longer projects to the driver registry — it falls through to
  `projectProvider` and is filed as a generic provider;
* a **`legal`** application loses its `lawyers` search projection, so an approved lawyer stops
  being discoverable;
* **Phase 2 canonical role profiles** stop being written — `2ba509b` was literally
  *"feat(roles): Phase 2 — canonical role provisioning"*, so this is a documented capability
  regressing.

### Role granting — I was initially wrong, and the correction matters

It first appeared that `grantAccountRole` was deleted. It is not: the candidate **imports** it
from `./role-authority`, calls it with an options argument, and adds **claim-mint
reconciliation** (`roleClaimReconcile`, plus an alert when the Firestore grant lands but the
Auth claim does not). That is an **improvement** — classification **TIGHTENS / BUG_FIX**.

Worth recording: `role-authority.js` exists in **both** lineages, but `c4013d1` still defines
its own local `grantAccountRole` at line 846 and calls `setCustomUserClaims` directly. So
production carries a duplicate of logic already extracted elsewhere. The candidate's extraction
is the better structure — but that does not license adopting the whole file.

## Projection / registry / list

| area | finding |
|---|---|
| `projectProvider`, `projectDriver` | present both sides |
| `projectLegal`, `projectRoleProfile` | **production-only** — no relocation; `role-authority.js` contains **zero** role-profile or legal markers |
| `projectSeller` | candidate-only; overlaps what `ROLE_PROFILES` covered |
| `grantAccountRole` | relocated + reconciliation added — TIGHTENS |
| `applicationList` | same guards both sides — `_requireAdmin` + App Check; no query-scope or field-exposure change observed |
| idempotency / retry | `blocked_*` projection statuses present in both |

## Tests

| suite | against production authority |
|---|---|
| `test-seller-application` | **57 passed, 0 failed** |
| `functions/test/application-lifecycle.test.js` | exit 0 |

Not decisive either way. **Source-proven**: the security invariants and the role-dispatch
divergence, both read directly from source. **Production-observed**: the Eventarc topology from
the security gate. **Production-unproven**: the runtime effect of the dropped branches — no
`rider` or `legal` application was decided against either build.

---

## Deltas requiring a human decision

1. **Drop `rider` spelling?** Phase-1 applications would file as generic providers. Is the
   spelling retired, or still arriving?
2. **Drop `legal` projection?** Approved lawyers would stop appearing in the `lawyers` search
   collection. Is legal onboarding live?
3. **Drop `ROLE_PROFILES` / Phase 2 profiles?** Directly reverses a shipped feature.
4. **Adopt `projectSeller`?** New seller path overlapping the profile system it replaces.
5. **Adopt the `role-authority` extraction + claim reconciliation?** The one clear improvement,
   and arguably separable from the rest.

None is a merge decision. Each is a product/business decision about which roles SOKONI
projects and where.

## Recommendation

**Do not resolve this module by choosing a side.** The candidate is neither a superset nor a
refactor — it is an earlier or parallel evolution that never received Phase 2 roles or legal
projection, plus improvements production never received.

The defensible shape is a **targeted reconciliation**: keep `c4013d1` as the base, port the
`role-authority` extraction and claim reconciliation forward, and decide `projectSeller` and the
three dropped branches individually on product grounds. That is a larger piece of work than
Slice 1 as scoped, and it should be authorised as its own slice.

```
production deployed   NO
production mutated    NO
worktree              clean
files changed         NONE
```
