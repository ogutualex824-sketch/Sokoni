# POS payment rail — audit before any Daraja → IntaSend migration

**Date:** 2026-09-02
**Scope:** map only. No code changed, nothing deployed, no payment path modified.
**Read against:** primary repo `release/multishop-checkout-certified` @ `fa5082b` (182 dirty files — see *Provenance caveat*).

Related: [[project_daraja_rail_separation]] · [[project_collection_route_two_rails]] ·
[[project_merchant_owned_payments]] · [[project_pos_payment_authority]] ·
`docs/COMMISSION_ENFORCEMENT_CONTRACT.md`

---

## The headline: the migration surface is far smaller than expected

**POS's payment confirmation is already rail-neutral.** `posCompleteCheckout`
(`functions/pos-zero-friction.js`) never calls a payment provider. It reads a document:

```
posPayments/{ref}
  status      must be 'completed'
  sellerUid   must match the merchant
  paidAmount  must cover the claimed line
  mpesaCode   carried onto the receipt
  paidPhone   carried onto the receipt
```

…then claims it exactly once via `posPaymentClaims/{ref}.create()` (atomic; a second sale
gets `ALREADY_EXISTS`). The word "daraja" appears in that function **only in comments**.

**So the rail is not embedded in POS. It is embedded in whatever WRITES `posPayments`.**
A migration replaces the writer, not the checkout. Everything already certified —
single-spend, ownership binding, amount sufficiency, mixed tender, cash exemption —
is preserved untouched.

## The second surprise: the live rail is already IntaSend

`functions/payment-destinations.js`, in its own header:

> *"The current live checkout rail remains the IntaSend collector; nothing here migrates it."*

The direct-to-merchant Daraja model — customers paying the merchant's own Till/PayBill — is
**built and deliberately gated off**. `resolveActiveDestination()` refuses to hand a PartyB
to the live STK path while `productionAuthorized !== true`, pending a Safaricom
multi-merchant arrangement that does not exist.

So the question is not "can we move to IntaSend". Most of the platform is already there.
The question is narrower: **POS specifically still pushes through `darajaSTKPush`.**

## What exists, per your ten questions

| # | question | finding |
|---|---|---|
| 1 | where `posCompleteCheckout` gets its payment destination | **It doesn't.** It never initiates payment; it verifies `posPayments/{ref}` |
| 2 | where the Daraja STK request is constructed | `functions/index.js:3536` `darajaSTKPush` — `BusinessShortCode`/`PartyB` = platform shortcode |
| 3 | payment purpose recorded | `collectionRoute` (`DIRECT_TO_SELLER` vs central), `pricingSource`, `hub`, server-priced `items` |
| 4 | what `railHub` does | **No such symbol.** Rail choice is per-callsite; see *The seam that exists* |
| 5 | how the callback identifies the sale | `darajaSTKCallback` (`index.js:4146`) keys by `checkoutId` = Safaricom `CheckoutRequestID` |
| 6 | where payment becomes a ledger entry | Callback writes `posPayments`, `sellerPayments`, `payments`, `orders`, `auditLogs`. **No `walletTransactions`, no `commissionLedger`** |
| 7 | how merchant entitlement is calculated | **For POS: it is not.** See *The gap* |
| 8 | IntaSend POS collection path | **Does not exist.** `payment-adapters.js` is IntaSend-only but POS never imports it |
| 9 | can marketplace IntaSend machinery be extended | **Yes** — `IntaSendAdapter` already implements payment, verify, payout, refund |
| 10 | merchant withdrawal | `wallets` / `walletTransactions` / `payoutRequests` exist (frozen backend); auto-B2C **OFF** |

## The seam that exists

`functions/payment-adapters.js` is a provider-agnostic adapter layer with the exact
interface a migration needs:

```
PaymentAdapter
  initiatePayment · verifyPayment · initiatePayout · initiateRefund
  verifyWebhookSignature · healthCheck · capabilities
    └── IntaSendAdapter   (the only implementation)
```

**There is no Daraja adapter.** Daraja is called directly from `index.js`, outside the
abstraction. And only `financial-os.js` and `wallet.js` consume the adapter layer — POS does
not.

So the target architecture you drew is not a rebuild; it is **moving POS onto a seam that
already exists** and adding the missing implementation behind it.

## The gap — and it is the important one

**A POS sale credits no merchant balance.**

- `merchantWallets` appears **once** in the entire `functions/` tree, in
  `business-health-score.js`. There is no merchant wallet ledger.
- The Daraja callback writes no `walletTransactions` and no `commissionLedger` row.
- `index.js` states the consequence directly: *"seller receives 100% while the ledger
  records a commission that was never [collected]"*.

Under `DIRECT_TO_SELLER` this is coherent — SOKONI never custodies the money, so commission
is a **receivable**, not revenue. But it means **the merchant wallet in your diagram does
not exist yet for POS**, and moving collection to IntaSend changes the custody model: money
would land with SOKONI, and the merchant's entitlement becomes a real liability that must be
ledgered before it can be withdrawn.

That is the substantive design decision in this migration — not the STK call.

## Your question 2: identifying the merchant at settlement

There are two candidate answers in the code, and the honest status differs sharply.

**(a) IntaSend native split.** `IntaSendAdapter.capabilities()` declares
`supportsSplit: true` and `initiateSplitPayment()` is implemented against
`/api/v1/payment/split-collection/`.

**It is built, and it is unproven:**
- `settlement-providers.js` has `intasend: { supportsSplit: true, splitEnabled: false }`
  with the note *"verify in sandbox before enabling"*
- the implementation itself says splits are *"mapped to IntaSend split/wallet fields at
  integration time (pending API confirmation)"*
- **no test references it**, and the only caller (`settlement-executor.js:146`) is gated
  behind `splitEnabled`, which is false

So the endpoint path and field shape are a **guess awaiting confirmation from IntaSend**.
Nothing here establishes that IntaSend's API accepts this request at all.

**(b) Collect-then-payout.** Single collection to the platform account, merchant entitlement
recorded in the internal ledger, withdrawal as a separate B2C payout. This is what
`settlement-providers.js` calls the fallback for every non-split rail, and it matches your
own recommendation to treat the merchant balance as a SOKONI ledger rather than treating
IntaSend as the wallet.

**(b) is the only one currently provable without an external answer from IntaSend.**

## Collection and withdrawal are already separate — keep them that way

```
COLLECTION   customer → IntaSend → posPayments/{ref} → sale → entitlement (MISSING)
WITHDRAWAL   wallets/{uid} → payoutRequests → IntaSend B2C → M-PESA destination
```

The withdrawal rail exists and is frozen (`wallet-backend-v1.0-frozen`), with auto-B2C off.
It has its own idempotency and its own authority. Nothing in this migration should merge
them.

## Provenance caveat — this is a REPO read, not a deployed read

Everything above is read from the working tree. It is **not** established that the deployed
Functions match it, and there is specific reason to doubt it:

- the primary repo has **182 dirty files**
- the Functions release path is recorded as **PUSH 403-BLOCKED**, so committed work may not
  be deployed
- the Functions lineage guard reportedly **fails against the production lineage**

Before any migration design is finalised, the deployed lineage must be established the way
the Rules lineage was — read what is actually running, not what is in the tree. That is the
first task of the next slice, not this one.

## Recommended next step

Do **not** write a migration plan yet. Establish deployed provenance first:

1. enumerate the deployed Cloud Functions and their update times
2. determine whether the deployed `darajaSTKPush` / `posCompleteCheckout` match this tree
3. confirm from IntaSend whether split-collection exists and what its contract is
4. only then design the rail swap behind `posPayments`

Step 3 is an **external dependency**, and it decides between architecture (a) and (b). It
should be asked now, in parallel, because it gates the design and nothing internal can
answer it.

---

# Addendum — the withdrawal domain, audited

**Scope:** map only. Nothing changed.

## The single most important finding

**There is no withdrawal fee logic anywhere in `functions/`.** The only `*FeeKES` symbols
(`platformFeeKES`, `riderFeeKES`, `totalFeeKES`) are **delivery** fees.

So the fee engine described is **greenfield**. There is no old fee table to migrate, and no
competing calculation to reconcile. That is the best possible starting position for making
it a single authority — the fragmentation risk is ahead of us, not behind.

## Second: there is no PayBill or Till payout today

`grep -owiE "till|paybill|shortcode"` against `functions/wallet.js`: **0 matches.**

`IntaSendAdapter.sendMoneyB2C()` is hardcoded:

```js
provider: 'MPESA-B2C',
transactions: [{ account: this._normalizeKenyanPhone(phone), amount: amt, … }]
```

`account` is a **normalised phone number**. Both PayBill and Till are new capability, not a
configuration of something existing. Whether IntaSend's `send-money` supports non-phone
M-PESA destinations at all is **not answerable from this codebase** — it is the same class
of external question as split-collection.

## Third: the authority is already fragmented, and across two collections

| file | exports | collection |
|---|---|---|
| `commission.js` | `requestWithdrawal`, `approveWithdrawal`, `rejectWithdrawal`, `getWithdrawals` | **`withdrawals`** |
| `finos.js` | `requestPayout`, `processPendingPayouts` | `wallets` |
| `finos-router.js` | `finosRequestBankPayout` | — |
| `index.js` | `initiateSellerPayout` (+ re-exports of finos) | — |
| `automation-engine.js` | `autoScheduledPayouts` | — |
| `wallet.js` | (the frozen engine) | **`payoutRequests`** |

`commission.js` writes **`withdrawals`**; `wallet.js` writes **`payoutRequests`**. The
canonical collection is `payoutRequests`. Two collections modelling one concept is precisely
the divergence that produced the settlement-vocabulary problem.

`index.js:requestPayout` / `processPendingPayouts` are **re-exports of `finos.js`**, not
separate implementations — so the count of real authorities is smaller than the export list
suggests, but it is still more than one.

## Fourth: the state machine is 10 statuses, not 4

Observed in `wallet.js` alone: `pending`, `approving`, `approved`, `processing`,
`retry_scheduled`, `completed`, `paid`, `failed`, `reversed`, `settled_manually`.

Note `completed` **and** `paid` both exist. The proposed
`AVAILABLE → WITHDRAWAL_RESERVED → PAYOUT_PROCESSING → PAYOUT_CONFIRMED` is a *different*
vocabulary, not a subset. Introducing it without mapping every existing status is how a
double-credit guard stops firing.

## Fifth: balance is not one field

`wallet.js` writes `balance`, `available`, `availableBalance`, `pending`, `pendingPayout`,
`pendingTopUp`. The canonical withdrawable figure is **`balance`, in shillings**. A
reservation model must be explicit about which field it decrements and which it holds —
adding a sixth name would make this worse.

## Blocking constraint

The wallet backend is **frozen** (`wallet-backend-v1.0-frozen`, `ab985e0`): no changes
except critical fixes. A withdrawal engine touching `wallets` / `payoutRequests` **is** a
change to the frozen surface. Either the freeze is explicitly lifted for this work, or the
engine is built alongside and cut over deliberately. That decision belongs to the operator
and precedes design.

## What cannot be answered internally

Both are external, both gate the design, and neither can be derived from code:

1. **Does IntaSend expose the actual fee for a given payout** (destination, amount, account
   configuration) — as an API field, a pricing endpoint, or only a published table? The
   fail-closed requirement is only implementable if some authoritative figure is obtainable
   per transaction.
2. **Does IntaSend `send-money` support PayBill and Till destinations**, and with what
   account/shortcode fields? `sendMoneyB2C` currently sends a phone number only.

These should be asked now, alongside the split-collection question. All three are the same
kind of dependency: an external answer that decides architecture, which no amount of code
reading will produce.

## Recommended sequence

1. operator decision on the wallet freeze
2. external answers from IntaSend (fees per destination; PayBill/Till support; split)
3. converge `withdrawals` → `payoutRequests` and map the 10 statuses, **before** adding
   destinations — expanding a fragmented authority multiplies the fragmentation
4. then design `calculateWithdrawal()` as the single quote authority, with destination
   modules deciding only *how* to send

---

# Addendum 2 — POS commission: what exists vs the proposed ladder

**Scope:** map only. Nothing changed.

## The 15 / 10 / 5 / 0 ladder does NOT exist in this tree

What exists in `functions/sub-billing.js` is a **relative discount**, not a rate:

| plan | `features.commission_discount_pct` |
|---|---|
| `seller_free` | 0 |
| `seller_basic` | 2 |
| `seller_pro` | 5 |
| `seller_enterprise` | 10 |

`commission-config.js:163` states it is *"applied RELATIVELY"*. So today the charge is
**base rate minus a plan discount** — an Enterprise seller pays `5% × 0.9 = 4.5%`, **not 0%**.

The proposal (absolute plan rates 15/10/5/0) is a **different model**, not a retuning of
this one. Both cannot coexist on the same field. There is precedent for absolute plan rates
— `commission_pct: 10 / 7 / 4` on the **service provider** plans — so the shape exists, but
on a different hub.

## POS is currently aliased to the marketplace category

`commission-config.js:101`:

```js
shopping: 'marketplace', pos: 'marketplace', b2b: 'marketplace',
```

So a POS sale is charged the **marketplace rate (5%)** today. Giving POS its own plan-based
schedule means **deliberately breaking this alias** — a commercial change, not a refactor,
and one that a previous commit (`ebb97c3 "POS becomes its own 5% lane"`) already touched.
It should be decided as a pricing decision, with the alias removal as its implementation.

## Three collisions to resolve BEFORE writing code

**1. Enterprise 0% vs the KES 10 minimum.** `MIN_COMMISSION_KES` dominates small sales — a
KES 97 order is charged KES 10 (10.3%), not 5%. Unless Enterprise is explicitly exempted
from the floor, **"0%" will still charge KES 10 per sale**. That is a contract question, not
a code question, and it is invisible until a merchant on the free-commission tier is billed.

**2. Three unit conventions already in play.**

| source | field | unit | 15% is written |
|---|---|---|---|
| `commission-config.js` | `pct` | percent | `15` |
| `sub-billing.js` (seller) | `commission_discount_pct` | percent, **relative** | n/a |
| `sub-billing.js` (services) | `commission_pct` | percent | `15` |
| prior ladder design | plan rate | **fraction** | `0.15` |

Writing `15` where a fraction is expected charges **1,500%**. The unit must be stated on
both sides of every assignment.

**3. A deploy guard forbids a second commission table.**
`scripts/verify-commission-single-source.js` fails the deploy if another commission table
appears anywhere in the repo — the platform previously had **nine that disagreed**. So the
"POS RAIL" branch of the proposed authority diagram must be **fields on the existing single
source**, never a new table. The diagram's two rails are a *routing* distinction, not two
tables.

## Deployed Functions lineage (your step 2)

```
functions deployed : 1,711
oldest updateTime  : 2026-08-22T07:31:47Z
newest updateTime  : 2026-09-01T20:27:46Z
```

**Functions ARE deploying** — most recently yesterday. The recorded "PUSH 403-BLOCKED" state
is not a total block on deployment. But the spread from 22 Aug to 1 Sep means **the deployed
set is not one lineage**: different functions were last written ten days apart, so
"the deployed code" is a mixture, and no single commit describes it.

This does not yet establish whether the deployed `darajaSTKPush` / `posCompleteCheckout`
match this tree. That needs per-function comparison, which `gcloud functions list` cannot
answer — it requires either source download per function or a deployed-provenance marker.

## What this changes about the sequence

Your step 4 ("define the POS commission calculation 15/10/5/0") has a hidden predecessor:

> **Decide whether POS commission is an absolute plan rate or a relative plan discount** —
> because the existing seller model is the latter, and the two cannot share a field.

And step 3 ("establish the authoritative POS plan per merchant") should confirm which plan
catalogue governs a POS merchant: `seller_*` plans carry discounts, `services_*` plans carry
absolute rates, and it is not established here which a POS merchant is on.
