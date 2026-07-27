# Booking & Payment Contract — v1.0 (RATIFIED 2026-07-28)

**Status:** RATIFIED — the authoritative customer-side booking + money contract for **service
appointments** (`providerBookings`). Phase E implements against this.
**Companion:** `docs/BOOKING_LIFECYCLE_CONTRACT.md` (provider lifecycle/states) and Phase C settlement.
**Audit basis:** read-only landscape audit 2026-07-27 (payment rails, current Book Now path, holds precedent).

---

## 0. The problem this contract resolves

The audit found **three parallel booking systems**, and the live customer path is incompatible with the
Phase A–D backend:

| Path | Creates | Credits provider | Slot reservation |
|---|---|---|---|
| **Legacy free** (`services.html submitBooking` → `SokoniDB.saveBooking`) | client-writes `bookings` | never | none |
| **Live pay-first** (`SokoniPay.bookNow` → `webhookIntasend`) | `bookings/{ref}` on payment | **at PAYMENT time** (`wallets.balance += net`) | none |
| **Canonical** (`bookingCreateService`, D-phases) | `providerBookings` (slot-locked) | **at COMPLETION** (Phase C settlement) | slot-lock CAS |

**Critical money conflict:** the live path credits the provider on *payment*; Phase C credits on
*completion*. Doing both = **double payment**. Phase E must define **exactly one credit point**.

---

## 1. Canonical booking financial timeline (the source of truth)

```
Service + slot selected
        │
        ▼
Amount computed SERVER-SIDE from the rate card   (price + fee [+ deposit]) — client cannot name it
        │
        ▼
providerBooking CREATED  status:pending  paymentStatus:pending   (slot-lock reserves the slot;
        │                                                          payment-expiry auto-cancels if unpaid)
        ▼
Payment authorized (M-Pesa STK via IntaSend)  →  webhook confirms  →  paymentStatus:paid  (funds HELD)
        │
        ▼
Provider confirms   (pending → confirmed)          [provider is NOT yet paid]
        │
        ▼
Service delivered → Complete   (→ completed)
        │
        ▼
SETTLEMENT (Phase C, the ONE credit point) — net → provider wallets.balance, exactly-once
```

**The invariant:** money is **held from payment until completion**, and the provider is credited **once,
at completion** (Phase C). No payment-time provider credit for `providerBookings`. This makes cancel/no-show
refunds/forfeits possible (the money is still held, not already paid out) and reuses the settlement monitor.

---

## 1a. Invariants (must always hold)

1. **Single provider credit point.** *No booking payment path may directly credit a provider wallet.*
   Provider credit is **exclusively** Phase C settlement after booking completion. The current
   `webhookIntasend` `type:'booking'` immediate-credit branch is legacy, retained only until Phase F retires
   that path — the canonical `providerBookings` flow never uses it. This resolves the double-credit conflict
   **by construction** (the settlement monitor's `walletTxExceedsSettled` stays 0 because there is one credit
   path, not because monitoring catches a second one).
2. **Payment amount derives EXCLUSIVELY from the server-minted payment-intent snapshot.** When payment begins
   the server snapshots `price`, `fee`, `deposit`, `pricingVersion` (the D3 rate-card values) into a
   `paymentIntent`. The STK amount is computed **only** from that snapshot — never from the current
   `providerServices` record, the client payload, or a UI-recalculated value. This closes the audit's
   Stage-1a `STK_NO_AUTHORITY` amount-authority gap for bookings.
3. **Funds held from payment to completion.** `paymentStatus:paid` means *held*, not *paid out*; the money is
   not the provider's until completion settles it.
4. **Payment-expiry is terminal and self-cleaning.** When the 15-min TTL on an unpaid pending booking
   expires: **release the slot lock, mark the booking `cancelled` (reason: payment-expired), invalidate the
   payment intent** (unusable), and the customer must **restart** the booking. No stale pending bookings linger.
5. **One review per completed booking, immutable linkage.** A review requires **exactly one `completed`
   `providerBookings` doc** owned by the reviewer; it references the **immutable `bookingId`** (+ providerId +
   customerUid). Deterministic review id keyed on `bookingId` enforces one-per-booking. The completed booking
   IS the purchase-verification — no separate mechanism.

The immutable pricing→payment chain:
```
rate card → server mints paymentIntent (snapshot: price/fee/deposit/pricingVersion)
          → customer pays the snapshot amount → booking uses that snapshot → completion settles from it
```

---

## 2. The eleven contract points (decisions)

1. **Service selection** — customer picks a `providerServices` rate card (the canonical service). The
   `serviceId` + `providerId` + chosen slot are the booking inputs.
2. **Slot reservation** — reserved at **create** via `bookingCreateService`'s slot-lock CAS (a pending
   booking holds the slot). No separate hold doc — the pending booking *is* the reservation, with a
   **payment-expiry** (unpaid → auto-cancelled, slot released) analogous to the venue engine's 2-min hold
   but longer for M-Pesa STK (recommend **15 min**).
3. **Deposit required vs optional** — **provider-controlled** (D3 `providerServices.deposit`; 0 = none).
4. **Booking fee** — provider-controlled (`providerServices.fee`). Both are the D3 **immutable snapshot** on
   the booking; the customer sees them before paying.
5. **Payment authorization/confirmation** — M-Pesa STK via IntaSend (existing rail). Amount is
   **server-authoritative**: a `paymentIntent` is minted server-side from the rate-card snapshot, so the
   client cannot set the amount (closes the audit's Stage-1a `STK_NO_AUTHORITY` gap for bookings).
   Confirmation is the existing idempotent `webhookIntasend` claim.
6. **Booking-creation timing** — **create-then-pay.** The `providerBooking` exists (pending, slot-locked)
   *before* payment; payment flips `paymentStatus:pending → paid`. (Not pay-then-create — that writes the
   wrong collection and credits at payment.)
7. **Cancellation windows** — provider-configurable; **v1 default:** free customer cancel ≥ 24h before
   `startTs`; < 24h is a late cancel (deposit forfeit — see §3 diagram). Provider cancel = always full refund.
8. **Deposit refund policy** — refunds are **wallet credits** to the customer (the platform's established
   refund mechanism — `automation-engine` credits buyer wallet; no IntaSend API refund exists). See §3.
9. **No-show forfeiture** — provider marks `no_show` (D1, only after `startTs`); the **deposit is forfeited**
   to the provider (settled to their wallet), the **remainder refunded** to the customer's wallet. See §3.
10. **Failure recovery** — STK timeout / abandoned payment: the pending booking's payment-expiry auto-cancels
    it and releases the slot (idempotent). Webhook-after-timeout still reconciles (deterministic ids).
11. **Idempotency** — three layers, all existing: payment-transition claim (`payments/{ref}` transaction),
    deterministic booking id (`providerId_slotKey`) + `_serviceBookingIdem`, and exactly-once settlement
    (Phase C). Phase E adds a deterministic **payment-intent** id per booking.

---

## 3. Cancel / no-show money policy (source of truth for the payment side)

```
CANCEL
 ├─ by provider (any time)            → FULL refund to customer wallet; slot released; no settlement
 ├─ by customer ≥ 24h before start    → FULL refund to customer wallet; slot released; no settlement
 └─ by customer < 24h before start    → deposit RETAINED (settled to provider); remainder refunded
                                         (if deposit = 0 → full refund)

NO-SHOW  (provider marks, only after startTs)
 └─ deposit FORFEITED (settled to provider wallet); remainder (price+fee − deposit) refunded to customer
    (if deposit = 0 → nothing forfeited; full refund)

COMPLETE
 └─ full settlement: net (price − commission) → provider wallet (Phase C, exactly-once)
```

These attach to the **lifecycle §6 side effects** — they change *what money moves*, never the state machine
(`cancelled`/`no_show`/`completed` are unchanged from `BOOKING_LIFECYCLE_CONTRACT.md`).

---

## 4. What is collected upfront (decision to confirm)

**v1 recommendation: collect the FULL amount (price + fee) upfront, held until completion.** Rationale:
avoids a second "pay the balance" step, the money is fully present for clean refund/forfeit math, and it
matches how customers expect to pay M-Pesa once. The **deposit** is then the *forfeitable portion* on
late-cancel/no-show (not a separate smaller charge). Alternative (deposit-only upfront, balance on service)
is deferred — it needs a balance-collection flow the canonical path doesn't have yet.

---

## 5. Escrow / held-funds mechanism (decision to confirm)

Funds must be **held** between payment and completion (§1). Two ways to realize "held":

- **(A) Logical hold (recommended v1):** payment lands in the platform IntaSend account (as today); the
  `providerBooking` carries `paymentStatus:paid` + `heldAmount` but the provider wallet is **not** credited
  until completion. "Held" is a *state*, not a separate ledger. Simple; reuses Phase C as the single credit.
- **(B) FinOS escrow:** route the payment through the existing FinOS escrow/`releaseEscrow` primitives
  (they exist but are not applied to service bookings today). More machinery; defer to a later version.

Either way, the **Phase E service-booking path must NOT use the existing `webhookIntasend` `type:'booking'`
immediate wallet-credit branch** — that branch stays for legacy `bookings`/venue and is retired in Phase F.

---

## 6. Reviews (Phase E workstream 3)

- **Gate:** a review may be created **only** for a `providerBookings` doc that is `completed` and owned by the
  reviewing customer — **one review per completed booking** (deterministic id keyed on `bookingId`). This is
  greenfield (the existing `submitReview` writes `reviews` with optional order-only gating).
- **Target:** write to **`providerReviews`** (the collection `providerGetReviews`/`providerReplyReview`
  already read), so reviews surface in the provider dashboard and directory.
- **Immutable linkage:** the review stores `bookingId` + `providerId` + `customerUid`, immutable.

---

## 7. Cutover & retirement (composes with Phase F)

- Phase E repoints **"Book Now"** (`services.html`, `provider-profile.html`) to the canonical path:
  `bookingCreateService` (create pending) → server-minted payment intent → STK → held → provider confirms.
- Legacy paths (`SokoniDB.saveBooking` free write; `SokoniPay.bookNow` pay-first webhook create) are
  **instrumented and retired in Phase F** once telemetry shows zero traffic (per the convergence template).
- The double-credit conflict is *resolved by construction*: canonical bookings never hit the payment-time
  credit branch, so the settlement monitor's `walletTxExceedsSettled` invariant stays 0.

---

## 8. Ratified decisions (2026-07-28)

1. **Credit point = completion only** (§1, invariant 1). Provider credited exclusively by Phase C settlement.
2. **Collect the full amount (price + fee) upfront, held** (§4). Deposit = the forfeitable portion of the
   already-paid amount, not a separate charge.
3. **Logical hold** (state-driven, reuse Phase C), not FinOS escrow, for v1 (§5).
4. **Cancellation policy** (§3): customer ≥24h → full refund; customer <24h → deposit retained + remainder
   refunded; provider cancel → 100% refund; no-show → deposit forfeited + remainder refunded.
5. **Payment-expiry TTL = 15 min**, terminal + self-cleaning (§2, invariant 4).

## 9. Versioning
- **v1.0** — this contract (create-then-pay, held-until-completion, full-amount-upfront, wallet-credit
  refunds, deposit-forfeit-on-no-show/late-cancel, reviews gated on completed booking).
- Adding deposit-only-upfront + balance collection, or FinOS escrow, is **v1.1+** (additive).
- Changing the credit point or the collected-amount model is **v2.0** (breaking), re-approved.
