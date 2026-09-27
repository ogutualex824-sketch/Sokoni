# Provider Reputation — followers, ratings, reviews, sharing

**Status:** committed on `feat/creator-hub`, **not deployed**. No KRA calls. No production writes. The migration has
not been run.
**Authority:** `functions/reputation.js` (served by `bookingDispatch`; admin ops through `adminOsDispatch`).
**Covers:** providers (artists, photographers, DJs, MCs and every service provider), venues, and approved creators.
**Related:** [[ENTERTAINMENT_AVAILABILITY]] · [[ENTERTAINMENT_BOOKINGS]] · [[ENTERTAINMENT_HUB]] · [[AdminOS]] ·
[[Authentication]] · [[Notifications]]

---

## 1. Why this exists — the census

Before this slice, provider reputation had these problems:

| # | Finding | Evidence (pre-slice) | Resolution |
|---|---|---|---|
| 1 | **Split-brain provider rating.** `bookingSubmitReview` updated only the PRIVATE `providerProfiles` mirror. Public pages read `providers.rating`, which **the provider could write** (rules blocked only `status`/`verified`/`suspended`/`approved`). | `booking-service.js`, `firestore.rules` providers block | One writer (`submitReview`) updates the public aggregate **and** the mirror in one transaction. Rules block every reputation field. |
| 2 | **Two provider review authorities.** Generic `reviews.js` also resolved `providers` targets and wrote client-created `reviews` docs. | `reviews.js _TARGET_SOURCES` | `providers` removed from every generic target list. `providerReviews` is the one store (owner decision). |
| 3 | **Follow identity = display name.** `services.html` followed `service--sv_<name slug>`. Two providers can share a name, and a rename orphans the follow. | `sokoni-social.js patchServicesFollowBtns` | Follows are keyed by the account: `{uid}--provider--{providerUid}`. The migration maps unique slugs and reports the rest. |
| 4 | **Client-written follower counts.** `followerCounts` had no rule (always denied), and the entity `followerCount` was owner-writable. | `sokoni-db.js`, rules | Server-counted in the follow transaction (owner decision: server callable on follows). |
| 5 | **`getMinishopPublic` leaked review records** (uids, raw docs). | `minishop.js` | Filtered to approved; projected to rating / text / first name / date. |
| 6 | **Client-created generic reviews** (`reviews` create allowed). | rules | `create: if false`; update / delete are admin only. |

**Reported, not fixed in this slice** (owner decision: "reputation holes now, rest reported"):

- Client-written review stores in other hubs: `healthReviews`, `legalReviews` (plus its callable fallback),
  `homeServiceReviews`, `constructReviews`, `digitalReviews`, `sportsReviews`, `unboxingReviews`, `csatRatings`,
  `driverRatings`.
- Binding gaps in `rateDigitalProduct`, `rateHealthProvider` and `rateLegalProvider`.
- Seller-broadcast impersonation (rules ~1839–1846).
- Client-writable aggregates on product / business / sellers / services / users.
- MiniShop keeps two follow stores: `shopFollowers` and `follows`.
- `sokoni-reviews.js` calls functions without an ID token.
- Product review targets are keyed `"product_"+id`, which mismatches the product id.
- Dead stores: `ratings`, `shopReviews`, `followerCounts`.
- ~~`sokoni-share.js` writes unescaped `innerHTML`.~~ **Fixed after `0865a34`** (CHANGELOG 210). The share sheet is
  built as DOM, and images are limited to https or same-origin.
- ~~Share cards hard-code a 5-star rating (`product.js:636`, `seller-public.html:456`).~~ **Fixed** (CHANGELOG 210):
  - a card draws stars only for a canonical aggregate (`ratingVerified` with at least one review);
  - the card link now honours the caller's SOKONI `shareURL`.
- ~~The provider-dashboard share link `/providers?p=` is never read by `providers.html`.~~ **Fixed** (CHANGELOG 210):
  - the link is the handle `/p.html?h=…&s=…`, and the QR code encodes the same link;
  - a handle lands on `provider-profile.html?h=…`, so no uid appears in the address bar.
- `reviews.html` is a localStorage page; its cloud push now fails closed.

---

## 2. Data model

| Collection | Written by | Read by | Notes |
|---|---|---|---|
| `follows/{uid}--{type}--{id}` | provider / venue / creator: **server only** · other types: client (unchanged) | the follower, admin | `via:'server'`, `showMe` (default **false**) |
| `providers/{uid}` · `venues/{id}` · `creators/{id}` | aggregate fields: **server only** | public | `rating · reviewCount · ratingSum · ratingDist · followerCount · shareCount · shareHandle · repV · followV` |
| `providerProfiles/{uid}` | server | owner | private mirror kept for back-compat |
| `providerReviews/{reviewId}` | server | author, provider, admin | id = the booking id (service) or `ven_{bookingId}` (venue); `publicId` = opaque `rv_…` |
| `reports/rep_{reviewId}_{uid}` | server | admin (trust & safety) | `entityType:'providerReview'`, controlled reason |
| `shareHandles/{handle}` | server | admin | handle → entity |
| `shareEvents/{type}_{id}_{uid}_{day}` | server | admin | one share event per person, per profile, per day |
| `reputationAudit/*` | server | admin | every moderation action and recount |

### Two markers, never one

- **`repV`**: the **rating** aggregate is server-derived. It is set only by a review write or a recount.
- **`followV`**: **`followerCount`** is server-maintained. It is set by a follow, an unfollow or a recount.

The two are kept separate on purpose. A follow must never make a legacy, owner-written `rating` look server-derived.
Until `repV` is set, the public rating comes from the server-written `providerProfiles` mirror; otherwise it shows
"No reviews yet". Until `followV` is set, the follower count renders **"—"**, never `0`.

---

## 3. Followers

| Op | Who | Behaviour |
|---|---|---|
| `repFollow {type,id,showMe?}` | signed-in | Transactional and idempotent. **Self-follow is refused**, and so is following a profile that is not public. A legacy client follow is **adopted** without being counted twice. The uid always comes from auth; a client-sent `uid` is ignored. |
| `repUnfollow {type,id}` | signed-in | Transactional. **Floors at 0.** A repeated unfollow is a no-op. |
| `repFollowVisibility {type,id,showMe}` | the follower | Lets the follower choose whether the provider may see their first name. |
| `repFollowState {items≤50}` | signed-in | following true/false |
| `repFollowers {type,id}` | **owner only** | count, first name + last initial of followers who opted in, `hiddenCount`. **Never** a uid, email, phone, booking or payment. |

---

## 4. Ratings & reviews

### Eligibility (server, `eligibility()`)

| Engine | Must be the reviewer's own booking | Not in | And |
|---|---|---|---|
| `providerBookings` | `customerUid` | cancelled · declined · no_show · paymentStatus refunded | `completed`, **or** show-up settled and the booked time has ended |
| `bookings` (venue) | `customerId` | cancelled · no_show · rejected · refunded · partially_refunded | paid when `requiresPayment`; `completed`, or checked in and ended; the venue owner must match the booking owner |
| both | | | within **60 days** of the end (`POLICY.REVIEW_WINDOW_MS`) |

- One review per booking (a deterministic id).
- Self-review is refused.
- The rating must be an **integer from 1 to 5**.
- The provider and the reviewer are derived from the booking, never from the client.

### Operations

- **`repSubmitReview`** / **`bookingSubmitReview`** (the canonical op, now delegating). Creates the review and the
  aggregate in the same transaction, and stamps `reviewedAt` on the booking.
- **`repEditReview`**. The author only, while the review is published, within **14 days**, and at most **3 edits**.
  The aggregate moves by the difference and the review is marked `edited`.
- **Provider reply**: `providerReplyReview` (existing, `providerDispatch`). Allowed only on reviews of the caller's own
  business, and never on a removed review. It **never touches the rating or the text**. The reviewer is notified
  (`rep_review_reply`).
- **`repReportReview`**. Takes a controlled reason: `HARASSMENT · SPAM · PERSONAL_INFORMATION · FRAUD_ALLEGATION ·
  IRRELEVANT · ABUSIVE · OTHER`. It creates a moderation case, once per person per review, and **does not change the
  rating**. It accepts the public `rv_…` id.
- **`repReviews`** (public). Returns published reviews only, each with the opaque `rv_…` id, first name + initial,
  "Verified booking", service name, `edited`, the reply and the date. It returns **no uid, no booking id, no contact**.
- **`repSummary`** (public, up to 30 items): rating, count, distribution, followers, verified.
- **`repMyReviews`**: the caller's own reviews, plus the bookings that are eligible for a review.
- **`repDashboard`** (owner): reputation, recent reviews, reported reviews, sharing.

### Moderation (AdminOS › Reviews & Reputation)

| Action | Who | Effect |
|---|---|---|
| Hide | admin | Removed from the public list and from the aggregate, in the same transaction. |
| Restore | admin | Counted again. |
| Remove | **super admin** | Final: a removed review cannot be restored. |
| Recount | **super admin** | Re-derives the aggregate from the published reviews and the follow records. |

- Every action needs a reason (5 characters or more).
- Every action is written to `reputationAudit`.
- Every action resolves the pending reports on that review.
- Every action notifies both parties (`rep_review_moderated`).
- **The booking behind a review is never changed.**

---

## 5. Sharing

- **`repShareLink`** returns `https://mysokoni.co.ke/p.html?h=<handle>`, optionally with `&s=<serviceId>` (the service
  must belong to that provider).
  - Events use `/event-hub.html?event=<id>`, so an event keeps its ticket identity.
  - A link **never** contains a uid, phone, email, PIN, payment reference or conversation id.
- **`p.html`** resolves the handle on the server (`repResolveHandle`) and redirects to a same-origin path only.
- **`repShareEvent`** is counted once per signed-in person, per profile, per day. It moves **only** `shareCount`, never
  followers or ratings.
  - The client records a share event only when something actually left the page (a native share, or a successful
    clipboard copy).

---

## 6. UI

| Surface | What |
|---|---|
| `provider-profile.html` | identity strip (★ · reviews · followers · ✓ Verified · Follow · Share · "let them see my first name") before the storefront; reviews + distribution + Report after it |
| `venue-booking.html` | identity strip in the venue header; a **Reviews** tab |
| `creator.html` | identity strip (follow / share; creator reviews stay on the creator's provider profile) |
| `entertainment.html` › Mine | **My reviews**: rate a completed booking; edit within the rules |
| `provider-dashboard.html` · `venue-manager.html` | **Followers & Reputation** tab (workspace `reputation`): Audience · Reputation (reply) · Sharing |
| `admin-os.html` | **Reviews & Reputation** (`sokoni-aos-reputation.js`) — never `admin.html` / `superadmin.html` |

Client: `sokoni-reputation.js` (`SokoniRep`). It displays only: it never computes a rating or a count and never writes
Firestore. Unknown values render "—".

**Category rules.** Events keep their ticket identity and their own share link. Product reviews stay on the product
authority. Creator bookings are reviewed on the creator's provider profile.

---

## 7. Notifications (`notify.js`)

`rep_new_review` (to the provider) · `rep_review_reply` (to the reviewer) · `rep_review_moderated` (to both parties).
All three use `priority:'commerce'` and `category:'reviews'`.

---

## 8. Security review

| Threat | Control | Proof |
|---|---|---|
| Follower count injection / negative count | server-only fields (rules), transactional count, floor at 0 | rules suite, sabotage |
| Fake follow for another user | uid from auth only; rules deny provider / venue / creator follow ids for everyone (a hyphenated uid cannot slip past) | unit + rules + sabotage |
| Fake aggregate / fake eligibility | `repV` marker; eligibility re-read inside the transaction | unit + sabotage |
| Forged reviewer / provider / booking | everything derived from the booking | unit + sabotage |
| Duplicate / self review | deterministic id; owner check | unit + sabotage |
| Provider editing a rating or deleting a review | `providerReviews` write:false; the reply op never touches the rating | rules + unit + sabotage |
| Unauthorized moderation / removal | admin re-check; remove requires super admin | unit + sabotage |
| Private follower enumeration | owner-only op; `showMe` opt-in | unit + sabotage |
| Moderation data read | `reputationAudit` / `shareEvents` / `shareHandles` admin read only | rules + sabotage |
| Share URL leak | handle links only | unit + browser + sabotage |
| Share-count manipulation | server-only, once per person per day, no side effects | unit + rules + sabotage |
| Booking id exposure in the public list | opaque `rv_` id (one-way hash, stored) | unit + sabotage |

---

## 9. Migration (NOT run)

`node scripts/migrate-reputation.js` performs a **dry run**. `--apply` writes, and is a deliberate deploy step: the
owner approves the counts first.

1. **Follows.** Each `service--sv_<slug>` follow is mapped to `{uid}--provider--{providerUid}`, **only** when exactly
   one active provider has that slug.
   - Ambiguous slugs (two or more providers) and orphan slugs (none) are **reported, never guessed**.
   - The legacy doc is kept and stamped `migratedTo`, so the migration is re-runnable.
2. **Aggregates.** Every provider and venue is recounted from its published `providerReviews` and its follow records.
   The recount sets `repV`, `followV`, and backfills `publicId` on older reviews.

Until the migration runs, a provider shows the rating from the server-written mirror (or "No reviews yet"), and the
follower count shows "—" until the first server follow.

---

## 10. Deployment requirements (when authorised)

- Functions: `bookingDispatch`, `providerDispatch`, `adminOsDispatch`.
  - Re-read the **Artifact Registry notice in CLAUDE.md** first.
  - Mind the merchant-identity provenance gap.
- Rules: deploy through the Rules REST API (`--only firestore:rules` fails open).
- Hosting: only from the latest commit.
- Then run the migration: dry run → owner review → `--apply`.
- Index: `providerReviews.publicId` (a single field, created automatically).

---

## 11. Tests

| Suite | Result |
|---|---|
| `scripts/test-reputation.js` | 70 / 0 |
| `scripts/test-reputation-browser.js` (Chromium: 360 · 390 · 768 · 1280, logged-out, buyer, provider, AdminOS, `p.html`) | 32 / 0 |
| `scripts/test-entertainment-rules.js` (served + allow-all counterproof) | 287 / 0 |
| `scripts/test-follow-rules.js` (provider moved to server-counted) | 42 / 0 |
| `scripts/sabotage-event-ops.js --group=rep` | 34 / 34 caught |
| `scripts/sabotage-event-ops.js` (all groups) | 221 / 221 caught · tree byte-identical |
| `scripts/test-share-integrity-browser.js` (CHANGELOG 210; real `provider-dashboard.html`, `p.html`, `provider-profile.html`, `seller-public.html`) | 64 / 0 |

## 12. Known limitations

- Messaging controls still do not offer "Followers" as an audience. That is now possible, because follows are
  account-based, but it is out of scope for this slice.
- The public review list reads up to 300 reviews per profile and pages in memory. At larger volumes it needs a
  composite index with cursor paging.
- `repFollowers` lists up to 500 follow records (`truncated` is flagged).
- The other hubs' client-written review stores (§1) remain open.
