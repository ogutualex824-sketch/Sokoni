# ADR-009 — One canonical representation per concept

**Date:** 2026-08-02 · **Status:** Accepted (specification) · **Nothing migrated**

## Decision

Each concept has exactly one canonical field. Dual-read during migration; converge writes only after
the read path handles both. See `docs/CANONICAL_DATA_MODEL.md`.

| concept | canonical |
|---|---|
| identity | `uid`, or a role-qualified uid (`ownerUid`, `hostUid`, `tenantUid`) |
| role | `roles[]` — never `admin`; that is a claim |
| phone | `phoneNumber`, E.164 |
| created / updated | `createdAt` / `updatedAt`, server Timestamp |
| verified | `verified: boolean` + `verifiedAt` + `verifiedBy` |
| location | one `location` map, `county` queryable |
| status | lowercase, per-lifecycle vocabulary |
| receipt id | `receiptNumber` — `receiptNo` deprecated |
| invoice id | `invoiceNumber` — `invoiceNo` deprecated |

## Evidence

Measured, not read. `users` carries **four** role representations (`roles` 97%, `registeredAs` 97%,
`role` 13%, `accountType` 13%). `applications` carries `role` **and** `type` on 100% of documents.
`providers` carries `uid` **and** `providerId` on 100%. **`city` exists on 0% of users** while the
admin pane renders a City column.

`payments` status is **UPPERCASE** (`COMPLETE`/`FAILED`/`PENDING`) while every other collection is
lowercase — so any cross-subsystem comparison is wrong today.

## What this forbids

- Renaming a field by copying it. `phone` holds `07…` and `phoneNumber` holds `+2547…`;
  **normalise, do not copy.**
- Ordering by a partially-present field before backfilling it.
- Collapsing `ownerUid` and `tenantUid` into `uid` — they are different people on the same document
  and the rules depend on the distinction.

## Receipt identifiers — decided 2026-08-02

`receiptNumber` and `invoiceNumber` are canonical; `receiptNo` and `invoiceNo` are deprecated
aliases. **Zero production documents carry any of them** — `receipts` holds 1 document, `payments` 8,
and orders/posSales/invoices are empty — so there is nothing to migrate and **no compatibility layer
is needed**. The aliases exist only in code: **109 field uses across 34 files**, including POS receipt
printing and `financial-engine.js`, which carries a paired `invoiceNo`/`receiptNo` vocabulary.

Ratcheted by `scripts/verify-receipt-naming.js` so the alias cannot spread while the rename is
scheduled; `--strict` becomes the mode once the count reaches zero.

## Consequences

Migration order is **financial first**: the `payments` status case is a live comparison bug.
