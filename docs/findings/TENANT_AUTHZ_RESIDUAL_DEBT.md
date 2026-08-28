# Finding — residual tenant-authorization debt after the merchant-authority primitive

**Opened:** 2026-08-28 · **Status:** OPEN · **Severity:** P1 (financial path), P3 (peripherals)
**Discovered by:** a post-fix sweep of *every* export in the touched modules — **not** by the
audit that motivated the fix, which had undercounted.

Related: [[project-tenant-boundary-merchantid]] · `docs/TENANT_AUTHORITY_PRIMITIVE.md` ·
`docs/AUTHORIZATION_REVIEW.md` · [[project-employee-attribution-audit]]

> This file exists so the items below survive independently of the change that found them.
> The fix branch `fix/tenant-merchant-authority` closed **8** entry points. It did **not** close
> these. Do not read that fix as "the tenant boundary is closed."

---

## 1. POS financial callables are unbound — P1, and deliberately left that way

`pos-zero-friction.js`:

| callable | guard today | what it accepts |
|---|---|---|
| `posCompleteCheckout` | `_assertAuth` | caller-supplied `merchantId` |
| `posValidateCoupon` | `_assertAuth` | caller-supplied `merchantId` |
| `posLookupCustomer` | `_assertAuth` | caller-supplied `merchantId` |
| `posLogReprint` | `_assertAuth` | caller-supplied `merchantId` |
| `posCheckPaymentStatus` | `_assertAuth` | caller-supplied `merchantId` |
| `posProcessRefund` | `_assertRefundAuthority` | **correctly bound** — the model to copy |

`_assertAuth` only proves a uid exists.

**Why the owner-only primitive was NOT applied here.** These run on **cashier devices**, and a
cashier is not an owner. `assertMerchantAccess` would deny every legitimate checkout — converting
a security fix into a **checkout outage**. The correct guard is the staff-aware shape
`_assertRefundAuthority` already uses:

```js
businesses/{merchantId}.ownerId === uid          // owner
  || posStaff where(merchantId, uid, status=='active')   // active staff
```

### BLOCKER — RESOLVED 2026-08-28: posStaff is server-only

**Step 1 cleared.** Measured against served ruleset `f1c4e35b` with aborting controls: `posStaff`
is absent from the rules with no wildcard reaching it (deny-by-default), `_createBusiness`
server-generates `merchantId` so a caller cannot choose the merchant, and `_setStaffPin` cannot
create a membership. **Not self-mintable** — unlike `shopEmployees`.

Design spec for the staff-aware guard: `docs/findings/STAFF_AWARE_AUTHORITY_SPEC.md`. It records a
constraint found while specifying it: membership must be **merchant-scoped**, because `posStaff`
stores `branchId="${merchantId}-main"` while these callables pass `branchId="default"` or none — a
branch-scoped guard would match zero rows and **deny every cashier**.

### ORIGINAL BLOCKER TEXT (superseded, kept for provenance)

**Is `posStaff` client-writable?** If it is self-mintable, adding that path **reopens the hole the
primitive just closed**, because an attacker would mint their own active membership in the victim
tenant.

Evidence gathered, deliberately incomplete:
* `posStaff` is **absent from `firestore.rules`** (repo copy)
* the **served** ruleset could not be fetched — `gcloud` token unavailable in this environment
* a cached served-ruleset file was **rejected, not used**: its control (`shopEmployees`, known
  present) read `0`, so the probe was broken rather than the answer negative
* the only writer found is `business-bootstrap.js:1071`, which is server-side
* **`shopEmployees` is known self-mintable** — that is the precedent that makes this a real risk,
  and it is a *different* collection, so the precedent does not settle it either way

**Do not guess this.** Resolve it against the served ruleset before binding the financial path.

---

## 2. Two more unbound peripheral surfaces — P3

`pos-peripherals.js`:

* **`posUpdatePeripheralStatus`** — takes caller `merchantId` behind `requireAuth` only; writes
  `status` / `health` / `errorMsg` into **any** merchant's peripheral document.
* **`posCreateCustomerDisplay`** — `requirePosAccess(uid)` is a **role** check, not a tenant
  binding. Writes `posCustomerDisplays/{sessionId}` with `merge:false` on a **caller-supplied**
  `sessionId`, so it can overwrite another tenant's live display session.

P3 only because both have **zero client callers** (verified against a control:
`posCompleteCheckout` has ~15). Same defect class; no urgency, but they are real.

---

## 3. `procurement.js` — 8 sites

Behind `_requireManager` — a **role** claim with **no merchant binding**. Narrower than the above
(needs a manager/admin claim) but the same shape: role is not tenancy.

---

## 4. Why the July 2026 authorization sweep reported "0 confirmed vulnerabilities"

`docs/AUTHORIZATION_REVIEW.md` (2026-07-17) is **correct within its stated scope and misleading
outside it.** Its method kept only handlers that **write to a money- or privilege-bearing
collection** (`wallets`, `payments`, `commissionLedger`, `posRetailSales`, `posStaff`, …).

**None of the 8 entry points fixed on `fix/tenant-merchant-authority` write to those
collections** — they touch `posPeripherals`, `posCheckoutMetrics`, `posCustomerDisplays` and
health-score documents. They were therefore **never candidates**, and the "0 confirmed
vulnerabilities" result never covered them.

**A cross-tenant read of another merchant's checkout metrics is a tenancy breach even though no
handler writes money.** Any future authorization sweep must scope on **caller-controlled resource
identifiers**, not on the sensitivity of the destination collection.

---

## Closure criteria

1. Establish `posStaff` writability against the **served** ruleset (with a control that aborts).
2. If server-only: bind the five financial callables with the staff-aware guard; if
   client-writable: fix `posStaff` first, or bind on a different authority.
3. Bind `posUpdatePeripheralStatus` and `posCreateCustomerDisplay`.
4. Decide `procurement.js`.
5. Re-run `docs/TENANT_ISOLATION_BASELINE_SNIPPET.md` — every OTHER-TENANT line `DENIED`.
