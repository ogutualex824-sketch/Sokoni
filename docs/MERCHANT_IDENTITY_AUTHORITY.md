# Merchant Identity Authority + Employee Sale Authority

**Status:** BUILT · CERTIFIED 51/0 (+2 unproven) · **NOT DEPLOYED**
**Module:** `functions/merchant-identity.js` · **Suite:** `scripts/test-merchant-identity.js`

Related: [[RECEIPT_CONTRACT]] · [[RELEASE_BOARD_MERCHANT_V2]] · [[Authentication]]

---

## Shape

```
Merchant Identity Authority          functions/merchant-identity.js
        │
        ├── who is the merchant/shop?      shops/{uid}  → shopIdentity()
        ├── who is serving this sale?      resolveActor()
        └── what role does that person have?
                    │
                    └── Employee Sale Authority   employeeSaleAuthorize()
                         ├── authenticated employee   auth.uid, never payload
                         ├── approved relationship    shopEmployees/{uid}.shopOwnerId
                         ├── shop scope               resolved, not requested
                         ├── sale authority           ROLE_CAPABILITIES
                         └── servedBy snapshot        posSaleAttribution/{key}
```

Two responsibilities, one file, internally separated: `resolveActor()` answers
*who*, `employeeSaleAuthorize()` answers *may they, and under whose name*.

## What is never trusted

`servedBy`, `role`, `employeeUid`, `cashierName` — **not read from the request at
all.** Asserted on the source, because the strongest form of "does not trust X" is
that X is never read.

`shopId` **is** accepted — as context. The caller has to say which shop it means.
The server then resolves the relationship from `shops/{uid}` and
`shopEmployees/{uid}` and refuses if there isn't one. A request is a question,
never an assertion.

`uid` always comes from `auth`.

## Resolution

| caller | resolves as | name from |
|---|---|---|
| `uid === shopId` | `owner` / **Owner** | `users/{uid}` → Auth `displayName` |
| `shopEmployees/{uid}.shopOwnerId === shopId`, active | mapped role / **Staff** or **Manager** | the employment record, then `users/{uid}` |
| anything else | **refused** | — |

Ownership is the **document id** — `shops/{uid}` is keyed by the owner's uid, so
there is no `ownerId` field to forge.

Employment roles map explicitly: `cashier`/`staff` → Staff, `manager`/`supervisor`
→ Manager. An unknown role (`intern`) is **refused**, not promoted to staff — a
receipt should not name a role nobody defined.

## Fail closed — the invariant that carries consequence

> **An employee must never fall through to the owner's identity.**

A receipt crediting the owner for an employee's sale is a false financial record,
and it is exactly the record a shift dispute turns on. Every refusal path is
certified to return **no `servedBy` at all**, and none of them mention the owner:

| case | reason |
|---|---|
| stranger with no employment | `not-employed-here` |
| employee of A acting on B | `not-employed-here` |
| revoked employee | `employment-inactive` |
| no shop specified | `shop-not-specified` |
| shop does not exist | `shop-not-found` |
| unauthenticated | `unauthenticated` |
| name unresolvable | `employee-name-unresolved` / `owner-name-unresolved` |

An unresolvable name is a **refusal**, not a fallback. The sale fails rather than
producing an anonymous or owner-attributed receipt.

## `shopEmployees` is self-declarable — and it does not matter

Any user may create `shopEmployees/{self}` with `shopOwnerId == self` (the live
rules permit it by design; that is how an owner adds staff). Such a record matches
only their **own** shop id, so it never resolves against someone else's shop.
Certified: a self-declared *manager* record does not resolve against shop A, while
the genuine employee still does.

## The receipt becomes automatic

```
Served by: Alex          Served by: Brian
Role: Owner              Role: Staff
```

`servedRoleLine()` emits nothing without a valid `Served by`, so a role can never
appear attached to nobody. Certified end-to-end: the employee receipt names Brian
and **does not contain the owner's name anywhere**.

## Shop identity feeds the receipt without inventing

`shopIdentity()` emits only fields that exist. An absent logo is **absent**, not an
empty string — so the receipt's wordmark fallback engages instead of drawing an
empty frame. No KRA PIN is invented: `shops/{uid}` has no tax field.

## NOT yet enforced — stated, not assumed

1. **`posCompleteCheckout` does not consult `posSaleAttribution`.** The attribution
   is written atomically (`create()`, so one key can be attributed once and a
   second caller cannot re-attribute someone else's sale), and the client passes
   the same `idempotencyKey` — but nothing yet *requires* the authorize call.
   Enforcement is a one-line guard on a **deployed money path** and is deliberately
   a separate, reviewed change.
2. **No real employee has completed a real sale.** Journey D needs the role
   switcher and a real employee account. Not green until the receipt says the
   correct employee.

Both are recorded as UNPROVEN in the suite. Neither is a pass.

## Dependency this created

Employees have **no data access** to the shop they work for — `products` and
`orders` are keyed to `sellerUid == auth.uid` (see [[RELEASE_BOARD_MERCHANT_V2]]
finding 4). So an employee sale cannot go through client writes at all; it has to
go through the server. This authority is that server side's identity half.

## Deployment

Exported by name in `functions/index.js` so releasing is a deploy, not an edit.
`enforceAppCheck: true`, region `us-central1`, matching the surrounding callables.
**Nothing deployed.**
