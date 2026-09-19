# SOKONI — service cost & performance contract

Companion to `GCP_COST_ARCHITECTURE_AUDIT.md`. That document measures what SOKONI *is*; this one
defines what each backend service is *allowed to be*.

**Status: PROPOSED.** Nothing here is enforced yet. A contract nobody checks is a comment, so §7
defines how each line becomes a gate.

**How to read a number.** `MEASURED` = read from GCP in the 30 days to 2026-09-19. `TARGET` = the
budget this service must hold. `CEILING` = the value at which it is in breach. Where today's
measurement already breaches the proposed contract, the row says so rather than quietly widening
the target to fit.

---

## 1. Why a contract, and why per plane

The audit found 1,709 services sharing **one** resource profile — 1 vCPU, concurrency 80, 99 max
instances — regardless of whether the service takes a payment or sweeps a queue. Uniformity of that
kind is not a standard; it is the absence of one.

Contracts are therefore written **per plane**, because a plane is the unit that has a genuine
boundary: its own identity, its own failure domain, its own scaling shape. Individual services
inherit their plane's contract unless named below.

---

## 2. Global invariants — every service, no exceptions

| Invariant | Value | Rationale |
|---|---|---|
| Runtime identity | **Per-plane service account. Never `roles/editor`.** | Today all 1,709 share one account with project-wide Editor — every function can delete the database |
| `maxInstanceCount` | **Per plane below. Never the 99 default.** | Today's configured headroom sums to 157,678 instances / 40 TiB |
| `minInstanceCount` | **0**, unless named in §4 | 12 pinned services = 95.7% of the compute bill |
| App Check | **Enforced on every callable** | 659 of 1,776 callables (37.1%) currently unenforced |
| Unbounded collection reads | **Forbidden** — every collection query carries `limit()` | 87 listeners + 96 `getDocs` currently unbounded |
| Structured logging | `severity` + `service` + correlation id; no PII, no secrets | |
| Cost attribution | Every service carries a `plane` label | Enables per-plane billing once export exists |

---

## 3. Plane contracts

### 3.1 Public read plane — catalogue, minishop, public profiles

| | |
|---|---|
| Expected traffic | Highest-volume plane; bursty, cacheable |
| CPU / memory | 1 vCPU / **256 MiB** |
| Concurrency | 80 |
| Scaling | min **0** · max **20** · CDN absorbs cold starts |
| Firestore reads / request | **TARGET ≤ 3** · CEILING 10 |
| Firestore writes / request | **0** — a read endpoint that writes is in breach |
| Listeners | **0** — public pages poll or use CDN, never subscribe |
| Latency | p95 ≤ 400 ms warm · p99 ≤ 2.5 s incl. cold start |
| Errors | 5xx < **0.1%** |
| Logging | Sampled 1:100 on success · 100% on error |
| **Today** | `minishopPage` and `profileGetPublicProfile` hold `min=1` and bill **708 h/month each**. **In breach** — CDN caching is the intended fix |

### 3.2 Commerce plane — checkout, payments, orders, POS

| | |
|---|---|
| Expected traffic | Lowest volume, highest value. **MEASURED: 1 order + 5 POS sales + 3 payments / 30 d** |
| CPU / memory | 1 vCPU / **512 MiB** (payment entry) · 256 MiB (other) |
| Concurrency | **40** — lower than default; these hold transactions |
| Scaling | min **1 on payment entry only** · max **30** |
| Firestore reads / request | **TARGET ≤ 12** · CEILING 25 *(ESTIMATE: `posCompleteCheckout` ≈ 9 + 1/line)* |
| Firestore writes / request | **TARGET ≤ 15** · CEILING 30 *(ESTIMATE: ≈ 11 + 1/line)* |
| Listeners | 0 server-side |
| Latency | p95 ≤ 1.5 s · **p99 ≤ 3 s including cold start** |
| Errors | 5xx < **0.05%** — the strictest budget on the platform |
| Logging | **100%, never sampled.** Money paths are always fully logged |
| Money invariants | Commission, payout, refund, IntaSend authority and order state machines **semantically unchanged**. A cost change that alters any of these is a defect, not an optimisation |
| **Today** | Within budget. `createCheckoutSession`, `verifyIntasendPayment`, `initiateSTKPush`, `webhookIntasend` keep `min=1` **by design** |

### 3.3 Event plane — Firestore triggers

| | |
|---|---|
| Expected traffic | Proportional to writes. **MEASURED: ~280,000 invocations/month from `products/{id}` alone** |
| CPU / memory | 1 vCPU / **512 MiB** |
| Concurrency | 40 |
| Scaling | min **0** · max **20** |
| **Services per collection** | **TARGET 1 dispatcher. CEILING 1.** Fan-out happens in-process |
| Firestore reads / event | **TARGET ≤ 5** · CEILING 15 |
| Firestore writes / event | **TARGET ≤ 3** · CEILING 8 |
| Write-back amplification | **Must terminate in ≤ 1 hop, and the guard must be tested** |
| Latency | p95 ≤ 2 s |
| Errors | 5xx < 0.1% |
| Logging | 1:10 on success · 100% on error |
| **Today** | **7 services bind `products/{productId}`. In breach of the "1 dispatcher" rule by 6.** One product write starts 6–7 containers, each parsing the same 689 KB bundle |

### 3.4 Scheduled plane — crons, sweepers, reconcilers

| | |
|---|---|
| Expected traffic | Deterministic. **MEASURED: 170 deployed jobs; 6 every-minute; ~16 every-5-minute** |
| CPU / memory | 1 vCPU / **512 MiB** |
| **Concurrency** | **1 — a cron that overlaps itself is a bug** |
| Scaling | min **0** · max **3** |
| **Services per cadence** | **TARGET 1 tick service per cadence.** Work dispatched in-process |
| Firestore reads / tick | **TARGET ≤ 50** · CEILING 500. A tick that scans a collection is in breach |
| Minimum cadence | **5 minutes** unless a money or safety path justifies 1 minute, documented per job |
| Errors | 5xx < **0.5%** — and **zero** jobs failing *every* run |
| Logging | 100% on error; success logs one line, not a report |
| **Today** | **In breach.** 170 jobs where ~12 would do. `runScheduledSelfHeal` and `processTypesenseQueue` fail on **every** run — a hard breach of the error clause |

### 3.5 Integration plane — Algolia, Typesense, Redis, SendGrid, IntaSend, Anthropic

| | |
|---|---|
| Expected traffic | Queue-driven, batched |
| CPU / memory | 1 vCPU / **256 MiB** |
| Concurrency | 40 |
| Scaling | min **0** · max **10** |
| **Services per integration** | **TARGET 1 worker.** One queue, one processor |
| External calls / invocation | **Batched.** 1 call per item is in breach |
| Retry | Exponential backoff + DLQ. **No unbounded retry loop** |
| Errors | 5xx < 0.5%; **external-provider failures logged as `WARN`, not `ERROR`** — an upstream outage must not read as a SOKONI defect |
| Logging | 100% on error · request/response bodies **never** logged (credentials) |
| **Today** | Several queue processors per integration. Consolidation candidate |

### 3.6 Admin / workforce plane

| | |
|---|---|
| CPU / memory | 1 vCPU / **512 MiB** · concurrency 40 · min 0 · max 10 |
| Firestore reads / request | TARGET ≤ 20 · CEILING 100 (admin views are legitimately heavier) |
| Latency | p95 ≤ 2 s · p99 ≤ 5 s — cold start acceptable |
| Errors | 5xx < 0.2% |
| **Security** | Separate SA. **Must not hold commerce-plane write access** |
| **Today** | `adminOsDispatch` is the right shape and already consolidated — **the model for other planes** |

### 3.7 Telemetry plane

| | |
|---|---|
| Expected traffic | **MEASURED: 109,252 invocations / 30 d** (`recordMetric` + `obsIngestTelemetry`) |
| CPU / memory | 1 vCPU / **256 MiB** · concurrency 80 · min 0 · max 10 |
| **Ingest** | **Batched client-side.** One write per event is in breach |
| Firestore writes / request | TARGET ≤ 1 batched · CEILING 5 |
| **Retention** | **TTL mandatory on every telemetry collection** |
| Errors | Best-effort. **Telemetry failure must never fail a user request** |
| **Today** | **In breach.** `clientMetrics` = 264,814 docs (55% of the database); no TTL observed; telemetry is ~94% of all documents |

---

## 4. Services permitted `minInstanceCount: 1`

Pinning is the most expensive setting available and is granted only where a cold start is visible
to a user **on a money path**.

| Service | Justification |
|---|---|
| `createCheckoutSession` | First touch of checkout; cold start is abandoned carts |
| `verifyIntasendPayment` | Payment confirmation; latency is user-visible anxiety |
| `initiateSTKPush` | User waits on their handset for the STK prompt |
| `webhookIntasend` | External caller with its own timeout; sole live receiver |

**Everything else defaults to 0.** Adding a service to this table requires a measured p99 cold-start
cost and a named user-visible symptom.

Currently pinned and **not** on this list — the eight that account for roughly 5,600 billable
instance-hours a month: `onNewOrderCreated`, `onOrderStatusChange`, `bookingDispatch`,
`providerDispatch`, `minishopPage`, `profileGetPublicProfile`, `kass`, and **`intasendWebhook`**,
which was retired in `1ef1d72` and should not be deployed at all.

---

## 5. Platform-wide budgets

| Metric | Today (MEASURED) | TARGET | CEILING |
|---|---|---|---|
| Deployed backend services | **1,709** | ~150–250 | 400 |
| Billable instance-hours / month | **8,886** | < 1,500 | 3,000 |
| Σ `maxInstanceCount` | **157,678** | < 5,000 | 10,000 |
| Services with `min>0` | **12** | 4 | 6 |
| 5xx rate | **0.374%** | < 0.1% | 0.25% |
| Services emitting 5xx | **161** | < 10 | 25 |
| Firestore reads / month | 1,174,952 | proportional to orders | 2× free tier |
| Peak concurrent listeners | 185 | < 5 per session | 10 per session |
| Log ingestion / month | 1.75 GB | < 5 GB | 25 GB |
| p95 product image | **~1.2 MB** | < 150 KB (WebP) | 300 KB |
| **Infra cost / completed order** | **$100–765** | **< $0.10 at ≥ 1,000 orders/mo** | $0.25 |

The cost-per-order target is deliberately conditional on volume. At one order a month **no
architecture achieves $0.10** — quoting that target unconditionally would be dishonest. The floor
is what is being managed now; per-order efficiency becomes the live metric once volume exists.

---

## 6. Breach policy

| Breach | Response |
|---|---|
| Any service exceeds its instance ceiling | Alert; investigate before raising |
| New service brings a plane above its service count | Rejected at review — consolidate instead |
| A callable ships without App Check | Blocked at review |
| An unbounded collection query ships | Blocked at review |
| A cron fails on every run for 24 h | Page; disable the job if it is not a money path |
| Cost/order exceeds ceiling at ≥ 1,000 orders/month | Architecture review, not a resource bump |
| Any change alters payment, commission, payout, order, POS, booking or delivery semantics | **Reverted.** Cost work never changes business behaviour |

---

## 7. How these become gates

A contract is only real if something checks it. In priority order:

1. **BigQuery billing export + budget alert.** Until this exists every cost figure is a range —
   §5's cost row cannot be enforced at all. **This is the prerequisite for the entire document.**
2. **Monitoring alert policies** for 5xx rate, instance-hours and `min>0` service count.
3. **A repo gate** — in the style of the existing SOKONI suites — asserting: no callable without
   App Check, no collection query without `limit()`, no service with `maxInstanceCount: 99`, and
   `min>0` exactly on the four services in §4. Static, cheap, runs on every slice.
4. **Per-journey instrumentation** so the reads/writes-per-order rows become MEASURED rather than
   ESTIMATE. The audit could not measure them because the traffic does not exist; the counters
   should be in place before it does.

---

## 8. Review

Revisit when any holds: an order-volume decade is crossed; a new plane is proposed; the cost/order
ceiling is breached; a P0 risk from the audit is closed.

**First review trigger: the first 100-order month** — the first point at which per-order figures
mean anything.
