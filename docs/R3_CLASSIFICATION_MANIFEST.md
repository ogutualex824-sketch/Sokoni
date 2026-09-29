# R3 — AdminOS classification manifest for approved providers with no C1 category stamp (REVIEW PACKET, nothing applied)

**Date:** 2026-09-29T18:28Z · **Production project** `sokoni-aeb26` · **READ ONLY.** Generator `scripts/r3-classification-manifest.js --plan`; contract suite `scripts/test-r3-classification-manifest.js`; machine packet `docs/release-gates/r3-classification-manifest.json`. `--apply` is not implemented until the owner names a digest. Follows [[R2_ROUTING_RESOLVER]]. Boundaries: no capability change, no business identity, no DG Wine / Latomi correction, no KASS, no status-only accounts, no deletion, no branch, no card.

## 1 · How each identity was classified

For every `providers/{uid}` (11): the **approved application** for that uid (exactly one, `uid` matching, the provider's `sourceApplicationId` agreeing, a decider recorded) is run through the **real C1 classifier** (`business-category.categoryFromApplication(app, role)`) and the **real lane classifier** (`provider-hub.classifyDecidedApplication`) — the same two calls `projectProvider` makes at approval. The proposed write is `projectProvider`'s stamp, field for field. `providers.category` / `categoryLabel` text is **never** evidence (self-editable). Not live by approval evidence → unresolved. C1 no exact match → unresolved (AdminOS decides by hand). Already stamped or healthcare-owned → skipped.

Expected post-R2 routing is computed for each row from category lane × observed/stamped capability, so a stamp that would produce CONFLICT is visible before any write and is kept in a **separate** set with its **own digest**.

## 2 · PRIMARY set — 3 identities · digest `cb87e8cac1931c70b7cc423cdb4de62c76256a83ef77bce98637b562defb98e3`

| uid | name | current | approved application (evidence) | C1 | proposed mutation | expected post-R2 |
|---|---|---|---|---|---|---|
| `FqmCT4t4KehQD6EJR4m3dLVbHBo1` | Julian's Closet | provider live (approvedAt), capability SERVICES / NOT_YET_STAMPED, no stamp | `8XwvCN8PLsVo9WdxG1Zv` — category `tailor`, role provider (explicit), decided by `D5Ql2EYr…` 2026-09-03 | **service_business** (exact) | `providers/{uid}.business = { category: service_business, lane: {provider/null}, source: application, applicationId, setAt }` + 1 adminAudit `category_backfill_r3` | services lane × SERVICES → **provider-dashboard.html, AVAILABLE** |
| `H7p6ktBHogM5GcBy6mz8negKVbG2` | Langa'ta mamafua | same | `e0cOABIkbtu2Vb1suG5y` — `cleaning`, provider (keyword), decided 2026-09-03 | **cleaning** (exact) | same shape, category cleaning | provider-dashboard.html, AVAILABLE |
| `X7KZGTy3ouYmGESePPxKVlC3j613` | Hometown Movers kenya | same | `hZN2s7YCX8qvzYpsLwhu` — `moving`, provider (keyword), decided 2026-09-03 | **trades** (exact) | same shape, category trades | provider-dashboard.html, AVAILABLE |

Three writes to `providers/{uid}.business` (admin-protected in rules; Admin SDK path) and three audit records. Nothing else.

## 3 · DISAGREEMENT set — 2 identities · digest `9f8a96e8032bd36337bbba1cae423b237056728282e39723454fd4e916348952` (NOT recommended for this slice)

| uid | name | current | evidence | C1 | expected post-R2 if stamped |
|---|---|---|---|---|---|
| `Ohg9HrtGpCXBUSzbRfaUifOPWQ32` | DG wines and spirits | provider live; capability **SERVICES / STAMPED** (C4) | `AvAE6rZEiO9FJ9UoMePY` — `wholesaler`, provider (keyword) | **wholesale** (exact; a SELLER category) | **CAPABILITY_CONFLICT — CATEGORY_CAPABILITY_DISAGREEMENT products/SERVICES, no route** |
| `IaOBkEJYcCXk23UDWk0OPp7XXeD3` | Latomi gadgets | provider live; capability **SERVICES / STAMPED** (C5) | `y0dp5uPehfj4qFf4imKl` — `wholesaler`, provider (explicit b2b default) | **wholesale** (exact) | same |

The evidence classifies them; the stamp would make the resolver refuse them explicitly (today they are PENDING_CLASSIFICATION, also no route). Stamping only moves them from "awaiting classification" to "records disagree — admin decision". That is the owner's genuine CONFLICT; it is presented separately so it is never applied by accident with the primary set, and the owner may accept, reject, or defer this digest.

## 4 · UNRESOLVED — 6 identities (no mutation; AdminOS by hand)

| uid | name | reason |
|---|---|---|
| `13iuLZx63jN5evaNcUnx7bhDSfs1` | Shave 'n' Trims (synthetic, manifest R1/R6) | not live by evidence; no approved application |
| `AiJp5yzTnRZZIZKZEepNUKn8NuI2` | DJ Bvmbxno | not live by evidence (status only); no approved application |
| `aOdQxmUGLCO4hOYsdHMhWuwYV9D2` | King Bruce | not live by evidence (status only); no approved application |
| `28vznyvnLyNFXAJqL2wf6PjbqrK2` | Heights Creations | pending, not live; no approved application (pending PRODUCTS+SERVICES) |
| `3SkVHLqJXzfeQlQ4PfBx5DFR4at2` | k Riss | approved, live, but C1 has **no exact match** for application category "Entertainment Performer" (lane entertainment/SERVICE) |
| `WLt0VowwtFcFADIJDIxXu3e6H1p1` | Kasindi holdings limited | approved, live, but C1 has **no exact match** for "Service Provider" |

The three status-only accounts stay exactly as the owner ruled: no approval evidence, no classification, no dashboard. k Riss and Kasindi are real approved providers whose applications C1 cannot place by exact match — an AdminOS reclassification (`business-category-admin`, `source: admin`) is the path, each its own decision.

## 5 · Proof of exclusions

Every proposed write is `providers/{uid}.business` (+ audit). No mutation names `capabilities`, `businesses`, `shops`, `sellers`, `products`, PRODUCTS, KASS (`D5Ql2EYr…` has no providers record and is not in any set), the 34 manifest records (none is a live provider) or a branch. The contract suite asserts the mutation shape, the exclusions, the evidence rule (provider text ignored), every refusal reason, the primary/disagreement separation and digest behaviour: **21 / 0**.

## 6 · What happens on authorization

`--apply <digest>` (to be implemented on the reviewed digest): one transaction per identity re-reading provider + application, recomputing the row, aborting on any difference, writing the stamp and the audit; idempotent (an already-stamped provider is skipped). Then a landing proof (stamp present, provider otherwise byte-identical, application untouched, capability untouched) and the post-R2 route check for each identity through `workspaceFor`.
