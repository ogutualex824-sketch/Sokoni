# Step 1 — Reader Convergence Matrix (`deliveries` → `packageRequests`)

**Status:** CENSUS ONLY — no code edited, no rules edited, nothing redirected, nothing deployed
**Date:** 2026-09-13
**Related:** [[DELIVERY_RAIL_CONVERGENCE]] · [[project_store_identity_gate]]

---

## 0. Enumeration — 10 read sites, 6 consumers

The "six readers" wording resolves to **10 root `/deliveries` read sites** grouped into **6
consumers**; `logistics-plus.js` contributes four.

| # | Site | Query |
|---|---|---|
| 1-4 | `logistics-plus.js` 736, 763, 794, 815 | `.where('shopId','==',shopId)` |
| 5 | `index.js:5713` | `.where('status','in',['assigned','in_transit']).count()` |
| 6 | `index.js:1546` | `.where('orderId','==',…).limit(1)` |
| 7 | `automation-engine.js:433` | `.where('orderId','==',dispute.orderId).limit(1)` |
| 8 | `email-triggers.js:836` | `status=='pending'` + `driverId==null` + `createdAt<=-30min` |
| 9 | `fulfilment-scan.js:188` | `.doc(String(t.id))` |
| 10 | `ecc.js:135` | `.limit(1)` health probe |

---

## 1. THE HEADLINE — the status vocabularies are DISJOINT

| | tokens |
|---|---|
| `packageRequests` (13 live docs) | `order_placed` (7), `ready_for_pickup` (2), `driver_accepted` (4) |
| what the readers filter on | `pending`, `assigned`, `in_transit`, `delivered` |

**Overlap: zero.**

This reframes the whole step. A literal field-name redirect is **INERT** — `index.js:5713` would
still count 0, and `email-triggers.js` would still match 0. Nothing would change, and nothing would
break. Every behavioural effect, and every risk, lives in the **status translation**, not in the
collection swap.

So Step 1 is really two decisions, and they should be gated separately:

1. repoint the collection (inert, safe, reversible)
2. translate the status vocabulary (this is where behaviour and risk appear)

---

## 2. Field mapping matrix

Presence measured across all 13 production documents. A field on 4/13 is not a contract.

| `deliveries` field | `packageRequests` | Evidence | Transform | Consumer impact |
|---|---|---|---|---|
| `orderId` | `orderId` | **13/13**, equals `orderRef` | none | ✅ direct |
| `status` | `status` | 13/13 but **disjoint vocabulary** | **translation required** | ⚠️ see §1 |
| `createdAt` | `createdAt` | 13/13 | none | ✅ direct |
| `shopId` | — | **ABSENT**; only `sellerUid` (13/13) | **BLOCKED** — see §4 | 🔴 `logistics-plus` ×4 |
| `deliveredAt` | — | **ABSENT** | derive from `timeline`? unproven | 🔴 `logistics-plus:815` |
| `zoneId` | — | **ABSENT** | no source identified | 🔴 `logistics-plus:794` |
| `driverId` | `assignedDriverId` \| `assignedDriverUid` \| `assignedRiderId` \| `riderId` | **four aliases, each 4/13** | pick one — unresolved | 🔴 `email-triggers` |
| `driverName` | `riderName` | 4/13 | rename | ⚠️ `index:1546` |
| `eta` | — | **ABSENT** | none | ⚠️ `index:1546` |
| `stage` | — | **ABSENT** | none | ⚠️ `index:1546` |
| `completedAt` | — | **ABSENT** | none | ⚠️ `automation-engine` |
| `deliveryFee` | `deliveryFee` | 13/13 | none | ✅ (not read by these six) |

### 2a. Four rider-identity aliases inside `packageRequests`

`assignedDriverId`, `assignedDriverUid`, `assignedRiderId`, `riderId` — **each present on exactly
4/13**, almost certainly the same four documents carrying four names for one fact. Choosing the
canonical one is Step 5's job, not Step 1's; `email-triggers` cannot be redirected until it is
chosen, because its whole query is `driverId == null`.

### 2b. `orderId` is NOT unique

Two documents share `orderId: SKN19R7E1S` (`DEL-SFVAYG2…`, `DEL-SFVAZRK…`). Both
`automation-engine.js:433` and `index.js:1546` use `.limit(1)`, so after a redirect they would
select an **arbitrary** one of the two. This is a pre-existing modelling defect that the redirect
would newly expose.

---

## 3. Historical replay risk — the sharpest finding

### `email-triggers.js:836` — `emailUnassignedDeliveryAlert`

```
onSchedule("every 30 minutes")  ->  up to 20 deliveries  ×  up to 10 admin recipients
emailId: `unassigned-alert-${doc.id}-${Date.now()}`
```

**`Date.now()` in the dedupe key means there is NO idempotency.** The same record re-alerts on
every run, forever.

With a status translation that maps `order_placed → pending`, **9 records** become eligible
(measured: unassigned and older than 30 minutes; the oldest is **2026-08-05**). That is up to
**9 × 10 = 90 emails every 30 minutes**, indefinitely, about August deliveries.

**Recommended cutoff — do not rely on the query alone:**
1. an explicit `createdAt >= <activation timestamp>` floor, recorded in config rather than code, **and**
2. a real idempotency key (`unassigned-alert-${doc.id}` with no `Date.now()`), **and**
3. a dry-run mode that logs recipients and sends nothing, run for one full schedule cycle first.

A cutoff alone is insufficient: without fixing the key, any future record still re-alerts forever.

### `automation-engine.js:433` — dispute evidence

Different in kind: not a sweep. It attaches delivery evidence to a dispute and feeds an
auto-resolve decision below a KES threshold. Low volume, **higher stakes** — it can change money
outcomes. It reads `completedAt`, which is absent, so it would attach `undefined` evidence.

**Recommendation:** redirect only after the status translation is settled, and assert that
auto-resolution outcomes are unchanged for the existing dispute corpus before enabling.

---

## 4. BLOCKER — `shopId` is not derivable, and must not be inferred

All four `logistics-plus.js` sites are shop-scoped. `packageRequests` has **no `shopId` and no
`storeId`** — only `sellerUid` (13/13). The codebase contradicts itself on whether these are the
same thing:

* `application-lifecycle.js:890` writes `shopId` **and** `sellerUid` as **different values** on the
  same document
* `index.js:3147/3164/3179` passes `shopId: after.sellerUid` — treating them as **equal**
* `logistics-plus._assertRole` requires `shops/{shopId}` to **exist as a document**

This is exactly the open Business→Store identity question. **The mapping must not be inferred
here.** Until it is ruled, the four `logistics-plus` sites cannot be redirected — they are
**BLOCKED**, not merely unmapped.

---

## 5. Order-page behaviour — `index.js:1546`

Classification requested. The honest answer is **UNPROVEN**, and here is precisely why:

* the surface adds a `📍 Live Map` action and returns a `delivery` sub-object
  (`status`, `driverName`, `eta`, `stage`)
* today that sub-object is **always `null`** — the collection is empty
* after a redirect **without** status translation it stays `null` (inert)
* after a redirect **with** translation it becomes non-null, but **three of its four fields do not
  exist** in `packageRequests` (`driverName`→`riderName` at 4/13; `eta`, `stage` absent)

So "INTENDED CHANGE" would ship a UI object that is mostly `undefined`, and "NOT INTENDED" preserves
a feature that has never worked. Neither is defensible on current evidence — this needs a **product
decision on what the order page should show**, not an engineering inference. Recorded as UNPROVEN
rather than silently chosen.

---

## 6. Per-consumer disposition

| Consumer | Disposition | Blocking condition |
|---|---|---|
| `ecc.js:135` | **RETAIN** | health probe; contents irrelevant |
| `index.js:5713` | **REDIRECT — safe** | inert until status translation; count stays 0 |
| `fulfilment-scan.js:188` | **REDIRECT — safe** | doc-id lookup; needs id-scheme confirmation (`DEL-…` vs `t.id`) |
| `automation-engine.js:433` | **REDIRECT — gated** | status translation + dispute-outcome regression |
| `index.js:1546` | **HOLD** | product decision (§5) |
| `email-triggers.js:836` | **HOLD** | idempotency fix + cutoff + dry-run (§3) |
| `logistics-plus.js` ×4 | **BLOCKED** | `shopId` identity ruling (§4) |

**Only 2 of 10 sites are safely redirectable today.**

---

## 7. Implementation scope, when the redirect gate opens

1. a single shared status-translation module — one mapping, not six copies
2. repoint sites 5 and 9 (safe)
3. everything else gated on §3, §4, §5

## 8. Tests required

* status translation: every `packageRequests` token → the expected `deliveries` token, including
  an **unknown token** case that must not silently map to a permissive value
* `index.js:5713`: count matches a fixture set under the translation
* `fulfilment-scan`: id-scheme round trip
* `email-triggers`: **dry-run asserts zero sends** below the cutoff; idempotency key stable across
  two runs of the same record (the current key fails this)
* `automation-engine`: dispute auto-resolve outcomes unchanged for the existing corpus
* a guard asserting **no new root `/deliveries` read** is introduced

## 9. Must remain untouched

`delivery-hub.js`; the depth-4 `inventory_webhooks/{webhookId}/deliveries` webhook attempt log;
the tenant-scoped `deliveries` path; all `packageRequests` documents; pricing; dispatch; PIN;
wallets and earnings; `xrH21J5GFbW8…`; and DL-02's committed rules denial.
