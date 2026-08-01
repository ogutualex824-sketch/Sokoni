# ADR-004 — Shared layout state has exactly one authoritative writer

**Date:** 2026-08-02 · **Status:** Accepted

## Decision

A shared layout value — a CSS custom property, a measured height, a global offset — has **one** writer.
Everything else reads it.

## Evidence

`--sk-header-h` was written by both `shared-header.js` and `sokoni-layout.js`. A style-recalculation
optimisation that should have reduced work measured **+10% styleMs**, because Blink scopes
custom-property invalidation to elements that *reference* the property and two writers doubled the
invalidation. The regression looked like a failed optimisation; it was a correctness bug.

`shared-header.js` **measures and publishes**; `sokoni-layout.js` now only reads.

## What this forbids

- A second module writing a published layout variable, even defensively.
- Sticky elements anchoring to `top: 0` instead of the published header height.

## Consequences

The optimisation that was rejected on a false measurement became measurable once the second writer was
removed.
