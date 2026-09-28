# L-9C — Disposition of c4f6ced ("a till sells only its own shop's products, to its own shop's customers")

**Status:** decided 2026-09-28. **Documentation only**: no production code, test, rule or certified authority
changes with this record.
**Related:** [[POS-0b-checkout-integrity]] (0b, L-4, L-9A), [[POS-Q0a-loyalty-redemption]] (L-5),
[[POS-Q0b1-customer-scope]] (L-6), [[FINANCIAL_CORE_ARCHITECTURE]].

## Decision

**c4f6ced is not ported to the POS lineage.** On this lineage the product rule is 0b's `_assertProductOwned`
(L-4, with L-9A's transactional owner set), and the customer rule is L-5/L-6's `_assertCustomerOwned` on
`pos-customer-scope.classifyCustomer`. c4f6ced's two checks are **not equivalent** to either, and neither side is
uniformly stricter. Porting c4f6ced would add a competing authority, not retire one.

A future merge of `feat/creator-hub` into this lineage (or the reverse) **must resolve both rules explicitly toward
this lineage's certified semantics**. It must never let c4f6ced's code or its tests (`test-pos-gate-behavioural`
Part E) land beside them silently.

## Where each lives (verified read-only, 2026-09-28)

| | c4f6ced | this lineage |
|---|---|---|
| Branch | `feat/creator-hub` (tip `4e9607b`), parent `5649e46` | `pos-safety/*` chain, `53ff924` → … → `8ab3b3d` |
| Contains the other? | lacks the live base `53ff924`, P0 `ed57196` and 0b `96d31e4` | lacks c4f6ced |
| Common ancestor | `ec64f4f` ("retire PayPal") | same |

The two rules meet **only** on a cross-line merge.

## What c4f6ced does

In `posCompleteCheckout` (creator-hub):
- **Product:** `_ownerOfProduct(p) = p.shopId || p.sellerUid` must equal the request's `merchantId`. It is checked
  on the pricing read and again inside the stock transaction, and a failure is `permission-denied`
  ("does not belong to this shop").
- **Customer:** a named, existing customer must pass
  `pos-customer-scope.ownsCustomer(id, data, merchantId)`. The check runs inside the transaction, and a failure is `permission-denied`
  ("not a customer of this shop").

Its finding was **real**: the checkout priced and deducted any product id, and updated any `posCustomers` id. That
finding stands as history. On this lineage the same defects were closed by 0b R4 (products) and Q0a/Q0b-1 (customers).

## Why the product rules are not equivalent

| Case | 0b `_assertProductOwned` (this lineage) | c4f6ced `_ownerOfProduct` |
|---|---|---|
| Fields read | every present field of 7 (`sellerUid`, `sellerId`, `shopId`, `merchantId`, `storeId`, `ownerId`, `ownerUid`) | `shopId`, falling back to `sellerUid` only |
| Accepted identities | the owner set proven for the sale: the shop plus the business resolved from the owner's uid; on the membership path, the proven business and its `ownerId` from the transaction's own read (L-9A) | exactly the request's `merchantId` |
| Conflicting fields (e.g. `shopId` ours, `sellerId` foreign) | **refused** | accepted |
| Empty `shopId` with `sellerUid` set | **refused** (unreadable owner) | falls back to `sellerUid` |
| Foreign value in `storeId`/`ownerId`/`ownerUid`/`merchantId`/`sellerId` | **refused** | ignored |
| Product owned by the business id, or by its owner, sold on the membership path (0b R4-W1, `P_WS2`) | accepted | **refused** |
| Product stamped only with `merchantId`/`sellerId`/`storeId` | accepted if in the owner set | **refused** |
| Owner value with stray whitespace | accepted (trimmed) | **refused** |

**Neither is uniformly stricter.** A port would therefore change certified outcomes in both directions.

## Why the customer rule is superseded

`ownsCustomer(id, data, merchantId)` accepts a body `sellerId` equal to the merchant, **or** a composite id prefixed
by it, and it checks against the request's `merchantId` alone. L-6's `classifyCustomer` is strict:
- a present `sellerId` must be well-formed and in the proven owner set, even when the id prefix matches (the X-6b case:
  our prefix with a foreign `sellerId` is refused by L-6, but accepted by `ownsCustomer`);
- a malformed or unowned record is refused;
- the owners are the proven set, not the request's claim.

L-5/L-6 are certified on this lineage (Q0a 26/0, Q0b-1 40/0).

## The `businesses.ownerId` remark

c4f6ced's comment says "never `businesses.ownerId`: that field is client-writable". L-9A tested that:
- it is **true for this lineage's repository rules**, where a client can create a business with any `ownerId`, and its owner can change it;
- it is **false for the live ruleset** `6c67a34d`, where no client can write it.

0b's membership path does use the business's `ownerId`. L-9A (`8ab3b3d`) closed the time-of-check/time-of-use race
on it. The residual dependency, and the rule that **this lineage's repository `firestore.rules` must not be deployed as-is**, are
recorded in [[POS-0b-checkout-integrity]] and CHANGELOG 167. This disposition does not change either.

## Tests that would collide on a merge

- c4f6ced's `test-pos-gate-behavioural` Part E (E0–E9) edits the same file as this lineage's 0b fixture change and the
  L-9A A9 synchronisation.
- Its assertions match c4f6ced's own messages (`/does not belong to this shop/`, `/not a customer of this shop/`), so they
  would fail against this lineage's messages even where the two rules agree.
- Its expectations cover own, foreign, mixed, ownerless and legacy (`sellerUid`-only) products, a cashier, and
  customers (E0–E9). They have no membership-path case, so they cannot surface the semantic difference in the table above.

A merge must port Part E's **intent** onto this lineage's semantics, not its text.

## Explicitly not decided here

- **`recordPOSSale`'s product check** (L-9B) is fail-open for ownerless, `shopId`-only, `ownerId`/`storeId`-only and conflicting
  products. Production measured 2026-09-28T13:13Z: 102/102 products carry `sellerUid`, and 0 are ownerless or conflicting. The repair
  is held as its own unit, because it touches M0-2.
- Any change to rules, to `_assertProductOwned` or to `_assertCustomerOwned`.
- **Not deployed.**
