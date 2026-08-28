# Slice 6 — Cross-surface verification

**Date:** 2026-08-28 · **Candidate:** `db62056` on `rc/ui-integration` · **Base:** live `b223635`

**Verdict counts (corrected): PASS 17 · FAIL 0 · BLOCKED 5 · UNPROVEN 13**

Nothing was deployed. No credentials or production records were manufactured.

---

## The question this slice answers

Do the already-integrated slices **compose**, independently of the two deliberately
blocked production-dependent areas? **Yes** — every composition check that could be
executed passed, and the two blocked areas stayed blocked rather than leaking into a
green.

## Navigation — the slices compose

| check | verdict | evidence |
|---|---|---|
| bar renders on `/`, `/product`, `/category`, `/search` | **PASS** | 5 items, exactly 1 bar each |
| NO duplicate bottom bars | **PASS** | 7 pages checked, 0 duplicates |
| NO empty nav shell | **PASS** | none |
| ONE Messages destination | **PASS** | 1 nav link, header button absent |
| one renderer, identical bar everywhere | **PASS** | `["/","category.html?cat=all","services.html","messages.html","track.html"]` |
| self-hosted Font Awesome retained | **PASS** | **338 pages compared: 0 lost self-hosting, 0 gained cdnjs** |
| no cdnjs stylesheet reintroduced | **PASS** | the cdnjs hit is a `preconnect` hint, not a stylesheet |

### Two probe defects found and corrected — both would have misled

**1. A false FAIL.** The Font Awesome check first reported FAIL on `/search`. `search.html`
has **zero** Font Awesome references in this tree *and* in live — it never loaded it. The
probe treated "no FA link" as "FA lost". The correct property is *no page that HAD
self-hosting lost it, and none gained cdnjs*, measured across all **338** pages: 0 and 0.

**2. Three false UNPROVENs, now measured.** `/cart`, `/checkout` and `/wishlist` reported
0 nav bars. They are not missing a bar — **they redirect to login when unauthenticated**:

    /cart      -> /login.html   /checkout -> /login   /wishlist -> /login
    /product   -> /product  (hook present, 5 items)

`login` is in the renderer's own EXCLUDED list, so having no bottom bar there is correct.
These stay UNPROVEN for the *signed-in* case, but the reason is now measured rather than
guessed.

> A probe that cannot distinguish "absent" from "never present" produces exactly the
> alarm this integration is meant to prevent. Both were caught by checking the control
> rather than by trusting the first red.

## Buyer journey

| check | verdict | note |
|---|---|---|
| product / cart / checkout reachable, laid out at 390 and 1440 | **PASS** | HTTP 200 both widths, **no horizontal scroll** |
| cart state survives navigation | **UNPROVEN** | no cart key exists for an anonymous empty session; writing a synthetic one would test my own fixture, not the app |
| product -> shop link resolves | **UNPROVEN** | needs a real product id |
| checkout completes | **UNPROVEN** | needs a signed-in buyer and a real payment rail |

## Merchant journey

| check | verdict | note |
|---|---|---|
| dashboard shell loads | **PASS** | HTTP 200, "SOKONI Merchant" |
| POS shell loads (unregressed) | **PASS** | HTTP 200, "SOKONI SmartPOS" |
| module globals register | **BLOCKED** | none register offline — **live's own modules included**; not caused by any slice |
| dashboard -> Payments/Wallet, Products, Shop, POS | **UNPROVEN** | auth-gated |
| activeShopId consistent across surfaces | **UNPROVEN** | source property proven 23/0 in `58c4c07`; the runtime chain needs a session |

## Delivery — stopped exactly where instructed

| check | verdict |
|---|---|
| client surfaces on the candidate | **BLOCKED** — not ported |
| `deliveryAssignRider` reachable | **BLOCKED** — absent from live `index.js` AND the deployed list |
| `deliveryRiderOptions` reachable | **BLOCKED** — same |
| rider workflow / status transitions | **BLOCKED** |

No Functions were deployed to make this testable.

## Financial path

| check | verdict | note |
|---|---|---|
| Wallet adapters owner-scoped in the QUERY | **PASS** | against SERVED ruleset `f1c4e35b` |
| Wallet panel renders for a real merchant | **UNPROVEN** | auth-gated + module-global blocker |
| money actually moves | **UNPROVEN** | no authenticated test was run |
| POS surface unregressed | **PASS** | HTTP 200 |

## Security boundaries

Source-level properties proven in `58c4c07` (23 passed, 0 failed) and unchanged since:
identity resolves through one server callable; `_scope()` names `no_sell_capability` and
`no_merchant_role` separately; **the client never writes `activeShopId`**; a failed scope
yields a poisoned cache key; all 13 module contexts share one authority; the Wallet is
handed no db adapter. The **runtime** refusal of a cross-merchant `activeShopId` remains
**UNPROVEN** — it lives in the callable and the rules layer.

## Two production findings, still separate and still open

- 🔴 **Browser-minted delivery PIN.** `https://mysokoni.co.ke/sokoni-delivery.js` still
  contains `_generatePIN` (2x) and `proofPin` (1x). Remediation pending, own track.
- 🛑 **Delivery marketplace Functions absent from production.** Deployment requires
  separate authorisation.

Neither was touched, worked around, or folded into this slice.

## Console

43 console errors across the sweep, all one repeated line: `Failed to load resource: 403`
— App Check rejecting an offline harness. No `PAGEERROR`, no uncaught exception, on any
page visited.
