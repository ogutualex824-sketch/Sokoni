# SOKONI — GCP cost & architecture: implementation record

Phase 2 execution log for `GCP_COST_ARCHITECTURE_AUDIT.md`. One slice per section, each with
before state, the exact mutations, after state and a rollback command.

**Rules held throughout:** one slice at a time · every production mutation numbered and recorded ·
no bundling · no change to payment, commission, payout, order, POS, booking or delivery semantics ·
no function deployments (the release line is independently blocked).

| Slice | Status |
|---|---|
| P0-1 Billing export + budget alerting | **DONE (partial — one Console step remains)** |
| P0-2 Unpin 8 unjustified services | **FAILED — rollback BLOCKED on problem B; 8 services remain Ready=False** |
| P0-2-INV Registry provenance investigation | **DONE (read-only) — cause UNKNOWABLE, audit logging off** |
| P0-3 Right-size max instances | **BLOCKED — same root cause** |
| P0-4 Retire `intasendWebhook` | **BLOCKED on a decision — traffic is 22, not 0** |
| P0-5 Least-privilege IAM | separate gate — not started |
| P0-6 App Check audit | separate gate — not started |
| P1 Product triggers / 5xx / consolidation | separate gates — not started |

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
