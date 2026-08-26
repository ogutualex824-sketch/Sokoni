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

## ⛔ Read this before deploying hosting

**`feat/merchant-v2-canonical` @ `bfbea7c` is BEHIND LIVE. A hosting deploy from this worktree
would roll production back.** Measured 2026-08-26 against `https://mysokoni.co.ke/version.json`
(live = `fda3df8`, cache `v558`):

| | |
|---|---|
| commits live has that this branch lacks | **4** |
| files that would regress | **5** |

```
fda3df8  chore: stamp production release v557
f26b0b3  fix: advance shipped service worker version floor
a4672dc  chore: record live POS setup state
3795dca  fix: allow vertical scroll chaining from horizontal carousels

pos-setup.html  service-worker.js  scripts/deploy/bump-sw-version.js
sokoni-responsive.css  version.json
```

The service-worker cache version on this branch is **`v555`**; live is **`v557`**. Deploying
hosting from here regresses the `-vNN` counter, which is explicitly forbidden. The predeploy guard
`scripts/deploy/guard-no-rollback.js` should abort this — **if it does, that is the guard working.
Never force past it.**

**Checked and safe:** the `sokoni_device_id` write in `pos-setup.html` is *identical* on both
sides, so the print-host identity chain is not affected by the divergence. Live's extra
`pos-setup.html` work (+339 lines) is what would be lost.

**Remedy before step 3:** merge or rebase live's four commits into this branch, re-run the suites,
and re-verify `version.json` after deploying.

## Deploy — in this order

1. **`firebase deploy --only firestore:indexes`.** The listener query is
   `kind == 'printIntent' AND shopId == SHOP AND status == 'PENDING' ORDER BY createdAt`, and the
   composite index must exist *before* anything starts listening, or every listener errors.
   **Safe from this worktree** — live's four commits do not touch `firestore.indexes.json`.
2. **Functions**, by name: `registerPrinterHost`, `getPrinterHostStatus`, `createPrintIntent`,
   `claimPrintJob`, `advancePrintJob`, `onPosSaleCompleted`.
   **Safe from this worktree** — live's four commits do not touch `functions/`.
3. **Hosting** — **BLOCKED** until the divergence above is resolved. Hosting publishes the working
   tree (`public: "."`), which is exactly why this matters. Verify `version.json` after.

**No rules deploy.** The ruleset is frozen at 255,490 / 256,000 and this work spends none of it.
Re-verify `firestore.rules` is byte-identical to HEAD before deploying anything else.

Nothing in the print chain is reachable from the UI until step 3 lands, so steps 1–2 can go ahead
now and change no behaviour on their own — the trigger is the one exception: once deployed it will
begin writing intents for completed sales at shops that already have a registered host. There are
none yet, so it writes nothing until a desktop is deliberately registered.

## Set up once

| step | where | expected |
|---|---|---|
| Run POS setup on the desktop | `/pos-setup` | writes `sokoni_device_id` and a `posDevices/{id}` document |
| Open merchant-v2 → Devices | desktop | `○ Printer not connected · This desktop is not currently the printing host for this shop.` |
| Press **Connect P58E** | desktop | browser chooser → pairs → `registerPrinterHost` → `● Connected · P58E · Ready to print` |
| Reload the PWA | desktop | `autoReconnect` restores the link with **no chooser** → `● Connected` |

## The first transaction — do this one alone

**Do not open with ten sales.** One controlled transaction, with a distinctive amount you can find
by eye in the backend:

```
PHONE  Sale → KES X
                ↓
        posRetailSales/{saleId}          1 sale
                ↓
        posPrintJobs/{shopId}__{saleId}  1 intent
                ↓
        status CLAIMED, claimedBy = host 1 claim
                ↓
        P58E                             1 physical receipt
                ↓
        status PRINTED (terminal)        1 terminal state
```

Establish all five before touching anything else. Five ones, or stop and find out why. Only then
attack it.

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
