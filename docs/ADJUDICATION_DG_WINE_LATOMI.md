# Adjudication census — DG Wine and Latomi Gadgets (read-only; no mutation, no manifest applied)

**Date:** 2026-09-29 · **Production project** `sokoni-aeb26` · **READ ONLY.** Follows [[R3_LANDING]]. The deferred disagreement digest `9f8a96e8…8952` remains deferred. This document gathers the evidence and names the administrative decision each conflict requires; it decides nothing.

## 1 · The conflict, as the authorities state it

| | DG wines and spirits `Ohg9HrtGpCXBUSzbRfaUifOPWQ32` | Latomi gadgets `IaOBkEJYcCXk23UDWk0OPp7XXeD3` |
|---|---|---|
| C1 category from the approved application | **wholesale** (exact; a SELLER category, "Wholesale & distribution", lane products → Merchant V2) | same |
| stamped capability (C4 / C5) | **SERVICES = approved**, evidence = the provider approval of 2026-09-03 | same (C5) |
| resolver today (no category stamp) | PENDING_CLASSIFICATION, no route | same |
| resolver if `wholesale` were stamped | CAPABILITY_CONFLICT (products / SERVICES), no route | same |

## 2 · What the applicants actually said (the approved applications, verbatim fields)

| field | DG Wine | Latomi |
|---|---|---|
| form | Register My Business (`hub-register.js`), category id `wholesaler` → label **"Wholesaler / Bulk Supplier"**, hub **b2b**, `type: business` | same |
| description | "We offer door to door delivery to our esteemed clients. Opening hours 8.00 - 6.00" | "Laptop accessories / **We sell** phones ..new end ex uk / Tv" |
| `productTypes` / `services` / `serviceTypes` | none / none / none | none / none / none |
| `requestedRole` | absent | **provider** — the **live line's** form default (`hub-register.js:421-423` on `ship/catalogue-port-on-live`: `_ROLE_BY_HUB` maps only shopping → seller, delivery → rider, healthcare → health, legal → legal; every other hub, b2b included, falls to `'provider'`), not a choice the applicant made. The c4 line's form has no such field. |
| `role` stamped by the server | **provider**, `roleResolvedBy: keyword` | **provider**, `roleResolvedBy: explicit` (the default above) |
| decided | approved 2026-09-03 by `D5Ql2EYr…` | approved 2026-09-03 by `D5Ql2EYr…` |

**How "provider" happened.** `application-lifecycle.resolveRole` (`:242`) tests the seller keyword pool `\b(seller|merchant|vendor|shop|store|retail|stockist|wholesal)\b` against the pooled fields; the word is **"wholesaler"**, which `\bwholesal\b` never matches, so DG Wine fell through to the default `provider`. Latomi never reached the keyword pool: the live form's hub default `requestedRole: provider` (b2b is not in `_ROLE_BY_HUB`) was taken as an explicit declaration. In both cases the role is a **classifier artefact**, not an applicant's statement that they provide services. The C4/C5 SERVICES stamps inherited that artefact faithfully (their evidence *is* that approval), which is why the capability authority now disagrees with the category authority.

## 3 · What they have done since approval (production, read-only)

| activity | DG Wine | Latomi |
|---|---|---|
| provider bookings / services listed / enquiries / reviews / conversations | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 |
| orders as seller / POS transactions / wallet transactions | 0 / 0 / 0 | 0 / 0 / 0 |
| products in any collection | 0 | 0 |
| provider profile fields typical of a service business (`services`, `skills`, `rate`) | none | none |
| subscriptions (provider / merchant) | none / none | none / none |
| provider record public flags | `acceptsBookings: true`, `available: true`, `searchable: true` — set by the provider projection at approval, not by the business | same |

Neither has traded on the platform in either lane. The only service-shaped facts on the records are the projection's defaults.

## 4 · Finding on intended offering

Every applicant-authored fact — the category chosen ("Wholesaler / Bulk Supplier"), the b2b hub, Latomi's own words ("we sell phones"), the absence of any service, skill or rate, and the C1 exact match to a seller category — points to **PRODUCTS**. Nothing applicant-authored points to SERVICES. The SERVICES stamp rests on a role the server derived by a regex miss and a form default.

This is a finding about the evidence, not a decision. The model forbids inferring capability from category text, and it equally forbids treating a projection's defaults as the business's intent. Only an administrative decision can change either authority.

## 5 · The administrative decision each conflict requires, and the paths that exist

Three lawful resolutions exist for each identity; each needs an explicit owner/admin decision and its own exact manifest:

| option | what it asserts | how it would be done (existing mechanisms) | consequence under R2 |
|---|---|---|---|
| **A. PRODUCTS (re-decide the offering as a product business)** | the approval was of a wholesaler; the provider role was an artefact | (1) `capabilities.SERVICES → revoked` and `capabilities.PRODUCTS → approved` on `businesses/{uid}` with `decidedBy` the deciding admin, `source: admin` — **no server op exists yet for an admin capability decision** (stamping was prohibited through R3; this is the missing "capability decision" op); (2) the seller projection (`projectSeller`) for `shops/{uid}` + `sellers/{uid}` (+ `businesses.business = wholesale`) and the `seller` role via `grantAccountRole`; (3) retire the provider record from discovery (`searchable/isPublic false`) or keep it — a decision. | category wholesale (products) + PRODUCTS → **Merchant V2** |
| **B. BOTH (products and services)** | they also provide a service (e.g., delivery is DG Wine's own logistics, not a service sold) | the existing **`providerRequestShop`** path (`functions/provider-shop.js`) provisions the merchant identity for an approved provider: `projectSeller` + seller role, honoured only for an ACTIVE provider. It is a *provider-initiated* request today (built for healthcare shops), with `shopRequestable` gating; an admin-initiated variant would need its own op. | wholesale + PRODUCTS_AND_SERVICES → **Merchant V2 + Services workspace** |
| **C. SERVICES (keep, reclassify category)** | they are genuinely service businesses | AdminOS reclassification (`business-category-admin`, `source: admin`) to a services-lane category | services category + SERVICES → provider dashboard |

The evidence in §2–§3 supports **A**; nothing supports **C**; **B** would assert a service offering no evidence shows. Option A requires a mechanism that does not exist yet: an audited admin **capability decision** op (approve / revoke a capability on `businesses/{id}.capabilities`, `source: admin`, `decidedBy`, `decidedAt`), which the read model already validates and R1 already protects from clients. That op is the natural next server slice if the owner chooses A; the seller projection and role grant already exist.

## 6 · What this census does not do

No stamp, no reclassification, no PRODUCTS approval, no revocation, no shop, no role change, no discovery change, no deploy. The manifests for A, B or C are produced only after the owner chooses per identity, each as its own digest.
