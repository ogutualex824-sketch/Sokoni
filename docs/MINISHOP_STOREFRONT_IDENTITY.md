# MiniShop storefront — identity finding

> **Dated:** 2026-09-22 · **Trigger:** the storefront brief, §14 ("do not port a wrong storefront")
> **Outcome:** `store.html` is **not** the MiniShop storefront. The port target was wrong.
>
> Related: [[COMMUNICATIONS_PORT_MANIFEST]] · [[SHOP_COMMUNICATION_CONTRACT_BOUNDARY]]

## What each file actually is

| File | What it is | Evidence |
|---|---|---|
| `store.html` | the **merchant profile** page | `<meta name="sokoni-page" content="merchant-profile">` |
| `minishop.html` + `sokoni-minishop.js` | **the MiniShop storefront** | served at `/shop/{handle}` and `/@{handle}` |
| `functions/minishop-page.js` (`minishopPage`) | prerenders that template per shop | **live in production** — present in the deployed-functions snapshot |

`minishop-page.js` states the relationship explicitly:

> *What it does NOT do: re-implement the storefront. The page is still rendered client-side by
> `sokoni-minishop.js` exactly as before. This function fetches the same static template and swaps
> the preview metadata in the `<head>`. That keeps one copy of the storefront markup … rather than
> a second copy inside the functions bundle that would drift.*

So the canonical chain is:

```
merchant-v2.html  (minishop-btn)
   -> handle
   -> minishopPage  /shop/{handle} · /@{handle}
   -> minishop.html  +  sokoni-minishop.js
   -> shopId, config, shop, products[], services[]
```

## The MiniShop is already built to the standard the brief asks for

This is not a placeholder. `sokoni-minishop.js` already carries:

- **handle-based identity** with `shopId`, `config`, `shop` state;
- **products *and* services** as first-class state, with product sections (best sellers, new
  arrivals) derived from the canonical catalogue;
- **followers** at `shopFollowers/{shopId}/followers/{uid}`;
- **authoritative certification** from `sellerCertifications/{sellerUid}` — and the reasoning is
  already the right one:

  > *a document the SHOP CANNOT WRITE … an attestation the badged party can mint is not an
  > attestation. It is NOT derived from shop.verified, ratings, reviews, availability, response
  > rate or completion rate … a five-star shop with no attestation is UNCERTIFIED and shows as
  > such.*

- **non-invented availability** — *"Silent when the schedule is absent. A shop with no timetable
  gets no invented 'opens tomorrow'."*

Trust, certification and availability honesty — §4 and §7 of the brief — are **already
implemented, and implemented well**. A redesign risks regressing carefully-reasoned code.

## The real gap

**Neither branch has any Communications integration on the MiniShop.** `minishop.html` and
`sokoni-minishop.js` contain zero references to `sokoni-connect-call.js` or
`connectAvailableActions` on the source branch *or* on live.

`minishop.html` is also essentially unchanged between trees — 15 live-only lines, 1 source-only —
so the live version is slightly **ahead**, and nothing about it needs porting.

## What `store.html` got, and whether it was wrong

The inquiry mount added to `store.html` is not incorrect — the merchant profile page is a
legitimate surface for "message this seller about a listing", and it uses the certified pattern:
the client supplies a **product**, the server derives the seller from
`products/{id}.sellerUid`. `shops/{uid}` never enters authorization.

But it is **not the MiniShop**, and it should not be described as such.

## Recommended next action — bounded

Mount the same certified inquiry pattern on `sokoni-minishop.js`, anchored on a published product
from `_state.allProducts`, with the identical rules already proven:

- the client supplies a **productId**, never a merchant uid;
- the server resolves `products/{id}.sellerUid`;
- the existing `inquiry` relationship, chat-ceilinged;
- `connectAvailableActions` decides what is drawn;
- no second message store.

That is a hunk of the same shape as `store.html`, and it is the whole of what the Communications
release needs from the MiniShop.

## What is NOT part of this release

Brief sections 3, 5, 6, 10, 11 and 13 — hero/visual redesign, bookings and calendars, rentals,
responsive rework, the analytics surface — are a **product programme**, not a live-lineage port.
Injecting a large untested storefront redesign into a release tree that is one page-set from
green would risk the release for work that has its own testing needs.

They should be scheduled separately, on top of a MiniShop that already does more than the brief
assumes.
