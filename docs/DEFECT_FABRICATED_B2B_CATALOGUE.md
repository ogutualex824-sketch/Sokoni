# Defect — `sokoni-b2b.js` serves a fabricated B2B catalogue

**Status:** TRACKED, NOT FIXED · raised 2026-09-05 · **do not fix inside a PO-convergence slice**
**Class:** same as the `pos-bi.html` fabricated-metrics defect closed in `5a45d34`
**Related:** [[PUBLICATION_CONTRACT]] · `docs/adr/ADR-018c-purchase-order-batch-disposition.md`

---

## The defect

`sokoni-b2b.js` (34 KB, the B2B supplier-directory / RFQ client) ships **37 hardcoded
catalogue rows** presenting invented businesses, products, prices, MOQs and savings
percentages as a live marketplace. Examples as shipped:

| field | invented value |
|---|---|
| `supplierName` | `Nairobi Apparel Co.`, `TechHub Kenya Ltd.`, `Rift Valley Mills`, `Murang'a Farmers Cooperative`, … |
| `price` / `wholesalePrice` | `12000` / `8500`, `65000` / `48000`, … |
| `moq` | `30`, `100`, `500` |
| `savings` | `47`, `29`, `56` (percent) |

There is **no callable reference anywhere in the file** — no `httpsCallable`, no
`servicesDispatch`. The directory is not backed by an authoritative source at all.

## Why it is the same class as the pos-bi defect

> merchant-facing production surface → invented business/product data → no authoritative
> backend source

The `pos-bi.html` defect substituted `mockInv()` / `mockPay()` on a query failure. This is
worse in one respect: there is no query to fail. The invented data is the only data.

Standing rule, from `CLAUDE.md` and reaffirmed by `5a45d34`:

> **No UI component may fabricate business metrics.** No demo/seed fallback on production
> data paths. When canonical data is unavailable, show a neutral state — never `0`, never an
> extrapolated guess.

Extended here: **no fabricated production business entities, prices, MOQs, savings, or
marketplace availability.**

## Backend context (traced 2026-09-05)

A real B2B engine exists: `functions/b2b-wholesale.js`, 12 handlers (wholesale accounts,
orders, approval, payment, credit notes, catalogue, `updateWholesaleProduct`), routed live
through `servicesDispatch` (`functions/index.js:11939`). `sokoni-b2b.js` does not call it.

`procurement.js:5-6` records the intended division of labour:

> *"Handles inbound purchasing from external suppliers — fully distinct from
> `b2b-wholesale.js` which manages outbound bulk sales to buyers."*

That is the **Suppliers** (who this business buys from) vs **My Supply** (what it offers
others) split. Both engines exist; neither has a coherent UI.

**All relevant collections are EMPTY in both `(default)` and `sokoni-ops`:**
`wholesaleAccounts`, `wholesaleOrders`, `wholesaleLedger`, `b2bSuppliers` — probe validated
against `businesses` (3 documents). So a truthful surface today would be an empty state.

Note `createWholesaleAccount` takes `businessName`/`businessType` as **free text**, so it
models a wholesale *customer record*, not a link between two canonical `businesses/{id}`.
The counterparty-as-external-contact shape applies to both engines, not just `procSuppliers`.

## Required remediation (own slice)

1. Remove the 37 fabricated rows outright — no mock generator left behind to re-reference.
2. Until the data is authoritative, show a **neutral empty state**, or an explicitly
   non-production surface that cannot be mistaken for a live marketplace.
3. If it becomes a real discovery surface, source it from the canonical engine
   (`getWholesaleCatalog`) over `businesses/{id}` — never a client-side literal.
4. Certify with a detector that fails on any reintroduced fabricated entity, with
   adversarial tests in both directions.

## Explicitly out of scope

Not to be fixed inside Slice B, B2 or any PO-convergence slice. Also still open and
separate: `getPOSInventoryIntelligence`'s 500, and the `pos-bi.html` KPI missing-field → `0`
coercion.

---

## REMEDIATED — Slice L, 2026-09-05

**Status: CLOSED.** The fabricated rows are deleted, and a canonical replacement exists.

### What was removed

| removed from `sokoni-b2b.js` | count |
|---|---|
| invented supplier businesses (`SUPPLIERS`) — names, phones, ratings, review counts, founding years, minimum-order values, ISO/KEBS/GlobalGAP certification claims | **15** |
| invented wholesale product rows (`PRODUCTS`) — prices, MOQs, savings percentages | **23** |

Both bindings survive as frozen empty literals so the seven consuming pages keep their API and
do not crash; no mock or seed generator was left behind. Two adjacent fabrications on the same
live path went with them:

* `b2b-chat.html` seeded two invented conversations with an invented supplier whenever a user
  had no threads — and `B.sendMessage` **persists**, so the fabrication was written to
  Firestore as real message history.
* `b2b-chat.html` rendered unread badges from `Math.floor(Math.random()*3)` — a different
  count on every repaint.
* `registerSupplier` initialised a new supplier with `rating: 0`. Zero reads as *rated badly*;
  an unrated business is now `rating: null`.

### Why `getWholesaleCatalog` was NOT the replacement

Traced against production (both databases; `sokoni-ops` is entirely empty, its own controls
read 0):

| probe | count |
|---|---|
| `products` (control) | 108 |
| `products.wholesaleEnabled == true` — **what the handler filters on** | **0** |
| `products.wholesalePrice > 0` — **real wholesale offers** | **10** |
| `products.minOrderQty > 0` — its MOQ field | **0** |
| `wholesaleAccounts` — its permission gate | **0** |

The handler is structurally blind to every real wholesale offer: it filters a field no product
writer in the repository sets (`updateWholesaleProduct`, its only writer, has **zero callers**),
reads MOQ from a field set on no product while defaulting it to 10, renders a missing price as
`0`, and gates on a collection with no documents — so it denies every caller on the platform.
Its identity space is a user uid, not `businesses/{businessId}`.

### The canonical replacement

`procurement.getSupplyCatalogue` — see `CHANGELOG.md` and
`scripts/test-supply-catalogue-slice-l.js` (149 checks, 15 sabotage catches).
`b2b-wholesale.js` is deliberately untouched: repointing it would redefine a live-dispatched
contract that `wholesale-portal.html` reads.

### Still open, deliberately separate

`b2b.html` and its sibling pages are **customer-facing** and now render truthful empty states;
wiring them to a business-scoped authority is a different audience question from the merchant
Supply workspace and is not resolved here. Also still open: `getPOSInventoryIntelligence`'s
500, and the `pos-bi.html` KPI missing-field → `0` coercion.
