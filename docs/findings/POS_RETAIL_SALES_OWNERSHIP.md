# posRetailSales — ownership field, and an unverified write-path gap

**Status:** OPEN · **Owner:** POS / payments track · **Raised by:** merchant-v2 migration, 2026-08-26
**Boundary:** the merchant-v2 workstream did NOT change `posCompleteCheckout` or any rule.

Related: [[project_posretailsales_field_divergence]] · [[project_pos_authority_root]] ·
[[project_users_merchantid_forgeable]] · [[reference_deployed_ruleset_authority]]

---

## The measurable symptom

**5 documents · KES 13,680 of POS sales are unreadable by the merchant who made them.**

That is the entire `posRetailSales` collection (no `nextPageToken` — this is not a sample).

| | count |
|---|---|
| `sellerId` **and** `merchantId` | 0 |
| `merchantId` only — **denied** | **5** |
| `sellerId` only | 0 |

Read via the Firestore REST API, 2026-08-26.

## Why every read is denied

The **served** ruleset — `f1c4e35b-bcc2-418b-b7a3-8990c1c8dad0`, release updated 2026-08-23,
fetched from `firebaserules.googleapis.com`, not from a repo file:

```
match /posRetailSales/{saleId} {
  allow read:  if isAdmin()
               || (isAuthed() && resource.data.sellerId  == request.auth.uid)
               || (isAuthed() && resource.data.cashierUid == request.auth.uid);
  allow write: if false; /* CF Admin SDK only */
}
```

Fields actually present on a live sale:

```
branchId, cashierId, channel, checkoutStartedAt, couponCode, couponDiscount, createdAt,
customer, discountTotal, grandTotal, id, idempotencyKey, items, loyaltyAwarded,
loyaltyRedeemed, merchantId, payments, saleDate, sellerUid, shiftId, shopId, status,
subtotal, taxTotal
```

Both predicates miss, and both misses are one word wide:

| rule checks | document has |
|---|---|
| `sellerId` | `sellerUid` |
| `cashierUid` | `cashierId` |

A query must also *constrain* on the authorised field: `where('merchantId','==',uid)` does not
prove `sellerId == uid`, so Firestore rejects the whole query rather than filtering it.

## Why the committed fix did not take

There are **two writers**.

- `functions/pos-retail-mirror.js` → `mapTxnToRetail` emits **both** `merchantId` and
  `sellerId` (`pos-retail-mirror-map.js:15`, *"satisfies the posRetailSales read rule
  directly"*). Landed in `9a70309`, **2026-08-09** — an ancestor of both `main` and the
  migration branch.
- `functions/pos-zero-friction.js:770` → `posCompleteCheckout` writes the sale document
  directly. **This is what produced all five live records**, which is why `sellerId` is absent
  from every one of them despite the mirror fix predating them by two weeks.

Reading the repo suggested the divergence was fixed. Only the live documents showed it was not.

## Which field should carry ownership

**Not `sellerUid`.** `posCompleteCheckout` never writes it — it arrives through `...metadata`,
spread from caller input. Keying a security rule to it would make ownership client-declared,
the same class as [[project_users_merchantid_forgeable]].

**`merchantId` is the better candidate.** In `posCompleteCheckout` it **is the shopId** (the
till sends `merchantId: scope.shopId`), and `resolveActor(cashierId, merchantId)` verifies it
against `shops/{uid}` — by document id, per its own comment, *"so ownership cannot be forged by
writing a field."* `cashierId` is server-derived via `_assertAuth(auth)`. `pos-intelligence.js`
already queries on `merchantId`.

## The gap — UNVERIFIED, please confirm before acting

`resolveActor` is awaited, but its `ok:false` branch sits **inside the manual-discount block**
and refuses only a discount:

```js
if (!_actor || !_actor.ok) {
  _e('A discount needs an identified member of staff. ' + ...,
     'permission-denied');
}
```

Between that check and `collection('posRetailSales').doc(saleId).set(sale)`, `_actor` is
referenced only for discount capability. **A sale with no discount therefore appears to be
written with the caller's claimed `merchantId` without the employment result gating it.**

This was found by reading one segment of `posCompleteCheckout`. It was **not executed, and no
earlier guard search was exhaustive.** Treat it as a question, not a confirmed defect. If an
earlier guard exists, this note is wrong and should be closed as such.

## Suggested order (owner's call)

1. **Verify or refute the gap.** Does a no-discount sale from a non-employee write a document
   attributed to another shop?
2. If real, make the employment result gate the **write**, not just the discount.
3. Align rule + writer on **`merchantId`** — and only then, because repairing history against an
   authority that still accepts bad attributions would have to be done twice.
4. **Backfill the 5 records** — surgical and auditable: ids, prior field set, added field,
   count before/after, **no amount / status / payment mutation**. Add the canonical field;
   do not delete or rename `merchantId` / `sellerUid`.
5. Prove **5/5** readable by their owner against the live collection.

Deliberately **not** done here: no rule widened, no `merchantId`-satisfies-the-rule shortcut,
no backfill ahead of the authority fix.

## What this blocks

merchant-v2 cannot converge onto `SokoniOrderService` → `SokoniAnalyticsEngine.compute()`,
because a `sellerId`-scoped POS provider returns **zero rows** today. Building it now would
yield a parity test that passes because *both* sides read an empty POS set — a green proof over
nothing, at financial-authority scale.

Consequently **Dashboard money tiles render a neutral dash**, with an on-screen explanation.
One flag, `POS_SALES_READABLE` in `merchant-v2.html`, flips them on when this is repaired; the
wiring behind it is finished and gated by `scripts/test-analytics-parity.js`.
