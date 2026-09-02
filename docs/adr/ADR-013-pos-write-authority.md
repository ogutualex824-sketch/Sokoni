# ADR-013 — Clients express intent; the server establishes authoritative state and money

**Status:** ✅ **ACCEPTED** (2026-09-01) — architecture decided, **implementation NOT authorized**.
Acceptance of this ADR does not authorize implementation, deployment, rules publication, or
migration. Each of those remains separately gated.
**Date raised:** 2026-09-01 · **Accepted:** 2026-09-01
**Raised by:** the P19/P20 evidence pass (see [[MULTISHOP_CHECKOUT_AUDIT]], `CHANGELOG.md`)

---

## The decision

> **CLIENTS EXPRESS INTENT / EVENTS.
> THE SERVER ESTABLISHES AUTHORITATIVE STATE AND MONEY.**

This principle applies to **POS** and to **Marketplace** — **separately**. They share the
authority principle; they do **not** share a business rail, a payment rail, or a collection.

**POS — Option A accepted.** Server-mediate Rail 2 through the existing offline-capable
callable/sync architecture. Offline-first capture is retained. Real-device/deployed proof of the
P15C callable-queue mechanism is required **before** migration.

```
POS client → captures cashier/sale intent → IndexedDB/offline queue when necessary
           → existing callable dispatch → server validates product/pricing/authority
           → server computes the authoritative financial outcome
           → authoritative sale + inventory mutation
```

The client may capture intent offline. The client must **not** be the final authority over sale
total, product price, discount outcome, inventory outcome, or any commission-bearing value.

**Marketplace — same authority principle, separate business rail.**

```
Buyer/seller client → order intent → SOKONI server
  → validate seller/product/availability/pricing
  → authoritative order totals → marketplace commission → delivery charges/rules
  → authoritative marketplace order → marketplace payment rail
  → seller / rider / SOKONI settlement
```

Marketplace remains SOKONI's orchestration and payment layer, using the established marketplace
payment architecture (IntaSend / platform Merchant-of-Record). Seller POS/Daraja sales remain a
**separate rail**. Do not merge POS sales and marketplace orders merely because they share the
same authority principle.

**Financial authority.** For marketplace orders the client is never authoritative for the final
order total, commission, seller payout, rider amount, delivery charge, or settlement amounts. The
server derives these from authoritative inputs and business rules. The established **5%**
marketplace commission structure stands — do not invent a second commission vocabulary or rate.
**Delivery is not free by default**; it is free only where the shop explicitly offers it. These
business rules are not to be changed while implementing the architecture.

---

## The decision, stated once

SOKONI currently answers this question **both ways at the same time**. Two sale rails and two
inventory models coexist, with opposite authority:

| | Rail 1 — server-authoritative | Rail 2 — client-authoritative |
|---|---|---|
| entry point | `posCompleteCheckout` (onCall) | direct client write to `posTransactions` |
| used by | `pos-v2.html`, `pos-checkout.html`, `till.html`, shell Sell | `pos.html` / `pos.js` (the live legacy till) |
| price | re-derived from `products`; a client price differing by >1 KES is **rejected** | whatever the client writes |
| total | server-computed from `enrichedItems` | whatever the client writes |
| discount | gated (owner/manager, or canonical `discounts`) | ungated |
| stock | transactional, floored at zero, `inventoryVersion` bumped | client-side |
| inventory model | canonical `products.stock` — **no branch concept** | `inventory/{branchId}__{productId}` — **branch-scoped** |

**These are the same question asked twice.** Answer it once and both resolve, along with most of
the branch-scope problem — because the branch-aware model lives entirely on the
client-authoritative side.

---

## Evidence (verified, not inferred)

Verified against **served ruleset `59af870d-72eb-4791-a3b6-2f4de7eb8ff7`**
(`firestore.rules.release-minimal`, 2026-09-01) — not the repo proposal, which is a separate and
currently unsafe artifact.

1. **Production permits the client-authoritative sale.** `posTransactions` create enforces only
   `sellerId == auth.uid`, `total is number`, `total >= 0`, a status enum, and absence of
   `adminNote`. There is **no per-item validation and no relation between `items` and `total`**.
2. **The mirror validates nothing.** `pos-retail-mirror-map.js` is a pure mapper: `unitPrice`,
   `subtotal`, `discountAmount` and `total` are copied into `posRetailSales` unchanged.
3. **Commission derives from `total`.** So this is a financial-integrity exposure, not merely an
   attribution one. The manager PIN is the only gate on price, and it is client-side.
4. **The missing-POS-sales symptom has a mechanism.** `pos-sync.js` sets
   `sellerId: data.sellerId || firebaseUid`. With a cashier signed in, either the fallback fires
   and the sale is written under the *cashier's* uid — invisible to every owner query — or the
   merchant id is present and the rule rejects it, and it sits in the DLQ.
5. **Branch inventory is denied in production.** No served rule for the bare `inventory`
   collection and no catch-all. `posStockMovements` create *is* permitted, so the audit record
   succeeds while the quantity is refused — permanent, silent divergence. P20B made the denial
   observable; it did **not** make the write succeed.
6. **Rail 1 is sound and must not be "fixed".** P19's original premise — a price-override
   authority gap — was **disproved**: neither capability vocabulary has a price concept at all.

---

## Options

### A. Server-mediate Rail 2 through the existing offline-capable callable path
Route `posTransactions` writes through `posCompleteCheckout` via the PosSync **callable route**
already built for shift registration (P15C).

- **Preserves** offline-first queueing — the mechanism exists and is proven in-harness.
- **Resolves** price, total, discount and stock authority in one move.
- **Costs:** requires the P15C real-device proof first (a passing in-memory harness cannot prove
  callable deployment topology), and a decision on what happens to sales already queued under the
  old shape.
- **Branch scope becomes explicit** rather than accidental: the canonical model has no branch
  concept, so branch-aware inventory must either be added to it or consciously dropped.

### B. Retire Rail 2
Point `pos.html` at `posCompleteCheckout`, as `pos-v2.html` already does.

- **Simplest**, and removes a whole class of divergence permanently.
- **Costs:** changes offline behaviour for the live till. The offline-first guarantee
  ("never lose a sale") is a product promise, not an implementation detail.

### C. Accept mirror-side validation
Validate in `pos-retail-mirror` instead.

- **Cheapest.**
- **Costs:** it is after the fact. A mirror can flag a bad sale; it cannot refuse one. The customer
  has already been charged. This does not resolve authority — it records violations of it.

### D. Deliberately keep both rails
Declare `posTransactions` an untrusted local journal and `posRetailSales` non-authoritative for
money.

- **Costs:** commission and analytics must then be sourced elsewhere, and the branch-scoped
  inventory model must be given real rules or removed. Choosing this means choosing it *loudly* —
  the current state is this option by default, without anyone having decided it.

---

## Decision rationale (accepted 2026-09-01)

**Option A is accepted**, sequenced behind the P15C real-device proof — it is the only option that preserves
the offline-first promise while making the server authoritative, and it reuses a mechanism that
already exists rather than inventing one. The proof must establish that the offline
registration/synchronisation path actually works **in the deployed topology**, not in a harness.

If A cannot be proven operationally, **B** is preferable to allowing two authority models to drift
indefinitely: a smaller, provable product change beats an open-ended half-migration.

**C and D are explicitly rejected as defaults.**

- **C** detects bad data *after* the client has already been trusted. Detection is not equivalent
  to server authority; the customer has been charged either way.
- **D** preserves the current split, and therefore preserves the financial-integrity and
  inventory-consistency problems intact. It remains available only as a *deliberate, stated*
  choice — never as the outcome of not choosing.

This narrows the field. It does **not** decide the ADR, which remains ⛔ Decision required.

---

## What this ADR forbids, whichever option is chosen

- **No partial hardening of Rail 2 before the decision.** Tightening one field while the rail
  stays client-authoritative produces a half-migration and a false sense of coverage.
- **No mirror-side "fix" presented as authority.** Detection is not enforcement (see
  [[ADR-005-commit-point-persistence-gating]]).
- **No silent equivalence between the two inventory models.** `products.stock` is not branch-aware.
  Treating a branch-scoped quantity as canonical, or vice versa, is a data-loss bug.
- **No granting of employee stock authority until branch scope is settled.**
  `workspaceMemberships` is merchant-wide; `posStaff` is branch-aware. Stock is the operation where
  that difference has physical meaning.
- **No rules deploy from the repo artifact to enable any of this.** A deploy from this repo today
  **regresses** two live protections — the `shopEmployees` anchor-immutability clause and
  `products`' `isSeller()` requirement. Reconcile first.
- **No treating POS and Marketplace as the same transaction rail.** They share the authority
  principle and nothing else — not collections, not payment rails, not settlement.
- **No trusting client-submitted totals, commission, payout, delivery or settlement amounts**, on
  either rail. A client-supplied figure may be compared against the server's; it may never become
  the stored value.
- **No partial Rail-2 hardening presented as equivalent to server authority.** Tightening one
  field while the rail stays client-authoritative is a half-migration with a false sense of cover.
- **No retiring Rail 2** unless the P15C architecture proves unavailable or operationally
  unacceptable — and B is then a decision to record here, not a shortcut to take quietly.
- **No weakening of the offline guarantee to simplify the fix.** "Never lose a sale" is a product
  promise, not an implementation detail.
- **No option may be chosen by accumulation.** A large body of certified-but-uncommitted work
  (P2–P18) exists. Certification establishes that each change is individually defensible; it does
  **not** establish that their combined architecture is the right one, and the cost of having
  written them is not an argument for any option here. If the decision goes against work already
  built, that work is discarded or reshaped — sunk effort does not vote.

---

## Recorded exception — POS entry decision (2026-09-01)

The merchant shell now opens `pos-hardware-wizard.html` when `posSetupComplete` is absent, and
its **Start Selling** action opens **`pos.html`** — the Rail 2, client-authoritative till.

This is a **deliberate temporary state**, decided by the operator so merchants get the POS their
staff already know. It does NOT revise this ADR: Rail 2 remains the thing Option A migrates, and
routing daily selling through it makes that migration MORE urgent, not less. When Rail 2 is
server-mediated, this entry point inherits the fix with no further UX change, because the shell
routes to a page rather than to a rail.

The latch stays **once-ever** (no daily expiry) by the same decision. Proven by
`scripts/test-pos-entry-setup-first.js` (14/0).

**Still to fix, unrelated to authority:** the completion screen tells the merchant “your printer
reconnects automatically”. Zero-tap Bluetooth reconnect is impossible without `getDevices()`, and
this project has already ruled that needing a tap is a PASS. The copy overstates the hardware.

## Related

[[ADR-005-commit-point-persistence-gating]] · [[ADR-008-evidence-before-change]] ·
[[ADR-009-canonical-field-representation]] · [[EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION]] ·
`CHECKOUT_CONTRACT.md`

**Suites pinning this evidence:** `test-stock-adjustment-authority.js` (52/0),
`test-pos-inventory-denial-visibility.js` (26/0), `test-refund-authority-convergence.js` (36/0).
All pin served ruleset `59af870d…` — **if that ruleset changes, refresh the evidence before
relying on this ADR.**
