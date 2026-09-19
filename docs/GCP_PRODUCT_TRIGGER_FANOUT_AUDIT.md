# SOKONI — `products/{productId}` trigger fan-out audit

**Gate: P0-7. READ-ONLY. Zero mutations.**
Date: 2026-09-19 · Project `sokoni-aeb26`

Run while the Artifact Registry canary observation is frozen. No function deployed or deleted, no
revision created, no Cloud Run / Artifact Registry / IAM / App Check / rules change.

---

## 1. Authoritative census — 7 confirmed, and all 7 deployed

| # | Function | Event | Source | Deployed |
|---|---|---|---|---|
| 1 | `emailOnProductStatusChange` | `onDocumentUpdated` | `email-triggers.js:110` | yes |
| 2 | `indexProductCreate` | `onDocumentCreated` | `index.js:9005` | yes |
| 3 | `indexProductUpdate` | `onDocumentUpdated` | `index.js:9017` | yes |
| 4 | `onProductPriceChanged` | `onDocumentUpdated` | `product-analytics.js:140` | yes |
| 5 | `onMarketplaceProductCreated` | `onDocumentCreated` | `product-limit.js:184` | yes |
| 6 | `onMarketplaceProductDeleted` | `onDocumentDeleted` | `product-limit.js:193` | yes |
| 7 | `onInventoryUpdated` | `onDocumentUpdated` | `redis-integrations.js:273` | yes |

All seven bind exactly `products/{productId}`, region `us-central1`, Gen 2. Each was joined against
the authoritative 1,709-name deployment list — **not** the 1,000-capped `gcloud run services list`.

Three sites register triggers inside a loop (`async-jobs.js:335`, `hub-etims.js:1108`,
`inventory-recall.js:187`). None binds a product path — confirmed against an exhaustive scan that
found product document patterns in only five files.

### 1.1 The first correction: **7 triggers never fire together**

The cost contract states *"One product write starts 6–7 containers."* That is wrong. They are split
across three different event types:

```
CREATE  -> 2 triggers   indexProductCreate, onMarketplaceProductCreated
UPDATE  -> 4 triggers   emailOnProductStatusChange, indexProductUpdate,
                        onProductPriceChanged, onInventoryUpdated
DELETE  -> 1 trigger    onMarketplaceProductDeleted
```

**Maximum simultaneous fan-out from one write is 4, not 7.**

---

## 2. Side-effect profile

| Trigger | Event | Lines | Side effects |
|---|---|---|---|
| `emailOnProductStatusChange` | UPDATE | 21 | email (external) |
| `indexProductCreate` | CREATE | 11 | Firestore write **to its own ref** |
| `indexProductUpdate` | UPDATE | 89 | Firestore write **to its own ref**, audit records, inventory movements |
| `onProductPriceChanged` | UPDATE | 66 | Firestore read + write, **Typesense**, analytics aggregation |
| `onMarketplaceProductCreated` | CREATE | 8 | counter increment (`_bump(+1)`) |
| `onMarketplaceProductDeleted` | DELETE | 8 | counter decrement (`_bump(-1)`) |
| `onInventoryUpdated` | UPDATE | 28 | **Redis** cache invalidation |

No trigger writes to *another* product document. Only the two `index*` triggers write back, and only
to the document that fired them.

---

## 3. Fan-out map

```
products/{productId}
│
├─ CREATE ──┬─ indexProductCreate ──────── writes searchableTerms + nameLower to OWN ref
│           │                              (guarded: skips if searchableTerms already set)
│           │                                    │
│           │                                    └──► counts as an UPDATE ──┐
│           └─ onMarketplaceProductCreated ── sellerProductCount +1          │
│                                                                            │
├─ UPDATE ──┬─ emailOnProductStatusChange ── external email send  ◄──────────┤
│           ├─ indexProductUpdate ────────── price-change audit               │
│           │                                inventoryMovements record        │
│           │                                writes terms to OWN ref ─────────┤ (guarded,
│           │                                                                 │  1 hop max)
│           ├─ onProductPriceChanged ─────── Firestore read + write           │
│           │                                Typesense index update           │
│           │                                analytics aggregation            │
│           └─ onInventoryUpdated ─────────── Redis cache invalidation ◄──────┘
│
└─ DELETE ──── onMarketplaceProductDeleted ── sellerProductCount −1
```

### 3.1 Recursion — bounded, and deliberately so

Both `index*` triggers write back to the firing document, which re-enters the UPDATE path. The guard
in `indexProductUpdate` is **output comparison**, not a field list:

```js
const nextTerms = _buildSearchTerms(after);
const sameTerms = prevTerms && prevTerms.length === nextTerms.length
  && prevTerms.every((t, i) => t === nextTerms[i]);
if (sameTerms && after.nameLower === nextName) return;
```

**Verified sound.** `buildSearchTerms` accumulates into a `Set` and returns `Array.from(terms)`; a JS
`Set` preserves insertion order, and insertion order is fixed by a literal field list iterated in
order. Identical input therefore yields a byte-identical array, `sameTerms` is true on the second
pass, and **the loop terminates after exactly one hop.**

The source comment records that an earlier fixed-`TEXT_FIELDS` comparison was wrong in both
directions — array fields compared by reference always looked changed and "re-armed the very update
loop the list was meant to prevent". The current design is a deliberate repair of a real defect.

**A hypothesis tested and rejected:** if term generation were non-deterministic in order, the guard
would fail intermittently and self-sustain the loop. It is not. This is *not* the driver of the
volume in §4.

### 3.2 Duplication across the four UPDATE triggers

| Property | Finding |
|---|---|
| Duplicated document read | **Yes — structural.** All four receive the same `before`/`after` snapshots. Not a Firestore read charge (delivered in the event payload), but four container invocations decode the same document |
| Duplicated Firestore reads | `onProductPriceChanged` reads; `indexProductUpdate` reads. Not proven to be the same documents |
| Duplicated external calls | **No.** Email, Typesense and Redis are each touched by exactly one trigger |
| Ordering dependencies | **None declared.** Firestore triggers have no ordering guarantee, and none of the four assumes one |
| Race conditions | `indexProductUpdate` writes back while the other three read the same snapshot. Harmless — they act on the event payload, not a re-read |
| Idempotency | `indexProductUpdate` uses a deterministic movement id `${pid}_v${version}` — exactly-once per authoritative change. `_bump` counters are **not** idempotent (§5) |

---

## 4. Cost and scale — MEASURED

### 4.1 Measurement

`run.googleapis.com/request_count`, 30 days to 2026-09-19:

| Trigger | Requests (MEASURED) |
|---|---|
| `onInventoryUpdated` | 46,300 |
| `emailOnProductStatusChange` | 46,296 |
| `indexProductUpdate` | 45,978 |
| `onProductPriceChanged` | 45,543 |
| `indexProductCreate` | **5** |
| `onMarketplaceProductCreated` | **5** |
| `onMarketplaceProductDeleted` | **NO DATA** |
| **Total** | **184,127** |

### 4.2 The second correction: it is not 280,000

The prior audit reported *"~280,000 invocations/month from `products/{id}` alone"*. **MEASURED: 184,127.**
The earlier figure is superseded.

### 4.3 What the numbers say

| Quantity | Value | Status |
|---|---|---|
| Product **creates** in 30 days | **5** | MEASURED (two independent CREATE triggers both report 5) |
| Product **updates** in 30 days | **≈46,000** | CALCULATED — four UPDATE triggers each ≈46,000, i.e. ≈46,000 events × 4 |
| Products in the catalogue | ≈108 | prior audit, not re-verified here |
| Updates per product per month | **≈426** | CALCULATED |
| Updates per product per day | **≈14** | CALCULATED |
| Update events per minute | **≈1.06** | CALCULATED |

The four UPDATE triggers agree to within 1.6% (45,543–46,300), which is the expected signature of
four independent subscribers to one event stream, with small differences from retries and cold-start
timing. This corroborates ≈46,000 as the true event count.

### 4.4 THE UNRESOLVED QUESTION — what writes products ~46,000 times a month?

**NOT ESTABLISHED. This is the most important open item in this audit.**

Five products were created in 30 days, yet the catalogue absorbed ≈46,000 updates — **≈1.06 per
minute, almost exactly one per minute.** That regularity strongly suggests a scheduled writer rather
than user activity, especially against measured business volume of 1 marketplace order and 5 POS
sales in the same window.

Eliminated so far:

| Candidate | Verdict |
|---|---|
| The `indexProduct*` write-back loop | **Rejected** — guard proven sound and terminating (§3.1) |
| `task-queue.js` every-minute job | **Rejected** — it `.get()`s products; all three access sites are reads |
| Other scheduled writers | **Not eliminated** — 12 files combine `onSchedule` with a products collection reference; cadences are daily/6-hourly, which do not fit a per-minute rate |

**Why it cannot be closed from here:** per-collection Firestore write attribution requires Data
Access audit logging, which is **disabled project-wide** (P0-5B §4). The writer cannot be identified
from logs as configured.

> **Do not consolidate these triggers before this is answered.** Consolidation would reduce
> invocations by ~75% and in doing so *hide* a write amplification that is likely a defect. Fixing
> the writer could remove ~46,000 events entirely — a far larger reduction than merging the
> subscribers, and it addresses a cause rather than a symptom.

### 4.5 Do not confuse invocation count with cost

| Component | Reality |
|---|---|
| Cloud Run **requests** | 184,127/month against a **2,000,000/month free tier** → **$0** |
| Cloud Run **compute** | vCPU-seconds × memory. **This is where the cost is**, and it is not measured per function here |
| Firestore **reads** | Trigger payloads are delivered in the event — not billed as reads |
| Firestore **writes** | The write-back adds ≈1 write per content-changing update. UNKNOWN in total |
| **External** | Typesense operations and email sends, both volume-dependent |

**Merging four triggers into one removes ~138,000 invocations that currently cost nothing.** The
saving is in duplicated container startup and duplicated document decoding, not in request charges.
Any consolidation proposal that quotes invocation count as the benefit is misleading.

---

## 5. Consolidation candidates — NOT IMPLEMENTED

| Trigger | Class | Reasoning |
|---|---|---|
| `emailOnProductStatusChange` | **A — keep independent** | Only external-email trigger. Email is slow and fails independently of SOKONI. Merging couples an outbound-provider outage to search indexing and cache invalidation |
| `indexProductUpdate` | **B — mergeable** | Firestore-local: audit, movements, search terms |
| `onProductPriceChanged` | **B — mergeable** | Firestore + Typesense + analytics |
| `onInventoryUpdated` | **B — mergeable** | Redis invalidation only, 28 lines |
| `indexProductCreate` | **B — mergeable with #5**, but worthless | 5 invocations in 30 days |
| `onMarketplaceProductCreated` | **B — mergeable with #2**, but worthless | 5 invocations in 30 days |
| `onMarketplaceProductDeleted` | **A — keep** | Sole DELETE subscriber; nothing to merge with |
| — | **D — unclear** | Whether the ≈46,000 updates are legitimate. **Blocks the whole decision** |

### 5.1 If B were merged (3 UPDATE triggers into one dispatcher)

| Dimension | Effect |
|---|---|
| Invocation reduction | ≈138,000/month → but **$0 saved**, all inside free tier |
| Compute reduction | **Real** — one container start instead of three, one document decode instead of three. Magnitude **UNKNOWN**; needs per-function vCPU-second measurement |
| Latency | **Worse per event.** Serial in-process execution replaces three parallel containers. Redis invalidation currently completes independently of Typesense |
| Failure isolation | **Worse.** Today a Typesense outage cannot stop Redis invalidation. Merged, ordering and error handling must be explicit, and a partial failure leaves mixed state |
| Idempotency | **Becomes mandatory.** A retry of the merged handler re-runs all three side effects. `indexProductUpdate` is already idempotent by deterministic id; Typesense and Redis paths would need equivalent guarantees |
| Operational complexity | One deploy affects three concerns. Failure diagnosis loses per-function metrics |
| Creates a revision? | **YES — blocked by the artifact freeze** |

### 5.2 The `_bump` counter is not idempotent — independent finding

`onMarketplaceProductCreated`/`Deleted` call `_bump(sellerUid, ±1)`. Cloud Functions guarantee
**at-least-once** delivery, so a retried event increments twice and `sellerProductCount` drifts.
At 5 events/month this is not urgent, but it is a correctness defect independent of consolidation,
and consolidation would not fix it.

---

## 6. Verification

| Check | Result |
|---|---|
| Functions deployed | **none** |
| Functions deleted | **none** |
| Revisions created | **none** |
| Cloud Run mutation | **none** |
| Artifact Registry mutation | **none** |
| IAM mutation | **none** — 39 bindings |
| App Check mutation | **none** |
| Firestore rules | untouched |
| Production application code | untouched |
| Canary | **intact** |
| Contamination baseline | **CLEAN** — 1,709 functions |

---

## 7. Unresolved questions

1. **What writes products ≈46,000 times a month?** Blocks any consolidation decision. §4.4
2. Exact product count — ≈108 is carried from the prior audit and was not re-verified.
3. Per-function vCPU-seconds, without which the compute saving from merging is unquantified.
4. Why `onMarketplaceProductDeleted` returns NO DATA — no deletes, or no metric series.

## 8. Proposed next mutation

**None.** Consolidation requires deployment and is blocked by the artifact freeze; more importantly
it should not proceed until §4.4 is answered, because it would mask the anomaly rather than fix it.

The next useful read-only step is to identify the writer — most cheaply by inspecting
`updatedAt`/`updatedBy`/`inventoryVersion` on live product documents to see which actor stamps them,
which needs no new logging.

---

## P0-7B — Who writes products ~46,000 times a month? **Classification B — likely writer, strong evidence.**

READ-ONLY. Only Firestore `runQuery`/`runAggregationQuery` were issued; the probe refuses any
non-read path in code. No document was modified, no index created, no Data Access logging enabled.

### The answer

> **Client-side Firestore writes from the browser sync layer — `seller-wiring.js`, and the same
> `_syncedAt` pattern in `pos-sync.js` and `provider-wiring.js` — rewriting the entire product
> catalogue with no change detection.**

`seller-wiring.js:_writeProduct`:

```js
const ref = doc(db, 'products', String(product.id));
const payload = _trimPayload(product);
payload._syncedAt = serverTimestamp();
...
await setDoc(ref, payload, { merge: true });
```

**There is no "has anything changed?" guard.** Every sync pass writes every product it holds. Each
of those writes fires all four UPDATE triggers.

### The evidence chain

| # | Observation | Method |
|---|---|---|
| 1 | **108 products**, confirming the prior estimate | `runAggregationQuery` count |
| 2 | **All 108 belong to ONE seller** — `D5Ql2EYr95bt79Ip`, "KASS SHOP" | full read |
| 3 | `_syncedAt` present on **108/108** | field census |
| 4 | `_syncedAt` is written **only** by browser code — `seller-wiring.js:71`, `provider-wiring.js:40`, `pos-sync.js:234`. Deployed `functions/` only ever **deletes** it (`index.js:6904`) | repo-wide search |
| 5 | `updatedAt` **stale by >1 day on 102**, absent on 6, fresh on **0** | timestamp comparison |
| 6 | `updatedBy` absent on **60/60** sampled | field probe |
| 7 | Writes arrive in **bursts** — 8 docs in 4.8s, 40 in 31.9s, 60 in 3.7s | server `updateTime` clustering |

Points 5 and 6 are the discriminator. The server-side edit path stamps `updatedAt`/`updatedBy` —
`indexProductUpdate` reads `after.updatedBy` for its price-change audit. **Not one product carries a
fresh `updatedAt`.** So the dominant writer is not the server edit path, not POS checkout, and not a
Cloud Function. Point 4 names it: the only code that writes `_syncedAt` is the browser.

Point 7 matches a client syncing a catalogue in pages rather than a human editing products.

### Hypotheses tested and REJECTED

| Hypothesis | Verdict | Disproof |
|---|---|---|
| `indexProduct*` write-back loop | **Rejected** | Guard compares generated output; `buildSearchTerms` is order-deterministic (`Set` preserves insertion order over a literal field list), so the loop terminates in one hop — P0-7 §3.1 |
| `task-queue.js` every-minute job | **Rejected** | All three of its `products` access sites are `.get()` reads |
| `shop-name-sync.js` bulk fan-out | **Rejected** | It stamps `sellerNameSyncedAt`; **0 of 108** products carry that field, so it has never run against them |
| Scheduled backend sweeper | **Not supported** | No scheduled writer matches the cadence, and all would run as a function that sets `updatedAt` |

Each was a plausible, specific prediction with a falsifiable test. Recording the rejections matters
as much as the answer: `shop-name-sync` in particular *looked* exactly right — a batch rewrite of
one seller's products — and the field signature killed it outright.

### Classification: **B — likely writer, not conclusively proven**

Strong and consistent, but circumstantial. It rests on a signature field and on the absence of
server-path metadata, **not** on an observed write attributed to a client session. Proving it to **A**
requires either Data Access audit logging on Firestore (explicitly out of scope, and costly — P0-5B
§"The option, and its cost") or instrumenting the client. **Neither is proposed.**

Not excluded: `pos-sync.js` and `provider-wiring.js` use the same `_syncedAt` signature and could
contribute. The evidence identifies the **mechanism** — unconditional client-side catalogue sync —
more firmly than it identifies which of the three paths dominates.

### Why this matters more than consolidating the triggers

```
one client sync pass
        │
        └── 108 unconditional product writes
                    │
                    └── × 4 UPDATE triggers = 432 invocations per pass
```

≈46,000 update events ÷ 108 products ≈ **426 full-catalogue sweeps in 30 days** — roughly 14 a day,
consistent with a dashboard or POS device syncing on load and on interval.

**Fixing the writer removes the events. Consolidating the triggers only makes the same events
cheaper to absorb** — and would have hidden this entirely, which is precisely why P0-7 recommended
against it.

Indicative reduction if the client wrote only genuine changes: with 5 creates and a handful of real
edits in 30 days, the product-trigger workload would fall from ≈46,000 events to the low hundreds —
a **>99% reduction**, versus the ~75% invocation reduction consolidation offers. And unlike
consolidation it costs no failure isolation, adds no shared failure domain, and needs no dispatcher.

### An independent correctness note — NOT a defect claim

`_writeProduct` already strips `price`, `costPrice`, `deliveryCost`, `stock`, `outOfStock`, `sold`
and `sellerUid` when the document exists. The comment records why: *"this sync was reverting
server-set values (observed: price 100 → cached 2000; sellerUid)"*. So a **real** money/inventory
regression was already found and fixed here. The remaining issue is volume, not correctness — the
guard prevents damage but does not prevent the write.

### What a fix would look like — NOT IMPLEMENTED, NOT DEPLOYED

The change is **client-side** (`seller-wiring.js` and siblings), so it is **not** a Cloud Function
deploy and would **not** create a Cloud Run revision. It is a hosting deploy, which has its own
guardrails (`guard-no-rollback.js`, deploy-from-latest-commit).

Sketch only: compare the trimmed payload against the existing snapshot — already fetched by the
`getDoc` above — and skip `setDoc` when no descriptive field differs. That is the same
compare-the-output shape that makes `indexProductUpdate`'s guard self-limiting.

**Not written, not tested, not deployed.** It needs its own gate, and hosting deploys are outside
this audit's authorisation.

### Verification

| Check | Result |
|---|---|
| Product documents modified | **none** — read-only probe, non-read paths refused in code |
| Indexes created | **none** |
| Data Access logging | **not enabled** |
| Functions deployed / deleted | **none** — 1,709 |
| Revisions created | **none** |
| Cloud Run / Artifact Registry / IAM / App Check | **unchanged** |
| Canary | **intact** |
| Contamination baseline | **CLEAN** |

### Unresolved

1. Which of the three client paths dominates — `seller-wiring`, `pos-sync`, `provider-wiring`.
2. What triggers a sync pass (page load, interval, reconnect) and its true frequency.
3. Why the catalogue holds exactly one seller — expected for current scale, but worth confirming.
4. Whether `_syncedAt` on 100% of products means every product has *only ever* been client-written.

### Next

The fix is client-side and belongs in its own gate. It does **not** depend on the Artifact Registry
freeze, since no function deploy is involved — but it does need the hosting deploy guardrails and
an explicit decision.
