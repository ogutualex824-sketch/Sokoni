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
- [ ] sokoni-5b functions **`fix/review-authority-on-76436b1` @ `51d3947`** live (tests 48/0, sabotage 10/10 on their tree): `submitReview` with `property` + `sports_venue` (eligibility: `propertyViewings.buyerUid`,
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

**`b6f9cee` (2026-10-03):** `propertyViewings` browser create closed. Viewings make a buyer review-eligible, so `scheduleViewing` (server) is the only writer. sokoni-5b found the forgeable create; tests H-6/H-6b/H-6c. **Open owner question:** `sportsVenueBookings` is still browser-created (claimsOwner), so for sports, "has a booking" means "asked for one".
