# Publication Contract (v1.0)

**Version:** 1.0 — semantic; see [Versioning & evolution](#versioning--evolution)
**Status:** Platform standard — adopted 2026-07-27
**Applies to:** every publishable entity — [[Products]], [[Providers]], [[Businesses]], and all future types (hotels, rentals, jobs, events, …)

## Why this exists

SOKONI accumulated three parallel publication implementations (products, providers, businesses), each with its own create/edit/read paths. That produced the same class of bug three times over: a write landed in one collection while the public directory read another, or a document was created incomplete (missing the field a directory `orderBy` silently requires), or an edit updated a private working record the public surface never saw.

The fix is not another one-off patch — it is a **single, repeatable publication model** every entity must satisfy. This contract is that model. A new content type is "done" only when it passes the contract; if it does, it inherits correct visibility, propagation, discoverability and security by construction.

```
Create → Canonical document → Projection(s) → Index → Directory / Search → Public page → Archive/Hide → Removed
```

## The contract

Every publishable entity MUST satisfy all seven stages.

### 1. Create
- Canonical document created (keyed consistently — by `uid`/owner or a stable id).
- Required projection(s) created — if the public directory reads a different collection than the private/working record, the create path writes BOTH.
- The created doc is COMPLETE for every read surface: includes any field a directory `orderBy` sorts on (e.g. `createdAt`/`updatedAt`) — **a missing sort field is silently dropped by Firestore and is invisible in the console.**
- Security rules enforced (owner-scoped, no admin fields).

### 2. Edit
- Changes propagate to ALL public projections (not just the private working record).
- Search terms regenerate (`searchableTerms`/`nameLower`).
- `updatedAt` re-stamped (so orderBy'd directories don't drop the doc).
- Status/verified/featured and other admin fields preserved, never touched by an owner edit.
- Public views reflect the change.

### 3. Discoverability
- Directory listing appears.
- Search finds the entity.
- Renames remove stale search terms and add the new ones.
- Search ranking metadata stays valid.

### 4. Public Rendering
- Public page loads without console/network errors.
- Related entities resolve correctly (storefront ↔ products, provider ↔ bookings, business ↔ products).

### 5. Lifecycle
- Hide/archive removes from search.
- Hide/archive removes from the directory where applicable.
- Republishing restores visibility.

### 6. Security
- Owner can edit their own entity.
- Non-owner cannot.
- Protected/admin fields remain protected (verified/featured/approved/suspended/commissionRate/role/…).

### 7. Observability
- Projection succeeds, or fails with structured logging.
- Indexing failures are visible, not silent.

## Parameterized test suite

One reusable suite, not three:

```
publicationContract("products")
publicationContract("providers")
publicationContract("businesses")
// and every future type:
publicationContract("hotels")
publicationContract("rentals")
publicationContract("jobs")
publicationContract("events")
```

`publicationContract(entityType)` exercises the full lifecycle against the Firestore emulator + `@firebase/rules-unit-testing`: create → assert directory + search + public-page + rules; edit → assert propagation + reindex; rename → assert stale terms gone; archive → assert removed from search/directory; republish → assert restored; plus the owner/non-owner/admin-field security matrix. A new content type is validated against the same standard instead of reinventing tests.

## Current entity status (2026-07-27)

| Entity | Create→Project | Edit propagates | Index (create+update) | Directory | Search | Contract | Certified under |
|---|---|---|---|---|---|---|---|
| **Products** | ✅ | ✅ | ✅ `indexProductCreate`/`Update` | ✅ | ✅ | **PASS** | **v1.0** |
| **Providers** | ✅ (providerPublish + `_mirrorToRegistry`) | ✅ (edits mirror to `providers/{uid}`, fee→rate) | ✅ `indexProviderCreate`/`Update` | ✅ | ✅ | **PASS** | **v1.0** |
| **Businesses** | ✅ (seller.html → `businesses/{uid}`) | ✅ (reindexed on edit) | ✅ `indexBusinessCreate`/`Update` | ✅ | ✅ (search spec → `businesses`) | **PASS** | **v1.0** |

**Certified under** records the contract version an entity last passed `publicationContract(entityType)` against — the audit trail of which standard certified it. All three are certified under **v1.0** by `scripts/test-publication-contract.js` (36/36), which runs in CI (`static-analysis` job) and as a hosting predeploy gate. See [[reference_provider_visibility]] for the provider/shop specifics and the collection maps.

## Roadmap to full compliance (independent releases)

1. **Business search indexing (NEXT — last user-facing gap).** Add `indexBusinessCreate`/`indexBusinessUpdate` (mirror the provider triggers; `buildSearchTerms` already reads `name`/`businessName`/`category`), point the search "businesses" spec at the `businesses` collection (currently reads the empty `sellers`). Release gate = the `publicationContract("businesses")` run: create→searchable, edit→search updates, rename→old terms gone, archive→removed.
2. **Product `businessId` stamping** — data-quality improvement (strengthens the storefront join beyond the current `sellerUid` fallback), no longer a workaround once indexing is in.
3. **Dry-run backfill** — report shops/providers missing their canonical doc, reason per candidate, proposed write, affected count; ZERO writes until explicit approval. A controlled migration, not a repair, because the write paths are now correct.

## Versioning & evolution

The contract is **semantically versioned** so the standard can grow without invalidating what earlier releases were certified against. Each entity's "Certified under" value is a permanent audit trail: an entity certified under v1.0 stays certified under v1.0 even after the contract advances, until it is re-run against the newer version.

- **v1.x (additive)** — a new clause every entity SHOULD meet, but whose absence does not retroactively fail a v1.0 certification. Entities re-certify to v1.1 as they are next touched.
- **v2.0 (breaking)** — a clause that changes what "published" means (e.g. a new mandatory projection, or a required moderation gate before public visibility). Entities must be re-run and re-certified; a v1.x certification is no longer sufficient.

Likely future requirements — candidates for v1.1 / v2.0, deliberately NOT in v1.0:
- **Search ranking** — relevance/quality signals beyond term matching.
- **Multilingual indexing** — Swahili + English term generation and query handling.
- **Geospatial search** — location-aware discovery (near-me, county radius).
- **AI metadata** — embeddings / generated tags for semantic search.
- **Moderation states** — pending/approved/rejected as first-class lifecycle states with their own visibility rules.

Adopt each by adding its clause to the relevant stage above, bumping the version, and re-certifying entities on their next touch. The `publicationContract(entityType)` suite gains the new assertions in the same change — the version bump and its test land together, so no entity can claim a version it wasn't actually tested against.

### Version history
- **v1.0** (2026-07-27) — initial standard: create → project → index → directory/search → public → archive, plus the owner/admin security matrix and observability. Emerged from the provider and shop publication fixes.

## Enforcement (CI + predeploy gate)

A contract is only a standard if it is enforced, not merely documented. Enforcement uses two layers this repo already runs for other checks:

1. **CI (`.github/workflows/ci.yml`)** — a PR that touches publication logic (any create/edit/projection/index path, `functions/search-terms.js`, or a directory/search read) MUST run `publicationContract(entityType)` for the affected entities and fails the PR on any regressed clause. This mirrors the existing `auth-certification.yml` precedent — a certification workflow gating a subsystem.
2. **Predeploy gate (`firebase.json`)** — the suite joins the existing predeploy scripts (hosting runs 7, functions 2) so a deploy cannot ship a publication regression even outside the PR flow.

**Certification rule:** an entity is "**Certified under vX**" only when the vX `publicationContract()` suite passes green in CI — never by assertion. A version's spec clause and its test assertions land in the same change, so the gate always tests exactly what the current contract requires (spec and tests can never drift).

**Status:** ✅ **ACTIVE** (release 1, 2026-07-27). `scripts/test-publication-contract.js` (36/36) runs in CI (`static-analysis` job) and as a hosting predeploy gate. Products, providers and businesses are certified under v1.0. Per-collection security remains certified by the `@firebase/rules-unit-testing` runs (businesses 5/5).

## Governing principle

Fix the **write path**, not the read path. Backfills are optional consistency passes run *after* the pipeline is correct — never a substitute for it. Every new marketplace entity is held to this contract before release; every contract change is versioned so certifications remain auditable; and the `publicationContract()` suite is the enforceable gate, not just a guideline.
