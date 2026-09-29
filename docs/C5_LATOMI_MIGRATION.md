# C5 — Latomi Gadgets: business identity created, SERVICES stamped (landing packet)

**Date:** 2026-09-29 · **Production project** `sokoni-aeb26` · **Applied 17:29Z** under the owner's explicit authorization of the exact command and plan digest `6b1c5044f1aa6fffc877f90a74490fa24409723c4959cb9a87c6be79f1c430dc`.
Same contract as [[C4_DG_WINE_MIGRATION]] (`scripts/migrate-capability-identity.js`, suite 28/0, now carrying `--slice` as provenance). Packet: `docs/release-gates/c5-latomi-migration.json`. Model: [[CAPABILITY_AUTHORITY_READ_MODEL]]. Census: [[C3_IDENTITY_CLASSIFICATION_CENSUS]].

## 1 · Pre-migration snapshot (read-only, 17:26Z, digest `0b499fe6…1dcdf`)

| Record | State |
|---|---|
| Auth `IaOBkEJYcCXk23UDWk0OPp7XXeD3` | claim `provider` only |
| `providers/{uid}` | live: `status: active`, `approvedAt` 2026-09-03T22:55:11Z, category "wholesaler", `sourceApplicationId` = the approved application, 0 reviews, no C1 `business` stamp |
| `applications/y0dp5uPehfj4qFf4imKl` | approved 2026-09-03T22:55:10Z, decided by `D5Ql2EYr95bt79IpcGTmOMTK0P83`, role provider (resolved **explicitly** — the b2b default `requestedRole: provider`), hub b2b |
| `sellers`, `businesses` (by id / by owner), `shops`, `merchants`, `branches`, `providerProfiles`, `providerServices`, `providerSubscriptions`, `entitlements` | **absent** |
| products (all product-bearing collections) | **0** |
| `users/{uid}` | roles buyer + provider · `wallets/{uid}` balance 0 KES |
| read model | SERVICES · NOT_YET_STAMPED · no conflicts |

No production fact differed from the C3 census, so the plan contained only the business identity and the audit record — no shop, no branch (the C4 decisions apply).

## 2 · Exact mutation manifest (applied, two writes, one transaction)

1. **create `businesses/IaOBkEJYcCXk23UDWk0OPp7XXeD3`** — `uid` = `ownerId` = the same owner uid; name "Latomi gadgets"; `status: active`; **`source: capability_migration_c5`**; `applicationId`; `category: wholesaler` (display wording); description/contact from the application; `searchable: false`, `isPublic: false`; **`capabilities = { version: 1, SERVICES: { state: approved, decidedBy: D5Ql2EYr…, decidedAt: 2026-09-03T22:55:10Z, applicationId: y0dp5uPe…, source: application_approval } }`**; no PRODUCTS key; **`migration.slice = C5`**; server timestamps.
2. **create `adminAudit/kIRnqG6YJwNP70bULqmb`** — action `capability_migration_c5`, target uid, business id, application id, capability SERVICES, reason naming the original approver.

## 3 · Transaction and idempotency

Every dependency re-read inside the transaction; drift aborts with no write (fake-store proof). Result `applied: true`, digest equal to the reviewed plan. **Second apply with the same command → `already_migrated`, nothing written.**

## 4 · Landing proof (read-only, 17:30Z) — 16 / 0

business exists, same owner uid, source `capability_migration_c5`, `migration.slice = C5` · SERVICES = approved, PRODUCTS absent, stamp validates · original approval evidence preserved · no discovery visibility, no shopId, no branch, no POS/subscription fields · **provider, application, users doc, wallet and Auth claims byte-identical** · products 0 everywhere · shops, branches, sellers, merchants, providerProfiles absent · exactly one adminAudit record · **read model on production: SERVICES / STAMPED / no conflicts**.

Full re-census (26 identities, 17:31Z): distribution unchanged (0 PRODUCTS · 7 SERVICES · 12 UNCLASSIFIED · 7 CONFLICT); the STAMPED set is exactly DG Wine (C4) and Latomi (C5); **only the Latomi row changed**; **cleanup manifest digest unchanged** (`028299e7…13e2`).

## 5 · Boundary

As for C4: the capability is stamped; the category authority has not stamped this provider, so the workspace still answers the legacy provider path. Fixing storefront and dashboard behaviour is the category + capability routing convergence, not this slice. No deploy.
