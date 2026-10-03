# Hub Review Stores — Census

**Date:** 2026-10-03 · **Author lane:** sokoni-5b (trust / reviews) · **Tree:** live hosting `72dca56` + rules source in that tree
**Status:** CENSUS ONLY — nothing changed, nothing deployed. **Not CLOSED:** the emulator proof
(`scripts/test-hub-review-rules.js`) is written but **not-attempted** (memory below the 512 MB floor at census time).
Every outcome below is **read from source**, not yet observed.

Related: [[Reviews]] · [[Moderation]] · [[AdminOS]] · [[Community Trust]] · `functions/reviews.js` (canonical
`submitReview`) · `functions/shared/review-moderation.js` (the one transition module)

## Why this exists

The marketplace review path is now canonical: `submitReview` checks for a paid, delivered order and creates a
**pending** review, and AdminOS approves it. The hubs each kept their own review store. This census records, for
each one, who writes it, what the rules do with that exact payload, and what the user is told.

## Findings

| Hub | Store | Writer (source) | Rule outcome for the real payload | User is told | Class |
|---|---|---|---|---|---|
| Marketplace | `reviews` | `submitReview` CF | CF-only after rules `6daba96` | "awaiting approval" | **CANONICAL** |
| Booking / providers | `providerReviews` | `booking-service.js` CF (one per booking) | CF-only (`write: false`) | — | **KEEP AS DOMAIN-SPECIFIC**: published at once; moderation open |
| Entertainment content | `entertainmentReviews` | `rateEntertainmentContent` CF | CF-only | — | **KEEP AS DOMAIN-SPECIFIC**: no purchase check, no moderation |
| Entertainment (artist/venue/event) | `entReviews` | `entertainment-hub.js` `submitReview` (browser `addDoc`) | **REFUSED**: payload carries `approved: true`, which `noAdminFields()` forbids | — | **LOST**. Without the flag it would be **SELF-PUB**. The client also recomputes the target's rating itself. |
| Home services | `homeServiceReviews` | `home-services.html` `_hsFireWrite` | **REFUSED**: payload has no `uid`, which the rule requires (error swallowed) | "✅ Thank you for your review!" | **LOST** |
| Legal | `legalConsultations.rating` / `legalReviews` | `rateLegalProvider` CF (completed consultation, own, once) / browser fallback | CF path is sound. The fallback payload has no `lawyerId`, so it is **REFUSED** | "Thank you for your review! ⭐" | CF = **KEEP AS DOMAIN-SPECIFIC**; fallback = **LOST** (remove it) |
| Health | `healthAppointments.rating` / `healthReviews` | `rateHealthProvider` CF / `sokoni-health.js saveReview` (browser) | CF path is sound. `saveReview` is **ACCEPTED** with any `providerId` | — | CF = **KEEP**; browser path = **SELF-PUB, dormant**: no page calls it, rule still open |
| Construction | `constructReviews` | `sokoni-construct.js saveReview` (browser) | **ACCEPTED** with any `providerId` | — | **SELF-PUB, dormant** (no page caller found) |
| Digital / freelance | `digitalReviews` | `digital.html submitFlReview` (browser `addDoc`) | **ACCEPTED** for any `contractId` / `sellerUid` | "⭐ Thank you for your review!" | **SELF-PUB, live**. Also indexed to Typesense `sokoni_reviews`. |
| Sports | `sportsReviews` | `sokoni-sports.js addReview` → `fsWrite` | Client throws on `.doc(undefined)` (no `id`). With an id it is still **REFUSED** (no `uid`) | — (sports-venue.html) | **LOST** |
| BnB | `bnbReviews` | `sokoni-bnb.js addReview` → `fsWrite` | Client throws (no `id`), and **no rule block exists**, so default deny | — (no page calls it) | **DEAD CODE**: would be LOST if wired |
| Property | `applications` (!) | `sokoni-property.js addReview` → `SokoniDB.saveApplication({...review, category:'reviews'})` | **ACCEPTED** as an application document | "✅ Review submitted!" | **MISFILED**: lands in the admin application store and is never published |
| B2B supplier | `localStorage` | `b2b-supplier.html` → `B.saveRating` | no server write | "✅ Review submitted! Thank you." | device-only (B2B is localStorage-only by design, see the v2 surface audit) |

Correction to a peer note: bnb, property and sports do **not** write `reviews`. Each hub's `fsWrite` maps the
key to its own store (or to `applications`).

## Classification → next slice (not started)

1. **MIGRATE to `submitReview`, which needs target types beyond product | seller:**
   - `entReviews` (artist / venue / event: no order exists, so eligibility needs a booking or ticket authority);
   - `homeServiceReviews` (eligibility = completed booking → this is really `providerReviews`);
   - `digitalReviews` (eligibility = completed contract);
   - `sportsReviews`, `bnbReviews`, property (eligibility = completed booking / stay / viewing).

   Each needs its own **eligibility authority** in the server. A review with no completed transaction behind it
   stays refused. No hub gets a client-trusted target type.
2. **KEEP AS DOMAIN-SPECIFIC, then add moderation:**
   - `providerReviews` (one per completed booking; already CF-only) should be published as `pending`, use
     `review-moderation.js`, and be approved in the same AdminOS queue (a new `kind`);
   - `rateHealthProvider` / `rateLegalProvider` should do the same for their `review` text.
3. **Close dormant client paths** (`healthReviews` / `constructReviews` browser create): set rules to CF-only once
   step 1 or 2 owns them. This is the rules owner's lane (sokoni-f3), after their writers move.
4. **Remove dishonest copy now** (hosting-only, no backend dependency): pages that say "submitted / thank you" for
   a write that is refused or misfiled should say what actually happened.

## Ownership split (agreed with sokoni-f3, 2026-10-03)

- **sokoni-5b (this lane):** `submitReview` gets the target types `property` and `sports_venue` plus their
  eligibility adapters, in the same `reviews` collection, moderation module and AdminOS queue. **Blocked on an
  owner decision:** neither hub has a "completed" state today. `propertyViewings` only ever reaches
  `requested`, and live pages don't use it. `sportsVenueBookings` is browser-created and admin-updated. So
  there is nothing to prove eligibility against yet.
- **sokoni-f3:**
  - client switches (property-listing / property-agent / sports-venue → `submitReview`, with honest success
    and failure messages);
  - removing the dead BnB writer;
  - rules: `sportsReviews` / `bnbReviews` closed to browser create, and no review rows in `applications`;
  - the `unboxing/{uid}/{file}` storage rule;
  - the emulator run.

## Release constraints

- No rule tightening for a hub before its writer moves, or a LOST hub stays lost and a SELF-PUB hub becomes LOST.
- Ratings aggregates (`entArtists.rating`, `healthProviders.rating`, `constructProviders.rating`) are currently
  recomputed by the browser. They must come from approved reviews only, server-side (UI data integrity rule).

## Evidence state

| Row | State |
|---|---|
| Source reading (every writer + rule block quoted above) | observed |
| Emulator proof `scripts/test-hub-review-rules.js` (12 rows: E-1/2, H-1, L-1, D-1, HC-1, C-1, S-1, B-1, P-1, X-1/2) | **not-attempted**: free RAM 413 MB < 512 MB floor |
| Same proof against the candidate rules `6daba96` (`RULES_FILE=`) | not-attempted |
| Production data (how many LOST / SELF-PUB docs exist live) | not-attempted: production reads are not authorised in this lane |
