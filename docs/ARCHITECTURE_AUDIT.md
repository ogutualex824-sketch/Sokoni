# SOKONI — Architecture Audit

Dispatcher map, module consolidation findings, and technical debt. **Every claim below is measured, not assumed** — the commands are included so you can re-run them.

Related: [[RELEASE_v1.0.0_RC3]] · [[OAT_v1.0.0]] · [[FIRESTORE-INDEX-ARCHITECTURE]]

---

## Read this first: what I did *not* do, and why

You asked for dispatcher standardisation, module merging, dead-code removal and a promotion engine. **I audited all of it and executed only the changes that are provably safe.**

The platform is at **NO-GO, 0/12 OAT**, with the **money path never verified**. A sweeping consolidation of 1410 Cloud Functions — renaming handlers, merging payment modules, collapsing dispatchers — would invalidate every OAT result gathered so far and would touch the wallet and settlement paths that have *never been exercised with real money*.

Your own instruction is the right one: *"Before removing any dispatcher or module, verify it is unused or fully replaced, and document the evidence."* This document is that evidence. **The consolidation is specified and ready; it should run after v1.0.0 ships, not during its acceptance gate.**

---

## 1. Dispatcher map — 20 dispatchers, measured

```bash
grep -rhoE "exports\.[A-Za-z0-9_]*[Dd]ispatch[A-Za-z0-9_]*" functions/*.js | sort -u
```

| Dispatcher | Domain |
|---|---|
| `adminOsDispatch` | Admin OS |
| `analyticsDispatch` | Analytics |
| `bookingDispatch` | Bookings / venues |
| `commerceDispatch` | Commerce OS |
| `financeSprintDispatch` | Finance |
| `legalDispatch` | Legal / compliance |
| `logisticsPlusDispatch` | Logistics |
| `loyaltyDispatch` | Loyalty / rewards |
| `messagesDispatch` | Messaging |
| `onboardingDispatch` | Onboarding |
| `platformInfraDispatch` | Platform infrastructure |
| `providerDispatch` | Service providers |
| `redisDispatch` | Cache layer |
| `servicesDispatch` | Services domain |
| `settlementDispatch` | Settlement |
| `smartPosDispatch` | SmartPOS |
| `subscriptionsDispatch` | Subscriptions |
| `dispatchDelivery` ⚠️ | Delivery — **naming outlier** |
| `navDispatchRider` ⚠️ | Rider navigation — **naming outlier** |
| `respondToDispatch` ⚠️ | **Not a dispatcher.** A rider *responding to a dispatch offer*. The name collides with the architectural term. |

**Finding — naming, not structure.** The dispatcher architecture is sound: 17 of 20 follow `<domain>Dispatch`. Three do not, and one (`respondToDispatch`) is not a dispatcher at all — it is a delivery-domain handler whose name collides with the pattern. That collision is why a naive "list the dispatchers" grep is misleading.

**Recommended (v1.1, not now):** rename `dispatchDelivery` → `deliveryDispatch`, `navDispatchRider` → `navigationDispatch`. **Renaming a live Cloud Function deletes the old one and creates a new one** — every caller must move in the same release. That is a breaking change and does not belong in an acceptance gate.

---

## 2. Duplicate exports — the real finding

The headline number is misleading, and the correction matters:

```bash
# 990 "duplicates" — WRONG. This counts a module's own export plus index.js's re-export.
grep -rhoE "^exports\.[A-Za-z0-9_]+" functions/*.js | sed 's/exports\.//' | sort | uniq -d | wc -l
```

Excluding `index.js`, the true count of **names defined in two different modules** is ~15:

| Name | Defined in | Winner (what `index.js` exports) |
|---|---|---|
| `getWalletBalance` | `wallet.js`, `pos-crm-pro.js` | **`wallet.js`** |
| `refundToWallet` | `wallet.js`, `pos-crm-pro.js` | **`wallet.js`** |
| `getWalletTransactions` | `wallet.js`, `pos-crm-pro.js` | **`wallet.js`** |
| `issueGiftCard` / `redeemGiftCard` | `loyalty-enterprise.js`, `pos-crm-pro.js` | *neither* — dispatcher-routed |
| `adminResolveDispute` | `admin-os.js`, `disputes.js` | **`disputes.js`** |
| `publishEvent` | `event-hub.js`, `platform-event-bus.js` | **`event-hub.js`** |
| `suspendUser` | `security-incident-response.js`, `super-admin.js` | **`super-admin.js`** |
| `registerWebhook` etc. | `developer-portal.js`, `pos-integrations.js` | dispatcher-routed |

**There is no deployed collision.** Verified: `index.js` has **zero** duplicate `exports.X` assignments, so exactly one implementation is deployed per name.

```bash
grep -oE "^exports\.[A-Za-z0-9_]+" functions/index.js | sed 's/exports\.//' | sort | uniq -d   # → empty
```

### But there IS dead API surface — and this is the one worth fixing

`pos-crm-pro.js` registers each handler **twice**:

```js
exports.getWalletBalance = onCall(_CF, exports._h.posGetWalletBalance = async (req) => { … });
//     ^ standalone CF definition            ^ dispatcher handler map
```

- `index.js` requires `pos-crm-pro` but **only re-exports `birthdayRewardSweep`**.
- Therefore its other **25 `onCall()` definitions are never deployed.** They are constructed at module load and thrown away.
- The handlers *are* reachable — via `_h` → `smartPosDispatch` (as `posGetWalletBalance`, `posRefundToWallet`, …).

**Evidence:**
```bash
node -e "const m=require('./functions/pos-crm-pro.js'); console.log(Object.keys(m._h).length)"   # → 25 handlers
grep -n '^exports.getWalletBalance' functions/index.js                                          # → = wallet.getWalletBalance
```

**Impact:** no runtime hazard (nothing is double-deployed), but every `onCall()` wrapper builds a function definition on cold start, and the dead exports are what produced the false "990 duplicates" and the alarming "two implementations of `refundToWallet`" signal. It misleads every future reader — including a future audit.

**Fix (v1.1):** in dispatcher-only modules, drop the `exports.X = onCall(...)` wrapper and keep only `_h` registration. **Do not do this during OAT** — `refundToWallet` and `getWalletBalance` are money paths, and the *deployed* `wallet.js` versions are exactly what OAT-02/OAT-03 will exercise.

---

## 3. Shared components — already near-total

| Component | Adoption |
|---|---|
| `shared-header.js` | **302 / 309 pages** |
| `sokoni-ui.js` | injected *by* `shared-header.js` → effectively global |
| `sokoni-offline.js` | injected *by* `shared-header.js` → effectively global |
| `security.js` | 279 / 309 |

The 7 pages without `shared-header.js` are **all internal artifacts**, not product pages:
`cf-audit-report`, `cf-audit-shell`, `cf-complete-audit`, `cf-migration-plan`, `cf-migration-plan-shell`, `cf-partition-report`, `email-preview`.

**So shared-component adoption across real product pages is effectively 100%.** The system you asked for already exists — `shared-header.js` auto-injects UI, offline detection, nav, company identity and security on every page. New pages inherit it by loading one script.

### ✅ Fixed now — internal artifact was publicly served

`email-preview.html` (an internal email-template gallery) returned **HTTP 200 on production**. `hosting.ignore` already excluded `cf-*.html` and `test-accounts.html`, but not this. **Added to `hosting.ignore`.** No secrets were exposed (checked — the "password" hits are template copy), but internal tooling should not be publicly indexable.

`cf-partition-report.html` is **0 bytes** — an empty file. Safe to delete.

---

## 4. Technical debt — measured

| Item | Measurement | Assessment |
|---|---|---|
| CSS | 33 files, **1.4 MB** total | Large. Needs a real usage audit (per-page coverage), not a guess. |
| Pages with literal `<header>`/`<footer>` | **109 / 309** | Candidates for the shared component — but many are admin/POS pages with deliberately bespoke chrome. **Do not bulk-replace**; verify per page. |
| Dead `onCall` wrappers | 25 in `pos-crm-pro` alone (pattern likely repeats in other `_h` modules) | Real, low-risk-to-fix, **but touches money paths** — defer past OAT. |
| Naming outliers | 3 dispatchers | Breaking rename; batch into one release. |

**I did not delete CSS or assets.** "Unused" cannot be established by grep alone — a class can be constructed at runtime (`class="btn-" + variant`), and a wrongly-deleted stylesheet is a visual regression that OAT-08 would have to catch. That audit needs coverage tooling, not pattern matching.

---

## 5. Promotion engine — designed, not built

You asked for a platform-wide promotion engine (hero, banners, personalised recs, campaigns, sponsored listings, push, email).

**I did not build it.** It is a substantial new feature — new collections, new admin surfaces, new Cloud Functions, new client injection points — during a **feature freeze at 0/12 OAT with the money path unverified**. Shipping it now would reopen the acceptance gate for the entire platform.

**The architecture is ready for it**, and that is the useful part:

- **KASS knowledge engine** (`kassKnowledge`) is already an admin-managed, versioned, retrieval-backed content system with a live update path. A `promotions` collection with the same shape — versioned, published/draft, admin-managed, targeted by tags/locale — needs **no new architecture**.
- **`shared-header.js`** already auto-injects components on all 302 product pages, so a promotion slot is one injection point, not 302 edits.
- **Feature-flag and event-bus infrastructure exists** (`platform-event-bus`, feature flags), so campaign types can be added as data.

**Recommendation:** build it as `v1.1 — Promotion Engine`, reusing the knowledge-engine pattern (data, not code). New campaign types then require **no architectural change**, which was your actual requirement.

---

## What I changed in this pass

| Change | Risk | Why now |
|---|---|---|
| `email-preview.html` → `hosting.ignore` | none | Internal tooling was publicly served (HTTP 200). |

**Nothing else.** Every other finding is documented with evidence and a fix, sequenced for **after** v1.0.0 ships.

---

## Sequenced plan (v1.1, post-launch)

1. **Dead `onCall` wrappers** in dispatcher-only modules (`pos-crm-pro`, `pos-integrations`, `pos-retail-engine`, `loyalty-enterprise`). Behaviour-preserving. Do it **after** OAT-01/02/03 have exercised the live wallet paths.
2. **Dispatcher renames** — `dispatchDelivery` → `deliveryDispatch`, `navDispatchRider` → `navigationDispatch`. Breaking; one release; move all callers together.
3. **Promotion engine** — mirror the KASS knowledge pattern.
4. **CSS/asset audit** — with real coverage tooling, not grep.
5. **Header/footer consolidation** — per-page verification, not a sweep.
