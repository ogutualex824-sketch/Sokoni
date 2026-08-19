# Slice 1 Contract Capture — `digital-hub`

**Status:** read-only review · **Date:** 2026-08-19 · **No code changed**
**Census window:** 2026-07-20T20:41Z → 2026-08-19T20:41Z (30 days)

Related: [[CF_CONSOLIDATION_PROGRAMME]] · [[Payments]] · [[Marketplace]]

---

## 1. Exported `onCall` functions — 10

`functions/digital-hub.js`, 336 lines, 11 `onCall` definitions of which **10 are
exported** via `functions/index.js:11985-11994`. No triggers, no schedules, no
HTTP functions. Shared options: `{ region: 'us-central1', enforceAppCheck: true }`.

## 2. Callers

| Caller class | Result |
| --- | --- |
| Client files (`.html`/`.js`) | **none** — verified per-name across the repo |
| Other server modules | `entitlement-adapters.js` references `downloadDigitalProduct` **in a comment**, not as a call |
| `functions/index.js` | re-export only (10 literal assignments) |
| Dynamic callable names | none — the module never builds a name at runtime |
| Scheduled/trigger callers | none |

> "0 client files" was treated as a warning sign, not a convenience. The hub
> pages that exist (`digital.html`, `digital-store.html`, `digital-esoko.html`,
> `digital-esoko-seller.html`) call **none** of these functions. This subsystem
> is built but unwired.

## 3. Operation classification

| Operation | Class | Notes |
| --- | --- | --- |
| `getDigitalProduct` | **read, public** | tolerates an unauthenticated caller for `status === 'active'` |
| `listDigitalProducts` | **read, public** | no auth check at all |
| `getMyDigitalPurchases` | read, owner | strips `fileStoragePath` |
| `getDigitalSellerDashboard` | read, owner | see defect D3 |
| `createDigitalProduct` | write, privileged | requires `role >= 2` |
| `updateDigitalProduct` | write, privileged | owner **or** `role >= 4` |
| `publishDigitalProduct` | write, privileged | owner **or** `role >= 4` |
| `rateDigitalProduct` | write, owner | must own the purchase |
| `purchaseDigitalProduct` | **FINANCIAL** | commission engine; writes `platformFee`, `sellerAmount`, increments `totalRevenue` |
| `downloadDigitalProduct` | **CAPABILITY GRANT** | issues a 15-minute signed Cloud Storage URL |

## 4. Auth / role / claim requirements

Roles are numeric custom claims read via `admin.auth().getUser(uid)`:
`0` public · `>= 2` seller · `>= 4` admin.

All authorization is **in-code, per operation** — none of it lives in the
function definition. This is the decisive difference from `impact`, where the
boundary was in the deployment config (`secrets:`) and therefore could not
survive a merge.

## 5. Secrets

**None.** No `secrets:`, no `defineSecret`, no `process.env` credential reads.

## 6. Writes and external services

* Firestore: `digitalProducts`, `digitalPurchases`, `digitalPurchaseIdempotency`, ratings
* Storage: **read-only signed URL** on `product.fileStoragePath`
* External services: **none** — no payment provider, no HTTP client

## 7-8. Request / response contracts

Every operation takes a flat `req.data` object and returns a plain object.
Errors are all `HttpsError` with stable codes: `unauthenticated`,
`permission-denied`, `invalid-argument`, `not-found`, `failed-precondition`,
`resource-exhausted`. No operation returns a raw provider payload.

## 9. Idempotency

Only `purchaseDigitalProduct` claims idempotency, via a caller-supplied
`idempotencyKey`. **See defect D1.**

## 10. Rate limiting / security

`enforceAppCheck: true` on all ten. Download attempts are capped by
`allowedDownloads` with a `resource-exhausted` error. No per-caller rate limit.

## 11. Materially different trust boundaries — YES

Four distinct boundaries in one module:

1. unauthenticated public read
2. seller-role write
3. admin-override write
4. ownership-gated **capability issuance** (signed Storage URL)

plus a financial write. A dispatcher can preserve all of these — they are
in-code — but ops 9 and 10 are the two where a routing mistake has a
consequence worse than an error message.

## 12. The real consolidation boundary

### Can these operations safely share one dispatcher? **YES — with two exclusions.**

**Included (8):** `createDigitalProduct`, `updateDigitalProduct`,
`publishDigitalProduct`, `getDigitalProduct`, `listDigitalProducts`,
`getMyDigitalPurchases`, `rateDigitalProduct`, `getDigitalSellerDashboard`

**Excluded (2), each for a specific reason:**

| Excluded | Reason |
| --- | --- |
| `purchaseDigitalProduct` | **Financial.** Calls the single commission authority and writes money fields. Slice 1 must not set the precedent that a money-touching operation may be routed behind a generic `op` parameter. |
| `downloadDigitalProduct` | **Capability grant.** Issues a signed Storage URL. A routing defect here leaks paid content rather than returning an error. Keeping it a physically separate endpoint keeps that blast radius at one function. |

**Expected exports removed: 7** (10 → 3: one dispatcher plus the two excluded).
**Client files affected: 0.** `functions/index.js` changes (10 re-exports → 3).

Neither exclusion is a safety verdict on the code itself — both are
"this does not belong in the *first* dispatcher".

---

## Value assessment — read before proceeding

**7 exports of the 212 required (3.3%).** Weighed against a full behavioural
proof (positive control, negative controls, routing proof, orphan deletion,
post-deploy traffic comparison, export-count verification) for a subsystem that:

* has **no client callers at all**
* shows **no traffic evidence** — all ten at ≤ 1 request, which the standing rule
  treats as none
* carries an **open, documented defect** that makes its paid path unusable (D2)

A reasonable alternative is to skip `digital-hub` and take a wired module with
real traffic, where the dispatcher pattern is proven against live behaviour
rather than against dormant code.

## Defects found during review — recorded, not fixed

**D1 — racy idempotency claim in `purchaseDigitalProduct`.**
`digitalPurchaseIdempotency` is read at `:172` *outside* the transaction and
written at `:228` *inside* it. The transaction never reads it, so two concurrent
purchases with the same key both pass the check and both commit — a second
purchase document and a double `totalRevenue` increment. The `already purchased`
query at `:183` is racy for the same reason. Not flagged by
`audit-financial-safety` because its V3 window is 7 lines and these are 56 apart.

**D2 — paid digital purchases are undeliverable.**
Purchases are created `pending_payment`; `downloadDigitalProduct` requires
`completed`; nothing transitions between them. Documented in
`entitlement-adapters.js:199-208`, which exists to supply the missing transition.

**D3 — fabricated seller-revenue figure.**
`getDigitalSellerDashboard` returns `sellerRevenue: totalRevenue * 0.90` — a
hardcoded 10% assumption — while `platformFeeTotal` on the very next line
resolves the real rate from `commission-config`. The two disagree whenever the
configured rate is not 10%. This is a business metric derived from a magic
multiplier rather than the canonical source.
