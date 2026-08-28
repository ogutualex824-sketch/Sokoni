# Slice 5 — Product-page convergence: live is already the newest

**Date:** 2026-08-28 · **Base:** `4f6d95f` on `rc/ui-integration`

**No production code was ported.** Every candidate source turned out to be older than
live, and the one non-trivial difference is a regression rather than a gain.

## Every product-page source, audited

| source | contributes | verdict |
|---|---|---|
| `release/admin-slice` (`4df93f3`) | **0** non-FA lines | its 10 product.html lines and `sokoni-menu-diag.js` are ALREADY in live, tracked |
| `feat/customer-nav` | 1 line — the `data-sokoni-nav` hook | **already ported in Slice 1** |
| `rc/identity-verification-1-3` | 1 line — a back affordance | **live's is strictly better** |
| all three | Font Awesome reverted to cdnjs | **must not be taken** |

`product.js` is **byte-identical** across live and every branch.

### The back affordance — why live wins

The branch offers `<a href="/" class="pnp-back" title="Back to marketplace">←</a>`.
Live has evolved past it: `.pnp-back` is a `✕` that closes to
`category.html?cat=all`, styled, with a documented rationale that `history.back()`
returns the buyer to the exact grid state they came from, and a **44 px** touch target
at mobile widths. Taking the older line would replace a considered control with a
plain arrow.

## Runtime verification — 320 / 390 / 1440 px

| property | narrow 320 | mobile 390 | desktop 1440 |
|---|---|---|---|
| bottom nav items | 5 | 5 | 5 |
| bottom nav EMPTY | **false** | **false** | **false** |
| sub-nav present | yes (y=0) | yes (y=0) | yes |
| **navs overlap** | **false** | **false** | **false** |
| back touch target | **44 px** | 44 px | 44 px |
| back href / label | `category.html?cat=all` / "Close product details" | same | same |
| body padding-bottom | 80 px | 80 px | 80 px |
| horizontal scroll | **none** | none | none |
| self-hosted Font Awesome | **yes** | yes | yes |

The page's own sub-nav and the Slice-1 bottom nav coexist without overlap at every
width — the bottom bar is pinned (y=584 at 320 px, y=788 at 390 px, h=56) and the
80 px body padding clears it, so no content sits under either bar.

## A probe correction, and one small pre-existing finding

The runtime probe reported `cdnjsFA: true`, which looked like the Font Awesome
regression this integration is built to prevent. It was **the probe being too loose**:
it matched `link[href*="cdnjs.cloudflare.com"]`, and what the page actually carries is
a **`preconnect` hint**, not a stylesheet. `selfHostedFA` was true simultaneously.

`product.html` contains **zero** cdnjs references in my tree and in live. The injector
is `security.js:505`, a `rel:'preconnect'` entry that is **pre-existing in live** and
untouched by any slice.

**Minor finding, not fixed here:** that preconnect now warms a TLS connection to a host
nothing loads from, since Font Awesome was self-hosted in `85ee4ee`. It costs a DNS
lookup and handshake per page for no benefit. It belongs to `security.js` and to
whoever owns the asset work — not to product convergence.

## Suites

All 15 product suites pass. `test-product-write-authority` initially exited 1 with
`MODULE_NOT_FOUND` — the documented `functions/node_modules` prerequisite, not a
product defect. After `npm ci` in `functions/` it returns **31 passed, 0 failed**,
including its two defect-reproduction controls.

    test-product-specs            142/0     test-products-ai-photo         35/0
    test-product-tombstone         34/0     test-products-premium-ui       39/0
    test-product-reviews           32/0     test-products-detail-sheet     30/0
    test-product-write-authority   31/0     test-products-specs-editor     30/0
    test-product-validator         28/0     test-products-variants-editor  24/0
    test-product-revalidation      21/0     test-product-delete-canonical  13/0

## Not proven here

- **Product -> shop/merchant -> inventory -> cart -> checkout** as an authenticated
  journey. The product page renders and its outward links to cart and wishlist are
  present, but a signed-in traversal needs credentials that were not manufactured.
  A shop link was NOT found in the unauthenticated DOM, which is expected for a page
  with no resolved product — recorded rather than asserted either way.
- Nothing here touches the delivery Functions blocker or the browser-minted delivery
  PIN defect. Both remain open and separate.
