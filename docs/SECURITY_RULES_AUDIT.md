# Security rules audit — self-certifying ownership

**Date:** 2026-08-02 · **Status:** Phase 1 MEASURED. Triage not started. **Nothing fixed.**

Related: [[Landlord Rules Run]] · [[ADR-001]] · [[Access Control Matrix]]

---

## The class

Three landlord defects were found by assertions that happened to exist. The pattern —
**letting the client's own payload certify who owns the document** — is not landlord-specific.

## Measurement

**`firestore.rules`: 106 occurrences** of `request.resource.data.<field> == request.auth.uid`,
across **33 distinct field names**:

| count | field | | count | field |
|---:|---|---|---:|---|
| 46 | `uid` | | 4 | `createdBy` |
| 8 | `ownerUid` | | 4 | `buyerUid` |
| 6 | `sellerUid` | | 3 | `senderUid` |
| 5 | `ownerId` | | 2 | `userId`, `reportedBy`, `customerId`, `clientUid` |

Singles: `targetUid` `shopOwnerId` `sellerId` `riderId` `reviewerUid` `responderUid` `requestedByUid`
`requestedBy` `reporterUid` `providerUid` `organizerUid` `hostUid` `gymUid` `freelancerUid` `flaggedBy`
`employerUid` `driverUid` `buyerId` `businessId` `authorUid` `askerUid` `applicantUid`

**`functions/`: 25 occurrences** of an owner id read from the client payload — `data.uid` (21),
`data.sellerUid` (2), `data.providerId` (2).

## **106 is the population to triage, NOT the vulnerability count**

This distinction matters and must survive into the fix work.

**Legitimate.** On a top-level collection, `request.resource.data.uid == request.auth.uid` on
**create** is the correct pattern — it stamps the creator and prevents writing a document as someone
else. That is authority *constraining* the payload.

**Vulnerable.** The same expression is a hole when it is the *only* check on an operation whose
authority belongs to a **parent document** — the landlord case. Landlord B writes their own uid onto a
unit and the rule agrees, because it never asks who owns the building.

So the triage question per occurrence is not "does it compare to `auth.uid`" but:

> **Is there a parent or pre-existing document whose ownership should decide this, and does the rule
> consult it?**

## Triage vocabulary (Phase 6)

`Canonical` · `Redundant` · `Dangerous` · `Dead`

## Next

1. Fix the two confirmed holes (`units`, `ledger` create) via parent `get()`.
2. Add assertions for missing / deleted / unreadable parent.
3. Triage the 106 against the question above; only `Dangerous` needs a rule change.
4. Then `FUNCTION_AUTH_AUDIT.md` for the 25 function-side occurrences.

**No feature work during this programme.**
