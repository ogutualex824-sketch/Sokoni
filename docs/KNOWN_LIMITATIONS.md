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

### 0. ✅ CLOSED — GDPR data export (both defects verified fixed, 2026-07-24)

**Both defects were verified SEPARATELY by RC-07, in that order, so neither fix
could mask the other.**

| Phase | Change | RC-07 evidence | Verdict |
|---|---|---|---|
| 1 — observability | deploy `failureReason`/`failureCode` (rev `processdataexport-00006-rel`), IAM untouched | `pending → failed`, `failureCode=permission_denied`, generic reason present | still **FAIL** — availability unchanged, as required |
| 2 — availability | grant `roles/iam.serviceAccountTokenCreator` on the runtime SA to itself | `pending → ready`, `downloadUrl` + `expiresAt` present | **0 FAIL** |

Phase 1 deliberately proved the export *still failed* while diagnostics worked —
had it succeeded there, the diagnosis would have been wrong and the sequence was
built to catch that.

`failureCode=permission_denied` independently corroborated the `signBlob`
diagnosis taken from Cloud Logging, from a second source.

Residual scope: the **callable entry** `requestDataExport` remains uncertified —
it is `enforceAppCheck:true` and cannot be invoked from headless Chromium, so
RC-07 reports it BLOCKED. The worker path, artifact, and status lifecycle are
certified. Closing this entry does not claim the client-facing entry point was
exercised.

*Original record, retained for the post-mortem:*

**0a. Execution defect — was: export does not work.**
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

**Retention note — now tracked separately as item 0c below.**

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
export working. Both were verified separately by RC-07 (table above).

---

### 0c. `data-exports/` has no retention policy — ⏳ OPEN, compliance follow-up

**Not implemented — logged as a follow-up task, deliberately separate from
restoring export functionality (item 0 above, now closed).**

Exports write `data-exports/<uid>/<requestId>.json`, containing that user's
personal data, and the upload happens **before** the signed URL is generated.
So both *successful* and *failed* exports leave personal data in Storage
indefinitely. Nothing currently deletes it:

- `expiresAt` on the request document governs the **download link**, not the
  **object** — the file outlives the link.
- The RC harness's `backend.cleanup()` covers **Firestore only**; Storage
  objects must be removed separately (done manually after each RC-07 run).

Today this is zero-risk — the bucket is empty and no production user has
exercised the path. It becomes a genuine data-minimisation problem the moment
real users request exports.

**Proposed:** a bucket lifecycle rule deleting `data-exports/` objects after the
export TTL (age-based, e.g. matching `EXPORT_TTL_MS`), so retention is enforced
by infrastructure rather than depending on application cleanup paths that only
run on the happy path.

### 0e. Logged-out visitors are shown a MOCK catalogue, not real listings — 🚫 P0

**Anonymous visitors do not see any real merchant product.** The public home
feed renders hardcoded demo data while the 129 real products stay invisible.

Evidence:

| Check | Result |
|---|---|
| Real products in Firestore | **129** |
| Products shown to an anonymous visitor | 91 priced items — site looks healthy |
| `Infinix Hot 40i` (shown publicly) | **NOT IN FIRESTORE** |
| `Vitenge Flare Dress` (shown publicly) | **NOT IN FIRESTORE** |
| `Shea Butter Moisturiser 500ml` (shown publicly) | **NOT IN FIRESTORE** |
| Source of those names | hardcoded in `sokoni-mock-data.js`, `script.js`, `category.js` |
| Real product names (e.g. `PEACH MANGO ICE`) | never rendered anonymously |

**⚠️ CORRECTION — the cause first recorded here was WRONG.** This was initially
attributed to anonymous `products` reads being denied by deployed rules. That
attribution came from headless automation and does **not** hold: in a **headed**
browser the anonymous read **succeeds** (`exists: true`), and `permission-denied`
appears only under headless, i.e. it is an **App Check artifact of automation**,
not a rules divergence. See the correction note under 0d.

**ROOT CAUSE — instrumented, in a headed production session:**

```
@firebase/app-check: Requests throttled due to 403 error.
                     Attempts allowed again after 01d:00m:00s
[SOKONI] Security verification failed. Please refresh and try again.
[RT] products: Missing or insufficient permissions.
__sokoniAppCheckReady -> resolved: "rejected"
```

**App Check fails with 403 for real browsers on production, then throttles that
client for 24 hours.** Firestore reads are denied *downstream of that*, the
catalogue listener never delivers, and the demo fallback is never replaced.

**It is intermittent, which is why earlier readings disagreed.** Both states were
observed on production in headed sessions:
- App Check **succeeds** → anonymous `products` read returns `exists: true`,
  product pages load normally.
- App Check **403 / throttled** → reads denied, storefront shows demo data.

That intermittency is exactly what produced the contradictory evidence and the
withdrawn rules theory. Firestore rules are **not** implicated: when App Check
holds a token, the identical anonymous read succeeds.

**Pipeline confirmed by instrumentation, not inference:**
`sokoni-db.js` → HTTP 200 and imports cleanly on demand · `_homeMergeFirestore`
is defined and ready · but `window.SokoniDB` stays undefined and the
`sokoni:catalogue` `appcheck-ready` event **never fires**, because the block
awaits `__sokoniAppCheckReady`, which resolves **"rejected"**.

**CONFIGURATION READ FROM THE LIVE PROJECT (App Check REST API):**

| Service | Enforcement |
|---|---|
| **firestore.googleapis.com** | **ENFORCED** |
| firebasestorage.googleapis.com | ENFORCED |
| identitytoolkit · dataconnect · ml · maps-backend | UNENFORCED |

reCAPTCHA v3 config for the web app:
`siteSecretSet: true` · `tokenTtl: 86400s` · **`minValidScore: 0.5`**

**This explains the mechanism and the intermittency.** reCAPTCHA v3 does not
pass/fail — it scores each visitor 0.0–1.0 for how human they look. With
`minValidScore: 0.5`, **any visitor scoring below 0.5 is refused an App Check
token**, and because Firestore is *enforced*, that visitor loses the entire
catalogue and sees demo data. The 86400s TTL matches the observed 24-hour
throttle, so one bad score locks a user out for a day.

What the configuration establishes: **it CAN systematically reject some
legitimate sessions.** Scores are depressed by conditions this audience plausibly
uses — carrier-grade NAT and shared mobile IPs, privacy browsers, ad-blockers,
VPNs, older devices, first-time visitors with no reCAPTCHA history — so
rejections are expected to be *non-random*, concentrated on particular client
profiles rather than scattered.

It does **NOT** establish how many users are affected. "Some legitimate sessions
are rejected" follows from the configuration; "a large fraction of users are
affected" would need production measurement and is **not claimed here**.

Also ruled out: site-key/domain registration is fine (`siteSecretSet: true`, and
tokens DO succeed in some sessions), so this is a threshold/enforcement
trade-off, not a broken provider setup.

**Still unmeasured — this is what decides severity:** token issuance rate,
rejected-request count, and the rejection distribution by browser/device/origin.
That needs the App Check metrics dashboard; the REST API used here does not
expose it. Severity should not be assigned until those numbers are read.

**Mitigations are a security decision, not taken here.** The usual levers are
lowering `minValidScore`, or setting Firestore to UNENFORCED/monitor while the
score distribution is measured — both weaken an anti-abuse control and belong
with whoever owns that trade-off.

It is the *fallback* that makes this severe regardless of cause — the page looks
fully populated, so a catalogue failure produces no visible symptom.

**Impact:**
- Every merchant's listing is invisible to logged-out visitors — no acquisition
  path reaches a real product.
- Visitors browse and can tap **fabricated products with prices**. Showing
  invented listings to consumers is a trust and consumer-protection concern
  independent of the technical fault.
- It explains why 0d went unnoticed: the storefront never *looked* broken.

**Not fixed here.** The correct remedy is the same policy reconciliation as 0d
(anonymous `products` read), which is a security-review decision. A second,
separate question for that review: whether a demo fallback should ever engage in
production at all, given it converts an outage into silently fake content.

### 0d. ❌ WITHDRAWN — "uncached product pages fail" does NOT reproduce

**This entry was wrong and is retained only so the correction is on the record.**

Originally filed as a conversion-impacting bug: opening a product by URL showed
"Product Not Found" for a live product, attributed to anonymous
`products/{id}` reads being denied by deployed rules.

**Re-tested properly and it does not hold.** In a **headed** browser, sampling
the page over 15s, the product page loads correctly: `notFound: false`, gallery
present from 6s, and a manual read in the same session returns `exists: true`.

**Where the error came from.** The first "headed" check reported a single
observation at a fixed instant and agreed with the headless run, so the artifact
looked like a reproduction. Time-sampling shows the page simply had not finished
loading. `permission-denied` appears **only under headless automation** — App
Check rejects it — so it was never evidence about rules.

| Original hypothesis | Corrected verdict |
|---|---|
| Rules deny anonymous reads | ❌ **wrong** — headed read succeeds |
| App Check / automation artifact | ✅ **this was the actual cause** |

**Consequences for other records:** the "deployed rules deny anonymous
`products` reads" claim — repeated in RC-09 and used to argue a repo-vs-production
rules divergence — is **unsupported**. There is no evidence of rules drift. The
security-review question framed around reconciling rules should be treated as
withdrawn unless independently re-established.

*Original entry follows, retained for the post-mortem:*

**Symptom:** opening a product by URL showed "Product Not Found" for a product
that exists and is `status: active`.

**Claimed root cause (SINCE DISPROVEN):** the anonymous client read of
`products/{id}` returns `permission-denied`:

| Hypothesis | Result as recorded at the time |
|---|---|
| Headless/automation artifact | ✗ believed ruled out — **this was the mistake** |
| App Check blocking the request | ✗ believed ruled out (App Check returned 200) |
| Product genuinely missing | ✗ correctly ruled out — exists, `status: active` |
| Firestore rules denying the read | ✅ claimed — **not supported** |

**Blast radius — precise, not assumed:**
- ✅ Tapping a product **from the feed works**: `openProduct` seeds
  `localStorage.selectedProduct`, so the synchronous path resolves and Firestore
  is never consulted.
- 🚫 Any **uncached arrival fails**: shared links, refresh, SEO/direct traffic,
  search results, recommendations, category deep-links — for logged-out users.

The Firestore fallback in `product.js` exists precisely to serve those arrivals;
deployed rules block it. This is the same divergence recorded in RC-09: deployed
rules deny anonymous `products` reads while the checked-out `firestore.rules`
says `allow read: if true`. **This finding is evidence about which side is
intended** — the repo file would restore these journeys — but deploying rules is
a security change and is deliberately left to a reviewed decision, not made here.

**Fixed in code (not the cause):** `product.js` swallowed the error
(`catch(e){ /* fall through to Not Found */ }`), presenting a permissions failure
as a missing product. It now distinguishes the two, logs the real code, and shows
"We couldn't load this product" with a browse action instead of blaming the
catalogue. That improves the message only — **the journey stays broken until the
rules divergence is resolved.**

### 1b. Typesense cluster does not exist — ⚠️ redundancy gap, NOT a launch blocker
The configured cluster hostname **does not resolve**:
`4kn6y5bfcxv8o702p-1.a2.typesense.net` → `ENOTFOUND`.

Evidence (layered, stopped at the failing layer):
- Secret Manager holds `TYPESENSE_ADMIN_KEY` (v5) and `TYPESENSE_SEARCH_KEY` (v6).
  There is no `TYPESENSE_HOST` secret — the host lives in `functions/.env` as
  `TYPESENSE_NODES`, which is correct (a hostname is not sensitive).
- DNS control test: `typesense.org`, `cloud.typesense.org`, the Algolia host and
  `google.com` all resolve; **only** the configured cluster fails.
- Confirmed **from inside the deployed function** (Google's network, not a dev
  machine): `searchHealth` reports `DNS_FAILURE`,
  `getaddrinfo ENOTFOUND 4kn6y5bfcxv8o702p-1.a2.typesense.net`.
- Only other hostname in the repo is `xyz.a1.typesense.net`, a docs placeholder.

Layers 5–8 (auth, collections, expected-vs-actual, sync pipeline) were **not**
tested: all are downstream of a host that does not exist, so results would be
meaningless. The API keys may be perfectly valid — they simply have no cluster.

**Root cause:** the Typesense Cloud cluster was deleted, expired, or never
provisioned. **This is provisioning, not code** — the integration reads its host
from configuration correctly.

**Minimal corrective action:** check the Typesense Cloud dashboard. If a live
cluster exists, its hostname differs — update `TYPESENSE_NODES` and redeploy,
then re-verify auth/collections (the keys may also belong to the dead cluster).
If none exists, provision one or decide to drop Typesense.

**Not a launch blocker:** Algolia serves search and the Firestore local-first
path covers outages. Typesense is a secondary backend; nothing customer-facing
depends on it today.

### 1. IntaSend webhook verification / replay — 🚫 blocks payments
The payment → activation flow cannot be signed off until the webhook
verification update is confirmed and a replay demonstrates the full
payment-received → order/subscription-activated path. Untouched this cycle; no
evidence it currently works end-to-end.
**Owner:** Payments. **Unblocks:** Orders (inventory deduction), subscriptions.

**Agreed approach — map the deployed system BEFORE testing its behaviour.**
Each phase must produce its artifact before the next begins, so every phase
rests on evidence rather than on reading the repository:

| Phase | Question | Artifact |
|---|---|---|
| 1 · Deployment | Which webhook URL is IntaSend *configured* to call, and which runtime endpoint receives it? | a verified webhook endpoint |
| 2 · Reachability | Which candidate handlers are actually deployed and reachable? | a runtime map of deployed entry points |
| 3 · Topology | How does the live callback flow through modules to produce business effects? | a documented execution path |
| 4 · Certification | Sequence, cause, outcome, idempotency, failure shape | RC results tied to that documented path |

Phases 1–2 are **deployment questions, not code questions.** A perfectly
implemented endpoint that the provider is not configured to call must never
become the subject of certification — and `healthcare-hub.js` (fully written,
never exported, therefore unreachable) is the precedent for why reachability is
checked separately from existence.

Known starting facts (established 2026-07-24, no payments work performed):
- `paymentRef` appears to be the canonical correlating identifier.
- Supporting modules exist: `payment-reconciliation.js`, `payment-adapters.js`,
  `payment-trust.js`, `payment-state-machine.js`.
- IntaSend-related logic appears in **six** files (`financial-os.js`, `finos.js`,
  `finos-admin.js`, `finos-automation.js`, `finos-utils.js`, `impact.js`).
  **This is a topology unknown, not a duplication finding** — those may be a
  layered pipeline (terminate / verify / orchestrate / persist / admin / shared)
  rather than competing implementations. Phase 3 decides which.

**Certification design (differs from search):** search had an internally
scheduled window, so "wait past the documented interval" worked. Payments crosses
an external boundary, so correlate immutable identifiers instead of waiting a
fixed duration, and treat **`UNRESOLVED`** as a first-class outcome — a timeout
must trigger reconciliation, never a PASS/FAIL guess. Idempotency must certify
BOTH replay safety (same operation twice → one effect) and intent separation
(distinct operations on one entity → each effect exactly once); see the
entity-scoped key list under Maintenance hazards.

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

## Security — output encoding is not enforced anywhere

### XSS sink audit (2026-07-24) — 1 fixed, inventory open

A stored XSS was found and fixed in `wishlist.html` (product name, category and
image URL interpolated raw into the saved-items card). Auditing outward from it
found the same shape widely, and — more importantly — **no mechanism enforcing
output encoding at all**. The rule is a platform standard; nothing checks it.
The wishlist hole survived for exactly that reason, while `cart.js`, rendering
the *same product objects*, escaped correctly.

**Inventory** — `npm run scan:xss` (`scripts/scan-xss-sinks.js`):

| Bucket | Count | Meaning |
|---|---|---|
| CONFIRMED | **208** | bare `${obj.field}` into an HTML sink, in a file with **no escape helper at all** |
| REVIEW | **156** | same, but the file escapes elsewhere — could be oversight or safe by construction |

Spot-verified as genuine: `unboxing.html:449` renders `${r.comment}` — a
user-written review — straight into HTML.

**These are sinks, not proven vulnerabilities.** Static analysis cannot tell
whether a value is user-controlled, already encoded upstream, or on a reachable
path. Confirm before claiming any individual one.

**Scanner design notes** (it took three passes to become trustworthy):
its first version reported **1011** findings — counting `${esc(x)}`,
`${JSON.stringify(x)}` and internal constants like `${role.label}`. It now flags
only a **bare property access** whose field name is user free text, excludes
`label`/`desc` (internal enum text in this codebase), and skips scratch dirs.
Validated against ground truth: `wishlist.html`, `cart.js` and `checkout.html`
— all known-clean — report **0**.

**Context matters, and the tool reports it** — the same value needs different
handling per sink:
- `js-handler` (`onclick="…${x}…"`) — HTML-escaping is **not** sufficient; pass
  an index/id and look the value up in JS (see `shareWish()` in wishlist.html).
- `url-attr` (`src`/`href`) — needs scheme validation; `javascript:`/`data:`
  survive HTML-escaping.
- `attr` / `text` — quote-aware HTML escaping.

**The structural fix, not yet done:** five different helper names are in use
(`_esc`, `esc`, `_h`, `escapeHtml`, `escapeHTML`) and no shared abstraction, so
there is nothing obvious to reach for. A single exported helper plus
`scan:xss` in `predeploy` would make new raw interpolations hard to add and
trivial to detect. Until then this depends on manual discipline, which is what
already failed once.

**Also fixed:** `wishlist.js` carried the identical unescaped template. It is
**dead code** — no page loads it; it survives only in the service-worker
precache — so it was not exploitable, but it was a landmine for anyone wiring it
up. Escaped rather than deleted (another process writes this repo).

## Architectural — two definitions of an indexed document

### Backfill and live indexing produce different records
**Evidence (2026-07-24, both observed in production `sokoni_services`):**

| Path | Record produced |
|---|---|
| Live trigger → `algolia-indexer.js` `TRANSFORMERS.services` | **28 fields** — `name, nameLower, description, category, subcategory, price, priceMax, priceType, currency, duration, images, thumbnail, tags, provider, rating, reviewCount, viewCount, orderCount, availability, remote, isFeatured, featuredLevel, location, hub, status, createdAt, updatedAt, _popularityScore` (derives `nameLower`, builds a `provider` sub-object) |
| `functions/scripts/algolia-backfill.js` `transformDoc` | **6 fields** — `name, county, providerId, isActive, indexedAt, objectID` |

The backfill script carries its **own, separate** transformation implementation
rather than reusing the 13 transformers in `algolia-indexer.js`.

**Consequence:** a document recovered by backfill is *present but less
discoverable* than the same document indexed through the live pipeline. This is
the concrete root cause of the `"clinic"` relevance gap — the seeded
`healthProviders` record has `clinic` and `specialization` in Firestore, and
neither field exists in its indexed record, so no query can match them.

**Blast radius:** the 132 records recovered by the 2026-07-24 backfill are all
thin. It self-heals for any document that is subsequently written (the trigger
upgrades it to the full schema) but **never** for documents that are never
edited again.

**Acceptance criterion for the fix:**
> Running a backfill over an unchanged dataset must produce the same indexed
> representation as if every document had been reprocessed through the live
> pipeline.

Deliberately **not** fixed during the sync-certification run, to keep evidence
gathering separate from design change.

**Wider pattern worth carrying:** *runtime path ≠ recovery path*, in the same
family as *happy path ≠ degraded path*. Each pair looks equivalent at the
architecture level and diverged in practice; only runtime inspection surfaced it.

**Partial progress (2026-07-24, variants):** the variant attributes were added
to *both* paths from a **single shared normaliser** —
`functions/search-terms.js::variantAttributes`, imported by the live transformer
and by `algolia-backfill.js`. So variants specifically cannot diverge. The
underlying 6-vs-28-field gap on every *other* field is unchanged and this item
stays open; the fix is to make the backfill call the 13 transformers rather than
carry its own `transformDoc`.

### ✅ FIXED — one oversized product was blocking Algolia indexing for every product batched with it (2026-07-24)

**Fix deployed:** `functions/algolia-sanitize.js` (new, shared by the live queue
path *and* the backfill) + `_flushIsolating` in `algolia-queue.js`.
`processAlgoliaQueue` redeployed. Regression test:
`npm run test:algolia-isolation` — 14 checks, including a stub that reproduces
Algolia's real all-or-nothing batch rejection.

Three defences, in order:
1. **Sanitise before batching** — base64 `data:` URIs are stripped from every
   image field; the poison record measures **400,658 → 602 bytes** and still
   indexes, so search keeps the product instead of losing it.
2. **Isolate, never cascade** — a rejected batch is retried one record at a
   time, so only a genuine offender is marked failed. An irreducible record is
   held out *before* the batch is sent.
3. **Actionable diagnostics** — every isolation logs the `objectID`, the
   collection/docId and the measured size against the limit.

**Recovery performed:** 153 queue entries that had been driven to `dlq` status
by the poison record were reset to `pending` with `attempts: 0` so the fixed
drain could reprocess them. (`algoliaQueueDLQ` also holds 279 archived copies;
they are a record of the incident, not a second backlog.)

**Still open, separate:** the product itself
(`products/1784487444890`, "PEACH MANGO ICE") still stores a 195KB base64 image
in Firestore. It now indexes safely with its image stripped, but it has an
`imageStorageUrls` field holding a real URL — the transformer could prefer that
so the product keeps a picture in search results. See the save-time safeguard
below.

**Save-time safeguard — ⚠️ RECOMMENDED, not implemented.** `seller-wiring.js`
persists product images as base64 data URIs. Rejecting or normalising them at
the point of save would stop oversized documents entering any downstream system,
rather than defending against them at every consumer. Must be done carefully:
existing products depend on the current behaviour for rendering.

*Original diagnosis retained below for the record.*

### One oversized product is blocking Algolia indexing for every product batched with it — HISTORICAL

**Found 2026-07-24** while running the variant acceptance probe. Not caused by
the variant work; the probe merely surfaced it.

`products/1784487444890` ("PEACH MANGO ICE") stores a **base64 data URI** as its
image:

| Field | Size |
|---|---|
| `images` | 195,425 bytes |
| `image` | 195,397 bytes |
| *whole document* | 397,980 bytes |

The live transformer passes that straight through, producing a **195,884-byte**
Algolia record against a **10,000-byte** limit. **Algolia rejects the entire
batch when one record is oversized**, so every product queued in the same batch
fails with it:

```
gs__products | upsert | failed | products_VP99 …
ERR: Record at the position 4 objectID=products_1784487444890 is too big
     size=195884/10000 bytes
```

**26+ consecutive failed queue entries** were observed in one 30-entry window
(`VP*`, `TC*`, `SP*`, `S*`, `P*`) — all reporting the *same* poison record.
Deletes drain normally (`status=done`), so the queue and drain are healthy; only
batched upserts are poisoned.

**Consequence:** new and edited products are **not reaching `gs__products`**.
This is why the variant end-to-end probe could not observe its record in Algolia
within 7 minutes — twice.

**This is the `runtime path ≠ recovery path` pattern again.** `algolia-backfill.js`
already carries **both** defences from earlier work — `safeImageUrl()` (rejects
base64 data URIs) and `enforceSize()` (9,000-byte guard). The **live queue path
has neither**. The recovery path was hardened; the runtime path was not.

**Fix (not yet applied — needs a decision):**
1. Port `safeImageUrl()` + `enforceSize()` into the live path (`algolia-queue.js`
   before batching, or the transformer itself).
2. Skip and record an oversized record instead of failing its whole batch — one
   bad document must not be able to stall indexing for everything around it.
3. Repair `products/1784487444890` (move the base64 image to Storage; it already
   has an `imageStorageUrls` field).
4. Re-drain the failed queue entries.

**Acceptance test:** with a deliberately oversized document present in a batch,
every *other* document in that batch must still index.

### Live Algolia index settings have drifted from the repo — ⚠️ OPEN
**Evidence (2026-07-24, read from the live `sokoni_products` index):**

| | Live index | `functions/algolia-admin.js` |
|---|---|---|
| `searchableAttributes` | 7 | 15 |
| `attributesForFaceting` | 7 | 26 |

`algoliaSetupIndexes` is an admin-only `onCall`, so a settings change committed
to the repo stays **inert** until someone with an admin claim invokes it — and
evidently that has not happened for several changes.

The variant work pushed its six searchable attributes and six facets
**additively** onto the live values (7 → 13 each, verified by re-reading the
index), deliberately *not* pushing the file wholesale: re-aligning relevance and
filtering for eight unrelated attributes is its own decision needing its own
relevance testing, not a side effect of a variant change.

**To close:** decide whether the repo or the live index is authoritative, then
either invoke `algoliaSetupIndexes` from an admin session or correct the file.
`node scripts/push-variant-index-settings.js` (no flag) prints the live-vs-repo
diff without writing.

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
