# ADR-005 — The persisted record is the commit point

**Date:** 2026-08-02 · **Status:** Accepted

## Decision

Nothing that depends on a record may run until that record is **persisted**. Notifications, invoices,
commissions, analytics and customer confirmations are downstream of the commit, never concurrent
with it.

```
persist ──✗──▶ recovery record · ops log · honest message   [stop]
persist ──✓──▶ 1 record · 2 notify · 3 invoice · 4 commission · 5 confirm
```

## Evidence

`bnb.html` wrapped its `addDoc` in `catch(e) {}` — an **empty body** — and the caller never awaited
it, showing "✅ Booking confirmed!" on the next line. A third path failed with no error at all: the
helper is defined in a `type="module"` block that executes *after* the inline booking script, so a
guest who paid quickly skipped Firestore entirely.

In every case the guest saw a confirmation, **the host was WhatsApped, an invoice was generated and
commission was recorded** for a booking that reached no database.

## What this forbids

- `catch (e) {}` around a persistence call. Ever.
- Fire-and-forget on a write whose success is being reported to a user.
- Telling a user to "try again" after a payment may have been captured — that risks a second charge.

## Consequences

On failure the user is told *"Payment received. Your booking is being verified. Keep this reference."*
and a recovery record is written under a **different key** with a **non-confirmed status**.

**No second source of truth was invented.** `darajaSTKCallback` already records every payment in
`posPayments/{checkoutId}` and writes `orphanPayments/{checkoutId}` when the paid-for document is
absent. The reference shown to the guest is the key that matches the two together.
