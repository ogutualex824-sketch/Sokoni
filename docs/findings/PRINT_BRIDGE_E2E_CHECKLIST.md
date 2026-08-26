# Phone→desktop print bridge — the end-to-end run

**Status:** READY TO RUN, nothing deployed yet · **Date:** 2026-08-26

Related: [[PWA_PRINTER_HOST_PLAN]] · [[PRINT_INTENT_LIFECYCLE]] · [[POS_DEVICE_ID_TWO_KEYS]] ·
[[POSDEVICES_SELLERID_DEAD_DISJUNCT]]

```
Desktop                                     Phone
  ├── registers as shop printerHost
  ├── connects P58E                          sale
  └── opens SOKONI PWA                        │
          ▲                                   ▼
          │  realtime              posRetailSales/{saleId}
          │                                   │ (trigger)
          │                                   ▼
          └──────────────────── posPrintJobs/{shopId}__{saleId}  PENDING
                                              │
                                       atomic CLAIM
                                              │
                                   canonical SokoniReceiptDoc
                                              │
                                            P58E → PRINTED
```

**The success condition is not "the printer printed".** It is:

> one committed phone sale → one durable print intent → one successful claim → **one physical receipt**

---

## Deploy first — in this order

1. **`firebase deploy --only firestore:indexes`.** The listener query is
   `kind == 'printIntent' AND shopId == SHOP AND status == 'PENDING' ORDER BY createdAt`, and the
   composite index must exist *before* anything starts listening, or every listener errors.
2. **Functions**, by name: `registerPrinterHost`, `getPrinterHostStatus`, `createPrintIntent`,
   `claimPrintJob`, `advancePrintJob`, `onPosSaleCompleted`.
3. **Hosting** — from the latest commit only, and verify `version.json` after.

**No rules deploy.** The ruleset is frozen at 255,490 / 256,000 and this work spends none of it.
Re-verify `firestore.rules` is byte-identical to HEAD before deploying anything else.

## Set up once

| step | where | expected |
|---|---|---|
| Run POS setup on the desktop | `/pos-setup` | writes `sokoni_device_id` and a `posDevices/{id}` document |
| Open merchant-v2 → Devices | desktop | `○ Printer not connected · This desktop is not currently the printing host for this shop.` |
| Press **Connect P58E** | desktop | browser chooser → pairs → `registerPrinterHost` → `● Connected · P58E · Ready to print` |
| Reload the PWA | desktop | `autoReconnect` restores the link with **no chooser** → `● Connected` |

## The eleven attacks

Run a sale on the phone for each, and count **sheets of paper**. Anything other than the stated
count is a defect, not a quirk.

| # | attack | expected | where to look |
|---|---|---|---|
| 1 | plain sale | **1 receipt** | `posPrintJobs/{shopId}__{saleId}` → `PRINTED`, `printedBy` = the host device |
| 2 | refresh the desktop mid-idle | **0 extra** | job already `PRINTED`; claim returns `failed-precondition` |
| 3 | Bluetooth disconnect → reconnect | **0 extra** | surface drops to `○ Saved printer · Reconnecting…`, listener **stops** |
| 4 | duplicate realtime event | **0 extra** | one `mayPrint:true` only; the rest decline |
| 5 | duplicate sale trigger (re-fire) | **0 extra**, **1 document** | deterministic id `{shopId}__{saleId}` |
| 6 | reopen the PWA | **0 extra** | `autoReconnect`, then listener resumes; PRINTED jobs are not re-queued |
| 7 | two desktop hosts race | **1 receipt**, one host | second gets `aborted`; one `claimedBy` |
| 8 | sale while the desktop is offline | **1 receipt when it returns** | job sits `PENDING`; prints once on reconnect |
| 9 | wrong-shop device claims | **refused** | `permission-denied` — "belongs to another shop" |
| 10 | already-printed receipt arrives again | **0 extra** | `failed-precondition` — "already printed" |
| 11 | print fails, then retry | **1 receipt total** | `FAILED` + `lastError`, operator retry → `PENDING` → prints; **same document** |

Plus **host replacement**: register a second desktop with **Print here instead** → the first
device's `printerHost` flips to `false` in the same transaction, `printerHostReplacedBy` records
the successor, and the old desktop's next claim is refused. Sell again — exactly one receipt, from
the new host.

## What the paper must say

The receipt is rendered from the **canonical sale** through `SokoniReceiptDoc`, not from the
intent — the intent carries no totals at all. So the paper must carry the merchant's own shop
name, KRA PIN, branch, payment settlement, delivery details, receipt number, QR and footer,
identical to the same receipt rendered anywhere else in SOKONI. **If the paper and the on-screen
receipt disagree, that is a receipt-contract defect, not a printing defect** — chase it in
`sokoni-receipt.js`, not here.

## Two honest gaps to expect

- **The lease is recovery, not a guarantee.** A host that is merely *slow* — paused past 90 s
  mid-print — can be taken over and print twice. Attack #3 with a long pause is the way to see it.
  It is a stated trade, not a bug to be surprised by.
- **`test-printjobs-rules.js`** passes its 4 static assertions but its behavioural half needs the
  Firestore emulator on `127.0.0.1:8080`. Start the emulator before treating that suite as a
  release verdict.

## Evidence standing behind this

| suite | result |
|---|---|
| `test-printer-host-registration` | 39/0 |
| `test-printer-autoreconnect` | 23/0 |
| `test-print-intent-lifecycle` | 83/0 |
| `test-print-sale-bridge` | 63/0 |
| `test-printer-host-ui` | 73/0 |
| sabotage runners | 32 caught, 0 missed |

All of it is stubbed execution. **None of it is a handset, a desktop and a real P58E**, which is
exactly what this checklist is for.
