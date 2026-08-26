# Admin Navigation & Device Certification — Batch 1

**Date:** 2026-08-25
**Branch:** `fix/algolia-batch-poisoning`
**Harness:** `scripts/certify-admin-responsive.js` (Playwright, local `node server.js`)
**Widths:** 1440 / 1280 / 1024 / 768 / 430 / 390 / 360

> **Not deployed.** Production HOLD stands. Firestore indexes remain staged and unpushed.
> Results are recorded as **PASS / PARTIAL / BLOCKED / NOT RUN** and are never rounded up.

---

## Acceptance gates

| Group | Criteria |
|---|---|
| **Admin shell** | header present · sidebar present · hamburger present and clickable · no consumer nav/search overlay · correct active section/page |
| **Responsive** | 7 widths · zero unintended horizontal overflow · no fixed element covering controls · chrome height tracks wrapped breadcrumbs/titles · drawer opens and closes |
| **Workspace isolation** | admin → admin chrome only · consumer → consumer chrome · seller/POS → their own chrome · no cross-workspace injection |
| **Consent** | admin banner absent · consumer banner present · no global suppression |
| **Authorization** | stubs may establish STRUCTURAL behaviour only; real admin/non-admin sessions remain the authority |
| **Navigation** | valid parent · admin home/back path · sibling navigation · active state · no marketplace or seller fallbacks |

---

## Root cause that explained most Batch-1 failures

The admin shell was **not** failing. It was being **covered by the wrong workspace chrome**.

Three separate symptoms turned out to share one cause — host pages suppressing or
overlaying the shell:

| Symptom | Cause |
|---|---|
| No header bar at any width (4 pages) | `header{display:none!important}` — pages with `data-no-header="true"` suppress the consumer header by ELEMENT type, which also swallowed the shell's `<header>` |
| Sidebar reported `width:244px` with 60 children but `getBoundingClientRect()` all zeros | `nav{display:none!important}` — the sidebar and breadcrumb bar are both `<nav>` |
| Hamburger unclickable below 1024px, drawer never opened | `shared-header.js` injected the consumer top-nav/search OVER the admin chrome (`body.sk-has-search`) |

The first two are fixed by setting `display` **inline with `important`** on the shell
elements — an inline important declaration outranks any stylesheet rule, which ends the
selector-specificity war rather than escalating it.

The third is fixed at the correct architectural boundary: `shared-header.js` does not inject
consumer chrome when `data-sokoni-workspace="admin"`. That is the same registry-driven marker
used for consent, and it also closes audit finding **§C3** (admin pages inheriting the
customer bottom nav).

### Why the fixes are registry-scoped, not page-scoped

`sokoni-admin-nav.js` stamps `data-sokoni-workspace="admin"` on `<html>` synchronously, and
only when the document resolves in the admin registry. Registry membership is the sole thing
that grants it, so a non-admin page cannot acquire the behaviour by copying markup, and a
future admin page cannot forget it. Removing a page from the registry removes its suppression
with it.

---

## Responsive fix pattern — measure, never hardcode

`reliability-center` padded the body to 95px against 124px of chrome: the header sat on 29px
of content. The breadcrumb trail had reflowed to **three lines** after the initial
measurement, and neither `resize` nor `fonts.ready` fired.

The dependency is:

```
header / breadcrumb height
        ↓  (measured, not assumed)
   chrome height
        ↓
  content offset
```

A `ResizeObserver` on the header and breadcrumb bar re-measures on any height change, so the
layout responds to actual geometry whatever causes the reflow — viewport width, font loading,
a long title, or a deep breadcrumb trail. A `padding-top: 124px` constant would have been
correct for exactly one page at exactly one width.

---

## Control integrity — a failing assertion is not always a failing product

Two assertions in this work were wrong, and were corrected rather than the product being
changed to satisfy them. Recorded because the certification system's value depends on being
able to tell the two apart.

### 1. `product.html` "missing consumer navigation" — FALSE POSITIVE

A negative control asserted that consumer pages must show the injected consumer nav.
`product.html` reported it absent, which looked like the workspace suppression had leaked.

It had not. `product.html` carries `data-no-header="true"` and shared-header **deliberately**
never injects there. Its workspace attribute read `(none)`, proving the admin suppression was
never evaluated for that page.

**Resolution:** the control expectation was corrected; `index.html` is the valid consumer
control and passes. The assertion was NOT weakened to make the run green.

### 2. Exit code read as a result — FALSE PASS

A background run was reported as "exit code 0, therefore zero failures". The command had been
piped through `grep`, so the exit status belonged to `grep`, not the harness. The real result
was **34/63**.

**Resolution:** results are now read from the harness output, never from the exit status of a
pipeline. A harness that gates on `process.exit(1)` tells you nothing once its output is piped.

### Standing rule

Do not weaken an assertion to turn a run green. Determine whether the ASSERTION or the
PRODUCT is wrong, and fix that one. A certification suite that is tuned until it passes
certifies nothing.

---

## Process incident — repo-wide `git stash` used for an A/B

**Classification: process incident, not a product defect.**

`git stash push` was used to compare behaviour with and without a change. The stash stack in
this repository is **repo-wide** and other processes work the same tree concurrently. The pop
failed against another process's in-flight work.

**Recovery verified before any further work:**

- the other process's stash (9 files, 434 insertions) — intact
- every prior fix in this session — present
- untracked files belonging to that stash — not clobbered

The A/B question was then answered by direct observation instead.

**Rules from here:**

- no repo-wide `git stash` for A/B experiments
- use a detached worktree or a temporary copy
- never disturb concurrent work
- never "clean up" another process's changes

With an RC this large, preserving attributable changes matters as much as the code.

---

## Results — Batch 1 CLOSED

**53 of 63 page-width combinations passed** (9 pages x 7 widths), after the shared-shell
tap-target fix took `beta-control` from 4/7 to 7/7.

| Page | Result | Widths | Cause of any failure |
|---|---|---|---|
| `admin-os.html` | **PASS** | 7/7 | — |
| `ops-dashboard.html` | **PASS** | 7/7 | — (regression control) |
| `beta-dashboard.html` | **PASS** | 7/7 | — (regression control) |
| `reliability-center.html` | **PASS** | 7/7 | — (regression control) |
| `admin-feedback.html` | **PASS** | 7/7 | — (regression control) |
| `enterprise-ops.html` | **PARTIAL** | 3/7 | Page ships its OWN `button#hamburger` inside its own `<header>`, sitting over the admin hamburger below 1024px. Cross-chrome collision. |
| `ops-center.html` | **PARTIAL** | 4/7 | Horizontal page overflow at <=430px. No oversized ELEMENT found — a sub-pixel or pseudo-element source not yet isolated. |
| `beta-control.html` | **PASS** | 7/7 | Was PARTIAL 4/7 — tap targets under 44px at <=430px (`sk-adm-logo` 22x44, `sk-adm-home` 34x44). Root cause was the SHARED shell; fixed, now a regression control. |
| `merchant-pipeline.html` | **PARTIAL** | 4/7 | Transient `div#sk-splash` overlays the hamburger during the drawer check. NON-DETERMINISTIC: present at 2400ms in one run, absent at 2400/4000/6000/9000ms in another. |

**BLOCKED: none. NOT RUN: none.**

### The BLOCKED prediction was wrong — worth recording

Before this run, `enterprise-ops` and `merchant-pipeline` were expected to resolve to
**BLOCKED — competing authorization gates**. Measurement showed otherwise: neither failure
involves authorization at all.

- `enterprise-ops` is covered by its own page hamburger (`button#hamburger < header < body`)
- `merchant-pipeline` is covered by the splash screen (`div#sk-splash`), not by its PIN gate
  as previously assumed

Both were classified from `elementFromPoint` evidence rather than from the earlier
hypothesis. Had the prediction been trusted, two real UI defects would have been filed as
environmental limitations and never fixed.

### Outstanding defects by owner

| Defect | Owner | Note |
|---|---|---|
| `sk-adm-logo` / `sk-adm-home` under 44px at <=430px | **shared shell** (`sokoni-admin-shell.js`) | Affects every admin page at narrow widths; fix once, then re-run controls |
| Own `button#hamburger` collides with admin burger | `enterprise-ops.html` | Page-level duplicate chrome; the page predates the shell |
| Horizontal overflow <=430px | `ops-center.html` | Source not isolated; no element exceeds the viewport |
| Transient splash covers controls | `merchant-pipeline.html` / harness | Race, not a persistent overlay. The harness does not wait for splash dismissal. |

The tap-target defect is the important one: it lives in the SHARED shell, so it is a
Batch-2 blocker in practice — every page wired next would inherit it.

### Gate accounting

| Gate | Status |
|---|---|
| Admin shell (header/sidebar/hamburger/no consumer overlay/active state) | **PASS** on 5, PARTIAL on 4 |
| Responsive (7 widths) | **PASS** on 5, PARTIAL on 4 |
| Workspace isolation (admin/consumer/seller/POS chrome) | **PASS** — verified with `index.html` control |
| Consent (admin absent, consumer present, no global suppression) | **PASS** — verified with controls |
| Authorization (structural only) | **PASS** structurally; real sessions remain the authority |
| Navigation (parent/home/siblings/active/no marketplace fallback) | **PASS** — registry validated, 50 surfaces |

---

### Classification definitions

| Result | Meaning |
|---|---|
| **PASS** | Every required check passes at every required width. |
| **PARTIAL** | A measurable product defect remains, even at a single width. |
| **BLOCKED** | The behaviour cannot legitimately be established without a real authenticated session or device capability. |
| **NOT RUN** | Genuinely untested. No claim is made. |

**BLOCKED is not a weaker PASS.** It records that the behaviour has *not* been established.
It is never converted to PASS on the grounds that the code looks correct.

---

## Regression controls

Four pages reached 7/7 and are now the shared-shell sentinels
(`docs/admin-responsive-controls.json`):

| Control | Result | Previously |
|---|---|---|
| `ops-dashboard.html` | **7/7 PASS** | header + logo-aspect + nav-usable failing at all widths |
| `beta-dashboard.html` | **7/7 PASS** | header + nav-usable failing; drawer blocked by consumer-nav overlay |
| `reliability-center.html` | **7/7 PASS** | header-no-cover — chrome 124 vs pad 95, 3-line breadcrumb reflow |
| `admin-feedback.html` | **7/7 PASS** | header + logo-aspect failing at all widths |

9 checks × 7 widths × 4 pages = **252 responsive assertions**, all green — from ONE
workspace-boundary fix, not four page patches.

Run after any change to a shared surface:

```
node scripts/certify-admin-responsive.js --controls
```

The controls cover all four shared layers Batch 2 will touch:
`sokoni-admin-shell.js`, `sokoni-admin-nav.js`, `shared-header.js`, `security.js`.

---

## Batch-2 protocol — keeping a 50-page effort auditable

Do **not** make the remaining 41 pages "ready" by changing the common shell again in one
sweep. That would put every page into one unattributable change and discard the evidence
Batch 1 just produced.

Order, without exception:

1. Record Batch-1 results.
2. Run the four regression controls.
3. Fix any shared-shell regression **first**.
4. Freeze the Batch-1 evidence.
5. Start Batch 2 with a **small, attributable** set of pages.
6. Re-run controls after **every** shared-shell modification.

**Responsive certification is part of the definition of done, not a cosmetic follow-up.**
A page is not complete because its links resolve. If its admin drawer is inaccessible at
390px, it is not done.

---

## Related

`docs/ADMIN_ROUTING_NAVIGATION_AUDIT.md` · `docs/ADMIN_SURFACE_CENSUS.md` ·
`docs/ADMIN_GUARD_RUNTIME_VERIFICATION.md` · `sokoni-admin-nav.js` ·
`sokoni-admin-shell.js` · `scripts/validate-admin-nav.js`

---

## Shell baseline FROZEN — 2026-08-25

### The fix

`#sk-adm-logo` and `#sk-adm-home` fell below the 44px tap-target floor at <=430px, where the
header hides the wordmark and the home label. Measured on `beta-control`: 22x44 and 34x44.

The fix grows the **hit area**, never the artwork:

```
#sk-adm-logo { min-width:44px; justify-content:center; }   /* image untouched */
#sk-adm-home { min-width:44px; justify-content:center; }   /* glyph untouched */
```

Enlarging the logo image would have satisfied the number and distorted the brand mark. The
`logo-aspect` check stayed green at all seven widths, confirming intrinsic ratio is intact.

### Gate sequence — both required, both met

| Step | Result |
|---|---|
| `beta-control` all 7 widths | **7/7 PASS** |
| 4 original regression controls | **28/28 PASS** — no shared-shell regression |
| Baseline frozen with `beta-control` added | **35/35 PASS** (5 controls) |

### Why beta-control became the fifth control

It is the only page in the set that exposed this defect. Below 430px the header collapses the
wordmark and the home label, and that is the sole condition under which those hit areas
shrink — the original four never entered that state. Dropping it would remove the only
sentinel for that path.

**The five controls are now the shell contract.** After ANY change to `sokoni-admin-shell.js`,
`sokoni-admin-nav.js`, `shared-header.js` or `security.js`:

```
node scripts/certify-admin-responsive.js --controls     # must be 35/35
```

If they fail, fix the shell. **Do not edit the baseline to accommodate a failure.**

### Deliberately NOT fixed in this step

| Page | Defect | Why deferred |
|---|---|---|
| `enterprise-ops.html` | Page-owned `button#hamburger` collides with the admin one | Page-local; belongs with that page's batch |
| `merchant-pipeline.html` | Transient `div#sk-splash` races the drawer check | Needs a deterministic splash lifecycle / wait condition. The harness must NOT be taught to pretend the splash does not exist. |
| `ops-center.html` | Horizontal overflow <=430px with NO oversized element | Isolate the actual geometry mechanism first — width calculation, scrollbar, transform, margin interaction — before touching CSS |

None of these are authorization blockers. That was established from `elementFromPoint`
evidence, correcting an earlier prediction that two of them would be BLOCKED.
