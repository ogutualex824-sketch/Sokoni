# Merchant-Owned Payments — Architecture Decision

**Status:** DECIDED (architecture) · **BLOCKED** (implementation) — awaiting Safaricom
**Date:** 2026-08-27
**Related:** [[COMMISSION_ENFORCEMENT_CONTRACT]] · [[CHECKOUT_CONTRACT]] · [[DARAJA_SANDBOX_TEST]]

---

## 1. The model

SOKONI is the **orchestrator**, not the collector. Customer funds go directly to the
merchant's own M-PESA account; SOKONI never receives or holds them.

```
                 ┌── customer money ──→ MERCHANT (own M-PESA)
CUSTOMER ────────┤
                 └── order evidence ──→ SOKONI
                                          ↓
                                     COMMISSION receivable
```

The two rails are **independent by design**. Commission is due on buyer-attested order
completion ([[COMMISSION_ENFORCEMENT_CONTRACT]] §6a), never on observing the customer's
payment — SOKONI cannot observe it and must not claim to.

SOKONI's own fees (commission, subscription, marketing, premium) continue to collect
through **IntaSend**. That rail is unchanged.

## 2. Two gates, not one

```
                 SAFARICOM
                    │
        ┌───────────┴───────────┐
        │                       │
Merchant eligible?       Platform authorized?
        │                       │
        └───────────┬───────────┘
                    ↓
             SOKONI may use
        merchant-owned STK Push
```

> **A yes to only the first is not enough.**

Gate 2 is not a new invention. `payment-destinations.js` already blocks on it:

> Configured and verified, but Safaricom has not authorised **multi-merchant collection
> for this platform**. Returning the destination here would put live customer money
> through an unauthorised arrangement.

`productionAuthorized` stays `false` until Safaricom's answer to gate 2 is **explicit**.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **`paymentDestinations` remains the authoritative destination/state object.** No new `merchantPaymentConfig` collection. | A third payment vocabulary alongside `shopSettings` and `paymentDestinations` repeats the failure this repo already has in delivery destination (8 spellings) and settlement status (2 vocabularies) — with money attached. `paymentDestinations` already has the state machine and the atomic swap. |
| 2 | **Secret Manager holds the Daraja secrets. Firestore stores only a `credentialRef`.** | Firestore rules control *access*, not *exposure*: any principal with project IAM read sees the passkey. Secret Manager has independent IAM, versioning and rotation. |
| 3 | **`shopSettings` is not the production secret store.** | Its rules allow the merchant's own client to read it. That makes live payment credentials reachable from any browser session, XSS or stolen session included. |
| 4 | **`paymentDestinations` gains the non-secret Daraja configuration and state.** | `storeNumber`, `transactionType`, `credentialRef`, `callbackStatus` — additive, one object. |
| 5 | **`ACTIVE` must be revocable and demotable.** | Credentials rotate, expire, or get pulled. A merchant stuck `ACTIVE` with dead credentials fails every customer checkout at the PIN prompt, silently. Repeated production failures demote and fall back to IntaSend. |
| 6 | **STK Query is a launch prerequisite, not a test convenience.** | See §4. |
| 7 | **The shared callback binds to the stored payment intent** — verifying at least expected amount **and** shortcode — with deterministic, idempotent processing. | One endpoint serves all merchants. `index.js` already warns a payment is "forge-completable by anyone who learns the CheckoutRequestID"; with N merchants that risk multiplies. Safaricom also retries callbacks. |
| 8 | **IntaSend remains the existing/default rail.** Merchant-owned Daraja is an *additional* payment method. | Introduces the new model without destabilising the live marketplace. |

## 4. Why STK Query is load-bearing, not optional

Under SOKONI-as-collector a dropped callback is a reconciliation problem — we can still see
our own money. Under merchant-owned it is a **customer-facing failure**:

```
customer paid the merchant  →  callback lost  →  SOKONI shows unpaid
                                              →  no order exists for the customer
```

`verifyPaymentStatus` (`index.js:4502`) reads Firestore only and makes no Daraja call, so it
reports whatever the callback wrote — `PENDING`, permanently. **STK Query is absent from the
repo** (verified 2026-08-26 with a negative control: the detector finds the two real
`processrequest` call sites and `oauth/v1/generate`, so the absence is real).

Design constraints for the eventual slice:

* Daraja returns a *processing* error when queried too soon. **"Query errored" must never be
  recorded as "transaction failed"** — an honest unknown beats a confident wrong answer.
* Callback and query are **two writers on one row**, arriving in either order. Whichever
  establishes a terminal outcome first wins; the second is corroboration, not replacement.
  Same shape as the commission settlement claim — reuse that pattern, do not blind-merge.
* The query hashes its password the same way as the push, so it **inherits the
  store-number question** (§5). Build both together or not at all.

## 5. The open technical question

`darajaSTKPush` (`index.js:3759`/`:3765`) and `sendTestSTKPush` (`:4673`/`:4679`) both set
`BusinessShortCode` **and** `PartyB` from a single `darajaShortCode`, and hash the password
with it. **No store/Head-Office field exists anywhere in the tree.**

For `CustomerBuyGoodsOnline`, Daraja binds the passkey to a store/HO number that may differ
from the till. If KASS's Till 3588275 has a distinct store number, the configuration is
**unrepresentable**. Fix, when confirmed: `darajaStoreNumber || darajaShortCode` in **all**
STK call sites (three, once STK Query exists).

**Not written speculatively.** Safaricom's answer states what the passkey is bound to.

## 6. Onboarding state machine

```
NOT_CONFIGURED → CREDENTIALS_SAVED → OAUTH_VERIFIED
   → PAYMENT_CONFIGURATION_VERIFIED → STK_TEST_VERIFIED
   → PRODUCTION_APPROVED → ACTIVE
                             ↑↓  (decision 5: demotable)
```

Only **ACTIVE** may initiate a real merchant-owned payment. This exists to prevent a
merchant typing an arbitrary shortcode and having live customer money delivered to it.

Per-merchant isolation is absolute: a purchase from Shop B never loads KASS's credentials.
The [[CHECKOUT_CONTRACT]] Single-Shop Invariant is what makes `sellerUid` unambiguous at
the moment of resolution, so it is a **prerequisite** of this architecture.

## 7. Phases

| Phase | Content |
|---|---|
| **1 — KASS** | Safaricom confirmation → credentials → shortcode/store relationship → configuration model → STK Query → callback allowlist from evidence → controlled KES 1 → full reconciliation |
| **2 — Template** | Turn KASS into a repeatable "Connect M-PESA" onboarding flow |
| **3 — Multi-shop** | Checkout dynamically selects the seller's verified destination |

KASS is the **reference implementation**, so merchant #2 is a configuration exercise rather
than an architectural experiment.

## 8. Prior art warning

A third-party sample circulated during this design reproduced **four defects this repo has
already found and paid for**:

| Sample | Reality |
|---|---|
| `datetime.now()` | Local time, not EAT. The timestamp is hashed into the password — a UTC server produces an invalid one. Cost a `2001` on 2026-08-25. |
| `TransactionDesc: f"Payment to {shop_name}"` | Unbounded, against Daraja's ~13-char limit. Fixed in `sendTestSTKPush` 2026-08-26. |
| `PartyB: shortcode` | The store-number conflation of §5. |
| `TransactionType: "CustomerPayBillOnline"` hardcoded | Wrong for a Till. |
| `settle_shop()` straight from the callback | No idempotency guard, and Safaricom retries callbacks. |
| `passkey VARCHAR(255)` in a plain table | Decision 2 exists because of exactly this. |

Structure fine as a sketch; details are a list of things already paid for once.

## 8b. ⛔ LAUNCH INVARIANT — delivery coupling (added 2026-08-27)

> **No merchant-owned order containing a non-zero delivery fee may be enabled until the
> platform delivery component and the rider component have an actual money-movement and
> reconciliation path, rather than merely records.**

The delivery fee has **no payment rail of its own** — it is a component of the order total, so
its custody follows the order. Today `platformFeeKES` is **recorded, never moved** (correct,
since SOKONI already holds the money) and `riderFee` is credited from SOKONI. Under
merchant-owned collection both sit in the merchant Till while SOKONI's records assert
otherwise.

No exposure exists today: production has **zero non-zero delivery-fee orders**. The gate must
be in place before the first one.

Full evidence and the pre-open checklist: [[RIDE_SERVICES_MONEY_AUDIT]] §6b–6c.

## 9. Current state — nothing implemented

| Item | State |
|---|---|
| Architecture | decided (this document) |
| `productionAuthorized` | **false**, untouched |
| `shopSettings` | 0 documents |
| `paymentDestinations/D5Ql2EYr95bt79IpcGTmOMTK0P83` (KASS) | pending TILL 3588275, no active destination |
| `darajaStoreNumber` | not written — awaits Safaricom |
| STK Query | not written — awaits Safaricom |
| Callback allowlist reconciliation | not changed — awaits evidence |
| `sendTestSTKPush` description fix | 14/0, **undeployed** |
| Deployment | none |

**Blocking dependency:** Safaricom's answer on both gates for Till 3588275.
Sandbox success (`1037`, 2026-08-25) proves the code path reached a handset. It establishes
**nothing** about production credentials, shortcode binding, or platform authorization.
