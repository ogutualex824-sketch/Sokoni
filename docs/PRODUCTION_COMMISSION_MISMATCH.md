# Production commission mismatch

**Status:** 2026-09-26. **Documentation only.** This document records production behaviour. It
changes no rate and names no winner. Owner decisions are recorded separately in
[[CANONICAL_MONEY_VERSION_DECISIONS]].

Related: [[PRODUCTION_PAYMENT_LINEAGE_MAP]], [[PRODUCTION_WALLET_LINEAGE_RECONCILIATION]],
[[REFUND_AUTHORITY_CONVERGENCE]].

**Evidence.** Everything below was measured read-only on 2026-09-26:

- The serving source archives of all **1,721** functions (41 distinct archives), read from
  `gs://gcf-v2-sources-…`. No deploys, provider calls or writes were made.
- Two Firestore REST GETs: `revenueConfig` and `commissionRules`.
- The census was run with `scripts/commission-version-extract.js`.

## 1. Correction to the earlier statement

[[PRODUCTION_PAYMENT_LINEAGE_MAP]] said that "the function that charges commission (5% / 12%) and
the function that reverses it on refund (3% / 8%) run different rate tables." **That statement is
imprecise.**

- The 3% / 8% table is **bundled** in the `fosSubmitRefund` / `fosApproveRefund` archive, but
  **neither refund handler ever calls `calculateCommission`**. Both are in `financial-os.js`
  `d0db437`.
- The same archive also serves `fosSecureWebhook`, which **charges** commission through
  `_processFOSTransaction → calculateCommission` using that 3% / 8% table.

The real mismatch is therefore **between charging paths**. On refund, commission is not recomputed
at all; it is either **not reversed** (the FOS path) or **reversed from the persisted value**
(`initiateRefund`).

## 2. Which transactions use which calculation

Production data overrides are **empty**, observed 2026-09-26:

- `commissionRules` has 0 documents.
- `revenueConfig` has 1 document, `plan_adjustments`, with `enabled: false`.
- There is no `global`, `seller_*` or `hub_*` override.

So the **code defaults below are what production charges**. One layer was not measured: the
subscription-plan rate layer that `calculateCommission` consults (`subRatePct`) for provider
flows.

| Charging path (serving function) | `commission-config` / `finos-utils` | Marketplace | Hub / delivery | POS | Services | Other notable behaviour |
|---|---|---|---|---|---|---|
| `webhookIntasend`, `intasendWebhook`, `posInitiateIntasendPayment` | `2a4a70e` / `0c31966` | 5 % | 12 % | **5 %, fixed** (bypasses every override and plan adjustment) | 15 % | persists `commissionPct`, `sokoniCut` (whole KES) |
| `fosSecureWebhook` (FOS transactions) | `8ed1a0d` / `a02aaa4` | **3 %** | **8 %** | 3 % (aliased to marketplace) | 15 % | persists `commissionCents`, `commissionRate` |
| `onSellerPaymentCreated`, `releaseEscrow`, `previewCommission` | `26da697` / `9e60e98` | **package tier** 5 / 4 / 3 / 2 % | 12 % | 5 % | **package tier** (Free 5 %) | unknown category **throws** (fail closed); `car_rental` refused as pending pricing |
| `onOrderStatusChange`, `expireOldEscrows`, `initiateRefund`, `recordPayment`, `webhookPaymentCallback` | `ea13f09` / `266a159` | package tier 5 / 4 / 3 / 2 % | 12 % | 5 % | package tier | unknown category throws |
| `posCompleteCheckout`, `completePOSQRPayment` (+7 supply functions) | `407481d` / `1886dc3` | **15 % flat** marketplace-seller lane (`base` 5 % without a `sellerId`) | 12 % | **5 % flat** POS lane | 15 % | event tickets 3 % |
| `initiateSTKPush`, `dispatchDelivery`, `respondToDispatch` (+2) | `c646856` / `36a0da1` | 5 % | 12 % | 5 % (aliased to marketplace) | 15 % | — |
| **1,682 other functions**, including `commissionDispatch`, `finosRecordTransaction`, `finosProcessSettlements`, `processSettlement`, `bookingDispatch`, `providerDispatch`, `purchaseTickets`, `onNewOrderCreated`, `onPosSaleCompleted`, `requestSellerPayout` | `ca10c86` / `36a0da1` | **3 %** | 12 % | 3 % (aliased to marketplace) | 15 % | — |
| `loyaltyDispatch` | `1f30c65` / `d6f8a0f` | 5 % | 12 % | 5 %, fixed | 15 % | — |
| `processTypesenseQueue` | `a5f5178` / `1886dc3` | marketplace lane **16 %** (Free) | 12 % | 5 % flat | 15 % | — |

Constants identical in every version: `MIN_COMMISSION_KES = 10`, `PLAN_MIN_PCT = 0.5`,
`PLAN_MAX_DISCOUNT = 50`.

Rates identical in every version include:

| Category | Rate |
|---|---|
| `event_tickets` | 3 % |
| `ppv` | 15 % |
| `digital` | 10 % |
| `food` | 5 % |
| `legal` | 5 % |
| `property` | 2 % |
| `vehicles` | 0 % + KES 2,000 |
| unknown category | default 5 %, except the two fail-closed versions, which throw |

**Consequence.** Take a KES 1,000 marketplace sale. SOKONI's commission today depends on the
**rail** that completes it:

| Rail | Commission |
|---|---|
| `fosSecureWebhook` or `finosRecordTransaction` | KES 30 |
| `webhookIntasend` | KES 50 |
| `onSellerPaymentCreated` | KES 20–50, by package |
| `posCompleteCheckout` marketplace lane | KES 150 |

## 3. Can a refund differ from the original commission?

| Refund path | Commission treatment on refund | Can differ from the charge? |
|---|---|---|
| `fosSubmitRefund` (admin auto-approve) / `fosApproveRefund` | **None.** Debits the seller's `wallets/{uid}.balance` by the **full refund amount** (any shortfall goes to `refundRecoveryDebt`). Writes `refundedCents` on the wallet and the `fosTransactions` doc. **No `commissionLedger` reversal.** | Yes. The seller was credited **net** (gross − commission) but is debited **gross**, so SOKONI keeps the commission and the seller bears it. Whether that is the intended policy is an owner question, not recorded anywhere. |
| `initiateRefund` (escrow) | Reverses from the **persisted** settlement: `platformRevenueShillings -= settlement.commissionCents / 100`, and the ledger is reversed via `handleOrderRefund`. | No — it uses the stored value. No recalculation happens. |

**An attribution risk on the FOS path (code-proven; frequency in data unmeasured).**

- For a refund keyed by `payRef`, `fosSubmitRefund` reads `payments/{payRef}`.
- The queue row stores `sellerUid: tx.sellerUid || tx.uid`, and `fosApproveRefund` debits that uid.
- For a buyer-initiated marketplace STK payment, `payments.uid` is the **buyer** and the seller is in
  `meta.sellerUid`. If `payments/{ref}` has no top-level `sellerUid`, the approve path debits the
  **buyer's** wallet.
- The admin auto-approve path debits only `tx.sellerUid`, so it may debit **nobody**.

## 4. Persisted at transaction time, or recalculated?

**Persisted, on every charging path examined. No refund path recalculates.**

| Path | Document and fields written at charge time |
|---|---|
| `webhookIntasend` | `commissionLedger/{apiRef}`: `category`, `commissionPct` (`null` on engine failure, plus a `commissionReviewQueue` row), `sokoniCut` (**whole KES**, `Math.round(cents / 100)`), `providerNet`, `serviceTotal`, `source: 'webhookIntasend'`, `status: 'auto_collected'`. Also `payments/{apiRef}`: `walletCreditedAt`, `walletCreditCents`, `walletCreditedTo`. |
| `fosSecureWebhook` | `fosTransactions/{txId}`: `commissionCents`, `commissionRate`, `netCents`, `remainderCents`. Also `commissionLedger/fos_{txId}`: `commissionCents`, `remainderCents`; and `ledger/fos_{txId}_commission`. Refuses to settle if commission fails. |
| `onSellerPaymentCreated` | `commissionLedger` with `pct`, `fixedKES`, `commissionKES`, `totalOwed`, the audit breakdown (`baseRate`, `planId`, `planApplied` …) and `billingModel: 'PER_SALE_48H' \| 'MONTHLY'`. |
| escrow / order settlement | the settlement doc's `commissionCents` plus the audit (`commissionPct`, `pricingSource`, `ruleId`, `engineVersion`). |

## 5. Does the ledger allow reconstruction?

**Mostly yes.**

- Every rail stores the charged amount and, in most cases, the rate and the category.
- What is **not** stored is the **code version** that priced the sale, except where
  `engineVersion` is written.
- The version can be inferred from `source` plus timestamp against the serving archive's deploy
  history. That inference is only as good as the deploy record: archives are replaced on deploy,
  and only the current generation was read here.
- The `webhookIntasend` rows round `sokoniCut` to whole shillings, so sub-shilling precision is
  lost there.

## 6. Affected flows

- Marketplace online checkout: `webhookIntasend`, `fosSecureWebhook`, `finosRecordTransaction`,
  `posCompleteCheckout` lane.
- POS / Till: `webhookIntasend` fixed 5 %, `posCompleteCheckout` 5 %, `onPosSaleCompleted` 3 %.
- Delivery: hub 12 % everywhere, except the FOS rail at 8 %.
- Provider and booking flows (`services`): 15 %, or package-tier 5 % on `onSellerPaymentCreated`.
- Merchant-collected payments (the 48 h receivable): `onSellerPaymentCreated`.
- FOS refunds (no reversal) and escrow refunds (persisted reversal).

## 7. Can historical data be classified read-only?

**Yes, with no writes.** For each commission document, group by
`source`, `category`, `commissionPct` or `commissionRate` or `pct`, and `createdAt`:

- `commissionLedger` (by `source`, and `fos_*` ids);
- `fosTransactions` (`commissionRate`);
- the settlement docs.

Then compare each group with the rate the **owner-chosen** table would have produced. The output is
a count and a KES delta per rail. **Not run in this slice.**

## 8. The smallest future remediation slice

1. **Read-only classification** (§7). This produces the size of the historical delta per rail and
   per category. No writes.
2. **One rate authority for every charging rail.** Every serving function would load the one
   owner-chosen `commission-config` / `finos-utils` pair. This is a deploy of the chosen version
   to the charging functions named in §2, one function at a time, each with a behavioural test at
   the chosen rates. Nothing is recomputed for past sales.
3. **A separate owner decision on FOS refund commission:** should a refund return commission to
   the seller, or keep it? Also fix the seller attribution (§3) to read the canonical seller, not
   `tx.uid`.

Out of scope for all three: rewriting historical ledgers. Any adjustment for past sales is a
finance decision taken on the output of step 1.
