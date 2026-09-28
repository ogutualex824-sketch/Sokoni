# Business Category Authority (convergence C1)

> CHANGELOG 236. Part of the platform convergence spine:
> [[Applications]] → [[AdminOS]] approval → **server category** → [[Dashboards]] (C2) → [[Subscriptions]] (C6) → [[Discovery]] (C3).

## The rule

There is ONE canonical business category, `providers/{uid}.business`:

```
business = {
  category,       // one of functions/business-category.js CATEGORIES, or null = UNCLASSIFIED
  lane,           // { hub: 'healthcare' | 'entertainment' | 'provider', entClass }. The commercial lane, frozen at approval.
  source,         // 'application' | 'admin'
  applicationId, setAt, classifiedBy?
}
```

- **Set by the server at approval** (`application-lifecycle.projectProvider`). It comes only from an EXACT match on what
  the applicant chose: `hub-register.js` business ids, or `provider-onboarding.js` professions.
- **The result is UNCLASSIFIED (null)** when:
  - two fields disagree;
  - nothing matches;
  - the answer conflicts with the decided role;
  - the only signal is a hub name.

  An UNCLASSIFIED business is never publicly eligible and waits in **AdminOS › Business Categories**.
- **Set by an administrator** through `bizAdminClassify`. It is audited in `adminAudit` and needs a reason.
  - It refuses categories owned by another authority: Lawyer is owned by legal-verification, Event organizer by the
    event_organizer role, Delivery by the driver role.
  - It refuses to cross the Healthcare boundary in either direction.
  - It refuses a business that is not yet approved.
- **Never set by the provider, and never by a raw client write, admin included.** `firestore.rules` protect `business`
  on `providers` for create and update. An approved application's classification fields (`role`, `category`,
  `subcategory`, `hub`, `performerType`, …) are frozen for its applicant.
- **Healthcare is the reference pattern, not a parallel list.** Healthcare's six categories are this registry's. A
  health provider's `business.category` and `healthcare.category` are one decision, written together by both
  `bizAdminClassify` and `healthAdminClassify`.

## Commercial rules are preserved, not flattened

- **The lane is decided by the existing classifier.** `business.lane` is exactly what
  `provider-hub.classifyDecidedApplication` has always decided: healthcare 5%, entertainment 5%, or the plan rate.
  It is now stamped once, at approval.
- **The commission lookup reads the stamp.** `resolveProviderClassification` reads the stamp first. Legacy providers
  without a stamp use the MOST RECENTLY decided application, not whichever was read first.
- **Commission tables are untouched.** `commission-config` RATES/ALIASES are not edited.
- **Reclassification never reprices.** An admin reclassification changes the category, not the lane, and the audit
  records the lane that stayed.

The category registry ([[Business Category Authority]]) is separate from the **product taxonomy** (`categories`
collection, `products.category`), which it does not touch.

## Mapping (review)

Judgment calls to confirm:
- catering → restaurant;
- butcher, farm, dairy → retail store;
- contractor and moving → trades;
- nutritionist and sports coach → service business;
- printing → service business;
- event planner → event services (not event organizer);
- photographer → artist/creator. Its commercial lane is entertainment SERVICE, which is what the existing classifier
  decides.
| Category | Label | Business types (hub-register.js) | Professions (provider-onboarding.js) |
|---|---|---|---|
| `clinician` | Doctor / Clinician | — | doctor, nurse, clinical officer, dentist, therapist, physiotherapist, nutritionist |
| `facility` | Clinic / Hospital / Facility | hospital, dental, optician, physiotherapy, mental-health, vet | — |
| `pharmacy` | Pharmacy | pharmacy | — |
| `laboratory` | Laboratory | laboratory | — |
| `telemedicine` | Telemedicine provider | — | — |
| `home_care` | Home health / Home care | — | — |
| `hotel` | Hotel / BnB | bnb, hotel | — |
| `restaurant` | Restaurant / Food business | restaurant, cafe, fast-food, bakery, food-truck, catering | — |
| `trades` | Trades & repairs (plumber, electrician…) | plumbing, electrical, carpentry, painting, ac-repair, landscaping, moving, contractor | electrician, plumber, carpenter, painter, welder, gardener, appliance repair, hvac, mover |
| `cleaning` | Cleaning & laundry | cleaning, laundry, pest-control | cleaner, pest control, laundry service, dry cleaner |
| `it_services` | Cyber / IT services | it-support, web-developer, software, app-developer, cctv, phone-repair, data-entry | cctv installation, access control, software developer, web designer, it support, network engineer, data analyst |
| `salon` | Salon / Barber / Spa | salon, spa, nail-art, makeup, tatoo | salon, barber, makeup artist, nail technician, spa therapist |
| `lawyer` | Lawyer / Advocate *(owned by legal-verification)* | lawyer, notary | lawyer, legal consultant, notary, arbitrator |
| `professional_services` | Professional services | accounting, tax-consultant, architect, insurance, insurance-auto, advertising, pr-firm, graphic-design, social-media | security consultant, graphic designer, marketing agency, pr consultant, business consultant, accountant, bookkeeper, architect, interior designer, structural engineer, quantity surveyor |
| `education` | Education & training | school, tutor, online-course, driving-school | tutor, private teacher, skills trainer, music teacher, language teacher |
| `auto_services` | Auto services | mechanic, car-wash | — |
| `fitness_studio` | Fitness studio | gym, yoga-studio, martial-arts, dance-fitness, spinning | — |
| `service_business` | Service business | security-guard, printing, nutrition, coach, tailor, shoe-repair | security guard, tailor, fashion designer, virtual assistant, copywriter, translator, research analyst, data entry |
| `artist_creator` | Artist / Creator | dj, mc, band, comedian, photographer, videographer, content-creator | photographer, videographer, content creator, dj, mc |
| `event_services` | Event services | event-planner | event planner, caterer, decorator, sound engineer, lighting technician |
| `event_organizer` | Event organizer *(owned by event_organizer role)* | — | — |
| `venue` | Venue | venue, sports-venue, swimming-pool | — |
| `retail_store` | Retail store | butcher, retail-shop, supermarket, boutique, wholesale, water-supplier, hardware, auto-parts, sports-equipment, agri-input, farm, dairy | — |
| `property` | Property | developer, landlord, property-agent | — |
| `delivery` | Delivery / Courier *(owned by driver role)* | courier, boda-delivery | delivery service, courier, freight agent |
| **UNCLASSIFIED** | classification required — AdminOS decides | car-rental, forex, sacco, football-club, basketball, other | — |

## Findings reported, not changed here

- **Payment/security BLOCKER, tracked and owned by the financial-core session (d6, FC-2):**
  - `webhookIntasend` takes its commission category from client `payments.meta.category`, so `saas` gives 0%.
  - The legacy `recordPayment` / `finos-router` / `settlement-engine` paths accept a caller-chosen category.
  - Target chain: approved business/category → authoritative transaction → canonical lane → server commission.
- **Deploy hazard:** `feat/creator-hub` lacks `1171a16`, the deployed P0 onboarding self-mint fix. Port it before C2 and before any `onboardingDispatch` deploy.
- **Inherited by `application-lifecycle.js`** and unchanged by C1: the release-only admin-claim grant (a do-not-deploy blocker) and the application self-approval vector.
- **Discovery consumers** (Typesense/Algolia facets, `sokoni-providers.js`) still filter on the provider-editable `providers.category`. C3 moves them onto `publicEligibility` and `categoryOf`.
- **An UNCLASSIFIED health provider is priced on the healthcare lane (role health).** That is preserved, and the commercial decision belongs to C6.
