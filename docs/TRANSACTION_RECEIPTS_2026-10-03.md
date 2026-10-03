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

**Read:** the callable `myTransactionReceipts` returns the caller's receipts, as client or as provider. It is scoped on the server; there is no client rule access.

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
