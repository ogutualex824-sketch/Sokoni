# ADR-006 — Landlord model is property → units → ledger

**Date:** 2026-08-02 · **Status:** Accepted · **Implementation blocked on rule tests**

## Decision

```
landlordProperties/{propertyId}      building · ownerUid · status
  └─ units/{unitId}                  ownerUid · tenantUid · monthlyRent · lease
       └─ ledger/{entryId}           type · period · amount · status
```

One document per level. `ownerUid` denormalised onto units and ledger entries, **immutable**.

## Evidence

`landlordData/{uid}.properties[]` held units, which held `rentHistory[]` and `waterBills[]`.
Recording one tenant's rent **rewrote the entire building**; entries could not be queried, indexed or
audited individually; and the document grew by two entries per unit per month forever.

**Measured: 0 documents in every candidate collection, and no declared index.** Migration cost is
zero — and `landlordData` had **no reader anywhere**: one rule, one write, a write-only mirror.

Option C (fold into `bnbListings`) was rejected: a short-stay booking and a monthly tenancy are
different products, and it breaks a create rule requiring `pricePerNight` semantics a rental lacks.

## What this forbids

- Unbounded arrays inside a document, especially financial ones.
- Editing a **paid** ledger entry. Money is reversed with a new adjustment or refund entry.
- `get(parent)` in rules where a denormalised immutable uid will do.

## Consequences

Rules deployed and compile-verified. **26 rule assertions are written but unexecuted** — the emulator
needs JDK 21 and the machine has 17. Phases 2/3/6 are gated on that suite passing. No exceptions.
