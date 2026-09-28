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
- ~~**Discovery consumers** (Typesense/Algolia facets, `sokoni-providers.js`) still filter on the provider-editable `providers.category`.~~ Done in C3a-1 and C3a-2; see [Discovery (C3)](#discovery-c3).
- **An UNCLASSIFIED health provider is priced on the healthcare lane (role health).** That is preserved, and the commercial decision belongs to C6.

## Discovery (C3)

Public discovery answers to this authority and to nothing else. `publicEligibility(provider)` is the ONE predicate:

- status is `active` or `approved`;
- not suspended (status or flag);
- `searchable !== false`;
- `isPublic !== false` (added in C3a-2);
- **classified**, meaning `categoryOf` returns a C1 category.

An unclassified provider, including one approved before C1, is **not discoverable** until AdminOS classifies it (owner
decision 2026-09-28). Its dashboard keeps working (C2).

| Path | Uses | Slice |
|---|---|---|
| Search indexes (Algolia + Typesense: every trigger, reconciler, backfill, admin reindex) | `discovery-eligibility.prepareForIndex`: ineligible upsert → delete, facet = C1 category | C3a-1 (CHANGELOG 243) |
| `searchQuery` | a services category filter must be a C1 key (`UNKNOWN_CATEGORY`); the client cannot choose `status` | C3a-1 |
| Public provider directory (`providerDispatch { op:'providerDirectory' }`) | `provider-directory.js` → `cardIfEligible`: a whitelist card under the C1 category | C3a-2 (CHANGELOG 244) |
| `sokoni-providers.js` (providers / services / cleaning / index / provider-profile) | the directory; no browser Firestore read | C3a-2 |
| Search fallback (`sokoni-firestore-search.js`, providers) | the directory (`remote` spec) | C3a-2 |
| `providerSearchProviders`, `providerGetPublicProfile` | the directory (`listDirectory` / `cardIfEligible`) | C3a-2 |
| `healthcareDirectory` | `publicEligibility`, restricted to a healthcare category that agrees with the healthcare authority | C3a-2 |
| An owner's public change → its profile + services (both engines' `providers` triggers) | `discovery-eligibility.cascadeOwnerChange`: re-queues dependents as upserts; the queue's gate decides delete vs index | C3b-1 (CHANGELOG 245) |
| `providerPublish` → `providerProfiles.searchable` | mirrors `publicEligibility` (no longer a status-only reading); `status:'active'` there is the onboarding state | C3b-1 |

**The C3b-1 invariant:**

```
authoritative provider change (approval · suspension · inactivation · searchable · isPublic · reclassification · delete)
        ↓  discoveryChanged(before, after) — eligibility flipped, or the C1 category changed while eligible
requeue providerProfiles/{uid} + every providerServices (providerId or uid) as UPSERT
        ↓  the SAME gated enqueue (prepareForIndex)
eligible → indexed under the owner's current category        ineligible → DELETE
```

- **No second definition.** The cascade never decides delete versus index; it only re-queues.
- **Idempotent.** Queue entries are keyed `collection_docId`.
- **Bounded.** Pages of 100, at most 500 services per change. A truncation is logged, and C3b-2 covers the rest.
- **Fail-soft.** A cascade error is logged and never fails the provider's own sync.
- **Cheap.** A content edit does not cascade.
- **Engines.** Typesense maps neither dependent, so its cascade enqueues nothing today. It is still wired, so it follows
  if Typesense ever maps them.

**Retired browser paths (C3a-2):**

- the `realtime.js` hub bridge, which copied raw providers into hub localStorage lists;
- the `services.html` raw `providers` listener, which fed `sokoniServiceProviders`, the list `legal-hub` reads.

**Legacy registries de-indexed** (owner decision): `mechanics`, `lawyers`, `healthProviders`, `homeServiceProviders`,
`services`. The collections are untouched. Verified lawyers remain discoverable: the Legal authority provisions a
`providers` doc, which `categoryOf` classifies as `lawyer`.

**Out of C3:** shop and merchant discovery (`businesses` → `sokoni_shops`, sellers, products) stays in the existing
merchant search architecture.

**Next:**

- ~~C3b-1: a flip in a provider's eligibility or category re-queues its services and profile.~~ Done (CHANGELOG 245).
- ~~C3b-2: a batched, resumable, dry-run cleanup of records already in the indexes, which is NOT run.~~ Written and
  tested (CHANGELOG 246), **not executed**. See [Existing-index cleanup (C3b-2)](#existing-index-cleanup-c3b-2).

## Existing-index cleanup (C3b-2)

`functions/discovery-cleanup.js` is the core; `scripts/discovery-cleanup.js` is the CLI. It is a **reconciliation tool,
not a discovery authority**. It walks records ALREADY in an index and asks the same C3a-1 gate whether each may stay.

**It starts from the index, not Firestore.** Firestore-driven reconcilers cannot see an orphaned record, whose source
doc is gone.

**Ownership is resolved, never read from the id.** A record does not say which collection wrote it: Algolia
`sokoni_services` is written by 7 collections keyed by raw doc id (`providers/{uid}` and `providerProfiles/{uid}` share
one objectID); Typesense uses raw ids too; `sokoni_properties` / `sokoni_hotels` mix `bnbListings` with out-of-scope
collections. Each record is resolved against every collection that writes its index:

| Verdict | When | Action |
|---|---|---|
| `OUT_OF_SCOPE` | no writer of the index is C3 provider discovery (shops, products…) | **retain**, with no Firestore read |
| `SHARED_OUT_OF_SCOPE` | a doc with this id exists in an out-of-scope collection of the index | **retain** |
| `ELIGIBLE` | an in-scope source passes the gate, even if a same-id sibling is stale | **retain** |
| `STALE` | in-scope source(s) exist and the gate refuses every one | **remove** |
| `ORPHAN` | no source anywhere, and every writer of the index is in scope | **remove** |
| `UNATTRIBUTABLE` | no source in a MIXED index, or an id that cannot be a doc id | **retain** |
| `PRIMARY_RETAINED` | a global copy whose primary record would be retained | **retain** |

Global copies (`{collection}_{docId}`) are SUBORDINATE to their primary's verdict: a queued delete also removes the
primary record, so a global copy goes only when its primary would.

**Guarantees:**

| Mode | Guarantee |
|---|---|
| Dry run (the default) | zero engine deletes and zero Firestore writes |
| Live | only the EXISTING gated queue, as `delete` entries; never a direct Algolia / Typesense call, never provider data, never an approval or a publish |
| Error | `failed` AND retained |
| Bounds | page size, pages per run, removals per run |
| Resumable | via `nextCursor` |
| Idempotent | yes |
| Report | examined / eligible / removed / (would remove) / retained / failed, by verdict |

**The CLI** needs an explicit `--project` and runs a dry run by default. `--apply` needs
`SOKONI_C3B2_APPLY_AUTHORIZED=<same project>` and is refused on production outright in this programme. A dry run
against production is a production READ, so run one only when the owner asks.

**Evidence boundary.** The engine readers (Algolia browse, Typesense id export) are thin and have been exercised ONLY
against fake clients. The suite's indexes are in-memory fixtures. Nothing here is evidence about live index contents.

**Pre-existing Algolia findings (reported, not changed):**
- The queue writes global shadows to an index named `global_search`, while `COLLECTION_INDEX_MAP` names the global
  index `sokoni_global`.
- `gs__providerServices` and `gs__providerProfiles` have no map entry, so the queue processor SKIPS their shadow
  upserts (`if (!mapping) continue`): they are never indexed and never marked done. Deletes are unaffected, since
  deleting by objectID needs no mapping. The cleanup's global writer set (`globalWritersOf`) includes them regardless.

**Open (reported):**

- **The `providers` read rule still allows a public read of `active`/`approved` docs, phone included.** Tightening it
  follows once no public page reads `providers` directly.
- **Directory pagination.** The directory reads at most 300 providers per query and reports `truncated`.
- **Legacy registry specs still in the search fallback.** `mechanics`, `healthProviders`, `lawyers` and `services` are
  browser-scanned there.
- **Hub pages that read legacy localStorage lists.** These need their own convergence: `mechanics.html`,
  `fitness-hub.html`, `home-services.html`, `bnb.html` and `legal-hub`.
