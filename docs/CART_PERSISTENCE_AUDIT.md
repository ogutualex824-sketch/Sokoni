# Cart Persistence — Audit and Track 2 Plan

**Status:** Audit complete. **2.1, 2.2A and 2.2B done (not deployed); 2.3–2.7 not started.**
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
| **2.2A** | canonical client cart service, built inert | **done, not deployed** — see below |
| **2.2B** | `market-actions.js` migrated onto SokoniCart | **done, not deployed** |
| 2.3 | migrate 17 writers / 27 readers | one surface at a time, as Track 3 |
| 2.4 | checkout boundary | `checkout.html` holds 10 references incl. both post-order `removeItem('cart')` calls — inside the do-not-modify perimeter |
| 2.5 | food-hub `sokoniCart` bridge | |
| 2.6 | remove the global `setItem` interceptor | only safe once 2.2–2.5 land |
| 2.7 | cart isolation / persistence suite | |

**The 2.2 decision is made:** canonical client service first, `localStorage['cart']` retained as
the store, authenticated persistence deferred to a separate capability behind the same service.
A server-authoritative cart is NOT being built now.

---

## Slice 2.2A — the SokoniCart service (done, inert)

`sokoni-cart.js` exposes `window.SokoniCart`. **No page loads it yet** — it ships unreferenced
so the service and the migration can be reviewed separately.

### Review changes (2026-08-12)

Two changes were required at review before any writer moves, and both are in:

* **`merge` keys on `cartId`.** Two food lines can share an id and differ only by note
  ("extra ugali" / "no ugali"); merging by id would discard a shopper instruction. A product
  merge is also barred from landing on a food row.
* **`subtotal()` removed.** The figure was honest, but a money total on a shared service
  invites a call site to render it as the authoritative amount — the server decides that in
  `verifyIntasendPayment`. Pages compute display totals where they display them. A test now
  guards against it being added back.

Writing the `cartId` merge test exposed a real defect: `merge` added `times` rather than
`times × the item’s own qty`, so merging a food row carrying `qty:2` added **one** unit and
the shopper would have been charged for one dish instead of two. Merge and append now
provably charge the same, asserted as an invariant across three item shapes.

### Known, considered, deliberately NOT changed

* **Numeric refs are array indices.** `setQty(3, …)` means index 3; a numeric product id
  passed during migration would edit the wrong row. Raised at review and left as-is —
  revisit if a migrated writer needs id-based qty updates.
* **No cross-tab safety.** Two tabs diverge and the last write wins, silently. The current
  per-page code has the same flaw, so this is not a regression, but a single service is the
  natural place to fix it later.

### The design constraint that shaped everything

`checkout.html:2443` sends `orderItems: cart` — the raw array — to `verifyIntasendPayment`,
which resolves `item.id || item.productId` against the product catalogue and
`item.qty || item.quantity` for its price cross-check. **The cart item shape is a
server-facing payment contract**, not a UI convention. So the service preserves the shape
exactly and normalises nothing; a field it "tidied" would change what lands in an order.

### Two quantity models, both live, both kept

```
product.js   pushes N DUPLICATE rows, no qty field
cart.js      reads a qty field on a single row
```

Both charge correctly — the server multiplies unit price by qty and sums. They differ in what
a COUNT means, and the platform already disagrees with itself:

```
shared-header.js:1250   cart.reduce((s,i) => s + (i.qty||1), 0)   -> units
market-actions.js:71    _loadCart().length                        -> lines
```

For one product added three times via `product.js` both read 3; via a `qty` field the header
reads 3 and the card badges read 1. Choosing a winner would silently change badge numbers on
live pages, so the service exposes **both** `lines()` and `units()`, and every migrated call
site must say which it meant. Convergence is a later, deliberate decision.

### DECIDED 2026-08-12 — the badge converges on **units**

`market-actions.js` adopts the `shared-header.js` formula, `Σ(qty||1)`. Evidence:

* 311 pages already read units; only 5 read lines.
* **All 5 of those pages also load `shared-header.js`**, and the two badges target different
  elements (`_syncBadges` deliberately excludes the header pip) — so both are on screen at
  once, disagreeing whenever an item carries a `qty` field.
* A shopper with one item at qty 3 should see 3.

Effect when `market-actions.js` is migrated in 2.3: on those 5 pages a qty-field item goes
1 → 3 (now agreeing with the header); duplicate-row items are unchanged at 3. No change on
the other 306 pages. The convergence happens once, at that call site, not as a side effect
spread across the migration.

### Deliberately NOT uid-scoped

The opposite of the wishlist. A cart is filled by shoppers who have not signed in; stamping an
owner would empty every anonymous visitor’s cart. Assertion K pins this: no `firebaseAuth`,
no uid in the key, no auth listener.

### Writes stay interceptable

The service writes through ordinary `localStorage.setItem('cart', ...)` **on purpose**, so
`provider-wiring.js`’s `cart` ⇄ `sokoniCart` bridge keeps firing. Bypassing it would
desynchronise the food hub. The interceptor comes out in 2.6.

### Verified — 78/78 (`scripts/test-cart-service-contract.js`)

Fixtures in the exact shapes the current writers emit, replayed through the real consumer
logic transcribed from `checkout.html`, `cart.js` and `verifyIntasendPayment`. The assertions
that matter are the ones proving the service does *not* tidy: field-for-field round trip,
duplicate rows preserved, both count models reproduced, corruption quarantined.

One behaviour change, deliberate and asserted: `add()` stores a **copy** per push.
`product.js` currently pushes the same object reference N times, so editing one line silently
edits all of them. Copying cannot alter totals and stops that leak.

---

## Slice 2.2B — market-actions.js migrated (done)

The first writer on the service. Chosen because it is already scheduled for 2.3, its badge
semantics were the ones moving to `units()`, it exercises add/remove/toggle/read, and it
needs nothing from the frozen checkout boundary.

```
market-actions.js  ->  SokoniCart  ->  localStorage['cart']
```

### What moved

* `_readList` / `_loadCart` / `_saveCart` deleted. The corruption quarantine they carried
  was not lost — it lives in the service now, so every surface gets it rather than this one.
* `addToCart` / `removeFromCart` / `toggleCart` / `isInCart` go through the service.
* `_syncBadges` counts `units()`. On these five pages the card badge and the header pip now
  agree; before, an item with a `qty` field showed 3 in the header and 1 on the card.
* The private `_emitCartChanged` is gone — the service emits on every mutation. The file
  now *subscribes* instead, so its badges also refresh when an unmigrated surface writes.
  Previously they went stale until the next page load.

### One service addition: `removeAllById`

`removeFromCart` has always been `filter(c => c.id !== id)` — every line with that id —
because the card button is a per-PRODUCT toggle: "remove from cart" means the product is
gone, not one unit of it. Routing it through `removeById` (single line) would have quietly
changed that button's meaning on five live pages whenever another writer had created
duplicate rows. The service offers both; the call site says which it means.

### Fails closed

Without `SokoniCart` the buttons say "Cart is still loading" and write nothing. The old
fallback — writing `localStorage` directly — is exactly what this migration removes, and a
button that appears to work while storing nothing is the defect Track 2.1 was about. All
five consumer pages load the service; asserted, because a missing `<script>` tag is
invisible to per-file scanning and is how three pages shipped migrated-but-inert in Track 3.

### Verified — 63/63 (`scripts/test-cart-market-actions.js`)

Runs the shipped `market-actions.js` and `sokoni-cart.js` together in one sandbox. Covers
every condition in the 2.2B gate, including the negative ones: a failed write is reported
rather than swallowed, no direct cart persistence remains, no second writer appeared, and
the frozen perimeter is untouched.

### Retired assertions

Three assertions in the 2.2A suite asserted the service ships INERT — no page loading it,
no writer migrated. 2.2B deliberately ended both, so they were **removed and named** rather
than relaxed, and blast-radius checking moved to the 2.2B suite. The 2.2A suite keeps the
part still worth failing on: the frozen perimeter. It now stands at 76/76.
