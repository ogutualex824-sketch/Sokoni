# ADR-008 — Evidence before change

**Date:** 2026-08-02 · **Status:** Accepted

## Decision

Measure production before changing code. **If evidence contradicts the plan, stop and revise before
writing more.**

## Evidence

- **Applications** — "the panel is blank" was assumed to be empty data. Firestore held **4
  applications**. The container was an orphan.
- **Users** — the role filter was designed against `roles[]`; measurement showed **8 documents use a
  `role` string and 2 have neither**. Reading one field alone would have hidden real accounts.
- **Ordering** — `orderBy('createdAt')` returns **59 of 61** users; `orderBy('updatedAt')` **13 of
  61**; `orderBy('joined')` **0**. Firestore omits documents lacking the ordering field, so a query
  that looks correct hides people.
- **Landlord** — an approved plan was **withdrawn mid-implementation** when the "property" turned out
  to be a building containing units containing monthly ledgers. Building the approved design would
  have shipped a model that fails identically in eighteen months.
- **Email Link** — reported DISABLED twice. The field was *absent*, and Google's APIs omit
  default-valued fields. **My check was wrong, not the config.**

## What this forbids

- Choosing a field name by intuition. `phone` looks obvious and covers **5%**; `phoneNumber` covers 75%.
- Reporting a gate as passing when it did not execute.
- Continuing an approved plan after the evidence has moved.

## Consequences

Several plans were revised mid-flight, and one guard's own false positive was caught before it blocked
deploys. Being wrong in public, early, is cheaper than being wrong in production.
