# Booking Convergence — Design (draft, no SoT committed)

**Status:** DESIGN ONLY — audited 2026-07-27 (4 read-only audits). No code, no source-of-truth commit until reviewed.
**Question this answers:** the service-booking loop is broken; which stack becomes the single source of truth, and how do we converge without rebuilding?

## 1. The problem — the loop is open

A service booking cannot complete end to end today. Three disconnected paths:

1. **Customer "Book Now"** (`services.html:1141,1191`, `provider-profile.html:319`) → `SokoniPay.bookNow` (`sokoni-pay.js:382`, localStorage + payment modal) **+** `SokoniDB.saveBooking` (`sokoni-db.js:154`, raw `addDoc` to top-level `bookings`, client-supplied id, **no** transaction/slot-lock/capacity/validation).
2. **Provider dashboard** reads **`providerBookings`** (`provider-ops.js:46`) — a *different* collection **nothing writes** (`firestore.rules` `providerBookings` `write:false`; no CF creates it). The provider never sees the customer's booking.
3. **Authoritative engines bypassed:** `availability.js reserveSlot` is dead (SDK calls undeployed standalone names); `booking.js` has ~8/10 guarantees but is venue-keyed and unused by any service UI.

Plus a **security hole**: `firestore.rules:326-330` lets a client create a `bookings` doc with self-declared `price`/`status`/`paymentStatus` (`noAdminFields` doesn't cover those), bypassing the authoritative path entirely.

## 2. The two stacks — deep comparison

| Dimension | **Provider-services stack** | **Venue stack (`booking.js`)** |
|---|---|---|
| Collection | `providerBookings/{id}` | top-level `bookings/{autoId}` |
| Owner key | `providerId` | `ownerId` + `customerId` + `venueId` |
| Record | `{providerId, status, price(cents), scheduledAt, service, customerName, ...}` (inferred — no create CF) | `{venueId, ownerId, customerId, date, startTime/endTime, startTs/endTs, duration, pricingBreakdown, status, paymentStatus, reminders[]}` (`booking.js:574-604`) |
| Status vocab | pending / requested / confirmed / declined / in_progress / completed / cancelled | pending / confirmed / active / completed / cancelled / no_show |
| **Reservation engine** | ❌ none (no create CF; `availability.js reserveSlot` has slot-lock but is dead/unreached) | ✅ atomic slot-lock CAS, capacity, buffers, per-customer counter, waitlist, holds+expiry, payment verification (`booking.js:490-627`) |
| Lifecycle CFs | ✅ confirm / decline / **complete** (`provider-ops.js:59,80,98`) + `providerCalendar` mirror | ✅ approve / reject / cancel / checkIn / checkOut / **markNoShow** / reschedule |
| **Commission** | ✅ **canonical engine** — `calculateCommission` (`provider-ops.js:128`, `category:'services'`, `subscriptionRole:'provider'`), plan-rate authoritative, full audit trail | ❌ none — completion just sets `status:'completed'` |
| Earnings ledger | ✅ `providerPayouts/{bookingId}` idempotent + audit trail (`provider-ops.js:146`) | ❌ none |
| **Wallet credit** | ❌ earnings sit in `providerPayouts` (pending); never reach `wallets.balance` | ❌ none |
| Analytics | ✅ `providerAnalytics` daily rollup (`provider-ops.js:180`) + `providerGetAnalytics` | ✅ `bookingGetStats` / `venueGetStats` |
| Pricing source | `providerProfiles.pricing` + rate cards (`providerServices`) | `venue.pricing` (unified pricing-schema) → `pricingBreakdown` |

**What each OWNS that the other lacks:**
- Provider stack owns the **money-critical business logic** — canonical commission, idempotent payout ledger with reproducible audit trail, analytics, the appointment lifecycle. It is missing only **creation + reservation**.
- `booking.js` owns the **authoritative reservation engine** (the hard concurrency-correct part). It is missing **commission + settlement**.

## 3. Recommendation — TWO domains, ONE shared reservation core (not a forced merge)

Service **appointments** (a person's time) and **venue/facility** bookings (a physical space with concurrent capacity) are genuinely different domains with different record shapes, pricing, and lifecycles. Forcing providers into the `venues` model (provider-as-venue) is a lossy rebuild that discards the provider stack's canonical commission/analytics.

**Recommended SoT: the provider-services stack (`providerBookings`) is canonical for service appointments.** Then:
1. **Extract `booking.js`'s reservation primitives into a shared module** (`reservation-core`): atomic slot-lock, capacity, buffer-aware overlap, per-customer counter, waitlist, hold+expiry. Both a new provider `bookingCreate` and the venue engine call it.
2. **Add the missing provider `bookingCreateService` CF** — the authoritative creation path that runs `reservation-core` against `providerAvailability` (working hours, buffers, capacity, blackout `overrides`) and writes `providerBookings` in a transaction. This closes the loop: the provider's existing confirm/complete/commission lifecycle now has real bookings to act on.
3. **Add the booking→wallet credit** — on `providerCompleteBooking` (or a settlement step), sweep the `providerPayouts` net into `wallets.balance` + `walletTransactions` (server-side; the standing "no client wallet writes" rule holds). Delete the false `wallet.js:1583` comment.
4. **Close the rules hole** — `bookings`/`providerBookings` create must be **CF-only** (`write:false` for `providerBookings` already; tighten `bookings` create so clients can't self-declare price/status).
5. **Repoint the client** — `services.html`/`provider-profile.html` "Book Now" from `SokoniPay.bookNow`+`SokoniDB.saveBooking` to the new `bookingCreateService` CF (payment via the verified path). Retire the raw `addDoc`.

Alternative (single-engine) if you prefer one collection: canonicalize on `booking.js`/`bookings`, generalize it to providers, and re-add commission + wallet there. This reuses the reservation engine but **rebuilds** the commission/ledger/analytics/audit-trail that provider-ops already has, keyed to the canonical engine — the more expensive path, and it collapses two domains into one model. Documented for completeness; not recommended.

## 4. Schema reconciliation (what a converged provider booking record needs)

`providerBookings/{id}` (canonical) gains the reservation fields it lacks, sourced from `reservation-core`:
- keys: `providerId`, `customerUid` (add — currently only `customerName`), `serviceId` (link to `providerServices` rate card).
- time: `date`, `startTime`/`endTime`, `startTs`/`endTs` (add — for overlap math), `durationMins`.
- reservation: deterministic slot key for the lock; `holdId`/`holdExpiresAt` if payment-pending.
- pricing: `price`(cents, exists) + `pricingSource` (rate card id + fee/deposit) + `paymentStatus` (add — pending/paid, so unpaid holds expire).
- status vocab: adopt `no_show` (from the venue vocab) so the lifecycle has it.
- commission/ledger/analytics: unchanged (already correct).

## 5. Migration & rollback

- **No historical data migration needed for correctness** — the old client-written `bookings` docs are orphaned/non-authoritative; leave them, don't backfill (per the standing "fix the write path, not the read path" principle). A later dry-run backfill could reconcile stragglers if any real bookings exist there.
- **Rollback** — the client repoint is flaggable (`USE_SERVICE_BOOKING_CORE`), the legacy `SokoniPay.bookNow` path stays until the new path is proven; the rules tightening is the one-way security fix (keep it).
- **Owner-isolation** — GREEN (separate audit); no blocker.

## 6. Build phases (maps to the 7-area vision)

| Phase | Work | Gate |
|---|---|---|
| **A. Reservation core** | extract shared slot-lock/capacity/buffer/waitlist/hold module; unit + emulator tests | concurrency suite (double-book, buffer, cap, waitlist) |
| **B. Authoritative service create** | `bookingCreateService` CF (reservation-core + providerAvailability) writing `providerBookings`; close the rules hole; repoint Book Now behind a flag | loop closes: customer→provider; emulator + rules-unit |
| **C. Settlement→wallet** | credit `providerPayouts` net → `wallets.balance` + `walletTransactions` on completion; delete false comment | wallet reconciliation test |
| **D. Provider ops onto the canonical foundation** | 4 sub-phases (below) — lifecycle ops, **availability convergence**, rate-card fields, calendar | per sub-phase |

### Phase D sub-phases

Phase D is not primarily feature work — it converges provider operations onto the authoritative
booking/settlement backend already in production. Four shippable increments, backend-first:

- **D1 — Booking lifecycle ops.** Implements `docs/BOOKING_LIFECYCLE_CONTRACT.md` (v1.0): new ops
  `providerRescheduleBooking` (in-place slot move via reservation-core), `providerCancelBooking`,
  `providerMarkNoShow`, `providerStartBooking` (→in_progress), `providerContactCustomer`; dashboard
  buttons. Gate: emulator state-transition + reschedule re-lock + rules suite; every terminal transition
  releases the slot lock; only `completed` settles.
- **D2 — Availability convergence (the architectural heart).** *One authoritative availability
  configuration path.* Today TWO paths write `providerAvailability` (the rich `availability-manager.html`
  via `setProviderAvailability`, and a blind-merge `providerUpdateAvailability`), the dashboard reaches
  neither (its Availability tab is a stub → onboarding), yet the authoritative engine
  (`bookingCreateService`) already trusts `providerAvailability`. D2: dashboard → availability manager →
  **normalized, server-validated** save → the booking engine consumes the same normalized model; stub
  removed. Folds in: the **breaks editor** (UI hard-codes `breaks:[]`) + **honoring breaks in the create
  path** (`booking-service.js` ignores them today); the `maxSim`↔`maxSimultaneous` round-trip bug. Gate:
  create-path rejects a slot inside a break; breaks round-trip; malformed config rejected.
  **Follow-on convergence candidate:** blackout `overrides` are written **directly to Firestore from the
  client** today — bring them onto the same server-authoritative save path (or record as the next
  convergence step), aligning with the platform's trajectory toward server-owned business state.
- **D3 — Rate-card fields.** Extend the already-canonical `providerServices` CRUD with per-service
  **fee, deposit, images[]** (Storage upload). Deposit activates the deferred cancel/no-show refund policy
  in the lifecycle contract §6.
- **D4 — Provider calendar.** First day/week UI over the already-populated `providerCalendar` /
  `providerGetBookings` (zero UI consumers today). Presentation over an existing backend.
| **E. Service page + reviews + client cutover** | rate cards, slots, reviews list, response time, Book Now wired to `bookingCreateService`; `providerReviews` creation CF gated on a completed booking; multi-dimension ratings | reviews gated on completion; publicationContract-style check |
| **F. Legacy retirement** | after cutover: deprecate + instrument the legacy client create path, measure usage, remove at zero traffic | zero legacy booking-create traffic before removal |

## Legacy retirement lifecycle (Phase F)

The legacy service-booking create path — `SokoniPay.bookNow` (localStorage) + `SokoniDB.saveBooking` raw `addDoc` to top-level `bookings`, plus `hub-wiring.js saveBooking` — must NOT become a permanent dual implementation. After the Phase E client cutover, retire it the same way the publication subsystem was converged:

1. **Deprecate** — mark the legacy path deprecated in code; new work never routes through it.
2. **Instrument** — emit a telemetry event whenever the legacy create path runs (which page, which flow), so its residual usage is measured, not guessed.
3. **Measure** — watch the metric across releases until legacy booking-create traffic reaches zero (all clients on `bookingCreateService`).
4. **Remove** — in a dedicated cleanup release, delete the legacy create code and any now-orphaned `bookings`-write client paths. Then the top-level `bookings` create rule can be fully closed to CF-only (`create: if false`), completing the security posture the Phase-B tightening began.

```
legacy path → feature flag → authoritative backend → client cutover →
observe production → zero legacy traffic → remove legacy code → close rule to CF-only
```

No silent caps, no permanent dual paths: the retirement is complete only when the metric is zero and the code is gone.

### Exit criteria (all must hold before any legacy code is removed)

Removal is gated on objective, instrumented measures — not a calendar date and not judgment. Every criterion is auditable from telemetry/logs, so the retirement decision leaves a clear trail for *why* it was safe to remove.

| Criterion | Target |
|---|---|
| Legacy booking-create requests | **0** for a sustained observation window (not a single reading — see [[feedback_intermittent_state]]) |
| Supported clients on `bookingCreateService` | **100%** (every shipped client build cut over) |
| Post-cutover error rate | within normal operational baseline (no regression introduced by the cutover) |
| Rollback period | fully elapsed with the flag defaulting to the new path and no rollback triggered |
| Legacy instrumentation | confirms **no production callers** across the observation window |

Only when **all** rows are green does the cleanup release land: delete the legacy create code, then close the top-level `bookings` create rule to `if false` (CF-only). If any row regresses mid-window, the window resets — the same async-observation discipline used elsewhere in the platform.

## 7. Open decisions for review
- **SoT confirmation** — provider stack canonical + shared reservation core (recommended) vs single-engine on `booking.js`.
- Whether venue and service bookings should ever share one directory/search surface (probably not — different domains).
- The `no_show`/`in_progress` status vocab unification.
