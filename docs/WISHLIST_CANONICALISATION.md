# Wishlist Canonicalisation

**Status:** Engineering complete, **not deployed**. Track 3 of the Premium KassShop program.
**Canonical record:** `wishlistItems/{uid}_{productId}`
**Client authority:** `sokoni-wishlist.js` → `window.SokoniWishlist`
**Transport:** `commerceDispatch({op:'wishlistAdd'|'wishlistRemove'|'wishlistGet'})`

Related: [[CANONICAL_COLLECTIONS]] · [[Commerce Lifecycle]] · [[KNOWN_LIMITATIONS]] ·
[[RULES_RECONCILIATION]]

---

## What was wrong

Four wishlist models were live simultaneously, and no two agreed.

| model | written by | reached the wishlist page? |
|---|---|---|
| `localStorage['wishlist']` | product.js, category.js, script.js, cart.js, market-actions.js, flashsale.html | no |
| `localStorage['sokoniWishlist']` | **nothing** — zero writers repo-wide | no |
| `wishlistItems/{uid}_{productId}` | the server model — correct, and unused by the UI | — |
| `wishlists/{uid}.items[]` | KASS `save_to_wishlist` | the page's own reader only |

The server model was already right. Deterministic `{uid}_{productId}` ids make add and remove
idempotent by construction, and `where('uid','==',auth.uid)` scopes every read to the caller.
**Nothing about the data model needed designing; the UI simply never used it.**

The consequence was not cosmetic. Because the UI read `localStorage`, wishlist state belonged to
a **device**, not an account. A clean `sokoniSignOut()` wiped it, but a force-quit, a session
restored as another user, or any path that skipped the sign-out handler left one shopper looking
at another shopper's saved items — the same shape as the Shop Details identity defect.

`localStorage['sokoniWishlist']` is worth its own line: `inspiq.js` read it to score category
interest, and **nothing had ever written it**, so the personalisation signal was permanently
empty. It read as working code.

---

## The rule

> There is exactly one wishlist authority: `SokoniWishlist`, backed by
> `wishlistItems/{uid}_{productId}`. `localStorage` is a paint cache, never an authority.
> The cache is stamped with the owning uid and discarded the moment that uid does not match
> the live session, so it cannot resurrect another account's saved items.

Ownership comes from Firebase Auth and nothing else — never `localStorage.sokoniUser` (a cached
profile blob is not an identity), never a URL parameter, never a shop or seller id.

There is deliberately **no Firestore rule** for `wishlistItems`. It is a CF-only collection, so a
client cannot reach it except through the authenticated, App-Check-enforced dispatch. That is the
boundary, not an oversight.

---

## Migration order

Each surface was migrated and verified on its own before the next began. One surface at a time is
what kept the migration reversible.

| phase | surface | suite |
|---|---|---|
| 4.1 | `product.js` / `product.html` | `test-wishlist-canonical.js` |
| 4.2 | `category.js` / `category.html` | `test-wishlist-category.js` |
| 4.3 | `script.js` / `index.html` | `test-wishlist-marketplace.js` |
| 4.4 | `market-actions.js` + 5 consumer pages | `test-wishlist-market-actions.js` |
| 4.5 | `wishlist.html` — canonical read, `wl-fs` Firebase app removed | `test-wishlist-page.js` |
| 4.6 | `inspiq.js` — dead `sokoniWishlist` reader removed | assertion W, same suite |
| 4.7 | `cart.js`, `profile.js`, `flashsale.html`; `wishlist.js` deleted | `test-wishlist-phase47.js` |
| — | cross-surface agreement | `test-wishlist-cross-surface.js` |

**289 assertions pass, 0 fail.** Four are recorded INCONCLUSIVE and are documented as such; none
was converted to a pass.

---

## What migration changed about failure

A wishlist save used to be a `localStorage` write, which cannot fail. It is now a server call,
which can. Every migrated surface had to grow a failure path it never had, and two of them
contained a latent data-loss bug that only became reachable once the operation could fail:

* **`cart.js` `moveToWishlist()`** removed the cart line *unconditionally*. Written naively
  against an async save, a signed-out shopper, an offline moment or a permission error would have
  emptied the cart row and saved nothing. "Move" is now **remove-after-add**: the cart line is
  dropped only once the canonical write resolves, and the item is re-located by identity rather
  than by the now-stale index. On failure the item stays in the cart and the toast says so.
* **`flashsale.html` `fsAddWish()`** showed "Added to wishlist ❤️" before anything was saved.

Both are asserted directly (`phase47` blocks D, G, I) rather than inferred.

`profile.js` had a wishlist count reading the legacy key into `#wishlistCount`, an element
`profile.html` no longer contains. It was removed rather than rerouted. If a wishlist count
returns to that page it must come from `SokoniWishlist.count()` **after** `load()` resolves, and
must render `—` until then: an unresolved read displayed as `0` tells an owner their saved items
are gone. See the standing rule in `CLAUDE.md` on UI data integrity.

`load()` **rejects** on failure and never resolves `[]`. An empty list is a claim, and a wrong one
makes every heart look un-saved and invites a duplicate add. `wishlist.html` renders an explicit
error state — "Your saved items are safe — we just can't show them right now" — with a retry.

---

## Pages must load the service

A page that calls `SokoniWishlist` without loading `sokoni-wishlist.js` fails **closed and
silently**: every heart answers "Wishlist is still loading" forever. `car-hub.html`,
`healthcare.html` and `services.html` shipped in exactly that state after Phase 4.4, because
per-file scanning cannot see a missing `<script>` tag. Assertion **L** in `test-wishlist-phase47.js`
now derives the consumer list from the repo and fails if any consumer page omits the tag.

---

## The final invariant

```
localStorage['wishlist']        executable writers: 0   readers: 0
localStorage['sokoniWishlist']  executable writers: 0   readers: 0
```

Enforced by `scripts/scan-legacy-wishlist.js`, which covers `.js` files and inline `<script>`
blocks in `.html`, excludes comments, and classifies each hit as READ / WRITE / DELETE.

Two things make it trustworthy rather than merely green:

1. **Positive controls.** Assertion M feeds it synthetic writers, readers, bracket syntax, inline
   HTML and comment-only mentions, and requires it to catch each shape it claims to cover. A sweep
   that reports zero is meaningless unless it can report non-zero.
2. **A suppressed bucket.** Every mention removed by comment-stripping is *listed*, not discarded.
   The scanner's inaccuracies all blank more than they should — false negatives, the dangerous
   direction — so the difference between the raw and stripped scans is surfaced for review.

`sokoni-wishlist.js` is the one file allowed to name the legacy keys, and only to `removeItem`
them. Assertion O pins that: no `setItem`, no `getItem`.

> **A note on the scanner.** Its first version opened a JavaScript string on the `"` inside
> `.replace(/"/g,'&quot;')`, ran past the closing quote, and swallowed ~200 lines of real code —
> reporting three freshly-migrated files as still holding legacy readers. JS cannot be lexed
> without parsing. The fix is a property rather than a special case: a normal JS string cannot
> contain a raw newline, so `'` and `"` open a string only when a matching unescaped quote exists
> later on the **same line**, and a misread can never propagate past its own line.

---

## Open, deferred, and explicitly not done

**Production legacy migration is NOT verified.** `migrateLegacy()` is proven by 52 assertions —
idempotent, order-independent, never deletes the legacy document, reports skipped/failed items,
derives completion from canonical state rather than a stored flag. But it has **no input path in
production**: `wishlists/{uid}` has no rule in the live ruleset (`ca9e8924`) or the local one, so a
client read is default-denied. The engine works; nothing can feed it.

A server-side path (`commerceDispatch` + Admin SDK, which bypasses rules) is the obvious answer and
is **deferred pending explicit authorisation**. The rules issue was deliberately not reopened to
force this through.

Also deferred:

* **Retiring the legacy `wishlists/{uid}` documents.** Nothing deletes them. Migration moves
  authority, not history.
* **`category` on the canonical record.** `wishlistItems` carries
  `uid/productId/shopId/name/price/image/addedAt` — no `category`. This is why `inspiq.js`'s
  interest scoring was deleted rather than rerouted: pointed at the canonical store it would score
  exactly as much as the dead read did, while *looking* migrated. Wishlist-driven personalisation
  needs `category` added as a deliberate schema decision first.

---

## Deployment

**Nothing in this track has been deployed.** Firestore rules are unchanged at `ca9e8924` — the
migration required no rule change, by design. Deployment is hosting-only and gated on review.
