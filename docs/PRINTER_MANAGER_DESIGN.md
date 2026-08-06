# PrinterManager — Design (Consolidation)

**Status:** DRAFT for approval · **Author:** AI engineering · **Date:** 2026-08-07
**Milestone:** R1.1 (Merchant Experience) · **RC impact:** touches the sale-time receipt path — R1.1, phased, fallback-preserving
**Related:** [[Platform Constitution]] (extend don't rebuild) · [[SmartPOS]] · [[reference_receipt_layout_engine]] · [[Universal Printer v3.0]]

---

## 1. Key finding — PrinterManager already exists (more complete than the spec)

`window.PrinterManager` (`sokoni-printer-manager.js`) is already a single printer service that meets every requirement of the ask:

- **One entry / five transports** — `print(docType,data,opts)` + high-level `printSokoniReceipt()` over **Bluetooth, USB, Serial, Network, Browser** adapters, all real (`sokoni-universal-printer.js`: BLE `navigator.bluetooth.requestDevice`, USB `navigator.usb`, Serial `navigator.serial`, Network `WebSocket`/`fetch`, Browser `window.print`).
- **`printReceipt(order)` already exists** — `PosPrintService.printAfterSale(receipt, context)` (`sokoni-pos-print-service.js:789`) is the document-level entry described in the spec.
- **Pairing memory + auto-reconnect** — `localStorage['spp_profile']` + `['p58e_paired_device']`; `autoReconnect()` uses `navigator.bluetooth.getDevices()` (Chrome 85+, no gesture) plus an exponential-backoff BLE reconnect ladder with a `_manualDisconnect` guard.
- **Persistent queue + retry** — `PrintQueue` (localStorage `spp_queue`/`spp_history`), auto-drains on `connected`/`focus`; PosPrintService enqueues when offline and drains on reconnect.
- **Status** — `PrinterManager.status()`/`.connected`/`.diagnostics()`, connect/disconnect/printed/error events, 30s health heartbeat.

**The problem is fragmentation, not capability.** Three parallel print stacks coexist, and the live sale path uses the *legacy* one:

| Stack | Entry global | Where it's wired |
|---|---|---|
| **A — Enterprise (target)** | `PrinterManager` / `PosPrintService` | Loaded, but `printAfterSale` has **no sale-time call site** |
| **B — Legacy (actually prints sales)** | `SokoniPrint` → `PosPrinter` | `pos.js:1037` sale receipt; `pos-boss.js:405` |
| **C — v2 offline-first** | `SokoniPosprint` | `pos.html:1932` init + Test Print + the `#printer-status-txt` UI |
| **D — HAL experiment** | `PrinterProvider` / `SokoniDriverManager` | not in the sale loop |

Plus: **three competing queues** (localStorage `spp_queue`, IndexedDB `print_queue`, SokoniPrint's in-memory), the **status UI listens to Stack C** (not the manager), and a **name collision** — `window.SokoniReceiptEngine` is exported by both `sokoni-receipt-engine.js` and `pos-receipt-engine.js`.

**Design principle:** make Stack A canonical, point the sale path + status UI at it, retire B/C/D behind it — **without ever breaking receipt-at-sale.** `SokoniReceipt` (`sokoni-receipt.js`) stays the single transport-agnostic composer; PrinterManager owns transport.

---

## 2. Target architecture

```
        SALE COMPLETE (pos.js)                     COMPOSER (layout only)
                 │                                 SokoniReceipt.doc({width:32})
                 ▼                                          │  (device-independent)
        PosPrintService.printReceipt(order) ◄──────────────┘
                 │   (document orchestrator: history, audit, offline queue drain)
                 ▼
           PrinterManager.print('sale', bytes)      ← THE single transport service
                 │
     ┌───────────┼───────────┬───────────┬───────────┐
  Bluetooth     USB        Serial      Network     Browser(fallback)
  (+ iOS HTML fallback when Web Bluetooth is absent — SokoniIOSPrint)
                 │
        ONE persistent queue (spp_queue) · pairing memory · auto-reconnect · status/events
                 │
        #printer-status-txt  ◄── PrinterManager events (single source of truth)
```

- **One call at sale time:** `PosPrintService.printReceipt(order)` (thin alias over the existing `printAfterSale`). It composes via `SokoniReceipt`, hands bytes to `PrinterManager`, records history/audit, and — if offline — enqueues and drains on reconnect.
- **One transport service:** `PrinterManager` (already built) — the only thing that talks to hardware.
- **One composer:** `SokoniReceipt` — layout only, transport-agnostic (per [[reference_receipt_layout_engine]]).
- **One queue, one status source.** Stacks B/C/D become thin shims or are removed once A is proven.

---

## 3. Consolidation gaps (what to actually do)

1. **Wire the sale path to Stack A.** Replace `pos.js:1037` `SokoniPrint.print('receipt', …)` (and `pos-boss.js:405`) with `PosPrintService.printReceipt(order)`, **keeping the current `SokoniPrint`/`PosPrinter.printBrowser` chain as the fallback** until parity is proven on real hardware.
2. **Single status source.** Re-point `#printer-status-txt` (`pos.html:1932`, currently on `SokoniPosprint` events) to `PrinterManager` `connected`/`disconnected` events. One truth for "is a printer connected."
3. **Unify the queue.** Make `spp_queue` (PrinterManager) the sole persistent print queue; have C's IndexedDB `print_queue` and B's in-memory queue defer to it (or drain into it) so a failed receipt is never stranded in a stack nobody drains.
4. **Resolve the composer collision.** `pos-receipt-engine.js` and `sokoni-receipt-engine.js` both define `window.SokoniReceiptEngine`; `SokoniReceipt` is the canonical 58mm composer. Namespace or retire the collider so layout has one owner.
5. **iOS fallback intact.** Web Bluetooth is absent on iOS Safari — keep `SokoniIOSPrint` (HTML receipt) as PrinterManager's browser/iOS transport, not a fourth parallel path.

---

## 4. Phased, reversible rollout

Every phase preserves a working receipt at sale time and is independently revertable. **Receipt printing must never regress — the fallback chain stays until the new path is proven on a real printer.**

| Phase | Scope | Risk | RC |
|---|---|---|---|
| **0. Map** | Inventory the three stacks, queues, status wiring, collisions (this doc). | none | safe |
| **1. Sale path → PosPrintService** | Route `pos.js:1037` + `pos-boss.js:405` through `PosPrintService.printReceipt(order)`; **keep `SokoniPrint`/`printBrowser` as automatic fallback on any error.** Verify a real sale prints on BT + browser. | MED (money-adjacent UX) | R1.1 |
| **2. Single status source** | `#printer-status-txt` ← PrinterManager events; remove the Stack-C status listener. | LOW | R1.1 |
| **3. One queue** | Make `spp_queue` the sole persistent queue; C/B defer/drain into it; auto-drain on reconnect + focus. Verify an offline sale queues and prints on reconnect. | MED | R1.1 |
| **4. Composer collision** | One owner for `SokoniReceiptEngine`; `SokoniReceipt` is the sole 58mm composer behind PrinterManager. | LOW–MED | R1.1 |
| **5. Retire dead stacks** | Once A is proven, reduce B/C/D to shims or remove; delete only after the sale path + Test Print + status all run on A. | MED | R1.1 |

**Per-phase verification:** a real receipt prints at sale (BT and browser fallback); Test Print uses the same stack; status reflects true connection; an offline sale queues then prints on reconnect; iOS Safari falls back to the HTML receipt. Because printing needs real hardware, each phase ends with an on-device check (the founder's device), not just headless.

---

## 5. Acceptance criteria (maps to the printer requirements)
1. **One call:** the POS prints a sale via a single `PosPrintService.printReceipt(order)` — no direct `SokoniPrint`/`PosPrinter`/`SokoniPosprint` calls in the sale path.
2. **Remembers printers:** a previously paired BT printer reconnects automatically on load (no re-pair) where the browser allows (`getDevices()`); manual Disconnect is respected.
3. **Multi-transport:** the same call prints over Bluetooth, USB, Serial, Network, and the browser fallback; iOS Safari uses the HTML fallback.
4. **Queue + retry:** a print that fails (offline / printer off) is queued and retried automatically on reconnect; never silently lost.
5. **Status:** `#printer-status-txt` (and any multi-till surface) reflects the true PrinterManager connection state from one source.
6. **No regression:** receipt-at-sale keeps working throughout; fallback chain preserved until parity proven.
7. **One composer:** `SokoniReceipt` is the sole 58mm layout owner; the `SokoniReceiptEngine` name collision is resolved.

---

## 6. Risks / non-goals
- **Money-adjacent UX:** a broken receipt at sale is a serious cashier problem. Hence fallback-preserving phasing and on-device verification each phase — never a big-bang switch.
- **iOS has no Web Bluetooth:** iOS must stay on the HTML/`SokoniIOSPrint` fallback; don't route it into a WebBLE-only path.
- **Real-hardware verification required:** transports can't be exercised headlessly; sign-off is on the founder's device (BT printer + browser fallback), same as the POS shell interactive regression.
- **Non-goal:** building new transports (all five exist) or a new composer (`SokoniReceipt` exists). This is consolidation, not construction.
- **TSPL/ZPL/CPCL** language drivers are shaped but marked "physical verification needed" — label printing beyond ESC/POS is out of scope until validated on hardware.

---

## 7. Recommended first step
Approve **Phase 1** (route the sale path through `PosPrintService.printReceipt(order)` with the existing fallback preserved) — it delivers the "one call" consolidation and the enterprise reconnect/queue benefits at the point that matters most (sale-time receipts), while staying fully revertable and never risking a lost receipt. Phases 2–5 follow with per-phase on-device checks.
