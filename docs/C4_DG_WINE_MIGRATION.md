# C4 — DG Wine: business identity created, SERVICES stamped (landing packet)

**Date:** 2026-09-29 · **Production project** `sokoni-aeb26` · **Applied 17:20Z** under the owner's explicit authorization naming plan digest `e1a274e2009e34049947171aae7355503910c4c7d4ce1978e80db6d54e24d7b0`.
Branch `slice/c4-capability-consumer` (worktree `C:/temp/sok-cap`). Contract: `scripts/migrate-capability-identity.js` (+ `test-migrate-capability-identity.js` 27/0). Packet: `docs/release-gates/c4-dg-wine-migration.json`. Model: [[CAPABILITY_AUTHORITY_READ_MODEL]]. Census: [[C3_IDENTITY_CLASSIFICATION_CENSUS]].

## 1 · Pre-migration snapshot (read-only, 17:10Z, digest `bf19eb70…6cbe21`)

| Record | State |
|---|---|
| Auth `Ohg9HrtGpCXBUSzbRfaUifOPWQ32` | claim `provider` only; created 2026-08-02 |
| `providers/{uid}` | live: `status: active`, `approvedAt` 2026-09-03T22:55:03Z, category "wholesaler", `sourceApplicationId` = the approved application, 0 reviews, no C1 `business` stamp |
| `applications/AvAE6rZEiO9FJ9UoMePY` | approved 2026-09-03T22:55:02Z, decided by `D5Ql2EYr95bt79IpcGTmOMTK0P83`, role provider, hub b2b |
| `sellers`, `businesses` (by id / by owner), `shops`, `merchants`, `branches`, `providerProfiles`, `providerServices`, `providerSubscriptions`, `entitlements` | **absent** |
| products (`products` by sellerUid/ownerId, `posProducts`, `inventory_products`, `listings`, `services`) | **0** |
| `users/{uid}` | roles buyer + provider, activeRole provider |
| `wallets/{uid}` | balance 0 KES |
| read model | SERVICES · NOT_YET_STAMPED · no conflicts |

## 2 · Exact mutation manifest (applied, two writes, one transaction)

1. **create `businesses/Ohg9HrtGpCXBUSzbRfaUifOPWQ32`** — `uid` = `ownerId` = the same owner uid; `name`/`businessName`/`nameLower` from the provider; `status: active`; `source: capability_migration_c4`; `applicationId`; `category: wholesaler` (display wording, as the seller projection keeps it); description, phone, email, city copied from the application/provider; **`searchable: false`, `isPublic: false`** (discovery stays the discovery gate's decision); **`capabilities = { version: 1, SERVICES: { state: approved, decidedBy: D5Ql2EYr…, decidedAt: 2026-09-03T22:55:02Z, applicationId: AvAE6rZE…, source: application_approval } }`** — the original approval is the evidence; **no PRODUCTS key**; `migration: { slice: C4, from: providers/{uid}, providerApprovedAt, sourceApplicationId }`; `createdAt`/`updatedAt` server timestamps.
2. **create `adminAudit/ZlbUd4RIyt9GKGtaB8bI`** — action `capability_migration_c4`, target uid, business id, application id, capability SERVICES, performedBy `admin-sdk:capability-migration`, reason naming the original approver.

Not written, by the owner's decision: **no shop** (a `shops` doc routes its owner to Merchant V2 through login and the workspace home — the wrong dashboard for SERVICES); **no branch** (three disjoint branch models, none for services; the only branch producer is SmartPOS provisioning, which also grants POS, payment-method and trial-subscription semantics; a shared services branch model is a later, separately designed slice); no seller, no subscription, no POS data, no discovery visibility, no PRODUCTS.

## 3 · Transaction and idempotency behaviour

- `--plan` re-derived the C3 shape from production and printed the manifest; `--apply` required the reviewed digest.
- Inside the transaction every dependency was re-read (`providers`, `sellers`, `businesses/{uid}`, `shops/{uid}`, `applications`) and the plan recomputed; any difference aborts with no write (proven on the fake store: a seller appearing between plan and apply → `drift_abort`, nothing written).
- Result: `applied: true`, digest equal to the reviewed plan.
- **Second apply with the same reviewed digest → `already_migrated`, nothing written** (proven on production and on the fake store; the first production re-run answered `digest_mismatch` because the digest check preceded the no-op check — also a refusal with no write — and the order was corrected in the same slice so the answer names the true state).

## 4 · Landing proof (read-only, 17:21Z) — 16 / 0

business exists at `businesses/{uid}`, same owner uid, migration source · SERVICES = approved, PRODUCTS absent, stamp validates · approval evidence preserved (decidedBy, decidedAt, applicationId, source) · no discovery visibility, no shopId, no branch, no POS/subscription fields · **provider byte-identical** · **application byte-identical** · **users doc byte-identical** · **wallet byte-identical** · Auth claims unchanged · products remain 0 across all product-bearing collections · shops absent · branches absent · sellers absent · merchants absent, providerProfiles absent · exactly one adminAudit record · **read model on production: SERVICES / STAMPED / no conflicts, proposed PRODUCTS absent**.

Re-census (C3 script, read-only, 17:21Z): 26 identities, same distribution (0 / 7 / 12 / 7); **only the DG Wine row changed** (NOT_YET_STAMPED → STAMPED, businesses 0 → 1); Latomi unchanged; **the cleanup manifest digest is unchanged** (`028299e7…13e2`) — no unrelated identity moved.

## 5 · The boundary this slice does not cross

C4 stamped the authoritative SERVICES capability. **It does not claim the workspace is fixed.** The c4 category authority has not stamped this provider (no C1 `business.category`), so `business-workspace.js` still answers the legacy-unclassified provider path for it — exactly as before the stamp, by design of the consumer slice (the stamp changes authority, not behaviour). Category + capability routing convergence is the later slice. No Functions deploy from this line (self-mint hotfix provenance).

## 6 · What C5 (Latomi Gadgets) will reuse

The same contract, unchanged: `--plan` for `IaOBkEJYcCXk23UDWk0OPp7XXeD3` / its approved application, owner review of that manifest and digest, `--apply --expect-digest`, landing proof, re-census. Separately authorized.
