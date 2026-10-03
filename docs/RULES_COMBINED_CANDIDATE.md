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
