# `providerDispatch` lineage census — what a redeploy from this line would change in production (READ ONLY)

**Date:** 2026-09-30 · **Compared:** the deployed archive (uploaded 2026-08-22, modules dating from the early-August provider-os phases; function last updated 2026-09-09, revision `providerdispatch-00048-qiz`) vs `slice/c4-capability-consumer` @ `764d1d1`. **Packet:** `docs/release-gates/providerdispatch-lineage-census.json` (per-module reachability and the require chain to every new module). Nothing deployed; production read-only (one source archive). Follows [[FUNCTIONS_PREFLIGHT_SHELL_GATE]].

## 1 · Headline

A scoped redeploy of `providerDispatch` moves **all 59 existing ops** to this line's code and adds 5. Of the 23 modules production runs, **12 change**; **54 modules are new** to the function — and **46 of the 54 are reachable through EXISTING ops** (not through the new ones), because this line's `booking-service.js` and `provider-ops.js` require the entertainment / events / venue / creator / healthcare stacks. Only **8** new modules are reachable solely through the new `providerRequestShop` op. **Nothing is "loaded only"**: every new module sits on a call path.

Two of the changes are **security fixes for vectors that are live today** (§3, provider-onboarding). Several are **money-policy changes** that would run in this one function while every other deployed function keeps the old policy (§4, split-brain).

## 2 · What the shell gate itself needs

`business-workspace.js` and its closure: **12 modules** — `business-workspace.js`, `shared/approval-remediation.js`, `shared/business-capabilities.js`, `shared/business-scope.js`, `shared/cleanup-claimed-ids.json`, `business-category.js`, `capability-authority.js`, `healthcare-category.js`, `healthcare-plans.js`, `healthcare-workspace.js`, `subscription-catalog.js`, `subscription-core.js` — plus the two-line merge and two `ROUTES` entries in `provider-dispatch.js`. That is the "required for the shell gate" set. Everything else in the diff is not.

## 3 · The 12 changed modules, classified

| Module | Diff | Reached by | Classification | What would change in production |
|---|---|---|---|---|
| `provider-dispatch.js` | +26/−1 | entry | **required** (merge `business-workspace._h`, ops `businessWorkspace`/`workspaceHome`) + **unrelated** (merges `healthcare-workspace`, `provider-directory`, `providerRequestShop`; declares and binds `QR_SIGNING_SECRET` — the deployed function binds no secret) | 5 new ops; a new secret binding |
| `provider-onboarding.js` | +260/−67 | 23 existing ops | **security fix, live vector closed** (the `hotfix/provider-publish-selfgrant` change `c853665`, present here by another port) + **breaking for a live page** | `providerPublish` **stops** writing `status: active / searchable / isPublic / acceptsBookings` and **stops minting `provider: true`** for any self-service publisher (production does this today — a second self-mint vector, separate from the onboarding one closed by 537d17e); `providerActivateSubscription` **refuses a priced plan on a client-supplied `paymentRef`** (production activates enterprise for nothing today); `providerSubmitVerification` **refuses client document URLs** and requires document *kinds* — the live `provider-onboarding.html` (6 ops) sends URLs, so verification submissions from the live page would start failing until hosting ships; `providerGetPublicProfile` answers to the canonical registry; QR carries the reputation share handle; agreement role lookup (dark) |
| `provider-ops.js` | +309/−181 | 32 existing ops | **unrelated c4 behaviour, money** | commission for completions computed through the engine with hub-selected inputs; **wallet credit at show-up** for bookings stamped `commissionHub: 'entertainment'` (live bookings carry no stamp → `not_entertainment`, unaffected); decline of a paid booking now refunds; cancel/decline become one transaction that releases the availability item; healthcare service cap; PIN-verified start for entertainment bookings |
| `booking-service.js` | +142/−80 | 35 existing ops | **unrelated c4 behaviour** + **prerequisite link** (requires `business-workspace.notBuiltFor`) | booking creation consults the shop-hours authority, the ONE availability authority (`ent-availability`), rate cards/quotes, and refuses categories whose bookings are not built |
| `booking-payment-sweep.js` | +31/−3 | 35 existing ops | **unrelated c4 behaviour** | holds/releases go through availability occupancy; payment-in-flight guard; notification anchors |
| `availability.js` | +65/−323 | 58 existing ops | **unrelated c4 behaviour** | `getAvailabilitySlots` answered by the availability authority (shape kept); pure defaults; admin audit rows |
| `commission-config.js` | +376/−9 | 32 existing ops | **unrelated c4 money policy** | the owner's 2026-09-28 schedule (marketplace 15 %, healthcare 12 %, hotel 15 %, home services 14 %, car rental 16 %, services 5 %, tickets 5 %, POS 5 %) — memory records production still charging 5 % elsewhere |
| `finos-utils.js` | +82/−8 | 32 existing ops | **unrelated c4 money policy** | marketplace seller plan ladder inside `calculateCommission` (not triggered by provider bookings, but a different engine version) |
| `subscription-core.js` | +51/−0 | 61 existing ops | **unrelated c4** | `merchantSubscriptions` read first for sellers; healthcare resolves only from `accountSubscriptions` |
| `legal-agreements.js` | +162/−13 | 55 existing ops | **prerequisite** (c4 `applicationDecide` uses `complianceFor`) / dark | entertainment, creator, venue instrument sets; `health → healthcare` alias makes a healthcare enforcement flag effective if one is ever set; enforcement stays dark |
| `notify.js` | +156/−13 | 58 existing ops | **behaviour that would newly become reachable** | **SMS actually sends**: the recipient now falls back to `users.phoneNumber`, so booking notifications with an SMS template reach phones for the first time (cost + user-facing); anchors; new types |
| `sms-service.js` | +18/−0 | 58 existing ops | **unrelated, inert here** | two templates; `SMS_WEBHOOK_TOKEN` declared at load, unused by any op |

Behaviour already present live: the 11 identical modules (`admin-claim`, `booking-availability-guard`, `booking-resolution`, `commission-vat-policy`… per the packet).

## 4 · Split-brain, stated plainly

`commission-config.js`, `finos-utils.js` and `subscription-core.js` are shared by many deployed functions (webhooks, POS, payouts). A scoped redeploy updates them **inside `providerDispatch` only**. Booking settlements through this function would price on the 09-28 schedule and the merchant-subscription store while the IntaSend webhook and the POS functions keep the old policy. One platform, two commission authorities running at once.

## 5 · The 54 new modules

| Reached through | Count | Modules |
|---|---|---|
| **existing ops** (booking-service → `ent-availability`, `ent-rate-cards`, `kasshop`, `provider-hub`, `reputation`; provider-ops → `entertainment-bookings` → `event-*`, `venue-payments` → `financial-os` → `creator-hub`; booking-resolution → notify → `shop-employees`; provider-onboarding → `verification-authority`; business-workspace closure via provider-ops/booking-service) | **46** | the full entertainment/events/venue/creator/healthcare stack becomes reachable from today's booking ops |
| **new op only** (`providerRequestShop`) | **8** | `provider-shop`, `sokoni-till` (mints a Till; declares `QR_SIGNING_SECRET`), `sokoni-qr-authority`, `role-authority` (grants `seller`), `business-wallet`, `money-authority`, `seller-trial`, `tenant-identity` |
| loaded only | **0** | — |

Runtime notes: `event-ops.js` declares `SOKONI_HMAC_KEY`, which `provider-dispatch` does **not** bind — any op path reaching its `.value()` would throw at runtime; `sokoni-till`, `shop-employees`, `creator-hub`, `healthcare-conversations` construct 14 top-level triggers at load (defined, never registered by this function — harmless, but loaded on every cold start).

## 6 · Can a clean, production-shaped release be constructed?

**Yes, in shape; not from this branch as-is.** The shell gate needs the 12-module closure in §2 plus a two-line merge. A candidate built as *deployed archive (23 modules) + those 12 + the minimal `provider-dispatch.js` edit* would ship the gate without the 46-module entertainment stack, the commission schedule, or the SMS change. Two honest caveats:

1. **Lineage.** The deployed modules match blobs first introduced in early August (`provider-dispatch.js` @ `9625b11`, `provider-ops.js` @ `55c9367`, `booking-service.js` @ `8a7250e`); the exact commit of the 22 August archive should be pinned by matching every blob before anything is built on it, so the candidate has a git provenance rather than an archive one.
2. **The provider-onboarding security fixes** (§3) are then **not** shipped either. They close live self-grant vectors and deserve their own decision — as a second scoped candidate (`provider-onboarding.js` only, plus the hosting change for `provider-onboarding.html`'s verification submission), not bundled with the gate.

Recommendation: build and test that minimal candidate in its own worktree from the pinned commit; keep the provider-onboarding fix as a separate candidate; leave commission/notify/entertainment changes for their own releases. No deploy tonight, as the owner ruled.

Related: [[FUNCTIONS_PREFLIGHT_SHELL_GATE]] · [[COMPLETE_APPLICATION_SHELL_GATE]] · [[project_provider_subscription_selfgrant]] · [[project_marketplace_commission_ladder_unshipped]]
