# Cloud Function Consolidation Programme

**Status:** started 2026-08-19 · **Gate:** `scripts/verify-architecture.js` · **Blocks:** the subscription release deploy

Related: [[Payments]] · [[SmartPOS]] · [[Marketplace]] · [[Authentication]]

---

## Why this exists

`verify-architecture` fails:

```
CF export count 1692 exceeds HARD budget 1480 — consolidate before deploying.
```

It is **not** a regression from any recent change. Measured:

| | count |
| --- | --- |
| Exports in source (runtime enumeration) | 1692 |
| Functions **deployed in production** (`functions:list`) | 1691 |
| HARD budget | 1480 |
| **Must remove** | **212** |

Production has been running ~211 over budget for some time. The budget guards the
~1500 Cloud Run vCPU ceiling this project has already hit once, so it is a real
capacity constraint, not a style rule — but it is a *standing* condition, and
clearing it is a programme, not a release step.

---

## What can and cannot move

Measured by `scripts/cf-consolidation-candidates.js`:

| Kind | Count | Can consolidate? |
| --- | --- | --- |
| `onCall` | 1734 | **Yes** — behind a dispatcher (13 already exist) |
| triggers / schedules / http / storage | 313 | **No** — each binds to its own event |

Two hard invariants constrain every step:

1. **A dispatched op must stop being individually exported.** `verify-architecture`
   enforces "no dispatched op double-exported", so consolidation *removes* the old
   name. Every client call site must move in the same change.
2. **An orphan aborts the next deploy.** A function deleted from source but still
   deployed blocks deployment until explicitly deleted in the console/CLI.

A third, softer constraint decides sequencing: **cached PWA clients**. A browser
holding yesterday's HTML still calls the old name. Code references are therefore
necessary but not sufficient evidence — production invocation data is.

---

## CORRECTION — the first pass measured the wrong population

An earlier revision of this document concluded that "the overage is mostly
unreferenced surface, not functions needing clever merging." **That was wrong**,
and the error is recorded here rather than quietly edited out.

The gate measures `Object.keys(require(functions/index.js))`. A function defined
in a module but never re-exported there is **not deployed and does not count**.
The first pass classified *module-level definitions*, producing 59 confident
`SAFE_REMOVE` candidates — of which **zero were exported**. Removing all 59 would
have moved the number by nothing.

Re-run against the exported population:

```
EXPORTED onCall examined  : 1203      (only these count toward the 1692)
SAFE_REMOVE               :    0
REVIEW_REQUIRED           :    1
KEEP                      : 1202
defined but NOT exported  :  531      source hygiene, worth ZERO to the budget
```

**There is no dead exported surface.** Every exported `onCall` is either
referenced in source or invoked in production. The 212 therefore cannot come from
removal at all: it must come from consolidating *live, in-use* functions behind
dispatchers, moving every client call site with them.

The 531 defined-but-unexported functions are a separate hygiene question. They
must never be counted as progress toward 1480.

## Why the invariant earned its place

Of 181 `onCall` names with no reference anywhere in source, **15 had been invoked
in production** inside the census window — among them `posInitiateTerminalPaymentV1`
and `replayWebhookDLQ`. Static analysis alone would have deleted live payment
terminal surface. The invariant is not bureaucracy; it caught real ones.

## The shape of the answer

`scripts/cf-reachability.js` classifies every `onCall` by whether anything can
reach it. A name counts as reachable if a client file **or** another server module
references it; modules that build callable names dynamically are excluded wholesale.
"Mentioned only in docs/tests" is reported but never treated as reachable.

```
total onCall examined                    : 1734
NO reference anywhere but its own module :  180
target reduction                         :  212
```

So the overage is mostly **unreferenced surface**, not functions needing clever
merging. The programme is therefore primarily *removal*, with dispatcher
consolidation making up the remainder.

Largest unreferenced populations:

| Module | onCall | client-ref | server-ref | no reference |
| --- | --- | --- | --- | --- |
| `finance-os-sprint43` | 37 | 20 | 0 | **17** |
| `marketplace-extensions` | 30 | 14 | 0 | **16** |
| `index` | 55 | 38 | 18 | **14** |
| `pos-inventory-pro` | 21 | 9 | 2 | **12** |
| `analytics-engine` | 33 | 22 | 0 | **11** |
| `logistics-plus` | 30 | 19 | 0 | **11** |
| `marketing-engine` | 11 | 1 | 0 | **10** |
| `property-hub` | 12 | 2 | 0 | **10** |

---

## Phases

### Phase 0 — evidence (in progress)

* `scripts/cf-inventory.js` — the real export population, grouped by origin
* `scripts/cf-consolidation-candidates.js` — what can move, and its blast radius
* `scripts/cf-reachability.js` — what nothing references
* **Production invocation history** — Cloud Logging over the retention window, so
  "unreferenced in source" can be upgraded to "not invoked in production"

A function is only a removal candidate when it is **unreferenced in source AND
un-invoked in production**. Either alone is insufficient: source can miss a cached
client, and logs only cover the retention window.

### Protected authorities — never removed, never dispatched

Frozen for the duration of the programme:

`createPaymentIntent` · `initiateSTKPush` · `intasendWebhook` · `webhookIntasend` ·
`onPaymentIntentPaid` · `reconcileSubscriptionPayment` · `payIntentWithWallet` ·
`subActivate` · `getMerchantEntitlements` · `subscriptionPaymentMethods` ·
`onSubscriptionChangedSyncLimit` · `onAiSubscriptionChangedSyncLimit` ·
`merchantIdentity` · `employeeSaleAuthorize` · `adminLinkMerchantAccounts`

The principle is larger than the names. The **single activation authority** must
survive intact:

```
webhook -> PAID -> onPaymentIntentPaid -> reconcilePaidIntent
                -> subscription -> entitlement
```

No dispatcher or factory may introduce a second subscription writer. Any module
containing a protected name is excluded from consolidation wholesale.

### Recommended order — yield per client file touched

Money, subscription and protected-bearing modules excluded. **32 modules** reach
212. Ordered so the earliest slices prove the pattern at the lowest blast radius:

| # | Module | onCall | saves | client files | cumulative |
| --- | --- | --- | --- | --- | --- |
| 1 | `impact` | 24 | 23 | **1** | 23 |
| 2 | `algolia-admin` | 10 | 9 | 0 | 32 |
| 3 | `digital-hub` | 10 | 9 | 0 | 41 |
| 4 | `pos-shift-scheduler` | 10 | 9 | 0 | 50 |
| 5 | `vehicle-hub` | 10 | 9 | 0 | 59 |
| 6 | `entertainment-hub` | 9 | 8 | 0 | 67 |
| 7 | `kass-knowledge` | 7 | 6 | 0 | 73 |
| 8 | `reliability-engine` | 7 | 6 | 0 | 79 |
| 9 | `pos-integrations-api` | 6 | 5 | 0 | 84 |
| 10 | `healthcare-hub` | 15 | 14 | 2 | 98 |

`impact` is the recommended first slice: 23 exports removed against a single
client file.

> `algolia-admin` here is the **admin/ops surface**, not the 90 `algoliaSync`
> triggers. Those stay out of scope entirely — degraded is not dead.

### Phase 1 — dispatcher consolidation, one module per deploy

There is no Phase "remove the provably unused": the measurement above showed that
population is empty among exported functions. Every slice is a consolidation of
live surface.

Per module, in the order above. Each slice runs the proof gate:

```
candidate identified
      -> unreferenced in source? / invoked in production?
      -> product-owner review where the window is insufficient
      -> consolidate behind a dispatcher
      -> move EVERY client call site in the same change
      -> deploy
      -> verify the function surface (functions:list)
      -> verify the protected payment/subscription invariants
      -> re-measure the budget
      -> repeat
```

Never batch two modules into one deploy — an aborted deploy should name one cause.
Delete orphans explicitly in the same step.

### Phase 2 — source hygiene (separate, zero budget value)

531 `onCall` functions are defined but never exported. They cost nothing against
the budget and must not be counted as progress, but they are dead weight and
mislead every future analysis. Tracked separately.

### Phase 3 — re-measure and hold the ratchet

Once under 1480, keep it there: the budget already warns at 1350.

---

## Risks

| Risk | Control |
| --- | --- |
| Cached PWA client calls a removed function | require zero production invocations over the full retention window, not just zero code references |
| Orphaned function aborts a later deploy | delete orphans explicitly as part of the same step |
| A dispatched op left double-exported | `verify-architecture` already fails on this |
| Deleting something a scheduled job calls | reachability counts server-to-server references |
| Dynamic callable names evade the analysis | whole module excluded when it builds names at runtime |

---

## Standing decision

Nothing in this programme is deleted on the strength of static analysis alone, and
no removal is bundled into a release whose purpose is something else. The
subscription release stays undeployed until the budget is met.

---

## Open

- Census window is 30 days (Cloud Monitoring request_count). Every classification
  record carries coverageStart/coverageEnd/coverageDays so a later reader cannot
  mistake a quiet window for a dead function.
- Retention window for the `_Default` log bucket not yet confirmed; if it is 30
  days, a function used quarterly would look dead. Seasonal/rare functions need a
  longer signal than logs can give — candidates in that class must be reviewed by
  a human who knows the product.
