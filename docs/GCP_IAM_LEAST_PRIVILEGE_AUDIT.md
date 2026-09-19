# SOKONI — least-privilege IAM audit

**Gate: P0-5. READ-ONLY inventory and analysis. Zero IAM mutations performed.**
Date: 2026-09-19 · Project `sokoni-aeb26` (24799054989)

Companion to `GCP_COST_ARCHITECTURE_AUDIT.md` and `GCP_COST_ARCHITECTURE_IMPLEMENTATION.md`.
Run while the Artifact Registry canary observation is frozen; nothing here touches Cloud Run,
Cloud Functions, Artifact Registry, traffic or production IAM.

---

## 1. Two corrections to the earlier audit

**"All 1,709 share one account with project-wide Editor."** The *conclusion* is right and is now
proven rather than sampled — but the surrounding numbers were wrong.

| Earlier statement | Reality |
|---|---|
| "1,709 service accounts" | **6 service accounts exist**, total |
| implied broad Editor sprawl | **Exactly 3 principals hold `roles/editor`** |
| 1,709 workloads on one Editor SA | **Confirmed, by census — 1,707 + 2 = 1,709, no exceptions** |

The exposure is real but far more *concentrated* than "sprawl" suggests — which is good news,
because a concentrated problem has a small, auditable fix.

**A method note that matters.** `gcloud run services list` returns **at most 1,000** services and
the truncation is *not* a clean alphabetical prefix — `recordmetric`, `initiatestkpush` and
`webhookintasend` all exist but are absent from the listing while `wfupdaterole` is present. Any
census built on that command is silently incomplete. The numbers below come from paging the Cloud
Run Admin API v2 directly.

---

## 2. Current IAM inventory

### 2.1 Service accounts — all six

| Service account | Purpose | Disabled |
|---|---|---|
| `24799054989-compute@developer` | **Runtime identity for all 1,709 functions** | no |
| `firebase-adminsdk-fbsvc@sokoni-aeb26` | Firebase Admin SDK agent | no |
| `sokoni-aeb26@appspot` | App Engine default — **see §5.2** | no |
| `sokoni-tenant-census-reader@sokoni-aeb26` | Read-only census tooling (`roles/datastore.viewer`) | no |
| `release-b-hosting-deployer@sokoni-aeb26` | Hosting deploys | no |
| `sokoni-hosting-deployer@sokoni-aeb26` | Hosting deploys | no |

`sokoni-tenant-census-reader` is a good model: a purpose-built identity holding exactly one narrow
read role.

### 2.2 Human principals

| Principal | Roles |
|---|---|
| `alexochieng3030@gmail.com` | `roles/owner` |
| `donna@adg.io` | `firebase.developAdmin`, `firebasehosting.admin`, `cloudfunctions.developer`, `errorreporting.viewer`, `logging.viewer`, `monitoring.viewer` |

`donna@adg.io` is already a reasonable least-privilege shape — scoped admin plus read-only
observability. **Not a finding.** Confirm the account is still expected to have access.

### 2.3 Project shape

`gcloud projects describe` returns **no `parent`** — the project sits under no organization or
folder. Therefore **every binding is direct; nothing is inherited**, and no org policy has to be
negotiated to change them.

---

## 3. `roles/editor` exposure matrix

Exactly three members:

| # | Principal | Nature | Verdict |
|---|---|---|---|
| 1 | `24799054989-compute@developer` | Runtime SA for **all 1,709** workloads | **THE finding.** §4–§6 |
| 2 | `24799054989@cloudservices` | Google-managed API service agent; Editor is the **Google default** | **DO NOT TOUCH.** Removing it breaks deployment machinery |
| 3 | `sokoni-aeb26@appspot` | App Engine default SA | **Strong removal candidate.** §5.2 |

### 3.1 The concentration risk

```
1,709 Cloud Run services  (1,707 us-central1 + 2 us-east1)
            │
            └── all run as 24799054989-compute@developer
                        │
                        └── roles/editor  (project-wide)
```

Proven by paging the Admin API: **every one of the 1,709 uses this identity. No exceptions.**

Every function — a public catalogue read, a telemetry sink, a cron — can therefore read and write
every Firestore document, every Storage object, and mint Firebase Auth claims. **A defect in any
one of 1,709 functions is a defect with project-wide blast radius.**

### 3.2 Direct bindings on the runtime SA

| Role | Justified? | Evidence |
|---|---|---|
| `roles/editor` | **NO** | §4 — nothing in source requires it |
| `roles/datastore.importExportAdmin` | **YES** | Nightly Firestore export, observed running |
| `roles/eventarc.eventReceiver` | **YES** | Firestore triggers |
| `roles/run.invoker` | **YES** | Service-to-service invocation |

---

## 4. Workload → required-permission matrix

Derived from source. Counts are files under `functions/` excluding `node_modules`.

| Capability | Files | Evidence | Proposed role |
|---|---|---|---|
| Firestore read/write | **288** | `admin.firestore()` / `getFirestore` | `roles/datastore.user` |
| Firebase Auth | **51** | `admin.auth()` / `getAuth` | `roles/firebaseauth.admin` |
| — custom claims | 11 | `.setCustomUserClaims` | (included above) |
| — **custom tokens** | 2 | `createCustomToken` — `device-engine.js:260` | **`roles/iam.serviceAccountTokenCreator` on itself — see §6.1** |
| Cloud Storage | 8 | `admin.storage().bucket()` — **default bucket** | `roles/storage.objectAdmin`, bucket-scoped |
| FCM / messaging | 9 | `admin.messaging()` | FCM send role — **UNPROVEN, §7** |
| Vertex AI | 1 | `vertexai` / `aiplatform` | `roles/aiplatform.user` |
| Redis | 2 | `ioredis` | **UNPROVEN, §7** |
| Firestore export | 1 | `index.js:10561` `:exportDocuments` | `roles/datastore.importExportAdmin` *(already held)* |
| Secret access | 3 secrets | mounted on the service spec | **already granted per-secret — §6.2** |

### 4.1 The Editor justification test — nothing passes it

Searched for every capability that would genuinely require Editor:

| Capability | Files |
|---|---|
| `@google-cloud/resource-manager` | **0** |
| `compute.googleapis` | **0** |
| `iam.googleapis` | **0** |
| `cloudfunctions.googleapis` | **0** |
| `run.googleapis` | **0** |
| `artifactregistry` | **0** |
| `.createBucket()` / `.deleteBucket()` | **0** |

**No first-party code manages GCP resources.** Editor is unjustified by any observed workload.

### 4.2 Two false positives caught during this audit

Both are recorded because the method failure is reusable, not because the result was interesting.

* **`importDocuments`/`exportDocuments`** matched five files — four were **Typesense**
  (`ts.importDocuments(...)`), not Firestore. Only `index.js:10561` is a genuine Firestore export.
  A permission matrix built on the unverified grep would have over-granted.
* **Bucket names** `albums`, `photos`, `my-bucket`, `another-bucket`, `log-bucket` appeared to be
  in use. They are **`node_modules` sample code**. My own `grep -h` suppressed filenames, which
  silently defeated the `grep -v node_modules` filter. Real first-party usage is
  `admin.storage().bucket()` — the **default** bucket only.

---

## 5. Per-principal analysis

### 5.1 `24799054989-compute@developer` — the runtime SA

Used by 1,709 services. Load-bearing and **must not lose** access to: Firestore, Firebase Auth
(including token signing), default Storage bucket, FCM, Eventarc, Cloud Run invocation, the three
mounted secrets, and Firestore export.

**Observed live activity** (Admin Activity log, 7d):

```
2026-09-18T23:00:08Z  firestore.googleapis.com  FirestoreAdmin.ExportDocuments
2026-09-17T23:00:06Z  firestore.googleapis.com  FirestoreAdmin.ExportDocuments
2026-09-16T23:00:07Z  firestore.googleapis.com  FirestoreAdmin.ExportDocuments
```

The nightly backup (02:00 EAT = 23:00Z) **is running**, as this identity. `datastore.importExportAdmin`
is load-bearing and must be retained.

### 5.2 `sokoni-aeb26@appspot` — Editor, and no evidence of use

| Probe | Result |
|---|---|
| App Engine application exists? | **No** — `gcloud app describe` reports none in the project |
| User-managed keys? | **None** — only 2 `SYSTEM_MANAGED` keys, so it cannot be used off-platform |
| Authenticated activity, 30d? | **None recorded** |
| Referenced in source? | Once — `index.js:10528`, and it is **inside a comment block** documenting one-time setup. The live backup uses the metadata server's default token, i.e. the compute SA |

**Positive control:** the identical query against the compute SA returns the nightly
`ExportDocuments` rows above, so the query mechanism works and the blank result is meaningful.

**Caveat, stated deliberately:** only Admin Activity logging is on for most services, so "no
recorded activity" is not "no activity". It is strong evidence, not proof.

**Verdict: strong candidate for Editor removal**, and the lowest-risk of the three — but it is a
*separate* mutation from the runtime SA and must not be bundled with it.

### 5.3 `24799054989@cloudservices` — leave alone

Google-managed. Editor on this agent is the platform default and is used by deployment and resource
orchestration. **Removing it is a known way to break a project.** Excluded from all proposals.

---

## 6. Dependency and risk analysis

### 6.1 CRITICAL — removing Editor would break `createCustomToken`

`functions/device-engine.js:260` calls `admin.auth().createCustomToken(uid)`.

With no service-account private key present, the Admin SDK signs custom tokens through the IAM
**`signBlob`** API, which requires `iam.serviceAccounts.signBlob` **on the signing identity**.

```
roles/iam.serviceAccountTokenCreator members:
  serviceAccount:firebase-adminsdk-fbsvc@sokoni-aeb26.iam.gserviceaccount.com
  serviceAccount:service-24799054989@gcp-sa-pubsub.iam.gserviceaccount.com
  -- 24799054989-compute@developer is ABSENT --
```

The runtime SA is **not** a token creator. It can sign today **only because `roles/editor` grants
`iam.serviceAccounts.signBlob`.**

> **A naive "remove Editor" silently breaks device token refresh.** The failure would appear at
> runtime, in an auth path, with no deploy to correlate it against.

Mitigation is mandatory and must be applied **before** removal: grant
`roles/iam.serviceAccountTokenCreator` to the runtime SA **on itself**.

### 6.2 De-risked — secrets do NOT depend on Editor

All three mounted secrets already carry an **explicit** per-secret grant:

```
AFRICASTALKING_USERNAME  roles/secretmanager.secretAccessor -> 24799054989-compute@developer
SOKONI_HMAC_KEY          roles/secretmanager.secretAccessor -> 24799054989-compute@developer
AFRICASTALKING_API_KEY   roles/secretmanager.secretAccessor -> 24799054989-compute@developer
```

Secret access survives Editor removal untouched. Checked precisely because a secret-mount failure
would break functions at startup.

### 6.3 Blast radius

| Property | Value |
|---|---|
| Workloads affected by one binding change | **1,709 — all of them, simultaneously** |
| Granularity available | **None.** One SA, one project-level binding |
| Revision required to take effect? | **No.** IAM changes apply to running instances |
| Rollback | Re-add the binding; propagation is seconds-to-minutes |

**The absence of a required revision is significant**: this work is compatible with the Artifact
Registry freeze. It is also the danger — there is no staged rollout, no canary service, no
per-function gate. The change is atomic across the entire platform.

### 6.4 Interaction with the artifact freeze

IAM changes create no revision and touch no artifact, so P0-5 does **not** contaminate the canary
experiment. The contamination tripwire watches builds, function count and revision names — none of
which an IAM binding change moves. **Verified clean after this audit.**

---

## 7. What could NOT be established — stated, not guessed

| Unknown | Why | How to close it |
|---|---|---|
| Exact FCM role | `admin.messaging()` maps to a send permission; the correct predefined role was not confirmed from evidence | Confirm against the FCM permission reference before granting |
| Redis requirement | `ioredis` appears in 2 files; **no Memorystore instance was confirmed to exist** | Determine whether Redis is provisioned or dead code |
| Whether greps missed a capability | Source scanning finds what it is told to look for | See below |
| Google's own least-privilege recommendation | **`recommender.googleapis.com` is DISABLED** | Enable it, then read the IAM recommender |
| Policy Analyzer view | **`cloudasset.googleapis.com` is DISABLED** | Enable if a full analysis is wanted |

> **A disabled API returns a permission-shaped error that reads as absence.** That trap already cost
> this programme once — `billingbudgets.googleapis.com` was disabled and three existing budgets were
> reported as "no budgets". So the two rows above record **"unanswerable"**, *not* "no
> recommendations exist".

**The strongest available evidence is the IAM Recommender**, which derives least-privilege from 90
days of *observed* usage rather than from source reading. Enabling `recommender.googleapis.com` is a
single, reversible, read-only-in-effect API enablement and would materially de-risk §8. **It is
recommended as the next step and was deliberately not performed here.**

---

## 8. Proposed replacement plan — NOT EXECUTED

Ordered so that **every grant precedes every revocation**. At no point does the platform hold fewer
permissions than it needs.

### Stage 1 — additive only. Zero risk; nothing is removed.

```
SA=24799054989-compute@developer.gserviceaccount.com

gcloud projects add-iam-policy-binding sokoni-aeb26 --member="serviceAccount:$SA" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding sokoni-aeb26 --member="serviceAccount:$SA" --role="roles/firebaseauth.admin"
gcloud projects add-iam-policy-binding sokoni-aeb26 --member="serviceAccount:$SA" --role="roles/aiplatform.user"
gcloud projects add-iam-policy-binding sokoni-aeb26 --member="serviceAccount:$SA" --role="roles/logging.logWriter"
gcloud projects add-iam-policy-binding sokoni-aeb26 --member="serviceAccount:$SA" --role="roles/monitoring.metricWriter"

# the signBlob dependency of 6.1 — MANDATORY before any removal
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member="serviceAccount:$SA" --role="roles/iam.serviceAccountTokenCreator"

# storage, bucket-scoped rather than project-wide
gcloud storage buckets add-iam-policy-binding gs://sokoni-aeb26.firebasestorage.app \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"
gcloud storage buckets add-iam-policy-binding gs://sokoni-aeb26-backups \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"
```

Retained unchanged: `datastore.importExportAdmin`, `eventarc.eventReceiver`, `run.invoker`, and the
three per-secret `secretAccessor` grants.

**Still to resolve before Stage 1:** the FCM role and the Redis question from §7.

### Stage 2 — soak. No mutation.

Run at least one **full nightly cycle** so the 02:00 EAT Firestore backup executes under the new
grants while Editor is still present. Watch 5xx rate, auth flows, the backup's `ExportDocuments`
record, and payment paths. Duration should cover every scheduled job's cadence.

### Stage 3 — the single revocation.

```
gcloud projects remove-iam-policy-binding sokoni-aeb26 \
  --member="serviceAccount:24799054989-compute@developer.gserviceaccount.com" \
  --role="roles/editor"
```

**One mutation. Whole-platform blast radius. Immediately reversible.**

### Stage 4 — separately, the appspot SA.

```
gcloud projects remove-iam-policy-binding sokoni-aeb26 \
  --member="serviceAccount:sokoni-aeb26@appspot.gserviceaccount.com" \
  --role="roles/editor"
```

Independent of Stages 1–3 and lower risk (§5.2). **Do not bundle.**

### Never

`24799054989@cloudservices` keeps Editor.

---

## 9. Verification performed after this audit

| Check | Result |
|---|---|
| IAM bindings changed | **none** — 39 before, 39 after |
| `auditConfigs` | unchanged — the P0-7 Artifact Registry entry intact |
| Cloud Run services / revisions | **unchanged** |
| Functions deployed or deleted | **none** — 1,709 |
| Cloud Build | unchanged — `72739a70…` |
| Artifact Registry | unchanged |
| Canary | intact |
| Forensic baseline | **CLEAN** |
| Application code | untouched |

---

## 10. Recommended next mutation

**Not Stage 1.** Enable `recommender.googleapis.com` and read the IAM recommender first.

It is a single reversible API enablement, it creates no revision, and it replaces source-derived
inference with 90 days of observed-usage evidence — closing three of the five unknowns in §7 before
any binding is touched. Given that Stage 3 has whole-platform blast radius and no staged rollout,
buying better evidence first is cheap.
