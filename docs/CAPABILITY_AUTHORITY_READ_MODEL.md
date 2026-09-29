# Capability authority — read model (C2)

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` · **READ ONLY. Stamps nothing. Imported by no production path. Not deployed.**
Follows [[CLASSIFICATION_STOREFRONT_CENSUS]] (777fcef). Governs C3–C8 of the classification track. Related: [[Marketplace]], [[Authentication]].

## 1 · The model the owner locked

```
Business (ONE identity: businesses/{businessId})
  ├── identity        name, owner uid, shop, provider record (kept as the service-domain record)
  ├── branches        one branch model shared by products and services (C6/C7)
  └── capabilities    an APPROVED FACT, stamped at approval — never derived later
       ├── PRODUCTS   approved | pending | suspended | revoked | absent
       └── SERVICES   approved | pending | suspended | revoked | absent
```

Three legitimate, routable classifications: **PRODUCTS**, **SERVICES**, **PRODUCTS_AND_SERVICES**. Two read-model states that are never routable: **UNCLASSIFIED** (nothing approved) and **CONFLICT** (records disagree).

**Capability is additive and independently approvable.** PRODUCTS approved + SERVICES approved = PRODUCTS_AND_SERVICES. A business is never *transformed* from PRODUCTS into SERVICES because someone chose a service category. The existing `providers/{uid}` record stays as the service-provider domain record during convergence; it is not the long-term capability authority.

**Capability is never derived from:** category text, URL or source collection, card type, a localStorage role, `providers`/`sellers` existence alone, or the dashboard a user entered through.

## 2 · Where the authority will live (the stamp)

```
businesses/{businessId}.capabilities = {
  version: 1,
  PRODUCTS: { state, decidedBy, decidedAt, applicationId, source },
  SERVICES: { state, decidedBy, decidedAt, applicationId, source },
}
state  ∈ approved | pending | suspended | revoked | absent     (a missing key = absent)
source ∈ application_approval | admin
```

Written only by a server approval path (a later slice), never by a client; the rules slice adds `capabilities` to the protected field set. A stamp that does not validate is **INVALID_STAMP** and the business is **CONFLICT**: a malformed authority is not an authority. `validateStamp` refuses a client-shaped stamp (state without `decidedBy`/`decidedAt`/`source`), a wrong version, an unknown capability or an unknown state.

## 3 · The module

`functions/shared/business-capabilities.js` (pure; no Firestore, no clock). It **reuses** `business-scope.js` for liveness rather than restating it: a registry document is live only with a live status **and** protected approval evidence (`approvedAt` / `approved` / `adminApproved`).

| Function | In | Out |
|---|---|---|
| `observe(records)` | `sellers`, `providers`, the owner's `applications` (or null when not loaded), `businesses`, `shops`, attached product count (or null) | what production **contains**: `seller`/`provider` ∈ live · present_not_live · status_live_no_approval_evidence · absent; approved/pending/rejected capability requests; business/shop presence; product count; the stamp if any |
| `propose(observed)` | the observation | `classification`, `proposed {PRODUCTS, SERVICES}`, `authorityStatus` ∈ STAMPED · NOT_YET_STAMPED · INVALID_STAMP, `conflicts[]` (coded), `notes[]` |
| `readModel(records)` | records | `propose(observe(records))` |
| `resolveRouting(classification)` | a classification | the routing contract (§5) |

### Conflict codes (each makes the business CONFLICT, not routable)

| Code | Meaning |
|---|---|
| `seller_status_without_approval` / `provider_status_without_approval` | the registry doc says active/approved but carries no protected approval evidence — a client-writable status |
| `approval_without_projection` | an approved application exists, the registry document is not live |
| `products_without_products_capability` | products are attached to a business whose PRODUCTS is not live |
| `stamp_disagrees_with_registry` | a valid stamp and the registry disagree on a capability |
| `stamp_invalid` | the stamp does not validate |

`projection_without_application` is a **note**, not a conflict: a live registry with no approved application among those loaded (a pre-application-era record, or one approved by another path).

## 4 · The safety distinction the census must keep

The census never says "provider exists, therefore SERVICES". It reports:

```
observed:            provider = live · seller = absent · application = approved (SERVICES) · business = absent · shop = absent · products = 0
proposed capability: SERVICES approved · PRODUCTS absent
authority status:    NOT_YET_STAMPED
```

That is exactly the DG Wine and Latomi Gadgets shape from 777fcef, and it is asserted as such (`test-business-capabilities.js` D1–D3). **No product capability is proposed for a move to Business**; the fact that they hold zero products is respected.

## 5 · The routing contract (what C6 will wire, on the existing surfaces)

| Classification | Storefront | Card | Dashboard | Services workspace |
|---|---|---|---|---|
| PRODUCTS | existing premium product storefront | existing premium product card (wish list only, tap → product page) | Merchant V2 | no |
| SERVICES | existing premium provider/service storefront | existing informative provider card (no product buttons) | provider dashboard | no |
| PRODUCTS_AND_SERVICES | both, through ONE business identity | both | Merchant V2 | **yes** (the existing Services side entry, gated at last) |
| UNCLASSIFIED | none | none | none — reason "no approved capability" | no |
| CONFLICT | none | none | none — reason "a human must resolve" | no |

No default to provider, no default to product. The fourteen display-field resolvers in the census will be replaced by consumers of this contract, one slice at a time.

## 6 · Integration boundary with the category lineage

Category authority (`business-category.js`, `slice/c4-category-matrix`) is **not** copied into this branch. Category enters the classification layer only as an input on the business record (`business.category`, stamped by that lineage at approval). It **never decides capability**. The read model's code reads no `category`, `businessType`, `hub` or `type` field, and the suite asserts it (X1).

```
c4-category-matrix ── category authority ──▶ classification/application layer ──▶ approved capability ──▶ storefront · cards · dashboard · branch · AdminOS
```

## 6b · What the c4 lineage already built, and how the read model fits it (verified 2026-09-29)

The owner's note that "most business dashboards have been built by another agent" is correct, and it is the **c4 lineage** (`slice/c4-category-matrix` @ `4ad69bf`, worktree `C:/temp/sok-catmx`; shared history with `feat/creator-hub`). Both peer sessions confirmed they own none of it and that a capability stamp conflicts with nothing of theirs. On that lineage, none of which is an ancestor of this branch:

| Commit | What exists there |
|---|---|
| `025af79` | **"What Are You Offering?"** — `offer.html`'s 27 tiles open the ONE canonical Register-My-Business intake with a preselected category; zero tiles reach the legacy `provider.html` intake; "Already have a dashboard?" → `workspace.html` (`scripts/test-offer-intake.js`) |
| `300ddaa` | **one route to every workspace** — `workspace.html` asks the server (`functions/business-workspace.js workspaceFor(db, uid)`) |
| `functions/business-workspace.js` | **the ONE workspace authority**: C1 category (`business-category.categoryOf(providers/{uid})`) + approval state + Shop ownership + entitlement (`capability-authority.capabilitiesFor`) → `{ category, route, modules{state,reason}, blocked, entitlement }`; six module states; `ROUTE_OF[category]` (retail/restaurant → merchant-v2, services → provider-dashboard, venues → venue-manager, delivery → driver); `LEGACY_UNCLASSIFIED` for an approved provider with no category |
| `11b8f55`, `8c53ea5`, `cccb609`, `48d932d` | provider dashboard as a projection of that answer; premium merchant-v2-style provider shell; healthcare rows of the same authority; hotel/property land on the provider dashboard |
| `1310b53` | **executable category → dashboard matrix** for every registrable category (`scripts/audit-category-dashboards.js --gate`): 101/104 routed, 0 unrouted, 3 admin-review-only |

**How the capability read model relates to it.** `business-workspace.js` routes on the *approved category* (stamped at approval by the classifier — an approved fact, not free text). It has **no products/services dimension**: a salon or fitness studio profile lists `products`, `inventory`, `pos` as NOT_IMPLEMENTED, and a retail store can never carry bookings. The capability stamp is exactly that missing dimension: route = f(category, capabilities). PRODUCTS_AND_SERVICES on a `salon` category means merchant-v2 with the Services workspace, not provider-dashboard with products missing. The read model therefore **complements** the c4 authority and must be **consumed by it**, never sit beside it.

**Consequence for where the track is done.** The consumer of the capability authority (`business-workspace.js`), the offering intake, the category matrix and the classifier all live on the c4 lineage. C6–C8 (resolver, intake and console convergence) cannot be built here without re-implementing them, which the owner forbade. This read model is lineage-neutral (pure; it imports only `business-scope.js`, present on both lines), so it is committed here as the certified vocabulary and **ported verbatim to the c4 lineage when the owner names the base line**. The peer census (sokoni-d6) adds two facts to carry over: `hub-register.js:421-423` defaults every b2b / food / fashion / agri / construction category to `requestedRole: 'provider'` (which is how Latomi became a provider), and `\bwholesal\b` in `application-lifecycle.js:228` never matches "wholesaler" (which is how DG Wine did).

## 6c · Two distinctions pinned after peer review

- **Unstamped ≠ stamped with nothing.** No stamp → `NOT_YET_STAMPED`; a valid stamp with neither capability → `STAMPED` + `UNCLASSIFIED`. The suite asserts they differ (P14), so an unstamped business can never render as "offers nothing".
- **Naming.** `businesses.capabilities` is a different collection from the integration console's `integrations[].capabilities` (UI affordances) and `serviceCapabilities`; no consumer reads across them, and this track adds nothing to the integration registry or catalogue.

## 7 · What happens next (not started)

- **C3 — existing-identity classification census (read-only).** Run `readModel` over every owner uid in production: every `sellers`, `providers`, `businesses`, `shops` record and its applications and product count. Output one row per identity: observed · proposed · authority status · conflicts. This is the migration classification the owner asked for. Requires the production-read path to be allowed for the census script.
- **C4 / C5 — DG Wine, Latomi Gadgets.** From a C3 row reading `SERVICES / NOT_YET_STAMPED / no conflicts`: create/attach the business identity under the existing owner uid, create the shop identity, preserve the provider record, stamp **SERVICES only**, connect the branch identity. Explicit approval and an exact manifest each.
- **C6** resolver convergence · **C7** application-flow convergence (one "What are you offering?" primitive, stored) · **C8** AdminOS/Super Admin.

## 8 · Deployment guard

This branch lacks the production self-mint hotfix (`1171a16` is not an ancestor of HEAD). **No Functions deployment from this branch** until that provenance is resolved or the work is rebased onto a lineage that contains it. The read model changes nothing deployable in any case.

Evidence: `scripts/test-business-capabilities.js`.
