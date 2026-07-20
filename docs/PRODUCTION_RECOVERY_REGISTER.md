# SOKONI — Production Recovery Register

**Living blocker register.** One row per blocker, from discovery to closure. Every
status is backed by runtime evidence, deployed-config reads, or verified code —
never assumption. Update in place; do not re-open a CLOSED item without
contradictory runtime evidence.

Last updated: 2026-07-21. Related: [[APP_CHECK]] · [[DEFECT_REGISTER]]

---

## Status legend

| Status | Meaning |
|---|---|
| ✅ RESOLVED | Root-caused, fixed, verified with evidence |
| 🟡 FIXED–UNVERIFIED | Fix committed; awaits production/device confirmation |
| ⛔ BLOCKED–EXTERNAL | Cause is infrastructure/IAM, not code; needs an owner action |
| 🔎 OPEN | Under investigation |

---

## P0 — Homepage catalogue (anonymous first paint)

**Status: 🟡 FIXED–UNVERIFIED** · Owner: catalogue (script.js/firebase.js) · Commit `416e99a`

- **Root cause (proven):** Firestore App Check is ENFORCED. `firebase.js` requested
  the App Check token fire-and-forget and created `db` synchronously, so the home
  catalogue listener attached while the token was still pending. A runtime probe
  showed the Firestore Listen channel requests were **cancelled**, no
  permission-denied reached the app, and the listener sat on empty cached
  snapshots — demo data was never replaced. Token observed `pending` at 15s,
  `exchanged` at 18s: the race was lost on first paint.
- **Runtime evidence:** App Check `services/verdict_count` over 24h —
  **6938 VALID|ALLOW vs 1208 DENY (85% allowed)**. Deployed ruleset `2f03266b` is
  byte-identical to repo; `products` is `allow read: if true`. So the server side
  is readable; the fault was a client-side attach race, not denial.
- **Fix:** `firebase.js` exposes the SDK's own token promise as
  `window.__sokoniAppCheckReady`; the home listener awaits it before
  `listenProducts`. Bounded to 12s so a stuck exchange degrades to a normal read,
  not a blank grid. App Check NOT weakened.
- **Verification owed:** load `mysokoni.co.ke/catalogue-doctor` on a real device →
  must show real merchant product names (not demo). See P5.
- **Regression:** demo fallback retained (`433fb6f`) so a failed/slow read shows
  placeholders, never an empty store.

## P1 — Service worker lifecycle

**Status: 🔎 OPEN (owned by concurrent session)** · Owner: sw-register.js / service-worker.js

- Pages are served **network-first** (`service-worker.js:697 networkFirstPage`), so
  an online reload fetches fresh HTML — code fixes propagate without a version bump.
- App Check metrics show **683 MISSING_OUTDATED_CLIENT/day**: a real population on
  stale precached bundles (`/pos-setup` and others are in PRECACHE, line 187).
  This is the most likely vector for users still seeing old/broken pages.
- `sw-register.js` is under active edit by the concurrent session. **Not touched
  here** to avoid collision. Owner to confirm update flow (controllerchange /
  Project Evergreen) does not interrupt marketplace startup.

## P2 — POS onboarding

**Status: partially ✅ / one ⛔ EXTERNAL** · Owner: pos-setup.html + IAM

| Sub-step | Status | Evidence |
|---|---|---|
| Phone → OTP → auth | ✅ RESOLVED `7fc7748` | Malformed `<script>` swallowed `_skWhy` (undefined) → blank step 4 on error; OTP spinner never dismissed. Both fixed; harness: `typeof _skWhy==='function'`, spinner clears, advances to step 4. |
| Business lookup (step 4) | ✅ RESOLVED `af3aad8` | `smartPosDispatch` probe → **HTTP 401 UNAUTHENTICATED** (function ran, invokable). Added cold-start loading message so the wait is never unexplained. |
| Legacy business fallback | ⛔ EXTERNAL | `getBusinessConfig` → **403 Forbidden** (run.invoker missing). Degrades to Create Business inside `Promise.allSettled`, so not fatal. |
| Device provisioning (step 6) | ⛔ BLOCKED–EXTERNAL | `bootstrapDevice` → **403 Forbidden** (run.invoker missing). End users lack `roles/run.invoker`, so provisioning cannot complete. **This blocks POS setup end-to-end.** Fix is IAM, not code. |

## P3 — Marketplace authority (catalogue convergence)

**Status: 🔎 OPEN — gated on P0 verification** · Owner: catalogue

- Audit found **9 retrieval surfaces with 6 incompatible visibility filters**
  (`status=='active'` vs `active!=false` vs none) and 3 storefront key schemes
  (`shopId` / `sellerUid` / `sellerName`). Convergence must NOT start until P0 is
  verified green on a device — converging readers onto a read path that is itself
  unproven would bake in the wrong contract.
- Touches script.js / realtime.js / sokoni-db.js — the concurrent session's files.
  Sequence after P0 closes; coordinate ownership first.

## P4 — Featured Shops

**Status: 🟡 INFRA BUILT–UNDEPLOYED** · Owner: admin-os.js + rules/indexes · Commit `9a408c9`

- **Backend infrastructure done** (server-authoritative). New secrets-free
  `featuredShops/{merchantUid}` collection; admin ops `adminSetFeaturedShop` /
  `adminListFeaturedShops` registered in `admin-os.js._h` (no new function — rides
  the invokable `adminOsDispatch`). Public read only while actively featured
  (rules-enforced expiry); admin-only write.
- **Why not shopSettings:** it holds live Daraja secrets and is owner-only; users/
  is PII/self-only. The projection copies a strict display allow-list — verified
  15/15 that zero secret/PII fields reach the public doc. Rules COMPILE against the
  live Rules API.
- **Not yet consumed:** the reader (`sokoni-spotlight.js`, currently querying the
  broken `shopSettings.featuredOnHome`) is untouched by design — catalogue
  convergence (P3) will repoint it at `featuredShops`.
- **Migration:** deploy rules + indexes + functions, then once —
  `adminOsDispatch({op:'adminSetFeaturedShop', merchantUid:'<KASS uid>', priority:100, reason:'Pilot'})`.
  KASS goes through this identical path; never hardcoded.

## P5 — Observability

**Status: 🟡 IN PROGRESS** · Owner: shared

- Catalogue lifecycle instrumented (`ee63f42`); swallowed Firestore error now
  surfaced (`dd96c50`); `sokoni:catalogue` CustomEvents emitted at each phase.
- `catalogue-doctor.html` (`31864ab`): on-device proof — App Check token, reads via
  `getDocsFromServer` (no cache masking), latency, error code, real product names.
- Remaining: same no-silent-failure treatment for payments and search paths.

## P6 — Deployment gate

**Status: ✅ RESOLVED** · Owner: scripts/predeploy-syntax-gate.js · Commit `e05bf2d`

- Syntax gate runs inside Firebase predeploy hooks (hosting + functions); a deploy
  after a failed parse is structurally impossible. Confirmed present.

---

## EXTERNAL action required (IAM) — not fixable in code

Three deployed Firebase **callables reject at Cloud Run before the function runs**
because `roles/run.invoker` is not granted to `allUsers`. Firebase HTTPS callables
are designed to be publicly invokable at the transport layer and enforce auth
*inside* the function (these return `UNAUTHENTICATED` when reached) — so granting
`allUsers` invoker is the standard, non-weakening configuration. The other
callables (`smartPosDispatch`, `servicesDispatch`, `generatePOSPaymentQR`, …)
already have it.

| Function | Impact | Priority |
|---|---|---|
| `bootstrapDevice` | POS setup cannot finish provisioning (step 6) | **HIGH** |
| `getBusinessConfig` | POS legacy business fallback | LOW (degrades) |
| `getTypesenseSearchKey` | Search Typesense tier dead (Algolia key works — 200) | MEDIUM |

Grant (run per function, once):

```bash
gcloud run services add-iam-policy-binding bootstrapDevice \
  --region=us-central1 --member=allUsers \
  --role=roles/run.invoker --project=sokoni-aeb26
# repeat for getBusinessConfig and getTypesenseSearchKey
```

Evidence: unauthenticated POST to each `…cloudfunctions.net/<name>` returned a
`403 Forbidden` HTML body (Cloud Run), versus `401 UNAUTHENTICATED` JSON from the
invokable ones.
