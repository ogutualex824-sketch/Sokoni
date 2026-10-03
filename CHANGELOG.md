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

