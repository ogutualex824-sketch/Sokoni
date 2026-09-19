# P1–P4 — the four offer-persistence decisions, made observable

**Status:** RECOMMENDED · awaiting owner sign-off
**Date:** 2026-09-19 · **Gate:** P (architecture decision gate)
**Evidence:** `scripts/test-offer-authority-boundary.js` — **35/0, 4 observed**
**Design half:** [[Offer Persistence Architecture]] — 64/0

No implementation. No rules change. No functions touched. Nothing deployed.

Each decision below carries the evidence it rests on and **the predicate that makes it
observable** — what must be true for the decision to be honoured, expressed as something a
suite can check rather than a paragraph someone must remember.

---

## P1 · Collection authority

**Recommendation: a new collection, `shopOffers`. Proposal only until P2–P4 settle.**

Three concepts, three authorities, and the evidence that they are genuinely different:

| | writer | authorises via | anchored on | affects a charge? |
|---|---|---|---|---|
| `offers` | client-direct | Firestore rules, `isAdmin()` | `productId` | yes, admin sets the price |
| `promotions` | `promotionUpsert` / `createPromotion` | callables, `_assertAdmin` | placement · promo `code` | banner no; promo code yes |
| **`shopOffers`** | *(proposed callable)* | `assertShopAccess` | `shopId` | yes, merchant sets it |

Scoping by a `shopId` **field** rather than by path matches the products authority, whose
`assertInScope` already works that way — so the same isolation reasoning transfers instead of
a second convention being invented.

> **Observable.** No merchant-offer surface may name `offers`, `promotions` or
> `promotionUsage`. The record module names **no collection at all** today, which is the
> strongest form of this and is asserted. `shopOffers` must not appear as a live identifier
> while it is still a proposal — also asserted.

### The cost of aliasing is already visible in this repo

`promotions` carries **two incompatible document shapes**:

```
promotionUpsert  (functions/promotions.js)  placement · title · body · ctaUrl · status
createPromotion  (functions/finos.js)       code · discountType · fundedBy · usageCount · isActive
```

Both admin-only, both writing one collection, with no discriminator between them. This is
**not a Gate P defect and is not repaired here** — it is recorded because it is the concrete
demonstration of exactly what P1's no-aliasing rule exists to prevent.

**Contained, and the containment is pinned:** the public banner read filters
`status == 'published'`, and a promo code has no `status` field at all — it has `isActive` —
so promo codes cannot surface as banners to customers. The suite asserts that filter, so if
it is ever removed this fails loudly. `promotionList` (admin) does **not** filter, so the
admin listing renders promo codes as banners with undefined `title` and `placement`. Display
only, admin only, recorded so it is not rediscovered as new.

---

## P2 · Write authorization

**Recommendation: an authenticated callable, `assertShopAccess(uid, shopId)`, App Check
enforced, idempotent inside a transaction.**

`resolveShopAccess` already defines exactly three ways in and refuses everything else:

```
owner     → role 'owner',  via 'owner'
employee  → role from shopEmployees, via 'employee'   (cashier · manager · inventory · support)
admin     → role 'admin',  via 'admin'
otherwise → permission-denied, "You do not have access to this shop."
```

**Admin behaviour is defined, not inferred** — `via: 'admin'` is an explicit branch. The
open sub-decision is narrower than it first appears: *which of the four employee roles may
publish an offer, versus only draft one.* `posRole` is minted by nothing and must never
become an offer permission; asserted.

The write shape is already established by `merchantAdjustStock` and should be copied rather
than reinvented: authenticate → validate → **authorise against the shop, never a claim** →
apply once via a caller-supplied id, inside a transaction, with `enforceAppCheck: true`.
All four properties are asserted against that reference.

> **Observable, once implemented.** An authenticated non-member produces **zero writes**,
> proven by querying the store afterwards rather than by reading a return value. A permitted
> role writes. An admin writes by the `via: 'admin'` path explicitly. Currently UNPROVEN —
> it needs the callable to exist.

---

## P3 · Redemption accounting

**Recommendation: a separate counter. Do not reuse `promotionUsage`.**

`promotionUsage` is written only by the FinOS money layer, and redemption there carries
**funding attribution** — `fundedBy`, `platformFundingPct`, `sellerFundingPct` — recording
*who paid for the discount*. It increments `promotions/{id}.usageCount` transactionally and
files the buyer and order the money was spent against.

A merchant's bundle discount is funded by the merchant **by definition**. Writing it into
that ledger would file merchant-funded money against a platform funding split — a
settlement-attribution error, not a naming inconvenience. The name sounds right, which is
precisely the trap.

The counter merchant offers need is also a different quantity: `inventoryLimit` asks *how
many packages remain*, which is stock-shaped, while `perCustomerLimit` and
`totalRedemptionLimit` are redemption-shaped. The offer view already refuses to show a
remainder unless both a declared limit and a real sold figure exist — absent is unmetered,
never exhausted — so whatever is chosen must supply a real observation or none.

> **Observable.** No merchant offer surface references `promotionUsage` or writes
> `usageCount` — asserted today across the offers studio, the promotion model and the record
> module. Which counter replaces it is UNPROVEN until decided.

---

## P4 · Checkout resolution boundary

**Recommendation: the authoritative decision happens in the charge path. The customer
resolver stays a display quote.**

The precedent is already set in `createCheckoutSession`, and it was set by fixing this exact
class of bug: checkout once held its own hardcoded code map and subtracted a discount from
the figure it *displayed*, so `serverTotal` never included it and buyers were **billed more
than they were quoted**.

What the charge path does now, all asserted on stripped code rather than on its comments:

* the discount is computed from the **validator's** result, never from client input;
* the client contributes a **code string and nothing else** — no client-supplied discount
  amount is read anywhere;
* the discount is capped against the server subtotal;
* an invalid code is ignored rather than fatal, so a bad code cannot block a real purchase;
* the delivery fee is likewise resolved server-side.

Merchant offers must enter at the same point and obey the same rule: **the client may name
an offer; it may never assert a discount.**

> **Observable.** Every customer surface still tells the buyer the price is confirmed at
> checkout, and the promotion model still declares itself a display quote — asserted, so the
> promise cannot quietly lapse. The client resolver has no charge path of its own —
> asserted. Merchant offers actually applied at charge time is UNPROVEN until the
> server-side resolver exists.

---

## What the implementation gate is then scoped to

Once P1–P4 are signed off, implementation is narrow: **one callable and its persistence
contract.** The schema is certified (64/0), the authority boundary is pinned (35/0), the
client seam is `ctx.listOffers()` / `ctx.saveOffer()`, and nothing in the composer, calendar,
preview, card or offer panel changes.

It still cannot ship while Cloud Functions deploys are frozen under
[[project_ar_canary_forensics]] — a separate constraint with its own owner and exit
condition, not a reason to route the write through rules instead.

Related: [[Offer Persistence Architecture]] · [[Offer Persistence Decision]] ·
[[project_merchant_offer_store_absent]] · [[project_workforce_authority_convergence]]
