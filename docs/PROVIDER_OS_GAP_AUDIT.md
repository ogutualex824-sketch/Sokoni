# Provider OS — Gap Audit

**Status:** COMPLETE (audit only — no implementation) · **Date:** 2026-08-03
**Scope:** `provider-dashboard.html` (1,060 lines, SPA) · `functions/provider-ops.js` (24 handlers) · `functions/provider-dispatch.js` (60-op router) · `functions/provider-onboarding.js` (`providerDashboard`/`providerGetAnalytics`) · `sokoni-provider.js`.
**Principle:** extend, do not rebuild. Ownership of `provider-dashboard.html` confirmed (clean tree, last edited 2026-08-02 by owner; no parallel agent).

---

## 🔴 Headline finding — fix this first
`loadDashboard()` (html:973–1034) reads fields the `providerDashboard` CF (onboarding.js:493–541) **does not emit** — pure field-name drift, not missing backend. Consequences on the Overview, even for a fully-configured provider:
- Plan shows "Free" (reads `sub.tier`, backend emits `sub.plan`); renewal "—" (`sub.renewalAt` vs `sub.renewalDate`).
- Today's Bookings / Pending Requests always 0 (reads `res.todayBookings`/`res.pendingRequests`; backend returns a single `bookings[]`).
- Month earnings "KSh 0" (`res.analytics.monthEarnings` vs `earnings.last30dKes`).
- **"Complete Your Profile 0%" card always shown** (`p.completionScore` vs top-level `profileCompletion`).
- Settings Profile/Pricing/Payment tabs load blank (projection excludes bio/phone/email/rates).

**All fixable frontend-side** (align field names; derive today/pending from `bookings[]`), plus a small backend projection-widen for the Settings prefill. No rebuild.

---

## Module status

| Module | Backend | Frontend | Status | Priority |
|---|---|---|---|---|
| Home Dashboard | `providerDashboard` (rich) | `panel-overview` | **Partial — data broken** (field drift) | **High** |
| Services | full CRUD + pricing (ops.js:700–919) | Settings ▸ Rate Cards | Present (works) | Low |
| Calendar | `providerAvailability`+`providerBookings` onSnapshot | `panel-calendar` week/month | Present (read-only) | Med |
| Bookings | full lifecycle (ops.js:140–561) | `panel-bookings` | Present (works) | Low |
| Wallet | `providerGetEarnings`, `getWalletBalance`, `requestSellerPayout` | `panel-earnings` | **Partial** — withdraw hidden, no balance/history | **High** |
| Customers | none (only `providerContactCustomer`) | — | **Missing** | Med |
| Reviews | `providerGetReviews`/`ReplyReview` | `panel-reviews` | Present (works) | Low |
| Analytics | `providerGetAnalytics` **exists, never called** | — | **Missing (frontend)** | Med |
| Settings | profile/pricing/payment/notif/avail/verif/sub | `panel-settings` (8 sub-tabs) | Present (mostly) | Med |

## Key defects (cited)
- **Withdraw button never appears** — gated on `d.pending>0` (html:777) but completed earnings settle as `settled` (ops.js:584), so withdrawable balance exists yet the CTA stays hidden. **High.**
- **Bookings pagination dead** — `#bkMore` always hidden, `B.loadMore()` is a no-op (html:338,626) though backend returns `hasMore`/`startAfter` (onboarding.js:561–564).
- **Reschedule via `prompt()`** (html:624) despite atomic `providerRescheduleBooking` (ops.js:460).
- **Cancel Subscription is fake** — toast only, no backend call (html:893).
- **Duplicate pricing UIs** — Settings ▸ Pricing (flat fields) vs per-service Rate-Card Studio, different schemas.

## Business Health card — 10/13 signals are FREE
Free from existing data: profile completion, verification, wallet status, payment connected, availability configured, active services, pending bookings, avg rating, reviews count, earnings.
**New aggregation needed (one `providerGetHealth` op over `providerBookings`+`bookingEvents`):** completion rate, cancellation rate, response time.

## Navigation
SPA (`P.show`, no reloads), self-updates (shared-header → sw-register). Desktop sidebar: Overview/Calendar/Bookings/Earnings/Reviews/Settings. Mobile bottom-nav: Home/Calendar/Bookings/Earnings/Settings.
Gaps: **Reviews missing on mobile**; **Analytics** has no nav item anywhere; **Services** buried in Settings; **Customers** absent. Label drift "Overview" (desktop) vs "Home" (mobile).

## Unused backend (available, never called by UI)
`providerGetAnalytics`, `providerSavePortfolio`/`GetPortfolio`, `providerGenerateQR`.

## UI/a11y
Nav items are `<div onclick>` (no role/tabindex/keyboard); emoji icons unlabeled; no focus management on panel switch; calendar week grid horizontally scrolls on phones. Positives: coherent token system, good empty states, global loading overlay (no skeletons).

---

## Implementation order (top-down, additive) — DO NOT rebuild working modules
1. **Home** — *fix + fill*: align `loadDashboard` to `providerDashboard` (+ derive today/pending from `bookings[]`; widen projection for Settings prefill), then add the **Business Health card** (10/13 free; one `providerGetHealth` op for the 3 rate/time signals).
2. **Services** — *polish*: promote Rate Cards to a top-level module; reconcile the two pricing editors.
3. **Calendar** — *fill*: add write actions (block slot / override / create booking) over the working read view.
4. **Bookings** — *polish*: real pagination (`hasMore`/`startAfter`); slot-picker reschedule via `providerRescheduleBooking`.
5. **Wallet** — *fix + fill*: un-gate Withdraw (use wallet balance); show balance + `walletTransactions` history.
6. **Customers** — *build new*: roster op over `providerBookings` (group by customer) + panel + nav.
7. **Reviews** — *polish*: add mobile nav entry.
8. **Analytics** — *fill (frontend)*: panel over existing `providerGetAnalytics` + `providerAnalytics` rollups.

**Cross-cutting quick wins:** remove dead Load-More; make/hide Cancel-Subscription; a11y on nav divs; standardize Overview/Home label.
**Production-quality — extend only:** Bookings lifecycle, Services CRUD, Reviews, Calendar renderer.
