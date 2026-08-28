# Step 2 spec — opt-in staff-aware authorization for the five cashier-facing callables

**Opened:** 2026-08-28 · **Status:** SPECIFIED, **NOT IMPLEMENTED** · **Authorized scope:** design only
**Prerequisite:** Step 1 CLEARED — see *`posStaff` is server-only* below.

Related: `docs/findings/TENANT_AUTHZ_RESIDUAL_DEBT.md` · `docs/TENANT_AUTHORITY_PRIMITIVE.md` ·
[[project-tenant-boundary-merchantid]] · [[project-pos-financial-integrity-freeze]]

---

## Step 1 result — `posStaff` is server-only, so the staff path is safe to build on

Measured against served ruleset `f1c4e35b-bcc2-418b-b7a3-8990c1c8dad0`, with controls that abort
(`shopEmployees` = 1, `match /users` = 4, 804 auth predicates — all non-zero, so the probe works).

1. **Rules.** `posStaff` occurs **0 times**. No generic top-level wildcard exists — the only
   `{document=**}` is scoped to `/tenants/{tenantId}/`. Firestore denies by default ⇒ **no direct
   client write.** Negative control: `posCheckoutMetrics` and `posPeripherals` also read 0, so
   "absent from rules" is simply the shape of a server-only collection here.
2. **Bootstrap write.** `_createBusiness` derives `merchantId` from `_generateMerchantId()`
   (`crypto.randomBytes`, collision-checked). **The caller cannot choose the merchant.** It writes
   `posStaff/{branchId}-{uid}` with the uid from `_requireAuth`, so a caller can only mint
   themselves owner of a **brand-new** merchant they just created.
3. **PIN write.** `_setStaffPin` merges only `pinHash`/`pinSetAt`/`pinVersion` onto an **existing**
   doc (`if (!staffSnap.exists) _err`). It cannot create a membership.

**Conclusion: `posStaff` is not self-mintable.** Unlike `shopEmployees`, which *is*.

---

## CRITICAL DESIGN CONSTRAINT — membership must be MERCHANT-scoped, not branch-scoped

The two existing private copies **disagree**, and only one of them works here:

| copy | matches `posStaff` on |
|---|---|
| `business-bootstrap._assertMerchantAccess` | `branchId` + `uid` + `status=='active'` |
| `pos-zero-friction._assertRefundAuthority` | `merchantId` + `uid` + `status=='active'` |

**Copying the branch-scoped shape would deny every cashier and take checkout down.** The data does
not line up with it:

* `posStaff` docs store `branchId = "${merchantId}-main"` (e.g. `SOK-GL58F7-main`)
* `posCompleteCheckout` and `posLogReprint` default `branchId` to the literal **`'default'`**
* `posValidateCoupon`, `posLookupCustomer`, `posCheckPaymentStatus` have **no `branchId` at all**

A branch-scoped query would therefore match **zero** rows for these callers.

**Decision: the staff-aware mode matches on `merchantId` + `uid` + `status=='active'`** — the
`_assertRefundAuthority` shape, the only one that is correct for all five.

**Stated trade-off:** merchant-scoped is *looser* than branch-scoped — a cashier at branch A may act
for branch B **within the same merchant**. That preserves the tenant boundary, which is what this
workstream is closing, but it does not enforce branch separation. Branch-level enforcement would
first require the callers to pass a real `branchId`; that is a client change and is **out of scope
here**. Record it, do not smuggle it in.

---

## The primitive to add — `merchant-authority.js`, opt-in, additive

Existing `assertMerchantAccess` **must not change behaviour**; the staff path is opt-in so the
already-certified 8 entry points keep their owner-only semantics and their 26/0 suite.

Hierarchy, fail-closed throughout:

1. authenticated caller, else `unauthenticated`
2. `admin` / `superAdmin` **claim** bypass — `=== true` only, never truthy
3. `businesses/{merchantId}.ownerId === uid`
4. **active `posStaff` membership** — `merchantId` + `uid` + `status=='active'` *(opt-in only)*
5. `merchants.ownerId` / `Array.isArray(adminUids) && includes(uid)` fallback *(only where required)*
6. otherwise `permission-denied`

`merchantId === auth.uid` must keep short-circuiting without a lookup — merchants operating under
their own uid are real and in use.

## Apply to exactly these five, and nothing else

`posCompleteCheckout` · `posValidateCoupon` · `posLookupCustomer` · `posLogReprint` ·
`posCheckPaymentStatus`

**Do not rewrite** `business-bootstrap`, `device-manager`, `shop-access`, or `_assertRefundAuthority`.
**Do not converge the four copies.** That is separate follow-on work (below) and must not enter this
release's critical path.

## Verification required before any deployment

* the existing **POS integrity / regression suite**
* **specifically prove a legitimate `posStaff` cashier can still execute all five paths** — a
  positive control. Denial-only evidence cannot distinguish a working guard from a broken one
* the `posStaff` fixture must be a **real active membership**, not an owner row, or the test proves
  only the owner path
* sabotage the new mode as before: a sabotage that fails to APPLY is a broken probe, never a pass

---

## Convergence debt — SEPARATE follow-on, not this release

Five private implementations of one idea now exist:

| site | authority | membership shape |
|---|---|---|
| `merchant-authority.js` (new) | `businesses.ownerId` | owner only |
| `business-bootstrap.js` (10 active-staff queries) | `businesses` → `posStaff` → `merchants` | **branch**-scoped |
| `pos-zero-friction._assertRefundAuthority` | `businesses` → `posStaff` | **merchant**-scoped |
| `device-manager.js` (2) | — | active-staff |
| `shop-access.js` (1) | — | active-staff |

This duplication **is** the original defect — no shared primitive, so every author invented one and
several forgot entirely. Converging them is correct and should happen; doing it inside a security
fix on the POS financial path is not. Track separately.
