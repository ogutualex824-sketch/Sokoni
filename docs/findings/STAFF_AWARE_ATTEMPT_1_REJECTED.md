# Rejected implementation — staff-aware guard, attempt 1 (`posStaff`)

**Date:** 2026-08-28 · **Status:** REJECTED BY TEST, reverted, preserved as evidence
**Patch:** `scratchpad/staff-aware-BLOCKED.patch` (338 lines) · **Never deployed**

Related: `docs/findings/STAFF_AWARE_AUTHORITY_SPEC.md` · `docs/findings/TENANT_AUTHZ_RESIDUAL_DEBT.md`

> Kept deliberately. Restoring 34/0 proves the bad implementation was removed; it does not mean
> the failure never happened, and the evidence trail must not read as though it didn't.

## What was built

`assertMerchantOperatorAccess` in `merchant-authority.js` — opt-in, additive, merchant-scoped,
resolving membership against **`posStaff`** (`merchantId` + `uid` + `status=='active'`), applied to
the five cashier-facing callables. It passed its own suite **51/0** and survived **14/14** sabotage
cases with **0 broken probes**.

## Why it was rejected

`scripts/test-sale-authority.js` went **34/0 → 29/5**. The decisive line:

```
FAIL  S9  CONTROL a cashier can still SELL — only the discount is gated
          [WRONGLY refused: Not authorised for this merchant.]
```

That is the till outage the whole sequencing exists to prevent, caught in a test instead of in
production.

## The mistake

The spec derived the authority from `_assertRefundAuthority`. **Refunds require manager/owner**, so
`posStaff` holds managers — while **ordinary selling cashiers live in `shopEmployees`**.

The real authority for these five callables is `merchant-identity.resolveActor`, which
`pos-zero-friction` requires at load *deliberately*, so that a missing employment authority fails
the deploy instead of silently disarming every till:

* `shops/{shopId}` — **keyed BY the owner's uid**, so ownership is the document id; there is no
  `ownerId` field to forge
* employee: `shopEmployees/{uid}.shopOwnerId === shopId`, employment active, role in `EMPLOYEE_ROLES`

So the POS identifier space is **`shopId` = owner uid**, not `SOK-XXXX`. The guard queried
`posStaff` by `merchantId`, matched nothing, and denied every cashier.

## The security question this raises

`shopEmployees` **is** client-writable, unlike `posStaff`. Served rules `f1c4e35b`:

```
allow create: if isAdmin() || (isAuthed() && request.resource.data.shopOwnerId == request.auth.uid);
allow update: if isAdmin() || (isAuthed() && resource.data.shopOwnerId == request.auth.uid);
```

A caller can only write records where **they** are the shop owner, so they cannot mint themselves
into a victim's shop — the cross-merchant gap is closed. **This is encouraging but must be TESTED
DIRECTLY, not assumed**, before the authority is adopted.

## Two conclusions RETRACTED during this work

A fresh `git worktree` has **no `node_modules`**. `test-pos-financial-trace` reported **15/5** in
two fresh worktrees and **20/0** in the provisioned one — same file, deterministic within each.

On that broken rig I stated (a) live `12c6676` carries 5 commission-ledger failures and (b)
`de20ba1` does too. **Both are false.** After `npm install` the reconciled branch reports **20/0**.
Uniform failure across a fresh rig is a probe fault until proven otherwise; provision dependencies
before attributing a suite result to code.
