## [2026-10-04] - Notifications E2E, step 1: the engine resolves the SMS recipient and ALWAYS records the SMS outcome

Functions (`functions/notify.js`, new `functions/shared/notify-recipient.js`). Built on webhook tip f26c80a, which carries the newest live notify.js (68811e1, a superset of the bf6d703 every other live function bundles). **Not deployed.**
- **Production evidence (read-only, owner-approved, 2026-10-03):**
  - smsQueue had **0** documents ever, and 58/58 notifyLog rows recorded no SMS outcome.
  - Push failed `no_token` 58/58: only 1 of 87 users has a token, last saved 16 June.
  - Email works (166 queued). AT_ENV = production; no SOKONI sender ID.
- **Recipient resolution:** the engine resolves the recipient itself:
  1. the verified profile phone (`users.phoneNumber`; an explicit `phoneVerified:false` demotes it);
  2. the verified login phone (Firebase Auth);
  3. no usable number.
  - The number is normalised to E.164 and must be a Kenyan mobile.
  - **A phone supplied by the caller is never used.**
- **SMS outcome, always recorded:** `queued` (attempted), `skipped:<no_phone | invalid_phone | unverified_phone | unsupported_destination | sms_disabled | quiet_hours | not_eligible | push_delivered | duplicate>` or `failed:<provider_error | rate_limited>`. Also `result.delivery.sms = {status: attempted|skipped|failed, reason}`.
- **Policy:**
  - SMS-eligible = types with an SMS template in payments / **orders** / delivery / security. The orders default was off, so an order SMS could never send.
  - Commerce SMS is a FALLBACK only when push cannot land. Marketing is never automatic.
- **Tests:**
  - `scripts/test-notify-sms-resolution.js` 19/0 runs the REAL notify(); sabotage caught 8/8.
  - It replaces `scripts/test-notify-sms-recipient.js`, whose case 1 ("a caller phone is used verbatim") the owner rule now forbids.
  - `test-notify-booking-types` shows 15 failures **pre-existing on this base**: types from other lineages (`payout_failed`, …) are not registered here. Converging them is step 2.
- **Not done yet (release gate):** push registration (browser), order and payment convergence onto this engine, per-channel idempotency, recovery-manifest deploys, and production delivery evidence.

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

