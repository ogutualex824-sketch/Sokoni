# POS till convergence — the older till completes sales on the server (2026-10-03)

**Owner:** "Yes, build it now" — convert pos.html so every sale and restock goes through the server, instead of the browser updating marketplace stock.
**Branch:** `hosting/pos-till-convergence-on-863f0f6`, built on `hosting/pos-stk-route-on-a436e12` @ 863f0f6, which descends from live 72dca56. **NOT DEPLOYED.**
**Suite:** `scripts/test-pos-till-converged.js` — 13/0 on the branch; 0/13 on base 863f0f6; sabotage (sale sync back on) fails T4.
**Related:** [[COMMERCIAL_CONVERGENCE_2026-09-30]] · POS server payment gate (fix/pos-server-payment-gate-on-3357619, e534623 / d4a167c)

## What changed

| Where | Before | Now |
|---|---|---|
| `pos.js` payment.complete | sale written locally, browser pushed stock to canonical, sale queued to the legacy posTransactions mirror; posCompleteCheckout ran only as a dry-run shadow | **posCompleteCheckout for real** via `SokoniSaleSubmit.submit` (stable key, in-flight handled); nothing local unless the server returns a saleId; no legacy mirror queue; offline → no sale |
| `pos-db.js` adjustStock | every reason pushed to canonical | `sale:` / `rollback:` / `localOnly` → **local cache only** (the server owns the sale decrement); refund / void still push (see Open) |
| Stock-in (pos.js) / PO receive (pos-db.js) | browser push | **`correctStock` → merchantAdjustStock** ('restock', stable adjustmentId; PO marked received after every line is accepted) |
| M-PESA key | the prompt used its own random key while checkout used another → the gate refuses (`wrong_sale`) | `SokoniPosStk.callStk` returns its key; a sale paid by a prompt settles under **that key**. The same fix applies to **merchant-v2 Sell** (`sokoni-merchant-sell.js` carries `settleKey`, `sokoni-merchant-data.buildSale` uses it) |
| Card / manual Till | charged first, then recorded | **refused before any money moves**: the server cannot confirm them (card rail quarantined; manual Till refused by the owner) |
| `pos.html` | — | loads `sokoni-sale-submit.js` before `pos.js` |

## Release rules
1. **This branch must NOT ship before the server checkout from the payment-gate line** (fix/pos-server-payment-gate / d4a167c, part of the 6b chain). Live posCompleteCheckout (ee37437 lineage) does not confirm `postill_` prompts. Ship functions first, or together.
2. The merchant-v2 Sell key fix is required by the same gate. Without it, every merchant-v2 M-PESA sale is refused once the gate is live.
3. Only after this ships may sokoni-5b lock `products.stock / sold / inventoryVersion` server-only, and then only once (b) below exists for refund / void.

## Open
- **(b) Refund / void restock.** There is no server path that returns stock on an approved refund or void (the canonical refund is request → owner approves; the POS void chain is held by the owner). Until it exists, refund / void keep the browser push, and the stock rules hunk waits.
- **(d) Staff stock permission.** merchantAdjustStock is owner-only, so a cashier or branch till cannot restock. That is no worse than before (the browser write was already denied for non-owners); it is an owner decision, raised by sokoni-5b.
- **Customer / loyalty.** The payload omits `customer`. Local POS customer ids may not be canonical, and the server's ownership check would refuse the sale; local loyalty still records. Server loyalty for till sales needs canonical customer linking.
- **One M-PESA prompt per sale.** A second prompt carries a different key and is refused; split sales are cash + one prompt.
- **Not run here:** a browser run (RAM below the floor) and the emulator suite for posCompleteCheckout (POS-01..15 + GC on d4a167c).

## Pre-existing failures (identical on base 863f0f6)
- test-pos-architecture: 5 FAIL
- test-pos-boot-budget: 2 FAIL
