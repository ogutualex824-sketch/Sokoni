# SOKONI v1.0.0 — Known Issues Register

**Last updated:** 2026-07-12 · **Maintained by:** Release Manager
**Rule:** an issue is listed here only with **evidence**. Nothing is listed on suspicion, and nothing verified is hidden.

---

## 🔴 RELEASE-BLOCKING

### RM-01 — Release build is not reproducible (204 uncommitted files)
| | |
|---|---|
| **Evidence** | `git status --short` → **204** uncommitted files on `main` |
| **Impact** | **A release tag cannot be cut. A Deployment Manifest cannot be issued. A Production Release Certificate cannot be signed.** OAT evidence cannot be bound to a build that does not exist in version control. |
| **Risk** | **High.** Whatever is deployed cannot be reproduced or rolled back to. |
| **Owner** | Engineering / operator |
| **Remediation** | Commit or revert the working tree. Confirm `git status` is clean. **Then** tag. |
| **Effort** | 15 min |
| **Status** | 🔴 **OPEN** |

### OAT-01 … OAT-12 — Operational Acceptance not executed
**0 of 12 passed.** No real payment, refund, payout, dispute, subscription, device, inbox or alert has been verified. See `OAT_v1.0.0.md`. **This is the release gate.**

---

## ✅ RESOLVED DURING THIS PHASE

### RM-02 — Product-image fallback deleted while still referenced *(fixed)*
| | |
|---|---|
| **Evidence** | `assets/default-product.png` deleted in the working tree, yet referenced by **14** files (`cart.js`, `category.js`, `checkout.html`, `invoice.html`, `car-hub.html`, `market-actions.js`, …). `assets/kenya-flag.svg` deleted, referenced by 2. |
| **Impact** | Every product without an image — **in cart, checkout and invoices** — would have rendered a broken-image icon. The fallback itself would 404. Directly on the purchase path. |
| **Remediation** | Restored both from HEAD. `assets/Sokonilogo2.png` remains deleted — verified **0** references (superseded 2.1 MB logo). |
| **Status** | ✅ **RESOLVED** |

---

## 🟠 HIGH — non-blocking, fix before broad public launch

### SEC-F2 — Chat attachments readable by any authenticated user
| | |
|---|---|
| **Evidence** | `storage.rules`: `match /chatAttachments/{uid}/**` → `allow read: if request.auth != null` |
| **Impact** | **Any registered user can read any other user's private chat attachments** (IDs, invoices, photos). |
| **Why not fixed** | The obvious fix (owner-only) would stop the **recipient** from viewing attachments sent to them — a functional regression. The correct fix is a **path restructure** to `/chatAttachments/{conversationId}/…` gated on conversation membership, which requires migrating existing URLs. **Not done blind.** |
| **Owner** | Engineering |
| **Effort** | 3–4 h (rules + client + migration) |
| **Status** | 🟠 **OPEN** — design in `SECURITY_RULES_REVIEW.md` |

### H2 — Subscription write split-brain
| | |
|---|---|
| **Evidence** | Writes diverge across 5 stores; `subscriptions` is keyed two incompatible ways (sub-engine vs subscription-os). Diagnostic: `getSubscriptionDivergence`. |
| **Impact** | One account can hold **conflicting** subscription records → wrong tier / commission. |
| **Mitigation in place** | **Reads and enforcement are already unified** via `subscription-core` (3 readers migrated). The *read* side is correct today. |
| **Why not fixed** | Write-unification is a **data migration over live billing** — must run behind a flag, not blind. |
| **Effort** | 1 day (flagged migration + reconciliation) |
| **Status** | 🟠 **OPEN** — plan in `SUBSCRIPTION_CONSOLIDATION.md` |

### CB-04 — Redis fallback is silent
| | |
|---|---|
| **Evidence** | `redis-service.js` latches `_fallback = true` and returns `null` **with no log and no alert**. |
| **Impact** | Redis being *down* is indistinguishable from Redis being *absent*. **Caching is silently off** in non-connector functions → extra Firestore reads → **real, avoidable spend**. |
| **Not a correctness issue** | Rate limiting **deliberately** falls back to Firestore for security-sensitive actions; there is no deployed queue worker. |
| **Effort** | 1 h (structured log + alert) — **needs no VPC connector** |
| **Status** | 🟠 **OPEN** — plan in `CB04_REDIS_REMEDIATION.md` |

---

## 🟡 MEDIUM

### 16 residual financial findings
All `onCall` (no automatic retry — duplication requires a client to re-fire). **None Critical.** Each documented with surface, event source, retry model, impact, likelihood, evidence, action in `RESIDUAL_FINANCIAL_FINDINGS.md`. Highest: **R1 `procurement.js:675`** — real KES double-debit on a double-clicked "Approve & Pay". CI **ratchet** prevents any *new* violation.

### Capacity Watch — 1,410 CFs vs 1,350 soft budget
~90 services of headroom to the Cloud Run ceiling (~1,500). **Architectural signal, not a deployment blocker.** `CAPACITY_WATCH.md`.

### Composite indexes: 325
Grew from 226. **Not verified** as deployed or within quota. Worth confirming before launch.

### `assets/default-product.png` is 1 MB
A **1 MB placeholder** shipped on the product/cart/checkout path. Performance cost on every image fallback. **Logged, not fixed** — no speculative changes during freeze.

---

## ⚪ NOT VERIFIED — deliberately unscored

**Responsiveness · Accessibility (WCAG AA) · PWA · Search ranking · Performance (cold start, bundle) · Backup-restore · Market activation.**

These have **not been tested**, therefore they carry **no score and no PASS**. They are OAT items. **A fabricated score is worse than a missing one.**

---

## Closed (verified fixed this release)

| ID | Defect | Impact if unfixed |
|---|---|---|
| **P0-1** | M-PESA callback: read-check-write + auto-ID | Double seller credit |
| **P0-2** | IntaSend webhook: same pattern, never patched | Duplicate commission ledger rows |
| **P0-3** | `onSellerPaymentCreated`: auto-ID + `increment()` on an at-least-once trigger | **Sellers billed commission TWICE** |
| **P0-4** | Shared webhook wrapper: racy idempotency claim | One payment event processed twice (4 rails) |
| **P0-5** | `processDriverEarning`: batch + `increment()` + auto-ID | **Drivers PAID TWICE** |
| **P0-6** | Scheduled AI-credit re-allocation | Free credits on scheduler retry |
| **P0 (POS)** | 9 SmartPOS handlers called an undefined `request` | `recordPOSSale` + 8 others **crashed on every call** |
| **C2** | Provider onboarding: 4 contract bugs | A provider **could not register at all** |
| **C3** | 12 roles routed to non-existent dashboards | **404 dead-end** after onboarding |
| **SEC-F1** | Financial ledgers client-writable by admin token | Ledger tampering from a browser |
| **RM-02** | Product-image fallback deleted while referenced | Broken images in cart/checkout/invoice |

**Every one of the six money defects was found by reading code. None was caught by a test.** That is the standing argument for OAT.

Related: [[OAT_v1.0.0]] · [[RELEASE_DASHBOARD]] · [[RESIDUAL_FINANCIAL_FINDINGS]] · [[SECURITY_RULES_REVIEW]]
