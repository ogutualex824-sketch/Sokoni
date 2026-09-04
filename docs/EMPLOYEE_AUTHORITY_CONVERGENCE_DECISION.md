# Employee Authority Convergence — Decision Required

**Status:** DECISION ARTIFACT — no code changed. **All five §6 questions now ANSWERED
(2026-09-04)** — Q1 by production census, Q2–Q5 by explicit product/policy decision. See the
inline note under each question. §4's convergence protocol has not been started; whether and when
to begin implementing against these five answers is a separate authorization.
**Date:** 2026-09-01
**Blocks:** approval consumption · void restoration · refund · discount · shift · stock · the five dead reads
**Related:** [[EMPLOYEE_AUTHORITY_MAP]] · [[MANAGER_APPROVAL_ARCHITECTURE]] · [[SHIFT_ACCOUNTING_CONTRACT]]

---

## 0 · The blocker underneath the blocker

Choosing a store is the *second* question. The first is that **the three systems do not agree
on what a shop is**:

| store | tenant key | resolves against |
|---|---|---|
| `shopEmployees` | `shopOwnerId` | `shops/{uid}` — the document id **is** the owner's uid |
| `workspaceMemberships` | `businessId` | `businesses/{businessId}` |
| `posStaff` | `merchantId` + `branchId` | `businesses/{merchantId}`, branch-scoped |

`pos-staff-ops.js` says so in its own privilege-escalation note: the owner short-circuit exists
specifically to avoid *"depending on whether sellerId is a `businesses/{id}` key — which is
**NOT uniform** across this codebase."*

**No convergence is safe until it is established whether `shopId`, `businessId` and
`merchantId` are the same identifier space.** If they are not, migrating employees between
stores silently re-points them at a different tenant. This needs answering with data, not
inspection — and it is the one thing on this page I cannot settle from source.

## 1 · The two capability vocabularies are not the same shape

| | `ROLE_CAPABILITIES` (Stack A) | `ALL_PERMISSIONS` (Stack B) |
|---|---|---|
| shape | **operation-shaped** | **domain-shaped** |
| values | `sell, refund, discount, openShift, closeShift, manageStaff` | `pos, refunds, discounts, inventory, finance, payroll, reports, customers, bookings, drivers, deliveries, branches, users, analytics, settings, view_products, manage_products` |
| shift | `openShift` and `closeShift` are **separate capabilities** | no shift concept — folded into `pos` |

Converging onto Stack B **loses the open/close shift distinction** unless `ALL_PERMISSIONS`
gains it. That is a real migration cost and must be a deliberate choice, not a side effect.

## 2 · The decision table

| Operation | Current authority | Proposed canonical | Why | Migration impact |
|---|---|---|---|---|
| **Checkout / `servedBy`** | `shopEmployees` via `resolveActor` | **`workspaceMemberships`** | `resolveActor` is the only Stack A reader that works; but it is one working reader propping up a store whose other five are dead | **High.** Money path. `servedBy` shape must be preserved exactly — it is what the Sales Control Centre displays and what "Not recorded" protects. Dual-read during migration |
| **Discount** | `shopEmployees` (`_actor.capabilities` `discount`) | **`workspaceMemberships`** (`discounts`) | one-to-one mapping already exists | Low — capability name changes singular → plural |
| **Refund** | **`posStaff`** via `_assertRefundAuthority` | **`workspaceMemberships`** (`refunds`) | `posStaff` reads *work* (writer/reader agree) but it has no invitation flow and no permission model — only `role` | Medium. `posStaff` is **branch-scoped**; Stack B is not. Branch must be carried across or refunds lose branch granularity |
| **Shift** | `workspaceMemberships` (`pos`) | **`workspaceMemberships`** — already canonical | no change of store; `pos-staff-ops` already routes through `_assertBusinessPermission` | Low, **but** add `openShift`/`closeShift` to `ALL_PERMISSIONS` or accept that `pos` gates both |
| **Approval** | `workspaceMemberships` (`pos`) | **`workspaceMemberships`** — already canonical | the hardened primitive already uses it | None |
| **Void** | **none** — owner-or-admin only (P7) | **`workspaceMemberships`** (proposed: `refunds`, or a new `voids`) | P7 made it safe by narrowing to ownership because no store could be chosen; that was correct then and is too narrow now | **Additive only** — restores a capability currently denied. See §3 |
| **Stock adjustment** | **none / audited gap** | **`workspaceMemberships`** (`inventory`) | `inventoryAdjustStock` was never audited for employee authority in this programme | Unknown until audited. Do not converge before auditing it |

## 3 · Recommendation

**One canonical workforce authority: `workspaceMemberships` (Workforce Identity v1.0).**
`shopEmployees` and `posStaff` become **compatibility/migration surfaces**, read during
transition, never independent authorities.

Reasons, in order of weight:

1. It is the **designed** layer — invitations, permissions, status lifecycle, audit trail —
   and the only one with a real management surface rather than bootstrap seeding.
2. It is **already canonical for the two newest subsystems**: shifts and the hardened approval
   primitive. Choosing anything else would mean migrating those *backwards*.
3. `shopEmployees` is the weakest candidate on evidence: **five of its six readers are dead**,
   and it has no branch scope.
4. `posStaff` is the strongest *runtime* candidate — its reads actually resolve and it is the
   only branch-aware store — but it carries only a `role` string, no permission model, and no
   invitation flow. Its **branch scope is the one thing worth taking from it.**

The principle to enforce, exactly as stated:

```
employee → canonical employment + shop membership → role / capability
        → protected operation → approval requirement → exact binding → mutation
```

### Void is the right first operation

- It is the **only** operation where convergence is **purely additive** — it restores a
  capability that is presently denied, so no employee loses access on day one.
- Its tenant binding and transaction atomicity are already proven (P7, 30/0/4), so the
  convergence changes exactly one thing: *who* may call it.
- Failure mode is visible and reversible: a wrongly-denied void is an immediate support
  complaint, not silent data corruption.

Every other operation redistributes existing access, where a mistake in either direction is
worse and much harder to see.

## 4 · Per-operation convergence protocol

For each operation, in order — **Void → Refund → Discount → Shift/Approval → Stock**:

1. baseline the current behaviour, executed not asserted
2. implement against the canonical authority
3. positive: an authorised employee **succeeds**
4. negative: **cross-shop** denied
5. negative: **wrong role / missing capability** denied
6. negative: **unauthenticated** denied
7. sabotage the guard, prove `applied:true`, prove the expected assertions fail
8. restore, verify by hash
9. full required gate

Only after all five converge does `_consumeApproval` get wired into the mutations, one at a
time, with the same battery.

## 5 · What must NOT move with this work

- the eight `sellerId || auth.uid` sites in `pos-retail-engine.js` — **1087 and 1101 are
  writes** on inventory transfer and deserve their own tenant-boundary battery
- `shiftId` server-derivation follow-ons
- `cashierUid` / `cashierId` — the Rules revision is drafted but **unstaged**, waiting on the
  `f88e8953` publish
- the five dead `shopEmployees` reads — these are *resolved by* the decision, not before it

## 6 · Open questions only you can answer

1. **Is `shopId` == `businessId` == `merchantId`?** Blocking. Needs production data.

   > **ANSWERED, 2026-09-04 — `docs/TENANT_IDENTIFIER_SPACE_CENSUS.md`.** **NO — distinct
   > identifier spaces; mapped relationship (via `businesses.ownerId`), not equality.** A
   > full, read-only census of production (`shops`, `sellers`, `businesses`, `shopEmployees`,
   > `workspaceMemberships`, `posStaff`, `posSettings`) found two live counter-examples to
   > this document's own working assumption: a currently-active `businesses` record whose
   > `merchantId` literally equals the owner's uid (reached via a merge, not normal
   > provisioning — directly contradicting this file's §0/`tenant-identity.js`'s own header
   > claim that a merchantId "can never equal an auth uid"), and one owner with **two**
   > simultaneously-active `businesses` records — exactly the `AMBIGUOUS` case
   > `resolveMerchantIdForOwner` exists to refuse on, confirmed live rather than theoretical.
   > Also found: stale `posStaff`/`posSettings` records still pointing at a retired, merged-
   > away business; a `workspaceMemberships` record keyed to a deprecated duplicate identity;
   > and 7 of 8 real `sellers` documents with no corresponding `shops/{uid}` document at all —
   > so `merchant-identity.js`'s `uid === shopId` pattern is not a universal production
   > invariant either. **This resolves the one data-dependent blocker in this question, not
   > the model itself.** The correct eventual architecture is an explicit mapping chain (owner
   > uid → canonical business identity → shop/workspace identity → employee/shop scope), not
   > collapsing the three identifiers into one. Questions 2–5 below remain open, unaffected by
   > this answer.

2. Does `ALL_PERMISSIONS` gain `openShift`/`closeShift`, or does `pos` continue to gate both?

   > **ANSWERED, 2026-09-04.** `ALL_PERMISSIONS` gains explicit `openShift` and `closeShift`
   > capabilities, distinct from `pos`. An employee granted `pos` must not thereby gain shift
   > control — the canonical model distinguishes `pos` / `openShift` / `closeShift` as three
   > independently grantable permissions, preserving least privilege.

3. Does void get `refunds`, or a new `voids` permission?

   > **ANSWERED, 2026-09-04.** A dedicated `voids` permission, independent of `refunds` —
   > they are operationally different actions and must remain independently grantable, so an
   > owner can let an employee void an eligible unfinalized transaction without also granting
   > refund authority. The existing owner/admin-only behavior for void (P7) remains the safe
   > baseline until `voids` is explicitly implemented and enforced — this answer does not by
   > itself change void's current authority.

4. Is branch scope a requirement of the canonical model, or may refunds lose branch
   granularity during migration?

   > **ANSWERED, 2026-09-04.** Branch scope is mandatory in the canonical model. Refund
   > authority must not lose branch granularity during migration — the canonical chain is
   > employee identity → business/workspace → branch → permitted operation. A refund-capable
   > employee must not gain cross-branch access merely because `workspaceMemberships` today
   > lacks a branch dimension. Given §6 Q1's production evidence that `shopId`/`businessId`/
   > `merchantId` are distinct, non-interchangeable spaces, branch ownership must be
   > represented explicitly in the canonical model — never inferred from any one of those
   > three identifiers.

5. Is there an acceptable dual-read window on the checkout path, or must it cut over atomically?

   > **ANSWERED, 2026-09-04.** No dual-read window on the money path. Checkout/`servedBy`
   > cuts over atomically: old authority → atomic cutover → canonical authority, with
   > compatibility handled *before* the cutover rather than via ambiguous runtime fallback. A
   > checkout request must resolve `servedBy` from the canonical authenticated employee/
   > merchant authority — it must not silently fall back to a second identity source
   > depending on which document happens to exist, which is exactly the kind of implicit
   > equality §6 Q1's evidence showed is unsafe.

## 6a · Standing invariants reaffirmed alongside the five answers (2026-09-04)

Not new decisions — restated explicitly so the convergence work builds against them without
re-deriving them from older material:

- **`permissions[]` is the authoritative grant.** `roleTemplate` stays descriptive only — a label
  for the UI, never itself a source of authority.
- **The model stays server-authoritative.** The owner grants permission; the employee's
  authenticated identity establishes who they are; the server — never the client — determines
  what they may access.

## 7 · State this decision does not change

32/32 suites, 1,016 assertions — **tested contracts, not production proof**. No live
cashier/manager transaction, no live Rules state, no handset behaviour, nothing deployed.
Approval consumption: **0 call sites**. PIN untouched. Priorities 3–8 remain **uncommitted**
working-tree changes on top of `fa5082b`.
