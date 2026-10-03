# Home Services — My Bookings (buyer surface)

Status: **built, NOT deployed** (2026-10-03, branch `hosting/home-services-on-rel`, from `release/hosting-dhub-2026-10-03` @ `f799841`).
Related: [[BOOKING_PAYMENT_CONTRACT]] · [[BOOKING_LIFECYCLE_CONTRACT]] · [[BOOKING_CONVERGENCE]] · [[Payments]] · [[Messaging]]

## Owner decisions (2026-10-03)

- A service booking is **not an order**. Its buyer-protection PIN is in **My Bookings**, not My Orders.
- The booking PIN can be **viewed again** in My Bookings until the booking completes. You must be signed in. It is never shown only once.
- Pay-after-service: the **provider proposes** the final amount. The **buyer accepts** it in Bookings, then pays through IntaSend.
- No WhatsApp booking. Messaging stays in the app.

## What the page does — `bookings.html`

| Area | Authority | Behaviour |
|---|---|---|
| List | `providerBookings` where `customerUid == uid`, limit 100 | Same predicate as the read rule. Sorted on the client, so no composite index is needed. |
| Groups | client grouping of server `status` | Upcoming · In progress · Completed · Cancelled (declined / no_show / expired). |
| Amounts | booking `price` / `deposit` (integer cents) | Shown exactly as stored; an unknown value shows `—`. |
| Payment | booking `paymentStatus` | `pending` → not paid, plus the hold window · `paid_held` → held by SOKONI until the PIN · `settled` → released · `refunded`. |
| Booking PIN | `serviceBookingPin` `{op:getMyBookingPin \| renewBookingPin, bookingId}` | Shown only for `paid_held` bookings that are not closed. Fetched only when the buyer asks. Held in memory for this page view only: never stored, never logged, and dropped on Hide or when the page goes to the background. If the callable is missing, the page says "not available yet" (never a fake PIN). Server refusals are shown as refusals. |
| Final balance | booking `balanceProposal` (written by 5b's `serviceBookingBalance`) | Shown read-only. **There is no accept or pay control** until the server side ships (5b's contract: purpose `service_booking_balance`, where the server reads the ACCEPTED amount). |
| Message | `chat.html?tx=service_booking&txId=<id>` | In-app; the server derives the parties. |
| Review | `SokoniBookService.review({bookingId})` | The one review UI and the one server gate (`bookingSubmitReview`). |
| Provider name | `providers/{id}` (public while active/approved) | A refused or missing read shows "Provider"; a name is never invented. |
| Deep link | `bookings.html?b=<id>` | Opens the right tab and highlights the booking. |

`my-bookings.html` redirects to `bookings.html`. `functions/provider-ops.js` links buyers' "Booking cancelled" notifications to `my-bookings.html`, a page that never existed, so those links returned 404 until now.

## Navigation

"📅 My Bookings" now sits next to "📦 My Orders" in:

- the shared-header drawer;
- the profile dropdown (`sokoni-profile-menu.js`);
- the profile Bookings panel, as a link card. That panel still lists venue `bookings`.

## Security

- The page makes **no browser writes**. The money state comes only from the server: the booking engine, then the webhook hold, then settlement on PIN release.
- The PIN is never written to localStorage or sessionStorage, and is never shown before the buyer asks for it.
- Every server value is escaped, and the page has XSS tests.

## Tests

`node scripts/test-bookings-browser.js`: **42/0**, with every network dependency stubbed. In a mutation check, removing the PIN gate fails 4 named rows.

## Open / depends on

- **5b**: `serviceBookingBalance` + `service_booking_balance` intent. When they ship, replace the read-only balance box with Accept/Decline + Pay.
- **b2 4L** (`95f2ef6` server, `292936f` hosting): `SokoniInbox.openForTransaction('service_booking', id)`. Once it merges, prefer it over the `chat.html` link.
- Deployment: `serviceBookingPin` must be live, from 5b's booking-PIN release, for the PIN box to work. Until then the page tells the buyer the PIN is "not available yet".

## Cleaning and Plumbing hubs — booking through the one authority (2026-10-03)

| Page | Before | After |
|---|---|---|
| `cleaning.html` | Providers already came from `SokoniProviders`. The "Book a Cleaner" form saved to localStorage, wrote `homeServiceBookings` from a second Firebase app (`cln-write`), called `SokoniPay.waConnect`, and announced "recorded" for a booking no provider saw. | 📩 opens `SokoniBookService.open({providerId, providerName})`. The generic "Book Now" shows a note telling the buyer to choose a cleaner, and opens no form. |
| `plumbing.html` | Six **hard-coded plumbers** with invented names, phones, ratings and job counts. Four invented customer reviews. An invented "Typical Nairobi rates" price guide. Invented stats ("25+ / 4.7★ / 6 Cities", "respond within 30 minutes", "same day"). Same localStorage / `plm-write` / WhatsApp booking path. Unescaped card values. | `SokoniProviders.list({category:'plumbing'})`. Cards are escaped and show rating, jobs and rate only where real. Book and message use one delegated listener over escaped `data-` attributes. The hero count comes from the registry, showing `—` until known. The invented sections are removed. |

Booking = `bookingCreateService` → `createPaymentIntent(service_booking)` → IntaSend STK → held → released by the buyer's booking PIN in [[#What the page does — `bookings.html`|My Bookings]].

Sending one request to several providers is a **quote request**. It is not built on these pages; the server authority is b2's leads slice 4F (`service_lead`, `leadCreate`, `sokoni-leads.js` on `hosting/techhub-on-chain` @ `23b20f7`). It is not in this release line yet, so the pages say "not available yet" and do not imitate it.

Tests: `test-home-services-hubs-browser` 30/0. Mutation check: removing the plumbing booking call fails K1 and K3. Retargeted suites:

- `test-compact-premium-cards` now accepts the delegated handler;
- `test-secondary-firebase-apps` no longer lists the removed `cln-write` / `plm-write` entries in its baseline.

Results match the parent commit. The failures that remain exist there too: no Playwright path in the worktree, b2's `elc-write` baseline entry, and no emulator.
