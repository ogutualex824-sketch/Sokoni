# Combined Firestore rules candidate — certification record

**Branch:** `rules/capability-decisions-on-f20be7d` (pushed) · **Base:** `f20be7d`, whose `firestore.rules.build` is
byte-identical (CR-stripped) to the LIVE release `cloud.firestore → rulesets/b87c94e4` (re-fetched 2026-10-01).
**Status:** CERTIFIED on the emulator, **NOT released**. Related: [[Security]] · [[Applications]] · [[Verification]]

## Contents — one release, five owners

| Block | Change | Owner / source |
|---|---|---|
| functions `appNoDecision` / `appUndecided` | applicant never writes a decisive status or decision metadata; a decided application is frozen (no edit / reopen / delete) | sokoni-27 K13-C `ad183b0`, ported from the older 6c67a34d base; keys extended with `agreementVerifiedAt/Version`, `priorDecisions` |
| `applications` | create/update/delete use the two functions; admin raw write cannot touch `priorDecisions` | K13-C + capability candidate 1 |
| `providers` | `business` (category + lane → dashboard route) server-only on create, owner update and admin raw update | capability (c4 CHANGELOG 236) |
| `reviews` | client create false; update/delete admin | sokoni-70 R0 |
| `unboxingReviews` | buyer creates a PENDING submission only; public read approved-only | sokoni-70 R0 |
| `verifications` | `allow write: if false` (forged approved badge closed) | owner 2026-10-01, sokoni-4d fix 1 |
| `businesses` | `capabilities` / `business` server-only, even vs admin raw writes | capability R1 |
| `verificationRequests` | `allow write: if false` (verificationSubmit / Decide are the writers) | owner 2026-10-01 |
| `jobs` | create tail parenthesised — anonymous/forged-uid create with `applicants: 0` closed | owner 2026-10-01, sokoni-4d fix 2 |

**Exact diff vs served:** 9 hunks, 64 changed lines in `.build`, every hunk inside one of the blocks above (gate item 7).
`.build` 160,181 B (61.1 % of 256 KiB), sha1 `d544c9489db3`.

## Owner gate (2026-10-01)

| # | Item | Result |
|---|---|---|
| 1 | forged badge create DENIED | `test-verif-jobs-rules.js` V1–V6 PASS (served: V1 succeeds — live defect) |
| 2 | anonymous job create DENIED; anon+applicants DENIED; authed+0 only with full contract; authed+applicants normal | J1–J7 PASS (served: J1, J3, J4 succeed — live defect) |
| 3 | legitimate applicant submission PASS | `test-verification-flow-e2e.js` S1–S3 on the LIVE `verificationSubmit` source |
| 4 | legitimate AdminOS decision (backend) PASS | D1–D2 on the LIVE `verificationDecide` source |
| 5 | public projection shows ONLY approved | P1–P2 on the LIVE `profileGetPublicProfile` source: approved-unexpired only |
| 6 | owner-isolation suites: no regression | 19 rules suites, candidate vs served: identical except the intended rows (connect 37, delivery-tracking 22, follow 40, hosting-ignores 36, isactive 10, landlord 28, p0-rider-payout 14, posdevices 26, printjobs 20/1 baseline on both, returns 20, role 57, role-switch 49, rules-parser 12, seller 15, stories 24, workspace 12) + K13-C 14/0 (served 6/8), R0 34/0 (served 20/14), category 19/1 (the 1 = c4's "edit an APPROVED application", refused by K13-C by design), capability 22/2 (c4 create expectations; served is stricter) |
| 7 | exact staged file set vs served | this record: 9 hunks, all intended |
| 8 | deploy ONLY firestore rules; verify the release pointer | **not done** — see Release |
| 9 | post-deploy live probes | **not done** |

**Writer census for the server-only collections:** no browser writes `verifications` / `verificationRequests` on live
`72dca56`, Slice B2, or any of 50 hosting refs; the detector's positive control finds the original `b905bc9`
setDoc/addDoc (1 each). Live writers: `verificationSubmit`, `verificationDecide`, `verificationRevoke`.

## Re-base 2026-10-01 — live is now f259c0b5

The owner moved `releases/cloud.firestore` to `rulesets/f259c0b5` (updateTime 2026-10-01T00:27:37Z) = b87c94e4 + exactly
this candidate's verifications / verificationRequests / jobs blocks (sokoni-27 hotfix; byte-verified here: 3 hunks, each
block md5-identical to this candidate's build). This candidate therefore already CONTAINS live; against f259c0b5 it
differs in **6 hunks** (applications functions + block, providers, reviews, unboxingReviews, businesses).
Counterproofs re-run vs f259c0b5: verif/jobs 16/0 on BOTH (holes closed in production — confirmed); K13-C candidate
14/0 vs live 6/8; R0 34/0 vs live 20/14. The 19 isolation suites stand (the candidate is unchanged; the base moved only
inside blocks those suites do not exercise). **Rollback for this release = f259c0b5.**

## Release — preconditions (all open)

1. **Ordering:** after sokoni-70's `e78b940` hosting is live (unboxing.html sends a clean payload; otherwise R0 refuses
   the live page's submissions).
1b. **K13-A/B functions** (sokoni-27: `applicationDecide`/`Reconcile`/`Lifecycle`, 7df7817 + f66f2c1) live **before or
   alongside** this release — K13-A's `applicationDecide` writes the decision record these rules defer to. sokoni-27
   reviewed the applications port: **APPROVED** (2026-10-01). Invariants K13-A rests on — keep true in any later edit:
   no rule matches `applicationDecisions` and there is **no catch-all match** (default-deny); `adminAudit` admin-read-only.
2. **Compiled size:** NOT measured. `scripts/measure-rules-compiled-delta.js` creates `sizeprobe-*` rulesets/releases in
   the production project (guarded, self-cleaning) — needs explicit owner authorization.
3. Re-fetch the live release immediately before; it must still be `b87c94e4` or the candidate is re-based.
3b. **foodMenus closed (sokoni-5b security convergence):** `allow read, write: if false`. Ship only AFTER the Food
   containment hosting (`2e5e33b`, removes food-dashboard.html's only writer) is live. Suite
   `scripts/zz-test-food-menus-rules.js` FM-1..FM-8 + control — **EMULATOR PENDING**.
3c. **products authority, phase 1 (sokoni-5b security convergence):** no browser create; the owner cannot change
   price / sale / wholesale / status / visibility / shop / owner / moderation / rating fields; no owner hard delete.
   Ship only AFTER (i) `merchantProduct` (feat/security-product-authority-on-c8a3e6c) is LIVE and (ii) the client
   migration hosting (hosting/security-product-client-on-32c16ee: merchant-v2, inventory pages, merchant.html
   availability, seller-wiring retired) is LIVE — otherwise product saves are denied. Stock stays owner-writable until
   phase 2 (after POS convergence, sokoni-2f). Suite `scripts/zz-test-products-authority-rules.js` PA-1..PA-14 —
   **EMULATOR PENDING**.
4. Release only `firestore:rules` (and verify `releases/cloud.firestore` → the new ruleset id afterwards — a scoped
   `--only firestore:rules` deploy can fail open), then run live probes (forged-badge create denied, anonymous job
   create denied, an applicant's own pending application still writable).

## 2026-10-03 — review authority alignment (`6daba96`) and RELEASE PRECONDITION

`6daba96` aligns the candidate with sokoni-5b's review authority (`7ec04c5`; sokoni-5b confirmed the match).
- `reviews` and `unboxingReviews`: no browser create, update or delete, admin browser included. Reads are unchanged.
- `reviewModerationLog`, `reviewRateLimits`, `smsSendAudit`, `deliveryPinLog`: no match, no wildcard, so deny-all.
- Same commit: buyer paid-cancel guard; `bookingPaymentReviews` / `pinDeliveryFailures` / `pinSecurityEvents` are
  admin-read and write:false.
- **Emulator suites NOT yet run** on `6daba96` (`zz-test-r0.js`, `test-census-4d-rules.js`). Run them before release.

**RELEASE PRECONDITION. These rules ship LAST, in this order. Each step must be live and verified first:**
1. functions `fix/review-authority-on-76436b1` @ `85a5fcf`: submitReview, getReviews, adminModerateReview, submitUnboxing
2. adminOsDispatch `fix/adminos-review-queue-on-18cfe7f` @ `3684b64`
3. hosting `hosting/review-approval-ui-on-72dca56` @ `307b84e`. This moves unboxing.html off the direct
   `SokoniDB.saveUnboxingReview` setDoc, and the wall listener queries `status == 'approved'`.
4. **these rules**

Releasing before step 3 refuses every unboxing submission. Releasing before step 1 leaves no writer for reviews.

Out of scope here:
- Storage: v1 unboxing is text-only. sokoni-5b adds a `unboxing/{uid}/{file}` storage rule when photos are built.
- The bnb / property / sports pages write `fsWrite('reviews', …)`, refused by both live and candidate rules. Those
  hubs need their own server path (sokoni-5b convergence item), never a rules loosening.

## 2026-10-03 (later): hub reviews + unboxing quarantine (`1925aaa`). RELEASE PRECONDITION EXTENDED

`1925aaa` closes `sportsReviews` to browser create/update, makes `applications` refuse `category:'reviews'`, and
adds the storage quarantine (`unboxing-pending/{uid}/` owner-only, `unboxing/{uid}/` server-written).

**RULE RELEASE = BLOCKED until every item is true:**
- [ ] sokoni-5b functions **`fix/review-authority-on-76436b1` @ `e8609fb`** live (tests 51/0, sabotage 13/13 on their tree; 51/0 reproduced here): `submitReview` with `property` + `sports_venue` (eligibility: `propertyViewings.buyerUid`,
      `sportsVenueBookings.uid`, a cancelled booking does not count), `getReviews` with targetType + authorName,
      `submitUnboxing`, and the approve photo copy
- [ ] adminOsDispatch review queue live (`3684b64`)
- [ ] hosting live: `hosting/hub-reviews-on-72dca56` @ `9476de3` + `hosting/review-approval-ui-on-72dca56` @ `307b84e`
- [ ] storage rules released and the upload contract proven
- [ ] emulator: `zz-test-r0.js` (incl. [H], [L]), `test-census-4d-rules.js`, `zz-test-unboxing-storage.js`,
      and sokoni-5b's `test-hub-review-rules.js` with RULES_FILE=candidate (P-1 and S-1 flip to REFUSED by design)
- [ ] compiled-size measurement authorized and within limit
- [ ] re-fetch of live rules; the candidate re-based if live moved
- [ ] then `--only firestore:rules` → verify pointer → probes → live browser proof per surface; rollback `f259c0b5`

**`b6f9cee` (2026-10-03):** `propertyViewings` browser create closed. Viewings make a buyer review-eligible, so `scheduleViewing` (server) is the only writer. sokoni-5b found the forgeable create; tests H-6/H-6b/H-6c. **Owner decision (2026-10-03):** keep `sportsVenueBookings` browser-created (claimsOwner). A booking request in your own name is enough to submit a venue review; AdminOS moderation is the filter. The rules do not change for bookings.

## 2026-10-03: Fitness memberships + F0-R containment (sokoni-e3 `rules/fitness-memberships-on-served` @ `5ddf5d2`)

Applied with e3's `scripts/build-fitness-rules-candidate.js --onto` to the **source** `firestore.rules`. The `.build` file was then regenerated with `scripts/build-firestore-rules.js`, and it is **byte-identical** to e3's direct application onto the previous `.build`.

**Gate item 7, Fitness delta:** 10 hunks, every one inside a Fitness block:

| Block | Change |
|---|---|
| `fitness_bookings`, `fitness_classes`, `fitness_clubs`, `fitness_community_posts`, `fitness_equipment`, `fitness_requests`, `fitness_challenges`, `fitness_checkins` | Read is admin-only; client write `false`. The legacy browser writers (D-3 self-confirmed bookings, D-5 unmoderated listings, D-14 exposed phones and forgeable points) are closed. |
| `fitness_gyms` | Owners can no longer set rating, review/member counts, verified, status, moderation or visibility fields, on create or update. |
| `providerMemberships` (+ `attendance` / `events` / `releases`), `fitnessMembershipClaims` | New and server-written only. Readable by the buyer, the gym (`providerId`) or an admin; attendance by the buyer, gym and admin; events and releases by the gym and admin. Claims deny all. |

Duplicate check: each collection has exactly one match block. `.build` is 159840 B (65.5 % of 256 KiB, −1.2 KB).

**e3's static test** (`RULES_FILE=firestore.rules.build node scripts/test-fitness-rules-static.js`): S1–S3, S5–S12 and S14 PASS; controls N1–N4, N6 and N7 are caught. Three failures are expected on this line only, because they compare against the served file and this line already differs from it:

- **S4** counts hunks outside the Fitness blocks. Those are this line's earlier, already-recorded hunks.
- **S13** expects the served `providers` block, which this line locks (`business` server-only).
- **N5** mutates that same served `providers` text, which no longer exists here, so the control has nothing to bite on.

None of them is a Fitness defect.

**Not decided here:** the `providers.category` lock. It belongs to sokoni-5b's owner-given security slice (item 1, category immutability) and will land as 5b's own commit on this line.

**Release precondition (Fitness), extending the list above:**
- [ ] sokoni-e3 **F0 hosting** live first. Otherwise live `72dca56` fitness-hub.html listeners on classes, clubs and bookings get permission-denied.
- [ ] Fitness functions live (the `providerMemberships` writers).
- [ ] Emulator: `RULES_FILE=firestore.rules.build` `scripts/test-fitness-rules-emulator.js` under `emulators:exec`. QUEUED (memory). Its M16 (`providers.business`) passes only on this merged file.

## 2026-10-03: provider trust lock (one hunk, three sources)

| Source | Ask | Applied here |
|---|---|---|
| sokoni-b2 Tech 4P (`e5eb1d6`, docs/RULES_PATCH_4P_PROVIDER_TRUST.md) | §1 `verifications` create could forge approved facets | **Already closed on this line** (`verifications` `write: false`, also on served f259c0b5). No change. |
| | §2 `providers`: owner-writable trust, badge and sort signals | `providerTrustKeys()` is refused on owner create and update. Create keeps the onboarding allowance `status == 'pending'` (onboarding-professional.html). |
| | §3 `services`: owner-writable `providerVerified` | Owner create/update refuse `providerVerified`, `isVerified`, `badges`, `rating`, `reviewCount`. |
| sokoni-5b security slice, item 1 | Provider category immutable (owner: changes go request → AdminOS) | `category` is in `providerTrustKeys()`. **Covered by this hunk**, so 5b adds no second `providers` hunk. |
| sokoni-e3 | `providers.linkedBusinessId` server-written only | In `providerTrustKeys()`. |

Admin raw writes are unchanged: everything except `business`, which stays server-only (applicationDecide / bizAdminClassify). `businesses` create remains `false` on this line, so e3's tree-only finding (unpinned ownerId) doesn't ship. Writers checked: provider.html and services.html `saveProvider` were already refused by the old rule (they send a non-pending `status`), and b2 retired the services.html self-listing.

Suite: `scripts/zz-test-provider-trust.js` (PT-R1/R2, PT-C*, PT-D-* one row per key, PT-S*, PT-R6a–c, PT-X1). **EMULATOR PENDING.** Baseline run against served f259c0b5: the PT-D rows must fail there.
**Open for 5b's slice:** the owner `businesses` update `hasOnly([...,'category',...])` still lets an owner relabel `businesses.category`. Capability reads `business`, which is server-only. Whether the label must also be locked is 5b's call under item 1.

## 2026-10-03: Car Hub C2, `trackingSubscriptions` admin-only

The owner could write their own `plan` / `vehicleLimit` (sokoni-tracking.js `saveSubscription`), which meant free self-activation of paid tracking tiers. Now `allow write: if isAdmin()`; owner read is unchanged. No server writer exists yet: a plan activates only through a verified IntaSend payment plus canonical subscription activation (sub-billing, Car Hub C6). The Car Hub page stops calling `saveSubscription` (C1b). Suite `scripts/zz-test-tracking-subscription.js` (TS-*), **EMULATOR PENDING**. Baseline f259c0b5: the TS-D rows must fail there.

**Provider trust lock, extended (sokoni-5b census, 2026-10-03):** `providerTrustKeys()` now also refuses `healthcare`, `legalProviderId`, `provisionedBy` and `legalVerification` on owner create and update. Without them, `business-category.categoryOf()`'s fallbacks let an unstamped approved provider self-classify as a clinic or lawyer, and flip the `!!p.healthcare` boundary that `bizAdminClassify` relies on. PT-D rows were added for each key. **EMULATOR PENDING.**

## 2026-10-03: orders status allow-lists (sokoni-5b security slice; edited by f3, the hunk owner)

- **Seller:** the deny-list let a seller set `cancelled` / `pending` from any status, so a paid order could be cancelled with no refund. Now an allow-list. Status unchanged (notes / tracking) is allowed. Otherwise only `cancelled` from `pending` / `pending_payment`, or `shipped` / `out_for_delivery` from a paid or accepted state.
- **Assigned rider:** only `delivered` / `completed` were denied. Now status unchanged is allowed. Otherwise only `picked_up` / `in_transit` / `out_for_delivery` from a rider stage.
- Delivered / completed and the payment states stay server-only.
- Census (5b): no live UI writes order status directly.
- Suite `scripts/zz-test-orders-status-rules.js` (OR-S1..7, OR-R1..8). **EMULATOR PENDING.** Baseline f259c0b5: OR-S1 and OR-R1..4 must fail there.

## 2026-10-03: B2B RFQ / lead ledger server-only (sokoni-f3 rfq.js + sokoni-2f b2b-leads.js)

- `b2bLeads`, `b2bLeadMonths`, `rfqs`, `rfqRecipients`, `rfqQuotes`: `write: false`, `read: isAdmin()`.
  Default deny already covered the writes; these blocks make it explicit and give AdminOS read.
  Suppliers read their lead statement through the `b2bLeadStatement` callable (2f `df1b281`), never the raw rows,
  because those carry `buyerBusinessId`. Buyers and suppliers reach RFQs only through `rfqDispatch`.
- `revenueConfig/{configId}`: write is now `isAdmin() && configId != "b2b_leads"`. The lead price has ONE writer, the
  validated and audited `adminSetB2bLeadPrice` callable. Admin reads are unchanged; a non-admin never matched `b2b_leads`.
- No recursive wildcard exists in the source, so no other block can OR-grant these paths.
- Index (2f): `b2bLeadStatement` queries `b2bLeads` by `supplierOwnerUid ==` and `month ==` (equality only), so it
  merges single-field indexes. Add a `(supplierOwnerUid, month)` composite only if prod asks for one.
- Suite `scripts/zz-test-b2b-leads-rules.js` (BL-L*, BL-M*, BL-P*, BL-R*, plus control BL-P4). **EMULATOR PENDING** (host
  memory is below the 512 MB floor). Baseline f259c0b5: BL-P1 must fail there.

## 2026-10-03: Jobs Board containment (three LIVE holes, verified on served f259c0b5)

1. `jobs` (legacy block): `create, update: false`; `delete: isAdmin()`. Live, any signed-in user can write a job with
   `status:'active'`, which is public through the second `jobs` block, with any `employerUid` and counters, bypassing
   `functions/jobs.js` validation. The poster can also rewrite `status` / `employerUid` / `expiresAt`.
2. `jobApplications` (legacy block): `create: false`. Live, the client picks the doc id, so an attacker can pre-create
   `{jobId}_{victimUid}` (the victim's `applyForJob` then returns `alreadyApplied`) or plant applications carrying an
   employer's `employerUid`. Applications are created only by the `applyForJob` transaction.
3. `jobSeekerProfiles`: read is now `isAdmin() || owner`. Live, it is `isAuthed()`, so any signed-in user reads raw
   `cvUrl`, defeating `getJobSeekerProfile`'s deliberate redaction.

No live client depends on the removed paths: `git grep` on 72dca56 finds only `sokoni-jobs.js:981`, a read of
`jobs where employerUid == uid`, which is kept (JR-J8). Hotfix-sized: these three hunks can be cut onto the served
ruleset as their own release if the owner wants them before the combined release. Owner decision.
Suite `scripts/zz-test-jobs-rules.js` (JR-J*, JR-A*, JR-P*, with controls). **EMULATOR PENDING** (196 MB free).
Baseline f259c0b5: JR-J1/J2/J3, JR-A1/A2 and JR-P1 must FAIL there.

## HELD 2026-10-03: providerAvailability server-only (sokoni-b2, owner: availability is server-authoritative), NOT APPLIED

Proposed: `providerAvailability/{uid}` read isAuthed, create/update/delete false; `/overrides/{date}` read isAuthed,
write false. Server writer: bookingDispatch availability callables (b2 feat/legal-hub-on-9cab901 @ 610d707, AV1–AV3).
- **It must REPLACE the existing block** at source line ~3823 (owner create/update, overrides owner write). A second
  `match` would OR with that block and keep client writes open.
- **BLOCKER:** `availability-manager.html` on the e3/techhub hosting chain is still a client-writing editor shared with
  the Merchant V2 shop schedule (6775b09; test-availability-convergence 34/0 asserts those writes). 2f's line replaces
  it with an A2 router (8d127ab). Until the owner or the assembly picks one, denying the writes breaks that page.
  b2 is asking 2f who owns the shop-availability choice. Apply only once that is resolved, with an emulator suite and a
  served baseline.

## 2026-10-03: Education (sokoni-5b hunks)

1. `education/{docId}`: `create, update, delete: false` (admins included); read unchanged. An orphan collection: no
   writer in any lineage, but three live triggers (`ts_education_*`) index every write into Typesense
   `sokoni_education`, so client writes were a search-injection path. Trigger deletion and the index purge are separate
   owner-gated steps (5b).
2. `educationEnterprises/{uid}`: read admin or owner; write false. Written by `applicationLifecycle`
   (5b feat/education-applications-on-cbbce0c @ 2cdc1b3).

Suite `scripts/zz-test-education-rules.js` (ED-W*, ED-R*, ED-E*). **EMULATOR PENDING.** Baseline f259c0b5: ED-W1/W2/W3
must fail there.
3. (later the same day) `learnerProfiles/{uid}` owner/admin read; `guardianLinks`, `guardianCodes`, `educationAudit`
   admin read only; all four write false. Written only by the `educationLearner` callable (5b @ 95f4317). Guardian
   identity never reaches a teacher or the public (owner), so guardians and learners see links only through the
   callable. Rows ED-L1–L11 added to the same suite. **EMULATOR PENDING.**

## 2026-10-03: receipts + B2B recovery ledger explicit deny (sokoni-2f)

`transactionReceipts/{id}` (plus `/events/{eid}`), `transactionReceiptFailures`, `receiptReconciliationExceptions`,
`b2bLeadRecoveries` and `b2bLeadOverpayments` are `read, write: false` for every client, admins included. Reads go
through `myTransactionReceipts` (scoped to the caller) and `adminSearchReceipts` (audited). Default deny already
applied; the explicit blocks make the owner's "customer reads another customer's receipt → reject" provable. A client
pre-creating a `b2bLeadRecoveries` op header would make a settlement replay as "already done" and skip the deduction;
RC-8 covers that. Rows RC-1–RC-10 are in `zz-test-b2b-leads-rules.js`. **EMULATOR PENDING.**
4. (later) `trainingInvites/{code}` and `trainingAssignments/{id}`: admin read only, write false. Written by the
   `educationEnterprise` callable (5b @ 70cb7e0). A company receives only display name + its own label through the
   callable. Rows ED-T1–T7. **EMULATOR PENDING.**
5. (later) `programmes/{id}`: admin read only, write false. Written by `manageMyProgrammes` (5b @ 1822cb0), which also
   serves the owner; public display comes through a server read. Rows ED-P1–P4. **EMULATOR PENDING.**
6. (later) `courseLessons/{id}` admin read only; `learnerCertificates/{id}` admin or owner (`uid`) read; both write
   false. Written by the `courseLessons` callable (5b @ 36cc6d8), which serves lessons only to enrolled learners, free
   previews or the owner. Rows ED-C1–C5. **EMULATOR PENDING.**
7. **storage.rules** (5b): `learner-photos/{uid}/{file}` (learners may be minors) is owner/admin read only, with owner
   write of a safe image < 2 MB matching a strict file-name pattern. `course-materials/{ownerUid}/{courseId}/{file}` is
   owner/admin read only (paid content; learners read only through the courseLessons 15-minute signed URL), with writes
   limited to the instructor of a DRAFT course through a `firestore.get` cross-service check. That check needs the
   Storage service agent's Firestore access in production; without it those writes fail CLOSED. OOXML office types are
   allowed and contentType is client-declared, so the server should verify file type. The callables store paths, never
   download URLs. Suite `scripts/zz-test-education-storage.js` (ES-P1–9, ES-M1–8; needs the storage + firestore
   emulators). **EMULATOR PENDING.**

## 2026-10-03: Construction containment, open RFQ PII (owner "contain now")

`constructRFQs` read was `status == 'open' || admin || owner`, so any open RFQ (with the buyer's name + phone) was readable
by anyone, signed out included (verified on served f259c0b5). It is now `admin || owner`. The hunk is in the combined
candidate AND in the hotfix file `firestore.rules.hotfix-jobs`. A rules release replaces the whole ruleset, so a second
hotfix cut from served would revert the first; the two security fixes therefore ship as ONE narrow rules release. The
hotfix diff vs served is now the three Jobs hunks + this one (44 lines). Rows CR-1–CR-4 are in `zz-test-jobs-rules.js`;
baseline f259c0b5: CR-1/CR-2 must fail. **EMULATOR PENDING.** The rest of the construct* client-writable holes
(constructOrders price/status, constructProviders status/rating, constructQuotations, constructReviews) stay for the
full Construction build, which retires those collections behind server authorities.
8. (later) `courseLessonHistory/{id}` admin read, write false (5b @ d990f2b). Rows ED-H1–H3. **EMULATOR PENDING.**

## 2026-10-03: product enquiry = lead (`contactRequests`), Construction convergence

The ONE in-app "contact the seller" record (product page → the seller's merchant-v2 Enquiries; b2's df1a4cb client).
The served rule let a buyer name ANY `sellerUid`, which allowed planting enquiries on another seller, a free status and
extra keys. The block is REPLACED (not duplicated) with:
- **Create:** the caller is the buyer; `sellerUid == products/{productId}.sellerUid` via `get()`; no self-enquiry;
  `status` 'pending'; a fixed key set (the exact df1a4cb payload); message ≤ 1000.
- **Seller:** moves the lead only along `leadNext()`:
  `pending → responded / contacted → qualified → quote_requested → quote_sent → negotiating → won`, with `lost` from
  any open state. Note-only edits are allowed.
- **Buyer:** may cancel their own open lead. `expired` is server-only.

Suite `scripts/zz-test-contact-requests-rules.js` (CQ-C*, F1–F6, S1–S7, X1–X2, B1–B2, A1). **EMULATOR PENDING.**
Baseline f259c0b5: the forged-seller, planted-status and lifecycle-jump rows must fail there.

## 2026-10-03: equipment rental (Construction convergence)

`rentalProducts` and `rentalBookings` had NO rule, so `rental.html` could never load. Both are written only by the
marketplace-extensions rental callables (server price, date-conflict check, `_assertSeller`). `rentalProducts` is read
when `status == 'active'`, or by the lister (`createdBy`) or an admin. `rentalBookings` is read by the renter
(`buyerId`) or an admin; shop owners read theirs through `rentalList`, which asserts the seller. Every client write is
false. Rows RN-1–RN-8 are in `zz-test-contact-requests-rules.js`. **EMULATOR PENDING.** Paid rentals stay closed: rental
commission is UNPRICED (2f refuses `category_unpriced`) until the owner sets it.
9. (later) `courseReviews/{id}` admin read, write false (5b @ 8a3e22b). Rows ED-R1–R3. **EMULATOR PENDING.**

## 2026-10-03: application decision fields (sokoni-e3 finding, served f259c0b5)

Served: an applicant's `applications` update checks only `noAdminFields()`, which omits `status`, `decidedBy`, `decidedAt`
and `reviewedBy`. So an applicant can mark their own application approved and forge the decider. The combined
candidate already closes this with `appNoDecision()` (no decided status or decision metadata on create or update) and
`appUndecided()` (no owner edit after a decision). The gap that remained: `reviewedBy` / `reviewedAt` were not in the
decision list, and they are now. Suite `scripts/zz-test-applications-reviewer.js` (AR-1–8). **EMULATOR PENDING.**
Whether any LIVE consumer acts on a forged status is sokoni-5b's question (applicationLifecycle); e3's Construction
Verification view already trusts only `verified === true`.

## 2026-10-03 P0: application decision fields — SERVED-based HOTFIX (owner via sokoni-5b)

The hotfix file `firestore.rules.hotfix-jobs` (re-fetched served f259c0b5, still identical) now carries FOUR narrow fixes as
ONE rules release: Jobs ×3, the construction open-RFQ PII fix, and this one. Its `applications` block:
- **Create:** no decision key (`appDecisionKeys()`, 26 keys from 5b's list); status `pending` / `pending_review`
  (business-apply).
- **Update:** no decision key touched; editable only while the application is `pending` / `pending_review` /
  `info_requested`; the only owner status move is `withdrawn` (complete-application).

5b's spec said "create status absent or pending only", which would have broken business-apply's `pending_review` and
complete-application's withdraw (K13-C), so both are admitted narrowly. The combined candidate's `appNoDecision` list now
carries the same 26 keys (+17), so the combined release cannot regress the hotfix. Rows AR-9–AR-14 are added; run them
against BOTH files. **EMULATOR PENDING.**

## 2026-10-03: Sports server-only collections (sokoni-2f, sportsDispatch @ a2d55b4)

REPLACED (no duplicates; one block each):
- `teams`: read when approved / archived, or by owner / captain / managers, or admin.
- `tournaments`: unpublished states private to the organiser; a missing status reads as draft (fail closed).
- `sportsTournamentRegs`: admin read.

NEW: `sportsTeamMembers` (own doc only) and `sportsFixtures` (public read). All writes are false (sportsDispatch only).
Two safety tweaks on 2f's hunks, both covered by rows: `managerUids` is read with a default, so a missing list can't make
the expression error; a missing tournament status reads as draft. Untouched by owner rule: sportsPlayers / sportsCoaches /
sportsPosts (no server writer yet), sportsVenueBookings (owner b6f9cee) and sportsReviews (1925aaa). Retiring
sportsOrders / sportsCoachBookings waits for zero-writer evidence. **Ships AFTER the functions carrying sportsDispatch.**
Suite `scripts/zz-test-sports-rules.js` (S-R1a–g, R2a–d, R3a–f, R4a–b, R5, R6, R7). **EMULATOR PENDING.**

## 2026-10-03: providers approval fields (sokoni-5b found, sokoni-e3 traced; served f259c0b5)

Served: the providers owner-update rule protected only status / verified / suspended / approved and never called
`noAdminFields()`; create lacked `approvalDecision` and `business`. So an owner could write
`approvalDecision {decision:'approve', source:'admin_decision'}`, `adminApproved`, `approvedAt` / `approvedBy`,
`business.category` and `commissionRate`, and could overwrite an admin's refusal. Live providerDispatch
approval-remediation (00050-rur) trusts `approvalDecision` with no admin check; advisory today, but one forgeable
authority. The combined candidate already locked `business`, `approvedAt` and `status` (provider trust lock). Added to
`providerTrustKeys()`: `approvalDecision`, `approvedBy`, `adminApproved`, `commissionRate`, `education`, `discovery`,
`_noIndex`, and the marketing category fields. The owner update path now also calls `noAdminFields()`. PT-D rows exist per
key, and PT-C rows cover the create path. **EMULATOR PENDING.** Like the applications P0, this could join the served-based
hotfix if the owner rates it P0; today it rides the combined release.
