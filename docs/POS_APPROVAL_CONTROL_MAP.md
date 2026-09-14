# POS manager-approval control — map and design

**Status:** mapping and design only. **No code changed. Approval consumption remains 0.**
**Date:** 2026-09-01 · **Follows:** [[adr/ADR-013-pos-write-authority]]

---

## 1. What already exists

The `request → manager decision` architecture is **largely built**. It is not deployed.

| stage | where | state |
|---|---|---|
| raise a request | `createApprovalRequest` (`pos-staff-ops.js`) | built, uncommitted |
| manager decision | `reviewApproval` | built, uncommitted — four-eyes + shop binding |
| binding contract | `APPROVAL_BINDING` + `_buildBinding` | built |
| single-use execution | `_consumeApproval`, reachable only as `_approvals.consume` | built, **0 call sites** |
| cashier UI | `sokoni-pos-approval-request.js` (11.8 KB, 3 call sites, `watch` for the decision) | **404 in production** |
| manager UI | `sokoni-pos-sales.js` Sales Control Centre (40.3 KB, 2 `reviewApproval` sites) | **404 in production** |

So the missing pieces are the **execution stage** (deliberately unwired), the operation types, and
the cart UI — not the pipeline.

## 2. The operation vocabulary is FIVE, not six

`APPROVAL_BINDING` — the existing authority map — is:

```js
discount:       ['amount'],
refund:         ['saleId', 'amount'],
void:           ['saleId'],
price_override: ['productId', 'amount'],
drawer_open:    [],
```

Against the six requested: **void, refund, discount, price_override already exist.**
`drawer_open` exists but was not in the six. **`quantity_reduction` and `stock_adjustment` do
not exist.** The instruction was to take the six from the existing map rather than invent
operations — so this discrepancy is reported, not resolved unilaterally.

`stock_adjustment` is additionally gated on the branch-scope decision: `merchantAdjustStock`
today refuses employees entirely, so there is no employee action to approve yet.

## 3. THE BOUNDARY — the cart is not server-held

**There is no backend cart.** `state.cartItems` in `pos.js` is browser memory. The proposed flow

```
manager approval → backend verifies binding → authorized mutation → cart 3 → 2
```

cannot be enforced, because **no server holds the cart to mutate.** A backend can authorise the
*intent*, but the quantity that changes is a local array a cashier can edit from the console.

It is also not one button. Three client paths reduce a line today, all equivalent:

```js
updateQty(id, -1)     // the − button
setQty(id, value)     // the number input — typing 0 REMOVES the line
removeItem(id)        // the ✕ button
```

Gating only `−` moves the cashier to the input or the ✕. That is the stated requirement
inverted: *"UI hiding/disabling the minus button is not security."*

## 4. Why this would be theatre **on Rail 2**

A pre-payment cart edit is not a financial fact. Nothing has been charged; reducing 3 to 2 is a
customer changing their mind. The event worth controlling is a change **after** money is
committed — which is exactly `void` and `refund`, and those already have approval machinery.

And on the rail the till actually uses, the server does not decide the sale at all: `pos.html`
writes `posTransactions` directly, and the served rules accept any non-negative `total` with no
relation to `items` (ADR-013, evidence 1–2). A cashier who wants to under-ring simply writes a
smaller total — no cart edit required. Adding an approval gate in front of the `−` button would
produce a manager prompt that a determined cashier can bypass entirely, while a manager reads it
as control that exists. That is the same defect class as the client-side PIN price override
found in P19: a manager authorises, a toast says success, and the server never enforced anything.

**This slice therefore depends on ADR-013 Option A.** Once the sale is server-mediated, the
server holds the authoritative line quantities at checkout and a binding on
`(saleId | cartToken, productId, fromQty, toQty)` becomes enforceable. Before that, it is UI.

## 5. The smallest additive implementation, when unblocked

Nothing here is proposed for now; it is the shape to build *after* Rail 2 is server-mediated.

1. **Add two entries to `APPROVAL_BINDING`** — the one shared mechanism, no new permissions:
   `quantity_reduction: ['cartToken', 'productId', 'fromQty', 'toQty']`, and
   `stock_adjustment: ['productId', 'delta']` only if the branch-scope decision enables
   employee stock authority.
2. **Wire consumption once**, in the server-authoritative checkout, not per-operation: the
   mutation reads `_approvals.consume(approvalId, expectedBinding)` and fails closed when the
   binding does not match the operation being executed. One consumption site, not six.
3. **The cart UI becomes a proposal.** `−`, the number input and `✕` all route to the same
   request path; the line does not change while a request is pending. The existing `watch`
   in the cashier module already carries the decision back.
4. **Fail closed on a forged request.** The server must reject a request whose actor is not a
   member of the bound merchant, and `reviewApproval` already refuses self-approval and
   cross-shop review. A cashier calling the callable directly gains nothing.
5. **Offline-first stays intact.** An approval request must never block queueing a sale. If a
   request cannot be raised offline, the correct behaviour is that the reduction is unavailable
   — never that the sale is lost or unqueueable.

## 6. Invariants preserved by this pass

Approval consumption **0** · no new permissions · no role vocabulary changed · no Firestore
rules touched · nothing deployed, committed or migrated · Marketplace and Rail 2 untouched ·
each operation keeps its existing authority rules.
