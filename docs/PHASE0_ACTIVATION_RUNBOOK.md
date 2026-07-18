# Phase 0 Activation Runbook

**Trigger:** Cloudflare reports the `mysokoni.co.ke` zone as **Active**.
**Purpose:** one executable sequence from activation to the Go / Conditional Go / No-Go decision.

> **Governing rule.** Production readiness is determined by **observed operational state**, not by
> successful deployment commands. Configuration → deployment → propagation → construction →
> runtime verification are separate phases. Each must complete before the next counts.
>
> **Never upgrade a PENDING to PASS by assumption.** Absence of failure is not evidence of success.

---

## Step 0 — Confirm the trigger (do not start early)

```bash
nslookup -type=NS mysokoni.co.ke      # expect anuj / nina .ns.cloudflare.com
```

Proceed only when Cloudflare nameservers are authoritative **and** the Cloudflare dashboard shows
**Active**. Starting mid-propagation produces failures that look like defects.

## Step 1 — Production verification suite

```bash
node scripts/rc1-production-verify.js
node scripts/rc1-production-verify.js --json > phase0-verify-$(date +%Y%m%d-%H%M).json
```

Expected transition from the pre-activation baseline:

| Check | Before activation | Required after |
|---|---|---|
| DNS delegated to Cloudflare | FAIL (`rs71–rs82.rcnoc.com`) | **PASS** |
| SSL — issued to our infrastructure | FAIL (`Let's Encrypt`) | **PASS** (Google Trust Services) |
| Origin is expected production stack | FAIL (`server=LiteSpeed`) | **PASS** (Firebase/GFE) |
| HSTS / CSP present | FAIL (absent) | **PASS** |
| CSP allows `auth.mysokoni.co.ke` | FAIL | **PASS** |

**Do not continue past any infrastructure FAIL.** An application failure measured against the
wrong origin is meaningless.

## Step 2 — Deploy pilot-critical indexes (additive only)

Definitions are staged in [`FIRESTORE_INDEX_AUDIT.md`](FIRESTORE_INDEX_AUDIT.md#ready-to-apply-definitions-pilot-critical-only).

```bash
# append the 9 definitions to firestore.indexes.json (ADD ONLY — never remove an entry)
firebase deploy --only firestore:indexes --project sokoni-aeb26     # NO --force
```

`--force` is omitted deliberately: without it, Firebase lists deployed-only indexes it would
otherwise delete and **skips** them. With it, they are dropped. The standing rule is *only ever
add indexes, never drop*.

## Step 3 — Index readiness gate (blocking)

```bash
node scripts/firestore-index-status.js --pilot
```

**Deployment submitted ≠ READY.** A BUILDING index throws `FAILED_PRECONDITION` *identically* to a
missing one, so testing now produces false defect reports.

If build state is not readable programmatically (`gcloud` is broken on the current host and the
Firebase CLI reports the configured set, not construction progress), **confirm READY in the
Firebase Console → Firestore → Indexes**. Record who confirmed it and when. Do **not** infer READY
from the deploy exit code.

Proceed only when all 9 report READY.

## Step 4 — Re-run affected checks

```bash
node scripts/rc1-production-verify.js
node "$SCRATCH/index-scan.js"     # index audit should no longer list the pilot-critical shapes
```

Then exercise the index-dependent paths that were previously blocked:
customer wallet balance (I-1) · accounting reports (I-2) · sales listing and customer history
(I-2) · incremental sync (I-3).

## Step 5 — Full RC1 smoke test

Merchant journey, in order — each step gated on the previous:

1. Merchant onboarding → `SOK-XXXXXX` minted, branch/tax/receipt/POS settings seeded.
2. Trial active **and expirable** (`currentPeriodEnd`, `uid`, `planId` present).
3. Create a product via `posUpsertProduct` → confirm **sellable** (`price` + `stockQty` readable).
4. Set a staff PIN (`setStaffPin`) → verify server-side via `validateDeviceAccess`.
5. Complete a sale → inventory decrements once, audit row written.
6. Refund behind manager authorization → single refund record, stock returned once.
7. Accounting reports return data.
8. Wallet balance reads.

## Step 6 — Reports

Produce, in this order: **Infrastructure · Security · Performance · Production Readiness.**

Each finding must cite observed evidence (HTTP status, header value, certificate issuer, index
state, test output). No claim without evidence.

## Step 7 — Phase 0 decision

Every criterion requires **direct evidence**. Anything unproven stays PENDING and is named
explicitly in the recommendation.

| # | Criterion | Evidence source |
|---|---|---|
| 1 | DNS delegation complete | Step 1 |
| 2 | Expected DNS records active (apex + www + auth) | Step 1 |
| 3 | TLS validated (chain · hostname · expiry · **issuer**) | Step 1 |
| 4 | Correct serving infrastructure confirmed | Step 1 |
| 5 | Application availability verified | Step 1 |
| 6 | Required security headers present | Step 1 |
| 7 | Pilot-critical indexes **READY** | Step 3 |
| 8 | Authentication validated | Step 5 + device testing |
| 9 | Marketplace workflows validated | Step 5 |
| 10 | Merchant workflows validated | Step 5 |
| 11 | Payment workflows validated | live low-value transaction |
| 12 | Security review completed | `AUTHORIZATION_REVIEW.md` |
| 13 | Performance review completed | Step 1 |
| 14 | No unresolved pilot-blocking defects | this runbook + risk register |

**Decision rule**

- **Go** — all 14 satisfied by observed evidence.
- **Conditional Go** — infrastructure, security and merchant workflows verified, with named
  residual items (e.g. physical device auth, live settlement) each carrying an owner and a
  closure condition. *This is the most likely outcome:* several criteria require a physical device
  or a real transaction that cannot be evidenced from the engineering environment.
- **No-Go** — any infrastructure FAIL, any pilot-critical index not READY, or any unresolved
  pilot-blocking defect.

State the condition that must be resolved for anything short of Go.

---

## Known residuals entering the pilot

Not blockers, but they must appear in the recommendation rather than be discovered later:

- **Physical validation** — Google Sign-In on iPhone Safari / installed PWA, receipt printing,
  cash drawer, barcode scanner. Cannot be evidenced without hardware.
- **Settlement is manual for the pilot** — `executeSettlement` is intentionally unwired
  (decision on record). The merchant is paid manually against the settlement preview.
- **Category B (54 ops)** — implemented but undeployable pending the Cloud Run quota; includes
  staff invitations. The pilot works around it: `createBusiness` seeds the owner directly.
- **T-1 / T-2** — confirmed transaction-ordering defects, formally deferred to Phase 1.
- **Category C (5 dead flows)** — returns, pickup verification, rent payment, M-PESA fallback,
  legacy onboarding wizard.
- **262 unverified index candidates** outside the pilot path.

## Rollback

If activation destabilises production: `firebase hosting:rollback`, and for functions
`git checkout <prev> -- functions/ && firebase deploy --only functions:<name>`.
**Never roll back by deleting indexes** — they are additive and unused ones are harmless.
Full procedure: [`RELEASE_PACKAGE_PHASE0.md`](RELEASE_PACKAGE_PHASE0.md) §6.5.
