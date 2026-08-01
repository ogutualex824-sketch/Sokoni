# ADR-002 — One renderer, one data source, one write path

**Date:** 2026-08-02 · **Status:** Accepted · **Enforced by:** `audit-duplicate-ids.js`, `verify-admin-markup.js`, the render-contract tests

## Decision

Every admin pane has exactly **one** renderer, **one** data source, **one** write path, **one** visible
pane, and no unreachable duplicate.

## Evidence

`admin.html` carried **two parallel layouts** for the same data. `showPane()` resolves
`getElementById('adm-pane-' + name)` to the **first match**, so five pane ids existed twice and the
second copy of each could never be displayed. **112 duplicate element ids.**

The failures this produced were all invisible in review:

- **Orders** — two renderers wrote `#ordersBody` 50 ms apart with **different action sets**. A click
  in that window hit `flagDispute`, which wrote localStorage only: the status change never reached
  Firestore and was discarded by the next snapshot. **A lost write.**
- **Users** — the renderer emitted 7 cells under a 6-column header, so every column after Email sat
  under the wrong heading; and the search box passed no argument, so typing filtered nothing.
- **Properties** — `propStats` resolved into the reachable pane and `bnbBody` into the unreachable
  one, so the pane showed **statistics above a permanently empty table**.

## What this forbids

- A second container for the same data "just for mobile". Render into both from one renderer.
- A renderer that writes an element another renderer also writes.
- Leaving an unreachable duplicate in place because it is harmless. It is not: it becomes reachable
  the moment someone adds a nav entry.

## Consequences

Duplicate ids **112 → 90**, all five panes converged. Every remaining duplicate is *within* one
surviving pane rather than *between* two copies.
