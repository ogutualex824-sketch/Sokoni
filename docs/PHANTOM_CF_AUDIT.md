# Phantom Cloud Function Audit — 2026-07-17

**Method:** every `httpsCallable(...)` call site in client code (worktrees and generated audit
blobs excluded) cross-referenced against the **live** deployed function list
(`firebase functions:list` → 1,440 functions) and every dispatcher `_h` registry
(695 ops across `functions/*.js`). Read-only static analysis. No code changed.

**Why this was run:** during the Phase 0 onboarding sprint, four instances of this exact failure
class were found by hand — `upsertProduct` and `posSendMpesa` (called but never deployed),
`executeSettlement` (deployed but never called), and `validateDeviceAccess` (deployed but
unreachable because nothing wrote `posStaff.pinHash`). Each is a runtime failure that only
surfaces when a user touches the feature. This sweep finds the rest.

**Scanner caveat:** an earlier pass over-reported because it only recognised `exports._h.x` and
`_h: { x }` registries. It now also recognises the bare `_h.x =` style (`provider-ops.js`) and
dispatcher allow-lists. The provider-dashboard ops flagged in that first pass were **false
positives** and are correctly registered.

---

## [A] Broken by the dispatcher consolidation — 24 names

The SmartPOS consolidation (156 `onCall` → 1 `smartPosDispatch`) removed the standalone
functions, but these clients still call the **old** names directly. The handler still exists as an
`_h` op, so the fix is to route the call through the dispatcher — no backend work.

| Client | Ops | Example | Merchant impact |
|---|---|---|---|
| `pos-accounting.html` | 11 | `getProfitAndLoss` | **P&L, balance sheet, cash flow, VAT report and expenses are all dead** — the merchant's entire accounting dashboard |
| `messages-admin.html` | 5 | `adminGetChatStats` | admin chat moderation dead |
| `sokoni-availability.js` | 5 | `setProviderAvailability` | provider availability cannot be set |
| `pos-onboard.html` | 1 | `recordPOSSale` | legacy wizard (already known-dead, see below) |
| `sokoni-pay-config.js` | 1 | `getCheckoutPaymentConfig` | checkout payment config falls back |
| `super-admin.html` | 1 | `getMerchantFinancials` | super-admin financials view |

`pos-accounting.html` is the notable one for the pilot: a merchant clicking any accounting report
gets `not-found`.

## [B] Implemented but NOT deployed — 54 names

Code exists **and** is exported from `index.js`, but the function is absent from the live project.
This is the known **Cloud Run CPU quota** block, not a code defect — it resolves when the quota
increase lands (tracked as an RC1 infrastructure dependency).

| Client | Ops | Example |
|---|---|---|
| `org-structure.html` | 14 | `orgGetDepartments` |
| `org-workflows.html` | 12 | `orgGetApprovalWorkflows` |
| `account-centre.html` | 8 | `deviceRegister` (device/session management) |
| `staff-management.html` | 8 | `wfInviteEmployee` (**staff invitations**) |
| `sokoni-workspace.js` | 4 | `wfClockIn` (attendance) |
| `workspace-invite.html` | 3 | `wfGetInvitation` |
| `org-directory.html` | 2 | `orgGetDirectory` |
| `professional-profile.html` | 2 | `wfGetProfessionalProfile` |
| `profile.html` | 1 | `profileGetCompletion` |

`staff-management.html` matters for onboarding: the **staff-invitation flow cannot work until the
quota is granted**. Phase 0 can proceed because `createBusiness` seeds the owner into `posStaff`
directly, and `setStaffPin` (shipped today) rides the already-deployed `smartPosDispatch`.

## [C] Genuinely missing — 6 real (8 flagged)

No handler and no export anywhere. `sokoni-test-suite.js` accounts for 2 of the 8
(`unknownFunction_xyz` is a deliberate negative-test fixture) — excluded.

| Client | Op | Impact |
|---|---|---|
| `pos-checkout.html` | `posSendMpesa` | M-PESA **fallback** path hard-fails (primary `SokoniPay` path works) |
| `pos-onboard.html` | `upsertProduct` | legacy onboarding wizard — superseded by `posUpsertProduct` on `smartPosDispatch` |
| `returns.html` | `processReturn` | **customer returns dead** |
| `scan.html` | `verifyPickupToken` | **pickup verification dead** |
| `tenant-portal.html` | `initiateRentPayment` | **rent payment dead** |
| `partner-portal.html` | `getProducts` | partner catalogue view dead |

## Phantom dispatcher ops

`sokoni-inventory.js:489` sends `op:'movement'` and `pos-checkout.html:1676` sends
`op:'cmLogDrawerOpen'`, neither of which is registered → `Unknown operation`. The
`sokoni-dev-mock.js` hits (`set`/`update`/`delete`) are mock plumbing, not real calls.

---

## Recommendation

None of this is fixed here — it is **outside the approved RC1 scope** (Priorities 1–3), and the
freeze permits only blockers, security, data-integrity, financial-correctness, deployment
blockers, and documented regressions.

Triage for authorization, in priority order:

1. **`pos-accounting.html` (category A, 11 ops)** — merchant-facing and completely dead. Cheapest
   real win: route through `smartPosDispatch`, no backend change.
2. **`returns.html`, `scan.html` (category C)** — dead customer-facing flows. Need handlers.
3. **Category B (54 ops)** — resolves with the Cloud Run quota increase; no code action.
4. Remaining category A clients — lower traffic.

Category B and the `posSendMpesa` fallback are already tracked in the RC1 technical-debt register.
