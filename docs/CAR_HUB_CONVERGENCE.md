# Car Hub convergence — authority map and slice plan

**Owner brief:** 2026-10-03. **Owner of this work:** sokoni-f3. **Status:** census done; slice C1 (containment) in progress; **nothing deployed.**
**Branch:** `hosting/carhub-containment-on-adb5f4d`. It is built on the Home Services integration line, which already contains sokoni-e3's car-page WhatsApp removals (`14ea4f7`, `42dd9b0`). sokoni-b2's `2ddaee5` (confirmBooking fee removal) is reproduced in C1b.

Related: [[HOME_SERVICES_BOOKINGS]] · [[SERVICE_LEADS]] · [[Payments]] · [[Applications]] · [[project_home_services_monetization]]

## Target

Every Car Hub role follows the platform's ONE lifecycle:

1. application (HubRegister → `applications`);
2. AdminOS review;
3. approval (`applicationDecide`);
4. provisioning of the provider/business record;
5. category stamp (`business`, server-only);
6. capability engine;
7. dashboard modules;
8. storefront;
9. services or vehicles;
10. leads/bookings (SokoniLeads / SokoniBookService);
11. IntaSend payment (`createPaymentIntent` → verified webhook);
12. held money, then the booking PIN;
13. settlement into the business wallet, with SOKONI's commission taken there.

The business wallet is never the buyer's personal wallet (Financial Core, owner 2026-09-28).

## Commercial keys (sokoni-2f commission authority @ `07ba2fd`, not deployed)

| Path | Key | Rate |
|---|---|---|
| Vehicle sale | `vehicles` (alias `car_hub`, `car_dealer`) | KES 2,000 flat |
| Car rental | `car_rental` | 5% (owner 2026-10-03, was 16%) |
| Mechanic / garage / inspection / any provider service booking | `services`, via the booking engine | 5%, provider-paid at settlement |
| Leads | none | free; no lead fee is configured |

Bare labels such as `car`, `car-hub`, `vehicle`, `mechanic`, `garage`, `inspection` and `tracking` match **no** row. Pages must send canonical keys only. A new key, such as tracking fees, is added by 2f at the authority.

## Census (2026-10-03, read-only; full evidence in the session record)

| Surface | Class | Defect |
|---|---|---|
| car-rental.html | FAKE + CLIENT-AUTHORITATIVE money | 7 hard-coded cars with ratings and phones. A browser STK push used a browser amount and reference, with no payment intent and no provider, so the money could never reach a business wallet. Then it showed a false "deposit confirmed, provider notified". The `carRentals` write went through a second Firebase app. Invented stats, price guide and reviews; "insurance included". |
| mechanics.html | FAKE (gated) + CLIENT | Stored XSS (name, bio and services rendered raw). Default 5★ / jobs / years. Raw `tel:`. Booking = localStorage + `waConnect(category:'plumbing')` + "Booking recorded". Register wrote `mechanics/{MCH…}` with rating 5 and no uid (always refused) and then said "now live". Local-only parts market, ask-hub and repair tracker. |
| car-hub.html (16 tabs, 362 KB) | FAKE + CLIENT | Simulated GPS presented as "Live Map". Self-approved driving licence (`approveDLFromQueue` rendered to the user). `confirmBooking` records commission `auto_collected` and a fee `paid` with no payment. Tracking plans: hard-coded prices, undefined `SokoniMpesa`. Inline duplicate of CarHubPro writing rule-less collections through second apps `ch-write` / `ch-rt`. |
| sokoni-carhub-pro.js | FAKE + DUPLICATE | Finance partners (bank rates and phones), inspection centres, transport firms (invented, with ratings). Dealer "revenue" summed from unpaid local bookings. Hard-coded AI price. `fsWrite` would route requests into `applications/` (intake pollution). |
| `trackingSubscriptions/{uid}` rule | CLIENT-AUTHORITATIVE | The owner can write their own plan, i.e. free self-activation. |
| functions/vehicle-hub.js (10 callables) | CANONICAL, unused | No client calls it. `updateVehicleListing` lets the seller set `status`, and publishing has no moderation. |
| NTSA / insurance / finance / roadside dispatch | INCOMPLETE | No server integration exists. External links only. |
| Applications | INCOMPLETE | HubRegister car ids: mechanic, car-wash, car-rental, auto-parts, driving-school, insurance-auto. Only `mechanic` maps to a role. No applicant path for dealer, inspection, fleet, tracking, transport/towing, roadside, finance or NTSA. No car service-mode capabilities exist. |
| AdminOS | INCOMPLETE | admin.html has a localStorage DL "queue". admin-os.html has no car area. |

## Slice plan

| Slice | Scope | Status |
|---|---|---|
| **C1a** | car-rental.html + mechanics.html containment (registry, booking engine, leads, HubRegister; fakes and client money removed) | **built** (this commit) |
| C1b | car-hub.html containment: confirmBooking fee/commission (b2 `2ddaee5` wording); no DL self-approval; no simulated "live" GPS; tracking plans "not available yet"; CarHubPro fakes removed; SOS → critical support ticket; finance/inspection/transport "not available yet" until providers and authorities exist | next |
| C2 | Rules: `trackingSubscriptions` server-only (combined rules line) | queued |
| C3 | Applications + capabilities: car ids in HubRegister / role mapping / `service-capabilities.FROM_BUSINESS_ID` (copy b2 `81cde54`), on the capability tip; AdminOS approval provisions providers | queued (needs b2/5b coordination) |
| C4 | Vehicle sale on `vehicle-hub.js` (moderated publish, seller cannot set status; `vehicles` KES 2,000) | queued (functions) |
| C5 | AdminOS Car Hub section (Slice C1 nav hierarchy) + Super Admin visibility | queued |
| C6 | Tracking packages in sub-billing (2f catalogue, owner prices) + a webhook purpose (5b) | queued (owner prices needed) |
| C7 | NTSA / insurance / finance: real integrations only, otherwise an honest "not available" | blocked on external contracts |

## C1a test

`node scripts/test-carhub-containment-static.js`: **28/0**. A mutation that re-adds a raw `tel:` fails M3.

Retargeted suites:

- `test-compact-premium-cards` now accepts the car-rental delegated handler.
- `test-secondary-firebase-apps`: the `cr-write` baseline entry is removed (9/0).
- `test-slice-b-support-whatsapp` W11: the home-services quote row now asserts the lead path.

The remaining W10 failure is pre-existing (electrical / phone-repair, sokoni-b2's pages). Browser suites were not run (memory floor).
