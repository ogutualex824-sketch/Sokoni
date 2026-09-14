# Manager Approval Architecture — census

**Status:** CENSUS COMPLETE — no code changed in this pass
**Date:** 2026-09-01
**Related:** [[EMPLOYEE_AUTHORITY_MAP]] · [[SHIFT_ACCOUNTING_CONTRACT]] · [[POS_AUTHORIZATION_CENSUS]]

---

## 1 · `createApprovalRequest`, completely mapped

`functions/pos-staff-ops.js:741`, writing `posApprovals`.

| question | answer |
|---|---|
| who can create | owner (`auth.uid === sellerId`) or a **Stack B** member with the `pos` permission, via `_assertBusinessPermission` |
| what operation | one of `discount`, `refund`, `void`, `price_override`, `drawer_open` |
| who approves | `reviewApproval`, gated by `_requireRole(auth, 'supervisor')` — **a claim check only** |
| expiration | `+5 minutes`, enforced at review and reported by `checkApproval` |
| single-use | **No.** Status goes `pending → approved`. Nothing marks it used |
| bound to shop | at creation **yes**; at review **NO** |
| bound to employee | records `requestedBy`; never compared to the reviewer |
| bound to operation | `type` is stored but nothing checks it at use |
| bound to amount | **No.** `requestData` is `data.requestData || {}` — an arbitrary, unvalidated client object |
| bound to transaction | **No.** No `saleId` binding is enforced |
| consumed by the mutation | **No consumer exists anywhere in the codebase** |

### The finding

`createApprovalRequest` **is** the right foundation — its five types map exactly onto the
protected operations, and it already binds the shop at creation through a real permission
check. But today it is a **workflow record, not an authorization primitive**. Nothing consumes
it, so it cannot gate anything, and an approved approval remains approved forever.

Four defects must be closed before it can carry authority:

1. **Self-approval is possible.** `reviewApproval` never compares `approval.requestedBy` to
   `auth.uid`. Anyone holding the `supervisor` claim can approve their own request — which
   removes the four-eyes property that is the entire point.
2. **Cross-shop review is possible.** `reviewApproval` checks the reviewer's *role* but never
   that `approval.sellerId` is a shop they belong to. A supervisor at shop A can approve shop
   B's request. (`getPendingApprovals` **does** bind the shop; `reviewApproval` does not, so
   the listing is safe and the mutation is not.)
3. **No consumption, so no single use.** An approval must be spent by the operation it
   authorised, atomically, exactly once.
4. **`requestData` is opaque and unvalidated.** Amount, sale and target are whatever the client
   sent, so an approval for "refund KES 50" cannot be distinguished from one for
   "refund KES 50,000".

`checkApproval` additionally takes only `_requireAuth` — any authenticated user can read any
approval document by id, across shops. Minor beside the above, but it is disclosure.

### Do not build a second system

Four approval rails already exist: `posApprovals` (this one), `posCloseApprovals`
(`pos-cash-manager.js`, shift close), `workflowApprovals` (`wap.js`), and `approvalRequests`
(`automation-engine.js`, risk routing). A token system beside these would be a fifth. The work
is to make `posApprovals` consumable, not to invent another.

## 2 · The protected mutation boundary

| operation | server mutation | current gate | can consume approval? |
|---|---|---|---|
| **refund** | `posProcessRefund` (`pos-zero-friction.js:1081`) | `_assertRefundAuthority` — claim + **`posStaff`** membership | **Yes** — best candidate |
| **void** | `voidPOSSale` (`pos-retail-engine.js:412`) | claims only, **no tenant binding** | Yes, after the P1 below |
| **price override** | inside `posCompleteCheckout` | `_actor.capabilities` (Stack A) | Yes |
| **large discount** | inside `posCompleteCheckout` | `_actor.capabilities.indexOf('discount')` | Yes |
| **stock adjustment** | `inventoryAdjustStock` (`inventory-engine.js:88`) | to be audited | Likely |
| **inventory correction** | `inventoryProcessStockCount` (`inventory-engine.js:518`) | to be audited | Likely |
| **shift close** | `closeShift` (`pos-staff-ops.js:147`) | `_requireSeller` (Stack B) | Yes — but note `posCloseApprovals` is a parallel rail |
| **cash drawer** | `cdOpenDrawer` (`pos-cash-drawer.js:71`) | **logs only** | **No** |

### `cash drawer` needs server-authoritative mutation work

`cdOpenDrawer` does not open a drawer. The client hardware opens it and then reports what
happened; the function writes a log row. There is therefore **nothing on the server to gate** —
approval could be checked before logging, and the drawer would still have opened. Recording it
as requiring server-authoritative mutation work rather than wrapping approval around a client
action that has already taken place.

## 3 · Three employee authorities gate three money operations

This census corrected an earlier claim in [[EMPLOYEE_AUTHORITY_MAP]] that there were two
employment stacks. A pattern census of `functions/` finds **eight** employment/role stores:

```
workspaceMemberships (28)  posStaff (13)  shopEmployees (6)  orgRoles (5)
hrStaff (5)  posStaffAvailability (2)  posRoles (2)  platformEmployees (1)
```

Three of them independently gate POS money operations:

| store | via | gates |
|---|---|---|
| `shopEmployees` | `resolveActor` | **checkout** |
| `workspaceMemberships` | `_assertBusinessPermission` | **shifts, approvals** |
| `posStaff` | `_assertRefundAuthority` | **refunds** |

So a member of staff may be authorised to sell but not to open a shift, or to refund but not to
sell, depending on which store happens to carry them. Any approval enforcement must choose one
authority — and that is the employee-convergence decision, which is parked.

The earlier control asserting "no third store" enumerated three names it guessed
(`shopStaff`, `employeeRecords`, `staffMembers`), found none, and concluded there were two.
A control that enumerates its own expectations can only confirm them. It now censuses by
pattern and pins the count at 8.

## 4 · Separate P1 — `voidPOSSale` has no tenant binding

Found while censusing the mutation boundary. Recorded here, **not fixed**, because
tenant-boundary findings get their own controlled remediation.

`voidPOSSale` checks that the caller holds `admin`, or `posRole` of `manager`/`supervisor`/
`owner` — **at any shop** — then takes a client-supplied `saleId`, voids
`posSales/{saleId}`, and restores inventory:

```js
admin.firestore().collection('products').doc(i.productId)
  .update({ stock: incr(i.qty), soldCount: incr(-i.qty) }).catch(() => {})
```

So a manager at one shop can void another merchant's sale **and increment that merchant's
product stock**. Two further problems in the same block: the stock restore is **not in a
transaction**, contrary to the standing inventory rule, and `.catch(() => {})` discards the
failure silently, so a partial restore leaves the sale voided and the stock wrong with no
signal.

## 5 · Proposed enforcement shape (not built)

```
cashier request
  → server verifies actor + shop            (one chosen authority)
  → server verifies manager approval        (posApprovals, status=approved)
  → approval bound to shop + operation + amount + transaction + requester
  → server CONSUMES the approval atomically (status → consumed, in the same
    transaction as the mutation, so a replay finds it already spent)
  → mutation
  → immutable audit event
```

The consumption and the mutation must share one transaction. If they do not, a crash between
them either spends an approval that did nothing or performs a mutation that can be replayed.

## 6 · What must happen before the client PIN is reconsidered

The PIN stays. It is currently the only thing standing between a cashier and these operations,
because the server-side approval it would replace **cannot yet be enforced** — nothing consumes
an approval, self-approval is possible, and cross-shop review is possible. Once approval is a
consumable, bound, single-use server primitive, the PIN becomes a credential mechanism for
obtaining one and the ~60 KB manager UI can be made lazy or removed without reducing financial
control. Not before.
