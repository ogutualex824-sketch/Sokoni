# Fitness rules candidate — memberships + F0-R containment

**Status:** CANDIDATE, **NOT released**. Static proof 14/14 + 7 negative controls caught. Emulator suite written,
**QUEUED** (host free RAM ≈270 MB < 512 MB floor, 2026-10-03) — no emulator result exists; do not quote one.
**Branch:** `rules/fitness-memberships-on-served` · Related: [[Fitness]] · [[Security]] · [[Payments]] · [[Providers]] · [[RULES_COMBINED_CANDIDATE]]

## Base — the SERVED ruleset

| | |
|---|---|
| Release | `projects/sokoni-aeb26/releases/cloud.firestore` (updateTime 2026-10-01T00:27:37Z), fetched read-only 2026-10-03 via the Rules REST API |
| Served ruleset | `rulesets/f259c0b5-0a9e-49c5-8578-a628a40d946c` (createTime 2026-10-01T00:20:38Z) |
| Base file | `firestore.rules.served-f259c0b5` — 158,619 B, sha256 `78d938fd9785ab8f…` — byte-identical to the takedown line's served base (rules/takedown-enforcement-on-served 47c928b) |
| Git base | `14ef233` (parent of the takedown candidate commit; none of the takedown/media-hold hunks are on this branch) |
| Candidate | `firestore.rules.fitness-candidate` — 157,363 B (−1,256 B vs served), sha256 `627134c740b2…`; 60.0 % of the 256 KiB (262,144 B) source limit |
| Builder | `node scripts/build-fitness-rules-candidate.js firestore.rules.served-f259c0b5` (sha-pinned input; each hunk must apply exactly once, fail closed) |

`firestore.rules` on shared branches is NOT edited.

## Hunks (9 anchors → 10 diff hunks; every changed served line lies inside a `fitness_*` block — static row S4)

| Id | Block | Served | Candidate | Why |
|---|---|---|---|---|
| FB | `fitness_bookings` | owner read; client create with `status:'confirmed'` | read `isAdmin()`; `write: false` | D-3 live fake confirmation |
| FG | `fitness_gyms` | owner create/update with `noAdminFields()` (which lacks rating/members) | adds `noGymLockedFields()` to create and update: `rating, ratingCount, reviewCount, members, memberCount, verified, status, moderationHold, moderationStatus, moderationReleased, hidden, isVisible`. Profile fields (name, loc, hours, phone, facilities, tagline, monthly, daypass …) stay owner-editable. Read unchanged (`true`). | D-14 self-stamped rating 5.0 |
| FC FL FP FE FR FH FK | `fitness_classes`, `_clubs`, `_community_posts`, `_equipment`, `_requests`, `_challenges`, `_checkins` | public or signed-in reads; client creates | read `isAdmin()`; `write: false` | D-5 unmoderated public listings and phones; D-14 forgeable pts, member names, exposed phones |
| FM (new, after `fitness_checkins`) | `providerMemberships/{membershipId}` | no rule (deny) | read: `isAuthed() && (buyerUid == uid ‖ providerId == uid ‖ isAdmin())`; `create, update, delete: false` | contract "Rules matchers" |
| FM | `…/attendance/{attendanceId}` | — | read: parent `buyerUid` or parent `providerId` or `isAdmin()`; write false | the member sees their own history; the gym sees its own |
| FM | `…/events/{eventId}`, `…/releases/{releaseId}` | — | read: parent `providerId` or `isAdmin()` (buyer denied); write false | 2f spec — AdminOS + gym views |
| FM | `fitnessMembershipClaims/{claimHash}` | — | `read, write: false` | server-only idempotency claims |

**Admin predicate:** the served `isAdmin()` (token `admin == true || superAdmin == true`), reused by name.

**Queries are provable.** Rules are not filters: a list is allowed only if the rule holds for every document the query
can return. `where('buyerUid','==',uid)` and `where('providerId','==',uid)` constrain exactly the fields the read rule
compares, so both list queries are provable. An unconstrained list (or one for another uid) is denied. Attendance /
events / releases lists are scoped by the parent path (`membershipId` is fixed), so the parent `get()` is the same
document for every result (one billed read per request, inside the 10-`get()` limit). Collection-group queries over
`attendance` have no rule → denied (staff use callables). Membership docs are server-written with both `buyerUid` and
`providerId`, so plain field access cannot hit a missing-field error; a missing parent makes `get()` error → **deny**
(the safe direction). Staff are never granted direct reads — the `fitnessGymMemberships` / `fitnessGymMembership`
callables resolve the gym server-side.

## Unchanged — verified, not edited

- **`fitness_progress/{userId}`** — owner-only (read admin|own, create/update own, delete admin). F0 keeps it. Row S11.
- **`providerPayouts/{payoutId}`** — served: `allow read: if isAdmin() || (isAuthed() && resource.data.providerId == request.auth.uid);`
  and no write statement → no client writes. That already meets the 2f requirement (a gym reads its own
  `sourceType=='membership'` rows, admin reads all, a buyer reads none). Not widened. Rows S12 / M15 / C5.
- **`providers/{providerId}`** — `business` owner-writability (5b finding) is ALREADY closed on f3's line
  `rules/capability-decisions-on-f20be7d` (create refuses `business`; owner update `hasAny([... 'business'])`; admin raw
  update refuses `business`). **Not duplicated here**; row S13 proves this candidate leaves the block byte-identical.
  Residual for f3: `category` is still owner-writable on both lines (`status/verified/suspended/approved` are already
  locked on served). If `category` is authoritative anywhere (resolveRole fallback), f3 should extend the same list —
  exact text: `.hasAny(['status', 'verified', 'suspended', 'approved', 'business', 'category']));`.

## Reader census (why the eight legacy reads go to admin)

`git grep` at live hosting `72dca56` (whole tree, excluding rules and docs): the only client file that touches any
`fitness_*` collection is `fitness-hub.html`. It reads `fitness_classes`, `fitness_clubs` (onSnapshot) and
`fitness_bookings` (own), and writes the rest. `functions/` (Typesense `ts_fitness_*`, search-sync) uses the Admin SDK
and bypasses rules. On F0 (`hosting/fitness-containment-on-72dca56`, 31f5844) the only remaining reference is
`fitness_progress`. So no client reader survives F0, and reads go to admin. `fitness_gyms` has **no** client reader even
on live (write-only); its public `read: true` is left as served (outside the requested scope). Candidate follow-up:
admin-only read.

## Release order (hard)

1. **F0 hosting** (`hosting/fitness-containment-on-72dca56`) must be LIVE first. Shipping these rules against the live
   `72dca56` fitness-hub.html turns its classes/clubs/bookings listeners into permission-denied errors.
2. **Functions** that write the new collections (e3 `fitnessCheckIn` / `fitnessCreateMembership` / read callables,
   2f membership settlement). The rules only grant reads of server-written docs, but the member/gym UI must not ship
   before both the functions and these rules.
3. **This candidate ships inside the COMBINED rules release**, after the functions it serves — never as its own
   `firestore:rules` deploy. The emulator suite must be run first (QUEUED).
4. Rollback = served `f259c0b5` (the combined release's documented rollback).

## Merging into the combined candidate (f3 — `rules/capability-decisions-on-f20be7d`, record commit 1499595)

The combined candidate's release artifact is `firestore.rules.build`; its source `firestore.rules` differs only in
formatting outside these blocks. All nine fitness blocks are byte-identical between served f259c0b5 and f3's line, so
the same anchors apply. Do NOT hand-merge — run the builder in `--onto` mode on f3's line. Dry-run verified 2026-10-03
against `origin/rules/capability-decisions-on-f20be7d` @ 99b1ffb: all 9 hunks applied exactly once on both files.

```
git show origin/rules/fitness-memberships-on-served:scripts/build-fitness-rules-candidate.js > scripts/build-fitness-rules-candidate.js
node scripts/build-fitness-rules-candidate.js firestore.rules.build --onto --out firestore.rules.build   # 161,096 -> 159,840 B (61.0 %)
node scripts/build-fitness-rules-candidate.js firestore.rules       --onto --out firestore.rules         # 172,980 -> 171,724 B
RULES_FILE=firestore.rules.build node scripts/test-fitness-rules-emulator.js   # under emulators:exec; M16 must PASS there
```

No overlap with f3's hunks (providers, applications, reviews, unboxingReviews, verifications, businesses,
verificationRequests, jobs, orders, bookingFees, propertyViewings, packageRequests): the blocks are disjoint. There is
also no overlap with the takedown line (products, reports, fraudAlerts). The static test's S1 / S4 / S13 rows are pinned
to served f259c0b5, so on the merged file rely on the emulator suite and f3's own gate-7 hunk inventory, which must grow
by these hunks.

## Tests

| Suite | Status |
|---|---|
| `scripts/test-fitness-rules-static.js` | **14/14 PASS**; negative controls N1–N7 all caught (write:true on providerMemberships → S5 fails; a second `/providerMemberships/{x}` → S3; unbalanced `{` → S2; events opened to the buyer → S7; a served providers line edited → S4 + S13; `fitness_classes` read:true → S9; a providerPayouts write → S12) |
| `scripts/test-fitness-rules-emulator.js` | WRITTEN, **QUEUED (RAM)** — M1–M16 + served controls C1–C5; refuses to run off-localhost; `demo-` project ids |

"Static" means textual: it proves the matchers, single blocks, brace balance and served identity. It does not evaluate rules.

## Unified diff (served f259c0b5 → candidate)

```diff
--- a/firestore.rules.served-f259c0b5
+++ b/firestore.rules.fitness-candidate
@@ -776,10 +776,6 @@ service cloud.firestore {
   }
   match /fitness_bookings/{bookingId} {
-  allow read:   if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
-  allow create: if claimsOwner()
-  && request.resource.data.keys().hasAll(['type','provider','ref','uid','status','ts'])
-  && request.resource.data.status == 'confirmed';
-  allow update: if isAdmin();
-  allow delete: if isAdmin();
+  allow read:   if isAdmin();
+  allow write:  if false;
   }
   match /fitness_progress/{userId} {
@@ -790,84 +786,70 @@ service cloud.firestore {
   }
   match /fitness_gyms/{gymId} {
+  function noGymLockedFields() {
+  return resource == null
+  ? !request.resource.data.keys().hasAny(['rating','ratingCount','reviewCount','members','memberCount','verified','status','moderationHold','moderationStatus','moderationReleased','hidden','isVisible'])
+  : !request.resource.data.diff(resource.data).affectedKeys().hasAny(['rating','ratingCount','reviewCount','members','memberCount','verified','status','moderationHold','moderationStatus','moderationReleased','hidden','isVisible']);
+  }
   allow read:   if true;
-  allow create: if isAuthed() && request.auth.uid == gymId && noAdminFields();
-  allow update: if isAuthed() && request.auth.uid == gymId && uidUnchanged() && noAdminFields();
+  allow create: if isAuthed() && request.auth.uid == gymId && noAdminFields() && noGymLockedFields();
+  allow update: if isAuthed() && request.auth.uid == gymId && uidUnchanged() && noAdminFields() && noGymLockedFields();
   allow delete: if isAdmin();
   }
   match /fitness_classes/{classId} {
-  allow read:   if true;
-  allow create: if claimsOwner()
-  && noAdminFields()
-  && request.resource.data.keys().hasAll(['name','type','instructor','phone','uid','ts']);
-  allow update: if isAdmin()
-  || (isAuthed() && resource.data.uid == request.auth.uid
-  && request.resource.data.diff(resource.data)
-  .affectedKeys().hasOnly(['name','loc','time','fee','slots','desc','type','updatedAt'])
-  && uidUnchanged());
-  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
+  allow read:   if isAdmin();
+  allow write:  if false;
   }
   match /fitness_clubs/{clubId} {
-  allow read:   if true;
-  allow create: if claimsOwner()
-  && noAdminFields()
-  && request.resource.data.keys().hasAll(['name','type','uid','ts']);
-  allow update: if isAdmin()
-  || (isAuthed() && resource.data.uid == request.auth.uid
-  && request.resource.data.diff(resource.data)
-  .affectedKeys().hasOnly(['name','desc','meet','members','updatedAt'])
-  && uidUnchanged());
-  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
+  allow read:   if isAdmin();
+  allow write:  if false;
   }
   match /fitness_community_posts/{postId} {
-  allow read:   if true;
-  allow create: if claimsOwner()
-  && noAdminFields()
-  && request.resource.data.keys().hasAll(['uid','ts'])
-  && (request.resource.data.text == null || request.resource.data.text.size() <= 2000);
-  allow update: if isAdmin()
-  || (isAuthed() && resource.data.uid == request.auth.uid
-  && request.resource.data.diff(resource.data)
-  .affectedKeys().hasOnly(['text','likes','updatedAt'])
-  && uidUnchanged());
-  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
+  allow read:   if isAdmin();
+  allow write:  if false;
   }
   match /fitness_equipment/{itemId} {
-  allow read:   if true;
-  allow create: if claimsOwner()
-  && noAdminFields()
-  && request.resource.data.keys().hasAll(['uid','ts']);
-  allow update: if isAdmin()
-  || (isAuthed() && resource.data.uid == request.auth.uid
-  && request.resource.data.diff(resource.data)
-  .affectedKeys().hasOnly(['price','desc','sold','updatedAt'])
-  && uidUnchanged());
-  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
+  allow read:   if isAdmin();
+  allow write:  if false;
   }
   match /fitness_requests/{requestId} {
-  allow read:   if request.auth != null;
-  allow create: if claimsOwner()
-  && noAdminFields()
-  && request.resource.data.keys().hasAll(['text','uid','ts'])
-  && request.resource.data.text.size() <= 1000;
-  allow update: if isAdmin()
-  || (isAuthed() && resource.data.uid == request.auth.uid
-  && request.resource.data.diff(resource.data)
-  .affectedKeys().hasOnly(['text','phone','updatedAt'])
-  && uidUnchanged());
-  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
+  allow read:   if isAdmin();
+  allow write:  if false;
   }
   match /fitness_challenges/{entryId} {
-  allow read:   if true;
-  allow create: if isAuthed() && request.resource.data.uid == request.auth.uid && noAdminFields();
-  allow update: if isAuthed() && resource.data.uid == request.auth.uid && uidUnchanged();
-  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
+  allow read:   if isAdmin();
+  allow write:  if false;
   }
   match /fitness_checkins/{checkinId} {
-  allow read:   if isAdmin() || (isAuthed() && resource.data.gymUid == request.auth.uid);
-  allow create: if isAuthed()
-  && request.resource.data.gymUid == request.auth.uid
-  && request.resource.data.keys().hasAll(['memberName','gymUid','ts']);
-  allow update: if isAdmin();
-  allow delete: if isAdmin();
+  allow read:   if isAdmin();
+  allow write:  if false;
+  }
+  match /providerMemberships/{membershipId} {
+  allow read:   if isAuthed()
+  && (resource.data.buyerUid == request.auth.uid
+  || resource.data.providerId == request.auth.uid
+  || isAdmin());
+  allow create, update, delete: if false;
+  match /attendance/{attendanceId} {
+  allow read:   if isAuthed()
+  && (get(/databases/$(database)/documents/providerMemberships/$(membershipId)).data.buyerUid == request.auth.uid
+  || get(/databases/$(database)/documents/providerMemberships/$(membershipId)).data.providerId == request.auth.uid
+  || isAdmin());
+  allow write:  if false;
+  }
+  match /events/{eventId} {
+  allow read:   if isAuthed()
+  && (get(/databases/$(database)/documents/providerMemberships/$(membershipId)).data.providerId == request.auth.uid
+  || isAdmin());
+  allow write:  if false;
+  }
+  match /releases/{releaseId} {
+  allow read:   if isAuthed()
+  && (get(/databases/$(database)/documents/providerMemberships/$(membershipId)).data.providerId == request.auth.uid
+  || isAdmin());
+  allow write:  if false;
+  }
+  }
+  match /fitnessMembershipClaims/{claimHash} {
+  allow read, write: if false;
   }
   match /bnbListings/{listingId} {
```
