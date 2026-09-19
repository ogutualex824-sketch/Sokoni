# Offer persistence — the one thing the Offers Studio cannot do, and why

**Status:** BLOCKED, awaiting an owner decision
**Date:** 2026-09-19
**Affects:** [[Merchant V2]] Offers & Promotions Studio (`sokoni-merchant-offers.js`)
**Nothing here has been implemented.** This record exists so the next person does not wire
the Studio to the wrong collection.

---

## What works, and what does not

The Offers & Promotions Studio is complete as a composer. Templates, the bundle builder with
derived economics, the schedule editor, conditions, the scheduling calendar and the live
preview all run against `sokoni-promotion-model.js`, which resolves a basket deterministically
(22/0). The marketplace card and the offer panel render an offer identically wherever a
customer meets it (62/0).

What it cannot do is **save**. `ctx.listOffers` and `ctx.saveOffer` are not supplied by the
shell, and on publish the Studio says so rather than pretending:

> Not saved — this shell has no offer store connected yet. The offer is held in this session
> only and will be lost on reload.

## Why it was not simply wired up

There are already two offer-shaped collections. **Neither is a merchant promotion store, and
both refuse merchant writes.**

| Collection | Rules | What it actually is |
|---|---|---|
| `offers` | `create/update/delete: if isAdmin()` | A **platform admin** price-drop tool. Keyed on `productId`, requires `offerPrice < originalPrice`, one active offer per product. `sokoni-offers.js` drives it. |
| `promotions` | `create/update: if isAdmin()` | A **platform** promotion/voucher concept, paired with `promotionUsage` for redemption tracking. |

And there is no merchant-scoped alternative: every `shops/{uid}` subcollection in the deployed
ruleset is `allow write: if false`.

So a merchant pressing Publish today would be denied by rules whichever of these it was
pointed at — which is the correct outcome, because neither collection means what the Studio
means.

### The trap this record exists to prevent

`offers` is the obvious name and the wrong destination. Wiring the Studio to it would either

* fail for every merchant, since merchants are not admins; or
* **be "fixed" by relaxing `isAdmin()` on `offers`** — which would hand every merchant write
  access to a platform-admin price tool that the storefront already reads, and reopen an
  admin boundary that is currently closed.

The second failure is the dangerous one, because it looks like progress.

## What an owner has to decide

1. **Where merchant offers live.** A new collection (`shopOffers`? `merchantPromotions`?), or
   a subcollection under `shops/{shopId}`. The products authority scopes by a `shopId` field
   rather than by path, so a top-level collection with a scope field matches the existing
   convention — see [[project_canonical_inventory_authority]].
2. **Who may write.** The shop owner only, or employees with a role? `resolveActor` is the
   platform's one workforce authority and already answers that question for the till, refunds
   and rosters — see [[project_workforce_authority_convergence]].
3. **Whether an offer may reference listings across shops.** The promotion model supports
   `qualifyingListingIds`; the tenant boundary says a listing belongs to one shop.
4. **Who resolves price at checkout.** The Studio's preview and the marketplace panel are
   explicitly a **display quote** — every surface says *"the price you pay is confirmed at
   checkout"*. The server must remain authoritative, which means the resolver has to run
   server-side before an offer can affect a real basket. Until then, no offer should be
   allowed to change a charged amount.

## Why the rules were not written here

`firestore.rules` is under an active freeze:

* the rules lineage was **reopened on 2026-09-13** and Gate B is locked — see
  [[project_rules_repo_served_divergence]];
* `firestore.rules.build` is **generated**, so editing it erases the change —
  [[reference_firestore_rules_source_vs_build]];
* `--only firestore:rules` is silently discarded by firebase-tools 15.26 and **fails open to
  both databases** — [[reference_firebase_deploy_scope_fails_open]];
* the deployed ruleset must be re-fetched before any rules work, because the local `.live`
  copy is stale — [[reference_deployed_ruleset_authority]].

A new match block written into that file now would land in a lineage that is already known to
diverge from what is served, and would be deployed by a path that cannot be scoped safely.
That is an owner-authorised piece of work, not a side effect of a UI feature.

## When it is unblocked

The client side is one function each. `ctx.listOffers()` returns the shop's offers and
`ctx.saveOffer(offer)` persists one; the Studio already calls both and already reports partial
and failed writes distinctly from successful ones. Nothing in the composer, the calendar, the
preview, the card or the offer panel has to change.

Related: [[project_merchant_v2_surface_audit]] · [[project_canonical_inventory_authority]] ·
[[reference_canonical_collections]]
