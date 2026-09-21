# SOKONI — GCP / Firebase cost & architecture audit

**Phase 1, READ ONLY.** Nothing was modified, deployed, deleted, migrated, renamed or disabled.
Production writes 0. Every Firestore probe ran with `set`/`update`/`delete`/`create`/`add`/`batch`/
`runTransaction` replaced by throwing tripwires before any module was loaded.

| | |
|---|---|
| Project | `sokoni-aeb26` · billing account `Firebase Payment` (enabled) |
| Repo | `release/multishop-checkout-certified` @ `30143a3` |
| Measurement window | 30 days to 2026-09-19 |
| Sources | Cloud Monitoring API, Cloud Functions API, Cloud Run API, Cloud Scheduler, Cloud Logging, Firestore `count()` aggregations, IAM policy, repository source |

Every number below is labelled **MEASURED** (read from GCP), **DERIVED** (computed from measured
values), or **ESTIMATE** (list price or code-path reasoning). No usage data is invented.

---

## 1. Executive summary

SOKONI's infrastructure cost does **not** scale with business activity. It is approximately
**99% fixed and 1% marginal**, which is the precise inverse of the stated goal.

The five findings that matter:

**1. Twelve idle containers are 95.7% of the compute bill.** MEASURED: 8,886 billable
instance-hours in 30 days, of which **8,500 hours** come from 12 services pinned at
`minInstanceCount: 1`. Each bills ~708 hours of a 720-hour month — they are on continuously.
Everything else in the estimate — all 1,697 other functions, every cron, every trigger — totals
**~88 hours, about 1%**.

**2. One of those twelve is a function that was retired.** `intasendWebhook` was retired in commit
`1ef1d72` because *IntaSend never called it*; `webhookIntasend` is the sole receiver. It is still
deployed, still pinned at min=1, and has been billing 24/7 ever since. This is provable,
zero-behaviour-risk waste.

**3. 1,281 of 1,709 services served zero requests in 30 days.** MEASURED: only 428 services
reported any traffic. A further 143 served ≤5 requests. The function count is not currently a large
*bill*, but it is a large *blast radius*, a large *deploy risk*, and the reason a single codebase is
stored 1,711 times.

**4. The configured worst case is 157,678 concurrent instances.** DERIVED from the sum of
`maxInstanceCount`: 1,462 services are set to 99 max instances each. If anything triggered a
broad fan-out, the project is configured to scale to **157,678 vCPU and 40 TiB of RAM** before any
SOKONI-side limit stops it. This is the single largest uncontrolled-spend risk and it is a
configuration default, not a decision.

**5. The business did one order.** MEASURED: **1 marketplace order, 5 POS sales and 3 payments in
30 days**, against 99 users and 108 products. Meanwhile `clientMetrics` holds 264,814 documents —
55% of the entire database. Telemetry outweighs business data roughly **94:6**.

**Infrastructure cost per completed order is therefore between about $100 and $760** — not because
per-order cost is high, but because the denominator is 1. At 1,000 orders/month the same
infrastructure would cost roughly **$0.10–$0.76 per order**. The fixed floor is the whole problem.

This is a platform built ahead of its demand, which is a legitimate position. What is not
legitimate is *operating* it as though the demand had arrived: 314 scheduled jobs, 12 always-on
containers and full-fidelity telemetry are the posture of a platform at scale, not one at one
order a month.

**Status: AMBER.** Spend is small in absolute terms and there is no runaway. It is AMBER rather
than GREEN because of the 157,678-instance headroom, `roles/editor` on every function, 37% of
callables without App Check, and a 0.374% 5xx rate with a diagnosed systemic cause. It is not RED
because nothing is currently burning money uncontrollably and no financial behaviour is at risk.

---

## 2. Current architecture

```
Browser / PWA  ──►  Firebase Hosting (static, us-multi)
                         │
                         ├──► 1,421 HTTPS callables ─┐
                         │                            ├─►  1,709 Cloud Run services
Cloud Scheduler ─170 jobs─► 170 scheduled functions ─┤     (Gen2 Cloud Functions,
                         │                            │      nodejs22, 1 vCPU, conc 80)
Firestore writes ──288 event triggers ───────────────┘
                         │
                         ▼
              Firestore (216 collections, 477,335 docs, 410 composite indexes)
              Cloud Storage (app bucket us-east1 — 26 objects)
              External: IntaSend · SendGrid · Algolia · Typesense · Redis · Anthropic
```

Every one of the 1,709 services is built from **the same source bundle** (`functions/`, 398 files,
204,972 lines, 9.3 MB, plus 104 MB `node_modules`). `functions/index.js` alone is **12,741 lines /
689 KB**. Each service's container therefore carries the entire platform in order to serve one
endpoint.

**Region split:** compute is `us-central1` (1,707) and `us-east1` (2). The application storage
bucket `sokoni-aeb26.firebasestorage.app` is in **`us-east1`**. Any media served through a
`us-central1` function crosses regions.

---

## 3. Service inventory

The full per-function inventory is machine-generated rather than transcribed — 1,709 rows would
bury the findings. What it aggregates to:

| Dimension | MEASURED distribution |
|---|---|
| Total deployed | **1,709**, all `ACTIVE`, all Gen2, all `nodejs22` |
| Region | 1,707 `us-central1` · 2 `us-east1` |
| Trigger | 1,421 HTTP/callable · 288 Firestore/Storage event |
| Memory | 1,476 × 256 MiB · 119 × 512 MiB · 99 × 128 MiB · 15 × 1024 MiB |
| CPU | **1 vCPU — all 1,709, no exceptions** |
| Concurrency | **80 — all 1,709, no exceptions** |
| Timeout | 1,028 × 60 s · 271 × 30 s · 97 × 15 s · 93 × 120 s · 55 × 540 s · 51 × 300 s · rest small |
| Max instances | **1,462 × 99** · 125 × 80 · 28 × 10 · 21 unset · rest ≤ 50 |
| Min instances | 1,697 unset · **12 × 1** |
| Runtime SA | **1,709 × the default compute SA** (see §9) |
| Last deployed | 1,705 on 2026-09-09; 4 since |

**Uniform CPU, concurrency and max-instances across 1,709 heterogeneous workloads is the signature
of defaults, not sizing.** A scheduled sweeper and a payment callable have identical resource
contracts.

### The twelve always-on services (MEASURED)

| Service | Memory | 30d billable hours | Justified? |
|---|---|---|---|
| `createCheckoutSession` | 256 Mi | 708.5 | Plausible — cold start on a payment entry point is user-visible |
| `verifyIntasendPayment` | 256 Mi | 708.5 | Plausible — same |
| `initiateSTKPush` | 256 Mi | 708.4 | Plausible — same |
| `webhookIntasend` | 256 Mi | 708.3 | Plausible — the sole live IntaSend receiver |
| `onNewOrderCreated` | 256 Mi | 708.4 | Questionable — an event trigger, not user-facing |
| `onOrderStatusChange` | 256 Mi | 708.4 | Questionable — same |
| `bookingDispatch` | 512 Mi | 708.4 | Questionable at 1 order/month |
| `providerDispatch` | 512 Mi | 708.4 | Questionable at 1 order/month |
| `minishopPage` | 256 Mi | 708.3 | Questionable — SSR page, cacheable |
| `profileGetPublicProfile` | 256 Mi | 708.3 | Questionable — cacheable read |
| `kass` | 256 Mi | 708.4 | Questionable — AI assistant |
| **`intasendWebhook`** | 256 Mi | **708.2** | **No — RETIRED in `1ef1d72`; IntaSend never called it** |

**8,500 of 8,886 instance-hours.** Note every one of them bills ~708 h of a 720 h month regardless
of traffic: `intasendWebhook` served **zero** requests and billed the same as
`createCheckoutSession`.

**2026-09-21:** one of the twelve, `profileGetPublicProfile`, has since been reconstructed and is no
longer pinned. The 30-day figures above are unchanged and remain the measurement for their window;
the current pinned set is **11**.

### Function-explosion status

The historical ~1,971-function surface is now **1,709** — a reduction, and the `smartPosDispatch`
consolidation (154 POS ops behind one service) and `adminOsDispatch` prove the pattern works. But
1,709 is still roughly **one Cloud Run service per 120 lines of source**. The explosion has been
slowed, not reversed.

### Provenance caution

Per the brief, **no function is proposed for deletion on "looks unused" alone.** The 1,281
zero-traffic services include disaster-recovery, admin and seasonal paths that *should* be idle.
`intasendWebhook` is the one exception, and only because its retirement is documented in a commit
and its replacement is named.

---

## 4. Cloud Run analysis

**MEASURED, 30 days:**

| Metric | Value |
|---|---|
| Billable instance time | **8,886 instance-hours** (31,990,135 instance-seconds) |
| Requests | **979,685** |
| Services with any traffic | **428 of 1,709** |
| Services with ≤5 requests | 143 |
| Services with **zero** | **1,281** |
| 2xx / 4xx / 5xx | 968,361 / 7,647 / **3,664** |
| 5xx rate | **0.374%** across **161 distinct services** |
| Egress | 3.36 GB |

**Utilisation.** Excluding the 12 always-on services and `adminOsDispatch`, the remaining ~1,696
services consumed **~88 instance-hours across 979,000 requests**. That is real efficiency —
scale-to-zero is working. The problem is not the busy services; it is the pinned ones.

**Over-provisioning.** No service is over-provisioned on *memory* (256 MiB is modest for a 689 KB
entry module plus dependencies). The over-provisioning is in **max instances**: 99 for services
that have never exceeded one concurrent instance.

**2026-09-21 — the concurrency premise is corrected.** Measured from
`run.googleapis.com/container/instance_count`, hourly `ALIGN_MAX`, **summed across the
`active`/`idle` state labels**, over 30 days:

| service | peak concurrent | ceiling | factor |
|---|---|---|---|
| `processTypesenseQueue` | 6 | unset | unbounded |
| `onOrderStatusChange` | 5 | 99 | 20× |
| `minishopPage` · `kass` · `providerDispatch` · `bookingDispatch` · `onNewOrderCreated` | 3 | 99 / 80 | 27–33× |

So "never exceeded one concurrent instance" is **not current**. The over-provisioning conclusion
stands — every ceiling remains 20–33× above anything observed — but the premise was understated,
and a cross-series **max** rather than a **sum** across state labels will reproduce the old figure.

**Cold starts and the OOM history.** The brief flags a prior Gen2 cold-start/OOM problem from large
bundles. The mechanism is still present and measurable in a different form: memory records
**function discovery taking 8.2 s against a 10 s deploy limit** on a cold worktree. That is the
cost of parsing the shared module graph, and it is paid on **every cold start of every one of the
1,709 services**. No OOM events were observed in the 30-day window; 99 × 128 MiB services are the
population to watch if bundle size grows.

---

## 5. Cloud Functions analysis

**Fan-out is the dominant invocation pattern.** MEASURED top consumers:

| Cluster | Services | Requests each | Cause |
|---|---|---|---|
| Every-minute crons | 6 | ~42,510 | 30 d × 1,440 min |
| Every-5-minute crons | ~16 | ~8,620 | 30 d × 288 |
| **Product write fan-out** | **6–7** | **~46,000** | one `products/{id}` write |
| Telemetry ingest | 2 | 60,236 + 49,016 | `recordMetric`, `obsIngestTelemetry` |

**The product fan-out is the clearest consolidation candidate.** MEASURED: seven functions trigger
on `products/{productId}`, declared across seven files:

```
index.js              indexProductCreate · indexProductUpdate · onProductPriceChanged
email-triggers.js     emailOnProductStatusChange
product-analytics.js  (products/{productId})
product-limit.js      (products/{productId}) ×2
redis-integrations.js onInventoryUpdated
shop-name-sync.js     algoliaSync_products_update
(typesense)           ts_products_onUpdate
```

**One product write starts six to seven containers**, each cold-parsing the same 689 KB bundle.
At ~46,000 invocations each, that is **~280,000 of the month's 979,685 requests from product writes
alone** — against a catalogue of **108 products**. That implies roughly 400+ writes per product per
month, which is itself evidence of write amplification: `indexProductUpdate` writes
`searchableTerms`/`nameLower` back onto the product, re-firing all seven triggers. It carries a
termination guard so it stops after one hop, but one hop doubles the fan-out.

**Scheduled jobs.** 314 `onSchedule` declarations in the repo; **170 deployed** Cloud Scheduler
jobs. Six run every minute. This machinery runs identically whether the platform handles one order
or a million.

---

## 6. Firestore analysis

**MEASURED, 30 days:** 1,174,952 reads · 631,668 writes · 67,874 deletes.
Snapshot listeners **peak 185, mean 1.0**; active connections peak 22, mean 0.5.
*(Caveat: the listener series returned 100 hourly buckets rather than 720 — treat peak as a
lower bound.)*

Against free tiers (50k reads/day, 20k writes/day): reads are **inside** the free tier; writes are
**marginally over** (631,668 vs ~600,000). **Firestore currently costs approximately nothing** —
roughly $0.03 of billable writes.

**The database is mostly exhaust.** MEASURED — 216 root collections, 477,335 documents:

| Collection | Docs | Kind |
|---|---|---|
| `clientMetrics` | **264,814** | telemetry |
| `cspViolations` | 68,042 | telemetry |
| `_sokoniWorkers` | 64,863 | telemetry |
| `selfHealLog` | 19,845 | telemetry |
| `routeDiagnostics` | 15,245 | telemetry |
| `opsMetrics` | 10,080 | telemetry |
| `subscriptionReconciliationRuns` | 8,535 | telemetry |
| `systemHealthHistory` | 6,995 | telemetry |
| … | | |
| `orders` | **10** | business |
| `posRetailSales` | **5** | business |
| `payments` | **27** | business |
| `users` | 99 | business |
| `products` | 108 | business |

**~94% of all documents are observability output.** None of these telemetry collections shows a TTL
policy in the inventory, so they grow without bound.

### Query and listener boundedness (repository analysis)

Method: strip comments, then for each call site inspect a 12-line window for `limit()` — a
same-line grep badly under-counts query builders. Client surfaces only, `functions/` excluded.

| | Sites | Bounded | Unbounded |
|---|---|---|---|
| `onSnapshot` | 281 | 160 + 34 single-doc | **87** |
| `getDocs` | 261 | 165 | **96** |

Worst concentrations: `sokoni-db.js` (14 unbounded listeners), `sokoni-tracking.js` (5),
`realtime.js` (4). For one-shot reads: `sokoni-payment-engine.js` (5), `verification-admin.html`
(5), `sokoni-ai-subscriptions.js` (4).

**Honest framing:** at 108 products and 99 users, an unbounded listener costs nothing today. These
are **scaling defects, not current costs** — they become expensive precisely when the business
starts working. They belong in P1, not P0.

### Journey mapping

The brief asks for reads/writes per journey. **With 1 order in 30 days these cannot be MEASURED**,
and I will not manufacture them. What can be stated is code-derived:

**ESTIMATE — POS sale (`posCompleteCheckout`, code-derived):** ~9 reads + ~11 writes for the
transaction envelope, **plus 1 read and 1 write per line item**, plus the daily-summary increment,
commission posting and movement attribution. A 3-line sale ≈ **12 reads / 15 writes**, before the
`products/{id}` trigger fan-out adds 6–7 container invocations per line written.

The buyer, rider and booking journeys cannot be responsibly estimated from code alone at this
level of confidence, and the traffic to measure them does not exist. **Recommendation: instrument
them (§18, P2) rather than guess.** This is a genuine gap in this audit and it is the main reason
the scaling model in §13 widens quickly.

---

## 7. Storage and image analysis

**MEASURED — `sokoni-aeb26.firebasestorage.app` (us-east1): 26 objects total.**
20 product images, 5 avatars.

| Observation | Evidence |
|---|---|
| Largest product image | **2,382,569 bytes (2.38 MB)** |
| Several others | 2.32 MB, 2.12 MB, 1.93 MB, 1.16 MB ×2 |
| Format | **100% JPEG — no WebP, no AVIF** |
| Thumbnails | **None.** No size-variant naming (`_200x200` etc.) anywhere in the bucket |
| Resize pipeline | Not present |
| Retention | Originals retained at full resolution |

A 2.38 MB hero image is the single most user-hostile fact in this audit — on a Kenyan mobile
connection that is a multi-second wait before a product is visible, and it is paid for in egress
every time it is not cached.

**Current cost is ~$0** (26 objects). **This is the one finding that scales directly with business
success**: 10,000 products × 3 images × 1.5 MB ≈ 45 GB stored and a proportional egress bill.

**Other buckets:** `gcf-v2-sources-*` holds **1,711 source archives averaging 2.69 MB ≈ 4.28 GB**
— the same bundle stored once per service. `sokoni-aeb26-backups` and `-20260626` exist; sizes
**UNMEASURED** (a `du -s` across all buckets did not complete within 20 minutes and was stopped
rather than left running).

---

## 8. Network analysis

**MEASURED:** Cloud Run egress **3.36 GB / 30 days**.

- **Cross-region by construction:** storage is `us-east1`, compute is `us-central1`. Any image
  proxied through a function crosses regions. Direct client→Storage downloads do not, so the
  practical exposure is limited to server-mediated media paths.
- **Two functions live in `us-east1`** while 1,707 live in `us-central1` — any call between them
  crosses regions.
- **`minishopPage` is a min=1 SSR endpoint.** Server-rendered pages are the classic case for CDN
  caching; if its responses are cacheable, both the egress and the pinned instance are avoidable.
- Payload sizes were not sampled per-endpoint — **UNMEASURED**.

---

## 9. Logging, monitoring and IAM

**Logging — MEASURED: 1,752,967,663 bytes (1.75 GB) billable ingestion / 30 days.** Against a
50 GiB free allowance this is **free**. It is still 1.75 GB of logs for one order.

**Monitoring — MEASURED (added during P0-1): 22 alert policies, all enabled, every one wired to a
notification channel**, across two enabled email channels. This is a mature setup and the audit
initially failed to credit it, because the alpha/beta CLI components were unavailable and the REST
API was not queried until P0-1.

**But note the gap it leaves.** The relevant policy is `HTTP 5xx Error Rate > 1%`, and the measured
rate is **0.374%** — so the scheduled jobs that fail on *every single run* have never alerted. A
threshold set above the standing failure rate only reports novelty, never a chronic condition.

**Error visibility — MEASURED: 3,664 5xx across 161 services, ~110–120 each.** That even
distribution is the signature of a systemic cause, not noise, and sampling the logs identified two:

1. **Missing composite indexes.** `runScheduledSelfHeal` — the largest single error producer —
   fails every run:
   `9 FAILED_PRECONDITION: The query requires an index` on `adminAlerts`
   (`resolved` + `severity` + `createdAt`) and on `syncQueue` (`status` + `updatedAt`).
   The self-healing job is the thing most in need of healing.
2. **A real defect.** `processTypesenseQueue` fails every run:
   `Cannot use "undefined" as a Firestore value (found in field "ref")`.

410 composite indexes are deployed, yet these two are missing. **Note the constraint:** memory
records index deploys as gated in this project (`RTCP CERTIFIED — index deploys UNSAFE`; the
payouts index is deliberately withheld). These indexes must **not** be added casually.

**IAM — the most serious non-cost finding.** MEASURED:

```
All 1,709 functions run as: 24799054989-compute@developer.gserviceaccount.com
That account holds:  roles/editor
                     roles/datastore.importExportAdmin
                     roles/eventarc.eventReceiver
                     roles/run.invoker
```

**Every function — including `getReviews` — has project-wide Editor and can export or delete the
entire datastore.** There is no per-service identity and therefore no blast-radius containment
anywhere in the backend.

**App Check.** Method: resolve `onCall`'s first argument, including shared config constants, since
a raw grep under-reports. Of **1,776 callable sites**: **1,072 enforced (60.4%)**, **659
unenforced (37.1%)**, 45 unresolved (2.5%, counted as neither). Unenforced callables are an abuse
vector and therefore a *spend* vector as well as a security one.

**Billing observability — MEASURED: there is no BigQuery billing export.** No datasets exist.
**Actual spend cannot be read from this project**, which is why §11 is a range rather than a figure,
and is itself a P0 finding: you cannot manage what you cannot see.

> **CORRECTED 2026-09-19 during P0-1.** This section originally also reported that no budget alert
> could be verified. That was wrong, and the reason matters: `billingbudgets.googleapis.com` was
> **disabled**, so the list command returned a permission-shaped error which I read as absence.
> Enabling the API revealed **three existing budgets** — USD 10 project-scoped, USD 75 on one
> service, USD 200 overall, all with 50/90/100% thresholds. All three had an **empty
> `notificationsRule`**. An API-disabled error is not an empty result; the control was to enable
> the API and ask again.

---

## 10. Build and artifact analysis

- **Cloud Build:** `gcloud builds list` returned no rows — either outside retention or not
  permitted to this account. ~~**UNMEASURED.**~~ **MEASURED 2026-09-21 — the query needed
  `--region`.** The global listing is empty; `--region=us-central1` returns rows (`ceb903bb`
  2026-09-21 SUCCESS, `72739a70` 2026-09-14, `63737c10` 2026-09-13). Neither retention nor
  permission was the cause — the scope was. Gen2 builds are regional.
- **Artifact Registry:** two `gcf-artifacts` repositories exist; the API reports `sizeBytes: 0`
  and image listing returned empty. ~~**UNMEASURED — verify in Console.**~~ With 1,709 Gen2 functions
  this is the most likely place for hidden storage cost and should not be assumed to be zero.
  **MEASURED 2026-09-21 — the zero is real, and it is a defect rather than thrift.** Both repos
  carry `firebase-functions-cleanup` (`DELETE`, `olderThan: 86400s`, `tagState: ANY`), installed by
  the Firebase CLI in June. Every function image is removed ~24h after it is built, so no service
  can create a revision from its existing spec. Artifact **storage** cost is genuinely ~$0; the
  price is paid in reconstruction. See `GCP_COST_ARCHITECTURE_IMPLEMENTATION.md` §P0-2-INV →
  **CAUSE ESTABLISHED**.
- **Source archives: 4.28 GB** (ESTIMATE, extrapolated from a 200-object sample averaging
  2,685,447 bytes across 1,711 objects).
- Deployment cadence: **1,705 of 1,709 functions were deployed on a single day (2026-09-09)** —
  i.e. the whole surface redeploys together. That is 1,709 container builds per release.
  **2026-09-21: one exception now exists** — `profileGetPublicProfile` was rebuilt individually
  (build `ceb903bb`), demonstrating that single-function reconstruction works and does not require
  the whole surface.

---

## 11. Cost model

**MEASURED inputs** (30 days): 8,886 billable instance-hours; 979,685 requests; 1,174,952 Firestore
reads; 631,668 writes; 3.36 GB egress; 1.75 GB logs; ~4.3 GB storage.

**Compute — DERIVED then ESTIMATE.** The 12 always-on services consume
`12 × 708.4 h × 3600 = 30,602,880 vCPU-seconds` and `3.5 GiB × 2,550,240 s = 8,925,840 GiB-seconds`.

| Billing basis | vCPU | Memory | **Total/month** |
|---|---|---|---|
| Idle/min-instance rate ($0.0000025 per unit) | $76.51 | $22.31 | **≈ $99** |
| Active rate ($0.000024 vCPU-s, $0.0000025 GiB-s) | $734.47 | $22.31 | **≈ $757** |

Which SKU applies to min-instance idle time depends on the CPU-allocation mode, **which I could not
read without a billing export**. The true figure is most likely nearer the lower bound.

| Line | 30-day cost | Basis |
|---|---|---|
| **Compute (12 always-on)** | **$99 – $757** | ESTIMATE, list price, range |
| Compute (all other functions) | < $5 | DERIVED — ~88 instance-hours, largely inside free tier |
| Firestore reads | $0 | MEASURED — inside free tier |
| Firestore writes | ~$0.03 | DERIVED — 31,668 over free tier |
| Firestore storage | ~$0 | small |
| Cloud Storage | ~$0.11 | 4.3 GB |
| Egress | ≤ $0.40 | 3.36 GB, mixed internal |
| Logging | $0 | 1.75 GB vs 50 GiB free |
| Monitoring | ~$0 | within free allowance |
| Build / Artifact Registry | **UNMEASURED** | see §10 |
| **TOTAL** | **≈ $100 – $765** | **~99% compute, ~97% twelve idle containers** |

---

## 12. Cost per order

**MEASURED denominator: 1 marketplace order in 30 days** (10 lifetime). Including POS sales and
payments as "completed commerce events" gives at most 9 events.

| Denominator | Cost per unit |
|---|---|
| 1 marketplace order | **$100 – $765** |
| 9 commerce events | $11 – $85 |

The number is arithmetically correct and practically meaningless as an efficiency measure. **The
honest metric at this stage is the fixed floor: ~$100–$765/month of infrastructure that exists
whether or not anyone buys anything**, of which ~97% is twelve idle containers.

---

## 13. Scaling model

Marginal cost per order is genuinely low; the floor dominates until volume arrives.

| Orders/month | Fixed floor | Marginal (ESTIMATE) | Total | **Per order** |
|---|---|---|---|---|
| 1 (**measured today**) | ~$100–765 | ~$0 | ~$100–765 | **$100–765** |
| 100 | ~$100–765 | < $1 | ~$100–766 | **~$1.00–7.66** |
| 1,000 | ~$100–765 | ~$2–5 | ~$102–770 | **~$0.10–0.77** |
| 10,000 | ~$100–765 | ~$25–60 — Firestore exits free tier | ~$125–825 | **~$0.013–0.083** |
| 100,000 | ~$100–765 | ~$250–600 + image egress | ~$350–1,365 | **~$0.004–0.014** |
| 1,000,000 | ~$100–765 | **$2,500–6,000+, image egress dominant** | ~$2,600–6,800 | **~$0.003–0.007** |

**Assumptions, stated plainly:** marginal Firestore ops per order are code-derived (§6), not
measured; image egress assumes the current unoptimised 1.5 MB average, which is the dominant term
above ~10,000 orders/month; the fan-out multiplier is assumed unchanged. **The ×100,000 and
×1,000,000 rows are extrapolations across five orders of magnitude from a single data point and
should be treated as shape, not forecast.**

The shape is the point: **cost per order improves by ~4 orders of magnitude purely by acquiring
customers.** SOKONI does not have a per-order cost problem. It has a fixed-floor problem and a
latent image-egress problem.

---

## 14. Identified risks

| # | Risk | Severity | Evidence |
|---|---|---|---|
| R1 | **157,678-instance configured headroom** — no project-level ceiling | **P0** | Sum of `maxInstanceCount`; 1,462 services at 99 |
| R2 | **No billing export** — spend unobservable. Budgets DO exist (see §9 correction) but had no notification rule | **P0** | Zero BigQuery datasets |
| R3 | **`roles/editor` on all 1,709 functions** | **P0 (security)** | IAM policy |
| R4 | 12 always-on containers = 95.7% of compute, one of them retired | **P1** | 8,500 of 8,886 instance-hours |
| R5 | 37.1% of callables without App Check → abuse = spend | **P1** | 659 of 1,776 sites |
| R6 | 0.374% 5xx, 161 services, two diagnosed causes | **P1** | 3,664 errors; index + undefined-field |
| R7 | 6–7× product-write fan-out with write-back amplification | **P1** | ~280,000 invocations/month, 108 products |
| R8 | Unbounded media — 2.38 MB JPEGs, no WebP, no thumbnails | **P1** | Bucket listing |
| R9 | 87 unbounded listeners + 96 unbounded `getDocs` | **P1 (scaling)** | Windowed source analysis |
| R10 | Telemetry = 94% of documents, no TTL observed | **P2** | 477,335 docs |
| R11 | 314 cron declarations / 170 deployed at 1 order/month | **P2** | Scheduler inventory |
| R12 | Storage `us-east1` vs compute `us-central1` | **P2** | Bucket + function regions |
| R13 | Artifact Registry and Cloud Build unmeasured | **P2** | API returned nothing |

---

## 15. Consolidation candidates

Ordered by evidence strength, **not** by size of number.

| Candidate | From → To | Basis |
|---|---|---|
| Product-write triggers | 7 services → **1** dispatcher | All bind `products/{productId}`; `smartPosDispatch` proves the pattern |
| Scheduled workers | 170 jobs → **~10–15** tick services | Group by cadence; one every-minute tick fans out in-process |
| Telemetry ingest | `recordMetric` + `obsIngestTelemetry` → **1**, batched | 109,252 invocations/month for observability |
| Queue processors | `processAlgoliaQueue`, `processTypesenseQueue`, `searchQueueCoordinator`, `hubProcessQueue`, `processEmailQueue`… → **1** worker | Identical shape, identical cadence, identical failure mode |
| `intasendWebhook` | **Retire** | Already retired in source; still deployed |

**Explicitly NOT consolidation candidates** — these have real independent boundaries and the brief's
rule protects them: `smartPosDispatch` (already consolidated), the IntaSend payment callables
(security + reliability boundary), `webhookIntasend` (external contract), `adminOsDispatch`
(separate security boundary), anything on the certified VOID/refund rails.

**Realistic target: ~150–250 services**, not "one". That is derived from distinct trigger paths,
security boundaries and deploy lifecycles — not from an arbitrary reduction goal.

---

## 16. Recommended target architecture

```
Hosting (static + CDN, long-cache immutable assets)
    │
    ├─ PUBLIC READ PLANE      ~10 services   CDN-cached, App Check enforced
    │                                        minishopPage, profileGetPublicProfile, catalogue
    ├─ COMMERCE PLANE         ~25 services   own SA, min=1 ONLY on payment entry points
    │                                        checkout, IntaSend, orders, POS dispatch
    ├─ WORKFORCE / ADMIN      ~20 services   own SA, adminOsDispatch pattern
    ├─ EVENT PLANE            ~15 services   ONE dispatcher per collection, fan-out in-process
    ├─ SCHEDULED PLANE        ~12 services   one per cadence, work dispatched internally
    └─ INTEGRATION PLANE      ~15 services   Algolia · Typesense · Redis · SendGrid, one worker each
```

Principles applied, per the brief's rule — a separate service only where independent scaling,
security boundary, deployment lifecycle, reliability boundary or resource requirement genuinely
justifies it:

- **Per-plane service accounts.** No plane holds `roles/editor`. The commerce plane cannot touch
  admin data; the telemetry plane cannot touch orders.
- **One event dispatcher per collection.** `products/{id}` starts *one* container which calls seven
  handlers in-process — removing ~240,000 invocations/month and six cold starts per write.
- **Project-level max-instance ceiling** sized to plausible peak, not 99 × 1,709.
- **min=1 only where a cold start is user-visible on a money path** — four services, not twelve.
- **CDN in front of the public read plane** — cacheable SSR does not need a pinned container.

---

## 17. Recommended resource settings

| Plane | Memory | CPU | Concurrency | Min | Max | Timeout |
|---|---|---|---|---|---|---|
| Public read | 256 Mi | 1 | 80 | 0 (CDN absorbs) | 20 | 30 s |
| Commerce — payment entry | 512 Mi | 1 | 40 | **1** | 30 | 60 s |
| Commerce — other | 256 Mi | 1 | 80 | 0 | 20 | 60 s |
| Workforce / admin | 512 Mi | 1 | 40 | 0 | 10 | 120 s |
| Event dispatcher | 512 Mi | 1 | 40 | 0 | 20 | 120 s |
| Scheduled tick | 512 Mi | 1 | 1 | 0 | 3 | 540 s |

> **2026-09-21 — the Scheduled tick row is CONTRADICTED BY OBSERVATION, for one service.**
> `processTypesenseQueue` is a scheduled tick and its measured 30-day peak is **6**, against this
> row's proposed max of **3**. The proposal is **preserved as the historical proposal** and has
> **not** been raised to 6: the observation establishes that 3 is insufficient to contain the
> observed peak, but it does not establish what the ceiling should be.
> `max=6` accommodates the peak with no measured surge headroom; `10`, `20` and `30` are
> progressively larger burst allowances. **OWNER ADJUDICATION REQUIRED.**
> Every ceiling in this table remains a **proposal**, not an established contract.
| Integration worker | 256 Mi | 1 | 40 | 0 | 10 | 300 s |

Rationale: max instances drop from 99 to a plausible ceiling because ~~no service has been observed
above one concurrent instance~~ **— corrected 2026-09-21: observed peaks are 3–6, still 20–33× below
the deployed ceilings (see §3). The conclusion holds; the premise was understated.** Scheduled ticks
take concurrency 1 because a cron that overlaps
itself is a bug; payment entry points keep `min=1` because that is the one place a cold start is
paid for in abandoned checkouts.

**These are proposals measured against observed load. They must not be applied blind** — §21 defines
how each is verified.

---

## 18. Required implementation changes

**P0 — uncontrolled-spend and blast-radius risk**

1. **Enable BigQuery billing export and a budget alert.** Everything else in this document is a
   range until this exists. Zero behaviour risk.
2. **Set a project-level Cloud Run instance ceiling**, and lower per-service `maxInstanceCount`
   from 99 to the values in §17. Caps the 157,678-instance exposure.
3. **Plan per-plane service accounts** to remove `roles/editor`. Design in P0, execute
   incrementally — this touches every function and must not be rushed.

**P1 — cost and correctness**

4. **Remove `min=1` from the eight questionable services**, keeping it on the four payment entry
   points. Expected to remove ~5,600 of 8,500 always-on instance-hours.
5. **Retire `intasendWebhook`** — already retired in source, provenance in `1ef1d72`.
6. **Collapse the `products/{id}` fan-out** to one dispatcher.
7. **Fix the two diagnosed 5xx causes** — the `processTypesenseQueue` undefined field (a code
   defect, fix directly) and the two missing indexes (**gated — see §14/R6; index deploys are
   restricted in this project**).
8. **Bound the 87 listeners and 96 queries**, highest-count files first.
9. **Image pipeline:** WebP/AVIF, responsive variants, a resize step on upload, long-cache headers.
   The only change here that scales with success.

**P2** — telemetry TTLs, cron consolidation, log sampling, region alignment, per-journey
instrumentation (which closes the §6 gap this audit could not).

---

## 19. Expected cost impact

| Change | Expected saving | Confidence |
|---|---|---|
| Remove 8 × `min=1` | **~$66–500/month** (~5,600 of 8,500 h) | **High** — directly measured |
| Retire `intasendWebhook` | ~$8–63/month | **High** — measured, zero traffic |
| Product fan-out → 1 dispatcher | ~240,000 fewer invocations/month | High on volume, low on $ today |
| Cron consolidation | ~400,000 fewer invocations/month | High on volume, low on $ today |
| Max-instance ceilings | **$0 today; bounds a six-figure tail risk** | High |
| Image pipeline | ~$0 today; **decisive above 10,000 orders/month** | High at scale |
| Telemetry TTL | ~$0 today; prevents unbounded growth | Medium |

**Realistic outcome: the ~$100–765/month floor falls to roughly $30–200/month**, and — more
importantly — the remaining spend becomes proportional to activity. **Most line items save almost
nothing today.** They are worth doing because they convert a fixed floor into a marginal cost and
remove tail risk, not because they cut this month's bill.

---

## 20. Rollback considerations

| Change | Rollback | Risk |
|---|---|---|
| Billing export | Delete the sink | None |
| Max-instance ceilings | Re-raise per service | Low — throttling under an unexpected spike |
| Remove `min=1` | Re-apply `--min-instances=1` | **Cold-start latency on first request.** Measure p95 before and after |
| Retire `intasendWebhook` | Redeploy from `1ef1d72^` | Low — provenance established, zero traffic |
| Fan-out consolidation | Revert commit, redeploy triggers | **Medium — touches product write paths.** Needs its own gate |
| Listener bounds | Revert per file | Low — but changes what users see; verify each surface |
| Image pipeline | Serve originals | Low — keep originals until variants verified |
| Service accounts | Re-grant | **High — an over-tight SA breaks functions in production.** Per-plane, staged |

**Every production configuration change must record before/after state**, per the brief. No batch
touches more than one plane at a time.

---

## 21. Verification plan

Per change: capture the metric **before**, apply to **one** service, verify, then widen.

| Metric | Source | Gate |
|---|---|---|
| Billable instance-hours | `run.googleapis.com/container/billable_instance_time` | Falls; no service rises |
| Cold-start latency p95 | `run.googleapis.com/request_latencies` | Payment paths **do not regress** |
| 5xx rate | `request_count` by `response_code_class` | **< 0.374% baseline**, no new service appears |
| Firestore reads/writes | `document/read_count`, `write_count` | Falls or flat; never rises |
| Requests | `request_count` | Fan-out and cron clusters fall as predicted |
| Active listeners | `network/snapshot_listeners` | Peak falls below 185 |
| Deployed service count | `gcloud functions list` | Falls only by intended retirements |
| Image bytes | bucket listing | p95 object size falls; no functional loss |

**Business-behaviour gates — non-negotiable, and these run before any cost metric is believed:**
the existing SOKONI suite (approval primitive, B9.33R, B9.34-PREP/A/D/E, B9.30A–G, B9.31, B9.32*,
B9.25, POS canonical stock, inventory sync) must stay green, and payment, POS, checkout, seller
inventory, rider and booking flows must be semantically unchanged.

---

## Appendix — measurement provenance

| Claim | Command |
|---|---|
| 1,709 functions | `gcloud functions list` |
| Resource config | `gcloud functions list --format=csv(serviceConfig.*)` |
| Instance-hours, requests, errors, egress, logs | Monitoring API `timeSeries`, 30 d, `ALIGN_SUM` |
| Listeners | Monitoring API, `ALIGN_MAX`/`ALIGN_MEAN` — **gauges, never summed** |
| Business volume | Firestore `count()` aggregations, write APIs tripwired |
| 5xx diagnosis | `gcloud logging read severity>=ERROR` |
| IAM | `gcloud projects get-iam-policy --flatten` |
| App Check | Source analysis resolving shared config identifiers |
| Listener bounds | Source analysis, 12-line window, comments stripped |
| Storage | `gcloud storage ls -l`; source archives extrapolated from a 200-object sample |

**Known gaps, stated rather than filled:** actual billed spend (no export), Artifact Registry size,
Cloud Build history, per-endpoint payload sizes, backup bucket sizes, and per-journey Firestore
operations for buyer/rider/booking — the last because the traffic to measure them does not exist.
