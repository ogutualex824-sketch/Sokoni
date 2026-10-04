## 2026-10-04 — Invoice payments settle from the VERIFIED webhook (allocation → 15% on applied → business wallet → receipt) (NOT deployed)

- **Owner contract (direct + 2f/f3, 2026-10-04):** invoice → payment initiation (2f 549ba7f: amount = server balance, 15% captured as an immutable snapshot) → verified webhook → allocation (f3 7bd9c55) → 15% on the APPLIED amount → merchant BUSINESS wallet → receipt (received / applied / excess) → invoice status → audit.
- **Settlement table:** exact → settle all; under → settle what was received, invoice partially_paid; over → settle only the balance, excess HELD (invoiceExcessHolds) + flagged, never credited; unresolvable (unconfirmed amount, void / non-canonical / missing invoice, currency, no snapshot, merchant payer, no business wallet, zero) → nothing allocated or credited, the whole amount HELD + flagged (invoicePaymentHolds/{ref} + adminAlerts). Fee = the captured commissionRate on appliedCents, never today's table.
- **Code:** NEW functions/invoice-payment-settle.js (settleInvoicePayment — all refusable checks before money moves; IntaSend's server-to-server confirmation of the same amount is the evidence; allocation replay recovers amounts from the allocation record so a half-finished attempt completes exactly once; wallet credit keyed per payment AND a create-once invoiceSettlements/{ref} audit record carrying the snapshot; receipt = paid (received) + released (applied: fee + merchant net), excess stays held). Wired in webhookIntasend after the rental hold (functions/index.js).
- **Carried byte-identical:** invoice-allocation.js 99c6a7e4 + shared/invoice-model.js 6a9998b3 (f3 7bd9c55), transaction-receipts.js 384442fb (2f 549ba7f: + 'invoice' kind, a pure addition on this tree's a760e381), shared/settlement-authority.js fac23464, business-wallet.js c342c882 (RC line), settlement-destination.js acc3d714, store-identity.js 415562c1, tenant-identity.js 3a890ccb (backward-compatible: optional dbOverride only).
- **Database:** new server-only collections invoicePaymentHolds, invoiceSettlements (and f3's invoiceExcessHolds, invoices/{id}/allocations) — no client rule (default deny); businessWallets / businessWalletEntries kind 'invoice_settlement'.
- **Tests:** NEW test-invoice-payment-settle 19/0 — settlement table (KES 12,500 @15%: exact → 10,625; 10,000 → 8,500 + 2,500 outstanding; 15,000 → 12,500 applied, 10,625, 2,500 held) and the owner's 12 invariants (verified-webhook-only incl. a claimed-vs-confirmed mismatch, allocation / wallet / receipt idempotency over 3 deliveries, crash-recovery replay, no client path, claims create no money, overpay never credited, receipt = verified + allocation, status from allocations, immutable captured rate, unresolved held + flagged with the AllocationError code). NEW sabotage-invoice-payment-settle 14/14 (incl. both idempotency keys broken → triple credit caught). Webhook-tree regression identical to base f0fca5c; p0-payment-integrity (12) and commission-category (3) rows remain UNPROVEN (emulator, memory gate).
- **Deploy:** webhookIntasend only, from this tree, after the rental webhook (f0fca5c) — with 2f's createPaymentIntent (invoice purpose + merchant_invoice 15% row) deployed first; emulator + browser gates and live verification still owed. NOT certified.

## [2026-10-03] - Rental payments: webhookIntasend HOLDS a verified rental_booking payment (the webhook half of the rental contract)

Functions only (`webhookIntasend` → new `functions/rental-payment-hold.js`). It is its own unit on top of the P0 webhook (73c5e5e). **Not deployed.**
- **What it does:** a `rentalBooking` intent payment is held, never credited. The shop owner is paid only at the renter's PIN at return (f3 rentalConfirmReturn).
- **Checks:** the callback gross must equal the intent's `amountCents` (rent + deposit) to the cent. IntaSend's own server-to-server confirmation is also required, and the payer must be the renter.
- **States:**
  - accepted / confirmed / payment_pending → `paid_held` / `held`, plus `heldAmountCents`, `depositCents`, `paymentRef`, `paidAt` and `providerMethod`, in one txn. A replay is a no-op.
  - A payment for a cancelled, declined or closed rental is NEVER held. It becomes `refund_due` with a `commissionReviewQueue/rental_refund_{ref}` row. No wallet is credited (Wallet FROZEN).
  - Anything unproven (amount, IntaSend, payer, missing rental) is parked in `commissionReviewQueue/rental_{reason}_{ref}`.
- **Scope:** non-rental intents fall through unchanged. The retired `intasendWebhook` is not touched.
- **Database:** `rentalBookings` gains `paid_held` / `held` / `refund_due` and the fields above. `commissionReviewQueue` gains kinds `rental_payment` and `rental_refund_due`.
- **Tests:** `test-rental-payment-hold` 20/0 (incl. wiring); sabotage caught 8/8. `test-p0-payment-integrity` 33/0 with the same 12 UNPROVEN as baseline; product-intent-enforcement 29/0; no-payer-credit 21/0; provider-method 14/0.
- **Deploy order:** after the P0 webhook and providerDispatch 451acee, and before f3's commerceDispatch + rental trigger.

## [2026-10-03] - webhookIntasend: the commission category comes from server records, never the client; unresolved → the seller credit is HELD

Functions only (`webhookIntasend`, new `functions/shared/commission-category-source.js`). Built on 73c5e5e. **Not deployed.**
- **Defect (2f lead, confirmed on 73c5e5e):**
  - The generic credit path priced commission with `payData.meta.category`, and `initiateSTKPush` copies `meta` verbatim from the client request. A modified client could name a 0% lane (jobs / construction_service) or the 5% default instead of marketplace 15%.
  - The seller-specific rule lookup used the PAYER's uid.
  - A failed commission calculation credited the seller 100%.
- **Fix:**
  - Product orders are priced under `marketplace` (owner 2026-09-19: one flat rate for every seller and product). The product's `category` is NOT read, because sellers can write it on the served rules. Live checkout sent `product`, which fell to the 5% default, and `marketplace` is 5% on this tree, so the price does not change. Other purposes use the category their server pricer stamped on the intent.
  - An unresolved category or a failed calculation HOLDS the seller credit: `commissionReviewQueue/commission_hold_{ref}` + `walletCreditSkipped: 'commission_unresolved'`. The buyer's payment still records as paid.
  - The commission lookup uses the attributed seller.
- **Behaviour change:** none for product orders. A payment whose server records name no category (a non-product purpose with no stamp) now holds the seller credit instead of charging the default.
- **Tests:**
  - `scripts/test-webhook-commission-category.js`: Layer A 7/0. Layer B (the real handler) is **UNPROVEN**: the harness refuses below the 512 MB floor, so it must run before deploy.
  - Existing suites: p0-payment-integrity 44/0 (all handler rows ran when memory allowed), product-intent 29/0, no-payer-credit 21/0, provider-method 14/0.

