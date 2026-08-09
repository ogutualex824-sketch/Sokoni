# Navigation Contract v1

**Status:** governance standard (owner-directed 2026-08-04). Applies to every user-facing page — existing and new. Like the [[Publication Contract]] and [[Provider Lifecycle Contract]], this exists so the platform cannot drift back into multiple navigation styles. The *premium redesign* is R1.1; this contract is the **correctness floor** every page must meet regardless.

---

## The 10 rules (every user-facing page MUST satisfy)

1. **Standard header.** Load `shared-header.js` (it injects the canonical header AND `sw-register.js`). A page must not hand-roll its own header/topbar in place of it. `shared-header.js` measures and publishes `--sk-header-h`; sticky bars anchor to that variable, never `top:0` (see [[project_uiux_overhaul]]).
2. **A way back — always.** No page is reachable without a way out. Every page has a working **Back** (or an unambiguous parent link). Never rely on bare `history.back()` for a page that can be deep-linked/opened cold — provide an explicit fallback parent (`history.length > 1 ? history.back() : location.assign('<parent>')`).
3. **No dead ends, no placeholders.** No `href="#"`, no `href="javascript:void(0)"`, no button whose handler goes nowhere. Every nav control resolves to a real, existing destination.
4. **Links must resolve.** Every internal link targets a file that exists. Cross-check on change; a 404 from the nav is a contract violation.
5. **Bottom navigation (mobile) is fixed and consistent.** The 5 canonical tabs — **Home · Explore · Orders · Wallet · Profile** — never change between workspaces. Hidden ≥769px (desktop uses the sidebar).
6. **Active page highlighted — cleanUrls-safe.** The active-tab check MUST match the **extension-free** pathname (production serves via cleanUrls). Never key active state on `'.html'` or a hardcoded `'page.html'` string — those never match in prod (see [[reference_cleanurls_page_matching]]). Match on the clean segment (e.g. last path segment without extension).
7. **Global actions present when applicable.** Search, Notifications, Messages, Profile access reachable from the header on every page where they apply.
8. **One header, one bottom nav.** Never render a hard-coded bar *and* the injected one — exactly one of each. Duplicate nav bars are a violation.
9. **Consistent desktop sidebar per workspace.** Each workspace shows ONLY its own tools (Seller/Provider/Rider/Admin sidebars per `docs/RELEASE_ROADMAP.md` R1.1). The sidebar set is workspace-scoped, never mixed.
10. **Workspace switching is canonical.** The switcher lives in Profile, reads `users/{uid}.roles` (the single source), and every role routes to a page that exists and is reachable. No disappearing roles; no route to a missing page.

## Self-update coupling (freshness)
Rule 1 also satisfies the PWA freshness requirement: a page loading `shared-header.js` gets `sw-register.js` automatically. A page that loads neither serves stale after deploys AND usually lacks nav — a double violation. See [[reference_sw_register_page_coverage]].

## How a NEW page complies (checklist)
- [ ] Loads `shared-header.js` before `</body>` (or, if truly headerless by design, still includes `sw-register.js` + an explicit Back).
- [ ] Has a working Back with a deep-link fallback (rule 2).
- [ ] No `#` / `javascript:void(0)` / dead handlers (rule 3).
- [ ] Mobile bottom nav present (or intentionally excluded for full-screen flows like checkout — documented).
- [ ] Active-tab logic matches the clean pathname (rule 6).
- [ ] Any workspace link points to an existing, reachable page (rules 4/10).

## Enforcement
- **RC-safe now (correctness):** existing pages are audited against rules 2/3/4/6/8/10 and fixed as small, isolated edits (no business-logic change). Findings tracked from the 2026-08-04 navigation audit.
- **R1.1 (redesign):** the premium navigation framework in `docs/RELEASE_ROADMAP.md` implements the full spec (unified engine, breadcrumbs, gestures, bottom sheets, animation) on top of this floor.
- **Ongoing:** new pages meet the checklist before merge; a page that violates rules 1/2/3 does not ship. Candidate for a predeploy check (grep for `href="#"` in nav regions, pages missing `shared-header.js`/`sw-register.js`).

Related: [[project_nav_engine]] · [[project_mobile_drawer_ux]] · [[reference_design_system]] · [[project_profile_v2]] · [[reference_sw_register_page_coverage]] · [[reference_cleanurls_page_matching]].
