# AdminOS `admin-os.js` Lineage Convergence — Build Report

**Branch:** `feat/adminos-convergence` (off `main` `9d42fa9`) · **Status:** built, UNMERGED, UNDEPLOYED
**Date:** 2026-09-01

## Contract (Gate-4 corrected spec A)
Converged `functions/admin-os.js` = **proven production baseline `252ff65`** (the source the live
`adminOsDispatch` archive is byte-identical to) **+ exactly one graft: the `adminGetAuditLogs`
`adminPermissions` pilot.** Nothing else from main's regressed lineage is carried.

## Provenance basis (independently established, Gates 2–3)
The deployed `adminOsDispatch → admin-os.js` archive is **byte-identical to `252ff65`**
(`feat(admin-os): P2 — System Health + Merchant Pipeline`, 2026-08-04). Production's exact source is
therefore pinned; using `252ff65` as the baseline reproduces live behavior with zero inference.

## Handler-by-handler provenance (55 registry entries + 2 dropped)
| Group | Count | Provenance | Action |
|---|---|---|---|
| Shared, byte-identical to production | 34 | `252ff65` | kept verbatim |
| **Regressions reverted** (`adminGetBookings`, `adminGetExecutiveDashboard`, `aosGetPendingPayouts`, `adminGetDisputes`, `adminGetReviews`, `adminGetSupportTickets`) | 6 | `252ff65` | production canonical restored; main's legacy-collection / dropped-envelope versions discarded |
| **Handlers restored** (`adminGetAnalytics`, `adminGetFinance`, `adminGetMerchantPipeline`, `adminGetNotifications`, `adminGetPayments`, `adminGetPayout`, `adminGetPayoutRequests`, `adminGetProviders`, `adminGetServices`, `adminGetSystemHealth`, `adminGetUsers`, `adminGetWallets`) | 12 | `252ff65` | were dropped from main; restored from production |
| Aliases (`adminGetOverview→adminGetExecutiveDashboard`, `adminGetReports→adminGetFinance`) | 2 | `252ff65:972-973` | restored |
| **Pilot** (`adminGetAuditLogs`) | 1 | `252ff65` body **+** `adminPermissions` `audit.read` graft from `feat/adminos-authority-core` (merged `3006358`) | production body + the one intentional main-forward change |
| **Dropped — production-retired** (`adminApprovePayouts`, `adminRemoveReview`) | 2 | retired in `252ff65:1087,1132` | NOT reintroduced |

`adminApprovePayouts` wrote the deprecated `payouts` collection (a no-op vs the real `payoutRequests`
queue; replaced by wallet engine `adminProcessPayout`). `adminRemoveReview` had zero callers and
duplicated moderation. Both were deliberately retired in production; main carried them only because
its lineage missed the `252ff65` canonical cleanup.

## Verification
- **Provenance diff** converged vs `252ff65`: 29 lines, **all the pilot graft** (helper + capability
  check + `const db` reshuffle); no other change → zero regressions reintroduced.
- **Zero-drop registry proof:** converged `_h` registry (55) is an **identical set** to the deployed
  `252ff65` registry (55) — no handler missing, none added.
- **Handler matrix** converged vs `252ff65`: 52/53 bodies byte-identical; only `adminGetAuditLogs`
  differs (the pilot). 0 live-only, 0 main-only.
- Syntax OK; `require()` loads; `_h` = 55 ops; `_adminCapabilityAllows` present.
- Full functions test suite **687/687**; Authority Core emulator suite **33/33** (incl. the four
  pilot capability checks against the converged file).

## Boundaries
No change to `adminOsDispatch`, `admin-os-dispatch.js`, `firestore.rules`, Finance/F2–F9, wallet,
commission, `SokoniPermissions`, or any other excluded surface. No merge, no deployment. The
`adminOsDispatch` deployment remains a separate, later gate.
