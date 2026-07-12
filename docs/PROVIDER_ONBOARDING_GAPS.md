# Provider Onboarding — Gap Analysis & Remediation Status

**Date:** 2026-07-12 · Audited the existing service-provider system against the 15-step Enterprise Onboarding spec.

## Verdict
The provider system was **~90% built** (19 onboarding handlers via `providerDispatch`, a dedicated `provider-onboarding.html` wizard + `provider-dashboard.html`, cleanly **separate from SmartPOS** — no Merchant ID/POS/inventory/printer leakage; subscriptions correctly **account-linked** by `uid`). But it was **non-functional end-to-end** due to a broken frontend↔backend contract, and several backend/data gaps.

---

## ✅ Fixed this pass — backend gaps (commit `debcb5a`/`6a1dd58`, deployed)
New **`functions/provider-ops.js`** routed through `providerDispatch` (**0 new Cloud Run services**), built **without touching the agent's live wizard files**:

- **7 dashboard handlers** the dashboard already called but that didn't exist — payloads + response fields matched exactly to `provider-dashboard.html`:
  `providerConfirmBooking`, `providerDeclineBooking`, `providerCompleteBooking`, `providerGetEarnings`, `providerRequestPayout`, `providerGetReviews`, `providerReplyReview`.
- **Subscription COMMISSION enforcement** — applied at booking completion (rate read from `providerSubscriptions`), writing an idempotent `providerPayouts` ledger entry. The one place real money is computed.
- **LISTINGS-LIMIT enforcement** — `providerAddService` respects `limits.listings` (`-1` = unlimited).
- **The 4 collections that existed only in a comment are now created:** `providerPortfolio` (SavePortfolio/GetPortfolio), `providerServices` (Add/List/Remove), `providerCalendar` (on confirm), `providerAnalytics` (daily rollup on completion).
- Every op requires auth + verifies ownership (`providerId === uid`). All queries **index-free** (single-field equality + in-memory filter/sort) — no composite-index deploy required. Guard: 0 collisions.

**Result:** the Provider Dashboard's Bookings actions, Earnings panel, Reviews panel, and service management now have working, deployed backends.

---

## ⏳ Remaining — frontend contract fixes (belong to the active agent's files)
These live in `provider-onboarding.html` / `onboarding.html` / `sokoni-provider.js`, which the background agent is **actively editing**. Left for after it commits, to avoid clobbering in-flight work. Each is a small, surgical fix:

| Gap | File:line | Fix |
|-----|-----------|-----|
| **A** — draft save sends numeric `step` | `provider-onboarding.html:313` | send the named string step (`'profile'`,`'coverage'`,…) the backend expects |
| **B** — subscription never activated | `provider-onboarding.html:342` | call `providerSelectPlan` + `providerActivateSubscription` before publish |
| **C** — publish payload ignored + field mismatch | `provider-onboarding.html:321-332` | map wizard field IDs → the `draft.profile.*` keys `providerPublish` reads |
| **D** — draft-resume shape mismatch | `provider-onboarding.html:291` | read `{draft, completedSteps, status}` from `providerGetDraft` |
| Photo/logo capture missing (step 4) | `provider-onboarding.html:373-393` | add a Storage upload → set `profilePhotoUrl` |
| File uploads (verify + portfolio) | steps 9, 11 | Storage upload → call `providerSubmitVerification` / new `providerSavePortfolio` |
| Payment methods (PayPal/Stripe/IntaSend/Wallet) | step 10 | add UI inputs (backend `providerConnectPayment` already supports them) |
| Dashboard field binding | `provider-dashboard.html:628-654` | align to `providerDashboard` output (`plan`≠`tier`, `renewalDate`≠`renewalAt`) |
| Two competing onboarding flows | `onboarding.html:256-267` | route the provider role to `provider-onboarding.html` (single source of truth) |
| Search thin | `provider-onboarding.js:525` (agent) | apply `county`; add distance/price/availability/tier/featured/AI |
| Phone not truly verified (step 2) | `provider-onboarding.html:354` | wire OTP verification |

**Once A–D land, the wizard completes end-to-end** (draft → subscription → publish → dashboard), which is the acceptance criterion.

Related: [[DISPATCHER_REGISTRY]] · [[project_smartpos_onboarding_v2]]
