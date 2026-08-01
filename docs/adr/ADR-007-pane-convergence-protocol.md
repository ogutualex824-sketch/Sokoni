# ADR-007 — Pane convergence protocol

**Date:** 2026-08-02 · **Status:** Accepted

## Decision

For each pane, in order: **map → determine canonical → move live functionality into the survivor →
delete the duplicate → verify.** One pane per commit. **Never bundle UI cleanup with data migration.**

## Evidence

Mapping first changed the answer every time:

- **Orders** — the reachable pane was correct; the duplicate was a subset.
- **Users** — the **unreachable** copy had the correct 7-column header and the working search handler.
  Deleting it without moving those across would have destroyed the only correct version.
- **Properties** — the renderer straddled both copies, and `landlordGrid` existed **only** in the
  unreachable one.
- **Rides** — no renderer existed at all; the feature was never built.

The removal tooling **refuses to delete a block containing an id not already declared earlier**, so a
pane holding a unique container cannot be removed by accident.

## What this forbids

- Deleting the duplicate before checking which copy the renderer actually feeds.
- Bundling a data-source change with a markup change — neither can then be verified or rolled back
  independently.
- Calling a pane complete when it is merely singular.

## Consequences

Five panes converged. Each commit's runtime behaviour was verifiably identical or verifiably better,
and each carried its own measured before/after counts.
