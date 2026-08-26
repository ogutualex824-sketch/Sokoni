# Admin — Page-Local Remediation Queue

**Opened:** 2026-08-25
**Purpose:** keep certified-PARTIAL pages visible. These are page-local defects that were
deliberately NOT fixed opportunistically while wiring later batches, so each fix stays
attributable to its own change.

> **Rule:** do not fix these while wiring a batch. They get their own pass, with the shell
> controls (35/35) run afterwards like any other change.

---

## Open — 9 pages

### From Batch 1 (admin shell)

| Page | Result | Defect | Notes |
|---|---|---|---|
| `enterprise-ops.html` | PARTIAL 3/7 | Page ships its OWN `button#hamburger` inside its own `<header>`, sitting over the admin hamburger below 1024px | Page-owned duplicate chrome that predates the shell. Removing it is the likely fix, but confirm nothing else binds to that button first. |
| `ops-center.html` | PARTIAL 4/7 | Horizontal overflow at <=430px with **no element exceeding the viewport** | Source not isolated. Sub-pixel or pseudo-element. Isolate the geometry before touching CSS. |

> **Removed 2026-08-25:** `merchant-pipeline.html` was reclassified **PARTIAL -> BLOCKED**.
> Its blocker is `#mp-gate`, the PIN second factor, not CSS. It needs a real session plus
> the PIN. See `docs/ADMIN_BATCH4_OPERATIONS_CERTIFICATION.md`.

### From Batch 2 (Finance)

All four are `no-h-overflow` from fixed-width page CSS, not shared chrome.

| Page | Result | Defect | Measured |
|---|---|---|---|
| `commission-admin.html` | PARTIAL 5/7 | `div.main` fixed width | **402px** — overflows 390 and 360 |
| `settlement-dashboard.html` | PARTIAL 3/7 | `div.sec` / `div.card` fixed width | **632px**, right edge **1054** — fails 1024, 430, 390, 360 |
| `revenue-dashboard.html` | PARTIAL 6/7 | 5px overflow at 390 | `button.icon-btn` right=395; a `thead`/`tr` 475px wide outside any scroll container |
| `commission-engine.html` | PARTIAL 6/7 | 5px overflow at 390 | No element exceeds the viewport — source not isolated |

### From Batch 3 (Trust & Safety)

Both are non-wrapping flex rows — page-local, not shared chrome.

| Page | Result | Defect | Measured |
|---|---|---|---|
| `trust-safety.html` | PARTIAL 3/7 | `div.ni` / `div.ng` in a row that does not wrap | up to **181px** overflow at 390; fails 768, 430, 390, 360 |
| `security-center.html` | PARTIAL 6/7 | `div.soc-header-right` (187px) + `.soc-tab` (92px) header controls do not wrap | **28px** overflow at 360 |

> `verification-admin.html` is **BLOCKED**, not PARTIAL, and is NOT in this queue — it needs
> a real authenticated session, not a CSS fix. See `docs/ADMIN_BATCH3_TRUST_CERTIFICATION.md`.

### From Batch 5 (Commerce)

| Page | Result | Defect | Measured |
|---|---|---|---|
| `automation-center.html` | PARTIAL 5/7 | `div.hdr-right` (188px) + `.stat` (83px) header controls do not wrap | **10px** overflow at 390 and 360 |

---

## `settlement-dashboard` — trace the geometry, do not assume

Its 632px blocks sit beside the shell's 244px sidebar offset at >=1024. **The sidebar alone
does not explain the failure**: 244 + 632 = 876, well inside 1024, yet the measured right edge
is 1054. Something positions the block further right.

Walk the chain and fix the smallest TRUE cause:

```
viewport
  -> containing block
  -> sidebar width
  -> content width
  -> fixed .sec width
  -> margin / padding / border / transform
  -> actual right edge
```

Do not "fix" this by narrowing or removing the sidebar. The sidebar is certified across five
control pages at all seven widths; a fixed 632px width inside a responsive column is the
defect.

---

## Standing lessons from these batches

**Fixed widths are the recurring cause.** `div.main` 402px and `div.sec` 632px both assume a
viewport that no longer exists once the admin shell reserves a sidebar column. Prefer
`max-width` + `min-width:0` over a fixed `width` in admin content.

**Wide content scrolls inside its own container.** `revenue-dashboard`'s table overflows the
page because nothing wraps it. The shell provides `.sk-adm-scroll` (`overflow-x:auto`)
precisely for this — a table is the canonical case.

**A 5px overflow with no oversized element is not "close enough".** It means the source is
something the element scan cannot see. Isolate it rather than nudging a width until the
number goes green — see the control-integrity rule in
`docs/ADMIN_BATCH1_CERTIFICATION.md`.

---

## Closing an entry

1. Fix the smallest true cause.
2. Re-certify that page at all seven widths — it must reach 7/7.
3. Run the shell controls: `node scripts/certify-admin-responsive.js --controls` — 35/35.
4. Move the row to **Closed** below with the measured before/after.

---

## Closed

*(none yet)*

---

## Related

`docs/ADMIN_BATCH1_CERTIFICATION.md` · `docs/ADMIN_BATCH2_FINANCE_CERTIFICATION.md` ·
`docs/admin-responsive-controls.json`
