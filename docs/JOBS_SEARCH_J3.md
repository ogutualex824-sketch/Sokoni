# Jobs Board — J3: Search field mapping

**Status:** built and tested on branch `functions/jobs-search-on-032e88e`. **NOT deployed.**
**Date:** 2026-10-03 · Related: [[Jobs]] · [[Search]] · [[KASS]] · [[Typesense]] · [[Algolia]]

## Problem

The canonical job document is `jobs/{jobId}`, written only by `functions/jobs.js` (served via
`servicesDispatch`). Search read a different, older shape:

| canonical (`jobs.js`) | what search read before J3 |
|---|---|
| `companyName` | `company` (fallback chain eventually reached `companyName`) |
| `type` | `jobType` → `type` → default `'fulltime'` |
| `featured` | `isFeatured` (never set → never featured) |
| `postedAt` | `createdAt` (absent → 0; it is the Typesense default sort field) |
| `expiresAt` | `deadline` / `applicationDeadline` (absent → expired jobs never detectable) |
| `salaryMin`/`salaryMax`/`salaryCurrency` | Typesense ok; KASS read `salary` (absent → always "Negotiable") |
| `status: 'closed'` | not in `SKIP_STATUSES` → **a closed job stayed searchable** |

`digitalJobs` and `digitalGigs` (browser-written, unmoderated, fake money) also fed `sokoni_jobs`.
The Typesense processor resolved the mapper by *target* collection, so canonical `jobs` were
transformed by the `digitalJobs` mapper.

## Owner rules applied

* Public search returns only jobs with `status === 'active'` **and** not expired.
* Freelance gigs are the job type `'freelance-gig'` in `jobs`; `digitalJobs`/`digitalGigs` must not
  be indexed into `sokoni_jobs`. No migration of old gig data.
* `employerUid` is never indexed.

## What changed

| file | change |
|---|---|
| `functions/jobs-search-eligibility.js` (new) | `isPubliclySearchableJob()` — the one predicate (active, not expired, `_noIndex` respected; unreadable `expiresAt` fails closed). KASS helpers: `normalizeJobTypeInput`, `formatJobSalary`, `publicJobSummary`, `kassSearchJobs`. |
| `functions/typesense-sync.js` | `jobs` uses the predicate; any non-public job update → `delete` (idempotent, even if "before" was already skipped, e.g. expired-but-still-indexed). |
| `functions/typesense-client.js` | `TRANSFORMERS.jobs` (allow-list, canonical names + the live schema's legacy aliases; free-text location → `locationText`, never the geopoint `location`). `COLLECTION_MAP`: only `jobs → sokoni_jobs`; `digitalJobs`/`digitalGigs` unmapped. |
| `functions/typesense-queue.js` | processor resolves the mapper **per item** from `item.collection`; unmapped sources are excluded; each item transformed once (the jobs mapper is clock-dependent). |
| `functions/algolia-sync.js` | same predicate + always-delete for `jobs`. |
| `functions/algolia-indexer.js` | `TRANSFORMERS.jobs` (allow-list, no `poster.id`); map: `jobs → TRANSFORMERS.jobs`; `digitalJobs` and `gs__digitalJobs` removed. `gs__jobs` now resolves (it pointed at a transformer that did not exist). |
| `functions/algolia-queue.js` | unmapped source / null transform → marked `done` (previously stranded in `processing`). |
| `functions/algolia-admin.js` | `sokoni_jobs` settings + replicas on canonical fields (`postedAt`, `expiresAt`, `featured`, `type`, `companyName`, `salaryMin/Max`). Orphan sweep: `sokoni_jobs ← ['jobs']` only. |
| `functions/algolia-reconcile.js` | reconcile target `jobs` + `TRANSFORMERS.jobs`. |
| `functions/search-sync.js` | registry: `digitalJobs`/`digitalGigs` removed; `jobs` field metadata canonical. |
| `functions/index.js` | KASS `search_jobs` delegates to `kassSearchJobs` (canonical reads, expired dropped, `freelance` → `freelance-gig`). |
| `functions/test/algolia-sync.test.js` | contract row updated: `digitalJobs` must NOT be mapped. |

Legacy aliases (`company`, `jobType`, `isFeatured`, `createdAt`, `deadline`) are still written,
filled from canonical values: the live Typesense `sokoni_jobs` schema declares them (changing it
requires recreating the collection) and existing hit renderers may read them.

Left untouched (inert, owner-gated retirement): `ts_digitalJobs_*`, `ts_digitalGigs_*`,
`algoliaSync_digitalJobs_*` triggers. They remain registered; their enqueue is a no-op from this tree.

## Lineage (read-only, 2026-10-03)

Jobs search runs in two live lineages:

* **09-09 lineage** — `ts_jobs_*`, `ts_digitalJobs_*`, `ts_digitalGigs_*`, `algoliaSync_jobs_*`,
  `algoliaSync_digitalJobs_*`, `processAlgoliaQueue`, `algoliaReindex`, `algoliaSetupIndexes`,
  `algoliaReconcile`, `typesenseBackfill`, `typesenseReconcile`, `typesenseRepairDivergent`,
  `searchFullReindex`, `searchRepairAll`, `kass`, `servicesDispatch` (all updated 2026-09-09).
  No single commit matches; closest `release/multishop-on-e52fdc5` (`534bb05`) for search files.
* **09-21 lineage** — `processTypesenseQueue` = `032e88e` byte-for-byte for every search file.

Base `032e88e` + commit `fc7f2e6` (verbatim live 09-09 `algolia-indexer.js`, `algolia-sync.js`,
`typesense-client.js` — the forged-`verified` fix and `landlordProfiles` triggers). Every file J3
changes then equals a live blob before the J3 edit, **except `index.js`** (kass serves `773f199`;
the base has `02b9052`; the kass handler region is identical, the rest of the file is not).

`ca55f8b` was **not** used: it lacks the 09-21 DLQ fix in `typesense-queue.js` and the 09-09
`verified` fix, so a deploy from it would regress production.

## Known limitations

* **Eventual consistency / expiry.** The predicate runs on write (triggers) and on processing
  (mappers). A job that passes `expiresAt` with no write stays indexed until touched. **J2 adds the
  expiry sweep** — not built here.
* **Old gig records already in the indexes stay** until purged. Purge path (owner-gated):
  deploy `typesenseDeleteOrphans` / `algoliaDeleteOrphans` from this tree (they now treat
  non-`jobs` records in `sokoni_jobs` as orphans; the Typesense one scans 250 ids per run), or a
  blue-green `typesenseBackfill({ firestoreCollection: 'jobs' })` + alias swap.
* `algolia-settings.js` holds a second, older `sokoni_jobs` settings profile (company/jobType/
  location.city). Whichever setup runs last wins. Not changed in J3; aliases keep it working.
* KASS composite queries (`status`+`location`/`type`) may need Firestore indexes; failures are
  swallowed to an empty result (pre-existing).
* Parallel undeployed work touching the same files: `d93fc01` (C3a-1 discovery gate —
  `typesense-queue.js`, `algolia-queue.js`, `search-service.js`). Merge required before either ships.
* `search-service.js` was not changed: line ~151 is intent routing only; no job field reads.

## Tests

`node scripts/test-jobs-search-mapping.js` — module-stubbed, no network: **23/23 rows pass;
7/7 mutants killed** (closed-not-skipped, employer-uid-leak, gigs-still-mapped, expiry-ignored,
kass-legacy-fields, replica-legacy-fields, processor-first-entry-lookup).
Regression: `functions/test/algolia-sync.test.js` 78/0, `test-search-pipeline` 15/0,
`test-algolia-batch-isolation`, `test-typesense-dlq-undefined-ref` 7/0, `check-variant-parity` — pass.

## Deploy (NOT authorized)

Scoped, one function at a time, each after its own live-archive lineage gate and under the
Artifact Registry notice in `CLAUDE.md`:

1. `processTypesenseQueue`, `processAlgoliaQueue` (processors first — they safely drop legacy items)
2. `ts_jobs_onCreate`, `ts_jobs_onUpdate`, `ts_jobs_onDelete`
3. `algoliaSync_jobs_create`, `algoliaSync_jobs_update`, `algoliaSync_jobs_delete`
4. `kass` (index.js lineage differs — own gate; kass currently has a failed latest-created revision)
5. Optional/maintenance: `algoliaSetupIndexes` (+ run it to apply replica settings),
   `algoliaReconcile`, `algoliaReindex`, `typesenseReconcile`, `typesenseBackfill`,
   `searchFullReindex`, `searchRepairAll`
6. Owner-gated purge: `typesenseDeleteOrphans`, `algoliaDeleteOrphans`
7. Owner-gated retirement (separate decision): `ts_digitalJobs_*`, `ts_digitalGigs_*`,
   `algoliaSync_digitalJobs_*`
