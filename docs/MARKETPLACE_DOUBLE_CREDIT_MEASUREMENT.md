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

---

## Repair — 2026-09-26 (owner-authorized, narrow)

**Scope:** the two credit gates only. Amounts, commission, wallet destination, order lifecycle and the
business-wallet architecture are untouched. The measurement above is kept as the historical record:
"no duplicate has happened yet" is not "the bug was harmless".

- `isAlreadySettled(status)` in `functions/order-settlement.js`: only a string counts, compared after
  `trim().toUpperCase()` against `'SETTLED'`.
- It gates `settleOrder` (credit) and `autoConfirmDeliveredOrders` (the sweep that fires `completed`).
- **Deliberately not applied to refund routing.** `handleOrderRefund` still compares case-sensitively. As a
  result, a refund of a webhook-credited order marks it `REFUNDED` **without clawing back the webhook's
  seller credit**. That is a separate open defect: routing it to `reverseSettledOrder` would find no
  `settlements/{orderId}` record to reverse.
- Consequence to know: a delivered order that the webhook already credited is **no longer auto-completed**
  by the sweep. It stays `delivered`, which is the same treatment an uppercase `SETTLED` order always had.

### Certification — `scripts/test-settled-case-guard.js` (real Firestore emulator)

| target | result |
|---|---|
| branch `functions/order-settlement.js` (patched) | **66 / 0** |
| deploy tree = production archive + patch | **66 / 0** |
| **counterproof:** production archive, unpatched | **24 / 21 FAIL**; reproduces the incident on the emulator (webhook-paid order credited again on `completed`) |

It covers `settled`, `SETTLED`, `Settled`, ` settled`, `SETTLED`+`completed`, and non-settled states as
positive controls (credited, then replay-safe). It also runs 3 concurrent `settleOrder` calls on the
webhook-paid order, and the sweep across every case.

### Deploy tree — production lineage, not this branch

The branch and production have diverged in both directions. Production has platform-funded discount logic;
the branch has the delivery-proof gate. Deploying from the branch would therefore change amounts and gating.
The deploy tree is **the deployed archive plus this patch and nothing else**:

- source: `gs://gcf-v2-sources-24799054989-us-central1/onOrderStatusChange/function-source.zip#1788077453779580`
  (byte-identical to `expireOldEscrows#1788077527517398`; sha256 prefix `cf287ef573d520ac`). This is the
  generation named in the recovery manifest.
- `.env` key names and values match both live functions exactly (compared by equality, never printed).
- The serving revisions `onorderstatuschange-00062-yoz` and `expireoldescrows-00032-gul` were created
  2026-08-30 08:11–08:12Z, the same deploy as the archive.
- Plan under `--only functions:onOrderStatusChange,functions:expireOldEscrows`: **2 updates, 0 creates,
  0 deletes**. Filter matching is exact per dash-chunk, and no live `onOrderStatusChange-*` or
  `expireOldEscrows-*` exists. Function count is **1723** (the manifest's 1709 is stale).

## DEPLOYED — 2026-09-26 05:27Z (owner-authorized: narrow repair, scaling-neutral, `--force`)

`firebase deploy --only functions:onOrderStatusChange,functions:expireOldEscrows --force`, run from
`C:/temp/sok-dc-deploy`: the production archive `#1788077453779580` plus exactly two file changes. The
first is the guard in `order-settlement.js`, applied by `scripts/infra/patch-settled-guard-20260926.js`,
the same script used on the branch. The second is `maxInstances: 99` on both functions (owner ruling:
scaling-neutral, equal to the serving revisions). Result: **2 updated, 0 created, 0 deleted**.

`--force` was needed only because the CLI reads min-instances from the GCF layer (undefined) and treats
`minInstances: 1` as a bill increase, although the serving revision already ran min 1. Under `--only`, the
planner cannot delete (exact dash-chunk filter match; no `onOrderStatusChange-*`/`expireOldEscrows-*` live),
and cleanup-policy setup is skipped because the repository already carries policies.

| | before | after |
|---|---|---|
| `onOrderStatusChange` serving | `00062-yoz` (image deleted; `00063-8sk` stuck FAILED) | **`00064-rat`**, Ready, 100%, min 1 / max 99 |
| `expireOldEscrows` serving | `00032-gul` | **`00033-fug`**, Ready, 100%, min 0 / max 99 |
| image | — | `on_order_status_change@sha256:97b5be2d8964…` (`version_1`, the package's only version) |
| build | — | `5e747ef2-436d-4954-90de-f90db69397e1` SUCCESS 05:27:21–05:27:56Z |
| source | `#1788077453779580` / `#1788077527517398` | `#1790400441458307` / `#1790400487403819` (byte-identical) |

**Verification — `scripts/infra/verify-settled-guard-deploy-20260926.js`: 43 / 0.** It covers the recovery
manifest's nine assertions: Ready, 100% traffic, scaling, image present, stuck revision cleared, trigger
contract, runtime config, the function count (exactly 1723) and the `profilegetpublicprofile-00007-xaz`
control. It also checks environment and secret bindings, the unchanged Eventarc trigger and scheduler job,
and **provenance:** serving revision → digest `97b5be…` → the only `version_1`, uploaded 05:27:46Z inside
build `5e747ef2` → build `_GOOGLE_LABEL_SOURCE` = the new archive → the deployed `order-settlement.js` and
`index.js` are **byte-identical** to the patched tree.

The provenance gap from the measurement is therefore **closed for the new revisions**. Unlike `00062-yoz`,
their image exists and chains to the exact source.

Two detector corrections were made during verification, both recorded in the script. First, GCF builds carry
no `build.source` or `results.images`, so provenance reads `_GOOGLE_LABEL_SOURCE` and the AR tag. Second,
`eventFilters` are compared as a set: two reads of the same unchanged resource returned them in different
orders, and a fourth read was byte-identical to the baseline.

No errors or warnings from either service since the deploy. The probe after the deploy is unchanged:
**0 double credits**. No behavioural test was run in production, because that would require mutating
production orders, which was not authorized.

### Regression hazard — read before any future deploy of these functions

**ENFORCED 2026-09-26.** Two guardrails, and neither is a string search:

1. **Predeploy gate** `scripts/deploy/guard-settled-case.js`, first in `firebase.json` `functions.predeploy`, so it runs on
   **every** functions deploy, scoped or not. It proves three things. STRUCTURE (AST): the predicate is defined
   and exported, `settleOrder` returns `already-settled` on it, the sweep `continue`s on it, and there is no
   second raw comparison of `settlementStatus` against SETTLED. BEHAVIOUR: the real module is driven against an
   in-memory database, and every settled spelling writes no money. CONTROL: an unsettled order IS credited.
   It fails closed on a missing file, a missing parser or a crash. Certified by `scripts/test-settled-guard-gate.js`:
   **14/0**, including 9 disconnecting mutants each refused on the check meant to catch it. The current production
   source PASSES and the known-vulnerable production source is REFUSED.
2. **Recovery manifest** `recovery_order` 5 now requires generation `1790400441458307` and states the same
   invariant for `gcloud` rebuilds, which never run predeploy.

The gate protects a deploy made **from a tree that carries it**. A tree that predates this commit has neither
the gate nor the guard. That is why the manifest states the invariant independently.

The guard now lives in production and on `feat/business-wallet-authority` **only**. Any deploy of
`onOrderStatusChange` or `expireOldEscrows` from another lineage — including a recovery-manifest rebuild or a
scoped deploy from `feat/integrations-control-center` — **silently reinstates the double credit**. Carry
`isAlreadySettled` into that lineage first; `scripts/test-settled-case-guard.js` must pass on it.

### Still open (not part of this repair)

- **Refund routing:** a refund of a webhook-credited order marks it `REFUNDED` without clawing back the
  seller credit.
- KASS canonical business identity (HOLD), the KES 1,530 provenance (HOLD), and the `SELLER_A` fixture wallets
  (HOLD pending the reference check).
