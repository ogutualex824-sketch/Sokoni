# SOKONI — GCP cost & architecture: implementation record

Phase 2 execution log for `GCP_COST_ARCHITECTURE_AUDIT.md`. One slice per section, each with
before state, the exact mutations, after state and a rollback command.

**Rules held throughout:** one slice at a time · every production mutation numbered and recorded ·
no bundling · no change to payment, commission, payout, order, POS, booking or delivery semantics ·
no function deployments (the release line is independently blocked).

| Slice | Status |
|---|---|
| P0-1 Billing export + budget alerting | **DONE (partial — one Console step remains)** |
| P0-2 Unpin 8 unjustified services | pending |
| P0-3 Right-size max instances | pending |
| P0-4 Retire `intasendWebhook` | pending |
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
