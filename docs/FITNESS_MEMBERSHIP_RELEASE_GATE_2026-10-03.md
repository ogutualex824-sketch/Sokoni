# Fitness memberships — integration release gate (2026-10-03)

**Integration branch:** `integration/fitness-membership-2f`. It is built from sokoni-e3's attendance tip `3d315a2`, then:
- merge of the commercial baseline `fe33bcc` (no-ff; provenance kept; only CHANGELOG conflicted, with both sides kept)
- cherry-pick `-x` of sokoni-b2's `25ef259` (feature-switch fix), plus its test helper `scripts/lib/inmem-firestore.js` from the same commit

**NOT DEPLOYED.** Nothing here is user-ready: the emulator and browser evidence does not exist yet.

**Related:** [[COMMERCIAL_CONVERGENCE_2026-09-30]] §13–14 · [[FITNESS_MEMBERSHIP_ATTENDANCE]]

## Ownership (unchanged from §13.5; no conflicts found)

| Owner | Releases |
|---|---|
| Commercial (sokoni-2f) | price defaults, payment purpose, webhook hold code, refunds, payouts, commission, sales predicate |
| sokoni-e3 | offers, creation + snapshot + payBy, attendance / QR / staff, rules, member / gym / AdminOS screens |
| sokoni-5b | the LIVE webhook port of the hold (not done) |
| sokoni-b2 | AdminOS `adminUpdateFeatureFlag` (fixed in 25ef259, carried here) |

## Feature switch disposition

| Case | Writer (AdminOS, 25ef259) | Reader (`shared/fitness-sales-switch` + creation copy) | Evidence |
|---|---|---|---|
| boolean `true` | written | ON | F1 · F-3 |
| boolean `false` | written | OFF | F1 |
| omitted | **refused** (invalid-argument) | OFF | F-1 · F1 |
| `null` / `"true"` / `1` / other | refused | OFF | F-2 · F1 |
| read error | — | OFF (fail closed) | F1 · creation C18 |

**Disposition:** the fail-open default is **REPAIRED IN CODE** (25ef259) and must ship in the same release; until then it is BLOCKED (b2 deploy). sokoni-e3's AdminOS fitness switch screen is **not on any branch yet** (UNPROVEN). Today the only writer is the generic AdminOS flag editor (`sokoni-aos.js updateFlag`), which sends an explicit boolean.

**Closed (d5fbd37):** `fitness-membership-create.js` imports `shared/fitness-sales-switch.js`, and its own copy is deleted (C19 asserts a single read site). An unreadable flag now logs `FLAG_UNREADABLE` (warn) and stays OFF.

## Release matrix

| Area | Owner | Test | Result | Evidence | Status |
|---|---|---|---|---|---|
| Money side (payment, hold, late refund, refunds, exception, payouts, notifications, prices, switch) | 2f | test-membership-settlement | 77/0 | integration tree | PROVEN (unit) |
| Commission schedule | 2f | test-commission-schedule | 25/0 | integration tree | PROVEN (unit) |
| Fixed / flat lanes | 2f | test-pos-fixed-rate-bypass | 32/0 | integration tree | PROVEN (unit) |
| Hub plans | 2f | test-hub-plan-entitlements | 17/0 | integration tree | PROVEN (unit) |
| Refund after settlement | 2f | test-service-settlement-reversal | 7/0 | integration tree | PROVEN (unit) |
| Attendance / QR / staff | e3 | test-fitness-attendance | 48/0 | integration tree | PROVEN (unit) |
| Creation + snapshot + payBy + flag (shared predicate, single read site) | e3 | test-fitness-membership-create | 23/0 | integration tree | PROVEN (unit) |
| Offer module (day/week/month limits = slicesOf; all 6 defaults valid) | e3 | test-membership-offer-module | 8/0 | integration tree | PROVEN (unit) |
| Feature switch writer | b2 | test-feature-flag-update | 4/0 | integration tree + 25ef259 | PROVEN (unit) |
| Healthcare / entertainment / events | various | suites | 40/0 · 95/0 · 111/0 | integration tree | PROVEN (unit) |
| Provider plan table | 2f | test-provider-plan-ladder | 38/0 | integration tree | PROVEN (unit) |
| Webhook suite | 5b | test-creator-callback | 74 pass / 4 fail | same 4 labels as HEAD | PRE-EXISTING FAILURE |
| Firestore rules + emulator flows | e3 / all | — | — | free RAM 348 MB < 512 | BLOCKED (memory) |
| Member / gym / AdminOS / Super Admin browser flows | e3 | — | — | RAM | BLOCKED (memory) |
| Live webhook hold | 5b | — | — | port requested (after P0 + REVIEW slices) | BLOCKED (5b) |
| AdminOS fitness screen (lifecycle, why-locked, refunds via membershipDecideRefund / membershipRequestException, explicit-boolean switch with re-read) | e3 | e3 AdminOS suite | 16/0 (3/3 controls) | hosting d70eca5 | PROVEN (unit) |
| Price consistency: editor pre-filled from fitness-offer-defaults → offer → membership snapshot → intent | e3 / 2f | D1–D3 + e3 OF-DEF row + snapshot test | pass | functions c90e526 + hosting d70eca5 | PROVEN (unit) |

## Next release gate
1. When free RAM is ≥ 512 MB, run on THIS branch: the e3 rules suite + emulator flows, then the browser flows (member, gym, AdminOS, Super Admin).
2. sokoni-e3 imports `shared/fitness-sales-switch` and pre-fills its offer editor from `shared/fitness-offer-defaults`.
3. sokoni-5b ports the hold into the live webhook and runs creator-callback + test-membership-settlement on its tree.
4. One release set, scoped deploy targets only, after the owner's explicit approval.

## Update (later 2026-10-03)
- Re-merged sokoni-e3's `d5fbd37` and commercial `9cab901` (vehicle sales 2%; agreement suite amended; switch warning). Only CHANGELOG conflicted, with both sides kept.
- The offline suite set is all green on the integration tip, plus `test-commission-5pct-agreement` 62/0. creator-callback still shows the same 4 pre-existing failures.
- Still UNPROVEN: the gym offer editor pre-fill and the AdminOS fitness screen (sokoni-e3's hosting branch, in progress).
- Still BLOCKED: emulator / browser (RAM) and the live webhook (sokoni-5b).

## Certification pair (later 2026-10-03)
Functions `integration/fitness-membership-2f @ c90e526` (+ e3 6d555b7: audit method 'qr', 5 composite indexes) · Hosting `hosting/fitness-memberships-on-31f5844 @ d70eca5` (e3: UI 51/0, AdminOS 16/0, containment 16/0). AdminOS / Super Admin link wiring is an assembly-time diff (docs/FITNESS_MEMBERSHIP_UI.md) so live never links to pages before their server exists. Runtime still BLOCKED (RAM ~210–350 MB).
