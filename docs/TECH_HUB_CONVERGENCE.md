# Tech Hub Convergence

Owner brief, 2026-10-03: finish Tech Hub end-to-end on existing SOKONI authorities — no rebuild, no duplicate
payment / booking / wallet / review / chat authority, no WhatsApp, AdminOS-gated, category-specific provider
dashboards, provider-controlled storefronts. Related: [[Services]], [[Bookings]], [[Payments]], [[AdminOS]],
[[IntaSend Convergence Brief]]. Strategy: no new hubs — Digital Hub folds into Tech Hub.

**Status: slices 1–3, 4a, 4b, 4F, 4K, 4L, 4M, 4N, 4O, 4P, 4Q, 4R, 4T, 4U built and tested; 4J blocked on sokoni-5b; capability screens (4C) partly NOT_IMPLEMENTED; NOTHING DEPLOYED. See the status board.**

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
| AdminOS | applications, providers table with **Suspend / Reinstate via applicationDecide** (4O), reviews moderation, bookings read, disputes | suspend/reinstate **built 4O**; verify (badge authority) open |
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

## Category matrix — slice 4Z (2026-10-03, from the repository taxonomy; NOTHING DEPLOYED)

Legend:
- **P** proven by an executed test on this branch (real handlers, in-memory Firestore / vm);
- **B** built, static or fake-DOM tested only;
- **D** depends on another owner (named);
- **—** not built.

Browser / emulator evidence is **UNRUN** for every cell; memory was below the 512 MB floor all day.

Every tech category shares the same rails. They differ only in the capabilities their intake id maps to (see "Tech taxonomy" above).

| Category (intake id) | Application | Approval | Category stamp | Capability | Dashboard modules | Service editor | Storefront | Lead / quote | Booking | Payment | Commission | Message | Call | Review | AdminOS | Super Admin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| phone-repair · laptop-repair · computer-repair | P (HubRegister + provider-onboarding → applications) | P (applicationDecide) | **D 5b** | P | P repairs, supportedDevices, leads; B UI | P device profile | B (badge P) | P | P (+ repairDetails) | D (existing IntaSend engine, not re-proven) | **D 5b port — live line settles 20 %** | P | P | existing engine | P suspend / reinstate, leads view | B read-only rates |
| electronics-repair | P | P | **D 5b** | P | P repairs, supportedDevices, leads | P | B | P | P | D | **D 5b** | P | P | existing | P | B |
| it-support | P | P | **D 5b** | P | P leads, bookings; supportTickets / remoteSupport / siteVisits NOT_IMPLEMENTED | P modes | B | P | P | D | **D 5b** | P | P | existing | P | B |
| networking | P | P | **D 5b** | P | P leads; networkProjects / siteVisits NOT_IMPLEMENTED | P modes | B | P | P | D | **D 5b** | P | P | existing | P | B |
| cctv | P | P | **D 5b** | P | P leads; cctvInstallations / siteVisits NOT_IMPLEMENTED | P modes | B | P | P | D | **D 5b** | P | P | existing | P | B |
| pos-support | P | P | **D 5b** | P | P leads; posSupport NOT_IMPLEMENTED | P modes | B | P | P | D | **D 5b** | P | P | existing | P | B |
| web-developer · software · app-developer · data-entry | P | P | **D 5b** | P | P leads; projects / remoteSupport NOT_IMPLEMENTED | P modes | B | P | P | D | **D 5b** | P | P | existing | P | B |
| electrical | P | P | **D 5b** | P (service modes) | P leads, bookings; siteVisits NOT_IMPLEMENTED | P modes | B | P | P | D | **D 5b** | P | P | existing | P | B |

No category is registration-only. Each one can apply, be approved, list, take leads, quote, book, message and call.

The capability-specific screens marked NOT_IMPLEMENTED are shown honestly (not as working) until their screens and server ops ship. They are the remaining 4C work.

## Status board

**PROVEN (executed):**

| Area | What is proven | Test |
|---|---|---|
| Capabilities | composition from valid approvals only | test-tech-taxonomy, test-service-capabilities |
| Device / service profile | capability-gated; repairDetails validated | test-tech-service-profile 18/0 |
| Leads and quotes | lifecycle; quote → booking at the quoted price; one conversion; no lead fee | test-service-leads 13/0 |
| Booking messaging | providerBookings + customerUid | test-messages-service-booking 6/0 |
| Suspend / reinstate | full cycle | test-provider-suspend-restore 8/0 |
| Search eligibility | both pipelines | test-provider-search-eligibility 8/0 |
| Verified badge | projection from admin facets; re-verify on rename | test-provider-badge 8/0 |
| Onboarding | intake into the one queue; OB-1 | test-provider-onboarding-intake 6/0, publish hotfix 15/0 |
| Calling | booking-bound, logged reveal | test-booking-contact 5/0 |
| Commission gate | invariant | gate-service-commission (GREEN on 2f's line, RED here) |
| Feature flags | fail-closed | test-feature-flag-update 4/0 |

**FIXED (were defects):**
- **Fake surfaces:** fake providers, WhatsApp bookings, client booking / lead-fee / review writes, the KES 0 invoice, and the fake "Booking confirmed".
- **Self-publish bypass (live P0):** ported OB-1 plus the application write.
- **Search:** suspended providers stayed in Algolia; Typesense indexed pending providers.
- **Verified badge:** had no admin grant path, and the owner could forge it via providerVerified.
- **Fake AdminOS signals:** "0.0 ⭐" for unknown ratings, and enquiries / calls marked AVAILABLE with nothing behind them.
- **Commission UI:**
  - the provider booking-fee field;
  - per-plan commission copy;
  - the commission keys on plans.html;
  - Super Admin editing a document no server reads.
- **Feature flags:** an omitted `enabled` switched a flag ON.
- **Messaging:** "Message" dead-ended.
- **Tech Hub pages:** demo AI and device feeds now show honest empty states.

**PRE-EXISTING (not caused here):**
- test-compact-premium-cards: 4 browser fails;
- test-adminos-head-defer: 4 fails;
- test-messages-premium: 6 fails;
- test-overlays: 2 fails.

**UNPROVEN:**
- every browser / emulator suite — test-admin-layouts reported 1 inconclusive failure while starved at 35 MB free;
- a live booking → IntaSend → completion → settlement run;
- the rules patch (applied on f3 a6e7b31; emulator pending).

**BLOCKED (owner named):**

| Item | Owner |
|---|---|
| Approval-time category stamp | sokoni-5b |
| Settlement 5 % port (gate must pass on the release tree) | sokoni-5b |
| Buyer total / providerServices.fee ignored | sokoni-5b |
| Offers (shopOffers service scope) | sokoni-5b, Food Gate 4 |
| Commission on discounted amounts | owner decision |
| Provider-trust rules emulator proof | sokoni-f3 |
| Voice masking | owner decision (needs a voice provider) |

**NOT BUILT:**
- capability-specific screens (supportTickets, remoteSupport, siteVisits, networkProjects, cctvInstallations, posSupport, projects, diagnostics, pickupDropoff);
- booking-status system messages for providerBookings (needs a new trigger);
- AdminOS: lead moderation actions and a verification-history view (verification-admin.html already exists);
- Ask Hub / Startups / Jobs browser writes on tech-hub (residue, other owners).

## Release order (when unblocked)

1. sokoni-5b's ONE providerDispatch release. It carries:
   - 5b's own changes: booking PIN, discovery, capability engine, category stamp, the ported 2f commercial settlement;
   - this line, feat/tech-taxonomy-on-13f74f3: 81cde54 → 25ef259 and later.

   It must pass `TREE=<release> node scripts/gate-service-commission.js`. It must also pass test-provider-publish-hotfix, test-provider-onboarding-intake and test-service-leads.
2. messagesDispatch (messages.js: service_booking / service_lead).
3. adminOsDispatch. It MUST carry 25ef259 (feature flag) and 4ab4eb7 / 1f813e7 (adminGetProviders, adminGetServiceLeads).
4. verificationDecide / verificationRevoke (badge projection).
5. Algolia / Typesense provider triggers (scoped), then a read-only check plus a one-off reconcile.
6. The rules release (f3 a6e7b31, provider-trust keys) after emulator proof.
7. The combined hosting release from live (hosting/techhub-on-chain merged per the assembly manifest, services.html three-way, generated snapshot from 2f).
8. After each step, verify live with a cache-buster or the function revision. Run every UNRUN browser / emulator suite above the memory floor before step 7.
