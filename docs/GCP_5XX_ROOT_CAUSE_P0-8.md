# SOKONI — P0-8: recurring scheduled-function failures

**READ-ONLY DIAGNOSIS. No fix applied, no index created, no deploy, no infrastructure mutation.**
Date: 2026-09-19 · Project `sokoni-aeb26`

Companion to `GCP_COST_ARCHITECTURE_AUDIT.md`. Run while the Artifact Registry canary observation
is frozen and another agent holds uncommitted work in the main checkout — neither was touched.

---

## 0. Billing export is live — the cost programme is unblocked

Checked independently (metadata reads only, **no billed queries**):

| Table | Rows | Size | Last modified |
|---|---|---|---|
| `gcp_billing_export_v1_016742_7E2122_8406F7` (Standard) | **108,289** | 80.3 MB | 2026-09-19 ~17:49Z |
| `gcp_billing_export_resource_v1_016742_7E2122_8406F7` (**Detailed**) | **125,863** | 106.3 MB | 2026-09-19 ~17:49Z |

Dataset created `05:00:55Z`, tables appeared `07:47:44Z`, data landing actively. Both DAY-partitioned.

**Consequence:** the audit's `$100–765/month` range and the `infra cost / completed order` metric can
now be *measured*. Detailed export gives per-SKU, per-resource attribution — the row that
`GCP_SERVICE_COST_CONTRACT.md` §5 could not enforce. That is the largest open item in the cost
programme, and it is now answerable. **Not done here** — it needs its own gate, and billed queries
need authorisation.

---

## 1. `runScheduledSelfHeal` — missing composite index. **Audit confirmed.**

### Root cause — exact

`functions/self-heal.js:116` `checkSyncQueue()`:

```js
const snap = await db.collection('syncQueue')
  .where('status', '==', 'failed')
  .where('updatedAt', '<', cutoff)
  .limit(200)
  .get();
```

Equality on `status` + **range** on `updatedAt` requires a composite index. Production error:

```
9 FAILED_PRECONDITION: The query requires an index.
```

The index URL in the error decodes to:

```
collectionGroups/syncQueue/indexes/_   fields: status, updatedAt, __name__
```

**`firestore.indexes.json` declares ZERO `syncQueue` indexes.** The index has never existed.

### Frequency — the audit was right

| | |
|---|---|
| ERROR entries, 7d | **4,032** |
| Invocations, 7d | ~2,016 (every 5 min) |
| Ratio | **exactly 2.0 per invocation — fails on every single run** |

### Minimum corrective change — **index configuration only, no code**

```json
{
  "collectionGroup": "syncQueue",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "status",    "order": "ASCENDING" },
    { "fieldPath": "updatedAt", "order": "ASCENDING" }
  ]
}
```

`__name__` is appended implicitly and is not declared.

### ⚠ Index deploys are independently hazardous here

`firebase deploy --only firestore:indexes` deploys **the whole file**, not one index. Prior work
recorded index deploys as unsafe on this project, and `docs`/memory carry a withheld-payouts-index
finding. **Adding one index therefore risks shipping every other pending index change in the file.**

Before any index work: diff `firestore.indexes.json` against the deployed index set and establish
exactly what else would go out. **That is a separate gate and was not performed here.**

### An open question the fix does not answer

`checkSyncQueue` **catches its own error**:

```js
} catch (err) {
  log.error('checkSyncQueue failed', { err: err.message });
  result.error = err.message;
}
```

So the check degrades gracefully and returns a result. Whether the function nonetheless returns a
non-2xx is **not established** — see §3. Adding the index removes the error and restores the sync
queue's self-healing, which is the real benefit regardless of the HTTP status.

**Also unmeasured:** `syncQueue` has never been swept successfully, so failed items have been
accumulating for an unknown period. Its depth should be measured before the fix, or the first
successful run will retry an unbounded backlog at once.

---

## 2. `processTypesenseQueue` — `undefined` in a Firestore write. **Audit WRONG on frequency.**

### Root cause — exact

`functions/typesense-queue.js:307`, in `_handleFailure`, on the DLQ path:

```js
await db.collection(DLQ_COL).doc(item.ref.id).set({
  ...item,
  status:    'failed',
  failedAt:  Date.now(),
  lastError: errorMsg,
  attempts,
  ref:       undefined,      // ← intended to strip `ref` from the spread
});
```

`item` is built at line 178 as `{ ref: d.ref, ...d.data() }`, so the spread carries a
`DocumentReference`. The author tried to remove it by assigning `undefined` — but **assigning
`undefined` does not remove a key**, and Firestore rejects undefined values unless
`ignoreUndefinedProperties` is set. Production error:

```
Error: Value for argument "data" is not a valid Firestore document.
Cannot use "undefined" as a Firestore value (found in field "ref").
```

### Frequency — correcting the audit

The audit stated this fails on **every** run. It does not.

| | |
|---|---|
| ERROR entries, 7d | **30** |
| Invocations, 7d | ~2,016 |
| Distinct failure events | ~15 (errors arrive in pairs) |
| Rate | **~0.7% of runs** |

The reason is structural: the throwing line sits behind `if (attempts >= MAX_ATTEMPTS)`. It only
executes when a queue item **exhausts its retries**, which is rare. Timestamps confirm a sporadic
pattern (06:04, 13:04, 04:14 …), not the 5-minute cadence of the schedule.

**This is worse than it looks, not better.** Every item that reaches the DLQ path fails to be
recorded *and* `await item.ref.delete()` on the next line never runs — so the item is neither
dead-lettered nor removed. It stays in the queue and will be retried forever. **The DLQ has never
received a single item.**

### Minimum corrective change — **code only, no index, no config**

```js
const { ref, ...rest } = item;
await db.collection(DLQ_COL).doc(ref.id).set({
  ...rest,
  status:    'failed',
  failedAt:  Date.now(),
  lastError: errorMsg,
  attempts,
});
await ref.delete();
```

Destructuring removes the key rather than setting it undefined. **Do not** enable
`ignoreUndefinedProperties` — that is a global behaviour change that would silently swallow
undefined values across every Firestore write in the codebase.

### Regression test — written, and currently RED

`scripts/test-typesense-dlq-undefined-ref.js`, 7 assertions:

```
*** FAIL ***  no `ref: undefined` in code (comments stripped)   <-- expected, defect still present
PASS  positive control: stripped source still contains the DLQ write
PASS  current construction is Firestore-INVALID (defect reproduced, field "ref")
PASS  proposed construction is Firestore-VALID
PASS  proposed construction carries no `ref` key
PASS  proposed construction preserves the queue data
PASS  doc id still derivable from ref after destructuring
```

It **fails against current code by design** — a test that passed before the fix would prove nothing.
The positive control guards the comment-stripper, so assertion 1 cannot pass vacuously on a blanked
file. After the fix, all 7 must pass.

`runScheduledSelfHeal` has **no equivalent unit test**, because the defect is absent index
configuration rather than code. Its verification is: index exists → error count drops to zero.

---

## 3. A claim I could not verify: the "5xx" framing

The audit records both as contributing to a measured 5xx rate. **I could not confirm that.**

```
runscheduledselfheal    request_count by response_code_class → {"?": 8615}
processtypesensequeue   request_count by response_code_class → {"?": 8625}
```

The metric returns **no `response_code_class` label** for either service, so these invocations
cannot be attributed to 2xx or 5xx from this source. What is proven is that both log `ERROR` — and
for `runScheduledSelfHeal`, on every run.

**Recorded as UNVERIFIED rather than restated.** An ERROR log is not an HTTP 5xx, and the
distinction matters if 5xx rate is ever used as a release gate.

---

## 4. Summary

| | `runScheduledSelfHeal` | `processTypesenseQueue` |
|---|---|---|
| Root cause | missing composite index `syncQueue(status, updatedAt)` | `ref: undefined` in the DLQ write |
| Fix type | **index configuration only** | **code only** |
| Frequency | **every run** (2 errors × ~2,016/7d) | **~0.7% of runs** (~15 events/7d) |
| Audit claim | confirmed | **wrong — not every run** |
| Hidden consequence | `syncQueue` never self-heals; backlog depth unknown | **DLQ has never received an item**; exhausted items retry forever |
| Test | none possible (config, not code) | `test-typesense-dlq-undefined-ref.js` — RED |
| Deploy needed | `firestore:indexes` — **hazardous, whole-file** | function deploy — **blocked by the artifact freeze** |

## 5. Not done, and why

Neither fix is applied. The Typesense fix needs a **function deploy**, which the Artifact Registry
freeze forbids. The index fix needs an **index deploy**, which is independently hazardous on this
project and requires its own diff gate.

**Proposed next mutation: none.** The index-file diff gate is the cheapest next read-only step, and
the billing-export cost attribution is now the highest-value one.

---

## P0-8A — Index-file diff gate. READ-ONLY.

**Question:** if we add the one `syncQueue` index P0-8 needs, what else would an index deployment
carry with it?

**Answer: four unrelated `reviews` indexes, and six deployed indexes become deletion candidates.**

### Current state

| | |
|---|---|
| Repo `firestore.indexes.json` composite indexes | **408** |
| Deployed composite indexes | **410** — all `READY` |
| Repo `fieldOverrides` | 1 |
| **`syncQueue` indexes deployed** | **0** |
| `syncQueue(status, updatedAt)` in repo | **NO** — it has never been declared |

Comparison normalises both sides and strips `__name__`, which Firestore appends implicitly and the
repo file omits; without that every index compares as different.

### WOULD BE CREATED by a deploy today — 4, none of them ours

```
+ reviews [targetId:ASC, status:ASC, createdAt:DESC]
+ reviews [targetId:ASC, status:ASC, rating:DESC,  createdAt:DESC]
+ reviews [targetId:ASC, status:ASC, rating:ASC,   createdAt:DESC]
+ reviews [targetId:ASC, status:ASC, helpful:DESC, createdAt:DESC]
```

**This is the finding.** Four `reviews` indexes are committed to the repo but were never deployed.
Adding the `syncQueue` index and deploying would ship **five** indexes, not one — four of them
unrelated to P0-8, for a collection this gate never examined.

They are additive and unlikely to break a live query, but they are **unreviewed by this programme**,
they consume write capacity while building, and shipping them under a P0-8 commit message would
misrepresent what was deployed.

### DEPLOYED BUT NOT IN REPO — 6, and this is the dangerous column

```
- inventory_batches    [available, expiryDate]
- messages             [mediaType, storageRef, timestamp]
- posPrintJobs         [kind, shopId, status, createdAt]      <-- POS PRINTING
- crmCustomerProfiles  [merchantId, clv]
- entitlements         [purpose, status, expiresAt]
- posCheckoutMetrics   [branchId, merchantId, saleDate]
```

These exist in production and are absent from the repo file — they were created directly (Console,
or by following an error-message link) and never written back.

**If an index deploy removes them, the queries behind them break at runtime with
`FAILED_PRECONDITION`** — and `posPrintJobs(kind, shopId, status, createdAt)` is POS print-job
dispatch, on the hardware path this programme already protected once.

**Unconfirmed and MUST be established before any index deploy:** whether this `firebase-tools`
version deletes indexes absent from the file, prompts, or ignores them. The CLI has historically
*not* deleted automatically, but that is a recollection, not a measurement, and the consequence of
being wrong is broken POS printing. **Verify against this exact CLI version before deploying.**

### What this changes about the P0-8 index fix

The fix is still "index configuration only, no code" — but it is **not** a one-line change with a
one-index blast radius. Deploying it means:

1. shipping 4 unreviewed `reviews` indexes, **and**
2. taking a risk on 6 production indexes that the repo does not know about.

### Recommended sequence — NOT executed

1. **Reconcile the 6 orphans into `firestore.indexes.json` first**, so the repo describes
   production. That is an additive, reversible, deploy-free change that removes the deletion risk
   entirely.
2. Confirm the CLI's deletion behaviour on this exact version.
3. Decide separately whether the 4 `reviews` indexes should ship.
4. Only then add `syncQueue(status, updatedAt)` and deploy.

Step 1 is the highest-value next action and needs no deployment. Doing step 4 first would be
shipping five indexes and a live-query risk to fix a cron.

### Reproduce

```
gcloud firestore indexes composite list --format=json > /tmp/idx-deployed.json
node <diff script> /tmp/idx-deployed.json
```

---

## P0-8B — Why the billing export stops at 2026-08-12. **Partially answered; NOT resolved.**

Read-only. Free metadata probes only — **no additional analytical BigQuery query was run.**

### The correction that prompted this

Earlier today I reported the export as *"landing actively"* on the strength of `lastModifiedTime`
being recent. That was wrong in the way that matters: **the table was being written recently, with
old usage data.** `lastModifiedTime` proves the table was touched, not that recent usage arrived.
Checking `usage_start_time` instead showed the data ends **2026-08-12**, 38 days stale.

### What the metadata shows

Partition probes (free — `bq show 'table$YYYYMMDD'`, not a query):

```
20260701 : 0
20260801 : 10,609
20260812 : 9,951      <-- frontier
20260813 : 0
20260814 : 0
20260815 : 0
20260816 : 0
20260901 : 0
20260919 : 0
```

Table totals, same free metadata, sampled three times:

```
17:49:02Z   detailed numRows = 125,863
18:38:54Z   detailed numRows = 135,814      (+9,951 in ~49 min)
~19:20Z     detailed numRows = 135,814      (no change in ~40 min)
```

**The +9,951 exactly equals the row count of the `20260812` partition.** So the export wrote the
Aug 12 day-partition during the observation window — it is backfilling **chronologically, one day
at a time** — and then stopped.

### What is established, and what is not

**Established:** this is a **chronological backfill**, not a misconfiguration and not a permanent
truncation. The frontier advanced by exactly one day while under observation. Aug 13 onward are
empty, so nothing after Aug 12 has been written yet.

**NOT established:** whether the backfill is *paused* or *stalled*. It made no progress for ~40
minutes after completing Aug 12. Two observations cannot distinguish bursty writing from a halt.

**Deliberately not claimed:** an earlier draft of this analysis estimated "~31 hours to catch up"
from the one observed interval. That estimate assumed steady progress and the third sample
contradicted it. **One interval is not a rate.** No completion estimate is offered.

### Why this matters more than the numbers it blocks

The measured window (2026-07-01 → 2026-08-12) predates every change this programme made. The
pinning census, P0-7C, and the current service configuration are all **after** it. So:

> **The $92.26 measured total and the $23.55 for the eight pins describe a configuration that no
> longer exists.** They must not be used to justify unpinning, and the ~$65/month extrapolation
> must not drive any current infrastructure decision.

### The cheap next check — free, one command

```
bq --project_id=sokoni-aeb26 show --format=prettyjson \
  'billing_export.gcp_billing_export_resource_v1_016742_7E2122_8406F7$20260813'
```

* **rows > 0** → the backfill resumed; it is bursty, and it will catch up on its own. Re-probe the
  frontier periodically until it reaches the current date, then re-run the cost attribution.
* **still 0 after several hours** → it is stalled at Aug 12 and needs investigation at the Console
  billing-export configuration, not in BigQuery.

Either way the answer arrives by probing partition metadata, which costs nothing.

### Status

**The cost programme's data source is 38 days stale and its recovery is unconfirmed.** Fresh billing
data — not another extrapolation — remains the gating milestone for cost attribution.
