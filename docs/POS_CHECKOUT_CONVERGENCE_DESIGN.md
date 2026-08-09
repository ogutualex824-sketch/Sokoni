# POS Checkout Convergence — Design & Regression Plan

**Status:** DRAFT for approval · **Author:** AI engineering · **Date:** 2026-08-07
**Risk:** HIGHEST — the money path. Shadow-first, feature-flagged, regression-gated. **No money-path code ships from this doc without sign-off.**
**Related:** [[project_pos_inventory_convergence]] · [[reference_pos_checkout_stock_authority]] · [[project_idempotency_hardening]]

---

## 1. Goal — one checkout engine for every terminal

Every terminal — **pos.html (main), pos-v2, pos-checkout, mobile, future kiosks** — completes a sale through exactly one canonical call:

```
Checkout → posCompleteCheckout() → ONE Firestore transaction:
   ├── Idempotency claim (exactly-once)
   ├── Canonical order (orders/…)
   ├── Canonical stock deduction (products.stock, floored, inventoryVersion++)
   ├── Payment record
   ├── (ledger / analytics / customer history via the existing order-settlement path)
   └── returns { saleId, receipt }
Printing stays DOWNSTREAM (queue + retry) — a print failure NEVER rolls back a committed sale.
```

Today only **pos-v2 / pos-checkout** call it. **pos.html/pos.js is a parallel local-first implementation** (IndexedDB saga + `posTransactions`, canonical stock now bridged by the interim `_posSyncCanonicalStock`, but **no canonical order** → not in dashboard GMV). This design converges the main terminal onto `posCompleteCheckout`.

---

## 2. The canonical contract (verified)

`functions/pos-zero-friction.js:54 posCompleteCheckout` (onCall):
- **Payload:** `{ idempotencyKey, merchantId, branchId, shiftId, items:[{productId,qty,unitPrice}], customer, payments:[{method,amount}], couponCode, loyaltyRedeemPoints, subtotal, discountTotal, taxTotal, grandTotal, metadata }`
- **Idempotency (atomic):** `db.collection('posIdempotency').doc(idempotencyKey).create({status:'processing'})` — exactly one caller creates it; a concurrent/retry call gets `ALREADY_EXISTS` → returns the cached `{saleId, receipt}` if complete, else rejects "in progress". This is what makes double-tap / refresh / HTTP-retry / two-terminals safe.
- **Server validation:** reads canonical `products`, enforces price tolerance (≤1 KES/item) and subtotal (±2%). Coupon validation.
- **Returns:** `{ saleId, receipt, cached? }`.

**Proven caller (pos-v2.html:743-763):** builds the payload with **one `idempotencyKey` per sale reused on offline retry**, calls the CF, and prints **after** success (`_finishSale` → `showReceiptPreview`/`_printSaleReceipt`). Printing is already downstream there — the pattern to copy.

---

## 3. The hard part — pos.js is offline-first

pos.js must not lose its offline-first property (a sale must never block on the network). So the bridge is:

```
Sale committed LOCALLY (IndexedDB — instant, cashier unblocked)
        │  + one stable idempotencyKey stamped on the local txn
        ▼
Enqueue a posCompleteCheckout call (durable queue) with that idempotencyKey
        │
   online ──► drain ──► posCompleteCheckout() ──► canonical order + stock (exactly-once)
   offline ─► stays queued ─► drains on reconnect (same key → still exactly-once)
        │
        ▼
Receipt queued downstream (existing PrinterManager queue) — independent of settlement
```

- The **idempotencyKey is generated once per sale** and stored on the local transaction, so any number of retries (reconnect, refresh, app relaunch, double-drain) settle **one** canonical order.
- The local saga stays as the **session-authoritative** record; `posCompleteCheckout` becomes the **canonical settlement**. Once it's authoritative, the interim `_posSyncCanonicalStock` is **removed** (posCompleteCheckout deducts canonical stock itself — no double deduction).

---

## 4. Payload mapping (pos.js → posCompleteCheckout)

| Canonical field | pos.js source |
|---|---|
| `idempotencyKey` | new per-sale key stamped on `txn` (reused on every retry) |
| `merchantId` | POS merchant uid (`sokoniUser.uid` / `sokoni_merchant_id`) |
| `branchId`, `shiftId` | `state.settings.branchId` / `state.currentShift.id` |
| `items[{productId,qty,unitPrice}]` | `txn.items` → `{productId:item.id, qty:item.qty, unitPrice:item.price}` |
| `payments[{method,amount}]` | `payInfo` → `[{method, amount}]` |
| `customer` | `state.currentCustomer` (id/phone) |
| `subtotal / discountTotal / taxTotal / grandTotal` | `txn` totals |
| `metadata` | `{ source:'pos.js', localTxnId: txn.id }` |

Server is authoritative on price/stock; the client values are validated, not trusted.

---

## 5. Instrument-first — SHADOW mode (your requirement, and the first thing we ship)

**Before** `posCompleteCheckout` becomes authoritative, run it in **shadow** behind a flag (`POS_CHECKOUT_SHADOW`), default ON in dev / a pilot till:

```
Legacy saga commits (authoritative)         posCompleteCheckout() runs in parallel (shadow)
   expected: order, stock, total       vs.     actual: saleId, canonical stock, total
                          │
                          ▼
          Compare → log discrepancy to posCheckoutShadow/{localTxnId}:
             { match:bool, expectedTotal, actualTotal, expectedItems, stockDeltaExpected/Actual, error }
```

- Shadow calls use the **same idempotencyKey** the real settlement will use, so the observation is representative (and, because it's idempotent, turning it authoritative later prints no new order).
- **No reliance** on the shadow result — the legacy saga stays authoritative during observation.
- Success bar to promote: an agreed run of consecutive sales with `match:true` (totals, item lines, stock deltas), **zero** duplicate orders, across last-item / multi-qty / refund / void / offline-replay.

---

## 6. Phased rollout (each gate-passed before the next)

| Phase | Scope | Flag | Risk |
|---|---|---|---|
| **0. Design** | This doc + regression plan. | — | none |
| **1. Shadow** | pos.js calls posCompleteCheckout in parallel, compares, logs `posCheckoutShadow`. Legacy stays authoritative. | `POS_CHECKOUT_SHADOW` | LOW (no behaviour change) |
| **2. Observe** | Run the regression (below) + a real pilot-till day; review discrepancies; fix mapping until 100% match. | shadow | LOW |
| **3. Authoritative (pilot)** | Flip one till: posCompleteCheckout is the settlement; local saga stays session-authoritative; **remove `_posSyncCanonicalStock`** for that path (no double deduct). | `POS_CHECKOUT_CANONICAL` (per-terminal) | MED |
| **4. All terminals** | Enable canonical checkout everywhere; pos-v2/pos-checkout already there. | flag default on | MED |
| **5. Retire legacy** | Remove the local-only settlement branch after a stable observation window. | — | MED |

---

## 7. Regression plan (must pass before Phase 3 — your checklist)

**Inventory:** sell last item (stock → 0, not negative) · sell multiple qty · refund (stock restored once) · void (stock restored once) · stock-in · **two terminals selling the same item simultaneously** (no oversell; atomic) · **offline recovery** (sell offline → reconnect → settles once).

**Orders:** every completed sale → **exactly one** canonical `orders` doc. No duplicates, no missing.

**Analytics:** each sale immediately updates GMV / order count / revenue / seller dashboard / reports (via the existing paid-order analytics hooks that fire on canonical order creation).

**Idempotency (the most important):** for each of — browser refresh mid-checkout, Bluetooth print fail, network reconnect, cashier double-click — assert **one** payment, **one** order, **one** stock deduction, **one** receipt. (Guaranteed by the atomic `posIdempotency.create()` + one key per sale.)

**Printer:** print failure → receipt queued + retried; **sale stays committed** (never rolled back). iOS falls back to HTML receipt.

**No-regression:** checkout latency unchanged for the cashier (local commit is instant; settlement is async); no new CLS; works iPhone Safari + Android Chrome. On-device only (App Check blocks headless).

---

## 8. Risks / non-goals
- **Double deduction** if both the legacy local→canonical bridge (`_posSyncCanonicalStock`) and posCompleteCheckout run authoritatively. Mitigation: `_posSyncCanonicalStock` is removed on the same terminal that flips to canonical (Phase 3), never both.
- **Offline sales** can't settle until online — acceptable (queued, idempotent replay); the local receipt/record is immediate.
- **Non-goal:** changing pos-v2/pos-checkout (already canonical) or the printer pipeline (already downstream).
- **Non-goal:** removing the local IndexedDB saga — it stays as the offline-first session record; only the *settlement* moves to canonical.

---

## 9. Recommended first step
Approve **Phase 1 (shadow)** only. It ships zero behaviour change — pos.js keeps selling exactly as today — while `posCompleteCheckout` runs alongside and logs whether it would have produced the identical order/stock/total. That gives us real evidence (not assumptions) that the mapping is correct **before** any money-path cutover, exactly as you asked. Phases 3+ proceed only after the regression + shadow observation pass on-device.
