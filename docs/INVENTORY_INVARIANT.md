# Inventory invariant — one meaning of stock

**Status:** Phase A (till) and Phase B (every other writer) built locally, not deployed.
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
| Card-session verify | `index.js` `verifyIntasendPayment` | ✅ Phase B: `planStockDeduction(…, flag)`. Unmetered → no write; short → floored at 0 + `oversoldAlerts` |
| Marketplace finaliser | `index.js` `_finalizeMarketplacePayment` | ✅ Phase B: flag. Unmetered → `sold` only. A **deleted** product is not written; it used to throw and leave a PAID payment with no order, and is now flagged `product_missing` |
| Legacy Daraja callback | `index.js` `darajaSTKCallback` | ✅ Phase B: flag, same as above (Daraja itself is retired) |
| B2B wholesale approval | `b2b-wholesale.js` `approveWholesaleOrder` | ✅ Phase B: refuse. All reads come first (a multi-item approval **threw**); unmetered is no longer refused; stock + `inventoryVersion` + `updatedAt` move together |
| Retail engine (second POS rail) | `pos-retail-engine.js` `recordPOSSale` | ✅ Phase B: refuse. Unmetered → counters only; now bumps `inventoryVersion` (resolves finding D-b) |
| POS device sync | `pos-retail.js` `posSyncToMarketplace` | ✅ Phase B: one transaction per item (it was a blind batch that trusted a rule the Admin SDK bypasses); flag; a negative quantity is refused (it used to **raise** stock) |
| WAP reserve / release | `wap.js` `_svcInventoryReserve` / `_svcInventoryRelease` | ✅ Phase B: reads first (a multi-item reserve **threw**); unmetered is no longer refused; `reservations.{order}` records what was taken; release returns exactly that |
| Click & collect create | `pos-marketplace-sync.js` `createClickAndCollect` | ✅ Phase B, **the 9th writer**. It was missed by the first census because it wrote an absolute `Math.max(0, cur − qty)`, not an increment. `stock ?? stockQty ?? quantity ?? 0` refused every unmetered item. Lines now record `stockDeducted` |
| Click & collect cancel | same, `updateClickAndCollectStatus` | ✅ Phase B: the order and products are read **inside** the transaction (two concurrent cancels could both return stock). `planStockReturn` is used. A deleted product no longer fails the cancel. The order records `stockReturn` |

**Phase B design (owner-approved 2026-09-30).** One shared deduction helper in `shared/sellability.js`, consumed by
every writer, instead of eight separate readings of stock:

- unmetered → no stock mutation;
- metered → atomic decrement;
- metered and insufficient → refuse, or flag in `oversoldAlerts` where payment is already taken (house rule:
  never reject a post-payment race);
- never negative.

## Findings recorded by Phase B, NOT fixed here

- **`posSyncToMarketplace` has no shop-ownership check.** Any signed-in account can move any product's stock and
  `soldCount`. It is exported from `functions/index.js`. This is an authorization defect, not a stock-semantics one, so
  it is its own repair.
- **`warehouse-scanner.html` writes `products.stockQty` from the browser.** This carries over from Phase A.
- **Production negative stock** left by the old code is not repaired. A read-only census is the owner's call.

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

## Evidence (Phase B)

**`scripts/test-inventory-unmetered-online.js` — 7/0**

| Check | What it proves |
|---|---|
| IB1 | The helper table, and the browser twin is byte-identical |
| IB2 | Finaliser: unmetered, repeat, metered, short (flagged), deleted product (order still finalises) |
| IB3 | B2B: multi-item approved; a short line refuses the whole approval |
| IB4 | Device sync: unmetered, short → 0 + alert, a negative quantity refused |
| IB5 | WAP: multi-item reserve, atomic refusal, exact release |
| IB6 | Click & collect: create/cancel with a deleted product; a second cancel is refused |
| IB7 | Structural: the inline `index.js` handlers and `recordPOSSale` consume the helper, and no raw stock write remains |

- **Parent `0e23ca3`: 0/7.**
  - IB2: a service goes to `stock: -3`.
  - IB3, IB5, IB6: unmetered items are refused.
  - IB4: counted stock goes to -1, and a negative quantity raises stock from 9 to 14.
- **Deliberate breakages 13/13**, covering the helper, every writer, and twin drift. The Phase A till breakages
  re-anchored onto the refactored till are 7/7.
- `merchant-ecosystem-convergence` is 144/1, identical to the parent. Finding D-b flipped to RESOLVED and now guards
  the fix.

## Behaviour changes to know before deploying

- A product carrying **only** the legacy `stockQty` (no `stock`) is no longer stock-limited at the till. That matches
  what the online checkout has always done.
  - Known client writer of `products.stockQty`: `warehouse-scanner.html` (a browser write).
  - It is recorded as its own finding; the scanner should write `stock` through the inventory authority.
- Unmetered items no longer bump `inventoryVersion` on a sale, because their stock did not change.
- Existing products already driven negative by the old code (for example `stock: -20` on a service) stay negative
  until corrected. Such an item is now **metered at 0 available**. **No data migration is run by this slice.** A
  read-only census of `products` where `stock < 0` is the owner's call before any repair.
