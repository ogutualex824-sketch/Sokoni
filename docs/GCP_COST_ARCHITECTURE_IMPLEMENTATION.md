# SOKONI — GCP cost & architecture: implementation record

Phase 2 execution log for `GCP_COST_ARCHITECTURE_AUDIT.md`. One slice per section, each with
before state, the exact mutations, after state and a rollback command.

**Rules held throughout:** one slice at a time · every production mutation numbered and recorded ·
no bundling · no change to payment, commission, payout, order, POS, booking or delivery semantics ·
no function deployments (the release line is independently blocked).

| Slice | Status |
|---|---|
| P0-1 Billing export + budget alerting | **CLOSED — owner enabled the export; awaiting async first delivery** |
| P0-1A Budget notification wiring | **PASS — all 3 budgets now reach the ops channel** |
| P0-2 Unpin 8 unjustified services | **FROZEN** — failed; rollback blocked on problem B; 8 services Ready=False |
| P0-2-INV Registry provenance investigation | **DONE (read-only) — cause UNKNOWABLE, audit logging off** |
| P0-3 Right-size max instances | **FROZEN** — same root cause |
| P0-4 Retire `intasendWebhook` | **DEFERRED / HIGH-RISK RETIREMENT** — deletion may be the purge trigger |
| P0-5 Least-privilege IAM | separate gate — not started |
| P0-6 App Check audit | separate gate — not started |
| P0-7 AR Data Access audit logging | **DONE — ADMIN_READ and DATA_WRITE both PROVEN live** |
| P0-7-OBS Forensic harness + baseline | **READY — harness live, method vocabulary confirmed** |
| P0-7-OBS-CANARY Controlled canary push | **Q-A CLOSED (DATA_WRITE proven) · Q-B OPEN (re-read ~24h)** |
| P1 Product triggers / 5xx / consolidation | **consolidation FROZEN** (deletion at scale); others not started |

---

## P0-1 — Billing export and budget alerting

### Two corrections to the audit

The audit reported *"no billing export; no budget alert verified"*. The first half was right. The
second half was wrong, and the reason is worth recording: **`billingbudgets.googleapis.com` was
disabled**, so `gcloud billing budgets list` returned a permission-shaped error that I read as
"no budgets". Enabling the API revealed **three existing budgets**.

Likewise the audit could not see monitoring alerting. It is in fact **well configured**: 22 alert
policies, all enabled, all wired to a notification channel.

Both are corrected in the audit document. A disabled API reading as an absent resource is exactly
the "empty result needs a positive control" failure — the control here was enabling the API and
re-asking.

### BEFORE

```
billing account      : 016742-7E2122-8406F7 ("Firebase Payment"), billingEnabled: true
billingbudgets API   : DISABLED
BigQuery datasets    : none
billing export       : NOT CONFIGURED
budgets              : 3, but unreadable while the API was disabled
  "Firebase Project sokoni-aeb26"  USD 10   project-scoped   50/90/100%   notificationsRule {}
  "App engine alert"               USD 75   1 service        50/90/100%   notificationsRule {}
  "Overall alert"                  USD 200  all services     50/75/90/100% notificationsRule {}
monitoring channels  : 2 enabled email — "SOKONI Ops Alerts", "Kaspa"
alert policies       : 22, all ON, all with 1 channel
```

### MUTATIONS

| # | Mutation | Command |
|---|---|---|
| 1 | Enabled the budget API | `gcloud services enable billingbudgets.googleapis.com --project=sokoni-aeb26` |
| 2 | Created the export dataset | `bq mk --dataset --location=US sokoni-aeb26:billing_export` |
| 3 | Wired the $200 budget to the ops channel | `gcloud billing budgets update <id> --notifications-rule-monitoring-notification-channels=projects/sokoni-aeb26/notificationChannels/3052073155470197456` |

### AFTER

```
billingbudgets API   : ENABLED
BigQuery dataset     : sokoni-aeb26:billing_export  (location US, created 2026-09-19T05:00:55Z)
"Overall alert"      : USD 200, thresholds 50/75/90/100%,
                       notificationsRule = { monitoringNotificationChannels:
                                             [".../notificationChannels/3052073155470197456"] }
billing export       : STILL NOT CONFIGURED  <-- see below
```

### What remains, and why I could not do it

**Billing export to BigQuery cannot be configured from the CLI.** `gcloud billing` exposes only
`accounts`, `budgets` and `projects` — there is no export command, and the Cloud Billing API does
not expose export configuration. It is a Console-only action.

The dataset — the prerequisite — now exists. The remaining step is yours:

> **Console → Billing → `Firebase Payment` → Billing export → BigQuery export → Edit settings**
> Project `sokoni-aeb26`, dataset `billing_export`. Enable **Standard usage cost** (and **Detailed
> usage cost** if you want per-SKU resource-level attribution, which is what makes per-service
> cost visible).

Data begins landing within ~24 hours and is **not backfilled** — the first complete month will be
October. Until then every cost figure in the audit stays a range.

### Two things this exposed

**The $10 project budget would trip at $5.** If real spend is anywhere near even the low end of the
audit's $100–765 estimate, that budget and the $200 one have been firing for some time. If nobody
has seen those alerts, they were going to billing-account administrators and being missed — which
is precisely why mutation 3 wired the $200 budget to the ops channel. **Expect alerts now.** That
is the intended outcome, not a regression.

**The 5xx alert threshold sits above the actual failure rate.** `HTTP 5xx Error Rate > 1%` is a
sensible-looking policy, but the measured rate is **0.374%** — so the crons that fail on *every
single run* have never alerted. A policy tuned above the standing failure rate is a policy that
only reports novelty. Re-tuning belongs to the P1 5xx gate, not here.

### Rollback

```
gcloud billing budgets update b1451494-8123-4d9b-a57b-17b8193eec77 \
  --billing-account=016742-7E2122-8406F7 --clear-notifications-rule
bq rm -r -d sokoni-aeb26:billing_export
gcloud services disable billingbudgets.googleapis.com --project=sokoni-aeb26
```

Risk: none to business behaviour. No compute, Firestore, payment or POS surface was touched.

### Verification

| Check | Result |
|---|---|
| Budgets readable | PASS — 3 listed after enabling the API |
| Dataset exists | PASS — `sokoni-aeb26:billing_export`, US |
| Notification rule populated | PASS — verified by `budgets describe` |
| Business behaviour | Untouched — no code, no function, no rule, no data |
| Production writes to business collections | **0** |

---

## P0-2 — Unpin the 8 unjustified services — **FAILED. Slice halted. Platform blocker found.**

The change did not apply. In attempting it I uncovered a defect materially larger than the cost
issue it was meant to fix, and it blocks P0-3 by the same mechanism.

### One correction to the audit, established before the attempt

The audit recorded `intasendWebhook` as serving **zero** requests. That was wrong — it served
**22** in 30 days. Measured per service rather than grepped:

| Service | 30d requests | 2xx | 4xx/5xx | Caller | Instance-hours |
|---|---|---|---|---|---|
| `intasendwebhook` | **22** | **0** | 22 (401/405) | `197.237.85.87`, one day only | 708 |
| `webhookintasend` | 41 | 41 | 0 | `157.245.201.212` (IntaSend) | 708 |

The correction **strengthens** the retirement rationale rather than weakening it: every one of the
22 was rejected, none came from IntaSend's address, and zero money moved. But the stated
precondition for P0-4 was *"current traffic = 0"*, and 22 is not 0. **P0-4 therefore needs an
explicit decision, not my inference.** It is not started.

### BEFORE (all 12 pinned services, recorded before any mutation)

```
service                  READY  latestCreated == latestReady        spec-min  rev-min
onnewordercreated        True   onnewordercreated-00021-waw            1         1
onorderstatuschange      True   onorderstatuschange-00062-yoz          1         1
bookingdispatch          True   bookingdispatch-00017-nel              1         1
providerdispatch         True   providerdispatch-00048-qiz             1         1
minishoppage             True   minishoppage-00006-beq                 1         1
profilegetpublicprofile  True   profilegetpublicprofile-00005-lap      1         1
kass                     True   kass-00056-soq                         1         1
intasendwebhook          True   intasendwebhook-00064-nin              1         1
-- NOT TOUCHED (the four legitimately pinned money-path services) --
createcheckoutsession    True   createcheckoutsession-00023-zuf        1         1
verifyintasendpayment    True   verifyintasendpayment-00058-roj        1         1
initiatestkpush          True   initiatestkpush-00043-niq              1         1
webhookintasend          True   webhookintasend-00064-lag              1         1
```

### MUTATION ATTEMPTED

`gcloud run services update <svc> --region=us-central1 --min-instances=0 --quiet` on the 8.

`gcloud run services update` was chosen deliberately over `gcloud functions deploy`: the latter
would have **redeployed repository source**, and the release line is independently blocked. The
former changes scaling configuration only.

**All 8 failed identically:**

```
ERROR: Revision 'onnewordercreated-00022-5r9' is not ready and cannot serve traffic.
Image '...gcf-artifacts/sokoni--aeb26__us--central1__on_order_status_change:version_1' not found.
```

### ROOT CAUSE — Artifact Registry holds no function images at all

| Evidence | Result |
|---|---|
| `artifacts repositories list` | 2 x `gcf-artifacts` (DOCKER), **both 0 MB** |
| `artifacts docker images list .../gcf-artifacts` | **0 items** |
| `artifacts docker tags list` on two specific images | **0 items each** |
| Image on a **serving** revision | `...on_order_status_change@sha256:92ea14cd...` — pinned by **digest** |
| Image in the **service spec** | `...on_order_status_change:version_1` — a **tag** |

Cloud Run keeps an internal copy of a revision's image, so **existing revisions keep serving after
the registry is emptied**. Creating a *new* revision re-resolves the spec's tag against Artifact
Registry — and that tag no longer exists. Hence the exact shape observed: everything runs, nothing
can be changed.

The apparent image cross-wiring (`onnewordercreated` to `on_order_status_change`,
`bookingdispatch` to `sokoni_chat`, `minishoppage` to `rider_profile`, `kass` to
`on_package_request_changed`) is **not** a separate defect. The healthy, untouched, 60k-request
service `recordmetric` points at `on_package_request_changed:version_1` too. GCF gen2 shares packed
artifact images across functions; the naming is cosmetic.

### AFTER — actual resulting state

```
service                  READY  serving revision (100% traffic)    rev Ready  spec-min  rev-min
onnewordercreated        False  onnewordercreated-00021-waw          True       ""        1
onorderstatuschange      False  onorderstatuschange-00062-yoz        True       ""        1
bookingdispatch          False  bookingdispatch-00017-nel            True       ""        1
providerdispatch         False  providerdispatch-00048-qiz           True       ""        1
minishoppage             False  minishoppage-00006-beq               True       ""        1
profilegetpublicprofile  False  profilegetpublicprofile-00005-lap    True       ""        1
kass                     False  kass-00056-soq                       True       ""        1
intasendwebhook          False  intasendwebhook-00064-nin            True       ""        1
```

Read precisely:

* **No outage.** `status.traffic` is 100% on the original revision for all 8, each independently
  verified `Ready: True`. Cloud Run never routes to a revision that cannot become ready.
* **No cost saving.** `minScale` is a **revision-level** annotation. The serving revisions still
  carry `minScale: 1`, so all 8 remain pinned and still bill roughly 708 instance-hours/month each.
  The spec now says min=0; nothing reads it until a revision can be created, which is impossible.
* **A real regression I introduced.** Each of the 8 now has a failed latest revision, so the
  service-level `Ready` condition is `False` (`reason: RevisionFailed`). Before the attempt all 12
  were `Ready: True` with `latestCreated == latestReady`. The four money-path services were not
  touched and remain `Ready: True`.

So: business behaviour unchanged, cost unchanged, health signal degraded on 8 non-money services.

### ROLLBACK — required, not yet executed

Restoring `--min-instances=1` would create revision 00023, which fails for the same reason. The
only way to clear `Ready: False` is to delete the failed revision, after which `latestCreated`
falls back to the serving revision:

```
gcloud run revisions delete onnewordercreated-00022-5r9         --region=us-central1 --quiet
gcloud run revisions delete onorderstatuschange-00063-<sfx>     --region=us-central1 --quiet
gcloud run revisions delete bookingdispatch-00018-<sfx>         --region=us-central1 --quiet
gcloud run revisions delete providerdispatch-00049-<sfx>        --region=us-central1 --quiet
gcloud run revisions delete minishoppage-00007-<sfx>            --region=us-central1 --quiet
gcloud run revisions delete profilegetpublicprofile-00006-<sfx> --region=us-central1 --quiet
gcloud run revisions delete kass-00057-<sfx>                    --region=us-central1 --quiet
gcloud run revisions delete intasendwebhook-00065-<sfx>         --region=us-central1 --quiet
```

Each target carries 0% traffic and is not `latestReady`; Cloud Run refuses to delete a revision
that is serving, which is the safety interlock. **This was blocked by the local permission
classifier and awaits authorisation.** It is the first and only thing that should be run.

The spec `minScale=""` is left as-is deliberately: it is inert, and it is the value P0-2 intended.

### The blocker this exposes — larger than the cost finding

> **No Cloud Run revision can be created for any of the 1,709 deployed backend services.**
> The images that back them are absent from Artifact Registry.

Consequences, in order of severity:

1. **No function can be redeployed.** Not for a feature, not for a security fix, not for a payment
   defect. The next `firebase deploy --only functions` must rebuild every image from source — which
   is precisely the deploy path the release line currently blocks.
2. **No function can be reconfigured.** Memory, CPU, concurrency, timeout, scaling, environment,
   service account — every one of these creates a revision. This kills **P0-3 (max-instance
   right-sizing)** outright: it uses the identical mechanism and will fail identically on all
   1,462 services. It also kills the per-plane resource profiles in `GCP_SERVICE_COST_CONTRACT.md`.
3. **Rollback to a previous revision is unaffected** (existing revisions keep their internal image
   copies), but **rollback to a previous _source_** requires a rebuild, so it is not available.
4. The `sizeBytes: 0` on both `gcf-artifacts` repos was already in the Phase 1 audit, recorded as a
   cost observation. It was not a cost observation. It was this.

**Cause not established.** A GCF cleanup policy, a manual purge, or an Artifact Registry lifecycle
rule are all candidates. Determining which is a separate read-only investigation and is not part of
this slice.

### Slice verdict

**P0-2: FAILED — no saving achieved, rollback pending authorisation.**
**P0-3: BLOCKED by the same root cause. Not attempted.**
**P0-4: BLOCKED on a decision — its stated precondition ("current traffic = 0") is not met (22).**

Per the standing rule, I have not attempted to repair the registry defect inside this slice.

---

## P0-2-INV — Read-only deployment & Artifact Registry provenance investigation

Authorised as read-only. **Zero mutations performed.** Ten questions, answered by execution.

### CORRECTION TO THE PREVIOUS SECTION — I overstated the severity

The P0-2 record above says *"No function can be redeployed. Not for a feature, not for a security
fix, not for a payment defect."* **That is wrong, and this investigation disproves it.**

`initiateSTKPush` was **deployed successfully on 2026-09-14 00:45** — Cloud Build `72739a70`,
status SUCCESS, 41s, producing source zip `initiateSTKPush/function-source.zip` at 00:45:58 and
revision `initiatestkpush-00043-niq` at 00:46, which is `Ready: True` and serving today.

The deploy path works. What does **not** work is creating a revision from a service's *existing
spec* without a rebuild. Those are different operations and I conflated them. The corrected claim
is in Q3/Q5 below.

### Q1 — Why are the artifacts absent? **NOT ESTABLISHED. The evidence to establish it was never collected.**

| Candidate cause | Verdict | Evidence |
|---|---|---|
| Cleanup / lifecycle policy | **Ruled out at repo level** | Neither repo has a `cleanupPolicies` field |
| Repository recreation | **Ruled out** | `createTime` 2026-06-08 (us-central1), 2026-06-21 (us-east1) — both predate the loss |
| Wrong project / region / repo | **Ruled out** | Only two AR repos exist in the project; both empty; both are the GCF-managed ones |
| Manual deletion | **Cannot confirm or exclude** | See below |
| Server-side GCF cleanup | **Cannot confirm or exclude** | See below |

**Why the cause cannot be established:** `gcloud projects get-iam-policy` returns
`auditConfigs: null`. **Data Access audit logging is entirely disabled on this project.** Artifact
Registry package and version deletions are Data Access events, not Admin Activity events, so no
deletion was ever recorded. The Admin Activity log for `artifactregistry.googleapis.com` contains
exactly **three** entries in 90 days — two `CreateRepository` (June, by
`service-...@gcf-admin-robot`) and one `UpdateRepository` (2026-06-23). No deletion.

This was verified against two positive controls rather than accepted as an empty result: an
unfiltered audit-log read returns rows, and my own `Services.ReplaceService` calls from earlier
today appear correctly. The query mechanism works; the records do not exist.

**The one hard timing fact:** repo `us-central1/gcf-artifacts` has
`updateTime: 2026-09-15T05:55:28Z`. A build succeeded on 2026-09-14 00:45 and its image is **also**
gone. So whatever removes images ran at or after 2026-09-15 05:55 and removed even a day-old image.
It is recurring, not a one-off.

> **Recommendation, not part of this slice:** enable Data Access audit logging for
> `artifactregistry.googleapis.com`. Without it this question stays unanswerable, and it will recur.

### Q2 — Where do serving revisions get their image? **From Cloud Run's internal copy. Not from AR.**

| | |
|---|---|
| Service **spec** image | `..._on_order_status_change:version_1` — a **tag** |
| Serving **revision** image | `..._on_order_status_change@sha256:92ea14cd…` — a **digest** |
| Does that digest resolve in AR? | **No** — `images describe` returns `Image not found` |
| Is the service serving? | **Yes**, 100% traffic, revision `Ready: True` |

GCF pins each revision by digest at deploy time. Cloud Run retains its own copy of a revision's
image. Both the tag and the digest are absent from AR, yet the revision runs — which is the direct
proof that AR is not in the serving path.

### Q3 — Can we roll back to a healthy revision without creating a new one? **Yes.**

Every affected service retains **at least three prior `Ready: True` revisions**:

```
onnewordercreated       00021-waw(serving) 00020-sam 00019-qax    all Ready=True
onorderstatuschange     00062-yoz(serving) 00061-bix 00060-mux    all Ready=True
bookingdispatch         00017-nel(serving) 00016-xev 00015-des    all Ready=True
providerdispatch        00048-qiz(serving) 00047-cub 00046-yis    all Ready=True
minishoppage            00006-beq(serving) 00005-guv 00004-qir    all Ready=True
profilegetpublicprofile 00005-lap(serving) 00004-ros 00003-juy    all Ready=True
kass                    00056-soq(serving) 00055-hov 00054-duh    all Ready=True
intasendwebhook         00064-nin(serving) 00063-zas 00062-lej    all Ready=True
```

`gcloud run services update-traffic --to-revisions=<rev>=100` modifies `spec.traffic` only, never
`spec.template`, so it creates no revision and cannot hit the missing-image failure. **Revision
rollback is available and safe.**

### Q4 — Can the pipeline reproduce the exact image? **No — but it can reproduce the function.**

`gs://gcf-v2-sources-24799054989-us-central1/` holds **1,711 `function-source.zip` objects**, one
per function, dated 2026-07-07 → 2026-09-14. Source is intact.

A rebuild produces a **new digest**, not the original image — base images and dependency
resolution move. So byte-identical reproduction is **not** available; functional reproduction from
preserved source **is**. For a rollback that must be exact, use Q3 (revision rollback), not a rebuild.

### Q5 — What restores the ability to create revisions? **A rebuild — per function, and it does not last.**

All four required APIs are enabled (`cloudbuild`, `artifactregistry`, `cloudfunctions`, `run`), and
Cloud Build has a working regional history in `us-central1` — five SUCCESS builds, most recent
2026-09-14. Deploying a function rebuilds its image, repopulates its tag, and restores that
function's ability to create revisions.

**But the restoration is temporary.** The image built on 2026-09-14 is already gone. Whatever
removes artifacts removed a one-day-old image. So a redeploy buys a window, not a fix. Until Q1 is
answered, treat deploy-then-reconfigure as a race.

### Q6 — Latent risk to currently-serving revisions? **None demonstrated. This is the key finding.**

`recordmetric` — `minScale` unset (**0**), `Ready: True`, ~60,000 requests/30d — started **new
instances today, after the registry was emptied**:

```
2026-09-19T03:15:58Z  Starting new instance. Reason: AUTOSCALING
2026-09-19T03:16:01Z  Default STARTUP TCP probe succeeded after 1 attempt for container "worker"
2026-09-19T04:05:57Z  Starting new instance. Reason: AUTOSCALING
2026-09-19T04:05:59Z  Default STARTUP TCP probe succeeded after 1 attempt for container "worker"
```

A min=0 service cannot serve without cold-starting, and these cold starts succeeded. **Scale-out
and scale-from-zero do not depend on Artifact Registry.** The blast radius is confined to revision
*creation*. Production is not living on borrowed time.

### Q7 — Cleanup policies configured? **No.** Neither repo carries a `cleanupPolicies` field, and `firebase.json` contains no artifact-cleanup configuration.

### Q8 — Artifacts in another repo or region? **No.** The project has exactly two AR repositories — `us-central1/gcf-artifacts` and `us-east1/gcf-artifacts`. Both report `sizeBytes: 0` and list 0 images. `sizeBytes` is server-computed and independent of the listing path, so two independent signals agree.

### Q9 — Is there enough provenance to reconstruct a deployment? **Yes, from source; no, from artifacts.**

1,711 source zips + intact Cloud Build + enabled APIs + `gcloud functions describe` metadata is
sufficient to redeploy. Artifact-level provenance is gone and is not recoverable.

### Q10 — Can the eight failed revisions be deleted safely? **Yes — all six conditions met on all eight.**

| Service | Failed revision | traffic | latestReady? | serving? | tagged traffic | healthy revision remains | rollback path |
|---|---|---|---|---|---|---|---|
| onnewordercreated | `onnewordercreated-00022-5r9` | 0% | no | no | 0 | yes (3) | confirmed |
| onorderstatuschange | `onorderstatuschange-00063-8sk` | 0% | no | no | 0 | yes (3) | confirmed |
| bookingdispatch | `bookingdispatch-00018-rwl` | 0% | no | no | 0 | yes (3) | confirmed |
| providerdispatch | `providerdispatch-00049-2rp` | 0% | no | no | 0 | yes (3) | confirmed |
| minishoppage | `minishoppage-00007-jnj` | 0% | no | no | 0 | yes (3) | confirmed |
| profilegetpublicprofile | `profilegetpublicprofile-00006-9nq` | 0% | no | no | 0 | yes (3) | confirmed |
| kass | `kass-00057-lkq` | 0% | no | no | 0 | yes (3) | confirmed |
| intasendwebhook | `intasendwebhook-00065-5ck` | 0% | no | no | 0 | yes (3) | confirmed |

Exact names were taken from the `Services.ReplaceService` audit-log entries for my own calls, not
guessed. "Not referenced by another service" holds structurally: in Cloud Run a revision belongs to
exactly one service. The tagged-traffic column was checked explicitly because a traffic tag pins a
revision even at 0%; none of the eight carries one.

### Incidental finding — the image cross-wiring is not a defect

One function's revisions point at unrelated image names over time — `minishoppage` used
`minishop_page` (00004), `on_subscription_changed_sync_limit` (00005), then `rider_profile`
(00006). GCF gen2 packs multiple functions into one shared container image and names it after one
of them. Cosmetic. Do not chase it.

### Reframing

The registry state is a **deployment-resilience** finding, not a cost finding and not an imminent
outage risk:

* Serving: **healthy**, including cold starts (Q6)
* Revision rollback: **available** (Q3)
* Source: **intact**, 1,711 zips (Q4)
* Rebuild: **works**, proven 2026-09-14 (Q5) — but does not persist
* Reconfiguration without rebuild: **broken** — this is the whole of the damage
* Cause: **unknowable as configured** (Q1) — Data Access audit logging is off

**Still blocked:** P0-3 and every per-plane resource profile in `GCP_SERVICE_COST_CONTRACT.md`, all
of which assumed `gcloud run services update`.

---

## P0-2-ROLLBACK — attempted, HALTED on the first deletion

Authorised: delete exactly the eight verified failed revisions, stop immediately if any deletion
behaves differently from the read-only evidence. **It did. One attempt was made; it failed; I
stopped. Seven were not attempted.**

### The attempt

```
BEFORE  onnewordercreated | Ready=False | RevisionFailed
        latestCreated = onnewordercreated-00022-5r9
        latestReady   = onnewordercreated-00021-waw
        traffic       = onnewordercreated-00021-waw @ 100%
        target revision ready-state = False, traffic 0%

COMMAND gcloud run revisions delete onnewordercreated-00022-5r9 --region=us-central1 --quiet

RESULT  Deleting [onnewordercreated-00022-5r9]... failed.
        ERROR: FAILED_PRECONDITION: The latest created Revision
        "onnewordercreated-00022-5r9" cannot be directly deleted.
        exit=1

AFTER   onnewordercreated | Ready=False | RevisionFailed
        latestCreated = onnewordercreated-00022-5r9
        latestReady   = onnewordercreated-00021-waw
        traffic       = onnewordercreated-00021-waw @ 100%
```

**AFTER is byte-identical to BEFORE.** The call was rejected, not partially applied. All eight
services were re-read afterwards; none drifted, all still serve 100% on their healthy revision.

### The condition I missed

My six safety conditions — 0% traffic, not `latestReady`, not serving, no traffic tag, healthy
predecessor present, rollback path confirmed — were **necessary but not sufficient**. There is a
seventh, structural to the Cloud Run delete API and independent of traffic:

> **A revision cannot be deleted while it is `latestCreatedRevisionName`.**

This is not a traffic-safety property, which is why checking traffic, tags and readiness did not
surface it. I verified what Cloud Run guards about *serving* and assumed that was the whole of the
delete contract. It was not. The evidence to predict this was available without mutating and I did
not go looking for it.

**It applies to all eight.** In every one of the eight services, `latestCreated` *is* the failed
revision:

```
onnewordercreated        latestCreated = onnewordercreated-00022-5r9         <- the failed one
onorderstatuschange      latestCreated = onorderstatuschange-00063-8sk       <- the failed one
bookingdispatch          latestCreated = bookingdispatch-00018-rwl           <- the failed one
providerdispatch         latestCreated = providerdispatch-00049-2rp          <- the failed one
minishoppage             latestCreated = minishoppage-00007-jnj              <- the failed one
profilegetpublicprofile  latestCreated = profilegetpublicprofile-00006-9nq   <- the failed one
kass                     latestCreated = kass-00057-lkq                      <- the failed one
intasendwebhook          latestCreated = intasendwebhook-00065-5ck           <- the failed one
```

Attempting the remaining seven would produce seven more identical rejections. Not attempted.

### What this means — a dependency inversion

The only way for a revision to stop being `latestCreated` is for a **newer revision to be
created**. Creating a revision requires an image in Artifact Registry. There is none.

```
clear Ready=False
      |
      +-- requires a NEWER revision to exist
                |
                +-- requires revision creation
                          |
                          +-- requires an image in Artifact Registry
                                    |
                                    +-- BLOCKED (problem B)
```

**Problem B is not merely the next gate — it is a hard prerequisite for undoing the P0-2 damage.**
I had assumed the rollback was independent of the artifact problem. It is not. The eight services
remain `Ready=False` until B is resolved.

### Severity of leaving it

Non-fatal, and unchanged from the P0-2 record: serving is unaffected, traffic is 100% on healthy
revisions, cold starts work, money-path services were never touched. What is degraded is the
**health signal** — eight services report `Ready=False`/`RevisionFailed` on dashboards and to any
alerting that reads service conditions. That is a monitoring-fidelity cost, not an availability one.

### One candidate, deliberately NOT attempted

`gcloud run services replace` with the image pinned to the **serving digest** rather than the
`:version_1` tag would, if Cloud Run accepted it, create a successful newer revision and free the
failed one for deletion. I did **not** try it, for two reasons: it creates a revision, which is
outside this authorisation; and the evidence predicts it fails anyway — `artifacts docker images
describe` on that exact digest returns `Image not found`, so revision creation should reject it
identically. It belongs in the B gate as a hypothesis to test, not as a workaround to reach for.

### Status

**P0-2 rollback: BLOCKED on problem B.** No further mutation attempted. Nothing changed.

---

## P0-7 — Artifact Registry Data Access audit logging — **DONE**

Authorised as a standalone slice: enable Data Access audit logging for
`artifactregistry.googleapis.com` and nothing else. One mutation. All prohibitions honoured.

**Purpose is forward visibility, not repair.** This recovers nothing. The 2026-09-15 disappearance
stays unexplained. What it buys is that the *next* one produces an identifiable deletion event with
a principal, instead of another inference.

### BEFORE

```
project                    : sokoni-aeb26 (24799054989)
IAM policy bytes           : 7046
policy version             : 1
etag                       : BwZa9qfC2ZE=
role bindings              : 39
auditConfigs               : null  (absent — top-level keys were only bindings/etag/version)
AR audit records in 90 days: 3  (2 CreateRepository June, 1 UpdateRepository 2026-06-23)
```

### The change

| | |
|---|---|
| Project | `sokoni-aeb26` |
| Service | `artifactregistry.googleapis.com` — **only** this service |
| Before | `auditConfigs` absent |
| After | `ADMIN_READ` + `DATA_WRITE` |
| Deliberately **excluded** | `DATA_READ` — every image pull; highest-volume log type on the platform and irrelevant to the question |
| Deliberately **excluded** | The "All services" default — not touched |

**Event types now captured.** `DATA_WRITE` covers image/package/version/tag **pushes and
deletions** — `DeletePackage`, `DeleteVersion`, `DeleteTag`. That is the disappearance event.
`ADMIN_READ` covers repository metadata reads, kept because it is low-volume and shows who is
inspecting the registry.

Verified before applying, mechanically rather than by eye:

```
bindings before/after      : 39 / 39
etag preserved             : true (BwZa9qfC2ZE=)
version preserved          : true
ONLY auditConfigs differs  : true   <- deep-equal of both policies with auditConfigs removed
```

### MUTATION

```
gcloud projects set-iam-policy sokoni-aeb26 policy-after.json
```

Etag-guarded: the submitted policy carried the etag read at capture time, so a concurrent change by
another process would have rejected the write rather than silently clobbering it. `exit=0`,
new etag `BwZbz4_7Q1M=`.

**No role binding was added, removed or altered.** The only IAM change is the audit configuration
required by this slice.

### AFTER — verification against every required condition

| # | Condition | Result |
|---|---|---|
| V1 | Audit configuration present | **PASS** — `auditConfigs` returns the expected block |
| V2 | AR Data Access logging enabled | **PASS** — `ADMIN_READ` + `DATA_WRITE` on `artifactregistry.googleapis.com` |
| V3 | Cloud Run services unchanged | **PASS** — all 12 pinned services identical to recorded state |
| V4 | No revisions created | **PASS** — `latestCreatedRevisionName` identical on all 12 |
| V5 | No traffic changed | **PASS** — all 12 still 100% on the same revision |
| V6 | No functions deployed | **PASS** — latest Cloud Build still `2026-09-14 00:45` |
| V7 | No repository/image state changed | **PASS** — both repos `sizeBytes: 0`; `updateTime` still `2026-09-15 05:55:28` (us-central1) and `2026-08-23 08:39:24` (us-east1); image listing still empty |
| — | Role bindings unchanged | **PASS** — 39 before, 39 after |

### Positive control — logging is live, not merely configured

A configuration that is present but inert would read as success. So the slice was closed by
generating an event and confirming capture:

```
issued : gcloud artifacts repositories list
logged : 2026-09-19T05:51:18Z  ArtifactRegistry.ListRepositories  alexochieng3030@gmail.com
```

Before this change the equivalent 90-day query returned **3 June records and nothing else**. It now
records reads in real time. **`ADMIN_READ` is proven working end-to-end.**

**`DATA_WRITE` is enabled but UNPROVEN.** Proving it requires a push or a delete against Artifact
Registry, which this authorisation forbids. It sits in the same `auditConfigs` entry as the proven
`ADMIN_READ`, so confidence is high — but it is not evidence, and it is recorded here as unproven
rather than claimed. It will be proven by the first real write, which is also the event we want.

### Cost

`DATA_WRITE` on one service. Measured platform log ingestion is 1.75 GB/month against a 50 GiB
monthly free allowance, so the added volume is immaterial. Registry writes are rare — three admin
events in 90 days. The expensive option, `DATA_READ`, was not enabled.

### Rollback

```
gcloud projects set-iam-policy sokoni-aeb26 policy-before.json
```

`policy-before.json` is the verbatim pre-change policy. Restoring it removes `auditConfigs` and
returns the project to `null`. No business behaviour depends on this setting either way.

### Preserved as a standing positive control

**`initiateSTKPush` deployed successfully on 2026-09-14** — Cloud Build `72739a70`, SUCCESS, 41s,
revision `initiatestkpush-00043-niq`, `Ready: True`, serving 100% today. The full chain

```
source -> build -> image -> revision -> serving
```

demonstrably works. The failure under investigation is therefore **not** "SOKONI cannot deploy". It
is the narrower:

```
existing service spec -> create revision WITHOUT rebuilding -> references a missing image -> fail
```

Any future diagnosis that implies the whole deploy path is broken contradicts this control and is
wrong.

### Status

**P0-7: DONE.** Stopped here as instructed. Not started and not to be started without a separate
decision: deployment repair, revision creation, revision deletion, min-instance changes,
max-instance changes, `intasendWebhook` retirement.

---

## P0-7-OBS — observation harness, and a gap in the wait-and-see plan

Read-only. No mutation. Tooling: `scripts/infra/ar-forensics.js` — captures every field required
for the forensic correlation (timestamp, methodName, serviceName, principalEmail, principalSubject,
callerIp, user agent, resourceName, status, authorizationInfo) and correlates against Cloud Build,
Cloud Functions and Cloud Run activity in the same window.

### Baseline — 2026-09-19T05:55Z

```
us-central1/gcf-artifacts   sizeBytes=0   updateTime=2026-09-15T05:55:28.000377Z   0 images
us-east1/gcf-artifacts      sizeBytes=0   updateTime=2026-08-23T08:39:24.823079Z   0 images
last Cloud Build            72739a70  SUCCESS  2026-09-14T00:45:59Z
newest source object        initiateSTKPush/function-source.zip  2026-09-14T00:45:58Z
```

### THE GAP — passive waiting can produce silence that proves nothing

**The registry holds zero images. A deletion cannot occur where there is nothing to delete.**

No deploy has run since 2026-09-14. Unless something pushes an image, `DATA_WRITE` will stay empty
forever, and that emptiness cannot distinguish:

* the removal mechanism has stopped, from
* there was nothing left for it to remove.

This is the standing "empty result needs a positive control" rule applied to the observation plan
itself. **A deletion event can only follow a push.** The script says so in its own output rather
than reporting a clean empty result, so the ambiguity cannot be misread later.

Three ways the window opens, in increasing order of deliberateness:

1. **Another agent deploys.** `CLAUDE.md` records that several AI agents work this repo in parallel
   worktrees. Any function deploy plants an image and starts the clock. Uncontrolled, but free.
2. **A canary image pushed directly to `gcf-artifacts`** — no function deployed, no revision
   created, no application code touched. Plants an artifact and observes whether it is removed.
   This is the cheapest *controlled* experiment and does not touch the serving path at all.
3. **A controlled single-function deploy.** Highest fidelity, highest risk — it deploys current
   repo source, and the release line is independently blocked, so the deployed bytes could diverge
   from production. Not recommended without choosing the function very carefully.

**None of these were performed.** Option 2 is offered for a decision; it is not authorised and not
started.

### A LEAD — function deletion as a candidate trigger

The correlation pass surfaced something the earlier investigation missed:

```
2026-09-14T08:37:46Z / 08:37:49Z   DeleteFunction  validateDarajaCredentials   alexochieng3030@gmail.com
2026-09-14T08:38:30Z / 08:38:33Z   DeleteFunction  sendTestSTKPush             alexochieng3030@gmail.com
2026-09-14T08:39:14Z / 08:39:17Z   DeleteFunction  darajaSTKPush               alexochieng3030@gmail.com
                    ...
2026-09-15T05:55:28Z               us-central1/gcf-artifacts updateTime
```

This is the Daraja outbound retirement already on record (1712 → 1709 functions). It is the only
mutating activity in the window before the registry's `updateTime` moved.

**Why it is plausible:** GCF gen2 packs *several functions into one shared container image* — proven
independently by the cross-wiring, where `minishoppage` revisions reference `minishop_page`, then
`on_subscription_changed_sync_limit`, then `rider_profile`. If deleting a function triggers cleanup
of *its* image, and that image is shared, the cleanup removes an artifact that **other, live
functions still reference in their specs**. That would produce exactly what we see: serving
unaffected (Cloud Run holds internal copies), specs unresolvable.

**Why it is not proof:**

* The gap is **~21 hours**, not immediate — consistent with an asynchronous sweeper, but equally
  consistent with an unrelated scheduled job.
* A larger deletion batch on **2026-07-11** (30+ functions in ~40 seconds) has no corresponding
  registry `updateTime`, which the hypothesis does not explain.
* `us-east1`'s `updateTime` of 2026-08-23 correlates with no deletion at all.
* The decisive `DeletePackage`/`DeleteVersion` records were never written, because Data Access
  logging was off until P0-7.

**Status: HYPOTHESIS. Not established.** Recorded so the next event either confirms or kills it.

### CONSEQUENCE FOR P0-4 — the retirement plan may be the trigger

P0-4 retires `intasendWebhook`, and the natural way to retire a function is to **delete** it. If the
hypothesis holds, deleting a function purges a *shared* image and damages unrelated live functions.

That inverts P0-4 from "harmless cleanup of something serving no successful traffic" into
"potentially the exact operation that caused this incident". It cannot proceed until the hypothesis
is settled, independently of the unresolved "22 requests, not 0" question.

**P0-4 now has two blockers, not one.**

### Tooling defect found and fixed

`gcloud`'s `value(updateTime)` renders in **local** time while `.date()` transforms render again —
the same field printed `05:55:28` and `08:55:28` in two invocations during this session. Forensics
correlates against UTC log timestamps, so a silent 3-hour skew would have wrecked the timeline. The
script now parses raw RFC3339 JSON and labels it `(UTC, raw)`.

The harness also **fails closed**: a `gcloud` invocation error prints `QUERY FAILED — this is not
the same as "no events"`. This was not theoretical — the first two runs failed on Windows
`.cmd` spawn semantics and reported the failure instead of an empty, green-looking result.

### Usage

```
node scripts/infra/ar-forensics.js        # last 7 days
node scripts/infra/ar-forensics.js 30d    # explicit window
```

Run it when a disappearance is suspected, or after any deploy, to catch the push and the subsequent
removal in one window. Our own audit reads are tagged in the output so this session's 138
`ListRepositories` calls are not mistaken for the mechanism.

### Status

**P0-7-OBS: harness ready, baseline recorded, waiting.** No production mutation. The 12 pinned
services stay untouched by decision, not by oversight.

---

## P0-7-OBS-CANARY — controlled Artifact Registry canary. Question A ANSWERED.

Authorised: push exactly one inert, uniquely-named artifact; verify; stop. **One push performed.
No deploy, no revision, no service change, no deletion, no IAM or config change.**

### How it was pushed — and why that matters

No container tooling exists on this machine (`docker`, `crane`, `oras`, `podman`, `buildah`,
`skopeo` — all absent). Rather than install any, the push used the **Docker Registry v2 HTTP API
directly** from Node. This is the minimum possible machinery: GCF, Cloud Run and Cloud Build are
never contacted. Tool: `scripts/infra/ar-canary-push.js`.

The artifact is inert by construction — an empty tar (two 512-byte zero blocks), gzipped to 29
bytes, plus a 328-byte config whose history string reads *"SOKONI Artifact Registry forensics
canary (P0-7-OBS). Inert. Not a function image. Safe to delete."* It is not runnable and is
attached to nothing.

**Safety enforced in code, not promised.** The pusher refuses any path outside the canary
namespace, never issues `DELETE` (the verb is unreachable), and aborts rather than overwrite an
existing tag. The interlock **fired in practice**: the first run was refused because Artifact
Registry returns an opaque upload-session URL carrying no image name. It was then widened
*precisely* — to that repository's upload-session prefix only — rather than removed. A blob
uploaded but never referenced by a manifest is unreferenced garbage; it cannot alter an existing
image, and every manifest write remains canary-scoped.

### BEFORE — 2026-09-19T06:05:53Z

```
repository        : gcf-artifacts          region: us-central1
image inventory   : []                     (zero images)
sizeBytes         : 0
updateTime        : 2026-09-15T05:55:28.000377Z
AR write/delete events, 30d : none
onnewordercreated latestCreated : onnewordercreated-00022-5r9
last Cloud Build  : 72739a70-d108-4812-b1e2-0e64243855f6
canary identifier : us-central1-docker.pkg.dev/sokoni-aeb26/gcf-artifacts/
                    sokoni-ar-forensics-canary:20260919T060552Z
```

### AFTER

| Check | Result |
|---|---|
| Artifact exists | **YES** — `sokoni-ar-forensics-canary`, tag `20260919T060552Z`, created `2026-09-19 06:08:12Z` |
| Manifest digest | `sha256:88f338d30f7c40853b2750f3a5c13dc0a57f167552e70dcdbb5d0fce6ce9cf81` |
| Layer / config digests | `sha256:b48e9c60…` (29 B) · `sha256:1a6efe0c…` (328 B) |
| Repository size | **0 → 779 bytes** |
| Repository updateTime | `2026-09-15T05:55:28Z` → **`2026-09-19T06:08:12.330016Z`** |
| Cloud Run revisions | **unchanged** — all four spot-checked services identical |
| Cloud Function deployment | **none** |
| Cloud Build | **unchanged** — still `72739a70…` |
| Existing images/tags modified | **none existed to modify** (repo was empty) |

### QUESTION A — does DATA_WRITE capture a registry write? **YES. PROVEN.**

```
timestamp      : 2026-09-19T06:08:11.449413497Z
methodName     : Docker-StartUpload
serviceName    : artifactregistry.googleapis.com
principalEmail : alexochieng3030@gmail.com
callerIp       : 197.237.85.87
callerUA       : gzip(gfe)
resourceName   : projects/sokoni-aeb26/locations/us-central1/repositories/gcf-artifacts
status         : code=OK
permissions    : ["artifactregistry.repositories.uploadArtifacts"]
```

P0-7 recorded `DATA_WRITE` as *enabled but UNPROVEN*. **It is now proven**, with the full field set
the forensic plan requires: timestamp, method, service, principal, caller IP, user agent, resource,
status and authorization. When the images disappear again, an event of this shape will name the
actor.

**Method vocabulary captured empirically** — `Docker-StartUpload` (×3) and `Docker-PutManifest`
(×1). This mattered: the forensic harness's regex did **not** include `Manifest`, so it would have
missed a push. Fixed, with the empirical basis recorded in the code comment. Deletions are expected
as `Docker-Delete*` / `DeletePackage` / `DeleteVersion` / `DeleteTag`.

*(Three `StartUpload` for two blobs: the first, refused run had already opened one session.)*

### QUESTION B — does the canary disappear? **OPEN. Do not conclude anything yet.**

The canary is 11 minutes old. The reference interval is the 2026-09-14 → 2026-09-15 window, roughly
21 hours. Nothing can be inferred before then, and a surviving canary is a **valid result**: it
would answer A and leave B unreproduced, narrowing the cause to something the canary does not model
— a function-lifecycle event rather than a blanket repository sweep.

**The canary is deliberately NOT deleted.** It is the instrument.

### INCIDENTAL FINDING — and it changes P0-4 again

The canary push, made from **this machine**, logged `callerIp: 197.237.85.87`.

That is the **same IP as all 22 requests to `intasendWebhook`** — the traffic that blocked P0-4 on
the "current traffic = 0" precondition. The live IntaSend receiver `webhookIntasend` is called from
a different address entirely, `157.245.201.212`.

So the 22 requests did not come from an unknown third party probing a retired endpoint. **They came
from this operator's own network** — consistent with local testing, and consistent with every one
being rejected 401/405 with zero 2xx.

Confidence: **high, not certain.** A Kenyan ISP address may be shared or carrier-graded, so "same
IP" is not "same person". But combined with the rejection pattern and the single-day burst, the
natural reading is operator testing, not external traffic.

**Effect on P0-4's first blocker:** the "22 ≠ 0" objection is substantially weakened — external
traffic to `intasendWebhook` appears to be genuinely zero. **The second blocker is untouched and
still decisive:** retiring the function means *deleting* it, and function deletion is the leading
hypothesis for the purge. P0-4 stays frozen on that ground alone.

### Status

**Question A: CLOSED — DATA_WRITE proven live with full field capture.**
**Question B: OPEN — re-read after ~24h with `node scripts/infra/ar-forensics.js 1d`.**

Stopped. No wait-and-act. The canary was not deleted, the purge was not reproduced, nothing was
deployed, and the 12 pinned services remain untouched.

---

## FREEZE REGISTER — pending artifact provenance

Frozen by decision, not by oversight. Each is frozen because it depends on, or could destroy the
evidence for, the unresolved Artifact Registry behaviour.

| Slice | State | Why frozen |
|---|---|---|
| P0-2 min-instance optimisation | **FROZEN** | Needs revision creation; also awaiting cleanup of its own 8 failed revisions |
| P0-3 max-instance optimisation | **FROZEN** | Same mechanism; would fail identically on 1,462 services |
| P0-4 `intasendWebhook` retirement | **DEFERRED / HIGH-RISK RETIREMENT** | Retiring means *deleting a function* — the leading purge hypothesis |
| P1 mass function consolidation | **FROZEN** | Consolidation is deletion at scale; the worst possible time to attempt it |

Healthy and untouched meanwhile: production traffic, payment paths, the 12 pinned services, the
four money-path services, all serving revisions.

### P0-4 reclassified

Previously "BLOCKED on a decision". Now **DEFERRED / HIGH-RISK RETIREMENT**, which is a different
thing. The traffic objection has weakened — the 22 requests trace to this operator's own egress IP
— but the retirement *method* is itself the suspected trigger. Deleting `intasendWebhook` could
reproduce the purge, or destroy the evidence we are waiting on, or both. It is not a cleanup task
any more; it is an experiment, and not the one we want to run first.

### The architectural lesson, if the hypothesis confirms

> Deleting a Gen2 function may remove a **shared** artifact that other deployed functions still
> reference.

That single sentence would explain every observation: existing revisions keep serving from Cloud
Run's internal copies, while new revisions from old specs cannot resolve their images. If
confirmed, it changes how SOKONI must handle **every** future function retirement and every
consolidation — which is precisely why P1 consolidation is frozen alongside P0-4 rather than
treated as unrelated.

**Still a hypothesis.** The 09-14 → 09-15 correlation is suggestive, not causal, and the 07-11
deletion batch does not fit it.

### The 24-hour check — mechanical, not interpretive

```
node scripts/infra/ar-forensics.js 1d
```

The tool now classifies the result itself, so the outcome cannot be argued into:

| Verdict | Meaning | Next step |
|---|---|---|
| **OUTCOME 1** — canary survives, no deletions | Purge not reproduced. **A valid result.** Argues against a blanket repository sweep and towards a function-lifecycle trigger | Investigate the lifecycle path, not the repository |
| **OUTCOME 2** — canary gone, deletion events captured | **Breakthrough.** Principal, method, resource and timestamp identify the mechanism | Inspect the captured principal; then design the repair |
| **OUTCOME 3** — canary gone, no deletion event | Either the removal is outside `DATA_WRITE`, another mechanism is involved, or the repository reading is wrong | **Investigate. Do not conclude** |
| **MIXED** | Canary survives but something else was deleted | Inspect before concluding |
| **INDETERMINATE** | A query failed | Not an outcome. Fix and re-run |

Two guards were added because both failure modes actually occurred during construction:

* **Age guard.** The verdict prints the canary's age and, below the reference interval (~21h),
  states that a surviving canary *proves nothing yet* and must not be quoted. Read at 0.3h it
  already showed "OUTCOME 1", which is meaningless.
* **Fail-closed lookup.** `canaryPresent` is `null` on any query failure and is never conflated
  with `false`. This caught a real defect: `CANARY_MARK` was declared in the pusher but not in the
  forensics script, and the resulting `ReferenceError` surfaced as **INDETERMINATE** rather than as
  a false "canary absent". An absence assertion that cannot distinguish "gone" from "I failed to
  look" is worthless, and this one was tested both ways.

### Do not delete the canary

`sokoni-ar-forensics-canary:20260919T060552Z`, digest `sha256:88f338d3…`. It is the reference
specimen. The script checks the digest so a surviving original is distinguishable from a re-pushed
replacement.

### Status

The next meaningful event is not a mutation. It is the first artifact lifecycle event after
2026-09-19T06:08:12Z.

---

## P0-1 (continued) — completion attempt. **BLOCKED: the remaining step has no API.**

Read-only verification performed as instructed. **No mutation was made**, because the verification
established that the remaining step cannot be performed by any programmatic means available here.

### Current state — verified, not assumed

| Item | State |
|---|---|
| Project → billing account | `sokoni-aeb26` → `billingAccounts/016742-7E2122-8406F7`, `billingEnabled: true` |
| Billing account | "Firebase Payment", **open: True** (two other accounts exist and are **closed**) |
| Export dataset | `sokoni-aeb26:billing_export` exists, location **US**, created 2026-09-19 |
| Export **active?** | **NO — the dataset contains zero tables** |
| Last successful export | **none — never ran** |
| Dataset access | `projectOwners`/`projectWriters`/`projectReaders` + owner. **No billing-export service account**, which is granted automatically when the export is configured |

**Budgets — 3, all on the correct account:**

| Budget | Amount | Thresholds | Monitoring channel | Scope |
|---|---|---|---|---|
| Firebase Project sokoni-aeb26 | USD 10 | 50/90/100% | **none** (default IAM recipients only) | project `24799054989` |
| App engine alert | USD 75 | 50/90/100% | **none** (default IAM recipients only) | 1 service |
| Overall alert | USD 200 | 50/75/90/100% | `…/notificationChannels/3052073155470197456` | all projects, all services |

The `Overall alert` channel is the P0-1 mutation from the earlier slice, confirmed still in place.

### The missing step, and why it is BLOCKED

**BigQuery billing export cannot be configured programmatically.** This was previously asserted;
it is now established by execution:

| Probe | Result |
|---|---|
| `gcloud billing --help` | Groups are exactly `accounts`, `budgets`, `projects`. No export. |
| `gcloud alpha billing` / `gcloud beta billing` | No export command in either surface |
| Cloud Billing v1 discovery — resources | `organizations, billingAccounts, services, projects, …` — **no export resource** |
| `billingAccounts` sub-resources | `subAccounts, projects` only |
| `billingAccounts` methods | `get, patch, list, create, testIamPermissions, getIamPolicy, move, setIamPolicy` — no export method |
| `BillingAccount` schema writable fields | `masterBillingAccount`, `currencyCode`, `displayName` only. **No export field**, so `patch` cannot set it either |

An earlier grep for "export" in the discovery document matched **prose, not an identifier** — a
textbook case of a detector reading a description as evidence. Re-checked structurally against
resources, methods and schema properties, and the answer is a clean negative.

**BLOCKED on an action only a human with Console access can take:**

> **Console → Billing → `Firebase Payment` → Billing export → BigQuery export → Edit settings**
> Project `sokoni-aeb26`, dataset `billing_export`.
> Enable **Standard usage cost**, and **Detailed usage cost** if per-SKU resource-level attribution
> is wanted — that is the one that makes per-service cost visible, which is what the audit needs.

After enabling: data begins landing within ~24h and is **not backfilled**. The first complete month
is October. Until then every cost figure in the audit remains a range, and §5 of
`GCP_SERVICE_COST_CONTRACT.md` cannot be enforced.

The prerequisite — the dataset — already exists, so the Console step is the only remaining work.

### Verification — nothing changed

| Check | Result |
|---|---|
| Cloud Run revision created | **none** |
| Cloud Function deployed | **none** |
| Production traffic changed | **none** |
| Cloud Build | unchanged — `72739a70-d108-4812-b1e2-0e64243855f6` |
| Artifact Registry | unchanged |
| Canary | **untouched** — `sokoni-ar-forensics-canary:20260919T060552Z`, digest `sha256:88f338d3…` |
| Forensic baseline | **CLEAN** — 1,709 functions, build matches, no revision drift |
| IAM / App Check / Firestore rules / application code | untouched |
| Payment, POS, order, booking logic | untouched |

### Two observations — recorded, deliberately NOT acted on

Both are outside "perform only the remaining Console step", so no mutation was made.

1. **Two budgets have no monitoring notification channel.** The $10 and $75 budgets notify only
   default IAM recipients on the billing account — the same failure mode that hid the earlier
   alerts. Only the $200 budget was wired to the ops channel. Wiring the other two is a one-command
   change and belongs in its own slice.
2. **The $10 project budget trips at $5.** Against the audit's $100–765 estimate it is certainly
   firing continuously, which makes it noise rather than signal. It should be re-based to something
   near real spend once the export gives a real number — which is another reason the Console step
   is the gate for everything else here.

### Status

**P0-1: BLOCKED — awaiting one Console action by the owner.** Everything programmatically possible
in this slice is done. No further automated work on P0-1 is available.

---

## P0-1A — Budget notification wiring. **PASS.**

Two mutations, both on notification configuration only. The BigQuery export remains untouched and
still blocked on the Console.

### Was it a patch or a replace?

Checked before mutating, because the instruction was to stop if the API replaces whole objects.

* `gcloud billing budgets update` derives an update mask from the flags supplied; only
  `notificationsRule` was supplied.
* The flag's own documentation: *"Targets to send notifications to when a threshold is exceeded.
  **This is in addition to default recipients** who have billing account roles."*
* Empirically, the earlier `$200` update via this same flag preserved its amount and all four
  thresholds.

Confirmed by outcome: after each mutation the amount, thresholds, filter and default IAM recipients
were byte-identical. **It patches. No budget object was replaced.**

### BEFORE

| Budget | ID | Amount | Thresholds | `notificationsRule` | Filter |
|---|---|---|---|---|---|
| Firebase Project sokoni-aeb26 | `32c19d43…` | USD 10 | 0.5 / 0.9 / 1.0 | **`{}` — no channel** | project `24799054989` |
| App engine alert | `441c3f30…` | USD 75 | 0.5 / 0.9 / 1.0 | **`{}` — no channel** | service `F17B-412E-CB64` |
| Overall alert | `b1451494…` | USD 200 | 0.5 / 0.9 / 1.0 / 0.75 | ops channel present | all |

Confirmed that **only** the $10 and $75 budgets were missing the channel.

### MUTATIONS — two, one at a time, verified between

```
1. gcloud billing budgets update 32c19d43-e2ee-418f-afbb-7dc44b4aabd4 \
     --billing-account=016742-7E2122-8406F7 \
     --notifications-rule-monitoring-notification-channels=\
       projects/sokoni-aeb26/notificationChannels/3052073155470197456     exit=0

   [verified before proceeding: USD 10, [0.5,0.9,1], filter intact, defaultIam on]

2. gcloud billing budgets update 441c3f30-97cc-456a-9e4f-362850cdd278 \
     --billing-account=016742-7E2122-8406F7 \
     --notifications-rule-monitoring-notification-channels=\
       projects/sokoni-aeb26/notificationChannels/3052073155470197456     exit=0
```

No new notification channel was created; the existing ops channel was reused.

### AFTER

```
- Firebase Project sokoni-aeb26  USD   10  thresholds=[0.5,0.9,1]       ops-channel=YES  defaultIam=on
- App engine alert               USD   75  thresholds=[0.5,0.9,1]       ops-channel=YES  defaultIam=on
- Overall alert                  USD  200  thresholds=[0.5,0.9,1,0.75]  ops-channel=YES  defaultIam=on
```

### Verification

| Check | Result |
|---|---|
| $10 amount / thresholds unchanged | **PASS** — USD 10, [0.5, 0.9, 1.0] |
| $10 ops channel present | **PASS** |
| $75 amount / thresholds unchanged | **PASS** — USD 75, [0.5, 0.9, 1.0] |
| $75 ops channel present | **PASS** |
| $200 unchanged | **PASS** — USD 200, four thresholds, channel intact |
| Default IAM recipients still enabled | **PASS** on all three — the channel is additive, not a replacement |
| Budget filters unchanged | **PASS** — project and service scopes intact |
| Billing export | **unchanged and still unconfigured** — `billing_export` holds zero tables |
| Cloud Run revisions created | **none** |
| Function deployed | **none** |
| Traffic changed | **none** |
| Cloud Build | unchanged — `72739a70…` |
| Artifact Registry | unchanged |
| Canary | **intact** — `sha256:88f338d3…`, tag `20260919T060552Z` |
| Forensic baseline | **CLEAN** — 1,709 functions, no drift |
| IAM / App Check / rules / application code | untouched |
| Payment, POS, order, booking | untouched |

### What this actually fixes

All three budgets previously notified only *default IAM recipients* — billing-account
administrators. That is exactly the failure mode the audit already ran into: budgets were firing
and nobody saw them, which is why they read as absent. Now every threshold on every budget reaches
the ops channel.

**Expect alerts, possibly immediately.** The $10 project budget trips at $5. Against the audit's
$100–765 estimate it is certainly already over every threshold. That noise is the intended
consequence of making the alerts visible, not a regression.

### Deliberately NOT changed

**The $10 budget amount stays at $10.** It is noisy today, but it is a useful early-warning floor
once a real baseline exists, and recalibrating it now would mean guessing. Thresholds get re-based
from actual billing data after the export lands — not before.

### Rollback

```
gcloud billing budgets update 32c19d43-e2ee-418f-afbb-7dc44b4aabd4 \
  --billing-account=016742-7E2122-8406F7 --clear-notifications-rule
gcloud billing budgets update 441c3f30-97cc-456a-9e4f-362850cdd278 \
  --billing-account=016742-7E2122-8406F7 --clear-notifications-rule
```

Note this clears the whole `notificationsRule`, returning each to `{}` — which is exactly the
recorded before-state for these two. Do **not** run it against `b1451494…`, whose rule predates
this slice.

Complete pre-change budget objects, including etags, are preserved in the slice working notes.

### Status

**P0-1A: PASS.** P0-1's export step remains BLOCKED on the Console. No frozen work started.

---

## P0-1 — CLOSED. Owner completed the Console step 2026-09-19.

Billing export to BigQuery was enabled by the owner in the Console — the one action with no
programmatic surface. P0-1 is no longer blocked.

```
Billing account : Firebase Payment (016742-7E2122-8406F7)
Project         : sokoni-aeb26
Dataset         : billing_export (US)
Standard usage cost : ON
Detailed usage cost : ON   <- per-SKU, per-resource attribution
```

`Detailed` is the one that matters for this programme. It is what eventually turns
*"GCP costs roughly X"* into *"this service consumed X while this business activity produced Y
transactions"* — the per-service cost attribution that §5 of `GCP_SERVICE_COST_CONTRACT.md` needs
and that the cost-per-order metric depends on.

**Deliberately NOT enabled:** FOCUS, Pricing and CUD exports. Not needed for this programme.

### Verification state at hand-off

`billing_export` holds **zero tables** at 2026-09-19T06:3xZ. That is expected, not a fault —
delivery is asynchronous and on Google's side. Data typically begins landing within ~24h and is
**not backfilled**, so the first complete month is October.

Until a table exists, every cost figure in the audit stays a range and the cost-per-order metric
cannot be computed.

**Verify with:**

```
bq --project_id=sokoni-aeb26 ls billing_export
```

Expect, once populated:

| Table | Source |
|---|---|
| `gcp_billing_export_v1_016742_7E2122_8406F7` | Standard usage cost |
| `gcp_billing_export_resource_v1_016742_7E2122_8406F7` | Detailed usage cost |

An empty listing before ~24h means nothing. An empty listing well after that is a real finding and
should be investigated rather than assumed to be latency.

### P0-1 group — final state

| Item | State |
|---|---|
| Budget API enabled | DONE |
| Export dataset created | DONE |
| Export configured (Console) | **DONE — owner, 2026-09-19** |
| $200 budget → ops channel | DONE |
| $10 and $75 budgets → ops channel | DONE (P0-1A) |
| Export data landed | **PENDING — asynchronous** |

Cost visibility is now instrumented end to end. The remaining wait is Google's, not ours.
