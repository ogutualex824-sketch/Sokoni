# Slice 1 — payment rail classification

**From:** `867ff70` · **Read-only.** `index.js` unmodified, no payment/POS/card module touched,
nothing deployed.

**Governing distinction:** M-PESA is a *payment method*; Daraja is an *integration rail*. A name
containing `mpesa`, `stk`, `till` or `pay` is not evidence of rail. Every classification below
is traced to implementation and deployment.

---

## The five payment exports from the index gate — none is Daraja

Four resolve to `./subscription-pay-methods`, one to `./commission`. Rail markers in
`subscription-pay-methods.js` (392 lines): `wallet` ×31, `intasend` ×1 (a comment),
**`daraja`/`safaricom`/`stkPush`/`consumer_key` — zero**. No external provider call.

| export | implementation | rail | purpose | classification | action |
|---|---|---|---|---|---|
| `payIntentWithWallet` | `subscription-pay-methods` | wallet | debits `wallets/{uid}` against a `paymentIntents` doc | **KEEP — WALLET/LEDGER** | preserve |
| `subscriptionPaymentMethods` | `subscription-pay-methods` | wallet | reads wallet balance to offer methods | **KEEP — WALLET/LEDGER** | preserve |
| `reconcileSubscriptionPayment` | `subscription-pay-methods` | wallet | manual retry / client poll after wallet payment; ownership-checked | **KEEP — WALLET/LEDGER** | preserve |
| `commissionDispatch` | `commission` | wallet/ledger (`wallet` ×33, `ledger` ×10) | commission processing | **KEEP — WALLET/LEDGER** | preserve |
| `onPaymentIntentPaid` | `subscription-pay-methods` | **rail-agnostic** | Firestore trigger on `paymentIntents/{ref}`; fires on `status==='paid'`, filters `purpose === 'subscription'`, calls `reconcilePaidIntent` | **KEEP — CURRENT PAYMENT** | preserve |

`onPaymentIntentPaid` deserves emphasis: it consumes **whatever rail wrote the intent**. It is
subscription *activation*, not a Daraja consumer. Removing it would break subscription
activation regardless of rail. It is a **live registered Eventarc trigger**.

---

## Where Daraja actually lives — and it is all undeployed

Checked against the **complete 1002-service list**, not the 1000-row us-central1 subset that an
earlier probe used:

| export | rail | deployed | references in index |
|---|---|---|---|
| `darajaSTKPush` | Daraja | **0** | 5 |
| `darajaSTKCallback` | Daraja | **0** | 17 |
| `validateDarajaCredentials` | Daraja | **0** | 4 |
| `sendTestSTKPush` | Daraja | **0** | 4 |
| `initiateSTKPush` | Daraja | **0** | 7 |
| `webhookMpesa` | Daraja | **0** | 2 |

**All six are Daraja-exclusive and none is deployed.** They are the genuine legacy rail.

**But they are not yet removable.** Each carries 2–17 internal references inside `index.js`, and
`webhookMpesa` is named in a live module's comment as a `paymentIntents` writer alongside the
IntaSend webhook. Deleting exports whose call sites remain would break the module. Removal is a
**follow-on task with its own reference-resolution work**, not a line-deletion.

Classification: **REMOVE — LEGACY DARAJA (candidate)**, contingent on resolving those references.

## The M-PESA-named exports that are LIVE — protected, not Daraja

This is precisely the trap. All five are deployed:

| export | deployed | why protected |
|---|---|---|
| `mpesaC2BValidation` | ✅ | C2B collection rail, live |
| `mpesaC2BConfirmation` | ✅ | C2B collection rail, live |
| `claimPosMpesaReference` | ✅ | **POS** reference claim |
| `onPosTransactionMpesaRef` | ✅ | **POS** transaction trigger |
| `getMpesaReconciliationSummary` | ✅ | live reconciliation |

**None may be removed under "remove Daraja".** Two are POS (frozen), two are the C2B rail, one
is reconciliation.

## POS Till-On — FROZEN, and larger than the two known functions

Deployed and untouched: `posInitiateTerminalPaymentV1`, `posCancelTerminalPaymentV1`,
`posReverseTerminalPayment`, `posSettleTerminalBatch`, `posPollTerminalStatus`,
`posGetTerminalHealth`, `posGetTerminalCapabilities`, `posGetTerminalBatchReport`,
`posTerminalEventWebhook`, plus `posInitiateIntasendPayment`, `posCheckPaymentStatus`,
`posCompleteCheckout`, `generatePosPaymentQr`, `completePosQrPayment`, `initiatePosQrPayment`,
`cancelPosPaymentQr`, `refundPosPayment`, `posProcessRefund`.

**KEEP — POS TILL-ON. Not modified.**

## Card — FROZEN

No card-exclusive export was isolated in this pass. Card behaviour appears to route through the
shared payment-intent surface (`createPaymentIntent`, `createPaymentSession`, `confirmPayment`,
`transitionPaymentState`, `recoverPaymentSession` — all deployed). Recorded as
**UNPROVEN — DO NOT TOUCH**, explicitly *not* "obsolete".

## Payment destination

`getPaymentDestination`, `savePaymentDestination` — **deployed**, exported by the candidate,
implementation source still **UNRECOVERABLE**. Export/wiring preserved; implementation **not
reconstructed, replaced or edited**.

---

## ⚠️ Unexpected finding — no IntaSend webhook is deployed

```
webhookIntasend    in source: 1    deployed: 0
intasendWebhook    in source: 1    deployed: 0
```

Checked against the full 1002-service list. **Neither IntaSend provider webhook is currently
deployed**, while `posInitiateIntasendPayment` *is*.

This is stated as an observation, not a conclusion. It may mean provider callbacks arrive by
another route, or that a Hosting rewrite fronts them, or that the webhook genuinely is not
deployed. It was **not** resolved here and nothing was changed — but if IntaSend is the
canonical marketplace rail, whether its webhook is reachable in production is worth answering
before any payment reconciliation work proceeds.

Flagged as **BLOCKED — PROVENANCE**, requiring its own investigation.

---

## Three lists

### REMOVE CANDIDATES — exclusively legacy Daraja
`darajaSTKPush` · `darajaSTKCallback` · `validateDarajaCredentials` · `sendTestSTKPush` ·
`initiateSTKPush` · `webhookMpesa`
— all undeployed; **removal blocked on 2–17 internal references each**.

### PROTECTED
The five wallet/subscription/commission exports · all five live M-PESA-named exports · the
entire POS Till-On set · card-adjacent payment-intent surface · payment-destination pair ·
`onPaymentIntentPaid`.

### BLOCKED
IntaSend webhook deployment status (`webhookIntasend` / `intasendWebhook`) · any Daraja removal
until its `index.js` references are resolved.

```
index modified        NO
production deployed   NO
production mutated    NO
worktree              clean
files changed         NONE
```
