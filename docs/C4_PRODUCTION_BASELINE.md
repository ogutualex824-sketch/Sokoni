# C4 Production Baseline — registration and approval authority

> Convergence programme · C4 · read-only production inspection on **2026-09-28**
> Related: [[C4A_REGISTRATION_AUTHORITY_SURVEY]] · [[C3_DISCOVERY_CERTIFICATION]] · [[BUSINESS_CATEGORY_AUTHORITY]]

**This document records what was verified in production, read-only, on the inspection date.** It does not claim that
repository code reflects production, and it does not authorize any production change.

## Scope and method

**Read-only: code and rules only.**
- No Firestore document was read.
- Nothing was written, deployed, migrated or changed in production.

**Rules** were fetched from the Firebase Rules REST API: the release pointer, then that exact ruleset. They were
preserved byte-for-byte as returned, and every verdict below is read from the SERVED text, not from any repository
file. Every duplicate `match` block was checked for brace depth: a nested path is not a duplicate. The `users` "second
block" is `typingIndicators/{c}/users/{uid}` (depth 3) and is NOT a finding.

**Functions** were read from their OWN deployed source archives (`buildConfig.source.storageSource`, downloaded at the
pinned generation). Verdicts come from the deployed files, not from the function name, and not from any branch.

### Served rules

| Release | Ruleset | Source | Bytes | sha256 (prefix) | Pointer updated |
|---|---|---|---|---|---|
| `cloud.firestore` (default) | `6c67a34d-bb07-4fd5-8934-32d6b547a276` | `firestore.rules` | 158,659 | `f12e3648e5a5c719` | 2026-09-22T20:19:30Z |
| `cloud.firestore/sokoni-ops` | `c76c080c-5073-4b3d-94bc-53d6d8254516` | `firestore.rules.sokoni-ops` | 674 | `ee81c9cd04c58720` | 2026-09-13T14:38:42Z |
| `firebase.storage/sokoni-aeb26.firebasestorage.app` | `182624f3-7088-49de-ad72-a4c4701cb9f2` | `storage.rules` | 12,327 | `a9f1d0d7cc367ed4` | 2026-08-11T05:18:05Z |

### Deployed functions inspected

1,721 functions are deployed.

| Function | Archive generation | Archive md5 (prefix) | Updated |
|---|---|---|---|
| `accountReactivate` | 1787384652618420 | `6f155e8b5e0e` | 2026-09-09 |
| `saveShopProfile` | 1787384729165626 | `6f155e8b5e0e` | 2026-09-09 |
| `autoOnSellerApplication` | 1787386675311900 | `6f155e8b5e0e` | 2026-09-09 |
| `wapApproveStep` | 1787384409648894 | `6f155e8b5e0e` | 2026-09-09 |
| `wapTriggerWorkflow` | 1787384404321485 | `6f155e8b5e0e` | 2026-09-09 |
| `providerDispatch` (`providerPublish`) | 1787386174474483 | `6f155e8b5e0e` | 2026-09-09 |
| `kass` | 1787383897310985 | `6f155e8b5e0e` | 2026-09-09 |
| `registerHealthProvider` | 1787385898119373 | `6f155e8b5e0e` | 2026-09-09 |
| `grantPlatformRole` | 1787383897259345 | `6f155e8b5e0e` | 2026-09-09 |
| `smartPosDispatch` | 1788294400928902 | `5adab3e1d949` | 2026-09-09 |
| `applicationLifecycle` | 1788716739456910 | `c52e2338a24b` | 2026-09-09 |
| `applicationDecide` | 1787598887701693 | `b996425e38a4` | 2026-09-09 |
| `setUserRole` | 1788256990847659 | `d2f921282c2c` | 2026-09-09 |

`adminUpdateUserRole` is not deployed as a standalone function.

## Verdicts

| Authority | Production | Evidence (deployed / served) |
|---|---|---|
| **`providerPublish`** (P0) | 🔴 **LIVE** | The deployed `provider-onboarding.js` is the version BEFORE the branch fix (OB-1). A caller whose `providers/{uid}` is not `suspended` gets it set `status:'active'`, `searchable`, `isPublic`, `acceptsBookings`, `available`, and the `provider` claim is minted **unconditionally**. There is no application and no admin. The preconditions are all self-supplied: `assertLegalCompliance` is dark-launched; profile and coverage come from the applicant's own draft; `providerActivateSubscription` accepts `free_trial` with no payment, and even a paid plan is set `active` from an unverified, optional `paymentRef`. The dispatcher routes `providerPublish`. **The branch's fix is committed, not deployed.** |
| `accountReactivate` (K2) | 🔴 **LIVE** | No check that the account was ever deactivated. `_restoreMerchantSurfaces` sets `providers.status` to the stash, or `'active'` when there is none. The served `providers` create lets any user create their own doc as `pending`, so this is a second self-approval route. (The file differs from the repo; the vulnerable logic is identical.) |
| Application-decision triggers (**K13**, new) | 🔴 **LIVE, weaker than the repo** | The deployed `decisionAuthority` checks ONLY that `after.decidedBy` resolves to an account with an admin claim; it does **not** consult `applicationDecisions`. The trigger takes `status` from the document, and intake normalisation does not touch `status` / `decidedBy`. The served `applications` rule lets the applicant write both. So an applicant who knows any admin uid can self-approve. |
| `saveShopProfile` (K8a) | 🟠 **LIVE** | Auth is the only guard. It creates `shops/{uid}` with `status:'active', isVisible:true`. Reach is bounded: the served `products` create requires `isSeller()` (`token.seller == true`). |
| `smartPosDispatch.createBusiness` (K8b) | 🟠 **LIVE** | Auth only. It creates active `businesses` and `merchants` records, and honours a caller-supplied `__provisionedBy:'approval'`. It may be intended self-serve POS onboarding: **owner decision**. |
| `autoOnSellerApplication` | 🟡 **Deployed, enabled, starved** | Automatic approval is enabled. The served rules have no `sellerApplications` block, so clients are denied, and no inspected archive writes it (see limitations). |
| Workflow approval (WAP `seller.activate`) | 🟡 **LIVE, staff approver** | Non-canonical. The approve step trusts `claims.role` / `eccRole` rather than `token.admin`. |
| Kass `approve_seller` | 🟡 **LIVE, admin + MFA** | Non-canonical: it writes `providers.status` directly. Assigned to C8. |
| `registerHealthProvider` | 🟢 no self-activation | Writes the legacy registry as `pending` only. |
| Business-collection rules | Mixed | 🔴 **LIVE:** `sellers`, `stores` (with a mutable `ownerId`), `mechanics`, `homeServiceProviders`, `constructProviders`, `marketingProviders` accept a client-set `status`. ✅ **NOT LIVE:** `businesses` (create `false`; owner update allowlisted without `status`), `shops` (admin create, allowlisted update), `rideDrivers` (`write: false`). **These are STRICTER in production than on the branch.** |
| `applications` rules | 🔴 **LIVE, weaker than the repo** | `create: claimsOwner() && noAdminFields()`. There is no decision guard: `status` (any value) and `decidedBy` are applicant-writable. |
| `providers` owner-update rules | 🔴 **LIVE, weaker than the repo** | Blocks only `status`, `verified`, `suspended`, `approved`. The owner can write `featured`, `adminApproved`, `commissionRate`, `role`, `isAdmin`, `business`, `healthcare`, `legalProviderId`, `provisionedBy`, and the rating keys. |
| `verifications`, `verificationRequests` | 🔴 **LIVE** | `verified` / `approved` can ride along on a `pending` create. |
| Duplicate `propertyListings` block | 🔴 **LIVE** | Two TOP-LEVEL blocks (depth 2). The second's `allow create: if isAuthed() && noAdminFields()` has no owner binding and ORs with the first. |
| Storage document rules | 🔴 **LIVE** | `/documents/{uid}/…` and `/kyc-documents/{uid}/…` are keyed by uid only, with no application id, and writable after review. They match the repository text. |

## Undetermined — stated, not assumed

1. **Admin-uid discoverability (K13).** Whether a normal user can learn an admin's uid was **not tested**, because it
   requires Firestore document reads, which are a separate authorization boundary. Until tested, K13 is treated as
   exploitable, not as safe.
2. **`sellerApplications` writers.** The census was **not exhaustive**: only five distinct deployed source archives were
   inspected for that writer, out of 1,721 deployed functions.

## Consequences for remediation (owner decisions, 2026-09-28)

- **Order:** `providerPublish` → K2 → K13 → the remaining C4 rules hardening → C4b canonical intake.
- **Rules are never deployed wholesale from this branch.** Production is stricter than the branch for `businesses`,
  `shops` and `rideDrivers`. Every rule remediation is applied against the SERVED production rules lineage, preserving
  those protections.
- **K13's fix** combines the stronger decision check (`applicationDecisions` + admin) with the matching served-rules
  guard.
- **Each remediation is built, tested, sabotaged and baselined first.** Deployment is a separate, explicit
  authorization. Recording this baseline authorizes nothing.
