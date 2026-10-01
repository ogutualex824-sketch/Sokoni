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
