# Catalogue capability matrix

**Generated from `functions/shared/catalogue-capabilities.js` on 2026-09-29 (universal catalogue U2).** The module is
the machine-readable authority; this page is a view of it. Keyed on the 31 canonical categories of
`functions/business-category.js`, which the 105 registered business ids and 73 professions resolve to. Proven by
`scripts/test-catalogue-capabilities.js` and `scripts/test-catalogue-u3-browser.js`.

Related: [[UNIVERSAL_CATALOGUE_CENSUS]], [[PRODUCT_OFFERS]], [[SHOP_AVAILABILITY_AUTHORITY]]

**Listing types** (`sokoni-listing-types.js`, extended in U2 with package / bundle / custom_job / project): `product`, `food`, `drink`, `room`, `service`, `event`, `rental`, `property`, `vehicle`, `digital`, `package`, `bundle`, `custom_job`, `project`.
The owner's object types map onto them: MENU_ITEM → food / drink, ROOM → room, EVENT / TICKET → event, BOOKABLE_ITEM → service, VEHICLE → vehicle / rental, PROPERTY → property, DIGITAL_PRODUCT → digital, CUSTOM_JOB → custom_job, PROJECT → project.

**Flags are permissions, not promises.** A flag says a surface may offer the capability to this kind of business. Stock always moves through `merchantAdjustStock`, and bookings through the booking authority.

| Category | Business ids | Profile | Listing types | Inv | Book | Quote | POS | Mkt | Staff | Fulfilment | Compliance (declared until verified) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `clinician` | — (professions / roles) | healthcare | service, package, digital | — | ✓ | — | — | ✓ | ✓ | onsite, visit, online | professional_licence |
| `facility` | hospital, dental, optician, physiotherapy, mental-health, vet | healthcare | service, package, product | ✓ | ✓ | — | ✓ | ✓ | ✓ | onsite, pickup | health_facility_licence |
| `pharmacy` | pharmacy | healthcare | product, bundle, package, service | ✓ | ✓ | — | ✓ | ✓ | ✓ | delivery, pickup, onsite | pharmacy_licence, kebs |
| `laboratory` | laboratory | healthcare | service, package | — | ✓ | — | — | ✓ | ✓ | onsite, visit | health_facility_licence |
| `telemedicine` | — (professions / roles) | healthcare | service, package, digital | — | ✓ | — | — | ✓ | ✓ | online | professional_licence |
| `home_care` | — (professions / roles) | healthcare | service, package, custom_job | — | ✓ | ✓ | — | ✓ | ✓ | visit | professional_licence |
| `hotel` | bnb, hotel | accommodation | room, package, food, drink, service | ✓ | ✓ | — | ✓ | ✓ | ✓ | onsite | business_permit, food_licence |
| `restaurant` | restaurant, cafe, fast-food, bakery, food-truck, catering | food | food, drink, package, bundle, product | ✓ | — | — | ✓ | ✓ | ✓ | delivery, pickup, onsite | food_licence |
| `trades` | plumbing, electrical, carpentry, painting, ac-repair, landscaping, moving, contractor | quoted_service | service, custom_job, project, package, product | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | visit, pickup | professional_licence |
| `cleaning` | cleaning, laundry, pest-control | quoted_service | service, package, custom_job | — | ✓ | ✓ | — | ✓ | ✓ | visit, onsite, pickup | — |
| `it_services` | it-support, web-developer, software, app-developer, cctv, phone-repair, data-entry | quoted_service | service, product, digital, package, bundle, custom_job, project | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | onsite, visit, delivery, pickup, digital | kebs, ownership |
| `salon` | salon, spa, nail-art, makeup, tatoo | appointment_shop | service, package, product | ✓ | ✓ | — | ✓ | ✓ | ✓ | onsite, visit | business_permit |
| `lawyer` | lawyer, notary | quoted_service | service, package | — | ✓ | ✓ | — | ✓ | ✓ | onsite, online | legal_credential |
| `professional_services` | accounting, tax-consultant, architect, insurance, insurance-auto, advertising, pr-firm, graphic-design, social-media | quoted_service | service, package, project, custom_job, digital | — | ✓ | ✓ | — | ✓ | ✓ | onsite, online, digital | professional_licence |
| `education` | school, tutor, online-course, driving-school | learning | service, package, digital, event | — | ✓ | — | — | ✓ | ✓ | onsite, online, digital | — |
| `auto_services` | mechanic, car-wash, car-rental | quoted_service | service, package, product, custom_job, rental, vehicle | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | onsite, pickup, delivery | vehicle_docs |
| `fitness_studio` | gym, yoga-studio, martial-arts, dance-fitness, spinning | appointment_shop | service, package, product, event | ✓ | ✓ | — | ✓ | ✓ | ✓ | onsite, online | — |
| `service_business` | security-guard, printing, nutrition, coach, tailor, shoe-repair, football-club, basketball | quoted_service | service, package, custom_job, product, event | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | onsite, visit, pickup, delivery | — |
| `artist_creator` | dj, mc, band, comedian, photographer, videographer, content-creator | entertainment | service, package, digital, event, custom_job | — | ✓ | ✓ | — | ✓ | ✓ | onsite, online, digital | — |
| `event_services` | event-planner | entertainment | service, package, custom_job, project | — | ✓ | ✓ | — | ✓ | ✓ | onsite | — |
| `event_organizer` | — (professions / roles) | events | event, package | — | ✓ | — | — | ✓ | ✓ | onsite, online | event_permit |
| `venue` | venue, sports-venue, swimming-pool | events | service, event, package | — | ✓ | — | ✓ | ✓ | ✓ | onsite | business_permit |
| `retail_store` | butcher, retail-shop, water-supplier, auto-parts, sports-equipment, manufacturer | commerce | product, bundle, package, digital | ✓ | — | — | ✓ | ✓ | ✓ | delivery, pickup | kebs, ownership, food_licence |
| `supermarket` | supermarket | commerce | product, bundle, package | ✓ | — | — | ✓ | ✓ | ✓ | delivery, pickup | kebs, food_licence |
| `wholesale` | wholesale, wholesaler, importer | commerce | product, bundle, package | ✓ | — | ✓ | ✓ | ✓ | ✓ | delivery, pickup | kebs, food_licence |
| `hardware` | hardware | commerce | product, bundle, package | ✓ | — | ✓ | ✓ | ✓ | ✓ | delivery, pickup | kebs |
| `electronics` | electronics | commerce | product, bundle, package, digital, service | ✓ | ✓ | — | ✓ | ✓ | ✓ | delivery, pickup, onsite, digital | kebs, ownership |
| `fashion` | boutique | commerce | product, bundle, package, custom_job | ✓ | — | ✓ | ✓ | ✓ | ✓ | delivery, pickup | — |
| `agriculture` | agri-input, farm, dairy | commerce | product, bundle, package, service | ✓ | — | — | ✓ | ✓ | ✓ | delivery, pickup | kebs, food_licence |
| `property` | developer, landlord, property-agent | property | property, rental, service, project | — | ✓ | ✓ | — | ✓ | ✓ | onsite | property_title |
| `delivery` | courier, boda-delivery | logistics | service | — | — | — | — | — | — | delivery | — |
| *unclassified* | forex, sacco, other, and any shop not yet classified | — | product, bundle, package, digital | ✓ | — | — | ✓ | ✓ | ✓ | delivery, pickup | kebs, ownership, food_licence |

**Unclassified** shops keep exactly today's goods selling. SOKONI classifies a shop in AdminOS; a type is never granted by guesswork.

**Enforcement today:**
- the merchant-v2 Listing Studio offers only the permitted types;
- the merchant writer refuses an explicit type outside the row;
- **both are CLIENT-side.** The server-side equivalent (product rules / a writer callable) is stage 3, gated for the owner's review.
