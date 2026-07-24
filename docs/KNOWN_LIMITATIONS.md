# SOKONI — Known Limitations

**Evidence-backed, intentionally-unresolved items only.** This is not a wishlist
and not a list of everything untested — see [[RELEASE_ACCEPTANCE]] for test
status. An entry belongs here only when we have *evidence* it is a real
limitation and a *reason* it is not yet fixed.

Last updated: 2026-07-24 · commit `7a6749c`

---

## ✅ CLOSED — credential exposure (2026-07-24)

**Resolved.** The key was rotated by the operator and verified independently:
the stored secret no longer matches the leaked value (fingerprint
`86904e7324…` → `c400e8c74aa5`), the new key authenticates against Algolia
(HTTP 200), and all 18 admin-key-bound functions were redeployed and confirmed
bound to **secret version 12 — the newest**. The leaked key is invalid.

*Original record, retained for the post-mortem:*
**The `ALGOLIA_ADMIN_KEY` value was printed into an assistant session transcript
and had to be rotated.**

Cause: `execSync('firebase functions:secrets:access ALGOLIA_ADMIN_KEY')`. The
Firebase CLI printed the secret to stdout and then hit a libuv assertion on
Windows (`UV_HANDLE_CLOSING`) and exited non-zero. Node therefore threw, and the
thrown Error object carries an `output` array containing the captured stdout —
which the runtime printed in full, secret included.

**Done:**
1. ~~Regenerate the Admin API Key~~ ✅
2. ~~`functions:secrets:set ALGOLIA_ADMIN_KEY`~~ ✅ (now v12)
3. ~~Redeploy the admin-key-bound functions~~ ✅ (18/18)

**Verify rotation without printing a secret** — compare the SHA-256 prefix; it
changes when the key changes and reveals nothing:
`node -e "const{getSecret}=require('./scripts/_secret.js');console.log(require('crypto').createHash('sha256').update(getSecret('ALGOLIA_ADMIN_KEY')).digest('hex').slice(0,12))"`

Scope: the Admin API key grants full read/write/delete on every Algolia index
for app `F2XND3V1FW`. It does **not** grant access to Firebase, Firestore, GCP or
any customer data. The search-only key was not exposed.

**Prevented from recurring:** `scripts/_secret.js` now fetches secrets via
`spawnSync` with piped stdio and throws a *scrubbed* error that never carries
captured output. All tooling must use it rather than calling the CLI directly.

## External dependencies (cannot be closed by code alone)

### 0. GDPR data export is BROKEN in production — 🚫 blocks a compliance obligation

**These are TWO separate defects. Fixing one does not fix the other.**

**0a. Execution defect — UNRESOLVED, export does not work.**
Every data export fails. Root cause diagnosed from Cloud Logging
(`processdataexport`, 2026-07-24):

```
Permission 'iam.serviceAccounts.signBlob' denied
```

The worker builds the artifact, then generates a signed download URL — which
requires `signBlob` on its own runtime service account. The runtime SA
`24799054989-compute@developer.gserviceaccount.com` has **no IAM bindings on
itself**, so signing is refused and the job dies at the final step. This is an
IAM misconfiguration, not application logic — the same class as the
`run.invoker` gap closed earlier the same day.

**Verified before recommending the IAM change** (three checks, not assumed):

1. **Runtime identity confirmed** — the *deployed* revision
   `processdataexport-00005-xuv` runs as
   `24799054989-compute@developer.gserviceaccount.com`, not some other SA.
2. **Failing call confirmed** — `file.getSignedUrl({action:'read', expires})`
   at `data-export.js:429`, i.e. the Cloud Storage signed-URL API that requires
   blob signing. The permission in the log matches that call.
3. **Signing is the ONLY blocker — proven empirically.** The upload (`file.save`)
   runs *before* signing, and the artifact was found in the bucket at
   `data-exports/<uid>/<requestId>.json`. So data collection, serialisation and
   the Storage write all succeed; there is no second Storage IAM issue queued
   behind this one. Only URL signing fails.

**Blast radius today:** the bucket contained exactly one artifact — the RC probe's
(since removed). No real user export was found orphaned, which indicates no
production user has exercised this path yet. The defect is real but has not yet
denied a live data-subject request.

**Retention note:** because the artifact is written *before* signing, every
failed export still leaves a JSON file containing that user's personal data in
Storage. Once real users hit this path, failures will accumulate personal data
with no delivery mechanism. Worth a lifecycle/TTL rule on `data-exports/`
independent of the fix above.

Remediation (privileged; must be run by a project admin — an automated attempt
was correctly refused by tooling):

```bash
gcloud iam service-accounts add-iam-policy-binding \
  24799054989-compute@developer.gserviceaccount.com \
  --member="serviceAccount:24799054989-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=sokoni-aeb26
```

Until applied, **no user can obtain their data export**. Verify with
`node tests/rc/rc-runner.js --backend=production --suite=rc-07` — the lifecycle
must reach `ready` with a `downloadUrl`.

**0b. Diagnostic defect — FIXED IN CODE, NOT YET DEPLOYED.**
`processDataExport` recorded only `{status:'failed', failedAt}`; the cause went
to Cloud Logging and nothing reached the document, so the failure was opaque to
both the user and support. Now writes `failureReason` (safe, generic,
user-facing) and `failureCode` (stable, for correlation). **Requires a Cloud
Functions deploy to take effect** — until then production still fails silently.

Closing 0b does **not** close 0a: diagnostics becoming actionable is not the
export working. Both must be verified separately by RC-07.

### 1. IntaSend webhook verification / replay — 🚫 blocks payments
The payment → activation flow cannot be signed off until the webhook
verification update is confirmed and a replay demonstrates the full
payment-received → order/subscription-activated path. Untouched this cycle; no
evidence it currently works end-to-end.
**Owner:** Payments. **Unblocks:** Orders (inventory deduction), subscriptions.

### 2. Algolia production credentials — ✅ RESOLVED 2026-07-24
Both keys were being rejected with `Invalid Application-ID or API key`. Root
cause was **not** the keys: they belonged to Algolia app **`F2XND3V1FW`**, while
the platform was configured for `FF2WSTR4YC` (which is a real, reachable app —
`/1/isalive` → 200 — hence the misleading error).

Fixed: `ALGOLIA_APP_ID` updated in 8 places (`functions/.env`, `sokoni-config.js`,
`conversion-analytics.js`, `system-health.js`, 3 scripts). Indexes created
(8, with settings/synonyms/rules) and backfilled (**129 records**). Verified with
the search-only key: `sokoni_products` 129 hits, `"cool mint"` 3, `"vape"` 20.

---

## Deployment gaps

### 3. Healthcare hub — ✅ RESOLVED 2026-07-24
The 15 `functions/healthcare-hub.js` callables are now wired into
`functions/index.js` and **deployed** (verified live, HTTP 401 = App-Check-gated).
The client booking path (`sokoni-health.js::saveAppointment`) routes through the
`bookAppointment` CF; teleconsult/lab bookings go to their own owner-writable
collections. Two appointment indexes deployed.
**Residual — ✅ CLEARED 2026-07-24:** an approved provider is now seeded.
`healthProviders/seed-provider-general-001` (Dr. Amina Wanjiru ·
general_practice · KES 1500 · Nairobi · `status:'active'`, `isSeed:true`),
created by `node scripts/seed-health-provider.js --apply` and verified by query
(1 active bookable provider returned). The appointment flow now has everything
it needs to be exercised end to end.
Remove the seed before public launch: it is tagged `isSeed:true` for exactly
that purpose.

### 4. Property/BnB listing activation — ✅ RESOLVED 2026-07-24
Decision: **auto-activate on create.** `property-hub.html` now writes
`status:'active'`, so a new listing is visible to buyers immediately. If
moderation is wanted later, the create site is commented to show where a
`pending` status + approval transition would re-enter. (BnB was never affected —
`bnbListings` reads are public.)

---

## Runtime validation outstanding (no evidence yet, not known-broken)

These are **pending**, not **broken** — listed so the distinction stays honest.

- Mobile: iPhone Safari, Android Chrome, PWA install/update — device-dependent,
  not yet run.
- Full lifecycle end-to-end (product/shop/order/review) needs authenticated
  seller + buyer sessions; verified statically only (see
  [[RELEASE_ACCEPTANCE]] Pass 2).
- Search end-to-end latency after the final `2026-07-24` change is **reasoned,
  not measured** — repeated automated runs tripped App Check throttling on the
  dev machine (403, 24h). Local matching alone measures ~1ms; the network-saving
  claim awaits an unthrottled client.

---

## Maintenance hazards (safe today, worth cleaning)

- **Duplicate `propertyListings` rule blocks** in `firestore.rules` (~L4101 and
  ~L4886) that disagree on accepted statuses. Firestore unions `allow`, so it is
  permissive-safe, but the two should be consolidated before they drift further.
- **`sokoni-orders.js::createOrder`** writes `escrow` at create time and would be
  denied by the `clientOrderInit` rule. Dead on the client (checkout uses
  `transitionOrder`); now carries a prominent ⚠️ do-not-reuse banner so it is not
  wired into checkout by mistake.
- **Products carry no `createdAt`** (only `uploadedAt`). Harmless now — display
  sorts client-side — but any future `orderBy('createdAt')` on `products` would
  silently return nothing.

- **Appointment idempotency is coupled to client behaviour.** `bookAppointment`
  uses the client-generated appointment id as its idempotency key. The guarantee
  "a retry books once" therefore holds only while every *new* booking attempt
  generates a *fresh* id. The current UI does (`_apptId` resets on modal
  open/close), so the edge case is unreachable today: reusing a key after
  cancelling would return the **cancelled** appointment instead of booking a new
  one. This is a contract worth making server-side (e.g. scope the idempotency
  record by status, or expire it on cancel) **before** a second client — mobile
  app, partner API, retry middleware — starts driving bookings.
