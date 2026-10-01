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


## Audit (brief §3), measured on LIVE archives 2026-10-01

| | Product order (marketplace, IntaSend) | Service booking (providerBooking intent) | Legacy bookNow booking |
|---|---|---|---|
| **Payment credit point** | webhookIntasend → `creditWalletTxn` (FinOS cents) at payment; order stamped `settlementStatus:'settled'` | none — `holdServiceBookingPayment` → `paid_held` | webhook `_isBooking` → `wallets.balance` at payment (**removed in 3a4c9ab**) |
| **Completion credit point** | `settleOrder` at `completed` (onOrderStatusChange) — a no-op for webhook-settled orders; **credited ANY completed order, unpaid included (gated in 788416b)** | `providerCompleteBooking` txn, only when `paid_held` (sokoni-4d trio adds the PIN gate) | none |
| **Wallet authority** | FinOS `creditWalletTxn` (webhook) vs `wallets.balance` shillings (settleOrder) — two representations | `wallets.balance` shillings | `wallets.balance` shillings |
| **Ledger** | `commissionLedger/{apiRef}` (webhook); `settlements/` + `ledger/` (settleOrder) | `providerPayouts` + `walletTransactions` | `walletTransactions/{p}_{ref}_booking` |
| **Duplicate paths** | none reachable (the settled marker); a finalize failure after the credit could leave the order unmarked (inferred) | none reachable; the race + plaintext PIN in 2e3762b were fixed by sokoni-4d (6a9dd40) | none (no completion credit), but forgeable provider + buyer self-credit |
| **Canonical settlement point (target)** | the buyer's PIN / confirmation → ONE release | `providerCompleteBooking` on a verified PIN (sokoni-4d) | AdminOS review → migrate each hub to held bookings + PIN |

The delivery PIN today:
- **Issuance:** issued at order create (crypto, 6 digits, HMAC, plaintext only in a deny-all `deliveryPins`). `deliveryPinOnAccept` silently replaces it at rider accept. A 4-digit `Math.random` webhook `proofPin` is never verifiable.
- **Lifecycle:** no TTL and no reissue. The 5-attempt counter is not transactional and never resets.
- **SMS:** sent only AFTER `delivered`.
- **Rider UI:** `driver.html dhPinEntry` is 4 digits and checked in the browser.
- **AdminOS:** no PIN view.

## Slices (owner decisions 2026-10-01: seller held till PIN · bookNow held + review · TTL 48 h, ≤5 resends · SMS now)

1. **DONE 788416b** — settlement gate in `settleOrder`: paymentVerified + rider_pin|buyer_confirmation + buyer ≠ seller,
   otherwise HELD. Live archive base 106db63. **Priority deploy** (it closes a seller self-credit).
2. **DONE 3a4c9ab** — webhook: no booking credit at payment, and nothing credited on an unreadable intent.
3. **NEXT, the seller hold.** For marketplace orders the webhook stops crediting at payment. It records
   `escrow {heldNetCents, commissionCents, rate, ref}` on the order (commission still decided AT PAYMENT, ledger
   unchanged) and leaves the order un-settled. `settleOrder` RELEASES exactly the recorded net through the same
   `creditWalletTxn` representation, once, on the PIN. No rate is recomputed, and there is no second commission
   record. Deploy order: slice 1 → slice 3 (functions) → webhook.
4. **Product PIN engine.**
   - TTL 48 h; `pinVersion`; seller / assigned-rider "Send customer PIN" callable (old PIN dies, ≤5).
   - Transactional attempt lockout.
   - No silent replacement at accept.
   - Retire the webhook `proofPin`.
   - Built on sokoni-4d's booking-pin-core envelope pattern.
5. **SMS delivery.**
   - A notify.js direct, UNPERSISTED secret send (the queue and notification docs store bodies).
   - Send at issue / resend, not after `delivered`.
   - WhatsApp slot OFF until the owner adds credentials.
6. **Hosting.**
   - Buyer show/hide PIN + "PIN YAKO NI PRODUCT YAKO" copy.
   - Seller/rider resend button.
   - driver.html 4-digit modal → server `completeDeliveryWithPin`.
   - AdminOS masked PIN status + held settlements + bookingPaymentReviews.
7. **Separate.**
   - `smsEnqueue` lets any signed-in user SMS any template to any number.
   - Hub-by-hub bookNow → service_booking intents.
