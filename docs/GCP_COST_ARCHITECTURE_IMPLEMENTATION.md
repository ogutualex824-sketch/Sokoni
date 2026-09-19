# SOKONI — GCP cost & architecture: implementation record

Phase 2 execution log for `GCP_COST_ARCHITECTURE_AUDIT.md`. One slice per section, each with
before state, the exact mutations, after state and a rollback command.

**Rules held throughout:** one slice at a time · every production mutation numbered and recorded ·
no bundling · no change to payment, commission, payout, order, POS, booking or delivery semantics ·
no function deployments (the release line is independently blocked).

| Slice | Status |
|---|---|
| P0-1 Billing export + budget alerting | **DONE (partial — one Console step remains)** |
| P0-2 Unpin 8 unjustified services | **FAILED — rollback pending authorisation** |
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
