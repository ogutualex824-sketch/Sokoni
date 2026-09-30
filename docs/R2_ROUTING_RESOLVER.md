# R2 — the workspace resolver routes on category + capability (both authorities, neither inferred)

**Date:** 2026-09-29 · **Line:** `slice/c4-capability-consumer` · **Server resolver only; NOT deployed.**
Contract: [[ROUTING_CONVERGENCE_CENSUS]] §5 with the owner's decisions (grandfather clause removed; DG Wine / Latomi stay CONFLICT; capability trusted only through the R1-protected authority). Precedes R3 (AdminOS classification manifest) and R4 (cards / surfaces).

## 1 · Exact change (`functions/business-workspace.js`, 166 changed lines; nothing else in `functions/`)

- **`categoryFor(providerDoc, businessDoc)`** — the category is READ from the stamp C1 wrote at approval: `providers/{uid}.business.category` (or the healthcare authority) via `BCAT.categoryOf`, else `businesses/{uid}.business.category` when its `source` is `application` or `admin` (a seller approved into a shop). Never from free-text `category`, `categoryLabel`, `hub`, `type`, an application, or the capability.
- **`laneOf(category)`** — `products` for C1's `SELLER_CATEGORIES`, `services` for every other C1 category, `null` for none.
- **`workspaceFor(db, uid)`** — `capabilityFor` (C2 read model over `sellers` / `providers` / `businesses`) first, then:

| category lane | capability | answer |
|---|---|---|
| products | PRODUCTS | the category's route (`merchant-v2.html`), AVAILABLE, modules OWN_WORKSPACE |
| services | SERVICES | the category's route and module states (unchanged behaviour: provider-dashboard, venue-manager, event-manager, driver, healthcare rows) |
| any | PRODUCTS_AND_SERVICES | `merchant-v2.html` + `servicesWorkspace: true`, service-module states kept |
| products | SERVICES only | `CAPABILITY_CONFLICT` / `CATEGORY_CAPABILITY_DISAGREEMENT`, **no route** |
| services | PRODUCTS only | same |
| none | any routable capability | `PENDING_CLASSIFICATION` / `UNCLASSIFIED`, **no route** — the grandfather clause is removed |
| any | UNCLASSIFIED | not found, or `PENDING_APPROVAL` (NOT_APPROVED / SUSPENDED), **no route** (before: the provider-dashboard holding route) |
| any | CONFLICT (read model) | `CAPABILITY_CONFLICT`, **no route** |
| — | unreadable | `CAPABILITY_UNREADABLE`, **no route** (before: the category path answered alone) |

  Every answer carries `category`, `lane`, `capability { classification, authorityStatus, conflicts }` and `servicesWorkspace`. Holding answers keep Overview + Settings AVAILABLE and every other module `PENDING_APPROVAL` with the reason, so `assertModule` and every entertainment/provider op gate refuse exactly as before.
- **`_categoryWorkspace(db, uid, prov, category)`** — now only the category route + module states for an approved, classified provider; the "no provider", "not approved" and **LEGACY_UNCLASSIFIED grandfather** branches are deleted.
- **`homeFor`** — carries the same fields; the "confirming what kind of business" message now comes from the resolver's `PENDING_CLASSIFICATION` answer.
- No write of any kind; no change to C1, to the read model, to the rules, to `workspace.html` or the dashboard projection (it already renders a route-less answer as a note).

## 2 · Ownership / provenance

C1 (`13597e4`…`62e38b3`) and the workspace authority (`ad7265b`…`300ddaa`, then `a7d142f` this track) are the owner's convergence lineage; no live session claims them (three peers confirmed). R2 edits the workspace authority only, and only its routing decision; C1 is consumed through `categoryOf` / `isCategory` / `SELLER_CATEGORIES` — not copied.

## 3 · The matrix, executed (`scripts/test-workspace-capability.js`, 51 / 0)

| case | seeded | answer |
|---|---|---|
| M1 | live seller + `businesses.business` hardware | merchant-v2, AVAILABLE |
| M2 | provider + cleaning | provider-dashboard, quotes AVAILABLE |
| M3 | provider salon + live seller | merchant-v2 + Services workspace, services AVAILABLE |
| M4 | provider electronics + live seller | merchant-v2 + Services workspace |
| M5 | provider, no stamp (the seven) | PENDING_CLASSIFICATION, no route |
| M6 | seller, no stamp | PENDING_CLASSIFICATION, no route |
| M7 | both, no stamp | PENDING_CLASSIFICATION, no route |
| M8 | provider + **wholesale** (SERVICES only) | CONFLICT / disagreement, no route |
| M9 | seller + trades (PRODUCTS only) | CONFLICT, no route |
| M10 | pending provider + cleaning | PENDING_APPROVAL, no route |
| M11 | suspended | PENDING_APPROVAL / SUSPENDED, no route |
| M12 | status without approval evidence | CAPABILITY_CONFLICT, no route |
| M13 | nothing | not found, no route |
| M14 | invariant | every routed answer has BOTH a category and a routable capability |

**DG Wine / Latomi.** As in production today (SERVICES stamped, no C1 stamp; free-text "wholesaler" is not read): **PENDING_CLASSIFICATION, no route.** Once C1 stamps `wholesale` (an admin act, R3): **CONFLICT / CATEGORY_CAPABILITY_DISAGREEMENT, no route** — not Merchant V2, not the provider dashboard. Control: the same record with an admin-stamped services-lane category routes to the provider dashboard.

**Consumes, does not re-derive** (static, comment-stripped): requires `./shared/business-capabilities` and calls `readModel()` exactly once; never tests `approvedAt` / `adminApproved`; never spells a capability classification (`CAPS.CLASSIFICATION` only; `'UNCLASSIFIED'` appears solely as the pending-classification reason); never requires `business-scope`; reads no free-text category / label / hub / type; lane only from `BCAT.SELLER_CATEGORIES`; no `LEGACY_UNCLASSIFIED`.

## 4 · Regression — one Chromium at a time

Node: business-workspace 30/0 · workspace-gates 24/0 · healthcare-workspace 51/0 · accommodation-profile 6/0 · audit-category-dashboards 6/0 (`--gate` exit 0, generated matrix unchanged) · migrate-capability-identity 28/0 · ent-availability 88/0 · ent-communications 76/0 · ent-journeys 49/0 · entertainment-bookings 95/0 · provider-agreement-role 27/0 · provider-directory 40/0 · business-capabilities 46/0 · business-category 45/0 · verify-capability-consumers 18/0. Browser: workspace-routing 33/0 · projection-browser 29/0 · business-category-admin-shops-browser 13/0 · business-category-admin-browser 13/0 · ent-availability-browser 54/0 · provider-dashboard-sidebar-browser (see §5). Pre-existing, unrelated: entertainment-registry 64/1 on the untouched tip.

## 5 · Explained assertion changes (no fixture was bent to go green)

- **Grandfather removed** — `test-business-workspace` "UNCLASSIFIED (approved)" now expects PENDING_CLASSIFICATION with no route; `test-business-workspace-gates` "legacy" now expects every op refused; `test-migrate-capability-identity` expects PENDING_CLASSIFICATION for the migrated identities.
- **Producer-shaped fixtures** — a shop is a live seller plus the `businesses.business` stamp `projectSeller` writes (a provider-only record with a products-lane category is a disagreement, and the suite now says so); approved entertainment providers carry the stamp `projectProvider` writes, derived through the real classifier (`categoryFromApplication`) and the real lane classifier (`provider-hub.classifyDecidedApplication`), and only when the application was decided — an undecided provider has no stamp, which is what keeps the "unverified artist" cases meaningful.
- **Sidebar suite** (90 / 0) — the photographer expectation is derived from the authority (`modulesForProfile(artist_creator)`: 19 AVAILABLE sections) instead of the literal "every item but Content", and compares the SET of visible sections rather than the count of visible items (the sidebar renders several items per section — three for Storefront — so an item count of 24 was measuring markup, not modules). The suite also waits for the projection to apply (`data-ws-state`) before measuring, so an unapplied fallback can no longer pass as an answer.
- **Unreadable capability** — no route (fail closed), replacing the earlier "category path answers".

## 6 · What R2 leaves exactly as it was

`homeFor` still lists a shop-owner home from `shops` ownership, the driver home from the `rider` claim, creator and venue homes from their own registries — those are other workspaces' authorities, unchanged and out of scope; the business home is the only one this contract governs. KASS, the four status-only accounts, the seven unclassified providers, the 34-record manifest, branch models, cards, Spotlight/App Check, AdminOS counts: untouched. The client projection keeps a dead `LEGACY_UNCLASSIFIED` exception (never matched now); removing it belongs to R4. No deploy.
