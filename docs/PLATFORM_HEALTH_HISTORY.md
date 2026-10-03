# Platform Health — daily score history

**Status:** built, tested, **NOT deployed** (2026-10-04, owner decision "yes").
Related: [[Platform Health]] · [[Analytics]] · [[AdminOS]] · `functions/platform-health.js` ·
hosting branch `hosting/platform-health-fix-on-cccd530` (`platform-health-view.js`).

## Why

The Platform Health page has an "over time" card. Until now the scores were computed on demand and never stored, so
the card could only show an honest empty state. This adds one stored reading per day so the card can draw a **real**
trend.

## Reuse check (step 0)

Checked before building. Nothing already stored these scores:

- **`platformHealthSweep`**: the serving archive was downloaded read-only.
  - Revision `platformhealthsweep-00015-qib`, 100% of traffic.
  - Source `gs://gcf-v2-sources-24799054989-us-central1/riderProfile/function-source.zip#1787386189115938`.
  - sha256 `6a312842…f853`, the same archive that serves `getPlatformHealthScores`.
  - It runs every hour. It only marks `platformHealth/{serviceId}` heartbeat docs as `stale`.
  - It stores no scores.
- **Cloud Scheduler** (`us-central1`, 170 jobs): none of the health or snapshot jobs stores these five scores.
  - `computeAllHealthScores` writes per-merchant `businessHealthScores`.
  - `snapshotPlatformMetrics` writes `opsMetrics`.
  - `recordHealthSnapshot` writes `healthSnapshots`, which is an input to the operational dimension.
  - The other jobs (`biDailySnapshot`, `generateDailySnapshot`, `analyticsSnapshotDaily`, …) belong to other domains.
- `getPlatformHealth` (operations-center) and `platformHealth` (index.js onRequest) return current state only.

## Lineage

- `getPlatformHealthScores` and `platformHealthSweep` both serve archive sha256 `6a312842…`. It has 379 files.
- In `C:/temp/sok-mv2p`, two commits have a `functions/` tree that is **byte-identical** to that archive, file by
  file:
  - `669e5ba`: commerceDispatch serving archive, non-functions files = live hosting `72dca56`;
  - `e521e03`: providerDispatch serving archive.
- `f4422b4` itself differs from the archive in one file, `order-settlement.js`.
- The comparison used `git hash-object --no-filters`. With filters on, CRLF files hash differently, and 5 files
  falsely appeared different.
- Branch `feat/platform-health-history-on-669e5ba` is cut from `669e5ba`.
- `platform-health.js` loads only `firebase-functions/v2/{https,scheduler}` and `firebase-admin/firestore`. It has no
  local requires, so the per-file diff against the archive is limited to the two files this change touches.

## Design

| Piece | Behaviour |
|---|---|
| `computeScores(db)` | The **one** formula, taken out of the callable unchanged: allSettled over the 5 dimensions, a failed dimension → `score:null`, overall withheld (`null`) if any dimension failed. Used by the callable **and** the snapshot. |
| `platformHealthSnapshot` | `onSchedule('0 3 * * *', timeZone 'Africa/Nairobi', us-central1, 512MiB, 120s)`. It writes `platformHealthHistory/{YYYY-MM-DD}`, keyed by the **Nairobi** date. |
| Idempotency | `ref.get()` first: if the doc exists, skip without computing. Then `ref.create()`. `ALREADY_EXISTS` from a concurrent run is a skip. A rerun on the same day **never overwrites**. |
| Document | `{date, overall: number\|null, dimensions:{marketplace,seller,buyer,operational,cost: number\|null}, failed:[dim], incomplete:[dim], computedAt: serverTimestamp, version: 1}`. A failed dimension is `null`, never `0`. `incomplete` lists the dimensions the server computed with `dataComplete:false`. |
| `getPlatformHealthScores.history` | `[{date, overall, dimensions}]`, **oldest first**, ≤ 90 entries (the last 90 Nairobi days). Days with no snapshot are absent. Nothing is interpolated. |
| History read | One `db.getAll()` over the 90 computed date keys. No query, no `orderBy`, **no index** (the earlier `__name__ desc` FAILED_PRECONDITION lesson). |
| Read failure | `history: null` + `historyError:{code,message}`. The live scores are still returned. `[]` means "no snapshot recorded yet", never "read failed". |
| Gate | Unchanged: `admin === true \|\| superAdmin === true`, checked before any read. |
| Back-compat | All legacy response keys are unchanged. `history` (and `historyError` on failure) is added. |

## Security

- `platformHealthHistory` is **server-only**. The Admin SDK writes it, and it is read only through the gated
  callable.
- Rules matcher for the f3 combined rules line (rules are **not** edited on this branch):

```
    // Platform Health daily score history: written by platformHealthSnapshot (Admin SDK),
    // read only through getPlatformHealthScores (admin || superAdmin). No client access.
    match /platformHealthHistory/{date} {
      allow read, write: if false;
    }
```

- Without the matcher the collection is already denied by default. The matcher states it explicitly.

## Performance and cost

- **Snapshot:** one run per day, at the same cost as one page load of the callable, plus 1 read and 1 write.
- **Callable:** each call now also reads up to 90 small documents (one batched `getAll`). The callable is admin-only
  with `maxInstances: 5`.
- **Storage:** about 365 documents a year of under 300 B each.
- **Scheduler:** adds 1 Cloud Scheduler job.

## Known limitations

- A day whose snapshot recorded a failed dimension keeps that `null`. `create()` semantics mean a later rerun cannot
  repair it. This is intentional: the record says the dimension was not measured that day.
- Before the first 03:00 run after deploy, `history` is `[]` and the page shows its empty state.

## Tests

`scripts/test-platform-health-history.js` is hermetic: Firestore and firebase-functions are faked, and it runs under
the block-admin preload. It has 37 rows, including two negative controls:

- (a) mutant overwrites on rerun → row "snapshot: rerun the same day does not overwrite" FAILS;
- (b) mutant writes 0 for a failed dimension → row "snapshot: failed dimension recorded as null (never 0)" FAILS.

## Deploy order (NOT done)

1. **Functions**, from this branch (the serving lineage):
   `firebase deploy --only functions:platformHealthSnapshot,functions:getPlatformHealthScores --project sokoni-aeb26`
   Then verify:
   - the new job `firebase-schedule-platformHealthSnapshot-us-central1` exists (`0 3 * * *` Africa/Nairobi);
   - `getPlatformHealthScores` serves the new revision.
2. **Rules:** the matcher above, on the f3 combined rules line.
3. **Hosting:** `platform-health-view.js` with `SERIES_FIELD = 'history'`.
