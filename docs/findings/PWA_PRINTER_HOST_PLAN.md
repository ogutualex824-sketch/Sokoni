# Canonical receipt + native PWA printer host — implementation plan

**Status:** PLAN · **Written:** 2026-08-26 · **Nothing implemented.**
Preceded by an audit of the existing device, receipt and print layers; every "reuse" below
names a file and function that already exists and was read.

Related: [[project_universal_printer_v3]] · [[project_printer_consolidation]] ·
[[reference_printer_reconnect_architecture]] · [[project_receipt_contract]]

---

## What the audit established

**Most of this already exists in pieces that do not know about each other.** The plan is
mostly wiring and one missing lifecycle, not new subsystems.

| piece | state |
|---|---|
| `SokoniReceiptDoc` | canonical, correct, minor-unit based. **Three defects.** |
| `posPrintJobs` | collection + CF-only rule **already in production** |
| `receiptIdOf()` | canonical idempotency key, exists |
| `PrintQueue` dedup on `receiptId` | right key, `localStorage` durability |
| `sokoni-device-hub.js` | strongest device layer — 9 `getDevices`, owns pairing, keyed registry |
| `posDevices` | device registry with CF writer and certified `ownsBiz` access |
| `autoReconnect` | **called by merchant-v2, implemented nowhere** |
| shop scoping in the device layer | **absent in both candidates** |
| any sale→print path | **does not exist** — nothing to undo |

---

## Slice 1 — canonical receipt correctness

`SokoniReceiptDoc` stays the single renderer. No second formatter.

### The input contract, as it actually is

```
o.receiptId | o.ref | o.orderNumber
o.createdAt | o.serverTimestamp
o.customer, o.shop, o.tax, o.terminalId
o.items[]  { name|title, qty|quantity, unitMinor, lineMinor }
o.totalMinor                                    MINOR UNITS
o.settlement { tenders[] { method, amountMinor } }
o.paymentRef | o.payment.reference | o.payment.mpesaCode
o.fulfilment
```

Minor units throughout, formatted only by `SokoniCash.fromMinor()`. **Conversion belongs at
the adapter boundary** — this is already the contract's design, not a new rule.

### The three confirmed defects

1. **`FULFILMENT / Not recorded` prints on every counter sale.**
   `sokoni-receipt.js:291` pushes the block unconditionally. An ordinary sale must carry no
   delivery section at all. Costs thermal paper on every receipt.

2. **`TOTAL PAID` renders its label with no amount** even when both tenders are present.

3. **No `Subtotal` / `Discount` / `Delivery Fee` lines exist.** The input surface has only
   `totalMinor`. Needs `subtotalMinor`, `discountMinor`, `deliveryMinor` — **carried, never
   derived from display prices.**

### Acceptance — the literal fixture

```
Sugar 2kg      1   2,800    2,800
Maize Flour    2     750    1,500
Subtotal                    4,300
Discount                     -300
Delivery Fee                  300
TOTAL                       4,300
CASH                        1,500
MPESA                       2,800
TOTAL PAID                  4,300
MPESA REF: TFG7H2K9QQ
```

Matrix: cash-only · M-PESA-only · combined · delivery · ordinary · discount · no discount ·
no customer · employee number present/absent. **The same fixture through POS, merchant-v2
Receipts and delivery, asserting byte-identical output** — that is what makes "one document"
a fact rather than an intention.

### A caution earned the hard way

My first pass reported four defects. Three were **my test passing the wrong shape** — the
renderer correctly refused to invent figures from input it did not recognise, and I read that
refusal as breakage. Any adapter work must start by proving the shape, not by loosening the
renderer to accept aliases. **Normalise at the adapter; do not grow the contract.**

---

## Slice 2 — the printer host

### Lifecycle owner: `sokoni-device-hub.js`

| | device-hub | pos-device-manager |
|---|---|---|
| `getDevices()` | **9** | 6 |
| `requestDevice` (pairing) | **3** | **0** |
| backoff/retry | **6** | 2 |
| printer-specific | 22 | **45** |
| shop scoping | **0** | **0** |
| global | `SokoniDeviceHub` | `PosDeviceManager` |

Device-hub owns pairing, which the other lacks entirely, is multi-transport
(USB/Bluetooth/Serial) and is less POS-coupled. `PosDeviceManager` stays underneath as the
printer transport. **No sixth Bluetooth implementation.**

### The `autoReconnect` defect

`merchant-v2.html:1344` calls `eng.autoReconnect ? eng.autoReconnect() : Promise.resolve(false)`.
No file implements it, so the ternary always takes `false` and the state falls to `saved`.
A merchant reads that as "my printer is gone". Implement it in the hub:

```
PWA starts → getDevices() → connect → CONNECTED
gattserverdisconnected → RECONNECTING → backoff → getDevices/connect → CONNECTED
```

A temporary failure must show **RECONNECTING**, never SETUP, and must **never erase the saved
device**. Note the browser limit honestly: first pairing needs a user gesture; restoration
does not, and only on Chromium. Elsewhere the honest state is `saved, not connected`.

### Host identity on `posDevices`

Reuse the existing collection; determine exact field names against the live schema before
adding any. Conceptually `printerHost`, `printerTransport`, `printerDeviceId`, `lastSeen`,
scoped by `merchantId`.

**The Bluetooth connection is never the authority for shop ownership.** A device is a host
because the server says so, not because it holds a GATT handle.

---

## Slice 3 — the durable print lifecycle

```
PENDING → CLAIMED → PRINTING → PRINTED
                 ↘ FAILED (retryable, with reason)
```

Idempotency key: **`receiptIdOf()`** — `receiptNumber || receiptNo`.

`posPrintJobs` is already `allow create, update, delete: if false` — CF-only. **Preserve
that.** Every transition is a callable:

- `createPrintIntent` — from a committed sale, shop-scoped, idempotent on `receiptId`
- `claimPrintJob({ jobId, deviceId })` — **atomic** `PENDING → CLAIMED`, in a transaction, one winner
- `completePrintJob` / `failPrintJob`

**The realtime listener must never call `print()`.** It discovers a pending intent and
attempts a claim; the claim decides. A duplicated event, a reload, two open windows, a
mid-print disconnect — all become harmless, because only the atomic transition grants
ownership.

`PrintQueue`'s `receiptId` dedup stays as an **execution cache**; the server job is the
authority.

---

## ⚠ The one open decision — it touches the frozen rules

The desktop must read pending jobs for **its shop**. The served rule is **user-scoped**:

```
allow read: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
```

A job created by a cashier's phone carries that cashier's `uid`. **The owner's desktop could
not read it.** Two honest options:

**A. Callable polling — no rules change.** `nextPrintJob({deviceId})` returns and claims
server-side. The frozen 436/0 proposal stays untouched. Costs true realtime; a short poll is
the fallback.

**B. Shop-scoped read — a rules change.** Add `|| (isAuthed() && ownsBiz(resource.data.shopId))`,
reusing the helper already certified at 26/0. Roughly 60–70 bytes against **739 free**. Gives
real `onSnapshot`. But it **modifies the frozen proposal**, which should then be re-run and
re-reviewed rather than amended quietly.

My recommendation: **B**, because polling a print queue is exactly the latency a merchant
feels at a counter — but it is a deliberate reopening of a frozen artifact and should be
decided explicitly, not assumed.

---

## Slice 4 — acceptance, deliberately hostile

Beyond the happy path, the suite must **produce the failure modes**:

- fire the realtime event **twice** → one receipt
- reload the desktop **between CLAIMED and PRINTED** → one receipt
- disconnect Bluetooth **during** printing → job retryable, not duplicated
- two desktop windows race a claim → exactly one wins
- a desktop on **Shop B** sees a **Shop A** job → refused
- printer offline → job stays PENDING, sale still succeeds
- reconnect → drains **only unprinted** intents, exactly once

**Never two receipts for one `receiptId`.**

And per the pattern that has caught every real defect this session: these are **mount and
integration tests that execute**, not source-text assertions. Three defects shipped in
Receipts behind green source-text suites before mounting the module caught them.

---

## Order of work

1. Receipt contract — three defects + the three-caller identity proof
2. `autoReconnect` in the device hub — the smallest fix, the biggest daily effect
3. Host identity on `posDevices`
4. Print-job lifecycle callables + atomic claim
5. Desktop listener/claimer + offline drain
6. Hostile acceptance suite

The rules proposal (`82cd8bf`, 436/0/0, 739 bytes free) **stays frozen** unless option B is
chosen — in which case it is re-opened, re-measured and re-run, never amended in place.
