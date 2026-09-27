# Entertainment Bookings — one identity, one PIN, one conversation (Convergence Slice A)

Related: [[ENTERTAINMENT_READINESS]] · [[EVENTS_OPERATIONS]] · [[ENTERTAINMENT_HUB]] · [[SOKONI_CONNECT]] · [[Payments]]

Branch `feat/creator-hub` · 2026-09-27 · **not deployed** · provider calls 0 · production writes 0.

## Owner decisions this slice implements

| Decision | Where it lands |
|---|---|
| One canonical booking identity; category-specific PINs ("PIN YAKO NI TICKET YAKO" for events, "PIN YAKO NI BOOKING YAKO" for bookings) | `functions/entertainment-bookings.js`, `functions/shared/ent-booking-identity.js` |
| Connect amendment AUTHORIZED: booking conversations | `connect-calls.js` anchor `entBooking`; `messages.ensureAnchoredConversation` |
| Artist / Entertainment-service / venue bookings pay **5 %** | `commission-config.RATES.entertainment_bookings`; `provider-hub` classification |
| **Cash removed** from event ticket sales | `event-sales.js`, Quick Sale UI, organizer agreement v1.1 |
| **Admission settles the ticket**: when gate staff admit a ticket by PIN / QR, SOKONI keeps 3 % and the organizer's business wallet is credited — never the buyer | `event-settlement.releaseTicketShare` |
| **Show-up settles the booking**, with refund and security policies | `provider-ops.settleOnShowUp`, `venue-payments.js` |

## 1. The identity

```
BOOKING → PAYMENT → PROVIDER → CONVERSATION → NOTIFICATIONS → REFUND → VERIFICATION → ADMINOS
```

| Category | Source (authority, unchanged) | Reference | Credential |
|---|---|---|---|
| EVENT | `eventOrders` (event-hub + event-settlement) | the order's `SK-EVT-YYYY-NNNNNN` ticket numbers | per-ticket PIN (event-ops) — **no booking PIN** |
| ARTIST | `providerBookings` classified ARTIST | `BK-ART-YYYY-NNNNNN` | booking PIN |
| SERVICE | `providerBookings` classified SERVICE | `BK-SVC-YYYY-NNNNNN` | booking PIN |
| VENUE | `bookings` (booking core) | `BK-VEN-YYYY-NNNNNN` | booking PIN |

One server-written envelope per booking: `entBookings/{evt|svc|ven}_{sourceId}`. It references the source; it copies no
price, slot or status authority. A trigger per source keeps it in step.

**Parties are derived on the server, never taken from a client:** buyer = the source's buyer field; provider = the event's
organizer, the venue's owner (re-derived from `venues/{id}.ownerId` — a mismatch gets no identity), or the booking's
provider.

**Entertainment classification** (ARTIST / SERVICE) comes from the provider's **decided application**
(`provider-hub.resolveProviderClassification`), stamped on the booking at creation (`commissionHub: 'entertainment'`,
`entClass`). The self-editable profile category cannot move a provider into the 5 % lane.

## 2. The booking PIN

- 4 digits from `crypto.randomInt`, **HMAC-bound to the booking**: `HMAC(SOKONI_HMAC_KEY, "entbk|<envId>|<pin>")`. The same
  digits never verify another booking, and a ticket PIN (`evtpin|…`) never verifies a booking.
- The raw PIN lives only in `entBookingSecrets/{envId}` — readable by the **buyer** alone. The provider sees `••••`.
- **Only the booking's provider** verifies (`entBookingVerifyPin`).
  - A wrong PIN is counted: 5 per booking and actor, 20 per actor, per 10 minutes.
  - It is audited without the PIN.
  - Crossing a limit writes a `securityEvents` record.
- States: ISSUED (not confirmed / paid) · **NOT_YET** (earlier than 2 h before the start) · ACTIVE · USED (once) ·
  SUSPENDED (refund in flight) · INVALID (cancelled / refunded) · EXPIRED.
- **Protected actions** require a verified PIN:
  - venue check-in (`bookingCheckIn`). This is now owner-only, and the time is the server's; the customer can no longer
    check themselves in.
  - the start of an Entertainment service (`providerStartBooking`).

## 3. Show-up settles the booking

| Category | When | SOKONI | Provider (business wallet `wallets/{uid}`) | Never |
|---|---|---|---|---|
| Event ticket | gate staff admit the ticket (PIN or QR) | 3 % (booked at payment) | that ticket's share of the organizer net | the buyer |
| Event, never admitted | event end + 24 h | 3 % | the unadmitted remainder | the buyer |
| Artist / service | the provider verifies the booking PIN | 5 % | price − 5 % + fee | the buyer |
| Venue | the venue verifies the booking PIN | 5 % | gross − 5 % − provider fee | the buyer |
| Venue no-show | booking end + 24 h (the buyer's dispute window) | 5 % | net | the buyer |

A refund after part of an order was paid at the gate is recorded as an AdminOS exception
(`refund_after_admission_release`), never a silent wallet debit.

## 4. Refund policies (every refund is a REQUEST to the canonical authority)

| Category | Policy | Path |
|---|---|---|
| Event | the event's refund policy (penalty only for buyer-driven reasons) | refund wizard → financial-os |
| Artist / service | provider cancel / decline → full; customer ≥ 24 h → full; customer < 24 h / no-show → deposit forfeited | booking engine `_disburseHeldFunds` (a provider **decline** of a paid booking now refunds — the money was stuck) |
| Venue | venue cancels → full; buyer ≥ the venue's cancellation window → full; inside the window → less the venue's fee; after the start or after show-up → no automatic refund | `venueRequestRefund` → financial-os (`via: 'venue_booking'`) → `onVenueRefundProcessed` |

`fosSubmitRefund` refuses direct refunds of `event_ticket`, `service_booking` (the double-refund defect) and `venue_booking`
payments.

## 5. Conversations and notifications

- The server creates `conversations/ent_booking_{envId}` with exactly the booking's two parties. It uses the same shape as
  every conversation, so the inbox, `chat.html`, moderation and the history boundary are unchanged.
  - Clients are refused, by both `createConversation` and the rules (reserved id space).
- System events are posted into the conversation (deterministic ids, so they are never duplicated): created · payment ·
  status · refund · verified.
- Notifications, anchored to the booking: `ent_booking_created`, `ent_booking_update`, `ent_booking_refund_update`,
  `ent_booking_verified`. Four existing booking types were silently dropped because they were unregistered; they are now
  registered: `booking_confirmed`, `booking_cancelled`, `booking_refund_completed`, `booking_reschedule_proposed`.
- Calls: the `entBooking` anchor uses the `booking` kind, which deliberately has no call surface. **Calls are UNPROVEN**
  because no TURN / STUN relay is provisioned.

## 6. Venue payment rail (`functions/venue-payments.js`)

- `venue_booking` purpose, priced from the booking's server total (client add-on prices are no longer accepted).
- It is self-settling: the webhook never credits the payer.
- It activates exactly once through the entitlement engine. The settlement is HELD until show-up or no-show release.
- An unpaid booking is cancelled 30 minutes after creation (`venuePaymentSweep`).

## 7. AdminOS

- `entAdminBookings` searches by reference, buyer, provider or source.
- `entAdminBookingTrace` returns: the envelope · source status · payment · settlement / commission / payout · conversation
  **metadata** (participants, message count — not content) · PIN state + wrong-PIN count · audit.
- `entAdminBookingConversation` is **super admin only**, needs a stated reason, and is audited (`ent_conversation_read`).
  Ordinary admins never see message content.

## 8. Rules

- `entBookings`: the two parties + admin read.
- `entBookingSecrets`: the buyer only.
- `entBookingRefs` / `entBookingPinAttempts` / `entBookingAudit`: server-only (admin read where useful).
- `venueSettlements`: the owner + admin.
- `venueRefundRequests`: the requester + admin.
- `bookings`: a client may only cancel their own booking, or edit the provider note; lifecycle moves go through the
  callables.
- `conversations`: `ent_booking_*` cannot be created by a client.

### Separate finding: `isActive()` denies tokens without a `deactivated` claim

This was found while proving the rules suite, and it is **NOT fixed here** because it is cross-system.

- Under the emulator, `isActive()` reads `request.auth.token.deactivated`, `.admin` and `.superAdmin`. On a token that has
  none of those claims, every operand errors, so the function errors and the request is **denied**.
- The result is that every `isActive()`-gated client write is denied for ordinary users; `conversations` create is one
  example.
- The booking-conversation denial had been passing for that reason. The suite now uses an actor whose `isActive()` is
  true, and a positive control proves that the reserved-id clause is what decides.
- Whether production behaves the same way is **unverified**. It needs its own rules slice.

## 9. Not in this slice

This slice does not include the Premium Booklet (Slice B) or the category sidebars (Slice C).

The availability / calendar layer, rate cards, enquiries and messaging controls are covered in
[[ENTERTAINMENT_AVAILABILITY]].

Deploying needs the new triggers (`entBookingOn*`, `venueOnBookingPayment`) and the
schedule (`venuePaymentSweep`). A composite index is likely needed for `entBookings` (`buyerUid` / `providerUid`).
