# Merchant v2 — target architecture (receipts, POS, workspace)

**Status:** TARGET, recorded deliberately. **Nothing here is built.** It exists so the remaining
messaging / location / release gates can be closed without anyone inventing a parallel POS or a
second receipt model in the meantime.

Related: [[CANONICAL_ORDER_DESTINATION]] · [[MESSAGES_PLATFORM_CENSUS]] · [[MERCHANT_SHELL_CAPABILITY]]

---

## 1. Merchant v2 is the workspace; POS Setup is advanced configuration

```
approval → shop setup → MERCHANT V2  ← the operating workspace
                          Dashboard · Orders · Sell/POS · Messages · Inventory
                          Customers · Payments · Delivery · Receipts · Analytics
                             ↓
                    Print / Share / WhatsApp / Delivery
```

**`pos-setup.html` stops being a doorway.** An approved merchant with an active shop sells from v2
immediately. POS Setup becomes **Settings → POS & Terminals**: printer pairing, terminal
registration, multiple tills, receipt templates, cashier permissions, payment-terminal config, test
prints, diagnostics, offline testing, advanced tax/receipt settings.

Configuration is for merchants who need it, not a toll gate for merchants who don't.

## 2. Receipt identity — one record, reconcilable

Every receipt carries enough to reconcile it, whether the sale began online or at the counter:

```
receiptId  orderId  transactionId  createdAt
sellerUid  shopId   terminalId?    paymentMethod  fulfillmentType
```

`terminalId` is present only where a terminal exists — absent for a phone sale, and **not**
fabricated.

### The timestamp rule

**The stored timestamp is the SERVER's and is immutable. The device clock is display only.**

A phone clock is user-settable and must never be the authority on a financial record. The UI
formats local time for the merchant; the receipt, order, payment, POS sale and delivery record all
carry the *same* server timestamp, so the same sale never appears at two different times in two
different views.

This mirrors what `merchantAdjustStock` already does — `serverTimestamp()` written inside the
transaction alongside the value it timestamps.

## 3. Sell → receipt, in one surface

Sell captures items, discount, payment method, cash received and change, and fulfilment — pickup or
delivery — without leaving v2. On completion it shows the receipt id and server time, with **Print**
and **Share** side by side (as the order sheet already does), plus View Order / Send Receipt /
Start New Sale.

**Delivery capture feeds the canonical destination, not a POS-only address model.** That is the
whole reason this document exists: the destination contract
([[CANONICAL_ORDER_DESTINATION]]) is **still unresolved**, and building a POS location form now
would add an eleventh spelling to the ten already measured.

> **Blocked until the destination census runs.** POS may read an existing destination; it must not
> write one.

## 4. P58E should be owned by the shell, not an iframe

The printer connection belongs to the v2 shell's device layer, so a merchant can
**sell → pay → change → pickup/delivery → complete → print → share → sell again** without a page
change.

**Today v2 frames POS**, and an iframe cannot share a GATT handle without a native rebuild. That is
already recorded as the expected cause if the P58E device check fails across
`v2 → POS → Orders → Analytics → POS` ([[RUNBOOK_p58e_and_pos_device_checks]]). This is the
architectural reason to eventually render POS natively — not a reason to start now.

## 5. Sequencing — what must close first

```
1  messaging authority        DONE   51/0 code, not deployed
2  history scoping            DONE   21/0 rules (emulator), not released
3  canonical destination      BLOCKED — data census not yet run
4  messaging Function release  one coherent deploy
5  premium Messages UI
6  receipts + native POS       ← this document
```

**Nothing in section 3 may be built before item 3 closes.** A beautiful POS location form on top of
ten competing destination fields would be the most expensive mistake available here.

## 6. Explicitly NOT a licence to

- create a second POS, a second receipt model, or a POS-only address schema
- write any new destination field
- trust the device clock for a stored financial timestamp
- make POS Setup a prerequisite for selling
- render a receipt total that was not produced by the same server authority as the order
