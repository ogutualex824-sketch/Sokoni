# Production Drift & Deployment Preflight — Payment Retirement Work

**Date:** 2026-09-14 · **Branch:** `release/multishop-checkout-certified` · **HEAD:** `1ef1d72`
**Status:** READ-ONLY. **Nothing deployed. Nothing deleted. No rule, secret or record modified.**

Related: [[DARAJA_UI_RETIREMENT_CENSUS]] · [[P3A_CENSUS_INTASEND_POS_ASSOCIATION]] ·
[[INTASEND_WEBHOOK_RETIREMENT_CENSUS]] · [[project_daraja_retirement_boundary]]

---

## 0. The exposure question, answered first

> **Can an authenticated client still invoke the old production `darajaSTKPush` today?**

**No.** It was deleted from production on 2026-09-14 (`d2e1c40`), together with `sendTestSTKPush`
and `validateDarajaCredentials`. Verified against a live `gcloud functions list`: all three are
absent. The premise that opened this gate is out of date, and the drift it assumed does not exist.

**But the retirement is not durable, and that is the finding that matters.** See §5.

---

## 1. Functions: exact Git → production mapping

Enumerating repo exports **statically was not sufficient** — `functions/index.js` carries
**8 `Object.assign(exports, module)` spreads**, and two of those modules (`algolia-sync.js`,
`typesense-sync.js`) generate their export names in loops. A regex sees zero names for them and
would have reported every one of their deployed functions as an orphan awaiting deletion.

The figures below come from **loading `functions/index.js` and reading its keys**, the way the
CLI's discovery does.

> Two measurement traps were hit and corrected before any number here was trusted:
> gcloud's output on Windows carries **CRLF**, so a first `comm` against it reported **all 1709**
> live functions as obsolete; and the static scan above under-counted exports. A control
> (`algoliaSync_brands_create`, `initiateSTKPush`, `webhookIntasend`, `completePOSQRPayment`
> present on both sides) now guards the comparison.

| | count |
|---|---:|
| exported by `functions/index.js` (runtime) | **1719** |
| deployed in `sokoni-aeb26` | **1709** |
| deployed **but not exported** | **26** |
| exported **but not deployed** | **36** |

Module load took **3.35 s** of the CLI's 10 s discovery budget on a warm tree — comfortable here,
but the cold-tree figure recorded in [[project_functions_discovery_headroom]] (8.2 s) is the one
that governs a real deploy.

---

## 2. Deployment status of every certified gate

Deployed build times against commit times (deploy in UTC, commits EAT = UTC+3):

| Function | Deployed | Contains |
|---|---|---|
| `initiateSTKPush` | **2026-09-14 00:47 Z** (03:47 EAT) | the **Door A** build only |
| `completePOSQRPayment` | 2026-09-09 06:02 Z | pre-P1 |
| `initiatePOSQRPayment` | 2026-09-09 06:01 Z | pre-P2, pre-P3 |
| `generatePOSPaymentQR` · `getPOSPaymentDetails` | 2026-09-09 06:01–06:02 Z | pre-D2 |
| `webhookIntasend` | 2026-09-09 06:02 Z | **pre-P3-A** |
| `intasendWebhook` | 2026-09-09 06:01 Z | the retired handler, still live |
| `darajaSTKCallback` · `webhookMpesa` | 2026-09-09 06:01–06:02 Z | D3, untouched by design |

Every certified gate was committed on **2026-09-14 between 08:37 and 13:14 EAT**. The payment rail
in production was deployed on **2026-09-09** — five days earlier.

**Therefore: P1, P2, P3, D1+D2, the POS ownership authority, P3-A, the Daraja UI retirement and the
`intasendWebhook` retirement are ALL undeployed.** The only 2026-09-14 deployment on the payment
rail is `initiateSTKPush`, from the authorised Door A handset test — and it predates P1 by five
hours.

Production is running the pre-P1 POS QR rail: the one where a **client-supplied string could stand
in for a payment**, and where the till prompt was **never actually sent**.

---

## 3. Hosting: a different lineage, not an older one

```
live      d592d8f   release/r1-pos-printer-fn   built 2026-09-02   dirtyWorkingTree: true
HEAD      1ef1d72   release/multishop-checkout-certified
merge-base 3dcf572  2026-08-13  — a month back
```

* **576 commits** on the production lineage that are **not** in our HEAD
* **240 commits** on ours that are not in theirs
* **1192 files differ**

`mysokoni.co.ke/payments` still serves the full Daraja console — **47 Daraja occurrences**, the
wizard pane, 78 KB.

### The rollback guard does NOT cover this

`scripts/deploy/guard-no-rollback.js` tests exactly one condition:

```js
git merge-base --is-ancestor <HEAD> <live>   // HEAD strictly BEHIND live → abort
```

Our HEAD is **diverged**, not behind, so the guard takes its final branch and prints
*"local 1ef1d72 is not behind live d592d8f — allowing deploy."* Its own header says so:
*"otherwise (ahead / diverged / live commit unknown here) → allowed."*

**A hosting deploy from this branch would be permitted, and would overwrite 576 commits of
production-lineage work.** The guard protects against deploying an *older* tree; it does not
protect against deploying a *different* one. That is a gap in the safety mechanism, not a
misconfiguration.

**Conclusion: the certified UI retirement cannot be shipped from this branch.** It must be ported
to the production lineage, or the two reconciled first. That is its own gate.

---

## 4. Removed from the repository ≠ removed from Firebase

| Function | Repository | Production | Action required |
|---|---|---|---|
| `darajaSTKPush` · `sendTestSTKPush` · `validateDarajaCredentials` | removed `800decc` | **already deleted** `d2e1c40` | none |
| `intasendWebhook` | removed `1ef1d72` | **still live** | **DELETE** (named) |
| `webhookIntasend` | changed by P3-A `a5b13cb` | pre-P3-A build | **UPDATE** (named) |
| `completePOSQRPayment` · `initiatePOSQRPayment` · `getPOSPaymentDetails` · `generatePOSPaymentQR` | P1/P2/P3/D2 | pre-gate builds | **UPDATE** (named) |
| `darajaSTKCallback` · `webhookMpesa` | untouched | live | **NONE — D3 blocked** |

---

## 5. The durability finding — the retirement is branch-local

**The production lineage `d592d8f` still exports all three deleted Daraja callables.**

```
darajaSTKPush              exports on release/r1-pos-printer-fn  → a deploy RECREATES it
sendTestSTKPush            exports on release/r1-pos-printer-fn  → a deploy RECREATES it
validateDarajaCredentials  exports on release/r1-pos-printer-fn  → a deploy RECREATES it
intasendWebhook            exports on release/r1-pos-printer-fn  → a deploy RECREATES it
```

So the deletions in `d2e1c40` hold **only until somebody deploys functions from the branch
production is actually built from.** The Daraja outbound rail would return, in its pre-`548e15d`
form — the fully working implementation with the browser-supplied `amount`.

**This is the real production risk, and it is the opposite of the one this gate set out to find.**
The exposure is not that the old callables are live; it is that **nothing prevents them coming
back**. Any durable retirement has to land on the production lineage.

---

## 6. The 26 "obsolete" deployed functions — only 7 are obsolete

"Absent from this branch" is not "obsolete", because the production lineage has 576 commits we do
not. Checked against `d592d8f`:

**19 exist on the production lineage — NOT obsolete, do not delete:**
`adminLinkMerchantAccounts`, `advancePrintJob`, `claimPrintJob`, `commissionDispatch`,
`createPrintIntent`, `employeeSaleAuthorize`, `getPrinterHostStatus`, `intasendWebhook`,
`onPackageRequestChanged`, `onPaymentIntentPaid`, `onPosSaleCompleted`, `payIntentWithWallet`,
`posSendPurchaseOrder`, `reconcileSubscriptionPayment`, `registerPrinterHost`,
`subscriptionPaymentMethods`, `verificationDecide`, `verificationRevoke`, `verificationSubmit`

**7 absent from both branches** — genuinely orphaned, and **out of scope for this gate**:
`algoliaSync_landlordProfiles_{create,delete,update}`, `expireBoosts`,
`onAiSubscriptionChangedSyncLimit`, `pickupHandover`, `posInitiateIntasendPayment`

`expireBoosts` and `pickupHandover` are already recorded in memory as lineage divergence rather
than removals. `posInitiateIntasendPayment` is payment-adjacent and deployed while absent from
every branch — **recorded, not touched.**

---

## 7. Functions exported but not deployed — 36, and only 4 are uncommitted

A blanket `firebase deploy --only functions` would **create 36 functions**, none of which belong
to this work:

* **32 committed at HEAD but never deployed** — the Sokoni Till suite (`mintSokoniTill`,
  `getMySokoniTill`, `setSokoniTillStatus`, `getSokoniTillActivity`, `mintDynamicSokoniQR`,
  `resolveSokoniQR`), the supply-chain suite (`findSuppliers`, `listPurchaseOrders`, `listGRNs`,
  `listWarehouseStock`, …), `createMultiShopCheckoutQuote`, `requestDeliveryQuote`,
  `completePickupWithPin`, `claimOrder`, and others
* **4 present only in the dirty working tree — another agent's uncommitted exports:**
  `hcActivateSubscriptionOnPayment`, `posCommissionReminder`, `posGateStatus`, `posSettleCommission`

**There are also 34 dirty files under `functions/`.** A deploy from the working tree ships all of
them. **Any deployment must run from a clean checkout of the certified commit**, never from this
tree.

---

## 8. Secrets — referenced nowhere, and still not recommended for deletion

| Secret | In Secret Manager | Referenced by `defineSecret` |
|---|---|---|
| `INTASEND_PRIVATE_KEY` · `INTASEND_API_KEY` · `INTASEND_WEBHOOK_CHALLENGE` | yes | **yes — keep** |
| `DARAJA_CONSUMER_KEY` · `DARAJA_CONSUMER_SECRET` | yes | **no branch references them** |

Checked across **every local branch's `functions/`**, not just HEAD. The deployed
`darajaSTKCallback` revision binds **no Daraja secret** — its environment carries only Algolia,
Africa's Talking, ETIMS and Typesense values.

**Recommendation: do not delete them in this gate.** The three functions that bound them were
deleted six hours ago; if any decision has to be reversed, the credentials are the cheapest thing
to still have. They are inert — no function can read a secret it does not bind. `functions/.env`
still carries `DARAJA_SANDBOX_SELLER_UIDS`, which is an allowlist, not a credential.

---

## 9. Rules and configuration drift

Against the **deployed** ruleset `6264c7db…` (released 2026-09-13):

* `posPayments` — deployed block grants read to admin / `sellerId` / `sellerUid` / `callerUid` /
  `buyerId`, and carries **no `allow write` clause**. The repo has an explicit
  `allow write: if false`. **Same security outcome** (Firestore denies by default); the sources
  differ, consistent with the reopened rules-lineage finding.
* `paymentAttempts` — **no match block on either side.** Invisible to every client, which is why
  P3-A's association had to land on `posPayments`.

**No rule was modified.**

---

## 10. Historical records — verified intact

Queried live:

```
posPayments documents : 13
Daraja-shaped         : 13   (checkoutId, no transactionId)
QR-shaped             :  0
statuses              : 6 failed · 5 pending · 2 completed
```

Exactly the 13 recorded by D1+D2, all still Daraja-shaped, none migrated or deleted. **Zero
QR-shaped documents exist in production** — consistent with the QR rail never having transacted.

---

## 11. D3 — isolated, unchanged

`darajaSTKCallback` and `webhookMpesa` remain deployed and untouched. Safaricom was POSTing to the
callback as recently as **2026-09-06**, and those registrations live in sellers' own portals.
D3 stays blocked on external de-registration.

The **IP-rejection finding stands recorded and unrepaired**: `196.201.212.69` — inside Safaricom's
published range — was rejected as an unexpected IP on 2026-09-03 and 2026-09-06. Repairing it
would mean reviving the legacy inbound rail, which contradicts the IntaSend-only direction.

---

## 12. The named-only change set

**No blanket deploy. No `--only functions`. Each line is one authorised operation.**

### A · Functions to UPDATE — from a clean checkout of `1ef1d72`
```
firebase deploy --project sokoni-aeb26 --only \
  functions:webhookIntasend,\
  functions:completePOSQRPayment,\
  functions:initiatePOSQRPayment,\
  functions:generatePOSPaymentQR,\
  functions:getPOSPaymentDetails,\
  functions:verifyPaymentStatus
```
Rollback target: the 2026-09-09 06:0x revisions, recoverable by redeploying `d592d8f`'s
`functions/` for those names.

### B · Function to DELETE — one operation
```
firebase functions:delete intasendWebhook --project sokoni-aeb26 --region us-central1 --force
```
Rollback: redeploy from any branch that still exports it — including, today, the production
lineage. **Do not run B until §5 is resolved**, or the next deploy from `release/r1-pos-printer-fn`
puts it straight back.

### C · Hosting — **BLOCKED, not merely unauthorised**
Cannot be deployed from this branch: it would overwrite 576 commits, and the rollback guard would
allow it. Requires lineage reconciliation first.

### D · Secrets — **no action.**
### E · D3 inbound — **no action.**
### F · Historical records — **no action.**

---

## 13. Preflight verdict

| GREEN criterion | |
|---|---|
| exact Git → production function mapping | ✔ 1719 / 1709, runtime-enumerated, control-guarded |
| exact hosting Git → production mapping | ✔ `d592d8f` vs `1ef1d72`, diverged at `3dcf572` |
| exact list of obsolete deployed functions | ✔ 7 truly obsolete; 19 misattributed by branch |
| exact named-only deployment/deletion plan | ✔ §12 |
| no accidental inclusion of unrelated functions | ✔ 36 undeployed identified and excluded |
| no blanket deployment path | ✔ |
| P1/P2/P3/P3-A dependency closure verified | ✔ 348 modules from HEAD, none unresolved |
| historical records protected | ✔ 13 documents, verified, untouched |
| D3 explicitly isolated | ✔ |
| other-agent work attributed | ✔ 4 uncommitted exports + 34 dirty files named |
| rollback targets identified | ✔ per operation |
| production actions individually named | ✔ A–F |

**The preflight is GREEN — and it recommends against the deployment it was preparing for, in two
of its six parts.** Hosting is blocked on lineage. The `intasendWebhook` deletion is pointless
until the production lineage stops exporting it.

**The functions UPDATE (A) is the one operation that is both safe and worth doing**, because it is
what puts P1's verification and P2's real prompt into production — and production is currently
running the rail where neither exists.
