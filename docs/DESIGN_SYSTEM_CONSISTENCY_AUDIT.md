# Design-System Consistency Audit (Launch Candidate)

**Status:** Evidence report — **no replacement code written** · **Date:** 2026-08-07
**Method:** grep counts across all top-level `*.html` + `*.js` (excluding the design-system files themselves + `.min`). Counts are approximate (a proxy for adoption), not exact call graphs.
**Related:** [[reference_design_system]] · [[project_mobile_ui_hardening]]

The canonical library already exists — `window.SK` (sokoni-ds.js) delegating to `SokoniUI` (sokoni-ui.js) + `sokoni-components.css`. The risk at this stage is **inconsistent use**, not missing components. This ranks where.

---

## 1. Design-system adoption (measured baseline)

| Component | Canonical | Legacy / custom | Adoption | Priority |
|---|---|---|---|---|
| **Dialogs** | `SK.dialog` — **102 uses** (Slice B batch 1) | `alert()`/`confirm()` bare — **331 left** | **~24%** (was ~0) — top-6 modules done | 🔴 High |
| **Toasts** | `SK.toast`/`SokoniUI.toast` — 17 | `showToast`/`showNotification` **535** (helper family → `window._sokoniToast`) · custom markup 114 files | ✅ **Slice A DONE (27abae9): ONE renderer** — `_sokoniToast` now delegates to `SokoniUI.toast`, so all ~552 helper calls render through one engine (call sites unchanged, per Wrap). 2 renderers → 1. | 🔴 High |
| **Status chips** | `SK.statusChip`/`.sk-status` — 1 (just added) | `.badge-*` / `status-*` — **127** across 37 files | **~0%** | 🔴 High |
| **Empty states** | `SK.empty`/`.sk-empty`/`.empty-state` — 33 files | hand-rolled "No X yet" — 78 files | **~30%** | 🔴 High |
| **Loading overlays** | `SK.loading` — 1 file | spinner / "Loading…" — 110 files | **~1%** | 🔴 High |
| **Skeletons** | `SK.skeleton` — 1 · `.sk-skel`/`.skeleton` class — 60 files | custom | **concept adopted, helper ~0** | 🟡 Med |
| **Form validation** | `SK.form.validate` — 0 files | page-specific — ~5 files | **~0% (low volume)** | 🟡 Med |
| **Cards** | `.sk-card` — 5 files | `*-card` classes — 287 uses (**mostly legitimate domain cards**) | n/a — most are KEEP | 🟡 Med |

**Headline:** the three components users see most — **dialogs, status chips, loading** — sit at **~0% adoption** despite the canonical versions existing. That's the highest-leverage, lowest-ambiguity convergence work.

---

## 2. Migration classification (Replace / Wrap / Keep)

| Area | Rule | Rationale |
|---|---|---|
| **Dialogs** (`alert`/`confirm`) | **Replace** → `SK.dialog` / `SK.dialog.confirm` | Native `alert`/`confirm` are blocking, unstyled, and break the premium feel. 396 of them. Clear win. |
| **Toasts** | **Wrap** (unify the 2 renderers) | Most pages already use a consistent `showToast`/`showNotification` helper — but it renders via `window._sokoniToast` while `SK.toast` renders via `SokoniUI.toast`. Point `showToast`/`SK.toast` at ONE renderer; keep the helper name (535 call sites) as the delegating entry. |
| **Status chips** | **Replace** → `SK.statusChip` | 127 `.badge-*`/inline status spans with drifting colors → one 6-color set. |
| **Empty states** | **Replace** → `SK.empty` (with `action`) | 78 hand-rolled "No X" blocks, most without a next-action CTA. |
| **Loading** | **Replace** overlays → `SK.loading`; **Keep** inline "Loading…" that will become skeletons | Full-screen/section spinners → `SK.loading`; short inline loaders are better replaced by `SK.skeleton` (Medium). |
| **Skeletons** | **Keep** the class + **Wrap** dynamic cases via `SK.skeleton` | The `.skeleton`/`.sk-skel` class is already used in 60 files — fine. Only dynamic list/card placeholders benefit from the helper. |
| **Cards** | **Keep** (mostly) | The 287 `*-card` classes are largely legitimate DOMAIN cards (product/order/merchant) already styled premium. Only truly generic containers are Replace candidates — not a launch blocker. |
| **Form validation** | **Replace** (low volume) → `SK.form.validate` | Only ~5 files; small effort, do opportunistically. |

---

## 3. Effort estimate & sequencing (High tier first)

| Slice | Scope | Effort | Notes |
|---|---|---|---|
| **A. Toast renderer unify** | Point the `showToast`/`showNotification` family + `SK.toast` at ONE renderer | **S** (1–2 files, central) | Highest ratio: 535 call sites converge by changing the *helper*, not the call sites. Do first. |
| **B. Dialogs → SK.dialog** | Replace `alert()`/`confirm()` (396) | **L** (~90 files) — but scriptable: `alert('x')`→`SK.toast`/`SK.dialog`; `confirm(x, cb)`→`SK.dialog.confirm`. Start with the top offenders (creative-studio 22, subscription-os 21, admin 21, wap 12, staff-management 12, account-centre 12). | Biggest visible win. Do in file batches, verify each. |
| **C. Status chips → SK.statusChip** | 127 `.badge-*` (37 files) | **M** | Mechanical; the mapping already covers ~35 status strings. |
| **D. Empty states → SK.empty** | ~78 hand-rolled, add next-action CTAs | **M** | Also improves conversion (guides the next action). |
| **E. Loading overlays → SK.loading** | 110 spinner/"Loading…" | **M** | Overlays → SK.loading; inline → skeleton. |

Medium tier (skeletons/forms/cards) follows once High is clean.

---

## 4. Release gate (before broad merchant onboarding)

Track these to 100% (measurable via the same greps):
- **100% dialogs** via `SK.dialog` — **currently ~0%**
- **100% toasts** via one renderer — **currently 2 renderers**
- **100% status indicators** via `SK.statusChip` — **currently ~0%**
- **100% empty states** via `SK.empty` — **currently ~30%**
- **100% loading overlays** via `SK.loading` — **currently ~1%**

Re-run §1 after each slice to watch adoption climb — evidence, not impressions.

### Adoption log (release-notes source)
| Date | Slice | Component | Before | After |
|---|---|---|---|---|
| 08-07 | A | Toasts (renderer) | 2 renderers | **1 renderer** |
| 08-07 | B1 | Dialogs | ~0% | **~24%** (102 via `SK.dialog`; 331 native left) — creative-studio, subscription-os, admin, wap, staff-management, account-centre |
| 08-07 | B2 | Dialogs | ~24% | **~40%** (158 via `SK.dialog`; 239 native left) — admin-subscriptions, ai-subscriptions, webhooks, observability, api-gateway, task-queue, email-center |
| 08-07 | B3 | Dialogs | ~40% | **~47%** (187 via `SK.dialog`; 212 native left) — driver, rider-nav (SOS), profile, pos-completeness |
| 08-07 | B4A | Dialogs | ~47% | **~53%** (210 via `SK.dialog`; 188 native left) — **data-no-header pages**: dispatch, ecc, provider-dashboard (money-path rigor) |
| 08-07 | B4B | Dialogs | ~53% | **~56%** (223 via `SK.dialog`; 175 native left) — **sokoni-aos.js money-path review**: escrow-release, payout-approve, void-receipt, session-revoke, mass email/SMS, content deletes (13 confirms, descriptive + danger) |
| 08-07 | B5 | Dialogs | ~56% | **~63%** (243 via `SK.dialog`; 141 native left) — admin/ops pages: legal-admin, inv-products, sasos-admin, ops-center, financial-os (money, danger), hr-payroll |
| 08-07 | B6 | Dialogs | ~63% | **~68%** (263 via `SK.dialog`; 121 native left) — seller-delivery, org-workflows, org-structure, my-subscriptions, manager-auth, gip, developer-portal, commissioning (2 doc/test-string alerts left as exceptions) |
| 08-07 | B7 | Dialogs | ~68% | **~73%** (282 via `SK.dialog`; 102 native left) — POS/admin: pos-printer-setup, pos-suppliers, pos-inventory, pos-hq, pos-accounting, workspace-invite, partner-portal, notifications, finos (money, danger). pos-ios-print-test deferred (no SK) |
| 08-07 | B8 | Dialogs | ~73% | **~79%** (304 via `SK.dialog`; 80 native left) — uat-center, superadmin, launch, food-dashboard, event-manager, chat, automation-center, async-jobs, status, seller, legal-centre. android-doctor deferred (no SK) |

**Batch ledger (dialogs):**
| Batch | Modules | SK.dialog | Native left | Adoption |
|---|---|---|---|---|
| 1 | creative-studio · subscription-os · admin · wap · staff-management · account-centre | 102 | 331 | ~24% |
| 2 | admin-subscriptions · ai-subscriptions · webhooks · observability · api-gateway · task-queue · email-center | 158 | 239 | ~40% |
| 3 | driver · rider-nav · profile · pos-completeness | 187 | 212 | ~47% |
| 4A | dispatch · ecc · provider-dashboard (`data-no-header`) | 210 | 188 | ~53% |

**B4A finding (corrects an earlier assumption):** `data-no-header` pages are NOT missing `SK` — shared-header.js injects `sokoni-ui.js`+`sokoni-ds.js` at lines 257/261 **unconditionally, before** the `data-no-header` early-return at line 567. Verified the script tags inject (`sk-ds-script`/`sk-ui-script` present on ecc). No bootstrap needed; no CSS/namespace conflicts (no page defines its own `SK`/`.sk-modal`/`openModal`). Headless can't runtime-verify `window.SK` on ANY auth-gated page (even known-good `admin` reads `undefined` — unauthed sessions redirect); runtime = on-device. **Trap avoided:** provider-dashboard has an `async confirm(id)` **method** (booking-confirm) — a definition, left untouched; only the 8 bare native `confirm()` calls migrated. provider-dashboard got money-path rigor (descriptive titles + `variant:'danger'` on no-show/cancel/delete/close).

**Batch-3 note:** all 9 confirms were in **non-async** functions (fire-and-forget onclick/listeners). Converted by marking each enclosing function `async` (body preserved exactly) — verified every caller discards the return value, so the Promise return is inert. rider-nav SOS lost its `\n\n` line break (modal wraps as one paragraph; text content preserved).

**Excluded from migration (scanner false-positives, verified):** `sokoni-alerts.js` (defines its OWN `alert(msg,severity,details)` audit system — not native); `functions/test/*`, `scripts/*` (Node — no `SK`); `dispatch.html`, `provider-dashboard.html`, `ecc.html` (`data-no-header` → shared-header never injects `SK`; need explicit `sokoni-ds.js` or stay native — handle separately).

### Dialog exception list (native retained — keeps "100%" unambiguous)
| File | Native retained | Reason |
|---|---|---|
| `sokoni-aos.js` (line ~25) | Yes — permanent | `alert("Access denied…")` fires at early init before deferred `sokoni-ds.js` is guaranteed loaded; security bail-out, not a dialog flow. Converting risks an `SK`-undefined throw. |
| `availability-manager.html` | Temporary — under review | Defines its OWN `alert`/`confirm` wrappers; needs a separate review (why they exist, whether they add logic, whether to delegate to `SK.dialog`). Not a drop-in swap. |
| JS libraries (`sokoni-*.js`, `pos-*.js`) | Conditional | Migrate ONLY after verifying every load site guarantees `window.SK` exists before execution. Any lib with a load path that doesn't guarantee SK stays native for now. |
| `pos-ios-print-test.html` (4 alerts) | Deferred | Standalone POS-print test page — loads NO shared-header and no `sokoni-ds.js`, so `SK` is absent. Would need an explicit `sokoni-ds.js` include first; low value (a test harness). |
| `android-doctor.html` (3 alerts) | Deferred | Diagnostic page — loads NO shared-header/`sokoni-ds.js`, `SK` absent. Same gate as pos-ios-print-test: needs an explicit include before migrating. |
| `developer-portal.html` (lines ~180/182) | Yes — permanent | `alert(...)` inside `<span class="str">` — rendered **code-documentation examples**, not executable. |
| `commissioning.html` (lines ~877/879) | Yes — permanent | `alert(1)` inside an **XSS-escaping test string** (`'<script>alert(1)</script>'`), not executable. |

**Slice B foundation (before any call-site moved):** the canonical modal gained what native `alert`/`confirm` give for free — `role="dialog"`/`aria-modal`, focus-trap, focus-restore, auto-focus, Enter-confirms — plus `SK.dialog.alert()` (new) and dialog telemetry (`window._skDialogMetrics` + `sk:dialog` event: type/module/result/durationMs). Mapping used: `alert(x)`→`SK.dialog.alert(x)`; `if(!confirm(x))return;`→`if(!(await SK.dialog.confirm(x)))return;` (async fns) or `SK.dialog.confirm(x, cb)` (non-async). `prompt()` left unchanged (no canonical equivalent yet).

---

## 5. Recommended first step
**Slice A (toast renderer unify)** — smallest change, highest leverage (535 call sites converge by fixing the helper), and it removes the one true fragmentation (two toast engines). Then **Slice B (dialogs)** in top-offender batches for the biggest visible lift. Each slice: convert → re-grep adoption → screenshot-verify a couple of pages → deploy. No page's *behavior* changes — only which shared component renders it.
