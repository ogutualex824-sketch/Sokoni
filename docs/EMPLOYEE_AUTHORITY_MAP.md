# Employee Authority Map

**Status:** CENSUS COMPLETE — decision pending
**Date:** 2026-09-01
**Suite:** `scripts/test-employee-authority-map.js` (28/0/4, in the required gate)
**Related:** [[POS_SHIFT_LIFECYCLE_AUDIT]] · [[POS_AUTHORIZATION_CENSUS]] · [[MERCHANT_V2_CERTIFICATION]]

---

## The question asked

> Fully map `shopEmployees`/`ROLE_CAPABILITIES` versus `workspaceMemberships`/`permissions`
> before changing either. Do not introduce a second employee authority merely for symmetry.

## CORRECTION (2026-09-01, later same day)

This document originally said there were TWO employment stacks. That was wrong. A pattern
census of `functions/` finds **eight** employment/role stores, and **three** of them
independently gate POS money operations: `shopEmployees` -> `resolveActor` -> checkout;
`workspaceMemberships` -> `_assertBusinessPermission` -> shifts and approvals; `posStaff` ->
`_assertRefundAuthority` -> refunds. See [[MANAGER_APPROVAL_ARCHITECTURE]] section 3.

The control that missed this enumerated three store names it guessed might exist, found none,
and concluded there were two. It now censuses by pattern and pins the count.

## The answer

A second employee authority **already exists**. There is nothing to introduce and nothing to
add for symmetry. There are two complete, parallel, non-communicating employment stacks:

| layer | **Stack A** — POS / shop | **Stack B** — Workforce Identity v1.0 |
|---|---|---|
| employment record | `shopEmployees` | `workspaceMemberships` |
| authorization model | `ROLE_CAPABILITIES` (`merchant-identity.js`) | `permissions[]` / `ALL_PERMISSIONS` |
| shift record | `posShifts` (`pos-staff-ops.js`) | `shiftSessions` (`workforce-identity.js`) |
| tenant key | `shopOwnerId` | `businessId` |
| invitations | inline in `index.js` | `workspaceInvitations` |
| consumers | POS, analytics, marketplace, logistics, finance | `org-engine`, `profile-engine` |

Stack B is the **designed** enterprise layer — "One Person. One Account. Unlimited
Businesses." — with invitations, permissions, shift tracking and audit trails, all
server-authorised. Stack A is what the **POS money path actually runs on**.

Neither reads the other. That separation is currently *load-bearing*: a bridge would
silently make one stack authoritative for the other, and the suite asserts it stays absent.

---

## The defect found while mapping

`shopEmployees` has **one writer** — invite acceptance in `functions/index.js`. It keys the
document by `auth.uid` and stores:

```
uid, email, name, role, shopOwnerId, shopName, active, joinedAt
```

Note what is **not** there: no `shopId`, no `userId`.

Five of its six consumers look it up by exactly those missing fields:

| consumer | lookup | resolves? |
|---|---|---|
| `merchant-identity.js` | `.doc(uid)` then checks `shopOwnerId === shopId` | ✅ |
| `analytics-engine.js` | `.doc(shopId + '_' + uid)` | ❌ composite id never written |
| `finance-os-sprint43.js` | `where shopId == · where userId ==` | ❌ neither field |
| `logistics-plus.js` | `where shopId == · where userId ==` | ❌ neither field |
| `marketplace-extensions.js` | `where shopId == · where uid ==` | ❌ no `shopId` |
| `pos-completeness.js` | `where shopId == · where uid ==` | ❌ no `shopId` |

All five are reachable in production — three directly from `index.js`, three via
`finance-sprint-dispatch`, `logistics-plus-dispatch` and `smartpos-dispatch`.

### Severity: functionality, not escalation

Every dead read **fails closed**. `analytics-engine` falls through to custom claims and then
`throw new Error('Access denied')`; the other four `throw new Error('forbidden')` on an empty
result. No consumer treats an empty read as permission — asserted as a control, because that
is precisely the line between a bug and a privilege escalation.

The consequence is that a legitimately invited employee is denied by five subsystems, while
only `merchant-identity` (and therefore `resolveActor`, and therefore POS `servedBy`)
recognises them.

### Why it was not fixed in this pass

Every available repair converts **DENY into ALLOW** across five subsystems. That is an
authorization expansion, and it cannot be validated here — there is no real employment data
in this environment, and a plausible-looking edit to five authorization paths is exactly the
class of change that must not be made on inspection alone.

Three repair shapes exist, and choosing between them is the decision:

1. **Converge readers onto the writer** (`.doc(uid)` + `shopOwnerId`, as `merchant-identity`
   does). Smallest change; no data migration; five authorization paths edited.
2. **Widen the writer** to also store `shopId`/`userId`. One file; but it creates
   denormalised aliases of an identity key — the thing repeatedly ruled out elsewhere in this
   programme — and does nothing for the composite-doc-id reader.
3. **Migrate Stack A onto Stack B** and retire `shopEmployees`. Correct long-term; largest
   blast radius; touches the money path.

Recommendation is **(1)**, because it makes the readers agree with the only writer that
exists rather than inventing new fields, and because `merchant-identity`'s shape already
carries the tenant binding that the query-based readers get for free from `shopId`.

---

## Consequence for shift convergence

The shift lifecycle audit counted **four** shift implementations. `shiftSessions` is a
**fifth**, and it belongs to Stack B.

Converging shifts *before* the employee-stack decision would encode the losing stack into the
money path. Shift convergence is therefore **blocked on this decision**, not on engineering
capacity.

---

## Required external action

- **Decision:** which stack is canonical for shop employment (recommend Stack A near-term,
  Stack B as the migration target).
- **Authorization:** to repair the five dead reads, since each converts DENY into ALLOW.
- **Data:** a real `shopEmployees` record and a deployed function to prove an employee
  actually passes analytics authorization. Not provable in this environment.

## What is locked

`scripts/test-employee-authority-map.js` characterizes the state above and is in the required
gate. It **fails when either side changes** — including when the defect is repaired. That is
intended: a repair here must be reviewed, not merged silently. The suite was proved capable
of failing by adding `shopId` to the writer, which brought two consumers alive and dropped the
dead count from five to three, failing the two assertions that carry the claim.
