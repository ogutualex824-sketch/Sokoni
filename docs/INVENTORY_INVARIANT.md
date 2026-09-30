# Inventory invariant — one meaning of stock

**Status:** Phase A (till) built locally, not deployed. Phase B (the online writers) is next.
**Owner decision:** 2026-09-30. **Authority:** `functions/shared/sellability.js` → `stockOf(p)`.

Related: [[SmartPOS]] · [[PACKAGES_AND_BUNDLES]] · [[QUICK_CHARGE_CENSUS]] · [[ECOSYSTEM_SYNC_CENSUS]] ·
[[project_product_persistence_invariant]]

---

## The invariant

| `products/{id}.stock` | Meaning | What a sale may do |
|---|---|---|
| a number `> 0` | **metered**, available | decrement atomically, never below zero; refuse more than there is |
| `0` | **metered**, sold out | refuse; the product still exists (out of stock ≠ deleted) |
| absent, `null`, or not a number | **UNMETERED**: a service, or a legacy product | sell freely. Stock is **never created, decremented or returned** |

- `trackInventory: false` also means "do not touch stock". A package or bundle has no stock of its own; its
  **components** do, each under the same rule.
- Only `stock` counts. The legacy `stockQty` and `quantity` fields are **not** stock to this rule, because
  `sellability.stockOf` never honoured them online. The till now agrees.

**Why this matters.** `FieldValue.increment(-n)` on an **absent** field *creates* it at `-n`. A printing service with
no stock field sold once became `stock: -20`. Sellability then read it as metered with nothing available, and the
next sale was refused for good. A refund doing `increment(+n)` made a service metered with a tiny stock. Found by
`test-quick-charge-sale.js` QS8 (the cyber basket), 2026-09-30.

## Every writer of `products.stock`

| Writer | Path | State |
|---|---|---|
| Till sale check | `pos-zero-friction.js` `posCompleteCheckout` (loose items + package components) | ✅ Phase A: `_SELL.stockOf(p).metered` |
| Till sale write | same (loose items, folded components, the component loop) | ✅ Phase A: an unmetered item keeps `sold`/`totalUnitsSold`/`totalRevenue`, with no `stock` or `inventoryVersion` write |
| Till pre-sale check | same, `dryRun` → `stockDeltas` | ✅ Phase A: metered items only; never a fake `0 → 0` |
| Till refund | `pos-zero-friction.js` `posProcessRefund` | ✅ Phase A: returns only while metered, and at most the line's `stockDeducted`. The refund record carries `stockReturned` per line. A sale from before `stockDeducted` existed is judged by today's metering. |
| Online order finaliser | `index.js` ≈3280 | ⏭ Phase B |
| Shared marketplace deduction | `index.js` ≈4053 | ⏭ Phase B |
| Legacy Daraja path | `index.js` ≈4409 | ⏭ Phase B |
| B2B wholesale | `b2b-wholesale.js` 454 | ⏭ Phase B |
| Retail engine (second POS rail) | `pos-retail-engine.js` 394 | ⏭ Phase B |
| Retail | `pos-retail.js` 78 | ⏭ Phase B |
| WAP | `wap.js` 803 (+ reservation return 822) | ⏭ Phase B |
| Marketplace sync return | `pos-marketplace-sync.js` 210 | ⏭ Phase B |

**Phase B design (owner-approved 2026-09-30).** One shared deduction helper in `shared/sellability.js`, consumed by
every writer, instead of eight separate readings of stock:

- unmetered → no stock mutation;
- metered → atomic decrement;
- metered and insufficient → refuse, or flag in `oversoldAlerts` where payment is already taken (house rule:
  never reject a post-payment race);
- never negative.

## Sale-line record

A till sale line now records **`stockDeducted`**: the units that line took from `products.stock` (0 for unmetered,
`trackInventory:false` and package lines). Package-component units are not attributed to a line.

## Evidence (Phase A)

**`scripts/test-inventory-unmetered-till.js` — 8/0**

| Check | What it proves |
|---|---|
| IA1 | The cyber basket (printing with **no** stock field, envelopes, scanning quick charge) → one M-PESA payment, one sale, one receipt, KES 390; envelopes 50 → 45; printing gets no stock field; the attached customer earns 39 points |
| IA2 | The same basket again succeeds; printing still has no stock, and `sold` moves |
| IA3 | Metered: 5 − 2 = 3; 1 < 2 is refused and stays 1; 0 is refused |
| IA4 | The dry-run shows a delta for the metered item only |
| IA5 | A refund returns the envelopes exactly and creates no stock on printing (`stockReturned` 5 / 0) |
| IA6 | A pre-change sale is refunded correctly |
| IA7 | A package takes its metered component, and its unmetered component gets no stock field |
| IA8 | A `stockQty`-only product is unmetered at the till and online alike |

- **QS8** (`test-quick-charge-sale.js`) now uses printing with **no** stock field. Permanent.
- **Deliberate breakages 7/7:** absent-as-zero, oversell, write-creates-stock, component, refund-to-anything, forgotten
  `stockDeducted`, invented dry-run delta.
- **Parent (`ca02732`):** 7 of 8 fail. The one that passes on the parent is IA3, metered behaviour, which is unchanged
  by design.

## Behaviour changes to know before deploying

- A product carrying **only** the legacy `stockQty` (no `stock`) is no longer stock-limited at the till. That matches
  what the online checkout has always done.
  - Known client writer of `products.stockQty`: `warehouse-scanner.html` (a browser write).
  - It is recorded as its own finding; the scanner should write `stock` through the inventory authority.
- Unmetered items no longer bump `inventoryVersion` on a sale, because their stock did not change.
- Existing products already driven negative by the old code (for example `stock: -20` on a service) stay negative
  until corrected. Such an item is now **metered at 0 available**. **No data migration is run by this slice.** A
  read-only census of `products` where `stock < 0` is the owner's call before any repair.
