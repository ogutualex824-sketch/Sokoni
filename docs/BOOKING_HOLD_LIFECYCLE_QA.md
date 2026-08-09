# Booking Hold Lifecycle — Production QA Gate

Six end-to-end scenarios that must pass on **production** (`mysokoni.co.ke`) before the
service-booking engine is considered production-proven. Run on a real device with a real
M-Pesa number against a real provider (DJ Bvmbxno). For each, send me the **bookingId**,
**paymentRef/receipt**, **providerId**, and **amount** — I verify the server side from Firestore.

Related engines: [[booking-service]] · [[availability]] · [[booking-payment-sweep]] · [[Payments]]

Hard-refresh once before starting so the service worker picks up **v193** (or later).

---

## 1. Successful M-Pesa payment
**Steps:** Open DJ profile → Book → pick a service → pick a slot → Pay with M-Pesa → enter PIN.
**Expected (UI):** Screen flips to "Paid • Held — awaiting provider"; the countdown disappears.
**Expected (server):** `providerBookings/{id}` → `paymentStatus: 'paid_held'`, `expiresAt` **removed**,
`heldAmount` = price+fee (cents), `paymentRef` set. The slot lock persists.
**Then:** the slot no longer appears in `getAvailabilitySlots` for that time (Scenario also proves Slice 2).

## 2. User closes the payment modal (abandon)
**Steps:** Create a booking to the payment sheet → **close the modal** (X / back) before paying.
**Expected (server, within ~1s):** booking → `status:'cancelled'`, `cancelReason:'customer-abandoned'`,
`cancelledBy:'customer'`; the `slotLocks/{slotKey}` doc is **deleted**; payment intent → `cancelled`.
**Expected (UI):** re-opening availability shows that slot **available again** immediately.

## 3. STK rejected / cancelled on the phone
**Steps:** Create a booking → Pay → on the phone, **cancel/reject** the STK prompt (or let it time out).
**Expected (server, on webhook receipt):** booking → `status:'cancelled'`,
`cancelReason:'payment-failed'|'payment-cancelled'|'payment-expired'…`, `cancelledBy:'intasend-webhook'`;
slot lock deleted; customer notified "Reservation released". **No sweep wait** — released on the webhook.
**Note:** this depends on IntaSend delivering a terminal-state webhook; if none arrives, Scenario 4 is the backstop.

## 4. Hold expires naturally (device dies)
**Steps:** Create a booking to the payment sheet → **do nothing** (don't pay, don't close) for ~6 min.
**Expected:** at `expiresAt` (5 min) the booking is swept within ~1 min (cleanup runs **every 1 minute**):
`status:'cancelled'`, `cancelReason:'payment-expired'`, `cancelledBy:'system'`; slot lock deleted.
**Expected (UI):** the sheet flips to "⌛ Expired — please rebook"; Pay is disabled at 0:00.

## 5. Two users book the same slot simultaneously
**Steps:** Two devices/accounts open the **same** slot → both tap through to create at the same time.
**Expected:** exactly **one** succeeds (gets to payment). The other gets a clear message —
*"Another customer is completing payment for this time…"* (loser saw a live unpaid hold) or
*"Someone else just booked and paid…"* (if the winner already paid). **Never** a double-booking.
**Server:** one `providerBookings/{providerId_slotKey}` doc; the deterministic id + slot-lock CAS guarantee it.

## 6. Same user refreshes during payment
**Steps:** Create a booking → at the payment sheet, **refresh the page** (or reopen the DJ and pick the SAME slot).
**Expected:** the existing **unpaid hold resumes** (server returns `resumed:true`, refreshes the 5-min window) —
**no duplicate** booking is created, no "just taken". The same `bookingId` continues to payment.

## 7. Idempotency under duplicate callbacks
**Why:** payment providers retry webhooks; the release/hold paths must stay idempotent.
**Steps:** Force a repeat — reject an STK (Scenario 3) so a terminal webhook fires, then let IntaSend retry
(or replay the same callback). Equivalently, close the modal twice (double release).
**Expected:** the **first** delivery changes state; **subsequent** deliveries are clean no-ops
(`released:false, reason:'already-released'|'already-paid'`) — no errors, no slot corruption, and
**no duplicate `bookingEvents`** (release/expiry/paid events use deterministic ids, so a retry overwrites
the same event doc). Guaranteed structurally by the transaction guards in `releaseServiceHold`
(terminal-status + paid-status early return) — this scenario confirms it end-to-end.

---

## Event trail (Slice 4) — `bookingEvents` per scenario
Every transition writes a structured event to `bookingEvents` (query `where bookingId == <id>`), with
`actor`, `previousStatus → newStatus`, `paymentRef`, `at`. Expected trails:

| Scenario | Event trail (`type`) |
|---|---|
| 1 Pay success → confirm → complete | `BOOKING_HELD` → `PAYMENT_CONFIRMED` → `BOOKING_CONFIRMED` (→ completion events) |
| 2 Close modal | `BOOKING_HELD` → `BOOKING_RELEASED` (actor `customer`) |
| 3 STK reject | `BOOKING_HELD` → `BOOKING_RELEASED` (actor `intasend-webhook`) |
| 4 Natural expiry | `BOOKING_HELD` → `BOOKING_EXPIRED` (actor `system`) |
| 6 Refresh/resume | `BOOKING_HELD` → `BOOKING_RESUMED` (repeatable) → … |
| 7 Duplicate callback | exactly **one** `BOOKING_RELEASED` doc (`<bookingId>_released`) no matter how many retries |

## Fast verification
`node scripts/verify-booking.js <bookingId>` prints the three layers for one booking — server state
(status, paymentStatus, expiresAt, cancelReason, **slot-lock presence**), the full `bookingEvents` trail,
and the financial chain (intent, commission ledger, provider calendar) — with a consistency check. Read-only.
Send me a `bookingId` after each scenario and I run it.

## What I verify server-side (from your IDs)
- Booking state transitions (`status`, `paymentStatus`, `cancelReason`, `cancelledBy`, `expiresAt`).
- Slot-lock presence/absence at `providerAvailability/{providerId}/slotLocks/{slotKey}`.
- Payment intent status (`paymentIntents/{ref}`).
- Settlement + commission on completion (Scenario 1 → provider confirm → complete): provider wallet net
  credited, `commissionLedger/{ref}` entry, admin financial reporting.

## Pass criteria
All six behave as above **and** the full happy path (Scenario 1 → provider confirm → complete → provider
wallet net → commission in admin reporting → customer review) completes. Then the hold lifecycle is proven.
