# SOKONI — Canonical Collections (Source-of-Truth Map)

**Check this before writing any query.** Reading a stale/duplicate collection is the single
most common defect on this platform — it produces "successful" writes that no consumer can
see, and admin panels that show 0 while real data sits elsewhere. Every domain has ONE
canonical collection. If you need data, read the canonical one.

Related: [[project_booking_hold_lifecycle]] · [[reference_wallet_balance_model]] · [[feedback_registry_projection_traps]]

---

## The map

| Domain | Canonical collection | Notes |
|---|---|---|
| **Product orders** | `orders` | Marketplace/checkout orders. |
| **Products** | `products` | Also mirrored to Algolia `sokoni_products` (auto-sync). |
| **Service bookings** | `providerBookings` | Doc id `${providerId}_${slotKey}`. The ONE service-booking store. **Never infer service metrics from `orders`.** |
| **Venue / resource bookings** | `bookings` (+ `bookingHolds`) | The *separate* venue engine (`booking.js`). Not service bookings. |
| **Availability config** | `providerAvailability/{uid}` | Schedule/appt/breaks/overrides; slot locks in `…/slotLocks/{slotKey}`. |
| **Booking lifecycle events** | `bookingEvents` | Append-only audit (HELD/RESUMED/RELEASED/EXPIRED/PAYMENT_CONFIRMED/CONFIRMED). |
| **Wallet balance** | `wallets/{uid}` | Canonical **withdrawable** balance = `balance` (whole **shillings**). Never duplicate balances. |
| **Wallet ledger entries** | `walletTransactions` | One row per movement; deterministic ids where at-most-once. |
| **Withdrawals** | `payoutRequests` | Lifecycle: requested → pending → approving → paid \| rejected. **`payouts` is DEPRECATED.** |
| **Provider settlements (services)** | `providerPayouts` | Per-booking earnings + commission (gross/commission/net, full audit). Settled at completion. |
| **Product / marketplace commission** | `commissionLedger` | Written by the IntaSend webhook for product payments. |
| **Provider analytics** | `providerAnalytics/{uid_YYYY-MM-DD}` | Daily rollup: bookingsCompleted, grossCents, commissionCents, netCents. |
| **Provider public profile** | `providerProfiles/{uid}` | Rating/reviewCount/completion; Algolia `sokoni_services`. |
| **Bookable services** | `providerServices` | Name/price/duration/category; Algolia `sokoni_services` (auto-sync). |
| **Provider registry (bookability)** | `providers/{uid}` | `status ∈ {active,approved}` + `acceptsBookings` gate service creation. |
| **Payment intents** | `paymentIntents/{ref}` | Server-minted; `resourceType`/`resourceId` link to the booking/order. |
| **In-app notifications** | `notifications` | Feed queries `targetUid`; write BOTH `userId` + `targetUid`. Dedupe log: `notifyLog`. |
| **Payment transactions** | `transactions` | Product payment records (admin revenue reads this today). |

---

## Deprecated / do-not-use

| Deprecated | Use instead | Why |
|---|---|---|
| `payouts` | `payoutRequests` | Withdrawals converge on `payoutRequests`; `payouts` is stale — admin views reading it showed 0. |
| `commission.js requestWithdrawal`, `finos.js requestPayout` | `requestSellerPayout` (wallet.js) | Both retired; earnings converge into `wallets.balance`, withdraw debits it. |
| Reading `providerPayouts` status==`pending` to withdraw | `wallets.balance` via `requestSellerPayout` | Booking earnings settle **directly to the wallet** and mark the payout `settled`, not `pending`. |

---

## Canonical functions (the ONE path)

- **Withdraw:** `requestSellerPayout` (wallet.js) → `payoutRequests` → `adminProcessPayout` (approve/reject/pay) → IntaSend B2C.
- **Admin payout queue:** `adminGetPendingPayouts` (wallet.js) reads `payoutRequests`.
- **Wallet top-up (deposit):** `initiateWalletTopUp` → `confirmWalletTopUp` (M-Pesa STK).
- **P2P send:** `walletV2Send` (wallet-engine.js).
- **Service settlement:** `providerCompleteBooking` (provider-ops.js) → `wallets.balance` + `providerPayouts` + `providerAnalytics`.

---

## Reporting rule (aggregate, don't pick one)

Admin finance must **aggregate both** revenue streams:

```
Total platform revenue = product commission (commissionLedger)
                       + service commission (providerPayouts)
GMV                    = product orders (orders) + service revenue (providerBookings/providerPayouts)
```

Do not report platform revenue from `transactions` alone — it misses every service booking.

---

*Maintained as part of the 2026-08 admin data-layer audit. Update this table in the same PR
that introduces a new domain or migrates a collection.*
