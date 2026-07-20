# Identity Link Migration — phone ↔ Google

**Status:** PLAN ONLY. Nothing in this document has been executed.
**Scope:** merging `alexochieng3030@gmail.com` and `+254705726803` into one Firebase Auth identity.
**Related:** [[Authentication]] · [[Access Control Matrix]] · [[Account Manager]]

---

## 1. The finding that determines everything

**This is a data migration, not a login-flow change.** That distinction is the whole plan.

SOKONI already has account-linking code — `auth.js:279-296` (Google) and `auth.js:1500-1523`
(generic/Facebook). Both call `linkWithCredential(user, pendingCred)`, which attaches an additional
**provider** to a user who is **already signed in**. Neither merges two users.

Two things follow, and both are load-bearing:

1. **A Firebase Auth UID is immutable and cannot be merged.** `linkWithCredential` fails with
   `auth/credential-already-in-use` when the credential belongs to an existing account — which is
   exactly this case. One of the two Auth users must be **deleted** before the other can absorb its
   credential. There is no merge primitive.

2. **The existing path cannot fire here anyway.** Linking is only triggered by Firebase raising
   `auth/account-exists-with-different-credential` (`auth.js:954, 1015, 1032, 1199`). That error is
   raised on an **email** collision. A phone credential carries no email, so a phone/Google pair
   never produces it.

Verified negative: a repo-wide search for `mergeUid|migrateUid|oldUid|newUid|transferOwnership|
mergeAccounts|reassignUid` returns two hits, both a listener refresh in
`sokoni-notifications.js:266`. **No UID-migration tooling exists.** `functions/account-manager.js`
does deletion, export and session revocation only.

---

## 2. Survivor selection

**The phone UID survives.** Not a preference — it is where the value is:

| | `+254705726803` | `alexochieng3030@gmail.com` |
|---|---|---|
| Seller role | yes | no |
| KASS VAPES identity | yes | no |
| Vape products (`products.sellerUid`) | yes | no |
| Buyer history | unknown — **must be audited** | unknown — **must be audited** |

Migrating *to* the Google UID would mean moving the seller role, the storefront, every product, and
every order reference. Migrating *to* the phone UID moves whatever buyer history the Google account
accumulated, which is very likely far smaller. **Move the smaller side.**

This assumption is not yet evidenced. **Phase 0 exists to falsify it**, and if the Google account
turns out to hold orders, wallet balance or receipts, the plan changes rather than proceeds.

---

## 3. Why this is harder than it looks

A UID appears in SOKONI in two structurally different ways, and only one is a field update.

### (a) UID as the document ID — requires copy + delete, not update

`users/{uid}`, `sellers/{uid}`, `wallets/{walletUid}`, `subscriptions/{uid}`,
`sellerSubscriptions/{sellerUid}`, `shopSettings/{sellerUid}`, `verifications/{sellerUid}`,
`notificationPrefs/{prefUid}`, `userNotifPrefs/{userId}`, `platformEmployees/{uid}`,
`shopEmployees/{empUid}`, `landlordData/{uid}`, `securityDevices|securityMFA|securityPasskeys|
securityRisk/{userId}`, `driverLocations/{driverId}`, `deliveryRiders/{riderId}`,
`rideDrivers/{driverId}`, `aiBlocks/{userId}`.

Plus **sub-collections**, which do not move with their parent and must be walked explicitly:
`userSync/{uid}/{kv,products}`, `userProgress/{uid}/{...}`, `users/{uid}/loyalty/{...}`,
`sellerBilling/{sellerUid}/monthly/{period}`.

`userSync/{uid}/products` is worth calling out: it is what the merchant dashboard's product list is
hydrated from (`sokoni-sync.js:255`). Miss it and the merged account has a working storefront and an
empty dashboard.

### (b) UID stored in a field — batched updates

`sellerUid` across ~35 collections (products, orders, escrows, invoices, commissions, payouts…),
`buyerUid` across ~25, plus `ownerUid`, `createdBy`, `driverUid`, `providerUid`, `userId`,
`customerUid`.

**`firestore.rules` is not a complete inventory.** Raw occurrence counts in application code are far
higher than the rules file covers — `customerUid` appears 44 times in code and **zero** times in
rules. Any enumeration taken from rules alone is a floor, not a ceiling. Phase 0 must enumerate from
live data.

### (c) Things that are not Firestore

- **Firebase Storage** paths keyed by uid (`profile-avatars/{uid}/…`, `storage.rules:106`).
- **Custom claims** — must be re-minted on the survivor, not copied blindly.
- **Auth-linked artefacts** — refresh tokens, MFA enrolments, passkeys. Passkeys are bound to the
  Auth user and **cannot be migrated**; they must be re-enrolled.
- **eTIMS / financial records.** See §6.

---

## 4. Phased plan

### Phase 0 — Audit (read-only, no changes)

Deliverable: a written inventory before anything is touched.

1. Resolve both UIDs via `admin.auth().getUserByEmail()` and `getUserByPhoneNumber()`.
2. For every collection in §3, count documents owned by each UID.
3. Flag any collection where **both** UIDs hold documents — those are merge conflicts, not moves.
4. Flag financial records under either UID: `wallets`, `escrows`, `commissionLedger`, `payoutRequests`,
   `etimsInvoices`, `sellerBilling`.
5. Confirm or refute the §2 assumption that the Google account is the smaller side.

**Gate:** if the Google UID holds wallet balance, settled orders or eTIMS invoices, stop and
re-plan. Those are not movable by a field rewrite (§6).

### Phase 1 — Preparation

1. **PITR checkpoint** and record the timestamp. This is the rollback anchor.
2. Export both `users/{uid}` documents verbatim.
3. Write the migration as an **idempotent, resumable** job — deterministic batch IDs, a progress
   document, safe to re-run after a crash. A half-completed identity migration is a worse state than
   either endpoint.
4. Dry-run mode that writes nothing and emits the exact mutation list for review.

### Phase 2 — Execution (single maintenance window, account signed out)

1. `revokeRefreshTokens` on both UIDs. Migrating under a live session risks writes landing on the
   dying UID.
2. Copy doc-ID-keyed documents and their sub-collections from Google-UID → phone-UID, **merging
   rather than overwriting** where the survivor already has a document.
3. Batch-update field-stored UIDs, ≤500 writes per batch.
4. Migrate Storage objects.
5. Verify counts match the Phase 0 inventory. **Do not proceed on a mismatch.**
6. Delete the Google Auth user.
7. Sign in as the phone account and `linkWithCredential` the Google credential — this is where the
   existing `auth.js` code finally applies, and only after the collision is gone.
8. Re-mint custom claims on the survivor; confirm `seller` and `betaStatus` are intact.

### Phase 3 — Verification

Run `sokoni-merchant-diag.js` on the merged account across every merchant page. It already reports
identity, claims, role split, product census across all three sources, and permission failures —
which is the same evidence this migration needs.

Then confirm by hand: sign in with Google, sign in with phone, and verify **both** land on the same
uid with the seller role and three products present.

---

## 5. Rollback

| Phase | Reversible? | Mechanism |
|---|---|---|
| 0 | n/a | read-only |
| 1 | yes | nothing mutated |
| 2 steps 1-5 | yes | PITR restore to the Phase 1 checkpoint |
| 2 step 6 onward | **no** | Auth user deletion is irreversible |

**Step 6 is the point of no return.** Everything before it is a Firestore state that PITR can undo;
Auth deletion is not covered by PITR. Treat steps 1-5 as the reversible migration and step 6 as a
separate, explicitly-authorised decision made only after step 5's verification passes.

---

## 6. What must not be migrated silently

**Financial and statutory records are not ownership fields.** `commissionLedger`, `escrows`,
`sfosEscrow`, `payoutRequests`, `sellerBilling` and `etimsInvoices` record what happened between a
buyer, a seller and Bravilex at a point in time. Rewriting the UID on a settled ledger row changes
the historical record of a financial event.

**Recommendation:** leave historical financial rows on the original UID and record the merge as an
explicit `identityMergedFrom` / `identityMergedTo` mapping, so reporting can resolve both to one
person **without** rewriting history. eTIMS invoices in particular are KRA submissions and should be
treated as immutable.

This means the merge is **not** "one UID disappears everywhere". It is "one UID becomes the login,
and history remains attributable". That is the correct outcome, not a compromise.

---

## 7. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Auth deletion is irreversible | **Critical** | Separate authorisation gate at Phase 2 step 6 |
| Enumeration misses a collection | High | Phase 0 enumerates from live data, not rules |
| Sub-collections skipped | High | Explicit walk; `userSync/{uid}/products` verified by diag |
| Both UIDs hold the same doc ID | High | Phase 0 flags; merge policy decided per collection |
| Financial history rewritten | High | §6 — map, do not rewrite |
| Passkeys lost | Medium | Cannot migrate; re-enrol after merge |
| Partial run leaves split state | Medium | Idempotent + resumable job, progress document |
| Writes land on the dying UID | Medium | Revoke tokens first; maintenance window |

---

## 8. Recommendation

**Do not run this migration to fix the current sprint.** It is irreversible at step 6 and its
benefit is convenience — one login instead of two.

The merchant-workspace defects found this sprint are **not caused by the split identity**. They are
a product-source divergence (`sokoni-sync.js:255`), unscoped queries denied by rules
(`seller-analytics.html:396`), and a stale denormalised `sellerName` (`seller.js:673`). All three
reproduce on a single-identity account and all three are fixable without touching Auth.

**Fix the workspace first. Merge identities later, deliberately, with Phase 0 evidence in hand.**
