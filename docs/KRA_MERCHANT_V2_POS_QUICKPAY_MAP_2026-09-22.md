# KRA / eTIMS across Merchant V2, POS, Till, Quick Pay and Online Orders

**Date:** 2026-09-22 · **HEAD:** `10acec6` · **Status:** READ-ONLY AUDIT. No KRA code changed.
**NOT DEPLOYED.**

**Method:** every layer traced UI → client module → callable → server authority → persistence →
KRA boundary → receipt. Filenames were not treated as evidence. Absence claims carry a control.

Related: [[MERCHANT_V2_POS_ECOSYSTEM_MAP_2026-09-22]] ·
[[MERCHANT_V2_POS_ECOSYSTEM_RELEASE_2026-09-22]] · [[POSPRODUCTS_MIGRATION_GRAPH]]

---

## 0. The headline — the layers, kept apart

The instruction was explicit: *do not equate "KRA PIN appears on the receipt" with "KRA
integration is complete."* Traced layer by layer, the answer is sharper than that warning:

| # | Layer | State | Evidence |
|---|---|---|---|
| 1 | Business identity / KRA PIN | **BUILT** | `etimsProfiles/{auth.uid}` — the uid IS the doc id. `KRA_PIN_RE = /^[A-Z]\d{9}[A-Z]$/` (`etims.js:62`). One PIN per ACCOUNT, not per shop |
| 2 | Tax determination | **BUILT, canonical** | `etims-tax-engine.js` — PURE, no I/O. Converged three previously divergent VAT implementations. VAT-inclusive; A standard 16%, B zero-rated, C exempt; round half-up at each step |
| 3 | Transaction | **BUILT, three domains** | `posRetailSales` (till) · `posSales` (dispatch) · `orders` (online) |
| 4 | Payment state | **BUILT, separate** | never collapsed into tax state |
| 5a | Internal invoice lifecycle | **BUILT** | `etims-lifecycle.js` — six document types: invoice, credit note, debit note, cancellation, amendment, reversal. Idempotent (dedup on id), audited, queued to `etimsTransmissionQueue` |
| 5b | **KRA wire transmission** | **NOT IMPLEMENTED** | `etims-kra-adapter.js`: `SPEC_LOADED = false`. **Every** builder returns a `KRA_SPEC_PENDING` marker. `docs/kra-etims-spec-v2.0.pdf` **does not exist** in the repo |
| 6 | Receipt / invoice | **BUILT** | `etims.js` renders HTML + text carrying the KRA PIN and branch |
| 7 | Correction / reversal | **MODELLED, not transmitted** | `etimsInvoiceLifecycle` covers credit/debit/cancel/amend/reversal — all PENDING at the wire |
| 8 | Reporting | **BUILT** | `etimsGetSellerStats`, `etimsGetAdminStats`, `etimsReconcileDaily` |

**So: SOKONI computes tax correctly and forms every KRA document correctly, and transmits
nothing.** The architecture is honest about it — `etims-lifecycle.js:122` calls
`KraAdapter.isTransmittable()` and stores `transmittable: false` on each record before queueing
it. Documents accumulate in `etimsTransmissionQueue` awaiting a spec that is not in the repo.

The receipt is deliberately labelled: `basis: 'sokoni_estimate'`, never `'official'` —
*"SOKONI assists with filing; KRA/ETIMS assesses. The day an ETIMS response exists it is stored
beside this, not over it."* (`pos-zero-friction.js:175`).

> **`SPEC_LOADED` is exported and read by nothing outside its own file.** No caller gates on it.
> Today that is harmless because the lifecycle checks `isTransmittable()` instead — but the flag
> is a dead export, and a future caller reaching for it would be reaching for a guard nobody
> maintains.

---

## 1. THE CONNECTIVITY FINDING — KRA covers online orders ONLY

`etimsOnOrderCompleted` is `onDocumentWritten({ document: "orders/{orderId}" })`, firing when
status enters `completed` / `delivered` / `order_delivered` (`etims.js:741`). `hubOnOrderCompleted`
is the hub equivalent.

**There is no eTIMS trigger on `posRetailSales` or on `posSales`.** Measured across
`functions/`: zero `document: 'posRetailSales'` and zero `document: 'posSales'` trigger
declarations anywhere.

```
ONLINE ORDER   orders/{id} -> completed  --trigger-->  eTIMS invoice lifecycle  ✅
TILL SALE      posRetailSales/{id}                     (no trigger)             ❌
DISPATCH SALE  posSales/{id}                           (no trigger)             ❌
```

A till sale **does** carry a computed tax figure: `posCompleteCheckout` calls
`etims-tax-engine.computeInvoice()` and writes `tax` onto the sale and the receipt
(`pos-zero-friction.js:166-183, 1085`). And when the shop has recorded no VAT status it writes
`vatStatus: 'undeclared'`, `vatCents: null` with a stated reason — an honest unknown, not a
zero. **But that figure never becomes an eTIMS invoice.**

**This is the central gap for §9 and §22.** Merchant V2's tax surface is genuinely connected for
marketplace orders and genuinely disconnected for POS/till — and no UI field discloses the
difference today.

---

## 2. The required table (§22)

`—` = not applicable · **UNPROVEN** = not settled here · **N/A-blocked** = the path itself does
not exist yet (see §3).

| # | Path | Transaction authority | Tax/KRA authority | Payment authority | Receipt authority | Inventory | Commission | Realtime | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | POS product sale | `recordPOSSale` → `posSales` | tax engine **not called on this path** | tender in caller | `posReceipts` | `products.stock −qty`, `soldCount` | `planSaleCommission` → `POS_PLAN_RATES` 5% | UNPROVEN | **NO KRA** |
| 2 | POS service sale | — | — | — | — | — | — | — | **N/A-blocked** |
| 3 | POS mixed sale | — | — | — | — | — | — | — | **N/A-blocked** |
| 4 | Till product sale | `posCompleteCheckout` → `posRetailSales` | `etims-tax-engine` (estimate only) | in-checkout tender legs | receipt object on the sale | `products.stock −qty`, `sold`, `inventoryVersion +1` | `calculateCommission({category:'pos'})` → category 5% | UNPROVEN | **TAX YES, eTIMS NO** |
| 5 | Till service sale | — | — | — | — | — | — | — | **N/A-blocked** |
| 6 | Till mixed sale | — | — | — | — | — | — | — | **N/A-blocked** |
| 7 | Manual cash cart | in-flight (SC-1) | — | in-flight tender engine | — | — | — | — | **NOT RUN** |
| 8 | Manual supported tender | in-flight (SC-1) | — | in-flight | — | — | — | — | **NOT RUN** |
| 9 | Multi-tender | `sokoni-pos-tender.js` (uncommitted) | — | same | — | — | — | — | **NOT RUN** |
| 10 | Quick Pay product | canonical checkout | as row 4 | as row 4 | as row 4 | as row 4 | as row 4 | UNPROVEN | partially = row 4 |
| 11 | Quick Pay service | — | — | — | — | — | — | — | **N/A-blocked** |
| 12 | Quick Pay mixed cart | — | — | — | — | — | — | — | **N/A-blocked** |
| 13 | Online marketplace order | `orders/{id}`, `order-settlement` | **`etimsOnOrderCompleted` → full lifecycle** | `payment-orchestrator` / IntaSend | `etimsGenerateInvoice` + receipt render | per order contract | marketplace lane **15%**, min KES 10 | UNPROVEN | **CONNECTED (wire pending)** |
| 14 | Refund | `posProcessRefund` → `posRetailSales` | **no credit note raised** | — | — | `stock +qty` | — | UNPROVEN | **TAX REVERSAL MISSING** |
| 15 | Void | `voidPOSSale` → `posSales` | **no cancellation raised** | — | — | `stock +qty`, `soldCount −qty` | — | — | **TAX REVERSAL MISSING + no caller** |
| 16 | Reversal | `etimsInvoiceLifecycle` | modelled, PENDING at wire | — | — | — | — | — | **MODELLED ONLY** |

### KRA-specific detail (§22 second list)

| Item | Answer |
|---|---|
| KRA PIN source | `etimsProfiles/{auth.uid}` — **ACCOUNT-scoped**, one PIN and one invoice sequence even for a two-shop merchant. Merchant V2's `kra-tax` route declares `ctx: [SELLER_UID]` alone for exactly this reason and states it in its header |
| Tax classification | `etims-tax-engine` categories A / B / C, from the item's `taxCat`; default standard-rated |
| Tax calculation authority | `etims-tax-engine.computeInvoice()` — pure, single source, three implementations converged onto it |
| Receipt/invoice authority | `etims.js` (render) + `etimsGenerateInvoice` (issue) |
| eTIMS submission authority | `etims-lifecycle.js` → `etims-kra-adapter.js` → **returns PENDING, always** |
| Submission state | `transmittable: false` on every record; rows queue in `etimsTransmissionQueue` |
| Correction / reversal authority | `etimsInvoiceLifecycle` — credit, debit, cancel, amend, reversal. **Not reachable from any POS reversal path** |
| Credential / token authority | `_ALL_SECRETS` on the eTIMS CFs (Secret Manager). Not read in this pass — **UNPROVEN** |
| Failure / unknown state | Tax: `vatStatus: 'undeclared'`, `vatCents: null` with a stated reason. Payment: `OUTCOME_UNKNOWN` preserved separately. The two are never collapsed |

---

## 3. Why rows 2, 3, 5, 6, 11, 12 are N/A-blocked — and it is NOT a naming problem

**A previous finding in this workstream said `trackInventory` vs `trackStock` were "two
spellings of one flag". That was wrong and is withdrawn.** They are fields on two different
collections, and the real situation is structural:

| | `products/{id}` | `posProducts/{id}` |
|---|---|---|
| stock flag | `trackInventory` | `trackStock` |
| priced/stocked by `posCompleteCheckout`? | **YES** — four call sites (`pos-zero-friction.js:305, 373, 727, 1393`) | **NO** — zero references in the whole file |
| missing item behaviour | throws `Product <id> disappeared` | — |
| served ruleset | normal seller scoping | ownership keyed on `sellerId`, which the canonical writer never sets → **every client query rejected wholesale** |
| status | canonical | *"no longer the collection a sale is priced or stocked from"* — `POSPRODUCTS_MIGRATION_GRAPH.md`; second writer decided for retirement (Option C) |

The in-flight catalogue model defines a **service** as a `posProducts` row with
`trackStock: false`. On today's evidence that places services in a collection the till does not
settle against and whose client reads the rules reject.

**Third layer, and the one that produces the symptom the withdrawn finding guessed at, by a
different route:** `business-bootstrap.js` reads `posProducts` rows and projects
`trackInventory: p.trackInventory !== false`. A row carrying `trackStock:false` and no
`trackInventory` yields `trackInventory: **true**` — so a service would be handed to the POS as
a **stocked product**. That is a projection default, not a spelling clash.

**This is for the owning workstream, not for this one.** Those files are foreign and
uncommitted; they were read, never edited. The finding is recorded so it is answered before
Quick Pay services are declared ready.

---

## 4. Refund / void and tax — the gap §12 of the brief asked about

Neither POS reversal path raises a tax document:

- `posProcessRefund` restores `products.stock +qty` on `posRetailSales` and **raises no credit
  note**.
- `voidPOSSale` restores `stock +qty`, `soldCount −qty` on `posSales` and **raises no
  cancellation** — and has no client caller at all.

`etimsInvoiceLifecycle` models all of credit note / debit note / cancellation / amendment /
reversal. **Nothing connects a POS reversal to it.**

Because no POS sale ever produced an eTIMS invoice (§1), there is at present **no tax document
to reverse** — so this is a latent gap rather than a live inconsistency. It becomes live the
moment POS sales are connected to the lifecycle, and must be built in the same unit, or a
refunded sale leaves a standing invoice.

The double-reversal invariants the brief demands are therefore currently satisfied *vacuously*
on the tax axis, and by the still-unbuilt projection guard on the stock axis. Neither is a
reason to relax them.

---

## 5. Commission vs tax — the ordering, traced not invented (§13)

From `posCompleteCheckout`:

```
server-priced subtotal (from canonical products, NOT the client's price)
  → discounts
  → tax        etims-tax-engine.computeInvoice(), VAT-INCLUSIVE
  → total      authoritativeTotal = subtotal − discount + taxTotal
  → payment    tender legs, verified
  → commission finos-utils.calculateCommission({ orderAmountCents: toCents(o.total) })
  → payout
```

**Commission is computed on the tax-inclusive total** (`o.total`), in cents, by the canonical
engine. Tax is not derived from commission and commission is not derived from tax — they are
separate steps in that order. Recorded because the brief said not to invent it.

Two till commission paths exist, both answering 5% today by different mechanisms:

```
TILL      calculateCommission({category:'pos'}) → ALIASES.pos → RATES.marketplace.pct  = 5
DISPATCH  planSaleCommission() → resolvePosRate() → POS_PLAN_RATES                      = 5
```

**`isMarketplaceSellerSale('pos')` is `false`**, so the 15% marketplace ladder correctly never
reaches the till. But the live till path lands on the marketplace **category** row — so raising
`RATES.marketplace.pct` to "align" it with the online lane would silently charge **15% at every
till**. The brief forbids that change; `scripts/test-commission-lane-separation.js` now makes
the prohibition executable (22/0, 2 UNPROVEN).

---

## 6. Blockers

| | |
|---|---|
| **K-1** | **KRA transmits nothing.** `SPEC_LOADED = false`; the spec PDF is absent from the repo. Everything upstream is built. Obtaining and mapping the spec is the only work that changes this, and it is confined to one file by design |
| **K-2** | **POS and till sales never enter the eTIMS lifecycle.** Online orders do. No trigger exists on either POS collection |
| **K-3** | **No POS reversal raises a tax document.** Latent while K-2 holds; live the moment K-2 is fixed |
| **K-4** | **Services cannot be settled by the till** — they are modelled in `posProducts`, which `posCompleteCheckout` does not read. Owning workstream's call |
| **K-5** | `SPEC_LOADED` is a dead export — nothing gates on it |
| **K-6** | Secret Manager credential wiring for eTIMS **not traced** in this pass — UNPROVEN |

## 7. What was NOT done

- No KRA code changed. No tax rule invented. No second KRA authority created.
- The cart/tender/service files were **read, never edited** — they are foreign and uncommitted.
- Secret/credential layer not traced.
- No realtime claim: no two-device run.
