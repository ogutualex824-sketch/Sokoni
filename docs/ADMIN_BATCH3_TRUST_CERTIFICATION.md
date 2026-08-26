# Admin Navigation & Device Certification — Batch 3: Trust & Safety

**Date:** 2026-08-25
**Branch:** `fix/algolia-batch-poisoning`
**Scope:** 5 Trust & Safety pages from `sokoni-admin-nav.js`
**Widths:** 1440 / 1280 / 1024 / 768 / 430 / 390 / 360

> **Not deployed.** Production HOLD stands. Firestore indexes remain staged and unpushed.

> **Navigation certification is NOT authorization certification.** This batch certifies that
> *a properly authorized admin can navigate to and between these pages*. That a **non-admin
> cannot enter them** is a separate proof and remains an open real-session blocker. No
> authorization gate was loosened to make the harness work.

---

## Navigation — 5/5 PASS (45/45 checks)

All nine checks on all five pages.

---

## Responsive — 26/35 · 2 PASS · 2 PARTIAL · 1 BLOCKED · 0 NOT RUN

| Page | Result | Widths | Cause |
|---|---|---|---|
| `moderation.html` | **PASS** | 7/7 | — |
| `security-zero-trust-dashboard.html` | **PASS** | 7/7 | — |
| `security-center.html` | **PARTIAL** | 6/7 | 28px overflow at 360: `div.soc-header-right` (187px) and `.soc-tab` (92px) — non-wrapping flex rows |
| `trust-safety.html` | **PARTIAL** | 3/7 | Up to 181px overflow at 768/430/390/360: `div.ni` (129-134px) and `div.ng` in a non-wrapping row |
| `verification-admin.html` | **BLOCKED** | 3/7 | Uses its OWN named Firebase app — see below |

---

## BLOCKED — `verification-admin.html`

**The first genuine BLOCKED in this work.** Not a defect, and not fixable by the harness.

The page initialises a **separate named Firebase app** and gates on that instance:

```js
const app  = getApps().find(a => a.name === "sokoni-va") || initializeApp(FB_CFG, "sokoni-va");
const auth = getAuth(app);
onAuthStateChanged(auth, async (user) => { ... });
```

The certification stub replaces `window.firebase`, which this instance never consults. So the
page's own auth sees no user, the deferral to the shared guard returns early, and
`#va-auth-check` — the overlay the page hides on its OWN success path — stays up at
z-index 9999 and covers the hamburger below 1024px.

With a real admin session the page's check resolves, `claims.admin === true`, the overlay is
hidden and the drawer works. **Stub-based certification cannot establish this.**

### What was deliberately NOT done

`va-auth-check` was **not** added to the shared guard's overlay-dismiss list. Doing so would
clear a gate overlay while the page's own authorization had not yet verified, revealing the
console before its check completed — loosening a security control to make a test pass. The
guard dismisses only `#auth-gate` / `#authGate`, and excludes second factors like `#mp-gate`
for the same reason.

**Resolution path:** real authenticated-session verification, alongside the existing
admin/non-admin session blockers.

---

## Authorization verified BEFORE wiring — two findings

### `moderation.html` is a MODERATOR-tier surface

Its gate accepts `claims.admin || claims.moderator`, and the registry declares
`authority: "moderator"`. Wiring it as `data-admin-guard="admin"` would have **locked out
every moderator**. It is wired to the moderator tier, which the shared guard satisfies with
`[moderator, admin, superAdmin]`.

### `security-center.html` looked like a bypass and is NOT

Its gate reads:

```js
const roleNum = Number(c.role) || 0;
if (roleNum < 4 && c.admin !== true && c.superAdmin !== true) { /* deny */ }
```

`setUserRole` mints `role` as a STRING, so `Number("superAdmin")` is `NaN` and `NaN < 4` is
`false` — which would make the whole condition false and SKIP the denial. But `|| 0` coerces
`NaN` to `0`, `0 < 4` is true, and the admin check runs. **The `|| 0` is load-bearing.**

Traced rather than assumed. "Fixing" this would have broken a working gate.

---

## Defects fixed — 4, two security-relevant

| Page | Defect |
|---|---|
| `security-zero-trust-dashboard.html:352` | `if (!isAdminOrSuper) { location.href = "/" }` — **marketplace dump on denial**, inside a security console |
| `security-zero-trust-dashboard.html:354` | Fail-closed catch (correct behaviour) racing the shared guard; now defers |
| `verification-admin.html:300` | Page **logo** linked to the customer marketplace |
| `moderation.html:167` | Access-denied panel offered "← Go to Home" → marketplace; now role-neutral `account-centre` |

The `/` on a denial path is the same class as the original audit's eleven marketplace dumps —
notable that it survived into a security surface.

Every deferral touches only the **unauthenticated** branch. No claims check was modified.

---

## Controls

No shared-surface change was needed this batch — all edits were page-local. The
batch-closing check ran anyway: **35/35, no shared-shell regression.** Registry validation:
all checks passed.

---

## Running total

| | Pages | PASS | PARTIAL | BLOCKED | NOT RUN |
|---|---|---|---|---|---|
| Batch 1 (admin shell) | 9 | 6 | 3 | 0 | 0 |
| Batch 2 (Finance) | 10 | 6 | 4 | 0 | 0 |
| Batch 3 (Trust & Safety) | 5 | 2 | 2 | 1 | 0 |
| **Certified** | **24** | **14** | **9** | **1** | **0** |
| Remaining | 26 | — | — | — | NOT RUN |

Shell controls: **35/35** (5 pages).

---

## Related

`docs/ADMIN_BATCH1_CERTIFICATION.md` · `docs/ADMIN_BATCH2_FINANCE_CERTIFICATION.md` ·
`docs/ADMIN_PAGE_LOCAL_REMEDIATION_QUEUE.md` · `docs/admin-responsive-controls.json`
