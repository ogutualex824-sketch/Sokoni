# `order-claim.js` — dedicated provenance/authority trace

**Read-only. Nothing committed, deployed, reset, or cleaned to produce this. Tier 1 remains frozen.
R1 and production untouched.**
**Date:** 2026-09-04 · **Trigger:** `docs/UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS.md` §2 classified
`order-claim.js` as **C — provenance missing**, the sole hard blocker on Tier 1 becoming a clean
deployable branch. This trace does not change that classification — provenance (who/why/approved)
is still unestablished — but it materially changes what evidence exists for the approval decision.
**Related:** [[UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS]] · [[MULTISHOP_STACK_PROVENANCE_MANIFEST]]

---

## 1. What the module actually does (full read)

`functions/order-claim.js` (179 lines) implements atomic, server-decided order claiming for
multi-cashier POS: when one online order is visible on many POS stations simultaneously, exactly
one employee/cashier may "take" it, decided inside a Firestore transaction rather than by whichever
client's popup renders first.

- `claimOrderFor(uid, orderId, {deviceId, token})` — the pure core. Runs inside
  `db.runTransaction`: reads the order, checks `_mayActForShop` (owner / admin / a `shopEmployees`
  grant), refuses terminal states (`completed`/`cancelled`/`refunded`/`rejected`), and — the actual
  race decision — checks `d.claimedBy`: unset → claims it; set to the same caller → idempotent
  success (a double-tap or reconnect is not a loss); set to someone else → clean refusal.
- Two `onCall` wrappers: `claimOrder` (App Check enforced) and `releaseOrderClaim` (holder or admin
  only).
- **Scope discipline, stated and honored:** it writes ONLY `claimedBy` / `claimedByRole` /
  `claimedAt` / `claimDeviceId` / `claimStatus`. No order `status`, payment, inventory, commission,
  or notification field is ever touched by this module — verified by reading every write site in
  the file (two: the claim transaction, the release transaction, both scoped to exactly those five
  fields).

## 2. Three embedded technical claims, independently verified against the real, current codebase

The module's own comments make specific, checkable claims about the rest of the system. Verifying
them is a direct test of whether the author actually understood this codebase or was
guessing/hallucinating.

| Claim (verbatim from the file) | Verification | Result |
|---|---|---|
| *"`orderAdvance` (notify.js:727) reads then writes with no transaction anywhere in that file, so two cashiers can both advance the same order today."* | Read `functions/notify.js`'s `advanceOrder` (the function `exports.orderAdvance` calls): plain `await ref.get()` at the top, plain `await ref.update(...)` after business logic in between — no `runTransaction` anywhere in the function. | **TRUE.** Exact defect class, correctly diagnosed, in a different file than the one being written. |
| *"`shopEmployees/{uid}.shopOwnerId` is the grant: firestore.rules only permits creating that document when `shopOwnerId == request.auth.uid`."* | `firestore.rules:1432-1441`, the `shopEmployees` block: `allow create: if isAdmin() \|\| (isAuthed() && request.resource.data.shopOwnerId == request.auth.uid);` | **TRUE**, verbatim match. |
| (implicit) `shopEmployees` is a real, established, already-in-use collection, not invented for this module | 25 other files reference it — `functions/shop-employees.js`, `merchant-v2.html`, `merchant.html`, five census scripts, `scripts/test-shop-employee-authority.js`, `sokoni-merchant-staff.js`, `sokoni-merchant-team.js`, etc. | **TRUE.** Widely-used, committed, real infrastructure. |

All three check out exactly. This is not proof of authorization, but it is strong evidence against
"careless graft" or "hallucinated/generated filler" — whoever wrote this had accurate, specific,
line-referenced knowledge of the actual state of two other real files at the time of writing.

## 3. A same-day companion test — found, and it runs

`scripts/test-order-claim-race.js` (also untracked, `??`) has mtime **2026-08-27 19:43** — two
minutes after `order-claim.js`'s own 19:41 mtime. This is the identical "module + its own
test/contract, written minutes apart" signature the provenance census already established for two
other clusters in this repo (manual-till-orders.js + its contract, 12 min apart; payment-destinations.js
+ checkout-mode.js, one second apart) — not a coincidence of timing, a consistent authorship
pattern across this whole body of work.

The test is real, not decorative: it **refuses to run without a live Firestore emulator**
(`FIRESTORE_EMULATOR_HOST` required, no mocks, no stubs), and fires genuine concurrent contention
via `Promise.all` — exactly this session's own established standard for concurrency claims (no
"call it twice in sequence and call that a race test").

**Run against a real Firestore emulator this pass** (`firebase emulators:exec --only firestore
--project sokoni-claim-race "node scripts/test-order-claim-race.js"` — local, throwaway project id,
nothing committed or deployed):

```
A. 10 concurrent claimers → exactly 1 winner ............... 12/12 PASS
B. Winner double-tapping is idempotent ...................... 2/2 PASS
C. 10 orders × 10 stations, 100 concurrent claims .......... 6/6 PASS  (7 distinct winners — real spread, not a collapse)
D. Authority (cross-shop denial, owner claim) ............... 4/4 PASS
E. Terminal states (completed/cancelled/refunded) refused ... 3/3 PASS

27 passed, 0 failed
```

Every property the file's own header comment claims — exactly one winner under real contention,
clean idempotent re-claim by the winner, no cross-shop claiming, terminal states refused, the loser
causes zero side effects (`status` untouched, no `paymentStatus`/`inventoryApplied`/notification
flags written) — is independently, functionally proven, not just asserted in a comment.

## 4. What this does and does not establish

**Does establish:** the code is real, carefully engineered, internally consistent with the rest of
the codebase, technically accurate in its stated assumptions, and functionally correct under the
exact concurrency scenario it exists to solve. It is the same caliber of work as the other
already-catalogued clusters in `docs/MULTISHOP_STACK_PROVENANCE_MANIFEST.md`, several of which this
session's own prior traces (`docs/SOKONI_TILL_QR_PAYMENT_TRACE.md`, `docs/COMMISSION_INVOICE_SPEC.md`)
already independently confirmed as "correct shape, deliberately built."

**Does not establish:** who wrote it, under what authorization, as part of which effort, or whether
it was ever reviewed or approved for release. No commit, no ADR, no design doc, no contract
document names it anywhere in this repository's history or working tree. Code quality and
functional correctness are not provenance — per your framework, this stays **Category C**.

## 5. What changes for the decision you're weighing

Before this trace, "C — provenance missing" carried an implicit risk reading: an unaccounted-for
file, unconditionally required by production-lineage `index.js`, could be anything — including
something unsafe. After this trace, the uncertainty is narrower and better characterized: this is
not an integrity risk in the sense of "we don't know if this is safe," it is a **process** gap in
the sense of "this is verifiably real, tested, working code that nobody formally attributed or
approved before it landed in a commit's working tree." Those call for different remedies — the
first would need reconstruction or removal; the second needs only an explicit decision to attribute
and admit it, which is exactly the judgment call you reserved for yourself.

No action taken on the classification itself. Escalated back to you with the fullest evidence this
pass could gather.
