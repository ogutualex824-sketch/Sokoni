# Admin Auth-Architecture Scan

**Date:** 2026-08-25
**Tool:** `scripts/scan-admin-auth-architecture.js`
**Scope:** all 50 registry surfaces
**Purpose:** predict the session-dependent certification set BEFORE spending a batch
discovering it one page at a time.

> **Classification only. Nothing was changed.** Finding a separate Firebase app does NOT
> mean a page should be rewritten to use the shared guard. See "Do not unify automatically".

---

## Result

| Prediction | Count |
|---|---|
| **OK** — the harness stub reaches this page's auth | 37 |
| **AT-RISK** — a separate instance exists; inspect before wiring | 9 |
| **BLOCKED** — needs a real authenticated session | 4 |

**Validation: 24/24 correct** against every page with a known certified outcome.

---

## The signal that actually matters

The first version of this predictor was **wrong**, and the error is worth keeping.

It classified any *named Firebase app* as BLOCKED. That flagged `security-center.html` —
which had **already certified 6/7**, failing only on overflow at 360, never on auth. A false
positive on a page whose real outcome was known.

The distinction:

| Pattern | Harness reach | Example |
|---|---|---|
| `firebase.initializeApp(cfg, 'name')` on the **compat shim** | **Stub applies** — it goes through `window.firebase` | `security-center.html` |
| `import { initializeApp } from '…/firebase-app.js'` then `getAuth(app)` | **Stub does NOT apply** — module scope is beyond `window.firebase` | `verification-admin.html` |

A page blocks only when **both** hold:

1. its auth comes from a **module-imported** Firebase the harness cannot replace, **and**
2. it owns a **default-visible overlay that only its own success path dismisses**

`security-center` satisfies neither fully: compat shim, and no self-dismissed blocking
overlay. It certified normally.

**A single control proves a detector fires. It does not prove the detector is right.**
Scoring against all 24 known outcomes is what caught this.

---

## PREDICTED BLOCKED — 4

| Page | Section | Status |
|---|---|---|
| `verification-admin.html` | Trust & Safety | **CONFIRMED** — certified BLOCKED in Batch 3 |
| `monitor.html` | Operations | Predicted — module import at `:386` |
| `launch-metrics.html` | Platform | Predicted — module import at `:188` |
| `redis-monitor.html` | Platform | Predicted — module import at `:533` |

All three predictions were spot-checked: each imports `firebase-app.js` as an ES module
rather than using the compat shim.

---

## AT-RISK — 9

Inspect before wiring; a separate instance exists but one BLOCKED condition is unproven.
Four of these have **already certified fine**, which is why AT-RISK is an "inspect me"
bucket and not a claim.

| Page | Section | Already certified? |
|---|---|---|
| `ops-center.html` | Operations | yes — PARTIAL (overflow, not auth) |
| `admin.html` | Operations | not yet |
| `beta-dashboard.html` | Platform | yes — **PASS 7/7** |
| `executive-dashboard.html` | Platform | not yet |
| `release-readiness.html` | Platform | not yet |
| `legal-admin.html` | Enterprise | not yet |
| `fos-admin.html` | Finance | yes — **PASS 7/7** |
| `revenue.html` | Finance | yes — **PASS 7/7** |
| `security-center.html` | Trust & Safety | yes — PARTIAL (overflow, not auth) |

---

## Distribution by section — informs batch order

| Section | OK | AT-RISK | BLOCKED | Note |
|---|---|---|---|---|
| Commerce | 5 | 0 | 0 | **cleanest remaining slice** |
| Administration | 2 | 0 | 0 | clean |
| Enterprise | 4 | 1 | 0 | |
| Finance | 8 | 2 | 0 | done — Batch 2 |
| Trust & Safety | 3 | 1 | 1 | done — Batch 3 |
| Operations | 5 | 2 | 1 | **Batch 4** — expect `monitor.html` to block |
| Platform | 10 | 3 | 2 | most complex — correctly scheduled last |

Platform carries the highest concentration of unusual auth architecture (2 BLOCKED,
3 AT-RISK), which supports leaving it until last.

---

## Do not unify automatically

A separate Firebase app is not automatically a defect. Per page, decide **why it exists**
before touching anything. The correct outcome is one of:

1. **Retain it**, mark the page BLOCKED pending real-session verification.
2. **Adapt the harness** to support that legitimate auth architecture.
3. **Consolidate** — only if the duplicate instance is genuinely accidental.

**Never change authentication architecture to make a responsive harness pass.**

The same reasoning already governs overlays: `#va-auth-check` was NOT added to the shared
guard's dismiss list, because clearing a gate overlay before the page's own authorization
verified would reveal the console early. `#mp-gate` is excluded for the same reason — a
second factor stays a second factor.

---

## Recorded for later: string-vs-numeric role semantics

`security-center.html`:

```js
const roleNum = Number(c.role) || 0;
if (roleNum < 4 && c.admin !== true && c.superAdmin !== true) { /* deny */ }
```

`setUserRole` mints `role` as a **string**:

```
role = "superAdmin"  ->  Number(role) = NaN  ->  NaN || 0 = 0  ->  0 < 4 = true  ->  admin check runs
```

**The `|| 0` is currently part of the authorization behaviour.** Without it, `NaN < 4` is
`false` and the denial would be skipped entirely.

Mixed string/numeric role semantics are fragile and deserve a future cleanup — but **not**
during a navigation/responsive batch, and not unless a real authorization defect is
established. `executive-dashboard.html` carried the same numeric-role idea as dead code
(`parseInt('superAdmin')` is `NaN`), removed in the J1 fix because nothing mints a numeric
role.

---

## Related

`docs/ADMIN_BATCH3_TRUST_CERTIFICATION.md` · `docs/ADMIN_SURFACE_CENSUS.md` ·
`docs/ADMIN_PAGE_LOCAL_REMEDIATION_QUEUE.md`
