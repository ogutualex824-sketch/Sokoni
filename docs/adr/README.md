# Architecture Decision Records

Numbered, dated decisions from the Admin OS convergence programme (2026-08-01 → 02).

**Why these exist:** every one of them was learned from a production defect, and every one of them is
the kind of decision a future contributor reverses by accident — usually while fixing something else,
usually with a change that looks locally sensible. A numbered record makes the reversal visible.

Each ADR states the decision, the evidence that produced it, and — most usefully — **what it forbids**.

| ADR | decision | status | evidence |
|---|---|---|---|
| [001](ADR-001-claim-based-authorization.md) | Authorization comes from Firebase custom claims, never from Firestore or an email string | **Accepted** · gated | `verify-claim-based-auth.js`, 1,192 files, 0 violations |
| [002](ADR-002-one-renderer-one-source-one-write-path.md) | Each admin pane has exactly one renderer, one data source, one write path | **Accepted** | Orders, Users, Properties |
| [003](ADR-003-no-business-authority-in-localstorage.md) | Business-authoritative state may not live in `localStorage` | **Accepted** · ratcheted | 45 keys outstanding |
| [004](ADR-004-single-writer-shared-layout-state.md) | Shared layout state has exactly one authoritative writer | **Accepted** | `--sk-header-h` dirty-check regression |
| [005](ADR-005-commit-point-persistence-gating.md) | The persisted record is the commit point for every downstream side effect | **Accepted** | BnB booking loss |
| [006](ADR-006-hierarchical-landlord-model.md) | Property → units → ledger, one document per level | **Accepted** · implementation blocked | 0 documents, zero migration cost |
| [007](ADR-007-pane-convergence-protocol.md) | Map, then remove one concern per commit; never bundle UI cleanup with data migration | **Accepted** | 5 panes, 112 → 90 duplicate ids |
| [008](ADR-008-evidence-before-change.md) | Measure production before changing code; if evidence contradicts the plan, stop and revise | **Accepted** | landlord model revision |
| [009](ADR-009-canonical-field-representation.md) | One canonical representation per concept; dual-read before converging writes | **Accepted** · specification | `CANONICAL_DATA_MODEL.md` |
| [010](ADR-010-financial-append-only-operational-event-driven.md) | Financial records append-only; operational records event-driven until dispatch | **Accepted** · design | `RECEIPT_ARCHITECTURE.md` |

## The rule that governs all of them

**A ratchet may decrease. It never increases without explicit architectural justification.**

Raising a baseline to silence a failing gate converts the gate into decoration. Every guard in this
programme — duplicate ids, admin markup, localStorage authority — is a ratchet for the same reason: an
absolute gate against a large existing backlog gets disabled, and a disabled gate protects nothing.

## Implementation documents

- `docs/PROPERTIES_DATA_SOURCE.md` — the investigation that produced ADR-003 and ADR-008
- `docs/LANDLORD_PROPERTY_MODEL.md` — options A/B/C and the measurement behind ADR-006
- `docs/ADMIN_LOCALSTORAGE_INVENTORY.md` — the 49-key inventory enforcing ADR-003
- `docs/CANONICAL_DATA_MODEL.md` — the specification for ADR-009
- `docs/ADMIN_CREDENTIAL_RISK_REPORT.md` — credential findings, unpatched by design
- `docs/RIDE_HUB_ROADMAP.md` — deferred product module, not debt
- `docs/RECEIPT_ARCHITECTURE.md` — the design for ADR-010

## Guards enforcing these decisions

| guard | enforces | mode |
|---|---|---|
| `verify-claim-based-auth.js` | ADR-001 | absolute — 0 violations |
| `verify-consent-gate.js` | consent (86 checks) | absolute |
| `audit-duplicate-ids.js` | ADR-002, ADR-007 | ratchet — 90 |
| `verify-admin-markup.js` | ADR-002 | absolute |
| `audit-admin-localstorage.js` | ADR-003 | ratchet — 45 |
| `test-users-render.js`, `test-apps-render.js` | ADR-002 | absolute |
| `test-landlord-rules.js` | ADR-006 | **written, not yet executed — needs JDK 21** |
