# Completion PIN & single settlement — webhook record

Related: [[PRODUCT_CHECKOUT_PAYMENT_GATE]] · [[Payments]] · [[Orders]]

### [2026-10-01] — webhookIntasend: a booking is never credited at payment; an unreadable intent credits nobody

**Files:** `functions/index.js` (webhookIntasend wallet-credit block), `functions/payment-attribution.js`,
`scripts/test-b1-online-checkout-chain.js` (BK-1..BK-5), `scripts/test-attribution-intent-unreadable.js`, this record
**Base:** `f076c64` (repair #1 Unit 4b, on the serving 68811e1 lineage). **Database:** new collection
`bookingPaymentReviews/{ref}` (server-only; no client rule = deny), `payments.bookingSettlement` / `bookingReviewRef`.
**Security / money:** removes a payment-time provider credit and a buyer self-credit. **Breaking:** legacy bookNow
providers are no longer paid at payment. They are released through AdminOS review until each hub moves onto
held bookings + the buyer PIN (owner decision 2026-10-01).

- Owner 2026-10-01: "the PIN completion event must become the single release/settlement trigger", and "stop it,
  hold + review" for the legacy bookNow hubs.
- **Booking credit at payment:** the `_isBooking` branch credited `wallets/{providerId}.balance` at payment. It was
  reached by the ~18 legacy bookNow hubs (no providerBooking intent) and by a service booking whose intent read
  failed. With no providerId, `_sellerId` fell back to `payData.uid` = the BUYER. That credit is removed. The
  payment is now parked as `bookingPaymentReviews/{ref}` (claimed provider, gross / commission / net, reason)
  plus a payments marker, created once in one transaction.
- **Unreadable intent:** `resolveFinancialAttribution` still fails open, but now flags `intentReadFailed`. The
  webhook withholds every wallet credit in that case and queues it on the existing `commissionReviewQueue`.
- **Unchanged:**
  - service bookings with a providerBooking intent (held by `holdServiceBookingPayment`; sokoni-4d's PIN release
    is the one credit point);
  - marketplace / POS credits.
- **Tests:**
  - `test-attribution-intent-unreadable` 5/0 (BASE f076c64 fails 3);
  - `test-product-intent-enforcement-webhook` 29/0;
  - `test-notify-sms-recipient` 29/0;
  - `test-notify-booking-types` 15 fails, identical on base b026856 (pre-existing);
  - B1 chain BK-1..BK-5 are emulator rows: NOT YET RUN (RAM below the floor).
- **Deploy:** in my webhook chain after B1 (Unit 2 → 4b → this), scoped. Not deployed.

