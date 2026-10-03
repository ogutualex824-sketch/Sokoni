# Transaction receipts: one platform-wide payment receipt per paid transaction

Status: **module built and unit-tested. Hooks NOT wired. NOT deployed.**
Owner decision 2026-10-03 (relayed by sokoni-b2): *"Required before Legal is user-ready."* It is platform-wide, not Legal-specific.

Related: [[Payments]] · [[Orders]] · [[COMMERCIAL_CONVERGENCE_2026-09-30]] · [[INTASEND_CONVERGENCE]]

## Census (2026-10-03, commercial-fn)

| Path | What a paid transaction produces today |
|---|---|
| Service booking verified (`booking-payment-sweep`) | `providerBookings` paid_held + heldAmount + paymentRef. **No receipt.** |
| PIN release (`provider-ops.settleOnPinRelease`) | `providerPayouts` (gross, commission, net, fee), wallet credit. **No receipt.** |
| Refund after release (`reverseServiceSettlement`) | negated payout, wallet debit, buyer ledger. **No credit note.** |
| Marketplace order (IntaSend) | `posReceipts/{apiRef}` with tax hard-coded 0 and method hard-coded "M-PESA" |
| POS | `posReceipts/{saleId}`, number derived from the sale id |
| `financial-engine.recordConfirmedPayment` | the intended single subscriber; **only caller was the deleted Daraja callback** |
| `financialDocuments` / `financialReceipts` | written only by that engine; no hosting reader |
| `sokoni-invoice.js`, `invoice.html` | **localStorage only** |
| IntaSend payment method | **never captured.** Every downstream path hard-codes it |

## Why not reuse `financial-engine.recordConfirmedPayment` as-is

- **VAT:** it applies a **default 16% VAT-inclusive split to the whole gross**. That is VAT inferred, which the project forbids.
- **Revenue:** it journals the whole amount as **SOKONI REVENUE**. A provider's service is not SOKONI's revenue; only the fee is.

So it stays unwired pending its own VAT decision. Its good parts are reused: idempotency by reference, sequential numbering (`_nextNumber('RCT')` gives `SKN-RCT-YYYY-NNNNNN`), immutability and the never-throw failure queue.

## What the receipt is

A **payment receipt** issued by SOKONI as the collecting platform. It proves the buyer paid and shows where the money is.

It is **not** a tax invoice:
- **The provider's supply** is fiscalised by the provider (`etims.generateForOrder`, their eTIMS profile).
- **SOKONI's fee** is SOKONI's own supply, invoiced to the provider through `etims._issuePlatformInvoice`.

`taxTreatment` is **recorded, never computed**: `provider_fiscal_invoice | not_vat_registered | unknown`.

## Data model (`functions/transaction-receipts.js`)

`transactionReceipts/{kind}_{sourceId}` holds one record per booking, quote or order.

**Immutable header**, set at the verified payment:
- **Identity:** `receiptNo`, `kind`, `sourceId`.
- **Parties:** `clientUid`, `counterpartyId`, `counterpartyName`.
- **What was bought:** `serviceLabel`, `quotedCents`, `currency`.
- **Payment:** `paymentRef`, `providerRef`, `method` (as IntaSend reported it; null = not reported).
- **Tax and proof:** `taxTreatment`, `confirmation {source:'intasend_webhook', verifiedAt}`, `issuedAt`.

**Running position**, changed only together with an event in the same transaction:
- `paidCents`, `heldCents`, `releasedCents`, `refundedCents`, `platformFeeCents`, `providerNetCents`, `status`, `updatedAt`.
- Status values: `paid_held | partially_released | released | partially_refunded | refunded | paid`.

**Events**, `.../events/{type}_{opKey}`: immutable, created with `create()`. They are the refund/adjustment history.
- Fields: `type` (`paid | released | refunded | adjusted`), `amountCents`, `platformFeeCents?`, `providerNetCents?`, `reason?`, `milestoneId?`, `opKey`, `at`.
- **Milestones later:** a milestone release is just another `released` event carrying its `milestoneId`. Nothing in the booking or ledger has to change.

**Owner's minimum field list → where each field lives:**
- invoice ID → `receiptNo`
- booking/quote ID → `kind` + `sourceId`
- client → `clientUid`
- advocate/firm → `counterpartyId` / `counterpartyName`
- service → `serviceLabel`
- quoted amount → `quotedCents`
- VAT/tax treatment → `taxTreatment`
- SOKONI fee → `platformFeeCents`
- held → `heldCents`
- released → `releasedCents`
- payment reference → `paymentRef` / `providerRef`
- payment method → `method`
- status → `status`
- confirmation → `confirmation`
- timestamps → `issuedAt` / `updatedAt` / event `at`
- refund/adjustment history → `events`

**Read:** the callable `myTransactionReceipts` returns the caller's receipts, as client or as provider, each with its own immutable `events` history (capped at 50, oldest first; a projection, not the raw document). It is scoped on the server; there is no client rule access.

## Hook contract (sokoni-b2 builds the provider-booking hooks on this)

Every call is made **after** the money step has committed, wrapped in `safely(db, label, fn)`. A failure is queued in `transactionReceiptFailures` and never fails the payment.

1. **Verified payment:** the webhook/sweep path that sets `paid_held`.
   ```js
   recordPaid(db, {
     kind: 'service_booking', sourceId: bookingId, clientUid: b.customerUid,
     counterpartyId: b.providerId, counterpartyName, serviceLabel: b.service,
     quotedCents: b.price + (b.fee || 0), paidCents: heldAmount,
     paymentRef: apiRef, providerRef: invoiceId, method: <IntaSend-reported or null>,
     taxTreatment: <from the provider's eTIMS profile: active → 'provider_fiscal_invoice'; else 'unknown'>,
   })
   ```
2. **PIN release / show-up:** `recordEvent(db, receiptIdFor('service_booking', bookingId), {type:'released', amountCents: settlementCents + commission, platformFeeCents: commission, providerNetCents: net, opKey: bookingId})`.
3. **Refund** (pre- or post-settlement): `recordEvent(db, id, {type:'refunded', amountCents: refundedCents, opKey: <refund id | bookingId+'_refund'>, reason})`.
4. **Accepted quote, order:** the same calls with `kind: 'quote' | 'order'`.

## Open

- **Payment method capture:** the IntaSend webhook never reads the provider/method field. The webhook lineage (sokoni-5b) must store it on the payment so `method` is real. Until then `method` is `null`, never a hard-coded "M-PESA".
- **Hosting:** a receipt view reading `myTransactionReceipts`. `sokoni-invoice.js` / `invoice.html` read localStorage and must not be reused as-is.
- **`financial-engine` VAT split:** a separate decision before anything calls it again.

## Tests

`scripts/test-transaction-receipts.js` passes 13/0:
- R1–R2: issue and replay.
- R3: release with fee/net, plus retry.
- R4: refund before/after release, over-refund refused, repeat refund.
- R5: milestone releases.
- R6: no VAT computed, null method.
- R7: bad input.
- R8: scoping.
- R9: never-throw queue.

## Convergence step 2 (owner brief, 2026-10-03)

**Decisions recorded**
- **One authority:** `transaction-receipts.js` is the single platform receipt authority. A receipt never decides who owns money; the payment/webhook and the ledger do.
- **Old recorder retired:** `financial-engine.recordConfirmedPayment` now refuses and logs (`{ok:false, reason:'retired'}`). Its body is unreachable until its accounting model is redesigned. It is never connected to receipts.
- **Paid Education stays OFF:** the `enrolment` kind is reserved only. Paid enrolment stays shut (E1) until its IntaSend/webhook path is certified.
- **Electronics:** no receipt until its commerce flow exists.

**Model additions**
- **`links`** (`quoteId`, `bookingId`, `orderId`, `purchaseOrderId`, `settlementId`): a Legal quote receipt references both the quote and the booking.
- **`b2b_order` kind and deductions:** a release may carry `deductions: [{kind:'lead_fee_recovery', amountCents, ref}]`, tracked as `deductionsCents`. It is never `platformFeeCents`.
  - Example: gross 500,000, commission 0, lead-fee recovery 696, supplier 499,304.
- **Balanced releases:** a release must satisfy fee + provider share + deductions = amount released, otherwise it is refused (`unbalanced_release`).
  - For service bookings: `providerNetCents` = `providerPayouts.settlementCents`, `platformFeeCents` = commission, amount = held.

**Retry and admin**
- **`safely(db, label, fn, replay)`** queues `{op, args}`. `retryFailures` replays it (callable `adminRetryReceiptFailures` for Super Admin, audited; plus a sweep every 6 hours). Deterministic ids mean a retry can only produce one receipt or event.
- **`adminSearchReceipts`:** search by receiptNo, paymentRef, sourceId or party. Returns header plus immutable events. Every access is audited (`adminAudit`, `receipt_view`). It is read-only; nothing rewrites history.

**Numbering:** `financial-engine._nextNumber` now shares one in-flight block reservation per instance. A burst on a cold instance previously had every caller reserve a block at once; they contended until transactions failed. The base fails the burst test; the fix passes. Numbers are unique and ascending, the series resets each year, and gaps are allowed.

**Payment method:** the commercial line's `webhookIntasend` carries 5b's `providerMethod` byte for byte. The Quick Charge receipt, the IntaSend order receipt, the merchant receipt and the marketplace order now record it, with null meaning not reported (`test-webhook-provider-method-commercial.js` 3/0).

**Reconciliation:** `receipt-reconciliation.js` (daily, 04:30 EAT) records exceptions and never corrects them. Added on the second pass: `receipt_without_payment`, `duplicate_payment_ref`, `invalid_history`, `history_total_mismatch` (stored totals must equal the immutable events) and `release_without_hold`.
- **Checks:** `missing_receipt`, `orphan_receipt`, `paid_mismatch`, `release_missing`, `provider_share_mismatch`, `refund_mismatch`.
- **Storage:** exceptions go to `receiptReconciliationExceptions`, one document per check and source, with `firstSeenAt` kept.
- **Scope:** service bookings first. Other kinds join as their hooks land. Wallet-movement-without-ledger checks belong to the wallet authority (Financial Core; wallet.js frozen) and are not done here.

**Tests:** `scripts/test-receipts-convergence.js` 14/0 (L1, B1–B3, Q1a–d, A1, N1, C1a–c, X1). `test-transaction-receipts` 13/0, `test-financial-engine` 21/0.

**Release order (owner):**
- **A:** foundation. Do not ship any UI alone that implies receipts exist.
- **B:** integrations (b2: bookings and quotes; B2B release via 5b's hook; method capture).
- **C:** buyer, provider and AdminOS UI.
- **D:** reconciliation.
- **E:** certification (at least 512 MB free, emulator, real IntaSend test payment and webhook, release, refund, duplicate webhook, receipt retry).
- **F:** production, functions first.
