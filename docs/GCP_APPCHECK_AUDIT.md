# SOKONI — App Check enforcement audit

**Gate: P0-6. READ-ONLY. Zero mutations. No App Check setting was changed.**
Date: 2026-09-19 · Project `sokoni-aeb26`

Run while the Artifact Registry canary observation is frozen. Nothing here touched Cloud Run,
Cloud Functions, Artifact Registry, IAM, traffic or App Check configuration.

---

## 0. The headline, stated before the numbers

> **"439 callables do not enforce App Check" is not "439 vulnerabilities."**

Of the 439 deployed callables without App Check, **at least 429 perform an authentication or
authorization check in their own body.** After individual inspection, **this audit found zero
confirmed unauthenticated privileged endpoints.**

App Check attests *which app* is calling. Authentication attests *who* is calling. Authorization
decides *what they may do*. They are independent controls, and the absence of the first is only a
finding where the others do not carry the weight.

---

## 1. Verified census — the 659 figure is superseded

The prior audit's "≈659 callables without App Check" was re-derived from scratch and does not hold.

| Measure | Count |
|---|---|
| Deployed functions (authoritative, paginated) | **1,709** |
| — resolved to a **callable** definition | **1,022** |
| — not callables (triggers, schedules, `onRequest`) or unparsed | 687 |
| Callables in source but **not deployed** | 19 |
| **Deployed callables with App Check ENFORCED** | **547** |
| **Deployed callables WITHOUT App Check** | **439** |
| Undetermined | 36 |

**Enforcement coverage: 547 / 1,022 = 53.5%.**

The 687 non-callables are **not** claimed safe — they are out of scope for *callable* App Check and
belong to a separate surface (HTTP endpoints and triggers) that this gate did not assess.

### 1.1 Provenance caveat — this describes the REPO, not the deployed bytes

App Check enforcement for callables is a **code-level** setting (`enforceAppCheck` in the `onCall`
options), so it can only be read from source. The newest deployed source artifact is dated
**2026-09-14T00:45:58Z**, and this branch carries **three commits touching `functions/` since**
(`2f4fc20`, `1ef1d72`, `a5b13cb`). For functions touched by those commits, repo state may differ
from deployed state. The 19 "in source but not deployed" callables are consistent with that drift.

---

## 2. Authorization coverage across the 439 unenforced callables

| Controls present in the function body | Count |
|---|---|
| Authentication **and** role/permission check | **171** |
| Authentication check only | **204** |
| Role/permission check only | **54** |
| **Neither detected** | **10** |
| Body not located | 0 |

The 10 were then read individually. Results in §4.

---

## 3. The method failure that dominated this audit

This gate found **five** defects in its own tooling. They are recorded because each would have
produced a confident, wrong, and alarming number.

| # | Defect | Effect |
|---|---|---|
| 1 | Callable options captured **up to the first comma** | A multi-property options object contains commas, so `{ region, …, enforceAppCheck: true }` truncated to `{ region`. **Reported every money callable as unenforced.** Unenforced count was inflated to 580 |
| 2 | `Object.assign(exports, mod)` bulk re-exports not parsed | Whole modules silently absent from the census |
| 3 | Object **spread** in options (`{ ..._CF_OPTS }`) not resolved | Enforcement declared in the spread constant read as absent |
| 4 | Authz regex did not know `assertAuth`, `assertTenant`, `requireAdmin`, `auth?.token?.admin` | Reported **"no authorization"** on functions that plainly authorize |
| 5 | `\brequireAdmin\b` cannot match inside `_requireAdmin` — `_` is a word character | `franchiseReviewApplication` reported as unprotected when it calls `_requireAdmin(req)` |

Defects 1 and 4 were each caught only because the *next* phase read the actual source. Defect 1 was
exposed by inspecting `adjustWallet`, which the census had just labelled unenforced and which
carries `enforceAppCheck: true` on the same line as its region.

**The reusable lesson:** an "absent control" finding derived from pattern matching must be confirmed
by reading the code before it is reported. Every iteration of this audit reduced the alarming
number — 580 → 473 → 439 unenforced, and 28 → 10 → effectively 0 unauthorized. A single pass would
have published a false crisis.

### 3.1 The census is certified both ways

`scripts/infra/appcheck-census.js` is checked against ground truth read from source:

```
POSITIVE CONTROL — must read as ENFORCED:
  PASS adjustWallet  PASS spendFromWallet  PASS initiateWalletTopUp
  PASS requestPayout PASS processRefund
INVERTING CONTROL — must read as NOT enforced:
  PASS scheduleAccountDeletion  PASS revokeAllSessions  PASS accountDeactivate
  pass=8 fail=0
```

A detector that only confirms enforcement would hide gaps; one that only confirms absence would
invent them. Both directions pass.

---

## 4. Classification

### Category A — security-sensitive, App Check appropriate as defence in depth

These are authenticated and authorized, so they are **not open**. App Check would add app
attestation against scripted abuse of a money or privilege path.

| Function | Module | Existing controls |
|---|---|---|
| `finosCreateEscrow` | `finos-router.js` | role check, `invoker: private` |
| `finosReleaseEscrow` | `finos-router.js` | auth + role, `invoker: private` |
| `finosDisputeEscrow` | `finos-router.js` | auth + role, `invoker: private` |
| `finosRequestBankPayout` | `finos-router.js` | role check, `invoker: private` |
| `finosUpdateSettlementRules` | `finos-router.js` | role check, `invoker: private` |
| `hubGenerateInvoice` / `hubResubmitInvoice` | `hub-etims.js` | auth + role |
| `adminSubProcessRefund` | `sub-billing.js` | auth |
| `inventoryAdjustStock` | `inventory-engine.js` | `assertAuth` + `assertTenant` |
| `merchantAdjustStock` | `merchant-inventory.js` | auth |
| POS session writes (`createPosSession`, `updatePosCart`, `closePosSession`, …) | `pos-session.js` | auth, several with role |
| `dispatchDelivery`, `completeDeliveryWithPin`, `captureProofOfDelivery` | `dispatch.js`, `delivery-complete.js` | auth |

**Note on `invoker: 'private'`** — several FinOS callables already carry it, which is a *stronger*
control than App Check for direct reachability: the endpoint does not accept unauthenticated
internet traffic at the Cloud Run layer at all.

### Category B — authenticated, lower risk

The bulk of the 439: authenticated read and write paths in inventory, CRM, workforce, analytics and
hub modules. App Check is desirable platform-wide but is not individually urgent.

### Category C — intentionally public

Verified by reading; these legitimately serve unauthenticated callers:

| Function | Purpose |
|---|---|
| `currencyGetRates`, `currencyConvert` | FX rates for display |
| `getReviews` | public product reviews |
| `getShopAvailability` | public shop open/closed state |
| `getTsAutocompleteSuggestions` | search autocomplete |
| `getProductTrustData` | public product page data |

For these, App Check is the **only** control that would distinguish the real app from a scraper,
since by design there is no user to authenticate. They are the strongest candidates for App Check
on *abuse-prevention* grounds rather than security grounds — and the most likely to break third
party or server-side consumers if enforced. **Not a defect today.**

### Category D — internal/system

`redisDispatch`, `asyncPauseQueue`, `asyncGetDashboard`, Typesense admin and queue operations.
Several are admin-gated (`typesenseCreateCollections` requires `auth.token.admin`;
`asyncPauseQueue` calls `_admin(req)`).

### Category E — evidence insufficient

**36 undetermined** by the census (options shape not resolvable) plus the **687** deployed functions
not resolved as callables. Neither group is claimed safe; both need a separate pass.

---

## 5. Source cross-check on the 10 "neither detected" candidates

Every one was read individually. **None is an unauthorized privileged endpoint.**

| Function | Finding |
|---|---|
| `franchiseReviewApplication` | **Calls `_requireAdmin(req)`** — detector defect #5. Approves/rejects franchise applications; correctly admin-gated |
| `franchiseGetBrandDashboard`, `franchiseGetLocations` | Same module, same guard family — read before any claim |
| `currencyGetRates`, `currencyConvert` | Genuinely unauthenticated. **Intentional** — Category C |
| `getReviews`, `getShopAvailability`, `getTsAutocompleteSuggestions`, `getProductTrustData` | Genuinely unauthenticated public reads — Category C |
| `getHealthScoreBenchmarks` | Benchmark data; verify whether aggregate-only before treating as public |

**Result: zero confirmed unauthenticated privileged endpoints.**

---

## 6. Remediation plan — NOTHING ENABLED

### 6.1 The deployment constraint that governs everything here

`enforceAppCheck` is set **in code**. Changing it for any function requires editing source and
**redeploying that function** — which creates a Cloud Run revision.

> **Every App Check remediation is therefore blocked by the Artifact Registry freeze.** There is no
> configuration-only path, and no subset of this work can proceed before the artifact lifecycle is
> understood.

This is a scheduling fact, not a reason to delay the analysis — which is why this gate was worth
running now.

### 6.2 Proposed sequence, for when deployment reopens

| Step | Scope | Rationale |
|---|---|---|
| 1 | Adopt a shared `CF_OPTS` constant carrying `enforceAppCheck: true` per module | The codebase already uses this pattern in 20+ modules. One edit per module, not per function |
| 2 | Category A first — FinOS, POS session, inventory adjust, dispatch | Money and stock paths, smallest set, highest value |
| 3 | Category B in module-sized batches | Each batch is one deploy and one verification |
| 4 | Category C **last, and only after client verification** | These serve unauthenticated callers; enforcing App Check here **will break any consumer that is not the SOKONI app**, including server-side and third-party integrations |
| 5 | Category E — resolve the 36 + audit the 687 non-callables | Separate gate |

### 6.3 Testing requirement — non-negotiable

App Check enforcement fails **closed**. A function with `enforceAppCheck: true` rejects every call
lacking a valid App Check token, including from a legitimate client whose App Check is misconfigured.

Before any batch:
1. Confirm App Check is registered and issuing tokens for **every** client (web, and any native app).
2. Confirm debug tokens exist for local and CI environments.
3. Deploy **one** low-risk Category B function first and verify real traffic succeeds.
4. Only then proceed by module.

**Do not enable App Check on a payment path as the first test.**

### 6.4 What App Check must not be used for

Not a substitute for authentication or authorization. Category A functions are candidates *because*
they already authenticate and authorize — App Check adds attestation on top. Any future proposal to
add App Check *instead of* an authorization check is a defect.

---

## 7. Verification

| Check | Result |
|---|---|
| App Check settings changed | **none** |
| Functions deployed | **none** |
| Revisions created | **none** |
| Cloud Run modified | **none** |
| Artifact Registry modified | **none** |
| IAM changed | **none** — 39 bindings |
| Canary | **intact** |
| Contamination baseline | **CLEAN** — 1,709 functions, build `72739a70…` |
| Application code changed | **none** — only `scripts/infra/` tooling and this document |

---

## 8. Proposed next mutation

**None in this gate.** All App Check remediation requires redeployment and is blocked behind the
artifact-lifecycle gate.

The next *available* work is analysis that needs no deploy: the `products/{productId}` trigger
fan-out audit, or the recurring 5xx root-cause preparation. Both are read-only and independent of
the canary.
