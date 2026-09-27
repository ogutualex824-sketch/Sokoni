# Entertainment Availability, Messaging Controls, Enquiries and Rate Cards

Related: [[ENTERTAINMENT_BOOKINGS]] · [[ENTERTAINMENT_READINESS]] · [[SOKONI_CONNECT]] · [[Payments]] · [[Marketing]] · [[PROVIDER_REPUTATION]]

Branch `feat/creator-hub` · 2026-09-27. **Not deployed.** Provider calls: 0. Production writes: 0. KRA: **deferred / unproven**.

## Core principle

Every bookable Entertainment provider goes through the same chain:

```
AVAILABILITY → CALENDAR → BOOKABLE SLOT → BOOKING → PAYMENT → SLOT LOCK → BOOKING PIN → MESSAGES → REFUND → SETTLEMENT
```

- **One** availability authority serves every provider. A calendar is a **key**, and a category changes only its
  configuration. There is no separate calendar per artist, venue or service.
- The calendar is **not** the payment authority. Viewing a slot never reserves it.
- A slot closes only through a reservation that the booking engine makes **inside its own transaction**. It reopens only
  when the booking reaches its **canonical terminal state**.
- The public sees only safe states. The provider's private logic stays private.

| Calendar key | Engine (unchanged authority) | Configuration read from |
|---|---|---|
| `svc_<providerUid>` | `booking-service.js` → `providerBookings` (artists, entertainment services, all providers) | `providerAvailability/{uid}`, via the one normalizer `availability.normalizeAvailabilityConfig` |
| `ven_<venueId>` | `booking.js` → `bookings` (venue core) | `venues/{id}` |

Events are **not** forced into appointment slots. They keep ticket inventory, ticket number, ticket PIN ("PIN YAKO NI
TICKET YAKO"), SOKONI QR and admission. Creator content (film access) needs no calendar. There is no creator
consultation / appearance product today, so a creator who takes bookings does so as an approved provider on the
`svc_` calendar.

## 1. The authority — `functions/ent-availability.js` + `functions/shared/ent-availability-core.js`

### What it stores

| Collection | Who reads | Holds |
|---|---|---|
| `entAvailability/{calKey}/months/{YYYY-MM}` | server + admin | occupancy items `{ id, k, s, e, bb, ba, u, svc, ref, label, until }`, where `k` = **B** booking · **H** hold · **X** block · **C** cooldown |
| `entAvailabilityPublic/{calKey}` and `/{calKey}_{YYYY-MM}` | **anyone** | a **counter** (`rev`) and nothing else — the realtime signal |
| `entAvailabilityAudit` | admin | every configuration change, block, open and intervention |

An item is stored in every month its **buffered** interval touches. Any candidate whose buffered interval could touch an
item therefore reads at least one document that holds it.

### Reservation (in the engine's transaction; every read before any write)

```js
const plan = await AV.planReservation({ cal, service, startMs, endMs, itemId, ref });  // outside: gates + validation
await db.runTransaction(async (txn) => {
  /* engine reads … */
  const st = await AV.readPlan(txn, plan);                  // month docs
  const r  = AV.claim(txn, plan, st, { kind: 'H' });        // decide + stage writes
});
```

- A booking stores `availability: { calKey, itemId, months }`.
- Later transitions find their item without a query:
  - `setKind` promotes H → B when the payment is **authoritatively** confirmed (the webhook / entitlement activation).
  - `release` runs on the canonical cancel / decline / expiry / executed refund.
  - `move` runs on reschedule.

### Decisions (pure; unit-tested)

- **Overlap:**
  - A candidate conflicts when its raw interval runs into an item's buffered interval, or its buffered interval runs
    into an item's raw interval.
  - Two buffers may meet each other; a buffer may never run into a booking.
  - Example: a booking 14:00–16:00 with a 30-minute buffer closes 13:30–16:30 for a 30-minute-buffered service.
- **Capacity** (Premium): more than one booking at a time turns the state into LIMITED.
- **Horizon:** past the horizon is `BOOKING_NOT_OPEN`, which is a different state from `UNAVAILABLE`.
- **Public states:** only `AVAILABLE · LIMITED · BOOKED · UNAVAILABLE · BOOKING_NOT_OPEN · TEMPORARILY_HELD`. Buffers,
  travel, blocks, closed hours, notice and private commitments all become `UNAVAILABLE`.
- **Public slot object:** exactly `{ start, end, state }`.

### Lifecycle

| Event | Slot |
|---|---|
| Customer reserves (payable) | **TEMPORARILY_HELD** (hold, 5 min for services / 30 min for venues) |
| Payment confirmed by the payment authority | **BOOKED** |
| Payment fails (webhook terminal answer) | **AVAILABLE** |
| Payment **in flight** (STK sent, no terminal answer) | stays held — neither the customer closing the sheet nor the expiry timer reopens it (`paymentInFlight`); the booking is flagged `paymentAmbiguousSince` |
| Canonical cancel / decline / reject / executed refund | **AVAILABLE** (or **UNAVAILABLE** under the calendar's cooldown policy) |
| Refund **requested** | unchanged (the refund may still be rejected) |
| Reschedule | the new time is claimed and the old one opens **in one commit**; a refused move changes nothing |

### Gates

- **Verification:**
  - An Entertainment provider (ARTIST / SERVICE) needs a **decided** application (`provider-hub.resolveProviderClassification`).
  - An account that presents as entertainment without one is `NOT_VERIFIED`: every public day shows UNAVAILABLE, and it
    can neither be booked nor enquired with.
  - A venue needs `status: 'active'`, which only AdminOS can set.
  - **`bookingSaveVenue` used to accept `status` from the owner** (`data.status || 'active'`), which allowed
    self-publishing and un-suspending. A new venue now starts `pending`, and an edit never changes the status.
- **Suspension:** a suspended provider takes no public bookings.
- **Premium / Equipped** (`subscription-core`: the `advanced_availability` feature or a policy tier) is required for:
  - capacity above 1;
  - different before / after buffers;
  - a horizon above the category's base;
  - per-service availability;
  - utilisation / hours / repeat-customer statistics.

  This is enforced **at use**: a setting written directly without the plan is ignored, and the callable refuses it with
  `PLAN_REQUIRED`.
- **Category policy** (`platformConfig/entAvailabilityPolicy`, super admin; code fallbacks apply only while the document
  is absent): `requiresVerification`, `maxHorizonDays`, `baseMaxHorizonDays`.

### Calls (bookingDispatch)

**Public (no sign-in needed, safe fields only):**
- `entAvailMonth`: day states.
- `entAvailDay`: slots.
- `entAvailSummary`: `BOOKINGS_OPEN · LIMITED · FULLY_BOOKED · NOT_BOOKABLE` plus the next open date, for marketplace cards
  and marketing.
- `entServicesPublic`.

**Owner:**
- `entAvailProviderMonth` / `Day`.
- `entAvailBlock` / `Unblock`.
- `entAvailGetConfig` / `SetConfig`.
- `entAvailSetServiceAvailability`.
- `entAvailStats`.

**AdminOS:**
- `entAdminAvailability`: states, times and booking references. Labels are shown to a super admin only.
- `entAdminAvailabilityIntervene`: super admin plus a reason — block, unblock, or `release_orphan`, which only removes an
  item whose booking is missing or terminal.
- `entAdminAvailabilityPolicy`.

### Retired (they could double-book)

- `reserveSlot` / `releaseSlot`: confirmed booking with no payment, in a store nothing read.
- `venueCreateBooking`: its overlap query matched nothing, and there was no lock.
- `bookingHoldSlot`: any user could hold any venue's time.

`getAvailabilitySlots` and `bookingGetAvailability` now answer from the authority. They previously wrote configuration
on a public read, and returned private reasons.

## 2. Messaging controls and enquiries — `functions/ent-enquiries.js`

**Public enquiry first, private conversation after a real relationship.** The conversation is always the canonical
`conversations/{id}`, so no second messaging system exists.

| | PUBLIC enquiry | PRIVATE booking |
|---|---|---|
| Conversation | `ent_enquiry_{id}`, created by the server on send | `ent_booking_{envId}`, created by the server for the booking |
| Controls | who-can-message, business hours, blocks, rate limits, duplicate suppression, closing | **none can close it** — a buyer with a booking, payment, refund or support case keeps it |
| Calls | REQUEST CALL → provider accepts / declines / schedules | Connect `booking` call surface (added 2026-09-27) |

- **Settings** (`entMessagingSettings/{uid}`, owner through a callable):
  - who can message: ANYONE / VERIFIED / PURCHASED / ACTIVE_BOOKING / ENQUIRY (customers who have enquired before) /
    NOBODY. "Followers" is not offered yet. Since CHANGELOG 209, follows are account-based ([[PROVIDER_REPUTATION]]), so it can be added later.
  - enquiry types;
  - call requests;
  - business hours;
  - accept outside hours;
  - response time (informational — **never** an "online" claim);
  - public info (description, location, policies, requirements, notice, pricing-from, FAQs);
  - quick responses. **A quick response may not claim that a payment, booking or refund is complete.**
- **Anti-spam** (server): 10 enquiries per user per day · 3 open per user and provider · a 2-minute cooldown per pair ·
  duplicate suppression for 24 h · 300 per provider per day · 30 messages per hour per enquiry conversation · the same
  message refused within 60 s. Every refusal is an explicit error; no message is silently dropped.
- **States** (server only): OPEN → ACKNOWLEDGED → RESPONDED → PROPOSAL_SENT → BOOKING_PENDING → CONVERTED · CLOSED ·
  EXPIRED (14 days, swept by the existing 1-minute job) · BLOCKED.
- **Blocks:** a provider may block a user from **public** enquiries. A buyer may report or block a provider
  (`moderationQueue`). The booking conversation is never affected.
- **System events** in the booking conversation (derived from state, never provider-authored): BOOKING CONFIRMED ·
  PAYMENT CONFIRMED · PIN ISSUED · UPCOMING (24 h, from the 30-minute reminder job) · COMPLETED · REFUND REQUESTED /
  UNDER REVIEW / APPROVED / PROCESSING / COMPLETED / DECLINED / OUTCOME UNKNOWN.
- **Inbox:** `messages.html` gains Enquiries · Bookings · Refunds · Payments tabs (tagged on each party's inbox row).
- **Conversation card:** `chat.html` shows provider, reference, status, date, service, payment and the PIN (**buyer
  only**), with the buttons VIEW BOOKING · MESSAGE · CALL (Connect, where the surface and authority allow) · REFUND.

## 3. Rate cards, quotes and discounts — `functions/ent-rate-cards.js`

- **Versions:**
  - `entRateCards/{id}/versions/{n}` are **immutable**. A price change is a new version.
  - A booking stores `rateCardId · rateCardVersion · price · currency · pricingAuthority`, and it is **never re-priced**.
- **Visibility:**
  - PUBLIC shows the price.
  - ENQUIRY_ONLY shows "Request a quote".
  - BOOKING_ONLY shows the price at checkout only.
  - PRIVATE, and any segment other than PUBLIC (MEMBER / CORPORATE / EVENT / PACKAGE / SEASONAL / PROMOTIONAL), is shown
    and bookable only for a buyer the **server** finds eligible (`entRateCardEligibility`, granted by the owner).
- **Quotes:**
  - enquiry → `entQuoteCreate` → the buyer accepts (**not a payment**) → reserve + pay at the quoted price, date and time →
    CONVERTED on the confirmed payment.
  - A live booking locks the quote.
- **Discounts** are stored in the **Marketing** authority's store (`mktCouponCodes`, scope `ent_booking`), with campaign,
  window, services, usage limit, percent / fixed value and a maximum. The discount is redeemed **inside** the booking
  transaction (`mktCouponRedemptions`, create-once). A browser "discount" is never an input.
- **Checkout** (`entCheckoutQuote`):
  - It shows service, date, time, rate card, base price, discount, final price, payment method and refund policy, plus
    the slot's current state.
  - CONFIRM & PAY sends `expectedTotalCents`.
    - If the authoritative total moved, the answer is **"Price changed."** and nothing is reserved.
    - If the time was taken, the answer is **"That time was just booked."**

## 4. Surfaces

| Surface | File |
|---|---|
| Calendar (month / year, bounded navigation, realtime, provider mode with blocks) | `sokoni-ent-calendar.js` |
| Storefront actions and checkout | `sokoni-ent-storefront.js` (`provider-profile.html`, `venue-booking.html` › Questions & rates) |
| Provider workspace: Calendar · Availability · Booked hours · Rate cards · Enquiries · Calls · Message settings · Marketing | `sokoni-ent-workspace.js` (`provider-dashboard.html` sidebar, `venue-manager.html` tabs) |
| Marketplace badges ("Available · 12 Oct", "Limited slots", "Fully booked") | `SokoniEntCalendar.badges()` on `services.html` and `venue-booking.html` |
| Buyer: My enquiries & quotes | `entertainment.html` › My bookings |
| Conversation card, inbox tabs | `sokoni-ent-conversation.js` → `chat.html`; `messages.html` |
| AdminOS › Entertainment › Bookings · Availability · Communications · Rate cards | `sokoni-aos-entertainment.js` |

## 5. Rules (firestore.rules)

- The occupancy is server-only, and even the owner cannot read or write it directly.
- The public availability counter is readable by anyone.
- Rate cards: the owner and admins; versions are immutable.
- Quotes, enquiries and call requests: the parties read; writes are server-only.
- Messaging settings: the owner reads; writes are server-only.
- The `ent_enquiry_*` conversation ids and type are reserved.
- Tightened:
  - `bookingHolds` create (was: any hold, any expiry);
  - `venueBlockouts` read / create (reasons and notes were readable by any signed-in user);
  - `providerCalendar` read (it carried customer names);
  - `availabilityStatus` write (an owner could spoof it);
  - `mktCouponCodes` read (every user could list every code);
  - `bookings`: a client may not create a venue reservation, or cancel a venue booking directly (property viewing
    requests are unchanged).

## 6. Known limits (not claimed as green)

- **Calls.** No TURN / STUN relay is provisioned, so a Connect call is **UNPROVEN** end to end.
  - The public call request (request / accept / schedule, with an authorised window) is built.
  - The **voice leg for a public enquiry** needs a Connect relationship that the frozen authority does not have
    (enquiries are chat-capped). That is an owner decision, and it is not made here.
- **Travel pricing** still uses the distance the buyer declares (`service-pricing`, unchanged by this slice). A buyer who
  under-declares pays less travel. No distance oracle exists, so this is a **known pricing limitation**, not a fixed
  control.
- **Existing live bookings** created before this slice carry no availability item.
  - The engines keep their previous slot-lock and prefetch overlap guards, so they still block identical and overlapping
    windows.
  - A backfill (a dry-run script, deliberate and run once) is a deploy step.
  - Venue bookings created before this slice used the server's UTC day, while new ones use Africa/Nairobi.
- **Venue waitlist offers** (`bookingHolds`) no longer block other buyers. An offer is a notification plus the offered
  buyer's head start, not a reservation.
- **Deploy:**
  - new ops ride the existing `bookingDispatch` and `adminOsDispatch`;
  - no new Cloud Function or schedule (enquiry expiry and reminders run in the existing jobs);
  - rules must be deployed together with the functions.
  - Re-read the CLAUDE.md Artifact Registry notice first.
