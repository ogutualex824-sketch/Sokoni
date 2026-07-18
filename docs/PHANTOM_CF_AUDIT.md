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

### Deployment backlog — release on Cloud Run quota resolution

These are **deployment-blocked, not code defects**. Do not redesign or duplicate the
functionality. When the quota increase is granted, deploy in this order and re-run this audit to
confirm the category empties.

| Order | Function group | Count | Unblocks | Pilot-critical? |
|---|---|---|---|---|
| 1 | `wf*` — workforce identity (`wfInviteEmployee`, `wfClockIn`, `wfGetInvitation`, …) | 15 | Staff invitations, attendance/clock-in, workspace invites | **Yes** — needed the moment the merchant hires a second person |
| 2 | `device*` — device/session management (`deviceRegister`, `deviceList`, `deviceTrust`, …) | 8 | Account-centre device trust, remote logout | Partly — security feature, not trading-critical |
| 3 | `org*` — org structure & workflows (departments, teams, roles, approvals, delegations) | 28 | Enterprise org chart, approval workflows, temp access | No — enterprise tier, post-pilot |
| 4 | `profileGetCompletion`, `wfGetProfessionalProfile` | 3 | Profile completion meters | No — cosmetic |

**Verification after deployment:** re-run the phantom sweep; category B should drop to zero. Any
name still absent means the deploy silently skipped it (check the Cloud Run service count against
the per-project limit rather than assuming success).

## [C] Genuinely missing — 5 real (8 flagged)

No handler and no export anywhere. Three of the eight are **false positives**, verified by reading
each call site:

- `sokoni-test-suite.js` × 2 — `unknownFunction_xyz` is a deliberate negative-test fixture.
- `partner-portal.html:360` — the `getProducts` call sits inside a `<pre>` block; it is **API
  documentation** showing partners how to call the platform, not an executed call.

### The 5 real dead flows

| # | Module | Op | Business impact | Effort | Dependencies | Priority |
|---|---|---|---|---|---|---|
| C-1 | `returns.html:616` | `processReturn` | **Customer returns cannot be approved.** A buyer requests a return and staff can never action it — direct CX and refund-liability exposure. Returns policy is published, so this is a stated commitment the platform cannot honour. | **Medium** — needs a handler with state machine (requested→approved/rejected→refunded), inventory restock and an audit row. Refund money movement should reuse `posProcessRefund`'s now-idempotent pattern. | Refund engine; inventory restock; notification engine | **P1 — highest of category C.** Customer-facing and tied to a published policy |
| C-2 | `tenant-portal.html:711` | `initiateRentPayment` | **Tenants cannot pay rent.** The property/tenant vertical has no payment path; the button fails. Revenue-blocking for that hub. | **Medium** — must route through the ONE payment rail (`fosInitiatePayment`/IntaSend STK), never a second payment engine. Needs lease→invoice→payment linkage. | Payment rail; commission engine (property category); lease records | **P2** — revenue-blocking but scoped to the property hub, not Phase 0 pilot |
| C-3 | `scan.html:210` | `verifyPickupToken` | **Click-and-collect pickup cannot be verified.** Staff cannot confirm a collection token, so handover is unverified — goods could be released to the wrong person. | **Small–Medium** — token verify + single-use consumption, must be transactional so a token cannot be redeemed twice. | Order/collection records; QR engine | **P2** — becomes P1 the moment click-and-collect is enabled for a pilot merchant |
| C-4 | `pos-checkout.html:2475` | `posSendMpesa` | M-PESA **fallback** path hard-fails. Low impact today because the primary `SokoniPay.platformBook` path works; only bites if `SokoniPay` fails to load. | **Small** — either implement the fallback against the existing rail or delete the dead branch and surface a clear error. | Payment rail | **P3** — remove or implement; do not leave a silent dead branch |
| C-5 | `pos-onboard.html:1252` | `upsertProduct` | Legacy onboarding wizard. **Superseded** — `posUpsertProduct` now exists on `smartPosDispatch` (shipped 2026-07-17). This wizard also writes to `sellers/{uid}` instead of `businesses/{SOK-…}`, so it produces an un-bootstrappable POS. | **Small** — retire the page or repoint it at the v2 flow. Do **not** re-implement `upsertProduct`. | SmartPOS onboarding v2 | **P2 — retire, don't fix.** Leaving it reachable is an onboarding trap |

**None of these is implemented during RC1**, per directive. C-1 and C-3 are the two that could
affect a pilot merchant; C-5 should be closed by removing the route rather than writing code.

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
