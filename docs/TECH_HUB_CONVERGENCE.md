# Tech Hub Convergence

Owner brief, 2026-10-03: finish Tech Hub end-to-end on existing SOKONI authorities — no rebuild, no duplicate
payment / booking / wallet / review / chat authority, no WhatsApp, AdminOS-gated, category-specific provider
dashboards, provider-controlled storefronts. Related: [[Services]], [[Bookings]], [[Payments]], [[AdminOS]],
[[IntaSend Convergence Brief]]. Strategy: no new hubs — Digital Hub folds into Tech Hub.

**Status: slices 1, 2a, 2b, 3, 4a, 4b, 4L and 4F built and tested; nothing deployed.**

## Authority map (census 2026-10-03)

| Capability | Canonical authority | State |
|---|---|---|
| Application | **ONE intake: `HubRegister.open`** (offer.html; sokoni-f3 be46c94, owner 2026-10-01) → `applications/{id}` → AdminOS `applicationDecide` → `applicationLifecycle` → `providers/{uid}`. `business-apply.html` (deterministic `{uid}--provider`) is reachable from nothing — not used | exists; random ids allow duplicate applications; category free text (stamp at approval = sokoni-5b) |
| Provider registry | `providers/{uid}` (status active/approved = public) via `sokoni-providers.js` | exists; owner can still change own `category` / `active` (rules) |
| Service catalogue | `providerServices`, CF-only (`providerDispatch` add/update/toggle/duplicate/remove, rate cards in cents) | exists; services can be created before approval |
| Booking | `sokoni-book-service.js` → `bookingCreateService` (server price, 5-min slot lock) → `service_booking` intent → IntaSend → webhook → `paid_held` | exists |
| Completion / settlement | `providerCompleteBooking` → `_disburseHeldFunds`; cancel / no-show / reschedule; `booking-resolution.js` refunds | exists; no completion PIN (provider self-completes) |
| Commission | plan rate in provider compatibility mode; healthcare by decided role (`provider-hub.js`) | exists; no lead fee |
| Leads / quotes | `serviceLeads` via service-leads.js (providerDispatch lead* ops), `bookingCreateService({leadId})` books at the quoted price; docs/SERVICE_LEADS.md | **built 4F** (server 906bd2f + hosting); no lead fee (not configured) |
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
| `tech-hub.html` repair / IT tabs | demo arrays; `techRepairs` client write with "Booking recorded" | **2a — fixed** |
| `tech-hub.html` device listings | `techDevices` client write, auto-active, no review | 3 (route to the marketplace product authority) |
| `tech-hub.html` Ask Hub | localStorage feed with wa.me hand-off | 7 (becomes the lead / quote request) |
| `tech-hub.html` freelancers / startups / courses / jobs / AI / compare | demo arrays, shown only on localhost or with `sokoniDemoData` (production shows nothing) | later; jobs → Work engine |
| `providers.html` confirmBooking | fake "Confirmed" + client write to `providerBookings` | **2a — fixed** |
| `provider.html` | legacy localStorage dashboard, fake "AI photo edit"; also the legal role workspace route (auth.js) and a `?cat=` intake on ~15 hubs | cross-hub — needs a role-routing decision; Tech/Home links moved off it (slice 3) |
| `home-services.html` | demo providers; WhatsApp booking to SOKONI; client `homeServiceBookings` / KES 30 `homeServiceLeads` / reviews writes | **2b — fixed** (quotes / requests remain → 7) |
| `digital.html`, `digital-esoko.html` | client-created contracts / "escrow"; purchase marked completed on the client | 6 (fold into digital-store callables) |
| `services.html` | legacy localStorage bookings / messages; bookNow / waConnect fallbacks | **2b — fixed** |
| `hub-register.js` | the ONE intake (not a duplicate — corrected 10-03) | kept; Tech/Home entries use it (slice 3) |
| `services.html` registerProvider | client `providers` write = public listing before AdminOS | **3 — fixed** |
| Category lists | at least 6 definitions | 4 |

## Slice plan

1. **Tech listings on the engine** (done): phone repair + electrical list approved providers; Book → canonical
   booking; Message → in-app chat; honest loading / error / empty; register → `business-apply`.
2. Tech Hub repair / IT / compare tabs, `providers.html`, `home-services.html`, `services.html` fallbacks onto the
   same directory and booking modal; compare from real provider data only.
3. **(done)** One intake: Tech/Home register entries → HubRegister; services.html self-listing retired. provider.html = cross-hub item.
4. One tech taxonomy (Device Repair, IT Support, Networking, CCTV, POS Support, Smart Home, …) served from the
   existing `SERVICE_CATEGORIES` authority and validated server-side; capability names sent to sokoni-5b.
5. Security / rules (rules release): provider `category`/`active` self-change, review self-approval,
   `providerAddService` approval gate, `mechanics` / `healthProviders` / `lawyers` self-activation.
6. Digital Hub folded into Tech Hub on the server-backed `digital-store` callables.
7. Leads / quotes authority (new, additive, on the existing booking engine) — owner decision on lead fees.
8. AdminOS provider suspend / restore / verify (+ sokoni-e3's takedown entityType).
9. Messaging context → `providerBookings`; completion PIN for provider bookings (existing PIN authority).

## Capability engine (sokoni-5b, 2026-10-03)

Tech dashboards build on sokoni-5b's capability engine `feat/capability-engine-on-c7e26b6` @ 13f74f3 (docs/CAPABILITY_ENGINE.md):
caps DEVICE_REPAIR, IT_SUPPORT, NETWORKING, CCTV_SECURITY, ELECTRONICS, POS_BUSINESS_TECH, SOFTWARE_DEV + service-mode caps; provider
modules (leads, repairs, diagnostics, supportTickets, siteVisits, cctvInstallations, posSupport, …) are NOT_IMPLEMENTED `TECH_HUB_PENDING`
until a screen ships (flip `implemented:true`, gate server ops with `assertModule`). Blocked on the approval-time category stamp
(sokoni-5b building it on f66f2c1 + 7df7817). providerDispatch has three pending changes that must ship as ONE release.

## Tech taxonomy (slice 4a, from the repository — nothing invented)

| Intake id (HubRegister CATS) | Server category (business-category) | Capabilities (service-capabilities) | Provider modules switched on |
|---|---|---|---|
| phone-repair | it_services | DEVICE_REPAIR, WORKSHOP, PICKUP_DROP_OFF, QUOTE_REQUEST, DIRECT_BOOKING | repairs, diagnostics, supportedDevices, pickupDropoff, leads, quotes, bookings |
| laptop-repair · computer-repair (new) | it_services | same as phone-repair | same |
| electronics-repair (new) | it_services | ELECTRONICS, DEVICE_REPAIR, WORKSHOP, QUOTE_REQUEST | repairs, diagnostics, supportedDevices, leads, quotes |
| it-support | it_services | IT_SUPPORT, REMOTE_SUPPORT, ONSITE_SUPPORT, QUOTE_REQUEST, DIRECT_BOOKING | supportTickets, remoteSupport, siteVisits, leads, quotes, bookings |
| networking (new) | it_services | NETWORKING, FIELD_SERVICE, ONSITE_SUPPORT, QUOTE_REQUEST | networkProjects, siteVisits, leads, quotes |
| cctv | it_services | CCTV_SECURITY, FIELD_SERVICE, ONSITE_SUPPORT, QUOTE_REQUEST | cctvInstallations, siteVisits, leads, quotes |
| pos-support (new) | it_services | POS_BUSINESS_TECH, ONSITE_SUPPORT, REMOTE_SUPPORT, QUOTE_REQUEST | posSupport, siteVisits, remoteSupport, leads, quotes |
| web-developer · software · app-developer | it_services | SOFTWARE_DEV, REMOTE_SUPPORT, QUOTE_REQUEST | projects, remoteSupport, leads, quotes |
| data-entry | it_services | REMOTE_SUPPORT, QUOTE_REQUEST | remoteSupport, leads, quotes |
| electrical | trades | FIELD_SERVICE, ONSITE_SUPPORT, QUOTE_REQUEST, DIRECT_BOOKING (new, service modes only) | siteVisits, leads, quotes, bookings |

All Tech modules are NOT_IMPLEMENTED (`TECH_HUB_PENDING`) except where a plan already makes `quotes` / `bookings` available —
a screen ships before its flag flips. Gaps found: provider-onboarding.html professions (`Network Engineer`, `IT Support`, …) classify through
`FROM_PROFESSION` but are not business ids, so they grant no capability; a second intake to converge later. The approval-time
category stamp (sokoni-5b) is required for any of this to reach `providers/{uid}.business`.

## Slice 4b — device repair, end to end (what is real)

| Step | Authority | State |
|---|---|---|
| Device / brand / repair / mode on a service | `providerServices.techProfile` via provider-ops add/update/duplicate + shared/tech-service-profile.js | built, executed tests (server 18/0) |
| Only granted modes / device fields only with DEVICE_REPAIR or ELECTRONICS | workspaceFor capabilities + assertModule | built; mutation "grant all caps" caught |
| Customer gives device + problem when booking | sokoni-book-service device step → bookingCreateService `repairDetails` | built; server rejects uncovered device; price unchanged |
| Provider sees repair requests | Repairs panel = providerGetBookings with repairDetails | built (fake-DOM test); browser UNRUN |
| Confirm / complete / settle | existing Bookings + booking PIN + `_disburseHeldFunds` | existing (not re-proven here) |
| Diagnostics module | — | NOT_IMPLEMENTED (no screen) |
| Message the customer / provider about a booking | messages.js service_booking → providerBookings (+ legacy `bookings`), customerUid party; messages.html `?tx=&txId=` | **fixed 4L** (server 95f2ef6, hosting); pre-booking "Message" → 4F enquiry |

## Category matrix (honest)

| Category | Application | Approval | Dashboard | Storefront | Listing | Booking | Payment | Commission | Chat | Reviews | AdminOS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Phone / device repair | yes | yes | generic | yes | **slice 1** | engine | engine | plan rate | in-app | engine | read-only |
| Electrical | yes | yes | generic | yes | **slice 1** | engine | engine | plan rate | in-app | engine | read-only |
| IT support / networking / CCTV / POS support | yes (free text) | yes | generic | yes | **slice 2a** | engine once listed | engine | plan rate | in-app | engine | read-only |

"Engine" = the canonical service engine is available once the provider is approved and has services; none of it is
proven end to end in a browser on this branch yet.
