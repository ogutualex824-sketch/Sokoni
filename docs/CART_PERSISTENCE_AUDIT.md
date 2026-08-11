# Cart Persistence — Audit and Track 2 Plan

**Status:** Audit complete. **Slice 2.1 done (not deployed); 2.2–2.7 not started.**
Related: [[WISHLIST_CANONICALISATION]] · [[Commerce Lifecycle]] · [[CANONICAL_COLLECTIONS]]

---

## Why this is not the wishlist again

Track 3 succeeded because **the correct server model already existed and the UI simply
never used it** — the work was pointing surfaces at `wishlistItems/{uid}_{productId}`.

**Cart has no such model.** The nearest thing, `carts/{uid}/items`, is a KASS-only stub that
cannot hold what the client cart carries. Track 2 is therefore a *design* decision followed
by a migration, not a migration. Assuming otherwise is the main way this goes wrong.

---

## Five places a cart lives

| # | location | writers / readers | notes |
|---|---|---|---|
| 1 | `localStorage['cart']` | **17 W / 27 R, 13 files** | the de facto authority |
| 2 | `localStorage['sokoniCart']` | 1 W / 2 R | food-hub key, bridged to #1 |
| 3 | `carts/{uid}/items/{productId}` | KASS only | **no client reader, no rule** |
| 4 | `userSync/{uid}/kv/cart` | `sokoni-sync.js` | opaque blob, cross-device restore |
| 5 | `localStorage['retrievedCart']` | 1 W / **0 R** | dead write, `pos-completeness.html` |

Counted by an executable-code scan (comments excluded, inline `<script>` included) using the
stripper built for the Track 3 sweep.

### Two things that do not show up in a file-by-file read

* **`localStorage.setItem` is monkey-patched.** `provider-wiring.js` wraps it to mirror
  `cart` ↔ `sokoniCart` on every write. It is injected **dynamically** by `security.js`,
  which 288 pages load — so it is active almost everywhere and invisible to any
  `<script src>` search. Any cart service must be designed knowing an interceptor sits
  under every write.
* **`sokoni-sync.js` is injected the same way** and mirrors both cart keys into
  `userSync/{uid}/kv` as raw strings.

### Shape divergence within `localStorage['cart']`

The one key does not hold one shape:

* `product.js` encodes quantity by **pushing N duplicate objects**; `cart.js` reads a `qty`
  field. Two quantity models in one array.
* Food items carry `cartId` and `restaurantId` for vendor grouping (`cart.js`).
* Product items may carry `selectedSize`, `selectedColor`, `selectedVariants`.
* `checkout.html` derives `pickupCoords` from `cart[0].sellerLat/sellerLng`.

`carts/{uid}/items` stores `{productId, productName, quantity, price, sellerUid}` and has
**none** of these. Adopting it as the canonical model would silently drop food orders,
variants, and delivery pickup coordinates.

---

## Slice 2.1 — KASS cart truth (done)

### The defect

```
KASS add_to_cart ──▶ carts/{uid}/items ──▶ "Added 2x Unga to your cart"
                                       ──▶ [🛒 View Cart] ──▶ cart.html
                                                          ──▶ localStorage['cart']
                                                          ✗ empty
```

`view_cart` read the same private collection, so KASS confirmed back its own writes — the
handlers were consistent with each other and wrong about the world. `kass-widget.js` stamps
a green ✅ panel on any reply matching `/added|saved|booked|…/`, certifying it visually.

Worse, `view_cart` reported a **`KES` total computed from `input.price`** — a number supplied
by the language model, never read from the catalogue.

### Why it could not be "fixed properly"

`localStorage` is client-side; `sokoniChat` is a server function. There is **no path** from
KASS to the cart the shopper sees. Every option that keeps the feature today requires a new
client-side cart writer — the eighteenth — a week before Track 2.2 sets out to consolidate
them. So the slice makes the endpoint honest and defers the feature.

### What changed

* `add_to_cart` writes nothing; resolves `products/{id}`; returns a link with
  `added:false, requiresUserAction:true`. Name and price come from the catalogue.
  `price` and `sellerUid` **removed from the tool schema**.
* `view_cart` reports no count, no total, and never claims the cart is empty.
* Tool descriptions and the system prompt forbid the model claiming "added" or guessing a
  count — the handler cannot control the model's prose, so the description is part of the fix.

**47/47** — `scripts/test-kass-cart-truth.js`. The handlers are not exported (Firebase
deploys every export as a Cloud Function), so the suite slices `_execChatTool` out of the
shipped source and runs it in a `vm` sandbox against a real emulator.

> The assertion worth keeping: block **H** reads `_isSuccessMsg`'s regex out of
> `kass-widget.js` and requires that neither handler produce a message that would trigger the
> green tick. An early draft of the `view_cart` copy ended *"everything you've added"* and
> failed it. Wording is part of the contract when a regex on prose drives the UI.

---

## Remaining sequence

| slice | scope | gate |
|---|---|---|
| **2.1** | KASS cart truth | **done, not deployed** |
| 2.2 | canonical client cart service | design decision first: local service + optional authenticated persistence, **or** a real server cart |
| 2.3 | migrate 17 writers / 27 readers | one surface at a time, as Track 3 |
| 2.4 | checkout boundary | `checkout.html` holds 10 references incl. both post-order `removeItem('cart')` calls — inside the do-not-modify perimeter |
| 2.5 | food-hub `sokoniCart` bridge | |
| 2.6 | remove the global `setItem` interceptor | only safe once 2.2–2.5 land |
| 2.7 | cart isolation / persistence suite | |

**The 2.2 decision is not made.** The audit proves only what cannot be done: the existing
`carts/` model cannot be adopted as-is. Whether SOKONI needs a server cart at all is open.
