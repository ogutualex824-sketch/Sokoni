# Entertainment category matrix

**Status:** 2026-09-26, branch `feat/creator-hub`. **Implemented and certified locally. Nothing is deployed.**

**Authority:** `functions/shared/entertainment-registry.js`. It is the one list of Entertainment top-level
categories and their lifecycles. `scripts/test-entertainment-registry.js` enforces that no category is
an orphan, and that every page it names exists.

Related: [[ENTERTAINMENT_HUB]], [[CREATOR_HUB]], [[CANONICAL_MONEY_VERSION_DECISIONS]],
[[REFUND_AUTHORITY_CONVERGENCE]].

## Before this slice

There were eleven independent category lists. They used different ids for the same thing:

- `band` / `live-band`
- `photographer` / `photography`
- `concert` / `concerts`
- `movie` / `movies`

There were also three separate intake paths:

- the performer modal;
- HubRegister;
- the Creator Studio.

Beyond the ids, three problems stood out:

- **No Streaming category existed anywhere.**
- **Nothing mapped a category to a dashboard.** Every approved entertainment applicant became a generic
  `provider`.
- **The organizer role could not be granted.** event-hub's gate read a numeric `users.role >= 2` that
  nothing wrote.

## The matrix

| Category | Exists | Application | Approval | Dashboard | Payment | Refund | Communications | AdminOS | Super Admin |
|---|---|---|---|---|---|---|---|---|---|
| **Creator** (films, series, documentaries…) | yes | `creator-studio.html` → `creators/{uid}` + `creatorVerifications/{uid}` | AdminOS › Creator Hub (`creatorAdminVerificationDecision`, `creatorAdminSetState`) | `creator-studio.html` (EQUIPPED) | `film_access` — M-PESA STK; hosted methods only when proven | fos* → `onFilmRefundProcessed` (royalty reversal) | profile menu → Messages / Notifications; no in-dashboard buyer chat | Creator Hub panel | fee attestation, Creator config, payment capability, dual-control override |
| **Streaming** (series & episodic) — *new* | yes (Creator content type, owner 2026-09-26) | as Creator; choose subcategory `streaming` | as Creator (film review + verification) | `creator-studio.html` | `film_access` (30/70) | as Creator | as Creator | Creator Hub panel | as Creator |
| **Events & Ticketing** | yes | `event-manager.html` organizer intake → `applications/{id}` (type `event_organizer`) — *new* | AdminOS › Applications (`applicationDecide`) → role `event_organizer` — *new* | `event-manager.html` (PREMIUM) | `event_ticket` — M-PESA STK; hosted only when proven — *new* | fos* → `onEventRefundProcessed` (tickets + held settlement reversed) — *new* | profile menu → Messages / Notifications | Entertainment panel — *new* | fee attestation for unreported provider fees |
| **Performers & Artists** (DJ, MC, band…) | yes | `provider-onboarding.html` → `applications/{id}` (role `provider`) | AdminOS › Applications | `provider-dashboard.html` (EQUIPPED) | `service_booking` (provider rail) | provider / merchant refund authority (not owned here) | provider dashboard: contact customer; profile menu | Providers + Applications | platform role management |
| **Venues** | yes | `ent-organizer.html` → `entVenues/{id}` (**pending**) | AdminOS › Entertainment (`entAdminSetListingStatus`) — *new* | `venue-manager.html` (PREMIUM) | none — booking requests are enquiries | n/a (no payment) | booking request → owner | Entertainment panel — *new* | — |

**Invariant, checked by the suite:** no category may be offered in an application without a dashboard,
and none may have a dashboard without an application path.

**Events & Ticketing, 2026-09-27:** the event-day operations layer is documented in [[EVENTS_OPERATIONS]]:

- PIN tickets;
- temporary staff: cashier, admission, marketing, manager;
- cash and organizer-terminal card door sales, with 3 % receivables netted at release;
- the refund policy and Refund Wizard;
- versioned organizer agreements that gate approval;
- AdminOS investigation and financial trace.

## Lifecycle per category

**Creator / Streaming**

1. Register.
2. Verification: DRAFT → SUBMITTED → UNDER_REVIEW → MORE_INFORMATION_REQUIRED → APPROVED or REJECTED.
3. Creator becomes ACTIVE.
4. Film: DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED (agreement locked) → PUBLISHED.
5. Discovery: `catalog.list`, PUBLISHED titles only.
6. Checkout: `film_access` intent.
7. Payment.
8. Entitlement.
9. Signed-URL playback with watermark.
10. Analytics.
11. Royalty accrual (30 / 70 of the amount net of the provider fee).
12. Quarterly statement → wallet → withdrawal.
13. Refund: royalty reversal, and entitlement revoked on a full refund.
14. Every step is audited in `adminAudit`.

Playback is on demand. **Live broadcast is not implemented.**

**Events**

1. Organizer applies in Event Manager.
2. Admin decides in AdminOS.
3. `users.roles` gets `event_organizer`, plus the claim.
4. The approval notice links to Event Manager.
5. Organizer creates the event: draft → ticket tiers → `live`.
6. Discovery: `listEvents` / `searchEvents`, live events only.
7. `purchaseTickets` reserves seats.
8. Buyer pays: `event_ticket` intent, ref = orderId.
9. Webhook exits through the self-settling branch.
10. `eventOnTicketPayment` → entitlement engine: order paid, tickets valid, settlement HELD, commission booked.
11. QR check-in.
12. Event ends.
13. After 24 h, the settlement releases to the organizer's `wallets.balance`.
14. If the event is cancelled: `pending_refund` orders → AdminOS refund queue → fos* refund → tickets
    refunded and settlement reversed.
15. Unpaid orders expire after 45 min and release their seats.

**Performers**

1. Provider onboarding.
2. Application.
3. Admin decision.
4. Provider profile projected, searchable.
5. Provider dashboard.
6. Bookings through the provider booking rail.

**Venues**

1. Owner lists the venue (pending).
2. AdminOS approves / rejects / suspends / restores it, with a reason and audit.
3. It becomes visible in discovery only while active.
4. Booking requests reach the owner.

## Checks from the brief

| No category may… | Status |
|---|---|
| appear in an application form but have no dashboard | holds — enforced by `orphans()` + page-exists checks |
| have a dashboard but no application path | holds — Events had none before this slice |
| publish without approval | Creator: admin approval required · Events: organizer approval required, then server publish · Venues/Artists: created pending, owner cannot change status (rules) · **legacy EntHub events can no longer be client-created** |
| be approved but routed to the wrong dashboard | holds — `dashboardForRole` is deterministic, and the approval notice carries the link |
| be searchable but not manageable | holds — every searchable category has an AdminOS surface |
| accept money without a transaction identity | holds — `film_access` / `event_ticket` intents; legacy paid PPV **closed** |
| grant a role without the right permissions | organizer claim minted only by an admin decision (the live self-mint is fixed separately, hotfix `1171a16`, not yet deployed) |

## Legacy convergence (owner decision: converge onto event-hub)

- `EntHub.purchaseTicket` and `EntHub.createEvent` now refuse, and send the user to Event Hub / Event Manager.
- The rules deny client creation of `entTickets` and `entEvents`.
- Paid legacy `purchaseEntertainment` is closed.
- Production held **0** documents in every one of these collections, measured read-only on 2026-09-26.
