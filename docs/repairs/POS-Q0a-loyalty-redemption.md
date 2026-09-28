# POS Q0a — loyalty redemption and the customer it touches (main line)

**Branch:** `pos-safety/q0a-loyalty-redemption` (from main 0b `96d31e4`) · **not deployed** · served lineage NOT changed
**Owner authorization (2026-09-27):** Q0a only, main first.
- Reject malformed and negative `loyaltyRedeemPoints`.
- Do not let the browser mint points or reduce money through redemption.
- Do not invent a server-side redemption-price authority.
- Require the customer to be owned by the already-proven merchant.
- Out of scope: Q0b (customer lookup/write scope), SMS, loyalty policy or rates, the served adaptation, and deployment.

**Related:** [[POS-0b-checkout-integrity]] · [[SERVED-0b-R4-product-ownership]] · `functions/pos-customer-scope.js`

## Defects (proven by the old-tree run)

`posCompleteCheckout` wrote this inside its transaction:

`posCustomers/{customer.id}.loyaltyPoints = max(0, points + awarded − loyaltyRedeemPoints)`

Neither the figure nor the customer id was checked.

| Sent by the browser | Old-tree balance (starting at 100, earning 1) |
|---|---|
| `-500`, `"-500"` or `[-500]` | **601** (points minted) |
| `NaN` | **NaN** written into the balance |
| `"5"` | 96 (coerced) |
| `true` | 100 (coerced to 1) |
| `0.5` | 100.5 (a fractional balance) |
| `Infinity`, or a redemption above the balance | **0** (balance wiped) |
| `50`, with the charged total unchanged | **51** — points burned for nothing |
| another shop's customer id (by `sellerId`, by composite id, conflicting, ownerless, malformed) | **that customer's** balance moved |
| `"C_FOREIGN/nested/x"` | accepted; the id reaches a document path outside `posCustomers/{id}` |

**Why a positive redemption buys nothing.** The till shows a loyalty discount but does not put it in
`discountTotal`. Only its `grandTotal` includes it, and the server prices without any loyalty value. So a redemption
worth more than KES 1 was already refused by the total check, and any redemption that did get through moved points only.
No server-side price for a point exists on this path; three clients disagree (0.5, 0.1 and 0.01 KES).

## The repair (`functions/pos-zero-friction.js`)

1. **The figure.** `loyaltyRedeemPoints` must satisfy `Number.isInteger(x) && x >= 0`, or the call is refused as
   `invalid-argument`. That rejects every non-number, NaN, ±Infinity, fractions and negatives, before anything is
   claimed, priced or charged. If the field is omitted it defaults to 0, as before.
2. **No redemption without a price.** Any `loyaltyRedeemPoints > 0` is refused as `failed-precondition`: "Loyalty
   points cannot be redeemed at the till yet…". Honouring it would require a redemption-price authority, and none is
   invented here. **Zero stays valid.**
3. **The customer id** must be one document id: a string of 1–200 characters with no `/`. Otherwise the call is refused
   as `invalid-argument`.
4. **Customer ownership** (`_assertCustomerOwned`):
   - **The rule:** `pos-customer-scope.js`'s `ownsCustomer` — body `sellerId`, or composite id `{sellerId}_{phone}`
     matched from the left.
   - **Evaluated against:** the owners proven for this sale (`_merchantOwnerSet`: shop actor, or workspace membership
     plus the business owner). It is never evaluated against anything the request names.
   - **Stricter than the lookup rule:** a `sellerId` that is present must be a well-formed string and must be ours. A
     record whose id prefix and body disagree is therefore refused.
   - **When it runs:** before any payment is verified or claimed, and again on the transaction's own read.
   - **Refusals:** all are `permission-denied` with a stated reason — belongs to another shop, not on record as a
     customer of this shop, or unreadable owner.
   - **An id that does not exist** touches nothing and does not stop the sale, as before.

**Production measurement** (read-only, 2026-09-27; counts only):
- `posCustomers`: 0, both top level and collection group.
- `loyaltyPrograms`: 0. `posWallets`: 0.
- `posRetailSales`: 5, all with `loyaltyRedeemed: 0` and `loyaltyAwarded: 0`, and none naming a customer.
- The positive control (the sales documents and their fields) was read correctly.

Failing closed therefore excludes no real sale.

## Evidence — `scripts/test-q0a-loyalty-redemption.js` (real handler, Firestore emulator, clean database per run)

| tree | result |
|---|---|
| new | **26 / 0** |
| old (`96d31e4`) | **6 / 20 FAIL**: every L and O assertion is red because the defect happened (see the table above), and O-i crashed as `internal`, which is not counted as a refusal |

**Controls, passing on both trees:**
- a zero redemption with an owned customer earns 1 point;
- an omitted redemption;
- a composite-id customer;
- a business member serving the business owner's customer;
- no customer;
- an unknown customer id.

**Refusals:** each must have the stated code **and** reason, and no sale, stock or points may move.

**Mutation check** (one safeguard reverted at a time, in scratch copies):

| Reverted | Red |
|---|---|
| whole figure check | L-a–i |
| integer clause | L-h |
| negative clause | L-a |
| positive-redemption refusal | L-j, L-k |
| customer-id check | O-h, O-i |
| in-transaction ownership check | O-f |
| all ownership checks | O-a–g |
| malformed-owner refusal | O-d |
| `sellerId` mismatch refusal | O-a, O-e, O-f, O-g |
| unowned refusal | O-b, O-c |
| trusting the record's own claimed owner | O-a, O-b, O-c, O-e, O-f, O-g |
| pre-transaction ownership check | none: defence in depth (fail before payment), as with R4's pricing-read check |

**Regression floor:**
- 40 main suites, compared with `96d31e4`: 39 identical.
- The one difference is `test-catalogue-canonical-migration` (46/1). Its guard requires a clean
  `functions/pos-zero-friction.js` working tree, the same pre-commit reading 0b had; it reads 47/0 once committed.
- The 0b checkout emulator suite is 31/0 on both trees.

**Gates:** `predeploy-syntax-gate` exit 0.

## Boundaries and open findings (NOT fixed here)

- **The till still offers "Redeem".** Such a sale is now refused with the stated message; before, a redemption worth
  more than KES 1 was already refused by the total check. Hiding the button, and any points-payment unit, need the
  loyalty policy re-census first.
- **`posWallets/{customer.id}` (wallet tender)** is debited by id. This repair covers it only when the matching
  `posCustomers` document exists; a wallet whose customer document is absent is still reachable. Production holds 0
  `posWallets` documents. This is a separate unit.
- **`pos-crm-pro.js` `_resolveSellerId`** honours a request-supplied `sellerId`, so composite ids can be planted under
  any prefix. That is Q0b territory, as are `posLookupCustomer`, `getPOSCustomer` and `upsertPOSCustomer`.
- Also not done here: Q0b, Q0c, Q0d, the served adaptation, Quick Add, and deployment.

## L-5 port onto the POS lineage (2026-09-28)

Q0a was certified on the main line (dd9dc2a, parent 96d31e4). This section records its port onto
the POS lineage descended from the live build, as reconciliation unit **L-5**, on base `3f78a46`
(L-4, the Batch 0b port). See [[POS-0b-checkout-integrity]] and [[FINANCIAL_CORE_ARCHITECTURE]].

- **How it was ported.** Q0a's parent is Batch 0b itself, which L-4 put on this lineage. The patch to
  `functions/pos-zero-friction.js` applies **cleanly, unmodified**:
  - the figure and id checks run before anything is priced;
  - the customer pre-check runs after `_owners` (L-4's `_merchantOwnerSet`);
  - the check is repeated on the transaction's own `custSnap`.

  The test suite is carried verbatim.
- **Its one dependency was already present.** `functions/pos-customer-scope.js` (`OWNER_FIELD`,
  `ownsCustomer`) has the **same blob** (`d3fcbc99`) here as on the main line, so no customer-scope code was
  carried or changed.
- **Scope held to the loyalty invariant:**
  - Q0b-1's later refactor onto a shared `classifyCustomer` is **not** carried;
  - `getPOSCustomer`, `posLookupCustomer` and `upsertPOSCustomer` are untouched.
  They remain L-6 and the separately recorded `getPOSCustomer` item.
- **Boundary note, updated for this lineage:** the `_resolveSellerId` finding above is already closed here by
  L-2 (a085031). The `posWallets/{customer.id}` gap is still open, as a separate unit.
- **Evidence:**
  - 26/0 on the port vs 6/20 on `3f78a46`, the same profile as the main line. Every old red is a mint,
    coercion, burn or cross-tenant write, and all six controls pass on both trees.
  - 11 of 12 mutants are caught. The survivor is the pre-transaction customer check, the documented
    defence in depth (table above).
  - Floor and earlier units: see CHANGELOG 163.
- **Not deployed.**
