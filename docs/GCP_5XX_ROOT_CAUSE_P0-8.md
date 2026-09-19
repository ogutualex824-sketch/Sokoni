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
