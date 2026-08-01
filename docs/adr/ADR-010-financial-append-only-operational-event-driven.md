# ADR-010 — Financial records are append-only; operational records are event-driven

**Date:** 2026-08-02 · **Status:** Accepted (design) · **Implementation:** not started

## Decision

**A receipt is a financial record. A delivery note is an operational record. They evolve under
different rules.**

- **Financial** — immutable once payment succeeds. Corrections create *new* records (refund, credit
  note, adjustment, reversal). Never an edit.
- **Operational** — mutable until dispatch, every change appended to an event log with editor,
  timestamp, previous value, new value and a **required reason**.
- **After dispatch** — operational becomes immutable too. Later change happens through dedicated
  events (failed delivery, return, redelivery, cancellation, exchange), never by rewriting history.

## Evidence

The `orders` rule already enforces the financial half through per-role `hasOnly()` allowlists: **no
financial field appears in any allowlist**, so `total`, `items` and `taxes` are already immutable to
buyers, sellers and drivers. `orders/{orderId}/events` already exists. This ADR mostly closes gaps
rather than introducing a model.

Three gaps were measured:

1. **No delivery field is in any allowlist**, so a merchant currently **cannot** correct a house
   number after payment. The assumed problem was that delivery details were too editable; in fact the
   water business's core need is impossible today.
2. **`isAdmin()` is unrestricted** — an administrator may rewrite `total` with no audit requirement.
   The financial record is immutable to everyone except the actor most able to cause a reconciliation
   problem.
3. **No dispatch lock** — a driver may rewrite `driverNote` after delivery.

The same invariant already proved itself in ADR-006: a **paid** landlord ledger entry is closed to the
landlord, and money is reversed with a new adjustment or refund entry rather than an edit.

## What this forbids

- Editing any financial field after payment — **including as an administrator**.
- A parallel "delivery" collection alongside the order. One order, one fulfilment map, one event log;
  a second document is a second authority to reconcile.
- An audit entry without a **reason**. *What* changed without *why* answers the easy question.
- Correcting a completed dispatch by editing it. A redelivery is a new attempt, not a rewrite.
- Recording a bottle deposit as a fulfilment edit. A deposit is money: it is a receipt line item and is
  returned through the refund pipeline.

## Consequences

Merchants gain the ability to fix a house number after payment — which they do not have today — while
the financial record becomes *more* locked than it currently is, not less.

Rules cannot enforce "and also write an event", so fulfilment edits must go through a callable with
the rule narrowed to prevent direct client writes.

**Open before implementation:** `receiptNo` (63 uses) and `receiptNumber` (45) are the same concept
under two names. Freezing an ambiguous field name would freeze the ambiguity — resolve under ADR-009
first.
