# Admin Navigation & Device Certification — Batch 2: Finance

**Date:** 2026-08-25
**Branch:** `fix/algolia-batch-poisoning`
**Scope:** 10 Finance-section pages from `sokoni-admin-nav.js`
**Harness:** `scripts/certify-admin-navigation.js` + `scripts/certify-admin-responsive.js`
**Widths:** 1440 / 1280 / 1024 / 768 / 430 / 390 / 360

> **Not deployed.** Production HOLD stands. Firestore indexes remain staged and unpushed.

---

## Navigation — 10/10 PASS

All nine checks on all ten pages: `registry-entry · correct-parent · home-path ·
parent-link · siblings · active-state · no-bad-fallback · deep-link · inbound`.

### The `finos-admin` hierarchy control

The original audit (§C1) found `finos-admin` was an **unreachable parent**: zero inbound
links, yet the only in-repo parent of `commission-admin` and `admin-subscriptions`. An entire
financial subtree hung off a node nothing linked to.

It now certifies clean, including `inbound`:

```
Operations Console > Financial OS > Financial Admin > Commissions > Commission Engine
```

`commission-admin` was re-parented under `finos-admin` rather than the console root. The
pre-registry link graph had `finos-admin` as that page's ONLY inbound source, so that was the
author's intended relationship all along — the defect was that `finos-admin` itself was
unreachable. Giving it a real place under `financial-os` makes the chain navigable in both
directions **without inventing a redirect**.

---

## Responsive — 62/70 · 6 PASS · 4 PARTIAL · 0 BLOCKED · 0 NOT RUN

| Page | Result | Widths | Remaining cause |
|---|---|---|---|
| `financial-os.html` | **PASS** | 7/7 | — |
| `finos-admin.html` | **PASS** | 7/7 | — |
| `fos-admin.html` | **PASS** | 7/7 | — |
| `revenue.html` | **PASS** | 7/7 | — |
| `sfos-monitor.html` | **PASS** | 7/7 | — |
| `etims-admin.html` | **PASS** | 7/7 | — |
| `revenue-dashboard.html` | **PARTIAL** | 6/7 | 5px overflow at 390: `button.icon-btn` right=395, and a `thead`/`tr` 475px wide outside any scroll container |
| `commission-engine.html` | **PARTIAL** | 6/7 | 5px overflow at 390; no element exceeds the viewport — sub-pixel or pseudo-element source, not isolated |
| `commission-admin.html` | **PARTIAL** | 5/7 | `div.main` fixed at **402px** — overflows 390 and 360 |
| `settlement-dashboard.html` | **PARTIAL** | 3/7 | `div.sec` / `div.card` fixed at **632px**, right edge 1054 — overflows at 1024, 430, 390, 360 |

Every remaining failure is `no-h-overflow`, and every one is **page-local fixed-width CSS**,
not shared chrome. Per the batch rule they are classified PARTIAL and do not contaminate the
batch. Deferred to their own remediation pass.

> **Attribution note for `settlement-dashboard`:** its 632px fixed-width blocks sit beside the
> shell's 244px sidebar offset at >=1024. 244 + 632 = 876 < 1024, so the sidebar alone does not
> explain a right edge of 1054 — the page positions the block further right. Recorded so the
> interaction is checked, not assumed, when that page is fixed. The correct fix is the fixed
> width, never removing the sidebar.

---

## Shared defects found and fixed at the workspace boundary

Batch 2 surfaced **two more consumer components** reaching into the admin workspace. With
consent and the consumer header from Batch 1, that makes four — each a different injector,
each now answered by registry membership rather than a per-page list.

| # | Component | Injector | Symptom |
|---|---|---|---|
| 1 | Consent banner | `security.js` | z-index 300001 covering the admin hamburger |
| 2 | Consumer header/search | `shared-header.js` | `body.sk-has-search` overlaying admin chrome |
| 3 | **Customer bottom nav** | `sokoni-nav-engine.js` | Marketplace `Home` link on admin pages |
| 4 | **Brand splash** | `splash.js` | Overlay WIDER THAN THE VIEWPORT at every width |

### The hand-maintained skip list

`sokoni-nav-engine.js` carried a `_SKIP` array naming individual admin pages —
`'admin'`, `'platform'`, `'sasos-admin'`, `'superadmin'`, `'monitor'`, `'moderation'`,
`'verification-admin'`. That is exactly the per-page enumeration the registry replaces, and it
explains why SOME admin consoles were clean while others silently inherited customer
navigation: the list had to be updated by hand for every new admin page, and was not.

It now checks `data-sokoni-workspace`, covering all 50 surfaces at once. The old entries were
left in place deliberately as a fallback if the engine runs before the registry stamps the
marker — removing them would trade one race for another.

### Splash impact

`revenue.html` went from **1/7 to 7/7** on the splash fix alone. `div.spl-out` measured
1446px against a 1440px viewport, 403 against 390, and so on at every width — it alone failed
the horizontal-overflow contract on that page.

---

## Two regressions I introduced, and how they were caught

### 1. Deferral left page auth gates up

Making inline gates `return` early when `window.SokoniAdminGuard` is present stopped them
racing the shared guard — and also skipped the code that **hides their own** `#auth-gate`
overlay. It stayed up and covered the hamburger on `finos-admin` and `sfos-monitor`, so the
drawer could not open below 1024px.

The guard now dismisses `#auth-gate` / `#authGate` on successful verification, **strictly**
those two ids. `#mp-gate` and other SECOND-FACTOR prompts are deliberately excluded: a
verified admin claim is exactly what makes a second factor meaningful, and clearing it would
silently remove a security control.

### 2. The same race, reintroduced in a new place

The first version of that fix did a direct `getElementById` inside the guard's success path.
`onAuthStateChanged` can fire **before** `DOMContentLoaded`, so the element did not exist yet
and the lookup silently found nothing — reported as fixed when it was not
(`gateInline: ""` proved it). This is the SAME race already solved once for the guard's own
overlay via the `settled` flag; the `ready()` helper needed for it was already in the file.

**Lesson recorded:** when a guard's success path touches page DOM, it must go through
`ready()`. A silent no-op looks identical to success unless the attribute is measured.

---

## Controls — held throughout

`node scripts/certify-admin-responsive.js --controls` was run after **every** shared-surface
change, five times in this batch:

| After | Result |
|---|---|
| registry re-parenting (`sokoni-admin-nav.js`) | **35/35** |
| customer-nav removal (`sokoni-admin-shell.js`) | **35/35** |
| nav-engine workspace guard (`sokoni-nav-engine.js`) | **35/35** |
| splash suppression + guard gate-dismiss (`splash.js`, `sokoni-admin-guard.js`) | **35/35** |
| gate-dismiss race fix (`sokoni-admin-guard.js`) | **35/35** |

No shared-shell regression at any point.

---

## Negative controls

Workspace scoping was verified in both directions each time — suppression must not leak to
consumer surfaces:

| Component | Admin page | Consumer control |
|---|---|---|
| Consent banner | absent | `index.html` **PRESENT** |
| Consumer header | absent | `index.html` **PRESENT** |
| Splash | absent | `index.html` **PRESENT** |

---

## Running total

| | Pages | PASS | PARTIAL | BLOCKED | NOT RUN |
|---|---|---|---|---|---|
| Batch 1 | 9 | 6 | 3 | 0 | 0 |
| Batch 2 (Finance) | 10 | 6 | 4 | 0 | 0 |
| **Total certified** | **19** | **12** | **7** | **0** | **0** |
| Remaining | 31 | — | — | — | NOT RUN |

Shell controls: **35/35** (5 pages).

---

## Related

`docs/ADMIN_BATCH1_CERTIFICATION.md` · `docs/ADMIN_SURFACE_CENSUS.md` ·
`docs/admin-responsive-controls.json` · `docs/ADMIN_ROUTING_NAVIGATION_AUDIT.md`
