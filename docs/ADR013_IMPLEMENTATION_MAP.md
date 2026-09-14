# ADR-013 — implementation map and migration sequence

**Status:** mapping pass only. **Nothing implemented, committed, deployed, published or migrated.**
**Date:** 2026-09-01 · **Governs:** [[adr/ADR-013-pos-write-authority]]
**Evidence baseline:** served ruleset `59af870d-72eb-4791-a3b6-2f4de7eb8ff7`
(`firestore.rules.release-minimal`). Repo rules are a **separate and currently unsafe** artifact.

---

## A. POS architecture map

Two rails, opposite authority. Rail 1 already satisfies ADR-013; Rail 2 does not.

| | Rail 1 — `posCompleteCheckout` | Rail 2 — `pos.js` |
|---|---|---|
| surfaces | `pos-v2.html`, `pos-checkout.html`, `till.html`, shell Sell | `pos.html` (live legacy till) |
| write | onCall, Admin SDK | client `setDoc` → `posTransactions` |
| price | re-derived from `products`; >1 KES difference **rejected** | client-chosen |
| total | server-computed from `enrichedItems` | client-chosen |
| discount | gated (P18: Stack A capability, else canonical `discounts`) | ungated |
| stock | transactional, floored at 0, `inventoryVersion` bumped | client-side |
| mirror | n/a | `pos-retail-mirror-map.js` — **pure mapper, validates nothing** |

**Served rule (production):** `posTransactions` create requires only `sellerId == auth.uid`,
`total is number`, `total >= 0`, a status enum, and no `adminNote`. No per-item validation; no
relation between `items` and `total`.

**Attribution mechanism.** `pos-sync.js` sets `sellerId: data.sellerId || firebaseUid`. With a
cashier signed in, either the fallback fires and the sale lands under the *cashier's* uid —
invisible to every owner query — or the rule rejects it and it sits in the DLQ.

**Inventory.** Canonical `products.stock` has **no branch concept**. The POS path targets
`inventory/{branchId}__{productId}`, which has **no served rule and no catch-all** → denied.
`posStockMovements` create *is* permitted, so audit succeeds while quantity is refused. P20B made
that denial observable; it did not make the write succeed.

## B. Marketplace architecture map

**Structurally healthier than POS, but its protection is partly incidental.**

`createCheckoutSession` (`functions/index.js:2349`, writes the order at `:2932` inside a
transaction) is the server rail and already satisfies ADR-013:

- subtotal recomputed from `products` (`serverSubtotal`), per-item, rejecting unpriced products;
- **delivery recomputed** from the merchant's `deliveryConfig` via the shared delivery engine,
  with a client mismatch **rejected** — the previous behaviour (accept and clamp to 0..5000) was
  correctly identified in-code as "a bounded lie is still a lie";
- where a merchant has no `deliveryConfig`, the legacy clamp applies and the gap is **logged**,
  so unconfigured merchants are visible and migratable rather than silently trusted.

**Served rules make a client-created order genuine *intent*.** `clientOrderInit()` forbids
`paymentVerified, paidAt, paidAmount, paidPhone, mpesaCode, settlementStatus, escrow,
escrowStatus, payoutStatus, receiptGenerated, inventoryApplied, fulfilmentStatus`, and restricts
status to `pending | pending_payment | draft`.

**The gap:** `clientOrderInit()` does **not** constrain `total`, `subtotal`, `deliveryFee` or
commission fields, while `order-settlement.js:_grossCents` reads
`order.orderTotal ?? order.total` and `order.deliveryFee` straight off the document. Its comment
calls these "server-authoritative from the order snapshot" — true only because the order was
written by the server rail.

**Why this is not currently exploitable — and why that is fragile.** The one client-side order
writer (`sokoni-orders.js` `createOrder`) has **no live callers**, and would be rejected anyway
because it writes an `escrow` key that `clientOrderInit()` forbids. So the marketplace is
protected by one deliberate control (the rules) and one accident (dead code). **The rules do not
today prevent a client from choosing an order total** — only from declaring it paid.

## C. Authority boundaries — every client → authoritative-money/inventory crossing

| # | crossing | rail | status |
|---|---|---|---|
| 1 | `posTransactions.total` / `items[].unitPrice` | POS Rail 2 | **OPEN** — client-authoritative, reaches commission |
| 2 | `posTransactions` discount | POS Rail 2 | **OPEN** — ungated |
| 3 | POS stock | POS Rail 2 | **OPEN** — client-side |
| 4 | `inventory/{branch}__{product}.qty` | POS sync | **DENIED in prod**, now observable (P20B); authority unfixed |
| 5 | `orders.total` / `deliveryFee` → `settleOrder` | Marketplace | **LATENT** — rules permit client totals; no live writer |
| 6 | `posCompleteCheckout` item spread `{...item}` | POS Rail 1 | **LATENT** — arbitrary fields persisted; no live consumer |
| 7 | `request.data.deliveryFee` | Marketplace | **CLOSED** — recomputed and mismatch rejected |
| 8 | order payment/settlement fields | Marketplace | **CLOSED** — `clientOrderInit()` forbids |

## D. Certified work that becomes applicable

Already built, gated, uncommitted — all of it serves Option A rather than being invalidated by it:

- **P15C callable sync route** (`pos-sync.js` `shift_registration` → `smartPosDispatch`) — the
  exact mechanism Option A reuses. **Its real-device proof is the gate on everything below.**
- **P18 discount authority** and **P17 refund authority** — already enforced in `posCompleteCheckout`;
  they become effective for the legacy till the moment its sales route through Rail 1.
- **P10 `recordPOSSale` money provenance**, **P4 tenant binding**, **P7 void atomicity** — server-side
  authority already converged.
- **P20 `merchantAdjustStock`** — the canonical, transactional stock-correction path Option A's
  inventory outcome should route through.
- **Tenant identity resolver** (`tenant-identity.js`) — needed to bind a till sale to a canonical
  merchant rather than a uid fallback.

**Not applicable / must not be pulled forward:** the five dead `shopEmployees` reads, and any
employee stock-authority grant — both blocked on branch scope.

## E. Migration dependencies (strict order)

1. **P15C real-device proof** on deployed callable topology. *Everything else waits on this.*
   A passing in-memory harness cannot prove deployment topology.
2. **Rules reconciliation** — the repo artifact currently **regresses** production
   (`shopEmployees` anchor immutability; `products` `isSeller()`). Must be resolved before any
   rules change, including the `inventory/{id}` question and tightening `clientOrderInit()`.
3. **Functions deployment authorization** + candidate-lineage guard (passes on `sok-fn-cand`,
   fails on `sok-printer` with 11 missing protections).
4. **Branch-scope decision** — required before POS inventory outcome can route to a canonical,
   branch-less `products.stock`.
5. **Queued-sale disposition** — what happens to `posTransactions` items already queued in the old
   shape at migration time. Unresolved; see F.
6. Only then: route Rail 2 through the callable, one concern per commit.

## F. Risks and unresolved decisions

- **The offline queue's shape changes.** Sales captured before migration are documents; after, they
  are callable intents. Draining the old queue without double-charging or losing a sale is the
  single largest implementation risk and is **not yet designed**.
- **Branch scope** — `posStaff` is branch-aware, `workspaceMemberships` is not. Stock is where the
  difference has physical meaning.
- **Two inventory models** — ADR-013 forbids treating them as equivalent; it does not yet decide
  which survives.
- **Marketplace total authority is unenforced at the rules layer** (crossing 5). Closing it is a
  rules change and therefore blocked behind dependency 2.
- **Commission vocabulary** — `commission-config.js` documents *category* rates (marketplace 10%,
  legal 12%) alongside a hub-keyed 5%, and a live split is on record where the server charges 5%
  while the browser displays 3%. ADR-013 fixes 5% as the marketplace structure; **reconciling the
  existing vocabularies is a product decision, not an implementation detail** — flagged, not taken.
- **`sokoni-orders.js` createOrder is dead code that would fail the rules if revived.** Either
  delete it or fix it; leaving it is a trap.

## G. Exact next implementation slice

**None yet — the next action is not code.**

The next slice is **P15C real-device proof**: run the deployed callable topology on a real handset
and establish that offline capture → queue → callable dispatch works end to end. It requires an
authorized handset and deployed functions, both external blockers.

**If that proof succeeds**, the first implementation slice is narrow and reversible:

> Route **one** POS operation — the sale — from `pos.js` through the existing callable dispatch to
> `posCompleteCheckout`, behind a flag, with the offline queue retained and the old path intact
> until parity is proven by the existing shadow-comparison mechanism (`pos.js:852`), which already
> dry-runs the canonical path and records a structured diff.

That mechanism exists, is already live, and is the correct instrument for proving parity before
switching authority. Nothing needs to be invented.

---

## Boundaries reaffirmed

Not deployed · not committed · rules not published (`f88e8953` untouched) · approval consumption 0
· no migration or backfill · no business rule invented or changed · POS and Marketplace remain
separate rails.
