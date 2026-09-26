# Marketplace double credit — production measurement

**Date:** 2026-09-26 · **Mode:** read-only (GET and `:runQuery` only; no code or data changed)
**Verdict:** **ARMED, NOT FIRED.** No seller has been credited twice. KASS is exposed on 7
orders right now, and a seller-side status write can trigger the second credit.
**Related:** [[BUSINESS_WALLET_ARCHITECTURE]] · [[WALLET_V2_ARCHITECTURE]] · [[Payments]] · [[Orders]]

---

## The defect, as deployed

```
webhookIntasend (paid)                   onOrderStatusChange (→ completed)
  creditWalletTxn → wallets/{seller}       settleOrder
    FinOS cents (swept to balance)           skips ONLY settlementStatus === 'SETTLED'
  order.settlementStatus = "settled"   ─►    "settled" !== "SETTLED"
  (comment: "so a settlement sweep           → credits wallets/{seller}.balance AGAIN
   must not double-credit")
```

The webhook comment states the intent and the code fails it by letter case alone.

## What production is running

| function | revision serving | source archive | carries the defect |
|---|---|---|---|
| `webhookIntasend` | `webhookintasend-00064-lag` | gen `1788689203393223` (Sep 6 tree) | writes lowercase `"settled"` (index.js:8731), credits at :8654 |
| `onOrderStatusChange` | `00062-yoz` (**`00063-8sk` FAILED: image deleted**) | gen `1788077453779580` (Aug 30 tree) | `settleOrder` skip at order-settlement.js:101 is uppercase-only; no other gate before the credit |
| `expireOldEscrows` | `00032-gul` | gen `1788077527517398` | runs `autoConfirmDeliveredOrders`, which has the same case bug |

`order-settlement.js` is **byte-identical** in all three archives, so every lineage in that window
carries it. Caveat: the source archive is the build input of the latest deploy. That `00062-yoz`
was built from this exact archive is highly likely but not proven at the image level, because the
image is gone (see the Artifact Registry notice in `CLAUDE.md`).

The deployed `settleOrder` is **weaker** than the branch source: it has no delivery-proof gate.

## What the data says

| measure | value |
|---|---|
| orders (all) | **10** |
| orders `status == completed` | **0** |
| `walletTransactions` `type == order_settlement` (settleOrder credits) | **0** |
| `settlements` docs | **0** |
| payments with a webhook wallet credit | **9** |
| orders at lowercase `"settled"` (webhook-credited) | **7**, all seller **KASS** (`D5Ql2EYr…`) |
| orders in both credit trails | **0 — joined from both directions** |

The zeros are backed by controls: the same queries find the 9 credited payments and the 7
lowercase orders, and the status distribution (`confirmed 5 · delivered 1 · in_transit 1 · paid 1 ·
pending_payment 2`) accounts for all 10 orders.

**Exposure today:** 7 KASS orders, each KES 97 paid and KES 87 already credited by the webhook.
A second credit would add `settleOrder`'s own net for each (not computed here). One order,
`SKN084IE2Z`, is already `delivered` (Aug 6).

No refunds or voids touched these orders, so there is nothing to reverse.

## Why it has not fired — and why that is luck

1. **No order has reached `completed`.**
2. **The auto-confirm sweep never runs.** `expireOldEscrows` returns early when there are no
   30-day-old active escrows, and production has **zero escrows of any kind**. The sweep only
   runs *after* that early return, which is an unrelated guard. Every daily run since at least
   09-20 returned 200 with no application log.

**Ways it fires, any of them, with no code change:**

- **The seller marks the order `completed`.** Served ruleset
  `6c67a34d-bb07-4fd5-8934-32d6b547a276`: a seller may update `status` on their own order to any
  value in `validOrderStatus()`, and that list includes `'completed'`.
- **An admin completes the order.**
- **Any escrow is created and ages 30 days.** The sweep then runs and completes `SKN084IE2Z`.
- **`onOrderStatusChange` is rebuilt from the current branch.** It is on the owner-authorized
  recovery manifest, and the branch source carries the same uppercase-only check.

## Evidence correction — the "live" business wallets are test fixtures

The two production `businessWallets` docs (`SOK-ALM49S`, `SOK-UHE9XA`) are both owned by
**`SELLER_A`**, have a balance of 0, and were created 2026-09-07 — certification debris, not
merchant wallets. So "the release-branch schema matches production" means it matches **test
data**. The businessId + `ownerId` model is still the right one on its merits, but no real
merchant's wallet anchors it.

## KASS identity — why its wallet cannot resolve

KASS has **three** `businesses` rows:

| id | status | note |
|---|---|---|
| `D5Ql2EYr95bt79IpcGTmOMTK0P83` | active | the retired `businesses/{uid}` shortcut |
| `SOK-GL58F7` | active | generated id |
| `SOK-E7J2Y8` | retired | `duplicate-business-merged` |

`tenant-identity.resolveMerchantIdForOwner` sees **two active** rows, so it returns **AMBIGUOUS**
and fails closed, and the release-branch chain refuses the uid-keyed row outright. KASS has **no**
business wallet, while its personal wallet holds `balance` **1530** (KES), which is merchant
revenue. Settling which business row is canonical is an owner decision, and it has to happen
before any wallet can be provisioned for KASS.

## Re-running

`node scripts/probe-marketplace-double-credit.js` is read-only. It needs `gcloud` user auth and,
on this machine, `CLOUDSDK_PYTHON` set to the bundled interpreter.
