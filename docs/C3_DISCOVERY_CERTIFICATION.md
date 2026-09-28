# C3 Discovery Certification

> Convergence programme · C3 (verified-only discovery) · certified at `f5643ad` on 2026-09-28
> Related: [[BUSINESS_CATEGORY_AUTHORITY]] · [[PROVIDER_REGISTRY]] · [[Search]] · [[AdminOS]]

## What this certifies — and what it does not

**C3 certifies the implemented and tested discovery authority and convergence mechanisms, and their tested behaviour.**
It does **not** certify that every existing production index is currently clean. C3b-2 was not executed, and no live
Algolia / Typesense inspection was performed.

C3 also does **not** claim that every user-facing recommendation or operator backfill path already consumes the
canonical discovery authority. The census below identified explicit exceptions, including the direct Typesense
backfill and the Kass discovery tools. They remain open findings, with remediation assigned to the appropriate later
slice.

"C3 complete" means the C3 authority and convergence slices are implemented and tested, with the carried-forward
exceptions documented. It does not mean every discovery defect in the repository is fixed.

## Authority chain

```
C1 category (providers/{uid}.business, server-stamped at approval)          13597e4
   ↓
approval / business state (AdminOS approval gate)                           ac413fe
   ↓
business-category.publicEligibility — the ONE predicate
   ↓
C3a-1 search-index gate  (discovery-eligibility.prepareForIndex)            d93fc01
   ↓
C3a-2 provider directory (providerDispatch { op:'providerDirectory' })      1b07fec
   ↓
C3b-1 owner-change cascade (re-queue dependents → the gate decides)         03ecfbc
   ↓
Algolia / Typesense (through the gated queues only)
C3b-2 existing-index cleanup — written and tested, NOT executed             f5643ad
```

C2 (the category workspace) is `11b8f55`.

## Summary

| Area | Status |
|---|---|
| Category authority (C1) | ✅ Closed |
| Approval / publication gate | ✅ Closed |
| Search eligibility gate (C3a-1) | ✅ Closed |
| Provider directory (C3a-2) | ✅ Closed |
| Eligibility-change cascade (C3b-1) | ✅ Closed |
| Existing-index cleanup tooling (C3b-2) | ✅ Closed |
| Cleanup execution | ⛔ **Not run** |
| Live search-index inspection | ⛔ **Not performed** |
| Known discovery follow-ups | 🟠 Open (below) |
| Census exceptions (Typesense backfill, Kass discovery) | 🟠 Open (below) |
| Algolia mapping / write defects | 🟠 Open (below) |
| Booking confirmation defect | Separate / Open |

## Surface-by-surface

| Surface | Path | Verdict | Evidence |
|---|---|---|---|
| Provider search | `providerSearchProviders` → `provider-directory.listDirectory` | ✅ Certified | C1 key only (`UNKNOWN_CATEGORY`), ineligible never listed · `test-provider-directory` |
| Provider directory | `providerDispatch { op:'providerDirectory' }` | ✅ Certified | `publicEligibility` · whitelist card (no phone, no self-set `featured`) · agrees with the index gate for every fixture · `test-provider-directory` 40/0 |
| Service search | `searchQuery` (services index) + both indexes' gate | ✅ Certified | unknown category refused, client cannot choose `status` · `test-discovery-index` 25/0 |
| Provider profiles | `providerGetPublicProfile`, `SokoniProviders.get` → `cardIfEligible` | ✅ Certified | approved-but-unclassified refused (E2a) · `test-provider-publish-authority` 32/0, `test-share-integrity-browser` 64/0 |
| Healthcare directory | `healthcareDirectory` → `publicEligibility` ∩ healthcare authority | ✅ Certified | `test-healthcare-directory` 51/0 |
| Hub directories (providers / services / cleaning / index / profile) | `sokoni-providers.js` → the directory | ✅ Certified | no browser read of `providers` · stale raw cache deleted · `test-provider-directory`, `test-in-app-booking-contact` 15/0 |
| Hub directories (legacy localStorage lists) | `mechanics.html`, `fitness-hub.html`, `home-services.html`, `bnb.html`, `legal-hub` | 🟠 **Open** (follow-up 3) | the bridge that fed them provider records is retired; the pages still render legacy lists |
| Algolia indexing | `algolia-queue.enqueue` (every trigger, reconciler, backfill) + C3b-1 cascade | ✅ Certified, with open defects A1–A2 | ineligible upsert → delete · `test-discovery-index`, `test-discovery-cascade` 24/0 |
| Typesense indexing | `typesense-queue.enqueue` + admin reindex (gated) + cascade | ✅ Certified **except** census finding N1 (direct backfill) and the backup restore (exception E1) | `test-discovery-index`, `test-discovery-cascade` |
| Search fallback | `sokoni-firestore-search.js` | ✅ providers spec → the directory · 🟠 **Open** (follow-up 2) legacy-registry specs | `test-provider-directory`; follow-up 2 |
| Legacy registry paths | `mechanics`, `lawyers`, `healthProviders`, `homeServiceProviders`, `services` | ✅ de-indexed at the gate · 🟠 **Open** browser paths (follow-ups 2 and 3) and Kass (N2) | `test-discovery-index` |

## Competing-path census (at `f5643ad`)

Method:
1. Every direct engine write in `functions/`: `saveObjects`, `partialUpdateObjects`, `importDocuments`,
   `upsertDocument`, `patchDocument`.
2. Every server list query on a provider-scoped or legacy-registry collection.
3. Every browser read of those collections.

Each hit is classified below.

**Direct engine writes:**

| Hit | Classification |
|---|---|
| `algolia-queue.js` processor (save / partial) | ✅ gated at `enqueue` |
| `typesense-queue.js` processor (import) | ✅ gated at `enqueue` |
| `typesense-admin.js` reindex | ✅ gated: `prepareForIndex` runs before transform and import |
| `typesense-backup.js` restore | ⚠ **Exception E1**: restores a snapshot ungated (admin disaster recovery, documented in C3a-1). A pre-C3 snapshot can re-introduce ineligible records |
| `functions/scripts/typesense-direct.js` | 🟠 **Finding N1** (below) |

**Server list queries:**

| Hit | Classification |
|---|---|
| `admin-os.js`, `business-category-admin.js`, `healthcare-admin.js` | AdminOS surfaces, not public discovery |
| `provider-ops.js`, `provider-onboarding.js`, `application-lifecycle.js` | owner-scoped or id lookups |
| `ent-availability.entServicesPublic` | **Boundary**: a known provider's storefront, gated by the BOOKING authority's bookability. It is not a discovery listing; legacy providers stay bookable by design (C2 grandfathering) |
| `index.js` Kass `search_restaurants` | 🟠 **Finding N2** |
| `index.js` Kass `get_sellers` | admin agent listing |
| `index.js` Kass `approve_seller` | **C8 finding** (below) |

**Browser reads:**

| Hit | Classification |
|---|---|
| `profile.html`, `sokoni-book-service.js` | **Boundary**: one known provider's services (profile / booking) |
| `mechanics.html`, `sokoni-health.js` | legacy-registry browser paths, follow-ups 2 and 3 |
| `sokoni-db.js` `listenProviders` | used only by `admin.html` |

## Existing-index cleanup (C3b-2)

| | |
|---|---|
| Implemented | `f5643ad`: `functions/discovery-cleanup.js` + `scripts/discovery-cleanup.js` |
| Tested | 35/0 cleanup tests · 17/17 sabotage |
| Production execution | ⛔ **NOT RUN** |
| Live-engine evidence | ⛔ **NOT AVAILABLE**. The engine readers were exercised only against fake clients; the suite's indexes are in-memory fixtures |

Therefore **nothing here claims the live indexes are clean.** Their state is intentionally unknown until a separately
authorized operational run. Certification did not execute the cleanup.

## Evidence at `f5643ad`

The working tree was identical to HEAD before and after every run.

**Suites:**

| Suite | Result |
|---|---|
| `test-business-category` | 44/0 |
| `test-business-category-rules` (emulator) | 20/0 |
| `test-business-category-admin-browser` | 13/0 |
| `test-business-workspace` | 30/0 |
| `test-business-workspace-gates` | 24/0 |
| `test-publication-gate` | 34/0 |
| `test-publication-gate-rules` (emulator) | 38/0 |
| `test-discovery-index` | 25/0 |
| `test-provider-directory` | 40/0 |
| `test-discovery-cascade` | 24/0 |
| `test-discovery-cleanup` | 35/0 |
| `test-healthcare-directory` | 51/0 |
| `test-provider-publish-authority` | 32/0 |
| `test-provider-suspension-mirror` | 38/0 |
| `test-in-app-booking-contact` | 15/0 |
| `test-share-integrity-browser` | 64/0 |
| `test-search-pipeline` | 15/0 |
| `test-firestore-search` | 23/23 |
| `test-legal-verification` | 105/0 |

**Counterproof:** `COUNTERPROOF=1 test-provider-publish-authority` against the reconstructed PRE-FIX source fails on
exactly the 13 genuine pre-fix defects (A2–A7, B1, D2–D5, G1, G2) and does not crash.

**Sabotage** (all four C3 groups re-run at `f5643ad` under the external supervisor):

| Group | Caught | Missed / crashed | Targets byte-identical | Restores |
|---|---|---|---|---|
| `disc` (C3a-1) | 11/11 | 0 / 0 | 5/5 | 0 |
| `dir` (C3a-2) | 16/16 | 0 / 0 | 7/7 | 0 |
| `casc` (C3b-1) | 14/14 | 0 / 0 | 4/4 | 0 |
| `clean` (C3b-2) | 17/17 | 0 / 0 | 2/2 | 0 |

All post-restore suites were green.

History (CHANGELOG 243–246):
- `dir` was first 15/16. A test-coverage gap was closed with a discriminating case, and the full group was re-run.
- `casc` was first 13 + 1 crash. The check now records a throw as a failure, and the full group was re-run.
- `scripts/run-sabotage.js` is not on `feat/creator-hub`, so an external supervisor gave the same restore guarantee.

**Per-slice baselines:**

| Slice | Baseline | SAME | DIFF | Notes |
|---|---|---|---|---|
| C3a-1 | vs `ac413fe` | 52 | 0 | |
| C3a-2 | vs `d93fc01` | 75 | 4 | all explained |
| C3b-1 | vs `1b07fec` | 78 | 2 | |
| C3b-2 | vs `03ecfbc` | 78 | 3 | |

Every DIFF was explained. In every slice, the `test-cart-market-actions` dirty-tree failure was re-verified to clear on
the committed tree.

**Pre-existing failures, identical in both trees throughout** (not C3, not modified): `test-secondary-firebase-apps`
(8/1), `test-realtime-multidevice` (68/1). `test-provider-dashboard-sidebar-browser` has a symmetric timing flake: 1 in
4 runs in EACH tree, on the same check.

## Open-findings register

### C3 follow-ups (recorded in C3a-2, open, not certified)

1. **Provider record exposure.** The `providers` read rule still allows a public read of active/approved docs, phone
   included. It is tightened once no public page reads `providers` directly.
2. **Legacy-registry browser fallback.** The search fallback still browser-scans `mechanics`, `healthProviders`,
   `lawyers` and `services`, as does `sokoni-health.js`.
3. **Legacy localStorage hub lists.** `mechanics.html` (which also writes the `mechanics` registry from the browser),
   `fitness-hub.html`, `home-services.html`, `bnb.html` and `legal-hub` still render them.

### Census findings (new at certification, open)

- **N1 · OPEN — ungated Typesense operator backfill.** `functions/scripts/typesense-direct.js` hard-codes the
  production project (`sokoni-aeb26`) and its Typesense node, reads Firestore collections, and imports them with
  `importDocuments`, bypassing the C3a-1 gated queue. Running it could re-index ineligible providers and the de-indexed
  registries. It was **not executed** during C3. It needs its own owner-authorized remediation slice; until then, C3's
  indexing-convergence claim carries this explicit exception.
- **N2 · OPEN — Kass discovery bypass (C3/C8 boundary).** The user-facing Kass tools `search_restaurants` (free-text
  `category` over raw `providers`, no status or eligibility check), `search_marketplace` (the de-indexed `services`
  registry, no status filter) and `search_stays` (raw `listings` / `hotels`, no status filter) build recommendations
  without the C3 eligibility authority. It is recorded here because it is a user-facing discovery path; remediation
  belongs to **C8 Kass convergence**.

### Outside C3 (recorded, not C3 scope)

- **C8 · approval-authority conflict.** The admin agent's `approve_seller` writes `providers.status` (`active` /
  `suspended`) directly, bypassing the canonical AdminOS approval lifecycle and C1's business stamp. This is more than
  a discovery issue: it can undermine the approval lifecycle itself. It is carried into C8 and deliberately **not**
  patched during certification.
- **Booking · false confirmation.** `providers.html` shows "Booking confirmed!" from a local path with no server
  confirmation. It belongs to booking-confirmation semantics, not discovery authority.

### Algolia defects (found by C3b-2, not changed)

- **A1.** The queue writes global shadows to `global_search`, while `COLLECTION_INDEX_MAP` names the global index
  `sokoni_global`.
- **A2.** `gs__providerServices` and `gs__providerProfiles` have no map entry, so the processor skips their shadow
  upserts: they are never indexed and never marked done. Deletes are unaffected.

### Exceptions (documented)

- **E1.** The Typesense backup restore is ungated admin disaster recovery. Restoring a pre-C3 snapshot can
  re-introduce ineligible records. Run the C3b-2 cleanup (dry run first) after any restore.

## Boundaries (by design, not defects)

- **Booking by a known id** (`entServicesPublic`, `profile.html`, `sokoni-book-service.js`) answers to the booking
  authority's bookability, not to discovery. A legacy unclassified provider is hidden from discovery but keeps its
  dashboard and bookings (C2 grandfathering, owner decision).
- **Shop / merchant discovery** (`businesses` → `sokoni_shops`, sellers, products) stays in the existing merchant search
  architecture. C3 neither redesigns nor removes it, and the cleanup never deletes shop entries.
- **AdminOS** surfaces read the raw registry by design.

## Next

C4 (Register My Business), after this certification. Open items carry forward:
- N1 needs its own slice;
- N2 and the C8 conflict go to C8;
- follow-ups 1–3 are C3 follow-ups;
- A1–A2 are search-infrastructure items.
