# Publication Contract (v1)

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

| Entity | Create→Project | Edit propagates | Index (create+update) | Directory | Search | Contract |
|---|---|---|---|---|---|---|
| **Products** | ✅ | ✅ | ✅ `indexProductCreate`/`Update` | ✅ | ✅ | **PASS** |
| **Providers** | ✅ (providerPublish + `_mirrorToRegistry`) | ✅ (edits mirror to `providers/{uid}`, fee→rate) | ✅ `indexProviderCreate`/`Update` | ✅ | ✅ | **PASS** |
| **Businesses** | ✅ (seller.html → `businesses/{uid}`) | ⚠️ (write path fixed; no reindex on edit yet) | ❌ **no `indexBusiness` trigger** | ✅ | ❌ **rides on product `sellerName` only** | **PARTIAL** |

See [[reference_provider_visibility]] for the provider/shop specifics and the collection maps.

## Roadmap to full compliance (independent releases)

1. **Business search indexing (NEXT — last user-facing gap).** Add `indexBusinessCreate`/`indexBusinessUpdate` (mirror the provider triggers; `buildSearchTerms` already reads `name`/`businessName`/`category`), point the search "businesses" spec at the `businesses` collection (currently reads the empty `sellers`). Release gate = the `publicationContract("businesses")` run: create→searchable, edit→search updates, rename→old terms gone, archive→removed.
2. **Product `businessId` stamping** — data-quality improvement (strengthens the storefront join beyond the current `sellerUid` fallback), no longer a workaround once indexing is in.
3. **Dry-run backfill** — report shops/providers missing their canonical doc, reason per candidate, proposed write, affected count; ZERO writes until explicit approval. A controlled migration, not a repair, because the write paths are now correct.

## Governing principle

Fix the **write path**, not the read path. Backfills are optional consistency passes run *after* the pipeline is correct — never a substitute for it. Every new marketplace entity is held to this contract before release.
