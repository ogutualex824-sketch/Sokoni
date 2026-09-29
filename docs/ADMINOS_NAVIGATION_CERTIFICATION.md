# AdminOS Navigation Certification (Slice E)

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` · **Certified tree:** `3f437f7` · **Status:** certified locally, **NOT deployed** (live `/admin-os` still serves `be7c676`).

This is the final navigation certification for the AdminOS sidebar programme (slices A → D). It records what was
**observed** on the committed tree — never what was expected. Related: [[AdminOS]] · [[Super Admin]] · [[Authentication]] ·
[[Integrations]] · [[SOKONI Connect]].

## Architecture that was certified

```
GLOBAL NAVIGATION                       CONTEXTUAL ACTION
   sidebar (#aosNav)                       body / page header
        ↓                                        ↓
   canonical route  #section[/tab]         related existing surface
        ↓
   SokoniAOS.navigate(section, tab)
        ↓
   existing panel  +  existing *Tab() selector

Super Admin → native panel where it has one, otherwise a link to admin-os.html#section[/tab]
```

Invariants held by the suites:

1. The 27-section inventory is authoritative; every `#panel-*` has exactly one sidebar parent and every sidebar parent has a panel.
2. A child item exists **only** for a distinct existing tab (9 children); it routes through `navigate(parent, tab)` and the existing selector — never a second implementation.
3. Every global destination has exactly **one** primary navigation path; the dashboard carries no navigation; contextual links (8) remain in Financial, SmartPOS, Delivery.
4. `#section/tab` deep links are validated against real nav items and tab buttons; hostile input falls back to the dashboard; all 57 routes survive a **real** reload.
   **C6 (2026-09-29):** a route may carry **one record** — `#support?open=ticket:<id>`, `#applications/queue?open=application:<id>`, `#applications/verification?open=request:<id>` — read only through the shared vocabulary `sokoni-record-links.js`, honoured only on the record's own route, opened through the SAME functions the in-app chips call, and **consumed once** (the hash is rewritten to the plain route). A hostile id, a kind on the wrong route or an absent vocabulary module opens nothing. `scripts/test-record-links.js` **21 / 0**.
5. The sidebar is a single scrolling `<nav aria-label="AdminOS navigation">`; the footer never scrolls away; `.active` and `aria-current="page"` move together; keyboard reaches every control with a visible ring; the phone drawer closes on Escape / « / scrim / section choice with focus returned.
6. The shared admin shell (`sokoni-admin-shell.js`) renders nothing on a page that declares `data-admin-shell="own"` (AdminOS, Super Admin) and still renders for every other admin page.
7. Super Admin reaches all 36 AdminOS destinations — natively or by link — and Integrations is the **same** `sokoni-integrations.js` in both consoles, rendering only its own closed `STATUS_META` vocabulary.

## Provenance ledger

| Slice | Commit | Reused from | What |
|---|---|---|---|
| A | `a51f268` | `f4a7f6a`, `8f99418` (production line) | opaque dark sidebar, SOKONI logo, collapse/close |
| A2 | `5750f8f` | `d8aea59` | shell opt-out `data-admin-shell="own"` + `test-adminos-single-navigation` |
| A3 | `9d1d5f2` | `767c0b7` (sidebar-layout chain) | `.aos-sidebar` excluded from the mobile catch-all; `min-width:0` chain |
| B | `65d3d2e` | Merchant V2 sidebar contract | scroll region, accessible drawer, focus, `aria-current`, reduced motion |
| C1 | `d007402` | — | child routes, `#section/tab`, coverage test |
| C2 | `94935b1` | `f196c70` | Super Admin links + shell opt-out + declaration-keyed catch-all |
| D | `3f437f7` | rest of `767c0b7` | quick-link grid removed, bell → `#comms/push`, header reflow |

Blobs at the certified tree: `admin-os.html f637b9e` · `sokoni-aos.js eb2913f` · `super-admin.html 956e612` ·
`sokoni-responsive.css 033080d` · `sokoni-admin-shell.js 9ce95d9`.

## Suites and observed results (tree `3f437f7`, run 2026-09-29)

| Suite | Result | Proves |
|---|---|---|
| `scripts/test-adminos-single-navigation.js` | **22 / 0** | one navigation tree on desktop and mobile; shell still renders for `monitor.html`; stripping the declaration brings the duplicates back |
| `scripts/test-adminos-sidebar-a11y.js` | **34 / 0** | scroll region, Tab reaches controls with a measured ring, Enter routes, Escape/«/scrim close, `aria-current` follows `navigate()`, reduced motion, brand in the drawer; 2 negative controls |
| `scripts/test-adminos-nav-coverage.js` | **32 / 0** | built ⇒ reachable at three levels; 57 real-reload deep links; rail and drawer tours; Integrations vocabulary; Super Admin reachability; 1 negative control |
| `scripts/test-adminos-shell-final.js` | **48 / 0** | one primary path; dashboard link-free; contextual links kept; bell and search routes; 320/390/768/1024/1440 shell certification; 1 negative control |
| `scripts/test-admin-os-render.js` | **43 / 0** | renderers unchanged |
| `scripts/test-admin-os-wiring.js` | **310 / 0** | dispatch wiring unchanged (+2 call sites: `smsStats`, C4) |
| `scripts/test-record-links.js` | **21 / 0** | C6: vocabulary; deep links open and consume; hostile / wrong-route / unknown open nothing; hashchange; ticket modal links; Connect links the application by id; `support.html?ticket=` (case preserved, signed-out fails closed); empty vocabulary module → nothing opens, nothing links |

All suites are hermetic: the repo is served from disk under a fake host, every other origin is aborted, Firebase is the
compat stub in `scripts/lib/adminos-probe-lib.js`. They cannot reach production. Run them **one at a time** on the
6 GB host; concurrent Chromium suites time out or are OOM-killed and read as harness errors, not product results.

## Known, recorded, not fixed here

- **Profile menu (`f4dcb5b`)** — needs the role-authority chain (`e7dd99e → 68497f7 → f4dcb5b → 8814a86`,
  `sokoni-role-authority.js`, live `sokoni-permissions.js`, `_skEnterAdmin`); imported alone its Admin-tools entries
  refuse on every click. Own slice.
- **SOKONI Store button (`526f330`)** — needs its backend and `merchant-v2.html?store=sokoni`; a bare link is dead.
- **Reduced motion platform-wide** — `sokoni-polish.css:198` `button:not(…)×4 … .13s !important` (0,4,1) beats every
  `*` reset; the sidebar wins by id specificity; every other button on every page still animates.
- **Super Admin's sidebar** scrolls as a whole (no dedicated scroll region) — its own shell.
- Live production still serves `be7c676`; the two mobile defects fixed in A3/C2 (80px drawer, 187px toggle) exist there
  until a separately authorized deploy.

## Re-certify

```
node scripts/test-adminos-single-navigation.js
node scripts/test-adminos-sidebar-a11y.js
node scripts/test-adminos-nav-coverage.js
node scripts/test-adminos-shell-final.js
node scripts/test-admin-os-render.js
node scripts/test-admin-os-wiring.js
```

A suite that exits **2** did not run to completion (harness error); it is not a pass and not a fail — re-run it alone.
