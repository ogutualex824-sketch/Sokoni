# Tech Hub Convergence

Owner brief, 2026-10-03: finish Tech Hub end-to-end on existing SOKONI authorities — no rebuild, no duplicate
payment / booking / wallet / review / chat authority, no WhatsApp, AdminOS-gated, category-specific provider
dashboards, provider-controlled storefronts. Related: [[Services]], [[Bookings]], [[Payments]], [[AdminOS]],
[[IntaSend Convergence Brief]]. Strategy: no new hubs — Digital Hub folds into Tech Hub.

**Status: slice 1 built and tested; nothing deployed.**

## Authority map (census 2026-10-03)

| Capability | Canonical authority | State |
|---|---|---|
| Application | `business-apply.html` → `SokoniProviderApplication` → `applications/{uid}--provider` → AdminOS `applicationDecide` → `applicationLifecycle` `projectProvider` | exists; category is free text, never validated |
| Provider registry | `providers/{uid}` (status active/approved = public) via `sokoni-providers.js` | exists; owner can still change own `category` / `active` (rules) |
| Service catalogue | `providerServices`, CF-only (`providerDispatch` add/update/toggle/duplicate/remove, rate cards in cents) | exists; services can be created before approval |
| Booking | `sokoni-book-service.js` → `bookingCreateService` (server price, 5-min slot lock) → `service_booking` intent → IntaSend → webhook → `paid_held` | exists |
| Completion / settlement | `providerCompleteBooking` → `_disburseHeldFunds`; cancel / no-show / reschedule; `booking-resolution.js` refunds | exists; no completion PIN (provider self-completes) |
| Commission | plan rate in provider compatibility mode; healthcare by decided role (`provider-hub.js`) | exists; no lead fee |
| Leads / quotes | — | **missing** (no collection, no callable, no rules); `priceType:'quotation'` unused |
| Messaging | `conversations` + `sendMessage` CF; `sokoni-inbox.js` | partial: `service_booking` context points at legacy `bookings`, not `providerBookings` |
| Reviews | `bookingSubmitReview` → `providerReviews/{bookingId}` | exists; ratings split across three places; generic `reviews` rule lets an author self-approve |
| Offers | promotions admin-only; shop offers keyed to shops | **missing** for providers |
| Search | `providerSearchProviders` (`providerProfiles`) vs directory (`providers`) | drift |
| Storefront | `provider-profile.html?uid=` | exists; not linked from nav |
| Provider dashboard | `provider-dashboard.html` + `sokoni-business-workspace.js` (`businessWorkspace` op) | exists; nothing tech-specific; capability engine = sokoni-5b's slice 0 (one engine) |
| AdminOS | applications (Super Admin / admin / moderation pages), `adminGetProviders` read-only, reviews moderation, bookings read, disputes | no provider suspend / restore / verify |
| Takedown / report | sokoni-e3's report authority (products only) | provider entityType not yet added |

## Fake / static / duplicate surfaces found

| Surface | Problem | Slice |
|---|---|---|
| `phone-repair.html`, `electrical.html` | hardcoded providers with invented ratings / jobs / verified; WhatsApp / localStorage booking; KES 0 invoice; invented reviews | **1 — fixed** |
| `tech-hub.html` repair / IT tabs, compare | demo arrays; `techRepairs` / `techDevices` client writes, auto-active listings; compare on demo data | 2 |
| `providers.html` confirmBooking | fake "Confirmed" + client write to `providerBookings` | 2 |
| `provider.html` | legacy localStorage dashboard, fake "AI photo edit" | 3 (retire / redirect) |
| `home-services.html` | demo providers; client writes to `homeService*` | 2 |
| `digital.html`, `digital-esoko.html` | client-created contracts / "escrow"; purchase marked completed on the client | 6 (fold into digital-store callables) |
| `services.html` | legacy localStorage bookings / messages; bookNow / waConnect fallbacks | 2 |
| `hub-register.js` | random-id `applications` write duplicating the application primitive | 3 |
| Category lists | at least 6 definitions | 4 |

## Slice plan

1. **Tech listings on the engine** (done): phone repair + electrical list approved providers; Book → canonical
   booking; Message → in-app chat; honest loading / error / empty; register → `business-apply`.
2. Tech Hub repair / IT / compare tabs, `providers.html`, `home-services.html`, `services.html` fallbacks onto the
   same directory and booking modal; compare from real provider data only.
3. Retire `provider.html` and `hub-register.js` application writes (redirect to the dashboard / application primitive).
4. One tech taxonomy (Device Repair, IT Support, Networking, CCTV, POS Support, Smart Home, …) served from the
   existing `SERVICE_CATEGORIES` authority and validated server-side; capability names sent to sokoni-5b.
5. Security / rules (rules release): provider `category`/`active` self-change, review self-approval,
   `providerAddService` approval gate, `mechanics` / `healthProviders` / `lawyers` self-activation.
6. Digital Hub folded into Tech Hub on the server-backed `digital-store` callables.
7. Leads / quotes authority (new, additive, on the existing booking engine) — owner decision on lead fees.
8. AdminOS provider suspend / restore / verify (+ sokoni-e3's takedown entityType).
9. Messaging context → `providerBookings`; completion PIN for provider bookings (existing PIN authority).

## Category matrix (honest)

| Category | Application | Approval | Dashboard | Storefront | Listing | Booking | Payment | Commission | Chat | Reviews | AdminOS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Phone / device repair | yes | yes | generic | yes | **slice 1** | engine | engine | plan rate | in-app | engine | read-only |
| Electrical | yes | yes | generic | yes | **slice 1** | engine | engine | plan rate | in-app | engine | read-only |
| IT support / networking / CCTV / POS support | yes (free text) | yes | generic | yes | demo (slice 2) | engine once listed | engine | plan rate | in-app | engine | read-only |

"Engine" = the canonical service engine is available once the provider is approved and has services; none of it is
proven end to end in a browser on this branch yet.
