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

## Quote requests on the one lead authority + the owner's fee model (2026-10-03)

Branch `hosting/home-services-leads-on-a7a00e7`: my `9b48b06` merged with sokoni-b2's `hosting/techhub-on-chain` @ `a7a00e7` (merge `56c173d`, resolved per hunk). That merge puts b2's lead authority in this branch's history: [[SERVICE_LEADS]], `sokoni-leads.js`, `service-requests.html`.

**home-services.html**

- **Request a Quote:** the buyer picks the service, then sees matching providers. Tapping 💬 on a provider opens `SokoniLeads.ask`, which calls `providerDispatch leadCreate`. The provider replies in SOKONI Messages and can send a quote. The buyer accepts or declines it on `service-requests.html`; an accepted quote is booked through `SokoniBookService.open({…, leadId})`, with the price taken from the quote on the server.
- **Removed:**
  - the `homeServiceQuotes` / `homeServiceRequests` writes from a second Firebase app (`hs-write`);
  - the localStorage "Quote Requests Near You" and "Ask the Hub" feeds, which only the poster's browser could see;
  - the phone-number fields;
  - the "up to 5 providers respond" promise;
  - `_hsFireWrite` itself, which had no callers left. Its `test-secondary-firebase-apps` baseline entry is gone too.
- **Not offered:** sending one request to many providers at once. The server doesn't support it, so the page tells the buyer to ask each provider instead.

**Fee model (owner, 2026-10-03; full record in [[project_home_services_monetization]]):**

- SOKONI takes **5% of the service amount, paid by the provider** and deducted at settlement. It is charged once per booking and comes from commercial configuration.
- The buyer pays the service or quote amount only.
- Leads are free: no lead, listing, registration, withdrawal or messaging fees.
- The server change belongs to sokoni-5b (booking engine, settlement, `service_booking_balance`). Its contract fields: `pricing.{providerServiceAmountKES, customerTotalKES, sokoniCommissionKES, sokoniPlatformFeeKES, commissionRate, configVersion}` and `settlement.{paymentCostsKES, providerSettlementKES, sokoniRevenueKES, settledAt}`.
- `bookings.html` shows the buyer total from `pricing.customerTotalKES`, falling back to the booking's stored price. It does no fee arithmetic.

Tests: `test-home-services-leads-static` 19/0. A mutation that adds 5% to the buyer's total fails M2 and M3. `test-secondary-firebase-apps` 9/0.

**Deferred** (free memory 340–407 MB, below the 512 MB floor): the browser suites `test-bookings-browser`, `test-home-services-hubs-browser` and `test-compact-premium-cards` on this merged branch. They are **UNPROVEN on this branch** until they've been re-run.

## Refunds, cancellation and disputes in My Bookings (owner rules, 2026-10-03)

| Booking state | Buyer action | Server authority |
|---|---|---|
| pending / requested / confirmed (not started) | **Cancel booking** | `providerDispatch providerCancelBooking`. The server applies the booking's cancellation policy and moves held money through `_disburseHeldFunds`. The page states no refund amount and waits for the server's answer. |
| provider-affected (`resolution.status = ACTION_REQUIRED`, paid_held) | **Get a full refund** | `providerDispatch customerRequestRefund` (booking resolution engine, full refund). |
| in_progress / completed | **Report a problem** | Support ticket with the booking reference: a request a person reviews. Never an automatic refund. |

**Server gaps** (5b / owner; not imitated in the UI):

- `createDispute` accepts **orders only**, because it reads `orders/{id}`. There is no service-booking dispute yet, and nothing holds settlement while a dispute is open.
- After settlement, a refund needs the canonical clawback through the ledger. That is not built for bookings.
- When a booking is fully refunded before settlement, the 5% must not be recognised as revenue. 5b's settlement must enforce this.

## Provider-side fee and commission copy (sokoni-b2, `hosting/techhub-on-chain`, NOT deployed)

- `e7e62bc`: the services editor no longer has the "Booking fee (KSh)" field (svFee), and its save payload sends no `fee`. Existing `providerServices.fee` values remain as unread data; sokoni-5b's server change ignores them.
- `cda9b03`: provider onboarding no longer shows the 20/15/10/7/5% per-plan ladder; the dashboard's legacy plan `commissionRate` is gone.
- `770466d`: both pages show the single rate from the generated snapshot (`sokoni-commission-rates.js`, from 2f's `21969e0`, services = 5), with a neutral fallback that shows no number.

**Caveat:** that snapshot still lists `"home_services": 14` and the plan ladder (flagged to 2f). Pages must use `pct('services')`, never `pct('home_services')`, until it's regenerated. The Home Services pages on this branch read no commission rate at all.
