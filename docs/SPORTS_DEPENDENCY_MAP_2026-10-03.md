# Sports: dependency and edit map (2026-10-03)

Owner 2026-10-03 gave the whole Sports vertical to **2f**. Nothing in this map has been built in shared infrastructure yet. Every shared edit below waits for the named owner's agreement.

Related: [[COMMERCIAL_CONVERGENCE_2026-09-30]] · [[TRANSACTION_RECEIPTS_2026-10-03]] · [[Marketplace]]

## Owner decisions (2026-10-03)

- **Commission:** venue bookings 5%, coaching 5%, tournament entry 5%. Explicit rows (`sports_venue_bookings`, `sports_coaching`, `sports_tournament_entry`), done at commercial-fn `6163a27` / `93ee71f`.
- **Builder:** 2f builds Sports.
- **Contract (relayed by sokoni-b2):** reuse existing primitives. No Sports receipts, wallets, checkout, booking engine, catalogue or dashboard.
- **Venues:** sports venues use the **existing general VENUE engine** (`venue-booking.js`, `venues`, type `sports_court` / `gym` / `swimming_pool` / `indoor_arena`), **not** the provider booking engine.
- **Coaches:** use the provider booking engine (`providerBookings`).

## Census: what exists today

**Hosting pages** (`sports-hub.html`, `sports-tournament.html`, `sports-venue.html`, plus `sokoni-sports.js`):
- **Fabricated data:** hard-coded seed data (8 teams with records, 7 named players with phones, 8 "verified" coaches, 8 "verified" venues with ratings, 6 tournaments with prize pools, fixtures, standings, marketplace items, posts).
- **Fake actions:** "book coach / book venue / register / order" generate client refs and toast success with **no payment and no server**.
- **Browser writes:** writes go straight to Firestore (`teams`, `sportsPlayers` …) and mostly fail the rules (field mismatches).
- **Dead code:** `sports-hub.js` is dead.
- **Old admin page:** the legacy `admin.html` Sports tab runs on localStorage only.

**Server side:** **none.** There is no `functions/sports*.js` and no team, tournament, fixture or standings logic.

**Rules (combined candidate):** `teams`, `tournaments`, `sportsPlayers`, `sportsCoaches`, `sportsVenues`, `sportsVenueBookings`, `sportsCoachBookings`, `sportsTournamentRegs`, `sportsReviews` (server-only already), `sportsPosts` and `sportsOrders` are mostly **owner-writable from the browser**.

## The map

| Concern | Existing system REUSED | Sports change | Files / branch | Owner, status |
|---|---|---|---|---|
| **Commission** | commission-config + finos-utils engine | explicit sports rows (done) | commercial-fn `6163a27`, `93ee71f` | 2f, done |
| **Venue booking** | venue engine: `venue-booking.js` (VENUE_TYPES incl. sports types), `booking.js` `purpose:'venue_booking'`, `venue-payments.js`, `venue-manager.html` / `venue-booking.html` | (a) a venue whose type is a SPORTS type is priced `sports_venue_bookings` (today `venue-payments.js:124` books every venue as `entertainment_bookings`; same 5%, but the explicit row and attribution must be right). (b) **Receipts:** the venue path must call `transaction-receipts` (`recordPaid` at verified payment, `released` / `refunded` events). b2's hooks cover providerBookings only. (c) `sports-venue.html` stops faking and deep-links into the real venue booking. | functions `venue-payments.js`, `booking.js` (purpose `venue_booking`); hosting `sports-venue.html` | **OWNER OF venue-booking.js / venue-payments.js: UNRESOLVED.** Stop here until named. |
| **Venue onboarding** | applications → `applicationDecide` (AdminOS queue) → `projectProvider` / venue projection; `hub-register.js` hub `sports` (sports-venue …) | sports venue = a venue application, type a sports type; AdminOS approves; nothing Sports-specific | functions `application-lifecycle.js` (only if the venue projection lacks the sports types) | application-lifecycle owner, to confirm |
| **Coach** | provider architecture (Electrical / Legal pattern): application → `projectProvider` → `provider-hub` classification → `bookingCreateService` → `providerBookings` → IntaSend → hold → PIN → settle → receipt (b2's hooks automatic) | (a) `provider-hub.commissionArgsForHub` returns `sports_coaching` for a coach (no subscriptionRole). (b) the capability engine's FROM_BUSINESS_ID gains `coach` → sports/specialities. (c) the coach is a section of the SHARED provider dashboard | functions `provider-hub.js` (commercial-fn, 2f); `service-capabilities.js` (capability line, b2); hosting `provider-dashboard.html` on `hosting/legal-hub-on-38d2d60 @ a51215b` (hunks to b2 first) | 2f + b2 |
| **Receipts / payments / wallet** | `transaction-receipts.js`, IntaSend webhook (5b lineage), business wallet / settlement | none for coaches (automatic). Venue: see the venue row. Tournament entry: purpose `sports_tournament_entry` attributed to the organiser and held, then `recordPaid` | functions `payment-purposes.js` (new purpose), webhook hook (5b lineage), `PLATFORM_PURPOSES` only for SOKONI's share | 2f (purpose) + 5b (webhook) |
| **Messaging** | `messages.js` `TX_COLLECTIONS` / `PARTY_FIELDS` / `SERVER_ANCHORED`; service_booking for coach / venue chats | new tx types `sports_team` (team ↔ players), `sports_tournament` (organiser ↔ registered teams). Participants are derived server-side from `sportsTeamMembers` / `sportsTournamentRegs`. Full contract goes to b2 BEFORE build | functions `messages.js` (b2 adds them, as for rfq / job_application) | b2 |
| **Notifications / SMS** | `notify.js` (`dedupeKey`, `logRef.create` idempotency), `sms-service.js` `enqueue` | fixture events call `notify({dedupeKey: 'fixture_'+id+'_'+event})`; reminders use a scheduled job with keys `remind_24h_` / `3h_` | functions `sports.js` (new, consumes only) | 2f |
| **Marketplace** | the canonical catalogue (`sokoni-product-taxonomy.js` category `sports`, cart, checkout, orders, seller wallet) | Sports Marketplace = a **filtered view** (category `sports`). `sokoniOrders` / `sportsOrders` fake orders are removed | hosting `sports-hub.html` | 2f (hosting) |
| **Merchant-v2 shell** | `sokoni-merchant-routes.js` (declared routes, MORE_GROUPS partition, `validate()`) | `sports-*` routes + ONE MORE_GROUPS 'sports' entry appended AFTER Jobs; role-aware via the capability MODULES (5b), never the browser category | hosting `hosting/chain-on-3e8dd53 @ e81d80a` (e3 chain) | 2f, routes; e3 merges Jobs first; 5b, MODULES key |
| **AdminOS** | `admin-os.html` / `sokoni-aos.js` application queue (`applicationList` / `applicationDecide`) | Sports applications (team / tournament) reach the queue; a Sports section (teams, tournaments, registrations, fixtures, results) as a self-loading module (like `d38a79a`) | hosting `sokoni-aos-sports.js` (new) + 3 lines in `admin-os.html` | 2f |
| **Subscriptions** | `sub-billing` PLANS + `subscription-catalog.requireFeature` | hubTypes `sports_team` / `sports_venue` / `sports_coach` / `sports_tournament`: free plan; paid tiers OFF until priced | functions `sub-billing.js` (commercial-fn) | 2f; prices come from the owner |
| **Rules** | combined candidate (f3) | REPLACE each Sports block with server-only as its server writer lands (`sportsVenueBookings` stays browser-created per owner b6f9cee). New collections `sportsTeamMembers`, `sportsFixtures`, `sportsResults` are server-only | `firestore.rules` on f3's candidate | f3 |

## Genuinely new (2f builds; no shared owner)

`functions/sports.js` (commercial-fn), one dispatch callable:

- **Teams:** register (draft → submitted), the AdminOS decision through the application queue, captain/manager roles granted **by the team**, invitations, accept/remove, and history. Collection `teams`, server-written.
- **Memberships:** `sportsTeamMembers/{teamId}_{uid}`, written with `create()`. One membership per team and player; no duplicate membership.
- **Tournaments:** draft → submitted → under_review → approved → registration_open → registration_closed → fixtures_published → in_progress → completed → archived. Only the server moves a tournament between states (owner or admin by role).
- **Registrations:** an approved team plus an eligible tournament plus an open window, checked for capacity and duplicates. pending → approved → registered / withdrawn / rejected.
- **Fixtures:** ONE `sportsFixtures/{id}` record read by every view, with an audit history.
- **Results:** submitted → confirmed → disputed → resolved. Standings are recalculated on the server.

## Release

- **Functions first.** Then rules replace-blocks (f3), then hosting (Sports pages converted off the seed data, the merchant-v2 Sports group, AdminOS Sports).
- **Fail closed:** any incomplete commercial capability stays OFF.
- **Certification:** at least 512 MB free, emulator, browser.
