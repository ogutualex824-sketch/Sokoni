# Hub reviews convergence: property, sports venue, BnB (2026-10-03)

**Status:** hosting tree `hosting/hub-reviews-on-72dca56`, built on live `72dca56`. **Not deployed.**
Related: [[RULES_COMBINED_CANDIDATE]] · [[HUB_REVIEW_STORES_CENSUS]] (sokoni-5b) · [[Reviews]] · [[AdminOS]]

## What was wrong (census on live 72dca56)

| Surface | Writer | Where it actually went | Result |
|---|---|---|---|
| Property listing / agent | `sokoni-property.js` `addReview` → `fsWrite` | `SokoniDB.saveApplication({...review, category:'reviews'})`, i.e. **the applications collection** | Never public, never moderated, a junk row in the applications queue. Page said "✅ Review submitted!" |
| Sports venue | `sokoni-sports.js` `addReview` → `fsWrite` | `sportsReviews` via `window.firebase` (compat SDK), **which the page never loaded** | Nothing reached the server. Page said it was posted. If it had arrived, the rule (read:true, no moderation) would have published it at once |
| BnB | `sokoni-bnb.js` `addReview` | `bnbReviews`, which has no rule (default deny) | **Dead code**: no page calls it |

All three displayed reviews from localStorage, so nobody else ever saw them. The sports venue **booking**
also never reached the server (same compat-SDK problem), and property viewings came from a localStorage
`requestViewing`.

## Owner decisions (2026-10-03)
- **Eligibility:** a property review needs a **server-recorded viewing** of that listing. A venue review
  needs a **server-recorded booking** at that venue. Both are in the reviewer's name, and every review
  goes **pending** into the one AdminOS queue.
- **Unboxing photos:** quarantine first, then publish on approval (storage rules are in the rules candidate).

## The flow now
```
property-listing.html ─► SokoniProperty.addReview ─┐
sports-venue.html     ─► SokoniSports.addReview   ─┼─► sokoni-hub-reviews.js submit()
                                                     │      └─► submitReview({targetType:'property'|'sports_venue', targetId, rating, body})
                                                     │             server: identity · eligibility · duplicate · rate limit → reviews/{uid_type_id} PENDING
                                                     └─► AdminOS queue (adminModerateReview) → approved → getReviews({targetType,targetId})
```
- The browser sends **no name, author, uid or status**. The display name comes from the server.
- **Honest UI:** "Review received — it will appear once a moderator approves it" is shown only when the
  server returned a review id with status `pending`. Refusals stay on screen with their reason: not
  signed in, not eligible, already reviewed, rate limited, unavailable. A failed read shows "Reviews
  unavailable", never "No reviews yet". Every review field is HTML-escaped.
- **Viewing** (`SokoniProperty.scheduleServerViewing`): `servicesDispatch` op `scheduleViewing` →
  `propertyViewings/{listing_uid_date}`. The local copy for the existing dashboards is written only after
  the server returns a viewing id. The paid viewing in `property-hub.html` is untouched (money path, own slice).
- **Venue booking** (`SokoniSports.recordServerVenueBooking`): a `setDoc` to `sportsVenueBookings/{id}` with
  the signed-in uid (existing rule: `claimsOwner` + required keys). No payment is taken. The copy now says
  "Booking request recorded", not "Venue booked".
- **Agent reviews:** not available. There is no eligibility authority for agents, and the seed rating and
  review count are no longer shown as real figures.
- **BnB:** `addReview` refuses honestly. BnB reviews wait for a server-recorded stay.

## Release order (mandatory)
1. Functions (sokoni-5b): `submitReview` with `property` + `sports_venue` + the eligibility adapters
   (`propertyViewings.buyerUid`, `sportsVenueBookings.uid`, a cancelled booking does not count); `getReviews`
   with `targetType` and `authorName`; `submitUnboxing`; the photo copy on approve. The **live**
   `submitReview` (09-09) accepts neither type, so until this ships these pages show "unavailable".
2. adminOsDispatch review queue (sokoni-5b `3684b64`).
3. Hosting: this tree **and** `307b84e` (unboxing page). Re-based on whatever is live at the time.
4. Storage rules (quarantine), then Firestore rules **last** (`rules/capability-decisions-on-f20be7d`).
5. Live browser proof for each surface, plus a direct-write attempt that must be denied.

## Tests
- `scripts/test-hub-review-clients.js`: 31/0, sabotage 7/7.
- Related suites identical to live 72dca56: apps-render 25/0, home-logo-routing 31/0, role-switch 50/0,
  seller-application 57/0, agreement-acknowledge 21/0, merchant-entry.
- **Not run:** browser and live checks (nothing is deployed), and the emulator rules suites (RAM).

## Open, not in this slice
Other self-publishing review stores found by sokoni-5b: `entReviews`, `homeServiceReviews`, `legalReviews`,
`digitalReviews`, `constructReviews`. The `viewings` category written into `applications` by the legacy
`requestViewing`. The paid viewing in `property-hub.html`.
